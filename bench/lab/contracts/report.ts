import type { AdapterStats } from './adapter.js';
import type { ScenarioDimension } from './scenario.js';

export interface ProbeMetrics {
  recallAtK: number;
  precisionAtK: number;
  reciprocalRank: number;
  ndcgAtK: number;
  answerCoverage: number;
  staleLeakRate: number;
  isolationLeakRate: number;
  duplicateRate: number;
  unknownResultRate: number;
  /** Safety credit is zero for an unanswered probe, preventing empty-result gaming. */
  staleSafety: number;
  isolationSafety: number;
}

export interface ProbeReport {
  probeId: string;
  query: string;
  resultIds: readonly string[];
  metrics: ProbeMetrics;
  durationMs?: number;
}

export interface ScenarioReport {
  scenarioId: string;
  split: 'dev' | 'holdout';
  dimensions: readonly ScenarioDimension[];
  capabilityGaps: readonly string[];
  outcome: 'unsupported' | 'failed' | 'scored';
  exclusionReason?: string;
  probes: readonly ProbeReport[];
  metrics: ProbeMetrics;
}

export interface LabGatePolicy {
  minRecallAtK: number;
  minPrecisionAtK: number;
  minAnswerCoverage: number;
  maxStaleLeakRate: number;
  maxIsolationLeakRate: number;
  maxDuplicateRate: number;
  maxUnknownResultRate: number;
  /** Maximum candidate regression relative to control for non-safety metrics. */
  maxQualityRegression: number;
}

export interface GateFailure {
  metric: keyof ProbeMetrics | 'adapter-health' | 'scenario-coverage';
  actual: number | string;
  expected: string;
  scenarioId?: string;
  arm?: 'control' | 'candidate';
}

export interface AdapterRunReport {
  contractVersion: string;
  runId: string;
  adapterId: string;
  adapterName: string;
  executionMode: 'proxy' | 'fixture' | 'live';
  health: string;
  outcome: 'unsupported' | 'failed' | 'scored';
  excludedScenarios: readonly { scenarioId: string; split: 'dev' | 'holdout'; reason: string }[];
  scenarioReports: readonly ScenarioReport[];
  metrics: ProbeMetrics;
  stats: AdapterStats;
  gateFailures: readonly GateFailure[];
  passed: boolean;
}

export interface MetricDelta {
  metric: keyof ProbeMetrics;
  control: number;
  candidate: number;
  delta: number;
}

export interface ComparisonReport {
  runId: string;
  evidenceMode: 'ad-hoc' | 'registered-ci';
  control: AdapterRunReport;
  candidate: AdapterRunReport;
  deltas: readonly MetricDelta[];
  failures: readonly GateFailure[];
  passed: boolean;
}

export interface RunManifest {
  schemaVersion: '1.0.0';
  runId: string;
  createdAt: string;
  gitCommit: string;
  baselineCommit: string;
  gitDirty: boolean;
  datasetId: string;
  datasetHash: string;
  configHash: string;
  /** Redacted diagnostic configuration. Secrets must never be serialized. */
  config?: Readonly<Record<string, unknown>>;
  seed: number;
  controlAdapter: string;
  candidateAdapter: string;
  runtime: {
    node: string;
    platform: string;
    arch: string;
  };
}
