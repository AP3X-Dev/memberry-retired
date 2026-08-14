import { describe, expect, it } from 'vitest';

import { MemBerryProxyAdapter } from '../../../../bench/lab/adapters/memberry-proxy.js';
import { RETRIEVAL_SCENARIOS } from '../../../../bench/lab/fixtures/retrieval.js';
import { runAdapter } from '../../../../bench/lab/runner.js';

describe('evaluation-lab migrated retrieval control', () => {
  it('preserves the measured proxy floor without hiding known coverage gaps', async () => {
    const report = await runAdapter({
      runId: 'retrieval-package-regression',
      adapter: new MemBerryProxyAdapter(),
      scenarios: RETRIEVAL_SCENARIOS,
    });
    expect(report.executionMode).toBe('proxy');
    expect(report.outcome).toBe('scored');
    expect(report.metrics.recallAtK).toBeGreaterThanOrEqual(0.8461538461);
    expect(report.metrics.answerCoverage).toBeGreaterThanOrEqual(0.8461538461);
    expect(report.metrics.staleLeakRate).toBe(0);
    expect(report.metrics.isolationLeakRate).toBe(0);
  });
});
