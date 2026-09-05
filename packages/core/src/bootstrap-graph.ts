// packages/core/src/bootstrap-graph.ts
// Seeds the Neo4j graph with foundational nodes for a project.
// This solves the chicken-and-egg problem: without Entity/Agent/Semantic nodes,
// episodic memories are orphaned islands with no relationships.

import { type Driver } from 'neo4j-driver';
import { nanoid } from 'nanoid';
import { createHash } from 'crypto';
import type { EmbeddingProvider } from './types.js';

/**
 * Stable content-addressed key for a bootstrap seed Semantic. Hashing
 * `scope|about[0]|claim` (rather than storing a long raw string) gives a short,
 * index-friendly key that is identical across re-ingest for the same logical
 * seed — so MERGE on it makes seed creation idempotent. `nanoid()`-based `id`
 * can't dedupe (it's random every run); this key is derived purely from the
 * seed's semantic identity, so the SAME seed re-ingested produces the SAME key.
 */
export function semanticDedupeKey(scope: string, about: string | undefined, claim: string): string {
  return createHash('sha1').update(`${scope}|${about ?? ''}|${claim}`).digest('hex');
}

// ─── Input types ─────────────────────────────────────────────────────────────

export interface BootstrapEntity {
  name: string;
  type: 'project' | 'module' | 'service' | 'component' | 'team' | 'person' | 'tool' | string;
  description?: string;
  /** Parent entity name — creates a CONTAINS relationship */
  parent?: string;
  /** Confined absolute ingest root (project entities only); overwritten on every ingest */
  root_path?: string;
}

export interface BootstrapSemantic {
  claim: string;
  domain: string;
  confidence?: number;
  /** Entity names this principle is ABOUT */
  about?: string[];
  tags?: string[];
}

export interface BootstrapAgent {
  id: string;
  name: string;
  type: 'assistant' | 'sentinel' | 'fixer' | 'researcher' | string;
}

export interface BootstrapInput {
  project_name: string;
  project_tag: string;
  description: string;
  domain: string;
  entities: BootstrapEntity[];
  semantic_seeds: BootstrapSemantic[];
  agents: BootstrapAgent[];
}

export interface BootstrapResult {
  entities_created: number;
  entities_existing: number;
  agents_created: number;
  agents_existing: number;
  semantics_created: number;
  relationships_created: number;
  project_entity_id: string;
}

const CANONICAL_PROJECT_SCOPE = /^project:[a-z0-9][a-z0-9._-]*$/;
const MAX_CANONICAL_PROJECT_SCOPE_LENGTH = 136;

/**
 * Bootstrap owns the durable mapping between a human project name and the
 * canonical scope used by memory/code retrieval. Keep already-canonical dots
 * and underscores intact; only case is normalized here.
 */
function canonicalBootstrapProjectScope(projectTag: string): string {
  const scope = projectTag.toLowerCase();
  if (scope.length > MAX_CANONICAL_PROJECT_SCOPE_LENGTH
    || !CANONICAL_PROJECT_SCOPE.test(scope)) {
    throw new Error('bootstrap: project_tag must be a canonical project scope');
  }
  return scope;
}

// Relationship types cannot be Cypher parameters, so mergeRelationship
// interpolates them (audit C7). bootstrap() only ever emits CONTAINS; anything
// else is rejected before a query string is built.
const BOOTSTRAP_RELATION_TYPES: ReadonlySet<string> = new Set(['CONTAINS']);

// ─── Service ─────────────────────────────────────────────────────────────────

export class BootstrapGraphService {
  /**
   * @param embedding Optional provider; when wired, each seeded Semantic gets a
   *   content embedding so it lands in the semantic_embedding vector index and
   *   is recallable by vector search (not just tag/scope lookup).
   */
  constructor(private driver: Driver, private embedding?: EmbeddingProvider) {}

  /**
   * Seed the graph with foundational nodes for a project.
   * Idempotent — MERGE prevents duplicates. Safe to run multiple times.
   */
  async bootstrap(input: BootstrapInput): Promise<BootstrapResult> {
    const projectScope = canonicalBootstrapProjectScope(input.project_tag);
    const result: BootstrapResult = {
      entities_created: 0,
      entities_existing: 0,
      agents_created: 0,
      agents_existing: 0,
      semantics_created: 0,
      relationships_created: 0,
      project_entity_id: '',
    };

    const session = this.driver.session();
    try {
      // 1. Create the project entity (always first)
      const projectId = await this.mergeEntity(session, {
        name: input.project_name,
        type: 'project',
        description: input.description,
      }, result, projectScope);
      result.project_entity_id = projectId;

      // 2. Create all entities FIRST (parent-linking is a separate pass below).
      //    OPT-21: the parent CONTAINS link used to run inline in this loop, so a
      //    module naming a parent that appears LATER in `entities` got no parent
      //    edge — the parent wasn't MERGEd yet when the child looked it up. MERGE
      //    every entity before any parent link so order in the array no longer
      //    matters. Remember each entity's id for the linking pass.
      const entityIds: string[] = [];
      for (const entity of input.entities) {
        const entityId = await this.mergeEntity(session, entity, result);
        entityIds.push(entityId);

        // Link to project (all entities belong to the project)
        if (entity.type !== 'project') {
          await this.mergeRelationship(session, projectId, entityId, 'CONTAINS', result);
        }
      }

      // 2b. Parent-linking pass — now that ALL entities exist, a parent listed
      //     later than its child still resolves. `LIMIT 1` makes the match
      //     deterministic when several entities share a name (one CONTAINS edge).
      for (let i = 0; i < input.entities.length; i++) {
        const entity = input.entities[i];
        if (!entity.parent) continue;
        const parentResult = await session.run(
          'MATCH (e:Entity {name: $parent}) RETURN e.id AS id LIMIT 1',
          { parent: entity.parent },
        );
        if (parentResult.records.length > 0) {
          const parentId = parentResult.records[0].get('id') as string;
          await this.mergeRelationship(session, parentId, entityIds[i], 'CONTAINS', result);
        }
      }

      // 3. Create agents
      for (const agent of input.agents) {
        await this.mergeAgent(session, agent, result);
      }

      // 4. Create semantic seeds
      //    OPT-8: each seed's work (createSemantic + its ABOUT links) is wrapped in
      //    its own try/catch so one bad/contended seed can't reject bootstrap() and
      //    abort the downstream phases (code indexing, component bridge, block
      //    seeding) the ingest handler runs AFTER bootstrap. ENTITY and AGENT
      //    merges above stay hard-fail — only seeding is best-effort. The result
      //    still reflects exactly the seeds that succeeded.
      for (const seed of input.semantic_seeds) {
        try {
          const semId = await this.createSemantic(session, seed, input.project_tag, result);

          // Link ABOUT relationships to named entities
          for (const entityName of seed.about ?? []) {
            const entityResult = await session.run(
              'MATCH (e:Entity {name: $name}) RETURN e.id AS id',
              { name: entityName },
            );
            if (entityResult.records.length > 0) {
              const entityId = entityResult.records[0].get('id') as string;
              await session.run(
                `MATCH (s:Semantic {id: $semId}), (e:Entity {id: $entityId})
                 MERGE (s)-[:ABOUT]->(e)`,
                { semId, entityId },
              );
              result.relationships_created++;
            }
          }
        } catch (err) {
          // Skip this seed and continue with the rest. A single failed seed must
          // not take down the whole bootstrap (and the phases that follow it).
          console.warn(
            `[bootstrap] semantic seed failed, skipping: ${seed.claim?.slice(0, 80) ?? '<no claim>'} — ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      // 5. Link all existing orphaned Episodic nodes for this project to the
      //    project entity. Use the STRUCTURED match the wiki queries (gap-13/T7)
      //    already use — `ep.task CONTAINS $tag` substring-matched unrelated
      //    projects ('foo' bootstrap linked 'project:foobar' episodes).
      //    An episode belongs here when ANY holds:
      //      1. ep.scope equals the canonical project tag (structured, primary),
      //      2. the canonical tag is in ep.tags (structured, primary),
      //      3. the legacy `[project:…]` task prefix is present (FALLBACK).
      //    `canonTag` must match berry_store byte-for-byte: store persists
      //    ep.scope/ep.tags as `rawTag.toLowerCase()` (lowercase, NOT slugified),
      //    so we lowercase here too. `input.project_tag` may arrive mixed-case
      //    (berry_bootstrap passes it through un-normalized), hence the explicit
      //    fold. The task fallback uses a BRACKETED token, never a bare substring.
      const canonTag = projectScope;
      const taskTag = `[project:${input.project_name}]`;
      const orphanResult = await session.run(
        `MATCH (ep:Episodic)
         WHERE (ep.scope = $canonTag OR $canonTag IN ep.tags OR ep.task CONTAINS $taskTag)
           AND NOT (ep)-[:REFERENCES]->(:Entity {name: $projectName})
         WITH ep
         MATCH (proj:Entity {name: $projectName})
         CREATE (ep)-[:REFERENCES]->(proj)
         RETURN count(ep) AS linked`,
        { canonTag, taskTag, projectName: input.project_name },
      );
      const linked = orphanResult.records[0]?.get('linked');
      if (linked) {
        const count = typeof linked === 'number' ? linked : (linked as { toNumber(): number }).toNumber();
        result.relationships_created += count;
      }

      return result;
    } finally {
      await session.close();
    }
  }

  /**
   * Check if a project has been bootstrapped.
   */
  async isBootstrapped(projectName: string): Promise<boolean> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        'MATCH (e:Entity {name: $name, type: "project"}) RETURN count(e) AS count',
        { name: projectName },
      );
      const count = result.records[0]?.get('count');
      return (typeof count === 'number' ? count : (count as { toNumber(): number }).toNumber()) > 0;
    } finally {
      await session.close();
    }
  }

  /**
   * Get bootstrap status for a project — what nodes and relationships exist.
   */
  async status(projectName: string): Promise<{
    bootstrapped: boolean;
    entities: number;
    agents: number;
    semantics: number;
    episodics: number;
    relationships: number;
  }> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        `OPTIONAL MATCH (proj:Entity {name: $name, type: 'project'})
         WITH proj
         OPTIONAL MATCH (proj)<-[:CONTAINS*0..]-(e:Entity)
         WITH proj, count(DISTINCT e) AS entityCount
         OPTIONAL MATCH (a:Agent)
         WITH proj, entityCount, count(a) AS agentCount
         OPTIONAL MATCH (s:Semantic)
         WITH proj, entityCount, agentCount, count(s) AS semCount
         OPTIONAL MATCH (ep:Episodic)
         WITH proj, entityCount, agentCount, semCount, count(ep) AS epCount
         OPTIONAL MATCH ()-[r]->()
         WHERE type(r) <> 'OBSERVES' AND type(r) <> 'RECOMMENDS_FOR'
         RETURN proj IS NOT NULL AS bootstrapped,
                entityCount, agentCount, semCount, epCount, count(r) AS relCount`,
        { name: projectName },
      );
      const r = result.records[0];
      const toNum = (v: unknown) => {
        if (typeof v === 'number') return v;
        if (v && typeof v === 'object' && 'toNumber' in v) return (v as { toNumber(): number }).toNumber();
        return 0;
      };
      return {
        bootstrapped: r.get('bootstrapped') as boolean,
        entities: toNum(r.get('entityCount')),
        agents: toNum(r.get('agentCount')),
        semantics: toNum(r.get('semCount')),
        episodics: toNum(r.get('epCount')),
        relationships: toNum(r.get('relCount')),
      };
    } finally {
      await session.close();
    }
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private async mergeEntity(
    session: ReturnType<Driver['session']>,
    entity: BootstrapEntity,
    result: BootstrapResult,
    projectScope?: string,
  ): Promise<string> {
    // Item 14a: overwrite (not coalesce) — the latest confined ingest root is
    // the truth. Clause is omitted entirely when absent so the query text is
    // unchanged for callers that never set it.
    const rootPathClause = entity.root_path !== undefined ? ' SET e.root_path = $rootPath' : '';
    const res = await session.run(
      `MERGE (e:Entity {name: $name})
       ON CREATE SET e.id = $id, e.type = $type, e.description = $description,
                     e.created_at = $now, e.project_scope = $projectScope
       ON MATCH SET e.description = CASE WHEN $description IS NOT NULL THEN $description ELSE e.description END,
                    e.type = CASE WHEN $type = 'project' THEN 'project' ELSE e.type END,
                    e.project_scope = CASE
                      WHEN $projectScope IS NOT NULL AND e.project_scope IS NULL THEN $projectScope
                      ELSE e.project_scope
                    END${rootPathClause}
       RETURN e.id AS id, e.created_at = $now AS isNew,
              e.project_scope AS storedProjectScope`,
      {
        name: entity.name,
        id: nanoid(),
        type: entity.type,
        description: entity.description ?? null,
        projectScope: projectScope ?? null,
        now: new Date().toISOString(),
        ...(entity.root_path !== undefined ? { rootPath: entity.root_path } : {}),
      },
    );
    const storedProjectScope = res.records[0].get('storedProjectScope') as unknown;
    if (projectScope !== undefined && storedProjectScope !== projectScope) {
      throw new Error('bootstrap: project scope conflicts with existing project authority');
    }
    const isNew = res.records[0].get('isNew') as boolean;
    if (isNew) result.entities_created++;
    else result.entities_existing++;
    return res.records[0].get('id') as string;
  }

  private async mergeAgent(
    session: ReturnType<Driver['session']>,
    agent: BootstrapAgent,
    result: BootstrapResult,
  ): Promise<void> {
    const res = await session.run(
      `MERGE (a:Agent {id: $id})
       ON CREATE SET a.name = $name, a.type = $type, a.created_at = $now
       RETURN a.created_at = $now AS isNew`,
      { id: agent.id, name: agent.name, type: agent.type, now: new Date().toISOString() },
    );
    const isNew = res.records[0].get('isNew') as boolean;
    if (isNew) result.agents_created++;
    else result.agents_existing++;
  }

  private async createSemantic(
    session: ReturnType<Driver['session']>,
    seed: BootstrapSemantic,
    projectTag: string,
    result: BootstrapResult,
  ): Promise<string> {
    const id = `sem-${nanoid(10)}`;
    const now = new Date().toISOString();
    const scope = projectTag.toLowerCase();
    // The project tag is stored lowercase to match `scope`; without this the
    // tag-scoped retrieval channel can't match a canonical lowercase project tag
    // against an upper-cased stored tag (the casing-fragmentation bug).
    const tags = [scope, seed.domain, ...(seed.tags ?? [])];
    // Dedupe key is computed in JS (a short hash, not a long raw string) and used
    // as the MERGE anchor so re-ingesting the SAME seed does not duplicate it.
    const dedupeKey = semanticDedupeKey(scope, seed.about?.[0], seed.claim);

    // Embed the claim so the seeded semantic is vector-recallable. Best-effort:
    // a missing/degraded provider or an embed failure just yields a non-vector
    // (still tag/scope-recallable) seed rather than failing the bootstrap.
    let embedding: number[] | undefined;
    if (this.embedding && this.embedding.available !== false && seed.claim) {
      try {
        embedding = await this.embedding.embed(seed.claim);
      } catch (err: unknown) {
        console.error(
          '[bootstrap-graph] seed embedding failed; semantic will not be vector-recallable:',
          err instanceof Error ? err.message : err,
        );
      }
    }

    // MERGE (not CREATE) on the stable dedupe_key: ON CREATE seeds all props with
    // a fresh id; ON MATCH only touches updated_at (no new id, no signal_count
    // bump, no duplicate node). `isNew` lets us count creations only — matched
    // re-ingests don't inflate semantics_created. The MERGE returns the existing
    // node's id when matched, so ABOUT linking (in bootstrap()) targets the right
    // node either way.
    const res = await session.run(
      `MERGE (s:Semantic {dedupe_key: $dedupeKey})
       ON CREATE SET s.id = $id,
                     s.content = $content,
                     s.confidence = $confidence,
                     s.signal_count = 0,
                     s.created_at = $now,
                     s.valid_at = $now,
                     s.updated_at = $now,
                     s.decay_class = 'stable',
                     s.tags = $tags,
                     s.scope = $scope${embedding ? ',\n                     s.embedding = $embedding' : ''}
       ON MATCH SET s.updated_at = $now${embedding ? ', s.embedding = coalesce(s.embedding, $embedding)' : ''}
       RETURN s.id AS id, s.created_at = $now AS isNew`,
      {
        dedupeKey,
        id,
        content: seed.claim,
        confidence: seed.confidence ?? 0.3,
        now,
        tags,
        scope,
        ...(embedding ? { embedding } : {}),
      },
    );
    const isNew = res.records[0].get('isNew') as boolean;
    if (isNew) result.semantics_created++;
    return res.records[0].get('id') as string;
  }

  private async mergeRelationship(
    session: ReturnType<Driver['session']>,
    fromId: string,
    toId: string,
    relType: string,
    result: BootstrapResult,
  ): Promise<void> {
    // Relationship types can't be parameterized in Cypher; the allowlist check
    // is what makes interpolating one safe. Value-free error on purpose.
    if (!BOOTSTRAP_RELATION_TYPES.has(relType)) {
      throw new Error('invalid_relationship_type');
    }
    await session.run(
      `MATCH (a:Entity {id: $fromId}), (b:Entity {id: $toId})
       MERGE (a)-[:${relType}]->(b)`,
      { fromId, toId },
    );
    result.relationships_created++;
  }
}
