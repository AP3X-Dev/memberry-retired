import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { test } from 'vitest';

import {
  validateDatasetRegistry,
  validateExperimentRegistry,
  validateMetricRegistry,
  validateSystemRegistry,
} from '../validate.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REGISTRY_DIR = resolve(HERE, '..');

async function json(name: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(REGISTRY_DIR, name), 'utf8'));
}

test('committed registries are valid and identifiers are unique', async () => {
  assert.deepEqual(validateDatasetRegistry(await json('datasets.json')), []);
  assert.deepEqual(validateMetricRegistry(await json('metrics.json')), []);
  assert.deepEqual(validateSystemRegistry(await json('systems.json')), []);
  assert.deepEqual(validateExperimentRegistry(await json('experiments.json')), []);
});

test('an acquirable external dataset requires a verified license and checksum', () => {
  const errors = validateDatasetRegistry({
    schemaVersion: 1,
    datasets: [{
      id: 'example',
      version: '1.0.0',
      kind: 'external',
      split: 'external',
      oracleAccess: 'source-defined',
      requiredInCi: false,
      source: { url: 'https://example.invalid/data.json', revision: 'v1' },
      license: { status: 'unverified', spdx: null, url: null },
      dataPolicy: { reviewStatus: 'unverified', containsPersonalData: null, containsSecrets: null, containsCustomerData: null, exclusions: ['unreviewed'] },
      acquisition: { status: 'available' },
      artifacts: [{ role: 'source-defined', access: 'scorer', fileName: 'data.json', hashMode: 'bytes', sha256: null, sizeBytes: null }],
    }],
  });

  assert.ok(errors.some((error) => error.includes('verified license')));
  assert.ok(errors.some((error) => error.includes('sha256')));
});

test('unknown external licensing is valid only when acquisition is explicitly blocked', () => {
  const errors = validateDatasetRegistry({
    schemaVersion: 1,
    datasets: [{
      id: 'research-only',
      version: 'snapshot-1',
      kind: 'external',
      split: 'external',
      oracleAccess: 'source-defined',
      requiredInCi: false,
      source: { url: 'https://example.invalid/data.json', revision: 'snapshot-1' },
      license: { status: 'unverified', spdx: null, url: null },
      dataPolicy: { reviewStatus: 'unverified', containsPersonalData: null, containsSecrets: null, containsCustomerData: null, exclusions: ['unreviewed'] },
      acquisition: { status: 'blocked', reason: 'License and artifact digest are not verified.' },
      artifacts: [{ role: 'source-defined', access: 'scorer', fileName: 'data.json', hashMode: 'bytes', sha256: null, sizeBytes: null }],
    }],
  });
  assert.ok(errors.some((error) => error.includes('required CI dev split')));
  assert.ok(errors.some((error) => error.includes('required CI holdout split')));
  assert.ok(errors.every((error) => !error.includes('research-only')));
});

test('required holdout data fails when adapter input and oracle are not physically separated', () => {
  const dataset = {
    id: 'bad-holdout', version: '1', kind: 'repository', split: 'holdout', oracleAccess: 'scorer-only', requiredInCi: true,
    source: { url: null, revision: '1', path: 'fixtures' },
    license: { status: 'internal', spdx: null, url: null },
    dataPolicy: { reviewStatus: 'verified', containsPersonalData: false, containsSecrets: false, containsCustomerData: false, exclusions: ['real data'] },
    acquisition: { status: 'bundled' },
    artifacts: [
      { role: 'input', access: 'adapter', fileName: 'same.jsonl', repositoryPath: 'same.jsonl', hashMode: 'text-lf', sha256: 'a'.repeat(64), sizeBytes: 1 },
      { role: 'oracle', access: 'scorer', fileName: 'same.jsonl', repositoryPath: 'same.jsonl', hashMode: 'text-lf', sha256: 'a'.repeat(64), sizeBytes: 1 },
    ],
  };
  const errors = validateDatasetRegistry({ schemaVersion: 1, datasets: [{ ...dataset, id: 'dev', split: 'dev' }, dataset] });
  assert.ok(errors.some((error) => error.includes('physically separate')));
});

test('experiments cannot default on or omit rollback authority', () => {
  const errors = validateExperimentRegistry({
    schemaVersion: 1,
    experiments: [{ id: 'unsafe', owner: '', flag: 'FEATURE', defaultEnabled: true, control: '', rollback: '' }],
  });
  assert.ok(errors.some((error) => error.includes('defaultEnabled must be false')));
  assert.ok(errors.some((error) => error.includes('owner')));
  assert.ok(errors.some((error) => error.includes('rollback')));
});

test('a combined dev+holdout dataset cannot bypass physical split separation in required CI', async () => {
  const registry = await json('datasets.json') as { datasets: Array<Record<string, unknown>> };
  const combined = registry.datasets.find((dataset) => dataset.id === 'memberry-lab-migrated-retrieval')!;
  combined.requiredInCi = true;
  const errors = validateDatasetRegistry(registry);
  assert.ok(errors.some((error) => error.includes('requiredInCi split must be exactly dev or holdout')));
});

test('each required suite fails closed without exactly one physical dev and holdout split', async () => {
  const registry = await json('datasets.json') as { datasets: Array<Record<string, unknown>> };
  registry.datasets = registry.datasets.filter((dataset) => dataset.id !== 'memberry-admission-structural-holdout');
  const errors = validateDatasetRegistry(registry);
  assert.ok(errors.some((error) => error.includes('admission-structural requires exactly one immutable required CI holdout split')));
});

test('admission structural systems cannot substitute proxy or wrong-fidelity registrations', async () => {
  const registry = await json('systems.json') as { systems: Array<Record<string, unknown>> };
  const system = registry.systems.find((entry) => entry.id === 'memberry-admission-shadow-fixture-v1')!;
  system.adapter = 'bench/lab/admission/proxy.ts';
  system.fidelity = 'proxy';
  const errors = validateSystemRegistry(registry);
  assert.ok(errors.some((error) => error.includes('admission structural required systems must be fixture fidelity')));
  assert.ok(errors.some((error) => error.includes('cannot be proxies')));
});
