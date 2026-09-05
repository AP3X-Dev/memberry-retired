import { types as nodeUtilTypes } from 'node:util';

export const QUERY_PLAN_CONTRACT_ID = 'memberry.query-plan' as const;
export const QUERY_PLAN_CONTRACT_VERSION = '1.0.0' as const;

export const QUERY_PLAN_MAX_PROJECT_SCOPES = 16 as const;
export const QUERY_PLAN_MAX_HINTS_PER_KIND = 16 as const;
export const QUERY_PLAN_MAX_EVIDENCE_NEEDS = 8 as const;
export const QUERY_PLAN_MAX_RESOLVED_ENTITY_IDS = 32 as const;

const MAX_TENANT_ID_LENGTH = 128;
const MAX_PROJECT_SCOPE_LENGTH = 136;
const MAX_HINT_LENGTH = 200;
const MAX_ENTITY_ID_LENGTH = 200;

export const QUERY_PLAN_INTENTS = Object.freeze([
  'GRAPH',
  'SEMANTIC',
  'IDENTIFIER',
  'HYBRID',
] as const);
export type QueryPlanIntentV1 = (typeof QUERY_PLAN_INTENTS)[number];

export const QUERY_PLAN_EVIDENCE_NEEDS = Object.freeze([
  'architecture',
  'code',
  'fact',
  'graph',
  'memory',
  'provenance',
  'relationship',
  'temporal',
] as const);
export type QueryPlanEvidenceNeedV1 = (typeof QUERY_PLAN_EVIDENCE_NEEDS)[number];

export const QUERY_PLAN_RESOLUTION_STATES = Object.freeze([
  'unresolved',
  'resolved',
  'ambiguous',
  'not-found',
  'denied',
] as const);
export type QueryPlanResolutionStateV1 = (typeof QUERY_PLAN_RESOLUTION_STATES)[number];

export interface QueryPlanAuthorityV1 {
  /** Authenticated tenant identity. Text-derived values can never populate this field. */
  readonly tenantId: string;
  /** Explicit caller constraints, structurally separate from task-derived hints. */
  readonly callerScopes: QueryPlanCallerScopesV1;
}

export interface QueryPlanCallerScopesV1 {
  /** At least one explicit canonical project scope is required to fail closed. */
  readonly projects: readonly string[];
  readonly repositories: readonly string[];
  readonly entities: readonly string[];
  readonly symbols: readonly string[];
}

export type QueryPlanTemporalFrameV1 =
  | { readonly mode: 'current' }
  | { readonly mode: 'as-of'; readonly asOf: string }
  | { readonly mode: 'interval'; readonly from: string; readonly to: string };

export interface QueryPlanTaskHintsV1 {
  /** Provenance marker: all values in this object are non-authoritative. */
  readonly source: 'task';
  readonly repositories: readonly string[];
  readonly entities: readonly string[];
  readonly symbols: readonly string[];
}

export interface QueryPlanResolutionV1 {
  readonly state: QueryPlanResolutionStateV1;
  readonly canonicalEntityIds: readonly string[];
}

/**
 * Closed, bounded handoff between query analysis and scope-aware resolution.
 * Authority is supplied only by the authenticated caller boundary. Hints carry
 * task-derived narrowing candidates and are never authorization inputs.
 */
export interface QueryPlanV1 {
  readonly contractId: typeof QUERY_PLAN_CONTRACT_ID;
  readonly contractVersion: typeof QUERY_PLAN_CONTRACT_VERSION;
  readonly authority: QueryPlanAuthorityV1;
  readonly intent: QueryPlanIntentV1;
  readonly temporalFrame: QueryPlanTemporalFrameV1;
  readonly evidenceNeeds: readonly QueryPlanEvidenceNeedV1[];
  readonly hints: QueryPlanTaskHintsV1;
  readonly resolution: QueryPlanResolutionV1;
}

export type QueryPlanContractErrorCode =
  | 'not_object'
  | 'invalid_type'
  | 'unknown_key'
  | 'missing_key'
  | 'invalid_identity'
  | 'invalid_enum'
  | 'invalid_identifier'
  | 'invalid_timestamp'
  | 'invalid_range'
  | 'invalid_state'
  | 'out_of_bounds'
  | 'noncanonical'
  | 'shared_reference'
  | 'cyclic_reference';

/** Error messages expose only closed schema paths and codes, never supplied values. */
export class QueryPlanContractError extends Error {
  constructor(
    readonly code: QueryPlanContractErrorCode,
    readonly field: string,
  ) {
    super(`query_plan_contract:${code}:${field}`);
    this.name = 'QueryPlanContractError';
  }
}

interface TraversalState {
  readonly seen: WeakSet<object>;
  readonly active: WeakSet<object>;
}

interface EnteredRecord {
  readonly source: object;
  readonly value: Record<PropertyKey, unknown>;
}

const SAFE_TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PROJECT_SCOPE_SHAPE = /^project:[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CANONICAL_PROJECT_SCOPE = /^project:[a-z0-9][a-z0-9._-]*$/;
const SAFE_HINT = /^[A-Za-z0-9][A-Za-z0-9._/@:+-]*$/;
const SAFE_ENTITY_HINT = /^(?:@?[A-Za-z0-9])(?:[A-Za-z0-9._/@:+ -]*[A-Za-z0-9._/@:+-])?$/;
const SAFE_ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const RESERVED_AUTHORITY_HINT = /^(?:project|tenant):/i;

function enterRecord(
  input: unknown,
  field: string,
  state: TraversalState,
  allowed: readonly string[],
  required: readonly string[],
): EnteredRecord {
  try {
    if (typeof input !== 'object' || input === null) {
      throw new QueryPlanContractError('not_object', field);
    }
    if (nodeUtilTypes.isProxy(input)) {
      throw new QueryPlanContractError('invalid_type', field);
    }
    if (Array.isArray(input)) {
      throw new QueryPlanContractError('not_object', field);
    }
    if (state.active.has(input)) {
      throw new QueryPlanContractError('cyclic_reference', field);
    }
    if (state.seen.has(input)) {
      throw new QueryPlanContractError('shared_reference', field);
    }

    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new QueryPlanContractError('invalid_type', field);
    }

    // Bound a closed object before descriptor cloning. Unknown-key floods fail
    // after one own-key enumeration and cannot amplify a second retained copy.
    const keys = Reflect.ownKeys(input);
    if (keys.length > allowed.length) {
      throw new QueryPlanContractError('unknown_key', field);
    }
    const allowedKeys = new Set(allowed);
    const stringKeys = new Set<string>();
    for (const key of keys) {
      if (typeof key !== 'string' || !allowedKeys.has(key)) {
        throw new QueryPlanContractError('unknown_key', field);
      }
      stringKeys.add(key);
    }
    for (const key of required) {
      if (!stringKeys.has(key)) {
        throw new QueryPlanContractError('missing_key', `${field}.${key}`);
      }
    }

    const descriptors: Array<readonly [string, PropertyDescriptor & { value: unknown }]> = [];
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor === undefined
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
        || descriptor.enumerable !== true) {
        throw new QueryPlanContractError('invalid_type', field);
      }
      descriptors.push([key, descriptor as PropertyDescriptor & { value: unknown }]);
    }

    state.seen.add(input);
    state.active.add(input);
    const value = Object.create(null) as Record<PropertyKey, unknown>;
    for (const [key, descriptor] of descriptors) {
      Object.defineProperty(value, key, {
        value: descriptor.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return { source: input, value };
  } catch (error) {
    if (error instanceof QueryPlanContractError) throw error;
    throw new QueryPlanContractError('invalid_type', field);
  }
}

function leaveRecord(record: EnteredRecord, state: TraversalState): void {
  state.active.delete(record.source);
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new QueryPlanContractError('invalid_enum', field);
  }
  return value as T;
}

function boundedIdentifier(
  value: unknown,
  field: string,
  maxLength: number,
  pattern: RegExp,
  rejectAuthoritySyntax = false,
): string {
  if (typeof value !== 'string') throw new QueryPlanContractError('invalid_type', field);
  if (value.length < 1 || value.length > maxLength) {
    throw new QueryPlanContractError('out_of_bounds', field);
  }
  if (!pattern.test(value) || (rejectAuthoritySyntax && RESERVED_AUTHORITY_HINT.test(value))) {
    throw new QueryPlanContractError('invalid_identifier', field);
  }
  return value;
}

function canonicalProjectScope(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new QueryPlanContractError('invalid_type', field);
  if (value.length < 1 || value.length > MAX_PROJECT_SCOPE_LENGTH) {
    throw new QueryPlanContractError('out_of_bounds', field);
  }
  if (!PROJECT_SCOPE_SHAPE.test(value)) {
    throw new QueryPlanContractError('invalid_identifier', field);
  }
  if (!CANONICAL_PROJECT_SCOPE.test(value) || value.toLowerCase() !== value) {
    throw new QueryPlanContractError('noncanonical', field);
  }
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireCanonicalOrder(values: readonly string[], field: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (compareText(values[index - 1]!, values[index]!) >= 0) {
      throw new QueryPlanContractError('noncanonical', field);
    }
  }
}

function denseStringArray(
  input: unknown,
  field: string,
  state: TraversalState,
  maxItems: number,
  parseItem: (value: unknown, field: string) => string,
  minItems = 0,
  canonicalOrder = false,
): readonly string[] {
  try {
    if (typeof input !== 'object' || input === null || nodeUtilTypes.isProxy(input) || !Array.isArray(input)) {
      throw new QueryPlanContractError('invalid_type', field);
    }
    if (state.active.has(input)) throw new QueryPlanContractError('cyclic_reference', field);
    if (state.seen.has(input)) throw new QueryPlanContractError('shared_reference', field);
    if (Object.getPrototypeOf(input) !== Array.prototype) {
      throw new QueryPlanContractError('invalid_type', field);
    }

    const lengthDescriptor = Object.getOwnPropertyDescriptor(input, 'length');
    if (lengthDescriptor === undefined || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')) {
      throw new QueryPlanContractError('invalid_type', field);
    }
    const length = lengthDescriptor.value;
    if (!Number.isSafeInteger(length) || length < minItems || length > maxItems) {
      throw new QueryPlanContractError('out_of_bounds', field);
    }

    const keys = Reflect.ownKeys(input);
    if (keys.length !== length + 1) {
      throw new QueryPlanContractError('invalid_type', field);
    }
    state.seen.add(input);
    state.active.add(input);
    try {
      const result: string[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (descriptor === undefined
          || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
          || descriptor.enumerable !== true) {
          throw new QueryPlanContractError('invalid_type', `${field}[]`);
        }
        result.push(parseItem(descriptor.value, `${field}[]`));
      }
      for (const key of keys) {
        if (key === 'length') continue;
        if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length) {
          throw new QueryPlanContractError('invalid_type', field);
        }
      }
      if (canonicalOrder) requireCanonicalOrder(result, field);
      return Object.freeze(result);
    } finally {
      state.active.delete(input);
    }
  } catch (error) {
    if (error instanceof QueryPlanContractError) throw error;
    throw new QueryPlanContractError('invalid_type', field);
  }
}

interface CanonicalTimestamp {
  readonly value: string;
  readonly epochMs: number;
}

function canonicalTimestamp(value: unknown, field: string): CanonicalTimestamp {
  if (typeof value !== 'string') throw new QueryPlanContractError('invalid_type', field);
  if (value.length > 32) throw new QueryPlanContractError('out_of_bounds', field);
  const parsed = new Date(value);
  const epochMs = parsed.getTime();
  if (!Number.isFinite(epochMs)) {
    throw new QueryPlanContractError('invalid_timestamp', field);
  }
  if (parsed.toISOString() !== value) {
    throw new QueryPlanContractError('noncanonical', field);
  }
  return { value, epochMs };
}

function parseAuthority(input: unknown, state: TraversalState): QueryPlanAuthorityV1 {
  const field = 'queryPlan.authority';
  const keys = ['tenantId', 'callerScopes'] as const;
  const entered = enterRecord(input, field, state, keys, keys);
  try {
    const tenantId = boundedIdentifier(
      entered.value.tenantId,
      `${field}.tenantId`,
      MAX_TENANT_ID_LENGTH,
      SAFE_TENANT_ID,
    );
    const callerScopes = parseCallerScopes(entered.value.callerScopes, state);
    return Object.freeze({ tenantId, callerScopes });
  } finally {
    leaveRecord(entered, state);
  }
}

function parseCallerScopes(input: unknown, state: TraversalState): QueryPlanCallerScopesV1 {
  const field = 'queryPlan.authority.callerScopes';
  const keys = ['projects', 'repositories', 'entities', 'symbols'] as const;
  const entered = enterRecord(input, field, state, keys, keys);
  try {
    const parseScope = (value: unknown, itemField: string) => boundedIdentifier(
      value,
      itemField,
      MAX_HINT_LENGTH,
      SAFE_HINT,
      true,
    );
    return Object.freeze({
      projects: denseStringArray(
        entered.value.projects,
        `${field}.projects`,
        state,
        QUERY_PLAN_MAX_PROJECT_SCOPES,
        canonicalProjectScope,
        1,
        true,
      ),
      repositories: denseStringArray(
        entered.value.repositories,
        `${field}.repositories`,
        state,
        QUERY_PLAN_MAX_HINTS_PER_KIND,
        parseScope,
        0,
        true,
      ),
      entities: denseStringArray(
        entered.value.entities,
        `${field}.entities`,
        state,
        QUERY_PLAN_MAX_HINTS_PER_KIND,
        parseScope,
        0,
        true,
      ),
      symbols: denseStringArray(
        entered.value.symbols,
        `${field}.symbols`,
        state,
        QUERY_PLAN_MAX_HINTS_PER_KIND,
        parseScope,
        0,
        true,
      ),
    });
  } finally {
    leaveRecord(entered, state);
  }
}

function parseTemporalFrame(input: unknown, state: TraversalState): QueryPlanTemporalFrameV1 {
  const field = 'queryPlan.temporalFrame';
  const modeRecord = enterRecord(input, field, state, ['mode', 'asOf', 'from', 'to'], ['mode']);
  try {
    const mode = enumValue(modeRecord.value.mode, ['current', 'as-of', 'interval'] as const, `${field}.mode`);
    if (mode === 'current') {
      ensureExactVariantKeys(modeRecord.value, ['mode'], field);
      return Object.freeze({ mode });
    }
    if (mode === 'as-of') {
      ensureExactVariantKeys(modeRecord.value, ['mode', 'asOf'], field);
      const asOf = canonicalTimestamp(modeRecord.value.asOf, `${field}.asOf`);
      return Object.freeze({ mode, asOf: asOf.value });
    }
    ensureExactVariantKeys(modeRecord.value, ['mode', 'from', 'to'], field);
    const from = canonicalTimestamp(modeRecord.value.from, `${field}.from`);
    const to = canonicalTimestamp(modeRecord.value.to, `${field}.to`);
    if (from.epochMs > to.epochMs) throw new QueryPlanContractError('invalid_range', field);
    return Object.freeze({ mode, from: from.value, to: to.value });
  } finally {
    leaveRecord(modeRecord, state);
  }
}

function ensureExactVariantKeys(
  value: Record<PropertyKey, unknown>,
  expected: readonly string[],
  field: string,
): void {
  const actual = Reflect.ownKeys(value);
  const expectedSet = new Set(expected);
  if (actual.some((key) => typeof key !== 'string' || !expectedSet.has(key))) {
    throw new QueryPlanContractError('unknown_key', field);
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new QueryPlanContractError('missing_key', `${field}.${key}`);
    }
  }
}

function parseHints(input: unknown, state: TraversalState): QueryPlanTaskHintsV1 {
  const field = 'queryPlan.hints';
  const keys = ['source', 'repositories', 'entities', 'symbols'] as const;
  const entered = enterRecord(input, field, state, keys, keys);
  try {
    if (entered.value.source !== 'task') {
      throw new QueryPlanContractError('invalid_identity', `${field}.source`);
    }
    const parseHint = (value: unknown, itemField: string) => boundedIdentifier(
      value,
      itemField,
      MAX_HINT_LENGTH,
      SAFE_HINT,
      true,
    );
    const parseEntityHint = (value: unknown, itemField: string) => boundedIdentifier(
      value,
      itemField,
      MAX_HINT_LENGTH,
      SAFE_ENTITY_HINT,
      true,
    );
    return Object.freeze({
      source: 'task',
      repositories: denseStringArray(
        entered.value.repositories,
        `${field}.repositories`,
        state,
        QUERY_PLAN_MAX_HINTS_PER_KIND,
        parseHint,
        0,
        true,
      ),
      entities: denseStringArray(
        entered.value.entities,
        `${field}.entities`,
        state,
        QUERY_PLAN_MAX_HINTS_PER_KIND,
        parseEntityHint,
        0,
        true,
      ),
      symbols: denseStringArray(
        entered.value.symbols,
        `${field}.symbols`,
        state,
        QUERY_PLAN_MAX_HINTS_PER_KIND,
        parseHint,
        0,
        true,
      ),
    });
  } finally {
    leaveRecord(entered, state);
  }
}

function parseResolution(input: unknown, state: TraversalState): QueryPlanResolutionV1 {
  const field = 'queryPlan.resolution';
  const keys = ['state', 'canonicalEntityIds'] as const;
  const entered = enterRecord(input, field, state, keys, keys);
  try {
    const resolutionState = enumValue(
      entered.value.state,
      QUERY_PLAN_RESOLUTION_STATES,
      `${field}.state`,
    );
    const canonicalEntityIds = denseStringArray(
      entered.value.canonicalEntityIds,
      `${field}.canonicalEntityIds`,
      state,
      QUERY_PLAN_MAX_RESOLVED_ENTITY_IDS,
      (value, itemField) => boundedIdentifier(value, itemField, MAX_ENTITY_ID_LENGTH, SAFE_ENTITY_ID),
      0,
      true,
    );
    const count = canonicalEntityIds.length;
    if ((resolutionState === 'resolved' && count < 1)
      || (resolutionState === 'ambiguous' && count < 2)
      || (resolutionState !== 'resolved' && resolutionState !== 'ambiguous' && count !== 0)) {
      throw new QueryPlanContractError('invalid_state', field);
    }
    return Object.freeze({ state: resolutionState, canonicalEntityIds });
  } finally {
    leaveRecord(entered, state);
  }
}

export function parseQueryPlanV1(input: unknown): QueryPlanV1 {
  const state: TraversalState = { seen: new WeakSet(), active: new WeakSet() };
  const field = 'queryPlan';
  const keys = [
    'contractId',
    'contractVersion',
    'authority',
    'intent',
    'temporalFrame',
    'evidenceNeeds',
    'hints',
    'resolution',
  ] as const;
  const entered = enterRecord(input, field, state, keys, keys);
  try {
    if (entered.value.contractId !== QUERY_PLAN_CONTRACT_ID) {
      throw new QueryPlanContractError('invalid_identity', `${field}.contractId`);
    }
    if (entered.value.contractVersion !== QUERY_PLAN_CONTRACT_VERSION) {
      throw new QueryPlanContractError('invalid_identity', `${field}.contractVersion`);
    }
    const authority = parseAuthority(entered.value.authority, state);
    const intent = enumValue(entered.value.intent, QUERY_PLAN_INTENTS, `${field}.intent`);
    const temporalFrame = parseTemporalFrame(entered.value.temporalFrame, state);
    const evidenceNeeds = denseStringArray(
      entered.value.evidenceNeeds,
      `${field}.evidenceNeeds`,
      state,
      QUERY_PLAN_MAX_EVIDENCE_NEEDS,
      (value, itemField) => enumValue(value, QUERY_PLAN_EVIDENCE_NEEDS, itemField),
      1,
      true,
    ) as readonly QueryPlanEvidenceNeedV1[];
    const hints = parseHints(entered.value.hints, state);
    const resolution = parseResolution(entered.value.resolution, state);
    return Object.freeze({
      contractId: QUERY_PLAN_CONTRACT_ID,
      contractVersion: QUERY_PLAN_CONTRACT_VERSION,
      authority,
      intent,
      temporalFrame,
      evidenceNeeds,
      hints,
      resolution,
    });
  } finally {
    leaveRecord(entered, state);
  }
}

/** Fixed-key, deterministic JSON for evidence identity and cross-runtime tests. */
export function canonicalQueryPlanV1(input: unknown): string {
  return JSON.stringify(parseQueryPlanV1(input));
}
