import { describe, expect, it, vi } from 'vitest';

import {
  RERANKER_MAX_CANDIDATES,
  SERVED_RERANKER_PROVIDER_IDENTITY,
  createRerankerProviderV1,
  createServedRerankerProviderV1,
  executeCalibratedRerankV1,
  type RerankerProviderV1,
} from '../index.js';
import {
  applyServedRerankerV1,
  type ServedRerankerApplicationResultV1,
} from '../served-reranker.js';
import {
  parseSerializedRerankerProviderRequestV1,
  serializeRerankerProviderResponseV1,
} from '../reranker.js';
import type { RetrievalResult } from '../types.js';

function result(
  id: string,
  score: number,
  title = '',
  content = '',
  metadata: Record<string, unknown> = {},
): RetrievalResult {
  return { id, source_type: 'semantic', title, content, score, metadata };
}

function blockResult(id: string, score: number, title = '', content = ''): RetrievalResult {
  return { id, source_type: 'block', title, content, score, metadata: {} };
}

function ids(outcome: ServedRerankerApplicationResultV1): string[] {
  return outcome.results.map((item) => item.id);
}

function exactProvider(scores: readonly number[]): RerankerProviderV1 {
  return createRerankerProviderV1(SERVED_RERANKER_PROVIDER_IDENTITY, async (serialized) => {
    const request = parseSerializedRerankerProviderRequestV1(serialized);
    return serializeRerankerProviderResponseV1(request, SERVED_RERANKER_PROVIDER_IDENTITY, scores);
  });
}

describe('RET-010B frozen served reranker', () => {
  it('freezes the public construction identity and canonical provider bytes', async () => {
    expect(SERVED_RERANKER_PROVIDER_IDENTITY).toEqual({
      providerId: 'memberry.local.lexical',
      modelId: 'bm25f-query-v1',
      calibrationId: 'fixed-blend-v1',
      locality: 'local',
    });
    expect(Object.getPrototypeOf(SERVED_RERANKER_PROVIDER_IDENTITY)).toBeNull();
    expect(Object.isFrozen(SERVED_RERANKER_PROVIDER_IDENTITY)).toBe(true);
    const provider = createServedRerankerProviderV1();
    const reranked = await executeCalibratedRerankV1({
      query: 'unmatched',
      candidates: [
        { value: 'one', sourceType: 'semantic', title: 'alpha', content: '', baselineScore: 1 },
        { value: 'two', sourceType: 'semantic', title: 'beta', content: '', baselineScore: 0 },
      ],
    }, provider);
    expect(reranked).toMatchObject({ outcome: 'reranked', provider: SERVED_RERANKER_PROVIDER_IDENTITY });
    expect(reranked.candidates.map((candidate) => candidate.score)).toEqual([0.15, 0]);
    expect(JSON.stringify(reranked.candidates.map((candidate) => candidate.score))).toBe('[0.15,0]');
    expect(Object.is(reranked.candidates[1]!.score, -0)).toBe(false);

    const exact = await executeCalibratedRerankV1({
      query: 'alpha',
      candidates: [{ value: 'exact', sourceType: 'semantic', title: 'alpha', content: '', baselineScore: 0 }],
    }, provider);
    const idf = Math.log(1 + (1 - 1 + 0.5) / (1 + 0.5));
    const titleBm25 = 1 * 2.2 / (1 + 1.2 * (1 - 0.30 + 0.30 * 1 / Math.max(1, 1)));
    const raw = idf * (2 * titleBm25 + 1 * 0);
    const lexical = raw / (raw + 4);
    const expected = Math.round((0.15 * 0 + 0.65 * lexical + 0.15 * 1 + 0.05 * 1) * 1_000_000)
      / 1_000_000;
    expect(exact.candidates[0]!.score).toBe(expected);
    expect(JSON.stringify(exact.candidates[0]!.score)).toBe(JSON.stringify(expected));
  });

  it('is query-sensitive and lets a lower-baseline exact match outrank a distractor', async () => {
    const baseline = [
      result('distractor', 1, 'unrelated roadmap'),
      result('alpha', 0.01, 'alpha retrieval'),
      result('omega', 0.01, 'omega retrieval'),
    ];
    const provider = createServedRerankerProviderV1();
    const alpha = await applyServedRerankerV1('alpha retrieval', baseline, provider);
    const omega = await applyServedRerankerV1('omega retrieval', baseline, provider);
    expect(alpha.outcome).toBe('reranked');
    expect(omega.outcome).toBe('reranked');
    expect(ids(alpha)[0]).toBe('alpha');
    expect(ids(omega)[0]).toBe('omega');
    expect(ids(alpha)).not.toEqual(ids(omega));
  });

  it('RET-Q-004 pins an architecture vector head without discarding the remaining reranked order', async () => {
    const episode = { ...result('episode-head', 1, 'architecture'), source_type: 'episodic' as const };
    const baseline = [
      episode,
      ...Array.from({ length: 12 }, (_, index) => result(`lexical-${index}`, 0.5, `match ${index}`)),
    ];
    const provider = exactProvider([0.1, 1, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5, 0.45]);

    const ordinary = await applyServedRerankerV1('match', baseline, provider);
    const guarded = await applyServedRerankerV1('match', baseline, provider, {
      preserveBaselineEpisodicHead: true,
    });

    expect(ordinary.outcome).toBe('reranked');
    expect(ids(ordinary).indexOf('episode-head')).toBe(12);
    expect(guarded.outcome).toBe('reranked');
    expect(ids(guarded)).toEqual([
      'episode-head', ...Array.from({ length: 12 }, (_, index) => `lexical-${index}`),
    ]);
    if (guarded.outcome !== 'reranked') throw new Error('expected reranked outcome');
    expect(guarded.candidates.map((candidate) => candidate.result.id)).toEqual(ids(guarded));
  });

  it('RET-Q-004 leaves an architecture head inside the reranked top ten under lexical control', async () => {
    const baseline = [
      { ...result('episode-head', 1, 'architecture'), source_type: 'episodic' as const },
      ...Array.from({ length: 9 }, (_, index) => result(`lexical-${index}`, 0.5, `match ${index}`)),
    ];
    const guarded = await applyServedRerankerV1(
      'match', baseline, exactProvider([0.1, 1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2]),
      { preserveBaselineEpisodicHead: true },
    );

    expect(guarded.outcome).toBe('reranked');
    expect(ids(guarded).indexOf('episode-head')).toBe(9);
  });

  it('RET-Q-004 leaves non-architecture episodic heads under ordinary lexical control', async () => {
    const baseline = [
      { ...result('episode-head', 1, 'decision'), source_type: 'episodic' as const },
      ...Array.from({ length: 5 }, (_, index) => result(`lexical-${index}`, 0.5, `match ${index}`)),
    ];
    const guarded = await applyServedRerankerV1(
      'match', baseline, exactProvider([0.1, 1, 0.9, 0.8, 0.7, 0.6]),
      { preserveBaselineEpisodicHead: true },
    );

    expect(guarded.outcome).toBe('reranked');
    expect(ids(guarded).indexOf('episode-head')).toBe(5);
  });

  it('reranks mixed batches containing a MemoryBlock instead of falling back wholesale', async () => {
    const baseline = [
      result('semantic-distractor', 1, 'unrelated roadmap'),
      blockResult('block-match', 0.01, 'project state', 'memberry languages modules indexed files'),
    ];
    const outcome = await applyServedRerankerV1(
      'memberry languages modules indexed files', baseline, createServedRerankerProviderV1(),
    );
    expect(outcome.outcome).toBe('reranked');
    expect(ids(outcome)[0]).toBe('block-match');
  });

  it('reranks a full 50-item long-memory window without truncating returned evidence', async () => {
    const baseline = Array.from({ length: 50 }, (_, index): RetrievalResult => ({
      ...result(
        `long-${index}`,
        0.5,
        `Long memory ${index}`,
        `${index === 37 ? 'needle decision ' : ''}${'x'.repeat(10_000)}`,
      ),
      source_type: index % 2 === 0 ? 'semantic' : 'episodic',
    }));
    const outcome = await applyServedRerankerV1(
      'needle decision', baseline, createServedRerankerProviderV1(),
    );
    expect(outcome.outcome).toBe('reranked');
    expect(outcome.results[0]!.id).toBe('long-37');
    expect(outcome.results[0]!.content).toHaveLength('needle decision '.length + 10_000);
  });

  it.each([
    '',
    'a an and are as at be by for from has have how in is it of on or that the this to was what when where which who why will with',
    '!!! --- ...',
    'a b c 1',
    'x'.repeat(33),
  ])('returns the exact baseline array for an empty retained query: %s', async (query) => {
    const baseline = [result('a', 0.8, 'alpha'), result('b', 0.2, 'beta')];
    const before = structuredClone(baseline);
    const outcome = await applyServedRerankerV1(query, baseline, createServedRerankerProviderV1());
    expect(outcome).toEqual({ outcome: 'baseline', reason: 'not-reranked', results: baseline });
    expect(outcome.results).toBe(baseline);
    expect(outcome.results[0]).toBe(baseline[0]);
    expect(baseline).toEqual(before);
  });

  it('retains metadata references, owns reranked records, and has no cross-call state', async () => {
    const metadata = { stable: true };
    const baseline = [result('a', 0.1, 'alpha', '', metadata), result('b', 0.9, 'beta')];
    const provider = createServedRerankerProviderV1();
    const [first, parallelA, parallelB] = await Promise.all([
      applyServedRerankerV1('alpha', baseline, provider),
      applyServedRerankerV1('alpha', baseline, provider),
      applyServedRerankerV1('beta', baseline, provider),
    ]);
    expect(first.outcome).toBe('reranked');
    expect(first.results).not.toBe(baseline);
    expect(first.results[0]).not.toBe(baseline[0]);
    expect(first.results.find((item) => item.id === 'a')!.metadata).toBe(metadata);
    expect(parallelA).toEqual(first);
    expect(ids(parallelB)[0]).toBe('b');
    expect(baseline.map((item) => item.score)).toEqual([0.1, 0.9]);
  });

  it('fails closed on sparse, proxy, inherited, and accessor-bearing inputs without hooks', async () => {
    const provider = createServedRerankerProviderV1();
    let hooks = 0;
    const sparse = new Array<RetrievalResult>(2);
    Object.defineProperty(sparse, 0, { value: result('a', 0.1, 'alpha'), enumerable: true });
    const inherited = Object.create({
      get id() { hooks += 1; return 'must-not-run'; },
    }) as RetrievalResult;
    const accessor = result('x', 0.1, 'alpha');
    Object.defineProperty(accessor, 'title', {
      enumerable: true,
      get: () => { hooks += 1; return 'must-not-run'; },
    });
    const proxied = new Proxy([result('p', 0.1, 'alpha')], {
      get: () => { hooks += 1; throw new Error('must-not-run'); },
    });
    for (const input of [sparse, [inherited], [accessor], proxied]) {
      const outcome = await applyServedRerankerV1('alpha', input, provider);
      expect(outcome.results).toBe(input);
      expect(outcome.outcome).toBe('baseline');
    }
    expect(hooks).toBe(0);
  });

  it('independently rejects invalid identity, invalid scores, throw, and rejection', async () => {
    const baseline = [result('a', 0.1, 'alpha'), result('b', 0.2, 'beta')];
    const providers = [
      createRerankerProviderV1({ ...SERVED_RERANKER_PROVIDER_IDENTITY, modelId: 'wrong' }, async () => ''),
      exactProvider([0.1234567, 0.2]),
      createRerankerProviderV1(SERVED_RERANKER_PROVIDER_IDENTITY, async () => '{'),
      createRerankerProviderV1(SERVED_RERANKER_PROVIDER_IDENTITY, () => { throw new Error('secret'); }),
      createRerankerProviderV1(SERVED_RERANKER_PROVIDER_IDENTITY, async () => Promise.reject(new Error('secret'))),
    ];
    for (const provider of providers) {
      const outcome = await applyServedRerankerV1('alpha', baseline, provider);
      expect(outcome).toEqual({ outcome: 'baseline', reason: 'not-reranked', results: baseline });
      expect(outcome.results).toBe(baseline);
    }
    const invalidQuery = await applyServedRerankerV1('\ud800', baseline, createServedRerankerProviderV1());
    const invalidTitle = [result('unicode', 0.1, '\ud800')];
    const invalidCandidate = await applyServedRerankerV1('alpha', invalidTitle, createServedRerankerProviderV1());
    expect(invalidQuery.results).toBe(baseline);
    expect(invalidCandidate.results).toBe(invalidTitle);
  });

  it('enforces exact candidate N/N+1 and token caps without input mutation', async () => {
    const atLimit = Array.from({ length: RERANKER_MAX_CANDIDATES }, (_, index) =>
      result(`c-${index}`, index / RERANKER_MAX_CANDIDATES, index === 127 ? 'needle' : 'haystack'));
    const accepted = await applyServedRerankerV1('needle', atLimit, createServedRerankerProviderV1());
    expect(accepted.outcome).toBe('reranked');
    expect(accepted.results).toHaveLength(128);
    const overLimit = [...atLimit, result('c-128', 0, 'needle')];
    const rejected = await applyServedRerankerV1('needle', overLimit, createServedRerankerProviderV1());
    expect(rejected.outcome).toBe('baseline');
    expect(rejected.results).toBe(overLimit);

    const query64 = Array.from({ length: 64 }, (_, index) => `token${index}`).join(' ');
    const query65 = `${query64} excludedneedle`;
    const candidate = [result('caps', 0.5, 'excludedneedle')];
    const capped = await applyServedRerankerV1(query65, candidate, createServedRerankerProviderV1());
    expect(capped.outcome).toBe('reranked');
    expect(capped.results[0]!.score).toBe(0.075);
  });

  it('freezes title/content N/N+1 token retention and half-micro score rejection', async () => {
    const provider = createServedRerankerProviderV1();
    const title127 = Array.from({ length: 127 }, (_, index) => `title${index}`).join(' ');
    const titleAt = await applyServedRerankerV1(
      'needle', [result('title-at', 0.5, `${title127} needle`)], provider,
    );
    const titleOver = await applyServedRerankerV1(
      'needle', [result('title-over', 0.5, `${title127} filler needle`)], provider,
    );
    expect(titleAt.results[0]!.score).toBeGreaterThan(0.075);
    expect(titleOver.results[0]!.score).toBe(0.075);

    const content2047 = Array.from({ length: 2047 }, (_, index) => `body${index}`).join(' ');
    const contentAt = await applyServedRerankerV1(
      'needle', [result('content-at', 0.5, '', `${content2047} needle`)], provider,
    );
    const contentOver = await applyServedRerankerV1(
      'needle', [result('content-over', 0.5, '', `${content2047} filler needle`)], provider,
    );
    expect(contentAt.results[0]!.score).toBeGreaterThan(0.075);
    expect(contentOver.results[0]!.score).toBe(0.075);

    const baseline = [result('half', 0.2, 'needle')];
    const rejected = await applyServedRerankerV1('needle', baseline, exactProvider([0.0000005]));
    const accepted = await applyServedRerankerV1('needle', baseline, exactProvider([0.000001]));
    expect(rejected.results).toBe(baseline);
    expect(rejected.outcome).toBe('baseline');
    expect(accepted).toMatchObject({ outcome: 'reranked', results: [{ score: 0.000001 }] });
  });

  it('does not dispatch inherited numeric setters through provider, response, or application arrays', async () => {
    const baseline = [result('a', 0.1, 'alpha'), result('b', 0.9, 'beta')];
    let callbacks = 0;
    const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, '0');
    let outcome: ServedRerankerApplicationResultV1 | undefined;
    try {
      Object.defineProperty(Array.prototype, '0', {
        configurable: true,
        get: () => { callbacks += 1; return undefined; },
        set: () => { callbacks += 1; },
      });
      outcome = await applyServedRerankerV1('alpha', baseline, createServedRerankerProviderV1());
    } finally {
      if (descriptor) Object.defineProperty(Array.prototype, '0', descriptor);
      else delete (Array.prototype as unknown as Record<string, unknown>)['0'];
    }
    expect(callbacks).toBe(0);
    expect(outcome?.outcome).toBe('reranked');
    expect(ids(outcome!)).toEqual(['a', 'b']);
  });

  it('captures scoring and construction intrinsics before hostile ambient drift', async () => {
    const originals = {
      normalize: String.prototype.normalize,
      lower: String.prototype.toLowerCase,
      split: RegExp.prototype[Symbol.split],
      sort: Array.prototype.sort,
      includes: Array.prototype.includes,
      log: Math.log,
      round: Math.round,
      define: Object.defineProperty,
      parse: JSON.parse,
      stringify: JSON.stringify,
    };
    let outcome: ServedRerankerApplicationResultV1 | undefined;
    try {
      String.prototype.normalize = (() => { throw new Error('drift'); }) as typeof String.prototype.normalize;
      String.prototype.toLowerCase = (() => { throw new Error('drift'); }) as typeof String.prototype.toLowerCase;
      RegExp.prototype[Symbol.split] = (() => { throw new Error('drift'); }) as typeof originals.split;
      Array.prototype.sort = (() => { throw new Error('drift'); }) as typeof Array.prototype.sort;
      Array.prototype.includes = (() => { throw new Error('drift'); }) as typeof Array.prototype.includes;
      Math.log = () => { throw new Error('drift'); };
      Math.round = () => { throw new Error('drift'); };
      Object.defineProperty = (() => { throw new Error('drift'); }) as typeof Object.defineProperty;
      JSON.parse = (() => { throw new Error('drift'); }) as typeof JSON.parse;
      JSON.stringify = (() => { throw new Error('drift'); }) as typeof JSON.stringify;
      outcome = await applyServedRerankerV1(
        'alpha',
        [result('a', 0.1, 'alpha'), result('b', 0.9, 'beta')],
        createServedRerankerProviderV1(),
      );
    } finally {
      String.prototype.normalize = originals.normalize;
      String.prototype.toLowerCase = originals.lower;
      RegExp.prototype[Symbol.split] = originals.split;
      Array.prototype.sort = originals.sort;
      Array.prototype.includes = originals.includes;
      Math.log = originals.log;
      Math.round = originals.round;
      Object.defineProperty = originals.define;
      JSON.parse = originals.parse;
      JSON.stringify = originals.stringify;
    }
    expect(outcome?.outcome).toBe('reranked');
    expect(ids(outcome!)[0]).toBe('a');
  });

  it('uses deterministic baseline/key ties and exact quantized provider output', async () => {
    const baseline = [result('z', 0.5, 'same'), result('a', 0.5, 'same')];
    const first = await applyServedRerankerV1('same', baseline, createServedRerankerProviderV1());
    const second = await applyServedRerankerV1('same', baseline, createServedRerankerProviderV1());
    expect(first).toEqual(second);
    expect(ids(first)).toEqual(['z', 'a']);
    for (const item of first.results) {
      expect(Number.isFinite(item.score)).toBe(true);
      expect(Math.round(item.score * 1_000_000) / 1_000_000).toBe(item.score);
      expect(Object.is(item.score, -0)).toBe(false);
    }
  });

  it('puts one head from each available memory plane in the first four for memory-only batches', async () => {
    const baseline: RetrievalResult[] = [
      ...Array.from({ length: 6 }, (_, index) => ({
        ...result(`semantic-${index}`, 1 - index * 0.01, 'needle', 'needle'),
      })),
      { ...result('episode', 0, 'other', 'other'), source_type: 'episodic' },
      { ...result('fact', 0, 'other', 'other'), source_type: 'fact' },
      blockResult('block', 0, 'other', 'other'),
    ];
    const outcome = await applyServedRerankerV1('needle', baseline, createServedRerankerProviderV1());
    expect(outcome.outcome).toBe('reranked');
    expect(new Set(outcome.results.slice(0, 4).map((item) => item.source_type)))
      .toEqual(new Set(['semantic', 'episodic', 'fact', 'block']));
    expect(outcome.results.find((item) => item.source_type === 'semantic')?.id).toBe('semantic-0');
  });

  it('does not apply memory-plane coverage to mixed code batches', async () => {
    const baseline: RetrievalResult[] = [
      ...Array.from({ length: 6 }, (_, index) => result(`semantic-${index}`, 1, 'needle', 'needle')),
      { ...result('episode', 0, 'other', 'other'), source_type: 'episodic' },
      { ...result('symbol', 1, 'needle', 'needle'), source_type: 'symbol' },
    ];
    const outcome = await applyServedRerankerV1('needle', baseline, createServedRerankerProviderV1());
    expect(outcome.outcome).toBe('reranked');
    expect(outcome.results.slice(0, 5).some((item) => item.id === 'episode')).toBe(false);
  });

  it('maps deadline and late settlement to the exact baseline', async () => {
    vi.useFakeTimers();
    try {
      const baseline = [result('a', 0.1, 'alpha')];
      const provider = createRerankerProviderV1(SERVED_RERANKER_PROVIDER_IDENTITY, async (serialized) => {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const request = parseSerializedRerankerProviderRequestV1(serialized);
        return serializeRerankerProviderResponseV1(request, SERVED_RERANKER_PROVIDER_IDENTITY, [1]);
      });
      const pending = applyServedRerankerV1('alpha', baseline, provider);
      await vi.advanceTimersByTimeAsync(251);
      const outcome = await pending;
      expect(outcome.results).toBe(baseline);
      expect(outcome.outcome).toBe('baseline');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(outcome.results).toBe(baseline);
    } finally {
      vi.useRealTimers();
    }
  });
});
