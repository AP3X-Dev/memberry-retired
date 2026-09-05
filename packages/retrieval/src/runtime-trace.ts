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
  type RetrievalTraceDeterministicOutputChannelV2,
  type RetrievalTraceChannelSettlement,
} from './trace.js';
import type { ContextItem, RetrievalResult } from './types.js';
import type { ServedRerankerApplicationResultV1 } from './served-reranker.js';

const RUNTIME_ARRAY = Array;
const RUNTIME_OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const RUNTIME_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const RUNTIME_OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const RUNTIME_REFLECT_APPLY = Reflect.apply;
const RUNTIME_STRING = String;
const RUNTIME_MAP = Map;
const RUNTIME_MAP_GET_METHOD = Map.prototype.get;
const RUNTIME_MAP_SET_METHOD = Map.prototype.set;
const RUNTIME_MAP_SET = Function.prototype.call.bind(RUNTIME_MAP_SET_METHOD) as <K, V>(map: Map<K, V>, key: K, value: V) => Map<K, V>;
const RUNTIME_MAP_GET = Function.prototype.call.bind(RUNTIME_MAP_GET_METHOD) as <K, V>(map: Map<K, V>, key: K) => V | undefined;
const RUNTIME_MAP_HAS = Function.prototype.call.bind(Map.prototype.has) as <K, V>(map: Map<K, V>, key: K) => boolean;
const RUNTIME_MAP_FOR_EACH = Function.prototype.call.bind(Map.prototype.forEach) as <K, V>(
  map: Map<K, V>, callback: (value: V, key: K) => void,
) => void;
const RUNTIME_SET = Set;
const RUNTIME_SET_ADD_METHOD = Set.prototype.add;
const RUNTIME_SET_HAS_METHOD = Set.prototype.has;
const RUNTIME_SET_ITERATOR = Set.prototype[Symbol.iterator];
const RUNTIME_SET_ADD = Function.prototype.call.bind(RUNTIME_SET_ADD_METHOD) as <T>(set: Set<T>, value: T) => Set<T>;
const RUNTIME_SET_HAS = Function.prototype.call.bind(RUNTIME_SET_HAS_METHOD) as <T>(set: Set<T>, value: T) => boolean;
const RUNTIME_SET_CLEAR = Function.prototype.call.bind(Set.prototype.clear) as <T>(set: Set<T>) => void;
const RUNTIME_ARRAY_PROTOTYPE = Array.prototype;
const RUNTIME_MAP_PROTOTYPE = Map.prototype;
const RUNTIME_SET_PROTOTYPE = Set.prototype;
const RUNTIME_STRING_PROTOTYPE = String.prototype;
const RUNTIME_REGEXP_PROTOTYPE = RegExp.prototype;
const RUNTIME_ARRAY_FLAT_MAP = Array.prototype.flatMap;
const RUNTIME_ARRAY_MAP = Array.prototype.map;
const RUNTIME_ARRAY_FILTER = Array.prototype.filter;
const RUNTIME_ARRAY_SORT = Array.prototype.sort;
const RUNTIME_ARRAY_SOME = Array.prototype.some;
const RUNTIME_ARRAY_INDEX_OF = Array.prototype.indexOf;
const RUNTIME_ARRAY_FLAT = Array.prototype.flat;
const RUNTIME_ARRAY_PUSH = Array.prototype.push;
const RUNTIME_ARRAY_ITERATOR = Array.prototype[Symbol.iterator];
const RUNTIME_MAP_VALUES = Map.prototype.values;
const RUNTIME_MAP_ITERATOR = Map.prototype[Symbol.iterator];
const RUNTIME_STRING_TRIM = String.prototype.trim;
const RUNTIME_STRING_SPLIT = String.prototype.split;
const RUNTIME_STRING_STARTS_WITH = String.prototype.startsWith;
const RUNTIME_REGEXP_TEST = RegExp.prototype.test;
const RUNTIME_NUMBER = Number;
const RUNTIME_NUMBER_IS_FINITE = Number.isFinite;
const RUNTIME_NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const RUNTIME_MATH = Math;
const RUNTIME_MATH_CEIL = Math.ceil;
const RUNTIME_ARRAY_ITERATOR_PROTOTYPE = RUNTIME_OBJECT_GET_PROTOTYPE_OF(
  RUNTIME_REFLECT_APPLY(RUNTIME_ARRAY_ITERATOR, [], []) as object,
);
const RUNTIME_ARRAY_ITERATOR_NEXT = RUNTIME_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  RUNTIME_ARRAY_ITERATOR_PROTOTYPE,
  'next',
)!.value;
const RUNTIME_MAP_ITERATOR_PROTOTYPE = RUNTIME_OBJECT_GET_PROTOTYPE_OF(
  RUNTIME_REFLECT_APPLY(RUNTIME_MAP_VALUES, new RUNTIME_MAP(), []) as object,
);
const RUNTIME_MAP_ITERATOR_NEXT = RUNTIME_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  RUNTIME_MAP_ITERATOR_PROTOTYPE,
  'next',
)!.value;
const RUNTIME_SET_ITERATOR_PROTOTYPE = RUNTIME_OBJECT_GET_PROTOTYPE_OF(
  RUNTIME_REFLECT_APPLY(RUNTIME_SET_ITERATOR, new RUNTIME_SET(), []) as object,
);
const RUNTIME_SET_ITERATOR_NEXT = RUNTIME_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  RUNTIME_SET_ITERATOR_PROTOTYPE,
  'next',
)!.value;

function assertRuntimeDataMethod(target: object, key: PropertyKey, expected: unknown): void {
  const descriptor = RUNTIME_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(target, key);
  if (!descriptor || !('value' in descriptor) || descriptor.value !== expected) {
    throw new Error('ranked-v2 runtime intrinsic integrity check failed');
  }
}

function assertRankedV2ConstructionIntrinsics(): void {
  if (Array !== RUNTIME_ARRAY || Map !== RUNTIME_MAP || Set !== RUNTIME_SET
    || String !== RUNTIME_STRING || Number !== RUNTIME_NUMBER || Math !== RUNTIME_MATH) {
    throw new Error('ranked-v2 runtime intrinsic integrity check failed');
  }
  assertRuntimeDataMethod(RUNTIME_ARRAY_PROTOTYPE, 'flatMap', RUNTIME_ARRAY_FLAT_MAP);
  assertRuntimeDataMethod(RUNTIME_ARRAY_PROTOTYPE, 'map', RUNTIME_ARRAY_MAP);
  assertRuntimeDataMethod(RUNTIME_ARRAY_PROTOTYPE, 'filter', RUNTIME_ARRAY_FILTER);
  assertRuntimeDataMethod(RUNTIME_ARRAY_PROTOTYPE, 'sort', RUNTIME_ARRAY_SORT);
  assertRuntimeDataMethod(RUNTIME_ARRAY_PROTOTYPE, 'some', RUNTIME_ARRAY_SOME);
  assertRuntimeDataMethod(RUNTIME_ARRAY_PROTOTYPE, 'indexOf', RUNTIME_ARRAY_INDEX_OF);
  assertRuntimeDataMethod(RUNTIME_ARRAY_PROTOTYPE, 'flat', RUNTIME_ARRAY_FLAT);
  assertRuntimeDataMethod(RUNTIME_ARRAY_PROTOTYPE, 'push', RUNTIME_ARRAY_PUSH);
  assertRuntimeDataMethod(RUNTIME_ARRAY_PROTOTYPE, Symbol.iterator, RUNTIME_ARRAY_ITERATOR);
  assertRuntimeDataMethod(RUNTIME_ARRAY_ITERATOR_PROTOTYPE, 'next', RUNTIME_ARRAY_ITERATOR_NEXT);
  assertRuntimeDataMethod(RUNTIME_MAP_PROTOTYPE, 'get', RUNTIME_MAP_GET_METHOD);
  assertRuntimeDataMethod(RUNTIME_MAP_PROTOTYPE, 'set', RUNTIME_MAP_SET_METHOD);
  assertRuntimeDataMethod(RUNTIME_MAP_PROTOTYPE, 'values', RUNTIME_MAP_VALUES);
  assertRuntimeDataMethod(RUNTIME_MAP_PROTOTYPE, Symbol.iterator, RUNTIME_MAP_ITERATOR);
  assertRuntimeDataMethod(RUNTIME_MAP_ITERATOR_PROTOTYPE, 'next', RUNTIME_MAP_ITERATOR_NEXT);
  assertRuntimeDataMethod(RUNTIME_SET_PROTOTYPE, 'has', RUNTIME_SET_HAS_METHOD);
  assertRuntimeDataMethod(RUNTIME_SET_PROTOTYPE, 'add', RUNTIME_SET_ADD_METHOD);
  assertRuntimeDataMethod(RUNTIME_SET_PROTOTYPE, Symbol.iterator, RUNTIME_SET_ITERATOR);
  assertRuntimeDataMethod(RUNTIME_SET_ITERATOR_PROTOTYPE, 'next', RUNTIME_SET_ITERATOR_NEXT);
  assertRuntimeDataMethod(RUNTIME_STRING_PROTOTYPE, 'trim', RUNTIME_STRING_TRIM);
  assertRuntimeDataMethod(RUNTIME_STRING_PROTOTYPE, 'split', RUNTIME_STRING_SPLIT);
  assertRuntimeDataMethod(RUNTIME_STRING_PROTOTYPE, 'startsWith', RUNTIME_STRING_STARTS_WITH);
  assertRuntimeDataMethod(RUNTIME_REGEXP_PROTOTYPE, 'test', RUNTIME_REGEXP_TEST);
  if (RUNTIME_NUMBER.isFinite !== RUNTIME_NUMBER_IS_FINITE
    || RUNTIME_NUMBER.isSafeInteger !== RUNTIME_NUMBER_IS_SAFE_INTEGER
    || RUNTIME_MATH.ceil !== RUNTIME_MATH_CEIL) {
    throw new Error('ranked-v2 runtime intrinsic integrity check failed');
  }
}

function defineRuntimeArrayItem<T>(target: T[], index: number, value: T): void {
  RUNTIME_OBJECT_DEFINE_PROPERTY(target, RUNTIME_STRING(index), {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

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
  plannedChannels?: readonly RetrievalTraceChannel[];
}

export interface DeterministicTraceRequestFacts {
  query: string;
  maxTokens: number;
  targetCount: number;
  projectScopeApplied: boolean;
  namedTenant: boolean;
  temporalFilterApplied: boolean;
  discovery?: RetrievalTraceChannelSettlement;
}

function deterministicSourceType(channel: RetrievalTraceDeterministicOutputChannelV2):
  'semantic' | 'arch_entity' | 'aspect' {
  return channel === 'memory.graph' ? 'semantic' : channel === 'arch.aspect' ? 'aspect' : 'arch_entity';
}

/** Trace-only adapter for the deterministic assembler. It receives already
 * ordered source candidates and never exposes their IDs or content. */
export class DeterministicRuntimeTraceAdapter {
  private readonly collector: RetrievalTraceCollector;
  private readonly requestShape: RetrievalTraceRequestShapeV1;
  private failed = false;

  constructor(private readonly facts: DeterministicTraceRequestFacts) {
    const plannedChannels: RetrievalTraceChannel[] = [
      ...(facts.discovery ? ['arch.fulltext' as const] : []),
      ...(facts.targetCount > 0 ? [
        'arch.hierarchy', 'arch.entity', 'arch.dependency', 'arch.aspect', 'memory.graph',
      ] as const : []),
    ];
    this.requestShape = {
      sources: { code: false, architecture: true, memory: true },
      projectScopeApplied: facts.projectScopeApplied,
      tenantScope: facts.namedTenant ? 'named' : 'default',
      entityScope: cardinality(facts.targetCount),
      tagScope: 'none',
      temporalFilterApplied: facts.temporalFilterApplied,
      queryLength: queryLength(facts.query),
      queryForm: queryForm(facts.query),
      tokenBudget: tokenBudget(facts.maxTokens),
      diversification: 'none',
      plannedChannels,
    };
    this.collector = new RetrievalTraceCollector('deterministic-v2', this.requestShape);
    if (facts.discovery) {
      this.safe(() => this.collector.attemptChannel('arch.fulltext'));
      this.safe(() => this.collector.settleChannel('arch.fulltext', facts.discovery!));
    }
  }

  attempt(channel: RetrievalTraceDeterministicOutputChannelV2): void {
    this.safe(() => this.collector.attemptChannel(channel));
  }

  settle(
    channel: RetrievalTraceDeterministicOutputChannelV2,
    settlement: RetrievalTraceChannelSettlement,
  ): void {
    this.safe(() => this.collector.settleChannel(channel, settlement));
  }

  recordSourceFinal(
    channel: RetrievalTraceDeterministicOutputChannelV2,
    candidates: readonly ContextItem[],
    included: readonly ContextItem[],
  ): void {
    if (this.failed) return;
    const delivered = new Set(included);
    const ordered = [...candidates].sort((a, b) => b.score - a.score);
    for (let index = 0; index < ordered.length; index++) {
      const item = ordered[index]!;
      this.safe(() => {
        const confidence = channel === 'memory.graph'
          && typeof item.metadata.confidence === 'number'
          && Number.isFinite(item.metadata.confidence)
          && item.metadata.confidence >= 0
          && item.metadata.confidence <= 1
          ? item.metadata.confidence : undefined;
        const handle = this.collector.addCandidate({
          sourceType: deterministicSourceType(channel),
          channels: [{ channel, rank: index + 1 }],
          evidence: confidence === undefined ? {} : { confidence },
          estimatedTokens: Math.ceil(item.content.length / 4),
        });
        const fromMemory = channel === 'memory.graph';
        const accepted = delivered.has(item);
        this.collector.recordFilter(handle, { name: 'source-enabled', outcome: 'pass' });
        this.collector.recordFilter(handle, { name: 'tenant', outcome: fromMemory ? 'pass' : 'not-applicable' });
        this.collector.recordFilter(handle, {
          name: 'project', outcome: this.facts.projectScopeApplied ? 'pass' : 'not-applicable',
        });
        this.collector.recordFilter(handle, { name: 'entity', outcome: 'pass' });
        this.collector.recordFilter(handle, {
          name: 'temporal',
          outcome: fromMemory && this.facts.temporalFilterApplied ? 'pass' : 'not-applicable',
        });
        this.collector.recordFilter(handle, { name: 'token-budget', outcome: accepted ? 'pass' : 'fail' });
        this.collector.recordTerminal(handle, accepted
          ? { outcome: 'included', reasons: [] }
          : { outcome: 'excluded', reasons: ['token-budget'] });
      });
    }
  }

  finalize(): RetrievalTraceV1 {
    try {
      return this.collector.finalize();
    } catch {
      const fallback = new RetrievalTraceCollector('deterministic-v2', this.requestShape, {
        maxCandidates: 1,
        maxEvents: 1,
      });
      fallback.markIncomplete('candidate-output-gap');
      return fallback.finalize();
    }
  }

  private safe(action: () => void): void {
    if (this.failed) return;
    try { action(); } catch {
      this.failed = true;
      try { this.collector.markIncomplete('candidate-output-gap'); } catch { /* fail closed */ }
    }
  }
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
  private readonly handles = new RUNTIME_MAP<string, RetrievalTraceCandidateHandle>();
  private readonly candidates = new RUNTIME_MAP<string, RetrievalResult>();
  private readonly window = new RUNTIME_MAP<string, boolean>();
  private readonly selected = new RUNTIME_SET<string>();
  private readonly budgeted = new RUNTIME_SET<string>();
  private budgetedOrder: string[] = [];
  private dedupedOrder: string[] = [];
  private dedupRecorded = false;
  private rerankerRecorded = false;
  private budgetRecorded = false;
  private failed = false;

  constructor(
    observations: readonly RuntimeStructuralObservation[],
    lists: readonly RetrievalResult[][],
    facts: RankedTraceRequestFacts,
    incompleteReasons: readonly RetrievalTraceIncompleteReason[] = [],
    private readonly algorithmVersion: 'ranked-v1' | 'ranked-v2' = 'ranked-v1',
  ) {
    if (algorithmVersion === 'ranked-v2') assertRankedV2ConstructionIntrinsics();
    let plannedChannels: RetrievalTraceChannel[];
    if (facts.plannedChannels === undefined) {
      const observedChannels = observations.flatMap((observation) =>
        observation.channels.map((entry) => entry.channel as RetrievalTraceChannel));
      const uniqueChannels = algorithmVersion === 'ranked-v2'
        ? new RUNTIME_SET(observedChannels)
        : new Set(observedChannels);
      plannedChannels = [...uniqueChannels]
        .sort((a, b) => CHANNEL_ORDER.indexOf(a) - CHANNEL_ORDER.indexOf(b));
    } else {
      plannedChannels = [...facts.plannedChannels];
    }
    this.collector = new RetrievalTraceCollector(algorithmVersion, {
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
    const provenance = algorithmVersion === 'ranked-v2'
      ? new RUNTIME_MAP<string, RuntimeStructuralCandidateObservation>()
      : new Map<string, RuntimeStructuralCandidateObservation>();
    for (const observation of observations) {
      const finalIds = algorithmVersion === 'ranked-v2'
        ? new RUNTIME_SET(observation.finalIds)
        : new Set(observation.finalIds);
      for (const candidate of observation.candidates) {
        if (!finalIds.has(candidate.privateId)) continue;
        const existing = provenance.get(candidate.privateId);
        if (!existing) provenance.set(candidate.privateId, { ...candidate, channels: [...candidate.channels] });
        else {
          const identities = algorithmVersion === 'ranked-v2'
            ? new RUNTIME_SET(existing.channels.map((channel) => channel.channel))
            : new Set(existing.channels.map((channel) => channel.channel));
          for (const channel of candidate.channels) {
            if (identities.has(channel.channel)) continue;
            if (algorithmVersion === 'ranked-v2') {
              defineRuntimeArrayItem(existing.channels, existing.channels.length, channel);
            } else existing.channels.push(channel);
          }
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
        const fromDirectArchitectureEntity = sourceChannels.some((channel) => channel === 'arch.entity');
        const projectApplied = (fromMemory && facts.memoryScopeApplied)
          || ((fromCode || fromArchitecture) && facts.projectNameApplied);
        this.collector.recordFilter(handle, { name: 'source-enabled', outcome: 'pass' });
        this.collector.recordFilter(handle, { name: 'tenant', outcome: 'pass' });
        this.collector.recordFilter(handle, { name: 'project', outcome: projectApplied ? 'pass' : 'not-applicable' });
        this.collector.recordFilter(handle, {
          name: 'entity',
          outcome: (fromMemory || fromDirectArchitectureEntity) && facts.entityCount > 0 ? 'pass' : 'not-applicable',
        });
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
    if (this.algorithmVersion === 'ranked-v2') RUNTIME_MAP_SET(this.window, result.id, admitted);
    else this.window.set(result.id, admitted);
    this.withHandle(result.id, (handle) => this.collector.recordFilter(handle, {
      name: 'candidate-window', outcome: admitted ? 'pass' : 'fail',
    }));
  }

  finalScore(result: RetrievalResult, value: number): void {
    this.withHandle(result.id, (handle) => this.collector.recordScore(handle, { name: 'final', value }));
  }

  mmr(observation: RankedMmrObservation): void {
    const selected = this.algorithmVersion === 'ranked-v2'
      ? RUNTIME_MAP_GET(this.handles, observation.selected.id)
      : this.handles.get(observation.selected.id);
    if (!selected) { this.failed = true; return; }
    if (this.algorithmVersion === 'ranked-v2') {
      const records = new RUNTIME_ARRAY<Parameters<RetrievalTraceCollector['recordMmrRound']>[2][number]>(
        observation.records.length,
      );
      for (let recordIndex = 0; recordIndex < observation.records.length; recordIndex += 1) {
        const record = observation.records[recordIndex]!;
        const pairwise = new RUNTIME_ARRAY<Parameters<RetrievalTraceCollector['recordMmrRound']>[2][number]['pairwise'][number]>(
          record.pairwise.length,
        );
        for (let pairIndex = 0; pairIndex < record.pairwise.length; pairIndex += 1) {
          const pair = record.pairwise[pairIndex]!;
          defineRuntimeArrayItem(pairwise, pairIndex, {
            selected: this.requireHandle(pair.selected.id), similarity: pair.similarity,
          });
        }
        defineRuntimeArrayItem(records, recordIndex, {
          candidate: this.requireHandle(record.candidate.id),
          relevance: record.relevance,
          lambda: observation.lambda,
          pairwise,
        });
      }
      this.safe(() => this.collector.recordMmrRound(observation.round, selected, records));
      RUNTIME_SET_ADD(this.selected, observation.selected.id);
    } else {
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
  }

  recordBudget(includedIds: readonly string[]): void {
    if (this.algorithmVersion === 'ranked-v2') {
      if (this.budgetRecorded) {
        this.failPhase();
        return;
      }
      this.budgetRecorded = true;
      if (!this.dedupRecorded || !this.rerankerRecorded) {
        this.failPhase();
        return;
      }
    }
    RUNTIME_SET_CLEAR(this.budgeted);
    this.budgetedOrder = [];
    for (let index = 0; index < includedIds.length; index += 1) {
      const id = includedIds[index]!;
      if (!RUNTIME_MAP_HAS(this.handles, id) || !RUNTIME_SET_HAS(this.selected, id)
        || RUNTIME_SET_HAS(this.budgeted, id)) {
        this.collector.markIncomplete('candidate-output-gap');
        continue;
      }
      RUNTIME_SET_ADD(this.budgeted, id);
      defineRuntimeArrayItem(this.budgetedOrder, this.budgetedOrder.length, id);
    }
  }

  recordDedup(inputIds: readonly string[], outputIds: readonly string[]): void {
    if (this.algorithmVersion === 'ranked-v2') {
      if (this.dedupRecorded || this.rerankerRecorded || this.budgetRecorded) {
        this.failPhase();
        return;
      }
      this.dedupRecorded = true;
    }
    const output = new RUNTIME_SET<string>();
    if (this.algorithmVersion === 'ranked-v2') this.dedupedOrder = new RUNTIME_ARRAY<string>(outputIds.length);
    for (let index = 0; index < outputIds.length; index += 1) {
      const id = outputIds[index]!;
      RUNTIME_SET_ADD(output, id);
      if (this.algorithmVersion === 'ranked-v2') defineRuntimeArrayItem(this.dedupedOrder, index, id);
    }
    for (let index = 0; index < inputIds.length; index += 1) {
      const id = inputIds[index]!;
      this.withHandle(id, (handle) => this.collector.recordFilter(handle, {
        name: 'dedup', outcome: RUNTIME_SET_HAS(output, id) ? 'pass' : 'fail',
      }));
    }
  }

  recordReranker(
    baselineResults: readonly RetrievalResult[],
    outcome: ServedRerankerApplicationResultV1,
  ): void {
    if (!this.dedupRecorded || this.rerankerRecorded || this.budgetRecorded) {
      this.failPhase();
      return;
    }
    if (this.failed) return;
    this.safe(() => {
      if (this.algorithmVersion !== 'ranked-v2') {
        throw new Error('reranker recording requires ranked-v2');
      }
      const baselineIds = new RUNTIME_ARRAY<string>(baselineResults.length);
      const handles = new RUNTIME_ARRAY<RetrievalTraceCandidateHandle>(baselineResults.length);
      for (let index = 0; index < baselineResults.length; index += 1) {
        const id = baselineResults[index]!.id;
        defineRuntimeArrayItem(baselineIds, index, id);
        defineRuntimeArrayItem(handles, index, this.requireHandle(id));
      }
      if (baselineIds.length !== this.dedupedOrder.length
        || (() => {
          for (let index = 0; index < baselineIds.length; index += 1) {
            if (baselineIds[index] !== this.dedupedOrder[index]) return true;
          }
          return false;
        })()) {
        throw new Error('reranker baseline differs from post-dedup order');
      }
      if (outcome.outcome === 'baseline') {
        if (outcome.results !== baselineResults) throw new Error('baseline outcome did not preserve input array');
        this.collector.recordRerankerStage(handles, { outcome: 'baseline' });
        this.rerankerRecorded = true;
        return;
      }
      if (outcome.candidates.length !== baselineResults.length) {
        throw new Error('reranked outcome cardinality changed');
      }
      const baselineSet = new RUNTIME_SET<RetrievalResult>();
      const observed = new RUNTIME_SET<RetrievalResult>();
      const candidateInputs = new RUNTIME_ARRAY<{
        candidateHandle: RetrievalTraceCandidateHandle;
        calibratedScore: number;
      }>(outcome.candidates.length);
      for (let index = 0; index < baselineResults.length; index += 1) {
        RUNTIME_SET_ADD(baselineSet, baselineResults[index]!);
      }
      for (let index = 0; index < outcome.candidates.length; index += 1) {
        const candidate = outcome.candidates[index]!;
        if (!RUNTIME_SET_HAS(baselineSet, candidate.baselineResult)
          || RUNTIME_SET_HAS(observed, candidate.baselineResult)
          || outcome.results[index] !== candidate.result) {
          throw new Error('reranked outcome lost private candidate identity');
        }
        RUNTIME_SET_ADD(observed, candidate.baselineResult);
        defineRuntimeArrayItem(candidateInputs, index, {
          candidateHandle: this.requireHandle(candidate.baselineResult.id),
          calibratedScore: candidate.calibratedScore,
        });
      }
      this.collector.recordRerankerStage(handles, {
        outcome: 'reranked',
        candidates: candidateInputs,
      });
      this.rerankerRecorded = true;
    });
  }

  recordStageFailure(stage: RetrievalTraceFailureStage, code: RetrievalTraceFailureCode): void {
    this.safe(() => this.collector.recordStageFailure(stage, code));
  }

  finalize(): RetrievalTraceV1 {
    if (this.algorithmVersion === 'ranked-v2'
      && (!this.dedupRecorded || !this.rerankerRecorded || !this.budgetRecorded)) {
      this.failPhase();
    }
    const handleEntries = new RUNTIME_ARRAY<{ id: string; handle: RetrievalTraceCandidateHandle }>();
    RUNTIME_MAP_FOR_EACH(this.handles, (handle, id) => {
      defineRuntimeArrayItem(handleEntries, handleEntries.length, { id, handle });
    });
    for (let index = 0; index < handleEntries.length; index += 1) {
      const { id, handle } = handleEntries[index]!;
      if (!RUNTIME_MAP_GET(this.window, id)) {
        this.safe(() => this.collector.recordTerminal(handle, { outcome: 'excluded', reasons: ['candidate-window'] }));
        continue;
      }
      const mmrSelected = RUNTIME_SET_HAS(this.selected, id);
      this.safe(() => this.collector.recordFilter(handle, { name: 'mmr', outcome: mmrSelected ? 'pass' : 'fail' }));
      if (!mmrSelected) {
        this.safe(() => this.collector.recordTerminal(handle, { outcome: 'excluded', reasons: ['mmr-diversification'] }));
        continue;
      }
      const included = RUNTIME_SET_HAS(this.budgeted, id);
      this.safe(() => this.collector.recordFilter(handle, { name: 'token-budget', outcome: included ? 'pass' : 'fail' }));
      if (!included) {
        this.safe(() => this.collector.recordTerminal(handle, { outcome: 'excluded', reasons: ['token-budget'] }));
      }
    }
    let rank = 0;
    for (let index = 0; index < this.budgetedOrder.length; index += 1) {
      const id = this.budgetedOrder[index]!;
      const handle = RUNTIME_MAP_GET(this.handles, id);
      if (!handle) continue;
      rank += 1;
      this.safe(() => {
        this.collector.recordOutput(handle, rank);
        this.collector.recordTerminal(handle, { outcome: 'included', reasons: [] });
      });
    }
    // A failure swallowed by safe() leaves a ranked-v2 collector without its
    // reranker stage, and the collector's own finalize then throws the raw
    // validator string. Keep the public failure value-free, matching the
    // serializer boundary in tools.ts.
    if (this.failed) {
      try { return this.collector.finalize(); } catch { throw new Error('Retrieval trace validation failed'); }
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
    const handle = this.algorithmVersion === 'ranked-v2'
      ? RUNTIME_MAP_GET(this.handles, id)
      : this.handles.get(id);
    if (!handle) { this.failed = true; return; }
    this.safe(() => action(handle));
  }

  private requireHandle(id: string): RetrievalTraceCandidateHandle {
    const handle = RUNTIME_MAP_GET(this.handles, id);
    if (!handle) throw new Error('MMR references an unobserved candidate');
    return handle;
  }

  private failPhase(): void {
    this.failed = true;
    try { this.collector.markIncomplete('candidate-output-gap'); } catch { /* fail closed */ }
  }

  private safe(action: () => void): void {
    if (this.failed) return;
    try { action(); } catch { this.failed = true; }
  }
}
