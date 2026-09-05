// packages/core/src/__tests__/consolidation-gds.test.ts
//
// Tests for GDS-enhanced consolidation: merge detection via cosine similarity,
// correction clustering, PageRank-based importance scoring, and graceful
// degradation when the GDS plugin is unavailable.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConsolidationEngine } from '../consolidation.js';
import type { ConsolidationRedisLayer, ConsolidationNeo4jLayer } from '../consolidation.js';
import type { AMPConfig, SemanticNode, StreamSignal, ConsolidationProposal } from '../types.js';
import { GDSAlgorithms } from '@memberry/neo4j';
import type { SimilarPair, RankedNode, CommunityNode } from '@memberry/neo4j';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<AMPConfig['consolidation']> = {}): AMPConfig {
  return {
    redis: { url: 'redis://localhost:6379' },
    neo4j: { uri: 'bolt://localhost:7687', user: 'neo4j', password: 'password' },
    embedding: { provider: 'openai', apiKey: 'test-key' },
    cache: { defaultTTL: 300, contextTTL: 600, embeddingTTL: 86400 },
    consolidation: { autoApply: false, signalThreshold: 3, ...overrides },
    exportPath: '/tmp/amp-export',
  };
}

function makeSemanticNode(id: string, overrides: Partial<SemanticNode> = {}): SemanticNode {
  return {
    id,
    content: `Semantic knowledge ${id}`,
    confidence: 0.8,
    signal_count: 2,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    decay_class: 'stable',
    tags: ['test'],
    ...overrides,
  };
}

function makeStreamSignal(
  targetId: string,
  type: StreamSignal['type'] = 'reinforcement',
  detail = 'Test signal',
): StreamSignal {
  return {
    type,
    target_id: targetId,
    detail,
    source_session: 'sess-gds-1',
    agent_id: 'agent-gds',
    timestamp: new Date().toISOString(),
  };
}

function makeRedis(overrides: Partial<ConsolidationRedisLayer> = {}): ConsolidationRedisLayer {
  return {
    lock: {
      acquire: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(true),
    },
    signals: {
      consume: vi.fn().mockResolvedValue([]),
    },
    queue: {
      popHighest: vi.fn().mockResolvedValue(null),
    },
    proposals: {
      save: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(null),
      listPending: vi.fn().mockResolvedValue([]),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    cache: {
      invalidateByNodeId: vi.fn().mockResolvedValue(1),
    },
    ...overrides,
  };
}

function makeNeo4j(overrides: Partial<ConsolidationNeo4jLayer> = {}): ConsolidationNeo4jLayer {
  return {
    semantic: {
      getById: vi.fn().mockResolvedValue(null),
      updateConfidence: vi.fn().mockResolvedValue(undefined),
      supersede: vi.fn().mockResolvedValue('new-id'),
    },
    ...overrides,
  };
}

// ─── Mock Neo4j driver for GDSAlgorithms ──────────────────────────────────────

interface MockRecord {
  get(key: string): unknown;
}

function makeMockRecord(data: Record<string, unknown>): MockRecord {
  return { get: (key: string) => data[key] };
}

function makeMockSession(runResult: { records: MockRecord[] } | Error = { records: [] }) {
  return {
    run: runResult instanceof Error
      ? vi.fn().mockRejectedValue(runResult)
      : vi.fn().mockResolvedValue(runResult),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockDriver(session: ReturnType<typeof makeMockSession>) {
  return {
    session: vi.fn().mockReturnValue(session),
  } as unknown as import('neo4j-driver').Driver;
}

// ─── GDS-enhanced merge detection ─────────────────────────────────────────────

describe('GDS-enhanced merge detection', () => {
  it('findSimilarSemantics returns pairs above the similarity threshold', async () => {
    const records = [
      makeMockRecord({ nodeA: 'sem-1', nodeB: 'sem-2', similarity: 0.92 }),
      makeMockRecord({ nodeA: 'sem-1', nodeB: 'sem-3', similarity: 0.85 }),
      makeMockRecord({ nodeA: 'sem-2', nodeB: 'sem-3', similarity: 0.60 }),
    ];

    const session = makeMockSession({ records });
    const driver = makeMockDriver(session);
    const gds = new GDSAlgorithms(driver);

    const pairs = await gds.findSimilarSemantics('TestEntity', 0.7);

    expect(pairs).toHaveLength(2);
    expect(pairs[0]).toEqual({ nodeA: 'sem-1', nodeB: 'sem-2', similarity: 0.92 });
    expect(pairs[1]).toEqual({ nodeA: 'sem-1', nodeB: 'sem-3', similarity: 0.85 });
    // sem-2/sem-3 pair at 0.60 is below threshold and excluded
  });

  it('findSimilarSemantics with default threshold of 0.7', async () => {
    const records = [
      makeMockRecord({ nodeA: 'sem-a', nodeB: 'sem-b', similarity: 0.75 }),
      makeMockRecord({ nodeA: 'sem-a', nodeB: 'sem-c', similarity: 0.69 }),
    ];

    const session = makeMockSession({ records });
    const driver = makeMockDriver(session);
    const gds = new GDSAlgorithms(driver);

    const pairs = await gds.findSimilarSemantics('TestEntity');

    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.similarity).toBeGreaterThanOrEqual(0.7);
  });

  it('similar semantic pairs can inform merge proposals in consolidation', async () => {
    // Scenario: two semantic nodes are highly similar (0.95). When correction
    // signals arrive for both, the consolidation engine should generate
    // supersede proposals for each. In a GDS-enhanced flow, a merge step
    // would combine them — here we verify the prerequisite: both targets
    // produce proposals that can be post-processed for merge.

    const nodeA = makeSemanticNode('sem-merge-a', { confidence: 0.7, content: 'Deploy with pnpm' });
    const nodeB = makeSemanticNode('sem-merge-b', { confidence: 0.6, content: 'Deploy using pnpm run deploy' });

    const signals: StreamSignal[] = [
      makeStreamSignal('sem-merge-a', 'correction', 'Deploy command updated'),
      makeStreamSignal('sem-merge-a', 'correction', 'Added --frozen-lockfile flag'),
      makeStreamSignal('sem-merge-b', 'correction', 'Deploy process changed'),
      makeStreamSignal('sem-merge-b', 'correction', 'Use CI deploy script'),
    ];

    const redis = makeRedis({
      signals: { consume: vi.fn().mockResolvedValue(signals) },
    });
    const neo4j = makeNeo4j({
      semantic: {
        getById: vi.fn().mockImplementation((id: string) => {
          if (id === 'sem-merge-a') return Promise.resolve(nodeA);
          if (id === 'sem-merge-b') return Promise.resolve(nodeB);
          return Promise.resolve(null);
        }),
        updateConfidence: vi.fn().mockResolvedValue(undefined),
        supersede: vi.fn().mockResolvedValue('new-merged'),
      },
    });

    const engine = new ConsolidationEngine(redis, neo4j, makeConfig());
    const result = await engine.run('merge-scope');

    // Both targets should generate supersede proposals (corrections present)
    const supersedeProposals = result.proposals.filter((p) => p.type === 'supersede');
    expect(supersedeProposals).toHaveLength(2);

    const affectedIds = supersedeProposals.flatMap((p) => p.affected_ids);
    expect(affectedIds).toContain('sem-merge-a');
    expect(affectedIds).toContain('sem-merge-b');

    // Both proposals should have reduced confidence due to corrections
    for (const proposal of supersedeProposals) {
      const afterConfidence = (proposal.after as { confidence: number }).confidence;
      const beforeConfidence = (proposal.before as { confidence: number }).confidence;
      expect(afterConfidence).toBeLessThan(beforeConfidence);
    }
  });

  it('findSimilarSemantics returns empty array when no embeddings exist', async () => {
    // No records returned when all nodes lack embeddings
    const session = makeMockSession({ records: [] });
    const driver = makeMockDriver(session);
    const gds = new GDSAlgorithms(driver);

    const pairs = await gds.findSimilarSemantics('EmptyEntity', 0.5);

    expect(pairs).toEqual([]);
  });

  it('merge detection with zero threshold returns all pairs', async () => {
    const records = [
      makeMockRecord({ nodeA: 'sem-x', nodeB: 'sem-y', similarity: 0.01 }),
      makeMockRecord({ nodeA: 'sem-x', nodeB: 'sem-z', similarity: 0.99 }),
    ];

    const session = makeMockSession({ records });
    const driver = makeMockDriver(session);
    const gds = new GDSAlgorithms(driver);

    const pairs = await gds.findSimilarSemantics('TestEntity', 0.0);

    expect(pairs).toHaveLength(2);
  });
});

// ─── Correction signal clustering ─────────────────────────────────────────────

describe('Correction signal clustering', () => {
  it('findCorrectionClusters returns targets ordered by correction count', async () => {
    const records = [
      makeMockRecord({ targetId: 'sem-hot', correctionCount: 5 }),
      makeMockRecord({ targetId: 'sem-warm', correctionCount: 2 }),
      makeMockRecord({ targetId: 'sem-cool', correctionCount: 1 }),
    ];

    const session = makeMockSession({ records });
    const driver = makeMockDriver(session);
    const gds = new GDSAlgorithms(driver);

    const clusters = await gds.findCorrectionClusters('TestEntity');

    expect(clusters).toHaveLength(3);
    expect(clusters[0]!.targetId).toBe('sem-hot');
    expect(clusters[0]!.correctionCount).toBe(5);
    expect(clusters[1]!.correctionCount).toBe(2);
    expect(clusters[2]!.correctionCount).toBe(1);
  });

  it('handles Neo4j Integer objects with toNumber()', async () => {
    // Neo4j count() returns Integer objects, not JS numbers
    const neo4jInteger = { toNumber: () => 3 };
    const records = [
      makeMockRecord({ targetId: 'sem-int', correctionCount: neo4jInteger }),
    ];

    const session = makeMockSession({ records });
    const driver = makeMockDriver(session);
    const gds = new GDSAlgorithms(driver);

    const clusters = await gds.findCorrectionClusters('TestEntity');

    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.correctionCount).toBe(3);
  });

  it('correction clusters drive supersede proposals in consolidation', async () => {
    // A semantic node with many corrections should generate a supersede proposal
    // with reduced confidence proportional to correction count
    const hotNode = makeSemanticNode('sem-heavily-corrected', {
      confidence: 0.9,
      signal_count: 5,
    });

    // 3 correction signals + 1 contradiction = weight 3*5 + 1*3 = 18
    const signals: StreamSignal[] = [
      makeStreamSignal('sem-heavily-corrected', 'correction', 'Wrong deploy path'),
      makeStreamSignal('sem-heavily-corrected', 'correction', 'Wrong branch name'),
      makeStreamSignal('sem-heavily-corrected', 'correction', 'Wrong env variable'),
      makeStreamSignal('sem-heavily-corrected', 'contradiction', 'Entire approach changed'),
    ];

    const redis = makeRedis({
      signals: { consume: vi.fn().mockResolvedValue(signals) },
    });
    const neo4j = makeNeo4j({
      semantic: {
        getById: vi.fn().mockResolvedValue(hotNode),
        updateConfidence: vi.fn().mockResolvedValue(undefined),
        supersede: vi.fn().mockResolvedValue('new-corrected'),
      },
    });

    const engine = new ConsolidationEngine(redis, neo4j, makeConfig());
    const result = await engine.run('correction-cluster-scope');

    expect(result.proposals).toHaveLength(1);
    const proposal = result.proposals[0]!;
    expect(proposal.type).toBe('supersede');

    // Confidence reduced by 0.1 * (3 corrections + 1 contradiction) = 0.4
    const afterConfidence = (proposal.after as { confidence: number }).confidence;
    expect(afterConfidence).toBeCloseTo(0.9 - 0.4, 5);
    expect(afterConfidence).toBeCloseTo(0.5, 5);
  });

  it('mixed signals cluster correctly per target', async () => {
    const nodeA = makeSemanticNode('sem-target-a', { confidence: 0.8 });
    const nodeB = makeSemanticNode('sem-target-b', { confidence: 0.7 });

    // Target A: 2 corrections (weight 10), Target B: 4 reinforcements (weight 4)
    const signals: StreamSignal[] = [
      makeStreamSignal('sem-target-a', 'correction'),
      makeStreamSignal('sem-target-a', 'correction'),
      makeStreamSignal('sem-target-b', 'reinforcement'),
      makeStreamSignal('sem-target-b', 'reinforcement'),
      makeStreamSignal('sem-target-b', 'reinforcement'),
      makeStreamSignal('sem-target-b', 'reinforcement'),
    ];

    const redis = makeRedis({
      signals: { consume: vi.fn().mockResolvedValue(signals) },
    });
    const neo4j = makeNeo4j({
      semantic: {
        getById: vi.fn().mockImplementation((id: string) => {
          if (id === 'sem-target-a') return Promise.resolve(nodeA);
          if (id === 'sem-target-b') return Promise.resolve(nodeB);
          return Promise.resolve(null);
        }),
        updateConfidence: vi.fn().mockResolvedValue(undefined),
        supersede: vi.fn().mockResolvedValue('new-id'),
      },
    });

    const engine = new ConsolidationEngine(redis, neo4j, makeConfig());
    const result = await engine.run('mixed-signals-scope');

    // Both exceed threshold (3): A=10, B=4
    expect(result.proposals).toHaveLength(2);

    const proposalA = result.proposals.find((p) => p.affected_ids.includes('sem-target-a'))!;
    const proposalB = result.proposals.find((p) => p.affected_ids.includes('sem-target-b'))!;

    // A has corrections -> supersede
    expect(proposalA.type).toBe('supersede');
    // B has only reinforcements -> reinforce (raises confidence; no corrections/contradictions)
    expect(proposalB.type).toBe('reinforce');
  });

  it('returns empty for entity with no corrections', async () => {
    const session = makeMockSession({ records: [] });
    const driver = makeMockDriver(session);
    const gds = new GDSAlgorithms(driver);

    const clusters = await gds.findCorrectionClusters('CleanEntity');

    expect(clusters).toEqual([]);
  });
});

// ─── Error handling when GDS plugin is not available ──────────────────────────

describe('GDS graceful degradation', () => {
  let stderr: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    stderr.mockRestore();
  });

  it('findSimilarSemantics throws similarity_unavailable when GDS query fails', async () => {
    const gdsError = new Error(
      'There is no procedure with the name `gds.similarity.cosine` registered',
    );
    const session = makeMockSession(gdsError);
    const driver = makeMockDriver(session);
    const gds = new GDSAlgorithms(driver);

    await expect(gds.findSimilarSemantics('TestEntity', 0.5)).rejects.toThrow('similarity_unavailable');
    await expect(gds.findSimilarSemantics('TestEntity', 0.5)).rejects.not.toThrow('gds.similarity.cosine');
    expect(session.close).toHaveBeenCalled();
  });

  it('findSimilarSemantics throws similarity_unavailable on network timeout', async () => {
    const timeoutError = new Error('Connection timed out');
    const session = makeMockSession(timeoutError);
    const driver = makeMockDriver(session);
    const gds = new GDSAlgorithms(driver);

    await expect(gds.findSimilarSemantics('TestEntity')).rejects.toThrow('similarity_unavailable');
    await expect(gds.findSimilarSemantics('TestEntity')).rejects.not.toThrow('Connection timed out');
    expect(session.close).toHaveBeenCalled();
  });

  it('findSimilarSemantics throws similarity_unavailable on ServiceUnavailable error', async () => {
    const serviceError = new Error('ServiceUnavailable: Neo4j instance is not available');
    const session = makeMockSession(serviceError);
    const driver = makeMockDriver(session);
    const gds = new GDSAlgorithms(driver);

    await expect(gds.findSimilarSemantics('TestEntity', 0.8)).rejects.toThrow('similarity_unavailable');
    await expect(gds.findSimilarSemantics('TestEntity', 0.8)).rejects.not.toThrow('ServiceUnavailable');
  });

  it('pageRank propagates errors (no graceful fallback)', async () => {
    const dbError = new Error('Neo4j connection refused');
    const session = makeMockSession(dbError);
    const driver = makeMockDriver(session);
    const gds = new GDSAlgorithms(driver);

    await expect(gds.pageRank('TestEntity')).rejects.toThrow('Neo4j connection refused');
    expect(session.close).toHaveBeenCalled();
  });

  it('communityDetection propagates errors (no graceful fallback)', async () => {
    const dbError = new Error('Authentication failure');
    const session = makeMockSession(dbError);
    const driver = makeMockDriver(session);
    const gds = new GDSAlgorithms(driver);

    await expect(gds.communityDetection()).rejects.toThrow('Authentication failure');
    expect(session.close).toHaveBeenCalled();
  });

  it('findCorrectionClusters propagates errors (no graceful fallback)', async () => {
    const dbError = new Error('Database shutting down');
    const session = makeMockSession(dbError);
    const driver = makeMockDriver(session);
    const gds = new GDSAlgorithms(driver);

    await expect(gds.findCorrectionClusters('TestEntity')).rejects.toThrow(
      'Database shutting down',
    );
    expect(session.close).toHaveBeenCalled();
  });

  it('consolidation engine continues when GDS similarity is unavailable', async () => {
    // The consolidation engine does not directly call GDS — it works from
    // signals and queue entries. When GDS returns empty (degraded), the engine
    // still processes the signals it has. This test verifies that the engine
    // produces correct proposals from signal data alone, without GDS enrichment.

    const node = makeSemanticNode('sem-no-gds', { confidence: 0.75 });
    const signals: StreamSignal[] = [
      makeStreamSignal('sem-no-gds', 'correction'),
      makeStreamSignal('sem-no-gds', 'correction'),
      makeStreamSignal('sem-no-gds', 'correction'),
    ];

    const redis = makeRedis({
      signals: { consume: vi.fn().mockResolvedValue(signals) },
    });
    const neo4j = makeNeo4j({
      semantic: {
        getById: vi.fn().mockResolvedValue(node),
        updateConfidence: vi.fn().mockResolvedValue(undefined),
        supersede: vi.fn().mockResolvedValue('new-fallback'),
      },
    });

    const engine = new ConsolidationEngine(redis, neo4j, makeConfig());
    const result = await engine.run('no-gds-scope');

    // Engine should still produce proposals from signal data alone
    expect(result.skipped).toBe(false);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]!.type).toBe('supersede');
    expect(result.proposals[0]!.affected_ids).toContain('sem-no-gds');
  });

  it('session is always closed even when query throws', async () => {
    const session = makeMockSession(new Error('unexpected crash'));
    const driver = makeMockDriver(session);
    const gds = new GDSAlgorithms(driver);

    // findSimilarSemantics throws similarity_unavailable -> session still closed via finally
    await expect(gds.findSimilarSemantics('TestEntity')).rejects.toThrow('similarity_unavailable');
    expect(session.close).toHaveBeenCalledTimes(1);

    // pageRank throws -> session should still be closed via finally
    session.close.mockClear();
    await expect(gds.pageRank('TestEntity')).rejects.toThrow();
    expect(session.close).toHaveBeenCalledTimes(1);
  });
});

// ─── PageRank-based importance scoring during promotion ───────────────────────

describe('PageRank-based importance scoring', () => {
  it('pageRank returns nodes ranked by signal_count * confidence', async () => {
    const records = [
      makeMockRecord({ id: 'sem-top', content: 'High importance', score: 4.5 }),
      makeMockRecord({ id: 'sem-mid', content: 'Medium importance', score: 2.1 }),
      makeMockRecord({ id: 'sem-low', content: 'Low importance', score: 0.3 }),
    ];

    const session = makeMockSession({ records });
    const driver = makeMockDriver(session);
    const gds = new GDSAlgorithms(driver);

    const ranked = await gds.pageRank('TestEntity');

    expect(ranked).toHaveLength(3);
    expect(ranked[0]!.id).toBe('sem-top');
    expect(ranked[0]!.score).toBe(4.5);
    expect(ranked[1]!.score).toBe(2.1);
    expect(ranked[2]!.score).toBe(0.3);

    // Verify descending order
    for (let i = 0; i < ranked.length - 1; i++) {
      expect(ranked[i]!.score).toBeGreaterThanOrEqual(ranked[i + 1]!.score);
    }
  });

  it('does not reinterpret untyped pageRank queue scores as decay instructions', async () => {
    const highScoreNode = makeSemanticNode('sem-high-pr', {
      confidence: 0.95,
      signal_count: 10,
    });
    const lowScoreNode = makeSemanticNode('sem-low-pr', {
      confidence: 0.3,
      signal_count: 1,
    });

    let queueCallCount = 0;
    const redis = makeRedis({
      queue: {
        popHighest: vi.fn().mockImplementation(() => {
          queueCallCount++;
          // High score entry exceeds threshold (3), low score does not (score=1)
          if (queueCallCount === 1)
            return Promise.resolve({ member: 'sem-high-pr', score: 10 });
          if (queueCallCount === 2)
            return Promise.resolve({ member: 'sem-low-pr', score: 1 });
          return Promise.resolve(null);
        }),
      },
    });
    const neo4j = makeNeo4j({
      semantic: {
        getById: vi.fn().mockImplementation((id: string) => {
          if (id === 'sem-high-pr') return Promise.resolve(highScoreNode);
          if (id === 'sem-low-pr') return Promise.resolve(lowScoreNode);
          return Promise.resolve(null);
        }),
        updateConfidence: vi.fn().mockResolvedValue(undefined),
        supersede: vi.fn().mockResolvedValue('new-id'),
      },
    });

    const engine = new ConsolidationEngine(redis, neo4j, makeConfig());
    const result = await engine.run('pagerank-scope');

    expect(result.proposals).toHaveLength(0);
    expect(redis.queue.popHighest).not.toHaveBeenCalled();
  });

  it('does not double-count an untyped queue score alongside typed signals', async () => {
    const node = makeSemanticNode('sem-boosted', { confidence: 0.8 });

    // 1 reinforcement = weight 1.0 (below threshold 3)
    // But queue entry with score=5 boosts total to 6.0 (above threshold)
    const signals: StreamSignal[] = [
      makeStreamSignal('sem-boosted', 'reinforcement'),
    ];

    let queueCallCount = 0;
    const redis = makeRedis({
      signals: { consume: vi.fn().mockResolvedValue(signals) },
      queue: {
        popHighest: vi.fn().mockImplementation(() => {
          queueCallCount++;
          if (queueCallCount === 1)
            return Promise.resolve({ member: 'sem-boosted', score: 5 });
          return Promise.resolve(null);
        }),
      },
    });
    const neo4j = makeNeo4j({
      semantic: {
        getById: vi.fn().mockResolvedValue(node),
        updateConfidence: vi.fn().mockResolvedValue(undefined),
        supersede: vi.fn().mockResolvedValue('new-id'),
      },
    });

    const engine = new ConsolidationEngine(redis, neo4j, makeConfig());
    const result = await engine.run('boost-scope');

    expect(result.proposals).toHaveLength(0);
    expect(redis.queue.popHighest).not.toHaveBeenCalled();
  });

  it('pageRank returns empty for entity with no semantic nodes', async () => {
    const session = makeMockSession({ records: [] });
    const driver = makeMockDriver(session);
    const gds = new GDSAlgorithms(driver);

    const ranked = await gds.pageRank('EmptyEntity');

    expect(ranked).toEqual([]);
  });

  it('communityDetection groups nodes by entity and marks orphans', async () => {
    const records = [
      makeMockRecord({ id: 'sem-g1-a', content: 'Group 1 fact A', communityId: 'ent-1' }),
      makeMockRecord({ id: 'sem-g1-b', content: 'Group 1 fact B', communityId: 'ent-1' }),
      makeMockRecord({ id: 'sem-g2-a', content: 'Group 2 fact A', communityId: 'ent-2' }),
      makeMockRecord({ id: 'sem-orphan', content: 'Orphan fact', communityId: 'unassigned' }),
    ];

    const session = makeMockSession({ records });
    const driver = makeMockDriver(session);
    const gds = new GDSAlgorithms(driver);

    const communities = await gds.communityDetection();

    expect(communities).toHaveLength(4);

    const group1 = communities.filter((n) => n.communityId === 'ent-1');
    expect(group1).toHaveLength(2);

    const group2 = communities.filter((n) => n.communityId === 'ent-2');
    expect(group2).toHaveLength(1);

    const orphans = communities.filter((n) => n.communityId === 'unassigned');
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.id).toBe('sem-orphan');
  });

  it('never creates queue-only decay, regardless of queue score', async () => {
    const node = makeSemanticNode('sem-decay-check', { confidence: 0.8 });

    let queueCallCount = 0;
    const redis = makeRedis({
      queue: {
        popHighest: vi.fn().mockImplementation(() => {
          queueCallCount++;
          if (queueCallCount === 1)
            return Promise.resolve({ member: 'sem-decay-check', score: 5 });
          return Promise.resolve(null);
        }),
      },
    });
    const neo4j = makeNeo4j({
      semantic: {
        getById: vi.fn().mockResolvedValue(node),
        updateConfidence: vi.fn().mockResolvedValue(undefined),
        supersede: vi.fn().mockResolvedValue('new-id'),
      },
    });

    const engine = new ConsolidationEngine(redis, neo4j, makeConfig());
    const result = await engine.run('decay-check-scope');

    expect(result.proposals).toHaveLength(0);
    expect(redis.queue.popHighest).not.toHaveBeenCalled();
  });
});
