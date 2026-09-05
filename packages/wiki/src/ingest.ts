// packages/wiki/src/ingest.ts
// Ingests raw source documents into the MemBerry graph as Source nodes,
// Entity nodes, and Semantic nodes with CITES/ABOUT relationships.

import neo4j, { type Driver } from 'neo4j-driver';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { ExtractionProvider } from '@memberry/core';
import { parseBoolFlag, readEnv, redactSecrets, semanticDedupeKey } from '@memberry/core';
import type { IngestInput, IngestResult } from './types.js';
import { needsConversion, type DocumentConverter } from './document-converter.js';

// ─── Cypher identifier allowlists (audit C6) ─────────────────────────────────
// Labels and relationship types cannot be Cypher parameters, so createRelation
// interpolates them. ingest() only ever passes these closed sets; anything else
// is rejected before a query string is built.

const RELATION_LABELS: ReadonlySet<string> = new Set(['Semantic', 'Source', 'Entity']);
const RELATION_TYPES: ReadonlySet<string> = new Set(['CITES', 'ABOUT']);

// ─── Schema for Source nodes ─────────────────────────────────────────────────

const SOURCE_SCHEMA: string[] = [
  'CREATE CONSTRAINT source_id IF NOT EXISTS FOR (s:Source) REQUIRE s.id IS UNIQUE',
  'CREATE INDEX source_title IF NOT EXISTS FOR (s:Source) ON (s.title)',
  'CREATE INDEX source_type IF NOT EXISTS FOR (s:Source) ON (s.source_type)',
];

export async function initWikiSchema(driver: Driver): Promise<void> {
  const session = driver.session();
  try {
    for (const stmt of SOURCE_SCHEMA) {
      await session.run(stmt);
    }
  } finally {
    await session.close();
  }
}

// ─── Ingestion service ──────────────────────────────────────────────────────

export class IngestionService {
  /**
   * Secret redaction at the ingest boundary (opt-in), mirroring AmpService.store
   * (service.ts ~424) which gates on config.redactOnIngest. Defaults to the same
   * mechanism the core services factory uses (services-factory.ts ~144):
   * `MEMBERRY_REDACT_ON_INGEST === 'true'`. Explicit constructor value wins so
   * callers/tests can force it on or off without touching the env.
   */
  private readonly redactOnIngest: boolean;

  constructor(
    private driver: Driver,
    private extractor?: ExtractionProvider,
    private converter?: DocumentConverter,
    redactOnIngest?: boolean,
  ) {
    this.redactOnIngest =
      redactOnIngest ?? parseBoolFlag(readEnv('MEMBERRY_REDACT_ON_INGEST'), false);
  }

  async ingest(input: IngestInput): Promise<IngestResult> {
    const {
      source_path,
      content: inlineContent,
      source_type,
      project_tag,
      title: inputTitle,
      entities: preEntities,
      claims: preClaims,
      tags: globalTags,
      base_confidence,
      decay_class,
      author,
      ensure_project,
    } = input;

    const projectName = project_tag.replace(/^project:/, '');
    const isHuman = author === 'human';
    const decayClass = decay_class ?? (isHuman ? 'stable' : 'volatile');
    const baseConfidence = base_confidence ?? (isHuman ? 0.7 : 0.3);
    // Provenance tags applied to the Source and every created Semantic.
    const provenanceTags = isHuman ? ['human-authored', 'source:brain-dump'] : [];

    // 1. Obtain source content (inline text wins over a file path).
    let content: string;
    if (typeof inlineContent === 'string') {
      content = inlineContent;
    } else if (source_path) {
      try {
        // Documents (PDF/Office/HTML/RTF) go through the converter when one is
        // injected; plain-text files are read directly as before.
        if (this.converter && needsConversion(source_path)) {
          content = (await this.converter.convert(source_path)).text;
        } else {
          content = await readFile(source_path, 'utf-8');
        }
      } catch (err: unknown) {
        console.error("[ingest] Suppressed error:", err);
        throw new Error(`Failed to read source file: ${source_path}`);
      }
    } else {
      throw new Error('ingest requires either `content` or `source_path`');
    }

    // 1b. Redact secrets from the verbatim body before anything derived from it
    // is persisted (paragraph-split brain-dump claims, auto-extraction input).
    // Matches AmpService.store, which redacts content before persistence when the
    // flag is on. Title/tags/entity names are structural and left untouched.
    if (this.redactOnIngest) {
      content = redactSecrets(content);
    }

    // 2. Determine title
    const title = inputTitle ?? extractTitle(content, source_path ?? 'brain-dump');

    // 3. Create (or reuse) the Source node. OPT-11: the id is content-addressed —
    // a hash of source_path|source_type|project_tag — so re-ingesting the SAME
    // source MERGEs onto the existing node instead of CREATE-ing a duplicate with
    // a fresh random id every run. `path` here is the same value the original
    // ingest stored, so the second ingest derives the same id and matches.
    const sourcePath = source_path ?? 'inline';
    const sourceId = sourceNodeId(sourcePath, source_type, project_tag);
    await this.createSourceNode(sourceId, title, source_type, sourcePath, project_tag);

    // 4. Ensure project entity exists, link source
    if (ensure_project) {
      await this.ensureProjectEntity(projectName);
    }
    await this.linkSourceToProject(sourceId, projectName);

    // 4b. Auto-extract claims and entities if none provided
    let autoExtractedClaims: typeof preClaims = undefined;
    let autoExtractedEntities: string[] | undefined;

    if (this.extractor && (!preClaims || preClaims.length === 0)) {
      try {
        // Truncate content to avoid token limits
        const truncated = content.slice(0, 8000);
        const result = await this.extractor.extractAll(truncated);
        autoExtractedEntities = result.entities.map((e: { name: string }) => e.name);
        autoExtractedClaims = result.claims.map((c: { content: string; about: string[]; confidence: number; tags: string[] }) => ({
          content: c.content,
          about: c.about,
          confidence: c.confidence,
          tags: c.tags,
        }));
        console.error(`[memberry-ingest] Auto-extracted ${result.entities.length} entities, ${result.claims.length} claims from ${source_path}`);
      } catch (err) {
        console.error('[memberry-ingest] Auto-extraction failed (non-critical):', err instanceof Error ? err.message : err);
      }
    }

    // 5. Process pre-extracted entities
    let entitiesCreated = 0;
    let entitiesLinked = 0;
    const allEntities = new Set<string>([...(preEntities ?? []), ...(autoExtractedEntities ?? [])]);

    for (const entityName of allEntities) {
      const created = await this.ensureEntity(entityName, 'concept', projectName);
      if (created) entitiesCreated++;
      else entitiesLinked++;
    }

    // 6. Process claims → semantic nodes (pre-extracted or auto-extracted)
    let claimsStored = 0;
    let citationsCreated = 0;
    let claims = preClaims ?? autoExtractedClaims ?? [];

    // Fallback for human brain dumps with no extractor and no pre-structured claims:
    // store the verbatim text as a single durable claim so the dump is never lost and
    // stays queryable. Richer multi-claim extraction kicks in when an ExtractionProvider
    // is configured. Split into paragraphs so distinct thoughts become distinct claims.
    if (claims.length === 0 && isHuman && content.trim()) {
      const paragraphs = content
        .split(/\n\s*\n/)
        .map((p) => p.replace(/^#+\s*/, '').trim())
        .filter((p) => p.length > 0);
      const bodies = paragraphs.length > 0 ? paragraphs : [content.trim()];
      claims = bodies.map((body) => ({ content: body.slice(0, 1500), about: [title] }));
    }

    for (const claim of claims) {
      const semanticId = `sem-${nanoid(12)}`;
      const tags = [
        ...(claim.tags ?? []),
        ...(globalTags ?? []),
        ...provenanceTags,
        project_tag,
      ];

      // Redact claim content too: pre-extracted / auto-extracted claims are not
      // derived from the (already-redacted) `content` string, so they need their
      // own pass. Brain-dump fallback claims are redacted transitively via content.
      const claimContent = this.redactOnIngest ? redactSecrets(claim.content) : claim.content;

      // OPT-11: content-addressed dedupe so re-ingesting the SAME source does not
      // duplicate its claim Semantics. Mirrors BootstrapGraphService.createSemantic:
      // dedupe_key = semanticDedupeKey(scope, about[0], content) drives a MERGE
      // backed by the `semantic_dedupe_unique` UNIQUE constraint (race-safe). Use
      // the project_tag (lowercased to match bootstrap's `scope`) and the first
      // ABOUT entity as the identity coordinates. Only count nodes actually created
      // — a matched re-ingest must not inflate claims_stored.
      const scope = project_tag.toLowerCase();
      const dedupeKey = semanticDedupeKey(scope, claim.about?.[0], claimContent);
      const { created: semCreated, id: resolvedSemanticId } = await this.createSemanticNode(
        semanticId,
        claimContent,
        claim.confidence ?? baseConfidence,
        tags,
        decayClass,
        dedupeKey,
        scope,
      );
      if (semCreated) claimsStored++;

      // Link CITES → Source. Use the RESOLVED id (the existing node's id on a
      // matched re-ingest, the new id on create) — the random `semanticId` only
      // sticks when the MERGE actually creates. MERGE on the relation keeps
      // re-ingest from double-linking.
      await this.createRelation(resolvedSemanticId, 'Semantic', sourceId, 'Source', 'CITES');
      citationsCreated++;

      // Link ABOUT → Entities
      for (const entityName of claim.about) {
        // Ensure entity exists
        const created = await this.ensureEntity(entityName, 'concept', projectName);
        if (created && !allEntities.has(entityName)) {
          entitiesCreated++;
          allEntities.add(entityName);
        }

        const entityId = await this.getEntityId(entityName);
        if (entityId) {
          await this.createRelation(resolvedSemanticId, 'Semantic', entityId, 'Entity', 'ABOUT');
        }
      }
    }

    // For brain dumps, link the dump's entities under the project so they become
    // navigable wiki articles (the compiler reaches entities via project CONTAINS).
    if (ensure_project) {
      for (const entityName of allEntities) {
        await this.linkEntityToProject(projectName, entityName);
      }
    }

    return {
      source_id: sourceId,
      entities_created: entitiesCreated,
      entities_linked: entitiesLinked,
      claims_stored: claimsStored,
      citations_created: citationsCreated,
    };
  }

  // ─── Graph operations ──────────────────────────────────────────────────────

  private async createSourceNode(
    id: string,
    title: string,
    sourceType: string,
    path: string,
    projectTag: string,
  ): Promise<void> {
    const session = this.driver.session();
    try {
      // OPT-11: MERGE on the content-addressed id (derived in `ingest` from
      // source_path|source_type|project_tag) so re-ingesting the same source
      // reuses the node instead of CREATE-ing a duplicate. ON CREATE seeds all
      // props; ON MATCH refreshes title/path (the source may have been re-titled
      // or moved) and stamps updated_at. There is no Source uniqueness constraint
      // today — single-writer ingest MERGE is sufficient (a follow-up could add a
      // `source_dedupe_unique` constraint for race safety; deferred — schema
      // changes need separate sign-off).
      await session.run(
        `MERGE (s:Source {id: $id})
         ON CREATE SET s.title = $title,
                       s.source_type = $sourceType,
                       s.path = $path,
                       s.project_tag = $projectTag,
                       s.created_at = $now
         ON MATCH SET s.title = $title,
                      s.path = $path,
                      s.updated_at = $now`,
        {
          id,
          title,
          sourceType,
          path,
          projectTag,
          now: new Date().toISOString(),
        },
      );
    } finally {
      await session.close();
    }
  }

  private async linkSourceToProject(sourceId: string, projectName: string): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run(
        // EXACT match: the project Entity is created under its EXACT name (see
        // ensureProjectEntity / ensureEntity in this file). A CONTAINS substring
        // match cross-linked unrelated projects (ingesting "app" also linked
        // "myapp"), so match the name the writer actually stored.
        `MATCH (s:Source {id: $sourceId})
         MATCH (p:Entity {name: $projectName, type: 'project'})
         MERGE (p)-[:HAS_SOURCE]->(s)`,
        { sourceId, projectName },
      );
    } finally {
      await session.close();
    }
  }

  private async ensureEntity(name: string, type: string, projectName: string): Promise<boolean> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        `MERGE (e:Entity {name: $name})
         ON CREATE SET e.id = $id, e.type = $type, e.created_at = $now
         ON MATCH SET e.type = CASE WHEN $type = 'project' THEN 'project' ELSE e.type END
         RETURN e.id AS id, e.created_at = $now AS created`,
        {
          name,
          id: `ent-${nanoid(12)}`,
          type,
          now: new Date().toISOString(),
        },
      );
      // Check if it was newly created by comparing timestamps
      const record = result.records[0];
      return record ? (record.get('created') as boolean) : false;
    } finally {
      await session.close();
    }
  }

  private async getEntityId(name: string): Promise<string | null> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        `MATCH (e:Entity {name: $name}) RETURN e.id AS id LIMIT 1`,
        { name },
      );
      return result.records[0]?.get('id') as string ?? null;
    } finally {
      await session.close();
    }
  }

  /**
   * OPT-11: MERGE a claim Semantic on its content-addressed `dedupe_key` instead
   * of CREATE-ing with a random id, mirroring BootstrapGraphService.createSemantic.
   * Re-ingesting the SAME source therefore reuses the existing claim node (no
   * duplicate). Backed by the `semantic_dedupe_unique` UNIQUE constraint so two
   * concurrent MERGEs can't both create. Returns whether the node was newly
   * created (so the caller counts creations only) and the resolved node id (the
   * existing id on a match, `id` on a create) so CITES/ABOUT target the right node.
   */
  private async createSemanticNode(
    id: string,
    content: string,
    confidence: number,
    tags: string[],
    decayClass: 'volatile' | 'stable' | 'permanent' = 'volatile',
    dedupeKey?: string,
    scope?: string,
  ): Promise<{ created: boolean; id: string }> {
    const session = this.driver.session();
    try {
      const now = new Date().toISOString();
      const res = await session.run(
        `MERGE (s:Semantic {dedupe_key: $dedupeKey})
         ON CREATE SET s.id = $id,
                       s.content = $content,
                       s.confidence = $confidence,
                       s.signal_count = 0,
                       s.created_at = $now,
                       s.valid_at = $now,
                       s.updated_at = $now,
                       s.decay_class = $decayClass,
                       s.tags = $tags,
                       s.scope = $scope
         ON MATCH SET s.updated_at = $now
         RETURN s.id AS id, s.created_at = $now AS isNew`,
        {
          id,
          content,
          confidence,
          tags,
          decayClass,
          scope: scope ?? null,
          dedupeKey: dedupeKey ?? `sem-${id}`,
          now,
        },
      );
      const record = res.records[0];
      return {
        created: record ? (record.get('isNew') as boolean) : false,
        id: (record?.get('id') as string) ?? id,
      };
    } finally {
      await session.close();
    }
  }

  /** Link an entity under the project via CONTAINS (skips self-linking the project). */
  private async linkEntityToProject(projectName: string, entityName: string): Promise<void> {
    if (entityName === projectName) return;
    const session = this.driver.session();
    try {
      await session.run(
        // EXACT match (see linkSourceToProject): the project Entity is stored
        // under its EXACT name, so a CONTAINS substring match cross-linked the
        // dump's entities under unrelated projects whose name shares a substring.
        `MATCH (p:Entity {name: $projectName, type: 'project'})
         MATCH (e:Entity {name: $entityName})
         MERGE (p)-[:CONTAINS]->(e)`,
        { projectName, entityName },
      );
    } finally {
      await session.close();
    }
  }

  /** Create the project Entity if missing (used by brain-dump ingestion). */
  private async ensureProjectEntity(projectName: string): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run(
        `MERGE (e:Entity {name: $name})
         ON CREATE SET e.id = $id, e.type = 'project', e.created_at = $now
         ON MATCH SET e.type = 'project'`,
        { name: projectName, id: `ent-${nanoid(12)}`, now: new Date().toISOString() },
      );
    } finally {
      await session.close();
    }
  }

  private async createRelation(
    sourceId: string,
    sourceLabel: string,
    targetId: string,
    targetLabel: string,
    relType: string,
  ): Promise<void> {
    // Value-free errors: the rejected string may be attacker-shaped.
    if (!RELATION_LABELS.has(sourceLabel) || !RELATION_LABELS.has(targetLabel)) {
      throw new Error('invalid_label');
    }
    if (!RELATION_TYPES.has(relType)) {
      throw new Error('invalid_relationship_type');
    }
    const session = this.driver.session();
    try {
      // Dynamic relationship types require APOC or string interpolation;
      // the allowlist checks above are what make interpolating them safe.
      await session.run(
        `MATCH (a:${sourceLabel} {id: $sourceId})
         MATCH (b:${targetLabel} {id: $targetId})
         MERGE (a)-[:${relType}]->(b)`,
        { sourceId, targetId },
      );
    } finally {
      await session.close();
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * OPT-11: deterministic, content-addressed id for a Source node. Hashing
 * `path|source_type|project_tag` (the source's stable identity) gives the SAME
 * id across re-ingest of the same source, so a MERGE on it dedupes instead of
 * CREATE-ing a new node with a random nanoid every run. Mirrors the dedupe-key
 * approach BootstrapGraphService uses for seed Semantics (sha1 of the identity
 * coordinates), keeping the id short and index-friendly. The `src-` prefix
 * preserves the existing id shape.
 */
export function sourceNodeId(path: string, sourceType: string, projectTag: string): string {
  const digest = createHash('sha1').update(`${path}|${sourceType}|${projectTag}`).digest('hex');
  return `src-${digest.slice(0, 24)}`;
}

function extractTitle(content: string, path: string): string {
  // Try to extract from markdown H1
  const h1Match = content.match(/^#\s+(.+)$/m);
  if (h1Match) return h1Match[1].trim();

  // Try YAML frontmatter title
  const fmMatch = content.match(/^---\n[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/m);
  if (fmMatch) return fmMatch[1].trim();

  // Fall back to filename
  return basename(path, extname(path)).replace(/[-_]/g, ' ');
}
