import { resolve } from 'node:path';

import {
  ADMISSION_CONTRACT_VERSION,
  BASELINE_PARITY_POLICY_ID,
  BASELINE_PARITY_POLICY_VERSION,
} from '../../../packages/core/src/admission.js';
import { createRunManifest } from '../artifacts.js';
import { canonicalSha256 } from '../baselines/canonical.js';
import {
  ADMISSION_STRUCTURAL_CONTRACT_VERSION,
  ADMISSION_STRUCTURAL_FIDELITY,
  type AdmissionStructuralReport,
} from '../contracts/admission.js';
import { loadAdmissionDatasetDescriptors } from '../datasets/load-admission.js';
import {
  REGISTERED_ADMISSION_SYSTEM_IDS,
  runRegisteredAdmissionEvidence,
  writeRequiredAdmissionArtifacts,
} from './registered.js';
import { ADMISSION_STRUCTURAL_FIXED_CLOCK, ADMISSION_STRUCTURAL_SEED } from './fixture-system.js';

export interface AdmissionStructuralCiGateOptions {
  runId: string;
  createdAt: string;
  gitCommit: string;
  baselineCommit: string;
  gitDirty: boolean;
  repoRoot?: string;
  artifactRoot: string;
}

export interface AdmissionStructuralCiGateResult {
  passed: true;
  report: AdmissionStructuralReport;
  artifacts: { json: string; markdown: string; manifest: string };
}

export async function runAdmissionStructuralCiGate(
  options: AdmissionStructuralCiGateOptions,
): Promise<AdmissionStructuralCiGateResult> {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const report = await runRegisteredAdmissionEvidence({ runId: options.runId, repoRoot });
  if (!report.passed) {
    throw new Error(`Admission structural gate failed:\n${report.failures.join('\n')}`);
  }
  const descriptors = [...await loadAdmissionDatasetDescriptors(repoRoot)]
    .sort((left, right) => left.id.localeCompare(right.id));
  if (descriptors.length !== 2
    || descriptors.some(({ suite }) => suite !== 'admission-structural')
    || descriptors.filter(({ split }) => split === 'dev').length !== 1
    || descriptors.filter(({ split }) => split === 'holdout').length !== 1) {
    throw new Error('Admission structural gate requires exactly one registered dev and holdout dataset');
  }
  const datasets = descriptors.map(({ id, version, split, hash }) => ({ id, version, split, hash }));
  const datasetHash = canonicalSha256(datasets);
  const configuration = Object.freeze({
    contracts: {
      admissionStructural: ADMISSION_STRUCTURAL_CONTRACT_VERSION,
      admissionObservation: ADMISSION_CONTRACT_VERSION,
    },
    policy: {
      id: BASELINE_PARITY_POLICY_ID,
      version: BASELINE_PARITY_POLICY_VERSION,
    },
    datasets,
    seed: ADMISSION_STRUCTURAL_SEED,
    clock: ADMISSION_STRUCTURAL_FIXED_CLOCK,
    fidelity: ADMISSION_STRUCTURAL_FIDELITY,
    network: false,
    credentials: false,
  });
  const manifest = createRunManifest({
    runId: options.runId,
    createdAt: options.createdAt,
    gitCommit: options.gitCommit,
    baselineCommit: options.baselineCommit,
    gitDirty: options.gitDirty,
    datasetId: 'memberry-admission-structural-v1',
    datasetHash,
    configHash: canonicalSha256(configuration),
    config: configuration,
    seed: ADMISSION_STRUCTURAL_SEED,
    controlAdapter: REGISTERED_ADMISSION_SYSTEM_IDS.control,
    candidateAdapter: REGISTERED_ADMISSION_SYSTEM_IDS.candidate,
  });
  const artifacts = await writeRequiredAdmissionArtifacts(
    resolve(options.artifactRoot, options.runId),
    report,
    manifest,
  );
  return { passed: true, report, artifacts };
}
