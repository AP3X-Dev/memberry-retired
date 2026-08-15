import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ScopeAwareBm25ControlAdapter } from '../adapters/baselines.js';
import { MemBerryProxyAdapter } from '../adapters/memberry-proxy.js';
import { createRunManifest, writeComparisonArtifacts } from '../artifacts.js';
import { TEMPORAL_ISOLATION_SCENARIOS } from '../fixtures/temporal-isolation.js';
import { compareAdapters } from '../runner.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

function manifest() {
  return createRunManifest({
    runId: 'atomic-artifact-run',
    createdAt: '2026-08-14T12:00:00.000Z',
    gitCommit: 'abcdef1234567890',
    baselineCommit: '7a31231',
    gitDirty: true,
    datasetId: 'temporal-isolation-v1',
    datasetHash: '1'.repeat(64),
    configHash: `sha256:${'2'.repeat(64)}`,
    config: { model: 'fixture', credentials: false, authorization: 'Bearer secret', nested: { api_key: 'secret' } },
    seed: 42,
    controlAdapter: 'scope-aware-bm25-control-v1',
    candidateAdapter: 'memberry-proxy-v1',
  });
}

describe('run artifacts', () => {
  it('normalizes hashes and recursively redacts secret configuration', () => {
    const value = manifest();
    expect(value.datasetHash).toBe(`sha256:${'1'.repeat(64)}`);
    expect(value.configHash).toBe(`sha256:${'2'.repeat(64)}`);
    expect(value.config).toEqual({ model: 'fixture', credentials: false, authorization: '[REDACTED]', nested: { api_key: '[REDACTED]' } });
    expect(value.gitDirty).toBe(true);
    expect(() => createRunManifest({ ...value, datasetHash: 'not-a-hash' })).toThrow('datasetHash');
  });

  it('atomically publishes one immutable artifact directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memberry-lab-artifacts-'));
    temporaryRoots.push(root);
    const destination = join(root, 'run');
    const comparison = await compareAdapters({
      runId: 'artifact-comparison',
      control: new ScopeAwareBm25ControlAdapter(),
      candidate: new MemBerryProxyAdapter(),
      scenarios: TEMPORAL_ISOLATION_SCENARIOS,
    });
    const value = manifest();
    const paths = await writeComparisonArtifacts(destination, comparison, value);
    expect((await readdir(destination)).sort()).toEqual(['comparison.json', 'comparison.md', 'manifest.json']);
    expect(JSON.parse(await readFile(paths.manifest, 'utf8'))).toEqual(value);
    expect(await readFile(paths.markdown, 'utf8')).toContain('Baseline commit: `7a31231`');

    await expect(writeComparisonArtifacts(destination, comparison, value)).rejects.toThrow();
    expect((await readdir(root)).filter((name) => name.startsWith('.atomic-artifact-run.tmp-'))).toEqual([]);
  });
});
