import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

import type { DatasetRegistry } from '../acquire.js';
import {
  loadRegisteredDatasetDescriptor,
  loadRegisteredScenarioInputs,
  loadRegisteredScenariosForScoring,
  verifyRegisteredDataset,
} from '../load-golden.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

test('registered dev and holdout JSONL are the scenarios executed by the scorer', async () => {
  const inputs = await loadRegisteredScenarioInputs(REPO_ROOT);
  const scenarios = await loadRegisteredScenariosForScoring(REPO_ROOT);
  assert.deepEqual(inputs.map(({ id, split }) => ({ id, split })), [
    { id: 'golden-dev-update-v1', split: 'dev' },
    { id: 'golden-holdout-isolation-v1', split: 'holdout' },
  ]);
  assert.deepEqual(scenarios.map(({ input }) => input.id), inputs.map(({ id }) => id));
  assert.doesNotMatch(JSON.stringify(inputs), /"(?:oracle|relevant|required|stale|forbidden)"\s*:/);
});

test('retrieval and temporal suites have distinct exact registered hashes', async () => {
  const retrieval = await loadRegisteredDatasetDescriptor('memberry-lab-migrated-retrieval', REPO_ROOT);
  const temporal = await loadRegisteredDatasetDescriptor('memberry-lab-temporal-isolation', REPO_ROOT);
  assert.notEqual(retrieval.hash, temporal.hash);
  assert.deepEqual(retrieval.inputArtifacts.map(({ path }) => path.endsWith('retrieval-inputs.ts')), [true]);
  assert.deepEqual(temporal.inputArtifacts.map(({ path }) => path.endsWith('temporal-isolation-inputs.ts')), [true]);
});

test('registered dataset verification rejects a stale digest', async () => {
  const registry = JSON.parse(await readFile(resolve(REPO_ROOT, 'bench/lab/registry/datasets.json'), 'utf8')) as DatasetRegistry;
  const dataset = structuredClone(registry.datasets.find(({ id }) => id === 'memberry-lab-golden-dev')!);
  dataset.artifacts[0].sha256 = '0'.repeat(64);
  await assert.rejects(verifyRegisteredDataset(dataset, REPO_ROOT), /SHA-256 mismatch/);
});
