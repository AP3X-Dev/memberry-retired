#!/usr/bin/env tsx

import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256File } from '../datasets/hash.js';

type JsonObject = Record<string, unknown>;

const HERE = dirname(fileURLToPath(import.meta.url));
const ID = /^[a-z0-9][a-z0-9._-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validId(value: unknown): value is string {
  return nonBlank(value) && ID.test(value);
}

function validateHeader(value: unknown, collection: string): { root?: JsonObject; items?: unknown[]; errors: string[] } {
  const root = object(value);
  const errors: string[] = [];
  if (!root) return { errors: ['registry must be a JSON object'] };
  if (root.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  const items = root[collection];
  if (!Array.isArray(items)) errors.push(`${collection} must be an array`);
  return { root, items: Array.isArray(items) ? items : undefined, errors };
}

export function validateDatasetRegistry(value: unknown): string[] {
  const { items, errors } = validateHeader(value, 'datasets');
  if (!items) return errors;
  const keys = new Set<string>();

  for (const [index, raw] of items.entries()) {
    const at = `datasets[${index}]`;
    const dataset = object(raw);
    if (!dataset) { errors.push(`${at} must be an object`); continue; }
    if (!validId(dataset.id)) errors.push(`${at}.id must be a lowercase stable identifier`);
    if (!nonBlank(dataset.version)) errors.push(`${at}.version must be non-empty`);
    else if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(dataset.version) || dataset.version.includes('..')) errors.push(`${at}.version must be filesystem-safe`);
    const key = `${String(dataset.id)}@${String(dataset.version)}`;
    if (keys.has(key)) errors.push(`${at} duplicates ${key}`);
    keys.add(key);
    if (dataset.kind !== 'repository' && dataset.kind !== 'external') errors.push(`${at}.kind must be repository or external`);
    if (typeof dataset.requiredInCi !== 'boolean') errors.push(`${at}.requiredInCi must be boolean`);

    const source = object(dataset.source);
    if (!source) errors.push(`${at}.source must be an object`);
    else {
      if (dataset.kind === 'external' && (!nonBlank(source.url) || !source.url.startsWith('https://'))) {
        errors.push(`${at}.source.url must be HTTPS for an external dataset`);
      }
    }

    const license = object(dataset.license);
    const licenseStatus = license?.status;
    if (!license || !['verified', 'internal', 'unverified'].includes(String(licenseStatus))) {
      errors.push(`${at}.license.status must be verified, internal, or unverified`);
    }

    const acquisition = object(dataset.acquisition);
    const acquisitionStatus = acquisition?.status;
    if (!acquisition || !['available', 'blocked', 'bundled'].includes(String(acquisitionStatus))) {
      errors.push(`${at}.acquisition.status must be available, blocked, or bundled`);
    }
    if (acquisitionStatus === 'blocked' && !nonBlank(acquisition?.reason)) {
      errors.push(`${at}.acquisition.reason is required when blocked`);
    }
    if (dataset.kind === 'repository' && acquisitionStatus !== 'bundled') {
      errors.push(`${at} repository data must use bundled acquisition`);
    }
    if (dataset.kind === 'external' && acquisitionStatus === 'available' && licenseStatus !== 'verified') {
      errors.push(`${at} external acquisition requires a verified license`);
    }
    if (acquisitionStatus !== 'blocked' && !nonBlank(source?.revision)) {
      errors.push(`${at}.source.revision must be pinned before data is available`);
    }
    if (licenseStatus === 'verified' && !nonBlank(license?.spdx)) {
      errors.push(`${at}.license.spdx is required for a verified license`);
    }
    if (dataset.requiredInCi === true && acquisitionStatus !== 'bundled') {
      errors.push(`${at} requiredInCi datasets must be bundled; CI cannot require network acquisition`);
    }
    if (dataset.requiredInCi === true && dataset.split !== 'dev' && dataset.split !== 'holdout') {
      errors.push(`${at} requiredInCi split must be exactly dev or holdout`);
    }

    const dataPolicy = object(dataset.dataPolicy);
    if (!dataPolicy || !['verified', 'unverified'].includes(String(dataPolicy.reviewStatus))) {
      errors.push(`${at}.dataPolicy.reviewStatus must be verified or unverified`);
    }
    if (!dataPolicy || !Array.isArray(dataPolicy.exclusions) || dataPolicy.exclusions.length === 0 || dataPolicy.exclusions.some((entry) => !nonBlank(entry))) {
      errors.push(`${at}.dataPolicy.exclusions must explicitly list excluded data classes`);
    }
    if (acquisitionStatus !== 'blocked') {
      if (dataPolicy?.reviewStatus !== 'verified') errors.push(`${at} available data requires a verified data-policy review`);
      for (const field of ['containsPersonalData', 'containsSecrets', 'containsCustomerData']) {
        if (dataPolicy?.[field] !== false) errors.push(`${at}.dataPolicy.${field} must be false before data is available`);
      }
    }

    if (!Array.isArray(dataset.artifacts) || dataset.artifacts.length === 0) {
      errors.push(`${at}.artifacts must be a non-empty array`);
      continue;
    }
    for (const [artifactIndex, rawArtifact] of dataset.artifacts.entries()) {
      const artifactAt = `${at}.artifacts[${artifactIndex}]`;
      const artifact = object(rawArtifact);
      if (!artifact) { errors.push(`${artifactAt} must be an object`); continue; }
      if (!nonBlank(artifact.fileName) || artifact.fileName.includes('/') || artifact.fileName.includes('\\')) {
        errors.push(`${artifactAt}.fileName must be a basename`);
      }
      if (!['input', 'oracle', 'legacy-mixed', 'source-defined'].includes(String(artifact.role))) {
        errors.push(`${artifactAt}.role is invalid`);
      }
      if (artifact.access !== 'adapter' && artifact.access !== 'scorer') {
        errors.push(`${artifactAt}.access must be adapter or scorer`);
      }
      if (artifact.hashMode !== 'bytes' && artifact.hashMode !== 'text-lf') {
        errors.push(`${artifactAt}.hashMode must be bytes or text-lf`);
      }
      const digestRequired = acquisitionStatus === 'available' || acquisitionStatus === 'bundled';
      if (digestRequired && (!nonBlank(artifact.sha256) || !SHA256.test(artifact.sha256))) {
        errors.push(`${artifactAt}.sha256 must be a lowercase SHA-256 when data is available`);
      } else if (artifact.sha256 !== null && artifact.sha256 !== undefined && (!nonBlank(artifact.sha256) || !SHA256.test(artifact.sha256))) {
        errors.push(`${artifactAt}.sha256 must be null or a lowercase SHA-256`);
      }
      if (artifact.sizeBytes !== null && artifact.sizeBytes !== undefined && (!Number.isSafeInteger(artifact.sizeBytes) || Number(artifact.sizeBytes) < 0)) {
        errors.push(`${artifactAt}.sizeBytes must be null or a non-negative safe integer`);
      }
      if (dataset.kind === 'repository' && !nonBlank(artifact.repositoryPath)) {
        errors.push(`${artifactAt}.repositoryPath is required for repository data`);
      }
    }

    if (dataset.split === 'dev' || dataset.split === 'holdout') {
      if (dataset.oracleAccess !== 'scorer-only') errors.push(`${at}.oracleAccess must be scorer-only for ${dataset.split}`);
      const artifacts = dataset.artifacts.map(object).filter((artifact): artifact is JsonObject => Boolean(artifact));
      const input = artifacts.find((artifact) => artifact.role === 'input');
      const oracle = artifacts.find((artifact) => artifact.role === 'oracle');
      if (!input || input.access !== 'adapter') errors.push(`${at} requires one adapter-visible input artifact`);
      if (!oracle || oracle.access !== 'scorer') errors.push(`${at} requires one scorer-only oracle artifact`);
      if (input && oracle && input.repositoryPath === oracle.repositoryPath) errors.push(`${at} input and oracle must be physically separate`);
    }
  }
  if (!items.some((raw) => { const item = object(raw); return item?.split === 'dev' && item.requiredInCi === true; })) {
    errors.push('registry requires an immutable required CI dev split');
  }
  if (!items.some((raw) => { const item = object(raw); return item?.split === 'holdout' && item.requiredInCi === true; })) {
    errors.push('registry requires an immutable required CI holdout split');
  }
  return errors;
}

export function validateExperimentRegistry(value: unknown): string[] {
  const { items, errors } = validateHeader(value, 'experiments');
  if (!items) return errors;
  const ids = new Set<string>();
  for (const [index, raw] of items.entries()) {
    const at = `experiments[${index}]`;
    const experiment = object(raw);
    if (!experiment) { errors.push(`${at} must be an object`); continue; }
    if (!validId(experiment.id)) errors.push(`${at}.id must be a stable identifier`);
    if (ids.has(String(experiment.id))) errors.push(`${at}.id is duplicated`);
    ids.add(String(experiment.id));
    if (!nonBlank(experiment.owner)) errors.push(`${at}.owner must be non-empty`);
    if (!nonBlank(experiment.flag)) errors.push(`${at}.flag must be non-empty`);
    if (experiment.defaultEnabled !== false) errors.push(`${at}.defaultEnabled must be false`);
    if (!nonBlank(experiment.control)) errors.push(`${at}.control must be non-empty`);
    if (!nonBlank(experiment.rollback)) errors.push(`${at}.rollback must be non-empty`);
  }
  return errors;
}

export function validateMetricRegistry(value: unknown): string[] {
  const { items, errors } = validateHeader(value, 'metrics');
  if (!items) return errors;
  const ids = new Set<string>();
  for (const [index, raw] of items.entries()) {
    const at = `metrics[${index}]`;
    const metric = object(raw);
    if (!metric) { errors.push(`${at} must be an object`); continue; }
    if (!nonBlank(metric.id) || !/^[A-Za-z][A-Za-z0-9._-]*$/.test(metric.id)) errors.push(`${at}.id must be a stable identifier`);
    if (ids.has(String(metric.id))) errors.push(`${at}.id is duplicated`);
    ids.add(String(metric.id));
    if (!nonBlank(metric.label)) errors.push(`${at}.label must be non-empty`);
    if (metric.direction !== 'higher' && metric.direction !== 'lower') errors.push(`${at}.direction must be higher or lower`);
    if (!nonBlank(metric.unit)) errors.push(`${at}.unit must be non-empty`);
    if (typeof metric.requiredInCi !== 'boolean') errors.push(`${at}.requiredInCi must be boolean`);
    if (typeof metric.hardGate !== 'boolean') errors.push(`${at}.hardGate must be boolean`);
  }
  return errors;
}

export function validateSystemRegistry(value: unknown): string[] {
  const { items, errors } = validateHeader(value, 'systems');
  if (!items) return errors;
  const ids = new Set<string>();
  for (const [index, raw] of items.entries()) {
    const at = `systems[${index}]`;
    const system = object(raw);
    if (!system) { errors.push(`${at} must be an object`); continue; }
    if (!validId(system.id)) errors.push(`${at}.id must be a stable identifier`);
    if (ids.has(String(system.id))) errors.push(`${at}.id is duplicated`);
    ids.add(String(system.id));
    if (!nonBlank(system.displayName)) errors.push(`${at}.displayName must be non-empty`);
    if (system.mode !== 'fixture' && system.mode !== 'live') errors.push(`${at}.mode must be fixture or live`);
    if (!['proxy', 'fixture', 'live'].includes(String(system.fidelity))) errors.push(`${at}.fidelity must be proxy, fixture, or live`);
    if (typeof system.requiredInCi !== 'boolean') errors.push(`${at}.requiredInCi must be boolean`);
    if (!nonBlank(system.adapter)) errors.push(`${at}.adapter must be non-empty`);
    if (!Array.isArray(system.capabilities) || system.capabilities.some((capability) => !nonBlank(capability))) {
      errors.push(`${at}.capabilities must be an array of non-empty strings`);
    }
  }
  return errors;
}

export async function validateRegistries(registryDir = HERE): Promise<string[]> {
  const specs: Array<[string, (value: unknown) => string[]]> = [
    ['datasets.json', validateDatasetRegistry],
    ['metrics.json', validateMetricRegistry],
    ['systems.json', validateSystemRegistry],
    ['experiments.json', validateExperimentRegistry],
  ];
  const errors: string[] = [];
  const loaded = new Map<string, unknown>();
  for (const [name, validator] of specs) {
    try {
      const parsed = JSON.parse(await readFile(resolve(registryDir, name), 'utf8'));
      loaded.set(name, parsed);
      errors.push(...validator(parsed).map((error) => `${name}: ${error}`));
    } catch (error) {
      errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (errors.length > 0) return errors;

  const repoRoot = resolve(registryDir, '..', '..', '..');
  const datasets = (loaded.get('datasets.json') as { datasets: Array<Record<string, unknown>> }).datasets;
  for (const dataset of datasets.filter((entry) => entry.requiredInCi === true)) {
    for (const artifact of dataset.artifacts as Array<Record<string, unknown>>) {
      const repositoryPath = String(artifact.repositoryPath);
      const path = resolve(repoRoot, repositoryPath);
      if (!path.startsWith(`${repoRoot}${process.platform === 'win32' ? '\\' : '/'}`)) {
        errors.push(`datasets.json: ${dataset.id}/${artifact.fileName} escapes the repository root`);
        continue;
      }
      try {
        const digest = await sha256File(path, artifact.hashMode as 'bytes' | 'text-lf');
        if (digest.sha256 !== artifact.sha256) errors.push(`datasets.json: ${dataset.id}/${artifact.fileName} SHA-256 mismatch`);
        if (artifact.sizeBytes !== null && digest.sizeBytes !== artifact.sizeBytes) errors.push(`datasets.json: ${dataset.id}/${artifact.fileName} normalized size mismatch`);
      } catch (error) {
        errors.push(`datasets.json: ${dataset.id}/${artifact.fileName} is unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const systems = (loaded.get('systems.json') as { systems: Array<Record<string, unknown>> }).systems;
  const systemIds = new Set(systems.map((system) => String(system.id)));
  for (const system of systems.filter((entry) => entry.requiredInCi === true)) {
    try { await stat(resolve(repoRoot, String(system.adapter))); }
    catch { errors.push(`systems.json: required adapter ${system.id} is unavailable at ${system.adapter}`); }
  }
  const experiments = (loaded.get('experiments.json') as { experiments: Array<Record<string, unknown>> }).experiments;
  for (const experiment of experiments) {
    if (!systemIds.has(String(experiment.control))) errors.push(`experiments.json: ${experiment.id} names unknown control ${experiment.control}`);
  }
  return errors;
}

async function main(): Promise<void> {
  const errors = await validateRegistries();
  if (errors.length > 0) {
    console.error('Evaluation-lab registry validation failed:');
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log('Evaluation-lab registries valid (datasets, metrics, systems).');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
