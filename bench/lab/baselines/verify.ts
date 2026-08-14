#!/usr/bin/env tsx

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256 } from '../datasets/hash.js';
import { canonicalSha256 } from './canonical.js';

type JsonObject = Record<string, unknown>;

export interface BaselineManifest extends JsonObject {
  schemaVersion: number;
  id: string;
  source: { repository: string; branch: string; commit: string; dirty: boolean };
  capturedAt: string;
  runtime: JsonObject;
  seed: number;
  configuration: JsonObject;
  datasets: Array<{ id: string; version: string; split: string; sha256: string }>;
  gitArtifacts: Array<{ path: string; hashMode: 'bytes' | 'text-lf'; sha256: string }>;
  commands: string[];
  results: {
    quality: { corpusSize: number; queryCount: number; metrics: Record<string, number> };
    membench: JsonObject;
  };
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MANIFEST = resolve(HERE, 'memberry-7a31231.json');
const DEFAULT_LOCK = resolve(HERE, 'baseline.lock.json');
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const SHA = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}

export function validateBaselineManifest(value: unknown): string[] {
  const errors: string[] = [];
  const manifest = object(value);
  if (!manifest) return ['baseline manifest must be an object'];
  if (manifest.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (typeof manifest.id !== 'string' || manifest.id.length === 0) errors.push('id must be non-empty');
  const source = object(manifest.source);
  if (!source || typeof source.commit !== 'string' || !COMMIT.test(source.commit)) errors.push('source.commit must be a full lowercase Git SHA');
  if (!source || source.dirty !== false) errors.push('source.dirty must be false for an immutable baseline');
  if (typeof manifest.capturedAt !== 'string' || !Number.isFinite(Date.parse(manifest.capturedAt))) errors.push('capturedAt must be an ISO timestamp');
  if (!Number.isSafeInteger(manifest.seed)) errors.push('seed must be an integer');
  if (!object(manifest.configuration)) errors.push('configuration must be an object');
  if (!Array.isArray(manifest.datasets) || manifest.datasets.length === 0) errors.push('datasets must be non-empty');
  else for (const [index, raw] of manifest.datasets.entries()) {
    const dataset = object(raw);
    if (!dataset || typeof dataset.id !== 'string' || typeof dataset.version !== 'string' || typeof dataset.split !== 'string' || typeof dataset.sha256 !== 'string' || !SHA.test(dataset.sha256)) {
      errors.push(`datasets[${index}] must include id, version, split, and SHA-256`);
    }
  }
  if (!Array.isArray(manifest.gitArtifacts) || manifest.gitArtifacts.length === 0) errors.push('gitArtifacts must be non-empty');
  else for (const [index, raw] of manifest.gitArtifacts.entries()) {
    const artifact = object(raw);
    if (!artifact || typeof artifact.path !== 'string' || artifact.path.includes('..') || artifact.path.includes(':')) errors.push(`gitArtifacts[${index}].path is unsafe`);
    if (!artifact || (artifact.hashMode !== 'bytes' && artifact.hashMode !== 'text-lf')) errors.push(`gitArtifacts[${index}].hashMode is invalid`);
    if (!artifact || typeof artifact.sha256 !== 'string' || !SHA.test(artifact.sha256)) errors.push(`gitArtifacts[${index}].sha256 is invalid`);
  }
  if (!Array.isArray(manifest.commands) || manifest.commands.length === 0 || manifest.commands.some((command) => typeof command !== 'string' || command.length === 0)) errors.push('commands must be non-empty strings');
  const results = object(manifest.results);
  const quality = object(results?.quality);
  const metrics = object(quality?.metrics);
  if (!quality || !Number.isSafeInteger(quality.corpusSize) || !Number.isSafeInteger(quality.queryCount) || !metrics) errors.push('results.quality is invalid');
  else for (const [name, score] of Object.entries(metrics)) if (typeof score !== 'number' || !Number.isFinite(score)) errors.push(`results.quality.metrics.${name} must be finite`);
  return errors;
}

export async function verifyBaselineGitArtifacts(manifest: BaselineManifest, repoRoot = REPO_ROOT): Promise<void> {
  const errors = validateBaselineManifest(manifest);
  if (errors.length > 0) throw new Error(`Invalid baseline manifest:\n${errors.join('\n')}`);
  execFileSync('git', ['cat-file', '-e', `${manifest.source.commit}^{commit}`], { cwd: repoRoot, stdio: 'pipe' });
  for (const artifact of manifest.gitArtifacts) {
    let content: Buffer;
    try {
      content = execFileSync('git', ['show', `${manifest.source.commit}:${artifact.path}`], {
        cwd: repoRoot,
        encoding: 'buffer',
        maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      }) as Buffer;
    } catch {
      throw new Error(`Baseline artifact missing from Git: ${artifact.path}`);
    }
    const actual = sha256(content, artifact.hashMode);
    if (actual !== artifact.sha256) throw new Error(`Baseline artifact hash mismatch for ${artifact.path}: expected ${artifact.sha256}, received ${actual}`);
  }
}

function gitFile(commit: string, path: string, repoRoot: string): Buffer {
  try {
    return execFileSync('git', ['show', `${commit}:${path}`], {
      cwd: repoRoot,
      encoding: 'buffer',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as Buffer;
  } catch {
    throw new Error(`Baseline command entrypoint missing from Git: ${path}`);
  }
}

/** Proves every recorded reproduction command existed in the immutable baseline tree. */
export async function verifyBaselineCommands(manifest: BaselineManifest, repoRoot = REPO_ROOT): Promise<void> {
  const packageJson = JSON.parse(gitFile(manifest.source.commit, 'package.json', repoRoot).toString('utf8')) as {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  for (const command of manifest.commands) {
    const npmScript = /^npm run ([A-Za-z0-9:_-]+)$/.exec(command);
    if (npmScript) {
      const script = packageJson.scripts?.[npmScript[1]];
      if (!script) throw new Error(`Baseline command references nonexistent npm script: ${npmScript[1]}`);
      const tsxEntrypoint = /(?:^|\s)tsx\s+([A-Za-z0-9._/-]+\.ts)(?:\s|$)/.exec(script)?.[1];
      if (tsxEntrypoint) gitFile(manifest.source.commit, tsxEntrypoint, repoRoot);
      continue;
    }
    const directTsx = /^npx --no-install tsx ([A-Za-z0-9._/-]+\.ts)$/.exec(command);
    if (directTsx) {
      if (!packageJson.dependencies?.tsx && !packageJson.devDependencies?.tsx) throw new Error('Baseline command requires tsx but the baseline package does not declare it');
      gitFile(manifest.source.commit, directTsx[1], repoRoot);
      continue;
    }
    throw new Error(`Unsupported baseline reproduction command: ${command}`);
  }
}

export async function loadAndVerifyBaseline(manifestPath = DEFAULT_MANIFEST, lockPath = DEFAULT_LOCK, repoRoot = REPO_ROOT): Promise<BaselineManifest> {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as BaselineManifest;
  const lock = JSON.parse(await readFile(lockPath, 'utf8')) as { baseline: string; hashMode: string; sha256: string };
  if (lock.hashMode !== 'canonical-json' || !SHA.test(lock.sha256)) throw new Error('Baseline lock must contain a canonical JSON SHA-256');
  const actual = canonicalSha256(manifest);
  if (actual !== lock.sha256) throw new Error(`Baseline manifest lock mismatch: expected ${lock.sha256}, received ${actual}`);
  await verifyBaselineGitArtifacts(manifest, repoRoot);
  await verifyBaselineCommands(manifest, repoRoot);
  return manifest;
}

async function main(): Promise<void> {
  const manifest = await loadAndVerifyBaseline();
  console.log(`Immutable baseline verified: ${manifest.id} (${manifest.source.commit})`);
  console.log(`Git artifacts: ${manifest.gitArtifacts.length}; datasets: ${manifest.datasets.length}; reproduction commands: ${manifest.commands.length}; canonical manifest lock: valid`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
