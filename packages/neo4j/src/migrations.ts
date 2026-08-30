// packages/neo4j/src/migrations.ts
//
// Forward-only schema migration runner for the MemBerry graph.
//
// DESIGN PRINCIPLE — "neutral IDs, additive schema":
//   Runtime node identity is assigned by the application (nanoid with neutral
//   prefixes: sem-/ep-/fact-/ent-/sym-/...), never by the schema. Node *labels*
//   and *properties* are additive and backward-compatible by construction, so a
//   fresh `initSchema()` is safe to re-run on any existing graph. That is why we
//   do not need destructive/down migrations for ordinary evolution.
//
// What this runner ADDS on top of idempotent `initSchema()`:
//   1. A persisted, auditable record of which migrations ran and when
//      (a singleton :SchemaVersion node).
//   2. An ordered way to apply *new* schema changes exactly once (e.g. a new
//      index, or recreating a vector index after an embedding-dimension change)
//      without re-running expensive backfills on every boot.
//   3. Drift detection for vector-index dimensions (see checkVectorIndexDimensions).
//
// The runner is idempotent: migrations already recorded in :SchemaVersion.applied
// are skipped. An interrupted run is safe to retry because every schema statement
// uses `IF NOT EXISTS` and every data statement is guarded by a self-extinguishing
// predicate.

import type { Driver } from 'neo4j-driver';
import { EMBEDDING_DIM } from '@memberry/core';
import { initSchema } from './schema.js';

export interface Migration {
  /** Stable, unique, ordered id. Convention: NNNN-kebab-description. */
  id: string;
  description: string;
  up(driver: Driver): Promise<void>;
  /** Optional operator-invoked rollback for migrations that remove schema capabilities. */
  down?(driver: Driver): Promise<void>;
}

/** Singleton node id used to track applied migrations. */
export const SCHEMA_VERSION_ID = 'memberry-schema';

/**
 * Ordered migration list. APPEND new migrations — never reorder or rewrite
 * an already-shipped entry, or deployments will diverge.
 */
export const MIGRATIONS: Migration[] = [
  {
    id: '0001-initial-schema',
    description:
      'Baseline constraints, plain/fulltext/vector indexes for episodic, semantic, ' +
      'entity, agent, model, memory-block and fact nodes.',
    up: async (driver) => {
      await initSchema(driver);
    },
  },
  {
    id: '0002-audit-log',
    description: 'Append-only audit trail: unique id constraint + (actor, at) lookup indexes.',
    up: async (driver) => {
      const session = driver.session();
      try {
        for (const stmt of [
          'CREATE CONSTRAINT audit_id IF NOT EXISTS FOR (a:AuditLog) REQUIRE a.id IS UNIQUE',
          'CREATE INDEX audit_at IF NOT EXISTS FOR (a:AuditLog) ON (a.at)',
          'CREATE INDEX audit_actor IF NOT EXISTS FOR (a:AuditLog) ON (a.actor)',
          'CREATE INDEX audit_scope IF NOT EXISTS FOR (a:AuditLog) ON (a.scope)',
        ]) {
          await session.run(stmt);
        }
      } finally {
        await session.close();
      }
    },
  },
  {
    id: '0003-tenant-indexes',
    description: 'Tenant isolation: indexes on tenant_id for the tenant-scoped node types.',
    up: async (driver) => {
      const session = driver.session();
      try {
        for (const stmt of [
          'CREATE INDEX episodic_tenant IF NOT EXISTS FOR (e:Episodic) ON (e.tenant_id)',
          'CREATE INDEX semantic_tenant IF NOT EXISTS FOR (s:Semantic) ON (s.tenant_id)',
          'CREATE INDEX fact_tenant IF NOT EXISTS FOR (f:Fact) ON (f.tenant_id)',
          'CREATE INDEX memblock_tenant IF NOT EXISTS FOR (b:MemoryBlock) ON (b.tenant_id)',
        ]) {
          await session.run(stmt);
        }
      } finally {
        await session.close();
      }
    },
  },
  {
    id: '0004-tenant-block-uniqueness',
    description:
      'Widen MemoryBlock uniqueness from (scope,name) to (scope,name,tenant_id) so two ' +
      'tenants can hold a same-named block; backfill existing blocks to the default tenant.',
    up: async (driver) => {
      const session = driver.session();
      try {
        // Existing blocks predate tenancy → default tenant (so the new MERGE key,
        // which includes tenant_id, matches them instead of creating duplicates).
        await session.run("MATCH (b:MemoryBlock) WHERE b.tenant_id IS NULL SET b.tenant_id = 'default'");
        // (scope,name,tenant_id) is strictly more permissive than (scope,name),
        // so this can't introduce new violations on existing data.
        await session.run('DROP CONSTRAINT memblock_scope_name IF EXISTS');
        await session.run(
          'CREATE CONSTRAINT memblock_scope_name_tenant IF NOT EXISTS ' +
          'FOR (b:MemoryBlock) REQUIRE (b.scope, b.name, b.tenant_id) IS UNIQUE',
        );
      } finally {
        await session.close();
      }
    },
  },
  {
    id: '0005-injection-log',
    description:
      'Injection telemetry: unique id constraint + lookup indexes for :InjectionLog ' +
      'nodes (session, time, scope, usage). Schema lands before any writer so later ' +
      'phases ship against a stable shape.',
    up: async (driver) => {
      const session = driver.session();
      try {
        for (const stmt of [
          'CREATE CONSTRAINT injection_id IF NOT EXISTS FOR (i:InjectionLog) REQUIRE i.id IS UNIQUE',
          'CREATE INDEX injection_session IF NOT EXISTS FOR (i:InjectionLog) ON (i.session_id)',
          'CREATE INDEX injection_at IF NOT EXISTS FOR (i:InjectionLog) ON (i.injected_at)',
          'CREATE INDEX injection_scope IF NOT EXISTS FOR (i:InjectionLog) ON (i.scope)',
          'CREATE INDEX injection_usage IF NOT EXISTS FOR (i:InjectionLog) ON (i.usage)',
        ]) {
          await session.run(stmt);
        }
      } finally {
        await session.close();
      }
    },
  },
  {
    id: '0006-structural-scope',
    description:
      'Structural tenancy: backfill Semantic.scope (and null Episodic.scope) from the ' +
      'first project:* tag, lowercased, and index scope on both labels. After this, ' +
      'project scope is an enforced storage column, not an advisory tag.',
    up: async (driver) => {
      const session = driver.session();
      try {
        // Backfill from tags. Nodes with no project:* tag keep scope NULL —
        // they are project-unaffiliated and excluded from project-scoped loads.
        await session.run(
          `MATCH (s:Semantic) WHERE s.scope IS NULL
           WITH s, [t IN coalesce(s.tags, []) WHERE toLower(t) STARTS WITH 'project:' AND toLower(t) <> 'project:*'] AS ptags
           WHERE size(ptags) > 0
           SET s.scope = toLower(ptags[0])`,
        );
        await session.run(
          `MATCH (e:Episodic) WHERE e.scope IS NULL
           WITH e, [t IN coalesce(e.tags, []) WHERE toLower(t) STARTS WITH 'project:' AND toLower(t) <> 'project:*'] AS ptags
           WHERE size(ptags) > 0
           SET e.scope = toLower(ptags[0])`,
        );
        // Normalize any pre-existing mixed-case scopes so equality filters hold.
        await session.run(
          'MATCH (s:Semantic) WHERE s.scope IS NOT NULL AND s.scope <> toLower(s.scope) SET s.scope = toLower(s.scope)',
        );
        await session.run(
          'MATCH (e:Episodic) WHERE e.scope IS NOT NULL AND e.scope <> toLower(e.scope) SET e.scope = toLower(e.scope)',
        );
        for (const stmt of [
          'CREATE INDEX semantic_scope IF NOT EXISTS FOR (s:Semantic) ON (s.scope)',
          'CREATE INDEX episodic_scope IF NOT EXISTS FOR (e:Episodic) ON (e.scope)',
        ]) {
          await session.run(stmt);
        }
      } finally {
        await session.close();
      }
    },
  },
  {
    id: '0007-admission-observation-sidecar',
    description:
      'Shadow admission observations: unique internal id and tenant/project lookup index. ' +
      'No existing memory nodes or relationships are rewritten.',
    up: async (driver) => {
      const session = driver.session();
      try {
        await session.run(
          'CREATE CONSTRAINT admission_observation_id IF NOT EXISTS ' +
          'FOR (o:AdmissionObservation) REQUIRE o.id IS UNIQUE',
        );
        await session.run(
          'CREATE INDEX admission_observation_tenant_project IF NOT EXISTS ' +
          'FOR (o:AdmissionObservation) ON (o.tenant_id, o.project_scope)',
        );
      } finally {
        await session.close();
      }
    },
  },
  {
    id: '0008-evidence-authority-ledger-v1',
    description:
      'Append-only, tenant/project-bound Semantic evidence coverage, cases, adjudication ' +
      'events, and transactionally paired outbox. Schema only; existing rows are untouched.',
    up: async (driver) => {
      const session = driver.session();
      try {
        for (const stmt of [
          'CREATE CONSTRAINT evidence_authority_ledger_id IF NOT EXISTS FOR (n:EvidenceAuthorityLedger) REQUIRE n.id IS UNIQUE',
          'CREATE CONSTRAINT evidence_authority_coverage_id IF NOT EXISTS FOR (n:EvidenceAuthorityCoverage) REQUIRE n.id IS UNIQUE',
          'CREATE CONSTRAINT evidence_authority_case_id IF NOT EXISTS FOR (n:EvidenceAuthorityCase) REQUIRE n.id IS UNIQUE',
          'CREATE CONSTRAINT evidence_authority_event_id IF NOT EXISTS FOR (n:EvidenceAuthorityEvent) REQUIRE n.id IS UNIQUE',
          'CREATE CONSTRAINT evidence_authority_outbox_id IF NOT EXISTS FOR (n:EvidenceAuthorityOutbox) REQUIRE n.id IS UNIQUE',
          'CREATE INDEX evidence_authority_ledger_scope IF NOT EXISTS FOR (n:EvidenceAuthorityLedger) ON (n.tenant_id, n.project_scope, n.semantic_id)',
          'CREATE INDEX evidence_authority_coverage_scope IF NOT EXISTS FOR (n:EvidenceAuthorityCoverage) ON (n.tenant_id, n.project_scope, n.semantic_id)',
          'CREATE INDEX evidence_authority_case_scope IF NOT EXISTS FOR (n:EvidenceAuthorityCase) ON (n.tenant_id, n.project_scope, n.semantic_id)',
          'CREATE INDEX evidence_authority_case_identity IF NOT EXISTS FOR (n:EvidenceAuthorityCase) ON (n.coverage_id, n.case_id)',
          'CREATE INDEX evidence_authority_event_scope IF NOT EXISTS FOR (n:EvidenceAuthorityEvent) ON (n.tenant_id, n.project_scope, n.semantic_id)',
          'CREATE INDEX evidence_authority_event_target IF NOT EXISTS FOR (n:EvidenceAuthorityEvent) ON (n.case_id, n.sequence)',
          'CREATE INDEX evidence_authority_outbox_scope IF NOT EXISTS FOR (n:EvidenceAuthorityOutbox) ON (n.tenant_id, n.project_scope, n.recorded_at)',
          'CREATE INDEX evidence_authority_outbox_event IF NOT EXISTS FOR (n:EvidenceAuthorityOutbox) ON (n.event_id)',
        ]) {
          await session.run(stmt);
        }
      } finally {
        await session.close();
      }
    },
  },
  // ORDER IS LOAD-BEARING — do not swap these two statements.
  //
  // The second statement's third disjunct (`s.invalid_at IS NOT NULL`) reads state
  // that only the first statement writes. Run them the other way round and that
  // disjunct is false for every archived legacy node — the whole archived cohort
  // would be skipped by the valid_at pass and left permanently uncovered, which
  // repairs nothing.
  //
  // Crashing between the two statements is safe: archived nodes are left holding
  // invalid_at with no valid_at, which reads as not-live under either plausible
  // reader rule, and a replay converges on the intended end state. Both predicates
  // are self-extinguishing (each only matches rows it has not yet written), so a
  // replay after a failed migration-record write is a no-op.
  //
  // The `s.archived_at IS NOT NULL` guard in the first statement only avoids a
  // pointless no-op write; it is not load-bearing for correctness.
  {
    id: '0009-semantic-lifecycle-backfill',
    description:
      'Backfill the Semantic lifecycle window on pre-existing nodes: invalid_at from ' +
      'archived_at for archived rows, then valid_at from created_at. Nodes created before ' +
      'these properties existed carry neither; this gives the legacy population the same ' +
      'shape CREATE now stamps.',
    up: async (driver) => {
      const session = driver.session();
      try {
        for (const stmt of [
          `MATCH (s:Semantic)
           WHERE s.archived = true AND s.invalid_at IS NULL AND s.archived_at IS NOT NULL
           SET s.invalid_at = s.archived_at`,
          `MATCH (s:Semantic)
           WHERE s.valid_at IS NULL AND s.created_at IS NOT NULL
             AND (s.archived IS NULL OR s.archived = false OR s.invalid_at IS NOT NULL)
           SET s.valid_at = s.created_at`,
        ]) {
          await session.run(stmt);
        }
      } finally {
        await session.close();
      }
    },
  },
  {
    id: '0010-prune-unserved-derived-indexes',
    description:
      'Drop derived indexes with no production reader while retaining their node properties for ' +
      'rollback. fact_content remains for bounded shadow qualification.',
    up: async (driver) => {
      const session = driver.session();
      try {
        for (const stmt of [
          'DROP INDEX semantic_content IF EXISTS',
          'DROP INDEX episodic_content IF EXISTS',
          'DROP INDEX fact_embedding IF EXISTS',
          'DROP INDEX aspect_content IF EXISTS',
          'DROP INDEX symbol_mini IF EXISTS',
          'DROP INDEX symbol_content_hash IF EXISTS',
        ]) {
          await session.run(stmt);
        }
      } finally {
        await session.close();
      }
    },
    down: async (driver) => {
      const session = driver.session();
      try {
        for (const stmt of [
          'CREATE FULLTEXT INDEX semantic_content IF NOT EXISTS FOR (s:Semantic) ON EACH [s.content]',
          'CREATE FULLTEXT INDEX episodic_content IF NOT EXISTS FOR (e:Episodic) ON EACH [e.content]',
          `CREATE VECTOR INDEX fact_embedding IF NOT EXISTS FOR (f:Fact) ON (f.embedding) OPTIONS {indexConfig: {\`vector.dimensions\`: ${EMBEDDING_DIM}, \`vector.similarity_function\`: 'cosine'}}`,
          'CREATE FULLTEXT INDEX aspect_content IF NOT EXISTS FOR (a:Aspect) ON EACH [a.name, a.description]',
          'CREATE VECTOR INDEX symbol_mini IF NOT EXISTS FOR (s:Symbol) ON (s.mini_vector) OPTIONS {indexConfig: {`vector.dimensions`: 64, `vector.similarity_function`: \'cosine\'}}',
          'CREATE INDEX symbol_content_hash IF NOT EXISTS FOR (s:Symbol) ON (s.content_hash)',
        ]) {
          await session.run(stmt);
        }
      } finally {
        await session.close();
      }
    },
  },
  {
    id: '0011-episodic-structured-index',
    description: 'Add reversible derived episodic index-key schema for IDX-001A.',
    up: async (driver) => {
      const session = driver.session();
      try {
        for (const statement of [
          'CREATE CONSTRAINT episodic_index_key_id IF NOT EXISTS FOR (k:EpisodicIndexKey) REQUIRE k.id IS UNIQUE',
          'CREATE INDEX episodic_index_key_episode IF NOT EXISTS FOR (k:EpisodicIndexKey) ON (k.episode_id)',
          'CREATE INDEX episodic_index_key_scope IF NOT EXISTS FOR (k:EpisodicIndexKey) ON (k.tenant_id, k.project_scope)',
          `CREATE VECTOR INDEX episodic_index_key_embedding IF NOT EXISTS FOR (k:EpisodicIndexKey) ON (k.embedding) OPTIONS {indexConfig: {\`vector.dimensions\`: ${EMBEDDING_DIM}, \`vector.similarity_function\`: 'cosine'}}`,
        ]) await session.run(statement);
      } finally {
        await session.close();
      }
    },
    down: async (driver) => {
      const session = driver.session();
      try {
        // Schema rollback is non-destructive: derived nodes remain available for
        // inspection or retry. `memberry index-backfill reset` deletes only
        // EpisodicIndexKey nodes when the operator explicitly requests it.
        for (const statement of [
          'DROP INDEX episodic_index_key_embedding IF EXISTS',
          'DROP INDEX episodic_index_key_scope IF EXISTS',
          'DROP INDEX episodic_index_key_episode IF EXISTS',
          'DROP CONSTRAINT episodic_index_key_id IF EXISTS',
        ]) await session.run(statement);
      } finally {
        await session.close();
      }
    },
  },
];

export interface MigrationResult {
  /** Migration ids applied during this run (in order). */
  applied: string[];
  /** Migration ids skipped because they were already recorded. */
  skipped: string[];
  /** Total number of migrations now recorded as applied. */
  version: number;
}

async function readAppliedMigrations(driver: Driver): Promise<string[]> {
  const session = driver.session();
  try {
    const res = await session.run(
      'MATCH (v:SchemaVersion {id: $id}) RETURN v.applied AS applied',
      { id: SCHEMA_VERSION_ID },
    );
    if (res.records.length === 0) return [];
    const applied = res.records[0].get('applied');
    if (!Array.isArray(applied)) return [];
    return applied.map((x) => String(x));
  } finally {
    await session.close();
  }
}

async function recordApplied(driver: Driver, applied: string[]): Promise<void> {
  const session = driver.session();
  try {
    await session.run(
      `MERGE (v:SchemaVersion {id: $id})
       SET v.applied = $applied, v.version = $version, v.updated_at = $ts`,
      { id: SCHEMA_VERSION_ID, applied, version: applied.length, ts: new Date().toISOString() },
    );
  } finally {
    await session.close();
  }
}

/**
 * Apply all pending migrations in order, recording each in :SchemaVersion.
 * Idempotent: already-applied migrations are skipped. Safe to run at every boot.
 *
 * @param migrations override for tests; defaults to the shipped MIGRATIONS list.
 */
export async function runMigrations(
  driver: Driver,
  migrations: Migration[] = MIGRATIONS,
): Promise<MigrationResult> {
  const alreadyApplied = new Set(await readAppliedMigrations(driver));
  const applied = [...alreadyApplied];
  const skipped: string[] = [];
  const newlyApplied: string[] = [];

  for (const migration of migrations) {
    if (alreadyApplied.has(migration.id)) {
      skipped.push(migration.id);
      continue;
    }
    await migration.up(driver);
    applied.push(migration.id);
    newlyApplied.push(migration.id);
    // Record after each migration so a crash mid-run doesn't replay completed ones.
    await recordApplied(driver, applied);
  }

  return { applied: newlyApplied, skipped, version: applied.length };
}

/** The node property holding an embedding-model vector. Vector indexes over any
 *  OTHER properties such as lexical_vector are not embedding indexes and are
 *  exempt from the EMBEDDING_DIM drift check. */
const EMBEDDING_PROPERTY = 'embedding';

export interface VectorIndexDimension {
  name: string;
  actual: number;
  expected: number;
}

/**
 * Best-effort drift check: compares each EMBEDDING vector index's configured
 * dimension against EMBEDDING_DIM. A mismatch means similarity queries will fail
 * or return garbage until the index is dropped and recreated. Returns the
 * mismatches (empty when all good, or when the server doesn't support the
 * introspection query).
 *
 * Only indexes over the `embedding` property are checked. Not every vector index
 * holds an embedding-model vector: `symbol_lexical` is a 4096-d hashed lexical
 * vector, and comparing it against EMBEDDING_DIM reported a permanent "mismatch" that pinned the
 * server in DEGRADED MODE — masking the real degradation the mode exists to show.
 */
/** A label whose embedding coverage has fallen below the floor. `ratio` is 0..1. */
export interface VectorIndexCoverage {
  label: string;
  nodes: number;
  embedded: number;
  ratio: number;
}

/**
 * Coverage floor. Deliberately not 1.0: indexing and embedding are not atomic, so a live system
 * always has a few just-written nodes awaiting a vector.
 *
 * Two different numbers follow from the current Symbol population of 54,314/54,314, and they are
 * NOT the same scenario:
 *   - ~2,715 existing symbols could LOSE their embedding before the floor trips (denominator
 *     fixed at 54,314; 5% of it).
 *   - ~2,860 NEW un-embedded symbols must arrive to trip it (the denominator grows with them:
 *     new > 0.05 * (54,314 + new)).
 */
const COVERAGE_FLOOR = 0.95;

/**
 * IDX-003 fail-loud guard, widened by IDX-004. The dimension check above catches an index whose
 * shape drifted. It does NOT catch the failure that actually happened: an index created
 * correctly and never written to, because the writer was constructed without an embedding
 * provider. Every query against it returns zero rows and the channel reports SUCCESS, so
 * retrieval silently degrades to lexical-only with nothing in any log. That shipped on the
 * memory side once and on the code side for the entire life of the code index.
 *
 * IDX-004 CHANGES THE PREDICATE, and reverses a recorded IDX-003 decision. The original guard
 * fired only at `embedded === 0`, on the reasoning that one embedding proves the writer is wired
 * and reporting a partial state "would cry wolf through every backfill". That was correct while
 * a backfill was the expected state. It is now obsolete, and its cost was concrete: it called
 * Symbol at 16,399/54,314 — 30% — perfectly healthy.
 *
 * The residual cry-wolf window is real and narrow, and is being shipped stated rather than
 * hidden: indexing a NEW project of ~2,860+ symbols and restarting the server before its embed
 * pass completes will report DEGRADED, pinned for that process lifetime (the guard runs once, at
 * boot). That requires a restart mid-backfill.
 */
/**
 * Labels whose embeddings are actually READ by a retrieval channel.
 *
 * `Fact` is deliberately absent. Migration 0010 drops the unserved `fact_embedding` index;
 * a future versioned Fact vector channel must add Fact here only after its reader ships. The guard
 * exists to catch ONE failure: a vector index that queries hit and silently get nothing from.
 * Until then Fact coverage cannot produce a served-reader failure. The active exact-entity Fact
 * channel remains independent of embeddings.
 *
 * Add a label here when something starts reading its embeddings, not before.
 */
const EMBEDDING_READ_LABELS = ['Symbol', 'Semantic', 'Episodic'] as const;

export async function checkVectorIndexCoverage(driver: Driver): Promise<VectorIndexCoverage[]> {
  const session = driver.session();
  try {
    const under: VectorIndexCoverage[] = [];
    for (const label of EMBEDDING_READ_LABELS) {
      const res = await session.run(
        `MATCH (n:${label})
         RETURN count(n) AS nodes,
                sum(CASE WHEN n.${EMBEDDING_PROPERTY} IS NOT NULL THEN 1 ELSE 0 END) AS embedded`,
      );
      const record = res.records[0];
      if (!record) continue;
      const nodes = Number(record.get('nodes'));
      const embedded = Number(record.get('embedded'));
      // A label with no nodes is not a defect — nothing is wrong with empty.
      if (nodes === 0) continue;
      const ratio = embedded / nodes;
      // Written `!(ratio >= FLOOR)` rather than `ratio < FLOOR` so a NaN ratio REPORTS instead of
      // silently passing. That also makes the `nodes === 0` guard above load-bearing and
      // therefore testable: remove it and a zero-node label yields 0/0 = NaN, which reports.
      if (!(ratio >= COVERAGE_FLOOR)) under.push({ label, nodes, embedded, ratio });
    }
    return under;
  } catch {
    // Restricted permissions or an unavailable server: skip the guard rather
    // than fail boot, exactly as the dimension check does.
    return [];
  } finally {
    await session.close();
  }
}

export async function checkVectorIndexDimensions(driver: Driver): Promise<VectorIndexDimension[]> {
  const session = driver.session();
  try {
    const res = await session.run(
      "SHOW INDEXES YIELD name, type, properties, options WHERE type = 'VECTOR' RETURN name, properties, options",
    );
    const mismatches: VectorIndexDimension[] = [];
    for (const record of res.records) {
      const name = String(record.get('name'));
      // Skip non-embedding vector indexes (lexical/mini vectors have their own dimensions).
      const properties = (record.get('properties') as string[] | null) ?? [];
      if (!properties.includes(EMBEDDING_PROPERTY)) continue;
      const options = record.get('options') as Record<string, unknown> | null;
      const indexConfig = (options?.['indexConfig'] ?? {}) as Record<string, unknown>;
      const rawDim = indexConfig['vector.dimensions'];
      if (rawDim == null) continue;
      const actual = Number(rawDim);
      if (Number.isFinite(actual) && actual !== EMBEDDING_DIM) {
        mismatches.push({ name, actual, expected: EMBEDDING_DIM });
      }
    }
    return mismatches;
  } catch {
    // Older servers / restricted permissions: skip drift detection rather than fail boot.
    return [];
  } finally {
    await session.close();
  }
}
