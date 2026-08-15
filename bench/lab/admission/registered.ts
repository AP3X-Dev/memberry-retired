import { readFile, stat } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';

import type { AdmissionStructuralReport } from '../contracts/admission.js';
import { ADMISSION_STRUCTURAL_FIDELITY } from '../contracts/admission.js';
import { writeEvaluationArtifacts } from '../artifacts.js';
import type { RunManifest } from '../contracts/report.js';
import { loadRegisteredAdmissionInputs, loadRegisteredAdmissionOracles } from '../datasets/load-admission.js';
import { scoreAdmissionExecutions } from './runner.js';

const DEFAULT_REPO_ROOT = resolve(process.cwd());
const SYSTEM_ENTRY = 'bench/lab/admission/systems.ts';
const CONTROL_ID = 'memberry-admission-baseline-fixture-v1';
const CANDIDATE_ID = 'memberry-admission-shadow-fixture-v1';
const FORBIDDEN_PATH = /(?:^|\/)(?:datasets|fixtures|registry|__tests__)(?:\/|$)|(?:^|[-_.])oracles?(?:[-_.]|$)|(?:^|\/)proxy(?:[-_.\/]|$)/i;
const registeredEvidence = new WeakSet<AdmissionStructuralReport>();

interface StructuralRegistration {
  id: string;
  adapter: string;
  contract?: string;
  fidelity: string;
  fidelityDetail?: string;
  requiredInCi: boolean;
  capabilities?: string[];
}

const REQUIRED_CAPABILITIES = [
  'baseline-effects', 'shadow-observation', 'fault-injection', 'late-settlement',
  'tenant-isolation', 'pre-redaction', 'default-off',
] as const;

export interface AdmissionSystemDependencyAudit {
  visited: readonly string[];
  violations: readonly string[];
}

function importSpecifiers(source: string, file: string): string[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteral(argument)) specifiers.push(argument.text);
      else specifiers.push('<dynamic>');
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return specifiers;
}

async function resolveModule(importer: string, specifier: string): Promise<string> {
  const base = resolve(dirname(importer), specifier);
  const candidates = [base, base.replace(/\.js$/i, '.ts'), resolve(base, 'index.ts')];
  for (const path of [...new Set(candidates)]) {
    try { if ((await stat(path)).isFile()) return path; } catch { /* next */ }
  }
  throw new Error('admission_system_audit:unresolved_import');
}

/** Audits only the lab-owned system graph; production package source is the evaluated boundary. */
export async function auditAdmissionSystemDependencies(
  repoRoot = DEFAULT_REPO_ROOT,
  entryFile = SYSTEM_ENTRY,
): Promise<AdmissionSystemDependencyAudit> {
  const root = resolve(repoRoot);
  const queue = [resolve(root, entryFile)];
  const visited = new Set<string>();
  const violations: string[] = [];
  while (queue.length) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const path = relative(root, current).replace(/\\/g, '/');
    if (path.startsWith('../') || path === '..') { violations.push('system dependency escapes repository'); continue; }
    if (FORBIDDEN_PATH.test(path)) violations.push(`${path}: scorer/proxy path forbidden`);
    // Production core is the subject under evaluation, not lab-owned candidate code.
    if (path.startsWith('packages/')) continue;
    const source = await readFile(current, 'utf8');
    for (const specifier of importSpecifiers(source, path)) {
      if (specifier === '<dynamic>' || !specifier.startsWith('.')) {
        violations.push(`${path}: dynamic or non-relative import forbidden`);
        continue;
      }
      const dependency = await resolveModule(current, specifier);
      queue.push(dependency);
    }
  }
  return { visited: [...visited].sort(), violations: [...new Set(violations)].sort() };
}

async function validateRegistrations(repoRoot: string): Promise<void> {
  const registry = JSON.parse(await readFile(resolve(repoRoot, 'bench/lab/registry/systems.json'), 'utf8')) as {
    systems?: StructuralRegistration[];
  };
  if (!Array.isArray(registry.systems)) throw new Error('admission_system_registry:invalid');
  const byId = new Map(registry.systems.map((entry) => [entry.id, entry]));
  for (const id of [CONTROL_ID, CANDIDATE_ID]) {
    const entry = byId.get(id);
    if (!entry || entry.requiredInCi !== true
      || entry.adapter.replace(/\\/g, '/') !== SYSTEM_ENTRY
      || entry.contract !== 'admission-structural-v1'
      || entry.fidelity !== 'fixture'
      || entry.fidelityDetail !== ADMISSION_STRUCTURAL_FIDELITY
      || !Array.isArray(entry.capabilities)
      || entry.capabilities.length !== REQUIRED_CAPABILITIES.length
      || REQUIRED_CAPABILITIES.some((capability) => !entry.capabilities!.includes(capability))) {
      throw new Error('admission_system_registry:mismatch');
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export async function runRegisteredAdmissionEvidence(options: {
  runId: string;
  repoRoot?: string;
}): Promise<AdmissionStructuralReport> {
  const repoRoot = resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  await validateRegistrations(repoRoot);
  const audit = await auditAdmissionSystemDependencies(repoRoot);
  if (audit.violations.length) throw new Error(`admission_system_audit:failed\n${audit.violations.join('\n')}`);
  // Import and constructor execution remain behind the completed registry and
  // transitive-source audit.
  const { createRegisteredAdmissionSystems } = await import('./systems.js');
  const { control, candidate } = createRegisteredAdmissionSystems();
  if (control.id !== CONTROL_ID || candidate.id !== CANDIDATE_ID
    || control === candidate || control.executionMode !== 'fixture' || candidate.executionMode !== 'fixture') {
    throw new Error('admission_system_factory:mismatch');
  }

  // This order is the trust boundary: both systems finish with input-only data
  // before the scorer-only oracle files are opened.
  const inputs = await loadRegisteredAdmissionInputs(repoRoot);
  const controlExecutions = [];
  const candidateExecutions = [];
  for (const input of inputs) controlExecutions.push(await control.execute(input));
  for (const input of inputs) candidateExecutions.push(await candidate.execute(input));
  const oracles = await loadRegisteredAdmissionOracles(repoRoot);
  const report = deepFreeze(scoreAdmissionExecutions({
    runId: options.runId,
    inputs,
    oracles,
    controlExecutions,
    candidateExecutions,
    evidenceMode: 'registered-ci',
  }));
  registeredEvidence.add(report);
  return report;
}

export function isRegisteredAdmissionEvidence(report: AdmissionStructuralReport): boolean {
  return registeredEvidence.has(report) && report.evidenceMode === 'registered-ci';
}

function renderAdmissionMarkdown(report: AdmissionStructuralReport, manifest: RunManifest): string {
  return [
    `# Admission structural run ${report.runId}`,
    '',
    `- Status: **${report.passed ? 'PASS' : 'FAIL'}**`,
    `- Evidence mode: \`${report.evidenceMode}\``,
    `- Fidelity: \`${report.fidelity}\``,
    `- Commit: \`${manifest.gitCommit}\`${manifest.gitDirty ? ' (dirty)' : ''}`,
    `- Dataset: \`${manifest.datasetId}\` (\`${manifest.datasetHash}\`)`,
    `- Control: \`${report.controlSystem}\``,
    `- Candidate: \`${report.candidateSystem}\``,
    '',
    '| Metric | Value |',
    '|---|---:|',
    ...Object.entries(report.metrics).map(([key, value]) => `| ${key} | ${value.toFixed(4)} |`),
    '',
    '## Scenario outcomes',
    '',
    ...report.scenarios.map((scenario) => `- ${scenario.scenarioId}: ${scenario.outcome}`),
    '',
    '## Failures',
    '',
    ...(report.failures.length ? report.failures.map((failure) => `- ${failure}`) : ['None.']),
    '',
  ].join('\n');
}

export async function writeRequiredAdmissionArtifacts(
  directory: string,
  report: AdmissionStructuralReport,
  manifest: RunManifest,
) {
  if (!isRegisteredAdmissionEvidence(report)) throw new Error('required artifacts need registered admission evidence');
  if (manifest.controlAdapter !== report.controlSystem || manifest.candidateAdapter !== report.candidateSystem) {
    throw new Error('admission manifest system identities do not match evidence');
  }
  return writeEvaluationArtifacts(directory, report, manifest, {
    jsonFile: 'admission-structural.json',
    markdownFile: 'admission-structural.md',
    renderMarkdown: renderAdmissionMarkdown,
  });
}

export const REGISTERED_ADMISSION_SYSTEM_IDS = Object.freeze({ control: CONTROL_ID, candidate: CANDIDATE_ID });
