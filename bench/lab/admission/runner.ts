import {
  BASELINE_PARITY_POLICY_ID,
  BASELINE_PARITY_POLICY_VERSION,
  parseAdmissionObservationV1,
} from '../../../packages/core/src/admission.js';
import {
  ADMISSION_STRUCTURAL_CONTRACT_VERSION,
  ADMISSION_STRUCTURAL_FIDELITY,
  type AdmissionStructuralMetrics,
  type AdmissionStructuralReport,
  type AdmissionStructuralScenarioInput,
  type AdmissionStructuralScenarioOracle,
  type AdmissionStructuralScenarioReport,
  type AdmissionStructuralSystemExecution,
} from '../contracts/admission.js';
import { ADMISSION_ORACLE_SAFE_FACT_KEYS, parseAdmissionStructuralOracleList } from './oracle.js';

export const ADMISSION_STRUCTURAL_POLICY = Object.freeze({
  scenarioCoverage: 1,
  baselineOutcomeParity: 1,
  baselineWriteParity: 1,
  observationAccuracy: 1,
  safeFactsAccuracy: 1,
  policyParity: 1,
  deliveryAccuracy: 1,
  contentLeakRate: 0,
  scopeLeakRate: 0,
});

type ScenarioChecks = AdmissionStructuralScenarioReport['checks'];
const POSITIVE_CHECKS = [
  'baselineOutcomeParity', 'baselineWriteParity', 'observationAccuracy',
  'safeFactsAccuracy', 'policyParity', 'deliveryAccuracy',
] as const;

function exact(value: unknown, expected: unknown): boolean {
  return JSON.stringify(value) === JSON.stringify(expected);
}

function canonicalProject(input: AdmissionStructuralScenarioInput['operations'][number]['input']): string {
  const explicit = input.scope?.trim();
  if (explicit) return explicit.toLowerCase();
  const tag = input.tags?.find((value) => /^project:/i.test(value));
  if (tag) return tag.toLowerCase();
  const prefix = (input.task.match(/^\[project:([\w.-]+)\]/i)
    ?? input.content.match(/^\[project:([\w.-]+)\]/i))?.[1];
  return prefix ? `project:${prefix.toLowerCase()}` : '';
}

function falseChecks(): ScenarioChecks {
  return {
    baselineOutcomeParity: false,
    baselineWriteParity: false,
    observationAccuracy: false,
    safeFactsAccuracy: false,
    policyParity: false,
    deliveryAccuracy: false,
    contentLeakRate: false,
    scopeLeakRate: false,
  };
}

function scoreScenario(
  input: AdmissionStructuralScenarioInput,
  oracle: AdmissionStructuralScenarioOracle | undefined,
  control: AdmissionStructuralSystemExecution | undefined,
  candidate: AdmissionStructuralSystemExecution | undefined,
): AdmissionStructuralScenarioReport {
  if (!oracle || !control || !candidate) {
    return { scenarioId: input.id, split: input.split, outcome: 'failed', failureCode: 'missing-required-evidence', checks: falseChecks() };
  }
  if (control.outcome !== 'scored' || candidate.outcome !== 'scored') {
    const unsupported = control.outcome === 'unsupported' || candidate.outcome === 'unsupported';
    return {
      scenarioId: input.id,
      split: input.split,
      outcome: unsupported ? 'unsupported' : 'failed',
      ...(unsupported
        ? { unsupportedCode: control.unsupportedCode ?? candidate.unsupportedCode ?? 'required-system-unsupported' }
        : { failureCode: control.failureCode ?? candidate.failureCode ?? 'required-system-failed' }),
      checks: falseChecks(),
    };
  }

  const expectedOperations = new Map(oracle.operations.map((operation) => [operation.operationId, operation]));
  const controlOperations = new Map(control.operations.map((operation) => [operation.operationId, operation]));
  const candidateOperations = new Map(candidate.operations.map((operation) => [operation.operationId, operation]));
  const requiredOperationIds = input.operations.map(({ id }) => id);
  const exactOperationIds = (ids: readonly string[]) => ids.length === requiredOperationIds.length
    && new Set(ids).size === ids.length
    && requiredOperationIds.every((id) => ids.includes(id));
  const baselineOutcomeParity = exactOperationIds(oracle.operations.map(({ operationId }) => operationId))
    && exactOperationIds(control.operations.map(({ operationId }) => operationId))
    && exactOperationIds(candidate.operations.map(({ operationId }) => operationId))
    && input.operations.every(({ id }) => {
      const expected = expectedOperations.get(id);
      return expected !== undefined
        && controlOperations.get(id)?.baselineOutcome === expected.baselineOutcome
        && candidateOperations.get(id)?.baselineOutcome === expected.baselineOutcome;
    });
  const baselineWriteParity = exact(control.baselineTrace, candidate.baselineTrace)
    && control.committedEpisodeCount === oracle.expectedEpisodeCount
    && candidate.committedEpisodeCount === oracle.expectedEpisodeCount;

  const observations = new Map<string, typeof candidate.observations>();
  for (const record of candidate.observations) {
    observations.set(record.operationId, [...(observations.get(record.operationId) ?? []), record]);
  }
  let observationAccuracy = control.observations.length === 0
    && candidate.observations.length === oracle.expectedObservationCount;
  let safeFactsAccuracy = true;
  let policyParity = true;
  let contentLeak = false;
  let scopeLeak = false;
  for (const operation of input.operations) {
    const expected = expectedOperations.get(operation.id);
    const records = observations.get(operation.id) ?? [];
    const expectedPresent = expected?.observation === 'stored' || expected?.observation === 'eventual';
    if ((expectedPresent && records.length !== 1) || (!expectedPresent && records.length !== 0)) {
      observationAccuracy = false;
      if (expectedPresent) {
        safeFactsAccuracy = false;
        policyParity = false;
      }
    }
    for (const record of records) {
      let parsed;
      try { parsed = parseAdmissionObservationV1(record.observation); }
      catch { parsed = null; }
      if (!parsed) {
        safeFactsAccuracy = false;
        policyParity = false;
      } else {
        if (expected?.safeFacts) {
          for (const key of ADMISSION_ORACLE_SAFE_FACT_KEYS) {
            if (parsed.safeFacts[key] !== expected.safeFacts[key]) safeFactsAccuracy = false;
          }
        }
        if (parsed.recommendation.policyId !== BASELINE_PARITY_POLICY_ID
          || parsed.recommendation.policyVersion !== BASELINE_PARITY_POLICY_VERSION
          || parsed.recommendation.recommendedTier !== 'episodic'
          || parsed.recommendation.wouldChangeBaseline !== false
          || parsed.recommendation.reasonCode !== 'baseline-parity-accepted-nonduplicate') policyParity = false;
      }
      const serialized = JSON.stringify(record.observation);
      if ([operation.input.task, operation.input.content].some((raw) => raw.length > 0 && serialized.includes(raw))) contentLeak = true;
      const actualOperation = candidateOperations.get(operation.id);
      if (!actualOperation?.episodeId
        || record.scope.episodeId !== actualOperation.episodeId
        || record.scope.tenantId !== operation.input.tenantId
        || record.scope.projectScope !== canonicalProject(operation.input)) scopeLeak = true;
    }
  }
  for (const [key, value] of Object.entries(oracle.runtime ?? {})) {
    if (candidate.runtime[key] !== value) observationAccuracy = false;
  }
  if (candidate.observations.some(({ operationId }) => !expectedOperations.has(operationId))) {
    observationAccuracy = false;
    scopeLeak = true;
  }
  if (new Set(candidate.observations.map(({ scope }) => `${scope.tenantId}\u0000${scope.projectScope}\u0000${scope.episodeId}`)).size
    !== candidate.observations.length) scopeLeak = true;

  const deliveryAccuracy = input.operations.every(({ id }) => {
    const expected = expectedOperations.get(id);
    return expected !== undefined
      && controlOperations.get(id)?.delivery === 'not-attempted'
      && candidateOperations.get(id)?.delivery === expected.delivery;
  });
  return {
    scenarioId: input.id,
    split: input.split,
    outcome: 'scored',
    checks: {
      baselineOutcomeParity,
      baselineWriteParity,
      observationAccuracy,
      safeFactsAccuracy,
      policyParity,
      deliveryAccuracy,
      contentLeakRate: !contentLeak,
      scopeLeakRate: !scopeLeak,
    },
  };
}

function ratio(reports: readonly AdmissionStructuralScenarioReport[], key: keyof ScenarioChecks): number {
  return reports.filter(({ outcome, checks }) => outcome === 'scored' && checks[key]).length / (reports.length || 1);
}

export interface ScoreAdmissionExecutionsOptions {
  runId: string;
  inputs: readonly AdmissionStructuralScenarioInput[];
  oracles: readonly AdmissionStructuralScenarioOracle[];
  controlExecutions: readonly AdmissionStructuralSystemExecution[];
  candidateExecutions: readonly AdmissionStructuralSystemExecution[];
  evidenceMode?: 'ad-hoc' | 'registered-ci';
}

export function scoreAdmissionExecutions(options: ScoreAdmissionExecutionsOptions): AdmissionStructuralReport {
  let canonicalOracles: readonly AdmissionStructuralScenarioOracle[] = [];
  let oracleParseFailure = false;
  try {
    canonicalOracles = parseAdmissionStructuralOracleList(options.oracles);
  } catch {
    oracleParseFailure = true;
  }
  const oracles = new Map(canonicalOracles.map((oracle) => [oracle.scenarioId, oracle]));
  const controls = new Map(options.controlExecutions.map((execution) => [execution.scenarioId, execution]));
  const candidates = new Map(options.candidateExecutions.map((execution) => [execution.scenarioId, execution]));
  const scenarios = options.inputs.map((input) => scoreScenario(input, oracles.get(input.id), controls.get(input.id), candidates.get(input.id)));
  const metrics: AdmissionStructuralMetrics = {
    scenarioCoverage: scenarios.filter(({ outcome }) => outcome === 'scored').length / (scenarios.length || 1),
    baselineOutcomeParity: ratio(scenarios, 'baselineOutcomeParity'),
    baselineWriteParity: ratio(scenarios, 'baselineWriteParity'),
    observationAccuracy: ratio(scenarios, 'observationAccuracy'),
    safeFactsAccuracy: ratio(scenarios, 'safeFactsAccuracy'),
    policyParity: ratio(scenarios, 'policyParity'),
    deliveryAccuracy: ratio(scenarios, 'deliveryAccuracy'),
    contentLeakRate: 1 - ratio(scenarios, 'contentLeakRate'),
    scopeLeakRate: 1 - ratio(scenarios, 'scopeLeakRate'),
  };
  const failures: string[] = oracleParseFailure ? ['oracle evidence is invalid'] : [];
  const requiredIds = options.inputs.map(({ id }) => id);
  const exactScenarioIds = (ids: readonly string[]) => ids.length === requiredIds.length
    && new Set(ids).size === ids.length
    && requiredIds.every((id) => ids.includes(id));
  if (!exactScenarioIds(canonicalOracles.map(({ scenarioId }) => scenarioId))) {
    failures.push('oracle evidence IDs must exactly match required scenarios');
  }
  if (!exactScenarioIds(options.controlExecutions.map(({ scenarioId }) => scenarioId))) {
    failures.push('control evidence IDs must exactly match required scenarios');
  }
  if (!exactScenarioIds(options.candidateExecutions.map(({ scenarioId }) => scenarioId))) {
    failures.push('candidate evidence IDs must exactly match required scenarios');
  }
  for (const scenario of scenarios) {
    if (scenario.outcome !== 'scored') failures.push(`${scenario.scenarioId}: ${scenario.outcome}`);
    for (const [check, passed] of Object.entries(scenario.checks)) if (!passed) failures.push(`${scenario.scenarioId}: ${check}`);
  }
  for (const key of ['scenarioCoverage', ...POSITIVE_CHECKS] as const) {
    if (metrics[key] !== 1) failures.push(`${key}: expected 1`);
  }
  for (const key of ['contentLeakRate', 'scopeLeakRate'] as const) {
    if (metrics[key] !== 0) failures.push(`${key}: expected 0`);
  }
  const controlSystem = options.controlExecutions[0]?.systemId ?? 'missing-control';
  const candidateSystem = options.candidateExecutions[0]?.systemId ?? 'missing-candidate';
  const report: AdmissionStructuralReport = {
    contractVersion: ADMISSION_STRUCTURAL_CONTRACT_VERSION,
    runId: options.runId,
    evidenceMode: options.evidenceMode ?? 'ad-hoc',
    executionMode: 'fixture',
    fidelity: ADMISSION_STRUCTURAL_FIDELITY,
    controlSystem,
    candidateSystem,
    policy: ADMISSION_STRUCTURAL_POLICY,
    scenarios,
    metrics,
    failures: [...new Set(failures)],
    passed: failures.length === 0,
  };

  // Reports are a closed, content-free projection. This final invariant rejects
  // accidental raw identifiers/content even if a future scorer adds fields.
  const rawValues = options.inputs.flatMap(({ operations }) => operations.flatMap(({ input }) => [
    input.task, input.content, input.tenantId, input.scope ?? '', ...(input.tags ?? []),
  ])).filter((value) => value.length >= 4);
  const serialized = JSON.stringify(report);
  if (rawValues.some((value) => serialized.includes(value))) {
    return { ...report, failures: [...report.failures, 'content-free report invariant failed'], passed: false };
  }
  return report;
}
