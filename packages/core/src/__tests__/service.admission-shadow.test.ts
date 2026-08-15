import { describe, expect, it, vi } from 'vitest';

import {
  AdmissionShadowRuntime,
  type AdmissionShadowAttempt,
  type AdmissionShadowHook,
} from '../admission-shadow.js';
import { AMPService, type Neo4jLayer, type RedisLayer } from '../service.js';
import type { AMPConfig, EpisodicNode } from '../types.js';

function config(overrides: Partial<AMPConfig> = {}): AMPConfig {
  return {
    redis: { url: 'redis://test' },
    neo4j: { uri: 'bolt://test', user: 'neo4j', password: '' },
    embedding: { provider: 'openai', apiKey: 'test-key' },
    cache: { defaultTTL: 300, contextTTL: 300, embeddingTTL: 86400 },
    consolidation: { autoApply: false, signalThreshold: 3 },
    exportPath: '/tmp/memberry',
    ...overrides,
  };
}

function redis(events: string[], duplicate = false): RedisLayer {
  return {
    cache: {
      get: vi.fn(),
      set: vi.fn(),
      invalidateByScope: vi.fn(async () => { events.push('cache'); return 0; }),
      invalidateByNodeId: vi.fn(async () => { events.push('signal-cache'); return 0; }),
    },
    embeddings: { get: vi.fn(), set: vi.fn() },
    dedup: {
      isDuplicate: vi.fn(),
      markSeen: vi.fn(),
      checkAndMark: vi.fn(async () => { events.push('dedup'); return duplicate; }),
      unmark: vi.fn(async () => { events.push('unmark'); }),
    },
    signals: { publish: vi.fn(async () => { events.push('signal-publish'); return '1-0'; }) },
    queue: { incrementScore: vi.fn(async () => { events.push('signal-score'); return 1; }) },
    extraction: { enqueue: vi.fn(async () => { events.push('extraction'); return '1-0'; }) },
  };
}

function neo4j(events: string[], failure?: 'create' | 'signal'): Neo4jLayer & { captured?: EpisodicNode } {
  const layer: Neo4jLayer & { captured?: EpisodicNode } = {
    episodic: {
      create: vi.fn(),
      createWithLinks: vi.fn(async (node) => {
        events.push('episode');
        layer.captured = node;
        if (failure === 'create') throw new Error('baseline-create-failure');
        return node.id;
      }),
      linkToAgent: vi.fn(),
      linkToEntity: vi.fn(),
      linkToModel: vi.fn(),
      linkSignal: vi.fn(async () => {
        events.push('signal-link');
        if (failure === 'signal') throw new Error('baseline-signal-failure');
      }),
    },
    query: { byScope: vi.fn(), byVector: vi.fn() },
    semantic: { existingIds: vi.fn(async (ids) => ids) },
    fact: {
      getActive: vi.fn(),
      create: vi.fn(),
      findBySubjectPredicate: vi.fn(),
      invalidate: vi.fn(),
    },
  };
  return layer;
}

type TestHook = AdmissionShadowHook & { readonly attempt: AdmissionShadowAttempt };

function hook(events: string[], overrides: Partial<AdmissionShadowAttempt> = {}): TestHook {
  const attempt: AdmissionShadowAttempt = {
    prepare: vi.fn(() => { events.push('prepare'); return {} as never; }),
    append: vi.fn(async (): Promise<'stored'> => { events.push('append'); return 'stored'; }),
    cancel: vi.fn(() => { events.push('cancel'); }),
    ...overrides,
  };
  return {
    enabled: true,
    begin: vi.fn(() => { events.push('begin'); return attempt; }),
    attempt,
  };
}

const input = {
  session_id: 'session-test',
  agent_id: 'agent-test',
  task: 'store a decision',
  content: 'the durable decision',
  tenantId: 'tenant-test',
  tags: ['project:test'],
  memory_type: 'decision' as const,
  outcome: 'approved' as const,
};

describe('AMPService admission shadow terminal seam', () => {
  it.each([false, true])(
    'performs exactly the baseline caller-object reads and preserves persisted values (redaction=%s)',
    async (redactOnIngest) => {
      const makeStatefulInput = () => {
        const reads: string[] = [];
        let taskRead = 0;
        let contentRead = 0;
        const target = { ...input };
        const value = new Proxy(target, {
          get(object, key, receiver) {
            reads.push(String(key));
            if (key === 'task') return `task-${++taskRead}`;
            if (key === 'content') return `content-${++contentRead} sk-abcdefghijk123456`;
            return Reflect.get(object, key, receiver);
          },
        });
        return { value, reads };
      };
      const run = async (withShadow: boolean) => {
        const events: string[] = [];
        const stateful = makeStatefulInput();
        const neo4jLayer = neo4j(events);
        const prepare = vi.fn(() => ({} as never));
        const shadow = withShadow ? hook(events, { prepare }) : undefined;
        const embedding = { embed: vi.fn(async () => [0.1]), embedBatch: vi.fn() };
        await new AMPService(
          redis(events), neo4jLayer, embedding,
          config({ redactOnIngest }), undefined, undefined, shadow,
        ).store(stateful.value);
        return { stateful, neo4jLayer, embedding, prepare };
      };

      const baseline = await run(false);
      const observed = await run(true);
      expect(observed.stateful.reads).toEqual(baseline.stateful.reads);
      expect(observed.neo4jLayer.captured).toMatchObject({
        task: baseline.neo4jLayer.captured?.task,
        content: baseline.neo4jLayer.captured?.content,
        scope: baseline.neo4jLayer.captured?.scope,
        tags: baseline.neo4jLayer.captured?.tags,
        memory_type: baseline.neo4jLayer.captured?.memory_type,
        outcome: baseline.neo4jLayer.captured?.outcome,
      });
      expect(observed.embedding.embed).toHaveBeenCalledWith(baseline.embedding.embed.mock.calls[0]![0]);
      expect(observed.prepare).toHaveBeenCalledOnce();
      const prepared = observed.prepare.mock.calls[0]![0];
      if (redactOnIngest) {
        expect(prepared).toMatchObject({
          task: 'task-3',
          content: 'content-2 sk-abcdefghijk123456',
          redactionConfigured: true,
        });
      } else {
        expect(prepared).toMatchObject({
          task: observed.neo4jLayer.captured?.task,
          content: observed.neo4jLayer.captured?.content,
          redactionConfigured: false,
        });
      }
    },
  );

  it('prepares after accepted dedup, appends absolutely last, and preserves the result', async () => {
    const events: string[] = [];
    const redisLayer = redis(events);
    const neo4jLayer = neo4j(events);
    const shadow = hook(events);
    const embedding = {
      embed: vi.fn(async () => { events.push('embedding'); return [0.1]; }),
      embedBatch: vi.fn(),
    };
    const audit = { append: vi.fn(async () => { events.push('audit'); }) };
    const service = new AMPService(redisLayer, neo4jLayer, embedding, config(), undefined, audit, shadow);

    const result = await service.store({
      ...input,
      signals: [{ type: 'reinforcement', target_id: 'semantic-1', detail: 'confirmed' }],
    });

    expect(result).toEqual({ id: expect.any(String), duplicate: false });
    expect(events).toEqual([
      'dedup', 'begin', 'embedding', 'episode', 'cache',
      'signal-link', 'signal-publish', 'signal-cache', 'signal-score',
      'extraction', 'audit', 'prepare', 'append',
    ]);
    expect(redisLayer.dedup.unmark).not.toHaveBeenCalled();
  });

  it('does nothing for duplicates and failed baseline stores', async () => {
    const duplicateEvents: string[] = [];
    const duplicateShadow = hook(duplicateEvents);
    const duplicateService = new AMPService(
      redis(duplicateEvents, true), neo4j(duplicateEvents),
      { embed: vi.fn(), embedBatch: vi.fn() }, config(), undefined, undefined, duplicateShadow,
    );
    await expect(duplicateService.store(input)).resolves.toEqual({ id: '', duplicate: true });
    expect(duplicateShadow.begin).not.toHaveBeenCalled();
    expect(duplicateShadow.attempt.prepare).not.toHaveBeenCalled();
    expect(duplicateShadow.attempt.append).not.toHaveBeenCalled();

    for (const failure of ['create', 'signal'] as const) {
      const events: string[] = [];
      const redisLayer = redis(events);
      const shadow = hook(events);
      const service = new AMPService(
        redisLayer, neo4j(events, failure),
        { embed: vi.fn(async () => [0.1]), embedBatch: vi.fn() },
        config(), undefined, undefined, shadow,
      );
      const failingInput = failure === 'signal'
        ? { ...input, signals: [{ type: 'reinforcement' as const, target_id: 'semantic-1', detail: 'x' }] }
        : input;
      await expect(service.store(failingInput)).rejects.toThrow(`baseline-${failure}-failure`);
      expect(shadow.attempt.append).not.toHaveBeenCalled();
      expect(shadow.attempt.cancel).toHaveBeenCalledOnce();
      expect(redisLayer.dedup.unmark).toHaveBeenCalledOnce();
    }
  });

  it('contains hostile preparation and terminal append without unmarking or changing success', async () => {
    for (const stage of ['begin', 'prepare', 'append'] as const) {
      const events: string[] = [];
      const redisLayer = redis(events);
      const healthyHook = hook(events, stage === 'prepare'
        ? { prepare: vi.fn(() => { throw new Error('shadow-secret-canary'); }) }
        : { append: vi.fn(async () => { throw new Error('shadow-secret-canary'); }) });
      const shadow: AdmissionShadowHook = stage === 'begin'
        ? { enabled: true, begin: vi.fn(() => { throw new Error('shadow-secret-canary'); }) }
        : healthyHook;
      const service = new AMPService(
        redisLayer, neo4j(events),
        { embed: vi.fn(async () => [0.1]), embedBatch: vi.fn() },
        config(), undefined, undefined, shadow,
      );

      await expect(service.store(input)).resolves.toEqual({ id: expect.any(String), duplicate: false });
      expect(redisLayer.dedup.unmark).not.toHaveBeenCalled();
    }
  });

  it('uses original content only for sensitivity and locates the actual persisted episode', async () => {
    const events: string[] = [];
    const secret = ['sk', 'abcdEFGH1234567890'].join('-');
    const sink = { persist: vi.fn(async (_scope, observation) => observation) };
    const shadow = new AdmissionShadowRuntime({
      enabled: true,
      timeoutMs: 50,
      sink,
      clock: { now: () => new Date('2026-08-14T18:00:00.000Z') },
    });
    const neo4jLayer = neo4j(events);
    const service = new AMPService(
      redis(events), neo4jLayer,
      { embed: vi.fn(async () => [0.1]), embedBatch: vi.fn() },
      config({ redactOnIngest: true }), undefined, undefined, shadow,
    );

    const result = await service.store({ ...input, content: `token ${secret}` });
    expect(neo4jLayer.captured?.content).not.toContain(secret);
    expect(sink.persist).toHaveBeenCalledOnce();
    const [storedScope, observation] = sink.persist.mock.calls[0]!;
    expect(storedScope).toEqual({
      tenantId: neo4jLayer.captured?.tenant_id,
      projectScope: neo4jLayer.captured?.scope,
      episodeId: result.id,
    });
    expect(observation.safeFacts).toMatchObject({
      sensitivity: 'detected',
      memoryClass: neo4jLayer.captured?.memory_type,
      outcome: neo4jLayer.captured?.outcome,
      tenantScope: 'resolved',
      projectScope: 'resolved',
    });
    expect(JSON.stringify(sink.persist.mock.calls)).not.toContain(secret);
  });

  it('does not inspect caller data before the baseline readonly guard when shadow is off', async () => {
    let reads = 0;
    const hostile = new Proxy({} as typeof input, {
      get() {
        reads += 1;
        throw new Error('input-must-not-be-read');
      },
    });
    const service = new AMPService(
      redis([]), neo4j([]),
      { embed: vi.fn(), embedBatch: vi.fn() },
      config({ readonly: true }), undefined, undefined, undefined,
    );

    await expect(service.store(hostile)).rejects.toThrow('read-only mode');
    expect(reads).toBe(0);
  });

  it('preserves the legacy empty scope when project-tag enforcement is disabled', async () => {
    const previous = process.env.MEMBERRY_REQUIRE_PROJECT_TAG;
    process.env.MEMBERRY_REQUIRE_PROJECT_TAG = 'false';
    try {
      const events: string[] = [];
      const neo4jLayer = neo4j(events);
      const service = new AMPService(
        redis(events), neo4jLayer,
        { embed: vi.fn(async () => [0.1]), embedBatch: vi.fn() },
        config(), undefined, undefined, undefined,
      );
      await service.store({ ...input, tags: undefined });
      expect(neo4jLayer.captured?.scope).toBe('');
    } finally {
      if (previous === undefined) delete process.env.MEMBERRY_REQUIRE_PROJECT_TAG;
      else process.env.MEMBERRY_REQUIRE_PROJECT_TAG = previous;
    }
  });
});
