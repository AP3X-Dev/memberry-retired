import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import { acquireDataset, type DatasetRegistry } from '../acquire.js';

function registryFor(content: Buffer, sha256 = createHash('sha256').update(content).digest('hex')): DatasetRegistry {
  return {
    schemaVersion: 1,
    datasets: [{
      id: 'fixture',
      version: '1.0.0',
      kind: 'external',
      split: 'external',
      oracleAccess: 'source-defined',
      requiredInCi: false,
      source: { url: 'https://example.invalid/data.json', revision: 'v1' },
      license: { status: 'verified', spdx: 'CC-BY-4.0', url: 'https://example.invalid/license' },
      dataPolicy: { reviewStatus: 'verified', containsPersonalData: false, containsSecrets: false, containsCustomerData: false, exclusions: ['real data'] },
      acquisition: { status: 'available' },
      artifacts: [{ role: 'source-defined', access: 'scorer', fileName: 'data.json', hashMode: 'bytes', sha256, sizeBytes: content.byteLength }],
    }],
  };
}

test('acquisition verifies a local artifact before publishing it to the cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memberry-lab-acquire-'));
  const source = join(root, 'source.json');
  const cache = join(root, 'cache');
  const content = Buffer.from('{"fixture":true}\n');
  await writeFile(source, content);

  const result = await acquireDataset({
    registry: registryFor(content),
    datasetId: 'fixture',
    cacheDir: cache,
    sourceFile: source,
  });

  assert.equal(result.cached, false);
  assert.equal(await readFile(result.artifacts[0].path, 'utf8'), content.toString());
  assert.equal(result.artifacts[0].sha256, createHash('sha256').update(content).digest('hex'));
});

test('checksum mismatch fails closed and never publishes the artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memberry-lab-mismatch-'));
  const source = join(root, 'source.json');
  const cache = join(root, 'cache');
  const content = Buffer.from('unexpected');
  await writeFile(source, content);

  await assert.rejects(
    acquireDataset({
      registry: registryFor(content, '0'.repeat(64)),
      datasetId: 'fixture',
      cacheDir: cache,
      sourceFile: source,
    }),
    /checksum mismatch/i,
  );

  await assert.rejects(stat(join(cache, 'fixture', '1.0.0', 'data.json')), /ENOENT/);
});

test('blocked datasets cannot be acquired even from a local file', async () => {
  const content = Buffer.from('data');
  const registry = registryFor(content);
  registry.datasets[0].acquisition = { status: 'blocked', reason: 'License is unverified.' };
  registry.datasets[0].license = { status: 'unverified', spdx: null, url: null };
  registry.datasets[0].artifacts[0].sha256 = null;

  await assert.rejects(
    acquireDataset({ registry, datasetId: 'fixture', cacheDir: tmpdir(), sourceFile: 'unused' }),
    /blocked.*License is unverified/i,
  );
});

test('unsafe dataset identity cannot escape the selected cache', async () => {
  const content = Buffer.from('data');
  const registry = registryFor(content);
  registry.datasets[0].version = '../../outside';
  await assert.rejects(
    acquireDataset({ registry, datasetId: 'fixture', cacheDir: tmpdir(), sourceFile: 'unused' }),
    /unsafe version/i,
  );
});
