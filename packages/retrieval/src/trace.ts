import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';

import { redactSecrets } from '@memberry/core';

import { SERVED_RERANKER_PROVIDER_IDENTITY } from './served-reranker.js';
import { RETRIEVAL_SOURCE_TYPES, type SourceType } from './types.js';

export const RETRIEVAL_TRACE_VERSION = '1.0.0' as const;
export const RETRIEVAL_TRACE_NUMBER_DECIMALS = 6 as const;

const HARD_LIMITS = Object.freeze({
  candidates: 512,
  plannedChannels: 16,
  channelsPerCandidate: 8,
  genericArrayEntries: 8192,
  traceEvents: 8193,
  filtersPerCandidate: 16,
  scoresPerCandidate: 8,
  exclusionReasonsPerCandidate: 8,
  mmrRounds: 64,
  mmrRecordsPerRound: 128,
  mmrRecordsTotal: 4096,
  mmrPairwisePerRecord: 64,
  // Ranked fusion over-fetches at most 100 candidates for a 50-result window.
  // Its complete trace records 82,075 pairwise comparisons. Keep a bounded
  // margin above that served maximum.
  mmrPairwiseTotal: 98304,
  stageFailures: 32,
});

const DEFAULT_LIMITS = Object.freeze({
  // Runtime candidate requests are already sealed at the 512-candidate hard
  // ceiling. A trace must be able to describe that bounded input even though
  // fusion admits at most 50 candidates to MMR and reranking.
  maxCandidates: 512,
  maxEvents: 4096,
  maxChannelsPerCandidate: 8,
  maxFiltersPerCandidate: 12,
  maxScoresPerCandidate: 8,
  maxExclusionReasonsPerCandidate: 8,
  maxMmrRounds: 64,
  maxMmrRecordsPerRound: 128,
  maxMmrRecordsTotal: 4096,
  maxMmrPairwisePerRecord: 64,
  maxMmrPairwiseTotal: 90112,
  maxStageFailures: 32,
});

const AGGREGATE_LIMITS = Object.freeze({
  // These ceilings dominate the collector's hard maxima, including duplicated
  // terminal-reason mirrors, while still bounding validation to a small trace.
  arrays: 8192,
  arrayEntries: 114_688,
  records: 98_304,
  recordFields: 262_144,
  scalarBytes: 4_194_304,
  depth: 20,
});

const MAX_TRACE_NUMBER = 1_000_000;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export type RetrievalTraceAlgorithmVersion = 'ranked-v1' | 'ranked-v2' | 'deterministic-v1' | 'deterministic-v2';
export type RetrievalTraceSourceType = SourceType;
export type RetrievalTraceChannel =
  | 'memory.scope' | 'memory.semantic-vector' | 'memory.episodic-vector' | 'memory.fact'
  | 'memory.block' | 'memory.graph' | 'code.fulltext' | 'code.lexical-vector'
  | 'code.dense-vector' | 'code.semantic-vector' | 'arch.fulltext' | 'arch.hierarchy'
  | 'arch.dependency' | 'arch.aspect' | 'arch.entity';
export const RETRIEVAL_TRACE_DETERMINISTIC_OUTPUT_CHANNEL_ORDER_V2 = Object.freeze([
  'arch.hierarchy',
  'arch.entity',
  'arch.dependency',
  'arch.aspect',
  'memory.graph',
] as const);
// The exact deterministic "No matching entities found" sentinel is presentation,
// not retrieved evidence. Its trace therefore has a successful discovery channel
// and zero candidates/output refs; no task text or synthetic provenance is stored.
export type RetrievalTraceDeterministicOutputChannelV2 =
  typeof RETRIEVAL_TRACE_DETERMINISTIC_OUTPUT_CHANNEL_ORDER_V2[number];
export type RetrievalTraceFilterName =
  | 'source-enabled' | 'tenant' | 'project' | 'entity' | 'tag' | 'temporal'
  | 'language' | 'kind' | 'dedup' | 'candidate-window' | 'mmr' | 'limit' | 'token-budget';
export type RetrievalTraceExclusionReason =
  | 'source-disabled' | 'tenant-policy' | 'project-scope' | 'entity-scope' | 'tag-scope'
  | 'temporal-filter' | 'language-filter' | 'kind-filter' | 'duplicate' | 'candidate-window'
  | 'mmr-diversification' | 'token-budget' | 'result-limit' | 'source-failed' | 'no-match';
export type RetrievalTraceFailureCode = 'unavailable' | 'timeout' | 'query-failed' | 'invalid-result';
export type RetrievalTraceFailureStage = 'intent' | 'embedding' | 'feedback';
export type RetrievalTraceTerminalOutcome = 'included' | 'excluded' | 'failed';
export type RetrievalTraceScoreName =
  | 'input' | 'rrf' | 'feedback-multiplier' | 'provenance-multiplier'
  | 'lexical-multiplier' | 'normalized' | 'final';
export type RetrievalTraceIncompleteReason =
  | 'channel-gap' | 'channel-accounting-conflict' | 'candidate-terminal-gap'
  | 'candidate-terminal-conflict' | 'candidate-output-gap' | 'candidate-event-conflict'
  | 'candidate-identity-collision' | 'mmr-gap' | 'limit-overflow';

const ALGORITHMS = ['ranked-v1', 'ranked-v2', 'deterministic-v1', 'deterministic-v2'] as const;
const SOURCE_TYPES = RETRIEVAL_SOURCE_TYPES;
export const RETRIEVAL_TRACE_CHANNEL_ORDER = Object.freeze([
  'memory.scope', 'memory.semantic-vector', 'memory.episodic-vector', 'memory.fact', 'memory.block', 'memory.graph',
  'code.fulltext', 'code.lexical-vector', 'code.dense-vector', 'code.semantic-vector',
  'arch.fulltext', 'arch.hierarchy', 'arch.dependency', 'arch.aspect', 'arch.entity',
] as const);
const FILTERS = [
  'source-enabled', 'tenant', 'project', 'entity', 'tag', 'temporal', 'language', 'kind',
  'dedup', 'candidate-window', 'mmr', 'limit', 'token-budget',
] as const;
const FILTER_OUTCOMES = ['pass', 'fail', 'not-applicable'] as const;
const EXCLUSION_REASONS = [
  'source-disabled', 'tenant-policy', 'project-scope', 'entity-scope', 'tag-scope', 'temporal-filter',
  'language-filter', 'kind-filter', 'duplicate', 'candidate-window', 'mmr-diversification',
  'token-budget', 'result-limit', 'source-failed', 'no-match',
] as const;
const FAILURE_CODES = ['unavailable', 'timeout', 'query-failed', 'invalid-result'] as const;
const FAILURE_STAGES = ['intent', 'embedding', 'feedback'] as const;
const TERMINAL_OUTCOMES = ['included', 'excluded', 'failed'] as const;
const SCORE_NAMES = [
  'input', 'rrf', 'feedback-multiplier', 'provenance-multiplier',
  'lexical-multiplier', 'normalized', 'final',
] as const;
const INCOMPLETE_REASONS = [
  'channel-gap', 'channel-accounting-conflict', 'candidate-terminal-gap',
  'candidate-terminal-conflict', 'candidate-output-gap', 'candidate-event-conflict',
  'candidate-identity-collision', 'mmr-gap', 'limit-overflow',
] as const;
const CARDINALITY_BUCKETS = ['none', 'one', 'few', 'many'] as const;
const QUERY_LENGTHS = ['empty', 'short', 'medium', 'long'] as const;
const QUERY_FORMS = ['natural-language', 'identifier-heavy', 'mixed'] as const;
const TOKEN_BUDGETS = ['small', 'medium', 'large', 'very-large'] as const;
const DIVERSIFICATION = ['none', 'mmr'] as const;
const FILTER_EXCLUSION_REASON: Readonly<Record<RetrievalTraceFilterName, RetrievalTraceExclusionReason>> = Object.freeze({
  'source-enabled': 'source-disabled',
  tenant: 'tenant-policy',
  project: 'project-scope',
  entity: 'entity-scope',
  tag: 'tag-scope',
  temporal: 'temporal-filter',
  language: 'language-filter',
  kind: 'kind-filter',
  dedup: 'duplicate',
  'candidate-window': 'candidate-window',
  mmr: 'mmr-diversification',
  limit: 'result-limit',
  'token-budget': 'token-budget',
});

const channelOrder = new Map(RETRIEVAL_TRACE_CHANNEL_ORDER.map((channel, index) => [channel, index]));
const deterministicV2ChannelOrderValues: readonly RetrievalTraceChannel[] = Object.freeze([
  'arch.fulltext',
  ...RETRIEVAL_TRACE_DETERMINISTIC_OUTPUT_CHANNEL_ORDER_V2,
  ...RETRIEVAL_TRACE_CHANNEL_ORDER.filter((channel) => channel !== 'arch.fulltext'
    && !RETRIEVAL_TRACE_DETERMINISTIC_OUTPUT_CHANNEL_ORDER_V2.includes(
      channel as RetrievalTraceDeterministicOutputChannelV2,
    )),
]);
const deterministicV2ChannelOrder = new Map(
  deterministicV2ChannelOrderValues.map((channel, index) => [channel, index]),
);
const sourceOrder = new Map(SOURCE_TYPES.map((source, index) => [source, index]));
const deterministicV2SourceBinding: Readonly<Record<RetrievalTraceDeterministicOutputChannelV2, RetrievalTraceSourceType>> = Object.freeze({
  'arch.hierarchy': 'arch_entity',
  'arch.entity': 'arch_entity',
  'arch.dependency': 'arch_entity',
  'arch.aspect': 'aspect',
  'memory.graph': 'semantic',
});

function orderForAlgorithm(algorithmVersion: RetrievalTraceAlgorithmVersion): ReadonlyMap<RetrievalTraceChannel, number> {
  return algorithmVersion === 'deterministic-v2' ? deterministicV2ChannelOrder : channelOrder;
}

function isDeterministicV2OutputChannel(
  channel: unknown,
): channel is RetrievalTraceDeterministicOutputChannelV2 {
  return typeof channel === 'string'
    && includesTraceArray(RETRIEVAL_TRACE_DETERMINISTIC_OUTPUT_CHANNEL_ORDER_V2 as readonly string[], channel);
}

export interface RetrievalTraceRequestShapeV1 {
  sources: { code: boolean; architecture: boolean; memory: boolean };
  projectScopeApplied: boolean;
  tenantScope: 'default' | 'named';
  entityScope: 'none' | 'one' | 'few' | 'many';
  tagScope: 'none' | 'one' | 'few' | 'many';
  temporalFilterApplied: boolean;
  queryLength: 'empty' | 'short' | 'medium' | 'long';
  queryForm: 'natural-language' | 'identifier-heavy' | 'mixed';
  tokenBudget: 'small' | 'medium' | 'large' | 'very-large';
  diversification: 'none' | 'mmr';
  plannedChannels: readonly RetrievalTraceChannel[];
}

export interface RetrievalTraceChannelStateV1 {
  channel: RetrievalTraceChannel;
  rank: number;
  score?: number;
}

export interface RetrievalTraceEvidenceStateV1 {
  confidence?: number;
  sourceCount?: number;
  superseded?: boolean;
  invalidated?: boolean;
}

export interface RetrievalTraceCandidateDraft {
  sourceType: RetrievalTraceSourceType;
  channels: readonly RetrievalTraceChannelStateV1[];
  evidence: RetrievalTraceEvidenceStateV1;
  estimatedTokens: number;
}

export interface RetrievalTraceCandidateV1 extends RetrievalTraceCandidateDraft {
  ref: string;
}

declare const CANDIDATE_HANDLE_BRAND: unique symbol;
export type RetrievalTraceCandidateHandle = { readonly [CANDIDATE_HANDLE_BRAND]: true };

export interface RetrievalTraceFilterEventInput {
  name: RetrievalTraceFilterName;
  outcome: 'pass' | 'fail' | 'not-applicable';
}

export interface RetrievalTraceScoreEventInput {
  name: RetrievalTraceScoreName;
  value: number;
}

export type RetrievalTraceChannelSettlement =
  | { outcome: 'success' }
  | { outcome: 'safe-failure'; code: RetrievalTraceFailureCode };

export type RetrievalTraceTerminalInput =
  | { outcome: 'included'; reasons: readonly [] }
  | { outcome: 'excluded' | 'failed'; reasons: readonly RetrievalTraceExclusionReason[]; duplicateOf?: RetrievalTraceCandidateHandle };

export interface RetrievalTraceMmrRecordInput {
  candidate: RetrievalTraceCandidateHandle;
  relevance: number;
  lambda: number;
  pairwise: readonly RetrievalTraceMmrPairwiseInput[];
}

export interface RetrievalTraceMmrPairwiseInput {
  selected: RetrievalTraceCandidateHandle;
  similarity: number;
}

export interface RetrievalTraceMmrPairwiseV1 {
  selectedRef: string;
  similarity: number;
}

export interface RetrievalTraceMmrRecordV1 {
  ref: string;
  relevance: number;
  maxSimilarity: number;
  lambda: number;
  objective: number;
  againstRef: string | null;
  pairwise: readonly RetrievalTraceMmrPairwiseV1[];
}

export interface RetrievalTraceRerankerProviderV2 {
  readonly providerId: string;
  readonly modelId: string;
  readonly calibrationId: string;
  readonly locality: 'local';
}

export interface RetrievalTraceRerankerCandidateV2 {
  readonly ref: string;
  readonly baselineRank: number;
  readonly calibratedScore: number;
  readonly rerankedRank: number;
}

export interface RetrievalTraceRerankerBaselineCandidateV2 {
  readonly ref: string;
  readonly baselineRank: number;
  readonly rerankedRank: number;
}

export type RetrievalTraceRerankerEventV2 =
  | (SequencedEvent & {
      readonly kind: 'reranker-stage';
      readonly provider: RetrievalTraceRerankerProviderV2;
      readonly outcome: 'reranked';
      readonly candidates: readonly RetrievalTraceRerankerCandidateV2[];
    })
  | (SequencedEvent & {
      readonly kind: 'reranker-stage';
      readonly provider: RetrievalTraceRerankerProviderV2;
      readonly outcome: 'baseline';
      readonly reason: 'not-reranked';
      readonly candidates: readonly RetrievalTraceRerankerBaselineCandidateV2[];
    });

export type RetrievalTraceRerankerOutcomeInput =
  | { readonly outcome: 'baseline' }
  | {
      readonly outcome: 'reranked';
      readonly candidates: readonly {
        readonly candidateHandle: RetrievalTraceCandidateHandle;
        readonly calibratedScore: number;
      }[];
    };

interface SequencedEvent { sequence: number }
export type RetrievalTraceStageEventV1 =
  | (SequencedEvent & { kind: 'channel-attempt'; channel: RetrievalTraceChannel })
  | (SequencedEvent & { kind: 'channel-terminal'; channel: RetrievalTraceChannel; outcome: 'success' })
  | (SequencedEvent & { kind: 'channel-terminal'; channel: RetrievalTraceChannel; outcome: 'safe-failure'; code: RetrievalTraceFailureCode })
  | (SequencedEvent & { kind: 'candidate-filter'; ref: string; name: RetrievalTraceFilterName; outcome: 'pass' | 'fail' | 'not-applicable' })
  | (SequencedEvent & { kind: 'candidate-score'; ref: string; name: RetrievalTraceScoreName; value: number })
  | (SequencedEvent & { kind: 'mmr-round'; round: number; selectedRef: string; records: readonly RetrievalTraceMmrRecordV1[] })
  | RetrievalTraceRerankerEventV2
  | (SequencedEvent & { kind: 'ranked-output'; ref: string; rank: number })
  | (SequencedEvent & { kind: 'deterministic-output'; ref: string; rank: number })
  | (SequencedEvent & {
      kind: 'candidate-terminal'; ref: string; outcome: RetrievalTraceTerminalOutcome;
      reasons: readonly RetrievalTraceExclusionReason[]; duplicateOfRef?: string;
    })
  | (SequencedEvent & { kind: 'stage-failure'; stage: RetrievalTraceFailureStage; code: RetrievalTraceFailureCode });

export interface RetrievalTraceTerminalExclusionV1 {
  ref: string;
  outcome: 'excluded' | 'failed';
  reasons: readonly RetrievalTraceExclusionReason[];
  duplicateOfRef?: string;
}

export interface RetrievalTraceV1 {
  schemaVersion: typeof RETRIEVAL_TRACE_VERSION;
  algorithmVersion: RetrievalTraceAlgorithmVersion;
  requestShape: RetrievalTraceRequestShapeV1;
  complete: boolean;
  incompleteReasons: readonly RetrievalTraceIncompleteReason[];
  candidates: readonly RetrievalTraceCandidateV1[];
  events: readonly RetrievalTraceStageEventV1[];
  resultOrder: readonly string[];
  terminalExclusions: readonly RetrievalTraceTerminalExclusionV1[];
  replayStateDigest: string;
}

export interface RetrievalTraceReplayResult {
  resultOrder: readonly string[];
  terminalExclusions: readonly RetrievalTraceTerminalExclusionV1[];
  replayStateDigest: string;
}

export interface RetrievalTraceCollectorOptions {
  maxCandidates?: number;
  maxEvents?: number;
  maxChannelsPerCandidate?: number;
  maxFiltersPerCandidate?: number;
  maxScoresPerCandidate?: number;
  maxExclusionReasonsPerCandidate?: number;
  maxMmrRounds?: number;
  maxMmrRecordsPerRound?: number;
  maxMmrRecordsTotal?: number;
  maxMmrPairwisePerRecord?: number;
  maxMmrPairwiseTotal?: number;
  maxStageFailures?: number;
}

const TRACE_ARRAY = Array;
const TRACE_ARRAY_IS_ARRAY = Array.isArray;
const TRACE_ARRAY_PROTOTYPE = Array.prototype;
const TRACE_ARRAY_ITERATOR = Array.prototype[Symbol.iterator];
const TRACE_ARRAY_POP = Function.prototype.call.bind(Array.prototype.pop) as <T>(input: T[]) => T | undefined;
const TRACE_OBJECT_CREATE = Object.create;
const TRACE_OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const TRACE_OBJECT_FREEZE = Object.freeze;
const TRACE_OBJECT_ENTRIES = Object.entries;
const TRACE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const TRACE_OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const TRACE_OBJECT_HAS_OWN = Object.hasOwn;
const TRACE_OBJECT_PROTOTYPE = Object.prototype;
const TRACE_REFLECT_OWN_KEYS = Reflect.ownKeys;
const TRACE_REFLECT_APPLY = Reflect.apply;
const TRACE_JSON_STRINGIFY = JSON.stringify;
const TRACE_STRING = String;
const TRACE_NUMBER = Number;
const TRACE_NUMBER_IS_FINITE = Number.isFinite;
const TRACE_NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const TRACE_NUMBER_TO_FIXED = Number.prototype.toFixed;
const TRACE_MATH_ABS = Math.abs;
const TRACE_BUFFER_BYTE_LENGTH = Buffer.byteLength;
const TRACE_REGEXP_TEST = RegExp.prototype.test;
const TRACE_REGEXP_EXEC = RegExp.prototype.exec;
const TRACE_REGEXP_SYMBOL_REPLACE = RegExp.prototype[Symbol.replace];
const TRACE_REGEXP_PROTOTYPE = RegExp.prototype;
const TRACE_STRING_INCLUDES = String.prototype.includes;
const TRACE_STRING_STARTS_WITH = String.prototype.startsWith;
const TRACE_STRING_ENDS_WITH = String.prototype.endsWith;
const TRACE_STRING_PAD_START = String.prototype.padStart;
const TRACE_STRING_PAD_END = String.prototype.padEnd;
const TRACE_STRING_REPLACE = String.prototype.replace;
const TRACE_STRING_PROTOTYPE = String.prototype;
const TRACE_OBJECT_IS = Object.is;
const TRACE_MAP = Map;
const TRACE_MAP_GET = Function.prototype.call.bind(Map.prototype.get) as <K, V>(
  map: ReadonlyMap<K, V>, key: K,
) => V | undefined;
const TRACE_MAP_SET = Function.prototype.call.bind(Map.prototype.set) as <K, V>(map: Map<K, V>, key: K, value: V) => Map<K, V>;
const TRACE_MAP_HAS = Function.prototype.call.bind(Map.prototype.has) as <K, V>(
  map: ReadonlyMap<K, V>, key: K,
) => boolean;
const TRACE_MAP_FOR_EACH = Function.prototype.call.bind(Map.prototype.forEach) as <K, V>(
  map: ReadonlyMap<K, V>, callback: (value: V, key: K) => void,
) => void;
const TRACE_MAP_SIZE_GETTER = TRACE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(Map.prototype, 'size')!.get!;
const TRACE_WEAK_MAP_GET = Function.prototype.call.bind(WeakMap.prototype.get) as <K extends object, V>(
  map: WeakMap<K, V>, key: K,
) => V | undefined;
const TRACE_WEAK_MAP_SET = Function.prototype.call.bind(WeakMap.prototype.set) as <K extends object, V>(
  map: WeakMap<K, V>, key: K, value: V,
) => WeakMap<K, V>;
const TRACE_WEAK_MAP = WeakMap;
const TRACE_WEAK_SET = WeakSet;
const TRACE_WEAK_SET_HAS = Function.prototype.call.bind(WeakSet.prototype.has) as <T extends object>(
  set: WeakSet<T>, value: T,
) => boolean;
const TRACE_WEAK_SET_ADD = Function.prototype.call.bind(WeakSet.prototype.add) as <T extends object>(
  set: WeakSet<T>, value: T,
) => WeakSet<T>;
const TRACE_WEAK_SET_DELETE = Function.prototype.call.bind(WeakSet.prototype.delete) as <T extends object>(
  set: WeakSet<T>, value: T,
) => boolean;
const TRACE_SET = Set;
const TRACE_SET_ADD = Function.prototype.call.bind(Set.prototype.add) as <T>(set: Set<T>, value: T) => Set<T>;
const TRACE_SET_HAS = Function.prototype.call.bind(Set.prototype.has) as <T>(set: Set<T>, value: T) => boolean;
const TRACE_SET_FOR_EACH = Function.prototype.call.bind(Set.prototype.forEach) as <T>(
  set: Set<T>, callback: (value: T) => void,
) => void;
const TRACE_SET_SIZE_GETTER = TRACE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(Set.prototype, 'size')!.get!;
const TRACE_ARRAY_SORT = Function.prototype.call.bind(Array.prototype.sort) as <T>(
  input: T[], compare: (left: T, right: T) => number,
) => T[];
const TRACE_ARRAY_ITERATOR_PROTOTYPE = TRACE_OBJECT_GET_PROTOTYPE_OF(
  TRACE_REFLECT_APPLY(TRACE_ARRAY_ITERATOR, [], []) as object,
);
const TRACE_ARRAY_ITERATOR_NEXT = TRACE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  TRACE_ARRAY_ITERATOR_PROTOTYPE,
  'next',
)!.value;
type TraceHash = ReturnType<typeof createHash>;
const TRACE_HASH_UPDATE = Function.prototype.call.bind(createHash('sha256').update) as (
  hash: TraceHash, data: string,
) => TraceHash;
const TRACE_HASH_DIGEST = Function.prototype.call.bind(createHash('sha256').digest) as (
  hash: TraceHash, encoding: 'hex',
) => string;

function defineTraceArrayItem<T>(target: T[], index: number, value: T): void {
  TRACE_OBJECT_DEFINE_PROPERTY(target, TRACE_STRING(index), {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function appendTraceError(errors: string[], message: string): void {
  defineTraceArrayItem(errors, errors.length, message);
}

function joinTraceErrors(errors: readonly string[]): string {
  let message = '';
  for (let index = 0; index < errors.length; index += 1) {
    if (index > 0) message += '; ';
    message += errors[index]!;
  }
  return message;
}

function concatTraceErrors(left: readonly string[], right: readonly string[]): string[] {
  const result = new TRACE_ARRAY<string>(left.length + right.length);
  for (let index = 0; index < left.length; index += 1) defineTraceArrayItem(result, index, left[index]!);
  for (let index = 0; index < right.length; index += 1) defineTraceArrayItem(result, left.length + index, right[index]!);
  return result;
}

function copyTraceArray<T>(source: readonly T[]): T[] {
  const target = new TRACE_ARRAY<T>(source.length);
  for (let index = 0; index < source.length; index += 1) {
    defineTraceArrayItem(target, index, source[index]!);
  }
  return target;
}

function filterTraceArray<T>(source: readonly T[], predicate: (value: T, index: number) => boolean): T[] {
  const target: T[] = [];
  for (let index = 0; index < source.length; index += 1) {
    if (predicate(source[index]!, index)) defineTraceArrayItem(target, target.length, source[index]!);
  }
  return target;
}

function mapTraceArray<T, U>(source: readonly T[], transform: (value: T, index: number) => U): U[] {
  const target = new TRACE_ARRAY<U>(source.length);
  for (let index = 0; index < source.length; index += 1) {
    defineTraceArrayItem(target, index, transform(source[index]!, index));
  }
  return target;
}

function someTraceArray<T>(source: readonly T[], predicate: (value: T, index: number) => boolean): boolean {
  for (let index = 0; index < source.length; index += 1) {
    if (predicate(source[index]!, index)) return true;
  }
  return false;
}

function includesTraceArray<T>(source: readonly T[], value: T): boolean {
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === value) return true;
  }
  return false;
}

function traceRegexTest(pattern: RegExp, value: string): boolean {
  return TRACE_REFLECT_APPLY(TRACE_REGEXP_TEST, pattern, [value]) as boolean;
}

function traceStringIncludes(value: string, search: string): boolean {
  return TRACE_REFLECT_APPLY(TRACE_STRING_INCLUDES, value, [search]) as boolean;
}

function traceStringStartsWith(value: string, search: string): boolean {
  return TRACE_REFLECT_APPLY(TRACE_STRING_STARTS_WITH, value, [search]) as boolean;
}

function traceStringEndsWith(value: string, search: string): boolean {
  return TRACE_REFLECT_APPLY(TRACE_STRING_ENDS_WITH, value, [search]) as boolean;
}

function tracePadStart(value: string, length: number, fill: string): string {
  return TRACE_REFLECT_APPLY(TRACE_STRING_PAD_START, value, [length, fill]) as string;
}

function tracePadEnd(value: string, length: number, fill: string): string {
  return TRACE_REFLECT_APPLY(TRACE_STRING_PAD_END, value, [length, fill]) as string;
}

function traceSha256(value: string): string {
  const hash = createHash('sha256');
  TRACE_HASH_UPDATE(hash, value);
  return TRACE_HASH_DIGEST(hash, 'hex');
}

function assertSecretRedactionIntrinsic(): void {
  const stringReplace = TRACE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(TRACE_STRING_PROTOTYPE, 'replace');
  const arrayIterator = TRACE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(TRACE_ARRAY_PROTOTYPE, Symbol.iterator);
  const arrayIteratorNext = TRACE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(TRACE_ARRAY_ITERATOR_PROTOTYPE, 'next');
  const regexpExec = TRACE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(TRACE_REGEXP_PROTOTYPE, 'exec');
  const regexpReplace = TRACE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(TRACE_REGEXP_PROTOTYPE, Symbol.replace);
  if (!stringReplace || !('value' in stringReplace) || stringReplace.value !== TRACE_STRING_REPLACE
    || !arrayIterator || !('value' in arrayIterator) || arrayIterator.value !== TRACE_ARRAY_ITERATOR
    || !arrayIteratorNext || !('value' in arrayIteratorNext) || arrayIteratorNext.value !== TRACE_ARRAY_ITERATOR_NEXT
    || !regexpExec || !('value' in regexpExec) || regexpExec.value !== TRACE_REGEXP_EXEC
    || !regexpReplace || !('value' in regexpReplace) || regexpReplace.value !== TRACE_REGEXP_SYMBOL_REPLACE) {
    throw new RetrievalTraceValidationError('secret redaction intrinsic integrity check failed');
  }
}

function traceMapValues<K, V>(source: ReadonlyMap<K, V>): V[] {
  const target: V[] = [];
  TRACE_MAP_FOR_EACH(source, (value) => defineTraceArrayItem(target, target.length, value));
  return target;
}

function traceMapSize<K, V>(source: ReadonlyMap<K, V>): number {
  return TRACE_REFLECT_APPLY(TRACE_MAP_SIZE_GETTER, source, []) as number;
}

function traceSetValues<T>(source: Set<T>): T[] {
  const target: T[] = [];
  TRACE_SET_FOR_EACH(source, (value) => defineTraceArrayItem(target, target.length, value));
  return target;
}

function traceSetSize<T>(source: Set<T>): number {
  return TRACE_REFLECT_APPLY(TRACE_SET_SIZE_GETTER, source, []) as number;
}

function traceRecord<T extends object>(fields: T): Readonly<T> {
  const result = TRACE_OBJECT_CREATE(null) as T;
  const keys = TRACE_REFLECT_OWN_KEYS(fields);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    const descriptor = TRACE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(fields, key)!;
    TRACE_OBJECT_DEFINE_PROPERTY(result, key, descriptor);
  }
  return TRACE_OBJECT_FREEZE(result);
}

export class RetrievalTraceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetrievalTraceValidationError';
  }
}

export class RetrievalTraceLimitError extends RetrievalTraceValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'RetrievalTraceLimitError';
  }
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function enumHas<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && includesTraceArray(values as readonly string[], value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  if (isProxy(value)) return false;
  if (TRACE_ARRAY_IS_ARRAY(value)) return false;
  const prototype = TRACE_OBJECT_GET_PROTOTYPE_OF(value);
  return prototype === TRACE_OBJECT_PROTOTYPE || prototype === null;
}

function safeRecord(value: unknown, label: string, errors: string[]): Record<string, unknown> | undefined {
  if (!isPlainRecord(value)) { appendTraceError(errors, `${label} must be a plain data object`); return undefined; }
  const before = errors.length;
  inspectObject(value, label, errors);
  return errors.length === before ? value : undefined;
}

function inspectObject(value: Record<string, unknown>, label: string, errors: string[]): string[] {
  const keys: string[] = [];
  const ownKeys = TRACE_REFLECT_OWN_KEYS(value);
  for (let index = 0; index < ownKeys.length; index += 1) {
    const key = ownKeys[index]!;
    if (typeof key !== 'string') { appendTraceError(errors, `${label} has non-string fields`); continue; }
    if (TRACE_SET_HAS(DANGEROUS_KEYS, key)) { appendTraceError(errors, `${label} has dangerous fields`); continue; }
    const descriptor = TRACE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, key);
    if (descriptor && !('value' in descriptor)) {
      appendTraceError(errors, `${label} has accessor fields`);
      continue;
    }
    if (!descriptor?.enumerable) {
      appendTraceError(errors, `${label} has non-data fields`);
      continue;
    }
    defineTraceArrayItem(keys, keys.length, key);
  }
  return keys;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string, errors: string[]): void {
  const keys = inspectObject(value, label, errors);
  if (someTraceArray(keys, (key) => !includesTraceArray(allowed, key))) appendTraceError(errors, `${label} has unknown fields`);
}

function requireKeys(value: Record<string, unknown>, required: readonly string[], label: string, errors: string[]): void {
  if (someTraceArray(required, (key) => !TRACE_OBJECT_HAS_OWN(value, key))) appendTraceError(errors, `${label} is missing required fields`);
}

function denseArray(value: unknown, max: number, label: string, errors: string[]): unknown[] | undefined {
  if (value === null || typeof value !== 'object' || isProxy(value) || !TRACE_ARRAY_IS_ARRAY(value)
    || TRACE_OBJECT_GET_PROTOTYPE_OF(value) !== TRACE_ARRAY_PROTOTYPE) {
    appendTraceError(errors, `${label} must be a plain array`);
    return undefined;
  }
  const lengthDescriptor = TRACE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, 'length');
  const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value as unknown : undefined;
  if (!validInteger(length, 0, max)) { appendTraceError(errors, `${label} exceeds hard limit`); return undefined; }
  let invalid = false;
  for (let index = 0; index < length; index++) {
    const descriptor = TRACE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, TRACE_STRING(index));
    if (!descriptor) { appendTraceError(errors, `${label} must not be sparse`); invalid = true; break; }
    if (!('value' in descriptor)) { appendTraceError(errors, `${label} contains accessor fields`); invalid = true; break; }
    if (!descriptor.enumerable) { appendTraceError(errors, `${label} has non-data entries`); invalid = true; break; }
  }
  if (invalid) return undefined;
  const ownKeys = TRACE_REFLECT_OWN_KEYS(value);
  for (let index = 0; index < ownKeys.length; index += 1) {
    const key = ownKeys[index]!;
    if (typeof key !== 'string') { appendTraceError(errors, `${label} has non-string fields`); continue; }
    if (key === 'length') continue;
    if (!traceRegexTest(/^(0|[1-9]\d*)$/, key) || TRACE_NUMBER(key) >= length) appendTraceError(errors, `${label} has ambiguous fields`);
    const descriptor = TRACE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, key);
    if (descriptor && !('value' in descriptor)) appendTraceError(errors, `${label} contains accessor fields`);
    else if (!descriptor?.enumerable) appendTraceError(errors, `${label} has non-data entries`);
  }
  return someTraceArray(errors, (error) => traceStringStartsWith(error, label)) ? undefined : value;
}

function preflightTraceStructure(root: unknown): string[] {
  const seen = new TRACE_WEAK_SET<object>();
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let arrays = 0;
  let arrayEntries = 0;
  let records = 0;
  let recordFields = 0;
  let scalarBytes = 0;
  while (stack.length > 0) {
    const current = TRACE_ARRAY_POP(stack)!;
    if (current.depth > AGGREGATE_LIMITS.depth) return ['trace exceeds aggregate depth budget'];
    if (current.value === null) {
      scalarBytes += 4;
      if (scalarBytes > AGGREGATE_LIMITS.scalarBytes) return ['trace exceeds aggregate byte budget'];
      continue;
    }
    if (typeof current.value === 'string') {
      if (current.value.length > AGGREGATE_LIMITS.scalarBytes - scalarBytes) {
        return ['trace exceeds aggregate byte budget'];
      }
      scalarBytes += TRACE_BUFFER_BYTE_LENGTH(current.value, 'utf8');
      if (scalarBytes > AGGREGATE_LIMITS.scalarBytes) return ['trace exceeds aggregate byte budget'];
      continue;
    }
    if (typeof current.value === 'number' || typeof current.value === 'boolean') {
      scalarBytes += 8;
      if (scalarBytes > AGGREGATE_LIMITS.scalarBytes) return ['trace exceeds aggregate byte budget'];
      continue;
    }
    if (typeof current.value !== 'object' || isProxy(current.value)) return ['trace contains exotic values'];
    if (TRACE_WEAK_SET_HAS(seen, current.value)) return ['trace contains shared or cyclic references'];
    TRACE_WEAK_SET_ADD(seen, current.value);
    if (TRACE_ARRAY_IS_ARRAY(current.value)) {
      if (TRACE_OBJECT_GET_PROTOTYPE_OF(current.value) !== TRACE_ARRAY_PROTOTYPE) return ['trace contains exotic values'];
      arrays++;
      if (arrays > AGGREGATE_LIMITS.arrays) return ['trace exceeds aggregate array budget'];
      const lengthDescriptor = TRACE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(current.value, 'length');
      const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value as unknown : undefined;
      if (!validInteger(length, 0, AGGREGATE_LIMITS.arrayEntries)) return ['trace exceeds aggregate array budget'];
      arrayEntries += length;
      if (arrayEntries > AGGREGATE_LIMITS.arrayEntries) return ['trace exceeds aggregate array budget'];
      for (let index = 0; index < length; index++) {
        const descriptor = TRACE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(current.value, TRACE_STRING(index));
        if (!descriptor) return ['trace contains sparse arrays'];
        if (!('value' in descriptor)) return ['trace contains accessor fields'];
        if (!descriptor.enumerable) return ['trace contains exotic values'];
        defineTraceArrayItem(stack, stack.length, { value: descriptor.value, depth: current.depth + 1 });
      }
      const keys = TRACE_REFLECT_OWN_KEYS(current.value);
      let ambiguous = false;
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index]!;
        if (typeof key !== 'string'
          || (key !== 'length' && (!traceRegexTest(/^(0|[1-9]\d*)$/, key) || TRACE_NUMBER(key) >= length))) ambiguous = true;
      }
      if (ambiguous) {
        return ['trace contains exotic values'];
      }
      continue;
    }
    const prototype = TRACE_OBJECT_GET_PROTOTYPE_OF(current.value);
    if (prototype !== TRACE_OBJECT_PROTOTYPE && prototype !== null) return ['trace contains exotic values'];
    records++;
    if (records > AGGREGATE_LIMITS.records) return ['trace exceeds aggregate record budget'];
    const keys = TRACE_REFLECT_OWN_KEYS(current.value);
    recordFields += keys.length;
    if (recordFields > AGGREGATE_LIMITS.recordFields) return ['trace exceeds aggregate record budget'];
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index]!;
      if (typeof key !== 'string') return ['trace contains exotic values'];
      if (TRACE_SET_HAS(DANGEROUS_KEYS, key)) return ['trace contains dangerous fields'];
      if (key.length > AGGREGATE_LIMITS.scalarBytes - scalarBytes) {
        return ['trace exceeds aggregate byte budget'];
      }
      scalarBytes += TRACE_BUFFER_BYTE_LENGTH(key, 'utf8');
      if (scalarBytes > AGGREGATE_LIMITS.scalarBytes) return ['trace exceeds aggregate byte budget'];
      const descriptor = TRACE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(current.value, key);
      if (!descriptor || !('value' in descriptor)) return ['trace contains accessor fields'];
      if (!descriptor.enumerable) return ['trace contains exotic values'];
      defineTraceArrayItem(stack, stack.length, { value: descriptor.value, depth: current.depth + 1 });
    }
  }
  return [];
}

function validInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && TRACE_NUMBER_IS_SAFE_INTEGER(value) && value >= min && value <= max;
}

function validateRoundedNumber(value: unknown, label: string, errors: string[], min: number, max: number): void {
  if (typeof value !== 'number' || !TRACE_NUMBER_IS_FINITE(value)) { appendTraceError(errors, `${label} must be finite`); return; }
  if (value < min || value > max) appendTraceError(errors, `${label} is outside semantic bounds`);
  if (roundTraceNumber(value) !== value || TRACE_OBJECT_IS(value, -0)) appendTraceError(errors, `${label} must be canonically rounded`);
}

export function roundTraceNumber(value: number): number {
  if (!TRACE_NUMBER_IS_FINITE(value) || TRACE_MATH_ABS(value) > MAX_TRACE_NUMBER) {
    throw new RetrievalTraceValidationError('trace number is outside safe finite bounds');
  }
  const rounded = TRACE_NUMBER(TRACE_REFLECT_APPLY(
    TRACE_NUMBER_TO_FIXED,
    value,
    [RETRIEVAL_TRACE_NUMBER_DECIMALS],
  ));
  return TRACE_OBJECT_IS(rounded, -0) ? 0 : rounded;
}

function canonicalizeValue(value: unknown, path: string, ancestors: WeakSet<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return roundTraceNumber(value);
  if (typeof value !== 'object') throw new RetrievalTraceValidationError(`${path} contains a non-canonical value`);
  if (TRACE_WEAK_SET_HAS(ancestors, value)) throw new RetrievalTraceValidationError(`${path} contains a cycle`);
  TRACE_WEAK_SET_ADD(ancestors, value);
  try {
    if (TRACE_ARRAY_IS_ARRAY(value)) {
      const errors: string[] = [];
      const items = denseArray(
        value,
        path === 'trace.events' ? HARD_LIMITS.traceEvents : HARD_LIMITS.genericArrayEntries,
        path,
        errors,
      );
      if (!items || errors.length > 0) throw new RetrievalTraceValidationError(joinTraceErrors(errors));
      const result = new TRACE_ARRAY<unknown>(items.length);
      for (let index = 0; index < items.length; index += 1) {
        defineTraceArrayItem(result, index, canonicalizeValue(items[index], `${path}[${index}]`, ancestors));
      }
      return result;
    }
    if (!isPlainRecord(value)) throw new RetrievalTraceValidationError(`${path} contains a non-canonical object`);
    const errors: string[] = [];
    const keys = inspectObject(value, path, errors);
    if (errors.length > 0) throw new RetrievalTraceValidationError(joinTraceErrors(errors));
    const out: Record<string, unknown> = TRACE_OBJECT_CREATE(null) as Record<string, unknown>;
    TRACE_ARRAY_SORT(keys, compareText);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index]!;
      const child = value[key];
      if (child === undefined) throw new RetrievalTraceValidationError(`${path} contains undefined`);
      out[key] = canonicalizeValue(child, `${path}.${key}`, ancestors);
    }
    return out;
  } finally {
    TRACE_WEAK_SET_DELETE(ancestors, value);
  }
}

/** Stable, JSON-safe canonicalization with sorted keys and six-decimal finite numbers. */
export function canonicalTraceJson(value: unknown): string {
  const preflight = preflightTraceStructure(value);
  if (preflight.length > 0) throw new RetrievalTraceValidationError(joinTraceErrors(preflight));
  return TRACE_JSON_STRINGIFY(canonicalizeValue(value, 'trace', new TRACE_WEAK_SET()));
}

function validateRequestShape(
  value: unknown,
  errors: string[],
  algorithmVersion: RetrievalTraceAlgorithmVersion = 'ranked-v1',
): void {
  const request = safeRecord(value, 'trace.requestShape', errors);
  if (!request) return;
  const keys = [
    'sources', 'projectScopeApplied', 'tenantScope', 'entityScope', 'tagScope',
    'temporalFilterApplied', 'queryLength', 'queryForm', 'tokenBudget', 'diversification', 'plannedChannels',
  ];
  exactKeys(request, keys, 'trace.requestShape', errors);
  requireKeys(request, keys, 'trace.requestShape', errors);
  const sources = safeRecord(request.sources, 'trace.requestShape.sources', errors);
  if (!sources) return;
  else {
    exactKeys(sources, ['code', 'architecture', 'memory'], 'trace.requestShape.sources', errors);
    requireKeys(sources, ['code', 'architecture', 'memory'], 'trace.requestShape.sources', errors);
    const sourceKeys = ['code', 'architecture', 'memory'] as const;
    for (let index = 0; index < sourceKeys.length; index += 1) {
      if (typeof sources[sourceKeys[index]!] !== 'boolean') appendTraceError(errors, 'trace.requestShape.sources has invalid flags');
    }
  }
  if (typeof request.projectScopeApplied !== 'boolean' || typeof request.temporalFilterApplied !== 'boolean') {
    appendTraceError(errors, 'trace.requestShape has invalid boolean flags');
  }
  if (request.tenantScope !== 'default' && request.tenantScope !== 'named') appendTraceError(errors, 'trace.requestShape.tenantScope is invalid');
  if (!enumHas(CARDINALITY_BUCKETS, request.entityScope) || !enumHas(CARDINALITY_BUCKETS, request.tagScope)) {
    appendTraceError(errors, 'trace.requestShape has invalid scope buckets');
  }
  if (!enumHas(QUERY_LENGTHS, request.queryLength) || !enumHas(QUERY_FORMS, request.queryForm)) {
    appendTraceError(errors, 'trace.requestShape has invalid query buckets');
  }
  if (!enumHas(TOKEN_BUDGETS, request.tokenBudget) || !enumHas(DIVERSIFICATION, request.diversification)) {
    appendTraceError(errors, 'trace.requestShape has invalid strategy buckets');
  }
  const planned = denseArray(request.plannedChannels, HARD_LIMITS.plannedChannels, 'trace.requestShape.plannedChannels', errors);
  if (planned) {
    if (someTraceArray(planned, (channel) => !enumHas(RETRIEVAL_TRACE_CHANNEL_ORDER, channel))) {
      appendTraceError(errors, 'trace.requestShape.plannedChannels has invalid channels');
    }
    const plannedSet = new TRACE_SET<unknown>();
    for (let index = 0; index < planned.length; index += 1) TRACE_SET_ADD(plannedSet, planned[index]);
    if (traceSetSize(plannedSet) !== planned.length) appendTraceError(errors, 'trace.requestShape.plannedChannels has duplicates');
    const order = orderForAlgorithm(algorithmVersion);
    const sorted = copyTraceArray(planned);
    TRACE_ARRAY_SORT(sorted, (a, b) => (TRACE_MAP_GET(order, a as RetrievalTraceChannel) ?? 99)
      - (TRACE_MAP_GET(order, b as RetrievalTraceChannel) ?? 99));
    if (canonicalTraceJson(planned) !== canonicalTraceJson(sorted)) appendTraceError(errors, 'trace.requestShape.plannedChannels is not canonical');
  }
}

function validateEvidence(value: unknown, label: string, errors: string[]): void {
  const evidence = safeRecord(value, label, errors);
  if (!evidence) return;
  exactKeys(evidence, ['confidence', 'sourceCount', 'superseded', 'invalidated'], label, errors);
  if (evidence.confidence !== undefined) validateRoundedNumber(evidence.confidence, `${label}.confidence`, errors, 0, 1);
  if (evidence.sourceCount !== undefined && !validInteger(evidence.sourceCount, 0, 64)) appendTraceError(errors, `${label}.sourceCount is outside semantic bounds`);
  if (evidence.superseded !== undefined && typeof evidence.superseded !== 'boolean') appendTraceError(errors, `${label}.superseded must be boolean`);
  if (evidence.invalidated !== undefined && typeof evidence.invalidated !== 'boolean') appendTraceError(errors, `${label}.invalidated must be boolean`);
}

function validateCandidate(
  value: unknown,
  index: number,
  errors: string[],
  algorithmVersion: RetrievalTraceAlgorithmVersion = 'ranked-v1',
): void {
  const label = `trace.candidates[${index}]`;
  const candidate = safeRecord(value, label, errors);
  if (!candidate) return;
  exactKeys(candidate, ['ref', 'sourceType', 'channels', 'evidence', 'estimatedTokens'], label, errors);
  requireKeys(candidate, ['ref', 'sourceType', 'channels', 'evidence', 'estimatedTokens'], label, errors);
  if (typeof candidate.ref !== 'string' || !traceRegexTest(/^c\d{4}$/, candidate.ref)) appendTraceError(errors, `${label}.ref is invalid`);
  if (!enumHas(SOURCE_TYPES, candidate.sourceType)) appendTraceError(errors, `${label}.sourceType is invalid`);
  const channels = denseArray(candidate.channels, HARD_LIMITS.channelsPerCandidate, `${label}.channels`, errors);
  if (channels && channels.length === 0) appendTraceError(errors, `${label}.channels must be non-empty`);
  if (channels) {
    for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
      const raw = channels[channelIndex];
      const channelLabel = `${label}.channels[${channelIndex}]`;
      const channel = safeRecord(raw, channelLabel, errors);
      if (!channel) continue;
      exactKeys(channel, ['channel', 'rank', 'score'], channelLabel, errors);
      requireKeys(channel, ['channel', 'rank'], channelLabel, errors);
      if (!enumHas(RETRIEVAL_TRACE_CHANNEL_ORDER, channel.channel)) appendTraceError(errors, `${channelLabel}.channel is invalid`);
      if (!validInteger(channel.rank, 1, HARD_LIMITS.candidates)) appendTraceError(errors, `${channelLabel}.rank is outside semantic bounds`);
      if (channel.score !== undefined) validateRoundedNumber(channel.score, `${channelLabel}.score`, errors, -1, 1);
    }
  }
  if (channels) {
    const identities = mapTraceArray(channels, (raw) => isPlainRecord(raw)
      ? `${String(raw.channel)}:${String(raw.rank)}` : 'invalid');
    const identitySet = new TRACE_SET<string>();
    for (let index = 0; index < identities.length; index += 1) TRACE_SET_ADD(identitySet, identities[index]!);
    if (traceSetSize(identitySet) !== identities.length) appendTraceError(errors, `${label}.channels has duplicates`);
    const sorted = copyTraceArray(channels);
    TRACE_ARRAY_SORT(sorted, (a, b) => compareChannelState(a, b, algorithmVersion));
    if (canonicalTraceJson(channels) !== canonicalTraceJson(sorted)) appendTraceError(errors, `${label}.channels is not canonical`);
    if (algorithmVersion === 'deterministic-v2') {
      if (channels.length !== 1) appendTraceError(errors, `${label} must have exactly one source-final channel for deterministic-v2`);
      const sourceFinal = isPlainRecord(channels[0]) ? channels[0].channel : undefined;
      if (!isDeterministicV2OutputChannel(sourceFinal)) {
        appendTraceError(errors, `${label} has an invalid deterministic-v2 source-final channel`);
      } else if (candidate.sourceType !== deterministicV2SourceBinding[sourceFinal]) {
        appendTraceError(errors, `${label} sourceType disagrees with its deterministic-v2 source-final channel`);
      }
    }
  }
  validateEvidence(candidate.evidence, `${label}.evidence`, errors);
  if (!validInteger(candidate.estimatedTokens, 0, 1_000_000)) appendTraceError(errors, `${label}.estimatedTokens is outside semantic bounds`);
}

function scoreBounds(name: RetrievalTraceScoreName): readonly [number, number] {
  if (traceStringEndsWith(name, 'multiplier')) return [0, 4];
  if (name === 'input') return [-1, 1];
  if (name === 'final') return [0, 4];
  return [0, 1];
}

function validateReasons(value: unknown, label: string, errors: string[]): RetrievalTraceExclusionReason[] | undefined {
  const reasons = denseArray(value, HARD_LIMITS.exclusionReasonsPerCandidate, label, errors);
  if (!reasons) return undefined;
  if (someTraceArray(reasons, (reason) => !enumHas(EXCLUSION_REASONS, reason))) appendTraceError(errors, `${label} has invalid reasons`);
  const reasonSet = new TRACE_SET<unknown>();
  for (let index = 0; index < reasons.length; index += 1) TRACE_SET_ADD(reasonSet, reasons[index]);
  if (traceSetSize(reasonSet) !== reasons.length) appendTraceError(errors, `${label} has duplicates`);
  const sorted = copyTraceArray(reasons);
  TRACE_ARRAY_SORT(sorted, (a, b) => compareText(String(a), String(b)));
  if (canonicalTraceJson(reasons) !== canonicalTraceJson(sorted)) appendTraceError(errors, `${label} is not canonical`);
  return reasons as RetrievalTraceExclusionReason[];
}

function validateMmrRecords(value: unknown, label: string, errors: string[]): void {
  const records = denseArray(value, HARD_LIMITS.mmrRecordsPerRound, label, errors);
  if (!records) return;
  if (records.length === 0) appendTraceError(errors, `${label} must be non-empty`);
  for (let index = 0; index < records.length; index += 1) {
    const raw = records[index];
    const recordLabel = `${label}[${index}]`;
    const record = safeRecord(raw, recordLabel, errors);
    if (!record) continue;
    exactKeys(record, ['ref', 'relevance', 'maxSimilarity', 'lambda', 'objective', 'againstRef', 'pairwise'], recordLabel, errors);
    requireKeys(record, ['ref', 'relevance', 'maxSimilarity', 'lambda', 'objective', 'againstRef', 'pairwise'], recordLabel, errors);
    if (typeof record.ref !== 'string' || !traceRegexTest(/^c\d{4}$/, record.ref)) appendTraceError(errors, `${recordLabel}.ref is invalid`);
    validateRoundedNumber(record.relevance, `${recordLabel}.relevance`, errors, 0, 1);
    validateRoundedNumber(record.maxSimilarity, `${recordLabel}.maxSimilarity`, errors, -1, 1);
    validateRoundedNumber(record.lambda, `${recordLabel}.lambda`, errors, 0, 1);
    validateRoundedNumber(record.objective, `${recordLabel}.objective`, errors, -1, 1);
    if (record.againstRef !== null && (typeof record.againstRef !== 'string' || !traceRegexTest(/^c\d{4}$/, record.againstRef))) {
      appendTraceError(errors, `${recordLabel}.againstRef is invalid`);
    }
    const pairwise = denseArray(record.pairwise, HARD_LIMITS.mmrPairwisePerRecord, `${recordLabel}.pairwise`, errors);
    if (pairwise) {
      for (let pairIndex = 0; pairIndex < pairwise.length; pairIndex += 1) {
        const rawPair = pairwise[pairIndex];
        const pairLabel = `${recordLabel}.pairwise[${pairIndex}]`;
        const pair = safeRecord(rawPair, pairLabel, errors);
        if (!pair) continue;
        exactKeys(pair, ['selectedRef', 'similarity'], pairLabel, errors);
        requireKeys(pair, ['selectedRef', 'similarity'], pairLabel, errors);
        if (typeof pair.selectedRef !== 'string' || !traceRegexTest(/^c\d{4}$/, pair.selectedRef)) appendTraceError(errors, `${pairLabel}.selectedRef is invalid`);
        validateRoundedNumber(pair.similarity, `${pairLabel}.similarity`, errors, -1, 1);
      }
    }
    if (pairwise) {
      const pairRefs = mapTraceArray(pairwise, (pair) => safeRecord(pair, `${recordLabel}.pairwise`, [])?.selectedRef);
      const pairRefSet = new TRACE_SET<unknown>();
      for (let pairIndex = 0; pairIndex < pairRefs.length; pairIndex += 1) TRACE_SET_ADD(pairRefSet, pairRefs[pairIndex]);
      if (traceSetSize(pairRefSet) !== pairRefs.length) appendTraceError(errors, `${recordLabel}.pairwise has duplicate refs`);
      const sortedPairs = copyTraceArray(pairwise);
      TRACE_ARRAY_SORT(sortedPairs, (a, b) => compareText(
        String(safeRecord(a, 'pair', [])?.selectedRef),
        String(safeRecord(b, 'pair', [])?.selectedRef),
      ));
      if (canonicalTraceJson(pairwise) !== canonicalTraceJson(sortedPairs)) appendTraceError(errors, `${recordLabel}.pairwise is not canonical`);
    }
  }
  const refs = mapTraceArray(records, (raw) => isPlainRecord(raw) ? raw.ref : undefined);
  const refSet = new TRACE_SET<unknown>();
  for (let index = 0; index < refs.length; index += 1) TRACE_SET_ADD(refSet, refs[index]);
  if (traceSetSize(refSet) !== refs.length) appendTraceError(errors, `${label} has duplicate refs`);
  const sorted = copyTraceArray(records);
  TRACE_ARRAY_SORT(sorted, (a, b) => compareText(
    String(isPlainRecord(a) ? a.ref : ''),
    String(isPlainRecord(b) ? b.ref : ''),
  ));
  if (canonicalTraceJson(records) !== canonicalTraceJson(sorted)) appendTraceError(errors, `${label} is not canonical`);
}

function validateEvent(
  value: unknown,
  index: number,
  errors: string[],
  algorithmVersion: RetrievalTraceAlgorithmVersion,
): void {
  const label = `trace.events[${index}]`;
  const event = safeRecord(value, label, errors);
  if (!event) return;
  if (!validInteger(event.sequence, 1, HARD_LIMITS.traceEvents)) appendTraceError(errors, `${label}.sequence is invalid`);
  if (typeof event.kind !== 'string') { appendTraceError(errors, `${label}.kind is invalid`); return; }
  const refValid = (ref: unknown) => typeof ref === 'string' && traceRegexTest(/^c\d{4}$/, ref);
  switch (event.kind) {
    case 'channel-attempt':
      exactKeys(event, ['sequence', 'kind', 'channel'], label, errors);
      requireKeys(event, ['sequence', 'kind', 'channel'], label, errors);
      if (!enumHas(RETRIEVAL_TRACE_CHANNEL_ORDER, event.channel)) appendTraceError(errors, `${label}.channel is invalid`);
      break;
    case 'channel-terminal': {
      const success = event.outcome === 'success';
      exactKeys(event, success ? ['sequence', 'kind', 'channel', 'outcome'] : ['sequence', 'kind', 'channel', 'outcome', 'code'], label, errors);
      requireKeys(event, success ? ['sequence', 'kind', 'channel', 'outcome'] : ['sequence', 'kind', 'channel', 'outcome', 'code'], label, errors);
      if (!enumHas(RETRIEVAL_TRACE_CHANNEL_ORDER, event.channel)) appendTraceError(errors, `${label}.channel is invalid`);
      if (event.outcome !== 'success' && event.outcome !== 'safe-failure') appendTraceError(errors, `${label}.outcome is invalid`);
      if (event.outcome === 'safe-failure' && !enumHas(FAILURE_CODES, event.code)) appendTraceError(errors, `${label}.code is invalid`);
      break;
    }
    case 'candidate-filter':
      exactKeys(event, ['sequence', 'kind', 'ref', 'name', 'outcome'], label, errors);
      requireKeys(event, ['sequence', 'kind', 'ref', 'name', 'outcome'], label, errors);
      if (!refValid(event.ref) || !enumHas(FILTERS, event.name) || !enumHas(FILTER_OUTCOMES, event.outcome)) appendTraceError(errors, `${label} is invalid`);
      break;
    case 'candidate-score': {
      exactKeys(event, ['sequence', 'kind', 'ref', 'name', 'value'], label, errors);
      requireKeys(event, ['sequence', 'kind', 'ref', 'name', 'value'], label, errors);
      if (!refValid(event.ref) || !enumHas(SCORE_NAMES, event.name)) appendTraceError(errors, `${label} is invalid`);
      else {
        const [min, max] = scoreBounds(event.name);
        validateRoundedNumber(event.value, `${label}.value`, errors, min, max);
      }
      break;
    }
    case 'mmr-round':
      exactKeys(event, ['sequence', 'kind', 'round', 'selectedRef', 'records'], label, errors);
      requireKeys(event, ['sequence', 'kind', 'round', 'selectedRef', 'records'], label, errors);
      if (!validInteger(event.round, 1, HARD_LIMITS.mmrRounds) || !refValid(event.selectedRef)) appendTraceError(errors, `${label} is invalid`);
      validateMmrRecords(event.records, `${label}.records`, errors);
      break;
    case 'reranker-stage': {
      if (algorithmVersion !== 'ranked-v2') appendTraceError(errors, `${label} is illegal for this algorithm`);
      const reranked = event.outcome === 'reranked';
      const keys = reranked
        ? ['sequence', 'kind', 'provider', 'outcome', 'candidates']
        : ['sequence', 'kind', 'provider', 'outcome', 'reason', 'candidates'];
      exactKeys(event, keys, label, errors);
      requireKeys(event, keys, label, errors);
      if (!reranked && (event.outcome !== 'baseline' || event.reason !== 'not-reranked')) {
        appendTraceError(errors, `${label}.outcome is invalid`);
      }
      const provider = safeRecord(event.provider, `${label}.provider`, errors);
      if (provider) {
        const providerKeys = ['providerId', 'modelId', 'calibrationId', 'locality'];
        exactKeys(provider, providerKeys, `${label}.provider`, errors);
        requireKeys(provider, providerKeys, `${label}.provider`, errors);
        if (provider.providerId !== SERVED_RERANKER_PROVIDER_IDENTITY.providerId
          || provider.modelId !== SERVED_RERANKER_PROVIDER_IDENTITY.modelId
          || provider.calibrationId !== SERVED_RERANKER_PROVIDER_IDENTITY.calibrationId
          || provider.locality !== 'local') appendTraceError(errors, `${label}.provider is invalid`);
        const identityKeys = ['providerId', 'modelId', 'calibrationId'] as const;
        for (let index = 0; index < identityKeys.length; index += 1) {
          const key = identityKeys[index]!;
          if (typeof provider[key] !== 'string' || TRACE_BUFFER_BYTE_LENGTH(provider[key] as string, 'utf8') > 128
            || !traceRegexTest(/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/, provider[key] as string)) {
            appendTraceError(errors, `${label}.provider is invalid`);
          }
        }
      }
      const candidates = denseArray(event.candidates, 128, `${label}.candidates`, errors);
      if (candidates) {
        for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
          const raw = candidates[candidateIndex];
          const candidateLabel = `${label}.candidates[${candidateIndex}]`;
          const candidate = safeRecord(raw, candidateLabel, errors);
          if (!candidate) continue;
          const candidateKeys = reranked
            ? ['ref', 'baselineRank', 'calibratedScore', 'rerankedRank']
            : ['ref', 'baselineRank', 'rerankedRank'];
          exactKeys(candidate, candidateKeys, candidateLabel, errors);
          requireKeys(candidate, candidateKeys, candidateLabel, errors);
          if (!refValid(candidate.ref)
            || !validInteger(candidate.baselineRank, 1, 128)
            || !validInteger(candidate.rerankedRank, 1, 128)) appendTraceError(errors, `${candidateLabel} is invalid`);
          if (reranked) validateRoundedNumber(
            candidate.calibratedScore,
            `${candidateLabel}.calibratedScore`,
            errors,
            0,
            1,
          );
        }
      }
      if (candidates) {
        const refs = new TRACE_SET<unknown>();
        const rerankedRanks = new TRACE_ARRAY<unknown>(candidates.length);
        let baselineDense = true;
        let baselineUnchanged = true;
        for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
          const raw = candidates[candidateIndex];
          const candidate = isPlainRecord(raw) ? raw : undefined;
          const ref = candidate?.ref;
          if (TRACE_SET_HAS(refs, ref)) appendTraceError(errors, `${label}.candidates has duplicate refs`);
          TRACE_SET_ADD(refs, ref);
          if (candidate?.baselineRank !== candidateIndex + 1) baselineDense = false;
          if (candidate?.rerankedRank !== candidateIndex + 1) baselineUnchanged = false;
          defineTraceArrayItem(rerankedRanks, candidateIndex, candidate?.rerankedRank);
        }
        if (!baselineDense) appendTraceError(errors, `${label}.candidates baseline ranks are not dense canonical order`);
        const sortedRanks = copyTraceArray(rerankedRanks);
        TRACE_ARRAY_SORT(sortedRanks, (a, b) => TRACE_NUMBER(a) - TRACE_NUMBER(b));
        let rankPermutation = true;
        for (let index = 0; index < sortedRanks.length; index += 1) {
          if (sortedRanks[index] !== index + 1) rankPermutation = false;
        }
        if (!rankPermutation) {
          appendTraceError(errors, `${label}.candidates reranked ranks are not a permutation`);
        }
        if (!reranked && !baselineUnchanged) {
          appendTraceError(errors, `${label}.baseline ranks changed`);
        }
        if (reranked) {
          const derived = copyTraceArray(candidates);
          TRACE_ARRAY_SORT(derived, (left, right) => {
            const a = left as Record<string, unknown>;
            const b = right as Record<string, unknown>;
            return TRACE_NUMBER(b.calibratedScore) - TRACE_NUMBER(a.calibratedScore)
              || TRACE_NUMBER(a.baselineRank) - TRACE_NUMBER(b.baselineRank)
              || compareText(TRACE_STRING(a.ref), TRACE_STRING(b.ref));
          });
          let canonicalRanks = true;
          for (let index = 0; index < derived.length; index += 1) {
            if ((derived[index] as Record<string, unknown>).rerankedRank !== index + 1) canonicalRanks = false;
          }
          if (!canonicalRanks) {
            appendTraceError(errors, `${label}.reranked ranks do not match calibrated order`);
          }
        }
      }
      break;
    }
    case 'ranked-output':
    case 'deterministic-output':
      exactKeys(event, ['sequence', 'kind', 'ref', 'rank'], label, errors);
      requireKeys(event, ['sequence', 'kind', 'ref', 'rank'], label, errors);
      if (!refValid(event.ref) || !validInteger(event.rank, 1, HARD_LIMITS.candidates)) appendTraceError(errors, `${label} is invalid`);
      break;
    case 'candidate-terminal': {
      const allowed = ['sequence', 'kind', 'ref', 'outcome', 'reasons', 'duplicateOfRef'];
      exactKeys(event, allowed, label, errors);
      requireKeys(event, ['sequence', 'kind', 'ref', 'outcome', 'reasons'], label, errors);
      if (!refValid(event.ref) || !enumHas(TERMINAL_OUTCOMES, event.outcome)) appendTraceError(errors, `${label} is invalid`);
      const reasons = validateReasons(event.reasons, `${label}.reasons`, errors);
      if (event.outcome === 'included' && reasons?.length !== 0) appendTraceError(errors, `${label}.reasons must be empty for included`);
      if (event.outcome !== 'included' && reasons?.length === 0) appendTraceError(errors, `${label}.reasons must be non-empty for non-included`);
      if (event.duplicateOfRef !== undefined && !refValid(event.duplicateOfRef)) appendTraceError(errors, `${label}.duplicateOfRef is invalid`);
      break;
    }
    case 'stage-failure':
      exactKeys(event, ['sequence', 'kind', 'stage', 'code'], label, errors);
      requireKeys(event, ['sequence', 'kind', 'stage', 'code'], label, errors);
      if (!enumHas(FAILURE_STAGES, event.stage) || !enumHas(FAILURE_CODES, event.code)) appendTraceError(errors, `${label} is invalid`);
      break;
    default:
      appendTraceError(errors, `${label}.kind is invalid`);
  }
}

function validateTerminalExclusion(value: unknown, index: number, errors: string[]): void {
  const label = `trace.terminalExclusions[${index}]`;
  const exclusion = safeRecord(value, label, errors);
  if (!exclusion) return;
  exactKeys(exclusion, ['ref', 'outcome', 'reasons', 'duplicateOfRef'], label, errors);
  requireKeys(exclusion, ['ref', 'outcome', 'reasons'], label, errors);
  if (typeof exclusion.ref !== 'string' || !traceRegexTest(/^c\d{4}$/, exclusion.ref)) appendTraceError(errors, `${label}.ref is invalid`);
  if (exclusion.outcome !== 'excluded' && exclusion.outcome !== 'failed') appendTraceError(errors, `${label}.outcome is invalid`);
  validateReasons(exclusion.reasons, `${label}.reasons`, errors);
  if (exclusion.duplicateOfRef !== undefined && (typeof exclusion.duplicateOfRef !== 'string' || !traceRegexTest(/^c\d{4}$/, exclusion.duplicateOfRef))) {
    appendTraceError(errors, `${label}.duplicateOfRef is invalid`);
  }
}

function replayState(value: RetrievalTraceV1): unknown {
  return {
    schemaVersion: value.schemaVersion,
    algorithmVersion: value.algorithmVersion,
    requestShape: value.requestShape,
    complete: value.complete,
    incompleteReasons: value.incompleteReasons,
    candidates: value.candidates,
    events: value.events,
  };
}

/** Deterministic corruption checksum only; conformance never treats it as authentication. */
export function computeRetrievalTraceReplayStateDigest(value: RetrievalTraceV1): string {
  return `sha256:${traceSha256(canonicalTraceJson(replayState(value)))}`;
}

function validateRetrievalTraceUnsafe(value: unknown): string[] {
  const errors: string[] = [];
  const trace = safeRecord(value, 'trace', errors);
  if (!trace) return errors;
  const keys = [
    'schemaVersion', 'algorithmVersion', 'requestShape', 'complete', 'incompleteReasons',
    'candidates', 'events', 'resultOrder', 'terminalExclusions', 'replayStateDigest',
  ];
  exactKeys(trace, keys, 'trace', errors);
  requireKeys(trace, keys, 'trace', errors);
  if (trace.schemaVersion !== RETRIEVAL_TRACE_VERSION) appendTraceError(errors, 'trace.schemaVersion is unsupported');
  const algorithmVersion = enumHas(ALGORITHMS, trace.algorithmVersion)
    ? trace.algorithmVersion
    : 'ranked-v1';
  if (!enumHas(ALGORITHMS, trace.algorithmVersion)) appendTraceError(errors, 'trace.algorithmVersion is unsupported');
  validateRequestShape(trace.requestShape, errors, algorithmVersion);
  if (typeof trace.complete !== 'boolean') appendTraceError(errors, 'trace.complete must be boolean');
  const incomplete = denseArray(trace.incompleteReasons, INCOMPLETE_REASONS.length, 'trace.incompleteReasons', errors);
  if (incomplete) {
    if (someTraceArray(incomplete, (reason) => !enumHas(INCOMPLETE_REASONS, reason))) appendTraceError(errors, 'trace.incompleteReasons has invalid reasons');
    const incompleteSet = new TRACE_SET<unknown>();
    for (let index = 0; index < incomplete.length; index += 1) TRACE_SET_ADD(incompleteSet, incomplete[index]);
    if (traceSetSize(incompleteSet) !== incomplete.length) appendTraceError(errors, 'trace.incompleteReasons has duplicates');
    const sorted = copyTraceArray(incomplete);
    TRACE_ARRAY_SORT(sorted, compareText as (a: unknown, b: unknown) => number);
    if (canonicalTraceJson(incomplete) !== canonicalTraceJson(sorted)) appendTraceError(errors, 'trace.incompleteReasons is not canonical');
    if ((trace.complete === true) !== (incomplete.length === 0)) appendTraceError(errors, 'trace.complete disagrees with incompleteReasons');
  }
  const candidates = denseArray(trace.candidates, HARD_LIMITS.candidates, 'trace.candidates', errors);
  if (candidates) {
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      validateCandidate(candidate, index, errors, algorithmVersion);
      if (isPlainRecord(candidate) && candidate.ref !== `c${tracePadStart(TRACE_STRING(index + 1), 4, '0')}`) appendTraceError(errors, 'trace.candidates refs are not contiguous');
    }
  }
  const events = denseArray(trace.events, HARD_LIMITS.traceEvents, 'trace.events', errors);
  if (events) {
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      validateEvent(event, index, errors, algorithmVersion);
      if (isPlainRecord(event) && event.sequence !== index + 1) appendTraceError(errors, 'trace.events sequence is not contiguous');
    }
    let rerankerCount = 0;
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (isPlainRecord(event) && event.kind === 'reranker-stage') rerankerCount += 1;
    }
    if (algorithmVersion === 'ranked-v2' ? rerankerCount !== 1 : rerankerCount !== 0) {
      appendTraceError(errors, 'trace reranker stage count disagrees with algorithm');
    }
    let mmrRecordsTotal = 0;
    let mmrPairwiseTotal = 0;
    for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
      const rawEvent = events[eventIndex];
      if (!isPlainRecord(rawEvent) || rawEvent.kind !== 'mmr-round' || !TRACE_ARRAY_IS_ARRAY(rawEvent.records)) continue;
      mmrRecordsTotal += rawEvent.records.length;
      for (let recordIndex = 0; recordIndex < rawEvent.records.length; recordIndex += 1) {
        const rawRecord = rawEvent.records[recordIndex];
        if (isPlainRecord(rawRecord) && TRACE_ARRAY_IS_ARRAY(rawRecord.pairwise)) mmrPairwiseTotal += rawRecord.pairwise.length;
      }
    }
    if (mmrRecordsTotal > HARD_LIMITS.mmrRecordsTotal) appendTraceError(errors, 'trace MMR observations exceed hard limit');
    if (mmrPairwiseTotal > HARD_LIMITS.mmrPairwiseTotal) appendTraceError(errors, 'trace MMR pairwise observations exceed hard limit');
  }
  const resultOrder = denseArray(trace.resultOrder, HARD_LIMITS.candidates, 'trace.resultOrder', errors);
  if (resultOrder) {
    if (someTraceArray(resultOrder, (ref) => typeof ref !== 'string' || !traceRegexTest(/^c\d{4}$/, ref))) appendTraceError(errors, 'trace.resultOrder has invalid refs');
    const resultSet = new TRACE_SET<unknown>();
    for (let index = 0; index < resultOrder.length; index += 1) TRACE_SET_ADD(resultSet, resultOrder[index]);
    if (traceSetSize(resultSet) !== resultOrder.length) appendTraceError(errors, 'trace.resultOrder has duplicates');
  }
  const exclusions = denseArray(trace.terminalExclusions, HARD_LIMITS.candidates, 'trace.terminalExclusions', errors);
  if (exclusions) {
    for (let index = 0; index < exclusions.length; index += 1) {
      validateTerminalExclusion(exclusions[index], index, errors);
    }
  }
  if (typeof trace.replayStateDigest !== 'string' || !traceRegexTest(/^sha256:[a-f0-9]{64}$/, trace.replayStateDigest)) {
    appendTraceError(errors, 'trace.replayStateDigest is invalid');
  } else if (errors.length === 0) {
    try {
      const expected = computeRetrievalTraceReplayStateDigest(trace as unknown as RetrievalTraceV1);
      if (trace.replayStateDigest !== expected) appendTraceError(errors, 'trace.replayStateDigest does not match safe replay state');
    } catch {
      appendTraceError(errors, 'trace.replayStateDigest could not be reproduced');
    }
  }
  const uniqueErrors: string[] = [];
  const seenErrors = new TRACE_SET<string>();
  for (let index = 0; index < errors.length; index += 1) {
    const error = errors[index]!;
    if (!TRACE_SET_HAS(seenErrors, error)) {
      TRACE_SET_ADD(seenErrors, error);
      defineTraceArrayItem(uniqueErrors, uniqueErrors.length, error);
    }
  }
  return uniqueErrors;
}

/** Total validation boundary: malformed proxies/values become closed errors, never thrown data. */
export function validateRetrievalTrace(value: unknown): string[] {
  try {
    const preflight = preflightTraceStructure(value);
    if (preflight.length > 0) return preflight;
    return validateRetrievalTraceUnsafe(value);
  } catch {
    return ['trace could not be safely inspected'];
  }
}

function terminalEvents(trace: RetrievalTraceV1): Extract<RetrievalTraceStageEventV1, { kind: 'candidate-terminal' }>[] {
  const result: Extract<RetrievalTraceStageEventV1, { kind: 'candidate-terminal' }>[] = [];
  for (let index = 0; index < trace.events.length; index += 1) {
    const event = trace.events[index]!;
    if (event.kind === 'candidate-terminal') defineTraceArrayItem(result, result.length, event);
  }
  return result;
}

function outputEvents(trace: RetrievalTraceV1): Array<Extract<RetrievalTraceStageEventV1, { kind: 'ranked-output' | 'deterministic-output' }>> {
  const result: Array<Extract<RetrievalTraceStageEventV1, { kind: 'ranked-output' | 'deterministic-output' }>> = [];
  for (let index = 0; index < trace.events.length; index += 1) {
    const event = trace.events[index]!;
    if (event.kind === 'ranked-output' || event.kind === 'deterministic-output') {
      defineTraceArrayItem(result, result.length, event);
    }
  }
  return result;
}

function rerankerEvents(trace: RetrievalTraceV1): RetrievalTraceRerankerEventV2[] {
  const result: RetrievalTraceRerankerEventV2[] = [];
  for (let index = 0; index < trace.events.length; index += 1) {
    const event = trace.events[index]!;
    if (event.kind === 'reranker-stage') defineTraceArrayItem(result, result.length, event);
  }
  return result;
}

function rankedV2PresentationOrder(trace: RetrievalTraceV1): string[] {
  const events = rerankerEvents(trace);
  const reranker = events.length === 0 ? undefined : events[0];
  if (!reranker) return [];
  const rankedCandidates = copyTraceArray(reranker.candidates);
  TRACE_ARRAY_SORT(rankedCandidates, (left, right) => left.rerankedRank - right.rerankedRank);
  const ranked = new TRACE_ARRAY<string>(rankedCandidates.length);
  for (let index = 0; index < rankedCandidates.length; index += 1) {
    defineTraceArrayItem(ranked, index, rankedCandidates[index]!.ref);
  }
  const included = new TRACE_SET<string>();
  const terminals = terminalEvents(trace);
  for (let index = 0; index < terminals.length; index += 1) {
    const event = terminals[index]!;
    if (event.outcome === 'included') TRACE_SET_ADD(included, event.ref);
  }
  const result: string[] = [];
  for (let index = 0; index < ranked.length; index += 1) {
    const ref = ranked[index]!;
    if (!TRACE_SET_HAS(included, ref)) continue;
    defineTraceArrayItem(result, result.length, ref);
  }
  return result;
}

function reconstructFromEvents(trace: RetrievalTraceV1): RetrievalTraceReplayResult {
  const expectedKind = trace.algorithmVersion === 'ranked-v1' || trace.algorithmVersion === 'ranked-v2'
    ? 'ranked-output' : 'deterministic-output';
  const allOutputs = outputEvents(trace);
  const outputs: Array<Extract<RetrievalTraceStageEventV1, { kind: 'ranked-output' | 'deterministic-output' }>> = [];
  for (let index = 0; index < allOutputs.length; index += 1) {
    if (allOutputs[index]!.kind === expectedKind) {
      defineTraceArrayItem(outputs, outputs.length, allOutputs[index]!);
    }
  }
  TRACE_ARRAY_SORT(outputs, (a, b) => a.rank - b.rank);
  const terminals = terminalEvents(trace);
  // V2 output ranks are derived from the calibrated reranker order and
  // terminal inclusion. Output events and top-level arrays are checked echoes,
  // never the authority used to replay the deterministic algorithm.
  const resultOrder = trace.algorithmVersion === 'ranked-v2'
    ? rankedV2PresentationOrder(trace)
    : trace.algorithmVersion === 'deterministic-v2'
    ? trace.candidates
      .filter((candidate) => terminals.some((event) => event.ref === candidate.ref && event.outcome === 'included'))
      .map((candidate) => candidate.ref)
    : outputs.map((event) => event.ref);
  const exclusionEvents: Array<Extract<RetrievalTraceStageEventV1, { kind: 'candidate-terminal' }>
    & { outcome: 'excluded' | 'failed' }> = [];
  for (let index = 0; index < terminals.length; index += 1) {
    const event = terminals[index]!;
    if (event.outcome !== 'included') defineTraceArrayItem(
      exclusionEvents,
      exclusionEvents.length,
      event as typeof event & { outcome: 'excluded' | 'failed' },
    );
  }
  TRACE_ARRAY_SORT(exclusionEvents, (a, b) => compareText(a.ref, b.ref));
  const exclusions: RetrievalTraceTerminalExclusionV1[] = new TRACE_ARRAY(exclusionEvents.length);
  for (let index = 0; index < exclusionEvents.length; index += 1) {
    const event = exclusionEvents[index]!;
    defineTraceArrayItem(exclusions, index, {
      ref: event.ref,
      outcome: event.outcome,
      reasons: copyTraceArray(event.reasons),
      ...(event.duplicateOfRef === undefined ? {} : { duplicateOfRef: event.duplicateOfRef }),
    });
  }
  return { resultOrder, terminalExclusions: exclusions, replayStateDigest: trace.replayStateDigest };
}

function conformanceErrors(trace: RetrievalTraceV1): string[] {
  const errors: string[] = [];
  const eventPriority: Record<RetrievalTraceStageEventV1['kind'], number> = {
    'channel-attempt': 0,
    'channel-terminal': 1,
    'candidate-filter': 2,
    'candidate-score': 3,
    'mmr-round': 4,
    'reranker-stage': 5,
    'ranked-output': 6,
    'deterministic-output': 6,
    'candidate-terminal': 7,
    'stage-failure': 8,
  };
  const eventOrderKey = (event: RetrievalTraceStageEventV1): string => {
    const order = orderForAlgorithm(trace.algorithmVersion);
    switch (event.kind) {
      case 'channel-attempt':
      case 'channel-terminal': return tracePadStart(TRACE_STRING(TRACE_MAP_GET(order, event.channel) ?? 99), 2, '0');
      case 'candidate-filter': return `${event.ref}:${event.name}`;
      case 'candidate-score': return `${event.ref}:${event.name}`;
      case 'mmr-round': return tracePadStart(TRACE_STRING(event.round), 4, '0');
      case 'reranker-stage': return '0000';
      case 'ranked-output':
      case 'deterministic-output': return tracePadStart(TRACE_STRING(event.rank), 4, '0');
      case 'candidate-terminal': return event.ref;
      case 'stage-failure': return `${event.stage}:${event.code}`;
    }
  };
  for (let index = 1; index < trace.events.length; index++) {
    const previous = trace.events[index - 1]!;
    const current = trace.events[index]!;
    const order = eventPriority[previous.kind] - eventPriority[current.kind]
      || compareText(eventOrderKey(previous), eventOrderKey(current));
    if (order > 0) { appendTraceError(errors, 'stage events are not in canonical replay order'); break; }
  }
  const refs = new TRACE_SET<string>();
  for (let index = 0; index < trace.candidates.length; index += 1) TRACE_SET_ADD(refs, trace.candidates[index]!.ref);
  const planned = new TRACE_SET<RetrievalTraceChannel>();
  for (let index = 0; index < trace.requestShape.plannedChannels.length; index += 1) {
    TRACE_SET_ADD(planned, trace.requestShape.plannedChannels[index]!);
  }
  const attempts = filterTraceArray(trace.events, (event) => event.kind === 'channel-attempt') as Array<
    Extract<RetrievalTraceStageEventV1, { kind: 'channel-attempt' }>>;
  const channelTerminals = filterTraceArray(trace.events, (event) => event.kind === 'channel-terminal') as Array<
    Extract<RetrievalTraceStageEventV1, { kind: 'channel-terminal' }>>;
  const plannedValues = traceSetValues(planned);
  for (let plannedIndex = 0; plannedIndex < plannedValues.length; plannedIndex += 1) {
    const channel = plannedValues[plannedIndex]!;
    if (filterTraceArray(attempts, (event) => event.channel === channel).length !== 1
      || filterTraceArray(channelTerminals, (event) => event.channel === channel).length !== 1) {
      appendTraceError(errors, 'channel accounting has gaps or duplicates');
    }
  }
  if (someTraceArray(attempts, (event) => !TRACE_SET_HAS(planned, event.channel))
    || someTraceArray(channelTerminals, (event) => !TRACE_SET_HAS(planned, event.channel))) {
    appendTraceError(errors, 'channel accounting contains unplanned channels');
  }
  const successful = new TRACE_SET<RetrievalTraceChannel>();
  for (let index = 0; index < channelTerminals.length; index += 1) {
    const event = channelTerminals[index]!;
    if (event.outcome === 'success') TRACE_SET_ADD(successful, event.channel);
  }
  for (let candidateIndex = 0; candidateIndex < trace.candidates.length; candidateIndex += 1) {
    const candidate = trace.candidates[candidateIndex]!;
    if (someTraceArray(candidate.channels, (channel) => !TRACE_SET_HAS(planned, channel.channel)
      || !TRACE_SET_HAS(successful, channel.channel))) {
      appendTraceError(errors, 'candidate source channel was not successfully settled');
    }
  }

  const terminals = terminalEvents(trace);
  const outputs = outputEvents(trace);
  const expectedOutputKind = trace.algorithmVersion === 'ranked-v1' || trace.algorithmVersion === 'ranked-v2'
    ? 'ranked-output' : 'deterministic-output';
  if (someTraceArray(outputs, (event) => event.kind !== expectedOutputKind)) appendTraceError(errors, 'output event does not match trace algorithm');
  const refValues = traceSetValues(refs);
  for (let refIndex = 0; refIndex < refValues.length; refIndex += 1) {
    const ref = refValues[refIndex]!;
    const terminal = filterTraceArray(terminals, (event) => event.ref === ref);
    const output = filterTraceArray(outputs, (event) => event.ref === ref);
    if (terminal.length !== 1) appendTraceError(errors, 'candidate does not have exactly one terminal event');
    const settledTerminal = terminal.length === 0 ? undefined : terminal[0];
    if (settledTerminal?.outcome === 'included' ? output.length !== 1 : output.length !== 0) {
      appendTraceError(errors, 'candidate output settlement disagrees with terminal event');
    }
  }
  if (someTraceArray(terminals, (event) => !TRACE_SET_HAS(refs, event.ref))
    || someTraceArray(outputs, (event) => !TRACE_SET_HAS(refs, event.ref))) appendTraceError(errors, 'events reference unknown candidates');
  const ranks = mapTraceArray(outputs, (event) => event.rank);
  TRACE_ARRAY_SORT(ranks, (a, b) => a - b);
  let contiguousRanks = true;
  for (let index = 0; index < ranks.length; index += 1) if (ranks[index] !== index + 1) contiguousRanks = false;
  if (!contiguousRanks) appendTraceError(errors, 'output ranks are not contiguous');

  for (let terminalIndex = 0; terminalIndex < terminals.length; terminalIndex += 1) {
    const terminal = terminals[terminalIndex]!;
    const duplicate = includesTraceArray(terminal.reasons, 'duplicate');
    if (duplicate !== (terminal.duplicateOfRef !== undefined)) appendTraceError(errors, 'duplicate exclusion relation is incomplete');
    if (terminal.duplicateOfRef !== undefined) {
      let target: typeof terminal | undefined;
      for (let index = 0; index < terminals.length; index += 1) {
        if (terminals[index]!.ref === terminal.duplicateOfRef) { target = terminals[index]; break; }
      }
      if (terminal.outcome !== 'excluded' || terminal.duplicateOfRef === terminal.ref || target?.outcome !== 'included') {
        appendTraceError(errors, 'duplicateOfRef must reference a distinct included candidate');
      }
    }
    if (terminal.outcome === 'failed' && !includesTraceArray(terminal.reasons, 'source-failed')) {
      appendTraceError(errors, 'failed terminal is missing source-failed');
    }
  }

  const filterEvents = filterTraceArray(trace.events, (event) => event.kind === 'candidate-filter') as Array<
    Extract<RetrievalTraceStageEventV1, { kind: 'candidate-filter' }>>;
  const scoreEvents = filterTraceArray(trace.events, (event) => event.kind === 'candidate-score') as Array<
    Extract<RetrievalTraceStageEventV1, { kind: 'candidate-score' }>>;
  const eventIdentities = new TRACE_SET<string>();
  for (let index = 0; index < filterEvents.length; index += 1) {
    const event = filterEvents[index]!;
    if (!TRACE_SET_HAS(refs, event.ref)) appendTraceError(errors, 'candidate event references an unknown ref');
    const identity = `filter:${event.ref}:${event.name}`;
    if (TRACE_SET_HAS(eventIdentities, identity)) appendTraceError(errors, 'candidate has duplicate filter or score events');
    TRACE_SET_ADD(eventIdentities, identity);
  }
  for (let index = 0; index < scoreEvents.length; index += 1) {
    const event = scoreEvents[index]!;
    if (!TRACE_SET_HAS(refs, event.ref)) appendTraceError(errors, 'candidate event references an unknown ref');
    const identity = `score:${event.ref}:${event.name}`;
    if (TRACE_SET_HAS(eventIdentities, identity)) appendTraceError(errors, 'candidate has duplicate filter or score events');
    TRACE_SET_ADD(eventIdentities, identity);
  }
  for (let terminalIndex = 0; terminalIndex < terminals.length; terminalIndex += 1) {
    const terminal = terminals[terminalIndex]!;
    const filters = filterTraceArray(filterEvents, (event) => event.ref === terminal.ref);
    const failed = filterTraceArray(filters, (event) => event.outcome === 'fail');
    if (terminal.outcome === 'included' && failed.length > 0) appendTraceError(errors, 'included candidate has failed filters');
    for (let index = 0; index < failed.length; index += 1) {
      const filter = failed[index]!;
      if (!includesTraceArray(terminal.reasons, FILTER_EXCLUSION_REASON[filter.name])) {
        appendTraceError(errors, 'failed filter is missing its exclusion reason');
      }
    }
    const reasonEntries = TRACE_OBJECT_ENTRIES(FILTER_EXCLUSION_REASON) as Array<
      [RetrievalTraceFilterName, RetrievalTraceExclusionReason]>;
    for (let index = 0; index < reasonEntries.length; index += 1) {
      const [name, reason] = reasonEntries[index]!;
      if (includesTraceArray(terminal.reasons, reason)
        && !someTraceArray(filters, (filter) => filter.name === name && filter.outcome === 'fail')) {
        appendTraceError(errors, 'filter-derived exclusion reason has no matching failed filter');
      }
    }
  }

  const mmrRounds = filterTraceArray(trace.events, (event) => event.kind === 'mmr-round') as Array<
    Extract<RetrievalTraceStageEventV1, { kind: 'mmr-round' }>>;
  TRACE_ARRAY_SORT(mmrRounds, (a, b) => a.round - b.round);
  if (trace.requestShape.diversification === 'none' && mmrRounds.length > 0) appendTraceError(errors, 'MMR events exist when diversification is disabled');
  if (trace.requestShape.diversification === 'none'
    && someTraceArray(filterEvents, (event) => event.name === 'mmr' && event.outcome !== 'not-applicable')) {
    appendTraceError(errors, 'MMR filter cannot pass or fail when diversification is disabled');
  }
  if (trace.requestShape.diversification === 'mmr') {
    const mmrFilters = filterTraceArray(filterEvents, (event) => event.name === 'mmr' && event.outcome !== 'not-applicable');
    let eligible = mapTraceArray(mmrFilters, (event) => event.ref);
    TRACE_ARRAY_SORT(eligible, compareText);
    if (eligible.length > HARD_LIMITS.mmrRecordsPerRound) appendTraceError(errors, 'MMR eligible set exceeds practical bound');
    const selected: string[] = [];
    let fixedLambda: number | undefined;
    let pairwiseTotal = 0;
    for (let index = 0; index < mmrRounds.length; index++) {
      const round = mmrRounds[index]!;
      if (round.round !== index + 1) appendTraceError(errors, 'MMR rounds are not contiguous');
      const recordRefs = mapTraceArray(round.records, (record) => record.ref);
      TRACE_ARRAY_SORT(recordRefs, compareText);
      if (canonicalTraceJson(recordRefs) !== canonicalTraceJson(eligible)) appendTraceError(errors, 'MMR eligible set is incomplete');
      if (!includesTraceArray(recordRefs, round.selectedRef)) appendTraceError(errors, 'MMR selected ref is not eligible');
      for (let recordIndex = 0; recordIndex < round.records.length; recordIndex += 1) {
        const record = round.records[recordIndex]!;
        pairwiseTotal += record.pairwise.length;
        const pairRefs = mapTraceArray(record.pairwise, (pair) => pair.selectedRef);
        TRACE_ARRAY_SORT(pairRefs, compareText);
        const selectedRefs = copyTraceArray(selected);
        TRACE_ARRAY_SORT(selectedRefs, compareText);
        if (canonicalTraceJson(pairRefs) !== canonicalTraceJson(selectedRefs)) appendTraceError(errors, 'MMR pairwise coverage is incomplete');
        const pairOrder = copyTraceArray(record.pairwise);
        TRACE_ARRAY_SORT(pairOrder, (a, b) => b.similarity - a.similarity
          || compareText(a.selectedRef, b.selectedRef));
        const maximum = pairOrder.length === 0 ? undefined : pairOrder[0];
        const derivedMaximum = maximum?.similarity ?? 0;
        const derivedAgainst = maximum?.selectedRef ?? null;
        if (record.maxSimilarity !== derivedMaximum || record.againstRef !== derivedAgainst) {
          appendTraceError(errors, 'MMR maxSimilarity and againstRef do not match pairwise replay');
        }
        const expected = roundTraceNumber(record.lambda * record.relevance - (1 - record.lambda) * derivedMaximum);
        if (record.objective !== expected) appendTraceError(errors, 'MMR objective does not match replay formula');
        if (fixedLambda === undefined) fixedLambda = record.lambda;
        else if (record.lambda !== fixedLambda) appendTraceError(errors, 'MMR lambda changed between records');
      }
      const recordOrder = copyTraceArray(round.records);
      TRACE_ARRAY_SORT(recordOrder, (a, b) => b.objective - a.objective || compareText(a.ref, b.ref));
      const winner = (recordOrder.length === 0 ? undefined : recordOrder[0])?.ref;
      if (winner !== round.selectedRef) appendTraceError(errors, 'MMR selected ref is not the objective winner');
      defineTraceArrayItem(selected, selected.length, round.selectedRef);
      eligible = filterTraceArray(eligible, (ref) => ref !== round.selectedRef);
    }
    if (pairwiseTotal > HARD_LIMITS.mmrPairwiseTotal) appendTraceError(errors, 'MMR pairwise observations exceed hard limit');
    const passed = mapTraceArray(filterTraceArray(mmrFilters, (event) => event.outcome === 'pass'), (event) => event.ref);
    TRACE_ARRAY_SORT(passed, compareText);
    const selectedSorted = copyTraceArray(selected);
    TRACE_ARRAY_SORT(selectedSorted, compareText);
    if (canonicalTraceJson(passed) !== canonicalTraceJson(selectedSorted)) appendTraceError(errors, 'MMR pass filters do not match selected candidates');
    const included = new TRACE_SET<string>();
    for (let index = 0; index < terminals.length; index += 1) {
      if (terminals[index]!.outcome === 'included') TRACE_SET_ADD(included, terminals[index]!.ref);
    }
    if (trace.algorithmVersion === 'ranked-v1') {
      const expectedOrder = filterTraceArray(selected, (ref) => TRACE_SET_HAS(included, ref));
      const orderedOutputs = copyTraceArray(outputs);
      TRACE_ARRAY_SORT(orderedOutputs, (a, b) => a.rank - b.rank);
      const actualOrder = mapTraceArray(orderedOutputs, (event) => event.ref);
      if (canonicalTraceJson(expectedOrder) !== canonicalTraceJson(actualOrder)) appendTraceError(errors, 'ranked MMR output is not replayable from rounds');
    }
    if (someTraceArray(traceSetValues(included), (ref) => !includesTraceArray(selected, ref))) {
      appendTraceError(errors, 'included MMR candidate was never selected');
    }
  } else if (trace.algorithmVersion === 'ranked-v1') {
    const finals = new Map(scoreEvents.filter((event) => event.name === 'final').map((event) => [event.ref, event.value]));
    const includedRefs = terminals.filter((event) => event.outcome === 'included').map((event) => event.ref);
    if (includedRefs.some((ref) => !finals.has(ref))) appendTraceError(errors, 'ranked included candidate is missing final score');
    const expected = includedRefs.sort((a, b) => (finals.get(b)! - finals.get(a)!) || compareText(a, b));
    const actual = outputs.sort((a, b) => a.rank - b.rank).map((event) => event.ref);
    if (canonicalTraceJson(expected) !== canonicalTraceJson(actual)) appendTraceError(errors, 'ranked output order does not match final scores');
  }
  const rerankers = rerankerEvents(trace);
  if (trace.algorithmVersion === 'ranked-v2') {
    if (rerankers.length !== 1) appendTraceError(errors, 'ranked-v2 requires exactly one reranker stage');
    const reranker = rerankers.length === 0 ? undefined : rerankers[0];
    if (reranker) {
      const baselineRefs = mapTraceArray(reranker.candidates, (candidate) => candidate.ref);
      const selectedRefs: string[] = [];
      for (let roundIndex = 0; roundIndex < mmrRounds.length; roundIndex += 1) {
        const ref = mmrRounds[roundIndex]!.selectedRef;
        if (someTraceArray(filterEvents, (event) => event.ref === ref
          && event.name === 'dedup' && event.outcome === 'pass')) {
          defineTraceArrayItem(selectedRefs, selectedRefs.length, ref);
        }
      }
      if (canonicalTraceJson(baselineRefs) !== canonicalTraceJson(selectedRefs)) {
        appendTraceError(errors, 'reranker baseline set/order does not match MMR and dedup output');
      }
      const dedupPassed = new TRACE_SET<string>();
      for (let index = 0; index < filterEvents.length; index += 1) {
        const event = filterEvents[index]!;
        if (event.name === 'dedup' && event.outcome === 'pass') TRACE_SET_ADD(dedupPassed, event.ref);
      }
      if (someTraceArray(baselineRefs, (ref) => !TRACE_SET_HAS(dedupPassed, ref))) {
        appendTraceError(errors, 'reranker candidate was not deduplicated into the baseline set');
      }
      const baselineSet = new TRACE_SET<string>();
      for (let index = 0; index < baselineRefs.length; index += 1) TRACE_SET_ADD(baselineSet, baselineRefs[index]!);
      if (someTraceArray(terminals, (event) => event.outcome === 'included'
        && !TRACE_SET_HAS(baselineSet, event.ref))) {
        appendTraceError(errors, 'budget included a candidate outside the reranker set');
      }
      for (let index = 0; index < baselineRefs.length; index += 1) {
        const ref = baselineRefs[index]!;
        const budgets = filterTraceArray(filterEvents, (event) => event.ref === ref && event.name === 'token-budget');
        if (budgets.length !== 1) appendTraceError(errors, 'reranker candidate lacks exact budget settlement');
      }
      const derived = rankedV2PresentationOrder(trace);
      const orderedOutputs = copyTraceArray(outputs);
      TRACE_ARRAY_SORT(orderedOutputs, (a, b) => a.rank - b.rank);
      const echo = mapTraceArray(orderedOutputs, (event) => event.ref);
      if (canonicalTraceJson(derived) !== canonicalTraceJson(echo)) {
        appendTraceError(errors, 'ranked-v2 output echo does not match derived reranker order');
      }
    }
  } else if (rerankers.length !== 0) {
    appendTraceError(errors, 'reranker stage is illegal for this algorithm');
  }
  if (trace.algorithmVersion === 'deterministic-v1') {
    if (trace.requestShape.diversification !== 'none') appendTraceError(errors, 'deterministic algorithm cannot use MMR');
    const included = new Set(terminals.filter((event) => event.outcome === 'included').map((event) => event.ref));
    const expected = trace.candidates.map((candidate) => candidate.ref).filter((ref) => included.has(ref));
    const actual = outputs.sort((a, b) => a.rank - b.rank).map((event) => event.ref);
    if (canonicalTraceJson(expected) !== canonicalTraceJson(actual)) appendTraceError(errors, 'deterministic output order does not match settled candidate order');
  }
  if (trace.algorithmVersion === 'deterministic-v2') {
    if (trace.requestShape.diversification !== 'none') appendTraceError(errors, 'deterministic-v2 algorithm cannot use MMR');
    const actualCandidateOrder = trace.candidates.map((candidate) => candidate.ref);
    const canonicalCandidates = [...trace.candidates]
      .sort((a, b) => compareChannelState(a.channels[0], b.channels[0], 'deterministic-v2'))
      .map((candidate) => candidate.ref);
    if (canonicalTraceJson(actualCandidateOrder) !== canonicalTraceJson(canonicalCandidates)) {
      appendTraceError(errors, 'deterministic-v2 candidates are not in canonical source-final order');
    }
    for (const channel of RETRIEVAL_TRACE_DETERMINISTIC_OUTPUT_CHANNEL_ORDER_V2) {
      const localRanks = trace.candidates
        .filter((candidate) => candidate.channels[0]?.channel === channel)
        .map((candidate) => candidate.channels[0]!.rank)
        .sort((a, b) => a - b);
      if (!localRanks.every((rank, index) => rank === index + 1)) {
        appendTraceError(errors, 'deterministic-v2 source-final ranks are not contiguous');
      }
    }
    const included = new Set(terminals.filter((event) => event.outcome === 'included').map((event) => event.ref));
    const derived = trace.candidates.map((candidate) => candidate.ref).filter((ref) => included.has(ref));
    const actual = outputs.sort((a, b) => a.rank - b.rank).map((event) => event.ref);
    if (canonicalTraceJson(derived) !== canonicalTraceJson(actual)) {
      appendTraceError(errors, 'deterministic-v2 output events do not match derived deterministic output');
    }
  }

  const reconstructed = reconstructFromEvents(trace);
  if (canonicalTraceJson(trace.resultOrder) !== canonicalTraceJson(reconstructed.resultOrder)) appendTraceError(errors, 'trace.resultOrder does not match replayed events');
  if (canonicalTraceJson(trace.terminalExclusions) !== canonicalTraceJson(reconstructed.terminalExclusions)) {
    appendTraceError(errors, 'trace.terminalExclusions does not match replayed events');
  }
  const uniqueErrors: string[] = [];
  const seenErrors = new TRACE_SET<string>();
  for (let index = 0; index < errors.length; index += 1) {
    const error = errors[index]!;
    if (!TRACE_SET_HAS(seenErrors, error)) {
      TRACE_SET_ADD(seenErrors, error);
      defineTraceArrayItem(uniqueErrors, uniqueErrors.length, error);
    }
  }
  return uniqueErrors;
}

function assertValidTrace(value: unknown): asserts value is RetrievalTraceV1 {
  const errors = validateRetrievalTrace(value);
  if (errors.length > 0) throw new RetrievalTraceValidationError(joinTraceErrors(errors));
}

function containsRecognizedSecret(value: unknown): boolean {
  if (typeof value === 'string') return redactSecrets(value) !== value;
  if (TRACE_ARRAY_IS_ARRAY(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (containsRecognizedSecret(value[index])) return true;
    }
    return false;
  }
  if (!isPlainRecord(value)) return false;
  const keys = TRACE_REFLECT_OWN_KEYS(value);
  for (let index = 0; index < keys.length; index += 1) {
    const descriptor = TRACE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, keys[index]!);
    if (descriptor && 'value' in descriptor && containsRecognizedSecret(descriptor.value)) return true;
  }
  return false;
}

export function assertRetrievalTraceSecretSafe(value: unknown): asserts value is RetrievalTraceV1 {
  assertSecretRedactionIntrinsic();
  assertValidTrace(value);
  if (containsRecognizedSecret(value)) throw new RetrievalTraceValidationError('trace contains a recognized secret shape');
}

export function assertRetrievalTraceConformant(value: unknown): asserts value is RetrievalTraceV1 {
  assertRetrievalTraceSecretSafe(value);
  if (!value.complete) throw new RetrievalTraceValidationError('trace is incomplete');
  const errors = conformanceErrors(value);
  if (errors.length > 0) throw new RetrievalTraceValidationError(joinTraceErrors(errors));
}

export function replayRetrievalTrace(value: unknown): RetrievalTraceReplayResult {
  assertRetrievalTraceConformant(value);
  return reconstructFromEvents(value);
}

function normalizeRequestShape(
  input: RetrievalTraceRequestShapeV1,
  algorithmVersion: RetrievalTraceAlgorithmVersion,
): RetrievalTraceRequestShapeV1 {
  const rawErrors: string[] = [];
  validateRequestShape(input, rawErrors, algorithmVersion);
  if (rawErrors.length > 0) throw new RetrievalTraceValidationError(joinTraceErrors(rawErrors));
  const normalized: RetrievalTraceRequestShapeV1 = {
    sources: { code: input.sources.code, architecture: input.sources.architecture, memory: input.sources.memory },
    projectScopeApplied: input.projectScopeApplied,
    tenantScope: input.tenantScope,
    entityScope: input.entityScope,
    tagScope: input.tagScope,
    temporalFilterApplied: input.temporalFilterApplied,
    queryLength: input.queryLength,
    queryForm: input.queryForm,
    tokenBudget: input.tokenBudget,
    diversification: input.diversification,
    plannedChannels: algorithmVersion === 'ranked-v2'
      ? copyTraceArray(input.plannedChannels)
      : [...input.plannedChannels].sort((a, b) => {
          const order = orderForAlgorithm(algorithmVersion);
          return (TRACE_MAP_GET(order, a) ?? 99) - (TRACE_MAP_GET(order, b) ?? 99);
        }),
  };
  if (algorithmVersion === 'ranked-v2') {
    TRACE_ARRAY_SORT(normalized.plannedChannels as RetrievalTraceChannel[], (a, b) => {
      const order = orderForAlgorithm(algorithmVersion);
      return (TRACE_MAP_GET(order, a) ?? 99) - (TRACE_MAP_GET(order, b) ?? 99);
    });
  }
  const errors: string[] = [];
  validateRequestShape(normalized, errors, algorithmVersion);
  if (errors.length > 0) throw new RetrievalTraceValidationError(joinTraceErrors(errors));
  return normalized;
}

function compareChannelState(
  a: unknown,
  b: unknown,
  algorithmVersion: RetrievalTraceAlgorithmVersion = 'ranked-v1',
): number {
  const left = isPlainRecord(a) ? a : {};
  const right = isPlainRecord(b) ? b : {};
  const order = orderForAlgorithm(algorithmVersion);
  return (TRACE_MAP_GET(order, left.channel as RetrievalTraceChannel) ?? 99)
    - (TRACE_MAP_GET(order, right.channel as RetrievalTraceChannel) ?? 99)
    || TRACE_NUMBER(left.rank ?? 0) - TRACE_NUMBER(right.rank ?? 0)
    || TRACE_NUMBER(left.score ?? 0) - TRACE_NUMBER(right.score ?? 0);
}

function normalizeCandidate(
  input: RetrievalTraceCandidateDraft,
  algorithmVersion: RetrievalTraceAlgorithmVersion,
): RetrievalTraceCandidateDraft {
  const rawErrors: string[] = [];
  const draft = safeRecord(input, 'candidate draft', rawErrors);
  if (draft) {
    exactKeys(draft, ['sourceType', 'channels', 'evidence', 'estimatedTokens'], 'candidate draft', rawErrors);
    requireKeys(draft, ['sourceType', 'channels', 'evidence', 'estimatedTokens'], 'candidate draft', rawErrors);
  }
  if (rawErrors.length > 0) throw new RetrievalTraceValidationError(joinTraceErrors(rawErrors));
  validateCandidate({
    ref: 'c0001', sourceType: input.sourceType, channels: input.channels,
    evidence: input.evidence, estimatedTokens: input.estimatedTokens,
  }, 0, rawErrors, algorithmVersion);
  if (rawErrors.length > 0) throw new RetrievalTraceValidationError(joinTraceErrors(rawErrors));
  const rankedV2 = algorithmVersion === 'ranked-v2';
  const channels: RetrievalTraceChannelStateV1[] = rankedV2
    ? new TRACE_ARRAY<RetrievalTraceChannelStateV1>(input.channels.length)
    : input.channels.map((channel) => ({
        channel: channel.channel,
        rank: channel.rank,
        ...(channel.score === undefined ? {} : { score: roundTraceNumber(channel.score) }),
      })).sort((a, b) => compareChannelState(a, b, algorithmVersion));
  if (rankedV2) {
    for (let index = 0; index < input.channels.length; index += 1) {
      const channel = input.channels[index]!;
      defineTraceArrayItem(channels, index, {
        channel: channel.channel,
        rank: channel.rank,
        ...(channel.score === undefined ? {} : { score: roundTraceNumber(channel.score) }),
      });
    }
    TRACE_ARRAY_SORT(channels, (a, b) => compareChannelState(a, b, algorithmVersion));
  }
  const normalized: RetrievalTraceCandidateDraft = {
    sourceType: input.sourceType,
    channels,
    evidence: {
      ...(input.evidence.confidence === undefined ? {} : { confidence: roundTraceNumber(input.evidence.confidence) }),
      ...(input.evidence.sourceCount === undefined ? {} : { sourceCount: input.evidence.sourceCount }),
      ...(input.evidence.superseded === undefined ? {} : { superseded: input.evidence.superseded }),
      ...(input.evidence.invalidated === undefined ? {} : { invalidated: input.evidence.invalidated }),
    },
    estimatedTokens: input.estimatedTokens,
  };
  const errors: string[] = [];
  validateCandidate({ ref: 'c0001', ...normalized }, 0, errors, algorithmVersion);
  if (errors.length > 0) throw new RetrievalTraceValidationError(joinTraceErrors(errors));
  return normalized;
}

interface CandidateEntry {
  handle: RetrievalTraceCandidateHandle;
  draft: RetrievalTraceCandidateDraft;
  fingerprint: string;
  filters: Map<RetrievalTraceFilterName, RetrievalTraceFilterEventInput>;
  scores: Map<RetrievalTraceScoreName, RetrievalTraceScoreEventInput>;
  outputRank?: number;
  terminal?: RetrievalTraceTerminalInput;
}

interface MmrRoundEntry {
  round: number;
  selected: CandidateEntry;
  records: Array<{
    candidate: CandidateEntry; relevance: number; lambda: number;
    pairwise: Array<{ selected: CandidateEntry; similarity: number }>;
  }>;
}

type RerankerDraft =
  | { readonly outcome: 'baseline'; readonly baseline: readonly CandidateEntry[] }
  | {
      readonly outcome: 'reranked';
      readonly baseline: readonly CandidateEntry[];
      readonly reranked: readonly { readonly candidate: CandidateEntry; readonly calibratedScore: number }[];
    };

type UnsequencedTraceEvent = RetrievalTraceStageEventV1 extends infer Event
  ? Event extends { sequence: number } ? Omit<Event, 'sequence'> : never
  : never;

function compareCandidateEntries(
  a: CandidateEntry,
  b: CandidateEntry,
  algorithmVersion: RetrievalTraceAlgorithmVersion,
): number {
  const firstA = a.draft.channels[0]!;
  const firstB = b.draft.channels[0]!;
  return compareChannelState(firstA, firstB, algorithmVersion)
    || (TRACE_MAP_GET(sourceOrder, a.draft.sourceType) ?? 99)
      - (TRACE_MAP_GET(sourceOrder, b.draft.sourceType) ?? 99)
    || compareText(canonicalTraceJson(a.draft.channels), canonicalTraceJson(b.draft.channels))
    || compareText(a.fingerprint, b.fingerprint);
}

function boundedOption(value: number | undefined, fallback: number, hard: number, name: string): number {
  const resolved = value ?? fallback;
  if (!validInteger(resolved, 1, hard)) throw new RetrievalTraceLimitError(`${name} is outside allowed bounds`);
  return resolved;
}

export class RetrievalTraceCollector {
  private readonly requestShape: RetrievalTraceRequestShapeV1;
  private readonly entries: CandidateEntry[] = [];
  private readonly handles = new TRACE_WEAK_MAP<object, CandidateEntry>();
  private readonly attempts = new TRACE_SET<RetrievalTraceChannel>();
  private readonly settlements = new TRACE_MAP<RetrievalTraceChannel, RetrievalTraceChannelSettlement>();
  private readonly mmrRounds: MmrRoundEntry[] = [];
  private readonly stageFailures: Array<{ stage: RetrievalTraceFailureStage; code: RetrievalTraceFailureCode }> = [];
  private readonly incomplete = new TRACE_SET<RetrievalTraceIncompleteReason>();
  private readonly limits: Required<RetrievalTraceCollectorOptions>;
  private finalized = false;
  private mmrPairwiseTotal = 0;
  private mmrRecordsTotal = 0;
  private rerankerDraft: RerankerDraft | undefined;

  constructor(
    private readonly algorithmVersion: RetrievalTraceAlgorithmVersion,
    requestShape: RetrievalTraceRequestShapeV1,
    options: RetrievalTraceCollectorOptions = {},
  ) {
    if (!enumHas(ALGORITHMS, algorithmVersion)) throw new RetrievalTraceValidationError('algorithmVersion is unsupported');
    this.requestShape = normalizeRequestShape(requestShape, algorithmVersion);
    this.limits = {
      maxCandidates: boundedOption(options.maxCandidates, DEFAULT_LIMITS.maxCandidates, HARD_LIMITS.candidates, 'maxCandidates'),
      maxEvents: boundedOption(options.maxEvents, DEFAULT_LIMITS.maxEvents, HARD_LIMITS.genericArrayEntries, 'maxEvents'),
      maxChannelsPerCandidate: boundedOption(options.maxChannelsPerCandidate, DEFAULT_LIMITS.maxChannelsPerCandidate, HARD_LIMITS.channelsPerCandidate, 'maxChannelsPerCandidate'),
      maxFiltersPerCandidate: boundedOption(options.maxFiltersPerCandidate, DEFAULT_LIMITS.maxFiltersPerCandidate, HARD_LIMITS.filtersPerCandidate, 'maxFiltersPerCandidate'),
      maxScoresPerCandidate: boundedOption(options.maxScoresPerCandidate, DEFAULT_LIMITS.maxScoresPerCandidate, HARD_LIMITS.scoresPerCandidate, 'maxScoresPerCandidate'),
      maxExclusionReasonsPerCandidate: boundedOption(options.maxExclusionReasonsPerCandidate, DEFAULT_LIMITS.maxExclusionReasonsPerCandidate, HARD_LIMITS.exclusionReasonsPerCandidate, 'maxExclusionReasonsPerCandidate'),
      maxMmrRounds: boundedOption(options.maxMmrRounds, DEFAULT_LIMITS.maxMmrRounds, HARD_LIMITS.mmrRounds, 'maxMmrRounds'),
      maxMmrRecordsPerRound: boundedOption(options.maxMmrRecordsPerRound, DEFAULT_LIMITS.maxMmrRecordsPerRound, HARD_LIMITS.mmrRecordsPerRound, 'maxMmrRecordsPerRound'),
      maxMmrRecordsTotal: boundedOption(options.maxMmrRecordsTotal, DEFAULT_LIMITS.maxMmrRecordsTotal, HARD_LIMITS.mmrRecordsTotal, 'maxMmrRecordsTotal'),
      maxMmrPairwisePerRecord: boundedOption(options.maxMmrPairwisePerRecord, DEFAULT_LIMITS.maxMmrPairwisePerRecord, HARD_LIMITS.mmrPairwisePerRecord, 'maxMmrPairwisePerRecord'),
      maxMmrPairwiseTotal: boundedOption(options.maxMmrPairwiseTotal, DEFAULT_LIMITS.maxMmrPairwiseTotal, HARD_LIMITS.mmrPairwiseTotal, 'maxMmrPairwiseTotal'),
      maxStageFailures: boundedOption(options.maxStageFailures, DEFAULT_LIMITS.maxStageFailures, HARD_LIMITS.stageFailures, 'maxStageFailures'),
    };
  }

  addCandidate(input: RetrievalTraceCandidateDraft): RetrievalTraceCandidateHandle {
    this.assertOpen();
    if (this.entries.length >= this.limits.maxCandidates) this.limitExceeded('candidate limit exceeded');
    const draft = normalizeCandidate(input, this.algorithmVersion);
    if (draft.channels.length > this.limits.maxChannelsPerCandidate) this.limitExceeded('candidate channel limit exceeded');
    const fingerprint = traceSha256(canonicalTraceJson(draft));
    const duplicate = this.algorithmVersion === 'ranked-v2'
      ? someTraceArray(this.entries, (entry) => entry.fingerprint === fingerprint)
      : this.entries.some((entry) => entry.fingerprint === fingerprint);
    if (duplicate) {
      if (this.algorithmVersion === 'ranked-v2') TRACE_SET_ADD(this.incomplete, 'candidate-identity-collision');
      else this.incomplete.add('candidate-identity-collision');
      throw new RetrievalTraceValidationError('candidate identity is ambiguous');
    }
    const handle = (this.algorithmVersion === 'ranked-v2' ? TRACE_OBJECT_FREEZE({}) : Object.freeze({})) as RetrievalTraceCandidateHandle;
    const entry: CandidateEntry = {
      handle,
      draft,
      fingerprint,
      filters: this.algorithmVersion === 'ranked-v2' ? new TRACE_MAP() : new Map(),
      scores: this.algorithmVersion === 'ranked-v2' ? new TRACE_MAP() : new Map(),
    };
    if (this.algorithmVersion === 'ranked-v2') {
      defineTraceArrayItem(this.entries, this.entries.length, entry);
      TRACE_WEAK_MAP_SET(this.handles, handle, entry);
    } else {
      this.entries.push(entry);
      this.handles.set(handle, entry);
    }
    return handle;
  }

  attemptChannel(channel: RetrievalTraceChannel): void {
    this.assertOpen();
    this.assertPlannedChannel(channel);
    this.reserveEvent();
    const rankedV2 = this.algorithmVersion === 'ranked-v2';
    if (rankedV2 ? TRACE_SET_HAS(this.attempts, channel) : this.attempts.has(channel)) {
      if (rankedV2) TRACE_SET_ADD(this.incomplete, 'channel-accounting-conflict');
      else this.incomplete.add('channel-accounting-conflict');
      throw new RetrievalTraceValidationError('channel was attempted more than once');
    }
    if (rankedV2) TRACE_SET_ADD(this.attempts, channel);
    else this.attempts.add(channel);
  }

  settleChannel(channel: RetrievalTraceChannel, settlement: RetrievalTraceChannelSettlement): void {
    this.assertOpen();
    this.assertPlannedChannel(channel);
    this.reserveEvent();
    const rankedV2 = this.algorithmVersion === 'ranked-v2';
    if (rankedV2
      ? !TRACE_SET_HAS(this.attempts, channel) || TRACE_MAP_HAS(this.settlements, channel)
      : !this.attempts.has(channel) || this.settlements.has(channel)) {
      if (rankedV2) TRACE_SET_ADD(this.incomplete, 'channel-accounting-conflict');
      else this.incomplete.add('channel-accounting-conflict');
      throw new RetrievalTraceValidationError('channel settlement conflicts with its attempt');
    }
    const settlementErrors: string[] = [];
    const settlementRecord = safeRecord(settlement, 'channel settlement', settlementErrors);
    if (settlementRecord) {
      const fields = settlementRecord.outcome === 'success' ? ['outcome'] : ['outcome', 'code'];
      exactKeys(settlementRecord, fields, 'channel settlement', settlementErrors);
      requireKeys(settlementRecord, fields, 'channel settlement', settlementErrors);
    }
    if (settlementErrors.length > 0) throw new RetrievalTraceValidationError(joinTraceErrors(settlementErrors));
    if (settlement.outcome !== 'success' && settlement.outcome !== 'safe-failure') {
      throw new RetrievalTraceValidationError('channel settlement outcome is invalid');
    }
    if (settlement.outcome === 'safe-failure' && !enumHas(FAILURE_CODES, settlement.code)) {
      throw new RetrievalTraceValidationError('channel failure code is invalid');
    }
    if (rankedV2) TRACE_MAP_SET(this.settlements, channel, TRACE_OBJECT_FREEZE({ ...settlement }));
    else this.settlements.set(channel, Object.freeze({ ...settlement }));
  }

  recordFilter(handle: RetrievalTraceCandidateHandle, input: RetrievalTraceFilterEventInput): void {
    this.assertOpen();
    const entry = this.resolve(handle);
    this.reserveEvent();
    const inputErrors: string[] = [];
    if (!isPlainRecord(input)) appendTraceError(inputErrors, 'filter event must be an object');
    else {
      exactKeys(input, ['name', 'outcome'], 'filter event', inputErrors);
      requireKeys(input, ['name', 'outcome'], 'filter event', inputErrors);
    }
    if (inputErrors.length > 0 || !enumHas(FILTERS, input.name) || !enumHas(FILTER_OUTCOMES, input.outcome)) {
      throw new RetrievalTraceValidationError(joinTraceErrors(inputErrors) || 'filter event is invalid');
    }
    if ((this.algorithmVersion === 'ranked-v2' ? traceMapSize(entry.filters) : entry.filters.size)
      >= this.limits.maxFiltersPerCandidate) this.limitExceeded('candidate filter limit exceeded');
    const rankedV2 = this.algorithmVersion === 'ranked-v2';
    if (rankedV2 ? TRACE_MAP_HAS(entry.filters, input.name) : entry.filters.has(input.name)) {
      if (rankedV2) TRACE_SET_ADD(this.incomplete, 'candidate-event-conflict');
      else this.incomplete.add('candidate-event-conflict');
      throw new RetrievalTraceValidationError('candidate filter was recorded more than once');
    }
    const filterRecord = { ...input };
    if (rankedV2) TRACE_MAP_SET(entry.filters, input.name, TRACE_OBJECT_FREEZE(filterRecord));
    else entry.filters.set(input.name, Object.freeze(filterRecord));
  }

  recordScore(handle: RetrievalTraceCandidateHandle, input: RetrievalTraceScoreEventInput): void {
    this.assertOpen();
    const entry = this.resolve(handle);
    this.reserveEvent();
    const inputErrors: string[] = [];
    if (!isPlainRecord(input)) appendTraceError(inputErrors, 'score event must be an object');
    else {
      exactKeys(input, ['name', 'value'], 'score event', inputErrors);
      requireKeys(input, ['name', 'value'], 'score event', inputErrors);
    }
    if (inputErrors.length > 0 || !enumHas(SCORE_NAMES, input.name)) {
      throw new RetrievalTraceValidationError(joinTraceErrors(inputErrors) || 'score event is invalid');
    }
    if ((this.algorithmVersion === 'ranked-v2' ? traceMapSize(entry.scores) : entry.scores.size)
      >= this.limits.maxScoresPerCandidate) this.limitExceeded('candidate score limit exceeded');
    const rankedV2 = this.algorithmVersion === 'ranked-v2';
    if (rankedV2 ? TRACE_MAP_HAS(entry.scores, input.name) : entry.scores.has(input.name)) {
      if (rankedV2) TRACE_SET_ADD(this.incomplete, 'candidate-event-conflict');
      else this.incomplete.add('candidate-event-conflict');
      throw new RetrievalTraceValidationError('candidate score was recorded more than once');
    }
    const value = roundTraceNumber(input.value);
    const [min, max] = scoreBounds(input.name);
    if (value < min || value > max) throw new RetrievalTraceValidationError('score is outside semantic bounds');
    if (rankedV2) TRACE_MAP_SET(entry.scores, input.name, TRACE_OBJECT_FREEZE({ name: input.name, value }));
    else entry.scores.set(input.name, Object.freeze({ name: input.name, value }));
  }

  recordOutput(handle: RetrievalTraceCandidateHandle, rank: number): void {
    this.assertOpen();
    const entry = this.resolve(handle);
    if (this.algorithmVersion === 'deterministic-v2') {
      throw new RetrievalTraceValidationError('deterministic-v2 output rank is derived by the collector');
    }
    this.reserveEvent();
    if (!validInteger(rank, 1, this.limits.maxCandidates) || entry.outputRank !== undefined) {
      if (this.algorithmVersion === 'ranked-v2') TRACE_SET_ADD(this.incomplete, 'candidate-output-gap');
      else this.incomplete.add('candidate-output-gap');
      throw new RetrievalTraceValidationError('candidate output rank is invalid or duplicated');
    }
    entry.outputRank = rank;
  }

  recordTerminal(handle: RetrievalTraceCandidateHandle, terminal: RetrievalTraceTerminalInput): void {
    this.assertOpen();
    const entry = this.resolve(handle);
    this.reserveEvent();
    if (entry.terminal !== undefined) {
      if (this.algorithmVersion === 'ranked-v2') TRACE_SET_ADD(this.incomplete, 'candidate-terminal-conflict');
      else this.incomplete.add('candidate-terminal-conflict');
      throw new RetrievalTraceValidationError('candidate terminal was recorded more than once');
    }
    const inputErrors: string[] = [];
    if (!isPlainRecord(terminal)) appendTraceError(inputErrors, 'terminal event must be an object');
    else {
      exactKeys(terminal, ['outcome', 'reasons', 'duplicateOf'], 'terminal event', inputErrors);
      requireKeys(terminal, ['outcome', 'reasons'], 'terminal event', inputErrors);
    }
    if (inputErrors.length > 0) throw new RetrievalTraceValidationError(joinTraceErrors(inputErrors));
    if (!enumHas(TERMINAL_OUTCOMES, terminal.outcome)) throw new RetrievalTraceValidationError('terminal outcome is invalid');
    if (terminal.reasons.length > this.limits.maxExclusionReasonsPerCandidate) this.limitExceeded('terminal reason limit exceeded');
    const rankedV2 = this.algorithmVersion === 'ranked-v2';
    const reasons = rankedV2 ? copyTraceArray(terminal.reasons) : [...terminal.reasons];
    const reasonSet = rankedV2 ? new TRACE_SET<RetrievalTraceExclusionReason>() : new Set(reasons);
    if (rankedV2) {
      for (let index = 0; index < reasons.length; index += 1) TRACE_SET_ADD(reasonSet, reasons[index]!);
    }
    const invalidReason = rankedV2
      ? someTraceArray(reasons, (reason) => !enumHas(EXCLUSION_REASONS, reason))
      : reasons.some((reason) => !enumHas(EXCLUSION_REASONS, reason));
    if (invalidReason || (rankedV2 ? traceSetSize(reasonSet) : reasonSet.size) !== reasons.length) {
      throw new RetrievalTraceValidationError('terminal reasons are invalid');
    }
    if (rankedV2) TRACE_ARRAY_SORT(reasons, compareText);
    else reasons.sort(compareText);
    if (terminal.outcome === 'included' ? reasons.length !== 0 : reasons.length === 0) throw new RetrievalTraceValidationError('terminal reasons disagree with outcome');
    const duplicateOf = 'duplicateOf' in terminal && terminal.duplicateOf !== undefined ? this.resolve(terminal.duplicateOf) : undefined;
    const duplicateReason = rankedV2 ? includesTraceArray(reasons, 'duplicate') : reasons.includes('duplicate');
    const sourceFailedReason = rankedV2 ? includesTraceArray(reasons, 'source-failed') : reasons.includes('source-failed');
    if (duplicateReason !== (duplicateOf !== undefined)) throw new RetrievalTraceValidationError('duplicate terminal requires a duplicate relation');
    if (terminal.outcome === 'failed' && !sourceFailedReason) throw new RetrievalTraceValidationError('failed terminal requires source-failed');
    const terminalRecord = { outcome: terminal.outcome, reasons, ...(duplicateOf ? { duplicateOf: duplicateOf.handle } : {}) };
    entry.terminal = (rankedV2 ? TRACE_OBJECT_FREEZE(terminalRecord) : Object.freeze(terminalRecord)) as RetrievalTraceTerminalInput;
  }

  recordMmrRound(round: number, selected: RetrievalTraceCandidateHandle, inputs: readonly RetrievalTraceMmrRecordInput[]): void {
    this.assertOpen();
    if (this.algorithmVersion === 'deterministic-v2') {
      throw new RetrievalTraceValidationError('deterministic-v2 does not support MMR');
    }
    this.reserveEvent();
    const arrayErrors: string[] = [];
    const denseInputs = denseArray(inputs, this.limits.maxMmrRecordsPerRound, 'MMR records', arrayErrors);
    if (arrayErrors.length > 0 || !denseInputs) throw new RetrievalTraceValidationError(joinTraceErrors(arrayErrors));
    if (this.mmrRounds.length >= this.limits.maxMmrRounds || inputs.length > this.limits.maxMmrRecordsPerRound) {
      this.limitExceeded('MMR limit exceeded');
    }
    if (this.mmrRecordsTotal + inputs.length > this.limits.maxMmrRecordsTotal) this.limitExceeded('MMR record total limit exceeded');
    const rankedV2 = this.algorithmVersion === 'ranked-v2';
    const repeatedRound = rankedV2
      ? someTraceArray(this.mmrRounds, (entry) => entry.round === round)
      : this.mmrRounds.some((entry) => entry.round === round);
    if (!validInteger(round, 1, this.limits.maxMmrRounds) || repeatedRound) {
      if (rankedV2) TRACE_SET_ADD(this.incomplete, 'mmr-gap');
      else this.incomplete.add('mmr-gap');
      throw new RetrievalTraceValidationError('MMR round is invalid or duplicated');
    }
    const selectedEntry = this.resolve(selected);
    let addedPairwise = 0;
    const buildRecord = (input: RetrievalTraceMmrRecordInput): MmrRoundEntry['records'][number] => {
      const recordErrors: string[] = [];
      const record = safeRecord(input, 'MMR record', recordErrors);
      if (record) {
        exactKeys(record, ['candidate', 'relevance', 'lambda', 'pairwise'], 'MMR record', recordErrors);
        requireKeys(record, ['candidate', 'relevance', 'lambda', 'pairwise'], 'MMR record', recordErrors);
      }
      if (recordErrors.length > 0) throw new RetrievalTraceValidationError(joinTraceErrors(recordErrors));
      const pairErrors: string[] = [];
      const pairs = denseArray(input.pairwise, this.limits.maxMmrPairwisePerRecord, 'MMR pairwise', pairErrors);
      if (!pairs || pairErrors.length > 0) throw new RetrievalTraceValidationError(joinTraceErrors(pairErrors));
      if (this.mmrPairwiseTotal + addedPairwise + pairs.length > this.limits.maxMmrPairwiseTotal) this.limitExceeded('MMR pairwise total limit exceeded');
      addedPairwise += pairs.length;
      const pairwise: MmrRoundEntry['records'][number]['pairwise'] = rankedV2
        ? new TRACE_ARRAY(input.pairwise.length)
        : input.pairwise.map((pair) => {
            const pairRecordErrors: string[] = [];
            const pairRecord = safeRecord(pair, 'MMR pairwise record', pairRecordErrors);
            if (pairRecord) {
              exactKeys(pairRecord, ['selected', 'similarity'], 'MMR pairwise record', pairRecordErrors);
              requireKeys(pairRecord, ['selected', 'similarity'], 'MMR pairwise record', pairRecordErrors);
            }
            if (pairRecordErrors.length > 0) throw new RetrievalTraceValidationError(joinTraceErrors(pairRecordErrors));
            return { selected: this.resolve(pair.selected), similarity: this.mmrNumber(pair.similarity, -1, 1) };
          });
      if (rankedV2) {
        for (let index = 0; index < input.pairwise.length; index += 1) {
          const pair = input.pairwise[index]!;
          const pairRecordErrors: string[] = [];
          const pairRecord = safeRecord(pair, 'MMR pairwise record', pairRecordErrors);
          if (pairRecord) {
            exactKeys(pairRecord, ['selected', 'similarity'], 'MMR pairwise record', pairRecordErrors);
            requireKeys(pairRecord, ['selected', 'similarity'], 'MMR pairwise record', pairRecordErrors);
          }
          if (pairRecordErrors.length > 0) throw new RetrievalTraceValidationError(joinTraceErrors(pairRecordErrors));
          defineTraceArrayItem(pairwise, index, {
            selected: this.resolve(pair.selected), similarity: this.mmrNumber(pair.similarity, -1, 1),
          });
        }
      }
      return {
        candidate: this.resolve(input.candidate),
        relevance: this.mmrNumber(input.relevance, 0, 1),
        lambda: this.mmrNumber(input.lambda, 0, 1),
        pairwise,
      };
    };
    const records: MmrRoundEntry['records'] = rankedV2
      ? new TRACE_ARRAY(inputs.length)
      : inputs.map(buildRecord);
    if (rankedV2) {
      for (let index = 0; index < inputs.length; index += 1) defineTraceArrayItem(records, index, buildRecord(inputs[index]!));
    }
    const recordCandidates = rankedV2 ? new TRACE_SET<CandidateEntry>()
      : new Set(records.map((record) => record.candidate));
    if (rankedV2) {
      for (let index = 0; index < records.length; index += 1) TRACE_SET_ADD(recordCandidates, records[index]!.candidate);
    }
    if ((rankedV2 ? traceSetSize(recordCandidates) : recordCandidates.size) !== records.length) {
      throw new RetrievalTraceValidationError('MMR round has duplicate candidates');
    }
    for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
      const record = records[recordIndex]!;
      const selectedCandidates = rankedV2 ? new TRACE_SET<CandidateEntry>()
        : new Set(record.pairwise.map((pair) => pair.selected));
      if (rankedV2) {
        for (let index = 0; index < record.pairwise.length; index += 1) {
          TRACE_SET_ADD(selectedCandidates, record.pairwise[index]!.selected);
        }
      }
      if ((rankedV2 ? traceSetSize(selectedCandidates) : selectedCandidates.size) !== record.pairwise.length) {
        throw new RetrievalTraceValidationError('MMR pairwise record has duplicate selected candidates');
      }
    }
    this.mmrPairwiseTotal += addedPairwise;
    this.mmrRecordsTotal += records.length;
    const roundRecord = { round, selected: selectedEntry, records };
    if (rankedV2) defineTraceArrayItem(this.mmrRounds, this.mmrRounds.length, roundRecord);
    else this.mmrRounds.push(roundRecord);
  }

  recordRerankerStage(
    baselineHandles: readonly RetrievalTraceCandidateHandle[],
    outcome: RetrievalTraceRerankerOutcomeInput,
  ): void {
    this.assertOpen();
    if (this.algorithmVersion !== 'ranked-v2') {
      throw new RetrievalTraceValidationError('reranker stage requires ranked-v2');
    }
    if (this.rerankerDraft !== undefined) {
      throw new RetrievalTraceValidationError('reranker stage was already recorded');
    }
    for (let index = 0; index < this.entries.length; index += 1) {
      const entry = this.entries[index]!;
      if (entry.outputRank !== undefined || entry.terminal !== undefined
        || TRACE_MAP_GET(entry.filters, 'token-budget') !== undefined) {
        throw new RetrievalTraceValidationError('reranker stage must precede budget and output');
      }
    }
    const baselineErrors: string[] = [];
    const denseBaseline = denseArray(baselineHandles, 128, 'reranker baseline handles', baselineErrors);
    if (!denseBaseline || baselineErrors.length > 0) {
      throw new RetrievalTraceValidationError(joinTraceErrors(baselineErrors));
    }
    const baseline = new TRACE_ARRAY<CandidateEntry>(denseBaseline.length);
    const baselineSet = new TRACE_SET<CandidateEntry>();
    for (let index = 0; index < denseBaseline.length; index += 1) {
      const entry = this.resolve(denseBaseline[index] as RetrievalTraceCandidateHandle);
      if (TRACE_SET_HAS(baselineSet, entry)) {
        throw new RetrievalTraceValidationError('reranker baseline contains duplicate handles');
      }
      TRACE_SET_ADD(baselineSet, entry);
      defineTraceArrayItem(baseline, index, entry);
    }
    const sortedRounds = copyTraceArray(this.mmrRounds);
    TRACE_ARRAY_SORT(sortedRounds, (left, right) => left.round - right.round);
    const selected: CandidateEntry[] = [];
    for (let index = 0; index < sortedRounds.length; index += 1) {
      const entry = sortedRounds[index]!.selected;
      if (TRACE_MAP_GET(entry.filters, 'dedup')?.outcome === 'pass') {
        defineTraceArrayItem(selected, selected.length, entry);
      }
    }
    let baselineMismatch = baseline.length !== selected.length;
    for (let index = 0; !baselineMismatch && index < baseline.length; index += 1) {
      baselineMismatch = baseline[index] !== selected[index];
    }
    if (baselineMismatch) {
      throw new RetrievalTraceValidationError('reranker baseline does not match MMR order');
    }
    for (let index = 0; index < baseline.length; index += 1) {
      if (TRACE_MAP_GET(baseline[index]!.filters, 'dedup')?.outcome !== 'pass') {
        throw new RetrievalTraceValidationError('reranker baseline was not deduplicated');
      }
    }
    const outcomeErrors: string[] = [];
    const outcomeRecord = safeRecord(outcome, 'reranker outcome', outcomeErrors);
    if (!outcomeRecord) throw new RetrievalTraceValidationError(joinTraceErrors(outcomeErrors));
    if (outcome.outcome === 'baseline') {
      exactKeys(outcomeRecord, ['outcome'], 'reranker outcome', outcomeErrors);
      requireKeys(outcomeRecord, ['outcome'], 'reranker outcome', outcomeErrors);
      if (outcomeErrors.length > 0) throw new RetrievalTraceValidationError(joinTraceErrors(outcomeErrors));
      this.rerankerDraft = { outcome: 'baseline', baseline: TRACE_OBJECT_FREEZE(copyTraceArray(baseline)) };
      return;
    }
    if (outcome.outcome !== 'reranked') {
      throw new RetrievalTraceValidationError('reranker outcome is invalid');
    }
    exactKeys(outcomeRecord, ['outcome', 'candidates'], 'reranker outcome', outcomeErrors);
    requireKeys(outcomeRecord, ['outcome', 'candidates'], 'reranker outcome', outcomeErrors);
    const candidateErrors: string[] = [];
    const inputs = denseArray(outcome.candidates, 128, 'reranker outcome candidates', candidateErrors);
    if (outcomeErrors.length > 0 || !inputs || candidateErrors.length > 0) {
      throw new RetrievalTraceValidationError(joinTraceErrors(concatTraceErrors(outcomeErrors, candidateErrors)));
    }
    const reranked = new TRACE_ARRAY<{ candidate: CandidateEntry; calibratedScore: number }>(inputs.length);
    const rerankedSet = new TRACE_SET<CandidateEntry>();
    for (let index = 0; index < inputs.length; index += 1) {
      const raw = inputs[index];
      const label = `reranker outcome candidates[${index}]`;
      const errors: string[] = [];
      const record = safeRecord(raw, label, errors);
      if (record) {
        exactKeys(record, ['candidateHandle', 'calibratedScore'], label, errors);
        requireKeys(record, ['candidateHandle', 'calibratedScore'], label, errors);
      }
      if (errors.length > 0) throw new RetrievalTraceValidationError(joinTraceErrors(errors));
      const value = record!.calibratedScore;
      if (typeof value !== 'number' || !TRACE_NUMBER_IS_FINITE(value) || value < 0 || value > 1
        || TRACE_OBJECT_IS(value, -0) || roundTraceNumber(value) !== value) {
        throw new RetrievalTraceValidationError('reranker score is not canonical');
      }
      const candidate = this.resolve(record!.candidateHandle as RetrievalTraceCandidateHandle);
      if (TRACE_SET_HAS(rerankedSet, candidate) || !TRACE_SET_HAS(baselineSet, candidate)) {
        throw new RetrievalTraceValidationError('reranker result is not a permutation of baseline handles');
      }
      TRACE_SET_ADD(rerankedSet, candidate);
      defineTraceArrayItem(reranked, index, { candidate, calibratedScore: value });
    }
    if (reranked.length !== baseline.length) {
      throw new RetrievalTraceValidationError('reranker result is not a permutation of baseline handles');
    }
    const baselineRank = new TRACE_MAP<CandidateEntry, number>();
    for (let index = 0; index < baseline.length; index += 1) {
      TRACE_MAP_SET(baselineRank, baseline[index]!, index + 1);
    }
    const refEntries = copyTraceArray(this.entries);
    TRACE_ARRAY_SORT(refEntries, (left, right) => compareCandidateEntries(left, right, this.algorithmVersion));
    const canonicalRef = new TRACE_MAP<CandidateEntry, string>();
    for (let index = 0; index < refEntries.length; index += 1) {
      TRACE_MAP_SET(canonicalRef, refEntries[index]!, `c${tracePadStart(TRACE_STRING(index + 1), 4, '0')}`);
    }
    const canonical = copyTraceArray(reranked);
    TRACE_ARRAY_SORT(canonical, (left, right) => right.calibratedScore - left.calibratedScore
      || TRACE_MAP_GET(baselineRank, left.candidate)! - TRACE_MAP_GET(baselineRank, right.candidate)!
      || compareText(TRACE_MAP_GET(canonicalRef, left.candidate)!, TRACE_MAP_GET(canonicalRef, right.candidate)!));
    for (let index = 0; index < canonical.length; index += 1) {
      if (canonical[index] !== reranked[index]) {
        throw new RetrievalTraceValidationError('reranker result order is not canonical');
      }
    }
    this.rerankerDraft = {
      outcome: 'reranked',
      baseline: TRACE_OBJECT_FREEZE(copyTraceArray(baseline)),
      reranked: TRACE_OBJECT_FREEZE(copyTraceArray(reranked)),
    };
  }

  recordStageFailure(stage: RetrievalTraceFailureStage, code: RetrievalTraceFailureCode): void {
    this.assertOpen();
    this.reserveEvent();
    if (this.stageFailures.length >= this.limits.maxStageFailures) this.limitExceeded('stage failure limit exceeded');
    if (!enumHas(FAILURE_STAGES, stage) || !enumHas(FAILURE_CODES, code)) throw new RetrievalTraceValidationError('stage failure is invalid');
    const failure = { stage, code };
    if (this.algorithmVersion === 'ranked-v2') defineTraceArrayItem(this.stageFailures, this.stageFailures.length, failure);
    else this.stageFailures.push(failure);
  }

  /** @internal Runtime adapters may fail closed when safe evidence cannot be
   * represented as events without inventing provenance. */
  markIncomplete(reason: RetrievalTraceIncompleteReason): void {
    this.assertOpen();
    if (!enumHas(INCOMPLETE_REASONS, reason)) {
      throw new RetrievalTraceValidationError('incomplete reason is unsupported');
    }
    TRACE_SET_ADD(this.incomplete, reason);
  }

  finalize(): RetrievalTraceV1 {
    this.assertOpen();
    if (this.algorithmVersion === 'ranked-v2') assertSecretRedactionIntrinsic();
    this.finalized = true;
    if (this.algorithmVersion === 'ranked-v2' && this.rerankerDraft === undefined) {
      TRACE_SET_ADD(this.incomplete, 'candidate-output-gap');
    }
    for (let index = 0; index < this.requestShape.plannedChannels.length; index += 1) {
      const channel = this.requestShape.plannedChannels[index]!;
      if (!TRACE_SET_HAS(this.attempts, channel) || TRACE_MAP_GET(this.settlements, channel) === undefined) {
        TRACE_SET_ADD(this.incomplete, 'channel-gap');
      }
    }
    const rankedV2 = this.algorithmVersion === 'ranked-v2';
    const sortedEntries = rankedV2 ? copyTraceArray(this.entries) : [...this.entries];
    if (rankedV2) TRACE_ARRAY_SORT(sortedEntries, (a, b) => compareCandidateEntries(a, b, this.algorithmVersion));
    else sortedEntries.sort((a, b) => compareCandidateEntries(a, b, this.algorithmVersion));
    if (this.algorithmVersion === 'deterministic-v2') {
      let outputRank = 0;
      for (let index = 0; index < sortedEntries.length; index += 1) {
        const entry = sortedEntries[index]!;
        if (entry.terminal?.outcome === 'included') entry.outputRank = ++outputRank;
      }
    }
    const usedChannelRanks = new TRACE_SET<string>();
    for (let entryIndex = 0; entryIndex < sortedEntries.length; entryIndex += 1) {
      const entry = sortedEntries[entryIndex]!;
      for (let channelIndex = 0; channelIndex < entry.draft.channels.length; channelIndex += 1) {
        const channel = entry.draft.channels[channelIndex]!;
        const identity = `${channel.channel}:${channel.rank}`;
        if (TRACE_SET_HAS(usedChannelRanks, identity)) TRACE_SET_ADD(this.incomplete, 'candidate-identity-collision');
        TRACE_SET_ADD(usedChannelRanks, identity);
      }
      if (!entry.terminal) TRACE_SET_ADD(this.incomplete, 'candidate-terminal-gap');
      if (entry.terminal?.outcome === 'included' ? entry.outputRank === undefined : entry.outputRank !== undefined) {
        TRACE_SET_ADD(this.incomplete, 'candidate-output-gap');
      }
      let unsettled = false;
      for (let channelIndex = 0; channelIndex < entry.draft.channels.length; channelIndex += 1) {
        if (TRACE_MAP_GET(this.settlements, entry.draft.channels[channelIndex]!.channel)?.outcome !== 'success') {
          unsettled = true;
          break;
        }
      }
      if (unsettled) TRACE_SET_ADD(this.incomplete, 'channel-gap');
    }
    const ranks: number[] = [];
    for (let index = 0; index < sortedEntries.length; index += 1) {
      const rank = sortedEntries[index]!.outputRank;
      if (rank !== undefined) defineTraceArrayItem(ranks, ranks.length, rank);
    }
    if (rankedV2) TRACE_ARRAY_SORT(ranks, (a, b) => a - b);
    else ranks.sort((a, b) => a - b);
    let ranksValid = true;
    const rankSet = new TRACE_SET<number>();
    for (let index = 0; index < ranks.length; index += 1) {
      if (ranks[index] !== index + 1 || TRACE_SET_HAS(rankSet, ranks[index]!)) ranksValid = false;
      TRACE_SET_ADD(rankSet, ranks[index]!);
    }
    if (!ranksValid) TRACE_SET_ADD(this.incomplete, 'candidate-output-gap');

    const refs = new TRACE_MAP<CandidateEntry, string>();
    for (let index = 0; index < sortedEntries.length; index += 1) {
      TRACE_MAP_SET(refs, sortedEntries[index]!, `c${tracePadStart(TRACE_STRING(index + 1), 4, '0')}`);
    }
    const candidates: RetrievalTraceCandidateV1[] = rankedV2
      ? new TRACE_ARRAY<RetrievalTraceCandidateV1>(sortedEntries.length)
      : sortedEntries.map((entry) => ({ ref: TRACE_MAP_GET(refs, entry)!, ...entry.draft }));
    if (rankedV2) {
      for (let index = 0; index < sortedEntries.length; index += 1) {
        const entry = sortedEntries[index]!;
        defineTraceArrayItem(candidates, index, { ref: TRACE_MAP_GET(refs, entry)!, ...entry.draft });
      }
    }
    const eventsWithoutSequence: UnsequencedTraceEvent[] = [];
    const appendEvent = (event: UnsequencedTraceEvent): void => {
      if (rankedV2) defineTraceArrayItem(eventsWithoutSequence, eventsWithoutSequence.length, event);
      else eventsWithoutSequence.push(event);
    };
    for (let index = 0; index < this.requestShape.plannedChannels.length; index += 1) {
      const channel = this.requestShape.plannedChannels[index]!;
      if (TRACE_SET_HAS(this.attempts, channel)) appendEvent({ kind: 'channel-attempt', channel });
    }
    for (let index = 0; index < this.requestShape.plannedChannels.length; index += 1) {
      const channel = this.requestShape.plannedChannels[index]!;
      const settlement = TRACE_MAP_GET(this.settlements, channel);
      if (settlement) appendEvent({ kind: 'channel-terminal', channel, ...settlement });
    }
    for (let entryIndex = 0; entryIndex < sortedEntries.length; entryIndex += 1) {
      const entry = sortedEntries[entryIndex]!;
      const ref = TRACE_MAP_GET(refs, entry)!;
      const filters = rankedV2 ? traceMapValues(entry.filters) : [...entry.filters.values()];
      if (rankedV2) TRACE_ARRAY_SORT(filters, (a, b) => compareText(a.name, b.name));
      else filters.sort((a, b) => compareText(a.name, b.name));
      for (let filterIndex = 0; filterIndex < filters.length; filterIndex += 1) {
        appendEvent({ kind: 'candidate-filter', ref, ...filters[filterIndex]! });
      }
    }
    for (let entryIndex = 0; entryIndex < sortedEntries.length; entryIndex += 1) {
      const entry = sortedEntries[entryIndex]!;
      const ref = TRACE_MAP_GET(refs, entry)!;
      const scores = rankedV2 ? traceMapValues(entry.scores) : [...entry.scores.values()];
      if (rankedV2) TRACE_ARRAY_SORT(scores, (a, b) => compareText(a.name, b.name));
      else scores.sort((a, b) => compareText(a.name, b.name));
      for (let scoreIndex = 0; scoreIndex < scores.length; scoreIndex += 1) {
        appendEvent({ kind: 'candidate-score', ref, ...scores[scoreIndex]! });
      }
    }
    const finalRounds = rankedV2 ? copyTraceArray(this.mmrRounds) : [...this.mmrRounds];
    if (rankedV2) TRACE_ARRAY_SORT(finalRounds, (a, b) => a.round - b.round);
    else finalRounds.sort((a, b) => a.round - b.round);
    for (let roundIndex = 0; roundIndex < finalRounds.length; roundIndex += 1) {
      const round = finalRounds[roundIndex]!;
      const records: RetrievalTraceMmrRecordV1[] = rankedV2
        ? new TRACE_ARRAY<RetrievalTraceMmrRecordV1>(round.records.length)
        : round.records.map((record) => {
            const pairwise = record.pairwise.map((pair) => ({
              selectedRef: TRACE_MAP_GET(refs, pair.selected)!, similarity: pair.similarity,
            })).sort((a, b) => compareText(a.selectedRef, b.selectedRef));
            const maximum = [...pairwise]
              .sort((a, b) => b.similarity - a.similarity || compareText(a.selectedRef, b.selectedRef))[0];
            const maxSimilarity = maximum?.similarity ?? 0;
            return {
              ref: TRACE_MAP_GET(refs, record.candidate)!, relevance: record.relevance, maxSimilarity,
              lambda: record.lambda,
              objective: roundTraceNumber(record.lambda * record.relevance - (1 - record.lambda) * maxSimilarity),
              againstRef: maximum?.selectedRef ?? null,
              pairwise,
            };
          }).sort((a, b) => compareText(a.ref, b.ref));
      if (rankedV2) {
        for (let recordIndex = 0; recordIndex < round.records.length; recordIndex += 1) {
          const record = round.records[recordIndex]!;
          const pairwise = new TRACE_ARRAY<RetrievalTraceMmrPairwiseV1>(record.pairwise.length);
          for (let pairIndex = 0; pairIndex < record.pairwise.length; pairIndex += 1) {
            const pair = record.pairwise[pairIndex]!;
            defineTraceArrayItem(pairwise, pairIndex, {
              selectedRef: TRACE_MAP_GET(refs, pair.selected)!, similarity: pair.similarity,
            });
          }
          TRACE_ARRAY_SORT(pairwise, (a, b) => compareText(a.selectedRef, b.selectedRef));
          const maximumOrder = copyTraceArray(pairwise);
          TRACE_ARRAY_SORT(maximumOrder, (a, b) => b.similarity - a.similarity
            || compareText(a.selectedRef, b.selectedRef));
          const maximum = maximumOrder.length === 0 ? undefined : maximumOrder[0];
          const maxSimilarity = maximum?.similarity ?? 0;
          defineTraceArrayItem(records, recordIndex, {
            ref: TRACE_MAP_GET(refs, record.candidate)!, relevance: record.relevance, maxSimilarity,
            lambda: record.lambda,
            objective: roundTraceNumber(record.lambda * record.relevance - (1 - record.lambda) * maxSimilarity),
            againstRef: maximum?.selectedRef ?? null,
            pairwise,
          });
        }
        TRACE_ARRAY_SORT(records, (a, b) => compareText(a.ref, b.ref));
      }
      appendEvent({
        kind: 'mmr-round',
        round: round.round,
        selectedRef: TRACE_MAP_GET(refs, round.selected)!,
        records,
      });
    }
    if (this.algorithmVersion === 'ranked-v2' && this.rerankerDraft !== undefined) {
      const provider = traceRecord({
        providerId: SERVED_RERANKER_PROVIDER_IDENTITY.providerId,
        modelId: SERVED_RERANKER_PROVIDER_IDENTITY.modelId,
        calibrationId: SERVED_RERANKER_PROVIDER_IDENTITY.calibrationId,
        locality: 'local' as const,
      });
      const rerankedRank = new TRACE_MAP<CandidateEntry, number>();
      if (this.rerankerDraft.outcome === 'reranked') {
        for (let index = 0; index < this.rerankerDraft.reranked.length; index += 1) {
          TRACE_MAP_SET(rerankedRank, this.rerankerDraft.reranked[index]!.candidate, index + 1);
        }
      }
      const eventCandidates = new TRACE_ARRAY<RetrievalTraceRerankerCandidateV2 | RetrievalTraceRerankerBaselineCandidateV2>(
        this.rerankerDraft.baseline.length,
      );
      for (let index = 0; index < this.rerankerDraft.baseline.length; index += 1) {
        const entry = this.rerankerDraft.baseline[index]!;
        let calibratedScore: number | undefined;
        if (this.rerankerDraft.outcome === 'reranked') {
          for (let rerankedIndex = 0; rerankedIndex < this.rerankerDraft.reranked.length; rerankedIndex += 1) {
            const reranked = this.rerankerDraft.reranked[rerankedIndex]!;
            if (reranked.candidate === entry) { calibratedScore = reranked.calibratedScore; break; }
          }
        }
        const base = {
          ref: TRACE_MAP_GET(refs, entry)!,
          baselineRank: index + 1,
          rerankedRank: this.rerankerDraft.outcome === 'reranked' ? TRACE_MAP_GET(rerankedRank, entry)! : index + 1,
        };
        const candidate = this.rerankerDraft.outcome === 'reranked'
          ? traceRecord({
              ref: base.ref,
              baselineRank: base.baselineRank,
              calibratedScore: calibratedScore!,
              rerankedRank: base.rerankedRank,
            })
          : traceRecord(base);
        defineTraceArrayItem(eventCandidates, index, candidate);
      }
      const event = this.rerankerDraft.outcome === 'reranked'
        ? traceRecord({
            kind: 'reranker-stage' as const,
            provider,
            outcome: 'reranked' as const,
            candidates: TRACE_OBJECT_FREEZE(eventCandidates) as readonly RetrievalTraceRerankerCandidateV2[],
          })
        : traceRecord({
            kind: 'reranker-stage' as const,
            provider,
            outcome: 'baseline' as const,
            reason: 'not-reranked' as const,
            candidates: TRACE_OBJECT_FREEZE(eventCandidates) as readonly RetrievalTraceRerankerBaselineCandidateV2[],
          });
      appendEvent(event as UnsequencedTraceEvent);
    }
    const outputEntries = rankedV2 ? new TRACE_ARRAY<CandidateEntry>()
      : [...sortedEntries].filter((item) => item.outputRank !== undefined);
    if (rankedV2) {
      for (let index = 0; index < sortedEntries.length; index += 1) {
        if (sortedEntries[index]!.outputRank !== undefined) {
          defineTraceArrayItem(outputEntries, outputEntries.length, sortedEntries[index]!);
        }
      }
      TRACE_ARRAY_SORT(outputEntries, (a, b) => a.outputRank! - b.outputRank!);
    } else outputEntries.sort((a, b) => a.outputRank! - b.outputRank!);
    for (let index = 0; index < outputEntries.length; index += 1) {
      const entry = outputEntries[index]!;
      appendEvent({
        kind: this.algorithmVersion === 'ranked-v1' || this.algorithmVersion === 'ranked-v2'
          ? 'ranked-output' : 'deterministic-output',
        ref: TRACE_MAP_GET(refs, entry)!, rank: entry.outputRank!,
      });
    }
    for (let index = 0; index < sortedEntries.length; index += 1) {
      const entry = sortedEntries[index]!;
      if (!entry.terminal) continue;
      const duplicate = 'duplicateOf' in entry.terminal && entry.terminal.duplicateOf !== undefined
        ? this.resolve(entry.terminal.duplicateOf) : undefined;
      appendEvent({
        kind: 'candidate-terminal', ref: TRACE_MAP_GET(refs, entry)!, outcome: entry.terminal.outcome,
        reasons: rankedV2 ? copyTraceArray(entry.terminal.reasons) : [...entry.terminal.reasons],
        ...(duplicate ? { duplicateOfRef: TRACE_MAP_GET(refs, duplicate)! } : {}),
      });
    }
    const finalFailures = rankedV2 ? copyTraceArray(this.stageFailures) : [...this.stageFailures];
    if (rankedV2) TRACE_ARRAY_SORT(finalFailures, (a, b) => compareText(a.stage, b.stage) || compareText(a.code, b.code));
    else finalFailures.sort((a, b) => compareText(a.stage, b.stage) || compareText(a.code, b.code));
    for (let index = 0; index < finalFailures.length; index += 1) {
      appendEvent({ kind: 'stage-failure', ...finalFailures[index]! });
    }
    const reservedEvents = this.algorithmVersion === 'ranked-v2' ? 1 : 0;
    if (eventsWithoutSequence.length > this.limits.maxEvents + reservedEvents) {
      TRACE_SET_ADD(this.incomplete, 'limit-overflow');
    }
    const events = rankedV2
      ? new TRACE_ARRAY<RetrievalTraceStageEventV1>(eventsWithoutSequence.length)
      : eventsWithoutSequence.map((event, index) => ({ sequence: index + 1, ...event })) as RetrievalTraceStageEventV1[];
    if (rankedV2) {
      for (let index = 0; index < eventsWithoutSequence.length; index += 1) {
        const event = eventsWithoutSequence[index]!;
        defineTraceArrayItem(events, index, event.kind === 'reranker-stage'
          ? traceRecord({ sequence: index + 1, ...event }) as RetrievalTraceStageEventV1
          : ({ sequence: index + 1, ...event }) as RetrievalTraceStageEventV1);
      }
    }

    const preliminary: RetrievalTraceV1 = {
      schemaVersion: RETRIEVAL_TRACE_VERSION,
      algorithmVersion: this.algorithmVersion,
      requestShape: this.requestShape,
      complete: false,
      incompleteReasons: [],
      candidates,
      events,
      resultOrder: [],
      terminalExclusions: [],
      replayStateDigest: tracePadEnd('sha256:', 71, '0'),
    };
    const rawSemanticErrors = conformanceErrors(preliminary);
    const semanticErrors = rankedV2 ? new TRACE_ARRAY<string>() : rawSemanticErrors.filter((error) =>
      !error.includes('resultOrder') && !error.includes('terminalExclusions'));
    if (rankedV2) {
      for (let index = 0; index < rawSemanticErrors.length; index += 1) {
        const error = rawSemanticErrors[index]!;
        if (!traceStringIncludes(error, 'resultOrder') && !traceStringIncludes(error, 'terminalExclusions')) {
          defineTraceArrayItem(semanticErrors, semanticErrors.length, error);
        }
      }
    }
    for (let index = 0; index < semanticErrors.length; index += 1) {
      const error = semanticErrors[index]!;
      if (traceStringIncludes(error, 'MMR')) TRACE_SET_ADD(this.incomplete, 'mmr-gap');
      else if (traceStringIncludes(error, 'channel')) TRACE_SET_ADD(this.incomplete, 'channel-gap');
      else if (traceStringIncludes(error, 'filter')) TRACE_SET_ADD(this.incomplete, 'candidate-event-conflict');
      else if (traceStringIncludes(error, 'terminal')) TRACE_SET_ADD(this.incomplete, 'candidate-terminal-gap');
      else TRACE_SET_ADD(this.incomplete, 'candidate-output-gap');
    }
    const reconstructed = reconstructFromEvents(preliminary);
    const incompleteReasons = rankedV2 ? traceSetValues(this.incomplete) : [...this.incomplete];
    if (rankedV2) TRACE_ARRAY_SORT(incompleteReasons, compareText);
    else incompleteReasons.sort(compareText);
    const withoutDigest: RetrievalTraceV1 = {
      ...preliminary,
      complete: incompleteReasons.length === 0,
      incompleteReasons,
      resultOrder: reconstructed.resultOrder,
      terminalExclusions: reconstructed.terminalExclusions,
    };
    const trace = { ...withoutDigest, replayStateDigest: computeRetrievalTraceReplayStateDigest(withoutDigest) };
    assertRetrievalTraceSecretSafe(trace);
    return trace;
  }

  private resolve(handle: RetrievalTraceCandidateHandle): CandidateEntry {
    if ((typeof handle !== 'object' && typeof handle !== 'function') || handle === null) throw new RetrievalTraceValidationError('candidate handle is invalid');
    const entry = TRACE_WEAK_MAP_GET(this.handles, handle as object);
    if (!entry) throw new RetrievalTraceValidationError('candidate handle is not owned by this collector');
    return entry;
  }

  private assertPlannedChannel(channel: RetrievalTraceChannel): void {
    const planned = this.algorithmVersion === 'ranked-v2'
      ? includesTraceArray(this.requestShape.plannedChannels, channel)
      : this.requestShape.plannedChannels.includes(channel);
    if (!enumHas(RETRIEVAL_TRACE_CHANNEL_ORDER, channel) || !planned) {
      throw new RetrievalTraceValidationError('channel is not planned');
    }
  }

  private reserveEvent(): void {
    let candidateEventCount = 0;
    if (this.algorithmVersion === 'ranked-v2') {
      for (let index = 0; index < this.entries.length; index += 1) {
        const entry = this.entries[index]!;
        candidateEventCount += traceMapSize(entry.filters) + traceMapSize(entry.scores)
          + (entry.outputRank === undefined ? 0 : 1) + (entry.terminal ? 1 : 0);
      }
    } else {
      candidateEventCount = this.entries.reduce((sum, entry) => sum + entry.filters.size + entry.scores.size
        + (entry.outputRank === undefined ? 0 : 1) + (entry.terminal ? 1 : 0), 0);
    }
    const count = (this.algorithmVersion === 'ranked-v2' ? traceSetSize(this.attempts) : this.attempts.size)
      + (this.algorithmVersion === 'ranked-v2' ? traceMapSize(this.settlements) : this.settlements.size)
      + this.stageFailures.length + this.mmrRounds.length
      + candidateEventCount;
    if (count >= this.limits.maxEvents) this.limitExceeded('event limit exceeded');
  }

  private mmrNumber(value: number, min: number, max: number): number {
    const normalized = roundTraceNumber(value);
    if (normalized < min || normalized > max) throw new RetrievalTraceValidationError('MMR number is outside semantic bounds');
    return normalized;
  }

  private limitExceeded(message: string): never {
    if (this.algorithmVersion === 'ranked-v2') TRACE_SET_ADD(this.incomplete, 'limit-overflow');
    else this.incomplete.add('limit-overflow');
    throw new RetrievalTraceLimitError(message);
  }

  private assertOpen(): void {
    if (this.finalized) throw new RetrievalTraceValidationError('collector is already finalized');
  }
}
