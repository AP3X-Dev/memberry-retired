import { Buffer as NodeBuffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  RETRIEVAL_TRACE_VERSION,
  RETRIEVAL_TRACE_DETERMINISTIC_OUTPUT_CHANNEL_ORDER_V2,
  RetrievalTraceCollector,
  RetrievalTraceLimitError,
  RetrievalTraceValidationError,
  assertRetrievalTraceConformant,
  assertRetrievalTraceSecretSafe,
  canonicalTraceJson,
  computeRetrievalTraceReplayStateDigest,
  replayRetrievalTrace,
  roundTraceNumber,
  validateRetrievalTrace,
  type RetrievalTraceCandidateDraft,
  type RetrievalTraceCandidateHandle,
  type RetrievalTraceRequestShapeV1,
  type RetrievalTraceV1,
} from '../trace.js';

const deterministicV2Fixture = JSON.parse(readFileSync(
  new URL('./fixtures/retrieval-trace-deterministic-v2.json', import.meta.url),
  'utf8',
)) as unknown;

const rankedRequest: RetrievalTraceRequestShapeV1 = {
  sources: { code: true, architecture: false, memory: true },
  projectScopeApplied: true,
  tenantScope: 'named',
  entityScope: 'few',
  tagScope: 'one',
  temporalFilterApplied: true,
  queryLength: 'short',
  queryForm: 'identifier-heavy',
  tokenBudget: 'medium',
  diversification: 'none',
  plannedChannels: ['memory.scope', 'memory.semantic-vector'],
};

function candidate(channel: 'memory.scope' | 'memory.semantic-vector', rank: number): RetrievalTraceCandidateDraft {
  return {
    sourceType: 'semantic',
    channels: [{ channel, rank, score: rank === 1 ? 0.91 : 0.81 }],
    evidence: { confidence: 0.9, sourceCount: 2, superseded: false, invalidated: false },
    estimatedTokens: 80,
  };
}

function settleChannels(collector: RetrievalTraceCollector): void {
  for (const channel of rankedRequest.plannedChannels) {
    collector.attemptChannel(channel);
    collector.settleChannel(channel, { outcome: 'success' });
  }
}

function addIncluded(
  collector: RetrievalTraceCollector,
  draft: RetrievalTraceCandidateDraft,
  outputRank: number,
  final: number,
): RetrievalTraceCandidateHandle {
  const handle = collector.addCandidate(draft);
  collector.recordFilter(handle, { name: 'tenant', outcome: 'pass' });
  collector.recordFilter(handle, { name: 'project', outcome: 'pass' });
  collector.recordScore(handle, { name: 'final', value: final });
  collector.recordOutput(handle, outputRank);
  collector.recordTerminal(handle, { outcome: 'included', reasons: [] });
  return handle;
}

function build(order: 'forward' | 'reverse' = 'forward') {
  const collector = new RetrievalTraceCollector('ranked-v1', rankedRequest);
  settleChannels(collector);
  const drafts = [
    { draft: candidate('memory.scope', 1), outputRank: 1, final: 0.91 },
    { draft: candidate('memory.semantic-vector', 2), outputRank: 2, final: 0.81 },
  ];
  for (const item of order === 'forward' ? drafts : [...drafts].reverse()) {
    addIncluded(collector, item.draft, item.outputRank, item.final);
  }
  return collector.finalize();
}

function buildRankedV2(outcome: 'reranked' | 'baseline' = 'reranked') {
  const request: RetrievalTraceRequestShapeV1 = {
    ...rankedRequest,
    diversification: 'mmr',
    plannedChannels: ['memory.scope'],
  };
  const collector = new RetrievalTraceCollector('ranked-v2', request);
  collector.attemptChannel('memory.scope');
  collector.settleChannel('memory.scope', { outcome: 'success' });
  const handles = [
    collector.addCandidate({ ...candidate('memory.scope', 1), sourceType: 'semantic' }),
    collector.addCandidate({ ...candidate('memory.scope', 2), sourceType: 'symbol' }),
    collector.addCandidate({ ...candidate('memory.scope', 3), sourceType: 'semantic' }),
  ];
  handles.forEach((handle) => collector.recordFilter(handle, { name: 'mmr', outcome: 'pass' }));
  const selected: RetrievalTraceCandidateHandle[] = [];
  for (let round = 1; round <= handles.length; round += 1) {
    const eligible = handles.slice(round - 1);
    collector.recordMmrRound(round, eligible[0]!, eligible.map((handle, index) => ({
      candidate: handle,
      relevance: 0.9 - (round + index - 1) / 10,
      lambda: 1,
      pairwise: selected.map((prior) => ({ selected: prior, similarity: 0 })),
    })));
    selected.push(eligible[0]!);
  }
  handles.forEach((handle) => collector.recordFilter(handle, { name: 'dedup', outcome: 'pass' }));
  collector.recordRerankerStage(handles, outcome === 'baseline'
    ? { outcome: 'baseline' }
    : {
        outcome: 'reranked',
        candidates: [
          { candidateHandle: handles[0]!, calibratedScore: 0.9 },
          { candidateHandle: handles[1]!, calibratedScore: 0.8 },
          { candidateHandle: handles[2]!, calibratedScore: 0.7 },
        ],
      });
  handles.forEach((handle) => {
    collector.recordFilter(handle, { name: 'token-budget', outcome: 'pass' });
    collector.recordTerminal(handle, { outcome: 'included', reasons: [] });
  });
  handles.forEach((handle, index) => collector.recordOutput(handle, index + 1));
  return { trace: collector.finalize(), handles, collector };
}

const deterministicV2Request: RetrievalTraceRequestShapeV1 = {
  sources: { code: false, architecture: true, memory: true },
  projectScopeApplied: true,
  tenantScope: 'default',
  entityScope: 'few',
  tagScope: 'none',
  temporalFilterApplied: false,
  queryLength: 'medium',
  queryForm: 'identifier-heavy',
  tokenBudget: 'large',
  diversification: 'none',
  plannedChannels: [
    'arch.fulltext',
    'arch.hierarchy',
    'arch.entity',
    'arch.dependency',
    'arch.aspect',
    'memory.graph',
  ],
};

type DeterministicV2OutputChannel = typeof RETRIEVAL_TRACE_DETERMINISTIC_OUTPUT_CHANNEL_ORDER_V2[number];

function deterministicV2Candidate(
  channel: DeterministicV2OutputChannel,
  rank = 1,
): RetrievalTraceCandidateDraft {
  const sourceType = channel === 'arch.aspect'
    ? 'aspect'
    : channel === 'memory.graph' ? 'semantic' : 'arch_entity';
  return {
    sourceType,
    channels: [{ channel, rank }],
    evidence: channel === 'memory.graph' ? { confidence: 0.8 } : {},
    estimatedTokens: channel === 'memory.graph' ? 90 : 40,
  };
}

function buildDeterministicV2(order: 'forward' | 'reverse' = 'forward') {
  const collector = new RetrievalTraceCollector('deterministic-v2', deterministicV2Request);
  for (const channel of deterministicV2Request.plannedChannels) {
    collector.attemptChannel(channel);
    collector.settleChannel(channel, { outcome: 'success' });
  }
  const drafts = RETRIEVAL_TRACE_DETERMINISTIC_OUTPUT_CHANNEL_ORDER_V2.map((channel) => ({
    channel,
    draft: deterministicV2Candidate(channel),
  }));
  const handles = new Map<DeterministicV2OutputChannel, RetrievalTraceCandidateHandle>();
  for (const item of order === 'forward' ? drafts : [...drafts].reverse()) {
    handles.set(item.channel, collector.addCandidate(item.draft));
  }
  for (const channel of RETRIEVAL_TRACE_DETERMINISTIC_OUTPUT_CHANNEL_ORDER_V2) {
    const handle = handles.get(channel)!;
    if (channel === 'arch.dependency') {
      collector.recordFilter(handle, { name: 'token-budget', outcome: 'fail' });
      collector.recordTerminal(handle, { outcome: 'excluded', reasons: ['token-budget'] });
    } else {
      collector.recordFilter(handle, { name: 'token-budget', outcome: 'pass' });
      collector.recordTerminal(handle, { outcome: 'included', reasons: [] });
    }
  }
  return collector.finalize();
}

describe('RET-001A retrieval trace contract', () => {
  it('records one closed ranked-v2 reranker event and independently replays calibrated presentation', () => {
    const { trace } = buildRankedV2();
    expect(trace.algorithmVersion).toBe('ranked-v2');
    expect(Object.keys(trace)).toEqual([
      'schemaVersion', 'algorithmVersion', 'requestShape', 'complete', 'incompleteReasons',
      'candidates', 'events', 'resultOrder', 'terminalExclusions', 'replayStateDigest',
    ]);
    const rerankers = trace.events.filter((event) => event.kind === 'reranker-stage');
    expect(rerankers).toHaveLength(1);
    const reranker = rerankers[0]!;
    if (reranker.kind !== 'reranker-stage') throw new Error('missing reranker event');
    expect(Object.getPrototypeOf(reranker)).toBeNull();
    expect(Object.getPrototypeOf(reranker.provider)).toBeNull();
    expect(Object.getPrototypeOf(reranker.candidates[0]!)).toBeNull();
    expect(reranker.sequence).toBe(15);
    expect(reranker).toEqual({
      sequence: 15,
      kind: 'reranker-stage',
      provider: {
        providerId: 'memberry.local.lexical',
        modelId: 'bm25f-query-v1',
        calibrationId: 'fixed-blend-v1',
        locality: 'local',
      },
      outcome: 'reranked',
      candidates: [
        { ref: 'c0001', baselineRank: 1, calibratedScore: 0.9, rerankedRank: 1 },
        { ref: 'c0002', baselineRank: 2, calibratedScore: 0.8, rerankedRank: 2 },
        { ref: 'c0003', baselineRank: 3, calibratedScore: 0.7, rerankedRank: 3 },
      ],
    });
    const kinds = trace.events.map((event) => event.kind);
    expect(kinds.lastIndexOf('mmr-round')).toBeLessThan(kinds.indexOf('reranker-stage'));
    expect(kinds.indexOf('reranker-stage')).toBeLessThan(kinds.indexOf('ranked-output'));
    expect(trace.resultOrder).toEqual(['c0001', 'c0002', 'c0003']);
    expect(replayRetrievalTrace(trace).resultOrder).toEqual(['c0001', 'c0002', 'c0003']);
    expect(validateRetrievalTrace(trace)).toEqual([]);
    assertRetrievalTraceConformant(trace);
  });

  it('records the exact scoreless fallback variant, including an empty reserved event', () => {
    const fallback = buildRankedV2('baseline').trace;
    const event = fallback.events.find((item) => item.kind === 'reranker-stage')!;
    expect(event).toMatchObject({ outcome: 'baseline', reason: 'not-reranked' });
    if (event.kind !== 'reranker-stage' || event.outcome !== 'baseline') throw new Error('unexpected event');
    expect(event.candidates.every((candidate) => !Object.hasOwn(candidate, 'calibratedScore'))).toBe(true);

    const empty = new RetrievalTraceCollector('ranked-v2', {
      ...rankedRequest,
      diversification: 'mmr',
      plannedChannels: ['memory.scope'],
    }, { maxEvents: 2 });
    empty.attemptChannel('memory.scope');
    empty.settleChannel('memory.scope', { outcome: 'success' });
    empty.recordRerankerStage([], { outcome: 'baseline' });
    const trace = empty.finalize();
    expect(trace.events).toHaveLength(3);
    expect(trace.events[2]).toMatchObject({ kind: 'reranker-stage', outcome: 'baseline', candidates: [] });
    expect(trace.complete).toBe(true);
  });

  it('keeps equal-score baseline order authoritative at a tight post-reranker budget cutoff', () => {
    const request: RetrievalTraceRequestShapeV1 = {
      ...rankedRequest, diversification: 'mmr', plannedChannels: ['memory.scope'],
    };
    const collector = new RetrievalTraceCollector('ranked-v2', request);
    collector.attemptChannel('memory.scope');
    collector.settleChannel('memory.scope', { outcome: 'success' });
    const first = collector.addCandidate({ ...candidate('memory.scope', 1), sourceType: 'semantic' });
    const second = collector.addCandidate({ ...candidate('memory.scope', 2), sourceType: 'symbol' });
    collector.recordFilter(first, { name: 'mmr', outcome: 'pass' });
    collector.recordFilter(second, { name: 'mmr', outcome: 'pass' });
    collector.recordMmrRound(1, first, [
      { candidate: first, relevance: 1, lambda: 1, pairwise: [] },
      { candidate: second, relevance: 0.9, lambda: 1, pairwise: [] },
    ]);
    collector.recordMmrRound(2, second, [{
      candidate: second, relevance: 0.9, lambda: 1,
      pairwise: [{ selected: first, similarity: 0 }],
    }]);
    collector.recordFilter(first, { name: 'dedup', outcome: 'pass' });
    collector.recordFilter(second, { name: 'dedup', outcome: 'pass' });
    collector.recordRerankerStage([first, second], {
      outcome: 'reranked',
      candidates: [
        { candidateHandle: first, calibratedScore: 0.5 },
        { candidateHandle: second, calibratedScore: 0.5 },
      ],
    });
    collector.recordFilter(first, { name: 'token-budget', outcome: 'pass' });
    collector.recordTerminal(first, { outcome: 'included', reasons: [] });
    collector.recordOutput(first, 1);
    collector.recordFilter(second, { name: 'token-budget', outcome: 'fail' });
    collector.recordTerminal(second, { outcome: 'excluded', reasons: ['token-budget'] });
    const trace = collector.finalize();
    const event = trace.events.find((item) => item.kind === 'reranker-stage');
    if (event?.kind !== 'reranker-stage' || event.outcome !== 'reranked') throw new Error('missing reranker event');
    expect(event.candidates.map((item) => [item.baselineRank, item.calibratedScore, item.rerankedRank]))
      .toEqual([[1, 0.5, 1], [2, 0.5, 2]]);
    expect(replayRetrievalTrace(trace).resultOrder).toEqual(['c0001']);
    expect(trace.resultOrder).toEqual(['c0001']);
  });

  it('rejects wrong-algorithm, duplicate, foreign, late, and noncanonical handle outcomes', () => {
    const v1 = new RetrievalTraceCollector('ranked-v1', rankedRequest);
    expect(() => v1.recordRerankerStage([], { outcome: 'baseline' })).toThrow(/ranked-v2/);

    const request: RetrievalTraceRequestShapeV1 = {
      ...rankedRequest, diversification: 'mmr', plannedChannels: ['memory.scope'],
    };
    const collector = new RetrievalTraceCollector('ranked-v2', request);
    collector.attemptChannel('memory.scope');
    collector.settleChannel('memory.scope', { outcome: 'success' });
    const handle = collector.addCandidate(candidate('memory.scope', 1));
    collector.recordFilter(handle, { name: 'mmr', outcome: 'pass' });
    collector.recordMmrRound(1, handle, [{ candidate: handle, relevance: 1, lambda: 1, pairwise: [] }]);
    collector.recordFilter(handle, { name: 'dedup', outcome: 'pass' });
    const foreignCollector = new RetrievalTraceCollector('ranked-v2', request);
    const foreign = foreignCollector.addCandidate(candidate('memory.scope', 1));
    expect(() => collector.recordRerankerStage([foreign], { outcome: 'baseline' })).toThrow(/owned/);
    expect(() => collector.recordRerankerStage([handle, handle], { outcome: 'baseline' })).toThrow(/duplicate|MMR/);
    expect(() => collector.recordRerankerStage([handle], {
      outcome: 'reranked', candidates: [{ candidateHandle: handle, calibratedScore: 0.1234567 }],
    })).toThrow(/canonical/);
    collector.recordRerankerStage([handle], { outcome: 'baseline' });
    expect(() => collector.recordRerankerStage([handle], { outcome: 'baseline' })).toThrow(/already/);

    const readyLateCollector = (): {
      collector: RetrievalTraceCollector;
      handle: RetrievalTraceCandidateHandle;
    } => {
      const late = new RetrievalTraceCollector('ranked-v2', request);
      late.attemptChannel('memory.scope');
      late.settleChannel('memory.scope', { outcome: 'success' });
      const lateHandle = late.addCandidate(candidate('memory.scope', 1));
      late.recordFilter(lateHandle, { name: 'mmr', outcome: 'pass' });
      late.recordMmrRound(1, lateHandle, [{
        candidate: lateHandle, relevance: 1, lambda: 1, pairwise: [],
      }]);
      late.recordFilter(lateHandle, { name: 'dedup', outcome: 'pass' });
      return { collector: late, handle: lateHandle };
    };
    const afterBudget = readyLateCollector();
    afterBudget.collector.recordFilter(afterBudget.handle, { name: 'token-budget', outcome: 'pass' });
    expect(() => afterBudget.collector.recordRerankerStage(
      [afterBudget.handle], { outcome: 'baseline' },
    )).toThrow(/precede budget and output/);
    const afterOutput = readyLateCollector();
    afterOutput.collector.recordOutput(afterOutput.handle, 1);
    expect(() => afterOutput.collector.recordRerankerStage(
      [afterOutput.handle], { outcome: 'baseline' },
    )).toThrow(/precede budget and output/);
  });

  it('keeps Array/Object/inserted-chain numeric setters at 0/127 dormant through finalize and replay', () => {
    const request: RetrievalTraceRequestShapeV1 = {
      ...rankedRequest, diversification: 'mmr', plannedChannels: ['memory.scope'],
    };
    for (const surface of ['array', 'object', 'inserted'] as const) {
      for (const hostileIndex of [0, 127] as const) {
        const collector = new RetrievalTraceCollector('ranked-v2', request);
        collector.attemptChannel('memory.scope');
        collector.settleChannel('memory.scope', { outcome: 'success' });
        const handle = collector.addCandidate(candidate('memory.scope', 1));
        collector.recordFilter(handle, { name: 'mmr', outcome: 'pass' });
        collector.recordMmrRound(1, handle, [{ candidate: handle, relevance: 1, lambda: 1, pairwise: [] }]);
        collector.recordFilter(handle, { name: 'dedup', outcome: 'pass' });
        const inserted = Object.create(Object.getPrototypeOf(Array.prototype)) as object;
        const originalArrayParent = Object.getPrototypeOf(Array.prototype);
        const host = surface === 'array' ? Array.prototype : surface === 'object' ? Object.prototype : inserted;
        const previous = Object.getOwnPropertyDescriptor(host, String(hostileIndex));
        let callbacks = 0;
        let trace: RetrievalTraceV1 | undefined;
        let validation: string[] | undefined;
        let replay: ReturnType<typeof replayRetrievalTrace> | undefined;
        try {
          Object.defineProperty(host, String(hostileIndex), {
            configurable: true,
            get: () => { callbacks += 1; return undefined; },
            set: () => { callbacks += 1; },
          });
          if (surface === 'inserted') Object.setPrototypeOf(Array.prototype, inserted);
          collector.recordRerankerStage([handle], {
            outcome: 'reranked', candidates: [{ candidateHandle: handle, calibratedScore: 1 }],
          });
          collector.recordFilter(handle, { name: 'token-budget', outcome: 'pass' });
          collector.recordTerminal(handle, { outcome: 'included', reasons: [] });
          collector.recordOutput(handle, 1);
          trace = collector.finalize();
          validation = validateRetrievalTrace(trace);
          replay = replayRetrievalTrace(trace);
        } finally {
          if (surface === 'inserted') Object.setPrototypeOf(Array.prototype, originalArrayParent);
          if (previous) Object.defineProperty(host, String(hostileIndex), previous);
          else delete (host as Record<string, unknown>)[String(hostileIndex)];
        }
        expect({ surface, hostileIndex, callbacks }).toEqual({ surface, hostileIndex, callbacks: 0 });
        expect(validation).toEqual([]);
        expect(replay?.resultOrder).toEqual(trace?.resultOrder);
      }
    }
  });

  it('keeps malformed validation closed under Array/Object/inserted-chain setters at 0/127', () => {
    const valid = buildRankedV2().trace;
    const sparseEvents = new Array<unknown>(valid.events.length);
    const sparse = { ...structuredClone(valid), events: sparseEvents };
    let accessorReads = 0;
    const accessor = structuredClone(valid) as RetrievalTraceV1;
    Object.defineProperty(accessor.events, '0', {
      configurable: true,
      enumerable: true,
      get: () => { accessorReads += 1; return valid.events[0]; },
    });
    const proxied = new Proxy(structuredClone(valid), {});
    const rerankerMutation = structuredClone(valid);
    for (let index = 0; index < rerankerMutation.events.length; index += 1) {
      const event = rerankerMutation.events[index]!;
      if (event.kind === 'reranker-stage' && event.outcome === 'reranked') {
        (event.candidates[0]! as { calibratedScore: number }).calibratedScore = 2;
        break;
      }
    }
    const manyInvalidEvents = {
      ...structuredClone(valid),
      events: Array.from({ length: 128 }, () => null),
    };
    const malformed: readonly unknown[] = [null, sparse, accessor, proxied, rerankerMutation, manyInvalidEvents];
    for (const surface of ['array', 'object', 'inserted'] as const) {
      for (const hostileIndex of [0, 127] as const) {
        const inserted = Object.create(Object.getPrototypeOf(Array.prototype)) as object;
        const originalArrayParent = Object.getPrototypeOf(Array.prototype);
        const host = surface === 'array' ? Array.prototype : surface === 'object' ? Object.prototype : inserted;
        const previous = Object.getOwnPropertyDescriptor(host, String(hostileIndex));
        let callbacks = 0;
        let allClosed = true;
        try {
          Object.defineProperty(host, String(hostileIndex), {
            configurable: true,
            get: () => { callbacks += 1; return undefined; },
            set: () => { callbacks += 1; },
          });
          if (surface === 'inserted') Object.setPrototypeOf(Array.prototype, inserted);
          for (let index = 0; index < malformed.length; index += 1) {
            if (validateRetrievalTrace(malformed[index]).length === 0) allClosed = false;
          }
        } finally {
          if (surface === 'inserted') Object.setPrototypeOf(Array.prototype, originalArrayParent);
          if (previous) Object.defineProperty(host, String(hostileIndex), previous);
          else delete (host as Record<string, unknown>)[String(hostileIndex)];
        }
        expect({ surface, hostileIndex, callbacks, allClosed }).toEqual({
          surface, hostileIndex, callbacks: 0, allClosed: true,
        });
      }
    }
    expect(accessorReads).toBe(0);
  });

  it('captures ranked-v2 array, math, JSON, freeze, and definition intrinsics end to end', () => {
    const request: RetrievalTraceRequestShapeV1 = {
      ...rankedRequest, diversification: 'mmr', plannedChannels: ['memory.scope'],
    };
    const collector = new RetrievalTraceCollector('ranked-v2', request);
    collector.attemptChannel('memory.scope');
    collector.settleChannel('memory.scope', { outcome: 'success' });
    const handle = collector.addCandidate(candidate('memory.scope', 1));
    collector.recordFilter(handle, { name: 'mmr', outcome: 'pass' });
    collector.recordMmrRound(1, handle, [{ candidate: handle, relevance: 1, lambda: 1, pairwise: [] }]);
    collector.recordFilter(handle, { name: 'dedup', outcome: 'pass' });
    const mutations: Array<{ target: object; key: PropertyKey; previous: PropertyDescriptor | undefined }> = [
      { target: Array.prototype, key: 'map', previous: Object.getOwnPropertyDescriptor(Array.prototype, 'map') },
      { target: Array.prototype, key: 'filter', previous: Object.getOwnPropertyDescriptor(Array.prototype, 'filter') },
      { target: Array.prototype, key: 'sort', previous: Object.getOwnPropertyDescriptor(Array.prototype, 'sort') },
      { target: Array.prototype, key: 'some', previous: Object.getOwnPropertyDescriptor(Array.prototype, 'some') },
      { target: Array.prototype, key: 'includes', previous: Object.getOwnPropertyDescriptor(Array.prototype, 'includes') },
      { target: Array.prototype, key: 'find', previous: Object.getOwnPropertyDescriptor(Array.prototype, 'find') },
      { target: Math, key: 'abs', previous: Object.getOwnPropertyDescriptor(Math, 'abs') },
      { target: Number, key: 'isFinite', previous: Object.getOwnPropertyDescriptor(Number, 'isFinite') },
      { target: Object, key: 'is', previous: Object.getOwnPropertyDescriptor(Object, 'is') },
      { target: Object, key: 'freeze', previous: Object.getOwnPropertyDescriptor(Object, 'freeze') },
      { target: Object, key: 'defineProperty', previous: Object.getOwnPropertyDescriptor(Object, 'defineProperty') },
      { target: JSON, key: 'stringify', previous: Object.getOwnPropertyDescriptor(JSON, 'stringify') },
    ];
    let trace: RetrievalTraceV1 | undefined;
    let validation: string[] | undefined;
    let replay: ReturnType<typeof replayRetrievalTrace> | undefined;
    try {
      for (let index = 0; index < mutations.length; index += 1) {
        Reflect.defineProperty(mutations[index]!.target, mutations[index]!.key, {
          value: () => { throw new Error('hostile intrinsic must not run'); },
          configurable: true,
          writable: true,
        });
      }
      collector.recordRerankerStage([handle], {
        outcome: 'reranked', candidates: [{ candidateHandle: handle, calibratedScore: 1 }],
      });
      collector.recordFilter(handle, { name: 'token-budget', outcome: 'pass' });
      collector.recordTerminal(handle, { outcome: 'included', reasons: [] });
      collector.recordOutput(handle, 1);
      trace = collector.finalize();
      validation = validateRetrievalTrace(trace);
      replay = replayRetrievalTrace(trace);
    } finally {
      for (let index = mutations.length - 1; index >= 0; index -= 1) {
        const mutation = mutations[index]!;
        if (mutation.previous) Reflect.defineProperty(mutation.target, mutation.key, mutation.previous);
        else Reflect.deleteProperty(mutation.target, mutation.key);
      }
    }
    expect(validation).toEqual([]);
    expect(replay?.resultOrder).toEqual(trace?.resultOrder);
  });

  it('fails closed before a changed iterator can enter the shared Core secret scan', () => {
    const request: RetrievalTraceRequestShapeV1 = {
      ...rankedRequest, diversification: 'mmr', plannedChannels: ['memory.scope'],
    };
    const collector = new RetrievalTraceCollector('ranked-v2', request);
    collector.attemptChannel('memory.scope');
    collector.settleChannel('memory.scope', { outcome: 'success' });
    const handle = collector.addCandidate(candidate('memory.scope', 1));
    collector.recordFilter(handle, { name: 'mmr', outcome: 'pass' });
    collector.recordMmrRound(1, handle, [{ candidate: handle, relevance: 1, lambda: 1, pairwise: [] }]);
    collector.recordFilter(handle, { name: 'dedup', outcome: 'pass' });
    collector.recordRerankerStage([handle], { outcome: 'baseline' });
    collector.recordFilter(handle, { name: 'token-budget', outcome: 'pass' });
    collector.recordTerminal(handle, { outcome: 'included', reasons: [] });
    collector.recordOutput(handle, 1);
    const previous = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator)!;
    let callbacks = 0;
    let failure: unknown;
    try {
      Reflect.defineProperty(Array.prototype, Symbol.iterator, {
        value: () => { callbacks += 1; throw new Error('hostile iterator must not run'); },
        configurable: true,
        writable: true,
      });
      try { collector.finalize(); } catch (error) { failure = error; }
    } finally {
      Reflect.defineProperty(Array.prototype, Symbol.iterator, previous);
    }
    expect(callbacks).toBe(0);
    expect(String(failure)).toMatch(/intrinsic integrity check failed/);
  });

  it('captures Map and Set methods through ranked-v2 record, finalize, validate, and replay', () => {
    const request: RetrievalTraceRequestShapeV1 = {
      ...rankedRequest, diversification: 'mmr', plannedChannels: ['memory.scope'],
    };
    const collector = new RetrievalTraceCollector('ranked-v2', request);
    collector.attemptChannel('memory.scope');
    collector.settleChannel('memory.scope', { outcome: 'success' });
    const handle = collector.addCandidate(candidate('memory.scope', 1));
    collector.recordFilter(handle, { name: 'mmr', outcome: 'pass' });
    collector.recordMmrRound(1, handle, [{ candidate: handle, relevance: 1, lambda: 1, pairwise: [] }]);
    collector.recordFilter(handle, { name: 'dedup', outcome: 'pass' });
    const mutations: Array<{ target: object; key: PropertyKey; previous: PropertyDescriptor | undefined }> = [
      { target: Map.prototype, key: 'get', previous: Object.getOwnPropertyDescriptor(Map.prototype, 'get') },
      { target: Map.prototype, key: 'set', previous: Object.getOwnPropertyDescriptor(Map.prototype, 'set') },
      { target: Set.prototype, key: 'has', previous: Object.getOwnPropertyDescriptor(Set.prototype, 'has') },
      { target: Set.prototype, key: 'add', previous: Object.getOwnPropertyDescriptor(Set.prototype, 'add') },
    ];
    let trace: RetrievalTraceV1 | undefined;
    let validation: string[] | undefined;
    let replay: ReturnType<typeof replayRetrievalTrace> | undefined;
    try {
      for (let index = 0; index < mutations.length; index += 1) {
        Reflect.defineProperty(mutations[index]!.target, mutations[index]!.key, {
          value: () => { throw new Error('hostile collection method must not run'); },
          configurable: true,
          writable: true,
        });
      }
      collector.recordRerankerStage([handle], {
        outcome: 'reranked', candidates: [{ candidateHandle: handle, calibratedScore: 1 }],
      });
      collector.recordFilter(handle, { name: 'token-budget', outcome: 'pass' });
      collector.recordTerminal(handle, { outcome: 'included', reasons: [] });
      collector.recordOutput(handle, 1);
      trace = collector.finalize();
      validation = validateRetrievalTrace(trace);
      replay = replayRetrievalTrace(trace);
    } finally {
      for (let index = mutations.length - 1; index >= 0; index -= 1) {
        Reflect.defineProperty(mutations[index]!.target, mutations[index]!.key, mutations[index]!.previous!);
      }
    }
    expect(validation).toEqual([]);
    expect(replay?.resultOrder).toEqual(trace?.resultOrder);
  });

  it('enforces generic 8192/8193 and top-level trace-event 8193/8194 bounds', () => {
    expect(() => canonicalTraceJson(Array.from({ length: 8192 }, () => null))).not.toThrow();
    expect(() => canonicalTraceJson(Array.from({ length: 8193 }, () => null))).toThrow(/hard limit/);
    expect(() => canonicalTraceJson({ events: Array.from({ length: 8193 }, () => null) })).not.toThrow();
    expect(() => canonicalTraceJson({ events: Array.from({ length: 8194 }, () => null) })).toThrow(/hard limit/);
  });

  it('accepts exactly 128 reranker candidates structurally and rejects 129 before replay work', () => {
    const atLimit = JSON.parse(JSON.stringify(buildRankedV2('baseline').trace)) as RetrievalTraceV1;
    const event = atLimit.events.find((item) => item.kind === 'reranker-stage');
    if (event?.kind !== 'reranker-stage' || event.outcome !== 'baseline') throw new Error('missing baseline event');
    (event as unknown as { candidates: unknown[] }).candidates = Array.from({ length: 128 }, (_, index) => ({
      ref: `c${String(index + 1).padStart(4, '0')}`,
      baselineRank: index + 1,
      rerankedRank: index + 1,
    }));
    atLimit.replayStateDigest = computeRetrievalTraceReplayStateDigest(atLimit);
    expect(validateRetrievalTrace(atLimit)).toEqual([]);

    const overLimit = JSON.parse(JSON.stringify(atLimit)) as RetrievalTraceV1;
    const overEvent = overLimit.events.find((item) => item.kind === 'reranker-stage');
    if (overEvent?.kind !== 'reranker-stage') throw new Error('missing reranker event');
    (overEvent.candidates as unknown as unknown[]).push({ ref: 'c0129', baselineRank: 129, rerankedRank: 129 });
    expect(validateRetrievalTrace(overLimit).join('; ')).toMatch(/hard limit/);
  });

  it('rejects tampered reranker rank/set/order and output echoes even with a recomputed digest', () => {
    const original = buildRankedV2().trace;
    const mutate = (change: (trace: RetrievalTraceV1) => void): RetrievalTraceV1 => {
      const copy = JSON.parse(JSON.stringify(original)) as RetrievalTraceV1;
      change(copy);
      copy.replayStateDigest = computeRetrievalTraceReplayStateDigest(copy);
      return copy;
    };
    const rank = mutate((trace) => {
      const event = trace.events.find((item) => item.kind === 'reranker-stage');
      if (event?.kind === 'reranker-stage') (event.candidates[0] as { rerankedRank: number }).rerankedRank = 2;
    });
    expect(() => replayRetrievalTrace(rank)).toThrow(RetrievalTraceValidationError);
    const echo = mutate((trace) => {
      const outputs = trace.events.filter((item) => item.kind === 'ranked-output');
      (outputs[0] as { ref: string }).ref = 'c0002';
      (outputs[1] as { ref: string }).ref = 'c0001';
    });
    expect(() => replayRetrievalTrace(echo)).toThrow(RetrievalTraceValidationError);
  });
  it('derives deterministic-v2 refs and outputs from the frozen algorithm order', () => {
    expect(RETRIEVAL_TRACE_DETERMINISTIC_OUTPUT_CHANNEL_ORDER_V2).toEqual([
      'arch.hierarchy', 'arch.entity', 'arch.dependency', 'arch.aspect', 'memory.graph',
    ]);
    const forward = buildDeterministicV2('forward');
    const reverse = buildDeterministicV2('reverse');
    expect(reverse).toEqual(forward);
    expect(forward.schemaVersion).toBe('1.0.0');
    expect(forward.algorithmVersion).toBe('deterministic-v2');
    expect(forward.candidates.map((item) => [item.ref, item.sourceType, item.channels[0]!.channel]))
      .toEqual([
        ['c0001', 'arch_entity', 'arch.hierarchy'],
        ['c0002', 'arch_entity', 'arch.entity'],
        ['c0003', 'arch_entity', 'arch.dependency'],
        ['c0004', 'aspect', 'arch.aspect'],
        ['c0005', 'semantic', 'memory.graph'],
      ]);
    expect(forward.resultOrder).toEqual(['c0001', 'c0002', 'c0004', 'c0005']);
    expect(forward.events.filter((event) => event.kind === 'deterministic-output'))
      .toEqual([
        { sequence: 18, kind: 'deterministic-output', ref: 'c0001', rank: 1 },
        { sequence: 19, kind: 'deterministic-output', ref: 'c0002', rank: 2 },
        { sequence: 20, kind: 'deterministic-output', ref: 'c0004', rank: 3 },
        { sequence: 21, kind: 'deterministic-output', ref: 'c0005', rank: 4 },
      ]);
    expect(replayRetrievalTrace(forward).resultOrder).toEqual(forward.resultOrder);
  });

  it('rejects caller output ordinals and closed deterministic-v2 provenance violations', () => {
    const collector = new RetrievalTraceCollector('deterministic-v2', deterministicV2Request);
    const entity = collector.addCandidate(deterministicV2Candidate('arch.entity'));
    expect(() => collector.recordOutput(entity, 1)).toThrow(/derived/);

    expect(() => collector.addCandidate({
      ...deterministicV2Candidate('arch.entity', 2),
      sourceType: 'semantic',
    })).toThrow(/source-final/);
    expect(() => collector.addCandidate({
      ...deterministicV2Candidate('arch.entity', 3),
      channels: [
        { channel: 'arch.entity', rank: 3 },
        { channel: 'arch.hierarchy', rank: 3 },
      ],
    })).toThrow(/one source-final channel/);
    expect(() => collector.recordMmrRound(1, entity, [])).toThrow(/does not support MMR/);
  });

  it('uses the deterministic-v2 total order for legacy planned-channel validation only', () => {
    const plannedChannels = [
      ...deterministicV2Request.plannedChannels,
      'memory.scope' as const,
      'code.fulltext' as const,
    ];
    const collector = new RetrievalTraceCollector('deterministic-v2', {
      ...deterministicV2Request,
      sources: { code: true, architecture: true, memory: true },
      plannedChannels,
    });
    for (const channel of plannedChannels) {
      collector.attemptChannel(channel);
      collector.settleChannel(channel, { outcome: 'success' });
    }
    expect(collector.finalize().requestShape.plannedChannels).toEqual(plannedChannels);
    expect(() => new RetrievalTraceCollector('deterministic-v2', {
      ...deterministicV2Request,
      plannedChannels: ['memory.graph', 'arch.entity'],
    })).toThrow(/not canonical/);
  });

  it('assigns refs by contiguous source-final rank rather than registration order', () => {
    const collector = new RetrievalTraceCollector('deterministic-v2', {
      ...deterministicV2Request,
      plannedChannels: ['arch.entity'],
    });
    collector.attemptChannel('arch.entity');
    collector.settleChannel('arch.entity', { outcome: 'success' });
    const second = collector.addCandidate(deterministicV2Candidate('arch.entity', 2));
    const first = collector.addCandidate(deterministicV2Candidate('arch.entity', 1));
    collector.recordTerminal(second, { outcome: 'included', reasons: [] });
    collector.recordTerminal(first, { outcome: 'included', reasons: [] });
    const trace = collector.finalize();
    expect(trace.candidates.map((item) => item.channels[0]!.rank)).toEqual([1, 2]);
    expect(trace.resultOrder).toEqual(['c0001', 'c0002']);
    expect(() => assertRetrievalTraceConformant(trace)).not.toThrow();
  });

  it('fails deterministic-v2 conformance on local-rank and derived-output tampering even with a new digest', () => {
    const gapCollector = new RetrievalTraceCollector('deterministic-v2', {
      ...deterministicV2Request,
      plannedChannels: ['arch.entity'],
    });
    gapCollector.attemptChannel('arch.entity');
    gapCollector.settleChannel('arch.entity', { outcome: 'success' });
    const gap = gapCollector.addCandidate(deterministicV2Candidate('arch.entity', 2));
    gapCollector.recordTerminal(gap, { outcome: 'included', reasons: [] });
    const gapTrace = gapCollector.finalize();
    expect(gapTrace.complete).toBe(false);
    expect(() => replayRetrievalTrace(gapTrace)).toThrow(/incomplete/);

    const tampered = structuredClone(buildDeterministicV2());
    const firstOutput = tampered.events.find((event) => event.kind === 'deterministic-output' && event.rank === 1);
    if (!firstOutput || firstOutput.kind !== 'deterministic-output') throw new Error('fixture missing deterministic output');
    firstOutput.ref = 'c0005';
    tampered.replayStateDigest = computeRetrievalTraceReplayStateDigest(tampered);
    expect(() => replayRetrievalTrace(tampered)).toThrow(/derived deterministic output/);
  });

  it('represents the exact deterministic no-match presentation as zero evidence candidates', () => {
    const collector = new RetrievalTraceCollector('deterministic-v2', {
      ...deterministicV2Request,
      sources: { code: false, architecture: true, memory: false },
      entityScope: 'none',
      plannedChannels: ['arch.fulltext'],
    });
    collector.attemptChannel('arch.fulltext');
    collector.settleChannel('arch.fulltext', { outcome: 'success' });
    const trace = collector.finalize();
    expect(trace).toMatchObject({ complete: true, candidates: [], resultOrder: [], terminalExclusions: [] });
    expect(replayRetrievalTrace(trace).resultOrder).toEqual([]);
  });

  it('freezes deterministic-v2 canonical JSON and digest across the Node 20/22 matrix', () => {
    const trace = buildDeterministicV2('reverse');
    expect(trace).toEqual(deterministicV2Fixture);
    expect(canonicalTraceJson(trace)).toBe(canonicalTraceJson(deterministicV2Fixture));
    expect(trace.replayStateDigest).toBe('sha256:744c26c828a761ab7568163662131d5674802341783d2687539c05f8110a2c2d');
    const rankedV1ForwardBytes = canonicalTraceJson(build('forward'));
    const rankedV1ReverseBytes = canonicalTraceJson(build('reverse'));
    expect(rankedV1ForwardBytes).toBe(rankedV1ReverseBytes);
    expect(JSON.parse(rankedV1ForwardBytes)).toEqual(build('forward'));
    expect(rankedV1ForwardBytes).toHaveLength(2198);
    expect(createHash('sha256').update(rankedV1ForwardBytes).digest('hex'))
      .toBe('b9fbc794a32bbd8e3cbb4d0147d26c4fe255f8eaa32394609dd2abaa3c5edaee');
    expect(build().replayStateDigest)
      .toBe('sha256:1cd91a9926a28949a35adfd0c4183a831cac25d2fcd230307463d3027a09a7db');
  });

  it('derives refs and ordered events without caller IDs, ordinals, or async arrival order', () => {
    const forward = build('forward');
    const reverse = build('reverse');

    expect(forward).toEqual(reverse);
    expect(forward.schemaVersion).toBe(RETRIEVAL_TRACE_VERSION);
    expect(forward.complete).toBe(true);
    expect(forward.candidates.map((item) => [item.ref, item.channels[0]!.channel, item.channels[0]!.rank]))
      .toEqual([
        ['c0001', 'memory.scope', 1],
        ['c0002', 'memory.semantic-vector', 2],
      ]);
    expect(forward.events.map((event) => event.sequence))
      .toEqual(forward.events.map((_, index) => index + 1));
    expect(canonicalTraceJson(forward)).not.toContain('stableOrdinal');
  });

  it('replays ranked output and terminal exclusions from events, not materialized echoes', () => {
    const collector = new RetrievalTraceCollector('ranked-v1', rankedRequest);
    settleChannels(collector);
    const included = addIncluded(collector, candidate('memory.scope', 1), 1, 0.91);
    const duplicate = collector.addCandidate(candidate('memory.semantic-vector', 2));
    collector.recordFilter(duplicate, { name: 'dedup', outcome: 'fail' });
    collector.recordScore(duplicate, { name: 'final', value: 0.81 });
    collector.recordTerminal(duplicate, {
      outcome: 'excluded',
      reasons: ['duplicate'],
      duplicateOf: included,
    });
    const trace = collector.finalize();

    expect(replayRetrievalTrace(trace)).toEqual({
      resultOrder: ['c0001'],
      terminalExclusions: [{
        ref: 'c0002',
        outcome: 'excluded',
        reasons: ['duplicate'],
        duplicateOfRef: 'c0001',
      }],
      replayStateDigest: trace.replayStateDigest,
    });

    const echoTamper = structuredClone(trace);
    echoTamper.resultOrder = ['c0002'];
    // The digest intentionally covers event state rather than trusting output echoes.
    expect(echoTamper.replayStateDigest).toBe(computeRetrievalTraceReplayStateDigest(echoTamper));
    expect(() => replayRetrievalTrace(echoTamper)).toThrow(/resultOrder/);
  });

  it('accounts for every planned channel with success or safe failure', () => {
    const collector = new RetrievalTraceCollector('ranked-v1', rankedRequest);
    collector.attemptChannel('memory.scope');
    collector.settleChannel('memory.scope', { outcome: 'success' });
    collector.attemptChannel('memory.semantic-vector');
    collector.settleChannel('memory.semantic-vector', { outcome: 'safe-failure', code: 'unavailable' });
    const trace = collector.finalize();

    expect(trace.complete).toBe(true);
    expect(trace.events.filter((event) => event.kind === 'channel-terminal')).toEqual([
      expect.objectContaining({ channel: 'memory.scope', outcome: 'success' }),
      expect.objectContaining({ channel: 'memory.semantic-vector', outcome: 'safe-failure', code: 'unavailable' }),
    ]);
    expect(() => assertRetrievalTraceConformant(trace)).not.toThrow();
  });

  it('marks gaps and overflows incomplete and makes conformance fail closed', () => {
    const gap = new RetrievalTraceCollector('ranked-v1', rankedRequest);
    gap.attemptChannel('memory.scope');
    gap.settleChannel('memory.scope', { outcome: 'success' });
    gap.addCandidate(candidate('memory.scope', 1));
    const incomplete = gap.finalize();
    expect(incomplete.complete).toBe(false);
    expect(incomplete.incompleteReasons).toEqual(expect.arrayContaining(['channel-gap', 'candidate-terminal-gap']));
    expect(() => assertRetrievalTraceConformant(incomplete)).toThrow(/incomplete/);
    expect(() => replayRetrievalTrace(incomplete)).toThrow(/incomplete/);

    const overflow = new RetrievalTraceCollector('ranked-v1', rankedRequest, { maxCandidates: 1 });
    overflow.addCandidate(candidate('memory.scope', 1));
    expect(() => overflow.addCandidate(candidate('memory.semantic-vector', 2))).toThrow(RetrievalTraceLimitError);
    const overflowTrace = overflow.finalize();
    expect(overflowTrace).toMatchObject({ complete: false });
    expect(overflowTrace.incompleteReasons).toContain('limit-overflow');
  });

  it('requires exactly one terminal event and a complete output settlement per candidate', () => {
    const collector = new RetrievalTraceCollector('ranked-v1', rankedRequest);
    settleChannels(collector);
    const handle = addIncluded(collector, candidate('memory.scope', 1), 1, 0.9);
    expect(() => collector.recordTerminal(handle, { outcome: 'included', reasons: [] }))
      .toThrow(RetrievalTraceValidationError);
    const trace = collector.finalize();
    expect(trace.complete).toBe(false);
    expect(trace.incompleteReasons).toContain('candidate-terminal-conflict');
    expect(() => assertRetrievalTraceConformant(trace)).toThrow();
  });

  it('records complete per-round MMR state and independently validates selection objectives', () => {
    const request: RetrievalTraceRequestShapeV1 = {
      ...rankedRequest,
      diversification: 'mmr',
      plannedChannels: ['memory.scope'],
    };
    const collector = new RetrievalTraceCollector('ranked-v1', request);
    collector.attemptChannel('memory.scope');
    collector.settleChannel('memory.scope', { outcome: 'success' });
    const a = collector.addCandidate(candidate('memory.scope', 1));
    const b = collector.addCandidate(candidate('memory.scope', 2));
    const c = collector.addCandidate(candidate('memory.scope', 3));
    collector.recordFilter(a, { name: 'mmr', outcome: 'pass' });
    collector.recordFilter(b, { name: 'mmr', outcome: 'pass' });
    collector.recordFilter(c, { name: 'mmr', outcome: 'fail' });
    collector.recordMmrRound(1, a, [
      { candidate: a, relevance: 0.9, lambda: 0.7, pairwise: [] },
      { candidate: b, relevance: 0.8, lambda: 0.7, pairwise: [] },
      { candidate: c, relevance: 0.7, lambda: 0.7, pairwise: [] },
    ]);
    collector.recordMmrRound(2, b, [
      { candidate: b, relevance: 0.8, lambda: 0.7, pairwise: [{ selected: a, similarity: 0.2 }] },
      { candidate: c, relevance: 0.7, lambda: 0.7, pairwise: [{ selected: a, similarity: 0.3 }] },
    ]);
    collector.recordOutput(a, 1);
    collector.recordTerminal(a, { outcome: 'included', reasons: [] });
    collector.recordOutput(b, 2);
    collector.recordTerminal(b, { outcome: 'included', reasons: [] });
    collector.recordTerminal(c, { outcome: 'excluded', reasons: ['mmr-diversification'] });
    const trace = collector.finalize();
    expect(trace.complete).toBe(true);
    expect(replayRetrievalTrace(trace).resultOrder).toEqual(['c0001', 'c0002']);

    const missingEligible = structuredClone(trace);
    const round = missingEligible.events.find((event) => event.kind === 'mmr-round' && event.round === 1);
    if (!round || round.kind !== 'mmr-round') throw new Error('fixture missing MMR round');
    round.records.pop();
    missingEligible.replayStateDigest = computeRetrievalTraceReplayStateDigest(missingEligible);
    expect(() => replayRetrievalTrace(missingEligible)).toThrow(/MMR eligible set/);

    const badObjective = structuredClone(trace);
    const badRound = badObjective.events.find((event) => event.kind === 'mmr-round');
    if (!badRound || badRound.kind !== 'mmr-round') throw new Error('fixture missing MMR round');
    badRound.records[0]!.objective = 0.62;
    badObjective.replayStateDigest = computeRetrievalTraceReplayStateDigest(badObjective);
    expect(() => replayRetrievalTrace(badObjective)).toThrow(/MMR objective/);

    const pairwiseTamper = structuredClone(trace);
    const secondRound = pairwiseTamper.events.find((event) => event.kind === 'mmr-round' && event.round === 2);
    if (!secondRound || secondRound.kind !== 'mmr-round') throw new Error('fixture missing second MMR round');
    secondRound.records[0]!.pairwise[0]!.similarity = 0.1;
    pairwiseTamper.replayStateDigest = computeRetrievalTraceReplayStateDigest(pairwiseTamper);
    expect(() => replayRetrievalTrace(pairwiseTamper)).toThrow(/maxSimilarity/);

    const pairwiseGap = structuredClone(trace);
    const gapRound = pairwiseGap.events.find((event) => event.kind === 'mmr-round' && event.round === 2);
    if (!gapRound || gapRound.kind !== 'mmr-round') throw new Error('fixture missing second MMR round');
    gapRound.records[0]!.pairwise = [];
    pairwiseGap.replayStateDigest = computeRetrievalTraceReplayStateDigest(pairwiseGap);
    expect(() => replayRetrievalTrace(pairwiseGap)).toThrow(/pairwise coverage/);
  });

  it('binds every failed filter to its closed exclusion reason in both directions', () => {
    const mappings = [
      ['source-enabled', 'source-disabled'], ['tenant', 'tenant-policy'], ['project', 'project-scope'],
      ['entity', 'entity-scope'], ['tag', 'tag-scope'], ['temporal', 'temporal-filter'],
      ['language', 'language-filter'], ['kind', 'kind-filter'], ['dedup', 'duplicate'],
      ['candidate-window', 'candidate-window'], ['limit', 'result-limit'],
      ['token-budget', 'token-budget'],
    ] as const;
    for (const [filter, reason] of mappings) {
      const collector = new RetrievalTraceCollector('ranked-v1', { ...rankedRequest, plannedChannels: ['memory.scope'] });
      collector.attemptChannel('memory.scope');
      collector.settleChannel('memory.scope', { outcome: 'success' });
      const target = collector.addCandidate(candidate('memory.scope', 1));
      collector.recordFilter(target, { name: filter, outcome: 'fail' });
      if (filter === 'dedup') {
        const original = collector.addCandidate(candidate('memory.scope', 2));
        collector.recordScore(original, { name: 'final', value: 0.9 });
        collector.recordOutput(original, 1);
        collector.recordTerminal(original, { outcome: 'included', reasons: [] });
        collector.recordTerminal(target, { outcome: 'excluded', reasons: [reason], duplicateOf: original });
      } else {
        collector.recordTerminal(target, { outcome: 'excluded', reasons: [reason] });
      }
      expect(() => replayRetrievalTrace(collector.finalize()), `${filter} -> ${reason}`).not.toThrow();
    }

    const included = structuredClone(build());
    const includedTerminal = included.events.find((event) => event.kind === 'candidate-terminal' && event.outcome === 'included');
    if (!includedTerminal || includedTerminal.kind !== 'candidate-terminal') throw new Error('fixture missing terminal');
    const includedFilter = included.events.find((event) => event.kind === 'candidate-filter'
      && event.ref === includedTerminal.ref && event.name === 'tenant');
    if (!includedFilter || includedFilter.kind !== 'candidate-filter') throw new Error('fixture missing included filter');
    includedFilter.outcome = 'fail';
    included.replayStateDigest = computeRetrievalTraceReplayStateDigest(included);
    expect(() => replayRetrievalTrace(included)).toThrow(/included candidate has failed filters/);

    const missingReason = structuredClone(build());
    const target = missingReason.events.find((event) => event.kind === 'candidate-filter' && event.name === 'tenant');
    if (!target || target.kind !== 'candidate-filter') throw new Error('fixture missing filter');
    target.outcome = 'fail';
    missingReason.replayStateDigest = computeRetrievalTraceReplayStateDigest(missingReason);
    expect(() => replayRetrievalTrace(missingReason)).toThrow(/failed filter is missing/);

    const reverse = new RetrievalTraceCollector('ranked-v1', { ...rankedRequest, plannedChannels: ['memory.scope'] });
    reverse.attemptChannel('memory.scope');
    reverse.settleChannel('memory.scope', { outcome: 'success' });
    const original = addIncluded(reverse, candidate('memory.scope', 1), 1, 0.9);
    const copy = reverse.addCandidate(candidate('memory.scope', 2));
    reverse.recordFilter(copy, { name: 'dedup', outcome: 'fail' });
    reverse.recordTerminal(copy, { outcome: 'excluded', reasons: ['duplicate'], duplicateOf: original });
    const unmatchedReason = structuredClone(reverse.finalize());
    const dedup = unmatchedReason.events.find((event) => event.kind === 'candidate-filter' && event.name === 'dedup');
    if (!dedup || dedup.kind !== 'candidate-filter') throw new Error('fixture missing dedup filter');
    dedup.outcome = 'pass';
    unmatchedReason.replayStateDigest = computeRetrievalTraceReplayStateDigest(unmatchedReason);
    expect(() => replayRetrievalTrace(unmatchedReason)).toThrow(/no matching failed filter/);
  });

  it('uses algorithm-specific replay instead of accepting the other output event kind', () => {
    const ranked = build();
    const tampered = structuredClone(ranked);
    const output = tampered.events.find((event) => event.kind === 'ranked-output');
    if (!output || output.kind !== 'ranked-output') throw new Error('fixture missing ranked output');
    (output as { kind: string }).kind = 'deterministic-output';
    tampered.replayStateDigest = computeRetrievalTraceReplayStateDigest(tampered);
    expect(() => replayRetrievalTrace(tampered)).toThrow(/algorithm/);

    const request: RetrievalTraceRequestShapeV1 = {
      ...rankedRequest,
      diversification: 'none',
      plannedChannels: ['memory.scope'],
    };
    const deterministic = new RetrievalTraceCollector('deterministic-v1', request);
    deterministic.attemptChannel('memory.scope');
    deterministic.settleChannel('memory.scope', { outcome: 'success' });
    const second = deterministic.addCandidate(candidate('memory.scope', 2));
    const first = deterministic.addCandidate(candidate('memory.scope', 1));
    deterministic.recordOutput(first, 1);
    deterministic.recordTerminal(first, { outcome: 'included', reasons: [] });
    deterministic.recordOutput(second, 2);
    deterministic.recordTerminal(second, { outcome: 'included', reasons: [] });
    expect(replayRetrievalTrace(deterministic.finalize()).resultOrder).toEqual(['c0001', 'c0002']);
  });

  it('rejects reordered stage events even when sequence and digest are recomputed', () => {
    const trace = structuredClone(build());
    [trace.events[0], trace.events[1]] = [trace.events[1]!, trace.events[0]!];
    trace.events.forEach((event, index) => { event.sequence = index + 1; });
    trace.replayStateDigest = computeRetrievalTraceReplayStateDigest(trace);
    expect(() => replayRetrievalTrace(trace)).toThrow(/canonical replay order/);
  });

  it('enforces semantic numeric bounds and coarse request shape', () => {
    expect(roundTraceNumber(0.123456789)).toBe(0.123457);
    expect(() => roundTraceNumber(1e300)).toThrow(RetrievalTraceValidationError);
    expect(() => roundTraceNumber(Number.POSITIVE_INFINITY)).toThrow(RetrievalTraceValidationError);

    const collector = new RetrievalTraceCollector('ranked-v1', rankedRequest);
    const draft = candidate('memory.scope', 1);
    draft.channels = [{ channel: 'memory.scope', rank: 1, score: 2 }];
    expect(() => collector.addCandidate(draft)).toThrow(/score/);
    expect(canonicalTraceJson(rankedRequest)).not.toMatch(/tokenCount|averageTokenLength|identifierDensity/);

    const highPrecision = structuredClone(build());
    const score = highPrecision.events.find((event) => event.kind === 'candidate-score');
    if (!score || score.kind !== 'candidate-score') throw new Error('fixture missing score');
    score.value = 0.1234567;
    expect(validateRetrievalTrace(highPrecision).some((error) => error.includes('must be canonically rounded'))).toBe(true);
  });

  it('rejects prototype ambiguity, sparse arrays, accessors, and unknown nested fields', () => {
    const parsed = JSON.parse('{"__proto__":{"polluted":true},"safe":1}') as unknown;
    expect(() => canonicalTraceJson(parsed)).toThrow(/dangerous/);
    expect(canonicalTraceJson({ safe: 1 })).toBe('{"safe":1}');

    const sparse = new Array(2);
    sparse[1] = 'x';
    expect(() => canonicalTraceJson(sparse)).toThrow(/sparse/);
    const accessor = Object.defineProperty({}, 'secret', { enumerable: true, get: () => 'value' });
    expect(() => canonicalTraceJson(accessor)).toThrow(/accessor/);

    const trace = build();
    const nested = structuredClone(trace) as unknown as { candidates: Array<Record<string, unknown>> };
    nested.candidates[0]!.rawId = 'db-123';
    expect(validateRetrievalTrace(nested)).toContain('trace.candidates[0] has unknown fields');
    const huge = structuredClone(trace) as unknown as { candidates: Array<{ channels: Array<{ score?: number }> }> };
    huge.candidates[0]!.channels[0]!.score = 1e300;
    expect(() => validateRetrievalTrace(huge)).not.toThrow();
    expect(validateRetrievalTrace(huge).length).toBeGreaterThan(0);
  });

  it('never executes candidate-field or event-element accessors', () => {
    let candidateReads = 0;
    const hostileCandidate = { ...candidate('memory.scope', 1) };
    Object.defineProperty(hostileCandidate, 'channels', {
      enumerable: true,
      get: () => { candidateReads++; return []; },
    });
    const collector = new RetrievalTraceCollector('ranked-v1', rankedRequest);
    expect(() => collector.addCandidate(hostileCandidate)).toThrow(/accessor/);
    expect(candidateReads).toBe(0);

    let eventReads = 0;
    const hostileTrace = structuredClone(build());
    Object.defineProperty(hostileTrace.events, 0, {
      enumerable: true,
      get: () => { eventReads++; return {}; },
    });
    expect(validateRetrievalTrace(hostileTrace)).toContain('trace contains accessor fields');
    expect(eventReads).toBe(0);
  });

  it('rejects oversized, shared, and cyclic structures in the shallow aggregate preflight', () => {
    const oversized = structuredClone(build());
    const hugeEvents: unknown[] = [];
    hugeEvents.length = 134_000_000;
    oversized.events = hugeEvents as typeof oversized.events;
    expect(validateRetrievalTrace(oversized)).toContain('trace exceeds aggregate array budget');

    const shared = structuredClone(build());
    shared.candidates[1]!.evidence = shared.candidates[0]!.evidence;
    expect(validateRetrievalTrace(shared)).toContain('trace contains shared or cyclic references');

    const cyclic = structuredClone(build()) as typeof shared & { cycle?: unknown };
    cyclic.cycle = cyclic;
    expect(validateRetrievalTrace(cyclic)).toContain('trace contains shared or cyclic references');

    const oversizedBytes = structuredClone(build()) as ReturnType<typeof build> & { padding?: string };
    oversizedBytes.padding = 'x'.repeat(4_300_000);
    expect(validateRetrievalTrace(oversizedBytes)).toContain('trace exceeds aggregate byte budget');
  });

  it('rejects aggregate scalar overflows before avoidable UTF-8 measurement at every public boundary', async () => {
    const originalByteLength = NodeBuffer.byteLength;
    let target = '';
    let targetScans = 0;
    NodeBuffer.byteLength = ((
      input: Parameters<typeof NodeBuffer.byteLength>[0],
      encoding?: BufferEncoding,
    ): number => {
      if (input === target) targetScans += 1;
      return originalByteLength(input, encoding);
    }) as typeof NodeBuffer.byteLength;
    vi.resetModules();
    try {
      const dynamicTrace = await import('../trace.js');

      target = 'safe';
      targetScans = 0;
      expect(dynamicTrace.canonicalTraceJson({ safe: 1 })).toBe('{"safe":1}');
      expect(targetScans).toBeGreaterThan(0);

      const expectAggregateFailure = (input: unknown, expectedScans: number): void => {
        targetScans = 0;
        expect(dynamicTrace.validateRetrievalTrace(input)).toEqual([
          'trace exceeds aggregate byte budget',
        ]);
        expect(targetScans).toBe(expectedScans);

        for (const boundary of [
          () => dynamicTrace.canonicalTraceJson(input),
          () => dynamicTrace.replayRetrievalTrace(input),
        ]) {
          targetScans = 0;
          let thrown: unknown;
          let returned: unknown;
          try {
            returned = boundary();
          } catch (error) {
            thrown = error;
          }
          expect(returned).toBeUndefined();
          expect(thrown).toMatchObject({
            name: 'RetrievalTraceValidationError',
            message: 'trace exceeds aggregate byte budget',
          });
          expect(targetScans).toBe(expectedScans);
        }
      };

      target = 'k'.repeat(4_194_304);
      const hostileKey = Object.create(null) as Record<string, unknown>;
      Object.defineProperty(hostileKey, 'x', { value: null, enumerable: true });
      Object.defineProperty(hostileKey, target, { value: null, enumerable: true });
      expectAggregateFailure(hostileKey, 0);

      target = 'v'.repeat(4_194_304);
      expectAggregateFailure({ padding: target }, 0);

      target = 'q'.repeat(4_194_304);
      expectAggregateFailure([null, target], 1);

      target = 'é'.repeat(2_097_152);
      expectAggregateFailure({ padding: target }, 1);
    } finally {
      NodeBuffer.byteLength = originalByteLength;
      vi.resetModules();
    }
  });

  it('accepts the exact default 128-candidate, eight-round MMR envelope', () => {
    const request: RetrievalTraceRequestShapeV1 = {
      ...rankedRequest,
      diversification: 'mmr',
      plannedChannels: ['memory.scope'],
    };
    const collector = new RetrievalTraceCollector('ranked-v1', request);
    collector.attemptChannel('memory.scope');
    collector.settleChannel('memory.scope', { outcome: 'success' });
    const handles = Array.from({ length: 128 }, (_, index) =>
      collector.addCandidate(candidate('memory.scope', index + 1)));
    handles.forEach((handle, index) => {
      collector.recordFilter(handle, { name: 'mmr', outcome: index < 8 ? 'pass' : 'fail' });
    });
    for (let round = 1; round <= 8; round++) {
      const prior = handles.slice(0, round - 1);
      collector.recordMmrRound(round, handles[round - 1]!, handles.slice(round - 1).map((handle, index) => ({
        candidate: handle,
        relevance: roundTraceNumber(1 - (index + round - 1) / 1000),
        lambda: 0.7,
        pairwise: prior.map((selected, selectedIndex) => ({
          selected,
          similarity: roundTraceNumber(0.1 + selectedIndex / 100),
        })),
      })));
    }
    handles.forEach((handle, index) => {
      if (index < 8) {
        collector.recordOutput(handle, index + 1);
        collector.recordTerminal(handle, { outcome: 'included', reasons: [] });
      } else {
        collector.recordTerminal(handle, { outcome: 'excluded', reasons: ['mmr-diversification'] });
      }
    });

    const trace = collector.finalize();
    const mmrRecords = trace.events.filter((event) => event.kind === 'mmr-round')
      .reduce((sum, event) => sum + event.records.length, 0);
    const pairwise = trace.events.filter((event) => event.kind === 'mmr-round')
      .reduce((sum, event) => sum + event.records.reduce((inner, record) => inner + record.pairwise.length, 0), 0);
    expect({ candidates: trace.candidates.length, events: trace.events.length, mmrRecords, pairwise })
      .toEqual({ candidates: 128, events: 274, mmrRecords: 996, pairwise: 3444 });
    expect(trace.complete).toBe(true);
    expect(validateRetrievalTrace(trace)).toEqual([]);
    expect(replayRetrievalTrace(trace).resultOrder).toHaveLength(8);
  }, 10_000);

  it('rejects raw content and recognized secret shapes without reflecting them in errors', () => {
    const trace = build();
    const credential = ['sk', 'live', '1234567890abcdefgh'].join('_');
    const hostile = { ...trace, query: `use ${credential}` };
    const errors = validateRetrievalTrace(hostile);
    expect(errors).toContain('trace has unknown fields');
    expect(errors.join(' ')).not.toContain(credential);
    expect(() => assertRetrievalTraceSecretSafe(hostile)).toThrow(RetrievalTraceValidationError);

    expect(() => new RetrievalTraceCollector('ranked-v1', { ...rankedRequest, query: credential } as RetrievalTraceRequestShapeV1))
      .toThrow(/unknown fields/);
    const collector = new RetrievalTraceCollector('ranked-v1', rankedRequest);
    expect(() => collector.addCandidate({ ...candidate('memory.scope', 1), rawId: 123 } as RetrievalTraceCandidateDraft))
      .toThrow(/unknown fields/);
  });

  it('freezes a Node 20/22 deterministic, JSON-roundtrippable replay fixture', () => {
    const trace = build('reverse');
    expect(validateRetrievalTrace(trace)).toEqual([]);
    expect(canonicalTraceJson(trace)).toBe(canonicalTraceJson(JSON.parse(JSON.stringify(trace))));
    expect(trace.replayStateDigest).toBe('sha256:1cd91a9926a28949a35adfd0c4183a831cac25d2fcd230307463d3027a09a7db');
  });
});
