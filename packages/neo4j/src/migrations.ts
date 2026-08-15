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
// are skipped. Because every individual statement also uses `IF NOT EXISTS`, an
// interrupted run is safe to retry.

import type { Driver } from 'neo4j-driver';
import { EMBEDDING_DIM } from '@memberry/core';
import { initSchema } from './schema.js';

export interface Migration {
  /** Stable, unique, ordered id. Convention: NNNN-kebab-description. */
  id: string;
  description: string;
  up(driver: Driver): Promise<void>;
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
 *  OTHER property (lexical_vector, mini_vector) are not embedding indexes and are
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
 * holds an embedding-model vector: `symbol_lexical` (4096-d hashed lexical) and
 * `symbol_mini` (64-d reduced) are deliberately other dimensions, and comparing
 * them against EMBEDDING_DIM reported two permanent "mismatches" that pinned the
 * server in DEGRADED MODE — masking the real degradation the mode exists to show.
 */
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
