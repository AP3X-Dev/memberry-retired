import { afterEach, describe, expect, it, vi } from 'vitest';
import neo4j, { Record as Neo4jRecord } from 'neo4j-driver';
import { ScopedQuery } from '../query.js';
import { FactStore } from '../fact.js';

function driverWith(run: ReturnType<typeof vi.fn>) {
  return {
    session: vi.fn(() => ({
      run,
      close: vi.fn(async () => undefined),
    })),
  };
}

const record = (values: Record<string, unknown>) => {
  const entries = Object.entries(values);
  return new Neo4jRecord(
    entries.map(([key]) => key),
    entries.map(([key, value]) => key === 'ordinal' && typeof value === 'number' ? String(value) : value),
  );
};

const semanticProjection = (overrides: Record<string, unknown> = {}) => ({
  id: 'semantic-a', content: 'safe', confidence: 0.9, signal_count: 1,
  created_at: '2024-01-01T00:00:00.000Z', updated_at: '2024-01-02T00:00:00.000Z',
  decay_class: 'stable', memory_type: 'decision', tags: ['project:alpha'],
  scope: 'project:alpha', tenant_id: 'tenant-a', embedding: null, ...overrides,
});

afterEach(() => vi.useRealTimers());

describe('RET-002C stable Entity.id consumers', () => {
  it('scopes semantics by exact stable IDs even when legacy names are also present', async () => {
    const run = vi.fn(async () => ({ records: [] }));
    const query = new ScopedQuery(driverWith(run) as never);

    await query.byScope({
      entityIds: ['entity-b', 'entity-a'],
      entities: ['duplicate-name'],
      tags: [],
      limit: 50,
    });

    const [cypher, params] = run.mock.calls[0] as [string, Record<string, unknown>];
    expect(cypher).toContain('e.id IN $entityIds');
    expect(cypher).not.toContain('e.name IN $entities');
    expect(params.entityIds).toEqual(['entity-b', 'entity-a']);
    expect(params).not.toHaveProperty('entities');
  });

  it('returns no semantics for an explicit empty stable-ID lane without a global query', async () => {
    const run = vi.fn(async () => ({ records: [] }));
    const query = new ScopedQuery(driverWith(run) as never);

    await expect(query.byScope({ entityIds: [], limit: 50 })).resolves.toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it('fetches facts by bounded IDs without invoking EntityResolver or a name fallback', async () => {
    const run = vi.fn(async () => ({ records: [
      record({ ordinal: 0, eid: 'entity-b', facts: [] }),
      record({ ordinal: 1, eid: 'entity-a', facts: [] }),
    ] }));
    const store = new FactStore(driverWith(run) as never);
    const resolveExisting = vi.fn(() => { throw new Error('name fallback reached'); });
    (store as unknown as { resolver: { resolveExisting: typeof resolveExisting } }).resolver = { resolveExisting };

    await expect(store.getActiveByEntityIdsBatch(['entity-b', 'entity-a', 'entity-b']))
      .resolves.toEqual([[], []]);

    expect(resolveExisting).not.toHaveBeenCalled();
    const [cypher, params] = run.mock.calls[0] as [string, Record<string, unknown>];
    expect(cypher).toContain('UNWIND $ids AS eid');
    expect(cypher).toContain('LIMIT $perIdFetch');
    expect(params.ids).toEqual(['entity-b', 'entity-a']);
    expect(Object.isFrozen(params.ids)).toBe(true);
    expect(run.mock.calls[0]).toHaveLength(3);
  });

  it('rejects hostile or over-bound fact ID lists without resolver/session hooks', async () => {
    const hooks = vi.fn();
    const proxy = new Proxy(['entity-a'], {
      get: (target, key, receiver) => { hooks(); return Reflect.get(target, key, receiver); },
      ownKeys: (target) => { hooks(); return Reflect.ownKeys(target); },
    });
    for (const value of [proxy, new Array(33).fill('entity-a'), ['bad id'], ['x'.repeat(201)]]) {
      const run = vi.fn(async () => ({ records: [] }));
      const driver = driverWith(run);
      const store = new FactStore(driver as never);
      const resolveExisting = vi.fn();
      (store as unknown as { resolver: { resolveExisting: typeof resolveExisting } }).resolver = { resolveExisting };
      await expect(store.getActiveByEntityIdsBatch(value as string[]))
        .rejects.toThrow('resolved_entity_ids_invalid');
      expect(driver.session).not.toHaveBeenCalled();
      expect(resolveExisting).not.toHaveBeenCalled();
    }
    expect(hooks).not.toHaveBeenCalled();
  });

  it.each([
    ['scope', (query: ScopedQuery) => query.byScope({ entityIds: ['entity-a'], limit: 10 }),
      record({ entityId: 'entity-foreign', s: { id: 'foreign-secret' } })],
  ])('rejects substituted official %s stable-result records', async (_label, invoke, foreignRecord) => {
    const run = vi.fn(async () => ({ records: [foreignRecord] }));
    await expect(invoke(new ScopedQuery(driverWith(run) as never)))
      .rejects.toThrow('stable_query_result_invalid');
  });

  it('rejects proxied and oversized stable query result arrays without hooks', async () => {
    const hooks = vi.fn();
    const proxied = new Proxy([], {
      get: (target, key, receiver) => { hooks(); return Reflect.get(target, key, receiver); },
      ownKeys: (target) => { hooks(); return Reflect.ownKeys(target); },
    });
    const oversized = new Array(11).fill(record({ entityId: 'entity-a', s: { id: 'safe' } }));
    for (const records of [proxied, oversized]) {
      const run = vi.fn(async () => ({ records }));
      await expect(new ScopedQuery(driverWith(run) as never).byScope({ entityIds: ['entity-a'], limit: 10 }))
        .rejects.toThrow('stable_query_result_invalid');
    }
    expect(hooks).not.toHaveBeenCalled();
  });

  it.each([
    ['scope', (query: ScopedQuery) => query.byScope({ entityIds: ['entity-a'], limit: 10 }),
      ['entityId', 's'], ['entity-a', { id: 'semantic-a' }]],
  ])('rejects missing, extra, sparse, and accessor %s result shapes without hooks', async (
    _label, invoke, fields, values,
  ) => {
    const hooks = vi.fn();
    const valid = new Neo4jRecord(fields, values);
    const sparse = new Neo4jRecord(fields, values) as Neo4jRecord & { _fields: unknown[] };
    const sparseFields: unknown[] = []; sparseFields.length = fields.length;
    sparse._fields = sparseFields;
    const accessorResult: Record<string, unknown> = {};
    Object.defineProperty(accessorResult, 'records', { get: () => { hooks(); return [valid]; } });
    const results = [
      { records: [new Neo4jRecord(fields.slice(0, -1), values.slice(0, -1))] },
      { records: [new Neo4jRecord([...fields, 'extra'], [...values, 'blocked'])] },
      { records: [sparse] },
      accessorResult,
    ];
    for (const result of results) {
      const run = vi.fn(async () => result);
      await expect(invoke(new ScopedQuery(driverWith(run) as never)))
        .rejects.toThrow('stable_query_result_invalid');
    }
    expect(hooks).not.toHaveBeenCalled();
  });

  it('rejects every hostile new query ID boundary before hooks or sessions', async () => {
    const hooks = vi.fn();
    const proxy = new Proxy(['entity-a'], {
      get: (target, key, receiver) => { hooks(); return Reflect.get(target, key, receiver); },
      ownKeys: (target) => { hooks(); return Reflect.ownKeys(target); },
      getOwnPropertyDescriptor: (target, key) => { hooks(); return Reflect.getOwnPropertyDescriptor(target, key); },
    });
    const revoked = Proxy.revocable(['entity-a'], {}); revoked.revoke();
    const accessor: unknown[] = [];
    Object.defineProperty(accessor, '0', { enumerable: true, get: () => { hooks(); return 'entity-a'; } }); accessor.length = 1;
    const sparse: unknown[] = []; sparse.length = 1;
    const extra = Object.assign(['entity-a'], { extra: true });
    const customProto = ['entity-a']; Object.setPrototypeOf(customProto, { custom: true });
    const values = [proxy, revoked.proxy, accessor, sparse, extra, customProto, new Array(33).fill('entity-a'), ['bad id'], ['x'.repeat(201)]];
    for (const value of values) {
      for (const invoke of [(query: ScopedQuery) => query.byScope({ entityIds: value as never, limit: 10 })]) {
        const run = vi.fn(async () => ({ records: [] }));
        const driver = driverWith(run);
        await expect(invoke(new ScopedQuery(driver as never))).rejects.toThrow('resolved_entity_ids_invalid');
        expect(driver.session).not.toHaveBeenCalled();
      }
    }
    expect(hooks).not.toHaveBeenCalled();
  });

  it('rejects hostile byScope root containers before property hooks or sessions', async () => {
    const hooks = vi.fn();
    const proxy = new Proxy({ entityIds: ['entity-a'], limit: 10 }, {
      get: (target, key, receiver) => { hooks(); return Reflect.get(target, key, receiver); },
      ownKeys: (target) => { hooks(); return Reflect.ownKeys(target); },
    });
    const revoked = Proxy.revocable({ entityIds: ['entity-a'], limit: 10 }, {}); revoked.revoke();
    const accessor = { limit: 10 } as Record<string, unknown>;
    Object.defineProperty(accessor, 'entityIds', { get: () => { hooks(); return ['entity-a']; } });
    const customProto = Object.assign(Object.create({ inherited: true }), { entityIds: ['entity-a'], limit: 10 });
    const extra = { entityIds: ['entity-a'], limit: 10, secret: 'blocked' };
    for (const scope of [proxy, revoked.proxy, accessor, customProto, extra]) {
      const run = vi.fn(async () => ({ records: [] }));
      const driver = driverWith(run);
      await expect(new ScopedQuery(driver as never).byScope(scope as never))
        .rejects.toThrow('query_scope_invalid');
      expect(driver.session).not.toHaveBeenCalled();
    }
    expect(hooks).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', [record({ ordinal: 0, eid: 'entity-a', facts: [] })]],
    ['extra', [record({ ordinal: 0, eid: 'entity-a', facts: [] }), record({ ordinal: 1, eid: 'entity-b', facts: [] }), record({ ordinal: 2, eid: 'entity-c', facts: [] })]],
    ['substituted', [record({ ordinal: 0, eid: 'entity-b', facts: [] }), record({ ordinal: 1, eid: 'entity-a', facts: [] })]],
    ['duplicate', [record({ ordinal: 0, eid: 'entity-a', facts: [] }), record({ ordinal: 0, eid: 'entity-b', facts: [] })]],
    ['overflow', [record({ ordinal: 0, eid: 'entity-a', facts: new Array(65).fill({ properties: {} }) }), record({ ordinal: 1, eid: 'entity-b', facts: [] })]],
  ])('fails closed on %s fact batch records with no partial result', async (_label, records) => {
    const run = vi.fn(async () => ({ records }));
    const store = new FactStore(driverWith(run) as never);
    await expect(store.getActiveByEntityIdsBatch(['entity-a', 'entity-b']))
      .rejects.toThrow(/fact_id_batch_(?:invalid|overflow)/);
  });

  it('bounds the per-entity fetch at the 64 cap so an over-documented entity keeps its top facts and its batch siblings', async () => {
    const factsFor = (eid: string, count: number) => Array.from({ length: count }, (_, index) => ({ properties: {
      entity_id: eid, id: `${eid}-fact-${String(index).padStart(3, '0')}`,
      valid_at: new Date(Date.UTC(2024, 0, 1, 0, 0, count - index)).toISOString(),
    } }));
    const stored: Record<string, ReturnType<typeof factsFor>> = { 'entity-a': factsFor('entity-a', 65), 'entity-b': factsFor('entity-b', 2) };
    const run = vi.fn(async (_cypher: string, params: Record<string, unknown>) => {
      const perIdFetch = (params.perIdFetch as { toNumber(): number }).toNumber();
      return { records: (params.ids as string[]).map((eid, ordinal) =>
        record({ ordinal, eid, facts: stored[eid].slice(0, perIdFetch) })) };
    });
    const result = await new FactStore(driverWith(run) as never).getActiveByEntityIdsBatch(['entity-a', 'entity-b']);
    expect(result.map((facts) => facts.length)).toEqual([64, 2]);
    expect(result[0].map((fact) => fact.id)).toEqual(stored['entity-a'].slice(0, 64).map((fact) => fact.properties.id));
  });

  it.each([
    ['foreign', { entity_id: 'entity-foreign', id: 'foreign-secret' }],
    ['missing', { id: 'missing-secret' }],
    ['wrong-type', { entity_id: 7, id: 'type-secret' }],
    ['unsafe', { entity_id: 'bad id', id: 'unsafe-secret' }],
  ])('rejects %s returned fact entity echoes without returning partial foreign data', async (_label, properties) => {
    const run = vi.fn(async () => ({ records: [
      record({ ordinal: 0, eid: 'entity-a', facts: [{ properties }] }),
    ] }));
    await expect(new FactStore(driverWith(run) as never).getActiveByEntityIdsBatch(['entity-a']))
      .rejects.toThrow('fact_id_batch_invalid_record');
  });

  it('rejects accessor and mixed duplicate fact entity echoes without invoking hooks', async () => {
    const hooks = vi.fn();
    const accessor = {};
    Object.defineProperty(accessor, 'entity_id', { get: () => { hooks(); return 'entity-a'; } });
    const results = [
      [record({ ordinal: 0, eid: 'entity-a', facts: [{ properties: accessor }] })],
      [record({ ordinal: 0, eid: 'entity-a', facts: [
        { properties: { entity_id: 'entity-a', id: 'safe' } },
        { properties: { entity_id: 'entity-b', id: 'foreign-secret' } },
      ] })],
    ];
    for (const records of results) {
      await expect(new FactStore(driverWith(vi.fn(async () => ({ records }))) as never)
        .getActiveByEntityIdsBatch(['entity-a']))
        .rejects.toThrow('fact_id_batch_invalid_record');
    }
    expect(hooks).not.toHaveBeenCalled();
  });

  it('requires exact tenant proof on every stable fact row', async () => {
    const namedMissing = record({ ordinal: 0, eid: 'entity-a', facts: [{ properties: {
      entity_id: 'entity-a', id: 'fact-a', valid_at: '2024-01-01T00:00:00.000Z',
    } }] });
    await expect(new FactStore(driverWith(vi.fn(async () => ({ records: [namedMissing] }))) as never)
      .getActiveByEntityIdsBatch(['entity-a'], undefined, 'tenant-a'))
      .rejects.toThrow('fact_id_batch_invalid_record');

    const defaultForeign = record({ ordinal: 0, eid: 'entity-a', facts: [{ properties: {
      entity_id: 'entity-a', tenant_id: 'tenant-b', id: 'fact-a', valid_at: '2024-01-01T00:00:00.000Z',
    } }] });
    await expect(new FactStore(driverWith(vi.fn(async () => ({ records: [defaultForeign] }))) as never)
      .getActiveByEntityIdsBatch(['entity-a']))
      .rejects.toThrow('fact_id_batch_invalid_record');
  });

  it('rejects stable facts that violate the declared per-entity total ordering', async () => {
    const reversed = record({ ordinal: 0, eid: 'entity-a', facts: [
      { properties: { entity_id: 'entity-a', id: 'fact-a', valid_at: '2024-01-01T00:00:00.000Z' } },
      { properties: { entity_id: 'entity-a', id: 'fact-b', valid_at: '2024-01-02T00:00:00.000Z' } },
    ] });
    await expect(new FactStore(driverWith(vi.fn(async () => ({ records: [reversed] }))) as never)
      .getActiveByEntityIdsBatch(['entity-a']))
      .rejects.toThrow('fact_id_batch_invalid_record');

    const reversedTie = record({ ordinal: 0, eid: 'entity-a', facts: [
      { properties: { entity_id: 'entity-a', id: 'fact-b', valid_at: '2024-01-01T00:00:00.000Z' } },
      { properties: { entity_id: 'entity-a', id: 'fact-a', valid_at: '2024-01-01T00:00:00.000Z' } },
    ] });
    await expect(new FactStore(driverWith(vi.fn(async () => ({ records: [reversedTie] }))) as never)
      .getActiveByEntityIdsBatch(['entity-a']))
      .rejects.toThrow('fact_id_batch_invalid_record');
  });

  it('accepts code-unit ordered mixed-case and punctuation fact ID ties', async () => {
    const facts = ['fact-A', 'fact-a', 'fact.a', 'fact:a'].map((id) => ({ properties: {
      entity_id: 'entity-a', id, valid_at: '2024-01-01T00:00:00.000Z',
    } }));
    const stable = record({ ordinal: 0, eid: 'entity-a', facts });
    await expect(new FactStore(driverWith(vi.fn(async () => ({ records: [stable] }))) as never)
      .getActiveByEntityIdsBatch(['entity-a']))
      .resolves.toHaveLength(1);
  });

  it('enforces the stable fact per-string byte boundary', async () => {
    const invoke = (object: string) => new FactStore(driverWith(vi.fn(async () => ({ records: [
      record({ ordinal: 0, eid: 'entity-a', facts: [{ properties: {
        entity_id: 'entity-a', id: 'fact-a', valid_at: '2024-01-01T00:00:00.000Z', object,
      } }] }),
    ] }))) as never).getActiveByEntityIdsBatch(['entity-a']);
    await expect(invoke('x'.repeat(16_384))).resolves.toHaveLength(1);
    await expect(invoke('x'.repeat(16_385))).rejects.toThrow('fact_id_batch_invalid_record');
  });

  it('preflights stable fact provider strings before UTF-8 scanning while retaining exact byte checks', async () => {
    const originalByteLength = Buffer.byteLength;
    let target = '';
    let targetScans = 0;
    Buffer.byteLength = ((
      input: Parameters<typeof Buffer.byteLength>[0],
      encoding?: BufferEncoding,
    ): number => {
      if (input === target) targetScans += 1;
      return originalByteLength(input, encoding);
    }) as typeof Buffer.byteLength;
    vi.resetModules();
    try {
      const { FactStore: DynamicFactStore } = await import('../fact.js');
      const invoke = (properties: Record<string, unknown>): Promise<unknown> => {
        const result = { records: [record({
          ordinal: 0, eid: 'entity-a', facts: [{ properties }],
        })] };
        const driver = driverWith(vi.fn(async () => result));
        return new DynamicFactStore(driver as never).getActiveByEntityIdsBatch(['entity-a']);
      };
      const properties = (overrides: Record<string, unknown>): Record<string, unknown> => ({
        id: 'fact-a', entity_id: 'entity-a', valid_at: '2024-01-01T00:00:00.000Z', ...overrides,
      });

      target = 'provider-safe-object';
      targetScans = 0;
      await expect(invoke(properties({ object: target }))).resolves.toHaveLength(1);
      expect(targetScans).toBeGreaterThan(0);

      target = 'x'.repeat(16_385);
      targetScans = 0;
      await expect(invoke(properties({ object: target })))
        .rejects.toThrow('fact_id_batch_invalid_record');
      expect(targetScans).toBe(0);

      target = 'é'.repeat(8_193);
      targetScans = 0;
      await expect(invoke(properties({ object: target })))
        .rejects.toThrow('fact_id_batch_invalid_record');
      expect(targetScans).toBeGreaterThan(0);

      target = 't'.repeat(16_384);
      targetScans = 0;
      const tags = Array.from({ length: 31 }, () => 'f'.repeat(16_384));
      tags.push(target);
      await expect(invoke(properties({ tags }))).rejects.toThrow('fact_id_batch_invalid_record');
      expect(targetScans).toBe(0);
    } finally {
      Buffer.byteLength = originalByteLength;
      vi.resetModules();
    }
  });

  it.each([
    ['scope', (query: ScopedQuery) => query.byScope({
      entityIds: ['entity-a'], limit: 10, tenantId: 'tenant-a', projectScope: 'project:alpha',
    }), record({ entityId: 'entity-a', s: semanticProjection({ tenant_id: 'tenant-b', content: 'FOREIGN-SECRET' }) })],
  ])('rejects allowed-ID %s rows with foreign tenant or project authority', async (_label, invoke, hostile) => {
    const run = vi.fn(async () => ({ records: [hostile] }));
    await expect(invoke(new ScopedQuery(driverWith(run) as never)))
      .rejects.toThrow('stable_query_result_invalid');
  });

  it('accepts legacy-null tenant data only for the default tenant stable lane', async () => {
    const projection = semanticProjection({ tenant_id: undefined });
    const run = vi.fn(async () => ({ records: [record({ entityId: 'entity-a', s: projection })] }));
    await expect(new ScopedQuery(driverWith(run) as never).byScope({
      entityIds: ['entity-a'], limit: 10, projectScope: 'project:alpha',
    })).resolves.toHaveLength(1);
  });

  it('normalizes only official safe nonnegative Neo4j Integer semantic signal counts', async () => {
    const invoke = (signalCount: unknown) => new ScopedQuery(driverWith(vi.fn(async () => ({ records: [
      record({ entityId: 'entity-a', s: semanticProjection({ signal_count: signalCount }) }),
    ] }))) as never).byScope({
      entityIds: ['entity-a'], limit: 10, tenantId: 'tenant-a', projectScope: 'project:alpha',
    });

    await expect(invoke(neo4j.int(1))).resolves.toMatchObject([{ signal_count: 1 }]);
    await expect(invoke(neo4j.int(Number.MAX_SAFE_INTEGER)))
      .resolves.toMatchObject([{ signal_count: Number.MAX_SAFE_INTEGER }]);

    const hooks = vi.fn();
    const forgedMarker = { low: 1, high: 0, __isInteger__: true };
    const accessor = Object.create(neo4j.Integer.prototype) as Record<string, unknown>;
    Object.defineProperty(accessor, 'low', { enumerable: true, configurable: true, get: () => { hooks(); return 1; } });
    Object.defineProperty(accessor, 'high', { enumerable: true, configurable: true, writable: true, value: 0 });
    const proxied = new Proxy(neo4j.int(1), { get: (target, key, receiver) => {
      hooks(); return Reflect.get(target, key, receiver);
    } });
    for (const hostile of [neo4j.int(-1), neo4j.int('9007199254740992'), forgedMarker, accessor, proxied]) {
      await expect(invoke(hostile)).rejects.toThrow('stable_query_result_invalid');
    }
    expect(hooks).not.toHaveBeenCalled();
  });

  it('accepts code-unit ordered mixed-case and punctuation ties in stable query results', async () => {
    const ids = ['semantic-A', 'semantic-a', 'semantic.a', 'semantic:a'];
    const rows = ids.map((id) => record({ entityId: 'entity-a', s: semanticProjection({ id }) }));
    await expect(new ScopedQuery(driverWith(vi.fn(async () => ({ records: rows }))) as never).byScope({
      entityIds: ['entity-a'], limit: 10, tenantId: 'tenant-a', projectScope: 'project:alpha',
    })).resolves.toHaveLength(4);
  });

  it('rejects stable query records that violate declared total ordering', async () => {
    const scopeRows = [
      record({ entityId: 'entity-a', s: semanticProjection({ id: 'semantic-b', confidence: 0.8 }) }),
      record({ entityId: 'entity-a', s: semanticProjection({ id: 'semantic-a', confidence: 0.9 }) }),
    ];
    await expect(new ScopedQuery(driverWith(vi.fn(async () => ({ records: scopeRows }))) as never)
      .byScope({ entityIds: ['entity-a'], limit: 10, tenantId: 'tenant-a', projectScope: 'project:alpha' }))
      .rejects.toThrow('stable_query_result_invalid');

  });

  it('rejects oversized and hostile nested stable query projection values without hooks', async () => {
    const hooks = vi.fn();
    const hostileTag = new Proxy({}, { get: () => { hooks(); return 'FOREIGN-SECRET'; } });
    const cases = [
      semanticProjection({ content: 'x'.repeat(65_537) }),
      semanticProjection({ tags: [hostileTag] }),
    ];
    for (const projection of cases) {
      const run = vi.fn(async () => ({ records: [record({ entityId: 'entity-a', s: projection })] }));
      await expect(new ScopedQuery(driverWith(run) as never).byScope({
        entityIds: ['entity-a'], limit: 10, tenantId: 'tenant-a', projectScope: 'project:alpha',
      })).rejects.toThrow('stable_query_result_invalid');
    }
    expect(hooks).not.toHaveBeenCalled();
  });

  it('preflights stable query provider strings before UTF-8 scanning while retaining exact byte checks', async () => {
    const originalByteLength = Buffer.byteLength;
    let target = '';
    let targetScans = 0;
    Buffer.byteLength = ((
      input: Parameters<typeof Buffer.byteLength>[0],
      encoding?: BufferEncoding,
    ): number => {
      if (input === target) targetScans += 1;
      return originalByteLength(input, encoding);
    }) as typeof Buffer.byteLength;
    vi.resetModules();
    try {
      const { ScopedQuery: DynamicScopedQuery } = await import('../query.js');
      const invoke = (projection: Record<string, unknown>): Promise<unknown> => {
        const run = vi.fn(async () => ({
          records: [record({ entityId: 'entity-a', s: projection })],
        }));
        return new DynamicScopedQuery(driverWith(run) as never).byScope({
          entityIds: ['entity-a'], limit: 10, tenantId: 'tenant-a', projectScope: 'project:alpha',
        });
      };

      target = 'provider-safe-content';
      targetScans = 0;
      await expect(invoke(semanticProjection({ content: target }))).resolves.toHaveLength(1);
      expect(targetScans).toBeGreaterThan(0);

      target = 'x'.repeat(65_537);
      targetScans = 0;
      await expect(invoke(semanticProjection({ content: target })))
        .rejects.toThrow('stable_query_result_invalid');
      expect(targetScans).toBe(0);

      target = 'é'.repeat(32_769);
      targetScans = 0;
      await expect(invoke(semanticProjection({ content: target })))
        .rejects.toThrow('stable_query_result_invalid');
      expect(targetScans).toBeGreaterThan(0);

      target = 't'.repeat(65_536);
      targetScans = 0;
      const tags = Array.from({ length: 31 }, () => 'f'.repeat(65_536));
      tags.push(target);
      await expect(invoke(semanticProjection({ tags }))).rejects.toThrow('stable_query_result_invalid');
      expect(targetScans).toBe(0);
    } finally {
      Buffer.byteLength = originalByteLength;
      vi.resetModules();
    }
  });

  it('rejects hostile result and record shapes without invoking their hooks', async () => {
    const hooks = vi.fn();
    const proxiedRecords = new Proxy([], {
      get: (target, key, receiver) => { hooks(); return Reflect.get(target, key, receiver); },
      ownKeys: (target) => { hooks(); return Reflect.ownKeys(target); },
    });
    const accessorRecords: unknown[] = [];
    Object.defineProperty(accessorRecords, '0', { get: () => { hooks(); return record({ ordinal: 0, eid: 'entity-a', facts: [] }); } });
    accessorRecords.length = 1;
    const extraRecords = Object.assign([record({ ordinal: 0, eid: 'entity-a', facts: [] })], { extra: true });
    const forgedRecord = { get: () => { hooks(); return undefined; } };
    const hostileOrdinal = new Proxy({}, { get: () => { hooks(); return '0'; } });
    const hostileProperties = {};
    Object.defineProperty(hostileProperties, 'id', { get: () => { hooks(); return 'fact-a'; } });
    const results = [
      { records: proxiedRecords },
      { records: accessorRecords },
      { records: extraRecords },
      { records: [forgedRecord] },
      { records: [record({ ordinal: hostileOrdinal, eid: 'entity-a', facts: [] })] },
      { records: [record({ ordinal: 0, eid: 'entity-a', facts: [{ properties: hostileProperties }] })] },
    ];
    for (const result of results) {
      const run = vi.fn(async () => result);
      await expect(new FactStore(driverWith(run) as never).getActiveByEntityIdsBatch(['entity-a']))
        .rejects.toThrow('fact_id_batch_invalid');
    }
    expect(hooks).not.toHaveBeenCalled();
  });

  it('rejects oversized record, fact, property, and nested-array shapes before hooks', async () => {
    const hooks = vi.fn();
    const valid = record({ ordinal: 0, eid: 'entity-a', facts: [] });
    const oversizedRecords = new Array(33).fill(valid);
    const oversizedFacts = new Array(66).fill({ properties: {} });
    const oversizedProperties: Record<string, unknown> = {};
    for (let index = 0; index < 65; index += 1) oversizedProperties[`extra_${index}`] = index;
    const oversizedTags: unknown[] = new Array(257).fill('tag');
    Object.defineProperty(oversizedTags, '0', { get: () => { hooks(); return 'tag'; } });
    const results = [
      { records: oversizedRecords },
      { records: [record({ ordinal: 0, eid: 'entity-a', facts: oversizedFacts })] },
      { records: [record({ ordinal: 0, eid: 'entity-a', facts: [{ properties: oversizedProperties }] })] },
      { records: [record({ ordinal: 0, eid: 'entity-a', facts: [{ properties: { tags: oversizedTags } }] })] },
    ];
    for (const result of results) {
      await expect(new FactStore(driverWith(vi.fn(async () => result)) as never).getActiveByEntityIdsBatch(['entity-a']))
        .rejects.toThrow('fact_id_batch_invalid');
    }
    expect(hooks).not.toHaveBeenCalled();
  });

  it('fails closed when a successful fact batch cannot prove session closure', async () => {
    const driver = {
      session: vi.fn(() => ({
        run: vi.fn(async () => ({ records: [record({ ordinal: 0, eid: 'entity-a', facts: [] })] })),
        close: vi.fn(async () => { throw new Error('transport close failure'); }),
      })),
    };
    await expect(new FactStore(driver as never).getActiveByEntityIdsBatch(['entity-a']))
      .rejects.toThrow('fact_id_batch_close_failed');
  });

  it('bounds a hung close after an otherwise successful fact batch', async () => {
    vi.useFakeTimers();
    const never = new Promise<never>(() => undefined);
    const driver = {
      session: vi.fn(() => ({
        run: vi.fn(async () => ({ records: [record({ ordinal: 0, eid: 'entity-a', facts: [] })] })),
        close: vi.fn(() => never),
      })),
    };
    const operation = new FactStore(driver as never).getActiveByEntityIdsBatch(['entity-a']);
    const result = operation.then(() => new Error('unexpected success'), (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(result).resolves.toMatchObject({ message: 'fact_id_batch_close_failed' });
  });

  it('preserves a query failure when closure also fails', async () => {
    const driver = {
      session: vi.fn(() => ({
        run: vi.fn(async () => { throw new Error('query failed first'); }),
        close: vi.fn(async () => { throw new Error('close failed second'); }),
      })),
    };
    await expect(new FactStore(driver as never).getActiveByEntityIdsBatch(['entity-a']))
      .rejects.toThrow('query failed first');
  });

  it('bounds a hung fact query by wall clock and a hung close independently', async () => {
    vi.useFakeTimers();
    const never = new Promise<never>(() => undefined);
    const close = vi.fn(() => never);
    const run = vi.fn(() => never);
    const driver = { session: vi.fn(() => ({ run, close })) };
    const operation = new FactStore(driver as never).getActiveByEntityIdsBatch(['entity-a']);
    const operationResult = operation.then(
      () => new Error('unexpected success'),
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(Promise.race([operationResult, Promise.resolve('still-pending')]))
      .resolves.toMatchObject({ message: 'fact_id_batch_timeout' });

    const closeNever = new Promise<never>(() => undefined);
    const failing = {
      session: vi.fn(() => ({ run: vi.fn(async () => { throw new Error('query failed'); }), close: vi.fn(() => closeNever) })),
    };
    const closeOperation = new FactStore(failing as never).getActiveByEntityIdsBatch(['entity-a']);
    const closeResult = closeOperation.then(
      () => new Error('unexpected success'),
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(Promise.race([closeResult, Promise.resolve('still-pending')]))
      .resolves.toMatchObject({ message: 'query failed' });
  });
});
