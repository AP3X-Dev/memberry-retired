// packages/neo4j/src/__tests__/semantic.test.ts
import { int } from 'neo4j-driver';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createNeo4jDriver } from '../driver.js';
import { SemanticStore } from '../semantic.js';
import type { SemanticNode } from '@memberry/core';

const NEO4J_URI = process.env.NEO4J_URI || 'bolt://localhost:7687';
const NEO4J_USER = process.env.NEO4J_USER || 'neo4j';
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || 'password';

async function isNeo4jReachable(uri: string, user: string, password: string): Promise<boolean> {
  const probe = createNeo4jDriver(uri, user, password);
  try {
    await probe.getServerInfo();
    return true;
  } catch {
    return false;
  } finally {
    await probe.close().catch(() => {});
  }
}

const TEST_PREFIX = `test-semantic-${Date.now()}`;

function makeSemanticNode(suffix: string): SemanticNode {
  const now = new Date().toISOString();
  return {
    id: `${TEST_PREFIX}-${suffix}`,
    content: `Test semantic content for ${suffix}`,
    confidence: 0.8,
    signal_count: 3,
    created_at: now,
    updated_at: now,
    decay_class: 'stable',
    tags: ['test', suffix],
  };
}

it('maps official Neo4j Integer signal_count values through getById and getByIds', async () => {
  const byIdProps = {
    ...makeSemanticNode('integer-mapper'),
    signal_count: int(3),
  };
  const byIdsProps = {
    ...makeSemanticNode('integer-mapper-batch'),
    signal_count: int(4),
  };
  const close = vi.fn(async () => undefined);
  const run = vi.fn(async (cypher: string) => ({
    records: [{
      get: () => ({ properties: cypher.includes('s.id IN $ids') ? byIdsProps : byIdProps }),
    }],
  }));
  const store = new SemanticStore({ session: () => ({ run, close }) } as never);

  const fetchedById = await store.getById(byIdProps.id);
  const [fetchedByIds] = await store.getByIds([byIdsProps.id]);

  expect(fetchedById?.signal_count).toBe(3);
  expect(typeof fetchedById?.signal_count).toBe('number');
  expect(fetchedByIds.signal_count).toBe(4);
  expect(typeof fetchedByIds.signal_count).toBe('number');
  expect(close).toHaveBeenCalledTimes(2);
});

describe('SemanticStore', () => {
  let neo4jAvailable = false;
  const driver = createNeo4jDriver(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD);
  let store: SemanticStore;

  const createdIds: string[] = [];

  async function persistSignalCountsAsIntegers(ids: string[]): Promise<void> {
    const session = driver.session();
    try {
      await session.run(
        'MATCH (s:Semantic) WHERE s.id IN $ids SET s.signal_count = toInteger(s.signal_count)',
        { ids },
      );
    } finally {
      await session.close();
    }
  }

  beforeAll(async () => {
    neo4jAvailable = await isNeo4jReachable(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD);
    if (!neo4jAvailable) {
      console.warn(`[skip] Neo4j not reachable at ${NEO4J_URI} — skipping semantic tests`);
      return;
    }
    store = new SemanticStore(driver);
  });

  afterAll(async () => {
    if (neo4jAvailable && createdIds.length > 0) {
      const session = driver.session();
      try {
        // Detach and delete all test Semantic nodes
        await session.run(
          'MATCH (s:Semantic) WHERE s.id IN $ids DETACH DELETE s',
          { ids: createdIds }
        );
        // Clean up any test Episodic or Entity nodes created during tests
        await session.run(
          `MATCH (e:Episodic) WHERE e.id STARTS WITH $prefix DETACH DELETE e`,
          { prefix: TEST_PREFIX }
        );
        await session.run(
          `MATCH (e:Entity) WHERE e.id STARTS WITH $prefix DETACH DELETE e`,
          { prefix: TEST_PREFIX }
        );
      } finally {
        await session.close();
      }
    }
    await driver.close().catch(() => {});
  });

  it('should create a semantic node and return its id', async () => {
    if (!neo4jAvailable) return;
    const node = makeSemanticNode('create');
    const id = await store.create(node);
    createdIds.push(id);
    expect(id).toBe(node.id);
  });

  it('should create a semantic node with embedding', async () => {
    if (!neo4jAvailable) return;
    const node = makeSemanticNode('with-embedding');
    const embedding = Array.from({ length: 8 }, (_, i) => i * 0.1);
    const id = await store.create({ ...node, embedding });
    createdIds.push(id);
    expect(id).toBe(node.id);
  });

  it('should retrieve a semantic node by id', async () => {
    if (!neo4jAvailable) return;
    const node = makeSemanticNode('retrieve');
    const id = await store.create(node);
    createdIds.push(id);
    await persistSignalCountsAsIntegers([id]);

    const fetched = await store.getById(id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(node.id);
    expect(fetched!.content).toBe(node.content);
    expect(fetched!.confidence).toBe(node.confidence);
    expect(fetched!.signal_count).toBe(node.signal_count);
    expect(typeof fetched!.signal_count).toBe('number');
    expect(fetched!.decay_class).toBe(node.decay_class);
    expect(fetched!.tags).toEqual(node.tags);
    // No tenant specified → defaults to 'default'
    expect(fetched!.tenant_id).toBe('default');
  });

  it('should persist a non-default tenant_id and round-trip it', async () => {
    if (!neo4jAvailable) return;
    const node = { ...makeSemanticNode('tenant'), tenant_id: 'acme' };
    const id = await store.create(node);
    createdIds.push(id);

    const fetched = await store.getById(id);
    expect(fetched).not.toBeNull();
    expect(fetched!.tenant_id).toBe('acme');
  });

  it('OPT-54: getByIds fetches many nodes in one round-trip and omits missing ids', async () => {
    if (!neo4jAvailable) return;
    const a = makeSemanticNode('byids-a');
    const b = makeSemanticNode('byids-b');
    const idA = await store.create(a);
    const idB = await store.create(b);
    createdIds.push(idA, idB);
    await persistSignalCountsAsIntegers([idA, idB]);

    const fetched = await store.getByIds([idA, idB, `${TEST_PREFIX}-byids-missing`]);
    // Exactly the two existing nodes, missing id omitted.
    expect(fetched.map((n) => n.id).sort()).toEqual([idA, idB].sort());
    // Mapping matches getById (content + defaulted tenant).
    const fa = fetched.find((n) => n.id === idA)!;
    expect(fa.content).toBe(a.content);
    expect(fa.confidence).toBe(a.confidence);
    expect(fa.signal_count).toBe(a.signal_count);
    expect(typeof fa.signal_count).toBe('number');
    expect(fa.tenant_id).toBe('default');
    const fb = fetched.find((n) => n.id === idB)!;
    expect(fb.signal_count).toBe(b.signal_count);
    expect(typeof fb.signal_count).toBe('number');

    // Empty input → empty result, no query.
    expect(await store.getByIds([])).toEqual([]);
  });

  it('should carry the tenant_id forward when superseding', async () => {
    if (!neo4jAvailable) return;
    const oldNode = { ...makeSemanticNode('supersede-tenant-old'), tenant_id: 'acme' };
    const oldId = await store.create(oldNode);
    createdIds.push(oldId);

    const newNode = { ...makeSemanticNode('supersede-tenant-new'), tenant_id: 'acme' };
    const newId = await store.supersede(oldId, newNode);
    createdIds.push(newId);

    const fetched = await store.getById(newId);
    expect(fetched!.tenant_id).toBe('acme');
  });

  it('should return null for a non-existent id', async () => {
    if (!neo4jAvailable) return;
    const fetched = await store.getById('non-existent-id-xyz');
    expect(fetched).toBeNull();
  });

  it('should update confidence', async () => {
    if (!neo4jAvailable) return;
    const node = makeSemanticNode('update-confidence');
    const id = await store.create(node);
    createdIds.push(id);

    await store.updateConfidence(id, 0.95);

    const fetched = await store.getById(id);
    expect(fetched).not.toBeNull();
    expect(fetched!.confidence).toBe(0.95);
  });

  it('applies the same confidence application key at most once', async () => {
    if (!neo4jAvailable) return;
    const node = makeSemanticNode('idempotent-confidence');
    const id = await store.create(node);
    createdIds.push(id);

    await store.updateConfidence(id, 0.9, 'proposal-stable-key');
    await store.updateConfidence(id, 0.99, 'proposal-stable-key');

    expect((await store.getById(id))?.confidence).toBe(0.9);
  });

  it('should supersede an old node with a new one and create SUPERSEDES relationship', async () => {
    if (!neo4jAvailable) return;
    const oldNode = makeSemanticNode('supersede-old');
    const oldId = await store.create(oldNode);
    createdIds.push(oldId);

    const newNode = makeSemanticNode('supersede-new');
    const newId = await store.supersede(oldId, newNode);
    createdIds.push(newId);

    expect(newId).toBe(newNode.id);

    // Verify the SUPERSEDES relationship exists
    const session = driver.session();
    try {
      const result = await session.run(
        `MATCH (new:Semantic {id: $newId})-[:SUPERSEDES]->(old:Semantic {id: $oldId})
         RETURN count(*) AS cnt`,
        { newId, oldId }
      );
      const cnt = result.records[0].get('cnt') as { toNumber: () => number } | number;
      const count = typeof cnt === 'object' ? cnt.toNumber() : cnt;
      expect(count).toBe(1);
    } finally {
      await session.close();
    }
  });

  it('atomically promotes every source episode and inherits active entity links', async () => {
    if (!neo4jAvailable) return;

    const episodicIds = [`${TEST_PREFIX}-episodic-a`, `${TEST_PREFIX}-episodic-b`];
    const entityIds = [
      `${TEST_PREFIX}-promote-reference`,
      `${TEST_PREFIX}-promote-modified`,
      `${TEST_PREFIX}-promote-invalid`,
    ];
    const session = driver.session();
    try {
      await session.run(
        `CREATE (a:Episodic {
          id: $episodicA,
          session_id: 'test-session',
          agent_id: 'test-agent',
          task: 'test-task',
          content: 'test episodic content a',
          scope: 'project:test',
          created_at: $now
        })
        CREATE (b:Episodic {
          id: $episodicB,
          session_id: 'test-session',
          agent_id: 'test-agent',
          task: 'test-task',
          content: 'test episodic content b',
          scope: 'project:test',
          created_at: $now
        })
        CREATE (referenced:Entity {id: $referenced, name: $referenced, type: 'project'})
        CREATE (modified:Entity {id: $modified, name: $modified, type: 'test'})
        CREATE (invalid:Entity {id: $invalid, name: $invalid, type: 'test'})
        CREATE (a)-[:REFERENCES {valid_at: $now}]->(referenced)
        CREATE (b)-[:MODIFIED {valid_at: $now}]->(modified)
        CREATE (b)-[:REFERENCES {valid_at: $now, invalid_at: $now}]->(invalid)`,
        {
          episodicA: episodicIds[0],
          episodicB: episodicIds[1],
          referenced: entityIds[0],
          modified: entityIds[1],
          invalid: entityIds[2],
          now: new Date().toISOString(),
        },
      );
    } finally {
      await session.close();
    }

    const newNode = makeSemanticNode('promoted');
    const newId = await store.promoteFromEpisodic(episodicIds, newNode);
    createdIds.push(newId);

    expect(newId).toBe(newNode.id);
    // Ambiguous commit replay: the same deterministic id and exact provenance
    // is a successful no-op so callers can retrigger derived publication.
    await expect(
      store.promoteFromEpisodic(episodicIds, newNode),
    ).resolves.toBe(newNode.id);
    await expect(
      store.promoteFromEpisodic(episodicIds, makeSemanticNode('overlapping-promote')),
    ).rejects.toThrow('already promoted');

    const verifySession = driver.session();
    try {
      const result = await verifySession.run(
        `MATCH (s:Semantic {id: $newId})
         OPTIONAL MATCH (s)-[:PROMOTED_FROM]->(ep:Episodic)
         WITH s, collect(ep.id) AS sources
         OPTIONAL MATCH (s)-[about:ABOUT]->(entity:Entity)
         RETURN sources, collect(entity.id) AS entities,
                count(CASE WHEN about.invalid_at IS NULL THEN 1 END) AS activeAbout`,
        { newId },
      );
      expect((result.records[0].get('sources') as string[]).sort()).toEqual([...episodicIds].sort());
      expect((result.records[0].get('entities') as string[]).sort()).toEqual(entityIds.slice(0, 2).sort());
    } finally {
      await verifySession.close();
    }
  });

  it('preserves active ABOUT links on a superseding semantic and invalidates old links', async () => {
    if (!neo4jAvailable) return;
    const oldNode = makeSemanticNode('supersede-about-old');
    const oldId = await store.create(oldNode);
    createdIds.push(oldId);
    const entityId = `${TEST_PREFIX}-supersede-about-entity`;
    const session = driver.session();
    try {
      await session.run(
        `CREATE (:Entity {id: $id, name: $id, type: 'test'})`,
        { id: entityId },
      );
    } finally {
      await session.close();
    }
    await store.linkToEntity(oldId, entityId);

    const newNode = makeSemanticNode('supersede-about-new');
    const newId = await store.supersede(oldId, newNode);
    createdIds.push(newId);

    const verifySession = driver.session();
    try {
      const result = await verifySession.run(
        `MATCH (new:Semantic {id: $newId})-[newR:ABOUT]->(e:Entity {id: $entityId})
         MATCH (old:Semantic {id: $oldId})-[oldR:ABOUT]->(e)
         RETURN newR.invalid_at AS newInvalidAt, oldR.invalid_at AS oldInvalidAt`,
        { newId, oldId, entityId },
      );
      expect(result.records).toHaveLength(1);
      expect(result.records[0].get('newInvalidAt')).toBeNull();
      expect(result.records[0].get('oldInvalidAt')).toBeTruthy();
    } finally {
      await verifySession.close();
    }
  });

  it('does not create a semantic when any promotion source is outside the tenant', async () => {
    if (!neo4jAvailable) return;
    const episodicId = `${TEST_PREFIX}-tenant-isolated-episodic`;
    const session = driver.session();
    try {
      await session.run(
        `CREATE (:Episodic {id: $id, tenant_id: 'acme', created_at: $now})`,
        { id: episodicId, now: new Date().toISOString() },
      );
    } finally {
      await session.close();
    }
    const newNode = { ...makeSemanticNode('tenant-isolated-promote'), tenant_id: 'globex' };

    await expect(store.promoteFromEpisodic([episodicId], newNode, 'globex')).rejects.toThrow(
      'outside tenant globex',
    );

    const verifySession = driver.session();
    try {
      const result = await verifySession.run(
        `MATCH (s:Semantic {id: $id}) RETURN count(s) AS count`,
        { id: newNode.id },
      );
      const count = result.records[0].get('count') as { toNumber: () => number };
      expect(count.toNumber()).toBe(0);
    } finally {
      await verifySession.close();
    }
  });

  it('should link a semantic node to an entity via ABOUT relationship', async () => {
    if (!neo4jAvailable) return;

    // Create a test Entity node
    const entityId = `${TEST_PREFIX}-entity`;
    const session = driver.session();
    try {
      await session.run(
        `CREATE (:Entity {id: $id, name: 'Test Entity', type: 'test', created_at: $now})`,
        { id: entityId, now: new Date().toISOString() }
      );
    } finally {
      await session.close();
    }

    const node = makeSemanticNode('about-entity');
    const semanticId = await store.create(node);
    createdIds.push(semanticId);

    await store.linkToEntity(semanticId, entityId);

    // Verify the ABOUT relationship exists
    const verifySession = driver.session();
    try {
      const result = await verifySession.run(
        `MATCH (s:Semantic {id: $semanticId})-[:ABOUT]->(e:Entity {id: $entityId})
         RETURN count(*) AS cnt`,
        { semanticId, entityId }
      );
      const cnt = result.records[0].get('cnt') as { toNumber: () => number } | number;
      const count = typeof cnt === 'object' ? cnt.toNumber() : cnt;
      expect(count).toBe(1);
    } finally {
      await verifySession.close();
    }
  });

  it('should be idempotent when linking to entity (MERGE)', async () => {
    if (!neo4jAvailable) return;

    const entityId = `${TEST_PREFIX}-entity-merge`;
    const session = driver.session();
    try {
      await session.run(
        `CREATE (:Entity {id: $id, name: 'Merge Entity', type: 'test', created_at: $now})`,
        { id: entityId, now: new Date().toISOString() }
      );
    } finally {
      await session.close();
    }

    const node = makeSemanticNode('merge-about');
    const semanticId = await store.create(node);
    createdIds.push(semanticId);

    // Call twice — should not create duplicate relationships
    await store.linkToEntity(semanticId, entityId);
    await store.linkToEntity(semanticId, entityId);

    const verifySession = driver.session();
    try {
      const result = await verifySession.run(
        `MATCH (s:Semantic {id: $semanticId})-[:ABOUT]->(e:Entity {id: $entityId})
         RETURN count(*) AS cnt`,
        { semanticId, entityId }
      );
      const cnt = result.records[0].get('cnt') as { toNumber: () => number } | number;
      const count = typeof cnt === 'object' ? cnt.toNumber() : cnt;
      expect(count).toBe(1);
    } finally {
      await verifySession.close();
    }
  });

  // RET-005B-AUTH-001B6P T7(b) — the behavioural half of the LATEST-instant
  // claim. Part (a) (the byte-equal Cypher assertion in
  // semantic.idempotency.test.ts) bites in every environment; this arm confirms
  // it against a real server and, like every `it` in this describe, passes
  // VACUOUSLY when Neo4j is unreachable.
  it('promoteFromEpisodic stamps valid_at with the LATEST source-episode instant', async () => {
    if (!neo4jAvailable) return;

    const earlier = '2026-01-01T00:00:00.000Z';
    const later = '2026-01-01T01:00:00.000Z';
    const episodicIds = [
      `${TEST_PREFIX}-episodic-latest-early`,
      `${TEST_PREFIX}-episodic-latest-late`,
    ];

    const session = driver.session();
    try {
      await session.run(
        `CREATE (a:Episodic {
           id: $earlyId, session_id: 'test-session', agent_id: 'test-agent',
           task: 'test-task', content: 'earlier source', created_at: $earlier
         })
         CREATE (b:Episodic {
           id: $lateId, session_id: 'test-session', agent_id: 'test-agent',
           task: 'test-task', content: 'later source', created_at: $later
         })`,
        { earlyId: episodicIds[0], lateId: episodicIds[1], earlier, later },
      );
    } finally {
      await session.close();
    }

    const newNode = makeSemanticNode('promoted-latest');
    const newId = await store.promoteFromEpisodic(episodicIds, newNode);
    createdIds.push(newId);

    const promoted = await store.getById(newId);
    // The LATER instant, not the earlier one and not the node's own created_at:
    // the generalization is evidence-backed only once its full source set exists.
    expect(promoted?.valid_at).toBe(later);
    expect(promoted?.valid_at).not.toBe(earlier);
    expect(promoted?.invalid_at).toBeUndefined();
  });
});

// RET-005B-AUTH-001B6P T16 — mapSemantic pass-through. A mock-driver arm, so it
// bites with or without a server (the same shape as the Integer-mapper test
// above). Legacy rows predate B6P and MUST map to undefined rather than to a
// fabricated instant — that is Decision 120 (2)'s refuse-legacy directive
// expressed mechanically.
it('maps valid_at/invalid_at through getById, dropping legacy absence and driver junk', async () => {
  const base = makeSemanticNode('lifecycle-mapper');
  const legacyProps = { ...base };
  const statedProps = {
    ...base,
    valid_at: '2026-02-01T00:00:00.000Z',
    invalid_at: '2026-03-01T00:00:00.000Z',
  };
  const junkProps = { ...base, valid_at: 12345, invalid_at: { nested: true } };

  const close = vi.fn(async () => undefined);
  let next: Record<string, unknown> = legacyProps;
  const run = vi.fn(async () => ({ records: [{ get: () => ({ properties: next }) }] }));
  const store = new SemanticStore({ session: () => ({ run, close }) } as never);

  const legacy = await store.getById(base.id);
  expect(legacy?.valid_at).toBeUndefined();
  expect(legacy?.invalid_at).toBeUndefined();
  expect(Object.prototype.hasOwnProperty.call(legacy, 'valid_at')).toBe(false);

  next = statedProps;
  const stated = await store.getById(base.id);
  expect(stated?.valid_at).toBe('2026-02-01T00:00:00.000Z');
  expect(stated?.invalid_at).toBe('2026-03-01T00:00:00.000Z');

  next = junkProps;
  const junk = await store.getById(base.id);
  expect(junk?.valid_at).toBeUndefined();
  expect(junk?.invalid_at).toBeUndefined();
});

// Item 12a (RL-014): every Semantic writer stamps status = 'active' on create.
// Asserted on the emitted Cypher — the only surface the mock harness observes.
describe('SemanticStore status stamping (RL-014)', () => {
  function makeCapturingStore(): { store: SemanticStore; queries: string[] } {
    const queries: string[] = [];
    const run = vi.fn(async (query: string) => {
      queries.push(query);
      return { records: [{ get: () => 'sem-status' }] };
    });
    const executeWrite = vi.fn(async (work: (tx: { run: typeof run }) => Promise<unknown>) =>
      work({ run }));
    const close = vi.fn(async () => undefined);
    const store = new SemanticStore({ session: () => ({ run, executeWrite, close }) } as never);
    return { store, queries };
  }
  const onCreateOf = (cypher: string): string => {
    const start = cypher.indexOf('ON CREATE SET');
    expect(start).toBeGreaterThan(-1);
    const rest = cypher.slice(start);
    const end = rest.search(/\n\s*(WITH|SET|MERGE|RETURN)\b/);
    return end === -1 ? rest : rest.slice(0, end);
  };

  it('create stamps status active in the CREATE map', async () => {
    const { store, queries } = makeCapturingStore();
    await store.create(makeSemanticNode('status-create'));
    expect(queries[0]).toMatch(/status:\s*'active'/);
  });

  it('promoteFromEpisodic stamps status active inside ON CREATE SET only', async () => {
    const { store, queries } = makeCapturingStore();
    await store.promoteFromEpisodic(['ep-a'], makeSemanticNode('status-promote'));
    expect(onCreateOf(queries[0])).toMatch(/s\.status\s*=\s*'active'/);
  });

  it('supersede stamps status active on the successor inside ON CREATE SET only', async () => {
    const { store, queries } = makeCapturingStore();
    await store.supersede('sem-old', makeSemanticNode('status-supersede'));
    expect(onCreateOf(queries[0])).toMatch(/new\.status\s*=\s*'active'/);
  });
});

// Item 12b (audit D10): promoted Semantics carry a caller-supplied dedupe_key
// so the semantic_dedupe_unique constraint covers them, and a key collision is
// resolved by linking the source episodes onto the EXISTING Semantic (no twin).
describe('SemanticStore promoteFromEpisodic dedupe_key (D10)', () => {
  const CONSTRAINT_CODE = 'Neo.ClientError.Schema.ConstraintValidationFailed';

  /** Each executeWrite call takes the next outcome: an Error to throw, else an id to return. */
  function makeStore(outcomes: Array<Error | string>) {
    const calls: Array<{ query: string; params: Record<string, unknown> }> = [];
    let i = 0;
    const executeWrite = vi.fn(async (work: (tx: { run: unknown }) => Promise<unknown>) => {
      const outcome = outcomes[i++];
      const run = vi.fn(async (query: string, params: Record<string, unknown>) => {
        calls.push({ query, params });
        if (outcome instanceof Error) throw outcome;
        return { records: [{ get: () => outcome }] };
      });
      return work({ run });
    });
    const close = vi.fn(async () => undefined);
    const store = new SemanticStore({ session: () => ({ executeWrite, close }) } as never);
    return { store, calls, executeWrite, close };
  }

  it('sets s.dedupe_key ON CREATE and carries the param when a dedupeKey is given', async () => {
    const { store, calls } = makeStore(['sem-1']);
    await store.promoteFromEpisodic(['ep-a'], makeSemanticNode('dedupe-given'), undefined, 'promoted:abc');
    const onCreate = calls[0]!.query.slice(calls[0]!.query.indexOf('ON CREATE SET'), calls[0]!.query.indexOf('WITH s, episodes'));
    expect(onCreate).toMatch(/s\.dedupe_key\s*=\s*\$dedupeKey/);
    expect(calls[0]!.params.dedupeKey).toBe('promoted:abc');
  });

  it('emits no dedupe_key clause or param when no dedupeKey is given', async () => {
    const { store, calls } = makeStore(['sem-1']);
    await store.promoteFromEpisodic(['ep-a'], makeSemanticNode('dedupe-absent'));
    expect(calls[0]!.query).not.toContain('dedupe_key');
    expect(calls[0]!.params).not.toHaveProperty('dedupeKey');
  });

  it('on a uniqueness-constraint collision links the episodes onto the existing Semantic and returns its id', async () => {
    const collision = Object.assign(new Error('already exists'), { code: CONSTRAINT_CODE });
    const { store, calls, executeWrite, close } = makeStore([collision, 'sem-existing']);
    const node = makeSemanticNode('dedupe-twin');

    await expect(store.promoteFromEpisodic(['ep-a', 'ep-b'], node, 'acme', 'promoted:abc')).resolves.toBe('sem-existing');

    expect(executeWrite).toHaveBeenCalledTimes(2);
    const retry = calls[1]!;
    expect(retry.query).toMatch(/MATCH \(existing:Semantic \{dedupe_key: \$dedupeKey\}\)/);
    expect(retry.query).toContain('MERGE (existing)-[:PROMOTED_FROM]->(ep)');
    // No second node write: the fallback never creates a Semantic.
    expect(retry.query).not.toMatch(/(MERGE|CREATE) \(\w*:Semantic \{id:/);
    expect(retry.query).not.toContain('ON CREATE');
    expect(retry.params).toMatchObject({ dedupeKey: 'promoted:abc', episodicIds: ['ep-a', 'ep-b'], tenant_id: 'acme' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('propagates any other driver error unchanged', async () => {
    const other = Object.assign(new Error('deadlock'), { code: 'Neo.TransientError.Transaction.DeadlockDetected' });
    const { store, executeWrite } = makeStore([other, 'sem-existing']);
    await expect(store.promoteFromEpisodic(['ep-a'], makeSemanticNode('dedupe-other'), undefined, 'promoted:abc')).rejects.toBe(other);
    expect(executeWrite).toHaveBeenCalledTimes(1);
  });

  it('propagates a constraint error when no dedupeKey was supplied (nothing to fall back to)', async () => {
    const collision = Object.assign(new Error('id exists'), { code: CONSTRAINT_CODE });
    const { store, executeWrite } = makeStore([collision, 'sem-existing']);
    await expect(store.promoteFromEpisodic(['ep-a'], makeSemanticNode('dedupe-nokey'))).rejects.toBe(collision);
    expect(executeWrite).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the collision fallback finds no matching Semantic in the tenant', async () => {
    const collision = Object.assign(new Error('already exists'), { code: CONSTRAINT_CODE });
    const calls: string[] = [];
    let n = 0;
    const executeWrite = vi.fn(async (work: (tx: { run: unknown }) => Promise<unknown>) => {
      const first = n++ === 0;
      return work({ run: vi.fn(async (q: string) => { calls.push(q); if (first) throw collision; return { records: [] }; }) });
    });
    const store = new SemanticStore({ session: () => ({ executeWrite, close: vi.fn() }) } as never);
    await expect(store.promoteFromEpisodic(['ep-a'], makeSemanticNode('dedupe-miss'), 'acme', 'promoted:abc')).rejects.toThrow(/dedupe_key/);
    expect(calls).toHaveLength(2);
  });
});
