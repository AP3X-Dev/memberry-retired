import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

import { compareQualityReports } from '../compare-quality.js';
import { requireGateResult } from '../ci-gate.js';
import { loadAndVerifyBaseline, validateBaselineManifest, verifyBaselineCommands, verifyBaselineGitArtifacts } from '../verify.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = resolve(HERE, '..', 'memberry-7a31231.json');

test('the immutable baseline manifest is structurally valid and its git artifacts match', async () => {
  const manifest = JSON.parse(await readFile(BASELINE_PATH, 'utf8'));
  assert.deepEqual(validateBaselineManifest(manifest), []);
  await assert.doesNotReject(verifyBaselineGitArtifacts(manifest, resolve(HERE, '..', '..', '..', '..')));
  await assert.doesNotReject(loadAndVerifyBaseline(
    BASELINE_PATH,
    resolve(HERE, '..', 'baseline.lock.json'),
    resolve(HERE, '..', '..', '..', '..'),
  ));
});

test('quality comparison passes an identical candidate', async () => {
  const manifest = JSON.parse(await readFile(BASELINE_PATH, 'utf8'));
  const candidate = {
    corpusSize: manifest.results.quality.corpusSize,
    queryCount: manifest.results.quality.queryCount,
    passed: true,
    metrics: { ...manifest.results.quality.metrics },
  };
  const comparison = compareQualityReports(manifest, candidate);
  assert.equal(comparison.passed, true);
  assert.deepEqual(comparison.failures, []);
});

test('quality comparison explains regressions and rejects missing metrics', async () => {
  const manifest = JSON.parse(await readFile(BASELINE_PATH, 'utf8'));
  const candidate = {
    corpusSize: manifest.results.quality.corpusSize,
    queryCount: manifest.results.quality.queryCount,
    passed: true,
    metrics: { ...manifest.results.quality.metrics, recallAt10: 0.5 },
  };
  delete candidate.metrics.mrr;

  const comparison = compareQualityReports(manifest, candidate);
  assert.equal(comparison.passed, false);
  assert.ok(comparison.failures.some((failure) => failure.includes('recallAt10')));
  assert.ok(comparison.failures.some((failure) => failure.includes('mrr') && failure.includes('missing')));
});

test('required CI gates cannot silently return no result', () => {
  assert.throws(() => requireGateResult('quality', undefined), /refusing to skip/);
  assert.throws(() => requireGateResult('comparison', null), /refusing to skip/);
});

test('baseline verification rejects a recorded command that never existed', async () => {
  const manifest = JSON.parse(await readFile(BASELINE_PATH, 'utf8'));
  manifest.commands = ['npm run bench:does-not-exist'];
  await assert.rejects(
    verifyBaselineCommands(manifest, resolve(HERE, '..', '..', '..', '..')),
    /nonexistent npm script/,
  );
});
