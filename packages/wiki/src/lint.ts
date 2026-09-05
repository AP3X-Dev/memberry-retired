// packages/wiki/src/lint.ts
// Graph health checks for the wiki knowledge base.

import neo4j, { type Driver } from 'neo4j-driver';
import type { LintInput, LintResult, LintCheckResult, LintIssue, LintCheck } from './types.js';
import { DEFAULT_TENANT } from '@memberry/core';
import { tenantWhere, tenantParams } from './queries.js';

// ─── Shared report formatter ─────────────────────────────────────────────────
//
// gap-17: a single formatter shared by the wiki CLI `lint` command and the MCP
// `berry_lint` handler, so the two surfaces can't drift. Previously the CLI
// printed only summary counts while the MCP handler had its own inline detail
// renderer.

/** Map a LintIssue severity to its short uppercase prefix. */
function severityPrefix(severity: LintIssue['severity']): string {
  return severity === 'error' ? 'ERROR' : severity === 'warning' ? 'WARN' : 'INFO';
}

/**
 * Render a LintResult as a human-readable report.
 *
 * Default (summaryOnly falsy): one header per check —
 *   `[PASS] <check>` for clean checks, `[ISSUES] <check> (N)` otherwise —
 * followed by each issue indented as `  [ERROR|WARN|INFO] <message>` with an
 * optional `    Suggestion: <...>` line; the overall summary + total close it.
 *
 * summaryOnly true: the terse summary + total only (the legacy CLI behavior).
 */
export function formatLintReport(result: LintResult, opts?: { summaryOnly?: boolean }): string {
  const summaryBlock = [result.summary, `Total issues: ${result.total_issues}`];

  if (opts?.summaryOnly) {
    return summaryBlock.join('\n');
  }

  const lines: string[] = [];

  for (const [name, checkResult] of Object.entries(result.checks)) {
    if (checkResult.issues.length === 0) {
      lines.push(`[PASS] ${name}`);
    } else {
      lines.push(`[ISSUES] ${name} (${checkResult.issues.length})`);
      for (const issue of checkResult.issues) {
        lines.push(`  [${severityPrefix(issue.severity)}] ${issue.message}`);
        if (issue.suggestion) {
          lines.push(`    Suggestion: ${issue.suggestion}`);
        }
      }
    }
  }

  lines.push('');
  lines.push(...summaryBlock);

  return lines.join('\n');
}

// ─── Individual check implementations ───────────────────────────────────────

type CheckFn = (driver: Driver, projectName: string, thresholds: Required<NonNullable<LintInput['thresholds']>>, tenantId: string) => Promise<LintCheckResult>;

const CHECKS: Record<LintCheck, CheckFn> = {
  orphan_pages: checkOrphanPages,
  broken_links: checkBrokenLinks,
  missing_links: checkMissingLinks,
  redirect_candidates: checkRedirectCandidates,
  link_density: checkLinkDensity,
  hub_detection: checkHubDetection,
  contradictions: checkContradictions,
  low_confidence: checkLowConfidence,
  stale_sources: checkStaleSources,
  coverage_gaps: checkCoverageGaps,
};

const DEFAULT_THRESHOLDS = {
  orphan_min_links: 0,
  missing_link_min_cooccurrence: 3,
  low_confidence_max: 0.3,
  hub_min_links: 10,
};

// ─── Orphan pages: entities with zero inbound semantic references ────────────

async function checkOrphanPages(driver: Driver, projectName: string, thresholds: typeof DEFAULT_THRESHOLDS, tenantId: string): Promise<LintCheckResult> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (project:Entity {type: 'project'})-[:CONTAINS*0..]->(e:Entity)
       WHERE project.name CONTAINS $projectName AND e.type <> 'project'
       OPTIONAL MATCH (s:Semantic)-[:ABOUT]->(e)
       WHERE coalesce(s.archived, false) = false AND ${tenantWhere('s')}
       WITH e, count(s) AS semCount
       WHERE semCount <= $minLinks
       RETURN e.name AS name, e.type AS type, semCount
       ORDER BY name`,
      { projectName, minLinks: neo4j.int(thresholds.orphan_min_links), ...tenantParams(tenantId) },
    );

    const issues: LintIssue[] = result.records.map((r) => ({
      severity: 'warning' as const,
      entity: r.get('name') as string,
      message: `Entity "${r.get('name')}" (${r.get('type')}) has no semantic knowledge about it`,
      suggestion: 'Add claims about this entity via berry_store or berry_ingest',
    }));

    return { check: 'orphan_pages', issues, passed: issues.length === 0 };
  } finally {
    await session.close();
  }
}

// ─── Broken links: semantic nodes referencing non-existent entities ──────────

async function checkBrokenLinks(driver: Driver, projectName: string, _thresholds: typeof DEFAULT_THRESHOLDS, tenantId: string): Promise<LintCheckResult> {
  // Find entities referenced by semantics but with no project home.
  // Ignores:
  //   - project-root entities (type='project') — they ARE the parent, no CONTAINS expected
  //   - entities that ARE in some project hierarchy (just not THIS project's) — those are
  //     legitimate cross-project references, downgraded to severity=info
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (s:Semantic)-[:ABOUT]->(e:Entity)
       WHERE e.type <> 'project'
         AND NOT EXISTS {
           MATCH (thisProj:Entity {type: 'project'})-[:CONTAINS*1..]->(e)
           WHERE toLower(thisProj.name) = toLower($projectName)
         }
         AND ANY(t IN s.tags WHERE t STARTS WITH 'project:')
         AND coalesce(s.archived, false) = false
         AND ${tenantWhere('s')}
       OPTIONAL MATCH (anyProj:Entity {type: 'project'})-[:CONTAINS*1..]->(e)
       WITH e, count(s) AS refs, collect(DISTINCT anyProj.name) AS otherProjects
       RETURN e.name AS name, e.id AS id, refs, otherProjects
       ORDER BY refs DESC
       LIMIT 50`,
      { projectName, ...tenantParams(tenantId) },
    );

    const issues: LintIssue[] = result.records.map((r) => {
      const name = r.get('name') as string;
      const refs = r.get('refs') as { toNumber?: () => number } | number;
      const refsNum = typeof refs === 'object' && refs !== null && 'toNumber' in refs
        ? refs.toNumber!()
        : Number(refs);
      const otherProjects = (r.get('otherProjects') as string[]).filter(Boolean);
      const isCrossProject = otherProjects.length > 0;
      return {
        severity: (isCrossProject ? 'info' : 'warning') as 'info' | 'warning',
        entity: name,
        message: isCrossProject
          ? `Entity "${name}" is referenced by ${refsNum} semantic node(s) here but lives in: ${otherProjects.join(', ')} (cross-project reference, not broken)`
          : `Entity "${name}" is referenced by ${refsNum} semantic node(s) but is not part of any project hierarchy`,
        suggestion: isCrossProject
          ? 'No action needed unless you want to mirror this entity into the current project explicitly'
          : 'Add this entity to a project via berry_bootstrap or create a CONTAINS relationship',
      };
    });

    // Pass = no orphan-warnings (info-level cross-project references are fine)
    const hasWarnings = issues.some((i) => i.severity === 'warning');
    return { check: 'broken_links', issues, passed: !hasWarnings };
  } finally {
    await session.close();
  }
}

// ─── Missing links: entities that co-occur in semantics but lack a relationship

async function checkMissingLinks(driver: Driver, projectName: string, thresholds: typeof DEFAULT_THRESHOLDS, tenantId: string): Promise<LintCheckResult> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (s:Semantic)-[:ABOUT]->(e1:Entity)
       MATCH (s)-[:ABOUT]->(e2:Entity)
       WHERE e1.name < e2.name
         AND coalesce(s.archived, false) = false
         AND ${tenantWhere('s')}
         AND NOT EXISTS { MATCH (e1)-[:CONTAINS|USES|CALLS|EXTENDS|IMPLEMENTS|EMITS|LISTENS]-(e2) }
       WITH e1.name AS entity1, e2.name AS entity2, count(s) AS cooccurrences
       WHERE cooccurrences >= $minCooccurrence
       RETURN entity1, entity2, cooccurrences
       ORDER BY cooccurrences DESC
       LIMIT 30`,
      { projectName, minCooccurrence: neo4j.int(thresholds.missing_link_min_cooccurrence), ...tenantParams(tenantId) },
    );

    const issues: LintIssue[] = result.records.map((r) => ({
      severity: 'info' as const,
      entity: `${r.get('entity1')} <-> ${r.get('entity2')}`,
      message: `"${r.get('entity1')}" and "${r.get('entity2')}" co-occur in ${r.get('cooccurrences')} semantic nodes but have no direct relationship`,
      suggestion: 'Consider adding a RELATES_TO, USES, or other typed relationship',
    }));

    return { check: 'missing_links', issues, passed: issues.length === 0 };
  } finally {
    await session.close();
  }
}

// ─── Redirect candidates: entities with very similar names ──────────────────

async function checkRedirectCandidates(driver: Driver, projectName: string, _thresholds: typeof DEFAULT_THRESHOLDS, tenantId: string): Promise<LintCheckResult> {
  const session = driver.session();
  try {
    // Find entity pairs where one name contains the other or they share a long common substring
    const result = await session.run(
      `MATCH (project:Entity {type: 'project'})-[:CONTAINS*0..]->(e1:Entity)
       WHERE project.name CONTAINS $projectName
       MATCH (project)-[:CONTAINS*0..]->(e2:Entity)
       WHERE e1.name < e2.name
         AND (toLower(e1.name) CONTAINS toLower(e2.name)
              OR toLower(e2.name) CONTAINS toLower(e1.name))
       RETURN e1.name AS name1, e1.type AS type1, e2.name AS name2, e2.type AS type2
       LIMIT 20`,
      { projectName },
    );

    const issues: LintIssue[] = result.records.map((r) => ({
      severity: 'info' as const,
      entity: `${r.get('name1')} / ${r.get('name2')}`,
      message: `"${r.get('name1')}" (${r.get('type1')}) and "${r.get('name2')}" (${r.get('type2')}) have overlapping names — possible duplicates`,
      suggestion: 'Consider merging these entities or adding one as an alias of the other',
    }));

    return { check: 'redirect_candidates', issues, passed: issues.length === 0 };
  } finally {
    await session.close();
  }
}

// ─── Link density: articles with unusually few entity references ─────────────

async function checkLinkDensity(driver: Driver, projectName: string, _thresholds: typeof DEFAULT_THRESHOLDS, tenantId: string): Promise<LintCheckResult> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (project:Entity {type: 'project'})-[:CONTAINS*0..]->(e:Entity)
       WHERE project.name CONTAINS $projectName AND e.type <> 'project'
       OPTIONAL MATCH (s:Semantic)-[:ABOUT]->(e)
       WHERE coalesce(s.archived, false) = false AND ${tenantWhere('s')}
       WITH e, count(s) AS semCount
       WHERE semCount > 0
       OPTIONAL MATCH (s2:Semantic)-[:ABOUT]->(e)
       WHERE coalesce(s2.archived, false) = false AND ${tenantWhere('s2')}
       OPTIONAL MATCH (s2)-[:ABOUT]->(other:Entity)
       WHERE other.name <> e.name
       WITH e, semCount, count(DISTINCT other) AS outboundLinks
       WHERE outboundLinks = 0
       RETURN e.name AS name, e.type AS type, semCount
       ORDER BY semCount DESC
       LIMIT 20`,
      { projectName, ...tenantParams(tenantId) },
    );

    const issues: LintIssue[] = result.records.map((r) => ({
      severity: 'info' as const,
      entity: r.get('name') as string,
      message: `"${r.get('name')}" has ${r.get('semCount')} semantic nodes but none reference other entities — article will have no outbound links`,
      suggestion: 'Enrich claims to reference related entities for better interlinking',
    }));

    return { check: 'link_density', issues, passed: issues.length === 0 };
  } finally {
    await session.close();
  }
}

// ─── Hub detection: entities with very high inbound references ──────────────

async function checkHubDetection(driver: Driver, projectName: string, thresholds: typeof DEFAULT_THRESHOLDS, tenantId: string): Promise<LintCheckResult> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (s:Semantic)-[:ABOUT]->(e:Entity)
       WHERE coalesce(s.archived, false) = false AND ${tenantWhere('s')}
       WITH e, count(DISTINCT s) AS refCount
       WHERE refCount >= $minLinks
       RETURN e.name AS name, e.type AS type, refCount
       ORDER BY refCount DESC
       LIMIT 20`,
      { minLinks: neo4j.int(thresholds.hub_min_links), ...tenantParams(tenantId) },
    );

    const issues: LintIssue[] = result.records.map((r) => ({
      severity: 'info' as const,
      entity: r.get('name') as string,
      message: `"${r.get('name')}" (${r.get('type')}) is referenced by ${r.get('refCount')} semantic nodes — consider making it an index/hub page`,
      suggestion: 'This entity is a natural hub. Consider adding sub-categories or a dedicated overview article',
    }));

    return { check: 'hub_detection', issues, passed: issues.length === 0 };
  } finally {
    await session.close();
  }
}

// ─── Contradictions: semantic nodes with contradicting signals ──────────────

async function checkContradictions(driver: Driver, projectName: string, _thresholds: typeof DEFAULT_THRESHOLDS, tenantId: string): Promise<LintCheckResult> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (ep:Episodic)-[:CONTRADICTS]->(s:Semantic)
       WHERE coalesce(s.archived, false) = false
         AND ${tenantWhere('s')} AND ${tenantWhere('ep')}
       RETURN s.id AS sem_id, s.content AS content, s.confidence AS confidence,
              count(ep) AS contradiction_count
       ORDER BY contradiction_count DESC
       LIMIT 20`,
      tenantParams(tenantId),
    );

    const issues: LintIssue[] = result.records.map((r) => ({
      severity: 'error' as const,
      entity: r.get('sem_id') as string,
      message: `Semantic "${(r.get('content') as string).slice(0, 100)}..." has ${r.get('contradiction_count')} contradiction signals (confidence: ${r.get('confidence')})`,
      suggestion: 'Review and resolve this contradiction — the claim may be outdated or wrong',
    }));

    return { check: 'contradictions', issues, passed: issues.length === 0 };
  } finally {
    await session.close();
  }
}

// ─── Low confidence: claims with few reinforcements ─────────────────────────

async function checkLowConfidence(driver: Driver, projectName: string, thresholds: typeof DEFAULT_THRESHOLDS, tenantId: string): Promise<LintCheckResult> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (s:Semantic)-[:ABOUT]->(e:Entity)
       WHERE s.confidence <= $maxConfidence
         AND coalesce(s.archived, false) = false
         AND ${tenantWhere('s')}
       RETURN s.id AS id, s.content AS content, s.confidence AS confidence,
              collect(DISTINCT e.name) AS entities
       ORDER BY s.confidence ASC
       LIMIT 30`,
      { maxConfidence: thresholds.low_confidence_max, ...tenantParams(tenantId) },
    );

    const issues: LintIssue[] = result.records.map((r) => ({
      severity: 'warning' as const,
      entity: (r.get('entities') as string[]).join(', '),
      message: `Low confidence (${r.get('confidence')}) claim: "${(r.get('content') as string).slice(0, 120)}..."`,
      suggestion: 'Reinforce with additional sources or agent observations to increase confidence',
    }));

    return { check: 'low_confidence', issues, passed: issues.length === 0 };
  } finally {
    await session.close();
  }
}

// ─── Stale sources: sources not referenced by recent semantics ──────────────

async function checkStaleSources(driver: Driver, projectName: string, _thresholds: typeof DEFAULT_THRESHOLDS, tenantId: string): Promise<LintCheckResult> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (src:Source)
       WHERE src.project_tag CONTAINS $projectName
       OPTIONAL MATCH (s:Semantic)-[:CITES]->(src)
       WHERE coalesce(s.archived, false) = false AND ${tenantWhere('s')}
       WITH src, count(s) AS citationCount
       WHERE citationCount = 0
       RETURN src.title AS title, src.source_type AS type, src.created_at AS created
       ORDER BY created
       LIMIT 20`,
      { projectName, ...tenantParams(tenantId) },
    );

    const issues: LintIssue[] = result.records.map((r) => ({
      severity: 'info' as const,
      entity: r.get('title') as string,
      message: `Source "${r.get('title')}" (${r.get('type')}) has no semantic nodes citing it`,
      suggestion: 'Re-ingest this source to extract claims, or remove if no longer relevant',
    }));

    return { check: 'stale_sources', issues, passed: issues.length === 0 };
  } finally {
    await session.close();
  }
}

// ─── Coverage gaps: domain tags with thin coverage ──────────────────────────

async function checkCoverageGaps(driver: Driver, projectName: string, _thresholds: typeof DEFAULT_THRESHOLDS, tenantId: string): Promise<LintCheckResult> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (s:Semantic)
       WHERE ANY(t IN s.tags WHERE t = 'project:' + $projectName)
         AND coalesce(s.archived, false) = false
         AND ${tenantWhere('s')}
       UNWIND s.tags AS tag
       WITH s, tag WHERE NOT tag STARTS WITH 'project:'
       RETURN tag, count(*) AS count, avg(s.confidence) AS avgConfidence
       ORDER BY count ASC
       LIMIT 20`,
      { projectName, ...tenantParams(tenantId) },
    );

    const issues: LintIssue[] = result.records
      .filter((r) => {
        const count = r.get('count');
        return (typeof count === 'object' && count !== null && 'toNumber' in count
          ? (count as { toNumber(): number }).toNumber()
          : Number(count)) <= 2;
      })
      .map((r) => ({
        severity: 'info' as const,
        entity: r.get('tag') as string,
        message: `Domain tag "${r.get('tag')}" has only ${r.get('count')} semantic nodes (avg confidence: ${(r.get('avgConfidence') as number).toFixed(2)})`,
        suggestion: 'This area is under-researched. Consider ingesting more sources or asking more questions about it',
      }));

    return { check: 'coverage_gaps', issues, passed: issues.length === 0 };
  } finally {
    await session.close();
  }
}

// ─── Main linter ────────────────────────────────────────────────────────────

export class WikiLinter {
  constructor(private driver: Driver) {}

  async lint(input: LintInput, tenantId: string = DEFAULT_TENANT): Promise<LintResult> {
    const projectName = input.project_tag.replace(/^project:/, '');
    const thresholds = { ...DEFAULT_THRESHOLDS, ...input.thresholds };
    const checksToRun = input.checks ?? (Object.keys(CHECKS) as LintCheck[]);

    const results: Record<string, LintCheckResult> = {};
    let totalIssues = 0;

    for (const check of checksToRun) {
      const fn = CHECKS[check];
      if (!fn) continue;

      try {
        const result = await fn(this.driver, projectName, thresholds, tenantId);
        results[check] = result;
        totalIssues += result.issues.length;
      } catch (err) {
        results[check] = {
          check,
          issues: [{
            severity: 'error',
            message: `Check failed: ${err instanceof Error ? err.message : String(err)}`,
          }],
          passed: false,
        };
        totalIssues++;
      }
    }

    // Build summary
    const passed = Object.values(results).filter((r) => r.passed).length;
    const failed = Object.values(results).filter((r) => !r.passed).length;
    const summary = `Ran ${checksToRun.length} checks: ${passed} passed, ${failed} with issues (${totalIssues} total issues)`;

    return { checks: results, total_issues: totalIssues, summary };
  }
}
