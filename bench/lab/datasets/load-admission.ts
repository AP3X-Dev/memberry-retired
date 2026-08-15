import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateAdmissionStructuralInput,
  type AdmissionStructuralScenarioInput,
  type AdmissionStructuralScenarioOracle,
} from '../contracts/admission.js';
import { parseAdmissionStructuralOracle } from '../admission/oracle.js';
import { loadRegisteredDatasetDescriptor, type RegisteredDatasetDescriptor } from './load-golden.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(HERE, '..', '..', '..');
const DATASET_IDS = ['memberry-admission-structural-dev', 'memberry-admission-structural-holdout'] as const;
const SCORER_ONLY_KEYS = new Set([
  'oracle', 'expected', 'safeFacts', 'recommendation', 'recommendedTier',
  'wouldChangeBaseline', 'metrics', 'baselineOutcome', 'delivery', 'observation',
]);

async function descriptors(
  repoRoot: string,
  verifyAccess: 'adapter' | 'all' = 'all',
): Promise<RegisteredDatasetDescriptor[]> {
  return Promise.all(DATASET_IDS.map((id) => loadRegisteredDatasetDescriptor(id, repoRoot, verifyAccess)));
}

async function parseJsonLines<T>(path: string): Promise<T[]> {
  const source = await readFile(path, 'utf8');
  return source.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
    try { return JSON.parse(line) as T; }
    catch { throw new Error(`${path}:${index + 1}: invalid JSONL`); }
  });
}

function rejectScorerKeys(value: unknown, path = 'input'): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectScorerKeys(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SCORER_ONLY_KEYS.has(key)) throw new Error(`${path}.${key}: scorer-only key is forbidden`);
    rejectScorerKeys(child, `${path}.${key}`);
  }
}

/** System-side loader. It never opens an oracle artifact. */
export async function loadRegisteredAdmissionInputs(
  repoRoot = DEFAULT_REPO_ROOT,
): Promise<readonly AdmissionStructuralScenarioInput[]> {
  const registered = await descriptors(repoRoot, 'adapter');
  const inputs: AdmissionStructuralScenarioInput[] = [];
  for (const descriptor of registered) {
    if (descriptor.inputArtifacts.length !== 1) throw new Error(`${descriptor.id} must have exactly one system input`);
    const values = await parseJsonLines<AdmissionStructuralScenarioInput>(descriptor.inputArtifacts[0]!.path);
    for (const value of values) {
      rejectScorerKeys(value);
      if (value.split !== descriptor.split) throw new Error(`${value.id}: split differs from registry`);
      const errors = validateAdmissionStructuralInput(value);
      if (errors.length) throw new Error(`${value.id}: ${errors.join('; ')}`);
      inputs.push(Object.freeze(value));
    }
  }
  const ids = inputs.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new Error('Admission structural input IDs must be unique');
  return Object.freeze(inputs);
}

/** Scorer-side loader. Call only after both registered systems have completed. */
export async function loadRegisteredAdmissionOracles(
  repoRoot = DEFAULT_REPO_ROOT,
): Promise<readonly AdmissionStructuralScenarioOracle[]> {
  const registered = await descriptors(repoRoot);
  const oracles: AdmissionStructuralScenarioOracle[] = [];
  for (const descriptor of registered) {
    if (descriptor.oracleArtifacts.length !== 1) throw new Error(`${descriptor.id} must have exactly one scorer oracle`);
    const values = await parseJsonLines<AdmissionStructuralScenarioOracle>(descriptor.oracleArtifacts[0]!.path);
    for (const value of values) {
      oracles.push(parseAdmissionStructuralOracle(value));
    }
  }
  const ids = oracles.map(({ scenarioId }) => scenarioId);
  if (new Set(ids).size !== ids.length) throw new Error('Admission structural oracle IDs must be unique');
  return Object.freeze(oracles);
}

export async function loadAdmissionDatasetDescriptors(
  repoRoot = DEFAULT_REPO_ROOT,
): Promise<readonly RegisteredDatasetDescriptor[]> {
  return Object.freeze(await descriptors(repoRoot));
}
