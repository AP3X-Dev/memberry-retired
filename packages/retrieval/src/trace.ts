import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';

import { redactSecrets } from '@memberry/core';

export const RETRIEVAL_TRACE_VERSION = '1.0.0' as const;
export const RETRIEVAL_TRACE_NUMBER_DECIMALS = 6 as const;

const HARD_LIMITS = Object.freeze({
  candidates: 512,
  plannedChannels: 16,
  channelsPerCandidate: 8,
  events: 8192,
  filtersPerCandidate: 16,
  scoresPerCandidate: 8,
  exclusionReasonsPerCandidate: 8,
  mmrRounds: 64,
  mmrRecordsPerRound: 128,
  mmrRecordsTotal: 4096,
  mmrPairwisePerRecord: 64,
  mmrPairwiseTotal: 8192,
  stageFailures: 32,
});

const DEFAULT_LIMITS = Object.freeze({
  maxCandidates: 128,
  maxEvents: 4096,
  maxChannelsPerCandidate: 8,
  maxFiltersPerCandidate: 12,
  maxScoresPerCandidate: 8,
  maxExclusionReasonsPerCandidate: 8,
  maxMmrRounds: 32,
  maxMmrRecordsPerRound: 128,
  maxMmrRecordsTotal: 2048,
  maxMmrPairwisePerRecord: 32,
  maxMmrPairwiseTotal: 4096,
  maxStageFailures: 32,
});

const AGGREGATE_LIMITS = Object.freeze({
  // These ceilings dominate the collector's hard maxima, including duplicated
  // terminal-reason mirrors, while still bounding validation to a small trace.
  arrays: 6144,
  arrayEntries: 36_864,
  records: 28_672,
  recordFields: 131_072,
  scalarBytes: 4_194_304,
  depth: 20,
});

const MAX_TRACE_NUMBER = 1_000_000;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export type RetrievalTraceAlgorithmVersion = 'ranked-v1' | 'deterministic-v1' | 'deterministic-v2';
export type RetrievalTraceSourceType =
  | 'semantic' | 'episodic' | 'symbol' | 'arch_entity' | 'aspect' | 'fact' | 'block';
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

const ALGORITHMS = ['ranked-v1', 'deterministic-v1', 'deterministic-v2'] as const;
const SOURCE_TYPES = ['semantic', 'episodic', 'symbol', 'arch_entity', 'aspect', 'fact', 'block'] as const;
const CHANNELS = [
  'memory.scope', 'memory.semantic-vector', 'memory.episodic-vector', 'memory.fact', 'memory.block', 'memory.graph',
  'code.fulltext', 'code.lexical-vector', 'code.dense-vector', 'code.semantic-vector',
  'arch.fulltext', 'arch.hierarchy', 'arch.dependency', 'arch.aspect', 'arch.entity',
] as const;
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

const channelOrder = new Map(CHANNELS.map((channel, index) => [channel, index]));
const deterministicV2ChannelOrderValues: readonly RetrievalTraceChannel[] = Object.freeze([
  'arch.fulltext',
  ...RETRIEVAL_TRACE_DETERMINISTIC_OUTPUT_CHANNEL_ORDER_V2,
  ...CHANNELS.filter((channel) => channel !== 'arch.fulltext'
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
    && (RETRIEVAL_TRACE_DETERMINISTIC_OUTPUT_CHANNEL_ORDER_V2 as readonly string[]).includes(channel);
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

interface SequencedEvent { sequence: number }
export type RetrievalTraceStageEventV1 =
  | (SequencedEvent & { kind: 'channel-attempt'; channel: RetrievalTraceChannel })
  | (SequencedEvent & { kind: 'channel-terminal'; channel: RetrievalTraceChannel; outcome: 'success' })
  | (SequencedEvent & { kind: 'channel-terminal'; channel: RetrievalTraceChannel; outcome: 'safe-failure'; code: RetrievalTraceFailureCode })
  | (SequencedEvent & { kind: 'candidate-filter'; ref: string; name: RetrievalTraceFilterName; outcome: 'pass' | 'fail' | 'not-applicable' })
  | (SequencedEvent & { kind: 'candidate-score'; ref: string; name: RetrievalTraceScoreName; value: number })
  | (SequencedEvent & { kind: 'mmr-round'; round: number; selectedRef: string; records: readonly RetrievalTraceMmrRecordV1[] })
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
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  if (isProxy(value)) return false;
  if (Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeRecord(value: unknown, label: string, errors: string[]): Record<string, unknown> | undefined {
  if (!isPlainRecord(value)) { errors.push(`${label} must be a plain data object`); return undefined; }
  const before = errors.length;
  inspectObject(value, label, errors);
  return errors.length === before ? value : undefined;
}

function inspectObject(value: Record<string, unknown>, label: string, errors: string[]): string[] {
  const keys: string[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') { errors.push(`${label} has non-string fields`); continue; }
    if (DANGEROUS_KEYS.has(key)) { errors.push(`${label} has dangerous fields`); continue; }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && !('value' in descriptor)) {
      errors.push(`${label} has accessor fields`);
      continue;
    }
    if (!descriptor?.enumerable) {
      errors.push(`${label} has non-data fields`);
      continue;
    }
    keys.push(key);
  }
  return keys;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string, errors: string[]): void {
  const keys = inspectObject(value, label, errors);
  if (keys.some((key) => !allowed.includes(key))) errors.push(`${label} has unknown fields`);
}

function requireKeys(value: Record<string, unknown>, required: readonly string[], label: string, errors: string[]): void {
  if (required.some((key) => !Object.hasOwn(value, key))) errors.push(`${label} is missing required fields`);
}

function denseArray(value: unknown, max: number, label: string, errors: string[]): unknown[] | undefined {
  if (value === null || typeof value !== 'object' || isProxy(value) || !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype) {
    errors.push(`${label} must be a plain array`);
    return undefined;
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value as unknown : undefined;
  if (!validInteger(length, 0, max)) { errors.push(`${label} exceeds hard limit`); return undefined; }
  let invalid = false;
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor) { errors.push(`${label} must not be sparse`); invalid = true; break; }
    if (!('value' in descriptor)) { errors.push(`${label} contains accessor fields`); invalid = true; break; }
    if (!descriptor.enumerable) { errors.push(`${label} has non-data entries`); invalid = true; break; }
  }
  if (invalid) return undefined;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') { errors.push(`${label} has non-string fields`); continue; }
    if (key === 'length') continue;
    if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length) errors.push(`${label} has ambiguous fields`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && !('value' in descriptor)) errors.push(`${label} contains accessor fields`);
    else if (!descriptor?.enumerable) errors.push(`${label} has non-data entries`);
  }
  return errors.some((error) => error.startsWith(label)) ? undefined : value;
}

function preflightTraceStructure(root: unknown): string[] {
  const seen = new WeakSet<object>();
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let arrays = 0;
  let arrayEntries = 0;
  let records = 0;
  let recordFields = 0;
  let scalarBytes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.depth > AGGREGATE_LIMITS.depth) return ['trace exceeds aggregate depth budget'];
    if (current.value === null) { scalarBytes += 4; continue; }
    if (typeof current.value === 'string') {
      if (current.value.length > AGGREGATE_LIMITS.scalarBytes) return ['trace exceeds aggregate byte budget'];
      scalarBytes += Buffer.byteLength(current.value, 'utf8');
      if (scalarBytes > AGGREGATE_LIMITS.scalarBytes) return ['trace exceeds aggregate byte budget'];
      continue;
    }
    if (typeof current.value === 'number' || typeof current.value === 'boolean') {
      scalarBytes += 8;
      if (scalarBytes > AGGREGATE_LIMITS.scalarBytes) return ['trace exceeds aggregate byte budget'];
      continue;
    }
    if (typeof current.value !== 'object' || isProxy(current.value)) return ['trace contains exotic values'];
    if (seen.has(current.value)) return ['trace contains shared or cyclic references'];
    seen.add(current.value);
    if (Array.isArray(current.value)) {
      if (Object.getPrototypeOf(current.value) !== Array.prototype) return ['trace contains exotic values'];
      arrays++;
      if (arrays > AGGREGATE_LIMITS.arrays) return ['trace exceeds aggregate array budget'];
      const lengthDescriptor = Object.getOwnPropertyDescriptor(current.value, 'length');
      const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value as unknown : undefined;
      if (!validInteger(length, 0, AGGREGATE_LIMITS.arrayEntries)) return ['trace exceeds aggregate array budget'];
      arrayEntries += length;
      if (arrayEntries > AGGREGATE_LIMITS.arrayEntries) return ['trace exceeds aggregate array budget'];
      for (let index = 0; index < length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(current.value, String(index));
        if (!descriptor) return ['trace contains sparse arrays'];
        if (!('value' in descriptor)) return ['trace contains accessor fields'];
        if (!descriptor.enumerable) return ['trace contains exotic values'];
        stack.push({ value: descriptor.value, depth: current.depth + 1 });
      }
      const keys = Reflect.ownKeys(current.value);
      if (keys.some((key) => typeof key !== 'string'
        || (key !== 'length' && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length)))) {
        return ['trace contains exotic values'];
      }
      continue;
    }
    const prototype = Object.getPrototypeOf(current.value);
    if (prototype !== Object.prototype && prototype !== null) return ['trace contains exotic values'];
    records++;
    if (records > AGGREGATE_LIMITS.records) return ['trace exceeds aggregate record budget'];
    const keys = Reflect.ownKeys(current.value);
    recordFields += keys.length;
    if (recordFields > AGGREGATE_LIMITS.recordFields) return ['trace exceeds aggregate record budget'];
    for (const key of keys) {
      if (typeof key !== 'string') return ['trace contains exotic values'];
      if (DANGEROUS_KEYS.has(key)) return ['trace contains dangerous fields'];
      scalarBytes += Buffer.byteLength(key, 'utf8');
      if (scalarBytes > AGGREGATE_LIMITS.scalarBytes) return ['trace exceeds aggregate byte budget'];
      const descriptor = Object.getOwnPropertyDescriptor(current.value, key);
      if (!descriptor || !('value' in descriptor)) return ['trace contains accessor fields'];
      if (!descriptor.enumerable) return ['trace contains exotic values'];
      stack.push({ value: descriptor.value, depth: current.depth + 1 });
    }
  }
  return [];
}

function validInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function validateRoundedNumber(value: unknown, label: string, errors: string[], min: number, max: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) { errors.push(`${label} must be finite`); return; }
  if (value < min || value > max) errors.push(`${label} is outside semantic bounds`);
  if (roundTraceNumber(value) !== value || Object.is(value, -0)) errors.push(`${label} must be canonically rounded`);
}

export function roundTraceNumber(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_TRACE_NUMBER) {
    throw new RetrievalTraceValidationError('trace number is outside safe finite bounds');
  }
  const rounded = Number(value.toFixed(RETRIEVAL_TRACE_NUMBER_DECIMALS));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function canonicalizeValue(value: unknown, path: string, ancestors: WeakSet<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return roundTraceNumber(value);
  if (typeof value !== 'object') throw new RetrievalTraceValidationError(`${path} contains a non-canonical value`);
  if (ancestors.has(value)) throw new RetrievalTraceValidationError(`${path} contains a cycle`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const errors: string[] = [];
      const items = denseArray(value, HARD_LIMITS.events, path, errors);
      if (!items || errors.length > 0) throw new RetrievalTraceValidationError(errors.join('; '));
      return items.map((item, index) => canonicalizeValue(item, `${path}[${index}]`, ancestors));
    }
    if (!isPlainRecord(value)) throw new RetrievalTraceValidationError(`${path} contains a non-canonical object`);
    const errors: string[] = [];
    const keys = inspectObject(value, path, errors);
    if (errors.length > 0) throw new RetrievalTraceValidationError(errors.join('; '));
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys.sort(compareText)) {
      const child = value[key];
      if (child === undefined) throw new RetrievalTraceValidationError(`${path} contains undefined`);
      out[key] = canonicalizeValue(child, `${path}.${key}`, ancestors);
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

/** Stable, JSON-safe canonicalization with sorted keys and six-decimal finite numbers. */
export function canonicalTraceJson(value: unknown): string {
  const preflight = preflightTraceStructure(value);
  if (preflight.length > 0) throw new RetrievalTraceValidationError(preflight.join('; '));
  return JSON.stringify(canonicalizeValue(value, 'trace', new WeakSet()));
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
    for (const key of ['code', 'architecture', 'memory']) {
      if (typeof sources[key] !== 'boolean') errors.push('trace.requestShape.sources has invalid flags');
    }
  }
  if (typeof request.projectScopeApplied !== 'boolean' || typeof request.temporalFilterApplied !== 'boolean') {
    errors.push('trace.requestShape has invalid boolean flags');
  }
  if (request.tenantScope !== 'default' && request.tenantScope !== 'named') errors.push('trace.requestShape.tenantScope is invalid');
  if (!enumHas(CARDINALITY_BUCKETS, request.entityScope) || !enumHas(CARDINALITY_BUCKETS, request.tagScope)) {
    errors.push('trace.requestShape has invalid scope buckets');
  }
  if (!enumHas(QUERY_LENGTHS, request.queryLength) || !enumHas(QUERY_FORMS, request.queryForm)) {
    errors.push('trace.requestShape has invalid query buckets');
  }
  if (!enumHas(TOKEN_BUDGETS, request.tokenBudget) || !enumHas(DIVERSIFICATION, request.diversification)) {
    errors.push('trace.requestShape has invalid strategy buckets');
  }
  const planned = denseArray(request.plannedChannels, HARD_LIMITS.plannedChannels, 'trace.requestShape.plannedChannels', errors);
  if (planned) {
    if (planned.some((channel) => !enumHas(CHANNELS, channel))) errors.push('trace.requestShape.plannedChannels has invalid channels');
    if (new Set(planned).size !== planned.length) errors.push('trace.requestShape.plannedChannels has duplicates');
    const order = orderForAlgorithm(algorithmVersion);
    const sorted = [...planned].sort((a, b) => (order.get(a as RetrievalTraceChannel) ?? 99) - (order.get(b as RetrievalTraceChannel) ?? 99));
    if (canonicalTraceJson(planned) !== canonicalTraceJson(sorted)) errors.push('trace.requestShape.plannedChannels is not canonical');
  }
}

function validateEvidence(value: unknown, label: string, errors: string[]): void {
  const evidence = safeRecord(value, label, errors);
  if (!evidence) return;
  exactKeys(evidence, ['confidence', 'sourceCount', 'superseded', 'invalidated'], label, errors);
  if (evidence.confidence !== undefined) validateRoundedNumber(evidence.confidence, `${label}.confidence`, errors, 0, 1);
  if (evidence.sourceCount !== undefined && !validInteger(evidence.sourceCount, 0, 64)) errors.push(`${label}.sourceCount is outside semantic bounds`);
  if (evidence.superseded !== undefined && typeof evidence.superseded !== 'boolean') errors.push(`${label}.superseded must be boolean`);
  if (evidence.invalidated !== undefined && typeof evidence.invalidated !== 'boolean') errors.push(`${label}.invalidated must be boolean`);
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
  if (typeof candidate.ref !== 'string' || !/^c\d{4}$/.test(candidate.ref)) errors.push(`${label}.ref is invalid`);
  if (!enumHas(SOURCE_TYPES, candidate.sourceType)) errors.push(`${label}.sourceType is invalid`);
  const channels = denseArray(candidate.channels, HARD_LIMITS.channelsPerCandidate, `${label}.channels`, errors);
  if (channels && channels.length === 0) errors.push(`${label}.channels must be non-empty`);
  channels?.forEach((raw, channelIndex) => {
    const channelLabel = `${label}.channels[${channelIndex}]`;
    const channel = safeRecord(raw, channelLabel, errors);
    if (!channel) return;
    exactKeys(channel, ['channel', 'rank', 'score'], channelLabel, errors);
    requireKeys(channel, ['channel', 'rank'], channelLabel, errors);
    if (!enumHas(CHANNELS, channel.channel)) errors.push(`${channelLabel}.channel is invalid`);
    if (!validInteger(channel.rank, 1, HARD_LIMITS.candidates)) errors.push(`${channelLabel}.rank is outside semantic bounds`);
    if (channel.score !== undefined) validateRoundedNumber(channel.score, `${channelLabel}.score`, errors, -1, 1);
  });
  if (channels) {
    const identities = channels.map((raw) => isPlainRecord(raw) ? `${String(raw.channel)}:${String(raw.rank)}` : 'invalid');
    if (new Set(identities).size !== identities.length) errors.push(`${label}.channels has duplicates`);
    const sorted = [...channels].sort((a, b) => compareChannelState(a, b, algorithmVersion));
    if (canonicalTraceJson(channels) !== canonicalTraceJson(sorted)) errors.push(`${label}.channels is not canonical`);
    if (algorithmVersion === 'deterministic-v2') {
      if (channels.length !== 1) errors.push(`${label} must have exactly one source-final channel for deterministic-v2`);
      const sourceFinal = isPlainRecord(channels[0]) ? channels[0].channel : undefined;
      if (!isDeterministicV2OutputChannel(sourceFinal)) {
        errors.push(`${label} has an invalid deterministic-v2 source-final channel`);
      } else if (candidate.sourceType !== deterministicV2SourceBinding[sourceFinal]) {
        errors.push(`${label} sourceType disagrees with its deterministic-v2 source-final channel`);
      }
    }
  }
  validateEvidence(candidate.evidence, `${label}.evidence`, errors);
  if (!validInteger(candidate.estimatedTokens, 0, 1_000_000)) errors.push(`${label}.estimatedTokens is outside semantic bounds`);
}

function scoreBounds(name: RetrievalTraceScoreName): readonly [number, number] {
  if (name.endsWith('multiplier')) return [0, 4];
  if (name === 'input') return [-1, 1];
  if (name === 'final') return [0, 4];
  return [0, 1];
}

function validateReasons(value: unknown, label: string, errors: string[]): RetrievalTraceExclusionReason[] | undefined {
  const reasons = denseArray(value, HARD_LIMITS.exclusionReasonsPerCandidate, label, errors);
  if (!reasons) return undefined;
  if (reasons.some((reason) => !enumHas(EXCLUSION_REASONS, reason))) errors.push(`${label} has invalid reasons`);
  if (new Set(reasons).size !== reasons.length) errors.push(`${label} has duplicates`);
  const sorted = [...reasons].sort((a, b) => compareText(String(a), String(b)));
  if (canonicalTraceJson(reasons) !== canonicalTraceJson(sorted)) errors.push(`${label} is not canonical`);
  return reasons as RetrievalTraceExclusionReason[];
}

function validateMmrRecords(value: unknown, label: string, errors: string[]): void {
  const records = denseArray(value, HARD_LIMITS.mmrRecordsPerRound, label, errors);
  if (!records) return;
  if (records.length === 0) errors.push(`${label} must be non-empty`);
  records.forEach((raw, index) => {
    const recordLabel = `${label}[${index}]`;
    const record = safeRecord(raw, recordLabel, errors);
    if (!record) return;
    exactKeys(record, ['ref', 'relevance', 'maxSimilarity', 'lambda', 'objective', 'againstRef', 'pairwise'], recordLabel, errors);
    requireKeys(record, ['ref', 'relevance', 'maxSimilarity', 'lambda', 'objective', 'againstRef', 'pairwise'], recordLabel, errors);
    if (typeof record.ref !== 'string' || !/^c\d{4}$/.test(record.ref)) errors.push(`${recordLabel}.ref is invalid`);
    validateRoundedNumber(record.relevance, `${recordLabel}.relevance`, errors, 0, 1);
    validateRoundedNumber(record.maxSimilarity, `${recordLabel}.maxSimilarity`, errors, -1, 1);
    validateRoundedNumber(record.lambda, `${recordLabel}.lambda`, errors, 0, 1);
    validateRoundedNumber(record.objective, `${recordLabel}.objective`, errors, -1, 1);
    if (record.againstRef !== null && (typeof record.againstRef !== 'string' || !/^c\d{4}$/.test(record.againstRef))) {
      errors.push(`${recordLabel}.againstRef is invalid`);
    }
    const pairwise = denseArray(record.pairwise, HARD_LIMITS.mmrPairwisePerRecord, `${recordLabel}.pairwise`, errors);
    pairwise?.forEach((rawPair, pairIndex) => {
      const pairLabel = `${recordLabel}.pairwise[${pairIndex}]`;
      const pair = safeRecord(rawPair, pairLabel, errors);
      if (!pair) return;
      exactKeys(pair, ['selectedRef', 'similarity'], pairLabel, errors);
      requireKeys(pair, ['selectedRef', 'similarity'], pairLabel, errors);
      if (typeof pair.selectedRef !== 'string' || !/^c\d{4}$/.test(pair.selectedRef)) errors.push(`${pairLabel}.selectedRef is invalid`);
      validateRoundedNumber(pair.similarity, `${pairLabel}.similarity`, errors, -1, 1);
    });
    if (pairwise) {
      const pairRefs = pairwise.map((pair) => safeRecord(pair, `${recordLabel}.pairwise`, [])?.selectedRef);
      if (new Set(pairRefs).size !== pairRefs.length) errors.push(`${recordLabel}.pairwise has duplicate refs`);
      const sortedPairs = [...pairwise].sort((a, b) => compareText(String(safeRecord(a, 'pair', [])?.selectedRef), String(safeRecord(b, 'pair', [])?.selectedRef)));
      if (canonicalTraceJson(pairwise) !== canonicalTraceJson(sortedPairs)) errors.push(`${recordLabel}.pairwise is not canonical`);
    }
  });
  const refs = records.map((raw) => isPlainRecord(raw) ? raw.ref : undefined);
  if (new Set(refs).size !== refs.length) errors.push(`${label} has duplicate refs`);
  const sorted = [...records].sort((a, b) => compareText(String(isPlainRecord(a) ? a.ref : ''), String(isPlainRecord(b) ? b.ref : '')));
  if (canonicalTraceJson(records) !== canonicalTraceJson(sorted)) errors.push(`${label} is not canonical`);
}

function validateEvent(value: unknown, index: number, errors: string[]): void {
  const label = `trace.events[${index}]`;
  const event = safeRecord(value, label, errors);
  if (!event) return;
  if (!validInteger(event.sequence, 1, HARD_LIMITS.events)) errors.push(`${label}.sequence is invalid`);
  if (typeof event.kind !== 'string') { errors.push(`${label}.kind is invalid`); return; }
  const refValid = (ref: unknown) => typeof ref === 'string' && /^c\d{4}$/.test(ref);
  switch (event.kind) {
    case 'channel-attempt':
      exactKeys(event, ['sequence', 'kind', 'channel'], label, errors);
      requireKeys(event, ['sequence', 'kind', 'channel'], label, errors);
      if (!enumHas(CHANNELS, event.channel)) errors.push(`${label}.channel is invalid`);
      break;
    case 'channel-terminal': {
      const success = event.outcome === 'success';
      exactKeys(event, success ? ['sequence', 'kind', 'channel', 'outcome'] : ['sequence', 'kind', 'channel', 'outcome', 'code'], label, errors);
      requireKeys(event, success ? ['sequence', 'kind', 'channel', 'outcome'] : ['sequence', 'kind', 'channel', 'outcome', 'code'], label, errors);
      if (!enumHas(CHANNELS, event.channel)) errors.push(`${label}.channel is invalid`);
      if (event.outcome !== 'success' && event.outcome !== 'safe-failure') errors.push(`${label}.outcome is invalid`);
      if (event.outcome === 'safe-failure' && !enumHas(FAILURE_CODES, event.code)) errors.push(`${label}.code is invalid`);
      break;
    }
    case 'candidate-filter':
      exactKeys(event, ['sequence', 'kind', 'ref', 'name', 'outcome'], label, errors);
      requireKeys(event, ['sequence', 'kind', 'ref', 'name', 'outcome'], label, errors);
      if (!refValid(event.ref) || !enumHas(FILTERS, event.name) || !enumHas(FILTER_OUTCOMES, event.outcome)) errors.push(`${label} is invalid`);
      break;
    case 'candidate-score': {
      exactKeys(event, ['sequence', 'kind', 'ref', 'name', 'value'], label, errors);
      requireKeys(event, ['sequence', 'kind', 'ref', 'name', 'value'], label, errors);
      if (!refValid(event.ref) || !enumHas(SCORE_NAMES, event.name)) errors.push(`${label} is invalid`);
      else {
        const [min, max] = scoreBounds(event.name);
        validateRoundedNumber(event.value, `${label}.value`, errors, min, max);
      }
      break;
    }
    case 'mmr-round':
      exactKeys(event, ['sequence', 'kind', 'round', 'selectedRef', 'records'], label, errors);
      requireKeys(event, ['sequence', 'kind', 'round', 'selectedRef', 'records'], label, errors);
      if (!validInteger(event.round, 1, HARD_LIMITS.mmrRounds) || !refValid(event.selectedRef)) errors.push(`${label} is invalid`);
      validateMmrRecords(event.records, `${label}.records`, errors);
      break;
    case 'ranked-output':
    case 'deterministic-output':
      exactKeys(event, ['sequence', 'kind', 'ref', 'rank'], label, errors);
      requireKeys(event, ['sequence', 'kind', 'ref', 'rank'], label, errors);
      if (!refValid(event.ref) || !validInteger(event.rank, 1, HARD_LIMITS.candidates)) errors.push(`${label} is invalid`);
      break;
    case 'candidate-terminal': {
      const allowed = ['sequence', 'kind', 'ref', 'outcome', 'reasons', 'duplicateOfRef'];
      exactKeys(event, allowed, label, errors);
      requireKeys(event, ['sequence', 'kind', 'ref', 'outcome', 'reasons'], label, errors);
      if (!refValid(event.ref) || !enumHas(TERMINAL_OUTCOMES, event.outcome)) errors.push(`${label} is invalid`);
      const reasons = validateReasons(event.reasons, `${label}.reasons`, errors);
      if (event.outcome === 'included' && reasons?.length !== 0) errors.push(`${label}.reasons must be empty for included`);
      if (event.outcome !== 'included' && reasons?.length === 0) errors.push(`${label}.reasons must be non-empty for non-included`);
      if (event.duplicateOfRef !== undefined && !refValid(event.duplicateOfRef)) errors.push(`${label}.duplicateOfRef is invalid`);
      break;
    }
    case 'stage-failure':
      exactKeys(event, ['sequence', 'kind', 'stage', 'code'], label, errors);
      requireKeys(event, ['sequence', 'kind', 'stage', 'code'], label, errors);
      if (!enumHas(FAILURE_STAGES, event.stage) || !enumHas(FAILURE_CODES, event.code)) errors.push(`${label} is invalid`);
      break;
    default:
      errors.push(`${label}.kind is invalid`);
  }
}

function validateTerminalExclusion(value: unknown, index: number, errors: string[]): void {
  const label = `trace.terminalExclusions[${index}]`;
  const exclusion = safeRecord(value, label, errors);
  if (!exclusion) return;
  exactKeys(exclusion, ['ref', 'outcome', 'reasons', 'duplicateOfRef'], label, errors);
  requireKeys(exclusion, ['ref', 'outcome', 'reasons'], label, errors);
  if (typeof exclusion.ref !== 'string' || !/^c\d{4}$/.test(exclusion.ref)) errors.push(`${label}.ref is invalid`);
  if (exclusion.outcome !== 'excluded' && exclusion.outcome !== 'failed') errors.push(`${label}.outcome is invalid`);
  validateReasons(exclusion.reasons, `${label}.reasons`, errors);
  if (exclusion.duplicateOfRef !== undefined && (typeof exclusion.duplicateOfRef !== 'string' || !/^c\d{4}$/.test(exclusion.duplicateOfRef))) {
    errors.push(`${label}.duplicateOfRef is invalid`);
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
  return `sha256:${createHash('sha256').update(canonicalTraceJson(replayState(value))).digest('hex')}`;
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
  if (trace.schemaVersion !== RETRIEVAL_TRACE_VERSION) errors.push('trace.schemaVersion is unsupported');
  const algorithmVersion = enumHas(ALGORITHMS, trace.algorithmVersion)
    ? trace.algorithmVersion
    : 'ranked-v1';
  if (!enumHas(ALGORITHMS, trace.algorithmVersion)) errors.push('trace.algorithmVersion is unsupported');
  validateRequestShape(trace.requestShape, errors, algorithmVersion);
  if (typeof trace.complete !== 'boolean') errors.push('trace.complete must be boolean');
  const incomplete = denseArray(trace.incompleteReasons, INCOMPLETE_REASONS.length, 'trace.incompleteReasons', errors);
  if (incomplete) {
    if (incomplete.some((reason) => !enumHas(INCOMPLETE_REASONS, reason))) errors.push('trace.incompleteReasons has invalid reasons');
    if (new Set(incomplete).size !== incomplete.length) errors.push('trace.incompleteReasons has duplicates');
    const sorted = [...incomplete].sort(compareText as (a: unknown, b: unknown) => number);
    if (canonicalTraceJson(incomplete) !== canonicalTraceJson(sorted)) errors.push('trace.incompleteReasons is not canonical');
    if ((trace.complete === true) !== (incomplete.length === 0)) errors.push('trace.complete disagrees with incompleteReasons');
  }
  const candidates = denseArray(trace.candidates, HARD_LIMITS.candidates, 'trace.candidates', errors);
  candidates?.forEach((candidate, index) => validateCandidate(candidate, index, errors, algorithmVersion));
  if (candidates) {
    candidates.forEach((candidate, index) => {
      if (isPlainRecord(candidate) && candidate.ref !== `c${String(index + 1).padStart(4, '0')}`) errors.push('trace.candidates refs are not contiguous');
    });
  }
  const events = denseArray(trace.events, HARD_LIMITS.events, 'trace.events', errors);
  events?.forEach((event, index) => {
    validateEvent(event, index, errors);
    if (isPlainRecord(event) && event.sequence !== index + 1) errors.push('trace.events sequence is not contiguous');
  });
  if (events) {
    let mmrRecordsTotal = 0;
    let mmrPairwiseTotal = 0;
    for (const rawEvent of events) {
      if (!isPlainRecord(rawEvent) || rawEvent.kind !== 'mmr-round' || !Array.isArray(rawEvent.records)) continue;
      mmrRecordsTotal += rawEvent.records.length;
      for (const rawRecord of rawEvent.records) {
        if (isPlainRecord(rawRecord) && Array.isArray(rawRecord.pairwise)) mmrPairwiseTotal += rawRecord.pairwise.length;
      }
    }
    if (mmrRecordsTotal > HARD_LIMITS.mmrRecordsTotal) errors.push('trace MMR observations exceed hard limit');
    if (mmrPairwiseTotal > HARD_LIMITS.mmrPairwiseTotal) errors.push('trace MMR pairwise observations exceed hard limit');
  }
  const resultOrder = denseArray(trace.resultOrder, HARD_LIMITS.candidates, 'trace.resultOrder', errors);
  if (resultOrder) {
    if (resultOrder.some((ref) => typeof ref !== 'string' || !/^c\d{4}$/.test(ref))) errors.push('trace.resultOrder has invalid refs');
    if (new Set(resultOrder).size !== resultOrder.length) errors.push('trace.resultOrder has duplicates');
  }
  const exclusions = denseArray(trace.terminalExclusions, HARD_LIMITS.candidates, 'trace.terminalExclusions', errors);
  exclusions?.forEach((exclusion, index) => validateTerminalExclusion(exclusion, index, errors));
  if (typeof trace.replayStateDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(trace.replayStateDigest)) {
    errors.push('trace.replayStateDigest is invalid');
  } else if (errors.length === 0) {
    try {
      const expected = computeRetrievalTraceReplayStateDigest(trace as unknown as RetrievalTraceV1);
      if (trace.replayStateDigest !== expected) errors.push('trace.replayStateDigest does not match safe replay state');
    } catch {
      errors.push('trace.replayStateDigest could not be reproduced');
    }
  }
  return [...new Set(errors)];
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
  return trace.events.filter((event): event is Extract<RetrievalTraceStageEventV1, { kind: 'candidate-terminal' }> => event.kind === 'candidate-terminal');
}

function outputEvents(trace: RetrievalTraceV1): Array<Extract<RetrievalTraceStageEventV1, { kind: 'ranked-output' | 'deterministic-output' }>> {
  return trace.events.filter((event): event is Extract<RetrievalTraceStageEventV1, { kind: 'ranked-output' | 'deterministic-output' }> =>
    event.kind === 'ranked-output' || event.kind === 'deterministic-output');
}

function reconstructFromEvents(trace: RetrievalTraceV1): RetrievalTraceReplayResult {
  const expectedKind = trace.algorithmVersion === 'ranked-v1' ? 'ranked-output' : 'deterministic-output';
  const outputs = outputEvents(trace).filter((event) => event.kind === expectedKind).sort((a, b) => a.rank - b.rank);
  const terminals = terminalEvents(trace);
  // V2 output ranks are derived from canonical source-final candidate order and
  // terminal inclusion. Output events and top-level arrays are checked echoes,
  // never the authority used to replay the deterministic algorithm.
  const resultOrder = trace.algorithmVersion === 'deterministic-v2'
    ? trace.candidates
      .filter((candidate) => terminals.some((event) => event.ref === candidate.ref && event.outcome === 'included'))
      .map((candidate) => candidate.ref)
    : outputs.map((event) => event.ref);
  const exclusions = terminalEvents(trace)
    .filter((event): event is typeof event & { outcome: 'excluded' | 'failed' } => event.outcome !== 'included')
    .sort((a, b) => compareText(a.ref, b.ref))
    .map((event) => ({
      ref: event.ref,
      outcome: event.outcome,
      reasons: [...event.reasons],
      ...(event.duplicateOfRef === undefined ? {} : { duplicateOfRef: event.duplicateOfRef }),
    }));
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
    'ranked-output': 5,
    'deterministic-output': 5,
    'candidate-terminal': 6,
    'stage-failure': 7,
  };
  const eventOrderKey = (event: RetrievalTraceStageEventV1): string => {
    const order = orderForAlgorithm(trace.algorithmVersion);
    switch (event.kind) {
      case 'channel-attempt':
      case 'channel-terminal': return String(order.get(event.channel) ?? 99).padStart(2, '0');
      case 'candidate-filter': return `${event.ref}:${event.name}`;
      case 'candidate-score': return `${event.ref}:${event.name}`;
      case 'mmr-round': return String(event.round).padStart(4, '0');
      case 'ranked-output':
      case 'deterministic-output': return String(event.rank).padStart(4, '0');
      case 'candidate-terminal': return event.ref;
      case 'stage-failure': return `${event.stage}:${event.code}`;
    }
  };
  for (let index = 1; index < trace.events.length; index++) {
    const previous = trace.events[index - 1]!;
    const current = trace.events[index]!;
    const order = eventPriority[previous.kind] - eventPriority[current.kind]
      || compareText(eventOrderKey(previous), eventOrderKey(current));
    if (order > 0) { errors.push('stage events are not in canonical replay order'); break; }
  }
  const refs = new Set(trace.candidates.map((candidate) => candidate.ref));
  const planned = new Set(trace.requestShape.plannedChannels);
  const attempts = trace.events.filter((event) => event.kind === 'channel-attempt');
  const channelTerminals = trace.events.filter((event) => event.kind === 'channel-terminal');
  for (const channel of planned) {
    if (attempts.filter((event) => event.channel === channel).length !== 1
      || channelTerminals.filter((event) => event.channel === channel).length !== 1) {
      errors.push('channel accounting has gaps or duplicates');
    }
  }
  if (attempts.some((event) => !planned.has(event.channel)) || channelTerminals.some((event) => !planned.has(event.channel))) {
    errors.push('channel accounting contains unplanned channels');
  }
  const successful = new Set(channelTerminals.filter((event) => event.outcome === 'success').map((event) => event.channel));
  for (const candidate of trace.candidates) {
    if (candidate.channels.some((channel) => !planned.has(channel.channel) || !successful.has(channel.channel))) {
      errors.push('candidate source channel was not successfully settled');
    }
  }

  const terminals = terminalEvents(trace);
  const outputs = outputEvents(trace);
  const expectedOutputKind = trace.algorithmVersion === 'ranked-v1' ? 'ranked-output' : 'deterministic-output';
  if (outputs.some((event) => event.kind !== expectedOutputKind)) errors.push('output event does not match trace algorithm');
  for (const ref of refs) {
    const terminal = terminals.filter((event) => event.ref === ref);
    const output = outputs.filter((event) => event.ref === ref);
    if (terminal.length !== 1) errors.push('candidate does not have exactly one terminal event');
    if (terminal[0]?.outcome === 'included' ? output.length !== 1 : output.length !== 0) {
      errors.push('candidate output settlement disagrees with terminal event');
    }
  }
  if (terminals.some((event) => !refs.has(event.ref)) || outputs.some((event) => !refs.has(event.ref))) errors.push('events reference unknown candidates');
  const ranks = outputs.map((event) => event.rank).sort((a, b) => a - b);
  if (!ranks.every((rank, index) => rank === index + 1)) errors.push('output ranks are not contiguous');

  for (const terminal of terminals) {
    const duplicate = terminal.reasons.includes('duplicate');
    if (duplicate !== (terminal.duplicateOfRef !== undefined)) errors.push('duplicate exclusion relation is incomplete');
    if (terminal.duplicateOfRef !== undefined) {
      const target = terminals.find((event) => event.ref === terminal.duplicateOfRef);
      if (terminal.outcome !== 'excluded' || terminal.duplicateOfRef === terminal.ref || target?.outcome !== 'included') {
        errors.push('duplicateOfRef must reference a distinct included candidate');
      }
    }
    if (terminal.outcome === 'failed' && !terminal.reasons.includes('source-failed')) errors.push('failed terminal is missing source-failed');
  }

  const filterEvents = trace.events.filter((event) => event.kind === 'candidate-filter');
  const scoreEvents = trace.events.filter((event) => event.kind === 'candidate-score');
  for (const event of [...filterEvents, ...scoreEvents]) if (!refs.has(event.ref)) errors.push('candidate event references an unknown ref');
  const eventIdentities = [...filterEvents.map((event) => `filter:${event.ref}:${event.name}`), ...scoreEvents.map((event) => `score:${event.ref}:${event.name}`)];
  if (new Set(eventIdentities).size !== eventIdentities.length) errors.push('candidate has duplicate filter or score events');
  for (const terminal of terminals) {
    const filters = filterEvents.filter((event) => event.ref === terminal.ref);
    const failed = filters.filter((event) => event.outcome === 'fail');
    if (terminal.outcome === 'included' && failed.length > 0) errors.push('included candidate has failed filters');
    for (const filter of failed) {
      if (!terminal.reasons.includes(FILTER_EXCLUSION_REASON[filter.name])) errors.push('failed filter is missing its exclusion reason');
    }
    for (const [name, reason] of Object.entries(FILTER_EXCLUSION_REASON) as Array<[RetrievalTraceFilterName, RetrievalTraceExclusionReason]>) {
      if (terminal.reasons.includes(reason)
        && !filters.some((filter) => filter.name === name && filter.outcome === 'fail')) {
        errors.push('filter-derived exclusion reason has no matching failed filter');
      }
    }
  }

  const mmrRounds = trace.events.filter((event) => event.kind === 'mmr-round').sort((a, b) => a.round - b.round);
  if (trace.requestShape.diversification === 'none' && mmrRounds.length > 0) errors.push('MMR events exist when diversification is disabled');
  if (trace.requestShape.diversification === 'none'
    && filterEvents.some((event) => event.name === 'mmr' && event.outcome !== 'not-applicable')) {
    errors.push('MMR filter cannot pass or fail when diversification is disabled');
  }
  if (trace.requestShape.diversification === 'mmr') {
    const mmrFilters = filterEvents.filter((event) => event.name === 'mmr' && event.outcome !== 'not-applicable');
    let eligible = mmrFilters.map((event) => event.ref).sort(compareText);
    if (eligible.length > HARD_LIMITS.mmrRecordsPerRound) errors.push('MMR eligible set exceeds practical bound');
    const selected: string[] = [];
    let fixedLambda: number | undefined;
    let pairwiseTotal = 0;
    for (let index = 0; index < mmrRounds.length; index++) {
      const round = mmrRounds[index]!;
      if (round.round !== index + 1) errors.push('MMR rounds are not contiguous');
      const recordRefs = round.records.map((record) => record.ref).sort(compareText);
      if (canonicalTraceJson(recordRefs) !== canonicalTraceJson(eligible)) errors.push('MMR eligible set is incomplete');
      if (!recordRefs.includes(round.selectedRef)) errors.push('MMR selected ref is not eligible');
      for (const record of round.records) {
        pairwiseTotal += record.pairwise.length;
        const pairRefs = record.pairwise.map((pair) => pair.selectedRef).sort(compareText);
        const selectedRefs = [...selected].sort(compareText);
        if (canonicalTraceJson(pairRefs) !== canonicalTraceJson(selectedRefs)) errors.push('MMR pairwise coverage is incomplete');
        const maximum = [...record.pairwise]
          .sort((a, b) => b.similarity - a.similarity || compareText(a.selectedRef, b.selectedRef))[0];
        const derivedMaximum = maximum?.similarity ?? 0;
        const derivedAgainst = maximum?.selectedRef ?? null;
        if (record.maxSimilarity !== derivedMaximum || record.againstRef !== derivedAgainst) {
          errors.push('MMR maxSimilarity and againstRef do not match pairwise replay');
        }
        const expected = roundTraceNumber(record.lambda * record.relevance - (1 - record.lambda) * derivedMaximum);
        if (record.objective !== expected) errors.push('MMR objective does not match replay formula');
        if (fixedLambda === undefined) fixedLambda = record.lambda;
        else if (record.lambda !== fixedLambda) errors.push('MMR lambda changed between records');
      }
      const winner = [...round.records].sort((a, b) => b.objective - a.objective || compareText(a.ref, b.ref))[0]?.ref;
      if (winner !== round.selectedRef) errors.push('MMR selected ref is not the objective winner');
      selected.push(round.selectedRef);
      eligible = eligible.filter((ref) => ref !== round.selectedRef);
    }
    if (pairwiseTotal > HARD_LIMITS.mmrPairwiseTotal) errors.push('MMR pairwise observations exceed hard limit');
    const passed = mmrFilters.filter((event) => event.outcome === 'pass').map((event) => event.ref).sort(compareText);
    const selectedSorted = [...selected].sort(compareText);
    if (canonicalTraceJson(passed) !== canonicalTraceJson(selectedSorted)) errors.push('MMR pass filters do not match selected candidates');
    const included = new Set(terminals.filter((event) => event.outcome === 'included').map((event) => event.ref));
    const expectedOrder = selected.filter((ref) => included.has(ref));
    const actualOrder = outputs.sort((a, b) => a.rank - b.rank).map((event) => event.ref);
    if (canonicalTraceJson(expectedOrder) !== canonicalTraceJson(actualOrder)) errors.push('ranked MMR output is not replayable from rounds');
    if ([...included].some((ref) => !selected.includes(ref))) errors.push('included MMR candidate was never selected');
  } else if (trace.algorithmVersion === 'ranked-v1') {
    const finals = new Map(scoreEvents.filter((event) => event.name === 'final').map((event) => [event.ref, event.value]));
    const includedRefs = terminals.filter((event) => event.outcome === 'included').map((event) => event.ref);
    if (includedRefs.some((ref) => !finals.has(ref))) errors.push('ranked included candidate is missing final score');
    const expected = includedRefs.sort((a, b) => (finals.get(b)! - finals.get(a)!) || compareText(a, b));
    const actual = outputs.sort((a, b) => a.rank - b.rank).map((event) => event.ref);
    if (canonicalTraceJson(expected) !== canonicalTraceJson(actual)) errors.push('ranked output order does not match final scores');
  }
  if (trace.algorithmVersion === 'deterministic-v1') {
    if (trace.requestShape.diversification !== 'none') errors.push('deterministic algorithm cannot use MMR');
    const included = new Set(terminals.filter((event) => event.outcome === 'included').map((event) => event.ref));
    const expected = trace.candidates.map((candidate) => candidate.ref).filter((ref) => included.has(ref));
    const actual = outputs.sort((a, b) => a.rank - b.rank).map((event) => event.ref);
    if (canonicalTraceJson(expected) !== canonicalTraceJson(actual)) errors.push('deterministic output order does not match settled candidate order');
  }
  if (trace.algorithmVersion === 'deterministic-v2') {
    if (trace.requestShape.diversification !== 'none') errors.push('deterministic-v2 algorithm cannot use MMR');
    const actualCandidateOrder = trace.candidates.map((candidate) => candidate.ref);
    const canonicalCandidates = [...trace.candidates]
      .sort((a, b) => compareChannelState(a.channels[0], b.channels[0], 'deterministic-v2'))
      .map((candidate) => candidate.ref);
    if (canonicalTraceJson(actualCandidateOrder) !== canonicalTraceJson(canonicalCandidates)) {
      errors.push('deterministic-v2 candidates are not in canonical source-final order');
    }
    for (const channel of RETRIEVAL_TRACE_DETERMINISTIC_OUTPUT_CHANNEL_ORDER_V2) {
      const localRanks = trace.candidates
        .filter((candidate) => candidate.channels[0]?.channel === channel)
        .map((candidate) => candidate.channels[0]!.rank)
        .sort((a, b) => a - b);
      if (!localRanks.every((rank, index) => rank === index + 1)) {
        errors.push('deterministic-v2 source-final ranks are not contiguous');
      }
    }
    const included = new Set(terminals.filter((event) => event.outcome === 'included').map((event) => event.ref));
    const derived = trace.candidates.map((candidate) => candidate.ref).filter((ref) => included.has(ref));
    const actual = outputs.sort((a, b) => a.rank - b.rank).map((event) => event.ref);
    if (canonicalTraceJson(derived) !== canonicalTraceJson(actual)) {
      errors.push('deterministic-v2 output events do not match derived deterministic output');
    }
  }

  const reconstructed = reconstructFromEvents(trace);
  if (canonicalTraceJson(trace.resultOrder) !== canonicalTraceJson(reconstructed.resultOrder)) errors.push('trace.resultOrder does not match replayed events');
  if (canonicalTraceJson(trace.terminalExclusions) !== canonicalTraceJson(reconstructed.terminalExclusions)) {
    errors.push('trace.terminalExclusions does not match replayed events');
  }
  return [...new Set(errors)];
}

function assertValidTrace(value: unknown): asserts value is RetrievalTraceV1 {
  const errors = validateRetrievalTrace(value);
  if (errors.length > 0) throw new RetrievalTraceValidationError(errors.join('; '));
}

function containsRecognizedSecret(value: unknown): boolean {
  if (typeof value === 'string') return redactSecrets(value) !== value;
  if (Array.isArray(value)) return value.some(containsRecognizedSecret);
  return isPlainRecord(value) ? Object.values(value).some(containsRecognizedSecret) : false;
}

export function assertRetrievalTraceSecretSafe(value: unknown): asserts value is RetrievalTraceV1 {
  assertValidTrace(value);
  if (containsRecognizedSecret(value)) throw new RetrievalTraceValidationError('trace contains a recognized secret shape');
}

export function assertRetrievalTraceConformant(value: unknown): asserts value is RetrievalTraceV1 {
  assertRetrievalTraceSecretSafe(value);
  if (!value.complete) throw new RetrievalTraceValidationError('trace is incomplete');
  const errors = conformanceErrors(value);
  if (errors.length > 0) throw new RetrievalTraceValidationError(errors.join('; '));
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
  if (rawErrors.length > 0) throw new RetrievalTraceValidationError(rawErrors.join('; '));
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
    plannedChannels: [...input.plannedChannels].sort((a, b) => {
      const order = orderForAlgorithm(algorithmVersion);
      return (order.get(a) ?? 99) - (order.get(b) ?? 99);
    }),
  };
  const errors: string[] = [];
  validateRequestShape(normalized, errors, algorithmVersion);
  if (errors.length > 0) throw new RetrievalTraceValidationError(errors.join('; '));
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
  return (order.get(left.channel as RetrievalTraceChannel) ?? 99) - (order.get(right.channel as RetrievalTraceChannel) ?? 99)
    || Number(left.rank ?? 0) - Number(right.rank ?? 0)
    || Number(left.score ?? 0) - Number(right.score ?? 0);
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
  if (rawErrors.length > 0) throw new RetrievalTraceValidationError(rawErrors.join('; '));
  validateCandidate({
    ref: 'c0001', sourceType: input.sourceType, channels: input.channels,
    evidence: input.evidence, estimatedTokens: input.estimatedTokens,
  }, 0, rawErrors, algorithmVersion);
  if (rawErrors.length > 0) throw new RetrievalTraceValidationError(rawErrors.join('; '));
  const normalized: RetrievalTraceCandidateDraft = {
    sourceType: input.sourceType,
    channels: input.channels.map((channel) => ({
      channel: channel.channel,
      rank: channel.rank,
      ...(channel.score === undefined ? {} : { score: roundTraceNumber(channel.score) }),
    })).sort((a, b) => compareChannelState(a, b, algorithmVersion)),
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
  if (errors.length > 0) throw new RetrievalTraceValidationError(errors.join('; '));
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
    || (sourceOrder.get(a.draft.sourceType) ?? 99) - (sourceOrder.get(b.draft.sourceType) ?? 99)
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
  private readonly handles = new WeakMap<object, CandidateEntry>();
  private readonly attempts = new Set<RetrievalTraceChannel>();
  private readonly settlements = new Map<RetrievalTraceChannel, RetrievalTraceChannelSettlement>();
  private readonly mmrRounds: MmrRoundEntry[] = [];
  private readonly stageFailures: Array<{ stage: RetrievalTraceFailureStage; code: RetrievalTraceFailureCode }> = [];
  private readonly incomplete = new Set<RetrievalTraceIncompleteReason>();
  private readonly limits: Required<RetrievalTraceCollectorOptions>;
  private finalized = false;
  private mmrPairwiseTotal = 0;
  private mmrRecordsTotal = 0;

  constructor(
    private readonly algorithmVersion: RetrievalTraceAlgorithmVersion,
    requestShape: RetrievalTraceRequestShapeV1,
    options: RetrievalTraceCollectorOptions = {},
  ) {
    if (!enumHas(ALGORITHMS, algorithmVersion)) throw new RetrievalTraceValidationError('algorithmVersion is unsupported');
    this.requestShape = normalizeRequestShape(requestShape, algorithmVersion);
    this.limits = {
      maxCandidates: boundedOption(options.maxCandidates, DEFAULT_LIMITS.maxCandidates, HARD_LIMITS.candidates, 'maxCandidates'),
      maxEvents: boundedOption(options.maxEvents, DEFAULT_LIMITS.maxEvents, HARD_LIMITS.events, 'maxEvents'),
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
    const fingerprint = createHash('sha256').update(canonicalTraceJson(draft)).digest('hex');
    if (this.entries.some((entry) => entry.fingerprint === fingerprint)) {
      this.incomplete.add('candidate-identity-collision');
      throw new RetrievalTraceValidationError('candidate identity is ambiguous');
    }
    const handle = Object.freeze({}) as RetrievalTraceCandidateHandle;
    const entry: CandidateEntry = { handle, draft, fingerprint, filters: new Map(), scores: new Map() };
    this.entries.push(entry);
    this.handles.set(handle, entry);
    return handle;
  }

  attemptChannel(channel: RetrievalTraceChannel): void {
    this.assertOpen();
    this.assertPlannedChannel(channel);
    this.reserveEvent();
    if (this.attempts.has(channel)) {
      this.incomplete.add('channel-accounting-conflict');
      throw new RetrievalTraceValidationError('channel was attempted more than once');
    }
    this.attempts.add(channel);
  }

  settleChannel(channel: RetrievalTraceChannel, settlement: RetrievalTraceChannelSettlement): void {
    this.assertOpen();
    this.assertPlannedChannel(channel);
    this.reserveEvent();
    if (!this.attempts.has(channel) || this.settlements.has(channel)) {
      this.incomplete.add('channel-accounting-conflict');
      throw new RetrievalTraceValidationError('channel settlement conflicts with its attempt');
    }
    const settlementErrors: string[] = [];
    const settlementRecord = safeRecord(settlement, 'channel settlement', settlementErrors);
    if (settlementRecord) {
      const fields = settlementRecord.outcome === 'success' ? ['outcome'] : ['outcome', 'code'];
      exactKeys(settlementRecord, fields, 'channel settlement', settlementErrors);
      requireKeys(settlementRecord, fields, 'channel settlement', settlementErrors);
    }
    if (settlementErrors.length > 0) throw new RetrievalTraceValidationError(settlementErrors.join('; '));
    if (settlement.outcome !== 'success' && settlement.outcome !== 'safe-failure') {
      throw new RetrievalTraceValidationError('channel settlement outcome is invalid');
    }
    if (settlement.outcome === 'safe-failure' && !enumHas(FAILURE_CODES, settlement.code)) {
      throw new RetrievalTraceValidationError('channel failure code is invalid');
    }
    this.settlements.set(channel, Object.freeze({ ...settlement }));
  }

  recordFilter(handle: RetrievalTraceCandidateHandle, input: RetrievalTraceFilterEventInput): void {
    this.assertOpen();
    const entry = this.resolve(handle);
    this.reserveEvent();
    const inputErrors: string[] = [];
    if (!isPlainRecord(input)) inputErrors.push('filter event must be an object');
    else {
      exactKeys(input, ['name', 'outcome'], 'filter event', inputErrors);
      requireKeys(input, ['name', 'outcome'], 'filter event', inputErrors);
    }
    if (inputErrors.length > 0 || !enumHas(FILTERS, input.name) || !enumHas(FILTER_OUTCOMES, input.outcome)) {
      throw new RetrievalTraceValidationError(inputErrors.join('; ') || 'filter event is invalid');
    }
    if (entry.filters.size >= this.limits.maxFiltersPerCandidate) this.limitExceeded('candidate filter limit exceeded');
    if (entry.filters.has(input.name)) {
      this.incomplete.add('candidate-event-conflict');
      throw new RetrievalTraceValidationError('candidate filter was recorded more than once');
    }
    entry.filters.set(input.name, Object.freeze({ ...input }));
  }

  recordScore(handle: RetrievalTraceCandidateHandle, input: RetrievalTraceScoreEventInput): void {
    this.assertOpen();
    const entry = this.resolve(handle);
    this.reserveEvent();
    const inputErrors: string[] = [];
    if (!isPlainRecord(input)) inputErrors.push('score event must be an object');
    else {
      exactKeys(input, ['name', 'value'], 'score event', inputErrors);
      requireKeys(input, ['name', 'value'], 'score event', inputErrors);
    }
    if (inputErrors.length > 0 || !enumHas(SCORE_NAMES, input.name)) {
      throw new RetrievalTraceValidationError(inputErrors.join('; ') || 'score event is invalid');
    }
    if (entry.scores.size >= this.limits.maxScoresPerCandidate) this.limitExceeded('candidate score limit exceeded');
    if (entry.scores.has(input.name)) {
      this.incomplete.add('candidate-event-conflict');
      throw new RetrievalTraceValidationError('candidate score was recorded more than once');
    }
    const value = roundTraceNumber(input.value);
    const [min, max] = scoreBounds(input.name);
    if (value < min || value > max) throw new RetrievalTraceValidationError('score is outside semantic bounds');
    entry.scores.set(input.name, Object.freeze({ name: input.name, value }));
  }

  recordOutput(handle: RetrievalTraceCandidateHandle, rank: number): void {
    this.assertOpen();
    const entry = this.resolve(handle);
    if (this.algorithmVersion === 'deterministic-v2') {
      throw new RetrievalTraceValidationError('deterministic-v2 output rank is derived by the collector');
    }
    this.reserveEvent();
    if (!validInteger(rank, 1, this.limits.maxCandidates) || entry.outputRank !== undefined) {
      this.incomplete.add('candidate-output-gap');
      throw new RetrievalTraceValidationError('candidate output rank is invalid or duplicated');
    }
    entry.outputRank = rank;
  }

  recordTerminal(handle: RetrievalTraceCandidateHandle, terminal: RetrievalTraceTerminalInput): void {
    this.assertOpen();
    const entry = this.resolve(handle);
    this.reserveEvent();
    if (entry.terminal !== undefined) {
      this.incomplete.add('candidate-terminal-conflict');
      throw new RetrievalTraceValidationError('candidate terminal was recorded more than once');
    }
    const inputErrors: string[] = [];
    if (!isPlainRecord(terminal)) inputErrors.push('terminal event must be an object');
    else {
      exactKeys(terminal, ['outcome', 'reasons', 'duplicateOf'], 'terminal event', inputErrors);
      requireKeys(terminal, ['outcome', 'reasons'], 'terminal event', inputErrors);
    }
    if (inputErrors.length > 0) throw new RetrievalTraceValidationError(inputErrors.join('; '));
    if (!enumHas(TERMINAL_OUTCOMES, terminal.outcome)) throw new RetrievalTraceValidationError('terminal outcome is invalid');
    if (terminal.reasons.length > this.limits.maxExclusionReasonsPerCandidate) this.limitExceeded('terminal reason limit exceeded');
    const reasons = [...terminal.reasons];
    if (reasons.some((reason) => !enumHas(EXCLUSION_REASONS, reason)) || new Set(reasons).size !== reasons.length) {
      throw new RetrievalTraceValidationError('terminal reasons are invalid');
    }
    reasons.sort(compareText);
    if (terminal.outcome === 'included' ? reasons.length !== 0 : reasons.length === 0) throw new RetrievalTraceValidationError('terminal reasons disagree with outcome');
    const duplicateOf = 'duplicateOf' in terminal && terminal.duplicateOf !== undefined ? this.resolve(terminal.duplicateOf) : undefined;
    if (reasons.includes('duplicate') !== (duplicateOf !== undefined)) throw new RetrievalTraceValidationError('duplicate terminal requires a duplicate relation');
    if (terminal.outcome === 'failed' && !reasons.includes('source-failed')) throw new RetrievalTraceValidationError('failed terminal requires source-failed');
    entry.terminal = Object.freeze({ outcome: terminal.outcome, reasons, ...(duplicateOf ? { duplicateOf: duplicateOf.handle } : {}) }) as RetrievalTraceTerminalInput;
  }

  recordMmrRound(round: number, selected: RetrievalTraceCandidateHandle, inputs: readonly RetrievalTraceMmrRecordInput[]): void {
    this.assertOpen();
    if (this.algorithmVersion === 'deterministic-v2') {
      throw new RetrievalTraceValidationError('deterministic-v2 does not support MMR');
    }
    this.reserveEvent();
    const arrayErrors: string[] = [];
    const denseInputs = denseArray(inputs, this.limits.maxMmrRecordsPerRound, 'MMR records', arrayErrors);
    if (arrayErrors.length > 0 || !denseInputs) throw new RetrievalTraceValidationError(arrayErrors.join('; '));
    if (this.mmrRounds.length >= this.limits.maxMmrRounds || inputs.length > this.limits.maxMmrRecordsPerRound) {
      this.limitExceeded('MMR limit exceeded');
    }
    if (this.mmrRecordsTotal + inputs.length > this.limits.maxMmrRecordsTotal) this.limitExceeded('MMR record total limit exceeded');
    if (!validInteger(round, 1, this.limits.maxMmrRounds) || this.mmrRounds.some((entry) => entry.round === round)) {
      this.incomplete.add('mmr-gap');
      throw new RetrievalTraceValidationError('MMR round is invalid or duplicated');
    }
    const selectedEntry = this.resolve(selected);
    let addedPairwise = 0;
    const records = inputs.map((input) => {
      const recordErrors: string[] = [];
      const record = safeRecord(input, 'MMR record', recordErrors);
      if (record) {
        exactKeys(record, ['candidate', 'relevance', 'lambda', 'pairwise'], 'MMR record', recordErrors);
        requireKeys(record, ['candidate', 'relevance', 'lambda', 'pairwise'], 'MMR record', recordErrors);
      }
      if (recordErrors.length > 0) throw new RetrievalTraceValidationError(recordErrors.join('; '));
      const pairErrors: string[] = [];
      const pairs = denseArray(input.pairwise, this.limits.maxMmrPairwisePerRecord, 'MMR pairwise', pairErrors);
      if (!pairs || pairErrors.length > 0) throw new RetrievalTraceValidationError(pairErrors.join('; '));
      if (this.mmrPairwiseTotal + addedPairwise + pairs.length > this.limits.maxMmrPairwiseTotal) this.limitExceeded('MMR pairwise total limit exceeded');
      addedPairwise += pairs.length;
      return {
        candidate: this.resolve(input.candidate),
        relevance: this.mmrNumber(input.relevance, 0, 1),
        lambda: this.mmrNumber(input.lambda, 0, 1),
        pairwise: input.pairwise.map((pair) => {
          const pairRecordErrors: string[] = [];
          const pairRecord = safeRecord(pair, 'MMR pairwise record', pairRecordErrors);
          if (pairRecord) {
            exactKeys(pairRecord, ['selected', 'similarity'], 'MMR pairwise record', pairRecordErrors);
            requireKeys(pairRecord, ['selected', 'similarity'], 'MMR pairwise record', pairRecordErrors);
          }
          if (pairRecordErrors.length > 0) throw new RetrievalTraceValidationError(pairRecordErrors.join('; '));
          return { selected: this.resolve(pair.selected), similarity: this.mmrNumber(pair.similarity, -1, 1) };
        }),
      };
    });
    if (new Set(records.map((record) => record.candidate)).size !== records.length) throw new RetrievalTraceValidationError('MMR round has duplicate candidates');
    for (const record of records) {
      if (new Set(record.pairwise.map((pair) => pair.selected)).size !== record.pairwise.length) {
        throw new RetrievalTraceValidationError('MMR pairwise record has duplicate selected candidates');
      }
    }
    this.mmrPairwiseTotal += addedPairwise;
    this.mmrRecordsTotal += records.length;
    this.mmrRounds.push({ round, selected: selectedEntry, records });
  }

  recordStageFailure(stage: RetrievalTraceFailureStage, code: RetrievalTraceFailureCode): void {
    this.assertOpen();
    this.reserveEvent();
    if (this.stageFailures.length >= this.limits.maxStageFailures) this.limitExceeded('stage failure limit exceeded');
    if (!enumHas(FAILURE_STAGES, stage) || !enumHas(FAILURE_CODES, code)) throw new RetrievalTraceValidationError('stage failure is invalid');
    this.stageFailures.push({ stage, code });
  }

  /** @internal Runtime adapters may fail closed when safe evidence cannot be
   * represented as events without inventing provenance. */
  markIncomplete(reason: RetrievalTraceIncompleteReason): void {
    this.assertOpen();
    if (!enumHas(INCOMPLETE_REASONS, reason)) {
      throw new RetrievalTraceValidationError('incomplete reason is unsupported');
    }
    this.incomplete.add(reason);
  }

  finalize(): RetrievalTraceV1 {
    this.assertOpen();
    this.finalized = true;
    for (const channel of this.requestShape.plannedChannels) {
      if (!this.attempts.has(channel) || !this.settlements.has(channel)) this.incomplete.add('channel-gap');
    }
    const sortedEntries = [...this.entries].sort((a, b) => compareCandidateEntries(a, b, this.algorithmVersion));
    if (this.algorithmVersion === 'deterministic-v2') {
      let outputRank = 0;
      for (const entry of sortedEntries) {
        if (entry.terminal?.outcome === 'included') entry.outputRank = ++outputRank;
      }
    }
    const usedChannelRanks = new Set<string>();
    for (const entry of sortedEntries) {
      for (const channel of entry.draft.channels) {
        const identity = `${channel.channel}:${channel.rank}`;
        if (usedChannelRanks.has(identity)) this.incomplete.add('candidate-identity-collision');
        usedChannelRanks.add(identity);
      }
      if (!entry.terminal) this.incomplete.add('candidate-terminal-gap');
      if (entry.terminal?.outcome === 'included' ? entry.outputRank === undefined : entry.outputRank !== undefined) {
        this.incomplete.add('candidate-output-gap');
      }
      if (entry.draft.channels.some((channel) => this.settlements.get(channel.channel)?.outcome !== 'success')) this.incomplete.add('channel-gap');
    }
    const ranks = sortedEntries.map((entry) => entry.outputRank).filter((rank): rank is number => rank !== undefined).sort((a, b) => a - b);
    if (!ranks.every((rank, index) => rank === index + 1) || new Set(ranks).size !== ranks.length) this.incomplete.add('candidate-output-gap');

    const refs = new Map(sortedEntries.map((entry, index) => [entry, `c${String(index + 1).padStart(4, '0')}`]));
    const candidates: RetrievalTraceCandidateV1[] = sortedEntries.map((entry) => ({ ref: refs.get(entry)!, ...entry.draft }));
    const eventsWithoutSequence: UnsequencedTraceEvent[] = [];
    for (const channel of this.requestShape.plannedChannels) if (this.attempts.has(channel)) eventsWithoutSequence.push({ kind: 'channel-attempt', channel });
    for (const channel of this.requestShape.plannedChannels) {
      const settlement = this.settlements.get(channel);
      if (settlement) eventsWithoutSequence.push({ kind: 'channel-terminal', channel, ...settlement });
    }
    for (const entry of sortedEntries) {
      const ref = refs.get(entry)!;
      for (const filter of [...entry.filters.values()].sort((a, b) => compareText(a.name, b.name))) {
        eventsWithoutSequence.push({ kind: 'candidate-filter', ref, ...filter });
      }
    }
    for (const entry of sortedEntries) {
      const ref = refs.get(entry)!;
      for (const score of [...entry.scores.values()].sort((a, b) => compareText(a.name, b.name))) {
        eventsWithoutSequence.push({ kind: 'candidate-score', ref, ...score });
      }
    }
    for (const round of [...this.mmrRounds].sort((a, b) => a.round - b.round)) {
      const records = round.records.map((record) => {
        const pairwise = record.pairwise.map((pair) => ({
          selectedRef: refs.get(pair.selected)!, similarity: pair.similarity,
        })).sort((a, b) => compareText(a.selectedRef, b.selectedRef));
        const maximum = [...pairwise].sort((a, b) => b.similarity - a.similarity || compareText(a.selectedRef, b.selectedRef))[0];
        const maxSimilarity = maximum?.similarity ?? 0;
        return {
          ref: refs.get(record.candidate)!, relevance: record.relevance, maxSimilarity,
          lambda: record.lambda,
          objective: roundTraceNumber(record.lambda * record.relevance - (1 - record.lambda) * maxSimilarity),
          againstRef: maximum?.selectedRef ?? null,
          pairwise,
        };
      }).sort((a, b) => compareText(a.ref, b.ref));
      eventsWithoutSequence.push({
        kind: 'mmr-round',
        round: round.round,
        selectedRef: refs.get(round.selected)!,
        records,
      });
    }
    for (const entry of [...sortedEntries].filter((item) => item.outputRank !== undefined).sort((a, b) => a.outputRank! - b.outputRank!)) {
      eventsWithoutSequence.push({
        kind: this.algorithmVersion === 'ranked-v1' ? 'ranked-output' : 'deterministic-output',
        ref: refs.get(entry)!, rank: entry.outputRank!,
      });
    }
    for (const entry of sortedEntries) {
      if (!entry.terminal) continue;
      const duplicate = 'duplicateOf' in entry.terminal && entry.terminal.duplicateOf !== undefined
        ? this.resolve(entry.terminal.duplicateOf) : undefined;
      eventsWithoutSequence.push({
        kind: 'candidate-terminal', ref: refs.get(entry)!, outcome: entry.terminal.outcome,
        reasons: [...entry.terminal.reasons], ...(duplicate ? { duplicateOfRef: refs.get(duplicate)! } : {}),
      });
    }
    for (const failure of [...this.stageFailures].sort((a, b) => compareText(a.stage, b.stage) || compareText(a.code, b.code))) {
      eventsWithoutSequence.push({ kind: 'stage-failure', ...failure });
    }
    if (eventsWithoutSequence.length > this.limits.maxEvents) this.incomplete.add('limit-overflow');
    const events = eventsWithoutSequence.map((event, index) => ({ sequence: index + 1, ...event })) as RetrievalTraceStageEventV1[];

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
      replayStateDigest: 'sha256:'.padEnd(71, '0'),
    };
    const semanticErrors = conformanceErrors(preliminary).filter((error) =>
      !error.includes('resultOrder') && !error.includes('terminalExclusions'));
    for (const error of semanticErrors) {
      if (error.includes('MMR')) this.incomplete.add('mmr-gap');
      else if (error.includes('channel')) this.incomplete.add('channel-gap');
      else if (error.includes('filter')) this.incomplete.add('candidate-event-conflict');
      else if (error.includes('terminal')) this.incomplete.add('candidate-terminal-gap');
      else this.incomplete.add('candidate-output-gap');
    }
    const reconstructed = reconstructFromEvents(preliminary);
    const incompleteReasons = [...this.incomplete].sort(compareText);
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
    const entry = this.handles.get(handle as object);
    if (!entry) throw new RetrievalTraceValidationError('candidate handle is not owned by this collector');
    return entry;
  }

  private assertPlannedChannel(channel: RetrievalTraceChannel): void {
    if (!enumHas(CHANNELS, channel) || !this.requestShape.plannedChannels.includes(channel)) {
      throw new RetrievalTraceValidationError('channel is not planned');
    }
  }

  private reserveEvent(): void {
    const count = this.attempts.size + this.settlements.size + this.stageFailures.length + this.mmrRounds.length
      + this.entries.reduce((sum, entry) => sum + entry.filters.size + entry.scores.size + (entry.outputRank === undefined ? 0 : 1) + (entry.terminal ? 1 : 0), 0);
    if (count >= this.limits.maxEvents) this.limitExceeded('event limit exceeded');
  }

  private mmrNumber(value: number, min: number, max: number): number {
    const normalized = roundTraceNumber(value);
    if (normalized < min || normalized > max) throw new RetrievalTraceValidationError('MMR number is outside semantic bounds');
    return normalized;
  }

  private limitExceeded(message: string): never {
    this.incomplete.add('limit-overflow');
    throw new RetrievalTraceLimitError(message);
  }

  private assertOpen(): void {
    if (this.finalized) throw new RetrievalTraceValidationError('collector is already finalized');
  }
}
