import { types as nodeUtilTypes } from 'node:util';

import {
  parseCandidateChannelRequestV1,
  type CandidateChannelRequestV1,
  type CandidateChannelTemporalFrameV1,
} from './candidate-channel.js';
import { RETRIEVAL_SOURCE_TYPES } from './types.js';

const OBJECT_CREATE = Object.create;
const OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_HAS_OWN = Object.hasOwn;
const OBJECT_PROTOTYPE = Object.prototype;
const ARRAY = Array;
const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_PROTOTYPE = Array.prototype;
const ARRAY_PROTOTYPE_PROTOTYPE = OBJECT_GET_PROTOTYPE_OF(ARRAY_PROTOTYPE);
const OBJECT_PROTOTYPE_PROTOTYPE = OBJECT_GET_PROTOTYPE_OF(OBJECT_PROTOTYPE);
const ARRAY_BUFFER_IS_VIEW = ArrayBuffer.isView;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const NODE_IS_PROXY = nodeUtilTypes.isProxy;
const BUFFER_BYTE_LENGTH = Buffer.byteLength;
const STRING = String;
const STRING_CHAR_CODE_AT = Function.prototype.call.bind(String.prototype.charCodeAt) as (
  input: string,
  index: number,
) => number;
const STRING_PAD_START = Function.prototype.call.bind(String.prototype.padStart) as (
  input: string,
  maxLength: number,
  fillString?: string,
) => string;
const REGEXP_EXEC = Function.prototype.call.bind(RegExp.prototype.exec) as (
  pattern: RegExp,
  input: string,
) => RegExpExecArray | null;
const MAP = Map;
const MAP_GET = Function.prototype.call.bind(Map.prototype.get) as <K, V>(
  map: Map<K, V>,
  key: K,
) => V | undefined;
const MAP_HAS = Function.prototype.call.bind(Map.prototype.has) as <K>(
  map: Map<K, unknown>,
  key: K,
) => boolean;
const MAP_SET = Function.prototype.call.bind(Map.prototype.set) as <K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
) => Map<K, V>;
const SET = Set;
const SET_HAS = Function.prototype.call.bind(Set.prototype.has) as <T>(
  set: Set<T>,
  value: T,
) => boolean;
const SET_ADD = Function.prototype.call.bind(Set.prototype.add) as <T>(
  set: Set<T>,
  value: T,
) => Set<T>;
const WEAK_SET = WeakSet;
const WEAK_SET_HAS = Function.prototype.call.bind(WeakSet.prototype.has) as (
  set: WeakSet<object>,
  value: object,
) => boolean;
const WEAK_SET_ADD = Function.prototype.call.bind(WeakSet.prototype.add) as (
  set: WeakSet<object>,
  value: object,
) => WeakSet<object>;

export const EVIDENCE_POST_FILTER_CONTRACT_ID = 'memberry.evidence-post-filter' as const;
export const EVIDENCE_POST_FILTER_CONTRACT_VERSION = '1.0.0' as const;
export const EVIDENCE_POST_FILTER_MAX_CANDIDATES = 512 as const;
export const EVIDENCE_POST_FILTER_MAX_AGGREGATE_RECEIPT_STRING_BYTES = 1_048_576 as const;

const MAX_TENANT_ID_BYTES = 128;
const MAX_PROJECT_SCOPE_BYTES = 136;
const MAX_ENTITY_ID_BYTES = 200;
const MAX_EVIDENCE_ID_BYTES = 200;
const MAX_TEMPORAL_VALUE_BYTES = 32;
const MAX_LITERAL_BYTES = 64;

const SAFE_TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CANONICAL_PROJECT_SCOPE = /^project:[a-z0-9][a-z0-9._-]*$/;
const SAFE_ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SAFE_EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/;

export type EvidencePostFilterSourceTypeV1 =
  | 'semantic'
  | 'episodic'
  | 'symbol'
  | 'arch_entity'
  | 'aspect'
  | 'fact'
  | 'block';

export interface EvidenceEligibilityReceiptV1 {
  readonly contractId: typeof EVIDENCE_POST_FILTER_CONTRACT_ID;
  readonly version: typeof EVIDENCE_POST_FILTER_CONTRACT_VERSION;
  readonly tenantId: string;
  readonly projectScope: string;
  readonly resolvedEntityId: string;
  readonly temporalFrame: CandidateChannelTemporalFrameV1;
  readonly sourceType: EvidencePostFilterSourceTypeV1;
  readonly evidenceId: string;
  readonly lifecycle: 'active' | 'inactive';
  readonly temporal: 'in-frame' | 'out-of-frame';
  readonly supersession: 'clear' | 'superseded';
  readonly contradiction: 'clear' | 'withheld';
}

export interface EvidencePostFilterCandidateInputV1<T> {
  readonly value: T;
  readonly receipt: EvidenceEligibilityReceiptV1;
}

export interface EvidencePostFilterInputV1<T> {
  readonly request: CandidateChannelRequestV1;
  readonly candidates: readonly EvidencePostFilterCandidateInputV1<T>[];
}

export interface EvidencePostFilterIncludedV1<T> {
  readonly ref: string;
  readonly value: T;
}

export type EvidencePostFilterDecisionV1 =
  | { readonly ref: string; readonly outcome: 'included' }
  | {
      readonly ref: string;
      readonly outcome: 'excluded';
      readonly reason: 'inactive' | 'stale' | 'contradictory';
    }
  | {
      readonly ref: string;
      readonly outcome: 'excluded';
      readonly reason: 'duplicate';
      readonly duplicateOfRef: string;
    };

export interface EvidencePostFilterResultV1<T> {
  readonly contractId: typeof EVIDENCE_POST_FILTER_CONTRACT_ID;
  readonly version: typeof EVIDENCE_POST_FILTER_CONTRACT_VERSION;
  readonly included: readonly EvidencePostFilterIncludedV1<T>[];
  readonly decisions: readonly EvidencePostFilterDecisionV1[];
}

export type EvidencePostFilterContractErrorCodeV1 =
  | 'invalid-request'
  | 'invalid-receipt'
  | 'budget-exceeded';

export class EvidencePostFilterContractError extends Error {
  declare readonly code: EvidencePostFilterContractErrorCodeV1;

  constructor(code: EvidencePostFilterContractErrorCodeV1) {
    super(code);
    OBJECT_DEFINE_PROPERTY(this, 'name', {
      value: 'EvidencePostFilterContractError',
      writable: true,
      enumerable: false,
      configurable: true,
    });
    OBJECT_DEFINE_PROPERTY(this, 'code', {
      value: code,
      writable: false,
      enumerable: true,
      configurable: false,
    });
  }
}

class InvalidStructure extends Error {}
class InvalidReceipt extends Error {}
class BudgetExceeded extends Error {}

type NullRecord = Record<string, unknown>;

interface ReceiptStringBudget {
  bytes: number;
}

interface ParsedCandidate<T> {
  readonly value: T;
  readonly receipt: EvidenceEligibilityReceiptV1;
}

function defineArrayItem<T>(target: T[], index: number, value: T): void {
  OBJECT_DEFINE_PROPERTY(target, STRING(index), {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function numericIndexKeys(): readonly string[] {
  const keys = new ARRAY<string>(EVIDENCE_POST_FILTER_MAX_CANDIDATES);
  for (let index = 0; index < keys.length; index += 1) {
    defineArrayItem(keys, index, STRING(index));
  }
  return OBJECT_FREEZE(keys);
}

const NUMERIC_INDEX_KEYS = numericIndexKeys();

function assertSafeInternalArrayPrototypeChain(): void {
  if (
    OBJECT_GET_PROTOTYPE_OF(ARRAY_PROTOTYPE) !== ARRAY_PROTOTYPE_PROTOTYPE
    || OBJECT_GET_PROTOTYPE_OF(OBJECT_PROTOTYPE) !== OBJECT_PROTOTYPE_PROTOTYPE
  ) {
    throw new InvalidStructure();
  }
  for (let index = 0; index < NUMERIC_INDEX_KEYS.length; index += 1) {
    const key = NUMERIC_INDEX_KEYS[index]!;
    if (
      OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(ARRAY_PROTOTYPE, key) !== undefined
      || OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(OBJECT_PROTOTYPE, key) !== undefined
    ) {
      throw new InvalidStructure();
    }
  }
}

function isPrivateError(error: unknown, prototype: object): boolean {
  return typeof error === 'object'
    && error !== null
    && !NODE_IS_PROXY(error)
    && OBJECT_GET_PROTOTYPE_OF(error) === prototype;
}

function nullRecord<T extends object>(fields: T): Readonly<T> {
  const result = OBJECT_CREATE(null) as T;
  const keys = REFLECT_OWN_KEYS(fields);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(fields, key);
    if (descriptor === undefined || !OBJECT_HAS_OWN(descriptor, 'value')) {
      throw new InvalidStructure();
    }
    OBJECT_DEFINE_PROPERTY(result, key, descriptor);
  }
  return OBJECT_FREEZE(result);
}

function arrayContains<T>(values: readonly T[], value: T): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) return true;
  }
  return false;
}

function closedRecord(
  input: unknown,
  allowed: readonly string[],
  required: readonly string[],
): NullRecord {
  try {
    if (typeof input !== 'object'
      || input === null
      || NODE_IS_PROXY(input)
      || ARRAY_IS_ARRAY(input)
      || ARRAY_BUFFER_IS_VIEW(input)) {
      throw new InvalidStructure();
    }
    const prototype = OBJECT_GET_PROTOTYPE_OF(input);
    if (prototype !== OBJECT_PROTOTYPE && prototype !== null) throw new InvalidStructure();
    const keys = REFLECT_OWN_KEYS(input);
    if (keys.length > allowed.length) throw new InvalidStructure();
    const snapshot = OBJECT_CREATE(null) as NullRecord;
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index]!;
      if (typeof key !== 'string' || !arrayContains(allowed, key)) throw new InvalidStructure();
      const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(input, key);
      if (descriptor === undefined
        || !OBJECT_HAS_OWN(descriptor, 'value')
        || descriptor.enumerable !== true) {
        throw new InvalidStructure();
      }
      snapshot[key] = descriptor.value;
    }
    for (let index = 0; index < required.length; index += 1) {
      if (!OBJECT_HAS_OWN(snapshot, required[index]!)) throw new InvalidStructure();
    }
    return snapshot;
  } catch (error) {
    if (isPrivateError(error, InvalidStructure.prototype)) throw error;
    throw new InvalidStructure();
  }
}

function exactRecord(input: unknown, expected: readonly string[]): NullRecord {
  return closedRecord(input, expected, expected);
}

function denseArray(input: unknown, max: number): readonly unknown[] {
  try {
    if (typeof input !== 'object'
      || input === null
      || NODE_IS_PROXY(input)
      || !ARRAY_IS_ARRAY(input)
      || ARRAY_BUFFER_IS_VIEW(input)) {
      throw new InvalidStructure();
    }
    const prototype = OBJECT_GET_PROTOTYPE_OF(input);
    if (prototype !== ARRAY_PROTOTYPE && prototype !== null) throw new InvalidStructure();
    const lengthDescriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(input, 'length');
    if (lengthDescriptor === undefined
      || !OBJECT_HAS_OWN(lengthDescriptor, 'value')
      || !NUMBER_IS_SAFE_INTEGER(lengthDescriptor.value)
      || lengthDescriptor.value < 0) {
      throw new InvalidStructure();
    }
    const length = lengthDescriptor.value as number;
    if (length > max) throw new BudgetExceeded();
    const keys = REFLECT_OWN_KEYS(input);
    if (keys.length !== length + 1) throw new InvalidStructure();
    const output = new ARRAY<unknown>(length);
    for (let index = 0; index < length; index += 1) {
      const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(input, STRING(index));
      if (descriptor === undefined
        || !OBJECT_HAS_OWN(descriptor, 'value')
        || descriptor.enumerable !== true) {
        throw new InvalidStructure();
      }
      defineArrayItem(output, index, descriptor.value);
    }
    return OBJECT_FREEZE(output);
  } catch (error) {
    if (isPrivateError(error, InvalidStructure.prototype)
      || isPrivateError(error, BudgetExceeded.prototype)) {
      throw error;
    }
    throw new InvalidStructure();
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

function receiptString(
  input: unknown,
  maxBytes: number,
  budget: ReceiptStringBudget,
  pattern?: RegExp,
): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new InvalidReceipt();
  }
  if (input.length > maxBytes) throw new BudgetExceeded();
  if (!validUnicode(input)) throw new InvalidReceipt();
  const bytes = BUFFER_BYTE_LENGTH(input, 'utf8');
  if (bytes > maxBytes) throw new BudgetExceeded();
  if (pattern !== undefined && REGEXP_EXEC(pattern, input) === null) throw new InvalidReceipt();
  budget.bytes += bytes;
  if (budget.bytes > EVIDENCE_POST_FILTER_MAX_AGGREGATE_RECEIPT_STRING_BYTES) {
    throw new BudgetExceeded();
  }
  return input;
}

function receiptLiteral<T extends string>(
  input: unknown,
  allowed: readonly T[],
  budget: ReceiptStringBudget,
): T {
  const value = receiptString(input, MAX_LITERAL_BYTES, budget);
  if (!arrayContains(allowed, value as T)) throw new InvalidReceipt();
  return value as T;
}

function receiptTemporalFrame(
  input: unknown,
  budget: ReceiptStringBudget,
): CandidateChannelTemporalFrameV1 {
  const root = closedRecord(input, ['mode', 'asOf'], ['mode']);
  const mode = receiptLiteral(root.mode, ['current', 'as-of'] as const, budget);
  if (mode === 'current') {
    if (REFLECT_OWN_KEYS(root).length !== 1) throw new InvalidReceipt();
    return nullRecord({ mode });
  }
  if (REFLECT_OWN_KEYS(root).length !== 2 || !OBJECT_HAS_OWN(root, 'asOf')) {
    throw new InvalidReceipt();
  }
  const asOf = receiptString(root.asOf, MAX_TEMPORAL_VALUE_BYTES, budget);
  return nullRecord({ mode, asOf });
}

function sameTemporalFrame(
  left: CandidateChannelTemporalFrameV1,
  right: CandidateChannelTemporalFrameV1,
): boolean {
  return left.mode === right.mode
    && (left.mode === 'current' || (right.mode === 'as-of' && left.asOf === right.asOf));
}

function sourceTypeForChannel(channel: string): EvidencePostFilterSourceTypeV1 {
  switch (channel) {
    case 'memory.scope':
    case 'memory.semantic-vector':
    case 'memory.graph':
      return 'semantic';
    case 'memory.episodic-vector':
      return 'episodic';
    case 'memory.fact':
      return 'fact';
    case 'memory.block':
      return 'block';
    case 'code.fulltext':
    case 'code.lexical-vector':
    case 'code.dense-vector':
    case 'code.semantic-vector':
      return 'symbol';
    case 'arch.aspect':
      return 'aspect';
    case 'arch.fulltext':
    case 'arch.hierarchy':
    case 'arch.dependency':
    case 'arch.entity':
      return 'arch_entity';
    default:
      throw new InvalidStructure();
  }
}

function allowedSources(request: CandidateChannelRequestV1): Set<EvidencePostFilterSourceTypeV1> {
  const result = new SET<EvidencePostFilterSourceTypeV1>();
  for (let index = 0; index < request.plannedChannels.length; index += 1) {
    SET_ADD(result, sourceTypeForChannel(request.plannedChannels[index]!));
  }
  return result;
}

function allowedEntities(request: CandidateChannelRequestV1): Set<string> {
  const result = new SET<string>();
  for (let index = 0; index < request.resolvedEntityIds.length; index += 1) {
    SET_ADD(result, request.resolvedEntityIds[index]!);
  }
  return result;
}

function parseReceipt(
  input: unknown,
  request: CandidateChannelRequestV1,
  entities: Set<string>,
  sources: Set<EvidencePostFilterSourceTypeV1>,
  budget: ReceiptStringBudget,
): EvidenceEligibilityReceiptV1 {
  try {
    const root = exactRecord(input, [
      'contractId',
      'version',
      'tenantId',
      'projectScope',
      'resolvedEntityId',
      'temporalFrame',
      'sourceType',
      'evidenceId',
      'lifecycle',
      'temporal',
      'supersession',
      'contradiction',
    ]);
    const contractId = receiptLiteral(
      root.contractId,
      [EVIDENCE_POST_FILTER_CONTRACT_ID] as const,
      budget,
    );
    const version = receiptLiteral(
      root.version,
      [EVIDENCE_POST_FILTER_CONTRACT_VERSION] as const,
      budget,
    );
    const tenantId = receiptString(root.tenantId, MAX_TENANT_ID_BYTES, budget, SAFE_TENANT_ID);
    const projectScope = receiptString(
      root.projectScope,
      MAX_PROJECT_SCOPE_BYTES,
      budget,
      CANONICAL_PROJECT_SCOPE,
    );
    const resolvedEntityId = receiptString(
      root.resolvedEntityId,
      MAX_ENTITY_ID_BYTES,
      budget,
      SAFE_ENTITY_ID,
    );
    const temporalFrame = receiptTemporalFrame(root.temporalFrame, budget);
    const sourceType = receiptLiteral(root.sourceType, RETRIEVAL_SOURCE_TYPES, budget);
    const evidenceId = receiptString(
      root.evidenceId,
      MAX_EVIDENCE_ID_BYTES,
      budget,
      SAFE_EVIDENCE_ID,
    );
    const lifecycle = receiptLiteral(root.lifecycle, ['active', 'inactive'] as const, budget);
    const temporal = receiptLiteral(root.temporal, ['in-frame', 'out-of-frame'] as const, budget);
    const supersession = receiptLiteral(root.supersession, ['clear', 'superseded'] as const, budget);
    const contradiction = receiptLiteral(root.contradiction, ['clear', 'withheld'] as const, budget);

    if (tenantId !== request.tenantId
      || projectScope !== request.projectScope
      || !SET_HAS(entities, resolvedEntityId)
      || !sameTemporalFrame(temporalFrame, request.temporalFrame)
      || !SET_HAS(sources, sourceType)) {
      throw new InvalidReceipt();
    }

    return nullRecord({
      contractId,
      version,
      tenantId,
      projectScope,
      resolvedEntityId,
      temporalFrame,
      sourceType,
      evidenceId,
      lifecycle,
      temporal,
      supersession,
      contradiction,
    });
  } catch (error) {
    if (isPrivateError(error, BudgetExceeded.prototype)) throw error;
    throw new InvalidReceipt();
  }
}

function candidateRef(index: number): string {
  return `p${STRING_PAD_START(STRING(index), 4, '0')}`;
}

type EvidenceMap = Map<string, string>;
type SourceMap = Map<string, EvidenceMap>;
type ProjectMap = Map<string, SourceMap>;
type TenantMap = Map<string, ProjectMap>;

function duplicateOrRemember(
  identities: TenantMap,
  receipt: EvidenceEligibilityReceiptV1,
  ref: string,
): string | undefined {
  let projects = MAP_GET(identities, receipt.tenantId);
  if (projects === undefined) {
    projects = new MAP<string, SourceMap>();
    MAP_SET(identities, receipt.tenantId, projects);
  }
  let sources = MAP_GET(projects, receipt.projectScope);
  if (sources === undefined) {
    sources = new MAP<string, EvidenceMap>();
    MAP_SET(projects, receipt.projectScope, sources);
  }
  let evidence = MAP_GET(sources, receipt.sourceType);
  if (evidence === undefined) {
    evidence = new MAP<string, string>();
    MAP_SET(sources, receipt.sourceType, evidence);
  }
  if (MAP_HAS(evidence, receipt.evidenceId)) return MAP_GET(evidence, receipt.evidenceId);
  MAP_SET(evidence, receipt.evidenceId, ref);
  return undefined;
}

export function applyEvidencePostFilterV1<T>(
  input: EvidencePostFilterInputV1<T> | unknown,
): EvidencePostFilterResultV1<T> {
  let root: NullRecord;
  try {
    assertSafeInternalArrayPrototypeChain();
    root = exactRecord(input, ['request', 'candidates']);
  } catch {
    throw new EvidencePostFilterContractError('invalid-request');
  }

  let request: CandidateChannelRequestV1;
  try {
    request = parseCandidateChannelRequestV1(root.request);
  } catch {
    throw new EvidencePostFilterContractError('invalid-request');
  }

  let rawCandidates: readonly unknown[];
  try {
    rawCandidates = denseArray(root.candidates, EVIDENCE_POST_FILTER_MAX_CANDIDATES);
    if (rawCandidates.length > request.limits.maxCandidatesAggregate) throw new BudgetExceeded();
  } catch (error) {
    throw new EvidencePostFilterContractError(
      isPrivateError(error, BudgetExceeded.prototype) ? 'budget-exceeded' : 'invalid-request',
    );
  }

  const entities = allowedEntities(request);
  const sources = allowedSources(request);
  const wrappers = new WEAK_SET<object>();
  const budget: ReceiptStringBudget = { bytes: 0 };
  const parsed = new ARRAY<ParsedCandidate<T>>(rawCandidates.length);

  for (let index = 0; index < rawCandidates.length; index += 1) {
    const raw = rawCandidates[index];
    let wrapper: NullRecord;
    try {
      if (typeof raw !== 'object'
        || raw === null
        || NODE_IS_PROXY(raw)
        || WEAK_SET_HAS(wrappers, raw)) {
        throw new InvalidStructure();
      }
      WEAK_SET_ADD(wrappers, raw);
      wrapper = exactRecord(raw, ['value', 'receipt']);
    } catch {
      throw new EvidencePostFilterContractError('invalid-request');
    }
    let parsedReceipt: EvidenceEligibilityReceiptV1;
    try {
      parsedReceipt = parseReceipt(wrapper.receipt, request, entities, sources, budget);
    } catch (error) {
      throw new EvidencePostFilterContractError(
        isPrivateError(error, BudgetExceeded.prototype) ? 'budget-exceeded' : 'invalid-receipt',
      );
    }
    defineArrayItem(parsed, index, { value: wrapper.value as T, receipt: parsedReceipt });
  }

  const included = new ARRAY<EvidencePostFilterIncludedV1<T>>();
  const decisions = new ARRAY<EvidencePostFilterDecisionV1>(parsed.length);
  const identities = new MAP<string, ProjectMap>();

  for (let index = 0; index < parsed.length; index += 1) {
    const item = parsed[index]!;
    const ref = candidateRef(index);
    if (item.receipt.lifecycle === 'inactive') {
      defineArrayItem(
        decisions,
        index,
        nullRecord({ ref, outcome: 'excluded' as const, reason: 'inactive' as const }),
      );
      continue;
    }
    if (item.receipt.temporal === 'out-of-frame' || item.receipt.supersession === 'superseded') {
      defineArrayItem(
        decisions,
        index,
        nullRecord({ ref, outcome: 'excluded' as const, reason: 'stale' as const }),
      );
      continue;
    }
    if (item.receipt.contradiction === 'withheld') {
      defineArrayItem(
        decisions,
        index,
        nullRecord({
          ref,
          outcome: 'excluded' as const,
          reason: 'contradictory' as const,
        }),
      );
      continue;
    }
    const duplicateOfRef = duplicateOrRemember(identities, item.receipt, ref);
    if (duplicateOfRef !== undefined) {
      defineArrayItem(
        decisions,
        index,
        nullRecord({
          ref,
          outcome: 'excluded' as const,
          reason: 'duplicate' as const,
          duplicateOfRef,
        }),
      );
      continue;
    }
    defineArrayItem(included, included.length, nullRecord({ ref, value: item.value }));
    defineArrayItem(decisions, index, nullRecord({ ref, outcome: 'included' as const }));
  }

  return nullRecord({
    contractId: EVIDENCE_POST_FILTER_CONTRACT_ID,
    version: EVIDENCE_POST_FILTER_CONTRACT_VERSION,
    included: OBJECT_FREEZE(included),
    decisions: OBJECT_FREEZE(decisions),
  });
}
