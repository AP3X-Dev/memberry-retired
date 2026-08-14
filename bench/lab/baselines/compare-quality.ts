#!/usr/bin/env tsx

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BaselineManifest } from './verify.js';

export interface CandidateQualityReport {
  corpusSize: number;
  queryCount: number;
  passed: boolean;
  metrics: Record<string, number>;
}

export interface ComparisonResult {
  passed: boolean;
  failures: string[];
  metrics: Array<{ metric: string; baseline: number; candidate: number | null; delta: number | null; pass: boolean }>;
}

interface ComparisonPolicy {
  schemaVersion: number;
  baseline: string;
  requireCandidatePass: boolean;
  requireSameCorpus: boolean;
  rules: Array<{ metric: string; direction: 'higher' | 'lower'; allowedRegression: number; hardGate?: boolean }>;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_POLICY = resolve(HERE, 'comparison-policy.json');

export function compareQualityReports(
  baseline: BaselineManifest,
  candidate: CandidateQualityReport,
  policy?: ComparisonPolicy,
): ComparisonResult {
  const activePolicy = policy ?? {
    schemaVersion: 1,
    baseline: baseline.id,
    requireCandidatePass: true,
    requireSameCorpus: true,
    rules: [
      ...['recallAt5', 'recallAt10', 'precisionAt5', 'ndcgAt10', 'mrr', 'intentAccuracy', 'currentAboveStaleRate']
        .map((metric) => ({ metric, direction: 'higher' as const, allowedRegression: 0 })),
      { metric: 'staleLeakRate', direction: 'lower', allowedRegression: 0 },
    ],
  };
  const failures: string[] = [];
  const base = baseline.results.quality;
  if (activePolicy.baseline !== baseline.id) failures.push(`policy targets ${activePolicy.baseline}, not ${baseline.id}`);
  if (activePolicy.requireCandidatePass && candidate.passed !== true) failures.push('candidate did not pass its intrinsic quality thresholds');
  if (activePolicy.requireSameCorpus && (candidate.corpusSize !== base.corpusSize || candidate.queryCount !== base.queryCount)) {
    failures.push(`candidate corpus changed: expected ${base.corpusSize} docs/${base.queryCount} queries, received ${candidate.corpusSize} docs/${candidate.queryCount} queries`);
  }
  const metrics = activePolicy.rules.map((rule) => {
    const baselineValue = base.metrics[rule.metric];
    const candidateValue = candidate.metrics?.[rule.metric];
    if (!Number.isFinite(baselineValue)) failures.push(`${rule.metric}: baseline metric is missing or non-finite`);
    if (!Number.isFinite(candidateValue)) {
      failures.push(`${rule.metric}: candidate metric is missing or non-finite`);
      return { metric: rule.metric, baseline: baselineValue, candidate: null, delta: null, pass: false };
    }
    const delta = candidateValue - baselineValue;
    const pass = rule.direction === 'higher'
      ? candidateValue + rule.allowedRegression >= baselineValue
      : candidateValue - rule.allowedRegression <= baselineValue;
    if (!pass) failures.push(`${rule.metric}: ${candidateValue} regressed from ${baselineValue} (delta ${delta >= 0 ? '+' : ''}${delta}; allowed ${rule.allowedRegression})`);
    return { metric: rule.metric, baseline: baselineValue, candidate: candidateValue, delta, pass };
  });
  return { passed: failures.length === 0, failures, metrics };
}

export async function loadComparisonPolicy(path = DEFAULT_POLICY): Promise<ComparisonPolicy> {
  const policy = JSON.parse(await readFile(path, 'utf8')) as ComparisonPolicy;
  if (policy.schemaVersion !== 1 || !Array.isArray(policy.rules) || policy.rules.length === 0) throw new Error('Invalid comparison policy');
  return policy;
}
