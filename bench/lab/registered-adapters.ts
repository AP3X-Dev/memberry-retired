import { readFile, stat } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';
import { writeComparisonArtifacts } from './artifacts.js';
import type { LabAdapter } from './contracts/adapter.js';
import type { ComparisonReport, LabGatePolicy, RunManifest } from './contracts/report.js';
import type { LabScenario, LabScenarioSplit } from './contracts/scenario.js';
import { compareAdapters } from './runner.js';

const DEFAULT_REPO_ROOT = resolve(process.cwd());
const DEFAULT_SYSTEM_REGISTRY = resolve(DEFAULT_REPO_ROOT, 'bench', 'lab', 'registry', 'systems.json');
const FORBIDDEN_PATH = /(?:^|\/)(?:fixtures|datasets|registry|__tests__)(?:\/|$)|(?:^|[-_.])oracles?(?:[-_.]|$)/i;
const FORBIDDEN_GLOBAL_IDENTIFIERS = new Set([
  'Bun', 'Deno', 'Function', 'eval', 'global', 'globalThis', 'module', 'process', 'require',
]);
const registeredEvidence = new WeakSet<ComparisonReport>();

export const REGISTERED_ADAPTER_TRUST_BOUNDARY =
  'Required-CI adapters are reviewed repository source with relative-only static dependencies. '
  + 'Node 20 has no stable portable per-module filesystem sandbox, so the lab audits before import, '
  + 'blocks loader, builtin, filesystem, global escape, and runtime-codegen routes, and passes only adapter inputs. '
  + 'This is a source-policy boundary, not an operating-system isolation claim.';

interface SystemRegistration {
  id: string;
  adapter: string;
  fidelity: 'proxy' | 'fixture' | 'live';
  requiredInCi: boolean;
  capabilities: string[];
}

interface CanonicalFactory {
  entry: string;
  create(): Promise<LabAdapter>;
}

const CANONICAL_FACTORIES: Readonly<Record<string, CanonicalFactory>> = Object.freeze({
  'memberry-proxy-v1': {
    entry: 'bench/lab/adapters/memberry-proxy.ts',
    create: async () => {
      const { MemBerryProxyAdapter } = await import('./adapters/memberry-proxy.js');
      return new MemBerryProxyAdapter();
    },
  },
  'scope-aware-bm25-control-v1': {
    entry: 'bench/lab/adapters/baselines.ts',
    create: async () => {
      const { ScopeAwareBm25ControlAdapter } = await import('./adapters/baselines.js');
      return new ScopeAwareBm25ControlAdapter();
    },
  },
  'bm25-baseline-v1': {
    entry: 'bench/lab/adapters/baselines.ts',
    create: async () => {
      const { Bm25BaselineAdapter } = await import('./adapters/baselines.js');
      return new Bm25BaselineAdapter();
    },
  },
  'recency-baseline-v1': {
    entry: 'bench/lab/adapters/baselines.ts',
    create: async () => {
      const { RecencyBaselineAdapter } = await import('./adapters/baselines.js');
      return new RecencyBaselineAdapter();
    },
  },
});

export interface DependencyAudit {
  entry: string;
  visited: readonly string[];
  violations: readonly string[];
}

function moduleSpecifiers(source: string, path: string): { specifiers: string[]; violations: string[] } {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const specifiers: string[] = [];
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && FORBIDDEN_GLOBAL_IDENTIFIERS.has(node.text)) {
      violations.push(`${path}: Node/global escape identifier ${node.text} is forbidden`);
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'constructor') {
      violations.push(`${path}: constructor-based runtime code access is forbidden`);
    }
    if (ts.isElementAccessExpression(node) && node.argumentExpression
      && ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === 'constructor') {
      violations.push(`${path}: constructor-based runtime code access is forbidden`);
    }
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      const argument = node.arguments[0];
      if (!argument || !ts.isStringLiteral(argument)) violations.push(`${path}: non-literal dynamic module loading is forbidden`);
      else specifiers.push(argument.text);
    }
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && ts.isIdentifier(node.expression)
      && (node.expression.text === 'eval' || node.expression.text === 'Function')) {
      violations.push(`${path}: runtime code generation is forbidden`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { specifiers, violations };
}

async function resolveLocalModule(importer: string, specifier: string): Promise<string | undefined> {
  if (!specifier.startsWith('.')) return undefined;
  const base = resolve(dirname(importer), specifier);
  const candidates = [
    base,
    base.replace(/\.js$/i, '.ts'),
    base.replace(/\.mjs$/i, '.mts'),
    resolve(base, 'index.ts'),
  ];
  for (const candidate of [...new Set(candidates)]) {
    try { if ((await stat(candidate)).isFile()) return candidate; } catch { /* try next deterministic candidate */ }
  }
  throw new Error(`${importer}: cannot resolve local import ${specifier}`);
}

/** Audits the full static adapter graph before any candidate module is instantiated. */
export async function auditAdapterDependencies(entry: string, repoRoot = DEFAULT_REPO_ROOT): Promise<DependencyAudit> {
  const root = resolve(repoRoot);
  const start = resolve(entry);
  const queue = [start];
  const visited = new Set<string>();
  const violations: string[] = [];
  while (queue.length) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const relativePath = relative(root, current).replace(/\\/g, '/');
    if (relativePath.startsWith('../') || relativePath === '..') {
      violations.push(`${current}: adapter dependency escapes repository root`);
      continue;
    }
    if (FORBIDDEN_PATH.test(relativePath)) violations.push(`${relativePath}: scorer-only path is forbidden to adapters`);
    const source = await readFile(current, 'utf8');
    const parsed = moduleSpecifiers(source, relativePath);
    violations.push(...parsed.violations);
    for (const specifier of parsed.specifiers) {
      if (!specifier.startsWith('.')) {
        violations.push(`${relativePath}: non-relative module ${specifier} is forbidden to required-CI adapters`);
        continue;
      }
      const dependency = await resolveLocalModule(current, specifier);
      if (dependency) queue.push(dependency);
    }
  }
  return { entry: start, visited: [...visited].sort(), violations: [...new Set(violations)].sort() };
}

async function registrations(registryFile: string): Promise<Map<string, SystemRegistration>> {
  const parsed = JSON.parse(await readFile(registryFile, 'utf8')) as { systems?: SystemRegistration[] };
  if (!Array.isArray(parsed.systems)) throw new Error('systems registry must contain systems[]');
  return new Map(parsed.systems.map((registration) => [registration.id, registration]));
}

async function loadRegisteredAdapter(
  id: string,
  registry: Map<string, SystemRegistration>,
  repoRoot: string,
): Promise<LabAdapter> {
  const registration = registry.get(id);
  if (!registration) throw new Error(`adapter ${id} is not registered`);
  if (!registration.requiredInCi) throw new Error(`adapter ${id} is not approved for required CI evidence`);
  const factory = CANONICAL_FACTORIES[id];
  if (!factory) throw new Error(`adapter ${id} has no canonical required-CI factory`);
  const registeredPath = registration.adapter.replace(/\\/g, '/');
  if (registeredPath !== factory.entry) {
    throw new Error(`adapter ${id} registry path must exactly match canonical factory entry ${factory.entry}`);
  }
  const entry = resolve(repoRoot, factory.entry);
  const relativeEntry = relative(resolve(repoRoot), entry);
  if (relativeEntry.startsWith('..') || relativeEntry === '..') throw new Error(`adapter ${id} path escapes repository root`);
  const audit = await auditAdapterDependencies(entry, repoRoot);
  if (audit.violations.length) throw new Error(`adapter ${id} dependency boundary failed:\n${audit.violations.join('\n')}`);
  // Import and constructor execution happen only after the dependency audit succeeds.
  const adapter = await factory.create();
  if (adapter.id !== registration.id) throw new Error(`adapter factory identity mismatch for ${id}`);
  if (adapter.executionMode !== registration.fidelity) throw new Error(`adapter ${id} execution mode differs from registry fidelity`);
  const declared = [...adapter.capabilities].sort();
  const registered = [...registration.capabilities].sort();
  if (JSON.stringify(declared) !== JSON.stringify(registered)) throw new Error(`adapter ${id} capabilities differ from registry`);
  return adapter;
}

export interface CompareRegisteredAdaptersOptions {
  runId: string;
  controlId: string;
  candidateId: string;
  scenarios: readonly LabScenario[];
  splits?: readonly LabScenarioSplit[];
  policy?: LabGatePolicy;
  registryFile?: string;
  repoRoot?: string;
}

/** Only this path can mint evidence accepted by the required-CI artifact writer. */
export async function compareRegisteredAdapters(options: CompareRegisteredAdaptersOptions): Promise<ComparisonReport> {
  const repoRoot = resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  const registryFile = resolve(options.registryFile ?? DEFAULT_SYSTEM_REGISTRY);
  const registry = await registrations(registryFile);
  const [control, candidate] = await Promise.all([
    loadRegisteredAdapter(options.controlId, registry, repoRoot),
    loadRegisteredAdapter(options.candidateId, registry, repoRoot),
  ]);
  const raw = await compareAdapters({
    runId: options.runId,
    control,
    candidate,
    scenarios: options.scenarios,
    splits: options.splits,
    policy: options.policy,
  });
  const report = deepFreeze({ ...raw, evidenceMode: 'registered-ci' as const });
  registeredEvidence.add(report);
  return report;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function isRegisteredCiEvidence(report: ComparisonReport): boolean {
  return registeredEvidence.has(report) && report.evidenceMode === 'registered-ci';
}

export async function writeRequiredCiComparisonArtifacts(
  directory: string,
  report: ComparisonReport,
  manifest: RunManifest,
) {
  if (!isRegisteredCiEvidence(report)) {
    throw new Error('required CI evidence must come from compareRegisteredAdapters; inline adapters are not accepted');
  }
  if (manifest.controlAdapter !== report.control.adapterId || manifest.candidateAdapter !== report.candidate.adapterId) {
    throw new Error('manifest adapter identities do not match registered comparison evidence');
  }
  return writeComparisonArtifacts(directory, report, manifest);
}
