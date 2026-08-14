import { describe, expect, it } from 'vitest';
import { ScopeAwareBm25ControlAdapter } from '../adapters/baselines.js';
import { MemBerryProxyAdapter } from '../adapters/memberry-proxy.js';
import { inRequestedScope, isCurrent, namespaceKey } from '../adapters/in-memory.js';
import { createRunManifest, renderComparisonMarkdown } from '../artifacts.js';
import type { AdapterCapability, IngestRequest, QueryRequest, QueryResponse } from '../contracts/adapter.js';
import { TEMPORAL_ISOLATION_SCENARIOS } from '../fixtures/temporal-isolation.js';
import { compareAdapters, runAdapter } from '../runner.js';

class EmptyCandidateAdapter extends MemBerryProxyAdapter {
  override readonly id = 'empty-candidate-v1';
  override readonly displayName = 'Empty candidate';
  override async query(_request: QueryRequest): Promise<QueryResponse> { return { results: [] }; }
}

class UnsupportedCandidateAdapter extends MemBerryProxyAdapter {
  override readonly id = 'unsupported-candidate-v1';
  override readonly displayName = 'Unsupported candidate';
  override readonly capabilities: ReadonlySet<AdapterCapability> = new Set([
    'namespaces', 'feedback', 'stats', 'cleanup', 'project-scope', 'tenant-scope',
  ]);
}

class OracleSpyAdapter extends MemBerryProxyAdapter {
  override readonly id = 'oracle-spy-v1';
  readonly received: string[] = [];
  override async ingest(request: IngestRequest) {
    this.received.push(JSON.stringify(request));
    return super.ingest(request);
  }
  override async query(request: QueryRequest) {
    this.received.push(JSON.stringify(request));
    return super.query(request);
  }
}

class FailingCandidateAdapter extends MemBerryProxyAdapter {
  override readonly id = 'failing-candidate-v1';
  override async query(): Promise<QueryResponse> { throw new Error('deliberate adapter failure'); }
}

/** Simulates a regression after correct scope filtering by appending one excluded item. */
class LeakyScopeRegressionAdapter extends ScopeAwareBm25ControlAdapter {
  override readonly id = 'leaky-scope-regression-v1';
  override async query(request: QueryRequest): Promise<QueryResponse> {
    const response = await super.query(request);
    const excluded = (this.stores.get(namespaceKey(request.namespace)) ?? [])
      .find((memory) => !inRequestedScope(memory, request.namespace) || !isCurrent(memory, request.asOf));
    if (!excluded || response.results.length >= request.limit) return response;
    return { results: [...response.results, { id: excluded.id, score: 0.0001 }] };
  }
}

describe('lab runner and comparison gate', () => {
  it('passes the proxy while preserving explicit capability evidence', async () => {
    const report = await runAdapter({
      runId: 'proxy-run',
      adapter: new MemBerryProxyAdapter(),
      scenarios: TEMPORAL_ISOLATION_SCENARIOS,
    });
    expect(report.passed).toBe(true);
    expect(report.outcome).toBe('scored');
    expect(report.executionMode).toBe('proxy');
    expect(report.metrics.answerCoverage).toBe(1);
    expect(report.metrics.staleLeakRate).toBe(0);
    expect(report.metrics.isolationLeakRate).toBe(0);
    expect(report.scenarioReports.every((scenario) => scenario.capabilityGaps.length === 0)).toBe(true);
  });

  it('fails a deliberate scope/temporal regression without letting averages hide leaks', async () => {
    const report = await runAdapter({
      runId: 'bm25-run',
      adapter: new LeakyScopeRegressionAdapter(),
      scenarios: TEMPORAL_ISOLATION_SCENARIOS,
    });
    expect(report.passed).toBe(false);
    expect(report.outcome).toBe('scored');
    expect(report.gateFailures).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: 'staleLeakRate' }),
      expect.objectContaining({ metric: 'isolationLeakRate' }),
    ]));
  });

  it('compares a candidate against a control and renders reproducible artifacts', async () => {
    const comparison = await compareAdapters({
      runId: 'comparison-run',
      control: new ScopeAwareBm25ControlAdapter(),
      candidate: new MemBerryProxyAdapter(),
      scenarios: TEMPORAL_ISOLATION_SCENARIOS,
    });
    expect(comparison.passed).toBe(true);
    expect(comparison.deltas.find((delta) => delta.metric === 'isolationLeakRate')?.delta).toBe(0);

    const manifest = createRunManifest({
      runId: comparison.runId,
      createdAt: '2026-08-14T12:00:00.000Z',
      gitCommit: '0123456789abcdef',
      baselineCommit: '7a31231',
      gitDirty: false,
      datasetId: 'temporal-isolation-v1',
      datasetHash: 'A'.repeat(64),
      configHash: `sha256:${'B'.repeat(64)}`,
      config: { endpoint: 'local', apiToken: 'must-not-leak', nested: { password: 'also-secret' } },
      seed: 42,
      controlAdapter: comparison.control.adapterId,
      candidateAdapter: comparison.candidate.adapterId,
    });
    const markdown = renderComparisonMarkdown(comparison, manifest);
    expect(markdown).toContain('Status: **PASS**');
    expect(markdown).toContain('| isolationLeakRate |');
    expect(markdown).toContain('scope-aware-bm25-control-v1');
    expect(manifest.runtime.node).toBe(process.version);
    expect(manifest.datasetHash).toBe(`sha256:${'a'.repeat(64)}`);
    expect(manifest.config).toEqual({ endpoint: 'local', apiToken: '[REDACTED]', nested: { password: '[REDACTED]' } });
  });

  it('reports intentionally excluded holdout scenarios without exposing them to the adapter', async () => {
    const report = await runAdapter({
      runId: 'dev-only',
      adapter: new MemBerryProxyAdapter(),
      scenarios: TEMPORAL_ISOLATION_SCENARIOS,
      splits: ['dev'],
    });
    expect(report.passed).toBe(true);
    expect(report.excludedScenarios).toEqual([
      { scenarioId: 'late-arriving-temporal-update-v1', split: 'holdout', reason: 'split-not-selected' },
      { scenarioId: 'tenant-isolation-v1', split: 'holdout', reason: 'split-not-selected' },
    ]);
    expect(report.scenarioReports.every((scenario) => scenario.split === 'dev')).toBe(true);
  });

  it('refuses a comparison that reuses the control as its own candidate', async () => {
    const adapter = new MemBerryProxyAdapter();
    await expect(compareAdapters({
      runId: 'invalid-comparison',
      control: adapter,
      candidate: adapter,
      scenarios: TEMPORAL_ISOLATION_SCENARIOS,
    })).rejects.toThrow('independent adapters');
  });

  it('fails empty-result abstention on both recall and coverage', async () => {
    const report = await runAdapter({
      runId: 'empty-regression',
      adapter: new EmptyCandidateAdapter(),
      scenarios: TEMPORAL_ISOLATION_SCENARIOS,
    });
    expect(report.passed).toBe(false);
    expect(report.metrics.recallAtK).toBe(0);
    expect(report.metrics.answerCoverage).toBe(0);
    expect(report.metrics.staleSafety).toBe(0);
    expect(report.gateFailures).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: 'recallAtK' }),
      expect.objectContaining({ metric: 'answerCoverage' }),
    ]));
  });

  it('marks capability exclusions unsupported and never treats them as a pass', async () => {
    const temporal = TEMPORAL_ISOLATION_SCENARIOS.filter(({ input }) => input.id === 'late-arriving-temporal-update-v1');
    const report = await runAdapter({ runId: 'unsupported-regression', adapter: new UnsupportedCandidateAdapter(), scenarios: temporal });
    expect(report.outcome).toBe('unsupported');
    expect(report.passed).toBe(false);
    expect(report.scenarioReports[0]).toEqual(expect.objectContaining({ outcome: 'unsupported' }));
    expect(report.gateFailures).toEqual(expect.arrayContaining([expect.objectContaining({ metric: 'scenario-coverage' })]));
  });

  it('never sends evaluator-only oracle labels through the adapter contract', async () => {
    const adapter = new OracleSpyAdapter();
    await runAdapter({ runId: 'oracle-boundary', adapter, scenarios: TEMPORAL_ISOLATION_SCENARIOS, splits: ['dev'] });
    expect(adapter.received.length).toBeGreaterThan(0);
    expect(adapter.received.join('\n')).not.toMatch(/"(?:relevant|required|stale|forbidden)"/);
  });

  it('records adapter exceptions as failed outcomes instead of missing scores', async () => {
    const report = await runAdapter({
      runId: 'failure-regression',
      adapter: new FailingCandidateAdapter(),
      scenarios: TEMPORAL_ISOLATION_SCENARIOS.slice(0, 1),
    });
    expect(report.outcome).toBe('failed');
    expect(report.passed).toBe(false);
    expect(report.scenarioReports[0]).toEqual(expect.objectContaining({ outcome: 'failed', exclusionReason: 'deliberate adapter failure' }));
  });

  it('fails closed and preserves failures when the control arm fails', async () => {
    const comparison = await compareAdapters({
      runId: 'failed-control-comparison',
      control: new FailingCandidateAdapter(),
      candidate: new MemBerryProxyAdapter(),
      scenarios: TEMPORAL_ISOLATION_SCENARIOS.slice(0, 1),
    });
    expect(comparison.passed).toBe(false);
    expect(comparison.control.outcome).toBe('failed');
    expect(comparison.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ arm: 'control', metric: 'scenario-coverage' }),
    ]));
  });

  it('fails closed and preserves failures when the candidate arm fails', async () => {
    const comparison = await compareAdapters({
      runId: 'failed-candidate-comparison',
      control: new ScopeAwareBm25ControlAdapter(),
      candidate: new FailingCandidateAdapter(),
      scenarios: TEMPORAL_ISOLATION_SCENARIOS.slice(0, 1),
    });
    expect(comparison.passed).toBe(false);
    expect(comparison.candidate.outcome).toBe('failed');
    expect(comparison.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ arm: 'candidate', metric: 'scenario-coverage' }),
    ]));
  });
});
