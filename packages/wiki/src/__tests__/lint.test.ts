// packages/wiki/src/__tests__/lint.test.ts
// Tests for WikiLinter — graph health checks.

import { describe, it, expect, vi } from 'vitest';
import { WikiLinter } from '../lint.js';
import type { Driver, Session, Result } from 'neo4j-driver';

// ─── Mock helpers ────────────────────────────────────────────────────────────

function mockRecord(data: Record<string, unknown>) {
  return {
    get(key: string) { return data[key]; },
    keys: Object.keys(data),
  };
}

function mockResult(records: ReturnType<typeof mockRecord>[]): Result {
  return { records } as unknown as Result;
}

function createMockDriver(queryHandler: (query: string, params?: unknown) => Result): Driver {
  const mockSession = {
    run: vi.fn(async (query: string, params?: unknown) => queryHandler(query, params)),
    close: vi.fn(async () => {}),
  } as unknown as Session;

  return {
    session: vi.fn(() => mockSession),
  } as unknown as Driver;
}

// ─── WikiLinter ──────────────────────────────────────────────────────────────

describe('WikiLinter', () => {
  describe('lint() — structure and summary', () => {
    it('returns a result with checks, total_issues, and summary', async () => {
      const driver = createMockDriver(() => mockResult([]));
      const linter = new WikiLinter(driver);

      const result = await linter.lint({
        project_tag: 'project:test',
        checks: ['orphan_pages'],
      });

      expect(result).toHaveProperty('checks');
      expect(result).toHaveProperty('total_issues');
      expect(result).toHaveProperty('summary');
      expect(result.summary).toContain('1 checks');
    });

    it('runs all 10 checks when no specific checks are provided', async () => {
      const driver = createMockDriver(() => mockResult([]));
      const linter = new WikiLinter(driver);

      const result = await linter.lint({ project_tag: 'project:test' });

      expect(Object.keys(result.checks)).toHaveLength(10);
      expect(result.summary).toContain('10 checks');
    });

    it('runs only requested checks', async () => {
      const driver = createMockDriver(() => mockResult([]));
      const linter = new WikiLinter(driver);

      const result = await linter.lint({
        project_tag: 'project:test',
        checks: ['orphan_pages', 'broken_links'],
      });

      expect(Object.keys(result.checks)).toHaveLength(2);
      expect(result.checks).toHaveProperty('orphan_pages');
      expect(result.checks).toHaveProperty('broken_links');
    });

    it('strips project: prefix from project_tag for query params', async () => {
      const runSpy = vi.fn(async () => mockResult([]));
      const driver = {
        session: vi.fn(() => ({
          run: runSpy,
          close: vi.fn(async () => {}),
        })),
      } as unknown as Driver;

      const linter = new WikiLinter(driver);
      await linter.lint({
        project_tag: 'project:mars-fps',
        checks: ['orphan_pages'],
      });

      // The query param should use "mars-fps", not "project:mars-fps"
      const params = runSpy.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(params?.projectName).toBe('mars-fps');
    });
  });

  describe('orphan_pages check', () => {
    it('passes when all entities have semantic knowledge', async () => {
      const driver = createMockDriver(() => mockResult([]));
      const linter = new WikiLinter(driver);

      const result = await linter.lint({
        project_tag: 'project:test',
        checks: ['orphan_pages'],
      });

      expect(result.checks['orphan_pages'].passed).toBe(true);
      expect(result.checks['orphan_pages'].issues).toHaveLength(0);
    });

    it('reports entities with no semantic nodes as orphans', async () => {
      const driver = createMockDriver((query) => {
        if (query.includes('OPTIONAL MATCH (s:Semantic)-[:ABOUT]')) {
          return mockResult([
            mockRecord({ name: 'EnemyAI', type: 'component', semCount: 0 }),
            mockRecord({ name: 'HealthBar', type: 'component', semCount: 0 }),
          ]);
        }
        return mockResult([]);
      });
      const linter = new WikiLinter(driver);

      const result = await linter.lint({
        project_tag: 'project:test',
        checks: ['orphan_pages'],
      });

      expect(result.checks['orphan_pages'].passed).toBe(false);
      expect(result.checks['orphan_pages'].issues).toHaveLength(2);
      expect(result.checks['orphan_pages'].issues[0].severity).toBe('warning');
      expect(result.checks['orphan_pages'].issues[0].entity).toBe('EnemyAI');
      expect(result.checks['orphan_pages'].issues[0].suggestion).toBeDefined();
    });
  });

  describe('broken_links check', () => {
    it('passes when no semantic nodes reference out-of-project entities', async () => {
      const driver = createMockDriver(() => mockResult([]));
      const linter = new WikiLinter(driver);

      const result = await linter.lint({
        project_tag: 'project:test',
        checks: ['broken_links'],
      });

      expect(result.checks['broken_links'].passed).toBe(true);
    });

    it('reports entities referenced by semantics but not in project', async () => {
      const driver = createMockDriver((query) => {
        if (query.includes('NOT EXISTS')) {
          // New broken_links query also returns `otherProjects` so info-vs-warning
          // can be derived per row. An empty otherProjects means "not in any project"
          // → severity=warning (truly orphaned).
          return mockResult([
            mockRecord({ name: 'MissingEntity', id: 'ent-xxx', refs: 3, otherProjects: [] }),
          ]);
        }
        return mockResult([]);
      });
      const linter = new WikiLinter(driver);

      const result = await linter.lint({
        project_tag: 'project:test',
        checks: ['broken_links'],
      });

      expect(result.checks['broken_links'].passed).toBe(false);
      expect(result.checks['broken_links'].issues).toHaveLength(1);
      expect(result.checks['broken_links'].issues[0].entity).toBe('MissingEntity');
      expect(result.checks['broken_links'].issues[0].severity).toBe('warning');
    });
  });

  describe('contradictions check', () => {
    it('passes when no contradiction signals exist', async () => {
      const driver = createMockDriver(() => mockResult([]));
      const linter = new WikiLinter(driver);

      const result = await linter.lint({
        project_tag: 'project:test',
        checks: ['contradictions'],
      });

      expect(result.checks['contradictions'].passed).toBe(true);
    });

    it('reports semantic nodes with contradiction signals', async () => {
      const driver = createMockDriver((query) => {
        if (query.includes('CONTRADICTS')) {
          return mockResult([
            mockRecord({
              sem_id: 'sem-123',
              content: 'Auth uses JWT tokens for session management',
              confidence: 0.6,
              contradiction_count: 2,
            }),
          ]);
        }
        return mockResult([]);
      });
      const linter = new WikiLinter(driver);

      const result = await linter.lint({
        project_tag: 'project:test',
        checks: ['contradictions'],
      });

      expect(result.checks['contradictions'].passed).toBe(false);
      expect(result.checks['contradictions'].issues).toHaveLength(1);
      expect(result.checks['contradictions'].issues[0].severity).toBe('error');
      expect(result.checks['contradictions'].issues[0].message).toContain('2 contradiction');
    });
  });

  describe('low_confidence check', () => {
    it('passes when all semantics have high confidence', async () => {
      const driver = createMockDriver(() => mockResult([]));
      const linter = new WikiLinter(driver);

      const result = await linter.lint({
        project_tag: 'project:test',
        checks: ['low_confidence'],
      });

      expect(result.checks['low_confidence'].passed).toBe(true);
    });

    it('reports low-confidence claims', async () => {
      const driver = createMockDriver((query) => {
        if (query.includes('s.confidence <=')) {
          return mockResult([
            mockRecord({
              id: 'sem-low',
              content: 'Redis might be unnecessary for small deployments',
              confidence: 0.15,
              entities: ['Redis', 'Deployment'],
            }),
          ]);
        }
        return mockResult([]);
      });
      const linter = new WikiLinter(driver);

      const result = await linter.lint({
        project_tag: 'project:test',
        checks: ['low_confidence'],
      });

      expect(result.checks['low_confidence'].passed).toBe(false);
      expect(result.checks['low_confidence'].issues).toHaveLength(1);
      expect(result.checks['low_confidence'].issues[0].severity).toBe('warning');
      expect(result.checks['low_confidence'].issues[0].entity).toBe('Redis, Deployment');
    });

    it('respects custom threshold', async () => {
      const runSpy = vi.fn(async () => mockResult([]));
      const driver = {
        session: vi.fn(() => ({
          run: runSpy,
          close: vi.fn(async () => {}),
        })),
      } as unknown as Driver;

      const linter = new WikiLinter(driver);
      await linter.lint({
        project_tag: 'project:test',
        checks: ['low_confidence'],
        thresholds: { low_confidence_max: 0.5 },
      });

      const params = runSpy.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(params?.maxConfidence).toBe(0.5);
    });
  });

  describe('missing_links check', () => {
    it('reports entity pairs with high co-occurrence but no direct relationship', async () => {
      const driver = createMockDriver((query) => {
        if (query.includes('e1.name < e2.name')) {
          return mockResult([
            mockRecord({ entity1: 'Auth', entity2: 'Redis', cooccurrences: 5 }),
          ]);
        }
        return mockResult([]);
      });
      const linter = new WikiLinter(driver);

      const result = await linter.lint({
        project_tag: 'project:test',
        checks: ['missing_links'],
      });

      expect(result.checks['missing_links'].passed).toBe(false);
      expect(result.checks['missing_links'].issues).toHaveLength(1);
      expect(result.checks['missing_links'].issues[0].severity).toBe('info');
      expect(result.checks['missing_links'].issues[0].entity).toBe('Auth <-> Redis');
    });
  });

  describe('redirect_candidates check', () => {
    it('reports entities with overlapping names', async () => {
      const driver = createMockDriver((query) => {
        if (query.includes('toLower(e1.name)')) {
          return mockResult([
            mockRecord({ name1: 'Auth', type1: 'service', name2: 'AuthService', type2: 'component' }),
          ]);
        }
        return mockResult([]);
      });
      const linter = new WikiLinter(driver);

      const result = await linter.lint({
        project_tag: 'project:test',
        checks: ['redirect_candidates'],
      });

      expect(result.checks['redirect_candidates'].passed).toBe(false);
      expect(result.checks['redirect_candidates'].issues[0].severity).toBe('info');
      expect(result.checks['redirect_candidates'].issues[0].entity).toBe('Auth / AuthService');
    });
  });

  describe('hub_detection check', () => {
    it('reports entities with high inbound reference count', async () => {
      const driver = createMockDriver((query) => {
        if (query.includes('refCount')) {
          return mockResult([
            mockRecord({ name: 'Neo4j', type: 'service', refCount: 15 }),
          ]);
        }
        return mockResult([]);
      });
      const linter = new WikiLinter(driver);

      const result = await linter.lint({
        project_tag: 'project:test',
        checks: ['hub_detection'],
      });

      expect(result.checks['hub_detection'].passed).toBe(false);
      expect(result.checks['hub_detection'].issues[0].entity).toBe('Neo4j');
      expect(result.checks['hub_detection'].issues[0].message).toContain('15 semantic nodes');
    });
  });

  describe('stale_sources check', () => {
    it('reports sources with no citations', async () => {
      const driver = createMockDriver((query) => {
        if (query.includes('CITES')) {
          return mockResult([
            mockRecord({ title: 'Old Spec v1', type: 'reference', created: '2025-01-01' }),
          ]);
        }
        return mockResult([]);
      });
      const linter = new WikiLinter(driver);

      const result = await linter.lint({
        project_tag: 'project:test',
        checks: ['stale_sources'],
      });

      expect(result.checks['stale_sources'].passed).toBe(false);
      expect(result.checks['stale_sources'].issues[0].entity).toBe('Old Spec v1');
    });
  });

  describe('coverage_gaps check', () => {
    it('reports tags with thin coverage', async () => {
      const driver = createMockDriver((query) => {
        if (query.includes('UNWIND s.tags AS tag')) {
          return mockResult([
            mockRecord({ tag: 'performance', count: 1, avgConfidence: 0.4 }),
          ]);
        }
        return mockResult([]);
      });
      const linter = new WikiLinter(driver);

      const result = await linter.lint({
        project_tag: 'project:test',
        checks: ['coverage_gaps'],
      });

      // count <= 2, so it should be flagged
      expect(result.checks['coverage_gaps'].passed).toBe(false);
      expect(result.checks['coverage_gaps'].issues[0].entity).toBe('performance');
    });

    it('does not flag tags with sufficient coverage', async () => {
      const driver = createMockDriver((query) => {
        if (query.includes('UNWIND s.tags AS tag')) {
          return mockResult([
            mockRecord({ tag: 'architecture', count: 5, avgConfidence: 0.7 }),
          ]);
        }
        return mockResult([]);
      });
      const linter = new WikiLinter(driver);

      const result = await linter.lint({
        project_tag: 'project:test',
        checks: ['coverage_gaps'],
      });

      expect(result.checks['coverage_gaps'].passed).toBe(true);
    });
  });

  describe('link_density check', () => {
    it('reports entities with semantics but no outbound links', async () => {
      const driver = createMockDriver((query) => {
        if (query.includes('outboundLinks = 0')) {
          return mockResult([
            mockRecord({ name: 'IslandComponent', type: 'concept', semCount: 3 }),
          ]);
        }
        return mockResult([]);
      });
      const linter = new WikiLinter(driver);

      const result = await linter.lint({
        project_tag: 'project:test',
        checks: ['link_density'],
      });

      expect(result.checks['link_density'].passed).toBe(false);
      expect(result.checks['link_density'].issues[0].severity).toBe('info');
      expect(result.checks['link_density'].issues[0].message).toContain('no outbound links');
    });
  });

  describe('error handling', () => {
    it('handles check failures gracefully', async () => {
      const driver = createMockDriver(() => {
        throw new Error('Neo4j connection lost');
      });
      const linter = new WikiLinter(driver);

      const result = await linter.lint({
        project_tag: 'project:test',
        checks: ['orphan_pages'],
      });

      expect(result.checks['orphan_pages'].passed).toBe(false);
      expect(result.checks['orphan_pages'].issues).toHaveLength(1);
      expect(result.checks['orphan_pages'].issues[0].severity).toBe('error');
      expect(result.checks['orphan_pages'].issues[0].message).toContain('Neo4j connection lost');
    });

    it('continues running other checks when one fails', async () => {
      let callCount = 0;
      const driver = createMockDriver((query) => {
        callCount++;
        if (callCount === 1) throw new Error('check failed');
        return mockResult([]);
      });
      const linter = new WikiLinter(driver);

      const result = await linter.lint({
        project_tag: 'project:test',
        checks: ['orphan_pages', 'contradictions'],
      });

      expect(result.checks['orphan_pages'].passed).toBe(false);
      expect(result.checks['contradictions'].passed).toBe(true);
    });

    it('counts issues across all checks in total_issues', async () => {
      const driver = createMockDriver((query) => {
        if (query.includes('OPTIONAL MATCH (s:Semantic)-[:ABOUT]')) {
          return mockResult([
            mockRecord({ name: 'OrphanA', type: 'concept', semCount: 0 }),
          ]);
        }
        if (query.includes('CONTRADICTS')) {
          return mockResult([
            mockRecord({ sem_id: 'sem-1', content: 'Claim A', confidence: 0.3, contradiction_count: 1 }),
            mockRecord({ sem_id: 'sem-2', content: 'Claim B', confidence: 0.2, contradiction_count: 2 }),
          ]);
        }
        return mockResult([]);
      });
      const linter = new WikiLinter(driver);

      const result = await linter.lint({
        project_tag: 'project:test',
        checks: ['orphan_pages', 'contradictions'],
      });

      expect(result.total_issues).toBe(3); // 1 orphan + 2 contradictions
    });
  });
});

// ─── Tenant predicate on every Semantic/Episodic read (audit C3, item 5b) ────

describe('tenant predicate on lint Semantic/Episodic reads', () => {
  const TENANT = 'tenant-a';
  // Every check whose Cypher matches a Semantic or Episodic node. A new check
  // that touches those labels must be added here (and must carry $tenantId).
  const cases = [
    'orphan_pages', 'broken_links', 'missing_links', 'link_density', 'hub_detection',
    'contradictions', 'low_confidence', 'stale_sources', 'coverage_gaps',
  ] as const;

  it.each(cases)('%s carries $tenantId on every Semantic/Episodic MATCH', async (check) => {
    const calls: Array<{ query: string; params: Record<string, unknown> }> = [];
    const driver = createMockDriver((query, params) => {
      calls.push({ query, params: (params ?? {}) as Record<string, unknown> });
      return mockResult([]);
    });
    await new WikiLinter(driver).lint({ project_tag: 'project:p', checks: [check] }, TENANT);
    expect(calls.length).toBeGreaterThan(0);
    for (const { query, params } of calls) {
      const aliases = [...query.matchAll(/\((\w+):(Semantic|Episodic)\)/g)].map((m) => m[1]);
      expect(aliases.length).toBeGreaterThan(0);
      for (const alias of aliases) {
        expect(query, `${check}: alias ${alias} unguarded`).toContain(
          `(${alias}.tenant_id = $tenantId OR (${alias}.tenant_id IS NULL AND $tenantId = $defaultTenant))`,
        );
      }
      expect(params.tenantId).toBe(TENANT);
      expect(params.defaultTenant).toBe('default');
    }
  });

  it('every check whose Cypher mentions Semantic/Episodic is in the table', async () => {
    const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../lint.ts', import.meta.url), 'utf8'));
    const covered = new Set<string>(cases);
    for (const m of src.matchAll(/^async function (check\w+)\(/gm)) {
      const body = src.slice(m.index!);
      const end = body.indexOf('\nasync function ', 1);
      const fn = end === -1 ? body : body.slice(0, end);
      if (!/\(\w+:(Semantic|Episodic)\)/.test(fn)) continue;
      const key = m[1].replace(/^check/, '').replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
      expect(covered, `${m[1]} missing from tenant table`).toContain(key);
    }
  });

  it('defaults to the default tenant so existing callers keep single-tenant behaviour', async () => {
    const runSpy = vi.fn(async () => mockResult([]));
    const driver = { session: vi.fn(() => ({ run: runSpy, close: vi.fn(async () => {}) })) } as unknown as Driver;
    await new WikiLinter(driver).lint({ project_tag: 'project:p', checks: ['hub_detection'] });
    expect(runSpy.mock.calls[0]?.[1]).toMatchObject({ tenantId: 'default', defaultTenant: 'default' });
  });
});
