import { types as nodeUtilTypes } from 'node:util';

import { redactSecrets } from './redact.js';
import type { MemoryType } from './types.js';

export const ADMISSION_CONTRACT_VERSION = '1.0.0' as const;
export const BASELINE_PARITY_POLICY_ID = 'baseline-parity-admission' as const;
export const BASELINE_PARITY_POLICY_VERSION = '1.0.0' as const;

export const ADMISSION_TIERS = [
  'discard',
  'working',
  'episodic',
  'semantic-candidate',
  'protected',
] as const;

export type AdmissionTier = (typeof ADMISSION_TIERS)[number];
export type AdmissionCaptureState = 'accepted-nonduplicate' | 'duplicate' | 'rejected';
export type AdmissionMemoryClass = MemoryType | 'unclassified';
export type AdmissionOutcome = 'approved' | 'revised' | 'rejected' | 'abandoned' | 'unspecified';
export type AdmissionTenantScope = 'resolved' | 'missing';
export type AdmissionProjectScope = 'resolved' | 'missing' | 'conflicting';
export type AdmissionSensitivity = 'detected' | 'not-detected';
export type AdmissionReasonCode = 'baseline-parity-accepted-nonduplicate';

export type AdmissionContractErrorCode =
  | 'not_object'
  | 'unknown_key'
  | 'missing_key'
  | 'invalid_type'
  | 'invalid_enum'
  | 'out_of_bounds'
  | 'invalid_state'
  | 'invalid_clock'
  | 'invalid_identifier';

/** Contract failures mention only closed field paths and codes, never input values. */
export class AdmissionContractError extends Error {
  constructor(
    readonly code: AdmissionContractErrorCode,
    readonly field: string,
  ) {
    super(`admission_contract:${code}:${field}`);
    this.name = 'AdmissionContractError';
  }
}

const MEMORY_CLASSES: readonly AdmissionMemoryClass[] = [
  'decision',
  'pattern',
  'convention',
  'architecture',
  'preference',
  'fact',
  'general',
  'unclassified',
];
const OUTCOMES: readonly AdmissionOutcome[] = ['approved', 'revised', 'rejected', 'abandoned', 'unspecified'];
const CAPTURE_STATES: readonly AdmissionCaptureState[] = ['accepted-nonduplicate', 'duplicate', 'rejected'];
const TENANT_SCOPES: readonly AdmissionTenantScope[] = ['resolved', 'missing'];
const PROJECT_SCOPES: readonly AdmissionProjectScope[] = ['resolved', 'missing', 'conflicting'];
const SENSITIVITY_FACTS: readonly AdmissionSensitivity[] = ['detected', 'not-detected'];
const MAX_INPUT_TASK = 5_000;
const MAX_INPUT_CONTENT = 10_000;
const MAX_INPUT_TAGS = 50;
const MAX_IDENTIFIER = 500;
const SAFE_PROJECT_SCOPE = /^project:[A-Za-z0-9][A-Za-z0-9._-]*$/;

const SAFE_FACTS_BRAND: unique symbol = Symbol('AdmissionSafeFactsV1');

export interface TrustedAdmissionInputV1 {
  captureState: AdmissionCaptureState;
  task: string;
  content: string;
  tags?: readonly string[];
  scope?: string;
  tenantId?: string;
  redactionConfigured: boolean;
  memoryType?: MemoryType;
  outcome?: Exclude<AdmissionOutcome, 'unspecified'>;
  hasSignals: boolean;
  hasEntities: boolean;
  hasModel: boolean;
}

/**
 * The only value an admission policy may inspect. Raw content, task, tags,
 * tenant identifiers, and project identifiers are deliberately absent.
 */
export interface AdmissionSafeFactsV1 {
  readonly contractVersion: typeof ADMISSION_CONTRACT_VERSION;
  readonly captureState: AdmissionCaptureState;
  readonly memoryClass: AdmissionMemoryClass;
  readonly outcome: AdmissionOutcome;
  readonly tenantScope: AdmissionTenantScope;
  readonly projectScope: AdmissionProjectScope;
  readonly sensitivity: AdmissionSensitivity;
  readonly redactionConfigured: boolean;
  readonly hasSignals: boolean;
  readonly hasEntities: boolean;
  readonly hasModel: boolean;
  readonly [SAFE_FACTS_BRAND]: true;
}

export interface AdmissionRecommendationV1 {
  readonly contractVersion: typeof ADMISSION_CONTRACT_VERSION;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly recommendedTier: AdmissionTier;
  readonly wouldChangeBaseline: boolean;
  readonly reasonCode: AdmissionReasonCode;
}

export interface AdmissionPolicyV1 {
  readonly id: string;
  readonly version: string;
  readonly supportedTier: AdmissionTier;
}

export interface AdmissionClock {
  now(): Date;
}

export interface AdmissionObservationV1 {
  readonly contractVersion: typeof ADMISSION_CONTRACT_VERSION;
  readonly safeFacts: AdmissionSafeFactsV1;
  readonly recommendation: AdmissionRecommendationV1;
  readonly observedAt: string;
}

export interface AdmissionObservationInputV1 {
  readonly safeFacts: AdmissionSafeFactsV1;
}

function record(value: unknown, field: string): Record<PropertyKey, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new AdmissionContractError('not_object', field);
    }
    if (nodeUtilTypes.isProxy(value)) throw new AdmissionContractError('invalid_type', field);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new AdmissionContractError('invalid_type', field);
    }
    const clone = Object.create(null) as Record<PropertyKey, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw new AdmissionContractError('invalid_type', field);
      }
      Object.defineProperty(clone, key, {
        value: descriptor.value,
        enumerable: descriptor.enumerable,
        configurable: true,
        writable: true,
      });
    }
    return clone;
  } catch (error) {
    if (error instanceof AdmissionContractError) throw error;
    throw new AdmissionContractError('invalid_type', field);
  }
}

function exactKeys(
  value: Record<PropertyKey, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  field: string,
  allowedSymbols: readonly symbol[] = [],
): void {
  const allowedNames = new Set(allowed);
  const allowedSymbolSet = new Set(allowedSymbols);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol' ? !allowedSymbolSet.has(key) : !allowedNames.has(key)) {
      throw new AdmissionContractError('unknown_key', field);
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new AdmissionContractError('missing_key', `${field}.${key}`);
    }
  }
}

function stringValue(value: unknown, field: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string') throw new AdmissionContractError('invalid_type', field);
  if (value.length > max || (!allowEmpty && value.trim().length === 0)) {
    throw new AdmissionContractError('out_of_bounds', field);
  }
  return value;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new AdmissionContractError('invalid_type', field);
  return value;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new AdmissionContractError('invalid_enum', field);
  }
  return value as T;
}

function optionalString(value: unknown, field: string, max: number): string | undefined {
  return value === undefined ? undefined : stringValue(value, field, max, true);
}

function denseStringArray(value: unknown, field: string, maxItems: number, maxItemLength: number): readonly string[] {
  try {
    if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      throw new AdmissionContractError('invalid_type', field);
    }
    const keys = Reflect.ownKeys(value);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (lengthDescriptor === undefined || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')) {
      throw new AdmissionContractError('invalid_type', field);
    }
    const length = lengthDescriptor.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > maxItems) {
      throw new AdmissionContractError('out_of_bounds', field);
    }
    const expectedKeys = new Set<PropertyKey>(['length']);
    for (let index = 0; index < length; index += 1) expectedKeys.add(String(index));
    if (keys.length !== expectedKeys.size || keys.some((key) => !expectedKeys.has(key))) {
      throw new AdmissionContractError('unknown_key', field);
    }

    const result: string[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw new AdmissionContractError('invalid_type', `${field}[]`);
      }
      result.push(stringValue(descriptor.value, `${field}[]`, maxItemLength, true));
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof AdmissionContractError) throw error;
    throw new AdmissionContractError('invalid_type', field);
  }
}

function brandSafeFacts(data: Omit<AdmissionSafeFactsV1, typeof SAFE_FACTS_BRAND>): AdmissionSafeFactsV1 {
  const target = { ...data } as AdmissionSafeFactsV1;
  Object.defineProperty(target, SAFE_FACTS_BRAND, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(target);
}

export function parseAdmissionSafeFactsV1(value: unknown): AdmissionSafeFactsV1 {
  const input = record(value, 'safeFacts');
  const keys = [
    'contractVersion',
    'captureState',
    'memoryClass',
    'outcome',
    'tenantScope',
    'projectScope',
    'sensitivity',
    'redactionConfigured',
    'hasSignals',
    'hasEntities',
    'hasModel',
  ] as const;
  exactKeys(input, keys, keys, 'safeFacts', [SAFE_FACTS_BRAND]);
  if (input.contractVersion !== ADMISSION_CONTRACT_VERSION) {
    throw new AdmissionContractError('invalid_enum', 'safeFacts.contractVersion');
  }
  return brandSafeFacts({
    contractVersion: ADMISSION_CONTRACT_VERSION,
    captureState: enumValue(input.captureState, CAPTURE_STATES, 'safeFacts.captureState'),
    memoryClass: enumValue(input.memoryClass, MEMORY_CLASSES, 'safeFacts.memoryClass'),
    outcome: enumValue(input.outcome, OUTCOMES, 'safeFacts.outcome'),
    tenantScope: enumValue(input.tenantScope, TENANT_SCOPES, 'safeFacts.tenantScope'),
    projectScope: enumValue(input.projectScope, PROJECT_SCOPES, 'safeFacts.projectScope'),
    sensitivity: enumValue(input.sensitivity, SENSITIVITY_FACTS, 'safeFacts.sensitivity'),
    redactionConfigured: booleanValue(input.redactionConfigured, 'safeFacts.redactionConfigured'),
    hasSignals: booleanValue(input.hasSignals, 'safeFacts.hasSignals'),
    hasEntities: booleanValue(input.hasEntities, 'safeFacts.hasEntities'),
    hasModel: booleanValue(input.hasModel, 'safeFacts.hasModel'),
  });
}

function parseTrustedInput(value: unknown): TrustedAdmissionInputV1 {
  const input = record(value, 'trustedInput');
  const allowed = [
    'captureState',
    'task',
    'content',
    'tags',
    'scope',
    'tenantId',
    'redactionConfigured',
    'memoryType',
    'outcome',
    'hasSignals',
    'hasEntities',
    'hasModel',
  ] as const;
  const required = [
    'captureState',
    'task',
    'content',
    'redactionConfigured',
    'hasSignals',
    'hasEntities',
    'hasModel',
  ] as const;
  exactKeys(input, allowed, required, 'trustedInput');

  let tags: readonly string[] | undefined;
  if (input.tags !== undefined) {
    tags = denseStringArray(input.tags, 'trustedInput.tags', MAX_INPUT_TAGS, MAX_IDENTIFIER);
  }

  const memoryType = input.memoryType === undefined
    ? undefined
    : enumValue(input.memoryType, MEMORY_CLASSES.filter((item) => item !== 'unclassified') as MemoryType[], 'trustedInput.memoryType');
  const outcome = input.outcome === undefined
    ? undefined
    : enumValue(input.outcome, OUTCOMES.filter((item) => item !== 'unspecified') as Array<Exclude<AdmissionOutcome, 'unspecified'>>, 'trustedInput.outcome');

  return Object.freeze({
    captureState: enumValue(input.captureState, CAPTURE_STATES, 'trustedInput.captureState'),
    task: stringValue(input.task, 'trustedInput.task', MAX_INPUT_TASK, true),
    content: stringValue(input.content, 'trustedInput.content', MAX_INPUT_CONTENT, true),
    ...(tags !== undefined ? { tags } : {}),
    ...(input.scope !== undefined ? { scope: optionalString(input.scope, 'trustedInput.scope', MAX_IDENTIFIER) } : {}),
    ...(input.tenantId !== undefined ? { tenantId: optionalString(input.tenantId, 'trustedInput.tenantId', MAX_IDENTIFIER) } : {}),
    redactionConfigured: booleanValue(input.redactionConfigured, 'trustedInput.redactionConfigured'),
    ...(memoryType !== undefined ? { memoryType } : {}),
    ...(outcome !== undefined ? { outcome } : {}),
    hasSignals: booleanValue(input.hasSignals, 'trustedInput.hasSignals'),
    hasEntities: booleanValue(input.hasEntities, 'trustedInput.hasEntities'),
    hasModel: booleanValue(input.hasModel, 'trustedInput.hasModel'),
  });
}

function projectScopeFact(scope: string | undefined, tags: readonly string[]): AdmissionProjectScope {
  const explicitRaw = scope?.trim() ?? '';
  const explicit = SAFE_PROJECT_SCOPE.test(explicitRaw) ? explicitRaw.toLowerCase() : null;
  if (explicitRaw !== '' && explicit === null) return 'conflicting';

  const projectTags = tags.filter((tag) => tag.trim().toLowerCase().startsWith('project:'));
  if (projectTags.some((tag) => !SAFE_PROJECT_SCOPE.test(tag.trim()))) return 'conflicting';
  const distinctTags = new Set(projectTags.map((tag) => tag.trim().toLowerCase()));
  if (distinctTags.size > 1) return 'conflicting';
  if (explicit && distinctTags.size === 1 && !distinctTags.has(explicit)) return 'conflicting';
  return explicit || distinctTags.size === 1 ? 'resolved' : 'missing';
}

/**
 * Trusted raw-data boundary. It allocates a new, branded safe-facts object and
 * makes only that object available to the baseline policy boundary; raw strings
 * and identifiers stop here.
 */
export class TrustedAdmissionPreprocessorV1 {
  preprocess(value: TrustedAdmissionInputV1): AdmissionSafeFactsV1 {
    const input = parseTrustedInput(value);
    const sensitivityInputs = [
      input.task,
      input.content,
      ...(input.tags ?? []),
      ...(input.scope === undefined ? [] : [input.scope]),
      ...(input.tenantId === undefined ? [] : [input.tenantId]),
    ];
    const sensitivityDetected = sensitivityInputs.some((item) => redactSecrets(item) !== item);
    return brandSafeFacts({
      contractVersion: ADMISSION_CONTRACT_VERSION,
      captureState: input.captureState,
      memoryClass: input.memoryType ?? 'unclassified',
      outcome: input.outcome ?? 'unspecified',
      tenantScope: input.tenantId?.trim() ? 'resolved' : 'missing',
      projectScope: projectScopeFact(input.scope, input.tags ?? []),
      sensitivity: sensitivityDetected ? 'detected' : 'not-detected',
      redactionConfigured: input.redactionConfigured,
      hasSignals: input.hasSignals,
      hasEntities: input.hasEntities,
      hasModel: input.hasModel,
    });
  }
}

export function parseAdmissionRecommendationV1(value: unknown): AdmissionRecommendationV1 {
  const input = record(value, 'recommendation');
  const keys = [
    'contractVersion',
    'policyId',
    'policyVersion',
    'recommendedTier',
    'wouldChangeBaseline',
    'reasonCode',
  ] as const;
  exactKeys(input, keys, keys, 'recommendation');
  if (input.contractVersion !== ADMISSION_CONTRACT_VERSION) {
    throw new AdmissionContractError('invalid_enum', 'recommendation.contractVersion');
  }
  if (input.policyId !== BASELINE_PARITY_POLICY_ID) {
    throw new AdmissionContractError('invalid_state', 'recommendation.policyId');
  }
  if (input.policyVersion !== BASELINE_PARITY_POLICY_VERSION) {
    throw new AdmissionContractError('invalid_state', 'recommendation.policyVersion');
  }
  if (input.recommendedTier !== 'episodic') {
    throw new AdmissionContractError('invalid_state', 'recommendation.recommendedTier');
  }
  if (input.wouldChangeBaseline !== false) {
    throw new AdmissionContractError('invalid_state', 'recommendation.wouldChangeBaseline');
  }
  if (input.reasonCode !== 'baseline-parity-accepted-nonduplicate') {
    throw new AdmissionContractError('invalid_state', 'recommendation.reasonCode');
  }
  return Object.freeze({
    contractVersion: ADMISSION_CONTRACT_VERSION,
    policyId: BASELINE_PARITY_POLICY_ID,
    policyVersion: BASELINE_PARITY_POLICY_VERSION,
    recommendedTier: 'episodic',
    wouldChangeBaseline: false,
    reasonCode: 'baseline-parity-accepted-nonduplicate',
  });
}

/** The MEM-001A control policy: observe accepted writes and preserve their route. */
export class BaselineParityAdmissionPolicyV1 implements AdmissionPolicyV1 {
  readonly id = BASELINE_PARITY_POLICY_ID;
  readonly version = BASELINE_PARITY_POLICY_VERSION;
  readonly supportedTier = 'episodic' as const;

  evaluate(value: AdmissionSafeFactsV1): AdmissionRecommendationV1 {
    const facts = parseAdmissionSafeFactsV1(value);
    if (facts.captureState !== 'accepted-nonduplicate') {
      throw new AdmissionContractError('invalid_state', 'safeFacts.captureState');
    }
    return Object.freeze({
      contractVersion: ADMISSION_CONTRACT_VERSION,
      policyId: this.id,
      policyVersion: this.version,
      recommendedTier: 'episodic',
      wouldChangeBaseline: false,
      reasonCode: 'baseline-parity-accepted-nonduplicate',
    });
  }
}

function canonicalTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new AdmissionContractError('invalid_type', field);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new AdmissionContractError('invalid_clock', field);
  }
  return value;
}

export function parseAdmissionObservationV1(value: unknown): AdmissionObservationV1 {
  const input = record(value, 'observation');
  const keys = [
    'contractVersion',
    'safeFacts',
    'recommendation',
    'observedAt',
  ] as const;
  exactKeys(input, keys, keys, 'observation');
  if (input.contractVersion !== ADMISSION_CONTRACT_VERSION) {
    throw new AdmissionContractError('invalid_enum', 'observation.contractVersion');
  }
  const safeFacts = parseAdmissionSafeFactsV1(input.safeFacts);
  if (safeFacts.captureState !== 'accepted-nonduplicate') {
    throw new AdmissionContractError('invalid_state', 'safeFacts.captureState');
  }
  const recommendation = parseAdmissionRecommendationV1(input.recommendation);
  return Object.freeze({
    contractVersion: ADMISSION_CONTRACT_VERSION,
    safeFacts,
    recommendation,
    observedAt: canonicalTimestamp(input.observedAt, 'observation.observedAt'),
  });
}

export function createAdmissionObservationV1(
  input: AdmissionObservationInputV1,
  clock: AdmissionClock,
): AdmissionObservationV1 {
  const rawInput = record(input, 'observationInput');
  exactKeys(rawInput, ['safeFacts'], ['safeFacts'], 'observationInput');
  const safeFacts = parseAdmissionSafeFactsV1(rawInput.safeFacts);
  const recommendation = new BaselineParityAdmissionPolicyV1().evaluate(safeFacts);
  let now: Date;
  try {
    now = clock.now();
  } catch {
    throw new AdmissionContractError('invalid_clock', 'observation.observedAt');
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new AdmissionContractError('invalid_clock', 'observation.observedAt');
  }
  const observedAt = now.toISOString();
  return parseAdmissionObservationV1({
    contractVersion: ADMISSION_CONTRACT_VERSION,
    safeFacts,
    recommendation,
    observedAt,
  });
}
