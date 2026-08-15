import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TrustedAdmissionPreprocessorV1,
  createAdmissionObservationV1,
  type AdmissionObservationV1,
} from '@memberry/core';
import { describe, expect, it, vi } from 'vitest';
import type { Driver } from 'neo4j-driver';

import {
  AdmissionObservationStore,
  AdmissionObservationStoreError,
  type AdmissionObservationScopeV1,
} from '../admission-observation.js';
import { TenantAdmin } from '../tenant-admin.js';

const SCOPE: AdmissionObservationScopeV1 = {
  tenantId: 'tenant-acme',
  projectScope: 'project:memberry',
  episodeId: 'ep-admission-001',
};
const SECRET_CANARY = ['sk', 'live', 'must-not-persist-1234567890'].join('_');
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function observation(observedAt = '2026-08-14T12:00:00.000Z', hasSignals = true): AdmissionObservationV1 {
  const safeFacts = new TrustedAdmissionPreprocessorV1().preprocess({
    captureState: 'accepted-nonduplicate',
    task: 'persist admission shadow result',
    content: `sensitive ${SECRET_CANARY}`,
    tags: ['project:memberry'],
    scope: 'project:memberry',
    tenantId: 'tenant-acme',
    redactionConfigured: true,
    memoryType: 'decision',
    outcome: 'approved',
    hasSignals,
    hasEntities: true,
    hasModel: false,
  });
  return createAdmissionObservationV1({ safeFacts }, { now: () => new Date(observedAt) });
}

type Stored = {
  properties: Record<string, unknown>;
  relationships: Array<{
    type: string;
    direction: 'outgoing' | 'incoming';
    tenantId: string;
    projectScope: string;
    episodeId: string;
  }>;
};

function resultRecord(values: Record<string, unknown>) {
  return { get: (key: string) => values[key] };
}

function makeDriver(options: {
  retryOnce?: boolean;
  failCreate?: boolean;
  sessionError?: string;
  executeWriteError?: string;
  executeReadError?: string;
  txError?: string;
  recordGetError?: string;
  closeError?: string;
} = {}) {
  let committed: Stored | undefined;
  const createIds: string[] = [];
  const attemptTokens: string[] = [];

  const runWork = async <T>(work: (tx: { run: (query: string, params?: Record<string, unknown>) => Promise<unknown> }) => Promise<T>, commit: boolean): Promise<T> => {
    let working = committed === undefined ? undefined : structuredClone(committed);
    const tx = {
      run: vi.fn(async (query: string, params: Record<string, unknown> = {}) => {
        if (options.txError) throw new Error(options.txError);
        if (query.includes('admission-observation:merge')) {
          const exactEpisode = params.tenantId === SCOPE.tenantId
            && params.projectScope === SCOPE.projectScope
            && params.episodeId === SCOPE.episodeId;
          if (!exactEpisode) return { records: [] };
          attemptTokens.push(String(params.attemptToken));
          const created = working === undefined;
          if (created) {
            createIds.push(String((params.properties as Record<string, unknown>).id));
            working = {
              properties: structuredClone(params.properties as Record<string, unknown>),
              relationships: [{
                type: 'OBSERVES',
                direction: 'outgoing',
                tenantId: String(params.tenantId),
                projectScope: String(params.projectScope),
                episodeId: String(params.episodeId),
              }],
            };
            if (options.failCreate) throw new Error('simulated rollback');
          }
          const exactLinkCount = working!.relationships.filter((relationship) =>
            relationship.type === 'OBSERVES'
            && relationship.direction === 'outgoing'
            && relationship.tenantId === params.tenantId
            && relationship.projectScope === params.projectScope
            && relationship.episodeId === params.episodeId).length;
          return { records: [options.recordGetError
            ? { get: () => { throw new Error(options.recordGetError); } }
            : resultRecord({
            properties: structuredClone(working!.properties),
            relationshipCount: working!.relationships.length,
            exactLinkCount,
            created,
          })] };
        }
        if (query.includes('admission-observation:episode-exists')) {
          const exact = params.tenantId === SCOPE.tenantId
            && params.projectScope === SCOPE.projectScope
            && params.episodeId === SCOPE.episodeId;
          return { records: [resultRecord({ count: exact ? 1 : 0 })] };
        }
        if (query.includes('admission-observation:inspect-existing')) {
          if (working === undefined) return { records: [] };
          const exactLinks = working.relationships.filter((relationship) =>
            relationship.type === 'OBSERVES'
            && relationship.direction === 'outgoing'
            && relationship.tenantId === params.tenantId
            && relationship.projectScope === params.projectScope
            && relationship.episodeId === params.episodeId).length;
          return { records: [resultRecord({
            properties: structuredClone(working.properties),
            relationshipCount: working.relationships.length,
            exactLinkCount: exactLinks,
          })] };
        }
        if (query.includes('admission-observation:create')) {
          createIds.push(String((params.properties as Record<string, unknown>).id));
          if (working !== undefined) throw new Error('constraint collision');
          working = {
            properties: structuredClone(params.properties as Record<string, unknown>),
            relationships: [{
              type: 'OBSERVES',
              direction: 'outgoing',
              tenantId: String(params.tenantId),
              projectScope: String(params.projectScope),
              episodeId: String(params.episodeId),
            }],
          };
          if (options.failCreate) throw new Error('simulated rollback');
          return { records: [resultRecord({ properties: structuredClone(working.properties) })] };
        }
        if (query.includes('admission-observation:read-scoped')) {
          if (working === undefined) return { records: [] };
          const exactLinkCount = working.relationships.filter((relationship) =>
            relationship.type === 'OBSERVES'
            && relationship.direction === 'outgoing'
            && relationship.tenantId === params.tenantId
            && relationship.projectScope === params.projectScope
            && relationship.episodeId === params.episodeId).length;
          const scoped = working.properties.tenant_id === params.tenantId
            && working.properties.project_scope === params.projectScope
            && exactLinkCount === 1;
          if (!scoped) return { records: [] };
          return { records: [options.recordGetError
            ? { get: () => { throw new Error(options.recordGetError); } }
            : resultRecord({
            properties: structuredClone(working.properties),
            relationshipCount: working.relationships.length,
            exactLinkCount,
          })] };
        }
        throw new Error('unexpected query');
      }),
    };
    const value = await work(tx);
    if (commit) committed = working;
    return value;
  };

  let writeQueue: Promise<unknown> = Promise.resolve();
  const executeWrite = vi.fn(<T>(work: Parameters<typeof runWork<T>>[0]) => {
    const pending = writeQueue.then(async () => {
      if (options.executeWriteError) throw new Error(options.executeWriteError);
      if (options.retryOnce) await runWork(work, false);
      return runWork(work, true);
    });
    writeQueue = pending.catch(() => undefined);
    return pending;
  });
  const executeRead = vi.fn(async <T>(work: Parameters<typeof runWork<T>>[0]) => {
    if (options.executeReadError) throw new Error(options.executeReadError);
    return runWork(work, false);
  });
  const close = vi.fn(async () => {
    if (options.closeError) throw new Error(options.closeError);
  });
  const session = { executeWrite, executeRead, close };
  const driver = { session: vi.fn(() => {
    if (options.sessionError) throw new Error(options.sessionError);
    return session;
  }) } as unknown as Driver;
  return {
    driver,
    get stored() { return committed; },
    set stored(value: Stored | undefined) { committed = value; },
    createIds,
    attemptTokens,
    executeWrite,
    executeRead,
    close,
  };
}

async function expectClosedFailure(
  promise: Promise<unknown>,
  canary: string,
  code: string = 'storage_unavailable',
): Promise<void> {
  let error: unknown;
  try { await promise; } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(AdmissionObservationStoreError);
  expect(error).toMatchObject({ code });
  expect(String(error)).not.toContain(canary);
}

describe('AdmissionObservationStore MEM-001B', () => {
  it('atomically persists a content-free sidecar and returns only the A observation', async () => {
    const fake = makeDriver();
    const input = observation();
    const returned = await new AdmissionObservationStore(fake.driver).persist(SCOPE, input);

    expect(returned).toEqual(input);
    expect(Object.keys(returned).sort()).toEqual(['contractVersion', 'observedAt', 'recommendation', 'safeFacts']);
    expect(fake.stored?.relationships).toEqual([expect.objectContaining({ type: 'OBSERVES', direction: 'outgoing' })]);
    expect(fake.stored?.properties).not.toHaveProperty('episode_id');
    expect(JSON.stringify(fake.stored)).not.toContain(SECRET_CANARY);
    expect(fake.stored?.properties.id).toBe(
      'admission-observation:sha256:bea1a61e5e5f5bebf408e45782659bc89df0dca4298a384c7eefbee1bf0e93c6',
    );
  });

  it('is idempotent across exact calls and managed transaction retry', async () => {
    const fake = makeDriver({ retryOnce: true });
    const store = new AdmissionObservationStore(fake.driver);
    const input = observation();
    await expect(store.persist(SCOPE, input)).resolves.toEqual(input);
    await expect(store.persist(SCOPE, input)).resolves.toEqual(input);
    expect(fake.createIds.length).toBeGreaterThanOrEqual(2);
    expect(new Set(fake.createIds).size).toBe(1);
    expect(new Set(fake.attemptTokens.slice(0, 2)).size).toBe(1);
    expect(fake.stored?.relationships).toHaveLength(1);
    expect(fake.stored?.properties.observed_at).toBe(input.observedAt);
  });

  it('accepts earlier/later timestamp replays, returns the first committed time, and rejects changed facts', async () => {
    const fake = makeDriver();
    const store = new AdmissionObservationStore(fake.driver);
    const first = observation();
    await store.persist(SCOPE, first);
    const snapshot = structuredClone(fake.stored);

    await expect(store.persist(SCOPE, observation('2026-08-14T13:00:00.000Z'))).resolves.toEqual(first);
    await expect(store.persist(SCOPE, observation('2026-08-14T11:00:00.000Z'))).resolves.toEqual(first);
    await expect(store.persist(SCOPE, observation(first.observedAt, false)))
      .rejects.toBeInstanceOf(AdmissionObservationStoreError);
    expect(fake.stored).toEqual(snapshot);
  });

  it.each([
    ['missing relationship', []],
    ['wrong relationship', [{ type: 'OBSERVES', direction: 'outgoing', tenantId: SCOPE.tenantId, projectScope: SCOPE.projectScope, episodeId: 'ep-wrong' }]],
    ['extra relationship', [
      { type: 'OBSERVES', direction: 'outgoing', tenantId: SCOPE.tenantId, projectScope: SCOPE.projectScope, episodeId: SCOPE.episodeId },
      { type: 'ABOUT', direction: 'outgoing', tenantId: SCOPE.tenantId, projectScope: SCOPE.projectScope, episodeId: SCOPE.episodeId },
    ]],
  ])('rejects an existing node with %s and never repairs it', async (_label, relationships) => {
    const seed = makeDriver();
    await new AdmissionObservationStore(seed.driver).persist(SCOPE, observation());
    seed.stored = { properties: structuredClone(seed.stored!.properties), relationships: structuredClone(relationships) as Stored['relationships'] };
    const snapshot = structuredClone(seed.stored);
    await expect(new AdmissionObservationStore(seed.driver).persist(SCOPE, observation()))
      .rejects.toBeInstanceOf(AdmissionObservationStoreError);
    expect(seed.stored).toEqual(snapshot);
  });

  it('rejects missing, extra, or mismatched persisted properties without healing', async () => {
    const fake = makeDriver();
    const store = new AdmissionObservationStore(fake.driver);
    await store.persist(SCOPE, observation());

    for (const mutate of [
      (properties: Record<string, unknown>) => { delete properties.has_model; },
      (properties: Record<string, unknown>) => { properties.extra = true; },
      (properties: Record<string, unknown>) => { properties._admission_attempt = 'stale-attempt'; },
      (properties: Record<string, unknown>) => { properties.recommended_tier = 'protected'; },
    ]) {
      const original = structuredClone(fake.stored!);
      const corrupted = structuredClone(original);
      mutate(corrupted.properties);
      fake.stored = corrupted;
      await expect(store.persist(SCOPE, observation())).rejects.toBeInstanceOf(AdmissionObservationStoreError);
      expect(fake.stored).toEqual(corrupted);
      fake.stored = original;
    }
  });

  it('rolls back node and relationship together when the transaction fails', async () => {
    const fake = makeDriver({ failCreate: true });
    await expectClosedFailure(
      new AdmissionObservationStore(fake.driver).persist(SCOPE, observation()),
      'simulated rollback',
    );
    expect(fake.stored).toBeUndefined();
  });

  it('normalizes session/write/transaction/result/close failures without leaking canaries', async () => {
    for (const [field, options] of [
      ['session-canary', { sessionError: 'session-canary' }],
      ['write-canary', { executeWriteError: 'write-canary' }],
      ['tx-canary', { txError: 'tx-canary' }],
      ['record-canary', { recordGetError: 'record-canary' }],
      ['close-canary', { closeError: 'close-canary' }],
    ] as const) {
      const fake = makeDriver(options);
      await expectClosedFailure(
        new AdmissionObservationStore(fake.driver).persist(SCOPE, observation()),
        field,
      );
    }
  });

  it('normalizes read/transaction/result/close failures on get without leaking canaries', async () => {
    const healthy = makeDriver();
    await new AdmissionObservationStore(healthy.driver).persist(SCOPE, observation());
    for (const [field, options] of [
      ['read-canary', { executeReadError: 'read-canary' }],
      ['get-tx-canary', { txError: 'get-tx-canary' }],
      ['get-record-canary', { recordGetError: 'get-record-canary' }],
      ['get-close-canary', { closeError: 'get-close-canary' }],
    ] as const) {
      const fake = makeDriver(options);
      fake.stored = structuredClone(healthy.stored);
      await expectClosedFailure(new AdmissionObservationStore(fake.driver).get(SCOPE), field);
    }
  });

  it('preserves the primary safe domain error when session.close also fails', async () => {
    const canary = 'secondary-close-canary';
    const fake = makeDriver({ closeError: canary });
    await expectClosedFailure(
      new AdmissionObservationStore(fake.driver).persist({ ...SCOPE, episodeId: 'ep-missing' }, observation()),
      canary,
      'episode_not_found',
    );
  });

  it('normalizes malformed observations to a value-free input error before storage', async () => {
    const canary = 'observation-secret-canary';
    const fake = makeDriver();
    await expectClosedFailure(
      new AdmissionObservationStore(fake.driver).persist(SCOPE, { ...observation(), [canary]: canary } as AdmissionObservationV1),
      canary,
      'invalid_observation',
    );
    expect(fake.executeWrite).not.toHaveBeenCalled();
  });

  it('concurrent identical writers converge through constraint-backed MERGE', async () => {
    const fake = makeDriver();
    const store = new AdmissionObservationStore(fake.driver);
    const input = observation();
    const [first, second] = await Promise.all([
      store.persist(SCOPE, input),
      store.persist(SCOPE, observation('2026-08-14T13:00:00.000Z')),
    ]);
    expect(first).toEqual(input);
    expect(second).toEqual(input);
    expect(fake.stored?.relationships).toHaveLength(1);
    expect(fake.createIds).toHaveLength(1);
  });

  it('reads only through the fully-qualified episode and exact OBSERVES link', async () => {
    const fake = makeDriver();
    const store = new AdmissionObservationStore(fake.driver);
    const input = observation();
    await store.persist(SCOPE, input);

    await expect(store.get(SCOPE)).resolves.toEqual(input);
    await expect(store.get({ ...SCOPE, tenantId: 'tenant-other' })).resolves.toBeNull();
    await expect(store.get({ ...SCOPE, projectScope: 'project:other' })).resolves.toBeNull();
    await expect(store.get({ ...SCOPE, episodeId: 'ep-other' })).resolves.toBeNull();
  });

  it('fails closed on invalid scopes without reflecting values', async () => {
    const fake = makeDriver();
    const unsafe = { ...SCOPE, projectScope: `project:${SECRET_CANARY}:invalid` };
    let error: unknown;
    try { await new AdmissionObservationStore(fake.driver).get(unsafe); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(AdmissionObservationStoreError);
    expect(String(error)).not.toContain(SECRET_CANARY);
    expect(fake.executeRead).not.toHaveBeenCalled();
  });

  it('requires resolved tenant and project safe facts before opening a transaction', async () => {
    const facts = new TrustedAdmissionPreprocessorV1().preprocess({
      captureState: 'accepted-nonduplicate',
      task: 'unscoped',
      content: 'fixture',
      redactionConfigured: true,
      memoryType: 'general',
      hasSignals: false,
      hasEntities: false,
      hasModel: false,
    });
    const unscoped = createAdmissionObservationV1({ safeFacts: facts }, { now: () => new Date('2026-08-14T12:00:00.000Z') });
    const fake = makeDriver();
    await expect(new AdmissionObservationStore(fake.driver).persist(SCOPE, unscoped))
      .rejects.toMatchObject({ code: 'observation_scope_unresolved' });
    expect(fake.executeWrite).not.toHaveBeenCalled();
  });

  it('keeps the sidecar outside product retrieval and publication surfaces', () => {
    for (const relative of [
      'packages/neo4j/src/provenance.ts',
      'packages/retrieval/src/index.ts',
      'packages/wiki/src/index.ts',
      'packages/graph/src/index.ts',
      'packages/mcp/src/bootstrap.ts',
    ]) {
      const source = readFileSync(resolve(REPO_ROOT, relative), 'utf8');
      expect(source).not.toMatch(/AdmissionObservationStore|OBSERVES/);
    }

    // MEM-001C may construct the B sink only at the core dependency root; the
    // sidecar remains absent from retrieval, graph, provenance, and wiki code.
    const factory = readFileSync(resolve(REPO_ROOT, 'packages/core/src/services-factory.ts'), 'utf8');
    expect(factory).toContain('new AdmissionObservationStore(driver)');

    const bootstrap = readFileSync(resolve(REPO_ROOT, 'packages/core/src/bootstrap-graph.ts'), 'utf8');
    expect(bootstrap).toContain("WHERE type(r) <> 'OBSERVES'");

    const tenantAdmin = readFileSync(resolve(REPO_ROOT, 'packages/neo4j/src/tenant-admin.ts'), 'utf8');
    const deleteBody = tenantAdmin.slice(tenantAdmin.indexOf('async delete'));
    expect(deleteBody.indexOf('MATCH (o:AdmissionObservation')).toBeGreaterThan(-1);
    expect(deleteBody.indexOf('MATCH (o:AdmissionObservation')).toBeLessThan(deleteBody.indexOf('for (const label of TENANT_LABELS)'));

    const storeSource = readFileSync(resolve(REPO_ROOT, 'packages/neo4j/src/admission-observation.ts'), 'utf8');
    expect(storeSource).toContain('MERGE (o:AdmissionObservation {id: $id})');
    expect(storeSource).not.toContain('CREATE (o:AdmissionObservation)');
  });

  it('deletes sidecars before episodics without expanding TenantCounts', async () => {
    const queries: string[] = [];
    const run = vi.fn(async (query: string) => {
      queries.push(query);
      return { records: [resultRecord({ c: 0 })] };
    });
    const driver = {
      session: vi.fn(() => ({ run, close: vi.fn(async () => undefined) })),
    } as unknown as Driver;

    const removed = await new TenantAdmin(driver).delete('tenant-acme');
    expect(Object.keys(removed).sort()).toEqual(['Episodic', 'Fact', 'MemoryBlock', 'Semantic']);
    const sidecar = queries.findIndex((query) => query.includes('MATCH (o:AdmissionObservation'));
    const episodic = queries.findIndex((query, index) => index > sidecar && query.includes('MATCH (n:Episodic'));
    expect(sidecar).toBeGreaterThan(-1);
    expect(episodic).toBeGreaterThan(sidecar);
  });
});
