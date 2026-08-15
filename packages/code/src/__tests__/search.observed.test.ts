import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { CodeSearch } from '../search.js';

function record(id: string, score: number) {
  const properties = {
    id, name: id, kind: 'function', language: 'typescript', file_path: `src/${id}.ts`,
    start_line: 1, signature: `function ${id}()`, doc_comment: '',
  };
  return { get: (key: string) => key === 's' ? { properties } : score };
}

function fixture() {
  const run = vi.fn(async (query: string) => {
    if (query.includes('symbol_search')) return { records: [record('alpha', 0.9)] };
    if (query.includes('symbol_lexical')) return { records: [record('alpha', 0.8), record('beta', 0.7)] };
    throw new Error('unexpected query');
  });
  const driver = { session: () => ({ run, close: vi.fn(async () => undefined) }) };
  const search = new CodeSearch(driver as never, {
    available: false,
    embed: vi.fn(async () => [0.1]),
    embedBatch: vi.fn(),
  });
  return { search, run };
}

describe('CodeSearch.searchObserved', () => {
  it('shares the standard search result while reporting exact channel provenance after settlement', async () => {
    const ordinaryFixture = fixture();
    const observedFixture = fixture();
    const options = { limit: 5, include_semantics: false };

    const ordinary = await ordinaryFixture.search.search('alpha', options);
    const observed = await observedFixture.search.searchObserved('alpha', options);

    expect(observed.value).toEqual(ordinary);
    expect(observed.observation.channels).toEqual([
      { channel: 'code.fulltext', outcome: 'success' },
      { channel: 'code.lexical-vector', outcome: 'success' },
      { channel: 'code.dense-vector', outcome: 'safe-failure', code: 'unavailable' },
    ]);
    expect(observed.observation.candidates.find((candidate) => candidate.privateId === 'alpha')?.channels)
      .toEqual([
        { channel: 'code.fulltext', rank: 1, score: 0.9 },
        { channel: 'code.lexical-vector', rank: 1, score: 0.8 },
      ]);
  });

  it('settles the remaining concurrent channels before returning structural failure accounting', async () => {
    const { search, run } = fixture();
    run.mockImplementation(async (query: string) => {
      if (query.includes('symbol_search')) throw new Error('private fulltext failure');
      if (query.includes('symbol_lexical')) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { records: [record('late-lexical', 0.7)] };
      }
      throw new Error('unexpected query');
    });

    let caught: unknown;
    try { await search.searchObserved('alpha', { include_semantics: false }); } catch (error) { caught = error; }
    const descriptor = Object.getOwnPropertyDescriptor(caught as object, 'observation');
    expect(descriptor && 'value' in descriptor ? descriptor.value.channels : []).toEqual(expect.arrayContaining([
      { channel: 'code.fulltext', outcome: 'safe-failure', code: 'query-failed' },
      { channel: 'code.lexical-vector', outcome: 'success' },
      { channel: 'code.dense-vector', outcome: 'safe-failure', code: 'unavailable' },
    ]));
  });

  it('never logs raw vector backend errors on the observed path', async () => {
    const { search, run } = fixture();
    const canary = 'code-sk_live_12345678901234567890';
    run.mockImplementation(async (query: string) => {
      if (query.includes('symbol_search')) return { records: [record('alpha', 0.9)] };
      if (query.includes('symbol_lexical')) throw new Error(canary);
      throw new Error('unexpected query');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await search.searchObserved('alpha', { include_semantics: false });

    expect(result.observation.channels).toContainEqual({
      channel: 'code.lexical-vector', outcome: 'safe-failure', code: 'query-failed',
    });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(canary);
    errorSpy.mockRestore();
  });

  it('allocates no trace-only Map in ordinary search and preserves channel call order', async () => {
    const events: string[] = [];
    const run = vi.fn(async (query: string) => {
      const channel = query.includes('symbol_search') ? 'fulltext'
        : query.includes('symbol_lexical') ? 'lexical'
        : 'unexpected';
      events.push(`run:${channel}`);
      return { records: channel === 'unexpected' ? [] : [record(channel, 0.8)] };
    });
    const driver = {
      session: () => {
        events.push('session');
        return { run, close: vi.fn(async () => { events.push('close'); }) };
      },
    };
    const search = new CodeSearch(driver as never, {
      available: false, embed: vi.fn(), embedBatch: vi.fn(),
    });
    const NativeMap = globalThis.Map;
    let directSearchMaps = 0;
    globalThis.Map = class<K, V> extends NativeMap<K, V> {
      constructor(entries?: readonly (readonly [K, V])[] | null) {
        super(entries);
        const directCaller = (new Error().stack ?? '').split('\n')[2] ?? '';
        if (/CodeSearch\.searchStandard/.test(directCaller)) directSearchMaps += 1;
      }
    } as MapConstructor;
    try {
      await search.search('alpha', { include_semantics: false });
    } finally {
      globalThis.Map = NativeMap;
    }

    expect(directSearchMaps).toBe(0);
    expect(events.slice(0, 4)).toEqual(['session', 'run:fulltext', 'session', 'run:lexical']);
  });

  it('keeps code trace state, settlement wrappers, and provenance behind the observed branch', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../search.ts'), 'utf8');
    expect(source).toMatch(/const channelOutcomes = observed\s*\? new Map/);
    expect(source).toMatch(/const observedFulltextPromise = observed\s*\? fulltextPromise\.then/);
    expect(source).toContain('if (!observed) return fused;');
    expect(source.indexOf('if (!observed) return fused;')).toBeLessThan(
      source.indexOf('const observation: InternalRetrievalObservation'),
    );
    expect(source.indexOf('if (!observed) return fused;')).toBeLessThan(
      source.indexOf('const candidates = new Map<string, InternalRetrievalCandidateObservation>()'),
    );
  });
});
