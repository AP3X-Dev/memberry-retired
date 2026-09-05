// packages/core/src/__tests__/consolidation.promote.test.ts
//
// Covers the episodic->semantic promote path, which was unreachable: the engine
// only ever generated proposals from Redis signal clusters, so a graph could
// accumulate any number of episodes and never grow a single Semantic node.
import { describe, it, expect, vi } from 'vitest';
import { ConsolidationEngine, clusterByEmbedding } from '../consolidation.js';
import type { AMPConfig, EpisodicNode } from '../types.js';

// ─── fixtures ────────────────────────────────────────────────────────────────

/** Unit vector in the plane, `deg` degrees off the x-axis — cosine(a,b) is the
 *  cosine of the angle between them, so similarity is exactly controllable. */
function vecAt(deg: number): number[] {
  const rad = (deg * Math.PI) / 180;
  return [Math.cos(rad), Math.sin(rad)];
}

function ep(id: string, embedding: number[], overrides: Partial<EpisodicNode> = {}): EpisodicNode {
  return {
    id,
    session_id: 'sess-1',
    agent_id: 'agent-1',
    task: `task ${id}`,
    content: `content ${id}`,
    created_at: '2026-08-12T00:00:00.000Z',
    embedding,
    scope: 'project:test',
    tags: ['project:test'],
    ...overrides,
  };
}

const CONFIG: AMPConfig = {
  redis: { url: 'redis://localhost:6379' },
  neo4j: { uri: 'bolt://localhost:7687', user: 'neo4j', password: '' },
  embedding: { provider: 'openai', apiKey: 'test-key' },
  cache: { defaultTTL: 300, contextTTL: 300, embeddingTTL: 86400 },
  consolidation: {
    autoApply: false,
    signalThreshold: 3,
    promote: { minClusterSize: 3, similarityThreshold: 0.9, maxPerRun: 3, maxCandidates: 200 },
  },
  exportPath: '/tmp',
};

/** Redis layer with no signals and no queue entries — isolates the promote path. */
function emptyRedis() {
  return {
    lock: { acquire: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(undefined) },
    signals: { consume: vi.fn().mockResolvedValue([]) },
    queue: { popHighest: vi.fn().mockResolvedValue(null) },
    proposals: {
      save: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(null),
      listPending: vi.fn().mockResolvedValue([]),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    cache: { invalidateByNodeId: vi.fn().mockResolvedValue(0) },
  };
}

function llmReturning(payload: unknown) {
  return {
    available: true as const,
    modelFor: () => 'gpt-4o',
    chat: vi.fn().mockResolvedValue(JSON.stringify(payload)),
  };
}

// ─── clusterByEmbedding ──────────────────────────────────────────────────────

describe('clusterByEmbedding', () => {
  it('groups similar episodes and drops clusters below minSize', () => {
    const episodes = [
      ep('a', vecAt(0)),
      ep('b', vecAt(5)),
      ep('c', vecAt(10)),
      ep('lonely', vecAt(90)), // orthogonal — its own cluster of 1
    ];

    const clusters = clusterByEmbedding(episodes, 0.9, 3);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.map((e) => e.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('ignores episodes with no embedding rather than clustering them together', () => {
    const episodes = [
      ep('a', vecAt(0)),
      ep('b', vecAt(2)),
      ep('no-vec-1', []),
      ep('no-vec-2', []),
      ep('no-vec-3', []),
    ];

    expect(clusterByEmbedding(episodes, 0.9, 3)).toHaveLength(0);
  });

  it('returns nothing when every episode is dissimilar', () => {
    const episodes = [ep('a', vecAt(0)), ep('b', vecAt(60)), ep('c', vecAt(120))];
    expect(clusterByEmbedding(episodes, 0.9, 2)).toHaveLength(0);
  });
});

// ─── promote proposals ───────────────────────────────────────────────────────

describe('ConsolidationEngine promote path', () => {
  const promotable = [
    ep('e1', vecAt(0), { session_id: 'sess-1' }),
    ep('e2', vecAt(3), { session_id: 'sess-2' }),
    ep('e3', vecAt(6), { session_id: 'sess-3' }),
  ];

  function neo4jWith(findPromotable: unknown) {
    return {
      semantic: {
        getById: vi.fn().mockResolvedValue(null),
        getByIds: vi.fn().mockResolvedValue([]),
        updateConfidence: vi.fn(),
        supersede: vi.fn(),
        promoteFromEpisodic: vi.fn().mockResolvedValue('sem-new'),
      },
      episodic: { getById: vi.fn().mockResolvedValue(null), findPromotable },
    };
  }

  it('proposes a promote from a qualifying cluster of episodes', async () => {
    const neo4j = neo4jWith(vi.fn().mockResolvedValue(promotable));
    const llm = llmReturning({ content: 'The engine owns validation.', confidence: 0.8, decay_class: 'stable' });
    const engine = new ConsolidationEngine(emptyRedis() as never, neo4j as never, CONFIG, llm as never);

    const result = await engine.run('project:test');

    expect(result.proposals).toHaveLength(1);
    const p = result.proposals[0]!;
    expect(p.type).toBe('promote');
    // affected_ids must be every SOURCE EPISODE id — promotion preserves a
    // PROMOTED_FROM edge for the complete cluster and derives one tenant.
    expect(p.affected_ids.sort()).toEqual(['e1', 'e2', 'e3']);
    expect(p.after.content).toBe('The engine owns validation.');
    expect(p.after.confidence).toBe(0.8);
    expect(p.after.tags).toEqual(['project:test']);
  });

  it('clamps an out-of-range model confidence into [0,1]', async () => {
    const neo4j = neo4jWith(vi.fn().mockResolvedValue(promotable));
    const llm = llmReturning({ content: 'A claim.', confidence: 4.2, decay_class: 'stable' });
    const engine = new ConsolidationEngine(emptyRedis() as never, neo4j as never, CONFIG, llm as never);

    const result = await engine.run('project:test');

    expect(result.proposals[0]!.after.confidence).toBe(1);
  });

  it('proposes nothing when the model declines with empty content', async () => {
    const neo4j = neo4jWith(vi.fn().mockResolvedValue(promotable));
    const llm = llmReturning({ content: '   ', confidence: 0.9, decay_class: 'stable' });
    const engine = new ConsolidationEngine(emptyRedis() as never, neo4j as never, CONFIG, llm as never);

    expect((await engine.run('project:test')).proposals).toHaveLength(0);
  });

  it('drops a cluster whose episodes span more than one project scope', async () => {
    const mixed = [
      ep('m1', vecAt(0), { scope: 'project:a', tags: ['project:a'] }),
      ep('m2', vecAt(2), { scope: 'project:b', tags: ['project:b'] }),
      ep('m3', vecAt(4), { scope: 'project:a', tags: ['project:a'] }),
    ];
    const neo4j = neo4jWith(vi.fn().mockResolvedValue(mixed));
    const llm = llmReturning({ content: 'Should never be proposed.', confidence: 0.9, decay_class: 'stable' });
    const engine = new ConsolidationEngine(emptyRedis() as never, neo4j as never, CONFIG, llm as never);

    expect((await engine.run('global')).proposals).toHaveLength(0);
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it('does not auto-generalize repeated evidence from one agent session', async () => {
    const sameSession = [
      ep('same-1', vecAt(0)),
      ep('same-2', vecAt(3)),
      ep('same-3', vecAt(6)),
    ];
    const neo4j = neo4jWith(vi.fn().mockResolvedValue(sameSession));
    const llm = llmReturning({ content: 'Uncorroborated.', confidence: 0.95, decay_class: 'stable' });
    const engine = new ConsolidationEngine(emptyRedis() as never, neo4j as never, CONFIG, llm as never);

    const result = await engine.run('project:test');

    expect(result.proposals).toEqual([]);
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it('requires independent sessions or agents before proposing promotion', async () => {
    const repeatedObservation = [ep('r1', vecAt(0)), ep('r2', vecAt(2)), ep('r3', vecAt(4))];
    const neo4j = neo4jWith(vi.fn().mockResolvedValue(repeatedObservation));
    const llm = llmReturning({ content: 'Should not promote.', confidence: 0.9, decay_class: 'stable' });

    const result = await new ConsolidationEngine(
      emptyRedis() as never,
      neo4j as never,
      CONFIG,
      llm as never,
    ).run('project:test');

    expect(result.proposals).toHaveLength(0);
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it('gates a low-confidence promote instead of auto-applying it', async () => {
    const redis = emptyRedis();
    const neo4j = neo4jWith(vi.fn().mockResolvedValue(promotable));
    const llm = llmReturning({ content: 'Uncertain claim.', confidence: 0.69, decay_class: 'stable' });
    const config = { ...CONFIG, consolidation: { ...CONFIG.consolidation, autoApply: true } };

    const result = await new ConsolidationEngine(
      redis as never,
      neo4j as never,
      config,
      llm as never,
    ).run('project:test');

    expect(result.applied).toHaveLength(0);
    expect(redis.proposals.save).toHaveBeenCalledOnce();
    expect(neo4j.semantic.promoteFromEpisodic).not.toHaveBeenCalled();
  });

  it('C5: a failed tenant read skips the batch as tenant_unresolved instead of promoting into the default tenant', async () => {
    const redis = emptyRedis();
    const neo4j = neo4jWith(vi.fn().mockResolvedValue(promotable));
    neo4j.episodic = {
      ...neo4j.episodic,
      getTenantsByIds: vi.fn().mockRejectedValue(new Error('neo4j transient')),
    } as never;
    const llm = llmReturning({ content: 'Solid claim.', confidence: 0.9, decay_class: 'stable' });
    const config = { ...CONFIG, consolidation: { ...CONFIG.consolidation, autoApply: true } };

    const result = await new ConsolidationEngine(
      redis as never,
      neo4j as never,
      config,
      llm as never,
    ).run('project:test');

    expect(result.skipped).toBe(false);
    expect(result.proposals).toHaveLength(1);
    expect(result.applied).toHaveLength(0);
    expect(result.skipped_tenant_unresolved).toBe(1);
    expect(neo4j.semantic.promoteFromEpisodic).not.toHaveBeenCalled();
  });

  it('still scans without an LLM but leaves ordinary recurrence candidates inert', async () => {
    const findPromotable = vi.fn().mockResolvedValue(promotable);
    const engine = new ConsolidationEngine(emptyRedis() as never, neo4jWith(findPromotable) as never, CONFIG);

    expect((await engine.run('project:test')).proposals).toHaveLength(0);
    expect(findPromotable).toHaveBeenCalledOnce();
  });

  it('automatically applies one explicit approved decision without an LLM or broad autoApply', async () => {
    const decision = ep('decision-1', [], {
      content: 'Use owner-token locks for wiki publication.',
      outcome: 'approved',
      memory_type: 'decision',
      tags: ['project:test', 'wiki-publication'],
    });
    const neo4j = neo4jWith(vi.fn().mockResolvedValue([decision]));
    const engine = new ConsolidationEngine(emptyRedis() as never, neo4j as never, CONFIG);

    const result = await engine.run('project:test');

    expect(result.applied).toHaveLength(1);
    expect(result.proposals[0]?.after).toMatchObject({
      content: decision.content,
      confidence: 0.9,
      memory_type: 'decision',
      tags: ['project:test', 'wiki-publication'],
    });
    expect(neo4j.semantic.promoteFromEpisodic).toHaveBeenCalledWith(
      ['decision-1'],
      expect.objectContaining({ memory_type: 'decision', confidence: 0.9 }),
      'default',
      expect.stringMatching(/^promoted:/),
    );
  });

  it.each(['revised', 'rejected', 'abandoned', undefined] as const)(
    'does not direct-promote a %s decision',
    async (outcome) => {
      const candidate = ep(`decision-${outcome ?? 'implicit'}`, vecAt(0), {
        outcome,
        memory_type: 'decision',
      });
      const neo4j = neo4jWith(vi.fn().mockResolvedValue([candidate]));
      const result = await new ConsolidationEngine(emptyRedis() as never, neo4j as never, CONFIG).run('project:test');

      expect(result.proposals).toEqual([]);
      expect(neo4j.semantic.promoteFromEpisodic).not.toHaveBeenCalled();
    },
  );

  it('recurring patterns retain classification and only recurring non-project tags', async () => {
    const patterns = [
      ep('p1', vecAt(0), { session_id: 's1', memory_type: 'pattern', tags: ['project:test', 'validation', 'one-off'] }),
      ep('p2', vecAt(2), { session_id: 's2', memory_type: 'pattern', tags: ['project:test', 'validation'] }),
      ep('p3', vecAt(4), { session_id: 's3', memory_type: 'pattern', tags: ['project:test', 'validation'] }),
    ];
    const neo4j = neo4jWith(vi.fn().mockResolvedValue(patterns));
    const llm = llmReturning({ content: 'Validate external inputs.', confidence: 0.85, decay_class: 'stable' });

    const result = await new ConsolidationEngine(emptyRedis() as never, neo4j as never, CONFIG, llm as never).run('project:test');

    expect(result.proposals[0]?.after).toMatchObject({
      memory_type: 'pattern',
      tags: ['project:test', 'validation'],
    });
  });

  it('is inert on a layer without findPromotable (backward compatibility)', async () => {
    const neo4j = neo4jWith(undefined);
    const llm = llmReturning({ content: 'x', confidence: 0.5, decay_class: 'stable' });
    const engine = new ConsolidationEngine(emptyRedis() as never, neo4j as never, CONFIG, llm as never);

    expect((await engine.run('project:test')).proposals).toHaveLength(0);
  });

  it('survives a findPromotable failure without losing the run', async () => {
    const neo4j = neo4jWith(vi.fn().mockRejectedValue(new Error('neo4j down')));
    const llm = llmReturning({ content: 'x', confidence: 0.5, decay_class: 'stable' });
    const engine = new ConsolidationEngine(emptyRedis() as never, neo4j as never, CONFIG, llm as never);

    const result = await engine.run('project:test');
    expect(result.skipped).toBe(false);
    expect(result.proposals).toHaveLength(0);
  });

  it('does not filter by scope on an unscoped ("global") run', async () => {
    const findPromotable = vi.fn().mockResolvedValue(promotable);
    const llm = llmReturning({ content: 'A claim.', confidence: 0.7, decay_class: 'stable' });
    const engine = new ConsolidationEngine(
      emptyRedis() as never,
      neo4jWith(findPromotable) as never,
      CONFIG,
      llm as never,
      'tenant-a',
    );

    await engine.run('global');

    expect(findPromotable).toHaveBeenCalledWith(undefined, 200, 'tenant-a');
  });
});
