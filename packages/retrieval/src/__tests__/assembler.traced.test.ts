import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { UnifiedAssembler } from '../assembler.js';
import { assertRetrievalTraceConformant, assertRetrievalTraceSecretSafe, replayRetrievalTrace } from '../trace.js';

const CANARY_ID = 'raw-private-sk_live_12345678901234567890';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeAssembler(codeDelay: number, memoryDelay: number, malformed = false) {
  const codeResult = {
    id: CANARY_ID,
    source_type: 'symbol', name: 'alpha', kind: 'function', file_path: 'src/a.ts', start_line: 1,
    signature: 'function alpha()', doc_comment: '', score: 0.9,
  };
  const codeLayer = {
    search: vi.fn(async () => [codeResult]),
    searchObserved: vi.fn(async () => {
      await delay(codeDelay);
      return {
        value: [codeResult],
        observation: {
          channels: [{ channel: 'code.fulltext', outcome: 'success' }],
          candidates: malformed ? [] : [{
            privateId: CANARY_ID,
            sourceType: 'symbol',
            channels: [{ channel: 'code.fulltext', rank: 1, score: 0.9 }],
            evidence: {}, estimatedTokens: 4,
          }],
          finalIds: [CANARY_ID],
        },
      };
    }),
  };
  const memoryValue = {
    markdown: '## [sem-1] (confidence: 0.90)\nremembered',
    tokens: 10,
    sources: ['sem-1'],
  };
  const memoryLayer = {
    load: vi.fn(async () => memoryValue),
    loadFreshObserved: vi.fn(async () => {
      await delay(memoryDelay);
      return {
        value: memoryValue,
        observation: {
          channels: [{ channel: 'memory.scope', outcome: 'success' }],
          candidates: [{
            privateId: 'sem-1', sourceType: 'semantic',
            channels: [{ channel: 'memory.scope', rank: 1 }],
            evidence: { confidence: 0.9 }, estimatedTokens: 3,
          }],
          finalIds: ['sem-1'],
        },
      };
    }),
  };
  const driver = {
    session: () => ({
      run: vi.fn(async () => ({ records: [{ get: () => 0 }] })),
      close: vi.fn(async () => undefined),
    }),
  };
  const redis = { get: vi.fn(async () => null), set: vi.fn(async () => undefined) };
  const embedding = { available: false, embed: vi.fn(), embedBatch: vi.fn() };
  return { assembler: new UnifiedAssembler(driver as never, redis, codeLayer, memoryLayer, embedding), codeLayer, memoryLayer };
}

describe('UnifiedAssembler.assembleTraced ranked runtime', () => {
  it('is deterministic across source settlement permutations, secret-safe, and does not use ordinary layer methods', async () => {
    const first = makeAssembler(20, 1);
    const second = makeAssembler(1, 20);
    const options = { strategy: 'ranked' as const, include_arch: false, max_tokens: 1000 };

    const a = await first.assembler.assembleTraced('find alpha', options);
    const b = await second.assembler.assembleTraced('find alpha', options);

    expect(a.context.sections).toEqual(b.context.sections);
    expect(a.trace).toEqual(b.trace);
    expect(first.codeLayer.search).not.toHaveBeenCalled();
    expect(first.memoryLayer.load).not.toHaveBeenCalled();
    expect(a.trace.incompleteReasons).toEqual([]);
    assertRetrievalTraceConformant(a.trace);
    assertRetrievalTraceSecretSafe(a.trace);
    expect(JSON.stringify(a.trace)).not.toContain(CANARY_ID);
    expect([...new Set(a.trace.events.map((event) => event.kind))]).toEqual(expect.arrayContaining([
      'channel-attempt', 'channel-terminal', 'candidate-filter', 'candidate-score',
      'mmr-round', 'ranked-output', 'candidate-terminal',
    ]));
    expect(a.trace.events.filter((event) => event.kind === 'candidate-score').map((event) => event.name))
      .toEqual(expect.arrayContaining(['rrf', 'feedback-multiplier', 'provenance-multiplier', 'lexical-multiplier', 'final']));
    expect(a.trace.events).toContainEqual(expect.objectContaining({ kind: 'candidate-filter', name: 'dedup', outcome: 'pass' }));
    expect(a.trace.events).toContainEqual(expect.objectContaining({
      kind: 'stage-failure', stage: 'embedding', code: 'unavailable',
    }));
  });

  it('returns unchanged context with an explicit incomplete trace when structural observation is malformed', async () => {
    const { assembler } = makeAssembler(0, 0, true);
    const result = await assembler.assembleTraced('find alpha', { strategy: 'ranked', include_arch: false });
    expect(result.context.sections.flatMap((section) => section.items).some((item) => item.id === CANARY_ID)).toBe(true);
    expect(result.trace.complete).toBe(false);
    expect(result.trace.incompleteReasons.length).toBeGreaterThan(0);
  });

  it('rejects deterministic routing because RET-001B1 is ranked-only', async () => {
    const { assembler } = makeAssembler(0, 0);
    await expect(assembler.assembleTraced('graph', { strategy: 'deterministic' }))
      .rejects.toThrow('ranked');
  });

  it('records a safe channel failure after settlement without changing surviving context', async () => {
    const { assembler, codeLayer } = makeAssembler(0, 0);
    const failure = new Error('private backend detail');
    Object.defineProperty(failure, 'observation', {
      value: {
        channels: [{ channel: 'code.fulltext', outcome: 'safe-failure', code: 'query-failed' }],
        candidates: [], finalIds: [],
      },
      enumerable: false,
    });
    codeLayer.searchObserved.mockRejectedValueOnce(failure);

    const result = await assembler.assembleTraced('find alpha', { strategy: 'ranked', include_arch: false });
    expect(result.context.sections.flatMap((section) => section.items).some((item) => item.id === CANARY_ID)).toBe(false);
    expect(result.trace.complete).toBe(true);
    expect(result.trace.events).toContainEqual(expect.objectContaining({
      kind: 'channel-terminal', channel: 'code.fulltext', outcome: 'safe-failure', code: 'query-failed',
    }));
    expect(JSON.stringify(result.trace)).not.toContain('private backend detail');
  });

  it('preserves real ordinary-only port results but fails the trace closed', async () => {
    const codeLayer = {
      search: vi.fn(async () => [{
        id: 'ordinary-code', source_type: 'symbol', name: 'ordinary', kind: 'function',
        file_path: 'src/ordinary.ts', start_line: 1, signature: 'ordinary()', doc_comment: '', score: 0.9,
      }]),
    };
    const memoryLayer = {
      load: vi.fn(async () => ({
        markdown: '# Memory Context\n\n## [ordinary-memory] (confidence: 0.90)\nremembered',
        tokens: 5,
        sources: ['ordinary-memory'],
      })),
    };
    const driver = { session: () => ({ run: vi.fn(async () => ({ records: [] })), close: vi.fn() }) };
    const redis = { get: vi.fn(async () => null), set: vi.fn(async () => undefined) };
    const embedding = { available: false, embed: vi.fn(), embedBatch: vi.fn() };
    const assembler = new UnifiedAssembler(driver as never, redis, codeLayer, memoryLayer, embedding);

    const result = await assembler.assembleTraced('ordinary ports', { include_arch: false });

    expect(result.context.sections.flatMap((section) => section.items).map((item) => item.id))
      .toEqual(expect.arrayContaining(['ordinary-code', 'ordinary-memory']));
    expect(result.trace.complete).toBe(false);
    expect(result.trace.incompleteReasons).toContain('candidate-output-gap');
  });

  it('does not execute proxy descriptor traps or expose their canary', async () => {
    const { assembler, codeLayer } = makeAssembler(0, 0);
    let descriptorTraps = 0;
    const hostile = new Proxy(new Error('proxy-sk_live_12345678901234567890'), {
      getOwnPropertyDescriptor() {
        descriptorTraps += 1;
        throw new Error('descriptor-sk_live_12345678901234567890');
      },
    });
    codeLayer.searchObserved.mockRejectedValueOnce(hostile);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await assembler.assembleTraced('proxy failure', { include_arch: false });

    expect(descriptorTraps).toBe(0);
    expect(JSON.stringify(result.trace)).not.toContain('sk_live');
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('sk_live');
    errorSpy.mockRestore();
  });

  it('does not execute nested structural observation accessors', async () => {
    const { assembler, codeLayer } = makeAssembler(0, 0);
    let getterCalls = 0;
    const hostileChannel = { outcome: 'safe-failure', code: 'query-failed' } as Record<string, unknown>;
    Object.defineProperty(hostileChannel, 'channel', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'code.fulltext';
      },
    });
    const failure = new Error('accessor-sk_live_12345678901234567890');
    Object.defineProperty(failure, 'observation', {
      value: { channels: [hostileChannel], candidates: [], finalIds: [] },
    });
    codeLayer.searchObserved.mockRejectedValueOnce(failure);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await assembler.assembleTraced('accessor failure', { include_arch: false });

    expect(getterCalls).toBe(0);
    expect(result.trace.events).toContainEqual(expect.objectContaining({
      kind: 'channel-terminal', channel: 'code.fulltext', outcome: 'safe-failure', code: 'query-failed',
    }));
    expect(errorSpy.mock.calls.flat().map(String).join(' ')).not.toContain('sk_live');
    errorSpy.mockRestore();
  });

  it('rejects fulfilled accessor and proxy wrappers before reading value or observation', async () => {
    for (const kind of ['value-accessor', 'observation-accessor', 'proxy'] as const) {
      const { assembler, codeLayer } = makeAssembler(0, 0);
      let forbiddenReads = 0;
      const valid = {
        value: [], observation: { channels: [], candidates: [], finalIds: [] },
      };
      const backing = {
        value: [{
          id: 'hostile-code', source_type: 'symbol', name: 'hostile', kind: 'function',
          file_path: 'src/hostile.ts', start_line: 1, signature: 'hostile()', doc_comment: '', score: 0.9,
        }],
        observation: {
          channels: [{ channel: 'code.fulltext', outcome: 'success' }],
          candidates: [], finalIds: [],
        },
      };
      let wrapper: unknown = backing;
      if (kind.endsWith('accessor')) {
        Object.defineProperty(backing, kind === 'value-accessor' ? 'value' : 'observation', {
          enumerable: true,
          get() { forbiddenReads += 1; return kind === 'value-accessor' ? valid.value : valid.observation; },
        });
      } else {
        wrapper = new Proxy(backing, {
          get(target, key, receiver) {
            if (key === 'then') return undefined;
            if (key === 'value' || key === 'observation') forbiddenReads += 1;
            return Reflect.get(target, key, receiver);
          },
        });
      }
      codeLayer.searchObserved.mockResolvedValueOnce(wrapper as never);

      const result = await assembler.assembleTraced(`hostile fulfilled ${kind}`, { include_arch: false });

      expect(forbiddenReads).toBe(0);
      expect(result.trace.complete).toBe(false);
      expect(result.trace.incompleteReasons).toContain('candidate-output-gap');
      expect(result.context.sections.flatMap((section) => section.items).some((item) => item.id === 'hostile-code')).toBe(false);
    }
  });

  it('requires observation finalIds to exactly match returned source-final IDs', async () => {
    for (const [name, candidates, finalIds] of [
      ['missing', [{
        privateId: CANARY_ID, sourceType: 'symbol',
        channels: [{ channel: 'code.fulltext', rank: 1, score: 0.9 }], evidence: {}, estimatedTokens: 4,
      }], []],
      ['ghost', [{
        privateId: 'ghost-id', sourceType: 'symbol',
        channels: [{ channel: 'code.fulltext', rank: 1, score: 0.9 }], evidence: {}, estimatedTokens: 4,
      }], ['ghost-id']],
      ['duplicate', [{
        privateId: CANARY_ID, sourceType: 'symbol',
        channels: [{ channel: 'code.fulltext', rank: 1, score: 0.9 }], evidence: {}, estimatedTokens: 4,
      }], [CANARY_ID, CANARY_ID]],
    ] as const) {
      const { assembler, codeLayer } = makeAssembler(0, 0);
      codeLayer.searchObserved.mockResolvedValueOnce({
        value: await codeLayer.search(),
        observation: {
          channels: [{ channel: 'code.fulltext', outcome: 'success' }],
          candidates: [...candidates], finalIds: [...finalIds],
        },
      } as never);

      const result = await assembler.assembleTraced(`bijection ${name}`, { include_arch: false });
      expect(result.context.sections.flatMap((section) => section.items).some((item) => item.id === CANARY_ID)).toBe(true);
      expect(result.trace.complete).toBe(false);
      expect(result.trace.incompleteReasons).toContain('candidate-output-gap');
    }
  });

  it('uses fixed trace-path logging for arch, code, memory, and shared embedding failures', async () => {
    const canary = 'backend-sk_live_12345678901234567890';
    const driver = {
      session: () => ({
        run: vi.fn(async () => { throw new Error(canary); }),
        close: vi.fn(async () => undefined),
      }),
    };
    const codeLayer = {
      search: vi.fn(),
      searchObserved: vi.fn(async () => { throw new Error(canary); }),
    };
    const memoryLayer = {
      load: vi.fn(),
      loadFreshObserved: vi.fn(async () => { throw new Error(canary); }),
    };
    const redis = { get: vi.fn(async () => null), set: vi.fn(async () => undefined) };
    const embedding = { available: true, embed: vi.fn(async () => { throw new Error(canary); }), embedBatch: vi.fn() };
    const assembler = new UnifiedAssembler(driver as never, redis, codeLayer, memoryLayer, embedding);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await assembler.assembleTraced('all failures');

    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(canary);
    expect(JSON.stringify(result.trace)).not.toContain(canary);
    expect(result.trace.events).toContainEqual(expect.objectContaining({
      kind: 'stage-failure', stage: 'embedding', code: 'query-failed',
    }));
    errorSpy.mockRestore();
  });

  it('maps only explicit source-final markdown sections and marks an aggregate section incomplete', async () => {
    const { assembler, memoryLayer } = makeAssembler(0, 0);
    memoryLayer.loadFreshObserved.mockResolvedValueOnce({
      value: {
        markdown: '## Current Facts\n\n- one aggregate\n\n## [sem-1] (confidence: 0.90)\nremembered',
        tokens: 10,
        sources: ['sem-1'],
      },
      observation: {
        channels: [{ channel: 'memory.scope', outcome: 'success' }],
        candidates: [{
          privateId: 'sem-1', sourceType: 'semantic',
          channels: [{ channel: 'memory.scope', rank: 1 }],
          evidence: { confidence: 0.9 }, estimatedTokens: 3,
        }],
        finalIds: ['sem-1'],
      },
    });

    const result = await assembler.assembleTraced('memory split', {
      include_arch: false,
      include_code: false,
    });

    expect(result.context.sections.flatMap((section) => section.items)).toHaveLength(2);
    expect(result.trace.complete).toBe(false);
    expect(result.trace.incompleteReasons).toContain('candidate-output-gap');
    expect(result.trace.candidates).toHaveLength(0);
  });

  it('normalizes only the exact AMPService Memory Context presentation preamble in traced mapping', async () => {
    const { assembler, memoryLayer } = makeAssembler(0, 0);
    memoryLayer.loadFreshObserved.mockResolvedValueOnce({
      value: {
        markdown: '# Memory Context\n\n**Task:** faithful memory fixture\n\n## [sem-1] (confidence: 0.90, score: 0.800)\nremembered',
        tokens: 10,
        sources: ['sem-1'],
      },
      observation: {
        channels: [{ channel: 'memory.scope', outcome: 'success' }],
        candidates: [{
          privateId: 'sem-1', sourceType: 'semantic',
          channels: [{ channel: 'memory.scope', rank: 1 }],
          evidence: { confidence: 0.9 }, estimatedTokens: 3,
        }],
        finalIds: ['sem-1'],
      },
    });

    const result = await assembler.assembleTraced('faithful memory fixture', {
      include_arch: false,
      include_code: false,
    });

    expect(result.context.sections.flatMap((section) => section.items)).toHaveLength(1);
    expect(result.context.sections[0]?.items[0]?.content).not.toContain('# Memory Context');
    expect(result.trace.complete).toBe(true);
    expect(result.trace.incompleteReasons).toEqual([]);
    expect(result.trace.candidates).toHaveLength(1);
  });

  it('does not normalize an arbitrary H1 or a mismatched Memory Context task preamble', async () => {
    for (const markdown of [
      '# Arbitrary Header\n\n**Task:** exact task\n\n## [sem-1] (confidence: 0.90)\nremembered',
      '# Memory Context\n\n**Task:** different task\n\n## [sem-1] (confidence: 0.90)\nremembered',
    ]) {
      const { assembler, memoryLayer } = makeAssembler(0, 0);
      memoryLayer.loadFreshObserved.mockResolvedValueOnce({
        value: { markdown, tokens: 10, sources: ['sem-1'] },
        observation: {
          channels: [{ channel: 'memory.scope', outcome: 'success' }],
          candidates: [{
            privateId: 'sem-1', sourceType: 'semantic',
            channels: [{ channel: 'memory.scope', rank: 1 }],
            evidence: {}, estimatedTokens: 3,
          }],
          finalIds: ['sem-1'],
        },
      });

      const result = await assembler.assembleTraced('exact task', { include_arch: false, include_code: false });
      expect(result.trace.complete).toBe(false);
      expect(result.trace.incompleteReasons).toContain('candidate-output-gap');
      expect(result.trace.candidates).toHaveLength(0);
    }
  });

  it('normalizes AMPService exact empty-memory presentation without inventing a result', async () => {
    const { assembler, memoryLayer } = makeAssembler(0, 0);
    memoryLayer.loadFreshObserved.mockResolvedValueOnce({
      value: {
        markdown: '# Memory Context\n\n_No relevant memories found for task: nothing here_\n',
        tokens: 0,
        sources: [],
      },
      observation: {
        channels: [{ channel: 'memory.scope', outcome: 'success' }],
        candidates: [],
        finalIds: [],
      },
    });

    const result = await assembler.assembleTraced('nothing here', {
      include_arch: false,
      include_code: false,
    });

    expect(result.context.sections).toEqual([]);
    expect(result.trace.complete).toBe(true);
    expect(result.trace.candidates).toEqual([]);
  });

  it('emits no markdown mapping for duplicate, reordered, or injected headings', async () => {
    const cases = [
      '## [sem-1] (confidence: 0.90)\none\n\n## [sem-1] (confidence: 0.80)\ninjected duplicate',
      '## [sem-2] (confidence: 0.80)\ntwo\n\n## [sem-1] (confidence: 0.90)\none',
      '## [sem-1] (confidence: 0.90)\none\n\n## Current Facts\n\ninjected aggregate',
    ];
    for (const markdown of cases) {
      const { assembler, memoryLayer } = makeAssembler(0, 0);
      memoryLayer.loadFreshObserved.mockResolvedValueOnce({
        value: { markdown, tokens: 10, sources: ['sem-1', 'sem-2'] },
        observation: {
          channels: [{ channel: 'memory.scope', outcome: 'success' }],
          candidates: [
            { privateId: 'sem-1', sourceType: 'semantic', channels: [{ channel: 'memory.scope', rank: 1 }], evidence: {}, estimatedTokens: 2 },
            { privateId: 'sem-2', sourceType: 'semantic', channels: [{ channel: 'memory.scope', rank: 2 }], evidence: {}, estimatedTokens: 2 },
          ],
          finalIds: ['sem-1', 'sem-2'],
        },
      });

      const result = await assembler.assembleTraced('unsafe markdown map', { include_arch: false, include_code: false });
      expect(result.trace.complete).toBe(false);
      expect(result.trace.incompleteReasons).toContain('candidate-output-gap');
      expect(result.trace.candidates).toHaveLength(0);
    }
  });

  it('records ranked output in exact final grouped and budgeted context order', async () => {
    const { assembler, codeLayer, memoryLayer } = makeAssembler(0, 0);
    const codeResults = [
      { id: 'code-1', source_type: 'symbol', name: 'alpha', kind: 'function', file_path: 'src/same.ts', start_line: 1, signature: 'alpha()', doc_comment: '', score: 0.9 },
      { id: 'code-2', source_type: 'symbol', name: 'beta', kind: 'function', file_path: 'src/same.ts', start_line: 2, signature: 'beta()', doc_comment: '', score: 0.8 },
    ];
    codeLayer.searchObserved.mockResolvedValueOnce({
      value: codeResults,
      observation: {
        channels: [{ channel: 'code.fulltext', outcome: 'success' }],
        candidates: codeResults.map((result, index) => ({
          privateId: result.id, sourceType: 'symbol' as const,
          channels: [{ channel: 'code.fulltext' as const, rank: index + 1, score: result.score }],
          evidence: {}, estimatedTokens: 3,
        })),
        finalIds: codeResults.map((result) => result.id),
      },
    });
    memoryLayer.loadFreshObserved.mockResolvedValueOnce({
      value: { markdown: '## [mem-1] (confidence: 0.90)\nremembered', tokens: 4, sources: ['mem-1'] },
      observation: {
        channels: [{ channel: 'memory.scope', outcome: 'success' }],
        candidates: [{
          privateId: 'mem-1', sourceType: 'semantic', channels: [{ channel: 'memory.scope', rank: 1 }],
          evidence: {}, estimatedTokens: 2,
        }],
        finalIds: ['mem-1'],
      },
    });

    const result = await assembler.assembleTraced('find function alpha', { include_arch: false, max_tokens: 1000 });
    expect(result.context.sections.flatMap((section) => section.items.map((item) => item.id)))
      .toEqual(['code-1', 'code-2', 'mem-1']);
    const byRef = new Map(result.trace.candidates.map((candidate) => [candidate.ref, candidate]));
    const outputShape = result.trace.events
      .filter((event) => event.kind === 'ranked-output')
      .sort((a, b) => a.rank - b.rank)
      .map((event) => {
        const candidate = byRef.get(event.ref)!;
        return [candidate.sourceType, candidate.channels[0]?.rank];
      });
    expect(outputShape).toEqual([['symbol', 1], ['symbol', 2], ['semantic', 1]]);
    expect(replayRetrievalTrace(result.trace).resultOrder).toEqual(
      result.trace.events.filter((event) => event.kind === 'ranked-output')
        .sort((a, b) => a.rank - b.rank).map((event) => event.ref),
    );
  });

  it('keeps trace-only allocation records behind observer guards', () => {
    const root = resolve(import.meta.dirname, '../../../..');
    const fusion = readFileSync(resolve(root, 'packages/retrieval/src/fusion.ts'), 'utf8');
    const scoring = readFileSync(resolve(root, 'packages/retrieval/src/scoring.ts'), 'utf8');
    const assembler = readFileSync(resolve(root, 'packages/retrieval/src/assembler.ts'), 'utf8');
    expect(fusion).not.toContain('const admitted = new Set');
    expect(scoring).toMatch(/const roundRecords = observer \? \[\].*: undefined/);
    expect(scoring).toMatch(/const pairwise = observer \? \[\].*: undefined/);
    expect(assembler).toContain('const traceIncompleteReasons = traced ? new Set');
  });
});
