// packages/core/src/__tests__/consolidation.test.ts
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConsolidationEngine } from '../consolidation.js';
import type { ConsolidationRedisLayer, ConsolidationNeo4jLayer } from '../consolidation.js';
import type { AMPConfig, SemanticNode, StreamSignal, ConsolidationProposal } from '../types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(autoApply = false): AMPConfig {
  return {
    redis: { url: 'redis://localhost:6379' },
    neo4j: { uri: 'bolt://localhost:7687', user: 'neo4j', password: 'password' },
    embedding: { provider: 'openai', apiKey: 'test-key' },
    cache: { defaultTTL: 300, contextTTL: 600, embeddingTTL: 86400 },
    consolidation: { autoApply, signalThreshold: 3 },
    exportPath: '/tmp/amp-export',
  };
}

function makeSemanticNode(id = 'sem-1'): SemanticNode {
  return {
    id,
    content: 'Semantic knowledge about the task',
    confidence: 0.8,
    signal_count: 2,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    decay_class: 'stable',
    tags: ['test'],
  };
}

function makeStreamSignal(targetId: string, type: StreamSignal['type'] = 'reinforcement'): StreamSignal {
  return {
    type,
    target_id: targetId,
    detail: 'Test signal detail',
    source_session: 'sess-1',
    agent_id: 'agent-1',
    timestamp: new Date().toISOString(),
  };
}

function makeDeliveredSignal(
  streamId: string,
  targetId: string,
  type: StreamSignal['type'] = 'reinforcement',
): StreamSignal & { stream_id: string } {
  return { ...makeStreamSignal(targetId, type), stream_id: streamId };
}

// ─── Mock factories ────────────────────────────────────────────────────────────

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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ConsolidationEngine.run', () => {
  it('returns skipped when lock cannot be acquired', async () => {
    const redis = makeRedis({
      lock: {
        acquire: vi.fn().mockResolvedValue(false),
        release: vi.fn().mockResolvedValue(false),
      },
    });
    const neo4j = makeNeo4j();

    const engine = new ConsolidationEngine(redis, neo4j, makeConfig());
    const result = await engine.run('test-scope');

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('lock_held');
    expect(result.proposals).toHaveLength(0);
    expect(result.applied).toHaveLength(0);
    // lock was never released (since it wasn't acquired)
    expect(redis.lock.release).not.toHaveBeenCalled();
  });

  it('releases lock even when an error occurs', async () => {
    const redis = makeRedis({
      signals: {
        consume: vi.fn().mockRejectedValue(new Error('stream error')),
      },
    });
    const neo4j = makeNeo4j();

    const engine = new ConsolidationEngine(redis, neo4j, makeConfig());

    await expect(engine.run('test-scope')).rejects.toThrow('stream error');
    expect(redis.lock.release).toHaveBeenCalledOnce();
  });

  it('renews the distributed lease during a long consolidation run', async () => {
    vi.useFakeTimers();
    try {
      const renew = vi.fn().mockResolvedValue(true);
      const redis = makeRedis({
        lock: {
          acquire: vi.fn().mockResolvedValue(true),
          renew,
          release: vi.fn().mockResolvedValue(true),
        },
        signals: {
          consume: vi.fn().mockImplementation(
            () => new Promise((resolve) => setTimeout(() => resolve([]), 10_001)),
          ),
        },
      });
      const run = new ConsolidationEngine(redis, makeNeo4j(), makeConfig()).run('slow-scope');

      await vi.advanceTimersByTimeAsync(10_001);
      await run;

      expect(renew).toHaveBeenCalledWith('slow-scope', expect.any(String), 30);
      expect(redis.lock.release).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('generates proposals from signals when threshold is met', async () => {
    const node = makeSemanticNode('sem-target');

    // 4 correction signals → totalWeight = 4 * 5.0 = 20 (above threshold 3)
    const signals: StreamSignal[] = [
      makeStreamSignal('sem-target', 'correction'),
      makeStreamSignal('sem-target', 'correction'),
      makeStreamSignal('sem-target', 'correction'),
      makeStreamSignal('sem-target', 'correction'),
    ];

    const redis = makeRedis({
      signals: {
        consume: vi.fn().mockResolvedValue(signals),
      },
    });
    const neo4j = makeNeo4j({
      semantic: {
        getById: vi.fn().mockResolvedValue(node),
        updateConfidence: vi.fn().mockResolvedValue(undefined),
        supersede: vi.fn().mockResolvedValue('new-sem-id'),
      },
    });

    const engine = new ConsolidationEngine(redis, neo4j, makeConfig(false));
    const result = await engine.run('test-scope');

    expect(result.skipped).toBe(false);
    expect(result.proposals.length).toBeGreaterThan(0);
    expect(result.proposals[0].affected_ids).toContain('sem-target');
    // Not auto-applied → saved to proposals store
    expect(redis.proposals.save).toHaveBeenCalledTimes(result.proposals.length);
    expect(result.applied).toHaveLength(0);
  });

  it('RAISES confidence on reinforcement signals (not decay)', async () => {
    // Reinforcement is evidence the knowledge held true — confidence must go UP, never
    // down. (Regression: this branch previously called buildDecayProposal, lowering
    // confidence by 5% on every confirmation.)
    const node = makeSemanticNode('sem-reinforced'); // confidence 0.8
    const signals: StreamSignal[] = [
      makeStreamSignal('sem-reinforced', 'reinforcement'),
      makeStreamSignal('sem-reinforced', 'reinforcement'),
      makeStreamSignal('sem-reinforced', 'reinforcement'),
      makeStreamSignal('sem-reinforced', 'reinforcement'),
    ];

    const redis = makeRedis({
      signals: { consume: vi.fn().mockResolvedValue(signals) },
    });
    const neo4j = makeNeo4j({
      semantic: {
        getById: vi.fn().mockResolvedValue(node),
        updateConfidence: vi.fn().mockResolvedValue(undefined),
        supersede: vi.fn().mockResolvedValue('new-id'),
      },
    });

    const engine = new ConsolidationEngine(redis, neo4j, makeConfig(false));
    const result = await engine.run('reinforce-scope');

    const proposal = result.proposals.find((p) => p.affected_ids.includes('sem-reinforced'));
    expect(proposal).toBeDefined();
    expect(proposal?.type).toBe('reinforce');
    const afterConfidence = (proposal?.after as { confidence?: number }).confidence;
    expect(afterConfidence).toBeGreaterThan(node.confidence); // raised, not decayed
    expect(afterConfidence).toBeLessThanOrEqual(1); // bounded
  });

  it('OPT-54: batches semantic fetch via getByIds (one call) instead of per-id getById', async () => {
    // Two distinct clusters each above threshold → the proposal pass must fetch
    // BOTH nodes in ONE getByIds call, not two sequential getById calls.
    const nodeA = makeSemanticNode('sem-a');
    const nodeB = makeSemanticNode('sem-b');
    const signals: StreamSignal[] = [
      makeStreamSignal('sem-a', 'correction'),
      makeStreamSignal('sem-a', 'correction'),
      makeStreamSignal('sem-a', 'correction'),
      makeStreamSignal('sem-b', 'correction'),
      makeStreamSignal('sem-b', 'correction'),
      makeStreamSignal('sem-b', 'correction'),
    ];

    const getById = vi.fn(); // must NOT be called when getByIds is present
    const getByIds = vi.fn().mockResolvedValue([nodeA, nodeB]);
    const redis = makeRedis({ signals: { consume: vi.fn().mockResolvedValue(signals) } });
    const neo4j = makeNeo4j({
      semantic: {
        getById,
        getByIds,
        updateConfidence: vi.fn().mockResolvedValue(undefined),
        supersede: vi.fn().mockResolvedValue('new-id'),
      },
    });

    const engine = new ConsolidationEngine(redis, neo4j, makeConfig(false));
    const result = await engine.run('batch-scope');

    expect(getByIds).toHaveBeenCalledTimes(1);
    const fetchedIds = (getByIds.mock.calls[0][0] as string[]).slice().sort();
    expect(fetchedIds).toEqual(['sem-a', 'sem-b']);
    expect(getById).not.toHaveBeenCalled(); // batched path preferred over per-id
    // Same proposals as the per-id path would have produced (one per cluster).
    const ids = result.proposals.flatMap((p) => p.affected_ids);
    expect(ids).toContain('sem-a');
    expect(ids).toContain('sem-b');
  });

  it('OPT-54: falls back to per-id getById when getByIds is absent', async () => {
    const node = makeSemanticNode('sem-fallback');
    const signals: StreamSignal[] = [
      makeStreamSignal('sem-fallback', 'correction'),
      makeStreamSignal('sem-fallback', 'correction'),
      makeStreamSignal('sem-fallback', 'correction'),
    ];
    const getById = vi.fn().mockResolvedValue(node);
    const redis = makeRedis({ signals: { consume: vi.fn().mockResolvedValue(signals) } });
    const neo4j = makeNeo4j({
      semantic: {
        getById, // no getByIds → fallback path
        updateConfidence: vi.fn().mockResolvedValue(undefined),
        supersede: vi.fn().mockResolvedValue('new-id'),
      },
    });

    const engine = new ConsolidationEngine(redis, neo4j, makeConfig(false));
    const result = await engine.run('fallback-scope');

    expect(getById).toHaveBeenCalledWith('sem-fallback');
    expect(result.proposals.some((p) => p.affected_ids.includes('sem-fallback'))).toBe(true);
  });

  it('keeps correction-derived supersedes review-gated when autoApply is true', async () => {
    const node = makeSemanticNode('sem-auto');

    const signals: StreamSignal[] = [
      makeStreamSignal('sem-auto', 'correction'),
      makeStreamSignal('sem-auto', 'correction'),
      makeStreamSignal('sem-auto', 'correction'),
    ];

    const redis = makeRedis({
      signals: {
        consume: vi.fn().mockResolvedValue(signals),
      },
    });
    const neo4j = makeNeo4j({
      semantic: {
        getById: vi.fn().mockResolvedValue(node),
        updateConfidence: vi.fn().mockResolvedValue(undefined),
        supersede: vi.fn().mockResolvedValue('new-sem-auto'),
      },
    });

    const engine = new ConsolidationEngine(redis, neo4j, makeConfig(true));
    const result = await engine.run('auto-scope');

    expect(result.skipped).toBe(false);
    expect(result.proposals.length).toBeGreaterThan(0);
    expect(result.applied).toHaveLength(0);
    expect(redis.proposals.save).toHaveBeenCalledOnce();
    expect(neo4j.semantic.supersede).not.toHaveBeenCalled();
  });

  it('auto-applies corroborated reinforcement when autoApply is true', async () => {
    const node = makeSemanticNode('sem-auto-reinforce');
    const signals = [
      makeStreamSignal(node.id),
      makeStreamSignal(node.id),
      makeStreamSignal(node.id),
    ];
    const redis = makeRedis({ signals: { consume: vi.fn().mockResolvedValue(signals) } });
    const neo4j = makeNeo4j({
      semantic: {
        getById: vi.fn().mockResolvedValue(node),
        updateConfidence: vi.fn().mockResolvedValue(undefined),
        supersede: vi.fn().mockResolvedValue('unused'),
      },
    });

    const result = await new ConsolidationEngine(redis, neo4j, makeConfig(true)).run('auto-scope');

    expect(result.proposals[0]?.type).toBe('reinforce');
    expect(result.applied).toEqual([result.proposals[0]?.id]);
    expect(neo4j.semantic.updateConfidence).toHaveBeenCalledOnce();
    expect(redis.proposals.save).not.toHaveBeenCalled();
  });

  it('uses a stable Neo4j application key when reinforcement is redelivered after ACK failure', async () => {
    const node = makeSemanticNode('sem-idempotent');
    const signals = [
      makeDeliveredSignal('stable-1', node.id),
      makeDeliveredSignal('stable-2', node.id),
      makeDeliveredSignal('stable-3', node.id),
    ];
    const ack = vi.fn()
      .mockRejectedValueOnce(new Error('redis unavailable after graph commit'))
      .mockResolvedValueOnce(3);
    const redis = makeRedis({ signals: { consume: vi.fn().mockResolvedValue(signals), ack } });
    const updateConfidence = vi.fn().mockResolvedValue(undefined);
    const neo4j = makeNeo4j({
      semantic: {
        getById: vi.fn().mockResolvedValue(node),
        updateConfidence,
        supersede: vi.fn().mockResolvedValue('unused'),
      },
    });
    const engine = new ConsolidationEngine(redis, neo4j, makeConfig(true));

    await expect(engine.run('idempotent-scope')).rejects.toThrow('redis unavailable');
    await expect(engine.run('idempotent-scope')).resolves.toMatchObject({ skipped: false });

    expect(updateConfidence).toHaveBeenCalledTimes(2);
    const firstKey = updateConfidence.mock.calls[0]?.[2];
    const secondKey = updateConfidence.mock.calls[1]?.[2];
    expect(firstKey).toMatch(/^signal-/);
    expect(secondKey).toBe(firstKey);
  });

  it('treats cache invalidation as best-effort after durable reinforcement', async () => {
    const node = makeSemanticNode('sem-cache-failure');
    const signals = [
      makeDeliveredSignal('cache-1', node.id),
      makeDeliveredSignal('cache-2', node.id),
      makeDeliveredSignal('cache-3', node.id),
    ];
    const ack = vi.fn().mockResolvedValue(3);
    const redis = makeRedis({
      signals: { consume: vi.fn().mockResolvedValue(signals), ack },
      cache: { invalidateByNodeId: vi.fn().mockRejectedValue(new Error('cache down')) },
    });
    const neo4j = makeNeo4j({
      semantic: {
        getById: vi.fn().mockResolvedValue(node),
        updateConfidence: vi.fn().mockResolvedValue(undefined),
        supersede: vi.fn().mockResolvedValue('unused'),
      },
    });

    const result = await new ConsolidationEngine(redis, neo4j, makeConfig(true)).run('cache-scope');

    expect(result.applied).toHaveLength(1);
    expect(ack).toHaveBeenCalledOnce();
  });

  it('accumulates 1+1+1 typed reinforcement deliveries across runs before ACK', async () => {
    const node = makeSemanticNode('sem-accumulate');
    let run = 0;
    const all = [
      makeDeliveredSignal('1-0', node.id),
      makeDeliveredSignal('2-0', node.id),
      makeDeliveredSignal('3-0', node.id),
    ];
    const ack = vi.fn().mockResolvedValue(3);
    const remove = vi.fn().mockResolvedValue(1);
    const redis = makeRedis({
      signals: {
        consume: vi.fn().mockImplementation(() => Promise.resolve(all.slice(0, ++run))),
        ack,
      },
      queue: { remove },
    });
    const neo4j = makeNeo4j({
      semantic: {
        getById: vi.fn().mockResolvedValue(node),
        updateConfidence: vi.fn().mockResolvedValue(undefined),
        supersede: vi.fn().mockResolvedValue('unused'),
      },
    });
    const engine = new ConsolidationEngine(redis, neo4j, makeConfig(false));

    expect((await engine.run('scope')).proposals).toHaveLength(0);
    expect((await engine.run('scope')).proposals).toHaveLength(0);
    expect(ack).not.toHaveBeenCalled();

    const third = await engine.run('scope');
    expect(third.proposals).toHaveLength(1);
    expect(third.proposals[0]?.type).toBe('reinforce');
    expect(ack).toHaveBeenCalledWith('consolidation', ['1-0', '2-0', '3-0']);
    expect(remove).toHaveBeenCalledWith(node.id);
  });

  it('redelivers after a crash/failure before proposal save instead of ACKing', async () => {
    const node = makeSemanticNode('sem-redeliver');
    const signals = [makeDeliveredSignal('crash-1', node.id, 'correction')];
    const save = vi.fn()
      .mockRejectedValueOnce(new Error('proposal store unavailable'))
      .mockResolvedValueOnce(undefined);
    const ack = vi.fn().mockResolvedValue(1);
    const redis = makeRedis({
      signals: { consume: vi.fn().mockResolvedValue(signals), ack },
      proposals: {
        save,
        get: vi.fn().mockResolvedValue(null),
        listPending: vi.fn().mockResolvedValue([]),
        remove: vi.fn().mockResolvedValue(undefined),
      },
    });
    const neo4j = makeNeo4j({
      semantic: {
        getById: vi.fn().mockResolvedValue(node),
        updateConfidence: vi.fn().mockResolvedValue(undefined),
        supersede: vi.fn().mockResolvedValue('unused'),
      },
    });
    const engine = new ConsolidationEngine(redis, neo4j, makeConfig(false));

    await expect(engine.run('scope')).rejects.toThrow('proposal store unavailable');
    expect(ack).not.toHaveBeenCalled();

    const retried = await engine.run('scope');
    expect(retried.proposals).toHaveLength(1);
    expect(ack).toHaveBeenCalledWith('consolidation', ['crash-1']);
  });

  it('leaves another project pending and ACKs only the current project signal', async () => {
    const nodeA = {
      ...makeSemanticNode('sem-project-a'),
      scope: 'project:a',
      tags: ['project:a'],
    };
    const nodeB = {
      ...makeSemanticNode('sem-project-b'),
      scope: 'project:b',
      tags: ['project:b'],
    };
    const signalA = {
      ...makeDeliveredSignal('a-1', nodeA.id, 'correction'),
      scope: 'project:a',
      tenant_id: 'default',
    };
    const signalB = {
      ...makeDeliveredSignal('b-1', nodeB.id, 'correction'),
      scope: 'project:b',
      tenant_id: 'default',
    };
    const ack = vi.fn().mockResolvedValue(1);
    const getByIds = vi.fn().mockResolvedValue([nodeA]);
    const redis = makeRedis({
      signals: { consume: vi.fn().mockResolvedValue([signalA, signalB]), ack },
    });
    const neo4j = makeNeo4j({
      semantic: {
        getById: vi.fn().mockResolvedValue(null),
        getByIds,
        updateConfidence: vi.fn().mockResolvedValue(undefined),
        supersede: vi.fn().mockResolvedValue('unused'),
      },
    });

    const result = await new ConsolidationEngine(redis, neo4j, makeConfig(false)).run('project:a');

    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]?.affected_ids).toEqual([nodeA.id]);
    expect(getByIds).toHaveBeenCalledWith([nodeA.id]);
    expect(ack).toHaveBeenCalledWith('consolidation', ['a-1']);
  });

  it('resolves legacy unscoped entries against target scope and leaves foreign targets pending', async () => {
    const nodeA = {
      ...makeSemanticNode('sem-legacy-a'),
      scope: 'project:a',
      tags: ['project:a'],
    };
    const nodeB = {
      ...makeSemanticNode('sem-legacy-b'),
      scope: 'project:b',
      tags: ['project:b'],
    };
    const signalA = makeDeliveredSignal('legacy-a', nodeA.id, 'correction');
    const signalB = makeDeliveredSignal('legacy-b', nodeB.id, 'correction');
    const ack = vi.fn().mockResolvedValue(1);
    const redis = makeRedis({
      signals: { consume: vi.fn().mockResolvedValue([signalA, signalB]), ack },
    });
    const neo4j = makeNeo4j({
      semantic: {
        getById: vi.fn().mockResolvedValue(null),
        getByIds: vi.fn().mockResolvedValue([nodeA, nodeB]),
        updateConfidence: vi.fn().mockResolvedValue(undefined),
        supersede: vi.fn().mockResolvedValue('unused'),
      },
    });

    const result = await new ConsolidationEngine(redis, neo4j, makeConfig(false)).run('project:a');

    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]?.affected_ids).toEqual([nodeA.id]);
    expect(ack).toHaveBeenCalledWith('consolidation', ['legacy-a']);
  });

  it('leaves a cross-tenant signal pending even when its project scope matches', async () => {
    const target = {
      ...makeSemanticNode('sem-tenant-b'),
      scope: 'project:a',
      tags: ['project:a'],
      tenant_id: 'tenant-b',
    };
    const signal = {
      ...makeDeliveredSignal('tenant-a-signal', target.id, 'correction'),
      scope: 'project:a',
      tenant_id: 'tenant-a',
    };
    const ack = vi.fn().mockResolvedValue(1);
    const redis = makeRedis({
      signals: { consume: vi.fn().mockResolvedValue([signal]), ack },
    });
    const neo4j = makeNeo4j({
      semantic: {
        getById: vi.fn().mockResolvedValue(target),
        updateConfidence: vi.fn().mockResolvedValue(undefined),
        supersede: vi.fn().mockResolvedValue('unused'),
      },
    });

    const result = await new ConsolidationEngine(redis, neo4j, makeConfig(false)).run('project:a');

    expect(result.proposals).toHaveLength(0);
    expect(ack).not.toHaveBeenCalled();
  });

  it('a global maintenance run preserves target project scope and rejects mismatched emitters', async () => {
    const target = {
      ...makeSemanticNode('sem-global-target'),
      scope: 'project:b',
      tags: ['project:b'],
    };
    const valid = {
      ...makeDeliveredSignal('global-valid', target.id, 'correction'),
      scope: 'project:b',
      tenant_id: 'default',
    };
    const foreign = {
      ...makeDeliveredSignal('global-foreign', target.id, 'correction'),
      scope: 'project:a',
      tenant_id: 'default',
    };
    const ack = vi.fn().mockResolvedValue(1);
    const redis = makeRedis({
      signals: { consume: vi.fn().mockResolvedValue([valid, foreign]), ack },
    });
    const neo4j = makeNeo4j({
      semantic: {
        getById: vi.fn().mockResolvedValue(target),
        updateConfidence: vi.fn().mockResolvedValue(undefined),
        supersede: vi.fn().mockResolvedValue('unused'),
      },
    });

    const result = await new ConsolidationEngine(redis, neo4j, makeConfig(false)).run('global');

    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]?.scope).toBe('project:b');
    expect(ack).toHaveBeenCalledWith('consolidation', ['global-valid']);
  });

  it('skips signals below the threshold', async () => {
    // 1 reinforcement signal → weight = 1.0 < threshold 3
    const signals: StreamSignal[] = [
      makeStreamSignal('sem-below', 'reinforcement'),
    ];

    const redis = makeRedis({
      signals: {
        consume: vi.fn().mockResolvedValue(signals),
      },
    });
    const neo4j = makeNeo4j();

    const engine = new ConsolidationEngine(redis, neo4j, makeConfig());
    const result = await engine.run('below-threshold-scope');

    expect(result.proposals).toHaveLength(0);
  });

  it('does not turn an untyped queue score into a decay proposal', async () => {
    const node = makeSemanticNode('sem-queued');

    let callCount = 0;
    const redis = makeRedis({
      queue: {
        popHighest: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return Promise.resolve({ member: 'sem-queued', score: 10 });
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
    const result = await engine.run('queue-scope');

    expect(result.proposals).toHaveLength(0);
    expect(redis.queue.popHighest).not.toHaveBeenCalled();
    expect(neo4j.semantic.getById).not.toHaveBeenCalled();
  });
});

describe('ConsolidationEngine.reviewProposal', () => {
  it('throws when proposal not found', async () => {
    const redis = makeRedis({
      proposals: {
        save: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listPending: vi.fn().mockResolvedValue([]),
        remove: vi.fn().mockResolvedValue(undefined),
      },
    });
    const neo4j = makeNeo4j();

    const engine = new ConsolidationEngine(redis, neo4j, makeConfig());

    await expect(engine.reviewProposal('nonexistent-id', 'approve')).rejects.toThrow(
      'Proposal nonexistent-id not found',
    );
  });

  it('removes the proposal on reject', async () => {
    const proposal: ConsolidationProposal = {
      id: 'prop-1',
      type: 'decay',
      scope: 'test',
      affected_ids: ['sem-1'],
      before: {},
      after: { confidence: 0.5 },
      score: 5,
      created_at: new Date().toISOString(),
    };

    const redis = makeRedis({
      proposals: {
        save: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(proposal),
        listPending: vi.fn().mockResolvedValue(['prop-1']),
        remove: vi.fn().mockResolvedValue(undefined),
      },
    });
    const neo4j = makeNeo4j();

    const engine = new ConsolidationEngine(redis, neo4j, makeConfig());
    await engine.reviewProposal('prop-1', 'reject');

    expect(redis.proposals.remove).toHaveBeenCalledWith('prop-1');
    // No Neo4j calls on reject
    expect(neo4j.semantic.updateConfidence).not.toHaveBeenCalled();
    expect(neo4j.semantic.supersede).not.toHaveBeenCalled();
  });

  it('applies a decay proposal on approve', async () => {
    const proposal: ConsolidationProposal = {
      id: 'prop-decay',
      type: 'decay',
      scope: 'test',
      affected_ids: ['sem-decay'],
      before: { confidence: 0.8 },
      after: { confidence: 0.76 },
      score: 5,
      created_at: new Date().toISOString(),
    };

    const redis = makeRedis({
      proposals: {
        save: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(proposal),
        listPending: vi.fn().mockResolvedValue(['prop-decay']),
        remove: vi.fn().mockResolvedValue(undefined),
      },
    });
    const neo4j = makeNeo4j();

    const engine = new ConsolidationEngine(redis, neo4j, makeConfig());
    await engine.reviewProposal('prop-decay', 'approve');

    expect(neo4j.semantic.updateConfidence).toHaveBeenCalledWith('sem-decay', 0.76, 'prop-decay');
    expect(redis.cache.invalidateByNodeId).toHaveBeenCalledWith('sem-decay');
    expect(redis.proposals.remove).toHaveBeenCalledWith('prop-decay');
  });

  it('applies a supersede proposal on approve', async () => {
    const node = makeSemanticNode('sem-old');
    const proposal: ConsolidationProposal = {
      id: 'prop-supersede',
      type: 'supersede',
      scope: 'test',
      affected_ids: ['sem-old'],
      before: { ...node } as Record<string, unknown>,
      after: { ...node, confidence: 0.9 } as Record<string, unknown>,
      score: 15,
      created_at: new Date().toISOString(),
    };

    const redis = makeRedis({
      proposals: {
        save: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(proposal),
        listPending: vi.fn().mockResolvedValue(['prop-supersede']),
        remove: vi.fn().mockResolvedValue(undefined),
      },
    });
    const neo4j = makeNeo4j({
      semantic: {
        getById: vi.fn().mockResolvedValue(node),
        updateConfidence: vi.fn().mockResolvedValue(undefined),
        supersede: vi.fn().mockResolvedValue('new-sem-id'),
      },
    });

    const engine = new ConsolidationEngine(redis, neo4j, makeConfig());
    await engine.reviewProposal('prop-supersede', 'approve');

    expect(neo4j.semantic.supersede).toHaveBeenCalledWith('sem-old', expect.objectContaining({
      confidence: 0.9,
    }));
    expect(redis.cache.invalidateByNodeId).toHaveBeenCalledWith('sem-old');
    expect(redis.proposals.remove).toHaveBeenCalledWith('prop-supersede');
  });
});

describe('ConsolidationEngine tenant propagation', () => {
  it('carries the tenant forward when superseding a node', async () => {
    const node = { ...makeSemanticNode('sem-tenant'), tenant_id: 'acme' };
    const proposal: ConsolidationProposal = {
      id: 'prop-supersede-tenant',
      type: 'supersede',
      scope: 'test',
      affected_ids: ['sem-tenant'],
      before: { ...node } as Record<string, unknown>,
      after: { ...node, confidence: 0.9 } as Record<string, unknown>,
      score: 15,
      created_at: new Date().toISOString(),
    };

    const supersede = vi.fn().mockResolvedValue('new-sem-id');
    const redis = makeRedis({
      proposals: {
        save: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(proposal),
        listPending: vi.fn().mockResolvedValue(['prop-supersede-tenant']),
        remove: vi.fn().mockResolvedValue(undefined),
      },
    });
    const neo4j = makeNeo4j({
      semantic: {
        getById: vi.fn().mockResolvedValue(node),
        updateConfidence: vi.fn().mockResolvedValue(undefined),
        supersede,
      },
    });

    const engine = new ConsolidationEngine(redis, neo4j, makeConfig());
    await engine.reviewProposal('prop-supersede-tenant', 'approve');

    expect(supersede).toHaveBeenCalledWith('sem-tenant', expect.objectContaining({
      tenant_id: 'acme',
    }));
  });

  it('derives a promoted semantic\'s tenant from the common tenant of source episodes', async () => {
    const proposal: ConsolidationProposal = {
      id: 'prop-promote',
      type: 'promote',
      scope: 'test',
      affected_ids: ['ep-1', 'ep-2'],
      before: {},
      after: { content: 'Distilled knowledge', confidence: 0.7 } as Record<string, unknown>,
      score: 10,
      created_at: new Date().toISOString(),
    };

    const promoteFromEpisodic = vi.fn().mockResolvedValue('new-promoted-id');
    const episodicGetById = vi.fn().mockResolvedValue({
      id: 'ep-x',
      session_id: 's',
      agent_id: 'a',
      task: 't',
      content: 'c',
      created_at: new Date().toISOString(),
      tenant_id: 'acme',
    });

    const redis = makeRedis({
      proposals: {
        save: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(proposal),
        listPending: vi.fn().mockResolvedValue(['prop-promote']),
        remove: vi.fn().mockResolvedValue(undefined),
      },
    });
    const neo4j = makeNeo4j({
      semantic: {
        getById: vi.fn().mockResolvedValue(null),
        updateConfidence: vi.fn().mockResolvedValue(undefined),
        supersede: vi.fn().mockResolvedValue('x'),
        promoteFromEpisodic,
      },
      episodic: { getById: episodicGetById },
    });

    const engine = new ConsolidationEngine(redis, neo4j, makeConfig());
    await engine.reviewProposal('prop-promote', 'approve');

    expect(promoteFromEpisodic).toHaveBeenCalledWith(
      ['ep-1', 'ep-2'],
      expect.objectContaining({ tenant_id: 'acme', content: 'Distilled knowledge' }),
      'acme',
      expect.stringMatching(/^promoted:/),
    );
  });

  it('rejects a promote when source episodes mix tenants', async () => {
    const proposal: ConsolidationProposal = {
      id: 'prop-promote-mixed',
      type: 'promote',
      scope: 'test',
      affected_ids: ['ep-1', 'ep-2'],
      before: {},
      after: { content: 'Mixed', confidence: 0.6 } as Record<string, unknown>,
      score: 10,
      created_at: new Date().toISOString(),
    };

    const promoteFromEpisodic = vi.fn().mockResolvedValue('new-id');
    let call = 0;
    const episodicGetById = vi.fn().mockImplementation(() => {
      call++;
      return Promise.resolve({
        id: `ep-${call}`,
        session_id: 's',
        agent_id: 'a',
        task: 't',
        content: 'c',
        created_at: new Date().toISOString(),
        tenant_id: call === 1 ? 'acme' : 'globex',
      });
    });

    const redis = makeRedis({
      proposals: {
        save: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(proposal),
        listPending: vi.fn().mockResolvedValue(['prop-promote-mixed']),
        remove: vi.fn().mockResolvedValue(undefined),
      },
    });
    const neo4j = makeNeo4j({
      semantic: {
        getById: vi.fn().mockResolvedValue(null),
        updateConfidence: vi.fn().mockResolvedValue(undefined),
        supersede: vi.fn().mockResolvedValue('x'),
        promoteFromEpisodic,
      },
      episodic: { getById: episodicGetById },
    });

    const engine = new ConsolidationEngine(redis, neo4j, makeConfig());
    await expect(engine.reviewProposal('prop-promote-mixed', 'approve')).rejects.toThrow(
      'Failed to apply proposal prop-promote-mixed',
    );
    expect(promoteFromEpisodic).not.toHaveBeenCalled();
  });

  it('OPT-45: derives tenant via the batched getTenantsByIds projection (not per-id getById)', async () => {
    const proposal: ConsolidationProposal = {
      id: 'prop-promote-batch',
      type: 'promote',
      scope: 'test',
      affected_ids: ['ep-1', 'ep-2'],
      before: {},
      after: { content: 'Batched', confidence: 0.7 } as Record<string, unknown>,
      score: 10,
      created_at: new Date().toISOString(),
    };

    const promoteFromEpisodic = vi.fn().mockResolvedValue('new-id');
    const getById = vi.fn();
    const getTenantsByIds = vi.fn().mockResolvedValue(['acme', 'acme']); // common tenant

    const redis = makeRedis({
      proposals: {
        save: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(proposal),
        listPending: vi.fn().mockResolvedValue(['prop-promote-batch']),
        remove: vi.fn().mockResolvedValue(undefined),
      },
    });
    const neo4j = makeNeo4j({
      semantic: {
        getById: vi.fn().mockResolvedValue(null),
        updateConfidence: vi.fn().mockResolvedValue(undefined),
        supersede: vi.fn().mockResolvedValue('x'),
        promoteFromEpisodic,
      },
      episodic: { getById, getTenantsByIds },
    });

    const engine = new ConsolidationEngine(redis, neo4j, makeConfig());
    await engine.reviewProposal('prop-promote-batch', 'approve');

    expect(getTenantsByIds).toHaveBeenCalledWith(['ep-1', 'ep-2']);
    expect(getById).not.toHaveBeenCalled(); // batched path preferred over per-id
    expect(promoteFromEpisodic).toHaveBeenCalledWith(
      ['ep-1', 'ep-2'],
      expect.objectContaining({ tenant_id: 'acme' }),
      'acme',
      expect.stringMatching(/^promoted:/),
    );
  });
});

describe('C5: tenant derivation fails closed on read errors', () => {
  function promoteProposal(after: Record<string, unknown>): ConsolidationProposal {
    return {
      id: 'prop-c5',
      type: 'promote',
      scope: 'test',
      affected_ids: ['ep-1', 'ep-2'],
      before: {},
      after,
      score: 10,
      created_at: new Date().toISOString(),
    };
  }

  function setup(after: Record<string, unknown>, episodic: Record<string, unknown>) {
    const promoteFromEpisodic = vi.fn().mockResolvedValue('new-id');
    const redis = makeRedis({
      proposals: {
        save: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(promoteProposal(after)),
        listPending: vi.fn().mockResolvedValue(['prop-c5']),
        remove: vi.fn().mockResolvedValue(undefined),
      },
    });
    const neo4j = makeNeo4j({
      semantic: {
        getById: vi.fn().mockResolvedValue(null),
        updateConfidence: vi.fn().mockResolvedValue(undefined),
        supersede: vi.fn().mockResolvedValue('x'),
        promoteFromEpisodic,
      },
      episodic,
    });
    return { engine: new ConsolidationEngine(redis, neo4j, makeConfig()), promoteFromEpisodic };
  }

  it('per-id getById rejection with no preferred tenant → batch fails, zero Semantics', async () => {
    const { engine, promoteFromEpisodic } = setup(
      { content: 'x', confidence: 0.7 },
      { getById: vi.fn().mockRejectedValue(new Error('neo4j transient')) },
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(engine.reviewProposal('prop-c5', 'approve')).rejects.toThrow('Failed to apply proposal prop-c5');
    expect(promoteFromEpisodic).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes('tenant_unresolved'))).toBe(true);
    errorSpy.mockRestore();
  });

  it('batched getTenantsByIds rejection with no preferred tenant → batch fails, zero Semantics', async () => {
    const { engine, promoteFromEpisodic } = setup(
      { content: 'x', confidence: 0.7 },
      { getById: vi.fn(), getTenantsByIds: vi.fn().mockRejectedValue(new Error('neo4j transient')) },
    );
    await expect(engine.reviewProposal('prop-c5', 'approve')).rejects.toThrow('Failed to apply proposal prop-c5');
    expect(promoteFromEpisodic).not.toHaveBeenCalled();
  });

  it('read rejection with a preferred tenant still fails closed (existing behaviour)', async () => {
    const { engine, promoteFromEpisodic } = setup(
      { content: 'x', confidence: 0.7, tenant_id: 'acme' },
      { getById: vi.fn(), getTenantsByIds: vi.fn().mockRejectedValue(new Error('neo4j transient')) },
    );
    await expect(engine.reviewProposal('prop-c5', 'approve')).rejects.toThrow('Failed to apply proposal prop-c5');
    expect(promoteFromEpisodic).not.toHaveBeenCalled();
  });

  it('happy path unchanged: a single resolved tenant promotes into that tenant', async () => {
    const { engine, promoteFromEpisodic } = setup(
      { content: 'x', confidence: 0.7 },
      { getById: vi.fn(), getTenantsByIds: vi.fn().mockResolvedValue(['acme', 'acme']) },
    );
    await engine.reviewProposal('prop-c5', 'approve');
    expect(promoteFromEpisodic).toHaveBeenCalledWith(['ep-1', 'ep-2'], expect.objectContaining({ tenant_id: 'acme' }), 'acme', expect.stringMatching(/^promoted:/));
  });

  // Item 12b (D10): the promote path passes a content-keyed dedupeKey so the
  // semantic_dedupe_unique constraint covers promoted Semantics. Whitespace and
  // case are normalized so a re-synthesized claim maps to the same key.
  it('passes a promoted: dedupeKey that is stable across whitespace/case variants of the content', async () => {
    const tenants = { getById: vi.fn(), getTenantsByIds: vi.fn().mockResolvedValue(['acme', 'acme']) };
    const a = setup({ content: 'The  Engine owns\nValidation. ', confidence: 0.7 }, tenants);
    const b = setup({ content: 'the engine owns validation.', confidence: 0.7 }, tenants);
    await a.engine.reviewProposal('prop-c5', 'approve');
    await b.engine.reviewProposal('prop-c5', 'approve');
    const keyA = a.promoteFromEpisodic.mock.calls[0]![3] as string;
    const keyB = b.promoteFromEpisodic.mock.calls[0]![3] as string;
    expect(keyA).toMatch(/^promoted:[0-9a-f]{40}$/);
    expect(keyB).toBe(keyA);

    const c = setup({ content: 'a different claim', confidence: 0.7 }, tenants);
    await c.engine.reviewProposal('prop-c5', 'approve');
    expect(c.promoteFromEpisodic.mock.calls[0]![3]).not.toBe(keyA);
  });
});

describe('ConsolidationEngine.status', () => {
  it('returns list of pending proposal IDs', async () => {
    const redis = makeRedis({
      proposals: {
        save: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listPending: vi.fn().mockResolvedValue(['prop-a', 'prop-b', 'prop-c']),
        remove: vi.fn().mockResolvedValue(undefined),
      },
    });
    const neo4j = makeNeo4j();

    const engine = new ConsolidationEngine(redis, neo4j, makeConfig());
    const status = await engine.status();

    expect(status.pending).toEqual(['prop-a', 'prop-b', 'prop-c']);
  });

  it('returns empty list when no pending proposals', async () => {
    const redis = makeRedis();
    const neo4j = makeNeo4j();

    const engine = new ConsolidationEngine(redis, neo4j, makeConfig());
    const status = await engine.status();

    expect(status.pending).toHaveLength(0);
  });
});

// ─── RET-005B-AUTH-001B6P: the two allowlist parsers ─────────────────────────
//
// The parsers are unexported and _applyProposal discards every lifecycle value
// before anything downstream sees it (its newNode literals enumerate ten fields
// and neither lifecycle field is among them), so the PASS-THROUGH is not
// behaviourally observable through any lawful route and is pinned structurally
// below instead of by a test that could never fail. What IS observable, and is
// the load-bearing content, is the drop-vs-throw ASYMMETRY: parseSemanticNode
// builds by conditional spread and structurally cannot tell absent from
// present-but-wrong, so it DROPS; parsePartialSemanticNode gates on `in`, can
// tell them apart, and therefore THROWS. Both follow their own pre-existing
// convention for all ten of their existing optional fields.

function makeLifecycleSupersedeHarness(after: Record<string, unknown>, before?: Record<string, unknown>) {
  const node = makeSemanticNode('sem-lifecycle-old');
  const proposal: ConsolidationProposal = {
    id: 'prop-lifecycle',
    type: 'supersede',
    scope: 'test',
    affected_ids: ['sem-lifecycle-old'],
    before: before ?? ({ ...node } as Record<string, unknown>),
    after,
    score: 15,
    created_at: new Date().toISOString(),
  };
  const redis = makeRedis({
    proposals: {
      save: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(proposal),
      listPending: vi.fn().mockResolvedValue(['prop-lifecycle']),
      remove: vi.fn().mockResolvedValue(undefined),
    },
  });
  const neo4j = makeNeo4j({
    semantic: {
      getById: vi.fn().mockResolvedValue(node),
      updateConfidence: vi.fn().mockResolvedValue(undefined),
      supersede: vi.fn().mockResolvedValue('new-sem-id'),
    },
  });
  return { node, redis, neo4j, engine: new ConsolidationEngine(redis, neo4j, makeConfig()) };
}

describe('consolidation lifecycle parsers (RET-005B-AUTH-001B6P)', () => {
  for (const field of ['valid_at', 'invalid_at'] as const) {
    it(`T15b: parsePartialSemanticNode THROWS on a wrong-typed ${field}`, async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const node = makeSemanticNode('sem-lifecycle-old');
      const { neo4j, engine } = makeLifecycleSupersedeHarness({
        ...node,
        confidence: 0.9,
        [field]: 42,
      } as Record<string, unknown>);

      await expect(engine.reviewProposal('prop-lifecycle', 'approve')).rejects.toThrow(
        /Failed to apply proposal/,
      );

      // The rejection alone is NOT the check — any failure inside
      // _applyProposal produces it. The logged message is what identifies the
      // parser throw as the cause.
      const parserErrors = consoleSpy.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes(`invalid "${field}"`),
      );
      expect(parserErrors.length).toBeGreaterThan(0);
      expect(neo4j.semantic.supersede).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it(`T15a: parseSemanticNode DROPS a wrong-typed ${field} without throwing`, async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const node = makeSemanticNode('sem-lifecycle-old');
      // Pollute only `before`: parseSemanticNode runs first, so this isolates
      // the dropping parser from the throwing one.
      const { neo4j, engine } = makeLifecycleSupersedeHarness(
        { ...node, confidence: 0.9 } as Record<string, unknown>,
        { ...node, [field]: 42 } as Record<string, unknown>,
      );

      await expect(engine.reviewProposal('prop-lifecycle', 'approve')).resolves.toBeUndefined();

      expect(neo4j.semantic.supersede).toHaveBeenCalledTimes(1);
      const parserErrors = consoleSpy.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes(`invalid "${field}"`),
      );
      expect(parserErrors).toHaveLength(0);

      consoleSpy.mockRestore();
    });
  }

  // STRUCTURAL, not behavioural: these prove the lines exist and are shaped in
  // each parser's own convention. They cannot prove a value survives, because
  // no value can survive _applyProposal today.
  it('pins each parser to its own convention in the source', () => {
    const source = readFileSync(new URL('../consolidation.ts', import.meta.url), 'utf8');
    const fullStart = source.indexOf('function parseSemanticNode(');
    const partialStart = source.indexOf('function parsePartialSemanticNode(');
    const partialEnd = source.indexOf('// ─── Dependency interfaces', partialStart);
    expect(fullStart).toBeGreaterThan(-1);
    expect(partialStart).toBeGreaterThan(fullStart);
    expect(partialEnd).toBeGreaterThan(partialStart);

    const full = source.slice(fullStart, partialStart);
    const partial = source.slice(partialStart, partialEnd);

    for (const field of ['valid_at', 'invalid_at']) {
      // parseSemanticNode: conditional spread, and NO throw for these fields.
      expect(full).toContain(`typeof raw.${field} === 'string'`);
      expect(full).toContain(`${field}: raw.${field}`);
      expect(full).not.toContain(`invalid "${field}"`);

      // parsePartialSemanticNode: `in` gate + throw, and NO conditional spread.
      expect(partial).toContain(`'${field}' in raw`);
      expect(partial).toContain(`invalid "${field}"`);
      expect(partial).toContain(`result.${field} = raw.${field}`);
      expect(partial).not.toContain(`...(typeof raw.${field}`);
    }
  });
});
