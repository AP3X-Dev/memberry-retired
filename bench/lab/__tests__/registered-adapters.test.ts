import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ScopeAwareBm25ControlAdapter } from '../adapters/baselines.js';
import { MemBerryProxyAdapter } from '../adapters/memberry-proxy.js';
import { createRunManifest } from '../artifacts.js';
import { TEMPORAL_ISOLATION_SCENARIOS } from '../fixtures/temporal-isolation.js';
import {
  auditAdapterDependencies,
  compareRegisteredAdapters,
  isRegisteredCiEvidence,
  writeRequiredCiComparisonArtifacts,
} from '../registered-adapters.js';
import { compareAdapters } from '../runner.js';

const temporaryRoots: string[] = [];
afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

function manifest(runId: string) {
  return createRunManifest({
    runId,
    createdAt: '2026-08-14T12:00:00.000Z',
    gitCommit: 'abcdef1234567890',
    baselineCommit: '7a31231',
    gitDirty: false,
    datasetId: 'registered-fixture',
    datasetHash: '1'.repeat(64),
    configHash: '2'.repeat(64),
    seed: 0,
    controlAdapter: 'scope-aware-bm25-control-v1',
    candidateAdapter: 'memberry-proxy-v1',
  });
}

describe('registered adapter evidence boundary', () => {
  it('audits the real candidate graph without granting oracle or filesystem access', async () => {
    const root = resolve(import.meta.dirname, '..', '..', '..');
    const audit = await auditAdapterDependencies(resolve(root, 'bench/lab/adapters/memberry-proxy.ts'), root);
    expect(audit.violations).toEqual([]);
    expect(audit.visited.some((path) => path.endsWith('proxy-ranking.ts'))).toBe(true);
    expect(audit.visited.some((path) => /oracle|fixtures|datasets/i.test(path))).toBe(false);
  });

  it('rejects a transitive scorer-oracle import before adapter execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memberry-adapter-boundary-'));
    temporaryRoots.push(root);
    await mkdir(join(root, 'adapters'));
    await mkdir(join(root, 'fixtures'));
    await writeFile(join(root, 'fixtures', 'secret-oracle.ts'), 'export const answer = "cheat";\n', 'utf8');
    await writeFile(join(root, 'adapters', 'candidate.ts'), 'import { answer } from "../fixtures/secret-oracle.js"; export default answer;\n', 'utf8');
    const audit = await auditAdapterDependencies(join(root, 'adapters', 'candidate.ts'), root);
    expect(audit.violations.join('\n')).toMatch(/scorer-only path is forbidden/);
  });

  it('rejects bare package loaders instead of trusting transitive package behavior', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memberry-adapter-package-boundary-'));
    temporaryRoots.push(root);
    await mkdir(join(root, 'adapters'));
    await writeFile(join(root, 'adapters', 'candidate.ts'), 'import "tsx"; export const candidate = true;\n', 'utf8');
    const audit = await auditAdapterDependencies(join(root, 'adapters', 'candidate.ts'), root);
    expect(audit.violations).toEqual([expect.stringContaining('non-relative module tsx is forbidden')]);
  });

  it('rejects Node global builtin acquisition including type-cast escape syntax', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memberry-adapter-builtin-boundary-'));
    temporaryRoots.push(root);
    await mkdir(join(root, 'adapters'));
    await writeFile(
      join(root, 'adapters', 'candidate.ts'),
      'const fs = (process as any).getBuiltinModule("node:fs"); export const answer = fs.readFileSync("fixtures/oracle.json", "utf8");\n',
      'utf8',
    );
    const audit = await auditAdapterDependencies(join(root, 'adapters', 'candidate.ts'), root);
    expect(audit.violations).toEqual(expect.arrayContaining([
      expect.stringContaining('Node/global escape identifier process is forbidden'),
    ]));
  });

  it('rejects registry path substitution before auditing or importing factory bytes', async () => {
    const root = resolve(import.meta.dirname, '..', '..', '..');
    const temporary = await mkdtemp(join(tmpdir(), 'memberry-registry-substitution-'));
    temporaryRoots.push(temporary);
    const source = JSON.parse(await readFile(resolve(root, 'bench/lab/registry/systems.json'), 'utf8')) as {
      systems: Array<{ id: string; adapter: string }>;
    };
    const candidate = source.systems.find((system) => system.id === 'memberry-proxy-v1');
    if (!candidate) throw new Error('test registry is missing memberry-proxy-v1');
    candidate.adapter = 'bench/lab/adapters/baselines.ts';
    const registryFile = join(temporary, 'systems.json');
    await writeFile(registryFile, `${JSON.stringify(source, null, 2)}\n`, 'utf8');
    await expect(compareRegisteredAdapters({
      runId: 'substituted-registry',
      controlId: 'scope-aware-bm25-control-v1',
      candidateId: 'memberry-proxy-v1',
      scenarios: TEMPORAL_ISOLATION_SCENARIOS,
      registryFile,
      repoRoot: root,
    })).rejects.toThrow('registry path must exactly match canonical factory entry');
  });

  it('mints required evidence only through registered audited adapter identities', async () => {
    const report = await compareRegisteredAdapters({
      runId: 'registered-comparison',
      controlId: 'scope-aware-bm25-control-v1',
      candidateId: 'memberry-proxy-v1',
      scenarios: TEMPORAL_ISOLATION_SCENARIOS,
    });
    expect(report.passed).toBe(true);
    expect(report.evidenceMode).toBe('registered-ci');
    expect(isRegisteredCiEvidence(report)).toBe(true);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.candidate.metrics)).toBe(true);
  });

  it('rejects inline adapters from the required-CI artifact path', async () => {
    const inline = await compareAdapters({
      runId: 'inline-comparison',
      control: new ScopeAwareBm25ControlAdapter(),
      candidate: new MemBerryProxyAdapter(),
      scenarios: TEMPORAL_ISOLATION_SCENARIOS,
    });
    expect(inline.evidenceMode).toBe('ad-hoc');
    expect(isRegisteredCiEvidence(inline)).toBe(false);
    await expect(writeRequiredCiComparisonArtifacts('unused', inline, manifest(inline.runId)))
      .rejects.toThrow('inline adapters are not accepted');
  });
});
