#!/usr/bin/env tsx

import { copyFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { sha256File, type HashMode } from './hash.js';

export interface DatasetArtifact {
  role: 'input' | 'oracle' | 'legacy-mixed' | 'source-defined';
  access: 'adapter' | 'scorer';
  fileName: string;
  repositoryPath?: string | null;
  hashMode: HashMode;
  sha256: string | null;
  sizeBytes: number | null;
  url?: string;
}

export interface DatasetEntry {
  id: string;
  version: string;
  kind: 'repository' | 'external';
  split: string;
  oracleAccess: string;
  requiredInCi: boolean;
  source: { url: string | null; revision: string | null; path?: string; upstream?: string };
  license: { status: 'verified' | 'internal' | 'unverified'; spdx: string | null; url: string | null; usage?: string };
  dataPolicy: {
    reviewStatus: 'verified' | 'unverified';
    containsPersonalData: boolean | null;
    containsSecrets: boolean | null;
    containsCustomerData: boolean | null;
    exclusions: string[];
  };
  acquisition: { status: 'available' | 'blocked' | 'bundled'; reason?: string };
  artifacts: DatasetArtifact[];
}

export interface DatasetRegistry {
  schemaVersion: number;
  datasets: DatasetEntry[];
}

export interface AcquiredArtifact {
  role: DatasetArtifact['role'];
  access: DatasetArtifact['access'];
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface AcquisitionResult {
  datasetId: string;
  version: string;
  cached: boolean;
  artifacts: AcquiredArtifact[];
}

export interface AcquireOptions {
  registry: DatasetRegistry;
  datasetId: string;
  cacheDir: string;
  sourceFile?: string;
  allowNetwork?: boolean;
  fetchImpl?: typeof fetch;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REGISTRY = resolve(HERE, '..', 'registry', 'datasets.json');
const DEFAULT_CACHE = resolve(HERE, '..', '..', '..', 'node_modules', '.cache', 'memberry-lab');
const SHA256 = /^[a-f0-9]{64}$/;

function requireSafeEntry(dataset: DatasetEntry): void {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(dataset.id) || dataset.id.includes('..')) {
    throw new Error(`Dataset has an unsafe id: ${dataset.id}`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(dataset.version) || dataset.version.includes('..')) {
    throw new Error(`Dataset ${dataset.id} has an unsafe version: ${dataset.version}`);
  }
  if (dataset.acquisition.status === 'blocked') {
    throw new Error(`Dataset ${dataset.id} acquisition is blocked: ${dataset.acquisition.reason ?? 'no reason recorded'}`);
  }
  if (dataset.kind !== 'external' || dataset.acquisition.status !== 'available') {
    throw new Error(`Dataset ${dataset.id} is ${dataset.acquisition.status}; acquisition only downloads external available datasets`);
  }
  if (!dataset.source.revision?.trim()) throw new Error(`Dataset ${dataset.id} has no immutable source revision`);
  if (dataset.license.status !== 'verified' || !dataset.license.spdx?.trim()) {
    throw new Error(`Dataset ${dataset.id} does not have a verified license`);
  }
  if (dataset.dataPolicy.reviewStatus !== 'verified'
    || dataset.dataPolicy.containsPersonalData !== false
    || dataset.dataPolicy.containsSecrets !== false
    || dataset.dataPolicy.containsCustomerData !== false
    || dataset.dataPolicy.exclusions.length === 0) {
    throw new Error(`Dataset ${dataset.id} does not have a verified exclusion/data-policy review`);
  }
  for (const artifact of dataset.artifacts) {
    if (!SHA256.test(artifact.sha256 ?? '')) throw new Error(`Dataset ${dataset.id}/${artifact.fileName} has no verified SHA-256`);
    if (artifact.fileName.includes('/') || artifact.fileName.includes('\\') || artifact.fileName === '.' || artifact.fileName === '..') {
      throw new Error(`Dataset ${dataset.id} contains an unsafe artifact filename`);
    }
  }
}

async function verifyArtifact(path: string, artifact: DatasetArtifact): Promise<AcquiredArtifact> {
  const actual = await sha256File(path, artifact.hashMode);
  if (actual.sha256 !== artifact.sha256) {
    throw new Error(`Checksum mismatch for ${artifact.fileName}: expected ${artifact.sha256}, received ${actual.sha256}`);
  }
  if (artifact.sizeBytes !== null && actual.sizeBytes !== artifact.sizeBytes) {
    throw new Error(`Size mismatch for ${artifact.fileName}: expected ${artifact.sizeBytes}, received ${actual.sizeBytes}`);
  }
  return { role: artifact.role, access: artifact.access, path, ...actual };
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function stageLocal(source: string, destination: string): Promise<void> {
  await copyFile(source, destination);
}

async function stageNetwork(url: string, destination: string, fetchImpl: typeof fetch): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error(`Dataset URL must use HTTPS: ${url}`);
  if (parsed.username || parsed.password) throw new Error('Dataset URLs must not contain credentials');
  const response = await fetchImpl(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Dataset download failed (${response.status} ${response.statusText})`);
  if (!response.body) throw new Error('Dataset download returned no response body');
  const finalUrl = new URL(response.url || url);
  if (finalUrl.protocol !== 'https:') throw new Error(`Dataset redirect left HTTPS: ${finalUrl.href}`);
  await pipeline(
    Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
    createWriteStream(destination, { flags: 'wx' }),
  );
}

export async function acquireDataset(options: AcquireOptions): Promise<AcquisitionResult> {
  const dataset = options.registry.datasets.find((entry) => entry.id === options.datasetId);
  if (!dataset) throw new Error(`Unknown dataset: ${options.datasetId}`);
  requireSafeEntry(dataset);
  if (options.sourceFile && dataset.artifacts.length !== 1) {
    throw new Error('--source-file can only be used with a single-artifact dataset');
  }
  if (!options.sourceFile && !options.allowNetwork) {
    throw new Error('Network acquisition is disabled; pass --network explicitly or provide --source-file');
  }

  const destinationDir = resolve(options.cacheDir, dataset.id, dataset.version);
  await mkdir(destinationDir, { recursive: true });
  const acquired: AcquiredArtifact[] = [];
  let allCached = true;

  for (const artifact of dataset.artifacts) {
    const destination = resolve(destinationDir, artifact.fileName);
    if (!destination.startsWith(`${destinationDir}${process.platform === 'win32' ? '\\' : '/'}`)) {
      throw new Error(`Unsafe cache destination for ${artifact.fileName}`);
    }
    if (await exists(destination)) {
      try {
        acquired.push(await verifyArtifact(destination, artifact));
        continue;
      } catch {
        await rm(destination, { force: true });
      }
    }

    allCached = false;
    const temporary = `${destination}.partial-${process.pid}-${Date.now()}`;
    try {
      if (options.sourceFile) await stageLocal(resolve(options.sourceFile), temporary);
      else {
        const url = artifact.url ?? dataset.source.url;
        if (!url) throw new Error(`Dataset ${dataset.id}/${artifact.fileName} has no download URL`);
        await stageNetwork(url, temporary, options.fetchImpl ?? fetch);
      }
      const verified = await verifyArtifact(temporary, artifact);
      await rename(temporary, destination);
      acquired.push({ ...verified, path: destination });
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  return { datasetId: dataset.id, version: dataset.version, cached: allCached, artifacts: acquired };
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const datasetId = arg('--dataset');
  if (!datasetId) throw new Error('Usage: acquire.ts --dataset <id> [--cache <path>] [--source-file <path> | --network]');
  const registryPath = resolve(arg('--registry') ?? DEFAULT_REGISTRY);
  const registry = JSON.parse(await readFile(registryPath, 'utf8')) as DatasetRegistry;
  const result = await acquireDataset({
    registry,
    datasetId,
    cacheDir: resolve(arg('--cache') ?? DEFAULT_CACHE),
    sourceFile: arg('--source-file'),
    allowNetwork: process.argv.includes('--network'),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
