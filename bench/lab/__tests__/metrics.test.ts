import { describe, expect, it } from 'vitest';
import { LAB_SCENARIO_VERSION, type LabProbeOracle, type LabScenarioInput } from '../contracts/scenario.js';
import { ndcgAtK, reciprocalRank, scoreProbe } from '../metrics.js';

const scenario: LabScenarioInput = {
  version: LAB_SCENARIO_VERSION,
  id: 'metric-fixture',
  split: 'dev',
  title: 'Metric fixture',
  description: 'Hand-computable fixture.',
  dimensions: ['recall'],
  tenant: 'tenant',
  project: 'project',
  memories: ['a', 'b', 'stale', 'forbidden', 'noise'].map((id) => ({
    id,
    content: id,
    recordedAt: '2026-01-01T00:00:00.000Z',
  })),
  queries: [],
};

const probe: LabProbeOracle = {
  probeId: 'probe',
  relevant: ['a', 'b'],
  required: ['a'],
  stale: ['stale'],
  forbidden: ['forbidden'],
};

describe('deterministic metrics', () => {
  it('matches hand-calculated rankings and safety rates', () => {
    const metrics = scoreProbe(scenario, probe, 4, [
      { id: 'noise', score: 4 },
      { id: 'a', score: 3 },
      { id: 'stale', score: 2 },
      { id: 'forbidden', score: 1 },
    ].slice(0, 4));
    expect(metrics.recallAtK).toBe(0.5);
    expect(metrics.precisionAtK).toBe(0.25);
    expect(metrics.reciprocalRank).toBe(0.5);
    expect(metrics.answerCoverage).toBe(1);
    expect(metrics.staleLeakRate).toBe(0.25);
    expect(metrics.isolationLeakRate).toBe(0.25);
    expect(metrics.staleSafety).toBe(0.75);
    expect(metrics.isolationSafety).toBe(0.75);
  });

  it('does not reward empty results for being leak-free', () => {
    const metrics = scoreProbe(scenario, probe, 4, []);
    expect(metrics.staleLeakRate).toBe(0);
    expect(metrics.isolationLeakRate).toBe(0);
    expect(metrics.answerCoverage).toBe(0);
    expect(metrics.staleSafety).toBe(0);
    expect(metrics.isolationSafety).toBe(0);
  });

  it('penalizes duplicate and unknown result ids', () => {
    const metrics = scoreProbe(scenario, probe, 4, [
      { id: 'a', score: 4 },
      { id: 'a', score: 3 },
      { id: 'not-in-corpus', score: 2 },
      { id: 'noise', score: 1 },
    ]);
    expect(metrics.duplicateRate).toBe(0.25);
    expect(metrics.unknownResultRate).toBe(0.25);
    expect(metrics.precisionAtK).toBe(0.25);
  });

  it('calculates reciprocal rank and nDCG deterministically', () => {
    expect(reciprocalRank(['noise', 'a', 'b'], new Set(['a', 'b']))).toBe(0.5);
    expect(ndcgAtK(['a', 'noise', 'b'], new Set(['a', 'b']), 3)).toBeCloseTo(0.9197207891, 8);
  });
});
