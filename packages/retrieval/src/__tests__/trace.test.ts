import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

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
  });

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
