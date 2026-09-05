import { types as nodeUtilTypes } from 'node:util';
import {
  QUERY_PLAN_CONTRACT_ID,
  QUERY_PLAN_CONTRACT_VERSION,
  QUERY_PLAN_MAX_HINTS_PER_KIND,
  parseQueryPlanV1,
  type QueryPlanV1,
} from './query-plan.js';

const SAFE_PROJECT_SCOPE = /^project:[a-z0-9][a-z0-9._-]*$/;
// Entity hints are display names, not authority or Cypher fragments. Permit
// ordinary internal ASCII spaces while keeping the bounded, parameterized
// resolver input free of leading/trailing whitespace and control characters.
const SAFE_ENTITY_HINT = /^(?:@?[A-Za-z0-9])(?:[A-Za-z0-9._/@:+ -]*[A-Za-z0-9._/@:+-])?$/;
const RESERVED_AUTHORITY_HINT = /^(?:project|tenant):/i;
const MAX_PROJECT_SCOPE_LENGTH = 136;
const MAX_HINT_LENGTH = 200;

/**
 * Closed set of structured denial reasons a `resolution_failed` error may carry (loop item 18).
 * Mirrors the resolver's diagnostic codes one-to-one; every value is content-free, so the wire
 * message stays value-free. Infra/structural failures carry no reason.
 */
export const RUNTIME_QUERY_PLANNER_DENIAL_REASONS_V1 = Object.freeze([
  'authority_mismatch',
  'project_denied',
  'entity_not_found',
  'entity_ambiguous',
  'entity_id_denied',
  'entity_multi_project',
  'entity_path_ambiguous',
  'entity_containment_cycle',
  'entity_scope_overflow',
] as const);
export type RuntimeQueryPlannerDenialReasonV1 = (typeof RUNTIME_QUERY_PLANNER_DENIAL_REASONS_V1)[number];

export class RuntimeQueryPlannerError extends Error {
  /** Only `resolution_failed` carries a reason; the code alone stays the stable prefix. */
  readonly reason: RuntimeQueryPlannerDenialReasonV1 | undefined;
  constructor(
    readonly code: 'invalid_request' | 'authentication_required' | 'unavailable' | 'resolution_failed',
    reason?: RuntimeQueryPlannerDenialReasonV1,
  ) {
    const withReason = code === 'resolution_failed' && reason !== undefined;
    super(withReason ? `runtime_query_planner:${code}:${reason}` : `runtime_query_planner:${code}`);
    this.name = 'RuntimeQueryPlannerError';
    this.reason = withReason ? reason : undefined;
  }
}

function invalidRequest(): never {
  throw new RuntimeQueryPlannerError('invalid_request');
}

function snapshotEntityHints(input: unknown): readonly string[] {
  try {
    if (typeof input !== 'object' || input === null || nodeUtilTypes.isProxy(input)
      || !Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
      return invalidRequest();
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(input, 'length');
    if (!lengthDescriptor || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 1
      || lengthDescriptor.value > QUERY_PLAN_MAX_HINTS_PER_KIND
      || Reflect.ownKeys(input).length !== lengthDescriptor.value + 1) {
      return invalidRequest();
    }
    const values: string[] = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
        || descriptor.enumerable !== true || typeof descriptor.value !== 'string'
        || descriptor.value.length < 1 || descriptor.value.length > MAX_HINT_LENGTH
        || !SAFE_ENTITY_HINT.test(descriptor.value) || RESERVED_AUTHORITY_HINT.test(descriptor.value)) {
        return invalidRequest();
      }
      values.push(descriptor.value);
    }
    return Object.freeze([...new Set(values)].sort());
  } catch (error) {
    if (error instanceof RuntimeQueryPlannerError) throw error;
    return invalidRequest();
  }
}

/**
 * Build the unresolved V1 plan used by the authenticated MCP integration.
 * Only the closure-bound tenant and explicit canonical project are authority;
 * public entity_scope values remain non-authoritative resolver hints.
 */
export interface RuntimeQueryPlannerReceiptV1 {
  readonly plan: QueryPlanV1;
  readonly trustedProjectScopes: readonly [string];
}

export interface RuntimeQueryPlannerAuthorityStateV1 {
  readonly tenantId: string;
  readonly projectScope: string;
  readonly resolvedEntityId: string;
  readonly temporalFrame: { readonly mode: 'current' } | { readonly mode: 'as-of'; readonly asOf: string };
}

export interface RuntimeQueryPlannerResolvedReceiptV1 {
  readonly contract: 'memberry.runtime-query-planner-resolved-receipt.v1';
}

export interface RuntimeQueryPlannerResolverV1 {
  resolve(plan: QueryPlanV1): Promise<unknown>;
}

export type RuntimeQueryPlannerResolverFactoryV1 = (authority: Readonly<{
  tenantId: string;
  projectScopes: readonly string[];
}>) => RuntimeQueryPlannerResolverV1;

const unresolvedReceiptState = new WeakMap<RuntimeQueryPlannerReceiptV1, Readonly<{
  tenantId: string;
  projectScope: string;
  temporalFrame: RuntimeQueryPlannerAuthorityStateV1['temporalFrame'];
}>>();
const resolvedReceiptState = new WeakMap<RuntimeQueryPlannerResolvedReceiptV1, RuntimeQueryPlannerAuthorityStateV1>();

export function buildRuntimeQueryPlannerReceiptV1(input: {
  tenantId: unknown;
  projectName: unknown;
  entityScope: unknown;
  asOf?: unknown;
}): RuntimeQueryPlannerReceiptV1 {
  try {
    if (typeof input !== 'object' || input === null || nodeUtilTypes.isProxy(input)
      || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) {
      return invalidRequest();
    }
    const keys = Reflect.ownKeys(input);
    if (keys.length < 3 || keys.length > 4
      || keys.some((key) => typeof key !== 'string'
        || !['tenantId', 'projectName', 'entityScope', 'asOf'].includes(key))) {
      return invalidRequest();
    }
    const values = new Map<string, unknown>();
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
        || descriptor.enumerable !== true) return invalidRequest();
      values.set(key, descriptor.value);
    }
    if (!values.has('tenantId') || !values.has('projectName') || !values.has('entityScope')) {
      return invalidRequest();
    }
    const tenantId = values.get('tenantId');
    const projectName = values.get('projectName');
    if (typeof tenantId !== 'string' || typeof projectName !== 'string'
      || projectName.length < 1 || projectName.length > MAX_PROJECT_SCOPE_LENGTH
      || !SAFE_PROJECT_SCOPE.test(projectName)) return invalidRequest();
    const entities = snapshotEntityHints(values.get('entityScope'));
    const temporalFrame = values.has('asOf') && values.get('asOf') !== undefined
      ? { mode: 'as-of' as const, asOf: values.get('asOf') }
      : { mode: 'current' as const };
    // Snapshot the authenticated caller's canonical project independently of
    // the parsed plan. The trusted resolver authority must never be recovered
    // from plan bytes, even though both values are intentionally equal.
    const trustedProjectScopes = Object.freeze([projectName]) as readonly [string];
    const plan = parseQueryPlanV1({
      contractId: QUERY_PLAN_CONTRACT_ID,
      contractVersion: QUERY_PLAN_CONTRACT_VERSION,
      authority: {
        tenantId,
        callerScopes: { projects: [projectName], repositories: [], entities: [], symbols: [] },
      },
      intent: 'HYBRID',
      temporalFrame,
      evidenceNeeds: ['memory'],
      hints: { source: 'task', repositories: [], entities, symbols: [] },
      resolution: { state: 'unresolved', canonicalEntityIds: [] },
    });
    const receipt = Object.freeze({ plan, trustedProjectScopes });
    unresolvedReceiptState.set(receipt, Object.freeze({
      tenantId,
      projectScope: projectName,
      temporalFrame: plan.temporalFrame as RuntimeQueryPlannerAuthorityStateV1['temporalFrame'],
    }));
    return receipt;
  } catch (error) {
    if (error instanceof RuntimeQueryPlannerError) throw error;
    return invalidRequest();
  }
}

function plannerOwnData(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    || descriptor.enumerable !== true) throw new RuntimeQueryPlannerError('resolution_failed');
  return descriptor.value;
}

const DENIAL_REASON_SET: ReadonlySet<string> = new Set(RUNTIME_QUERY_PLANNER_DENIAL_REASONS_V1);

/**
 * Loop item 18. Reads the resolver's `diagnostics` as a structured denial: a dense data array
 * of known codes. Returns the first code (the reason) or undefined for an empty array. Hooks,
 * proxies, sparse or oversize arrays and unknown codes are structural and throw the bare
 * `resolution_failed`, exactly as the old empty-array requirement did. Shared by both
 * resolution paths (the receipt path here and the legacy path in tools.ts) so they can never
 * disagree about what a denial looks like.
 */
export function readResolverDenialReasonV1(diagnostics: unknown): RuntimeQueryPlannerDenialReasonV1 | undefined {
  if (!Array.isArray(diagnostics) || nodeUtilTypes.isProxy(diagnostics)
    || Object.getPrototypeOf(diagnostics) !== Array.prototype) throw new RuntimeQueryPlannerError('resolution_failed');
  const length = Object.getOwnPropertyDescriptor(diagnostics, 'length');
  const count = length && Object.prototype.hasOwnProperty.call(length, 'value') ? length.value : undefined;
  if (!Number.isSafeInteger(count) || (count as number) < 0
    || (count as number) > RUNTIME_QUERY_PLANNER_DENIAL_REASONS_V1.length
    || Reflect.ownKeys(diagnostics).length !== (count as number) + 1) throw new RuntimeQueryPlannerError('resolution_failed');
  let first: RuntimeQueryPlannerDenialReasonV1 | undefined;
  for (let index = 0; index < (count as number); index += 1) {
    const entry = Object.getOwnPropertyDescriptor(diagnostics, String(index));
    if (!entry || !Object.prototype.hasOwnProperty.call(entry, 'value') || entry.enumerable !== true
      || typeof entry.value !== 'string' || !DENIAL_REASON_SET.has(entry.value)) {
      throw new RuntimeQueryPlannerError('resolution_failed');
    }
    if (index === 0) first = entry.value as RuntimeQueryPlannerDenialReasonV1;
  }
  return first;
}

function exactResolvedEntityId(input: unknown): string {
  try {
    if (typeof input !== 'object' || input === null || nodeUtilTypes.isProxy(input)
      || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype
      || Reflect.ownKeys(input).length !== 2) throw new Error();
    const resolution = plannerOwnData(input, 'resolution');
    const diagnostics = plannerOwnData(input, 'diagnostics');
    const reason = readResolverDenialReasonV1(diagnostics);
    if (reason !== undefined) throw new RuntimeQueryPlannerError('resolution_failed', reason);
    if (typeof resolution !== 'object' || resolution === null || nodeUtilTypes.isProxy(resolution)
      || Array.isArray(resolution) || Object.getPrototypeOf(resolution) !== Object.prototype
      || Reflect.ownKeys(resolution).length !== 2
      || plannerOwnData(resolution, 'state') !== 'resolved') throw new Error();
    const ids = plannerOwnData(resolution, 'canonicalEntityIds');
    if (!Array.isArray(ids) || nodeUtilTypes.isProxy(ids) || Object.getPrototypeOf(ids) !== Array.prototype
      || Reflect.ownKeys(ids).length !== 2 || Object.getOwnPropertyDescriptor(ids, 'length')?.value !== 1) throw new Error();
    const id = Object.getOwnPropertyDescriptor(ids, '0');
    if (!id || !Object.prototype.hasOwnProperty.call(id, 'value') || id.enumerable !== true
      || typeof id.value !== 'string' || id.value.length < 1 || id.value.length > 200
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id.value)) throw new Error();
    return id.value;
  } catch (error) {
    if (error instanceof RuntimeQueryPlannerError) throw error;
    throw new RuntimeQueryPlannerError('resolution_failed');
  }
}

/** @internal Authenticates, plans, resolves, and seals one complete authority receipt. */
export async function resolveRuntimeQueryPlannerAuthorityV1(input: {
  authenticated: boolean;
  plannerEnabled: boolean;
  resolverFactory: RuntimeQueryPlannerResolverFactoryV1 | null;
  tenantId: string;
  projectName: unknown;
  entityScope: unknown;
  asOf?: unknown;
}): Promise<RuntimeQueryPlannerResolvedReceiptV1> {
  if (!input.authenticated) throw new RuntimeQueryPlannerError('authentication_required');
  if (!input.plannerEnabled || !input.resolverFactory) throw new RuntimeQueryPlannerError('unavailable');
  const unresolved = buildRuntimeQueryPlannerReceiptV1({
    tenantId: input.tenantId,
    projectName: input.projectName,
    entityScope: input.entityScope,
    ...(input.asOf !== undefined ? { asOf: input.asOf } : {}),
  });
  const trusted = unresolvedReceiptState.get(unresolved);
  if (!trusted) throw new RuntimeQueryPlannerError('resolution_failed');
  try {
    const resolver = input.resolverFactory(Object.freeze({
      tenantId: trusted.tenantId,
      projectScopes: Object.freeze([trusted.projectScope]),
    }));
    if (typeof resolver !== 'object' || resolver === null || nodeUtilTypes.isProxy(resolver)) {
      throw new RuntimeQueryPlannerError('resolution_failed');
    }
    const descriptor = Object.getOwnPropertyDescriptor(resolver, 'resolve');
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      || typeof descriptor.value !== 'function') throw new RuntimeQueryPlannerError('resolution_failed');
    const resolvedEntityId = exactResolvedEntityId(await descriptor.value.call(resolver, unresolved.plan));
    const receipt = Object.freeze({
      contract: 'memberry.runtime-query-planner-resolved-receipt.v1' as const,
    });
    resolvedReceiptState.set(receipt, Object.freeze({
      tenantId: trusted.tenantId,
      projectScope: trusted.projectScope,
      resolvedEntityId,
      temporalFrame: trusted.temporalFrame,
    }));
    return receipt;
  } catch (error) {
    if (error instanceof RuntimeQueryPlannerError) throw error;
    throw new RuntimeQueryPlannerError('resolution_failed');
  }
}

/** @internal Read the immutable authority behind an unforgeable resolved receipt. */
export function readRuntimeQueryPlannerAuthorityV1(input: unknown): RuntimeQueryPlannerAuthorityStateV1 {
  if (typeof input !== 'object' || input === null || nodeUtilTypes.isProxy(input)) {
    throw new RuntimeQueryPlannerError('resolution_failed');
  }
  const state = resolvedReceiptState.get(input as RuntimeQueryPlannerResolvedReceiptV1);
  if (!state) throw new RuntimeQueryPlannerError('resolution_failed');
  return state;
}

export function buildRuntimeQueryPlanV1(input: {
  tenantId: unknown;
  projectName: unknown;
  entityScope: unknown;
  asOf?: unknown;
}): QueryPlanV1 {
  return buildRuntimeQueryPlannerReceiptV1(input).plan;
}
