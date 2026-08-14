import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LabScenario, LabScenarioInput, LabScenarioOracle } from '../contracts/scenario.js';
import { validateScenario } from '../contracts/scenario.js';
import { validateDatasetRegistry, validateRegistries } from '../registry/validate.js';
import type { DatasetArtifact, DatasetEntry, DatasetRegistry } from './acquire.js';
import { sha256File } from './hash.js';
import { canonicalSha256 } from '../baselines/canonical.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(HERE, '..', '..', '..');
const ORACLE_KEYS = new Set(['oracle', 'relevant', 'required', 'stale', 'forbidden']);

export interface RegisteredDatasetDescriptor {
  id: string;
  version: string;
  split: string;
  hash: string;
  inputArtifacts: Array<{ path: string; sha256: string }>;
  oracleArtifacts: Array<{ path: string; sha256: string }>;
}

async function readRegistry(repoRoot: string): Promise<DatasetRegistry> {
  const path = resolve(repoRoot, 'bench', 'lab', 'registry', 'datasets.json');
  const registry = JSON.parse(await readFile(path, 'utf8')) as DatasetRegistry;
  const errors = validateDatasetRegistry(registry);
  if (errors.length > 0) throw new Error(`Dataset registry is invalid:\n${errors.join('\n')}`);
  return registry;
}

function artifactPath(repoRoot: string, artifact: DatasetArtifact): string {
  if (!artifact.repositoryPath) throw new Error(`${artifact.fileName} has no repositoryPath`);
  const path = resolve(repoRoot, artifact.repositoryPath);
  const prefix = `${resolve(repoRoot)}${process.platform === 'win32' ? '\\' : '/'}`;
  if (!path.startsWith(prefix)) throw new Error(`${artifact.fileName} escapes the repository root`);
  return path;
}

export async function verifyRegisteredDataset(
  dataset: DatasetEntry,
  repoRoot = DEFAULT_REPO_ROOT,
  verifyAccess: 'adapter' | 'all' = 'all',
): Promise<RegisteredDatasetDescriptor> {
  if (dataset.kind !== 'repository' || dataset.acquisition.status !== 'bundled') {
    throw new Error(`${dataset.id} is not a bundled repository dataset`);
  }
  const artifacts = await Promise.all(dataset.artifacts.map(async (artifact) => {
    const path = artifactPath(repoRoot, artifact);
    if (verifyAccess === 'adapter' && artifact.access === 'scorer') {
      return { role: artifact.role, access: artifact.access, path, repositoryPath: artifact.repositoryPath!, sha256: artifact.sha256! };
    }
    const actual = await sha256File(path, artifact.hashMode);
    if (actual.sha256 !== artifact.sha256) throw new Error(`${dataset.id}/${artifact.fileName} SHA-256 mismatch`);
    if (artifact.sizeBytes !== null && actual.sizeBytes !== artifact.sizeBytes) throw new Error(`${dataset.id}/${artifact.fileName} normalized size mismatch`);
    return { role: artifact.role, access: artifact.access, path, repositoryPath: artifact.repositoryPath!, sha256: actual.sha256 };
  }));
  const hash = canonicalSha256({
    id: dataset.id,
    version: dataset.version,
    split: dataset.split,
    artifacts: artifacts.map(({ role, access, repositoryPath, sha256 }) => ({ role, access, repositoryPath, sha256 })),
  });
  return {
    id: dataset.id,
    version: dataset.version,
    split: dataset.split,
    hash,
    inputArtifacts: artifacts.filter(({ role, access }) => role === 'input' && access === 'adapter').map(({ path, sha256 }) => ({ path, sha256 })),
    oracleArtifacts: artifacts.filter(({ role, access }) => role === 'oracle' && access === 'scorer').map(({ path, sha256 }) => ({ path, sha256 })),
  };
}

export async function loadRegisteredDatasetDescriptor(datasetId: string, repoRoot = DEFAULT_REPO_ROOT): Promise<RegisteredDatasetDescriptor> {
  const registry = await readRegistry(repoRoot);
  const dataset = registry.datasets.find(({ id }) => id === datasetId);
  if (!dataset) throw new Error(`Unknown registered dataset: ${datasetId}`);
  return verifyRegisteredDataset(dataset, repoRoot);
}

async function parseJsonLines<T>(path: string): Promise<T[]> {
  const lines = (await readFile(path, 'utf8')).split(/\r?\n/).filter((line) => line.trim().length > 0);
  return lines.map((line, index) => {
    try { return JSON.parse(line) as T; }
    catch (error) { throw new Error(`${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`); }
  });
}

function assertAdapterVisibleOnly(value: unknown, path = 'input'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertAdapterVisibleOnly(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (ORACLE_KEYS.has(key)) throw new Error(`${path}.${key} contains scorer-only oracle data`);
    assertAdapterVisibleOnly(child, `${path}.${key}`);
  }
}

async function requiredGoldenDescriptors(repoRoot: string, verifyAccess: 'adapter' | 'all' = 'all'): Promise<RegisteredDatasetDescriptor[]> {
  const registry = await readRegistry(repoRoot);
  const required = registry.datasets.filter((dataset) => dataset.requiredInCi && (dataset.split === 'dev' || dataset.split === 'holdout'));
  if (required.filter(({ split }) => split === 'dev').length !== 1 || required.filter(({ split }) => split === 'holdout').length !== 1) {
    throw new Error('Exactly one required registered dev dataset and one required registered holdout dataset are required');
  }
  return Promise.all(required.map((dataset) => verifyRegisteredDataset(dataset, repoRoot, verifyAccess)));
}

/** Loads only adapter-visible inputs. This function never opens an oracle artifact. */
export async function loadRegisteredScenarioInputs(repoRoot = DEFAULT_REPO_ROOT): Promise<readonly LabScenarioInput[]> {
  const descriptors = await requiredGoldenDescriptors(repoRoot, 'adapter');
  const inputs: LabScenarioInput[] = [];
  for (const descriptor of descriptors) {
    if (descriptor.inputArtifacts.length !== 1) throw new Error(`${descriptor.id} must have exactly one adapter input artifact`);
    const parsed = await parseJsonLines<LabScenarioInput>(descriptor.inputArtifacts[0].path);
    for (const input of parsed) {
      assertAdapterVisibleOnly(input);
      if (input.split !== descriptor.split) throw new Error(`${input.id} split ${input.split} does not match registry split ${descriptor.split}`);
      inputs.push(input);
    }
  }
  return inputs;
}

/** Evaluator-only loader. Adapters receive only each returned scenario.input through the runner contract. */
export async function loadRegisteredScenariosForScoring(repoRoot = DEFAULT_REPO_ROOT): Promise<readonly LabScenario[]> {
  const registryErrors = await validateRegistries(resolve(repoRoot, 'bench', 'lab', 'registry'));
  if (registryErrors.length > 0) throw new Error(`Registered dataset integrity failed:\n${registryErrors.join('\n')}`);
  const [inputs, descriptors] = await Promise.all([
    loadRegisteredScenarioInputs(repoRoot),
    requiredGoldenDescriptors(repoRoot),
  ]);
  const oracles: LabScenarioOracle[] = [];
  for (const descriptor of descriptors) {
    if (descriptor.oracleArtifacts.length !== 1) throw new Error(`${descriptor.id} must have exactly one scorer oracle artifact`);
    oracles.push(...await parseJsonLines<LabScenarioOracle>(descriptor.oracleArtifacts[0].path));
  }
  const byId = new Map(oracles.map((oracle) => [oracle.scenarioId, oracle]));
  if (byId.size !== oracles.length) throw new Error('Registered oracle scenario IDs must be unique');
  const scenarios = inputs.map((input) => {
    const oracle = byId.get(input.id);
    if (!oracle) throw new Error(`${input.id} has no registered oracle`);
    const scenario = { input, oracle } satisfies LabScenario;
    const errors = validateScenario(scenario);
    if (errors.length > 0) throw new Error(`${input.id}: ${errors.join('; ')}`);
    byId.delete(input.id);
    return scenario;
  });
  if (byId.size > 0) throw new Error(`Registered oracles have no input: ${[...byId.keys()].join(', ')}`);
  return scenarios;
}
