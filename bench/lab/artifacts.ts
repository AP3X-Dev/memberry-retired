import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ComparisonReport, RunManifest } from './contracts/report.js';

const SECRET_KEY = /(?:authorization|credential|password|secret|token|api[-_]?key|private[-_]?key|cookie)/i;
const SHA256 = /^(?:sha256:)?([a-f0-9]{64})$/i;
const GIT_COMMIT = /^[a-f0-9]{7,64}$/i;

function fixed(value: number): string { return value.toFixed(4); }

export function normalizeSha256(value: string, label = 'hash'): string {
  const match = SHA256.exec(value.trim());
  if (!match) throw new Error(`${label} must be a 64-character SHA-256 digest`);
  return `sha256:${match[1].toLowerCase()}`;
}

export function redactConfig(value: unknown, key = ''): unknown {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((entry) => redactConfig(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([childKey, child]) => [childKey, redactConfig(child, childKey)]));
  }
  return value;
}

export function renderComparisonMarkdown(report: ComparisonReport, manifest: RunManifest): string {
  const lines = [
    `# Evaluation run ${report.runId}`,
    '',
    `- Status: **${report.passed ? 'PASS' : 'FAIL'}**`,
    `- Evidence mode: \`${report.evidenceMode}\``,
    `- Commit: \`${manifest.gitCommit}\`${manifest.gitDirty ? ' (dirty)' : ''}`,
    `- Baseline commit: \`${manifest.baselineCommit}\``,
    `- Dataset: \`${manifest.datasetId}\` (\`${manifest.datasetHash}\`)`,
    `- Config hash: \`${manifest.configHash}\``,
    `- Seed: \`${manifest.seed}\``,
    `- Control: \`${report.control.adapterId}\``,
    `- Candidate: \`${report.candidate.adapterId}\``,
    `- Outcomes: control \`${report.control.outcome}\`, candidate \`${report.candidate.outcome}\``,
    '',
    '| Metric | Control | Candidate | Delta |',
    '|---|---:|---:|---:|',
    ...report.deltas.map((delta) => `| ${delta.metric} | ${fixed(delta.control)} | ${fixed(delta.candidate)} | ${delta.delta >= 0 ? '+' : ''}${fixed(delta.delta)} |`),
    '',
    '## Gate failures',
    '',
    ...(report.failures.length
      ? report.failures.map((failure) => `- ${failure.arm ? `[${failure.arm}] ` : ''}${failure.scenarioId ? `\`${failure.scenarioId}\` ` : ''}${failure.metric}: ${failure.actual}; expected ${failure.expected}`)
      : ['None.']),
    '',
    '## Capability gaps',
    '',
  ];
  for (const run of [report.control, report.candidate]) {
    const gaps = run.scenarioReports.flatMap((scenario) => scenario.capabilityGaps.map((gap) => `${scenario.scenarioId}: ${gap}`));
    lines.push(`- ${run.adapterId}: ${gaps.length ? gaps.join(', ') : 'none'}`);
  }
  lines.push('', '## Exclusions', '');
  for (const run of [report.control, report.candidate]) {
    const exclusions = run.excludedScenarios.map((value) => `${value.scenarioId} (${value.reason})`);
    lines.push(`- ${run.adapterId}: ${exclusions.length ? exclusions.join(', ') : 'none'}`);
  }
  lines.push('');
  return lines.join('\n');
}

export function createRunManifest(input: Omit<RunManifest, 'schemaVersion' | 'runtime'>): RunManifest {
  if (!GIT_COMMIT.test(input.gitCommit)) throw new Error('gitCommit must be a hexadecimal Git object id');
  if (!GIT_COMMIT.test(input.baselineCommit)) throw new Error('baselineCommit must be a hexadecimal Git object id');
  return {
    schemaVersion: '1.0.0',
    ...input,
    gitCommit: input.gitCommit.toLowerCase(),
    baselineCommit: input.baselineCommit.toLowerCase(),
    datasetHash: normalizeSha256(input.datasetHash, 'datasetHash'),
    configHash: normalizeSha256(input.configHash, 'configHash'),
    ...(input.config ? { config: redactConfig(input.config) as Readonly<Record<string, unknown>> } : {}),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
  };
}

/**
 * Publishes a complete immutable run directory atomically. Existing run IDs fail
 * closed rather than being partially overwritten or mixed with stale evidence.
 */
export async function writeComparisonArtifacts(
  directory: string,
  report: ComparisonReport,
  manifest: RunManifest,
): Promise<{ json: string; markdown: string; manifest: string }> {
  const parent = dirname(directory);
  const temporary = join(parent, `.${manifest.runId}.tmp-${process.pid}-${randomUUID()}`);
  await mkdir(parent, { recursive: true });
  await mkdir(temporary);
  const temporaryPaths = {
    json: join(temporary, 'comparison.json'),
    markdown: join(temporary, 'comparison.md'),
    manifest: join(temporary, 'manifest.json'),
  };
  try {
    await Promise.all([
      writeFile(temporaryPaths.json, `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
      writeFile(temporaryPaths.markdown, renderComparisonMarkdown(report, manifest), 'utf8'),
      writeFile(temporaryPaths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
    ]);
    await rename(temporary, directory);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  return {
    json: join(directory, 'comparison.json'),
    markdown: join(directory, 'comparison.md'),
    manifest: join(directory, 'manifest.json'),
  };
}
