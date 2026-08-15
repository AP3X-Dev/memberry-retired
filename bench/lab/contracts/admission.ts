import type { AdmissionObservationV1, AdmissionSafeFactsV1 } from '../../../packages/core/src/admission.js';

export const ADMISSION_STRUCTURAL_CONTRACT_VERSION = '1.0.0' as const;
export const ADMISSION_STRUCTURAL_FIDELITY = 'production-core / fixture-persistence' as const;

export type AdmissionStructuralCapability =
  | 'baseline-effects'
  | 'shadow-observation'
  | 'fault-injection'
  | 'late-settlement'
  | 'tenant-isolation'
  | 'pre-redaction'
  | 'default-off';

export type AdmissionStructuralSplit = 'dev' | 'holdout';
export type AdmissionStructuralExecutionMode = 'proxy' | 'fixture' | 'live';
export type AdmissionStructuralOutcome = 'scored' | 'unsupported' | 'failed';
export type AdmissionBaselineOutcome = 'accepted' | 'duplicate' | 'rejected' | 'failed';
export type AdmissionDeliveryOutcome = 'not-attempted' | 'stored' | 'failed' | 'timed-out';
export type AdmissionObservationExpectation = 'none' | 'stored' | 'eventual';
export type AdmissionSidecarFault = 'reject' | 'commit-then-late-success';

export interface AdmissionStructuralEpisodeInput {
  session_id: string;
  agent_id: string;
  task: string;
  content: string;
  tenantId: string;
  tags?: readonly string[];
  scope?: string;
  memory_type?: 'decision' | 'pattern' | 'convention' | 'architecture' | 'preference' | 'fact' | 'general';
  outcome?: 'approved' | 'revised' | 'rejected' | 'abandoned';
  signals?: readonly { type: 'reinforcement' | 'correction' | 'contradiction'; target_id: string; detail: string }[];
  entities?: readonly string[];
  model_id?: string;
}

export interface AdmissionStructuralOperationInput {
  id: string;
  input: AdmissionStructuralEpisodeInput;
}

export interface AdmissionStructuralScenarioInput {
  version: typeof ADMISSION_STRUCTURAL_CONTRACT_VERSION;
  id: string;
  split: AdmissionStructuralSplit;
  title: string;
  requiredCapabilities: readonly AdmissionStructuralCapability[];
  config: {
    shadowEnabled: boolean;
    redactOnIngest: boolean;
    timeoutMs: number;
  };
  operations: readonly AdmissionStructuralOperationInput[];
  faults?: {
    embedding?: readonly string[];
    baseline?: readonly string[];
    sidecar?: Readonly<Record<string, AdmissionSidecarFault>>;
  };
}

export interface AdmissionStructuralOperationOracle {
  operationId: string;
  baselineOutcome: AdmissionBaselineOutcome;
  delivery: AdmissionDeliveryOutcome;
  observation: AdmissionObservationExpectation;
  safeFacts?: Readonly<Omit<AdmissionSafeFactsV1, symbol | 'contractVersion'>>;
}

export interface AdmissionStructuralScenarioOracle {
  version: typeof ADMISSION_STRUCTURAL_CONTRACT_VERSION;
  scenarioId: string;
  expectedEpisodeCount: number;
  expectedObservationCount: number;
  operations: readonly AdmissionStructuralOperationOracle[];
  runtime?: Readonly<Record<string, number | boolean | string | null>>;
}

export interface AdmissionStructuralObservationRecord {
  operationId: string;
  scope: { tenantId: string; projectScope: string; episodeId: string };
  observation: AdmissionObservationV1;
}

export interface AdmissionStructuralOperationExecution {
  operationId: string;
  baselineOutcome: AdmissionBaselineOutcome;
  delivery: AdmissionDeliveryOutcome;
  episodeId?: string;
}

export interface AdmissionStructuralSystemExecution {
  scenarioId: string;
  split: AdmissionStructuralSplit;
  systemId: string;
  executionMode: AdmissionStructuralExecutionMode;
  fidelity: typeof ADMISSION_STRUCTURAL_FIDELITY;
  outcome: AdmissionStructuralOutcome;
  unsupportedCode?: 'missing-capability' | 'wrong-fidelity';
  failureCode?: 'invalid-input' | 'system-failure';
  operations: readonly AdmissionStructuralOperationExecution[];
  /** Scorer-internal only. It is never serialized into a report or artifact. */
  baselineTrace: readonly unknown[];
  /** Scorer-internal only. It is never serialized into a report or artifact. */
  observations: readonly AdmissionStructuralObservationRecord[];
  committedEpisodeCount: number;
  runtime: Readonly<Record<string, number | boolean | string | null>>;
}

export interface AdmissionStructuralSystem {
  readonly id: string;
  readonly executionMode: AdmissionStructuralExecutionMode;
  readonly fidelity: typeof ADMISSION_STRUCTURAL_FIDELITY;
  readonly contractVersion: typeof ADMISSION_STRUCTURAL_CONTRACT_VERSION;
  readonly capabilities: ReadonlySet<AdmissionStructuralCapability>;
  execute(input: AdmissionStructuralScenarioInput): Promise<AdmissionStructuralSystemExecution>;
}

export interface AdmissionStructuralMetrics {
  scenarioCoverage: number;
  baselineOutcomeParity: number;
  baselineWriteParity: number;
  observationAccuracy: number;
  safeFactsAccuracy: number;
  policyParity: number;
  deliveryAccuracy: number;
  contentLeakRate: number;
  scopeLeakRate: number;
}

export interface AdmissionStructuralScenarioReport {
  scenarioId: string;
  split: AdmissionStructuralSplit;
  outcome: AdmissionStructuralOutcome;
  unsupportedCode?: string;
  failureCode?: string;
  checks: Readonly<Record<keyof Omit<AdmissionStructuralMetrics, 'scenarioCoverage'>, boolean>>;
}

export interface AdmissionStructuralReport {
  contractVersion: typeof ADMISSION_STRUCTURAL_CONTRACT_VERSION;
  runId: string;
  evidenceMode: 'ad-hoc' | 'registered-ci';
  executionMode: 'fixture';
  fidelity: typeof ADMISSION_STRUCTURAL_FIDELITY;
  controlSystem: string;
  candidateSystem: string;
  policy: Readonly<Record<string, number>>;
  scenarios: readonly AdmissionStructuralScenarioReport[];
  metrics: AdmissionStructuralMetrics;
  failures: readonly string[];
  passed: boolean;
}

const SCORER_ONLY_KEYS = new Set([
  'oracle', 'expected', 'safeFacts', 'recommendation', 'recommendedTier',
  'wouldChangeBaseline', 'metrics', 'baselineOutcome', 'delivery', 'observation',
]);
const CAPABILITIES = new Set<AdmissionStructuralCapability>([
  'baseline-effects', 'shadow-observation', 'fault-injection', 'late-settlement',
  'tenant-isolation', 'pre-redaction', 'default-off',
]);

function scorerKeys(value: unknown, path: string, errors: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scorerKeys(entry, `${path}[${index}]`, errors));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SCORER_ONLY_KEYS.has(key)) errors.push(`${path}.${key}: scorer-only key is forbidden in system input`);
    scorerKeys(child, `${path}.${key}`, errors);
  }
}

export function validateAdmissionStructuralInput(value: AdmissionStructuralScenarioInput): string[] {
  const errors: string[] = [];
  scorerKeys(value, 'input', errors);
  if (!value || typeof value !== 'object') return [...errors, 'input must be an object'];
  if (value.version !== ADMISSION_STRUCTURAL_CONTRACT_VERSION) errors.push('unsupported admission structural input version');
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(value.id ?? '')) errors.push('input id must be stable');
  if (value.split !== 'dev' && value.split !== 'holdout') errors.push('input split must be dev or holdout');
  if (!Array.isArray(value.requiredCapabilities)
    || value.requiredCapabilities.some((capability) => !CAPABILITIES.has(capability))) errors.push('input capabilities are invalid');
  if (!value.config || typeof value.config.shadowEnabled !== 'boolean'
    || typeof value.config.redactOnIngest !== 'boolean'
    || !Number.isSafeInteger(value.config.timeoutMs)
    || value.config.timeoutMs < 1 || value.config.timeoutMs > 1_000) errors.push('input config is invalid');
  if (!Array.isArray(value.operations) || value.operations.length === 0) errors.push('input operations are required');
  const ids = new Set<string>();
  for (const operation of value.operations ?? []) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(operation.id ?? '') || ids.has(operation.id)) errors.push('operation ids must be unique stable ids');
    ids.add(operation.id);
    const input = operation.input;
    if (!input || typeof input.session_id !== 'string' || typeof input.agent_id !== 'string'
      || typeof input.task !== 'string' || typeof input.content !== 'string'
      || typeof input.tenantId !== 'string') errors.push(`${operation.id}: episode input is invalid`);
  }
  for (const id of [...(value.faults?.embedding ?? []), ...(value.faults?.baseline ?? []), ...Object.keys(value.faults?.sidecar ?? {})]) {
    if (!ids.has(id)) errors.push(`fault names unknown operation ${id}`);
  }
  return [...new Set(errors)];
}
