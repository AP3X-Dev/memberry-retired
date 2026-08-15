import type { RankedFusionObserver } from './fusion.js';
import type { RankedMmrObservation } from './scoring.js';
import {
  RetrievalTraceCollector,
  type RetrievalTraceCandidateHandle,
  type RetrievalTraceChannel,
  type RetrievalTraceFailureCode,
  type RetrievalTraceRequestShapeV1,
  type RetrievalTraceV1,
  type RetrievalTraceScoreName,
  type RetrievalTraceFailureStage,
  type RetrievalTraceIncompleteReason,
} from './trace.js';
import type { RetrievalResult } from './types.js';

export type RuntimeStructuralChannel = RetrievalTraceChannel;
export type RuntimeStructuralChannelObservation =
  | { channel: RuntimeStructuralChannel; outcome: 'success' }
  | { channel: RuntimeStructuralChannel; outcome: 'safe-failure'; code: RetrievalTraceFailureCode };
export interface RuntimeStructuralCandidateObservation {
  privateId: string;
  sourceType: 'semantic' | 'episodic' | 'symbol' | 'arch_entity' | 'aspect' | 'fact' | 'block';
  channels: Array<{ channel: RuntimeStructuralChannel; rank: number; score?: number }>;
  evidence: { confidence?: number; sourceCount?: number; superseded?: boolean; invalidated?: boolean };
  estimatedTokens: number;
}
export interface RuntimeStructuralObservation {
  channels: RuntimeStructuralChannelObservation[];
  candidates: RuntimeStructuralCandidateObservation[];
  finalIds: string[];
}
export interface RuntimeObserved<T> { value: T; observation: RuntimeStructuralObservation }

const CHANNEL_ORDER: readonly RetrievalTraceChannel[] = [
  'memory.scope', 'memory.semantic-vector', 'memory.episodic-vector', 'memory.fact', 'memory.block', 'memory.graph',
  'code.fulltext', 'code.lexical-vector', 'code.dense-vector', 'code.semantic-vector', 'arch.fulltext',
];

export interface RankedTraceRequestFacts {
  includeCode: boolean;
  includeArchitecture: boolean;
  includeMemory: boolean;
  projectScopeApplied: boolean;
  projectNameApplied: boolean;
  memoryScopeApplied: boolean;
  namedTenant: boolean;
  entityCount: number;
  tagCount: number;
  temporalFilterApplied: boolean;
  query: string;
  maxTokens: number;
}

function cardinality(value: number): 'none' | 'one' | 'few' | 'many' {
  return value === 0 ? 'none' : value === 1 ? 'one' : value <= 4 ? 'few' : 'many';
}

function queryLength(query: string): RetrievalTraceRequestShapeV1['queryLength'] {
  const count = query.trim() ? query.trim().split(/\s+/).length : 0;
  return count === 0 ? 'empty' : count <= 4 ? 'short' : count <= 16 ? 'medium' : 'long';
}

function queryForm(query: string): RetrievalTraceRequestShapeV1['queryForm'] {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  const identifiers = tokens.filter((token) => /[_./:\\-]|[a-z][A-Z]|^[A-Z]{2,}$/.test(token)).length;
  if (identifiers === 0) return 'natural-language';
  return identifiers === tokens.length ? 'identifier-heavy' : 'mixed';
}

function tokenBudget(value: number): RetrievalTraceRequestShapeV1['tokenBudget'] {
  return value <= 2_000 ? 'small' : value <= 8_000 ? 'medium' : value <= 16_000 ? 'large' : 'very-large';
}

function sourceType(value: RetrievalResult['source_type']) {
  return value;
}

/**
 * Translates private in-process source observations into the content-free A
 * collector. Raw IDs are retained only as Map keys and can never reach output.
 */
export class RankedRuntimeTraceAdapter implements RankedFusionObserver {
  private readonly collector: RetrievalTraceCollector;
  private readonly handles = new Map<string, RetrievalTraceCandidateHandle>();
  private readonly candidates = new Map<string, RetrievalResult>();
  private readonly window = new Map<string, boolean>();
  private readonly selected = new Set<string>();
  private readonly budgeted = new Set<string>();
  private budgetedOrder: string[] = [];
  private failed = false;

  constructor(
    observations: readonly RuntimeStructuralObservation[],
    lists: readonly RetrievalResult[][],
    facts: RankedTraceRequestFacts,
    incompleteReasons: readonly RetrievalTraceIncompleteReason[] = [],
  ) {
    const plannedChannels = [...new Set(observations.flatMap((observation) =>
      observation.channels.map((entry) => entry.channel as RetrievalTraceChannel)))]
      .sort((a, b) => CHANNEL_ORDER.indexOf(a) - CHANNEL_ORDER.indexOf(b));
    this.collector = new RetrievalTraceCollector('ranked-v1', {
      sources: { code: facts.includeCode, architecture: facts.includeArchitecture, memory: facts.includeMemory },
      projectScopeApplied: facts.projectScopeApplied,
      tenantScope: facts.namedTenant ? 'named' : 'default',
      entityScope: cardinality(facts.entityCount),
      tagScope: cardinality(facts.tagCount),
      temporalFilterApplied: facts.temporalFilterApplied,
      queryLength: queryLength(facts.query),
      queryForm: queryForm(facts.query),
      tokenBudget: tokenBudget(facts.maxTokens),
      diversification: 'mmr',
      plannedChannels,
    });
    for (const reason of incompleteReasons) this.collector.markIncomplete(reason);

    for (const channel of plannedChannels) this.safe(() => this.collector.attemptChannel(channel));
    const provenance = new Map<string, RuntimeStructuralCandidateObservation>();
    for (const observation of observations) {
      const finalIds = new Set(observation.finalIds);
      for (const candidate of observation.candidates) {
        if (!finalIds.has(candidate.privateId)) continue;
        const existing = provenance.get(candidate.privateId);
        if (!existing) provenance.set(candidate.privateId, { ...candidate, channels: [...candidate.channels] });
        else {
          const identities = new Set(existing.channels.map((channel) => channel.channel));
          for (const channel of candidate.channels) if (!identities.has(channel.channel)) existing.channels.push(channel);
        }
      }
    }
    for (const result of lists.flat()) {
      const existingResult = this.candidates.get(result.id);
      if (!existingResult || result.content.length > existingResult.content.length) this.candidates.set(result.id, result);
    }
    for (const result of this.candidates.values()) {
      const observed = provenance.get(result.id);
      if (!observed || observed.channels.length === 0) {
        this.collector.markIncomplete('candidate-output-gap');
        continue;
      }
      this.safe(() => {
        const handle = this.collector.addCandidate({
          sourceType: sourceType(result.source_type),
          channels: observed.channels.map((channel) => ({
            channel: channel.channel as RetrievalTraceChannel,
            rank: channel.rank,
            ...(channel.score === undefined || !Number.isFinite(channel.score) || channel.score < -1 || channel.score > 1
              ? {} : { score: channel.score }),
          })),
          evidence: {
            ...(observed.evidence.confidence !== undefined
              && Number.isFinite(observed.evidence.confidence)
              && observed.evidence.confidence >= 0 && observed.evidence.confidence <= 1
              ? { confidence: observed.evidence.confidence } : {}),
            ...(observed.evidence.sourceCount !== undefined
              && Number.isSafeInteger(observed.evidence.sourceCount)
              && observed.evidence.sourceCount >= 0 && observed.evidence.sourceCount <= 64
              ? { sourceCount: observed.evidence.sourceCount } : {}),
            ...(observed.evidence.superseded === undefined ? {} : { superseded: observed.evidence.superseded }),
            ...(observed.evidence.invalidated === undefined ? {} : { invalidated: observed.evidence.invalidated }),
          },
          estimatedTokens: Math.ceil(result.content.length / 4),
        });
        this.handles.set(result.id, handle);
        const sourceChannels = observed.channels.map((channel) => channel.channel);
        const fromMemory = sourceChannels.some((channel) => channel.startsWith('memory.'));
        const fromCode = sourceChannels.some((channel) => channel.startsWith('code.'));
        const fromArchitecture = sourceChannels.some((channel) => channel.startsWith('arch.'));
        const projectApplied = (fromMemory && facts.memoryScopeApplied)
          || ((fromCode || fromArchitecture) && facts.projectNameApplied);
        this.collector.recordFilter(handle, { name: 'source-enabled', outcome: 'pass' });
        this.collector.recordFilter(handle, { name: 'tenant', outcome: 'pass' });
        this.collector.recordFilter(handle, { name: 'project', outcome: projectApplied ? 'pass' : 'not-applicable' });
        this.collector.recordFilter(handle, { name: 'entity', outcome: fromMemory && facts.entityCount > 0 ? 'pass' : 'not-applicable' });
        this.collector.recordFilter(handle, { name: 'tag', outcome: fromMemory && facts.tagCount > 0 ? 'pass' : 'not-applicable' });
        this.collector.recordFilter(handle, { name: 'temporal', outcome: fromMemory && facts.temporalFilterApplied ? 'pass' : 'not-applicable' });
      });
    }
    for (const observation of observations) {
      for (const channel of observation.channels) this.safe(() => this.settle(channel));
    }
  }

  rrf(result: RetrievalResult, value: number): void {
    this.withHandle(result.id, (handle) => this.collector.recordScore(handle, { name: 'rrf', value }));
  }

  score(result: RetrievalResult, name: 'feedback-multiplier' | 'provenance-multiplier' | 'lexical-multiplier' | 'normalized', value: number): void {
    this.withHandle(result.id, (handle) => this.collector.recordScore(handle, { name: name as RetrievalTraceScoreName, value }));
  }

  candidateWindow(result: RetrievalResult, admitted: boolean): void {
    this.window.set(result.id, admitted);
    this.withHandle(result.id, (handle) => this.collector.recordFilter(handle, {
      name: 'candidate-window', outcome: admitted ? 'pass' : 'fail',
    }));
  }

  finalScore(result: RetrievalResult, value: number): void {
    this.withHandle(result.id, (handle) => this.collector.recordScore(handle, { name: 'final', value }));
  }

  mmr(observation: RankedMmrObservation): void {
    const selected = this.handles.get(observation.selected.id);
    if (!selected) { this.failed = true; return; }
    this.safe(() => this.collector.recordMmrRound(
      observation.round,
      selected,
      observation.records.map((record) => ({
        candidate: this.requireHandle(record.candidate.id),
        relevance: record.relevance,
        lambda: observation.lambda,
        pairwise: record.pairwise.map((pair) => ({
          selected: this.requireHandle(pair.selected.id),
          similarity: pair.similarity,
        })),
      })),
    ));
    this.selected.add(observation.selected.id);
  }

  recordBudget(includedIds: readonly string[]): void {
    this.budgeted.clear();
    this.budgetedOrder = [];
    for (const id of includedIds) {
      if (!this.handles.has(id) || !this.selected.has(id) || this.budgeted.has(id)) {
        this.collector.markIncomplete('candidate-output-gap');
        continue;
      }
      this.budgeted.add(id);
      this.budgetedOrder.push(id);
    }
  }

  recordDedup(inputIds: readonly string[], outputIds: readonly string[]): void {
    const output = new Set(outputIds);
    for (const id of inputIds) this.withHandle(id, (handle) => this.collector.recordFilter(handle, {
      name: 'dedup', outcome: output.has(id) ? 'pass' : 'fail',
    }));
  }

  recordStageFailure(stage: RetrievalTraceFailureStage, code: RetrievalTraceFailureCode): void {
    this.safe(() => this.collector.recordStageFailure(stage, code));
  }

  finalize(): RetrievalTraceV1 {
    for (const [id, handle] of this.handles) {
      if (!this.window.get(id)) {
        this.safe(() => this.collector.recordTerminal(handle, { outcome: 'excluded', reasons: ['candidate-window'] }));
        continue;
      }
      const mmrSelected = this.selected.has(id);
      this.safe(() => this.collector.recordFilter(handle, { name: 'mmr', outcome: mmrSelected ? 'pass' : 'fail' }));
      if (!mmrSelected) {
        this.safe(() => this.collector.recordTerminal(handle, { outcome: 'excluded', reasons: ['mmr-diversification'] }));
        continue;
      }
      const included = this.budgeted.has(id);
      this.safe(() => this.collector.recordFilter(handle, { name: 'token-budget', outcome: included ? 'pass' : 'fail' }));
      if (!included) {
        this.safe(() => this.collector.recordTerminal(handle, { outcome: 'excluded', reasons: ['token-budget'] }));
      }
    }
    let rank = 0;
    for (const id of this.budgetedOrder) {
      const handle = this.handles.get(id);
      if (!handle) continue;
      rank += 1;
      this.safe(() => {
        this.collector.recordOutput(handle, rank);
        this.collector.recordTerminal(handle, { outcome: 'included', reasons: [] });
      });
    }
    return this.collector.finalize();
  }

  private settle(entry: RuntimeStructuralChannelObservation): void {
    this.collector.settleChannel(
      entry.channel as RetrievalTraceChannel,
      entry.outcome === 'success'
        ? { outcome: 'success' }
        : { outcome: 'safe-failure', code: entry.code as RetrievalTraceFailureCode },
    );
  }

  private withHandle(id: string, action: (handle: RetrievalTraceCandidateHandle) => void): void {
    const handle = this.handles.get(id);
    if (!handle) { this.failed = true; return; }
    this.safe(() => action(handle));
  }

  private requireHandle(id: string): RetrievalTraceCandidateHandle {
    const handle = this.handles.get(id);
    if (!handle) throw new Error('MMR references an unobserved candidate');
    return handle;
  }

  private safe(action: () => void): void {
    if (this.failed) return;
    try { action(); } catch { this.failed = true; }
  }
}
