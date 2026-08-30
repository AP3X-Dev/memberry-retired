import { types as nodeUtilTypes } from 'node:util';

import {
  RETRIEVAL_TRACE_CHANNEL_ORDER,
  type RetrievalTraceChannel,
  type RetrievalTraceSourceType,
} from './trace.js';
import { RETRIEVAL_SOURCE_TYPES } from './types.js';

const INTRINSIC_JSON_PARSE = JSON.parse;
const INTRINSIC_JSON_STRINGIFY = JSON.stringify;
const INTRINSIC_OBJECT_CREATE = Object.create;
const INTRINSIC_OBJECT_FREEZE = Object.freeze;
const INTRINSIC_OBJECT_SET_PROTOTYPE_OF = Object.setPrototypeOf;
const INTRINSIC_OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const INTRINSIC_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const INTRINSIC_OBJECT_HAS_OWN = Object.hasOwn;
const INTRINSIC_OBJECT_IS = Object.is;
const INTRINSIC_OBJECT_PROTOTYPE = Object.prototype;
const INTRINSIC_ARRAY_IS_ARRAY = Array.isArray;
const INTRINSIC_ARRAY_PROTOTYPE = Array.prototype;
const INTRINSIC_ARRAY_BUFFER_IS_VIEW = ArrayBuffer.isView;
const INTRINSIC_REFLECT_OWN_KEYS = Reflect.ownKeys;
const INTRINSIC_NODE_IS_PROXY = nodeUtilTypes.isProxy;
const INTRINSIC_NODE_IS_PROMISE = nodeUtilTypes.isPromise;
const INTRINSIC_SET = Set;
const INTRINSIC_WEAK_SET = WeakSet;
const INTRINSIC_SET_HAS = Function.prototype.call.bind(Set.prototype.has) as (
  set: Set<unknown>, value: unknown,
) => boolean;
const INTRINSIC_SET_ADD = Function.prototype.call.bind(Set.prototype.add) as (
  set: Set<unknown>, value: unknown,
) => Set<unknown>;
const INTRINSIC_WEAK_SET_HAS = Function.prototype.call.bind(WeakSet.prototype.has) as (
  set: WeakSet<object>, value: object,
) => boolean;
const INTRINSIC_WEAK_SET_ADD = Function.prototype.call.bind(WeakSet.prototype.add) as (
  set: WeakSet<object>, value: object,
) => WeakSet<object>;
const INTRINSIC_WEAK_SET_DELETE = Function.prototype.call.bind(WeakSet.prototype.delete) as (
  set: WeakSet<object>, value: object,
) => boolean;
const INTRINSIC_STRING = String;
const INTRINSIC_STRING_SLICE = Function.prototype.call.bind(String.prototype.slice) as (
  input: string, start: number, end?: number,
) => string;
const INTRINSIC_STRING_STARTS_WITH = Function.prototype.call.bind(String.prototype.startsWith) as (
  input: string, search: string, position?: number,
) => boolean;
const INTRINSIC_STRING_FROM_CHAR_CODE = String.fromCharCode;
const INTRINSIC_REGEXP_EXEC = Function.prototype.call.bind(RegExp.prototype.exec) as (
  pattern: RegExp, input: string,
) => RegExpExecArray | null;
const INTRINSIC_NUMBER = Number;
const INTRINSIC_NUMBER_PARSE_INT = Number.parseInt;
const INTRINSIC_NUMBER_IS_FINITE = Number.isFinite;
const INTRINSIC_NUMBER_IS_INTEGER = Number.isInteger;
const INTRINSIC_NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const INTRINSIC_NUMBER_MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const INTRINSIC_NUMBER_TO_FIXED = Function.prototype.call.bind(Number.prototype.toFixed) as (
  input: number, fractionDigits?: number,
) => string;
const INTRINSIC_MATH_ABS = Math.abs;
const INTRINSIC_BUFFER_BYTE_LENGTH = Buffer.byteLength;
const INTRINSIC_DATE = Date;
const INTRINSIC_DATE_GET_TIME = Function.prototype.call.bind(Date.prototype.getTime) as (
  input: Date,
) => number;
const INTRINSIC_DATE_TO_ISO_STRING = Function.prototype.call.bind(Date.prototype.toISOString) as (
  input: Date,
) => string;
const INTRINSIC_SYMBOL_SPECIES = Symbol.species;
const INTRINSIC_PROMISE = Promise;
const INTRINSIC_PROMISE_PROTOTYPE = Promise.prototype;
const INTRINSIC_PROMISE_CONSTRUCTOR_DESCRIPTOR = INTRINSIC_OBJECT_FREEZE({
  ...INTRINSIC_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(Promise.prototype, 'constructor')!,
});
const INTRINSIC_PROMISE_SPECIES_DESCRIPTOR = INTRINSIC_OBJECT_FREEZE({
  ...INTRINSIC_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(Promise, INTRINSIC_SYMBOL_SPECIES)!,
});
const INTRINSIC_PROMISE_THEN = Function.prototype.call.bind(
  Promise.prototype.then,
) as (
  promise: Promise<unknown>,
  onFulfilled: (value: unknown) => unknown,
  onRejected: () => unknown,
) => Promise<unknown>;
const INTRINSIC_STRING_CHAR_CODE_AT = Function.prototype.call.bind(
  String.prototype.charCodeAt,
) as (input: string, index: number) => number;

export const CANDIDATE_CHANNEL_CONTRACT_ID = 'memberry.candidate-channel' as const;
export const CANDIDATE_CHANNEL_CONTRACT_VERSION = '1.0.0' as const;
export const CANDIDATE_CHANNEL_MAX_PLANNED = 15 as const;
export const CANDIDATE_CHANNEL_MAX_PER_CHANNEL = 64 as const;
export const CANDIDATE_CHANNEL_DEFAULT_AGGREGATE = 128 as const;
export const CANDIDATE_CHANNEL_MAX_AGGREGATE = 512 as const;
export const CANDIDATE_CHANNEL_MAX_STRING_BYTES = 65_536 as const;
export const CANDIDATE_CHANNEL_MAX_AGGREGATE_STRING_BYTES = 4_194_304 as const;
export const CANDIDATE_CHANNEL_MAX_SERIALIZED_BYTES = 33_554_432 as const;
// RET-009 backstop for a roster runner that never settles. It is a backstop, not a
// budget: it must stay strictly above every well-behaved worst case, or it preempts
// a healthy runner. The worst of those today is the memory.fact hop at 7000 ms,
// composed serially from FACT_ID_BATCH_WALL_TIMEOUT_MS (packages/neo4j/src/fact.ts:675,
// 6000 ms, bounding session.run) and FACT_ID_BATCH_CLOSE_TIMEOUT_MS (fact.ts:676,
// 1000 ms, applied afterwards in the outer finally). Raising EITHER of those two
// constants requires raising this one.
export const CANDIDATE_CHANNEL_EXECUTOR_DEADLINE_MS = 10_000 as const;

const MAX_RESOLVED_ENTITY_IDS = 32;
const MAX_TENANT_ID_BYTES = 128;
const MAX_PROJECT_SCOPE_BYTES = 136;
const MAX_EVIDENCE_ID_BYTES = 200;
const MAX_SCORE_MAGNITUDE = 1_000_000;
const MAX_GRAPH_DEPTH = 12;
const MAX_GRAPH_VALUES = 8_192;
const MAX_GRAPH_ENTRIES = 4_096;
const MAX_GRAPH_KEYS = 16_384;

const SAFE_TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const CANONICAL_PROJECT_SCOPE = /^project:[a-z0-9][a-z0-9._-]*$/;
const SAFE_EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/;
const SOURCE_TYPES = RETRIEVAL_SOURCE_TYPES;
const EXPLICIT_FAILURE_CODES = INTRINSIC_OBJECT_FREEZE([
  'unavailable', 'timeout', 'query-failed',
] as const);
const CHANNEL_FAILURE_CODES = INTRINSIC_OBJECT_FREEZE([
  ...EXPLICIT_FAILURE_CODES,
  'invalid-result',
  'budget-exceeded',
] as const);

export type CandidateChannelFailureCodeV1 = typeof CHANNEL_FAILURE_CODES[number];
export type CandidateChannelExplicitFailureCodeV1 = typeof EXPLICIT_FAILURE_CODES[number];

export type CandidateChannelTemporalFrameV1 =
  | { readonly mode: 'current' }
  | { readonly mode: 'as-of'; readonly asOf: string };

export interface CandidateChannelLimitsV1 {
  readonly maxCandidatesPerChannel: number;
  readonly maxCandidatesAggregate: number;
}

export interface CandidateChannelRequestV1 {
  readonly contractId: typeof CANDIDATE_CHANNEL_CONTRACT_ID;
  readonly contractVersion: typeof CANDIDATE_CHANNEL_CONTRACT_VERSION;
  readonly tenantId: string;
  readonly projectScope: string;
  readonly resolvedEntityIds: readonly string[];
  readonly temporalFrame: CandidateChannelTemporalFrameV1;
  readonly plannedChannels: readonly RetrievalTraceChannel[];
  readonly limits: CandidateChannelLimitsV1;
}

export type CandidateChannelProvenanceV1 =
  | { readonly kind: 'semantic'; readonly semanticId: string }
  | { readonly kind: 'episodic'; readonly episodeId: string }
  | { readonly kind: 'symbol'; readonly symbolId: string }
  | { readonly kind: 'arch_entity'; readonly entityId: string }
  | { readonly kind: 'aspect'; readonly aspectId: string }
  | { readonly kind: 'fact'; readonly factId: string }
  | { readonly kind: 'block'; readonly blockId: string };

export interface CandidateChannelCandidateV1 {
  readonly contractId: typeof CANDIDATE_CHANNEL_CONTRACT_ID;
  readonly contractVersion: typeof CANDIDATE_CHANNEL_CONTRACT_VERSION;
  readonly channel: RetrievalTraceChannel;
  readonly tenantId: string;
  readonly projectScope: string;
  readonly resolvedEntityId: string;
  readonly temporalFrame: CandidateChannelTemporalFrameV1;
  readonly sourceType: RetrievalTraceSourceType;
  readonly evidenceId: string;
  readonly rank: number;
  readonly score: number;
  readonly title: string;
  readonly content: string;
  readonly provenance: CandidateChannelProvenanceV1;
}

export type CandidateChannelRunnerResultV1 =
  | {
      readonly contractId: typeof CANDIDATE_CHANNEL_CONTRACT_ID;
      readonly contractVersion: typeof CANDIDATE_CHANNEL_CONTRACT_VERSION;
      readonly channel: RetrievalTraceChannel;
      readonly outcome: 'success';
      readonly candidateCount: number;
      readonly candidates: readonly CandidateChannelCandidateV1[];
    }
  | {
      readonly contractId: typeof CANDIDATE_CHANNEL_CONTRACT_ID;
      readonly contractVersion: typeof CANDIDATE_CHANNEL_CONTRACT_VERSION;
      readonly channel: RetrievalTraceChannel;
      readonly outcome: 'safe-failure';
      readonly code: CandidateChannelExplicitFailureCodeV1;
    };

declare const CANDIDATE_CHANNEL_SERIALIZED_RESULT_BRAND: unique symbol;
export type CandidateChannelSerializedResultV1 = string & {
  readonly [CANDIDATE_CHANNEL_SERIALIZED_RESULT_BRAND]: true;
};

export type CandidateChannelRunnerV1 = (
  request: CandidateChannelRequestV1,
) => CandidateChannelRunnerResultV1 | Promise<CandidateChannelSerializedResultV1>;

export interface CandidateChannelRunnerRegistrationV1 {
  readonly channel: RetrievalTraceChannel;
  readonly run: CandidateChannelRunnerV1;
}

export type CandidateChannelRunnerRosterV1 = readonly CandidateChannelRunnerRegistrationV1[];

export type CandidateChannelSettlementV1 =
  | {
      readonly contractId: typeof CANDIDATE_CHANNEL_CONTRACT_ID;
      readonly contractVersion: typeof CANDIDATE_CHANNEL_CONTRACT_VERSION;
      readonly channel: RetrievalTraceChannel;
      readonly outcome: 'success';
      readonly candidateCount: number;
    }
  | {
      readonly contractId: typeof CANDIDATE_CHANNEL_CONTRACT_ID;
      readonly contractVersion: typeof CANDIDATE_CHANNEL_CONTRACT_VERSION;
      readonly channel: RetrievalTraceChannel;
      readonly outcome: 'safe-failure';
      readonly code: CandidateChannelFailureCodeV1;
    };

export interface CandidateChannelExecutionResultV1 {
  readonly contractId: typeof CANDIDATE_CHANNEL_CONTRACT_ID;
  readonly contractVersion: typeof CANDIDATE_CHANNEL_CONTRACT_VERSION;
  readonly request: CandidateChannelRequestV1;
  readonly candidates: readonly CandidateChannelCandidateV1[];
  readonly settlements: readonly CandidateChannelSettlementV1[];
}

export type CandidateChannelContractErrorCodeV1 = 'invalid-request' | 'invalid-roster' | 'invalid-result';

export class CandidateChannelContractError extends Error {
  constructor(readonly code: CandidateChannelContractErrorCodeV1) {
    super(`candidate_channel_contract:${code}`);
    this.name = 'CandidateChannelContractError';
  }
}

class InvalidValue extends Error {}
class BudgetExceeded extends Error {}

function frozenRecord<T extends object>(source: T): T {
  const output = INTRINSIC_OBJECT_CREATE(null) as Record<PropertyKey, unknown>;
  const keys = INTRINSIC_REFLECT_OWN_KEYS(source);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    const descriptor = INTRINSIC_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(source, key);
    if (descriptor === undefined || !INTRINSIC_OBJECT_HAS_OWN(descriptor, 'value')) {
      throw new InvalidValue();
    }
    output[key] = descriptor.value;
  }
  return INTRINSIC_OBJECT_FREEZE(output) as T;
}

function ownDataValue(record: object, key: PropertyKey): unknown {
  const descriptor = INTRINSIC_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(record, key);
  return descriptor !== undefined && INTRINSIC_OBJECT_HAS_OWN(descriptor, 'value')
    ? descriptor.value
    : undefined;
}

function isPrivateParserError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || INTRINSIC_NODE_IS_PROXY(error)) return false;
  const prototype = INTRINSIC_OBJECT_GET_PROTOTYPE_OF(error);
  return prototype === InvalidValue.prototype || prototype === BudgetExceeded.prototype;
}

function isBudgetError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && !INTRINSIC_NODE_IS_PROXY(error)
    && INTRINSIC_OBJECT_GET_PROTOTYPE_OF(error) === BudgetExceeded.prototype;
}

function arrayContains<T>(values: readonly T[], value: T): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) return true;
  }
  return false;
}

function sortedCodeUnitCopy(values: readonly string[]): readonly string[] {
  const output: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    let destination = output.length;
    while (destination > 0 && output[destination - 1]! > value) {
      output[destination] = output[destination - 1]!;
      destination -= 1;
    }
    output[destination] = value;
  }
  return INTRINSIC_OBJECT_FREEZE(output);
}

interface ParseState {
  readonly seen: WeakSet<object>;
  readonly active: WeakSet<object>;
  values: number;
  entries: number;
  keys: number;
  stringBytes: number;
}

interface EnteredRecord {
  readonly source: object;
  readonly snapshot: Record<string, unknown>;
}

function freshState(): ParseState {
  const state: ParseState = {
    seen: new INTRINSIC_WEAK_SET(),
    active: new INTRINSIC_WEAK_SET(),
    values: 0,
    entries: 0,
    keys: 0,
    stringBytes: 0,
  };
  INTRINSIC_OBJECT_SET_PROTOTYPE_OF(state, null);
  return state;
}

function countValue(state: ParseState, depth: number): void {
  state.values += 1;
  if (depth > MAX_GRAPH_DEPTH || state.values > MAX_GRAPH_VALUES) throw new BudgetExceeded();
}

function plainPrototype(value: object): boolean {
  const prototype = INTRINSIC_OBJECT_GET_PROTOTYPE_OF(value);
  return prototype === INTRINSIC_OBJECT_PROTOTYPE || prototype === null;
}

function enterRecord(
  input: unknown,
  allowed: readonly string[],
  required: readonly string[],
  state: ParseState,
  depth: number,
): EnteredRecord {
  try {
    countValue(state, depth);
    if (typeof input !== 'object' || input === null || INTRINSIC_NODE_IS_PROXY(input)
      || INTRINSIC_ARRAY_IS_ARRAY(input) || INTRINSIC_ARRAY_BUFFER_IS_VIEW(input) || !plainPrototype(input)) {
      throw new InvalidValue();
    }
    if (INTRINSIC_WEAK_SET_HAS(state.active, input) || INTRINSIC_WEAK_SET_HAS(state.seen, input)) {
      throw new InvalidValue();
    }
    const keys = INTRINSIC_REFLECT_OWN_KEYS(input);
    state.keys += keys.length;
    if (state.keys > MAX_GRAPH_KEYS) throw new BudgetExceeded();
    if (keys.length > allowed.length) throw new InvalidValue();
    const allowedSet = new INTRINSIC_SET<string>();
    for (let index = 0; index < allowed.length; index += 1) {
      INTRINSIC_SET_ADD(allowedSet, allowed[index]!);
    }
    const stringKeys: string[] = [];
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index]!;
      if (typeof key !== 'string' || !INTRINSIC_SET_HAS(allowedSet, key)) throw new InvalidValue();
      stringKeys[stringKeys.length] = key;
    }
    for (let index = 0; index < required.length; index += 1) {
      if (!arrayContains(stringKeys, required[index]!)) throw new InvalidValue();
    }
    const snapshot = INTRINSIC_OBJECT_CREATE(null) as Record<string, unknown>;
    for (let index = 0; index < stringKeys.length; index += 1) {
      const key = stringKeys[index]!;
      const descriptor = INTRINSIC_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(input, key);
      if (descriptor === undefined
        || !INTRINSIC_OBJECT_HAS_OWN(descriptor, 'value')
        || descriptor.enumerable !== true) throw new InvalidValue();
      snapshot[key] = descriptor.value;
    }
    INTRINSIC_WEAK_SET_ADD(state.seen, input);
    INTRINSIC_WEAK_SET_ADD(state.active, input);
    return frozenRecord({ source: input, snapshot });
  } catch (error) {
    if (isPrivateParserError(error)) throw error;
    throw new InvalidValue();
  }
}

function leaveRecord(entered: EnteredRecord, state: ParseState): void {
  INTRINSIC_WEAK_SET_DELETE(state.active, entered.source);
}

function exactVariant(snapshot: Record<string, unknown>, expected: readonly string[]): void {
  const keys = INTRINSIC_REFLECT_OWN_KEYS(snapshot);
  if (keys.length !== expected.length) throw new InvalidValue();
  for (let index = 0; index < expected.length; index += 1) {
    if (!INTRINSIC_OBJECT_HAS_OWN(snapshot, expected[index]!)) throw new InvalidValue();
  }
}

function denseArray<T>(
  input: unknown,
  min: number,
  max: number,
  state: ParseState,
  depth: number,
  parse: (value: unknown, index: number) => T,
): readonly T[] {
  try {
    countValue(state, depth);
    if (typeof input !== 'object' || input === null || INTRINSIC_NODE_IS_PROXY(input)
      || !INTRINSIC_ARRAY_IS_ARRAY(input) || INTRINSIC_ARRAY_BUFFER_IS_VIEW(input)
      || INTRINSIC_OBJECT_GET_PROTOTYPE_OF(input) !== INTRINSIC_ARRAY_PROTOTYPE) throw new InvalidValue();
    if (INTRINSIC_WEAK_SET_HAS(state.active, input) || INTRINSIC_WEAK_SET_HAS(state.seen, input)) {
      throw new InvalidValue();
    }
    const lengthDescriptor = INTRINSIC_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(input, 'length');
    if (lengthDescriptor === undefined || !INTRINSIC_OBJECT_HAS_OWN(lengthDescriptor, 'value')
      || !INTRINSIC_NUMBER_IS_SAFE_INTEGER(lengthDescriptor.value)) throw new InvalidValue();
    const length = lengthDescriptor.value as number;
    if (length < min) throw new InvalidValue();
    if (length > max) throw new BudgetExceeded();
    state.entries += length;
    if (state.entries > MAX_GRAPH_ENTRIES) throw new BudgetExceeded();
    const keys = INTRINSIC_REFLECT_OWN_KEYS(input);
    state.keys += keys.length;
    if (keys.length !== length + 1 || state.keys > MAX_GRAPH_KEYS) throw new InvalidValue();
    INTRINSIC_WEAK_SET_ADD(state.seen, input);
    INTRINSIC_WEAK_SET_ADD(state.active, input);
    try {
      const result: T[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = INTRINSIC_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(input, INTRINSIC_STRING(index));
        if (descriptor === undefined
          || !INTRINSIC_OBJECT_HAS_OWN(descriptor, 'value')
          || descriptor.enumerable !== true) throw new InvalidValue();
        result[index] = parse(descriptor.value, index);
      }
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index]!;
        if (key === 'length') continue;
        if (typeof key !== 'string' || INTRINSIC_REGEXP_EXEC(/^(0|[1-9]\d*)$/, key) === null
          || INTRINSIC_NUMBER(key) >= length) {
          throw new InvalidValue();
        }
      }
      return INTRINSIC_OBJECT_FREEZE(result);
    } finally {
      INTRINSIC_WEAK_SET_DELETE(state.active, input);
    }
  } catch (error) {
    if (isPrivateParserError(error)) throw error;
    throw new InvalidValue();
  }
}

function stringValue(
  input: unknown,
  maxBytes: number,
  state: ParseState,
  depth: number,
  pattern?: RegExp,
  allowEmpty = false,
): string {
  countValue(state, depth);
  if (typeof input !== 'string' || (!allowEmpty && input.length === 0)) throw new InvalidValue();
  if (input.length > maxBytes) throw new BudgetExceeded();
  for (let index = 0; index < input.length; index += 1) {
    const code = INTRINSIC_STRING_CHAR_CODE_AT(input, index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < input.length ? INTRINSIC_STRING_CHAR_CODE_AT(input, index + 1) : -1;
      if (next < 0xdc00 || next > 0xdfff) throw new InvalidValue();
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new InvalidValue();
    }
  }
  const bytes = INTRINSIC_BUFFER_BYTE_LENGTH(input, 'utf8');
  if (bytes > maxBytes) throw new BudgetExceeded();
  if (pattern !== undefined && INTRINSIC_REGEXP_EXEC(pattern, input) === null) throw new InvalidValue();
  state.stringBytes += bytes;
  if (state.stringBytes > CANDIDATE_CHANNEL_MAX_AGGREGATE_STRING_BYTES) throw new BudgetExceeded();
  return input;
}

function literal<T extends string>(input: unknown, values: readonly T[], state: ParseState, depth: number): T {
  const value = stringValue(input, 64, state, depth);
  if (!arrayContains(values, value as T)) throw new InvalidValue();
  return value as T;
}

function safeInteger(input: unknown, min: number, max: number, state: ParseState, depth: number): number {
  countValue(state, depth);
  if (typeof input !== 'number' || !INTRINSIC_NUMBER_IS_SAFE_INTEGER(input) || INTRINSIC_OBJECT_IS(input, -0)
    || input < min || input > max) throw new InvalidValue();
  return input;
}

function canonicalScore(input: unknown, state: ParseState, depth: number): number {
  countValue(state, depth);
  if (typeof input !== 'number' || !INTRINSIC_NUMBER_IS_FINITE(input) || INTRINSIC_OBJECT_IS(input, -0)
    || INTRINSIC_MATH_ABS(input) > MAX_SCORE_MAGNITUDE
    || (INTRINSIC_NUMBER_IS_INTEGER(input) && !INTRINSIC_NUMBER_IS_SAFE_INTEGER(input))) {
    throw new InvalidValue();
  }
  const rounded = INTRINSIC_NUMBER(INTRINSIC_NUMBER_TO_FIXED(input, 6));
  return INTRINSIC_OBJECT_IS(rounded, -0) ? 0 : rounded;
}

function channelValue(input: unknown, state: ParseState, depth: number): RetrievalTraceChannel {
  return literal(input, RETRIEVAL_TRACE_CHANNEL_ORDER, state, depth);
}

function temporalFrame(
  input: unknown,
  state: ParseState,
  depth: number,
): CandidateChannelTemporalFrameV1 {
  const entered = enterRecord(input, ['mode', 'asOf'], ['mode'], state, depth);
  try {
    const mode = literal(entered.snapshot.mode, ['current', 'as-of'] as const, state, depth + 1);
    if (mode === 'current') {
      exactVariant(entered.snapshot, ['mode']);
      return frozenRecord({ mode });
    }
    exactVariant(entered.snapshot, ['mode', 'asOf']);
    const asOf = stringValue(entered.snapshot.asOf, 32, state, depth + 1);
    const parsed = new INTRINSIC_DATE(asOf);
    if (!INTRINSIC_NUMBER_IS_FINITE(INTRINSIC_DATE_GET_TIME(parsed))
      || INTRINSIC_DATE_TO_ISO_STRING(parsed) !== asOf) throw new InvalidValue();
    return frozenRecord({ mode, asOf });
  } finally {
    leaveRecord(entered, state);
  }
}

function sameTemporal(
  left: CandidateChannelTemporalFrameV1,
  right: CandidateChannelTemporalFrameV1,
): boolean {
  return left.mode === right.mode
    && (left.mode === 'current' || (right.mode === 'as-of' && left.asOf === right.asOf));
}

function limitsValue(input: unknown, state: ParseState, depth: number): CandidateChannelLimitsV1 {
  if (input === undefined) {
    return frozenRecord({
      maxCandidatesPerChannel: CANDIDATE_CHANNEL_MAX_PER_CHANNEL,
      maxCandidatesAggregate: CANDIDATE_CHANNEL_DEFAULT_AGGREGATE,
    });
  }
  const keys = ['maxCandidatesPerChannel', 'maxCandidatesAggregate'] as const;
  const entered = enterRecord(input, keys, keys, state, depth);
  try {
    return frozenRecord({
      maxCandidatesPerChannel: safeInteger(
        entered.snapshot.maxCandidatesPerChannel,
        1,
        CANDIDATE_CHANNEL_MAX_PER_CHANNEL,
        state,
        depth + 1,
      ),
      maxCandidatesAggregate: safeInteger(
        entered.snapshot.maxCandidatesAggregate,
        1,
        CANDIDATE_CHANNEL_MAX_AGGREGATE,
        state,
        depth + 1,
      ),
    });
  } finally {
    leaveRecord(entered, state);
  }
}

function parseRequest(input: unknown): CandidateChannelRequestV1 {
  const state = freshState();
  const allowed = [
    'contractId', 'contractVersion', 'tenantId', 'projectScope', 'resolvedEntityIds',
    'temporalFrame', 'plannedChannels', 'limits',
  ] as const;
  const required = [
    'contractId', 'contractVersion', 'tenantId', 'projectScope', 'resolvedEntityIds',
    'temporalFrame', 'plannedChannels',
  ] as const;
  const entered = enterRecord(input, allowed, required, state, 0);
  try {
    if (literal(entered.snapshot.contractId, [CANDIDATE_CHANNEL_CONTRACT_ID], state, 1)
      !== CANDIDATE_CHANNEL_CONTRACT_ID
      || literal(entered.snapshot.contractVersion, [CANDIDATE_CHANNEL_CONTRACT_VERSION], state, 1)
      !== CANDIDATE_CHANNEL_CONTRACT_VERSION) throw new InvalidValue();
    const tenantId = stringValue(entered.snapshot.tenantId, MAX_TENANT_ID_BYTES, state, 1, SAFE_TENANT_ID);
    const projectScope = stringValue(
      entered.snapshot.projectScope,
      MAX_PROJECT_SCOPE_BYTES,
      state,
      1,
      CANONICAL_PROJECT_SCOPE,
    );
    const parsedResolvedEntityIds = denseArray(
      entered.snapshot.resolvedEntityIds,
      1,
      MAX_RESOLVED_ENTITY_IDS,
      state,
      1,
      (value) => stringValue(value, 200, state, 2, SAFE_ENTITY_ID),
    );
    const resolvedEntityIdSet = new INTRINSIC_SET<string>();
    for (let index = 0; index < parsedResolvedEntityIds.length; index += 1) {
      const id = parsedResolvedEntityIds[index]!;
      if (INTRINSIC_SET_HAS(resolvedEntityIdSet, id)) throw new InvalidValue();
      INTRINSIC_SET_ADD(resolvedEntityIdSet, id);
    }
    const resolvedEntityIds = sortedCodeUnitCopy(parsedResolvedEntityIds);
    const temporal = temporalFrame(entered.snapshot.temporalFrame, state, 1);
    const planned = denseArray(
      entered.snapshot.plannedChannels,
      1,
      CANDIDATE_CHANNEL_MAX_PLANNED,
      state,
      1,
      (value) => channelValue(value, state, 2),
    );
    const plannedSet = new INTRINSIC_SET<RetrievalTraceChannel>();
    for (let index = 0; index < planned.length; index += 1) {
      const channel = planned[index]!;
      if (INTRINSIC_SET_HAS(plannedSet, channel)) throw new InvalidValue();
      INTRINSIC_SET_ADD(plannedSet, channel);
    }
    const plannedChannelsMutable: RetrievalTraceChannel[] = [];
    for (let registryIndex = 0; registryIndex < RETRIEVAL_TRACE_CHANNEL_ORDER.length; registryIndex += 1) {
      const channel = RETRIEVAL_TRACE_CHANNEL_ORDER[registryIndex]!;
      if (INTRINSIC_SET_HAS(plannedSet, channel)) {
        plannedChannelsMutable[plannedChannelsMutable.length] = channel;
      }
    }
    const plannedChannels = INTRINSIC_OBJECT_FREEZE(plannedChannelsMutable);
    return frozenRecord({
      contractId: CANDIDATE_CHANNEL_CONTRACT_ID,
      contractVersion: CANDIDATE_CHANNEL_CONTRACT_VERSION,
      tenantId,
      projectScope,
      resolvedEntityIds,
      temporalFrame: temporal,
      plannedChannels,
      limits: limitsValue(entered.snapshot.limits, state, 1),
    });
  } finally {
    leaveRecord(entered, state);
  }
}

export function parseCandidateChannelRequestV1(input: unknown): CandidateChannelRequestV1 {
  try {
    return parseRequest(input);
  } catch {
    throw new CandidateChannelContractError('invalid-request');
  }
}

function fixedRecord(entries: readonly (readonly [string, unknown])[]): Record<string, unknown> {
  const output = INTRINSIC_OBJECT_CREATE(null) as Record<string, unknown>;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    output[entry[0]] = entry[1];
  }
  return output;
}

function fixedArray<T, U>(values: readonly T[], convert: (value: T) => U): U[] {
  const output: U[] = [];
  for (let index = 0; index < values.length; index += 1) output[index] = convert(values[index]!);
  INTRINSIC_OBJECT_SET_PROTOTYPE_OF(output, null);
  return output;
}

function fixedTemporalFrame(value: CandidateChannelTemporalFrameV1): Record<string, unknown> {
  return value.mode === 'current'
    ? fixedRecord([['mode', 'current']])
    : fixedRecord([['mode', 'as-of'], ['asOf', value.asOf]]);
}

function fixedRequest(value: CandidateChannelRequestV1): Record<string, unknown> {
  return fixedRecord([
    ['contractId', value.contractId],
    ['contractVersion', value.contractVersion],
    ['tenantId', value.tenantId],
    ['projectScope', value.projectScope],
    ['resolvedEntityIds', fixedArray(value.resolvedEntityIds, (item) => item)],
    ['temporalFrame', fixedTemporalFrame(value.temporalFrame)],
    ['plannedChannels', fixedArray(value.plannedChannels, (item) => item)],
    ['limits', fixedRecord([
      ['maxCandidatesPerChannel', value.limits.maxCandidatesPerChannel],
      ['maxCandidatesAggregate', value.limits.maxCandidatesAggregate],
    ])],
  ]);
}

export function canonicalCandidateChannelRequestV1(input: unknown): string {
  return INTRINSIC_JSON_STRINGIFY(fixedRequest(parseCandidateChannelRequestV1(input)));
}

function parseRoster(
  input: unknown,
  request: CandidateChannelRequestV1,
): readonly CandidateChannelRunnerRegistrationV1[] {
  const state = freshState();
  const roster = denseArray(
    input,
    request.plannedChannels.length,
    CANDIDATE_CHANNEL_MAX_PLANNED,
    state,
    0,
    (value) => {
      const entered = enterRecord(value, ['channel', 'run'], ['channel', 'run'], state, 1);
      try {
        const channel = channelValue(entered.snapshot.channel, state, 2);
        const run = entered.snapshot.run;
        countValue(state, 2);
        if (typeof run !== 'function' || INTRINSIC_NODE_IS_PROXY(run)) throw new InvalidValue();
        return frozenRecord({ channel, run: run as CandidateChannelRunnerV1 });
      } finally {
        leaveRecord(entered, state);
      }
    },
  );
  if (roster.length !== request.plannedChannels.length) throw new InvalidValue();
  const ordered: CandidateChannelRunnerRegistrationV1[] = [];
  const seen = new INTRINSIC_SET<RetrievalTraceChannel>();
  for (let index = 0; index < roster.length; index += 1) {
    const entry = roster[index]!;
    if (!arrayContains(request.plannedChannels, entry.channel) || INTRINSIC_SET_HAS(seen, entry.channel)) {
      throw new InvalidValue();
    }
    INTRINSIC_SET_ADD(seen, entry.channel);
  }
  for (let plannedIndex = 0; plannedIndex < request.plannedChannels.length; plannedIndex += 1) {
    const channel = request.plannedChannels[plannedIndex]!;
    let found: CandidateChannelRunnerRegistrationV1 | undefined;
    for (let rosterIndex = 0; rosterIndex < roster.length; rosterIndex += 1) {
      if (roster[rosterIndex]!.channel === channel) found = roster[rosterIndex]!;
    }
    if (found === undefined) throw new InvalidValue();
    ordered[ordered.length] = found;
  }
  return INTRINSIC_OBJECT_FREEZE(ordered);
}

const PROVENANCE_ID_KEY: Readonly<Record<RetrievalTraceSourceType, string>> = frozenRecord({
  semantic: 'semanticId',
  episodic: 'episodeId',
  symbol: 'symbolId',
  arch_entity: 'entityId',
  aspect: 'aspectId',
  fact: 'factId',
  block: 'blockId',
});

const CHANNEL_SOURCE_TYPE: Readonly<Record<RetrievalTraceChannel, RetrievalTraceSourceType>> = frozenRecord({
  'memory.scope': 'semantic',
  'memory.semantic-vector': 'semantic',
  'memory.episodic-vector': 'episodic',
  'memory.fact': 'fact',
  'memory.block': 'block',
  'memory.graph': 'semantic',
  'code.fulltext': 'symbol',
  'code.lexical-vector': 'symbol',
  'code.dense-vector': 'symbol',
  'code.semantic-vector': 'symbol',
  'arch.fulltext': 'arch_entity',
  'arch.hierarchy': 'arch_entity',
  'arch.dependency': 'arch_entity',
  'arch.aspect': 'aspect',
  'arch.entity': 'arch_entity',
});

function provenanceValue(
  input: unknown,
  sourceType: RetrievalTraceSourceType,
  state: ParseState,
  depth: number,
): CandidateChannelProvenanceV1 {
  const idKey = PROVENANCE_ID_KEY[sourceType];
  const entered = enterRecord(input, ['kind', idKey], ['kind', idKey], state, depth);
  try {
    if (literal(entered.snapshot.kind, SOURCE_TYPES, state, depth + 1) !== sourceType) {
      throw new InvalidValue();
    }
    const id = stringValue(
      entered.snapshot[idKey],
      MAX_EVIDENCE_ID_BYTES,
      state,
      depth + 1,
      SAFE_EVIDENCE_ID,
    );
    return frozenRecord({ kind: sourceType, [idKey]: id }) as CandidateChannelProvenanceV1;
  } finally {
    leaveRecord(entered, state);
  }
}

function candidateValue(
  input: unknown,
  request: CandidateChannelRequestV1,
  channel: RetrievalTraceChannel,
  state: ParseState,
  depth: number,
): CandidateChannelCandidateV1 {
  const keys = [
    'contractId', 'contractVersion', 'channel', 'tenantId', 'projectScope', 'resolvedEntityId',
    'temporalFrame', 'sourceType', 'evidenceId', 'rank', 'score', 'title', 'content', 'provenance',
  ] as const;
  const entered = enterRecord(input, keys, keys, state, depth);
  try {
    if (literal(entered.snapshot.contractId, [CANDIDATE_CHANNEL_CONTRACT_ID], state, depth + 1)
      !== CANDIDATE_CHANNEL_CONTRACT_ID
      || literal(entered.snapshot.contractVersion, [CANDIDATE_CHANNEL_CONTRACT_VERSION], state, depth + 1)
      !== CANDIDATE_CHANNEL_CONTRACT_VERSION
      || channelValue(entered.snapshot.channel, state, depth + 1) !== channel) throw new InvalidValue();
    const tenantId = stringValue(entered.snapshot.tenantId, MAX_TENANT_ID_BYTES, state, depth + 1, SAFE_TENANT_ID);
    const projectScope = stringValue(
      entered.snapshot.projectScope,
      MAX_PROJECT_SCOPE_BYTES,
      state,
      depth + 1,
      CANONICAL_PROJECT_SCOPE,
    );
    const resolvedEntityId = stringValue(
      entered.snapshot.resolvedEntityId,
      200,
      state,
      depth + 1,
      SAFE_ENTITY_ID,
    );
    const temporal = temporalFrame(entered.snapshot.temporalFrame, state, depth + 1);
    if (tenantId !== request.tenantId || projectScope !== request.projectScope
      || !arrayContains(request.resolvedEntityIds, resolvedEntityId)
      || !sameTemporal(temporal, request.temporalFrame)) throw new InvalidValue();
    const sourceType = literal(entered.snapshot.sourceType, SOURCE_TYPES, state, depth + 1);
    if (sourceType !== CHANNEL_SOURCE_TYPE[channel]) throw new InvalidValue();
    const evidenceId = stringValue(
      entered.snapshot.evidenceId,
      MAX_EVIDENCE_ID_BYTES,
      state,
      depth + 1,
      SAFE_EVIDENCE_ID,
    );
    const provenance = provenanceValue(entered.snapshot.provenance, sourceType, state, depth + 1);
    if ((provenance as unknown as Readonly<Record<string, unknown>>)[PROVENANCE_ID_KEY[sourceType]]
      !== evidenceId) throw new InvalidValue();
    return frozenRecord({
      contractId: CANDIDATE_CHANNEL_CONTRACT_ID,
      contractVersion: CANDIDATE_CHANNEL_CONTRACT_VERSION,
      channel,
      tenantId,
      projectScope,
      resolvedEntityId,
      temporalFrame: temporal,
      sourceType,
      evidenceId,
      rank: safeInteger(entered.snapshot.rank, 1, CANDIDATE_CHANNEL_MAX_PER_CHANNEL, state, depth + 1),
      score: canonicalScore(entered.snapshot.score, state, depth + 1),
      title: stringValue(
        entered.snapshot.title,
        CANDIDATE_CHANNEL_MAX_STRING_BYTES,
        state,
        depth + 1,
        undefined,
        true,
      ),
      content: stringValue(
        entered.snapshot.content,
        CANDIDATE_CHANNEL_MAX_STRING_BYTES,
        state,
        depth + 1,
        undefined,
        true,
      ),
      provenance,
    });
  } finally {
    leaveRecord(entered, state);
  }
}

interface ParsedRunnerSuccess {
  readonly kind: 'success';
  readonly candidates: readonly CandidateChannelCandidateV1[];
  readonly stringBytes: number;
}

interface ParsedRunnerFailure {
  readonly kind: 'safe-failure';
  readonly code: CandidateChannelExplicitFailureCodeV1;
}

function parseRunnerResult(
  input: unknown,
  request: CandidateChannelRequestV1,
  channel: RetrievalTraceChannel,
): ParsedRunnerSuccess | ParsedRunnerFailure {
  const state = freshState();
  const entered = enterRecord(
    input,
    ['contractId', 'contractVersion', 'channel', 'outcome', 'candidateCount', 'candidates', 'code'],
    ['contractId', 'contractVersion', 'channel', 'outcome'],
    state,
    0,
  );
  try {
    if (literal(entered.snapshot.contractId, [CANDIDATE_CHANNEL_CONTRACT_ID], state, 1)
      !== CANDIDATE_CHANNEL_CONTRACT_ID
      || literal(entered.snapshot.contractVersion, [CANDIDATE_CHANNEL_CONTRACT_VERSION], state, 1)
      !== CANDIDATE_CHANNEL_CONTRACT_VERSION
      || channelValue(entered.snapshot.channel, state, 1) !== channel) throw new InvalidValue();
    const outcome = literal(entered.snapshot.outcome, ['success', 'safe-failure'] as const, state, 1);
    if (outcome === 'safe-failure') {
      exactVariant(entered.snapshot, ['contractId', 'contractVersion', 'channel', 'outcome', 'code']);
      return frozenRecord({
        kind: 'safe-failure',
        code: literal(entered.snapshot.code, EXPLICIT_FAILURE_CODES, state, 1),
      });
    }
    exactVariant(entered.snapshot, [
      'contractId', 'contractVersion', 'channel', 'outcome', 'candidateCount', 'candidates',
    ]);
    const candidateCount = safeInteger(
      entered.snapshot.candidateCount,
      0,
      INTRINSIC_NUMBER_MAX_SAFE_INTEGER,
      state,
      1,
    );
    if (candidateCount > request.limits.maxCandidatesPerChannel) throw new BudgetExceeded();
    const candidates = denseArray(
      entered.snapshot.candidates,
      0,
      request.limits.maxCandidatesPerChannel,
      state,
      1,
      (value) => candidateValue(value, request, channel, state, 2),
    );
    if (candidateCount !== candidates.length) throw new InvalidValue();
    const evidenceIds = new INTRINSIC_SET<string>();
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]!;
      if (candidate.rank !== index + 1 || INTRINSIC_SET_HAS(evidenceIds, candidate.evidenceId)) {
        throw new InvalidValue();
      }
      INTRINSIC_SET_ADD(evidenceIds, candidate.evidenceId);
    }
    return frozenRecord({ kind: 'success', candidates, stringBytes: state.stringBytes });
  } finally {
    leaveRecord(entered, state);
  }
}

function fixedProvenance(value: CandidateChannelProvenanceV1): Record<string, unknown> {
  const idKey = PROVENANCE_ID_KEY[value.kind];
  return fixedRecord([
    ['kind', value.kind],
    [idKey, (value as unknown as Readonly<Record<string, unknown>>)[idKey]],
  ]);
}

function fixedCandidate(value: CandidateChannelCandidateV1): Record<string, unknown> {
  return fixedRecord([
    ['contractId', value.contractId],
    ['contractVersion', value.contractVersion],
    ['channel', value.channel],
    ['tenantId', value.tenantId],
    ['projectScope', value.projectScope],
    ['resolvedEntityId', value.resolvedEntityId],
    ['temporalFrame', fixedTemporalFrame(value.temporalFrame)],
    ['sourceType', value.sourceType],
    ['evidenceId', value.evidenceId],
    ['rank', value.rank],
    ['score', value.score],
    ['title', value.title],
    ['content', value.content],
    ['provenance', fixedProvenance(value.provenance)],
  ]);
}

function canonicalParsedRunnerResult(
  parsed: ParsedRunnerSuccess | ParsedRunnerFailure,
  channel: RetrievalTraceChannel,
): CandidateChannelSerializedResultV1 {
  const trusted = parsed.kind === 'safe-failure'
    ? fixedRecord([
        ['contractId', CANDIDATE_CHANNEL_CONTRACT_ID],
        ['contractVersion', CANDIDATE_CHANNEL_CONTRACT_VERSION],
        ['channel', channel],
        ['outcome', 'safe-failure'],
        ['code', parsed.code],
      ])
    : fixedRecord([
        ['contractId', CANDIDATE_CHANNEL_CONTRACT_ID],
        ['contractVersion', CANDIDATE_CHANNEL_CONTRACT_VERSION],
        ['channel', channel],
        ['outcome', 'success'],
        ['candidateCount', parsed.candidates.length],
        ['candidates', fixedArray(parsed.candidates, fixedCandidate)],
      ]);
  return INTRINSIC_JSON_STRINGIFY(trusted) as CandidateChannelSerializedResultV1;
}

export function canonicalCandidateChannelRunnerResultV1(
  input: unknown,
  requestInput: unknown,
  channelInput: unknown,
): CandidateChannelSerializedResultV1 {
  const request = parseCandidateChannelRequestV1(requestInput);
  try {
    const channelState = freshState();
    const channel = channelValue(channelInput, channelState, 0);
    if (!arrayContains(request.plannedChannels, channel)) throw new InvalidValue();
    return canonicalParsedRunnerResult(parseRunnerResult(input, request, channel), channel);
  } catch {
    throw new CandidateChannelContractError('invalid-result');
  }
}

interface JsonLexicalState {
  index: number;
  values: number;
  entries: number;
  keys: number;
}

function skipJsonWhitespace(input: string, state: JsonLexicalState): void {
  while (state.index < input.length) {
    const code = INTRINSIC_STRING_CHAR_CODE_AT(input, state.index);
    if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return;
    state.index += 1;
  }
}

function scanJsonString(input: string, state: JsonLexicalState, decode: boolean): string {
  if (INTRINSIC_STRING_CHAR_CODE_AT(input, state.index) !== 0x22) throw new InvalidValue();
  state.index += 1;
  let decoded = '';
  while (state.index < input.length) {
    const code = INTRINSIC_STRING_CHAR_CODE_AT(input, state.index);
    state.index += 1;
    if (code === 0x22) return decoded;
    if (code < 0x20) throw new InvalidValue();
    if (code !== 0x5c) {
      if (decode) decoded += INTRINSIC_STRING_FROM_CHAR_CODE(code);
      if (decode && decoded.length > CANDIDATE_CHANNEL_MAX_STRING_BYTES) throw new BudgetExceeded();
      continue;
    }
    if (state.index >= input.length) throw new InvalidValue();
    const escaped = INTRINSIC_STRING_CHAR_CODE_AT(input, state.index);
    state.index += 1;
    if (escaped === 0x75) {
      if (state.index + 4 > input.length) throw new InvalidValue();
      const hex = INTRINSIC_STRING_SLICE(input, state.index, state.index + 4);
      if (INTRINSIC_REGEXP_EXEC(/^[0-9a-fA-F]{4}$/, hex) === null) throw new InvalidValue();
      if (decode) decoded += INTRINSIC_STRING_FROM_CHAR_CODE(INTRINSIC_NUMBER_PARSE_INT(hex, 16));
      if (decode && decoded.length > CANDIDATE_CHANNEL_MAX_STRING_BYTES) throw new BudgetExceeded();
      state.index += 4;
      continue;
    }
    const simple = escaped === 0x22 ? '"'
      : escaped === 0x5c ? '\\'
        : escaped === 0x2f ? '/'
          : escaped === 0x62 ? '\b'
            : escaped === 0x66 ? '\f'
              : escaped === 0x6e ? '\n'
                : escaped === 0x72 ? '\r'
                  : escaped === 0x74 ? '\t'
                    : undefined;
    if (simple === undefined) throw new InvalidValue();
    if (decode) decoded += simple;
    if (decode && decoded.length > CANDIDATE_CHANNEL_MAX_STRING_BYTES) throw new BudgetExceeded();
  }
  throw new InvalidValue();
}

function scanJsonNumber(input: string, state: JsonLexicalState): void {
  const start = state.index;
  if (INTRINSIC_STRING_CHAR_CODE_AT(input, state.index) === 0x2d) state.index += 1;
  if (INTRINSIC_STRING_CHAR_CODE_AT(input, state.index) === 0x30) {
    state.index += 1;
    const next = INTRINSIC_STRING_CHAR_CODE_AT(input, state.index);
    if (next >= 0x30 && next <= 0x39) throw new InvalidValue();
  } else {
    const first = INTRINSIC_STRING_CHAR_CODE_AT(input, state.index);
    if (first < 0x31 || first > 0x39) throw new InvalidValue();
    do { state.index += 1; } while (
      INTRINSIC_STRING_CHAR_CODE_AT(input, state.index) >= 0x30
      && INTRINSIC_STRING_CHAR_CODE_AT(input, state.index) <= 0x39
    );
  }
  if (INTRINSIC_STRING_CHAR_CODE_AT(input, state.index) === 0x2e) {
    state.index += 1;
    const firstFraction = INTRINSIC_STRING_CHAR_CODE_AT(input, state.index);
    if (firstFraction < 0x30 || firstFraction > 0x39) throw new InvalidValue();
    do { state.index += 1; } while (
      INTRINSIC_STRING_CHAR_CODE_AT(input, state.index) >= 0x30
      && INTRINSIC_STRING_CHAR_CODE_AT(input, state.index) <= 0x39
    );
  }
  const exponent = INTRINSIC_STRING_CHAR_CODE_AT(input, state.index);
  if (exponent === 0x65 || exponent === 0x45) {
    state.index += 1;
    const sign = INTRINSIC_STRING_CHAR_CODE_AT(input, state.index);
    if (sign === 0x2b || sign === 0x2d) state.index += 1;
    const firstExponent = INTRINSIC_STRING_CHAR_CODE_AT(input, state.index);
    if (firstExponent < 0x30 || firstExponent > 0x39) throw new InvalidValue();
    do { state.index += 1; } while (
      INTRINSIC_STRING_CHAR_CODE_AT(input, state.index) >= 0x30
      && INTRINSIC_STRING_CHAR_CODE_AT(input, state.index) <= 0x39
    );
  }
  if (state.index === start) throw new InvalidValue();
}

function scanJsonValue(input: string, state: JsonLexicalState, depth: number): void {
  state.values += 1;
  if (state.values > MAX_GRAPH_VALUES) throw new BudgetExceeded();
  skipJsonWhitespace(input, state);
  const code = INTRINSIC_STRING_CHAR_CODE_AT(input, state.index);
  if (code === 0x7b) {
    if (depth + 1 > MAX_GRAPH_DEPTH) throw new BudgetExceeded();
    state.index += 1;
    skipJsonWhitespace(input, state);
    const seenKeys = new INTRINSIC_SET<string>();
    if (INTRINSIC_STRING_CHAR_CODE_AT(input, state.index) === 0x7d) { state.index += 1; return; }
    while (true) {
      const key = scanJsonString(input, state, true);
      state.keys += 1;
      if (state.keys > MAX_GRAPH_KEYS) throw new BudgetExceeded();
      if (INTRINSIC_SET_HAS(seenKeys, key)) throw new InvalidValue();
      INTRINSIC_SET_ADD(seenKeys, key);
      skipJsonWhitespace(input, state);
      if (INTRINSIC_STRING_CHAR_CODE_AT(input, state.index) !== 0x3a) throw new InvalidValue();
      state.index += 1;
      scanJsonValue(input, state, depth + 1);
      skipJsonWhitespace(input, state);
      const separator = INTRINSIC_STRING_CHAR_CODE_AT(input, state.index);
      state.index += 1;
      if (separator === 0x7d) return;
      if (separator !== 0x2c) throw new InvalidValue();
      skipJsonWhitespace(input, state);
    }
  }
  if (code === 0x5b) {
    if (depth + 1 > MAX_GRAPH_DEPTH) throw new BudgetExceeded();
    state.index += 1;
    skipJsonWhitespace(input, state);
    if (INTRINSIC_STRING_CHAR_CODE_AT(input, state.index) === 0x5d) { state.index += 1; return; }
    while (true) {
      state.entries += 1;
      if (state.entries > MAX_GRAPH_ENTRIES) throw new BudgetExceeded();
      scanJsonValue(input, state, depth + 1);
      skipJsonWhitespace(input, state);
      const separator = INTRINSIC_STRING_CHAR_CODE_AT(input, state.index);
      state.index += 1;
      if (separator === 0x5d) return;
      if (separator !== 0x2c) throw new InvalidValue();
      skipJsonWhitespace(input, state);
    }
  }
  if (code === 0x22) { scanJsonString(input, state, false); return; }
  const literalValues = ['true', 'false', 'null'] as const;
  for (let index = 0; index < literalValues.length; index += 1) {
    const literalValue = literalValues[index]!;
    if (INTRINSIC_STRING_STARTS_WITH(input, literalValue, state.index)) {
      state.index += literalValue.length;
      return;
    }
  }
  scanJsonNumber(input, state);
}

function scanSerializedJson(input: string): void {
  const state = INTRINSIC_OBJECT_CREATE(null) as JsonLexicalState;
  state.index = 0;
  state.values = 0;
  state.entries = 0;
  state.keys = 0;
  if (INTRINSIC_STRING_CHAR_CODE_AT(input, 0) === 0xfeff) throw new InvalidValue();
  scanJsonValue(input, state, 0);
  skipJsonWhitespace(input, state);
  if (state.index !== input.length) throw new InvalidValue();
}

function parseSerializedRunnerResult(
  input: unknown,
  request: CandidateChannelRequestV1,
  channel: RetrievalTraceChannel,
): ParsedRunnerSuccess | ParsedRunnerFailure {
  if (typeof input !== 'string') throw new InvalidValue();
  if (input.length > CANDIDATE_CHANNEL_MAX_SERIALIZED_BYTES) throw new BudgetExceeded();
  if (INTRINSIC_BUFFER_BYTE_LENGTH(input, 'utf8') > CANDIDATE_CHANNEL_MAX_SERIALIZED_BYTES) {
    throw new BudgetExceeded();
  }
  scanSerializedJson(input);
  let decoded: unknown;
  try {
    decoded = INTRINSIC_JSON_PARSE(input) as unknown;
  } catch {
    throw new InvalidValue();
  }
  const parsed = parseRunnerResult(decoded, request, channel);
  if (canonicalParsedRunnerResult(parsed, channel) !== input) throw new InvalidValue();
  return parsed;
}

function successSettlement(
  channel: RetrievalTraceChannel,
  candidateCount: number,
): CandidateChannelSettlementV1 {
  return frozenRecord({
    contractId: CANDIDATE_CHANNEL_CONTRACT_ID,
    contractVersion: CANDIDATE_CHANNEL_CONTRACT_VERSION,
    channel,
    outcome: 'success',
    candidateCount,
  });
}

function failureSettlement(
  channel: RetrievalTraceChannel,
  code: CandidateChannelFailureCodeV1,
): CandidateChannelSettlementV1 {
  return frozenRecord({
    contractId: CANDIDATE_CHANNEL_CONTRACT_ID,
    contractVersion: CANDIDATE_CHANNEL_CONTRACT_VERSION,
    channel,
    outcome: 'safe-failure',
    code,
  });
}

interface AttemptResult {
  readonly channel: RetrievalTraceChannel;
  readonly parsed?: ParsedRunnerSuccess | ParsedRunnerFailure;
  readonly code?: CandidateChannelFailureCodeV1;
}

function isExactNativePromise(input: object): input is Promise<unknown> {
  try {
    if (INTRINSIC_NODE_IS_PROXY(input) || !INTRINSIC_NODE_IS_PROMISE(input)
      || INTRINSIC_OBJECT_GET_PROTOTYPE_OF(input) !== INTRINSIC_PROMISE_PROTOTYPE) return false;
    const constructorDescriptor = INTRINSIC_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
      INTRINSIC_PROMISE_PROTOTYPE,
      'constructor',
    );
    if (constructorDescriptor === undefined
      || !INTRINSIC_OBJECT_HAS_OWN(constructorDescriptor, 'value')
      || constructorDescriptor.value !== INTRINSIC_PROMISE
      || constructorDescriptor.writable !== INTRINSIC_PROMISE_CONSTRUCTOR_DESCRIPTOR.writable
      || constructorDescriptor.enumerable !== INTRINSIC_PROMISE_CONSTRUCTOR_DESCRIPTOR.enumerable
      || constructorDescriptor.configurable !== INTRINSIC_PROMISE_CONSTRUCTOR_DESCRIPTOR.configurable) return false;
    const speciesDescriptor = INTRINSIC_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
      INTRINSIC_PROMISE,
      INTRINSIC_SYMBOL_SPECIES,
    );
    if (speciesDescriptor === undefined
      || !INTRINSIC_OBJECT_HAS_OWN(speciesDescriptor, 'get')
      || speciesDescriptor.get !== INTRINSIC_PROMISE_SPECIES_DESCRIPTOR.get
      || speciesDescriptor.set !== INTRINSIC_PROMISE_SPECIES_DESCRIPTOR.set
      || speciesDescriptor.enumerable !== INTRINSIC_PROMISE_SPECIES_DESCRIPTOR.enumerable
      || speciesDescriptor.configurable !== INTRINSIC_PROMISE_SPECIES_DESCRIPTOR.configurable) return false;
    return INTRINSIC_REFLECT_OWN_KEYS(input).length === 0;
  } catch {
    return false;
  }
}

function parseAttempt(
  raw: unknown,
  request: CandidateChannelRequestV1,
  channel: RetrievalTraceChannel,
): AttemptResult {
  try {
    return frozenRecord({ channel, parsed: parseRunnerResult(raw, request, channel) });
  } catch (error) {
    return frozenRecord({
      channel,
      code: isBudgetError(error) ? 'budget-exceeded' : 'invalid-result',
    });
  }
}

function parseSerializedAttempt(
  raw: unknown,
  request: CandidateChannelRequestV1,
  channel: RetrievalTraceChannel,
): AttemptResult {
  try {
    return frozenRecord({ channel, parsed: parseSerializedRunnerResult(raw, request, channel) });
  } catch (error) {
    return frozenRecord({
      channel,
      code: isBudgetError(error) ? 'budget-exceeded' : 'invalid-result',
    });
  }
}

interface ObservedPromiseValue {
  readonly fulfilled: boolean;
  readonly value?: unknown;
  readonly timedOut?: true;
}

const EXECUTOR_DEADLINE_OBSERVED: ObservedPromiseValue = frozenRecord({
  fulfilled: false,
  timedOut: true as const,
});

interface PendingAttempt {
  readonly channel: RetrievalTraceChannel;
  readonly observed: Promise<ObservedPromiseValue>;
}

function startAttempt(
  request: CandidateChannelRequestV1,
  channel: RetrievalTraceChannel,
  run: CandidateChannelRunnerV1,
): AttemptResult | PendingAttempt {
  let returned: unknown;
  try {
    returned = run(request);
  } catch {
    return frozenRecord({ channel, code: 'query-failed' });
  }
  if (typeof returned !== 'object' || returned === null) return parseAttempt(returned, request, channel);
  if (INTRINSIC_NODE_IS_PROXY(returned)) return frozenRecord({ channel, code: 'invalid-result' });
  if (!INTRINSIC_NODE_IS_PROMISE(returned)) return parseAttempt(returned, request, channel);
  if (!isExactNativePromise(returned)) return frozenRecord({ channel, code: 'invalid-result' });
  // The backstop is armed here, in the pending branch only: the five returns above
  // would each leave a live handle behind, and arming at await time instead would
  // bound a roster of N hung runners by N deadlines rather than one, because
  // attempts start concurrently and are awaited in order.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    let settle!: (value: ObservedPromiseValue) => void;
    // No Promise combinator: `race`/`resolve` perform Get(C, "resolve") and consult
    // Symbol.species on a runner-supplied promise, which is the exact surface
    // INTRINSIC_PROMISE_SPECIES_DESCRIPTOR and isExactNativePromise exist to remove.
    // A deferred over the captured intrinsic settles the race on resolve-once
    // semantics alone, and satisfies isExactNativePromise itself.
    const observed = new INTRINSIC_PROMISE<ObservedPromiseValue>((resolve) => { settle = resolve; });
    // setTimeout/clearTimeout are resolved at call time, deliberately unlike every
    // other intrinsic in this file: a module-load capture binds the real timer
    // before a test's fake clock is installed, so the deadline could never be
    // exercised. Precedents: runtime-candidate-channel.ts bounded(),
    // fact.ts withFactBatchDeadline(). Promise intrinsics stay captured at load.
    timer = setTimeout(() => { settle(EXECUTOR_DEADLINE_OBSERVED); }, CANDIDATE_CHANNEL_EXECUTOR_DEADLINE_MS);
    timer.unref?.();
    INTRINSIC_PROMISE_THEN(
      returned,
      (value) => { clearTimeout(timer); settle(frozenRecord({ fulfilled: true, value })); },
      () => { clearTimeout(timer); settle(frozenRecord({ fulfilled: false })); },
    );
    return frozenRecord({ channel, observed });
  } catch {
    if (timer !== undefined) clearTimeout(timer);
    return frozenRecord({ channel, code: 'invalid-result' });
  }
}

export async function executeCandidateChannelsV1(
  requestInput: unknown,
  rosterInput: unknown,
): Promise<CandidateChannelExecutionResultV1> {
  const request = parseCandidateChannelRequestV1(requestInput);
  let roster: readonly CandidateChannelRunnerRegistrationV1[];
  try {
    roster = parseRoster(rosterInput, request);
  } catch {
    throw new CandidateChannelContractError('invalid-roster');
  }

  const started: Array<AttemptResult | PendingAttempt> = [];
  for (let index = 0; index < roster.length; index += 1) {
    const registration = roster[index]!;
    started[index] = startAttempt(request, registration.channel, registration.run);
  }
  const attempts: AttemptResult[] = [];
  for (let index = 0; index < started.length; index += 1) {
    const item = started[index]!;
    const pendingObserved = ownDataValue(item, 'observed');
    if (pendingObserved === undefined) {
      attempts[index] = item as AttemptResult;
      continue;
    }
    const pendingChannel = ownDataValue(item, 'channel') as RetrievalTraceChannel;
    if (typeof pendingObserved !== 'object' || pendingObserved === null
      || !isExactNativePromise(pendingObserved)) {
      attempts[index] = frozenRecord({ channel: pendingChannel, code: 'invalid-result' });
      continue;
    }
    // The executor deadline is armed per attempt in startAttempt, at
    // CANDIDATE_CHANNEL_EXECUTOR_DEADLINE_MS; awaiting here is therefore bounded.
    const observed = await pendingObserved;
    if (typeof observed !== 'object' || observed === null) {
      attempts[index] = frozenRecord({ channel: pendingChannel, code: 'invalid-result' });
      continue;
    }
    // Checked before `fulfilled`, which maps everything else to query-failed.
    // A runner cannot forge this: the wrapper record is only ever built by this
    // module's own callbacks, and a runner's fulfilled value is nested at .value
    // and is always a string primitive, since parseSerializedRunnerResult rejects
    // every non-string. ownDataValue reads own data descriptors only, so
    // Object.prototype pollution cannot reach the key either.
    if (ownDataValue(observed, 'timedOut') === true) {
      attempts[index] = frozenRecord({ channel: pendingChannel, code: 'timeout' });
      continue;
    }
    const fulfilled = ownDataValue(observed, 'fulfilled');
    attempts[index] = fulfilled === true
      ? parseSerializedAttempt(ownDataValue(observed, 'value'), request, pendingChannel)
      : frozenRecord({ channel: pendingChannel, code: 'query-failed' });
  }

  const candidates: CandidateChannelCandidateV1[] = [];
  const settlements: CandidateChannelSettlementV1[] = [];
  let acceptedStringBytes = 0;
  for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex += 1) {
    const attempt = attempts[attemptIndex]!;
    const attemptCode = ownDataValue(attempt, 'code') as CandidateChannelFailureCodeV1 | undefined;
    if (attemptCode !== undefined) {
      settlements[settlements.length] = failureSettlement(attempt.channel, attemptCode);
      continue;
    }
    const parsed = ownDataValue(attempt, 'parsed') as ParsedRunnerSuccess | ParsedRunnerFailure;
    if (parsed.kind === 'safe-failure') {
      settlements[settlements.length] = failureSettlement(attempt.channel, parsed.code);
      continue;
    }
    if (candidates.length + parsed.candidates.length > request.limits.maxCandidatesAggregate
      || parsed.stringBytes > CANDIDATE_CHANNEL_MAX_AGGREGATE_STRING_BYTES - acceptedStringBytes) {
      settlements[settlements.length] = failureSettlement(attempt.channel, 'budget-exceeded');
      continue;
    }
    for (let candidateIndex = 0; candidateIndex < parsed.candidates.length; candidateIndex += 1) {
      candidates[candidates.length] = parsed.candidates[candidateIndex]!;
    }
    acceptedStringBytes += parsed.stringBytes;
    settlements[settlements.length] = successSettlement(attempt.channel, parsed.candidates.length);
  }

  return frozenRecord({
    contractId: CANDIDATE_CHANNEL_CONTRACT_ID,
    contractVersion: CANDIDATE_CHANNEL_CONTRACT_VERSION,
    request,
    candidates: INTRINSIC_OBJECT_FREEZE(candidates),
    settlements: INTRINSIC_OBJECT_FREEZE(settlements),
  });
}
