import { randomUUID } from 'node:crypto';

import {
  TrustedAdmissionPreprocessorV1,
  createAdmissionObservationV1,
  type AdmissionObservationV1,
  type EpisodicNode,
} from '@memberry/core';
import type { Driver, ManagedTransaction } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AdmissionObservationStore,
  AdmissionObservationStoreError,
  type AdmissionObservationScopeV1,
} from '../admission-observation.js';
import { createNeo4jDriver } from '../driver.js';
import { EpisodicStore } from '../episodic.js';
import { MIGRATIONS } from '../migrations.js';
import { TenantAdmin } from '../tenant-admin.js';

const LIVE_ENABLED = process.env.MEMBERRY_NEO4J_INTEGRATION === '1';
const describeLive = LIVE_ENABLED ? describe : describe.skip;
const uri = process.env.NEO4J_URI || 'bolt://localhost:7687';
const user = process.env.NEO4J_USER || 'neo4j';
const password = process.env.NEO4J_PASSWORD || 'password';
const suffix = randomUUID().toLowerCase();
const tenantId = `test-admission-${suffix}`;
const projectScope = `project:test-admission-${suffix}`;
const scopeFor = (name: string): AdmissionObservationScopeV1 => ({
  tenantId,
  projectScope,
  episodeId: `ep-test-admission-${name}-${suffix}`,
});
const primaryScope = scopeFor('primary');
const ambiguousScope = scopeFor('ambiguous');
const rollbackScope = scopeFor('rollback');
const wrongTargetScope = scopeFor('wrong-target');
const allScopes = [primaryScope, ambiguousScope, rollbackScope, wrongTargetScope];
const SECRET_CANARY = ['sk', 'live', `disposable-${suffix}`].join('_');
const driver = createNeo4jDriver(uri, user, password);

function observation(at: string): AdmissionObservationV1 {
  const safeFacts = new TrustedAdmissionPreprocessorV1().preprocess({
    captureState: 'accepted-nonduplicate',
    task: 'live sidecar test',
    content: `disposable synthetic fixture ${SECRET_CANARY}`,
    tags: [projectScope],
    scope: projectScope,
    tenantId,
    redactionConfigured: true,
    memoryType: 'decision',
    outcome: 'approved',
    hasSignals: false,
    hasEntities: false,
    hasModel: false,
  });
  return createAdmissionObservationV1({ safeFacts }, { now: () => new Date(at) });
}

function episode(scope: AdmissionObservationScopeV1): EpisodicNode {
  return {
    id: scope.episodeId,
    session_id: `session-${suffix}`,
    agent_id: `agent-${suffix}`,
    task: 'disposable admission integration fixture',
    content: 'synthetic non-production episode',
    outcome: 'approved',
    memory_type: 'decision',
    created_at: '2026-08-14T00:00:00.000Z',
    scope: projectScope,
    tags: [projectScope],
    tenant_id: tenantId,
  };
}

async function scalar(query: string, key: string, params: Record<string, unknown>): Promise<number> {
  const session = driver.session();
  try {
    const result = await session.run(query, params);
    return Number(result.records[0]?.get(key) ?? 0);
  } finally {
    await session.close();
  }
}

async function productSnapshot() {
  const episodic = new EpisodicStore(driver);
  const promotable = await episodic.findPromotable(projectScope, 100, tenantId);
  const counts: Record<string, number> = {};
  for (const label of ['Episodic', 'Semantic', 'Fact', 'MemoryBlock']) {
    counts[label] = await scalar(
      `MATCH (n:${label} {tenant_id: $tenantId}) RETURN count(n) AS count`,
      'count',
      { tenantId },
    );
  }
  return {
    counts,
    promotableIds: promotable.map((item) => item.id).sort(),
  };
}

async function observationGraphState(id: string) {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (o:AdmissionObservation {id: $id})
       OPTIONAL MATCH (o)-[r]-(n)
       RETURN properties(o) AS properties,
              collect(CASE WHEN r IS NULL THEN null ELSE {
                type: type(r), outgoing: startNode(r) = o,
                targetId: n.id, targetLabels: labels(n)
              } END) AS relationships`,
      { id },
    );
    if (result.records.length === 0) return null;
    return {
      properties: result.records[0]!.get('properties') as Record<string, unknown>,
      relationships: (result.records[0]!.get('relationships') as unknown[]).filter(Boolean),
    };
  } finally {
    await session.close();
  }
}

function afterCommitLossDriver(base: Driver, canary: string): Driver {
  return {
    session: () => {
      const session = base.session();
      return {
        executeWrite: async <T>(work: (tx: ManagedTransaction) => Promise<T>) => {
          await session.executeWrite(work);
          throw new Error(canary);
        },
        executeRead: session.executeRead.bind(session),
        close: session.close.bind(session),
      };
    },
  } as unknown as Driver;
}

function corruptedMergeResultDriver(base: Driver): Driver {
  return {
    session: () => {
      const session = base.session();
      return {
        executeWrite: <T>(work: (tx: ManagedTransaction) => Promise<T>) => session.executeWrite(async (tx) => {
          const wrapped = {
            run: async (query: string, params?: Record<string, unknown>) => {
              const result = await tx.run(query, params);
              if (!query.includes('admission-observation:merge') || result.records.length === 0) return result;
              const original = result.records[0]!;
              return {
                ...result,
                records: [{
                  get: (key: string) => key === 'relationshipCount' ? 2 : original.get(key),
                }],
              } as typeof result;
            },
          } as ManagedTransaction;
          return work(wrapped);
        }),
        executeRead: session.executeRead.bind(session),
        close: session.close.bind(session),
      };
    },
  } as unknown as Driver;
}

async function expectSafeFailure(promise: Promise<unknown>, code: string, canary?: string): Promise<void> {
  let error: unknown;
  try { await promise; } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(AdmissionObservationStoreError);
  expect(error).toMatchObject({ code });
  if (canary) expect(String(error)).not.toContain(canary);
}

describeLive('AdmissionObservationStore live Neo4j gate', () => {
  beforeAll(async () => {
    // Explicit gate means credentials/reachability are mandatory: never skip.
    await driver.getServerInfo();
  });

  afterAll(async () => {
    if (LIVE_ENABLED) {
      const session = driver.session();
      try {
        await session.run(
          `MATCH (n)
           WHERE n.tenant_id = $tenantId OR n.id IN $episodeIds
           DETACH DELETE n`,
          { tenantId, episodeIds: allScopes.map((scope) => scope.episodeId) },
        );
      } finally {
        await session.close();
      }
    }
    await driver.close().catch(() => undefined);
  });

  it('applies migration 0007 directly twice and proves its named schema objects', async () => {
    const migration = MIGRATIONS.find((item) => item.id === '0007-admission-observation-sidecar');
    expect(migration).toBeDefined();
    await migration!.up(driver);
    await migration!.up(driver);

    const session = driver.session();
    try {
      const constraint = await session.run(
        `SHOW CONSTRAINTS YIELD name
         WHERE name = 'admission_observation_id'
         RETURN name`,
      );
      const index = await session.run(
        `SHOW INDEXES YIELD name
         WHERE name = 'admission_observation_tenant_project'
         RETURN name`,
      );
      expect(constraint.records).toHaveLength(1);
      expect(index.records).toHaveLength(1);
    } finally {
      await session.close();
    }
  });

  it('proves concurrency, retry, rollback, isolation, drift rejection, and cleanup on disposable data', async () => {
    const episodic = new EpisodicStore(driver);
    for (const scope of allScopes) await episodic.create(episode(scope));
    const baseline = await productSnapshot();
    expect(baseline.counts.Episodic).toBe(allScopes.length);
    expect(baseline.promotableIds).toEqual(allScopes.map((scope) => scope.episodeId).sort());

    // Real concurrent writes use independent sessions; the constraint-backed
    // MERGE makes both calls converge on whichever commits first.
    const firstTime = observation('2026-08-14T12:00:00.000Z');
    const secondTime = observation('2026-08-14T13:00:00.000Z');
    const [concurrentA, concurrentB] = await Promise.all([
      new AdmissionObservationStore(driver).persist(primaryScope, firstTime),
      new AdmissionObservationStore(driver).persist(primaryScope, secondTime),
    ]);
    expect(concurrentA).toEqual(concurrentB);
    expect([firstTime.observedAt, secondTime.observedAt]).toContain(concurrentA.observedAt);
    await expect(new AdmissionObservationStore(driver).persist(
      primaryScope,
      observation('2026-08-14T11:00:00.000Z'),
    )).resolves.toEqual(concurrentA);
    await expect(new AdmissionObservationStore(driver).persist(
      primaryScope,
      observation('2026-08-14T14:00:00.000Z'),
    )).resolves.toEqual(concurrentA);

    const session = driver.session();
    let primaryId: string;
    try {
      const result = await session.run(
        `MATCH (o:AdmissionObservation)-[r:OBSERVES]->(e:Episodic {id: $episodeId})
         WHERE o.tenant_id = $tenantId AND o.project_scope = $projectScope
         RETURN o.id AS id, properties(o) AS properties, count(r) AS count`,
        primaryScope,
      );
      expect(result.records).toHaveLength(1);
      primaryId = String(result.records[0]!.get('id'));
      const properties = result.records[0]!.get('properties') as Record<string, unknown>;
      expect(Number(result.records[0]!.get('count'))).toBe(1);
      expect(Object.keys(properties).sort()).toEqual([
        'capture_state', 'contract_version', 'has_entities', 'has_model', 'has_signals',
        'id', 'memory_class', 'observed_at', 'outcome', 'policy_id', 'policy_version',
        'project_scope', 'reason_code', 'recommended_tier', 'redaction_configured',
        'safe_project_scope', 'sensitivity', 'tenant_id', 'tenant_scope',
        'would_change_baseline',
      ]);
      expect(properties).not.toHaveProperty('episode_id');
      expect(properties).not.toHaveProperty('content');
      expect(properties).not.toHaveProperty('task');
      expect(JSON.stringify(properties)).not.toContain(SECRET_CANARY);
    } finally {
      await session.close();
    }

    // Commit succeeds but the response is lost. The public error is closed and
    // a normal exact retry discovers and returns the committed observation.
    const lossCanary = `lost-response-${suffix}`;
    await expectSafeFailure(
      new AdmissionObservationStore(afterCommitLossDriver(driver, lossCanary))
        .persist(ambiguousScope, firstTime),
      'storage_unavailable',
      lossCanary,
    );
    await expect(new AdmissionObservationStore(driver).persist(ambiguousScope, secondTime))
      .resolves.toEqual(firstTime);

    // The merge mutates inside a real transaction, then its returned evidence is
    // corrupted so the callback throws. Neo4j must roll node and link back.
    const beforeRollback = await scalar(
      'MATCH (o:AdmissionObservation {tenant_id: $tenantId}) RETURN count(o) AS count',
      'count',
      { tenantId },
    );
    await expectSafeFailure(
      new AdmissionObservationStore(corruptedMergeResultDriver(driver)).persist(rollbackScope, firstTime),
      'existing_state_mismatch',
    );
    expect(await scalar(
      'MATCH (o:AdmissionObservation {tenant_id: $tenantId}) RETURN count(o) AS count',
      'count',
      { tenantId },
    )).toBe(beforeRollback);
    expect(await scalar(
      `MATCH (:AdmissionObservation)-[:OBSERVES]->(e:Episodic {id: $episodeId})
       RETURN count(e) AS count`,
      'count',
      { ...rollbackScope },
    )).toBe(0);

    // Property corruption is rejected and byte-for-byte graph evidence remains.
    let direct = driver.session();
    try {
      await direct.run('MATCH (o:AdmissionObservation {id: $id}) SET o.corrupt = true', { id: primaryId });
    } finally { await direct.close(); }
    let drifted = await observationGraphState(primaryId);
    await expectSafeFailure(
      new AdmissionObservationStore(driver).persist(primaryScope, firstTime),
      'existing_state_mismatch',
    );
    expect(await observationGraphState(primaryId)).toEqual(drifted);
    direct = driver.session();
    try { await direct.run('MATCH (o:AdmissionObservation {id: $id}) REMOVE o.corrupt', { id: primaryId }); }
    finally { await direct.close(); }

    // Missing, wrong, and extra relationships are independently rejected and
    // never repaired. Each failed call leaves its exact pre-call graph unchanged.
    direct = driver.session();
    try { await direct.run('MATCH (o:AdmissionObservation {id: $id})-[r:OBSERVES]->() DELETE r', { id: primaryId }); }
    finally { await direct.close(); }
    drifted = await observationGraphState(primaryId);
    await expectSafeFailure(new AdmissionObservationStore(driver).persist(primaryScope, firstTime), 'existing_state_mismatch');
    expect(await observationGraphState(primaryId)).toEqual(drifted);

    direct = driver.session();
    try {
      await direct.run(
        `MATCH (o:AdmissionObservation {id: $id}), (e:Episodic {id: $episodeId})
         CREATE (o)-[:OBSERVES]->(e)`,
        { id: primaryId, episodeId: wrongTargetScope.episodeId },
      );
    } finally { await direct.close(); }
    drifted = await observationGraphState(primaryId);
    await expectSafeFailure(new AdmissionObservationStore(driver).persist(primaryScope, firstTime), 'existing_state_mismatch');
    expect(await observationGraphState(primaryId)).toEqual(drifted);

    direct = driver.session();
    try {
      await direct.run('MATCH (o:AdmissionObservation {id: $id})-[r:OBSERVES]->() DELETE r', { id: primaryId });
      await direct.run(
        `MATCH (o:AdmissionObservation {id: $id}), (e:Episodic {id: $episodeId})
         CREATE (o)-[:OBSERVES]->(e)`,
        { id: primaryId, episodeId: primaryScope.episodeId },
      );
      await direct.run(
        `MATCH (o:AdmissionObservation {id: $id}), (e:Episodic {id: $episodeId})
         CREATE (o)-[:ABOUT]->(e)`,
        { id: primaryId, episodeId: wrongTargetScope.episodeId },
      );
    } finally { await direct.close(); }
    drifted = await observationGraphState(primaryId);
    await expectSafeFailure(new AdmissionObservationStore(driver).persist(primaryScope, firstTime), 'existing_state_mismatch');
    expect(await observationGraphState(primaryId)).toEqual(drifted);
    direct = driver.session();
    try { await direct.run('MATCH (o:AdmissionObservation {id: $id})-[r:ABOUT]->() DELETE r', { id: primaryId }); }
    finally { await direct.close(); }

    // Scope probes cannot see or attach the observation.
    const store = new AdmissionObservationStore(driver);
    await expect(store.get({ ...primaryScope, tenantId: `${tenantId}-wrong` })).resolves.toBeNull();
    await expect(store.get({ ...primaryScope, projectScope: `${projectScope}-wrong` })).resolves.toBeNull();
    await expectSafeFailure(
      store.persist({ ...primaryScope, tenantId: `${tenantId}-wrong` }, firstTime),
      'episode_not_found',
    );
    expect(await scalar(
      `MATCH (o:AdmissionObservation)-[:OBSERVES]->(e:Episodic)
       WHERE e.id IN $episodeIds
         AND (o.tenant_id <> $tenantId OR o.project_scope <> $projectScope)
       RETURN count(o) AS count`,
      'count',
      { tenantId, projectScope, episodeIds: allScopes.map((item) => item.episodeId) },
    )).toBe(0);

    // Product-facing typed counts and promotable retrieval are unchanged by all
    // sidecar work; raw graph query remains the deliberate visibility exception.
    expect(await productSnapshot()).toEqual(baseline);
    expect(await scalar(
      'MATCH (o:AdmissionObservation {tenant_id: $tenantId}) RETURN count(o) AS count',
      'count',
      { tenantId },
    )).toBe(2);

    const removed = await new TenantAdmin(driver).delete(tenantId);
    expect(removed.Episodic).toBe(allScopes.length);
    expect(await scalar(
      'MATCH (n) WHERE n.tenant_id = $tenantId RETURN count(n) AS count',
      'count',
      { tenantId },
    )).toBe(0);
    expect(await scalar(
      `MATCH (a)-[r]-(b)
       WHERE a.id IN $episodeIds OR b.id IN $episodeIds
       RETURN count(r) AS count`,
      'count',
      { episodeIds: allScopes.map((item) => item.episodeId) },
    )).toBe(0);
  }, 120_000);
});
