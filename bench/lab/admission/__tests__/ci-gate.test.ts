import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { runAdmissionStructuralCiGate } from '../ci-gate.js';

describe('admission structural deterministic CI gate', () => {
  it('publishes exact offline provenance without raw fixture values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memberry-admission-ci-'));
    try {
      const result = await runAdmissionStructuralCiGate({
        runId: 'admission-ci-test',
        createdAt: '2026-08-14T18:00:00.000Z',
        gitCommit: 'ebb89d5',
        baselineCommit: 'ebb89d5',
        gitDirty: true,
        artifactRoot: root,
      });
      expect(result.passed).toBe(true);
      const manifest = JSON.parse(await readFile(result.artifacts.manifest, 'utf8')) as Record<string, unknown>;
      expect(manifest).toMatchObject({
        gitCommit: 'ebb89d5',
        baselineCommit: 'ebb89d5',
        gitDirty: true,
        datasetId: 'memberry-admission-structural-v1',
        seed: 1001,
        controlAdapter: 'memberry-admission-baseline-fixture-v1',
        candidateAdapter: 'memberry-admission-shadow-fixture-v1',
        config: {
          contracts: { admissionStructural: '1.0.0', admissionObservation: '1.0.0' },
          policy: { id: 'baseline-parity-admission', version: '1.0.0' },
          clock: '2026-08-14T18:00:00.000Z',
          fidelity: 'production-core / fixture-persistence',
          network: false,
          credentials: false,
        },
      });
      expect(manifest.datasetHash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(manifest.configHash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect((manifest.runtime as { node: string }).node).toBe(process.version);
      const published = [result.artifacts.json, result.artifacts.markdown, result.artifacts.manifest]
        .map(async (path) => readFile(path, 'utf8'));
      expect((await Promise.all(published)).join('\n'))
        .not.toMatch(/ordinary durable decision|syntheticMEM001D|tenant-admission|project:admission/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
