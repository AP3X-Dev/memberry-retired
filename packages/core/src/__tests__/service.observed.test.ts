import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { AMPService } from '../service.js';
import { InternalObservedRetrievalError } from '../retrieval-observer.js';
import type { AMPConfig, SemanticNode } from '../types.js';

const config: AMPConfig = {
  redis: { url: '' },
  neo4j: { uri: '', user: '', password: '' },
  embedding: { provider: 'openai', apiKey: '' },
  cache: { defaultTTL: 300, contextTTL: 600, embeddingTTL: 3600 },
  consolidation: { autoApply: false, signalThreshold: 3 },
  exportPath: '',
};

function semantic(id: string): SemanticNode {
  return {
    id,
    content: `content-${id}`,
    confidence: 0.9,
    signal_count: 2,
    created_at: '2026-08-14T00:00:00.000Z',
    updated_at: '2026-08-14T00:00:00.000Z',
    decay_class: 'stable',
    tags: ['project:test'],
    scope: 'project:test',
  };
}

function fixture() {
  const cache = {
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    invalidateByScope: vi.fn(async () => 0),
    invalidateByNodeId: vi.fn(async () => 0),
  };
  const byScope = vi.fn(async () => [semantic('sem-scope')]);
  const byVector = vi.fn(async () => [{ ...semantic('sem-vector'), score: 0.8 }]);
  const service = new AMPService(
    {
      cache,
      embeddings: { get: vi.fn(), set: vi.fn() },
      dedup: { isDuplicate: vi.fn(), markSeen: vi.fn(), checkAndMark: vi.fn(), unmark: vi.fn() },
      signals: { publish: vi.fn() },
      queue: { incrementScore: vi.fn() },
    } as never,
    { episodic: {} as never, query: { byScope, byVector } } as never,
    { available: true, embed: vi.fn(async () => [0.1]), embedBatch: vi.fn() },
    config,
  );
  return { service, cache, byScope, byVector };
}

describe('AMPService.loadFreshObserved', () => {
  it('shares the ordinary assembly implementation but bypasses cache get/set and reports settled source-final provenance', async () => {
    const { service, cache, byScope, byVector } = fixture();
    const scope = { task: 'trace this', tags: ['project:test'], max_tokens: 1000 };

    const observed = await service.loadFreshObserved(scope);

    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
    expect(byScope).toHaveBeenCalledWith(expect.objectContaining({ projectScope: 'project:test' }));
    expect(byVector).toHaveBeenCalledOnce();
    expect(observed.value.sources).toEqual(['sem-vector', 'sem-scope']);
    expect(observed.observation.channels).toEqual(expect.arrayContaining([
      expect.objectContaining({ channel: 'memory.scope', outcome: 'success' }),
      expect.objectContaining({ channel: 'memory.semantic-vector', outcome: 'success' }),
    ]));
    expect(observed.observation.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ privateId: 'sem-scope', sourceType: 'semantic' }),
      expect.objectContaining({ privateId: 'sem-vector', sourceType: 'semantic' }),
    ]));
  });

  it('leaves ordinary load cache and single-flight behavior on the existing path', async () => {
    const { service, cache } = fixture();
    const scope = { task: 'ordinary', tags: ['project:test'] };
    await Promise.all([service.load(scope), service.load(scope)]);
    expect(cache.get).toHaveBeenCalledTimes(2);
    expect(cache.set).toHaveBeenCalledTimes(1);
  });

  it('waits for concurrent source settlement and carries closed channel accounting on failure', async () => {
    const { service, cache, byScope, byVector } = fixture();
    byScope.mockRejectedValueOnce(new Error('private scope failure'));
    byVector.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return [{ ...semantic('late-vector'), score: 0.8 }];
    });

    let caught: unknown;
    try { await service.loadFreshObserved({ task: 'failure', tags: ['project:test'] }); } catch (error) { caught = error; }

    expect(caught).toBeInstanceOf(InternalObservedRetrievalError);
    expect((caught as InternalObservedRetrievalError).observation.channels).toEqual(expect.arrayContaining([
      { channel: 'memory.scope', outcome: 'safe-failure', code: 'query-failed' },
      { channel: 'memory.semantic-vector', outcome: 'success' },
    ]));
    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('never logs raw vector backend errors on the observed path', async () => {
    const { service, byVector } = fixture();
    const canary = 'core-sk_live_12345678901234567890';
    byVector.mockRejectedValueOnce(new Error(canary));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await service.loadFreshObserved({ task: 'safe logs', tags: ['project:test'] });

    expect(result.observation.channels).toContainEqual({
      channel: 'memory.semantic-vector', outcome: 'safe-failure', code: 'query-failed',
    });
    expect(errorSpy.mock.calls.flat().map(String).join(' ')).not.toContain(canary);
    errorSpy.mockRestore();
  });

  it('ordinary load allocates only its baseline ranking Map and preserves source/cache call order', async () => {
    const events: string[] = [];
    const { service, cache, byScope, byVector } = fixture();
    cache.get.mockImplementation(async () => { events.push('cache:get'); return null; });
    cache.set.mockImplementation(async () => { events.push('cache:set'); });
    byScope.mockImplementation(async () => { events.push('scope'); return [semantic('sem-scope')]; });
    byVector.mockImplementation(async () => { events.push('vector'); return [{ ...semantic('sem-vector'), score: 0.8 }]; });
    const NativeMap = globalThis.Map;
    let directAssemblyMaps = 0;
    globalThis.Map = class<K, V> extends NativeMap<K, V> {
      constructor(entries?: readonly (readonly [K, V])[] | null) {
        super(entries);
        const directCaller = (new Error().stack ?? '').split('\n')[2] ?? '';
        if (/AMPService\._assembleLoad/.test(directCaller)) directAssemblyMaps += 1;
      }
    } as MapConstructor;
    try {
      await service.load({ task: 'ordinary allocation probe', tags: ['project:test'] });
    } finally {
      globalThis.Map = NativeMap;
    }

    expect(directAssemblyMaps).toBe(1);
    expect(events).toEqual(['cache:get', 'scope', 'vector', 'cache:set']);
  });

  it('keeps core settlement wrappers and candidate provenance behind observation guards', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../service.ts'), 'utf8');
    expect(source).toMatch(/const channelOutcomes = observation\s*\? new Map/);
    expect(source).toContain('if (observation && this.blocks && projectTag)');
    expect(source).toMatch(/const scopedSemanticsPromise = observation\s*\? rawScopedSemanticsPromise\.then/);
    expect(source).toMatch(/const observedFactsPromise = observation && this\.neo4j\.fact/);
    expect(source).toMatch(/const sourceTypeById = observation \? new Map/);
    expect(source).toMatch(/const candidateChannels = observation\s*\? new Map/);
  });
});
