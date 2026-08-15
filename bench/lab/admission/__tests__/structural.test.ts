import { describe, expect, it } from 'vitest';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ADMISSION_STRUCTURAL_POLICY,
  scoreAdmissionExecutions,
} from '../runner.js';
import { createRegisteredAdmissionSystems } from '../systems.js';
import {
  auditAdmissionSystemDependencies,
  isRegisteredAdmissionEvidence,
  runRegisteredAdmissionEvidence,
  writeRequiredAdmissionArtifacts,
} from '../registered.js';
import {
  loadRegisteredAdmissionInputs,
  loadRegisteredAdmissionOracles,
} from '../../datasets/load-admission.js';
import { createRunManifest } from '../../artifacts.js';
import type { AdmissionStructuralScenarioOracle } from '../../contracts/admission.js';
import { validateAdmissionStructuralOracle } from '../oracle.js';
import * as publicLab from '../../index.js';

describe('MEM-001D1 structural admission evidence', () => {
  it('runs all pinned dev and holdout cases through production core with exact hard metrics', async () => {
    const report = await runRegisteredAdmissionEvidence({ runId: 'admission-structural-test' });
    expect(report.passed).toBe(true);
    expect(report.fidelity).toBe('production-core / fixture-persistence');
    expect(report.scenarios).toHaveLength(11);
    expect(report.scenarios.every(({ outcome }) => outcome === 'scored')).toBe(true);
    expect(report.metrics).toEqual({
      scenarioCoverage: 1,
      baselineOutcomeParity: 1,
      baselineWriteParity: 1,
      observationAccuracy: 1,
      safeFactsAccuracy: 1,
      policyParity: 1,
      deliveryAccuracy: 1,
      contentLeakRate: 0,
      scopeLeakRate: 0,
    });
    expect(report.policy).toEqual(ADMISSION_STRUCTURAL_POLICY);
    expect(isRegisteredAdmissionEvidence(report)).toBe(true);
    expect(JSON.stringify(report)).not.toMatch(/ordinary durable decision|syntheticMEM001D|tenant-admission|project:admission/i);
  });

  it('loads scorer oracles separately and keeps every adapter input oracle-free', async () => {
    const inputs = await loadRegisteredAdmissionInputs();
    expect(inputs).toHaveLength(11);
    for (const input of inputs) {
      expect(JSON.stringify(input)).not.toMatch(/"(?:oracle|expected|safeFacts|recommendation|recommendedTier|wouldChangeBaseline)"/);
    }
    const oracles = await loadRegisteredAdmissionOracles();
    expect(oracles).toHaveLength(11);
    expect(new Set(oracles.map(({ scenarioId }) => scenarioId)).size).toBe(11);
  });

  it('keeps the scorer-only oracle loader out of the public lab barrel', () => {
    expect('loadRegisteredAdmissionInputs' in publicLab).toBe(true);
    expect('loadAdmissionDatasetDescriptors' in publicLab).toBe(true);
    expect('loadRegisteredAdmissionOracles' in publicLab).toBe(false);
  });

  it('does not read or verify scorer-only oracle bytes before system execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memberry-admission-oracle-boundary-'));
    try {
      await mkdir(join(root, 'bench/lab/registry'), { recursive: true });
      await copyFile(join(process.cwd(), 'bench/lab/registry/datasets.json'), join(root, 'bench/lab/registry/datasets.json'));
      for (const split of ['dev', 'holdout']) {
        const target = join(root, `bench/lab/datasets/admission/v1/${split}`);
        await mkdir(target, { recursive: true });
        await copyFile(join(process.cwd(), `bench/lab/datasets/admission/v1/${split}/input.jsonl`), join(target, 'input.jsonl'));
        await writeFile(join(target, 'oracle.jsonl'), '{"corrupt":true}\n', 'utf8');
      }
      await expect(loadRegisteredAdmissionInputs(root)).resolves.toHaveLength(11);
      await expect(loadRegisteredAdmissionOracles(root)).rejects.toThrow(/SHA-256 mismatch/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('audits canonical registered systems and excludes proxy, inline, fixture, dataset, and oracle imports', async () => {
    const audit = await auditAdmissionSystemDependencies();
    expect(audit.violations).toEqual([]);
    expect(audit.visited.some((path) => path.endsWith('systems.ts'))).toBe(true);
    expect(audit.visited.some((path) => /(?:oracle|datasets|fixtures|proxy)/i.test(path))).toBe(false);
  });

  it('fails its source audit on CRLF oracle imports without relying on line endings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memberry-admission-audit-'));
    try {
      await mkdir(join(root, 'bench/lab/admission'), { recursive: true });
      await mkdir(join(root, 'bench/lab/datasets'), { recursive: true });
      await writeFile(join(root, 'bench/lab/admission/system.ts'), "import '../datasets/oracle.js';\r\nexport const unsafe = true;\r\n", 'utf8');
      await writeFile(join(root, 'bench/lab/datasets/oracle.ts'), 'export const label = true;\r\n', 'utf8');
      const audit = await auditAdmissionSystemDependencies(root, 'bench/lab/admission/system.ts');
      expect(audit.violations).toContain('bench/lab/datasets/oracle.ts: scorer/proxy path forbidden');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('is deterministic apart from the caller-supplied run identifier', async () => {
    const first = await runRegisteredAdmissionEvidence({ runId: 'determinism-a' });
    const second = await runRegisteredAdmissionEvidence({ runId: 'determinism-b' });
    expect({ ...first, runId: '<run>' }).toEqual({ ...second, runId: '<run>' });
  });

  it('emits module-instance-neutral observation payloads at the scorer boundary', async () => {
    const [input] = await loadRegisteredAdmissionInputs();
    const { candidate } = createRegisteredAdmissionSystems();
    const execution = await candidate.execute(input!);
    expect(execution.observations.length).toBeGreaterThan(0);
    for (const { observation } of execution.observations) {
      expect(Reflect.ownKeys(observation.safeFacts).every((key) => typeof key === 'string')).toBe(true);
    }
  });

  it('fails closed when a required system reports unsupported or failed evidence', async () => {
    const inputs = await loadRegisteredAdmissionInputs();
    const oracles = await loadRegisteredAdmissionOracles();
    const { control, candidate } = createRegisteredAdmissionSystems();
    const controlExecutions = await Promise.all(inputs.map((input) => control.execute(input)));
    const candidateExecutions = await Promise.all(inputs.map((input) => candidate.execute(input)));

    const unsupported = candidateExecutions.map((value, index) => index === 0
      ? { ...value, outcome: 'unsupported' as const, unsupportedCode: 'missing-capability' as const }
      : value);
    expect(scoreAdmissionExecutions({
      runId: 'unsupported', inputs, oracles, controlExecutions, candidateExecutions: unsupported,
    }).passed).toBe(false);

    const failed = candidateExecutions.map((value, index) => index === 0
      ? { ...value, outcome: 'failed' as const, failureCode: 'system-failure' as const }
      : value);
    expect(scoreAdmissionExecutions({
      runId: 'failed', inputs, oracles, controlExecutions, candidateExecutions: failed,
    }).passed).toBe(false);
  });

  it('fails closed on duplicate or extra required execution evidence', async () => {
    const inputs = await loadRegisteredAdmissionInputs();
    const oracles = await loadRegisteredAdmissionOracles();
    const { control, candidate } = createRegisteredAdmissionSystems();
    const controlExecutions = await Promise.all(inputs.map((input) => control.execute(input)));
    const candidateExecutions = await Promise.all(inputs.map((input) => candidate.execute(input)));
    const report = scoreAdmissionExecutions({
      runId: 'extra-execution',
      inputs,
      oracles,
      controlExecutions,
      candidateExecutions: [...candidateExecutions, candidateExecutions[0]!],
    });
    expect(report.passed).toBe(false);
    expect(report.failures).toContain('candidate evidence IDs must exactly match required scenarios');
  });

  it('fails closed on every incomplete or corrupt safe-facts oracle variant at load and direct-score boundaries', async () => {
    const inputs = await loadRegisteredAdmissionInputs();
    const registeredOracles = await loadRegisteredAdmissionOracles();
    const { control, candidate } = createRegisteredAdmissionSystems();
    const controlExecutions = await Promise.all(inputs.map((input) => control.execute(input)));
    const candidateExecutions = await Promise.all(inputs.map((input) => candidate.execute(input)));

    const mutateObservation = (
      expectation: 'stored' | 'eventual',
      mutate: (operation: Record<string, unknown>) => void,
    ): AdmissionStructuralScenarioOracle[] => {
      const oracles = structuredClone(registeredOracles) as AdmissionStructuralScenarioOracle[];
      const oracle = oracles.find(({ operations }) => operations.some(({ observation }) => observation === expectation))!;
      const operation = oracle.operations.find(({ observation }) => observation === expectation)! as unknown as Record<string, unknown>;
      mutate(operation);
      return oracles;
    };
    const cases: Array<[string, AdmissionStructuralScenarioOracle[]]> = [];
    for (const expectation of ['stored', 'eventual'] as const) {
      cases.push(
        [`${expectation}: omitted`, mutateObservation(expectation, (operation) => { delete operation.safeFacts; })],
        [`${expectation}: partial`, mutateObservation(expectation, (operation) => {
          delete (operation.safeFacts as Record<string, unknown>).hasModel;
        })],
        [`${expectation}: invalid enum`, mutateObservation(expectation, (operation) => {
          (operation.safeFacts as Record<string, unknown>).captureState = 'accepted-sometimes';
        })],
        [`${expectation}: invalid type`, mutateObservation(expectation, (operation) => {
          (operation.safeFacts as Record<string, unknown>).hasSignals = 'false';
        })],
        [`${expectation}: unknown key`, mutateObservation(expectation, (operation) => {
          (operation.safeFacts as Record<string, unknown>).rawContent = 'forbidden';
        })],
      );
    }
    const forbiddenOnNone = structuredClone(registeredOracles) as AdmissionStructuralScenarioOracle[];
    const noneOracle = forbiddenOnNone.find(({ operations }) => operations.some(({ observation }) => observation === 'none'))!;
    const noneOperation = noneOracle.operations.find(({ observation }) => observation === 'none')! as unknown as Record<string, unknown>;
    noneOperation.safeFacts = structuredClone(registeredOracles[0]!.operations[0]!.safeFacts);
    cases.push(['none: forbidden', forbiddenOnNone]);

    for (const [name, oracles] of cases) {
      const invalid = oracles.find((oracle) => validateAdmissionStructuralOracle(oracle).length > 0);
      expect(invalid, name).toBeDefined();
      const report = scoreAdmissionExecutions({
        runId: `invalid-oracle-${name}`,
        inputs,
        oracles,
        controlExecutions,
        candidateExecutions,
      });
      expect(report.passed, name).toBe(false);
      expect(report.metrics.safeFactsAccuracy, name).toBeLessThan(1);
      expect(report.failures).toContain('oracle evidence is invalid');
    }

    for (const expectation of ['stored', 'eventual'] as const) {
      const oracles = mutateObservation(expectation, (operation) => {
        const facts = operation.safeFacts as Record<string, unknown>;
        Object.defineProperty(facts, 'hasModel', {
          value: !facts.hasModel,
          enumerable: false,
          configurable: true,
          writable: true,
        });
      });
      expect(oracles.every((oracle) => validateAdmissionStructuralOracle(oracle).length === 0)).toBe(true);
      const report = scoreAdmissionExecutions({
        runId: `non-enumerable-wrong-label-${expectation}`,
        inputs,
        oracles,
        controlExecutions,
        candidateExecutions,
      });
      expect(report.passed, expectation).toBe(false);
      expect(report.metrics.safeFactsAccuracy, expectation).toBeLessThan(1);
    }
  });

  it('canonicalizes once and rejects stateful accessors, proxies, and exotic oracle containers before scoring', async () => {
    const inputs = await loadRegisteredAdmissionInputs();
    const registeredOracles = await loadRegisteredAdmissionOracles();
    const { control, candidate } = createRegisteredAdmissionSystems();
    const controlExecutions = await Promise.all(inputs.map((input) => control.execute(input)));
    const candidateExecutions = await Promise.all(inputs.map((input) => candidate.execute(input)));
    const score = (oracles: unknown) => scoreAdmissionExecutions({
      runId: 'oracle-toctou',
      inputs,
      oracles: oracles as readonly AdmissionStructuralScenarioOracle[],
      controlExecutions,
      candidateExecutions,
    });

    const stateful = structuredClone(registeredOracles) as AdmissionStructuralScenarioOracle[];
    const statefulOperation = stateful[0]!.operations[0]! as unknown as Record<string, unknown>;
    const validSafeFacts = statefulOperation.safeFacts;
    let statefulReads = 0;
    Object.defineProperty(statefulOperation, 'safeFacts', {
      enumerable: true,
      configurable: true,
      get() {
        statefulReads += 1;
        return statefulReads === 2 ? undefined : validSafeFacts;
      },
    });
    expect(validateAdmissionStructuralOracle(stateful[0])).not.toEqual([]);
    expect(statefulReads).toBe(0);
    expect(score(stateful).passed).toBe(false);
    expect(statefulReads).toBe(0);

    const mutations: Array<[string, (oracles: AdmissionStructuralScenarioOracle[]) => unknown]> = [
      ['oracle proxy', (oracles) => {
        oracles[0] = new Proxy(oracles[0]!, {});
        return oracles;
      }],
      ['operation proxy', (oracles) => {
        const operations = oracles[0]!.operations as AdmissionStructuralScenarioOracle['operations'][number][];
        operations[0] = new Proxy(operations[0]!, {});
        return oracles;
      }],
      ['safeFacts proxy', (oracles) => {
        const operation = oracles[0]!.operations[0]! as unknown as Record<string, unknown>;
        operation.safeFacts = new Proxy(operation.safeFacts as object, {});
        return oracles;
      }],
      ['runtime proxy', (oracles) => {
        (oracles[0] as unknown as Record<string, unknown>).runtime = new Proxy(oracles[0]!.runtime as object, {});
        return oracles;
      }],
      ['operations array proxy', (oracles) => {
        (oracles[0] as unknown as Record<string, unknown>).operations = new Proxy(oracles[0]!.operations, {});
        return oracles;
      }],
      ['oracle accessor', (oracles) => {
        Object.defineProperty(oracles[0], 'scenarioId', { enumerable: true, get: () => oracles[0]!.scenarioId });
        return oracles;
      }],
      ['operation accessor', (oracles) => {
        const operation = oracles[0]!.operations[0]!;
        Object.defineProperty(operation, 'delivery', { enumerable: true, get: () => 'stored' });
        return oracles;
      }],
      ['safeFacts accessor', (oracles) => {
        const safeFacts = oracles[0]!.operations[0]!.safeFacts!;
        Object.defineProperty(safeFacts, 'hasModel', { enumerable: true, get: () => false });
        return oracles;
      }],
      ['runtime accessor', (oracles) => {
        Object.defineProperty(oracles[0]!.runtime!, 'appended', { enumerable: true, get: () => 1 });
        return oracles;
      }],
      ['operation-array accessor', (oracles) => {
        const operations = oracles[0]!.operations;
        const operation = operations[0];
        Object.defineProperty(operations, '0', { enumerable: true, get: () => operation });
        return oracles;
      }],
      ['oracle array proxy', (oracles) => new Proxy(oracles, {})],
    ];

    for (const [name, mutate] of mutations) {
      const oracles = structuredClone(registeredOracles) as AdmissionStructuralScenarioOracle[];
      const report = score(mutate(oracles));
      expect(report.passed, name).toBe(false);
      expect(report.metrics.safeFactsAccuracy, name).toBeLessThan(1);
      expect(report.failures, name).toContain('oracle evidence is invalid');
    }
  });

  it('detects baseline-write, policy, observation, content, and scope regressions', async () => {
    const inputs = await loadRegisteredAdmissionInputs();
    const oracles = await loadRegisteredAdmissionOracles();
    const { control, candidate } = createRegisteredAdmissionSystems();
    const controlExecutions = await Promise.all(inputs.map((input) => control.execute(input)));
    const candidateExecutions = await Promise.all(inputs.map((input) => candidate.execute(input)));
    const first = candidateExecutions[0]!;
    const observation = first.observations[0]!;
    const corrupted = candidateExecutions.map((value, index) => index === 0 ? {
      ...value,
      baselineTrace: [...value.baselineTrace, { kind: 'unexpected-write' }],
      observations: [{
        ...observation,
        scope: { ...observation.scope, tenantId: 'wrong-tenant' },
        observation: {
          ...observation.observation,
          recommendation: { ...observation.observation.recommendation, wouldChangeBaseline: true },
          leaked: inputs[0]!.operations[0]!.input.content,
        } as never,
      }],
    } : value);
    const report = scoreAdmissionExecutions({
      runId: 'corrupted', inputs, oracles, controlExecutions, candidateExecutions: corrupted,
    });
    expect(report.passed).toBe(false);
    expect(report.metrics.baselineWriteParity).toBeLessThan(1);
    expect(report.metrics.policyParity).toBeLessThan(1);
    expect(report.metrics.contentLeakRate).toBeGreaterThan(0);
    expect(report.metrics.scopeLeakRate).toBeGreaterThan(0);
  });

  it('writes only registered content-free evidence through the generic atomic writer', async () => {
    const report = await runRegisteredAdmissionEvidence({ runId: 'registered-artifact' });
    const root = await mkdtemp(join(tmpdir(), 'memberry-admission-artifact-'));
    try {
      const manifest = createRunManifest({
        runId: report.runId,
        createdAt: '2026-08-14T18:00:00.000Z',
        gitCommit: 'ebb89d5',
        baselineCommit: '4166fee',
        gitDirty: false,
        datasetId: 'memberry-admission-structural-v1',
        datasetHash: '1'.repeat(64),
        configHash: '2'.repeat(64),
        config: { network: false, credentials: false, fidelity: report.fidelity },
        seed: 0,
        controlAdapter: report.controlSystem,
        candidateAdapter: report.candidateSystem,
      });
      const paths = await writeRequiredAdmissionArtifacts(join(root, 'run'), report, manifest);
      const artifact = await readFile(paths.json, 'utf8');
      expect(artifact).toContain('production-core / fixture-persistence');
      expect(artifact).not.toMatch(/ordinary durable decision|syntheticMEM001D|tenant-admission|project:admission/i);
      await expect(writeRequiredAdmissionArtifacts(join(root, 'inline'), { ...report } as never, manifest))
        .rejects.toThrow(/registered admission evidence/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
