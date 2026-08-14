import { describe, expect, it } from 'vitest';

import * as publicFixtures from '../fixtures/index.js';
import { RETRIEVAL_SCENARIOS } from '../fixtures/retrieval.js';
import { MemBerryProxyAdapter } from '../adapters/memberry-proxy.js';
import { runAdapter } from '../runner.js';
import { validateScenario } from '../contracts/scenario.js';

describe('migrated retrieval fixtures', () => {
  it('preserves all seven legacy behavioral scenarios under the versioned contract', () => {
    expect(RETRIEVAL_SCENARIOS).toHaveLength(7);
    expect(RETRIEVAL_SCENARIOS.flatMap(validateScenario)).toEqual([]);
    expect(RETRIEVAL_SCENARIOS.some(({ input }) => input.split === 'dev')).toBe(true);
    expect(RETRIEVAL_SCENARIOS.some(({ input }) => input.split === 'holdout')).toBe(true);
  });

  it('does not expose scorer-only oracle modules from the public fixture barrel', () => {
    expect(publicFixtures).not.toHaveProperty('RETRIEVAL_ORACLES');
    expect(publicFixtures).not.toHaveProperty('TEMPORAL_ISOLATION_ORACLES');
  });

  it('scores the explicitly labeled proxy honestly without treating it as live evidence', async () => {
    const report = await runAdapter({
      runId: 'retrieval-migration-regression',
      adapter: new MemBerryProxyAdapter(),
      scenarios: RETRIEVAL_SCENARIOS,
    });
    expect(report.executionMode).toBe('proxy');
    expect(report.outcome).toBe('scored');
    // The migrated corpus exposes two incomplete multi-answer probes. Preserve
    // that weakness as the control instead of relaxing labels to manufacture a pass.
    expect(report.passed).toBe(false);
    expect(report.metrics.answerCoverage).toBeCloseTo(0.8461538462, 8);
    expect(report.gateFailures).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: 'answerCoverage' }),
    ]));
    expect(report.metrics.staleLeakRate).toBe(0);
    expect(report.metrics.isolationLeakRate).toBe(0);
  });
});
