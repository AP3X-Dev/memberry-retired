import { describe, expect, it } from 'vitest';

import { RankedRuntimeTraceAdapter } from '../runtime-trace.js';
import { SERVED_RERANKER_PROVIDER_IDENTITY, createRerankerProviderV1, type RerankerProviderV1 } from '../index.js';
import { parseSerializedRerankerProviderRequestV1, serializeRerankerProviderResponseV1 } from '../reranker.js';
import { applyServedRerankerV1 } from '../served-reranker.js';
import type { RetrievalResult } from '../types.js';

// Live repro 2026-09-04 (deployed 7538337, rq-s-03 / rq-e-05 / rq-f-03 with
// include_trace full): the RET-Q-004 pin moves a demoted episodic
// `architecture` head back to position 0. The ranked-v2 trace collector
// rejects that order as non-canonical, the runtime adapter swallows the
// rejection, and finalize() then throws the raw validator string
// `trace reranker stage count disagrees with algorithm` straight to the MCP
// client. Fixed by serving the pin as a calibrated-score override to the head
// (served-reranker.ts) and by keeping the adapter's public failure value-free
// (runtime-trace.ts). This file pins the control, the fixed pin, and the
// value-free failure.

function exactProvider(scores: readonly number[]): RerankerProviderV1 {
  return createRerankerProviderV1(SERVED_RERANKER_PROVIDER_IDENTITY, async (serialized) => {
    const request = parseSerializedRerankerProviderRequestV1(serialized);
    return serializeRerankerProviderResponseV1(request, SERVED_RERANKER_PROVIDER_IDENTITY, scores);
  });
}

function fixture(): { baseline: RetrievalResult[]; adapter: RankedRuntimeTraceAdapter } {
  const head: RetrievalResult = {
    id: 'private-episode-head', source_type: 'episodic', title: 'architecture', content: 'head evidence',
    score: 1, metadata: {},
  };
  const baseline: RetrievalResult[] = [
    head,
    ...Array.from({ length: 12 }, (_, index): RetrievalResult => ({
      id: `private-lexical-${index}`, source_type: 'semantic', title: `match ${index}`, content: 'lexical evidence',
      score: 0.5, metadata: {},
    })),
  ];
  const observations = [{
    channels: [{ channel: 'memory.scope' as const, outcome: 'success' as const }],
    candidates: baseline.map((item, index) => ({
      privateId: item.id,
      sourceType: item.source_type,
      channels: [{ channel: 'memory.scope' as const, rank: index + 1, score: item.score }],
      evidence: {},
      estimatedTokens: 4,
    })),
    finalIds: baseline.map((item) => item.id),
  }];
  const facts = {
    includeCode: false,
    includeArchitecture: false,
    includeMemory: true,
    projectScopeApplied: true,
    projectNameApplied: true,
    memoryScopeApplied: true,
    namedTenant: false,
    entityCount: 1,
    tagCount: 0,
    temporalFilterApplied: false,
    query: 'match',
    maxTokens: 1_000,
  };
  const adapter = new RankedRuntimeTraceAdapter(observations, [baseline], facts, [], 'ranked-v2');
  baseline.forEach((item) => {
    adapter.candidateWindow(item, true);
    adapter.finalScore(item, item.score);
  });
  // The collector requires the reranker baseline to equal the MMR-selected
  // order, so select every candidate in baseline order.
  baseline.forEach((item, index) => {
    const chosen = baseline.slice(0, index);
    adapter.mmr({
      round: index + 1,
      selected: item,
      lambda: 1,
      records: baseline.slice(index).map((candidate, offset) => ({
        candidate,
        relevance: 1 - (index + offset) * 0.01,
        pairwise: chosen.map((selected) => ({ selected, similarity: 0 })),
      })),
    });
  });
  adapter.recordDedup(baseline.map((item) => item.id), baseline.map((item) => item.id));
  return { baseline, adapter };
}

// Lexical provider demotes the vector head to the tail: baseline rank 1, reranked rank 13.
const DEMOTING_SCORES = [0.1, 1, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5, 0.45];

async function finalizeWithPin(preserveBaselineEpisodicHead: boolean) {
  const { baseline, adapter } = fixture();
  const outcome = await applyServedRerankerV1('match', baseline, exactProvider(DEMOTING_SCORES), {
    preserveBaselineEpisodicHead,
  });
  expect(outcome.outcome).toBe('reranked');
  adapter.recordReranker(baseline, outcome);
  adapter.recordBudget(outcome.results.map((item) => item.id));
  return { trace: adapter.finalize(), outcome };
}

describe('RET-Q-004 pin on the ranked-v2 runtime trace', () => {
  it('control: an unpinned served rerank finalizes a complete trace with one reranker stage', async () => {
    const { trace, outcome } = await finalizeWithPin(false);
    expect(trace.events.filter((event) => event.kind === 'reranker-stage')).toHaveLength(1);
    expect(trace.incompleteReasons).toEqual([]);
    expect(trace.complete).toBe(true);
    expect(outcome.results[0]!.id).toBe('private-lexical-0');
  });

  it('the pinned head is served as a score override and the trace stays complete', async () => {
    const { trace, outcome } = await finalizeWithPin(true);
    expect(trace.incompleteReasons).toEqual([]);
    expect(trace.complete).toBe(true);
    const stages = trace.events.filter((event) => event.kind === 'reranker-stage');
    expect(stages).toHaveLength(1);
    const stage = stages[0]!;
    if (stage.kind !== 'reranker-stage' || stage.outcome !== 'reranked') throw new Error('expected reranked stage');
    const head = stage.candidates.find((candidate) => candidate.baselineRank === 1)!;
    expect(head.rerankedRank).toBe(1);
    expect(head.calibratedScore).toBe(1);
    expect(outcome.results.map((item) => item.id).slice(0, 2)).toEqual(['private-episode-head', 'private-lexical-0']);
    expect(outcome.results[0]!.score).toBe(1);
    expect(trace.resultOrder[0]).toBe(head.ref);
  });

  it('a failure swallowed by the adapter surfaces as the value-free public error', async () => {
    const { baseline, adapter } = fixture();
    const outcome = await applyServedRerankerV1('match', baseline, exactProvider(DEMOTING_SCORES));
    // Baseline handed to the reranker stage disagrees with the recorded dedup order.
    adapter.recordReranker([...baseline].reverse(), outcome);
    adapter.recordBudget(outcome.results.map((item) => item.id));
    let message = '';
    try { adapter.finalize(); } catch (error) { message = String((error as Error).message); }
    expect(message).toBe('Retrieval trace validation failed');
  });
});
