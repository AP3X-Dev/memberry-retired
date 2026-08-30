import { createHash } from 'node:crypto';
import { types as nodeUtilTypes } from 'node:util';

import type { RetrievalTraceSourceType } from './trace.js';
import { RETRIEVAL_SOURCE_TYPES } from './types.js';

const JSON_PARSE = JSON.parse;
const JSON_STRINGIFY = JSON.stringify;
const OBJECT_CREATE = Object.create;
const OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_HAS_OWN = Object.hasOwn;
const OBJECT_IS = Object.is;
const OBJECT_PROTOTYPE = Object.prototype;
const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_PROTOTYPE = Array.prototype;
const ARRAY_INCLUDES = Function.prototype.call.bind(Array.prototype.includes) as (
  input: readonly unknown[], value: unknown,
) => boolean;
const ARRAY_MAP = Function.prototype.call.bind(Array.prototype.map) as <T, U>(
  input: readonly T[], callback: (value: T, index: number) => U,
) => U[];
const ARRAY_SORT = Function.prototype.call.bind(Array.prototype.sort) as <T>(
  input: T[], compare: (left: T, right: T) => number,
) => T[];
const ARRAY_BUFFER_IS_VIEW = ArrayBuffer.isView;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const NODE_IS_PROXY = nodeUtilTypes.isProxy;
const NODE_IS_PROMISE = nodeUtilTypes.isPromise;
const BUFFER_BYTE_LENGTH = Buffer.byteLength;
const NUMBER_IS_FINITE = Number.isFinite;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const MATH_MIN = Math.min;
const STRING = String;
const STRING_CHAR_CODE_AT = Function.prototype.call.bind(String.prototype.charCodeAt) as (
  input: string, index: number,
) => number;
const STRING_SLICE = Function.prototype.call.bind(String.prototype.slice) as (
  input: string, start: number, end?: number,
) => string;
const STRING_REPEAT = Function.prototype.call.bind(String.prototype.repeat) as (
  input: string, count: number,
) => string;
const REGEXP_TEST = Function.prototype.call.bind(RegExp.prototype.test) as (
  pattern: RegExp, input: string,
) => boolean;
const SET_TIMEOUT = setTimeout;
const CLEAR_TIMEOUT = clearTimeout;
const MONOTONIC_NOW = process.hrtime.bigint;
const BIGINT = BigInt;
const PROMISE = Promise;
const PROMISE_PROTOTYPE = Promise.prototype;
const SYMBOL_SPECIES = Symbol.species;
const PROMISE_CONSTRUCTOR_DESCRIPTOR = OBJECT_FREEZE({
  ...OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(Promise.prototype, 'constructor')!,
});
const PROMISE_SPECIES_DESCRIPTOR = OBJECT_FREEZE({
  ...OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(Promise, SYMBOL_SPECIES)!,
});
const PROMISE_RESOLVE = Function.prototype.call.bind(Promise.resolve) as <T>(
  constructor: PromiseConstructor, value: T | PromiseLike<T>,
) => Promise<Awaited<T>>;
const PROMISE_THEN = Function.prototype.call.bind(Promise.prototype.then) as (
  promise: Promise<unknown>,
  fulfilled: (value: unknown) => unknown,
  rejected: () => unknown,
) => Promise<unknown>;
const HASH_PROTOTYPE = OBJECT_GET_PROTOTYPE_OF(createHash('sha256')) as object;
const HASH_UPDATE_DESCRIPTOR = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(HASH_PROTOTYPE, 'update');
const HASH_DIGEST_DESCRIPTOR = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(HASH_PROTOTYPE, 'digest');
if (HASH_UPDATE_DESCRIPTOR === undefined || !OBJECT_HAS_OWN(HASH_UPDATE_DESCRIPTOR, 'value')
  || typeof HASH_UPDATE_DESCRIPTOR.value !== 'function'
  || HASH_DIGEST_DESCRIPTOR === undefined || !OBJECT_HAS_OWN(HASH_DIGEST_DESCRIPTOR, 'value')
  || typeof HASH_DIGEST_DESCRIPTOR.value !== 'function') {
  throw new Error('memberry.reranker:hash-intrinsics-unavailable');
}
const HASH_UPDATE = Function.prototype.call.bind(HASH_UPDATE_DESCRIPTOR.value) as (
  hash: ReturnType<typeof createHash>, input: string, encoding: BufferEncoding,
) => ReturnType<typeof createHash>;
const HASH_DIGEST = Function.prototype.call.bind(HASH_DIGEST_DESCRIPTOR.value) as (
  hash: ReturnType<typeof createHash>, encoding: 'hex',
) => string;
const WEAK_SET = WeakSet;
const WEAK_SET_HAS = Function.prototype.call.bind(WeakSet.prototype.has) as (
  set: WeakSet<object>, value: object,
) => boolean;
const WEAK_SET_ADD = Function.prototype.call.bind(WeakSet.prototype.add) as (
  set: WeakSet<object>, value: object,
) => WeakSet<object>;

export const RERANKER_CONTRACT_ID = 'memberry.reranker' as const;
export const RERANKER_CONTRACT_VERSION = '1.0.0' as const;
export const RERANKER_MAX_CANDIDATES = 128 as const;
export const RERANKER_MAX_QUERY_BYTES = 8_192 as const;
export const RERANKER_MAX_STRING_BYTES = 65_536 as const;
export const RERANKER_MAX_AGGREGATE_STRING_BYTES = 4_194_304 as const;
export const RERANKER_MAX_RESPONSE_BYTES = 65_536 as const;
export const RERANKER_DEFAULT_TIMEOUT_MS = 250 as const;
export const RERANKER_MAX_TIMEOUT_MS = 2_000 as const;
export const RERANKER_BASELINE_REASON = 'not-reranked' as const;

const SAFE_PROVIDER_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/;
const MAX_SERIALIZED_PROVIDER_REQUEST_BYTES =
  (RERANKER_MAX_AGGREGATE_STRING_BYTES * 6) + (RERANKER_MAX_CANDIDATES * 256);

declare const serializedRerankerRequestBrand: unique symbol;
export type SerializedRerankerProviderRequestV1 = string & {
  readonly [serializedRerankerRequestBrand]: true;
};

export interface RerankCandidateInputV1<T> {
  readonly value: T;
  readonly sourceType: RetrievalTraceSourceType;
  readonly title: string;
  readonly content: string;
  readonly baselineScore: number;
}

export interface RerankInputV1<T> {
  readonly query: string;
  readonly candidates: readonly RerankCandidateInputV1<T>[];
}

export interface RerankerProviderIdentityV1 {
  readonly providerId: string;
  readonly modelId: string;
  readonly calibrationId: string;
  readonly locality: 'local' | 'remote';
}

export interface RerankerProviderCandidateV1 {
  readonly key: string;
  readonly sourceType: RetrievalTraceSourceType;
  readonly title: string;
  readonly content: string;
  readonly baselineRank: number;
  readonly baselineScore: number;
}

export interface RerankerProviderRequestV1 {
  readonly contractId: typeof RERANKER_CONTRACT_ID;
  readonly contractVersion: typeof RERANKER_CONTRACT_VERSION;
  readonly requestDigest: string;
  readonly query: string;
  readonly candidateCount: number;
  readonly candidates: readonly RerankerProviderCandidateV1[];
}

export interface RerankerCancellationV1 {
  readonly isCancelled: () => boolean;
}

export type RerankerProviderRunV1 = (
  request: SerializedRerankerProviderRequestV1,
  cancellation: RerankerCancellationV1,
) => Promise<string>;

export interface RerankerProviderV1 {
  readonly identity: RerankerProviderIdentityV1;
  readonly run: RerankerProviderRunV1;
}

export interface RerankerOptionsV1 {
  readonly timeoutMs?: number;
}

export interface RerankedCandidateV1<T> {
  readonly value: T;
  readonly baselineRank: number;
  readonly baselineScore: number;
  readonly score: number;
}

export type RerankerResultV1<T> =
  | {
      readonly outcome: 'reranked';
      readonly provider: RerankerProviderIdentityV1;
      readonly candidates: readonly RerankedCandidateV1<T>[];
    }
  | {
      readonly outcome: 'baseline';
      readonly reason: typeof RERANKER_BASELINE_REASON;
      readonly candidates: readonly RerankedCandidateV1<T>[];
    };

export type RerankerContractErrorCodeV1 =
  | 'invalid-request'
  | 'request-too-large'
  | 'invalid-provider'
  | 'invalid-options';

export class RerankerContractError extends Error {
  readonly code: RerankerContractErrorCodeV1;

  constructor(code: RerankerContractErrorCodeV1) {
    super(code);
    this.name = 'RerankerContractError';
    this.code = code;
  }
}

interface SafeCandidate<T> {
  readonly value: T;
  readonly sourceType: RetrievalTraceSourceType;
  readonly title: string;
  readonly content: string;
  readonly baselineRank: number;
  readonly baselineScore: number;
  readonly key: string;
}

interface ParsedInput<T> {
  readonly query: string;
  readonly candidates: readonly SafeCandidate<T>[];
}

interface ParsedResponseScore {
  readonly key: string;
  readonly calibratedScore: number;
}

interface ParsedResponse {
  readonly scores: readonly ParsedResponseScore[];
}

type NullRecord = Record<string, unknown>;

function defineArrayItem<T>(target: T[], index: number, value: T): void {
  OBJECT_DEFINE_PROPERTY(target, STRING(index), {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
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

function isAllowedPrototype(value: object): boolean {
  const prototype = OBJECT_GET_PROTOTYPE_OF(value);
  return prototype === null || prototype === OBJECT_PROTOTYPE;
}

function exactRecord(input: unknown, expected: readonly string[]): NullRecord {
  try {
    if (typeof input !== 'object' || input === null || NODE_IS_PROXY(input)
      || ARRAY_IS_ARRAY(input) || ARRAY_BUFFER_IS_VIEW(input) || !isAllowedPrototype(input)) {
      throw new Error();
    }
    const keys = REFLECT_OWN_KEYS(input);
    if (keys.length !== expected.length) throw new Error();
    const snapshot = OBJECT_CREATE(null) as NullRecord;
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index]!;
      if (typeof key !== 'string' || !ARRAY_INCLUDES(expected, key)) throw new Error();
      const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(input, key);
      if (descriptor === undefined || !OBJECT_HAS_OWN(descriptor, 'value')
        || descriptor.enumerable !== true) throw new Error();
      snapshot[key] = descriptor.value;
    }
    for (let index = 0; index < expected.length; index += 1) {
      if (!OBJECT_HAS_OWN(snapshot, expected[index]!)) throw new Error();
    }
    return snapshot;
  } catch {
    throw new Error('invalid-record');
  }
}

function optionalRecord(input: unknown, allowed: readonly string[]): NullRecord {
  if (input === undefined) return OBJECT_CREATE(null) as NullRecord;
  try {
    if (typeof input !== 'object' || input === null || NODE_IS_PROXY(input)
      || ARRAY_IS_ARRAY(input) || ARRAY_BUFFER_IS_VIEW(input) || !isAllowedPrototype(input)) {
      throw new Error();
    }
    const keys = REFLECT_OWN_KEYS(input);
    const snapshot = OBJECT_CREATE(null) as NullRecord;
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index]!;
      if (typeof key !== 'string' || !ARRAY_INCLUDES(allowed, key)) throw new Error();
      const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(input, key);
      if (descriptor === undefined || !OBJECT_HAS_OWN(descriptor, 'value')
        || descriptor.enumerable !== true) throw new Error();
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    throw new Error('invalid-record');
  }
}

function denseArray(input: unknown, max: number): readonly unknown[] {
  try {
    if (typeof input !== 'object' || input === null || NODE_IS_PROXY(input)
      || !ARRAY_IS_ARRAY(input) || ARRAY_BUFFER_IS_VIEW(input)
      || OBJECT_GET_PROTOTYPE_OF(input) !== ARRAY_PROTOTYPE) throw new Error();
    const lengthDescriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(input, 'length');
    if (lengthDescriptor === undefined || !OBJECT_HAS_OWN(lengthDescriptor, 'value')
      || !NUMBER_IS_SAFE_INTEGER(lengthDescriptor.value)) throw new Error();
    const length = lengthDescriptor.value as number;
    if (length > max) throw new RerankerContractError('request-too-large');
    const keys = REFLECT_OWN_KEYS(input);
    if (keys.length !== length + 1) throw new Error();
    const values: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(input, STRING(index));
      if (descriptor === undefined || !OBJECT_HAS_OWN(descriptor, 'value')
        || descriptor.enumerable !== true) throw new Error();
      defineArrayItem(values, index, descriptor.value);
    }
    return values;
  } catch (error) {
    if (error instanceof RerankerContractError) throw error;
    throw new Error('invalid-array');
  }
}

function validUnicode(input: string): boolean {
  for (let index = 0; index < input.length; index += 1) {
    const code = STRING_CHAR_CODE_AT(input, index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < input.length ? STRING_CHAR_CODE_AT(input, index + 1) : -1;
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function stringBytes(input: unknown, maxBytes: number): number {
  if (typeof input !== 'string') throw new Error('invalid-string');
  if (input.length > maxBytes) throw new RerankerContractError('request-too-large');
  if (!validUnicode(input)) throw new Error('invalid-string');
  const bytes = BUFFER_BYTE_LENGTH(input, 'utf8');
  if (bytes > maxBytes) throw new RerankerContractError('request-too-large');
  return bytes;
}

function identityString(input: unknown): string {
  stringBytes(input, 128);
  if ((input as string).length === 0
    || !REGEXP_TEST(SAFE_PROVIDER_IDENTITY, input as string)) throw new Error('invalid-identity');
  return input as string;
}

function sourceType(input: unknown): RetrievalTraceSourceType {
  if (typeof input !== 'string' || !ARRAY_INCLUDES(RETRIEVAL_SOURCE_TYPES, input)) {
    throw new Error('invalid-source-type');
  }
  return input as RetrievalTraceSourceType;
}

function finiteNumber(input: unknown): number {
  if (typeof input !== 'number' || !NUMBER_IS_FINITE(input) || OBJECT_IS(input, -0)) {
    throw new Error('invalid-number');
  }
  return input;
}

function calibratedScore(input: unknown): number {
  const score = finiteNumber(input);
  if (score < 0 || score > 1) throw new Error('invalid-score');
  return score;
}

function candidateKey(index: number): string {
  return `r${STRING_SLICE(`0000${index}`, -4)}`;
}

function parseInput<T>(input: unknown): ParsedInput<T> {
  try {
    const root = exactRecord(input, ['query', 'candidates']);
    const queryBytes = stringBytes(root.query, RERANKER_MAX_QUERY_BYTES);
    const rawCandidates = denseArray(root.candidates, RERANKER_MAX_CANDIDATES);
    const seen = new WEAK_SET<object>();
    const candidates: SafeCandidate<T>[] = [];
    let aggregate = queryBytes;
    for (let index = 0; index < rawCandidates.length; index += 1) {
      const raw = rawCandidates[index];
      if (typeof raw !== 'object' || raw === null || WEAK_SET_HAS(seen, raw)) throw new Error();
      WEAK_SET_ADD(seen, raw);
      const item = exactRecord(raw, ['value', 'sourceType', 'title', 'content', 'baselineScore']);
      const parsedSourceType = sourceType(item.sourceType);
      aggregate += stringBytes(parsedSourceType, RERANKER_MAX_STRING_BYTES);
      aggregate += stringBytes(item.title, RERANKER_MAX_STRING_BYTES);
      aggregate += stringBytes(item.content, RERANKER_MAX_STRING_BYTES);
      if (aggregate > RERANKER_MAX_AGGREGATE_STRING_BYTES) {
        throw new RerankerContractError('request-too-large');
      }
      defineArrayItem(candidates, index, nullRecord({
        value: item.value as T,
        sourceType: parsedSourceType,
        title: item.title as string,
        content: item.content as string,
        baselineRank: index + 1,
        baselineScore: finiteNumber(item.baselineScore),
        key: candidateKey(index),
      }));
    }
    return nullRecord({ query: root.query as string, candidates: OBJECT_FREEZE(candidates) });
  } catch (error) {
    if (error instanceof RerankerContractError) throw error;
    throw new RerankerContractError('invalid-request');
  }
}

function parseIdentity(input: unknown): RerankerProviderIdentityV1 {
  try {
    const record = exactRecord(input, ['providerId', 'modelId', 'calibrationId', 'locality']);
    if (record.locality !== 'local' && record.locality !== 'remote') throw new Error();
    const locality: RerankerProviderIdentityV1['locality'] = record.locality;
    const identity = nullRecord({
      providerId: identityString(record.providerId),
      modelId: identityString(record.modelId),
      calibrationId: identityString(record.calibrationId),
      locality,
    });
    assertResponseFeasible(identity);
    return identity;
  } catch {
    throw new RerankerContractError('invalid-provider');
  }
}

function parseProvider(input: unknown): RerankerProviderV1 | undefined {
  if (input === undefined) return undefined;
  try {
    const record = exactRecord(input, ['identity', 'run']);
    if (typeof record.run !== 'function' || NODE_IS_PROXY(record.run)) throw new Error();
    return nullRecord({
      identity: parseIdentity(record.identity),
      run: record.run as RerankerProviderRunV1,
    });
  } catch {
    throw new RerankerContractError('invalid-provider');
  }
}

function parseTimeout(input: unknown): number {
  try {
    const options = optionalRecord(input, ['timeoutMs']);
    if (!OBJECT_HAS_OWN(options, 'timeoutMs')) return RERANKER_DEFAULT_TIMEOUT_MS;
    if (typeof options.timeoutMs !== 'number' || !NUMBER_IS_SAFE_INTEGER(options.timeoutMs)
      || OBJECT_IS(options.timeoutMs, -0) || options.timeoutMs < 1
      || options.timeoutMs > RERANKER_MAX_TIMEOUT_MS) throw new Error();
    return options.timeoutMs;
  } catch {
    throw new RerankerContractError('invalid-options');
  }
}

function jsonString(input: string): string {
  return JSON_STRINGIFY(input) as string;
}

function jsonNumber(input: number): string {
  return JSON_STRINGIFY(input) as string;
}

function serializeProviderCandidates(candidates: readonly RerankerProviderCandidateV1[]): string {
  let result = '[';
  for (let index = 0; index < candidates.length; index += 1) {
    if (index > 0) result += ',';
    const candidate = candidates[index]!;
    result += `{"key":${jsonString(candidate.key)},"sourceType":${jsonString(candidate.sourceType)},"title":${jsonString(candidate.title)},"content":${jsonString(candidate.content)},"baselineRank":${jsonNumber(candidate.baselineRank)},"baselineScore":${jsonNumber(candidate.baselineScore)}}`;
  }
  return `${result}]`;
}

function serializeDigestPayload(
  query: string,
  candidates: readonly RerankerProviderCandidateV1[],
): string {
  return `{"contractId":${jsonString(RERANKER_CONTRACT_ID)},"contractVersion":${jsonString(RERANKER_CONTRACT_VERSION)},"query":${jsonString(query)},"candidateCount":${candidates.length},"candidates":${serializeProviderCandidates(candidates)}}`;
}

function serializeProviderRequestBytes(
  requestDigest: string,
  query: string,
  candidates: readonly RerankerProviderCandidateV1[],
): string {
  return `{"contractId":${jsonString(RERANKER_CONTRACT_ID)},"contractVersion":${jsonString(RERANKER_CONTRACT_VERSION)},"requestDigest":${jsonString(requestDigest)},"query":${jsonString(query)},"candidateCount":${candidates.length},"candidates":${serializeProviderCandidates(candidates)}}`;
}

function serializeResponseScores(scores: readonly ParsedResponseScore[]): string {
  let result = '[';
  for (let index = 0; index < scores.length; index += 1) {
    if (index > 0) result += ',';
    const score = scores[index]!;
    result += `{"key":${jsonString(score.key)},"calibratedScore":${jsonNumber(score.calibratedScore)}}`;
  }
  return `${result}]`;
}

function serializeProviderResponseBytes(
  requestDigest: string,
  identity: RerankerProviderIdentityV1,
  candidateCount: number,
  scores: readonly ParsedResponseScore[],
): string {
  return `{"contractId":${jsonString(RERANKER_CONTRACT_ID)},"contractVersion":${jsonString(RERANKER_CONTRACT_VERSION)},"requestDigest":${jsonString(requestDigest)},"providerId":${jsonString(identity.providerId)},"modelId":${jsonString(identity.modelId)},"calibrationId":${jsonString(identity.calibrationId)},"candidateCount":${candidateCount},"scores":${serializeResponseScores(scores)}}`;
}

function sha256Utf8(input: string): string {
  const hash = createHash('sha256');
  if (OBJECT_GET_PROTOTYPE_OF(hash) !== HASH_PROTOTYPE) throw new Error('invalid-hash-realm');
  HASH_UPDATE(hash, input, 'utf8');
  return HASH_DIGEST(hash, 'hex');
}

function assertResponseFeasible(identity: RerankerProviderIdentityV1): void {
  const scores: ParsedResponseScore[] = [];
  for (let index = 0; index < RERANKER_MAX_CANDIDATES; index += 1) {
    defineArrayItem(scores, index, nullRecord({
      key: candidateKey(index),
      calibratedScore: 0.9999999999999999,
    }));
  }
  const response = serializeProviderResponseBytes(
    STRING_REPEAT('0', 64),
    identity,
    RERANKER_MAX_CANDIDATES,
    scores,
  );
  if (BUFFER_BYTE_LENGTH(response, 'utf8') > RERANKER_MAX_RESPONSE_BYTES) throw new Error();
}

function canonicalRequest<T>(
  input: ParsedInput<T>,
): { readonly value: RerankerProviderRequestV1; readonly serialized: SerializedRerankerProviderRequestV1 } {
  const candidates = ARRAY_MAP(input.candidates, (candidate) => nullRecord({
    key: candidate.key,
    sourceType: candidate.sourceType,
    title: candidate.title,
    content: candidate.content,
    baselineRank: candidate.baselineRank,
    baselineScore: candidate.baselineScore,
  }));
  OBJECT_FREEZE(candidates);
  const requestDigest = sha256Utf8(serializeDigestPayload(input.query, candidates));
  const value = nullRecord({
    contractId: RERANKER_CONTRACT_ID,
    contractVersion: RERANKER_CONTRACT_VERSION,
    requestDigest,
    query: input.query,
    candidateCount: candidates.length,
    candidates,
  });
  return nullRecord({
    value,
    serialized: serializeProviderRequestBytes(
      requestDigest,
      input.query,
      candidates,
    ) as SerializedRerankerProviderRequestV1,
  });
}

/** @internal Provider-factory boundary; not part of the package root API. */
export function parseSerializedRerankerProviderRequestV1(
  serialized: SerializedRerankerProviderRequestV1 | string,
): RerankerProviderRequestV1 {
  if (typeof serialized !== 'string' || serialized.length > MAX_SERIALIZED_PROVIDER_REQUEST_BYTES
    || !validUnicode(serialized)
    || BUFFER_BYTE_LENGTH(serialized, 'utf8') > MAX_SERIALIZED_PROVIDER_REQUEST_BYTES) {
    throw new Error('invalid-reranker-request');
  }
  let decoded: unknown;
  try {
    decoded = JSON_PARSE(serialized) as unknown;
  } catch {
    throw new Error('invalid-reranker-request');
  }
  try {
    const root = exactRecord(decoded, [
      'contractId', 'contractVersion', 'requestDigest', 'query', 'candidateCount', 'candidates',
    ]);
    if (root.contractId !== RERANKER_CONTRACT_ID
      || root.contractVersion !== RERANKER_CONTRACT_VERSION
      || typeof root.requestDigest !== 'string'
      || !REGEXP_TEST(/^[a-f0-9]{64}$/, root.requestDigest as string)
      || typeof root.candidateCount !== 'number'
      || !NUMBER_IS_SAFE_INTEGER(root.candidateCount)
      || root.candidateCount < 0 || root.candidateCount > RERANKER_MAX_CANDIDATES) throw new Error();
    let aggregate = stringBytes(root.query, RERANKER_MAX_QUERY_BYTES);
    const rawCandidates = denseArray(root.candidates, RERANKER_MAX_CANDIDATES);
    if (rawCandidates.length !== root.candidateCount) throw new Error();
    const candidates: RerankerProviderCandidateV1[] = [];
    for (let index = 0; index < rawCandidates.length; index += 1) {
      const item = exactRecord(rawCandidates[index], [
        'key', 'sourceType', 'title', 'content', 'baselineRank', 'baselineScore',
      ]);
      if (item.key !== candidateKey(index) || item.baselineRank !== index + 1) throw new Error();
      const parsedSourceType = sourceType(item.sourceType);
      aggregate += stringBytes(parsedSourceType, RERANKER_MAX_STRING_BYTES);
      aggregate += stringBytes(item.title, RERANKER_MAX_STRING_BYTES);
      aggregate += stringBytes(item.content, RERANKER_MAX_STRING_BYTES);
      if (aggregate > RERANKER_MAX_AGGREGATE_STRING_BYTES) throw new Error();
      defineArrayItem(candidates, index, nullRecord({
        key: item.key as string,
        sourceType: parsedSourceType,
        title: item.title as string,
        content: item.content as string,
        baselineRank: item.baselineRank as number,
        baselineScore: finiteNumber(item.baselineScore),
      }));
    }
    OBJECT_FREEZE(candidates);
    const requestDigest = sha256Utf8(serializeDigestPayload(root.query as string, candidates));
    const result = nullRecord({
      contractId: RERANKER_CONTRACT_ID,
      contractVersion: RERANKER_CONTRACT_VERSION,
      requestDigest,
      query: root.query as string,
      candidateCount: candidates.length,
      candidates,
    });
    if (requestDigest !== root.requestDigest
      || serializeProviderRequestBytes(requestDigest, result.query, candidates) !== serialized) throw new Error();
    return result;
  } catch {
    throw new Error('invalid-reranker-request');
  }
}

/** @internal Provider-factory boundary; not part of the package root API. */
export function serializeRerankerProviderResponseV1(
  request: RerankerProviderRequestV1,
  identity: RerankerProviderIdentityV1,
  scoresInput: readonly number[],
): string {
  const rawScores = denseArray(scoresInput, RERANKER_MAX_CANDIDATES);
  if (rawScores.length !== request.candidateCount) {
    throw new Error('invalid-reranker-scores');
  }
  const scores: ParsedResponseScore[] = [];
  for (let index = 0; index < rawScores.length; index += 1) {
    defineArrayItem(scores, index, nullRecord({
      key: request.candidates[index]!.key,
      calibratedScore: calibratedScore(rawScores[index]),
    }));
  }
  return serializeProviderResponseBytes(
    request.requestDigest,
    identity,
    request.candidateCount,
    OBJECT_FREEZE(scores),
  );
}

function baselineCandidates<T>(input: ParsedInput<T>): readonly RerankedCandidateV1<T>[] {
  const result = ARRAY_MAP(input.candidates, (candidate) => nullRecord({
    value: candidate.value,
    baselineRank: candidate.baselineRank,
    baselineScore: candidate.baselineScore,
    score: candidate.baselineScore,
  }));
  return OBJECT_FREEZE(result);
}

function baselineResult<T>(input: ParsedInput<T>): RerankerResultV1<T> {
  return nullRecord({
    outcome: 'baseline' as const,
    reason: RERANKER_BASELINE_REASON,
    candidates: baselineCandidates(input),
  });
}

function isExactNativePromise(input: unknown): input is Promise<unknown> {
  try {
    if (typeof input !== 'object' || input === null || NODE_IS_PROXY(input)
      || !NODE_IS_PROMISE(input) || OBJECT_GET_PROTOTYPE_OF(input) !== PROMISE_PROTOTYPE
      || REFLECT_OWN_KEYS(input).length !== 0) return false;
    const constructorDescriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(PROMISE_PROTOTYPE, 'constructor');
    if (constructorDescriptor === undefined || !OBJECT_HAS_OWN(constructorDescriptor, 'value')
      || constructorDescriptor.value !== PROMISE
      || constructorDescriptor.writable !== PROMISE_CONSTRUCTOR_DESCRIPTOR.writable
      || constructorDescriptor.enumerable !== PROMISE_CONSTRUCTOR_DESCRIPTOR.enumerable
      || constructorDescriptor.configurable !== PROMISE_CONSTRUCTOR_DESCRIPTOR.configurable) return false;
    const speciesDescriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(PROMISE, SYMBOL_SPECIES);
    return speciesDescriptor !== undefined && OBJECT_HAS_OWN(speciesDescriptor, 'get')
      && speciesDescriptor.get === PROMISE_SPECIES_DESCRIPTOR.get
      && speciesDescriptor.set === PROMISE_SPECIES_DESCRIPTOR.set
      && speciesDescriptor.enumerable === PROMISE_SPECIES_DESCRIPTOR.enumerable
      && speciesDescriptor.configurable === PROMISE_SPECIES_DESCRIPTOR.configurable;
  } catch {
    return false;
  }
}

function responseRecord(input: unknown, expected: readonly string[]): NullRecord {
  return exactRecord(input, expected);
}

function parseResponse(
  raw: unknown,
  request: RerankerProviderRequestV1,
  identity: RerankerProviderIdentityV1,
): ParsedResponse {
  if (typeof raw !== 'string' || raw.length > RERANKER_MAX_RESPONSE_BYTES
    || !validUnicode(raw)
    || BUFFER_BYTE_LENGTH(raw, 'utf8') > RERANKER_MAX_RESPONSE_BYTES) throw new Error();
  let decoded: unknown;
  try {
    decoded = JSON_PARSE(raw) as unknown;
  } catch {
    throw new Error();
  }
  const root = responseRecord(decoded, [
    'contractId', 'contractVersion', 'requestDigest', 'providerId', 'modelId',
    'calibrationId', 'candidateCount', 'scores',
  ]);
  if (root.contractId !== RERANKER_CONTRACT_ID
    || root.contractVersion !== RERANKER_CONTRACT_VERSION
    || root.requestDigest !== request.requestDigest
    || root.providerId !== identity.providerId
    || root.modelId !== identity.modelId
    || root.calibrationId !== identity.calibrationId
    || root.candidateCount !== request.candidateCount) throw new Error();
  const rawScores = denseArray(root.scores, request.candidateCount);
  if (rawScores.length !== request.candidateCount) throw new Error();
  const expected = OBJECT_CREATE(null) as Record<string, true>;
  for (let index = 0; index < request.candidates.length; index += 1) {
    expected[request.candidates[index]!.key] = true;
  }
  const seen = OBJECT_CREATE(null) as Record<string, true>;
  const scores: ParsedResponseScore[] = [];
  for (let index = 0; index < rawScores.length; index += 1) {
    const scoreRecord = responseRecord(rawScores[index], ['key', 'calibratedScore']);
    if (typeof scoreRecord.key !== 'string' || !OBJECT_HAS_OWN(expected, scoreRecord.key)
      || OBJECT_HAS_OWN(seen, scoreRecord.key)) throw new Error();
    seen[scoreRecord.key] = true;
    defineArrayItem(scores, index, nullRecord({
      key: scoreRecord.key,
      calibratedScore: calibratedScore(scoreRecord.calibratedScore),
    }));
  }
  OBJECT_FREEZE(scores);
  if (serializeProviderResponseBytes(
    request.requestDigest,
    identity,
    request.candidateCount,
    scores,
  ) !== raw) throw new Error();
  return nullRecord({ scores });
}

function codeUnitCompare(left: string, right: string): number {
  const length = MATH_MIN(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = STRING_CHAR_CODE_AT(left, index) - STRING_CHAR_CODE_AT(right, index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function rerankedResult<T>(
  input: ParsedInput<T>,
  identity: RerankerProviderIdentityV1,
  response: ParsedResponse,
): RerankerResultV1<T> {
  const scores = OBJECT_CREATE(null) as Record<string, number>;
  for (let index = 0; index < response.scores.length; index += 1) {
    const score = response.scores[index]!;
    scores[score.key] = score.calibratedScore;
  }
  const ordered = ARRAY_MAP(input.candidates, (candidate) => nullRecord({
    value: candidate.value,
    baselineRank: candidate.baselineRank,
    baselineScore: candidate.baselineScore,
    score: scores[candidate.key]!,
    key: candidate.key,
  }));
  ARRAY_SORT(ordered, (left, right) => right.score - left.score
    || left.baselineRank - right.baselineRank
    || codeUnitCompare(left.key, right.key));
  const publicCandidates = ARRAY_MAP(ordered, (candidate) => nullRecord({
    value: candidate.value,
    baselineRank: candidate.baselineRank,
    baselineScore: candidate.baselineScore,
    score: candidate.score,
  }));
  return nullRecord({
    outcome: 'reranked' as const,
    provider: identity,
    candidates: OBJECT_FREEZE(publicCandidates),
  });
}

export function createRerankerProviderV1(
  identityInput: unknown,
  run: RerankerProviderRunV1,
): RerankerProviderV1 {
  if (typeof run !== 'function' || NODE_IS_PROXY(run)) {
    throw new RerankerContractError('invalid-provider');
  }
  return nullRecord({ identity: parseIdentity(identityInput), run });
}

interface CancellationControl {
  readonly value: RerankerCancellationV1;
  readonly cancel: () => void;
}

function createCancellationControl(): CancellationControl {
  let cancelled = false;
  const isCancelled = OBJECT_FREEZE(() => cancelled);
  const value = nullRecord({
    isCancelled,
  });
  return nullRecord({
    value,
    cancel: () => {
      if (!cancelled) cancelled = true;
    },
  });
}

export function executeCalibratedRerankV1<T>(
  input: RerankInputV1<T> | unknown,
  providerInput?: RerankerProviderV1 | unknown,
  optionsInput?: RerankerOptionsV1 | unknown,
): Promise<RerankerResultV1<T>> {
  const parsed = parseInput<T>(input);
  const provider = parseProvider(providerInput);
  const timeoutMs = parseTimeout(optionsInput);
  const fallback = baselineResult(parsed);
  if (parsed.candidates.length === 0 || provider === undefined) {
    return PROMISE_RESOLVE(PROMISE, fallback);
  }
  const request = canonicalRequest(parsed);
  return new PROMISE<RerankerResultV1<T>>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof SET_TIMEOUT> | undefined;
    const cancellation = createCancellationControl();
    const deadlineNs = MONOTONIC_NOW() + (BIGINT(timeoutMs) * 1_000_000n);
    const isOverDeadline = (): boolean => MONOTONIC_NOW() >= deadlineNs;
    const cancelThenBaseline = (): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) CLEAR_TIMEOUT(timer);
      cancellation.cancel();
      resolve(fallback);
    };
    const finishSuccess = (result: RerankerResultV1<T>): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) CLEAR_TIMEOUT(timer);
      resolve(result);
    };
    timer = SET_TIMEOUT(cancelThenBaseline, timeoutMs);
    let returned: unknown;
    try {
      returned = provider.run(request.serialized, cancellation.value);
    } catch {
      cancelThenBaseline();
      return;
    }
    if (isOverDeadline() || !isExactNativePromise(returned)) {
      cancelThenBaseline();
      return;
    }
    try {
      PROMISE_THEN(
        returned as Promise<unknown>,
        (raw) => {
          if (settled) return undefined;
          if (isOverDeadline()) {
            cancelThenBaseline();
            return undefined;
          }
          try {
            const response = parseResponse(raw, request.value, provider.identity);
            const result = rerankedResult(parsed, provider.identity, response);
            if (isOverDeadline()) cancelThenBaseline();
            else finishSuccess(result);
          } catch {
            cancelThenBaseline();
          }
          return undefined;
        },
        () => {
          cancelThenBaseline();
          return undefined;
        },
      );
    } catch {
      cancelThenBaseline();
    }
  });
}
