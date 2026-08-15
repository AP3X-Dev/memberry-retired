import { types as nodeUtilTypes } from 'node:util';

import {
  ADMISSION_CONTRACT_VERSION,
  parseAdmissionSafeFactsV1,
} from '../../../packages/core/src/admission.js';
import {
  ADMISSION_STRUCTURAL_CONTRACT_VERSION,
  type AdmissionBaselineOutcome,
  type AdmissionDeliveryOutcome,
  type AdmissionObservationExpectation,
  type AdmissionStructuralOperationOracle,
  type AdmissionStructuralScenarioOracle,
} from '../contracts/admission.js';

const BASELINE_OUTCOMES = new Set<AdmissionBaselineOutcome>(['accepted', 'duplicate', 'rejected', 'failed']);
const DELIVERY_OUTCOMES = new Set<AdmissionDeliveryOutcome>(['not-attempted', 'stored', 'failed', 'timed-out']);
const OBSERVATION_EXPECTATIONS = new Set<AdmissionObservationExpectation>(['none', 'stored', 'eventual']);
export const ADMISSION_ORACLE_SAFE_FACT_KEYS = [
  'captureState', 'memoryClass', 'outcome', 'tenantScope', 'projectScope',
  'sensitivity', 'redactionConfigured', 'hasSignals', 'hasEntities', 'hasModel',
] as const;

class AdmissionOracleContractError extends Error {
  constructor(reason: string, field: string) {
    super(`admission_oracle:${reason}:${field}`);
    this.name = 'AdmissionOracleContractError';
  }
}

function dataRecord(
  value: unknown,
  field: string,
  allowed: readonly string[],
  required: readonly string[],
): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    throw new AdmissionOracleContractError('not_plain_object', field);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AdmissionOracleContractError('not_plain_object', field);
  }
  const allowedKeys = new Set(allowed);
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) {
      throw new AdmissionOracleContractError('unknown_key', field);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new AdmissionOracleContractError('accessor_forbidden', `${field}.${key}`);
    }
    result[key] = descriptor.value;
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(result, key)) {
      throw new AdmissionOracleContractError('missing_key', `${field}.${key}`);
    }
  }
  return result;
}

function denseDataArray(value: unknown, field: string): readonly unknown[] {
  if (typeof value !== 'object' || value === null || nodeUtilTypes.isProxy(value) || !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new AdmissionOracleContractError('not_plain_array', field);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (lengthDescriptor === undefined || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
    || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
    throw new AdmissionOracleContractError('invalid_array', field);
  }
  const length = lengthDescriptor.value as number;
  const expectedKeys = new Set<PropertyKey>(['length']);
  for (let index = 0; index < length; index += 1) expectedKeys.add(String(index));
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedKeys.size || keys.some((key) => !expectedKeys.has(key))) {
    throw new AdmissionOracleContractError('invalid_array', field);
  }
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new AdmissionOracleContractError('accessor_forbidden', `${field}[]`);
    }
    result.push(descriptor.value);
  }
  return result;
}

function safeFacts(value: unknown): NonNullable<AdmissionStructuralOperationOracle['safeFacts']> {
  const facts = dataRecord(
    value,
    'oracle.operation.safeFacts',
    ADMISSION_ORACLE_SAFE_FACT_KEYS,
    ADMISSION_ORACLE_SAFE_FACT_KEYS,
  );
  const parsed = parseAdmissionSafeFactsV1({
    contractVersion: ADMISSION_CONTRACT_VERSION,
    ...facts,
  });
  return Object.freeze({
    captureState: parsed.captureState,
    memoryClass: parsed.memoryClass,
    outcome: parsed.outcome,
    tenantScope: parsed.tenantScope,
    projectScope: parsed.projectScope,
    sensitivity: parsed.sensitivity,
    redactionConfigured: parsed.redactionConfigured,
    hasSignals: parsed.hasSignals,
    hasEntities: parsed.hasEntities,
    hasModel: parsed.hasModel,
  });
}

function runtimeRecord(value: unknown): Readonly<Record<string, number | boolean | string | null>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    throw new AdmissionOracleContractError('not_plain_object', 'oracle.runtime');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AdmissionOracleContractError('not_plain_object', 'oracle.runtime');
  }
  const result: Record<string, number | boolean | string | null> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new AdmissionOracleContractError('unknown_key', 'oracle.runtime');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new AdmissionOracleContractError('accessor_forbidden', `oracle.runtime.${key}`);
    }
    const entry = descriptor.value;
    if (entry !== null && typeof entry !== 'string' && typeof entry !== 'boolean'
      && (typeof entry !== 'number' || !Number.isFinite(entry))) {
      throw new AdmissionOracleContractError('invalid_value', `oracle.runtime.${key}`);
    }
    result[key] = entry as number | boolean | string | null;
  }
  return Object.freeze(result);
}

function operationOracle(value: unknown): AdmissionStructuralOperationOracle {
  const record = dataRecord(
    value,
    'oracle.operation',
    ['operationId', 'baselineOutcome', 'delivery', 'observation', 'safeFacts'],
    ['operationId', 'baselineOutcome', 'delivery', 'observation'],
  );
  if (typeof record.operationId !== 'string' || record.operationId.trim().length === 0) {
    throw new AdmissionOracleContractError('invalid_value', 'oracle.operation.operationId');
  }
  if (!BASELINE_OUTCOMES.has(record.baselineOutcome as AdmissionBaselineOutcome)) {
    throw new AdmissionOracleContractError('invalid_value', 'oracle.operation.baselineOutcome');
  }
  if (!DELIVERY_OUTCOMES.has(record.delivery as AdmissionDeliveryOutcome)) {
    throw new AdmissionOracleContractError('invalid_value', 'oracle.operation.delivery');
  }
  if (!OBSERVATION_EXPECTATIONS.has(record.observation as AdmissionObservationExpectation)) {
    throw new AdmissionOracleContractError('invalid_value', 'oracle.operation.observation');
  }
  const observation = record.observation as AdmissionObservationExpectation;
  const hasSafeFacts = Object.prototype.hasOwnProperty.call(record, 'safeFacts');
  if (observation === 'none' && hasSafeFacts) {
    throw new AdmissionOracleContractError('forbidden_key', 'oracle.operation.safeFacts');
  }
  if (observation !== 'none' && !hasSafeFacts) {
    throw new AdmissionOracleContractError('missing_key', 'oracle.operation.safeFacts');
  }
  return Object.freeze({
    operationId: record.operationId,
    baselineOutcome: record.baselineOutcome as AdmissionBaselineOutcome,
    delivery: record.delivery as AdmissionDeliveryOutcome,
    observation,
    ...(observation === 'none' ? {} : { safeFacts: safeFacts(record.safeFacts) }),
  });
}

export function parseAdmissionStructuralOracle(value: unknown): AdmissionStructuralScenarioOracle {
  const record = dataRecord(
    value,
    'oracle',
    ['version', 'scenarioId', 'expectedEpisodeCount', 'expectedObservationCount', 'operations', 'runtime'],
    ['version', 'scenarioId', 'expectedEpisodeCount', 'expectedObservationCount', 'operations'],
  );
  if (record.version !== ADMISSION_STRUCTURAL_CONTRACT_VERSION) {
    throw new AdmissionOracleContractError('invalid_value', 'oracle.version');
  }
  if (typeof record.scenarioId !== 'string' || record.scenarioId.trim().length === 0) {
    throw new AdmissionOracleContractError('invalid_value', 'oracle.scenarioId');
  }
  if (!Number.isSafeInteger(record.expectedEpisodeCount) || (record.expectedEpisodeCount as number) < 0) {
    throw new AdmissionOracleContractError('invalid_value', 'oracle.expectedEpisodeCount');
  }
  if (!Number.isSafeInteger(record.expectedObservationCount) || (record.expectedObservationCount as number) < 0) {
    throw new AdmissionOracleContractError('invalid_value', 'oracle.expectedObservationCount');
  }
  const operations = denseDataArray(record.operations, 'oracle.operations').map(operationOracle);
  if (operations.length === 0) throw new AdmissionOracleContractError('missing_value', 'oracle.operations');
  const operationIds = operations.map(({ operationId }) => operationId);
  if (new Set(operationIds).size !== operationIds.length) {
    throw new AdmissionOracleContractError('duplicate_value', 'oracle.operation.operationId');
  }
  const hasRuntime = Object.prototype.hasOwnProperty.call(record, 'runtime');
  return Object.freeze({
    version: ADMISSION_STRUCTURAL_CONTRACT_VERSION,
    scenarioId: record.scenarioId,
    expectedEpisodeCount: record.expectedEpisodeCount as number,
    expectedObservationCount: record.expectedObservationCount as number,
    operations: Object.freeze(operations),
    ...(hasRuntime ? { runtime: runtimeRecord(record.runtime) } : {}),
  });
}

export function parseAdmissionStructuralOracleList(value: unknown): readonly AdmissionStructuralScenarioOracle[] {
  return Object.freeze(denseDataArray(value, 'oracles').map(parseAdmissionStructuralOracle));
}

export function validateAdmissionStructuralOracle(value: unknown): string[] {
  try {
    parseAdmissionStructuralOracle(value);
    return [];
  } catch (error) {
    return [error instanceof AdmissionOracleContractError
      ? error.message
      : 'admission_oracle:invalid_value:oracle.operation.safeFacts'];
  }
}
