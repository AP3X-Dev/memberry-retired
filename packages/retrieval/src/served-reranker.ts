import { types as nodeUtilTypes } from 'node:util';
import { Buffer } from 'node:buffer';

import {
  RERANKER_BASELINE_REASON,
  RERANKER_DEFAULT_TIMEOUT_MS,
  createRerankerProviderV1,
  executeCalibratedRerankV1,
  parseSerializedRerankerProviderRequestV1,
  serializeRerankerProviderResponseV1,
  type RerankerProviderIdentityV1,
  type RerankerProviderV1,
} from './reranker.js';
import { RETRIEVAL_SOURCE_TYPES, type RetrievalResult, type SourceType } from './types.js';

const ARRAY = Array;
const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_PROTOTYPE = Array.prototype;
const ARRAY_INCLUDES = Function.prototype.call.bind(Array.prototype.includes) as <T>(
  input: readonly T[], value: T,
) => boolean;
const BUFFER_BYTE_LENGTH = Buffer.byteLength;
const OBJECT_CREATE = Object.create;
const OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_HAS_OWN = Object.hasOwn;
const OBJECT_IS = Object.is;
const OBJECT_PROTOTYPE = Object.prototype;
const REFLECT_APPLY = Reflect.apply;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const NODE_IS_PROXY = nodeUtilTypes.isProxy;
const NUMBER_IS_FINITE = Number.isFinite;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const MATH_LOG = Math.log;
const MATH_MAX = Math.max;
const MATH_MIN = Math.min;
const MATH_ROUND = Math.round;
const STRING = String;
const STRING_CHAR_CODE_AT = Function.prototype.call.bind(String.prototype.charCodeAt) as (
  input: string, index: number,
) => number;
const STRING_NORMALIZE = String.prototype.normalize;
const STRING_SLICE = Function.prototype.call.bind(String.prototype.slice) as (
  input: string, start: number, end?: number,
) => string;
const STRING_TO_LOWER_CASE = String.prototype.toLowerCase;
const REGEXP_SPLIT = RegExp.prototype[Symbol.split];
const SPLIT_PATTERN = /[^a-z0-9]+/;
const SET = Set;
const SET_HAS = Function.prototype.call.bind(Set.prototype.has) as <T>(set: Set<T>, value: T) => boolean;
const SET_ADD = Function.prototype.call.bind(Set.prototype.add) as <T>(set: Set<T>, value: T) => Set<T>;

const QUERY_TOKEN_LIMIT = 64;
const TITLE_TOKEN_LIMIT = 128;
const CONTENT_TOKEN_LIMIT = 2048;
// The served fusion window is 50 candidates and the provider request has a sealed 256 KiB
// aggregate envelope. A 1,000-code-unit prefix keeps that full window feasible even for four-byte
// Unicode while retaining
// the leading decision/task text that the scorer uses; returned evidence remains untruncated.
const PROVIDER_CONTENT_CODE_UNITS = 1_000;
const PROVIDER_COMPACTION_THRESHOLD_BYTES = 192 * 1024;
const TOKEN_LENGTH_LIMIT = 32;
const SCORE_SCALE = 1_000_000;
const BM25_K_PLUS_ONE = 2.2;
const BM25_K = 1.2;
const TITLE_WEIGHT = 2;
const CONTENT_WEIGHT = 1;
const TITLE_B = 0.30;
const CONTENT_B = 0.75;
const LEXICAL_SCALE = 4;
const BASELINE_WEIGHT = 0.15;
const LEXICAL_WEIGHT = 0.65;
const COVERAGE_WEIGHT = 0.15;
const PHRASE_WEIGHT = 0.05;
const MEMORY_PLANE_HEAD_FLOOR = 0.800001;
const MEMORY_PLANE_REMAINDER_CEILING = 0.799999;

const CORE_MEMORY_SOURCE_TYPES: readonly SourceType[] = OBJECT_FREEZE([
  'semantic', 'episodic', 'fact', 'block',
]);

const STOPWORDS: readonly string[] = OBJECT_FREEZE([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have',
  'how', 'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was',
  'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with',
]);

export const SERVED_RERANKER_PROVIDER_IDENTITY = nullRecord({
  providerId: 'memberry.local.lexical' as const,
  modelId: 'bm25f-query-v1' as const,
  calibrationId: 'fixed-blend-v1' as const,
  locality: 'local' as const,
});

export type ServedRerankerProviderIdentityV1 = typeof SERVED_RERANKER_PROVIDER_IDENTITY;
export type ServedRerankerConstructionV1 = RerankerProviderV1 & {
  readonly identity: ServedRerankerProviderIdentityV1;
};

export interface ServedRerankedCandidateV1 {
  readonly baselineResult: RetrievalResult;
  readonly result: RetrievalResult;
  readonly calibratedScore: number;
}

export type ServedRerankerApplicationResultV1 =
  | {
      readonly outcome: 'baseline';
      readonly reason: typeof RERANKER_BASELINE_REASON;
      readonly results: readonly RetrievalResult[];
    }
  | {
      readonly outcome: 'reranked';
      readonly provider: ServedRerankerProviderIdentityV1;
      readonly results: readonly RetrievalResult[];
      readonly candidates: readonly ServedRerankedCandidateV1[];
    };

function defineArrayItem<T>(target: T[], index: number, value: T): void {
  OBJECT_DEFINE_PROPERTY(target, STRING(index), {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function createDenseArray<T>(length: number): T[] {
  return new ARRAY<T>(length);
}

function appendArrayItem<T>(target: T[], value: T): void {
  defineArrayItem(target, target.length, value);
}

function nullRecord<T extends object>(fields: T): Readonly<T> {
  const result = OBJECT_CREATE(null) as T;
  const keys = REFLECT_OWN_KEYS(fields);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(fields, key)!;
    OBJECT_DEFINE_PROPERTY(result, key, descriptor);
  }
  return OBJECT_FREEZE(result);
}

function ownValue(record: object, key: string): unknown {
  const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(record, key);
  if (descriptor === undefined || !OBJECT_HAS_OWN(descriptor, 'value')
    || descriptor.enumerable !== true) throw new Error('invalid-retrieval-result');
  return descriptor.value;
}

function isAllowedRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || NODE_IS_PROXY(value) || ARRAY_IS_ARRAY(value)) return false;
  const prototype = OBJECT_GET_PROTOTYPE_OF(value);
  return prototype === OBJECT_PROTOTYPE || prototype === null;
}

function sourceType(value: unknown): SourceType {
  if (typeof value !== 'string') throw new Error('invalid-source-type');
  for (let index = 0; index < RETRIEVAL_SOURCE_TYPES.length; index += 1) {
    if (RETRIEVAL_SOURCE_TYPES[index] === value) return value as SourceType;
  }
  throw new Error('invalid-source-type');
}

interface SafeResult {
  readonly original: RetrievalResult;
  readonly id: string;
  readonly source_type: SourceType;
  readonly title: string;
  readonly content: string;
  readonly score: number;
  readonly metadata: Record<string, unknown>;
}

function snapshotResults(input: readonly RetrievalResult[]): readonly SafeResult[] {
  if (typeof input !== 'object' || input === null || NODE_IS_PROXY(input)
    || !ARRAY_IS_ARRAY(input) || OBJECT_GET_PROTOTYPE_OF(input) !== ARRAY_PROTOTYPE) {
    throw new Error('invalid-results');
  }
  const lengthDescriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(input, 'length');
  if (lengthDescriptor === undefined || !OBJECT_HAS_OWN(lengthDescriptor, 'value')
    || typeof lengthDescriptor.value !== 'number' || !NUMBER_IS_SAFE_INTEGER(lengthDescriptor.value)) {
    throw new Error('invalid-results');
  }
  const length = lengthDescriptor.value;
  const keys = REFLECT_OWN_KEYS(input);
  if (keys.length !== length + 1) throw new Error('invalid-results');
  const snapshots = createDenseArray<SafeResult>(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(input, STRING(index));
    if (descriptor === undefined || !OBJECT_HAS_OWN(descriptor, 'value')
      || descriptor.enumerable !== true || !isAllowedRecord(descriptor.value)) {
      throw new Error('invalid-results');
    }
    const value = descriptor.value as unknown as RetrievalResult;
    const id = ownValue(value, 'id');
    const rawSourceType = ownValue(value, 'source_type');
    const title = ownValue(value, 'title');
    const content = ownValue(value, 'content');
    const score = ownValue(value, 'score');
    const metadata = ownValue(value, 'metadata');
    if (typeof id !== 'string' || typeof title !== 'string' || typeof content !== 'string'
      || typeof score !== 'number' || !NUMBER_IS_FINITE(score) || OBJECT_IS(score, -0)
      || typeof metadata !== 'object' || metadata === null) throw new Error('invalid-results');
    defineArrayItem(snapshots, index, nullRecord({
      original: value,
      id,
      source_type: sourceType(rawSourceType),
      title,
      content,
      score,
      metadata: metadata as Record<string, unknown>,
    }));
  }
  return OBJECT_FREEZE(snapshots);
}

function isStopword(token: string): boolean {
  for (let index = 0; index < STOPWORDS.length; index += 1) {
    if (STOPWORDS[index] === token) return true;
  }
  return false;
}

function tokenize(input: string, limit: number): readonly string[] {
  const normalized = REFLECT_APPLY(STRING_NORMALIZE, input, ['NFKC']) as string;
  const lowered = REFLECT_APPLY(STRING_TO_LOWER_CASE, normalized, []) as string;
  const split = REFLECT_APPLY(REGEXP_SPLIT, SPLIT_PATTERN, [lowered]) as string[];
  const result: string[] = [];
  for (let index = 0; index < split.length && result.length < limit; index += 1) {
    const token = split[index]!;
    if (token.length <= 1 || token.length > TOKEN_LENGTH_LIMIT || isStopword(token)) continue;
    appendArrayItem(result, token);
  }
  return OBJECT_FREEZE(result);
}

function uniqueTokens(tokens: readonly string[]): readonly string[] {
  const result: string[] = [];
  for (let index = 0; index < tokens.length && result.length < QUERY_TOKEN_LIMIT; index += 1) {
    const token = tokens[index]!;
    let present = false;
    for (let seenIndex = 0; seenIndex < result.length; seenIndex += 1) {
      if (result[seenIndex] === token) { present = true; break; }
    }
    if (!present) appendArrayItem(result, token);
  }
  return OBJECT_FREEZE(result);
}

function termFrequency(tokens: readonly string[], target: string): number {
  let count = 0;
  for (let index = 0; index < tokens.length; index += 1) if (tokens[index] === target) count += 1;
  return count;
}

function containsToken(tokens: readonly string[], target: string): boolean {
  return termFrequency(tokens, target) > 0;
}

function containsSequence(tokens: readonly string[], query: readonly string[]): boolean {
  if (query.length === 0 || query.length > tokens.length) return false;
  for (let start = 0; start <= tokens.length - query.length; start += 1) {
    let matches = true;
    for (let offset = 0; offset < query.length; offset += 1) {
      if (tokens[start + offset] !== query[offset]) { matches = false; break; }
    }
    if (matches) return true;
  }
  return false;
}

function isCoreMemorySource(value: SourceType): boolean {
  for (let index = 0; index < CORE_MEMORY_SOURCE_TYPES.length; index += 1) {
    if (CORE_MEMORY_SOURCE_TYPES[index] === value) return true;
  }
  return false;
}

function finite(value: number): number {
  if (!NUMBER_IS_FINITE(value)) throw new Error('non-finite-score');
  return value;
}

function clamp(value: number): number {
  return MATH_MIN(1, MATH_MAX(0, value));
}

function providerContent(input: string): string {
  if (input.length <= PROVIDER_CONTENT_CODE_UNITS) return input;
  let end = PROVIDER_CONTENT_CODE_UNITS;
  const last = STRING_CHAR_CODE_AT(input, end - 1);
  if (last >= 0xD800 && last <= 0xDBFF) end -= 1;
  return STRING_SLICE(input, 0, end);
}

function bm25(tf: number, length: number, average: number, b: number): number {
  if (tf === 0) return 0;
  const denominator = tf + BM25_K * (1 - b + b * length / MATH_MAX(average, 1));
  return finite(tf * BM25_K_PLUS_ONE / denominator);
}

interface TokenizedCandidate {
  readonly title: readonly string[];
  readonly content: readonly string[];
  readonly baselineScore: number;
}

function scoreBatch(query: string, candidates: readonly {
  readonly sourceType: SourceType;
  readonly title: string;
  readonly content: string;
  readonly baselineScore: number;
}[]): readonly number[] {
  const queryTokens = tokenize(query, QUERY_TOKEN_LIMIT);
  const uniqueQuery = uniqueTokens(queryTokens);
  if (uniqueQuery.length === 0) throw new Error('empty-retained-query');
  const tokenized = createDenseArray<TokenizedCandidate>(candidates.length);
  let titleTotal = 0;
  let contentTotal = 0;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    const title = tokenize(candidate.title, TITLE_TOKEN_LIMIT);
    const content = tokenize(candidate.content, CONTENT_TOKEN_LIMIT);
    titleTotal += title.length;
    contentTotal += content.length;
    defineArrayItem(tokenized, index, nullRecord({ title, content, baselineScore: candidate.baselineScore }));
  }
  const averageTitle = finite(titleTotal / candidates.length);
  const averageContent = finite(contentTotal / candidates.length);
  const documentFrequencies = createDenseArray<number>(uniqueQuery.length);
  for (let queryIndex = 0; queryIndex < uniqueQuery.length; queryIndex += 1) {
    const token = uniqueQuery[queryIndex]!;
    let frequency = 0;
    for (let documentIndex = 0; documentIndex < tokenized.length; documentIndex += 1) {
      const document = tokenized[documentIndex]!;
      if (containsToken(document.title, token) || containsToken(document.content, token)) frequency += 1;
    }
    defineArrayItem(documentFrequencies, queryIndex, frequency);
  }
  const scores = createDenseArray<number>(candidates.length);
  for (let candidateIndex = 0; candidateIndex < tokenized.length; candidateIndex += 1) {
    const candidate = tokenized[candidateIndex]!;
    let raw = 0;
    let matched = 0;
    for (let queryIndex = 0; queryIndex < uniqueQuery.length; queryIndex += 1) {
      const token = uniqueQuery[queryIndex]!;
      const df = documentFrequencies[queryIndex]!;
      const titleTf = termFrequency(candidate.title, token);
      const contentTf = termFrequency(candidate.content, token);
      if (titleTf > 0 || contentTf > 0) matched += 1;
      const idf = finite(MATH_LOG(1 + (tokenized.length - df + 0.5) / (df + 0.5)));
      raw = finite(raw + idf * (
        TITLE_WEIGHT * bm25(titleTf, candidate.title.length, averageTitle, TITLE_B)
        + CONTENT_WEIGHT * bm25(contentTf, candidate.content.length, averageContent, CONTENT_B)
      ));
    }
    const lexical = raw === 0 ? 0 : finite(raw / (raw + LEXICAL_SCALE));
    const coverage = finite(matched / uniqueQuery.length);
    const phrase = containsSequence(candidate.title, queryTokens)
      || containsSequence(candidate.content, queryTokens) ? 1 : 0;
    const blended = clamp(finite(
      BASELINE_WEIGHT * clamp(candidate.baselineScore)
      + LEXICAL_WEIGHT * lexical
      + COVERAGE_WEIGHT * coverage
      + PHRASE_WEIGHT * phrase,
    ));
    const rounded = MATH_ROUND(blended * SCORE_SCALE) / SCORE_SCALE;
    defineArrayItem(scores, candidateIndex, OBJECT_IS(rounded, -0) ? 0 : rounded);
  }
  // A memory-only context should not let many same-plane hits erase every other memory plane
  // from the first five items an agent sees. Preserve lexical order within each plane, promote
  // only that plane's strongest candidate, and leave mixed code/architecture batches untouched.
  let coreMemoryOnly = candidates.length > 0;
  const planeHeads = createDenseArray<number | undefined>(CORE_MEMORY_SOURCE_TYPES.length);
  for (let index = 0; index < planeHeads.length; index += 1) defineArrayItem(planeHeads, index, undefined);
  let planeCount = 0;
  for (let index = 0; index < candidates.length; index += 1) {
    const type = candidates[index]!.sourceType;
    if (!isCoreMemorySource(type)) { coreMemoryOnly = false; break; }
    let planeIndex = 0;
    while (CORE_MEMORY_SOURCE_TYPES[planeIndex] !== type) planeIndex += 1;
    const previous = planeHeads[planeIndex];
    if (previous === undefined) planeCount += 1;
    if (previous === undefined || scores[index]! > scores[previous]!) planeHeads[planeIndex] = index;
  }
  if (coreMemoryOnly && planeCount > 1) {
    const heads = new SET<number>();
    for (let index = 0; index < planeHeads.length; index += 1) {
      if (planeHeads[index] !== undefined) SET_ADD(heads, planeHeads[index]!);
    }
    for (let index = 0; index < scores.length; index += 1) {
      const raw = scores[index]!;
      const calibrated = SET_HAS(heads, index)
        ? MEMORY_PLANE_HEAD_FLOOR + (1 - MEMORY_PLANE_HEAD_FLOOR) * raw
        : MEMORY_PLANE_REMAINDER_CEILING * raw;
      const rounded = MATH_ROUND(calibrated * SCORE_SCALE) / SCORE_SCALE;
      scores[index] = OBJECT_IS(rounded, -0) ? 0 : rounded;
    }
  }
  return OBJECT_FREEZE(scores);
}

export function createServedRerankerProviderV1(): ServedRerankerConstructionV1 {
  const provider = createRerankerProviderV1(
    SERVED_RERANKER_PROVIDER_IDENTITY,
    async (serialized) => {
      const request = parseSerializedRerankerProviderRequestV1(serialized);
      const scores = scoreBatch(request.query, request.candidates);
      return serializeRerankerProviderResponseV1(
        request,
        SERVED_RERANKER_PROVIDER_IDENTITY,
        scores,
      );
    },
  );
  return provider as ServedRerankerConstructionV1;
}

function identityMatches(identity: RerankerProviderIdentityV1): boolean {
  try {
    if (!isAllowedRecord(identity)) return false;
    return ownValue(identity, 'providerId') === SERVED_RERANKER_PROVIDER_IDENTITY.providerId
      && ownValue(identity, 'modelId') === SERVED_RERANKER_PROVIDER_IDENTITY.modelId
      && ownValue(identity, 'calibrationId') === SERVED_RERANKER_PROVIDER_IDENTITY.calibrationId
      && ownValue(identity, 'locality') === SERVED_RERANKER_PROVIDER_IDENTITY.locality
      && REFLECT_OWN_KEYS(identity).length === 4;
  } catch {
    return false;
  }
}

function canonicalScore(value: number): boolean {
  if (!NUMBER_IS_FINITE(value) || value < 0 || value > 1 || OBJECT_IS(value, -0)) return false;
  const rounded = MATH_ROUND(value * SCORE_SCALE) / SCORE_SCALE;
  return rounded === value && !OBJECT_IS(rounded, -0);
}

function baseline(results: readonly RetrievalResult[]): ServedRerankerApplicationResultV1 {
  return nullRecord({ outcome: 'baseline' as const, reason: RERANKER_BASELINE_REASON, results });
}

/** @internal Shared post-dedup/pre-budget application seam for runtime-trace and RET-010C. */
export async function applyServedRerankerV1(
  query: string,
  results: readonly RetrievalResult[],
  provider: RerankerProviderV1,
): Promise<ServedRerankerApplicationResultV1> {
  let snapshots: readonly SafeResult[];
  try {
    if (typeof query !== 'string' || !isAllowedRecord(provider)
      || REFLECT_OWN_KEYS(provider).length !== 2) return baseline(results);
    const providerIdentity = ownValue(provider, 'identity');
    const providerRun = ownValue(provider, 'run');
    if (!isAllowedRecord(providerIdentity) || typeof providerRun !== 'function' || NODE_IS_PROXY(providerRun)
      || !identityMatches(providerIdentity as unknown as RerankerProviderIdentityV1)) return baseline(results);
    snapshots = snapshotResults(results);
    let providerBytes = BUFFER_BYTE_LENGTH(query, 'utf8');
    for (let index = 0; index < snapshots.length; index += 1) {
      providerBytes += BUFFER_BYTE_LENGTH(snapshots[index]!.title, 'utf8');
      providerBytes += BUFFER_BYTE_LENGTH(snapshots[index]!.content, 'utf8');
    }
    const compactProviderText = providerBytes > PROVIDER_COMPACTION_THRESHOLD_BYTES;
    const candidates = createDenseArray<{
      value: SafeResult; sourceType: SourceType; title: string; content: string; baselineScore: number;
    }>(snapshots.length);
    for (let index = 0; index < snapshots.length; index += 1) {
      const snapshot = snapshots[index]!;
      defineArrayItem(candidates, index, nullRecord({
        value: snapshot,
        sourceType: snapshot.source_type,
        title: snapshot.title,
        content: compactProviderText ? providerContent(snapshot.content) : snapshot.content,
        baselineScore: snapshot.score,
      }));
    }
    const reranked = await executeCalibratedRerankV1<SafeResult>(
      nullRecord({ query, candidates: OBJECT_FREEZE(candidates) }),
      provider,
      nullRecord({ timeoutMs: RERANKER_DEFAULT_TIMEOUT_MS }),
    );
    if (reranked.outcome !== 'reranked' || !identityMatches(reranked.provider)
      || reranked.candidates.length !== snapshots.length) return baseline(results);
    const seen = new SET<SafeResult>();
    const ownedResults = createDenseArray<RetrievalResult>(snapshots.length);
    const applications = createDenseArray<ServedRerankedCandidateV1>(snapshots.length);
    for (let index = 0; index < reranked.candidates.length; index += 1) {
      const candidate = reranked.candidates[index]!;
      if (!ARRAY_INCLUDES(snapshots, candidate.value) || SET_HAS(seen, candidate.value)
        || !canonicalScore(candidate.score)) return baseline(results);
      SET_ADD(seen, candidate.value);
      const snapshot = candidate.value;
      const owned = nullRecord({
        id: snapshot.id,
        source_type: snapshot.source_type,
        title: snapshot.title,
        content: snapshot.content,
        score: candidate.score,
        metadata: snapshot.metadata,
      }) as unknown as RetrievalResult;
      defineArrayItem(ownedResults, index, owned);
      defineArrayItem(applications, index, nullRecord({
        baselineResult: snapshot.original,
        result: owned,
        calibratedScore: candidate.score,
      }));
    }
    return nullRecord({
      outcome: 'reranked' as const,
      provider: SERVED_RERANKER_PROVIDER_IDENTITY,
      results: OBJECT_FREEZE(ownedResults),
      candidates: OBJECT_FREEZE(applications),
    });
  } catch {
    return baseline(results);
  }
}
