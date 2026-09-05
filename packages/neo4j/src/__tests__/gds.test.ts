// packages/neo4j/src/__tests__/gds.test.ts
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import neo4j, { type Driver } from 'neo4j-driver';
import { createNeo4jDriver } from '../driver.js';
import { GDSAlgorithms, type SimilarPair } from '../gds.js';

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

// ─── Seed helpers ────────────────────────────────────────────────────────────

const ENTITY_NAME = 'gds-test-entity';
const ENTITY_NAME_2 = 'gds-test-entity-2';
const SEMANTIC_IDS = ['gds-sem-1', 'gds-sem-2', 'gds-sem-3', 'gds-sem-4'];
const EPISODIC_IDS = ['gds-ep-1', 'gds-ep-2'];

// Simple non-zero embeddings for cosine similarity
function makeEmbedding(val: number): number[] {
  return Array.from({ length: 8 }, (_, i) => (i === 0 ? val : 0.1));
}

async function seedData(driver: ReturnType<typeof createNeo4jDriver>): Promise<void> {
  const session = driver.session();
  try {
    // Clean up first
    await session.run(
      `MATCH (n) WHERE n.id IN $ids DETACH DELETE n`,
      { ids: [...SEMANTIC_IDS, ...EPISODIC_IDS, 'gds-ent-1', 'gds-ent-2'] },
    );

    // Entities
    await session.run(
      `CREATE (e:Entity {id: 'gds-ent-1', name: $name, type: 'test', created_at: '2024-01-01'})`,
      { name: ENTITY_NAME },
    );
    await session.run(
      `CREATE (e:Entity {id: 'gds-ent-2', name: $name, type: 'test', created_at: '2024-01-01'})`,
      { name: ENTITY_NAME_2 },
    );

    // Semantic nodes for ENTITY_NAME (3 nodes with embeddings, 1 without)
    const semanticData = [
      { id: 'gds-sem-1', content: 'fact A', confidence: 0.9, signal_count: 3, embedding: makeEmbedding(1.0) },
      { id: 'gds-sem-2', content: 'fact B', confidence: 0.7, signal_count: 2, embedding: makeEmbedding(0.8) },
      { id: 'gds-sem-3', content: 'fact C', confidence: 0.5, signal_count: 1, embedding: makeEmbedding(0.5) },
      // No embedding — should be excluded from cosine similarity
      { id: 'gds-sem-4', content: 'fact D', confidence: 0.6, signal_count: 4, embedding: null },
    ];

    for (const s of semanticData) {
      await session.run(
        `CREATE (s:Semantic {
           id: $id, content: $content,
           confidence: $confidence, signal_count: $signal_count,
           created_at: '2024-01-01', updated_at: '2024-01-01',
           decay_class: 'stable', tags: []
         })`,
        { id: s.id, content: s.content, confidence: s.confidence, signal_count: s.signal_count },
      );
      if (s.embedding) {
        await session.run(
          `MATCH (s:Semantic {id: $id}) SET s.embedding = $embedding`,
          { id: s.id, embedding: s.embedding },
        );
      }
      await session.run(
        `MATCH (s:Semantic {id: $id}), (e:Entity {id: 'gds-ent-1'})
         MERGE (s)-[:ABOUT]->(e)`,
        { id: s.id },
      );
    }

    // Episodic nodes that CORRECTS some semantics
    await session.run(
      `CREATE (ep:Episodic {
         id: 'gds-ep-1', session_id: 'sess-1', agent_id: 'agent-1',
         task: 'test', content: 'ep content 1',
         created_at: '2024-01-01'
       })`,
    );
    await session.run(
      `CREATE (ep:Episodic {
         id: 'gds-ep-2', session_id: 'sess-1', agent_id: 'agent-1',
         task: 'test', content: 'ep content 2',
         created_at: '2024-01-01'
       })`,
    );

    // ep-1 CORRECTS gds-sem-1, ep-2 CORRECTS gds-sem-1 (2 corrections total)
    await session.run(
      `MATCH (ep:Episodic {id: 'gds-ep-1'}), (s:Semantic {id: 'gds-sem-1'})
       MERGE (ep)-[:CORRECTS]->(s)`,
    );
    await session.run(
      `MATCH (ep:Episodic {id: 'gds-ep-2'}), (s:Semantic {id: 'gds-sem-1'})
       MERGE (ep)-[:CORRECTS]->(s)`,
    );
    // ep-1 also CORRECTS gds-sem-2 (1 correction)
    await session.run(
      `MATCH (ep:Episodic {id: 'gds-ep-1'}), (s:Semantic {id: 'gds-sem-2'})
       MERGE (ep)-[:CORRECTS]->(s)`,
    );
  } finally {
    await session.close();
  }
}

async function cleanupData(driver: ReturnType<typeof createNeo4jDriver>): Promise<void> {
  const session = driver.session();
  try {
    await session.run(
      `MATCH (n) WHERE n.id IN $ids DETACH DELETE n`,
      { ids: [...SEMANTIC_IDS, ...EPISODIC_IDS, 'gds-ent-1', 'gds-ent-2'] },
    );
  } finally {
    await session.close();
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GDSAlgorithms', () => {
  let neo4jAvailable = false;
  const driver = createNeo4jDriver(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD);
  let gds: GDSAlgorithms;

  beforeAll(async () => {
    neo4jAvailable = await isNeo4jReachable(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD);
    if (!neo4jAvailable) {
      console.warn(`[skip] Neo4j not reachable at ${NEO4J_URI} — skipping GDS tests`);
      return;
    }
    await seedData(driver);
    gds = new GDSAlgorithms(driver);
  });

  afterAll(async () => {
    if (neo4jAvailable) {
      await cleanupData(driver);
    }
    await driver.close().catch(() => {});
  });

  describe('findSimilarSemantics', () => {
    // The GDS plugin may be absent on the test box: the method then rejects
    // with the value-free `similarity_unavailable` instead of returning [].
    async function similarOrUnavailable(entity: string, threshold: number): Promise<SimilarPair[]> {
      try {
        return await gds.findSimilarSemantics(entity, threshold);
      } catch (err) {
        expect((err as Error).message).toBe('similarity_unavailable');
        return [];
      }
    }

    it('returns an array (empty or populated) or fails loud when GDS is unavailable', async () => {
      if (!neo4jAvailable) return;
      const results = await similarOrUnavailable(ENTITY_NAME, 0.0);
      expect(Array.isArray(results)).toBe(true);
    });

    it('returned pairs have nodeA, nodeB and similarity fields', async () => {
      if (!neo4jAvailable) return;
      const results = await similarOrUnavailable(ENTITY_NAME, 0.0);
      for (const pair of results) {
        expect(pair).toHaveProperty('nodeA');
        expect(pair).toHaveProperty('nodeB');
        expect(pair).toHaveProperty('similarity');
        expect(typeof pair.similarity).toBe('number');
      }
    });

    it('returns empty for unknown entity (or fails loud without GDS)', async () => {
      if (!neo4jAvailable) return;
      const results = await similarOrUnavailable('no-such-entity', 0.5);
      expect(results).toEqual([]);
    });

    it('respects threshold — no pair has similarity below threshold', async () => {
      if (!neo4jAvailable) return;
      const threshold = 0.99;
      const results = await similarOrUnavailable(ENTITY_NAME, threshold);
      for (const pair of results) {
        expect(pair.similarity).toBeGreaterThanOrEqual(threshold);
      }
    });
  });

  describe('pageRank', () => {
    it('returns ranked nodes with id, content, score', async () => {
      if (!neo4jAvailable) return;
      const results = await gds.pageRank(ENTITY_NAME);
      expect(results.length).toBeGreaterThan(0);
      for (const node of results) {
        expect(node).toHaveProperty('id');
        expect(node).toHaveProperty('content');
        expect(node).toHaveProperty('score');
      }
    });

    it('orders results by score descending', async () => {
      if (!neo4jAvailable) return;
      const results = await gds.pageRank(ENTITY_NAME);
      for (let i = 0; i < results.length - 1; i++) {
        expect(results[i]!.score).toBeGreaterThanOrEqual(results[i + 1]!.score);
      }
    });

    it('score = signal_count * confidence', async () => {
      if (!neo4jAvailable) return;
      const results = await gds.pageRank(ENTITY_NAME);
      // gds-sem-1: signal_count=3, confidence=0.9 → score=2.7 (highest)
      const topNode = results[0]!;
      expect(topNode.id).toBe('gds-sem-1');
      expect(topNode.score).toBeCloseTo(2.7, 5);
    });

    it('returns empty for unknown entity', async () => {
      if (!neo4jAvailable) return;
      const results = await gds.pageRank('no-such-entity');
      expect(results).toHaveLength(0);
    });
  });

  describe('communityDetection', () => {
    it('returns community nodes with id, content, communityId', async () => {
      if (!neo4jAvailable) return;
      const results = await gds.communityDetection();
      expect(results.length).toBeGreaterThan(0);
      for (const node of results) {
        expect(node).toHaveProperty('id');
        expect(node).toHaveProperty('content');
        expect(node).toHaveProperty('communityId');
      }
    });

    it('groups seeded semantics under gds-ent-1 community', async () => {
      if (!neo4jAvailable) return;
      const results = await gds.communityDetection();
      const ent1Nodes = results.filter((n) => n.communityId === 'gds-ent-1');
      // All 4 seeded semantics are linked to gds-ent-1
      expect(ent1Nodes.length).toBeGreaterThanOrEqual(4);
    });

    it('assigns unassigned community for nodes with no entity link', async () => {
      if (!neo4jAvailable) return;
      // Create an orphan node
      const session = driver.session();
      try {
        await session.run(
          `CREATE (s:Semantic {
             id: 'gds-orphan', content: 'orphan',
             confidence: 0.5, signal_count: 0,
             created_at: '2024-01-01', updated_at: '2024-01-01',
             decay_class: 'volatile', tags: []
           })`,
        );
      } finally {
        await session.close();
      }

      const results = await gds.communityDetection();
      const orphan = results.find((n) => n.id === 'gds-orphan');
      expect(orphan).toBeDefined();
      expect(orphan!.communityId).toBe('unassigned');

      // Cleanup orphan
      const cleanSession = driver.session();
      try {
        await cleanSession.run(`MATCH (s:Semantic {id: 'gds-orphan'}) DETACH DELETE s`);
      } finally {
        await cleanSession.close();
      }
    });
  });

  describe('findCorrectionClusters', () => {
    it('returns correction counts for semantics with corrections', async () => {
      if (!neo4jAvailable) return;
      const results = await gds.findCorrectionClusters(ENTITY_NAME);
      expect(results.length).toBeGreaterThan(0);
      for (const cluster of results) {
        expect(cluster).toHaveProperty('targetId');
        expect(cluster).toHaveProperty('correctionCount');
        expect(cluster.correctionCount).toBeGreaterThan(0);
      }
    });

    it('orders by correctionCount descending', async () => {
      if (!neo4jAvailable) return;
      const results = await gds.findCorrectionClusters(ENTITY_NAME);
      for (let i = 0; i < results.length - 1; i++) {
        expect(results[i]!.correctionCount).toBeGreaterThanOrEqual(
          results[i + 1]!.correctionCount,
        );
      }
    });

    it('gds-sem-1 has 2 corrections', async () => {
      if (!neo4jAvailable) return;
      const results = await gds.findCorrectionClusters(ENTITY_NAME);
      const sem1 = results.find((r) => r.targetId === 'gds-sem-1');
      expect(sem1).toBeDefined();
      expect(sem1!.correctionCount).toBe(2);
    });

    it('gds-sem-2 has 1 correction', async () => {
      if (!neo4jAvailable) return;
      const results = await gds.findCorrectionClusters(ENTITY_NAME);
      const sem2 = results.find((r) => r.targetId === 'gds-sem-2');
      expect(sem2).toBeDefined();
      expect(sem2!.correctionCount).toBe(1);
    });

    it('returns empty for unknown entity', async () => {
      if (!neo4jAvailable) return;
      const results = await gds.findCorrectionClusters('no-such-entity');
      expect(results).toHaveLength(0);
    });
  });
});

// ─── Fake-driver tests (no Neo4j needed) ─────────────────────────────────────

describe('GDSAlgorithms.findSimilarSemantics (fake driver)', () => {
  function fakeDriver(run: (cypher: string, params: Record<string, unknown>) => Promise<unknown>) {
    const runSpy = vi.fn(run);
    const close = vi.fn(async () => {});
    const driver = { session: () => ({ run: runSpy, close }) } as unknown as Driver;
    return { driver, run: runSpy, close };
  }

  it('rejects with value-free similarity_unavailable when the driver fails', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { driver, close } = fakeDriver(async () => {
        throw new Error('Could not connect to bolt://secret:7687 as user admin');
      });
      const gds = new GDSAlgorithms(driver);
      let caught: unknown;
      await gds.findSimilarSemantics('ent').catch((e) => { caught = e; });
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe('similarity_unavailable');
      expect((caught as Error).message).not.toContain('bolt://secret');
      expect(close).toHaveBeenCalledTimes(1);
      expect(stderr).toHaveBeenCalledTimes(1);
    } finally {
      stderr.mockRestore();
    }
  });

  it('bounds the cross join and the result with $limit (default 200, Neo4j integer)', async () => {
    const { driver, run } = fakeDriver(async () => ({ records: [] }));
    const gds = new GDSAlgorithms(driver);
    await expect(gds.findSimilarSemantics('ent')).resolves.toEqual([]);
    const [cypher, params] = run.mock.calls[0]! as [string, Record<string, unknown>];
    expect(cypher).toMatch(/nodes\[0\.\.\$limit\]/);
    expect(cypher).toMatch(/LIMIT \$limit\s*$/);
    expect(neo4j.isInt(params.limit)).toBe(true);
    expect(neo4j.integer.toNumber(params.limit as neo4j.Integer)).toBe(200);
  });

  it('accepts an explicit limit as the third argument', async () => {
    const { driver, run } = fakeDriver(async () => ({ records: [] }));
    await new GDSAlgorithms(driver).findSimilarSemantics('ent', 0.7, 25);
    const params = run.mock.calls[0]![1] as Record<string, unknown>;
    expect(neo4j.integer.toNumber(params.limit as neo4j.Integer)).toBe(25);
  });

  it('happy path: maps records and applies the threshold', async () => {
    const rec = (nodeA: string, nodeB: string, similarity: number) => ({
      get: (k: string) => ({ nodeA, nodeB, similarity })[k],
    });
    const { driver } = fakeDriver(async () => ({ records: [rec('a', 'b', 0.9), rec('a', 'c', 0.5)] }));
    const results = await new GDSAlgorithms(driver).findSimilarSemantics('ent', 0.7);
    expect(results).toEqual([{ nodeA: 'a', nodeB: 'b', similarity: 0.9 }]);
  });
});
