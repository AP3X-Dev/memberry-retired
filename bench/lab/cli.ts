#!/usr/bin/env tsx

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { ScopeAwareBm25ControlAdapter } from './adapters/baselines.js';
import { MemBerryProxyAdapter } from './adapters/memberry-proxy.js';
import { createRunManifest, writeComparisonArtifacts } from './artifacts.js';
import type { LabScenarioSplit } from './contracts/scenario.js';
import { RETRIEVAL_SCENARIOS } from './fixtures/retrieval.js';
import { TEMPORAL_ISOLATION_SCENARIOS } from './fixtures/temporal-isolation.js';
import { compareAdapters } from './runner.js';
import { canonicalSha256 } from './baselines/canonical.js';

type Suite = 'protected' | 'retrieval' | 'all';

interface CliOptions {
  suite: Suite;
  splits?: readonly LabScenarioSplit[];
  runId: string;
  outputRoot: string;
}

function value(args: string[], name: string): string | undefined {
  const exact = args.find((arg) => arg.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function parseCliOptions(args: string[], now = new Date()): CliOptions {
  const suite = (value(args, '--suite') ?? 'protected') as Suite;
  if (!['protected', 'retrieval', 'all'].includes(suite)) throw new Error(`unknown --suite ${suite}`);
  const splitValue = value(args, '--split') ?? 'all';
  if (!['dev', 'holdout', 'all'].includes(splitValue)) throw new Error(`unknown --split ${splitValue}`);
  const runId = value(args, '--run-id') ?? `lab-${now.toISOString().replace(/[:.]/g, '-')}`;
  if (!/^[a-zA-Z0-9._-]+$/.test(runId)) throw new Error('--run-id may contain only letters, digits, dot, underscore, and hyphen');
  return {
    suite,
    splits: splitValue === 'all' ? undefined : [splitValue as LabScenarioSplit],
    runId,
    outputRoot: resolve(value(args, '--output') ?? 'node_modules/.cache/memberry-lab/runs'),
  };
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

export async function runCli(options: CliOptions): Promise<{ passed: boolean; directory: string }> {
  const scenarios = options.suite === 'protected'
    ? TEMPORAL_ISOLATION_SCENARIOS
    : options.suite === 'retrieval'
      ? RETRIEVAL_SCENARIOS
      : [...TEMPORAL_ISOLATION_SCENARIOS, ...RETRIEVAL_SCENARIOS];
  const control = new ScopeAwareBm25ControlAdapter();
  const candidate = new MemBerryProxyAdapter();
  const comparison = await compareAdapters({
    runId: options.runId,
    control,
    candidate,
    scenarios,
    splits: options.splits,
  });
  const gitCommit = git(['rev-parse', 'HEAD']);
  const baselineCommit = '7a31231b1dcaa4e8e32d71ed987e22f36fdd0c75';
  const config = {
    suite: options.suite,
    splits: options.splits ?? ['dev', 'holdout'],
    control: control.id,
    candidate: candidate.id,
  };
  const manifest = createRunManifest({
    runId: options.runId,
    createdAt: new Date().toISOString(),
    gitCommit,
    baselineCommit,
    gitDirty: git(['status', '--porcelain', '--untracked-files=all']).length > 0,
    datasetId: `memberry-lab-${options.suite}-v1`,
    datasetHash: canonicalSha256(scenarios),
    configHash: canonicalSha256(config),
    config,
    seed: 0,
    controlAdapter: control.id,
    candidateAdapter: candidate.id,
  });
  const directory = resolve(options.outputRoot, options.runId);
  const paths = await writeComparisonArtifacts(directory, comparison, manifest);
  console.log(`${comparison.passed ? 'PASS' : 'FAIL'} ${options.runId}`);
  console.log(`Control: ${control.id}; candidate: ${candidate.id}; scenarios: ${scenarios.length}`);
  console.log(`Recall@k: ${comparison.candidate.metrics.recallAtK.toFixed(4)}; precision@k: ${comparison.candidate.metrics.precisionAtK.toFixed(4)}`);
  console.log(`Stale leak: ${comparison.candidate.metrics.staleLeakRate.toFixed(4)}; isolation leak: ${comparison.candidate.metrics.isolationLeakRate.toFixed(4)}`);
  for (const failure of comparison.failures) console.error(`- ${failure.scenarioId ? `${failure.scenarioId}: ` : ''}${failure.metric} ${failure.actual}; expected ${failure.expected}`);
  console.log(`Report: ${paths.markdown}`);
  return { passed: comparison.passed, directory };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('/bench/lab/cli.ts')) {
  runCli(parseCliOptions(process.argv.slice(2)))
    .then(({ passed }) => { if (!passed) process.exitCode = 1; })
    .catch((error) => { console.error(error instanceof Error ? error.stack ?? error.message : error); process.exitCode = 1; });
}
