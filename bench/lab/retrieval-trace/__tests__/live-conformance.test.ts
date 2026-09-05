import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  childEnvironment,
  classifyTraceReadiness,
  cleanupOwnedRedisKeys,
  caseStageDiagnosticCode,
  classifySeededPresentation,
  compositionRootCommand,
  parseSeedReadback,
  parseResidualCounts,
  parseRedisScanPage,
  parseRedisSingleton,
  rankedFixtureMarkers,
  rankedTraceMcpErrorDiagnostic,
  rankedTraceMcpErrorDiagnosticAfterCapture,
  readBoundedResponseText,
  ret010dCaseStageDiagnosticCode,
  requiredPresentationIdForCase,
  resolveTraceConformanceConfig,
  runAbortableOperation,
  safeDiagnosticCode,
  scanRedisKeys,
  seededMissingDiagnosticCode,
  setRedisOwnershipMarker,
  tenantIsolationForbiddenValues,
  traceFixtureForbiddenValues,
  traceFixtureQueries,
  TRACE_INSPECTION_FIXED_CODES,
  RET010D_CASE_IDS,
  RET010D_CASE_STAGES,
  RET010D_STAGE_FIXED_CAUSES,
  TraceMcpTransport,
  TraceValidationStderrParser,
  waitForTraceReadiness,
} from '../live-conformance.js';
import {
  RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_ENABLED,
  RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_ENV,
  RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_LINES,
  type RetrievalTraceValidationStage,
} from '../../../../packages/retrieval/src/tools.js';
import { observeOrderedMarkdownResultIds } from '../contract.js';
import { validateSystemRegistry } from '../../registry/validate.js';

const validEnv = {
  MEMBERRY_TRACE_LIVE_DISPOSABLE: 'true',
  MEMBERRY_TRACE_LIVE_DEFAULT_TOKEN: 'default-trace-token',
  MEMBERRY_TRACE_LIVE_NAMED_TOKEN: 'named-trace-token',
  MEMBERRY_TRACE_LIVE_MCP_URL: 'http://127.0.0.1:3411',
  MEMBERRY_TRACE_LIVE_REDIS_URL: 'redis://127.0.0.1:6379',
  MEMBERRY_TRACE_LIVE_NEO4J_URI: 'bolt://127.0.0.1:7687',
  MEMBERRY_TRACE_LIVE_NEO4J_USER: 'neo4j',
  MEMBERRY_TRACE_LIVE_NEO4J_PASSWORD: 'testpassword',
  MEMBERRY_TRACE_LIVE_REDIS_CONTAINER_ID: 'a'.repeat(64),
  MEMBERRY_TRACE_LIVE_REDIS_IMAGE_ID: `sha256:${'b'.repeat(64)}`,
  MEMBERRY_TRACE_LIVE_NEO4J_CONTAINER_ID: 'c'.repeat(64),
  MEMBERRY_TRACE_LIVE_NEO4J_IMAGE_ID: `sha256:${'d'.repeat(64)}`,
} as const;

function retrievalResolutionStatus() {
  return {
    schema_version: 1,
    affects_readiness: false,
    history_scope: 'process-lifetime',
    history_complete: false,
    counters_saturated: false,
    caller_type_known: false,
    content_captured: false,
    identity_captured: false,
    calls: { total: 0, berry_context: 0, berry_ask: 0 },
    routing: { unanchored: 0, anchored_legacy: 0, anchored_resolver: 0 },
    resolution: {
      attempted: 0,
      resolved: 0,
      failed: 0,
      success_rate: null,
      invalid_request: 0,
      resolution_failed: 0,
      authentication_required: 0,
      unavailable: 0,
      other_failure: 0,
    },
  };
}

const mappingFixture = {
  run: 'run-000000000001',
  default: {
    projectId: 'ret001d-dp-run-000000000001',
    projectName: 'ret001d-default-project-run-000000000001',
    projectTenant: 'default',
    targetId: 'ret001d-dt-run-000000000001',
    targetName: 'ret001d-default-target-run-000000000001',
    targetTenant: 'default',
    targetResponsibility: 'ret001ddrun000000000001',
  },
  named: {
    projectId: 'ret001d-np-run-000000000001',
    projectName: 'ret001d-named-project-run-000000000001',
    projectTenant: 'ret001d-named',
    targetId: 'ret001d-nt-run-000000000001',
    targetName: 'ret001d-named-target-run-000000000001',
    targetTenant: 'ret001d-named',
    targetResponsibility: 'ret001dnrun000000000001',
  },
} as const;

const seedFixture = {
  run: 'run-000000000001',
  defaultProject: 'ret001d-default-project-run-000000000001',
  defaultTarget: 'ret001d-default-target-run-000000000001',
  namedProject: 'ret001d-named-project-run-000000000001',
  namedTarget: 'ret001d-named-target-run-000000000001',
  defaultRankedMarker: 'ret001ddrun000000000001',
  namedRankedMarker: 'ret001dnrun000000000001',
} as const;

const rankedTracedInspectionDiagnostics = [
  ['RET001D_MCP_RESULT_INVALID', 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_MCP_RESULT_INVALID'],
  ['RET001D_MCP_TOOL_FAILURE', 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_MCP_TOOL_FAILURE'],
  ['RET001D_MARKDOWN_INVALID', 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_MARKDOWN_INVALID'],
  ['RET001D_MARKDOWN_REQUEST_MISMATCH', 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_MARKDOWN_REQUEST_MISMATCH'],
  ['RET001D_SEEDED_RESULT_EMPTY', 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_SEEDED_RESULT_EMPTY'],
  ['RET001D_MARKDOWN_PROVENANCE_INVALID', 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_MARKDOWN_PROVENANCE_INVALID'],
  ['RET001D_MARKDOWN_RESULT_INVALID', 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_MARKDOWN_RESULT_INVALID'],
  ['RET001D_MARKDOWN_RESULT_COUNT_MISMATCH', 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_MARKDOWN_RESULT_COUNT_MISMATCH'],
  ['RET001D_SEEDED_RESULT_MISSING', 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_SEEDED_RESULT_MISSING'],
  ['RET001D_MARKDOWN_RESULT_ORDER_MISMATCH', 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_MARKDOWN_RESULT_ORDER_MISMATCH'],
  ['RET001D_NO_TRACE_BLOCK_COUNT', 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_NO_TRACE_BLOCK_COUNT'],
  ['RET001D_TRACE_TOO_LARGE', 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_TRACE_TOO_LARGE'],
  ['RET001D_TRACE_JSON_INVALID', 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_TRACE_JSON_INVALID'],
  ['RET001D_TRACE_CONFORMANCE_INVALID', 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_TRACE_CONFORMANCE_INVALID'],
  ['RET001D_TRACE_ALGORITHM_MISMATCH', 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_TRACE_ALGORITHM_MISMATCH'],
  ['RET001D_TRACE_INCOMPLETE', 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_TRACE_INCOMPLETE'],
  ['RET001D_TRACE_BOUNDS_INVALID', 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_TRACE_BOUNDS_INVALID'],
  ['RET001D_TRACE_NONCANONICAL', 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_TRACE_NONCANONICAL'],
  ['RET001D_TRACE_FORBIDDEN_VALUE', 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_TRACE_FORBIDDEN_VALUE'],
  ['RET001D_TRACE_REPLAY_INVALID', 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_TRACE_REPLAY_INVALID'],
  ['RET001D_TRACE_REPLAY_MISMATCH', 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_TRACE_REPLAY_MISMATCH'],
  ['RET001D_TRACE_CHANNEL_SETTLEMENT_INVALID', 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_TRACE_CHANNEL_SETTLEMENT_INVALID'],
  ['RET001D_TRACE_TERMINAL_COVERAGE_INVALID', 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_TRACE_TERMINAL_COVERAGE_INVALID'],
  ['RET001D_MARKDOWN_TRACE_BINDING_INVALID', 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_MARKDOWN_TRACE_BINDING_INVALID'],
  ['RET001D_TRACE_BLOCK_COUNT', 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_TRACE_BLOCK_COUNT'],
] as const;

function seedRecord(values: Record<string, unknown>): { get(key: string): unknown } {
  return { get: (key: string) => values[key] };
}

function validSeedRecords(): Array<{ get(key: string): unknown }> {
  return [
    seedRecord({
      projectId: 'ret001d-dp-run-000000000001', projectName: seedFixture.defaultProject, projectTenant: 'default',
      targetId: 'ret001d-dt-run-000000000001', targetName: seedFixture.defaultTarget, targetTenant: 'default',
      targetResponsibility: seedFixture.defaultRankedMarker,
    }),
    seedRecord({
      projectId: 'ret001d-np-run-000000000001', projectName: seedFixture.namedProject, projectTenant: 'ret001d-named',
      targetId: 'ret001d-nt-run-000000000001', targetName: seedFixture.namedTarget, targetTenant: 'ret001d-named',
      targetResponsibility: seedFixture.namedRankedMarker,
    }),
  ];
}

function seedRecordsFor(
  run: string,
  defaultResponsibility: string,
  namedResponsibility: string,
): Array<{ get(key: string): unknown }> {
  return [
    seedRecord({
      projectId: `ret001d-dp-${run}`, projectName: seedFixture.defaultProject, projectTenant: 'default',
      targetId: `ret001d-dt-${run}`, targetName: seedFixture.defaultTarget, targetTenant: 'default',
      targetResponsibility: defaultResponsibility,
    }),
    seedRecord({
      projectId: `ret001d-np-${run}`, projectName: seedFixture.namedProject, projectTenant: 'ret001d-named',
      targetId: `ret001d-nt-${run}`, targetName: seedFixture.namedTarget, targetTenant: 'ret001d-named',
      targetResponsibility: namedResponsibility,
    }),
  ];
}

function presentationResult(
  id: string,
  task = 'fixture query',
  strategy: 'deterministic' | 'ranked' = 'deterministic',
): unknown {
  return { content: [{ type: 'text', text: [
    '# Unified Context',
    `**Task:** ${task}`,
    `**Strategy:** ${strategy} | **Tokens:** ~1 | **Sources:** arch_entity:1 | **IDs:** 1`,
    '',
    '## Architecture',
    '',
    `<!-- ${id} -->`,
    'seeded presentation',
  ].join('\n') }] };
}

function traceValidationErrorResult(text: unknown = 'Retrieval trace validation failed'): unknown {
  return { isError: true, content: [{ type: 'text', text }] };
}

describe('RET-001D live composition harness', () => {
  it.each([
    ['deterministic', 'target-ret001d-default-target-run-000000000001'],
    ['ranked', 'ret001d-dt-run-000000000001'],
    ['auto', 'target-ret001d-default-target-run-000000000001'],
    ['named-tenant-forced-ranked', 'ret001d-nt-run-000000000001'],
  ] as const)('maps %s to its exact seeded presentation ID', (id, expected) => {
    expect(requiredPresentationIdForCase(id, mappingFixture)).toBe(expected);
  });

  it('derives separate bounded alphanumeric ranked markers from the run', () => {
    const markers = rankedFixtureMarkers(seedFixture.run);
    expect(markers).toEqual({
      default: 'ret001ddrun000000000001',
      named: 'ret001dnrun000000000001',
    });
    expect(markers.default).not.toBe(markers.named);
    expect(markers.default).toMatch(/^[a-z0-9]+$/);
    expect(markers.named).toMatch(/^[a-z0-9]+$/);
    expect(markers.default.length).toBeLessThanOrEqual(64);
    expect(markers.named.length).toBeLessThanOrEqual(64);
  });

  it.each([
    ['minimum timestamp', '0-000000000000'],
    ['maximum timestamp', 'abcdefghijk-ffffffffffff'],
  ])('accepts the canonical live run grammar at the %s boundary', (_label, run) => {
    const markers = rankedFixtureMarkers(run);
    expect(markers.default).toMatch(/^[a-z0-9]{1,64}$/);
    expect(markers.named).toMatch(/^[a-z0-9]{1,64}$/);
  });

  it.each([
    'ab',
    'a-b',
    'a-b-c',
    'ab-c',
    '-000000000000',
    '00-000000000000',
    'abcdefghijkl-000000000000',
    'a-00000000000',
    'a-0000000000000',
    'a-00000000000A',
  ])('rejects non-canonical live run %j', (run) => {
    expect(() => rankedFixtureMarkers(run)).toThrow('RET001D_RANKED_MARKER_INVALID');
  });

  it.each([
    ['ab', 'a-b'],
    ['a-b-c', 'ab-c'],
    ['a-bbbbbbbbbbbb', 'ab-bbbbbbbbbbb'],
  ])('never accepts both members of the exact prior compacting collision pair %j / %j', (left, right) => {
    expect(left.replaceAll('-', '')).toBe(right.replaceAll('-', ''));
    const accepted = [left, right].flatMap((run) => {
      try { return [rankedFixtureMarkers(run)]; }
      catch { return []; }
    });
    expect(accepted.length).toBeLessThanOrEqual(1);
  });

  it('is injective across accepted live runs and marker families', () => {
    const runs = [
      '0-000000000000',
      'a-000000000000',
      'a-000000000001',
      'ab-000000000000',
      'abcdefghijk-ffffffffffff',
    ];
    const markers = runs.flatMap((run) => Object.values(rankedFixtureMarkers(run)));
    expect(new Set(markers)).toHaveLength(markers.length);
  });

  it('maps each ranked marker only to its intended target query while preserving deterministic and auto tasks', () => {
    expect(traceFixtureQueries({
      defaultTarget: seedFixture.defaultTarget,
      namedTarget: seedFixture.namedTarget,
      defaultRankedMarker: seedFixture.defaultRankedMarker,
      namedRankedMarker: seedFixture.namedRankedMarker,
    })).toEqual({
      deterministic: seedFixture.defaultTarget,
      ranked: seedFixture.defaultRankedMarker,
      auto: `what depends on ${seedFixture.defaultTarget}`,
      named: seedFixture.namedRankedMarker,
    });
  });

  it.each([
    ['missing default marker', { defaultRankedMarker: '' }],
    ['missing named marker', { namedRankedMarker: '' }],
    ['crossed identical markers', { namedRankedMarker: seedFixture.defaultRankedMarker }],
    ['non-alphanumeric marker', { defaultRankedMarker: 'ret001d-default-marker' }],
    ['oversized marker', { defaultRankedMarker: 'a'.repeat(65) }],
  ])('fails closed for %s', (_label, override) => {
    expect(() => traceFixtureQueries({
      defaultTarget: seedFixture.defaultTarget,
      namedTarget: seedFixture.namedTarget,
      defaultRankedMarker: seedFixture.defaultRankedMarker,
      namedRankedMarker: seedFixture.namedRankedMarker,
      ...override,
    })).toThrow('RET001D_RANKED_MARKER_INVALID');
  });

  it('accepts only the exact two truth-bound seeded containment rows', () => {
    expect(parseSeedReadback(validSeedRecords(), seedFixture)).toEqual(mappingFixture);
    expect(() => parseSeedReadback(validSeedRecords().slice(0, 1), seedFixture))
      .toThrow('RET001D_NEO4J_SEED_READBACK_CARDINALITY');
    expect(() => parseSeedReadback([...validSeedRecords(), validSeedRecords()[0]!], seedFixture))
      .toThrow('RET001D_NEO4J_SEED_READBACK_CARDINALITY');
  });

  it('rejects a same-marker readback even when the caller repeats that marker as expected truth', () => {
    const repeatedMarker = seedFixture.defaultRankedMarker;
    expect(() => parseSeedReadback(
      seedRecordsFor(seedFixture.run, repeatedMarker, repeatedMarker),
      { ...seedFixture, namedRankedMarker: repeatedMarker },
    )).toThrow('RET001D_NEO4J_SEED_READBACK_MISMATCH');
  });

  it.each([
    ['default', 'ret001ddforged000000000001', seedFixture.namedRankedMarker],
    ['named', seedFixture.defaultRankedMarker, 'ret001dnforged000000000001'],
  ])('rejects a caller-supplied %s marker that does not derive from the run', (
    _label, defaultRankedMarker, namedRankedMarker,
  ) => {
    expect(() => parseSeedReadback(
      seedRecordsFor(seedFixture.run, defaultRankedMarker, namedRankedMarker),
      { ...seedFixture, defaultRankedMarker, namedRankedMarker },
    )).toThrow('RET001D_NEO4J_SEED_READBACK_MISMATCH');
  });

  it('rejects run and marker truth copied from different canonical runs', () => {
    const run = 'abc-abcdefabcdef';
    expect(() => parseSeedReadback(
      seedRecordsFor(run, seedFixture.defaultRankedMarker, seedFixture.namedRankedMarker),
      { ...seedFixture, run },
    )).toThrow('RET001D_NEO4J_SEED_READBACK_MISMATCH');
  });

  it.each([
    ['get accessor', () => Object.defineProperty({}, 'get', {
      enumerable: true,
      get() { throw new Error('RET001D_SECRET_FIXTURE'); },
    })],
    ['proxied record', () => new Proxy(seedRecord({}), {
      get() { throw new Error('RET001D_SECRET_FIXTURE'); },
      getOwnPropertyDescriptor() { throw new Error('RET001D_SECRET_FIXTURE'); },
    })],
    ['throwing get invocation', () => ({
      get() { throw new Error('RET001D_SECRET_FIXTURE'); },
    })],
  ] as const)('maps a hostile seed read-back %s to one fixed content-free code', (_label, createRecord) => {
    let error: unknown;
    try { parseSeedReadback([createRecord() as never, validSeedRecords()[1]!], seedFixture); }
    catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('RET001D_NEO4J_SEED_READBACK_INVALID');
    expect((error as Error).message).not.toContain('SECRET_FIXTURE');
    expect(safeDiagnosticCode(error)).toBe('RET001D_NEO4J_SEED_READBACK_INVALID');
  });

  it.each([
    ['targetId', 'ret001d-unexpected-target'],
    ['targetName', 'ret001d-unexpected-name'],
    ['projectId', 'ret001d-unexpected-project'],
    ['projectName', 'ret001d-unexpected-project-name'],
    ['targetTenant', 'ret001d-unexpected-tenant'],
    ['projectTenant', 'ret001d-unexpected-tenant'],
    ['targetResponsibility', 'ret001dwrongmarker'],
  ] as const)('rejects a seeded read-back %s mismatch', (field, value) => {
    const records = validSeedRecords();
    const first = {
      projectId: 'ret001d-dp-run-000000000001', projectName: seedFixture.defaultProject, projectTenant: 'default',
      targetId: 'ret001d-dt-run-000000000001', targetName: seedFixture.defaultTarget, targetTenant: 'default',
      targetResponsibility: seedFixture.defaultRankedMarker,
      [field]: value,
    };
    records[0] = seedRecord(first);
    expect(() => parseSeedReadback(records, seedFixture)).toThrow('RET001D_NEO4J_SEED_READBACK_MISMATCH');
  });

  it.each([
    [['target-ret001d-default-target-run-000000000001'], 'expected', 1, 0, 0, 0],
    [['ret001d-dt-run-000000000001'], 'alternate', 0, 1, 0, 0],
    [['ret001d-dp-run-000000000001', 'target-ret001d-default-project-run-000000000001'], 'project-only', 0, 0, 2, 0],
    [['unrelated-result'], 'none', 0, 0, 0, 1],
  ] as const)('classifies seeded presentation evidence without returning identifiers: %j', (
    resultIds, classification, expectedCount, alternateCount, projectCount, otherCount,
  ) => {
    expect(classifySeededPresentation('deterministic', mappingFixture, resultIds)).toEqual({
      classification, expectedCount, alternateCount, projectCount, otherCount, totalCount: resultIds.length,
    });
  });

  it('bounds seeded-missing diagnostic counts', () => {
    expect(() => classifySeededPresentation(
      'deterministic', mappingFixture, Array.from({ length: 513 }, (_, index) => `id-${index}`),
    )).toThrow('RET001D_SEEDED_DIAGNOSTIC_BOUND');
  });

  it('reports alternate seeded presentation evidence using only bounded counts', () => {
    const secret = 'RET001D-secret-result-id';
    const observed = classifySeededPresentation('deterministic', mappingFixture, [
      mappingFixture.default.targetId,
      secret,
    ]);
    const code = seededMissingDiagnosticCode('deterministic', observed);
    expect(code).toBe(
      'RET001D_CASE_DETERMINISTIC_STAGE_ORDINARY_PRESENTATION_SEEDED_ALTERNATE_E0_A1_P0_O1_T2',
    );
    expect(code).not.toContain(secret);
    expect(code).not.toContain(mappingFixture.default.targetId);
    expect(safeDiagnosticCode(new Error(code))).toBe(code);
  });

  it.each([
    ['missing key', {
      classification: 'none', expectedCount: 0, alternateCount: 0, projectCount: 0, totalCount: 0,
    }],
    ['extra key', {
      classification: 'none', expectedCount: 0, alternateCount: 0, projectCount: 0, otherCount: 0, totalCount: 0,
      secret: 'RET001D_SECRET_FIXTURE',
    }],
    ['invalid classification', {
      classification: 'RET001D_SECRET_FIXTURE', expectedCount: 0, alternateCount: 0,
      projectCount: 0, otherCount: 0, totalCount: 0,
    }],
    ['non-integer count', {
      classification: 'none', expectedCount: 0.5, alternateCount: 0, projectCount: 0, otherCount: 0, totalCount: 0.5,
    }],
    ['negative count', {
      classification: 'none', expectedCount: 0, alternateCount: 0, projectCount: 0, otherCount: -1, totalCount: -1,
    }],
    ['oversized count', {
      classification: 'none', expectedCount: 0, alternateCount: 0, projectCount: 0, otherCount: 513, totalCount: 513,
    }],
    ['inconsistent sum', {
      classification: 'none', expectedCount: 0, alternateCount: 0, projectCount: 0, otherCount: 1, totalCount: 0,
    }],
    ['inconsistent expected class', {
      classification: 'alternate', expectedCount: 1, alternateCount: 1, projectCount: 0, otherCount: 0, totalCount: 2,
    }],
    ['inconsistent alternate class', {
      classification: 'project-only', expectedCount: 0, alternateCount: 1, projectCount: 1, otherCount: 0, totalCount: 2,
    }],
    ['inconsistent project class', {
      classification: 'none', expectedCount: 0, alternateCount: 0, projectCount: 1, otherCount: 0, totalCount: 1,
    }],
  ] as const)('rejects forged seeded diagnostic evidence: %s', (_label, forged) => {
    let error: unknown;
    try { seededMissingDiagnosticCode('deterministic', forged as never); }
    catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('RET001D_SEEDED_DIAGNOSTIC_INVALID');
    expect((error as Error).message).not.toContain('SECRET_FIXTURE');
    expect(safeDiagnosticCode(error)).toBe('RET001D_SEEDED_DIAGNOSTIC_INVALID');
  });

  it('rejects proxied seeded diagnostic evidence without invoking its traps', () => {
    const forged = new Proxy({
      classification: 'none', expectedCount: 0, alternateCount: 0,
      projectCount: 0, otherCount: 0, totalCount: 0,
    }, {
      ownKeys() { throw new Error('RET001D_SECRET_FIXTURE'); },
      get() { throw new Error('RET001D_SECRET_FIXTURE'); },
    });
    expect(() => seededMissingDiagnosticCode('deterministic', forged as never))
      .toThrow('RET001D_SEEDED_DIAGNOSTIC_INVALID');
  });

  it.each([
    ['case', 'RET001D_SECRET_FIXTURE', 'ordinary-call'],
    ['stage', 'deterministic', 'RET001D_SECRET_FIXTURE'],
  ] as const)('rejects an invalid diagnostic %s using one fixed code', (_label, id, stage) => {
    let error: unknown;
    try { caseStageDiagnosticCode(id as never, stage as never, new Error('RET001D_SECRET_FIXTURE')); }
    catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('RET001D_CASE_STAGE_DIAGNOSTIC_INVALID');
    expect((error as Error).message).not.toContain('SECRET_FIXTURE');
    expect(safeDiagnosticCode(error)).toBe('RET001D_CASE_STAGE_DIAGNOSTIC_INVALID');
  });

  it.each([
    'ordinary-call',
    'ordinary-presentation',
    'ordinary-inspection',
    'false-call',
    'false-inspection',
    'traced-call',
    'traced-inspection',
    'false-parity',
    'traced-parity',
    'tenant-isolation',
  ] as const)('emits a closed content-free diagnostic for every case at stage %s', (stage) => {
    const secret = 'RET001D secret fixture/query body';
    for (const id of ['deterministic', 'ranked', 'auto', 'named-tenant-forced-ranked'] as const) {
      const code = caseStageDiagnosticCode(id, stage, new Error(secret));
      expect(code).toMatch(/^RET001D_CASE_[A-Z0-9_]+_STAGE_[A-Z0-9_]+$/);
      expect(code).not.toContain(secret);
      expect(safeDiagnosticCode(new Error(code))).toBe(code);
    }
  });

  it.each(rankedTracedInspectionDiagnostics)(
    'maps ranked traced-inspection fixed cause %s to exact subreason diagnostic',
    (innerCode, expected) => {
      const code = caseStageDiagnosticCode('ranked', 'traced-inspection', new Error(innerCode));
      expect(code).toBe(expected);
      expect(safeDiagnosticCode(new Error(code))).toBe(expected);
    },
  );

  it('keeps the compile-time trace-inspection allowlist exact and fully exercised', () => {
    expect(TRACE_INSPECTION_FIXED_CODES)
      .toEqual(rankedTracedInspectionDiagnostics.map(([innerCode]) => innerCode));
  });

  it('maps every RET-010D case, stage, and enumerated fixed cause to one exact content-free diagnostic', () => {
    for (const id of RET010D_CASE_IDS) {
      const caseCode = id.toUpperCase().replaceAll('-', '_');
      for (const stage of RET010D_CASE_STAGES) {
        const stageCode = stage.toUpperCase().replaceAll('-', '_');
        for (const cause of RET010D_STAGE_FIXED_CAUSES[stage]) {
          const expected = `RET010D_CASE_${caseCode}_STAGE_${stageCode}_${cause.slice('RET001D_'.length)}`;
          const code = ret010dCaseStageDiagnosticCode(id, stage, new Error(cause));
          expect(code).toBe(expected);
          expect(safeDiagnosticCode(new Error(code))).toBe(code);
        }
      }
    }
  });

  it('maps unknown RET-010D causes to UNKNOWN for every exact case and stage', () => {
    const secret = 'RET010D secret fixture/query/result body';
    for (const id of RET010D_CASE_IDS) {
      for (const stage of RET010D_CASE_STAGES) {
        const code = ret010dCaseStageDiagnosticCode(id, stage, new Error(secret));
        expect(code).toBe(
          `RET010D_CASE_${id.toUpperCase().replaceAll('-', '_')}`
          + `_STAGE_${stage.toUpperCase().replaceAll('-', '_')}_UNKNOWN`,
        );
        expect(code).not.toContain(secret);
        expect(safeDiagnosticCode(new Error(code))).toBe(code);
      }
    }
  });

  it.each([
    ['invalid case string', 'RET010D_SECRET_FIXTURE', 'ordinary-call'],
    ['invalid stage string', 'authority-disabled-ranked', 'RET010D_SECRET_FIXTURE'],
    ['proxied case', new Proxy({}, { get() { throw new Error('RET010D_SECRET_FIXTURE'); } }), 'ordinary-call'],
    ['accessor stage', 'authority-disabled-ranked', Object.defineProperty({}, 'value', {
      get() { throw new Error('RET010D_SECRET_FIXTURE'); },
    })],
  ] as const)('rejects malformed RET-010D diagnostic identity %s without reflecting it', (_label, id, stage) => {
    let error: unknown;
    expect(() => {
      try { ret010dCaseStageDiagnosticCode(id as never, stage as never, new Error('RET010D_SECRET_FIXTURE')); }
      catch (caught) { error = caught; }
    }).not.toThrow();
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('RET010D_CASE_STAGE_DIAGNOSTIC_INVALID');
    expect((error as Error).message).not.toContain('SECRET_FIXTURE');
    expect(safeDiagnosticCode(error)).toBe('RET010D_CASE_STAGE_DIAGNOSTIC_INVALID');
  });

  it('maps hostile RET-010D diagnostic causes to UNKNOWN without hooks or reflection', () => {
    let callbacks = 0;
    const hostileCauses = [
      () => 'RET001D_MCP_TIMEOUT',
      () => Object.defineProperty(new Error('placeholder'), 'message', {
        configurable: true,
        get() { callbacks += 1; throw new Error('RET010D_SECRET_FIXTURE'); },
      }),
      () => new Proxy(new Error('RET001D_MCP_TIMEOUT'), {
        get() { callbacks += 1; throw new Error('RET010D_SECRET_FIXTURE'); },
        getOwnPropertyDescriptor() { callbacks += 1; throw new Error('RET010D_SECRET_FIXTURE'); },
      }),
      () => {
        const pair = Proxy.revocable(new Error('RET001D_MCP_TIMEOUT'), {});
        pair.revoke();
        return pair.proxy;
      },
      () => new Error(`RET001D_${'A'.repeat(300)}`),
      () => new Error('RET001D_MCP_TIMEOUT__RET010D_SECRET_FIXTURE'),
    ];
    for (const cause of hostileCauses) {
      for (const id of RET010D_CASE_IDS) {
        for (const stage of RET010D_CASE_STAGES) {
          let code: string | undefined;
          expect(() => { code = ret010dCaseStageDiagnosticCode(id, stage, cause()); }).not.toThrow();
          expect(code).toMatch(/_UNKNOWN$/);
          expect(code).not.toContain('SECRET_FIXTURE');
          expect(safeDiagnosticCode(new Error(code))).toBe(code);
        }
      }
    }
    expect(callbacks).toBe(0);
  });

  it.each([
    'RET010D_CASE_UNKNOWN_STAGE_ORDINARY_CALL_UNKNOWN',
    'RET010D_CASE_AUTHORITY_DISABLED_RANKED_STAGE_UNKNOWN_UNKNOWN',
    'RET010D_CASE_AUTHORITY_DISABLED_RANKED_STAGE_ORDINARY_CALL',
    'RET010D_CASE_AUTHORITY_DISABLED_RANKED_STAGE_ORDINARY_CALL_UNKNOWN_SECRET',
    'RET010D_CASE_AUTHORITY_DISABLED_RANKED_STAGE_PRESENTATION_PARITY_MCP_TIMEOUT',
    'RET010D_CASE_authority_disabled_ranked_STAGE_ORDINARY_CALL_UNKNOWN',
    `RET010D_CASE_${'A'.repeat(300)}`,
  ])('rejects malformed or value-bearing RET-010D stage diagnostic %s', (code) => {
    expect(safeDiagnosticCode(new Error(code))).toBe('RET001D_INTERNAL_FAILURE');
  });

  it.each(Object.keys(RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_LINES) as RetrievalTraceValidationStage[])(
    'classifies the exact public retrieval-trace validation envelope with captured stage %s',
    (stage) => {
      const code = rankedTraceMcpErrorDiagnostic(traceValidationErrorResult(), stage);
      expect(code).toBe(`RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_TRACE_VALIDATION_FAILED_${stage}`);
      expect(safeDiagnosticCode(new Error(code))).toBe(code);
    },
  );

  it.each([undefined, '', 'UNKNOWN', 'IN_MEMORY_CONFORMANCE_SECRET'])(
    'maps exact trace-validation envelope with absent or invalid stage %s to UNKNOWN',
    (stage) => {
      expect(rankedTraceMcpErrorDiagnostic(traceValidationErrorResult(), stage))
        .toBe('RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_UNKNOWN');
    },
  );

  it.each([
    ['extra root key', () => ({ ...traceValidationErrorResult() as object, extra: true })],
    ['missing content', () => ({ isError: true })],
    ['root array', () => [traceValidationErrorResult()]],
    ['root proxy', () => new Proxy(traceValidationErrorResult() as object, {
      ownKeys() { throw new Error('RET001D_SECRET_FIXTURE'); },
      getOwnPropertyDescriptor() { throw new Error('RET001D_SECRET_FIXTURE'); },
    })],
    ['revoked root proxy', () => {
      const pair = Proxy.revocable(traceValidationErrorResult() as object, {});
      pair.revoke();
      return pair.proxy;
    }],
    ['isError accessor', () => Object.defineProperty({ content: [] }, 'isError', {
      enumerable: true, get() { throw new Error('RET001D_SECRET_FIXTURE'); },
    })],
    ['isError non-boolean', () => ({ isError: 'true', content: [{
      type: 'text', text: 'Retrieval trace validation failed',
    }] })],
    ['content accessor', () => Object.defineProperty({ isError: true }, 'content', {
      enumerable: true, get() { throw new Error('RET001D_SECRET_FIXTURE'); },
    })],
    ['content object', () => ({ isError: true, content: { 0: { type: 'text', text: 'secret' }, length: 1 } })],
    ['content proxy', () => ({ isError: true, content: new Proxy([{
      type: 'text', text: 'Retrieval trace validation failed',
    }], { getOwnPropertyDescriptor() { throw new Error('RET001D_SECRET_FIXTURE'); } }) })],
    ['empty content', () => ({ isError: true, content: [] })],
    ['two content items', () => ({ isError: true, content: [
      { type: 'text', text: 'Retrieval trace validation failed' },
      { type: 'text', text: 'RET001D_SECRET_FIXTURE' },
    ] })],
    ['sparse content', () => ({ isError: true, content: new Array(1) })],
    ['content extra key', () => {
      const content = [{ type: 'text', text: 'Retrieval trace validation failed' }];
      Object.defineProperty(content, 'extra', { enumerable: true, value: 'RET001D_SECRET_FIXTURE' });
      return { isError: true, content };
    }],
    ['item array', () => ({ isError: true, content: [['text', 'Retrieval trace validation failed']] })],
    ['item proxy', () => ({ isError: true, content: [new Proxy({
      type: 'text', text: 'Retrieval trace validation failed',
    }, { ownKeys() { throw new Error('RET001D_SECRET_FIXTURE'); } })] })],
    ['item extra key', () => ({ isError: true, content: [{
      type: 'text', text: 'Retrieval trace validation failed', extra: 'RET001D_SECRET_FIXTURE',
    }] })],
    ['missing type', () => ({ isError: true, content: [{ text: 'Retrieval trace validation failed' }] })],
    ['missing text', () => ({ isError: true, content: [{ type: 'text' }] })],
    ['type accessor', () => ({ isError: true, content: [Object.defineProperty({
      text: 'Retrieval trace validation failed',
    }, 'type', { enumerable: true, get() { throw new Error('RET001D_SECRET_FIXTURE'); } })] })],
    ['text accessor', () => ({ isError: true, content: [Object.defineProperty({ type: 'text' }, 'text', {
      enumerable: true, get() { throw new Error('RET001D_SECRET_FIXTURE'); },
    })] })],
    ['wrong type', () => ({ isError: true, content: [{ type: 'image', text: 'Retrieval trace validation failed' }] })],
    ['non-string text', () => traceValidationErrorResult({ secret: 'RET001D_SECRET_FIXTURE' })],
    ['text prefix', () => traceValidationErrorResult('prefix Retrieval trace validation failed')],
    ['text suffix', () => traceValidationErrorResult('Retrieval trace validation failed suffix')],
    ['arbitrary text', () => traceValidationErrorResult('RET001D_SECRET_FIXTURE')],
    ['oversize text', () => traceValidationErrorResult('x'.repeat(513))],
  ] as const)('maps malformed or hostile MCP error envelope %s to exact UNKNOWN', (_label, createResult) => {
    let code: string | undefined;
    expect(() => { code = rankedTraceMcpErrorDiagnostic(createResult(), 'IN_MEMORY_CONFORMANCE'); }).not.toThrow();
    expect(code).toBe('RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_UNKNOWN');
    expect(code).not.toContain('SECRET_FIXTURE');
  });

  it('does not classify an exact non-error result envelope as an MCP error', () => {
    expect(rankedTraceMcpErrorDiagnostic({
      isError: false,
      content: [{ type: 'text', text: 'ordinary result remains inspected by trace gates' }],
    })).toBeUndefined();
    expect(rankedTraceMcpErrorDiagnostic({
      content: [{ type: 'text', text: 'ordinary result remains inspected by trace gates' }],
    })).toBeUndefined();
  });

  it('ties the exact classifier string and stage lines to the production trace serializer source', async () => {
    const tools = await readFile(
      fileURLToPath(new URL('../../../../packages/retrieval/src/tools.ts', import.meta.url)), 'utf8',
    );
    expect(tools.match(/throw new Error\('Retrieval trace validation failed'\)/g)).toHaveLength(1);
    for (const [stage, line] of Object.entries(RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_LINES)) {
      expect(line).toBe(`MEMBERRY_TRACE_VALIDATION_STAGE=${stage}`);
      expect(tools.split(`'${line}'`)).toHaveLength(2);
    }
  });

  it.each(Object.entries(RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_LINES))(
    'stderr parser recognizes only exact fixed line for %s across chunks and CRLF',
    (stage, line) => {
      const parser = new TraceValidationStderrParser();
      const split = Math.floor(line.length / 2);
      parser.push(Buffer.from(line.slice(0, split)));
      expect(parser.stage()).toBeUndefined();
      parser.push(`${line.slice(split)}\r\n`);
      expect(parser.stage()).toBe(stage);
    },
  );

  it.each([
    'MEMBERRY_TRACE_VALIDATION_STAGE=UNKNOWN\n',
    'prefix MEMBERRY_TRACE_VALIDATION_STAGE=IN_MEMORY_REPLAY\n',
    'MEMBERRY_TRACE_VALIDATION_STAGE=IN_MEMORY_REPLAY suffix\n',
    'RET001D_SECRET_FIXTURE\n',
    `${'x'.repeat(257)}\n`,
  ])('stderr parser discards unknown or overlong line without retaining its value', (line) => {
    const parser = new TraceValidationStderrParser();
    parser.push(line);
    expect(parser.stage()).toBeUndefined();
    expect(JSON.stringify(parser)).not.toContain('SECRET_FIXTURE');
  });

  it('stderr parser requires newline, rejects repeat/conflict, and resets all request state', () => {
    const parser = new TraceValidationStderrParser();
    const first = RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_LINES.IN_MEMORY_REPLAY;
    const second = RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_LINES.CANONICALIZATION;

    parser.push(first);
    expect(parser.stage()).toBeUndefined();
    parser.reset();
    parser.push(`${first}\n${first}\n`);
    expect(parser.stage()).toBeUndefined();
    parser.reset();
    parser.push(`${first}\n${second}\n`);
    expect(parser.stage()).toBeUndefined();
    parser.reset();
    parser.push(`${'x'.repeat(300)}\n${second}\n`);
    expect(parser.stage()).toBe('CANONICALIZATION');
    parser.invalidate();
    expect(parser.stage()).toBeUndefined();
    parser.reset();
    parser.push(`${first}\n`);
    expect(parser.stage()).toBe('IN_MEMORY_REPLAY');
  });

  it('awaits an exact stage that arrives after the exact MCP validation result', async () => {
    vi.useFakeTimers();
    try {
      const parser = new TraceValidationStderrParser();
      const generation = parser.reset();
      const awaitTerminal = vi.fn(() => parser.waitForTerminal(generation));
      let resolved = false;
      const diagnostic = rankedTraceMcpErrorDiagnosticAfterCapture(
        traceValidationErrorResult(), awaitTerminal,
      ).then((code) => {
        resolved = true;
        return code;
      });
      expect(awaitTerminal).toHaveBeenCalledOnce();
      parser.push(`${RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_LINES.EXPOSED_REPLAY}\n`, generation);
      await vi.advanceTimersByTimeAsync(99);
      expect(resolved).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(diagnostic).resolves.toBe(
        'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_TRACE_VALIDATION_FAILED_EXPOSED_REPLAY',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['non-error', { content: [{ type: 'text', text: 'ordinary' }] }],
    ['nonexact validation error', traceValidationErrorResult('Retrieval trace validation failed suffix')],
    ['malformed error', { isError: true, content: [] }],
  ] as const)('does not wait for parser state for %s envelope', async (_label, result) => {
    const awaitTerminal = vi.fn(async () => 'IN_MEMORY_REPLAY' as const);
    const diagnostic = await rankedTraceMcpErrorDiagnosticAfterCapture(result, awaitTerminal);
    expect(awaitTerminal).not.toHaveBeenCalled();
    expect(diagnostic).toBe(_label === 'non-error'
      ? undefined
      : 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_UNKNOWN');
  });

  it('maps a hard-bounded parser timeout to UNKNOWN', async () => {
    vi.useFakeTimers();
    try {
      const parser = new TraceValidationStderrParser();
      const generation = parser.reset();
      const diagnostic = rankedTraceMcpErrorDiagnosticAfterCapture(
        traceValidationErrorResult(), () => parser.waitForTerminal(generation),
      );
      await vi.advanceTimersByTimeAsync(100);
      await expect(diagnostic).resolves.toBe('RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_UNKNOWN');
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['end', 'error', 'close'] as const)('maps child stderr %s terminal to UNKNOWN', async (terminal) => {
    const parser = new TraceValidationStderrParser();
    const generation = parser.reset();
    const diagnostic = rankedTraceMcpErrorDiagnosticAfterCapture(
      traceValidationErrorResult(), () => parser.waitForTerminal(generation),
    );
    parser[terminal](generation);
    await expect(diagnostic).resolves.toBe('RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_UNKNOWN');
  });

  it('invalidates prior-generation waiters, bytes, and terminal callbacks on reset', async () => {
    vi.useFakeTimers();
    try {
      const parser = new TraceValidationStderrParser();
      const prior = parser.reset();
      const priorWait = parser.waitForTerminal(prior);
      parser.push(`${RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_LINES.IN_MEMORY_REPLAY}\n`, prior);
      const current = parser.reset();
      await expect(priorWait).resolves.toBeUndefined();
      parser.push(`${RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_LINES.IN_MEMORY_REPLAY}\n`, prior);
      parser.close(prior);
      let currentResolved = false;
      const currentWait = parser.waitForTerminal(current).then((stage) => {
        currentResolved = true;
        return stage;
      });
      await vi.advanceTimersByTimeAsync(5);
      expect(currentResolved).toBe(false);
      parser.push(`${RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_LINES.CANONICALIZATION}\n`, current);
      await vi.advanceTimersByTimeAsync(94);
      expect(currentResolved).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(currentWait).resolves.toBe('CANONICALIZATION');
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['repeat', 'IN_MEMORY_REPLAY', 'IN_MEMORY_REPLAY'],
    ['conflict', 'IN_MEMORY_REPLAY', 'CANONICALIZATION'],
  ] as const)('maps %s exact stage lines to UNKNOWN', async (_label, first, second) => {
    const parser = new TraceValidationStderrParser();
    const generation = parser.reset();
    const diagnostic = rankedTraceMcpErrorDiagnosticAfterCapture(
      traceValidationErrorResult(), () => parser.waitForTerminal(generation),
    );
    parser.push(
      `${RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_LINES[first]}\n`
      + `${RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_LINES[second]}\n`,
      generation,
    );
    await expect(diagnostic).resolves.toBe('RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_UNKNOWN');
  });

  it.each([
    ['delayed repeat', 'IN_MEMORY_REPLAY', 'IN_MEMORY_REPLAY'],
    ['delayed conflict', 'IN_MEMORY_REPLAY', 'CANONICALIZATION'],
  ] as const)('observes the full deadline and maps %s after the old quiet point to UNKNOWN', async (
    _label, first, second,
  ) => {
    vi.useFakeTimers();
    try {
      const parser = new TraceValidationStderrParser();
      const generation = parser.reset();
      let resolved = false;
      const diagnostic = rankedTraceMcpErrorDiagnosticAfterCapture(
        traceValidationErrorResult(), () => parser.waitForTerminal(generation),
      ).then((code) => {
        resolved = true;
        return code;
      });
      parser.push(`${RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_LINES[first]}\n`, generation);
      await vi.advanceTimersByTimeAsync(50);
      expect(resolved).toBe(false);
      parser.push(`${RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_LINES[second]}\n`, generation);
      await expect(diagnostic).resolves.toBe('RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_UNKNOWN');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears deadline timers across sequential reset generations', async () => {
    vi.useFakeTimers();
    try {
      const parser = new TraceValidationStderrParser();
      const first = parser.reset();
      const firstWait = parser.waitForTerminal(first);
      expect(vi.getTimerCount()).toBe(1);
      const second = parser.reset();
      await expect(firstWait).resolves.toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
      const secondWait = parser.waitForTerminal(second);
      parser.push(`${RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_LINES.CANONICALIZATION}\n`, second);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(100);
      await expect(secondWait).resolves.toBe('CANONICALIZATION');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drains heavy unknown stderr without retaining or reflecting it before timeout', async () => {
    vi.useFakeTimers();
    try {
      const parser = new TraceValidationStderrParser();
      const generation = parser.reset();
      const secret = 'RET001D_SECRET_FIXTURE';
      const diagnostic = rankedTraceMcpErrorDiagnosticAfterCapture(
        traceValidationErrorResult(), () => parser.waitForTerminal(generation),
      );
      parser.push(`${`${secret}\n`.repeat(20_000)}${'x'.repeat(10_000)}`, generation);
      expect(JSON.stringify(parser)).not.toContain(secret);
      await vi.advanceTimersByTimeAsync(100);
      const code = await diagnostic;
      expect(code).toBe('RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_UNKNOWN');
      expect(code).not.toContain(secret);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['unknown Error', (): unknown => new Error('RET001D_UNKNOWN_TRACE_REASON')],
    ['non-Error string', (): unknown => 'RET001D_TRACE_JSON_INVALID'],
    ['non-Error object', (): unknown => ({ message: 'RET001D_TRACE_JSON_INVALID' })],
    ['message accessor', (): unknown => Object.defineProperty(new Error('placeholder'), 'message', {
      configurable: true,
      get() { throw new Error('RET001D_SECRET_FIXTURE'); },
    })],
    ['Error proxy', (): unknown => new Proxy(new Error('RET001D_TRACE_JSON_INVALID'), {
      get() { throw new Error('RET001D_SECRET_FIXTURE'); },
      getOwnPropertyDescriptor() { throw new Error('RET001D_SECRET_FIXTURE'); },
    })],
    ['revoked Error proxy', (): unknown => {
      const pair = Proxy.revocable(new Error('RET001D_TRACE_JSON_INVALID'), {});
      pair.revoke();
      return pair.proxy;
    }],
    ['secret message', (): unknown => new Error('RET001D_SECRET_FIXTURE')],
    ['value-bearing suffix', (): unknown => new Error('RET001D_TRACE_JSON_INVALID__RET001D_SECRET_FIXTURE')],
  ] as const)('maps ranked traced-inspection hostile or unapproved %s to UNKNOWN', (_label, cause) => {
    let code: string | undefined;
    expect(() => { code = caseStageDiagnosticCode('ranked', 'traced-inspection', cause()); }).not.toThrow();
    expect(code).toBe('RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_UNKNOWN');
    expect(code).not.toContain('SECRET_FIXTURE');
    expect(safeDiagnosticCode(new Error(code))).toBe(code);
  });

  it('does not add subreasons to any other case or stage', () => {
    const cause = new Error('RET001D_TRACE_JSON_INVALID');
    expect(caseStageDiagnosticCode('deterministic', 'traced-inspection', cause))
      .toBe('RET001D_CASE_DETERMINISTIC_STAGE_TRACED_INSPECTION');
    expect(caseStageDiagnosticCode('ranked', 'ordinary-inspection', cause))
      .toBe('RET001D_CASE_RANKED_STAGE_ORDINARY_INSPECTION');
  });

  it.each([
    'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION',
    'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_RET001D_TRACE_JSON_INVALID',
    'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_TRACE_JSON_INVALID_SECRET',
    'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_TRACE_VALIDATION_FAILED',
    'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_TRACE_VALIDATION_FAILED_SECRET',
    'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_TRACE_VALIDATION_FAILED_UNKNOWN',
    'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_',
    'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_UNKNOWN_SECRET',
  ])('rejects malformed or value-bearing ranked traced-inspection diagnostic %s', (code) => {
    expect(safeDiagnosticCode(new Error(code))).toBe('RET001D_INTERNAL_FAILURE');
  });

  it('rejects cross-algorithm presentation-ID substitution', () => {
    const deterministicId = requiredPresentationIdForCase('deterministic', mappingFixture);
    const rankedId = requiredPresentationIdForCase('ranked', mappingFixture);
    expect(deterministicId).not.toBe(rankedId);
    expect(() => observeOrderedMarkdownResultIds(presentationResult(deterministicId), {
      expectedTask: 'fixture query', expectedStrategy: 'deterministic', requiredResultIds: [rankedId],
    })).toThrow('RET001D_SEEDED_RESULT_MISSING');
  });

  it('fails closed when the seeded presentation ID is missing', () => {
    const required = requiredPresentationIdForCase('deterministic', mappingFixture);
    expect(() => observeOrderedMarkdownResultIds(presentationResult('unrelated-result'), {
      expectedTask: 'fixture query', expectedStrategy: 'deterministic', requiredResultIds: [required],
    })).toThrow('RET001D_SEEDED_RESULT_MISSING');
  });

  it('is loopback/disposable fail-closed and exposes only sanitized config', () => {
    const config = resolveTraceConformanceConfig(validEnv);
    expect(config.safeConfig).toEqual({
      host: '127.0.0.1',
      port: 3411,
      transport: 'streamable-http-mcp',
      requestTimeoutMs: 10_000,
      startupTimeoutMs: 300_000,
      responseByteLimit: 4_194_304,
    });
    expect(() => resolveTraceConformanceConfig({ ...validEnv, MEMBERRY_TRACE_LIVE_DISPOSABLE: 'false' }))
      .toThrow('RET-001D live evidence is fail-closed');
    expect(() => resolveTraceConformanceConfig({ ...validEnv, MEMBERRY_TRACE_LIVE_MCP_URL: 'http://192.168.0.25:3411' }))
      .toThrow(/loopback/);
    expect(() => resolveTraceConformanceConfig({ ...validEnv, MEMBERRY_TRACE_LIVE_REDIS_IMAGE_ID: 'redis:7-alpine' }))
      .toThrow(/exact immutable identity/);
    expect(JSON.stringify(config.safeConfig)).not.toContain(config.defaultToken);
    expect(JSON.stringify(config.safeConfig)).not.toContain(config.namedToken);
    expect(JSON.stringify(config.safeConfig)).not.toContain(config.neo4jPassword);
  });

  it('starts the real composition root with a narrow child environment', () => {
    expect(compositionRootCommand()).toEqual({
      executable: process.execPath,
      args: ['--import', 'tsx', 'packages/mcp/src/server.ts'],
    });
    const config = resolveTraceConformanceConfig(validEnv);
    const parentDiagnosticFlag = process.env[RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_ENV];
    const env = childEnvironment(config, 'single-default', 'C:\\fixture\\export');
    expect(env).toMatchObject({
      NODE_ENV: 'test',
      PORT: '3411',
      MCP_PORT: '3411',
      MEMBERRY_HOST: '127.0.0.1',
      MEMBERRY_API_TOKEN: 'default-trace-token',
      MEMBERRY_CONSOLIDATION_ENABLED: 'false',
      MEMBERRY_WIKI_AUTOREFRESH: 'false',
      [RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_ENV]: RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_ENABLED,
      OPENAI_API_KEY: '',
    });
    expect(process.env[RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_ENV]).toBe(parentDiagnosticFlag);
    expect(env.MEMBERRY_TENANT_TOKENS).toBeUndefined();
    expect(env.MEMBERRY_QUERY_PLANNER_V1).toBeUndefined();
    expect(env.MEMBERRY_CANDIDATE_CHANNEL_V1).toBeUndefined();
    expect(env.MEMBERRY_RERANKER_V1).toBeUndefined();
    const named = childEnvironment(config, 'named-tenant', 'C:\\fixture\\export');
    expect(named.MEMBERRY_API_TOKEN).toBeUndefined();
    expect(named.MEMBERRY_TENANT_TOKENS).toBe(`ret001d-named:${config.namedToken}`);
    for (const profile of ['disabled', 'served'] as const) {
      const authority = childEnvironment(config, 'single-default', 'C:\\fixture\\export', profile);
      expect(authority).toMatchObject({
        MEMBERRY_QUERY_PLANNER_V1: '1',
        MEMBERRY_CANDIDATE_CHANNEL_V1: '1',
        MEMBERRY_RERANKER_V1: profile,
      });
    }
    for (const profile of ['shadow', ' enabled', 'served ', '', null]) {
      expect(() => childEnvironment(
        config, 'single-default', 'C:\\fixture\\export', profile as never,
      )).toThrow('RET010D_CHILD_PROFILE_INVALID');
    }
  });

  it('runs the original four legacy cases before six sequential closed RET-010D authority profiles', async () => {
    const source = await readFile(
      fileURLToPath(new URL('../live-conformance.ts', import.meta.url)), 'utf8',
    );
    for (const id of [
      'authority-disabled-ranked', 'authority-served-ranked',
      'authority-disabled-auto', 'authority-served-auto',
      'authority-disabled-deterministic', 'authority-served-deterministic',
    ]) expect(source.split(`'${id}'`).length).toBeGreaterThanOrEqual(2);
    expect(source.indexOf("id: 'named-tenant-forced-ranked'"))
      .toBeLessThan(source.indexOf('await seedRet010dFixtures'));
    expect(source.indexOf("exportPath, 'disabled'"))
      .toBeLessThan(source.indexOf("exportPath, 'served'"));
    expect(source).toContain('RET010D_MATCHED_CONTROL_UNCHANGED');
    expect(source).toContain('RET010D_DETERMINISTIC_BYPASS_MISMATCH');
    expect(source).toContain('ret010dCases.length !== 6');
    expect(source).toContain("as_of: '2026-08-01T00:00:00.000Z'");
    expect(source).toContain('projectName: `ret010d-project-${run}`');
    expect(source).toContain('projectScope: `project:ret010d-project-${run}`');
    expect(source).toContain('project: fixture.projectName');
    expect(source).toContain('scope: fixture.projectScope');
    expect(source).toContain('project_name: fixture.projectScope');
    expect(source).toContain('ret010dFixture.projectName, ret010dFixture.projectScope');
    expect(source).toContain('tags:[$scope], scope:$scope');
    expect(source).toContain('tags:[$foreignScope], scope:$foreignScope');
    expect(source).not.toContain('project_name: fixture.project,');
    expect(source).not.toContain('scope: `project:${fixture.project}`');
    for (const privateFixtureValue of [
      'run,',
      "'stable baseline memory'",
      "'ret010d-foreign'",
      '`ret010d-foreign-project-entity-${run}`',
      '`ret010d-foreign-project-${run}`',
      '`ret010d-foreign-target-entity-${run}`',
      '`ret010d-foreign-target-${run}`',
      '`project:ret010d-foreign-project-${run}`',
    ]) expect(source).toContain(privateFixtureValue);
    expect(source).toContain('}, allForbidden, manifestTruth)');
    expect(source).toContain('for (const value of allForbidden)');
  });

  it('wires every RET-010D operation through the closed stage mapper and keeps outer failures fixed', async () => {
    const source = await readFile(
      fileURLToPath(new URL('../live-conformance.ts', import.meta.url)), 'utf8',
    );
    for (const stage of RET010D_CASE_STAGES) {
      expect(source).toContain(`atRet010dCaseStage(id, '${stage}'`);
    }
    for (const code of [
      'RET010D_NEO4J_SEED_FAILED',
      'RET010D_NEO4J_SESSION_CLOSE_FAILED',
      'RET010D_CHILD_PROFILE_INVALID',
      'RET010D_MATCHED_CONTROL_UNCHANGED',
      'RET010D_DETERMINISTIC_BYPASS_MISMATCH',
      'RET010D_MANIFEST_SHAPE',
      'RET010D_MANIFEST_KEYS',
    ]) {
      expect(source).toContain(`'${code}'`);
      expect(safeDiagnosticCode(new Error(code))).toBe(code);
    }
  });

  it('wires an immediately drained child stderr parser and resets it before every traced request', async () => {
    const source = await readFile(
      fileURLToPath(new URL('../live-conformance.ts', import.meta.url)), 'utf8',
    );
    expect(source).toContain("stdio: ['ignore', 'ignore', 'pipe']");
    expect(source).toMatch(/this\.child\.stderr\.on\('data',[\s\S]+traceValidationDiagnostics\.push/);
    expect(source).toMatch(/removeListener\('data', this\.stderrDataListener\)[\s\S]+on\('data', this\.stderrDataListener\)/);
    expect(source).toMatch(/resetTraceValidationDiagnostic\(\);[\s\S]+include_trace: true/);
  });

  it('bounds streamed bodies before retaining oversized evidence', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { headers: { 'content-length': '33' } });
    await expect(readBoundedResponseText(response, 32)).rejects.toThrow('RET001D_HTTP_BODY_TOO_LARGE');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    ['mismatched id', { jsonrpc: '2.0', id: 999 }],
    ['wrong jsonrpc version', { jsonrpc: '1.0', id: 1 }],
  ])('rejects an initialize response with %s', async (_label, correlation) => {
    const config = resolveTraceConformanceConfig(validEnv);
    const fetchImpl = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { id?: number; method: string };
      if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
      const result = request.method === 'initialize'
        ? { protocolVersion: '2025-03-26' }
        : { content: [{ type: 'text', text: 'ok' }] };
      return new Response(JSON.stringify({ ...correlation, result }), {
        headers: { 'content-type': 'application/json', 'mcp-session-id': 'session-1' },
      });
    }) as unknown as typeof fetch;
    await expect(new TraceMcpTransport(config, config.defaultToken, fetchImpl).call('berry_tools', { action: 'list' }))
      .rejects.toThrow('RET001D_MCP_CORRELATION_INVALID');
  });

  it('correlates the tool response itself, not only initialization', async () => {
    const config = resolveTraceConformanceConfig(validEnv);
    const fetchImpl = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { id?: number; method: string };
      if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
      const result = request.method === 'initialize'
        ? { protocolVersion: '2025-03-26' }
        : { content: [{ type: 'text', text: 'ok' }] };
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: request.method === 'tools/call' ? Number(request.id) + 1 : request.id, result,
      }), { headers: { 'content-type': 'application/json', 'mcp-session-id': 'session-1' } });
    }) as unknown as typeof fetch;
    await expect(new TraceMcpTransport(config, config.defaultToken, fetchImpl).call('berry_tools', { action: 'list' }))
      .rejects.toThrow('RET001D_MCP_CORRELATION_INVALID');
  });

  it('keeps the request timeout active through a bounded streaming body read', async () => {
    vi.useFakeTimers();
    try {
      const config = resolveTraceConformanceConfig({
        ...validEnv, MEMBERRY_TRACE_LIVE_REQUEST_TIMEOUT_MS: '100',
      });
      let calls = 0;
      const fetchImpl = vi.fn(async () => {
        calls += 1;
        if (calls > 1) return new Response(null, { status: 202 });
        const body = new ReadableStream<Uint8Array>({
          start(value) {
            value.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26"}}'));
          },
        });
        return new Response(body, {
          headers: { 'content-type': 'application/json', 'mcp-session-id': 'session-1' },
        });
      }) as unknown as typeof fetch;
      const pending = new TraceMcpTransport(config, config.defaultToken, fetchImpl)
        .call('berry_tools', { action: 'list' });
      const outcome = pending.then(() => 'resolved', (error: Error) => error.message);
      await vi.advanceTimersByTimeAsync(200);
      expect(await outcome).toBe('RET001D_MCP_TIMEOUT');
      await pending.catch(() => undefined);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts and drains a timed mutation so it cannot fire after cleanup or recount', async () => {
    vi.useFakeTimers();
    try {
      let delayedMutations = 0;
      let cleanupCompleted = false;
      let mutationAfterCleanup = false;
      const pending = runAbortableOperation(
        (signal) => new Promise<void>((resolvePromise, rejectPromise) => {
          const delayed = setTimeout(() => {
            delayedMutations += 1;
            mutationAfterCleanup ||= cleanupCompleted;
            resolvePromise();
          }, 250);
          signal.addEventListener('abort', () => {
            clearTimeout(delayed);
            rejectPromise(new Error('aborted-and-drained'));
          }, { once: true });
        }),
        100,
        'RET001D_NEO4J_PREFLIGHT_TIMEOUT',
        'RET001D_NEO4J_PREFLIGHT_FAILED',
      );
      const rejection = expect(pending).rejects.toThrow('RET001D_NEO4J_PREFLIGHT_TIMEOUT');
      await vi.advanceTimersByTimeAsync(101);
      await rejection;
      cleanupCompleted = true;
      await vi.advanceTimersByTimeAsync(500);
      expect(delayedMutations).toBe(0);
      expect(mutationAfterCleanup).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('builds explicit cross-tenant and decoy forbidden sets for every live case', () => {
    const fixture = {
      run: 'run-000000000001',
      defaultContent: 'default-content',
      namedContent: 'named-content',
      decoyContent: 'decoy-content',
      defaultRankedMarker: seedFixture.defaultRankedMarker,
      namedRankedMarker: seedFixture.namedRankedMarker,
    };
    expect(tenantIsolationForbiddenValues('default', fixture)).toEqual(expect.arrayContaining([
      'ret001d-np-run-000000000001', 'ret001d-nt-run-000000000001',
      'ret001d-ns-run-000000000001', 'named-content',
      seedFixture.namedRankedMarker, 'ret001d-decoy-run-000000000001', 'decoy-content',
    ]));
    expect(tenantIsolationForbiddenValues('named-tenant', fixture)).toEqual(expect.arrayContaining([
      'ret001d-dp-run-000000000001', 'ret001d-dt-run-000000000001',
      'ret001d-dd-run-000000000001', 'ret001d-da-run-000000000001',
      'ret001d-ds-run-000000000001', 'default-content', seedFixture.defaultRankedMarker,
      'ret001d-decoy-run-000000000001', 'decoy-content',
    ]));
  });

  it('fails strict seed and isolation checks for missing or cross-tenant ranked markers', () => {
    const queries = traceFixtureQueries({
      defaultTarget: seedFixture.defaultTarget,
      namedTarget: seedFixture.namedTarget,
      defaultRankedMarker: seedFixture.defaultRankedMarker,
      namedRankedMarker: seedFixture.namedRankedMarker,
    });
    expect(() => observeOrderedMarkdownResultIds(presentationResult('unrelated-result', queries.ranked, 'ranked'), {
      expectedTask: queries.ranked, expectedStrategy: 'ranked',
      requiredResultIds: [mappingFixture.default.targetId],
    })).toThrow('RET001D_SEEDED_RESULT_MISSING');
    expect(tenantIsolationForbiddenValues('default', {
      run: seedFixture.run, defaultContent: 'default-content', namedContent: 'named-content',
      decoyContent: 'decoy-content', defaultRankedMarker: seedFixture.defaultRankedMarker,
      namedRankedMarker: seedFixture.namedRankedMarker,
    })).toContain(seedFixture.namedRankedMarker);
  });

  it('places both ranked markers in trace and artifact forbidden values', () => {
    const queries = traceFixtureQueries({
      defaultTarget: seedFixture.defaultTarget,
      namedTarget: seedFixture.namedTarget,
      defaultRankedMarker: seedFixture.defaultRankedMarker,
      namedRankedMarker: seedFixture.namedRankedMarker,
    });
    const forbidden = traceFixtureForbiddenValues(['token-a', 'token-b'], {
      defaultContent: 'default-content', namedContent: 'named-content', decoyContent: 'decoy-content',
      defaultRankedMarker: seedFixture.defaultRankedMarker, namedRankedMarker: seedFixture.namedRankedMarker,
    }, queries);
    expect(forbidden).toEqual(expect.arrayContaining([
      seedFixture.defaultRankedMarker, seedFixture.namedRankedMarker,
    ]));
    const evidence = JSON.stringify({ packet: 'RET-001D', cases: [{ id: 'ranked', trace: { candidateCount: 1 } }] });
    expect(forbidden.some((value) => evidence.includes(value))).toBe(false);
  });

  it('requires an explicit single residual row and never defaults missing Neo4j evidence to clean', () => {
    expect(() => parseResidualCounts([])).toThrow('RET001D_NEO4J_RESIDUAL_INVALID');
    expect(() => parseResidualCounts([{ get: () => undefined }])).toThrow('RET001D_NEO4J_RESIDUAL_INVALID');
    expect(parseResidualCounts([{ get: (key: string) => key === 'nodes' ? 0 : 0 }])).toEqual({
      nodes: 0, relationships: 0,
    });
  });

  const redisRun = 'a-000000000000';
  const redisToken = 'a'.repeat(32);
  const redisOwned = {
    marker: `memberry:lab:ret001d:${redisRun}:ownership`,
    defaultContext: 'amp:ctx:1111111111111111',
    defaultNode: `amp:deps:ret001d-ds-${redisRun}`,
    defaultScope: `amp:scope-deps:project:ret001d-default-project-${redisRun}`,
    namedContext: 'amp:ctx:ret001d-named:2222222222222222',
    namedNode: `amp:deps:ret001d-named:ret001d-ns-${redisRun}`,
    namedScope: `amp:scope-deps:ret001d-named:project:ret001d-named-project-${redisRun}`,
  } as const;

  function cacheJson(source: string): string {
    return JSON.stringify({ markdown: '# Memory Context', tokens: 1, sources: [source], assembled_at: '2026-08-16T00:00:00.000Z' });
  }

  it('claims an unguessable marker token only with exact SET token EX 900 NX OK semantics', async () => {
    const set = vi.fn().mockResolvedValue('OK');
    await expect(setRedisOwnershipMarker(
      { set } as never, new Set(['baseline']), redisRun, redisToken,
    )).resolves.toBe(redisOwned.marker);
    expect(set).toHaveBeenCalledWith(redisOwned.marker, redisToken, 'EX', 900, 'NX');
  });

  it('rejects marker collisions before SET and snapshot-to-NX races without deleting anything', async () => {
    const collisionSet = vi.fn();
    await expect(setRedisOwnershipMarker(
      { set: collisionSet } as never, new Set([redisOwned.marker]), redisRun, redisToken,
    )).rejects.toThrow('RET001D_REDIS_OWNERSHIP_INVALID');
    expect(collisionSet).not.toHaveBeenCalled();

    const racedSet = vi.fn().mockResolvedValue(null);
    await expect(setRedisOwnershipMarker(
      { set: racedSet } as never, new Set(['baseline']), redisRun, redisToken,
    )).rejects.toThrow('RET001D_REDIS_OWNERSHIP_INVALID');
  });

  it('maps SET errors to a fixed diagnostic without reflecting the marker token', async () => {
    const set = vi.fn().mockRejectedValue(new Error(redisToken));
    await expect(setRedisOwnershipMarker(
      { set } as never, new Set(['baseline']), redisRun, redisToken,
    )).rejects.toThrow('RET001D_REDIS_OWNERSHIP_FAILED');
    expect(safeDiagnosticCode(new Error(redisToken))).toBe('RET001D_INTERNAL_FAILURE');
  });

  it.each([
    undefined, null, 1, {}, 'ok', ['-1', []], ['x', []], ['00', []],
    ['18446744073709551616', []], ['1'.repeat(21), []],
  ])('rejects malformed SCAN outer/cursor evidence %#', (value) => {
    expect(() => parseRedisScanPage(value)).toThrow('RET001D_REDIS_SCAN_FAILED');
  });

  it('traverses legitimate multi-page SCAN evidence exactly once per cursor', async () => {
    const scan = vi.fn()
      .mockResolvedValueOnce(['17', ['alpha', 'beta']])
      .mockResolvedValueOnce(['0', ['gamma']]);
    await expect(scanRedisKeys({ scan } as never, 1_000)).resolves.toEqual(new Set(['alpha', 'beta', 'gamma']));
    expect(scan.mock.calls.map(([cursor]) => cursor)).toEqual(['0', '17']);
  });

  it('rejects repeated nonterminal SCAN cursors', async () => {
    const scan = vi.fn().mockResolvedValueOnce(['1', []]).mockResolvedValueOnce(['1', []]);
    await expect(scanRedisKeys({ scan } as never, 1_000)).rejects.toThrow('RET001D_REDIS_SCAN_FAILED');
  });

  it('bounds SCAN page count even when pages contain no keys', async () => {
    let cursor = 0;
    const scan = vi.fn(async () => [String(++cursor), []]);
    await expect(scanRedisKeys({ scan } as never, 1_000)).rejects.toThrow('RET001D_REDIS_KEY_BOUND');
    expect(scan).toHaveBeenCalledTimes(4_096);
  });

  it('bounds duplicate-page pressure independently of unique-key count', async () => {
    let cursor = 0;
    const scan = vi.fn(async () => [String(++cursor), ['same-key']]);
    await expect(scanRedisKeys({ scan } as never, 1_000)).rejects.toThrow('RET001D_REDIS_KEY_BOUND');
    expect(scan).toHaveBeenCalledTimes(4_096);
  });

  it.each([
    [['0', new Array(4_097).fill('key')], 'RET001D_REDIS_SCAN_FAILED'],
    [['0', ['x'.repeat(1_025)]], 'RET001D_REDIS_SCAN_FAILED'],
  ])('rejects raw SCAN entry bounds %#', async (page, code) => {
    await expect(scanRedisKeys({ scan: vi.fn().mockResolvedValue(page) } as never, 1_000))
      .rejects.toThrow(code as string);
  });

  it('bounds the aggregate number of distinct SCAN keys', async () => {
    const scan = vi.fn()
      .mockResolvedValueOnce(['1', new Array(4_096).fill(0).map((_, index) => `key-${index}`)])
      .mockResolvedValueOnce(['0', ['overflow']]);
    await expect(scanRedisKeys({ scan } as never, 1_000)).rejects.toThrow('RET001D_REDIS_KEY_BOUND');
  });

  it('rejects proxy, revoked, accessor, sparse, extra-key, and oversized SCAN outer and inner arrays without hooks', () => {
    let traps = 0;
    const proxy = new Proxy(['0', []], { get() { traps++; throw new Error('outer secret'); } });
    const revoked = Proxy.revocable(['0', []], {}); revoked.revoke();
    const accessor = ['0', []];
    Object.defineProperty(accessor, '0', { enumerable: true, get() { traps++; throw new Error('outer accessor'); } });
    const sparse = new Array(2); Object.defineProperty(sparse, '0', { enumerable: true, value: '0' });
    const extra = ['0', []]; Object.defineProperty(extra, Symbol('secret'), { value: true });
    const oversized = ['0', [], 'extra'];

    const innerProxy = new Proxy([] as string[], { get() { traps++; throw new Error('inner secret'); } });
    const innerRevoked = Proxy.revocable([] as string[], {}); innerRevoked.revoke();
    const innerAccessor = ['key'];
    Object.defineProperty(innerAccessor, '0', { enumerable: true, get() { traps++; throw new Error('inner accessor'); } });
    const innerSparse = new Array(1);
    const innerExtra = ['key']; Object.defineProperty(innerExtra, 'extra', { value: true });
    const innerOversized = new Array(4_097).fill('key');

    for (const value of [proxy, revoked.proxy, accessor, sparse, extra, oversized,
      ['0', innerProxy], ['0', innerRevoked.proxy], ['0', innerAccessor], ['0', innerSparse],
      ['0', innerExtra], ['0', innerOversized]]) {
      expect(() => parseRedisScanPage(value)).toThrow('RET001D_REDIS_SCAN_FAILED');
    }
    expect(traps).toBe(0);
  });

  it('applies equivalent descriptor-safe singleton validation to hostile SMEMBERS arrays', () => {
    let traps = 0;
    const proxy = new Proxy(['key'], { get() { traps++; throw new Error('secret'); } });
    const revoked = Proxy.revocable(['key'], {}); revoked.revoke();
    const accessor = ['key'];
    Object.defineProperty(accessor, '0', { enumerable: true, get() { traps++; throw new Error('accessor'); } });
    const sparse = new Array(1);
    const extra = ['key']; Object.defineProperty(extra, 'extra', { value: true });
    for (const value of [proxy, revoked.proxy, accessor, sparse, extra, ['one', 'two']]) {
      expect(parseRedisSingleton(value)).toBeUndefined();
    }
    expect(parseRedisSingleton(['key'])).toBe('key');
    expect(traps).toBe(0);
  });

  function redisCleanupFixture() {
    const keys = new Set<string>(['baseline', ...Object.values(redisOwned)]);
    const sets = new Map<string, unknown>([
      [redisOwned.defaultNode, [redisOwned.defaultContext]],
      [redisOwned.defaultScope, [redisOwned.defaultContext]],
      [redisOwned.namedNode, [redisOwned.namedContext]],
      [redisOwned.namedScope, [redisOwned.namedContext]],
    ]);
    const values = new Map<string, string>([
      [redisOwned.marker, redisToken],
      [redisOwned.defaultContext, cacheJson(`ret001d-ds-${redisRun}`)],
      [redisOwned.namedContext, cacheJson(`ret001d-ns-${redisRun}`)],
    ]);
    const deleted: string[] = [];
    let beforeEval: (() => void) | undefined;
    const remove = (removed: readonly string[]) => {
      deleted.push(...removed);
      for (const key of removed) { keys.delete(key); sets.delete(key); values.delete(key); }
    };
    const redis = {
      scan: vi.fn(async () => ['0', [...keys]]),
      smembers: vi.fn(async (key: string) => sets.get(key) ?? []),
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      eval: vi.fn(async (_script: string, keyCount: number, ...parts: string[]) => {
        beforeEval?.();
        const casKeys = parts.slice(0, keyCount);
        const argv = parts.slice(keyCount);
        if (keyCount < 1 || (keyCount - 1) % 3 !== 0 || argv.length !== 1 + ((keyCount - 1) / 3)) return -1;
        if (_script.includes('KEYS[left] == KEYS[right]') && new Set(casKeys).size !== casKeys.length) return -13;
        if (!values.has(casKeys[0]!) || sets.has(casKeys[0]!) || values.get(casKeys[0]!) !== argv[0]) return -1;
        for (let index = 1, proof = 0; index < casKeys.length; index += 3, proof++) {
          const [contextKey, nodeKey, scopeKey] = casKeys.slice(index, index + 3);
          if (!contextKey || !nodeKey || !scopeKey || sets.has(contextKey) || !values.has(contextKey)
            || !sets.has(nodeKey) || !sets.has(scopeKey)) return -1;
          const nodeMembers = sets.get(nodeKey);
          const scopeMembers = sets.get(scopeKey);
          if (!Array.isArray(nodeMembers) || nodeMembers.length !== 1 || nodeMembers[0] !== contextKey
            || !Array.isArray(scopeMembers) || scopeMembers.length !== 1 || scopeMembers[0] !== contextKey
            || values.get(contextKey) !== argv[1 + proof]) return -1;
        }
        const uniqueKeys = [...new Set(casKeys)];
        remove(uniqueKeys);
        return uniqueKeys.length;
      }),
    };
    return { redis, keys, sets, values, deleted, setBeforeEval(hook: () => void) { beforeEval = hook; } };
  }

  it('proves and removes the exact seven run-owned Redis artifacts', async () => {
    const fixture = redisCleanupFixture();
    const result = await cleanupOwnedRedisKeys(
      fixture.redis as never, new Set(['baseline']), redisRun, redisToken, 1_000,
    );
    expect(result).toEqual({ ownedCreated: 7, ownedRemaining: 0, unexpectedNewKeys: 0 });
    expect(new Set(fixture.deleted)).toEqual(new Set(Object.values(redisOwned)));
    expect(fixture.keys).toEqual(new Set(['baseline']));
    expect(fixture.redis.eval).toHaveBeenCalledTimes(1);
    const [script, keyCount, ...parts] = fixture.redis.eval.mock.calls[0]!;
    const explicitKeys = parts.slice(0, keyCount as number);
    const argv = parts.slice(keyCount as number);
    expect(keyCount).toBe(7);
    expect(explicitKeys).toEqual([
      redisOwned.marker,
      redisOwned.defaultContext, redisOwned.defaultNode, redisOwned.defaultScope,
      redisOwned.namedContext, redisOwned.namedNode, redisOwned.namedScope,
    ]);
    expect(new Set(explicitKeys).size).toBe(7);
    expect(argv).toEqual([
      redisToken, cacheJson(`ret001d-ds-${redisRun}`), cacheJson(`ret001d-ns-${redisRun}`),
    ]);
    expect(script).toEqual(expect.stringContaining("redis.call('TYPE'"));
    expect(script).toEqual(expect.stringContaining("redis.call('SCARD'"));
    expect(script).toEqual(expect.stringContaining("redis.call('SMEMBERS'"));
    expect(script).toEqual(expect.stringContaining("redis.call('DEL'"));
    expect(script).not.toContain(redisToken);
    expect(JSON.stringify(result)).not.toContain(redisToken);
  });

  it.each([
    ['marker', redisOwned.marker],
    ['dependency', redisOwned.defaultNode],
    ['context', redisOwned.defaultContext],
  ])('never deletes a preexisting %s key', async (_label, preexisting) => {
    const fixture = redisCleanupFixture();
    await expect(cleanupOwnedRedisKeys(
      fixture.redis as never, new Set(['baseline', preexisting]), redisRun, redisToken, 1_000,
    )).rejects.toThrow('RET001D_REDIS_OWNERSHIP_INVALID');
    expect(fixture.deleted).not.toContain(preexisting);
    expect(fixture.keys.has(preexisting)).toBe(true);
    if (preexisting !== redisOwned.marker) expect(fixture.deleted).toContain(redisOwned.marker);
  });

  it('preserves and reports foreign keys including an unreferenced context-shaped key', async () => {
    const fixture = redisCleanupFixture();
    fixture.keys.add('concurrent:foreign');
    fixture.keys.add('amp:ctx:3333333333333333');
    await expect(cleanupOwnedRedisKeys(
      fixture.redis as never, new Set(['baseline']), redisRun, redisToken, 1_000,
    )).resolves.toEqual({ ownedCreated: 7, ownedRemaining: 0, unexpectedNewKeys: 2 });
    expect(fixture.keys.has('concurrent:foreign')).toBe(true);
    expect(fixture.keys.has('amp:ctx:3333333333333333')).toBe(true);
  });

  it.each([
    ['missing peer', () => redisCleanupFixture(), (f: ReturnType<typeof redisCleanupFixture>) => f.keys.delete(redisOwned.defaultScope)],
    ['multiple members', () => redisCleanupFixture(), (f: ReturnType<typeof redisCleanupFixture>) => f.sets.set(redisOwned.defaultNode, [redisOwned.defaultContext, 'amp:ctx:4444444444444444'])],
    ['mismatched members', () => redisCleanupFixture(), (f: ReturnType<typeof redisCleanupFixture>) => f.sets.set(redisOwned.defaultScope, ['amp:ctx:4444444444444444'])],
    ['duplicate cross-channel context', () => redisCleanupFixture(), (f: ReturnType<typeof redisCleanupFixture>) => {
      f.sets.set(redisOwned.namedNode, [redisOwned.defaultContext]); f.sets.set(redisOwned.namedScope, [redisOwned.defaultContext]);
    }],
    ['wrong tenant namespace', () => redisCleanupFixture(), (f: ReturnType<typeof redisCleanupFixture>) => {
      f.sets.set(redisOwned.defaultNode, [redisOwned.namedContext]); f.sets.set(redisOwned.defaultScope, [redisOwned.namedContext]);
    }],
    ['malformed context namespace', () => redisCleanupFixture(), (f: ReturnType<typeof redisCleanupFixture>) => {
      const malformed = 'amp:ctx:333333333333333';
      f.keys.add(malformed); f.values.set(malformed, cacheJson(`ret001d-ds-${redisRun}`));
      f.sets.set(redisOwned.defaultNode, [malformed]); f.sets.set(redisOwned.defaultScope, [malformed]);
    }],
    ['malformed cache', () => redisCleanupFixture(), (f: ReturnType<typeof redisCleanupFixture>) => f.values.set(redisOwned.defaultContext, '{')],
    ['oversized cache', () => redisCleanupFixture(), (f: ReturnType<typeof redisCleanupFixture>) => f.values.set(redisOwned.defaultContext, 'x'.repeat(1_048_577))],
    ['wrong source', () => redisCleanupFixture(), (f: ReturnType<typeof redisCleanupFixture>) => f.values.set(redisOwned.defaultContext, cacheJson('foreign-source'))],
  ])('rejects %s ownership proof without deleting the questionable artifacts', async (_label, create, mutate) => {
    const fixture = create();
    mutate(fixture);
    await expect(cleanupOwnedRedisKeys(
      fixture.redis as never, new Set(['baseline']), redisRun, redisToken, 1_000,
    )).rejects.toThrow('RET001D_REDIS_OWNERSHIP_INVALID');
    expect(fixture.keys.has(redisOwned.defaultNode)).toBe(true);
    expect(fixture.keys.has(redisOwned.defaultContext)).toBe(true);
    expect(fixture.deleted).toContain(redisOwned.marker);
  });

  it('rejects hostile dependency arrays without invoking their traps', async () => {
    const fixture = redisCleanupFixture();
    let traps = 0;
    fixture.sets.set(redisOwned.defaultNode, new Proxy([redisOwned.defaultContext], {
      get(target, property, receiver) {
        if (property === 'then') return undefined;
        traps++;
        throw new Error('secret trap');
      },
    }));
    await expect(cleanupOwnedRedisKeys(
      fixture.redis as never, new Set(['baseline']), redisRun, redisToken, 1_000,
    )).rejects.toThrow('RET001D_REDIS_OWNERSHIP_INVALID');
    expect(traps).toBe(0);
    expect(fixture.deleted).toContain(redisOwned.marker);
  });

  it('returns incomplete cardinality while deleting only independently proven partial execution keys', async () => {
    const fixture = redisCleanupFixture();
    for (const key of [redisOwned.namedContext, redisOwned.namedNode, redisOwned.namedScope]) fixture.keys.delete(key);
    await expect(cleanupOwnedRedisKeys(
      fixture.redis as never, new Set(['baseline']), redisRun, redisToken, 1_000,
    )).resolves.toEqual({ ownedCreated: 4, ownedRemaining: 0, unexpectedNewKeys: 0 });
    expect(new Set(fixture.deleted)).toEqual(new Set([
      redisOwned.marker, redisOwned.defaultContext, redisOwned.defaultNode, redisOwned.defaultScope,
    ]));
    const source = await readFile(fileURLToPath(new URL('../live-conformance.ts', import.meta.url)), 'utf8');
    expect(source).toContain('redisResidual.ownedCreated !== 7');
  });

  it('atomically deletes exactly one key for a marker-only partial execution', async () => {
    const fixture = redisCleanupFixture();
    for (const key of [
      redisOwned.defaultContext, redisOwned.defaultNode, redisOwned.defaultScope,
      redisOwned.namedContext, redisOwned.namedNode, redisOwned.namedScope,
    ]) fixture.keys.delete(key);
    await expect(cleanupOwnedRedisKeys(
      fixture.redis as never, new Set(['baseline']), redisRun, redisToken, 1_000,
    )).resolves.toEqual({ ownedCreated: 1, ownedRemaining: 0, unexpectedNewKeys: 0 });
    expect(fixture.deleted).toEqual([redisOwned.marker]);
    expect(fixture.redis.eval.mock.calls[0]![1]).toBe(1);
  });

  it('keeps both ambiguous triples out of Lua arguments', async () => {
    const fixture = redisCleanupFixture();
    fixture.sets.set(redisOwned.namedNode, [redisOwned.defaultContext]);
    fixture.sets.set(redisOwned.namedScope, [redisOwned.defaultContext]);
    await expect(cleanupOwnedRedisKeys(
      fixture.redis as never, new Set(['baseline']), redisRun, redisToken, 1_000,
    )).rejects.toThrow('RET001D_REDIS_OWNERSHIP_INVALID');
    expect(fixture.redis.eval.mock.calls[0]![1]).toBe(1);
    expect(fixture.deleted).toEqual([redisOwned.marker]);
    for (const key of [
      redisOwned.defaultContext, redisOwned.defaultNode, redisOwned.defaultScope,
      redisOwned.namedContext, redisOwned.namedNode, redisOwned.namedScope,
    ]) expect(fixture.keys.has(key)).toBe(true);
  });

  it.each([
    ['marker replacement', (f: ReturnType<typeof redisCleanupFixture>) => f.values.set(redisOwned.marker, 'b'.repeat(32))],
    ['node set replacement', (f: ReturnType<typeof redisCleanupFixture>) => f.sets.set(redisOwned.defaultNode, ['amp:ctx:4444444444444444'])],
    ['scope set replacement', (f: ReturnType<typeof redisCleanupFixture>) => f.sets.set(redisOwned.defaultScope, ['amp:ctx:4444444444444444'])],
    ['context replacement', (f: ReturnType<typeof redisCleanupFixture>) => f.values.set(redisOwned.defaultContext, cacheJson('replacement'))],
    ['node type replacement', (f: ReturnType<typeof redisCleanupFixture>) => {
      f.sets.delete(redisOwned.defaultNode); f.values.set(redisOwned.defaultNode, 'replacement');
    }],
    ['context type replacement', (f: ReturnType<typeof redisCleanupFixture>) => {
      f.values.delete(redisOwned.defaultContext); f.sets.set(redisOwned.defaultContext, ['replacement']);
    }],
  ])('atomically deletes zero keys on %s before EVAL', async (_label, replace) => {
    const fixture = redisCleanupFixture();
    fixture.setBeforeEval(() => replace(fixture));
    await expect(cleanupOwnedRedisKeys(
      fixture.redis as never, new Set(['baseline']), redisRun, redisToken, 1_000,
    )).rejects.toThrow('RET001D_REDIS_OWNERSHIP_INVALID');
    expect(fixture.deleted).toEqual([]);
    expect(fixture.keys).toEqual(new Set(['baseline', ...Object.values(redisOwned)]));
  });

  it('rejects duplicate KEYS inside the Lua boundary with a dedicated code and zero deletion', async () => {
    const capture = redisCleanupFixture();
    await cleanupOwnedRedisKeys(
      capture.redis as never, new Set(['baseline']), redisRun, redisToken, 1_000,
    );
    const script = capture.redis.eval.mock.calls[0]![0];

    const fixture = redisCleanupFixture();
    fixture.sets.set(redisOwned.namedNode, [redisOwned.defaultContext]);
    fixture.sets.set(redisOwned.namedScope, [redisOwned.defaultContext]);
    const before = new Set(fixture.keys);
    const result = await fixture.redis.eval(
      script,
      7,
      redisOwned.marker,
      redisOwned.defaultContext, redisOwned.defaultNode, redisOwned.defaultScope,
      redisOwned.defaultContext, redisOwned.namedNode, redisOwned.namedScope,
      redisToken,
      cacheJson(`ret001d-ds-${redisRun}`), cacheJson(`ret001d-ds-${redisRun}`),
    );
    expect(result).toBe(-13);
    expect(fixture.deleted).toEqual([]);
    expect(fixture.keys).toEqual(before);
  });

  it('fails closed with zero deletion on EVAL error', async () => {
    const fixture = redisCleanupFixture();
    fixture.redis.eval.mockRejectedValueOnce(new Error('eval failed'));
    await expect(cleanupOwnedRedisKeys(
      fixture.redis as never, new Set(['baseline']), redisRun, redisToken, 1_000,
    )).rejects.toThrow('RET001D_REDIS_CLEANUP_FAILED');
    expect(fixture.deleted).toEqual([]);
  });

  it.each([-1, 0, 6, 8, '7', null, {}, []])(
    'rejects malformed or inexact EVAL result %# with zero deletion', async (result) => {
      const fixture = redisCleanupFixture();
      fixture.redis.eval.mockResolvedValueOnce(result);
      await expect(cleanupOwnedRedisKeys(
        fixture.redis as never, new Set(['baseline']), redisRun, redisToken, 1_000,
      )).rejects.toThrow('RET001D_REDIS_OWNERSHIP_INVALID');
      expect(fixture.deleted).toEqual([]);
    },
  );

  it('requires exact EVAL count even when a fake reports success without deleting', async () => {
    const fixture = redisCleanupFixture();
    fixture.redis.eval.mockResolvedValueOnce(7);
    await expect(cleanupOwnedRedisKeys(
      fixture.redis as never, new Set(['baseline']), redisRun, redisToken, 1_000,
    )).resolves.toEqual({ ownedCreated: 7, ownedRemaining: 7, unexpectedNewKeys: 0 });
  });

  it('reduces arbitrary fixture/query failures to closed content-free diagnostics', () => {
    const fixture = 'RET001D secret fixture/query body';
    expect(safeDiagnosticCode(new Error(fixture))).toBe('RET001D_INTERNAL_FAILURE');
    expect(safeDiagnosticCode(new Error('RET001D_MCP_TIMEOUT'))).toBe('RET001D_MCP_TIMEOUT');
    expect(safeDiagnosticCode(new AggregateError([new Error(fixture)], fixture))).not.toContain(fixture);
  });

  it.each([
    ['message accessor', () => Object.defineProperty(Object.create(Error.prototype), 'message', {
      get() { throw new Error('RET001D_SECRET_FIXTURE'); },
    })],
    ['error proxy', () => new Proxy(new Error('RET001D_MCP_TIMEOUT'), {
      get() { throw new Error('RET001D_SECRET_FIXTURE'); },
      getOwnPropertyDescriptor() { throw new Error('RET001D_SECRET_FIXTURE'); },
    })],
    ['revoked error proxy', () => {
      const pair = Proxy.revocable(new Error('RET001D_MCP_TIMEOUT'), {});
      pair.revoke();
      return pair.proxy;
    }],
  ] as const)('never throws or reflects a hostile diagnostic %s', (_label, createError) => {
    let code: string | undefined;
    expect(() => { code = safeDiagnosticCode(createError()); }).not.toThrow();
    expect(code).toBe('RET001D_INTERNAL_FAILURE');
    expect(code).not.toContain('SECRET_FIXTURE');
  });

  it.each([
    'RET001D_SECRET_FIXTURE',
    `RET001D_${'A'.repeat(300)}`,
    'RET001D_MCP_HTTP_99',
    'RET001D_MCP_HTTP_600',
    'RET001D_MCP_HTTP_4O4',
    'RET001D_CASE_UNKNOWN_STAGE_ORDINARY_CALL',
    'RET001D_CASE_DETERMINISTIC_STAGE_UNKNOWN',
    'RET001D_CASE_DETERMINISTIC_STAGE_ORDINARY_CALL_SEEDED_NONE_E0_A0_P0_O0_T0',
    'RET001D_CASE_DETERMINISTIC_STAGE_ORDINARY_PRESENTATION_SEEDED_UNKNOWN_E0_A0_P0_O0_T0',
    'RET001D_CASE_DETERMINISTIC_STAGE_ORDINARY_PRESENTATION_SEEDED_NONE_E0_A0_P0_O513_T513',
    'RET001D_CASE_DETERMINISTIC_STAGE_ORDINARY_PRESENTATION_SEEDED_NONE_E0_A0_P0_O1_T0',
    'RET001D_READINESS_TIMEOUT__RET001D_SECRET_FIXTURE',
  ])('rejects unknown or malformed diagnostic code %s', (code) => {
    expect(safeDiagnosticCode(new Error(code))).toBe('RET001D_INTERNAL_FAILURE');
  });

  it.each([
    'RET001D_CASE_STAGE_DIAGNOSTIC_INVALID',
    'RET001D_CLEANUP_OR_CASE_COUNT_INVALID',
    'RET001D_COMPOSITION_ROOT_EXITED',
    'RET001D_COMPOSITION_ROOT_STOP_TIMEOUT',
    'RET001D_EVIDENCE_FAILED',
    'RET001D_EVIDENCE_WRITE_FAILED',
    'RET001D_EVIDENCE_WRITE_TIMEOUT',
    'RET001D_FALSE_PARITY_MISMATCH',
    'RET001D_GIT_DIRTY',
    'RET001D_GIT_STATE_FAILED',
    'RET001D_HTTP_BODY_ABORTED',
    'RET001D_HTTP_BODY_READ_FAILED',
    'RET001D_HTTP_BODY_TOO_LARGE',
    'RET001D_INTERNAL_FAILURE',
    'RET001D_MANIFEST_FORBIDDEN_VALUE',
    'RET001D_MCP_CORRELATION_INVALID',
    'RET001D_MCP_ENVELOPE_INVALID',
    'RET001D_MCP_INITIALIZE_INVALID',
    'RET001D_MCP_NETWORK',
    'RET001D_MCP_RPC_ERROR',
    'RET001D_MCP_TIMEOUT',
    'RET001D_MCP_TOOL_RESPONSE_INVALID',
    'RET001D_NEO4J_CLEANUP_FAILED',
    'RET001D_NEO4J_CLOSE_FAILED',
    'RET001D_NEO4J_PREFLIGHT_FAILED',
    'RET001D_NEO4J_RESIDUAL_INVALID',
    'RET001D_NEO4J_RESIDUAL_QUERY_FAILED',
    'RET001D_NEO4J_SEED_FAILED',
    'RET001D_NEO4J_SEED_READBACK_CARDINALITY',
    'RET001D_NEO4J_SEED_READBACK_FAILED',
    'RET001D_NEO4J_SEED_READBACK_INVALID',
    'RET001D_NEO4J_SEED_READBACK_MISMATCH',
    'RET001D_NEO4J_SESSION_CLOSE_FAILED',
    'RET001D_NEO4J_VERSION_FAILED',
    'RET001D_NEO4J_VERSION_INVALID',
    'RET001D_READINESS_INVALID',
    'RET001D_READINESS_NETWORK',
    'RET001D_READINESS_TIMEOUT__RET001D_READINESS_NETWORK',
    'RET001D_READINESS_UNKNOWN',
    'RET001D_RANKED_MARKER_INVALID',
    'RET001D_REDIS_CLEANUP_FAILED',
    'RET001D_REDIS_KEY_BOUND',
    'RET001D_REDIS_OWNERSHIP_FAILED',
    'RET001D_REDIS_OWNERSHIP_INVALID',
    'RET001D_REDIS_PREFLIGHT_FAILED',
    'RET001D_REDIS_SCAN_FAILED',
    'RET001D_REDIS_VERSION_FAILED',
    'RET001D_REDIS_VERSION_INVALID',
    'RET001D_SEEDED_DIAGNOSTIC_BOUND',
    'RET001D_SEEDED_DIAGNOSTIC_INVALID',
    'RET001D_SEEDED_RESULT_MISSING',
    'RET001D_SERVICE_IDENTITY_MISSING',
    'RET001D_TEMP_CREATE_FAILED',
    'RET001D_TENANT_ISOLATION_FAILURE',
    'RET001D_TRACE_BLOCK_COUNT',
    'RET001D_TRACED_PARITY_MISMATCH',
    'RET010D_CASE_STAGE_DIAGNOSTIC_INVALID',
    'RET010D_CHILD_PROFILE_INVALID',
    'RET010D_DETERMINISTIC_BYPASS_MISMATCH',
    'RET010D_MANIFEST_KEYS',
    'RET010D_MANIFEST_SHAPE',
    'RET010D_MATCHED_CONTROL_UNCHANGED',
    'RET010D_NEO4J_SEED_FAILED',
    'RET010D_NEO4J_SESSION_CLOSE_FAILED',
  ])('accepts legitimate static runner diagnostic %s', (code) => {
    expect(safeDiagnosticCode(new Error(code))).toBe(code);
  });

  it.each(['100', '200', '404', '599'])('accepts bounded MCP HTTP diagnostic %s', (status) => {
    const code = `RET001D_MCP_HTTP_${status}`;
    expect(safeDiagnosticCode(new Error(code))).toBe(code);
  });

  it.each([
    ['expected', 1, 0, 0, 511, 512],
    ['alternate', 0, 1, 0, 511, 512],
    ['project-only', 0, 0, 1, 511, 512],
    ['none', 0, 0, 0, 512, 512],
  ] as const)('accepts legitimate seeded dynamic family %s', (
    classification, expectedCount, alternateCount, projectCount, otherCount, totalCount,
  ) => {
    const code = seededMissingDiagnosticCode('named-tenant-forced-ranked', {
      classification, expectedCount, alternateCount, projectCount, otherCount, totalCount,
    });
    expect(safeDiagnosticCode(new Error(code))).toBe(code);
  });

  it('times out readiness deterministically and never retries structural failures', async () => {
    let now = 0;
    const sleep = vi.fn(async () => { now += 250; });
    await expect(waitForTraceReadiness(
      async () => { throw new Error('RET001D_READINESS_NETWORK'); },
      500,
      { now: () => now, sleep },
    )).rejects.toThrow('RET001D_READINESS_TIMEOUT__RET001D_READINESS_NETWORK');
    expect(sleep).toHaveBeenCalledTimes(2);
    await expect(waitForTraceReadiness(
      async () => { throw new Error('RET001D_READINESS_INVALID'); },
      500,
      { now: () => 0, sleep },
    )).rejects.toThrow('RET001D_READINESS_INVALID');
  });

  it('accepts only the exact named-tenant degradation class, never an arbitrary 503', () => {
    const limitation = 'shared logical multi-tenant consolidation and wiki publication are disabled to prevent cross-tenant disclosure';
    const body = {
      status: 'ready',
      service: 'memberry-mcp',
      transport: 'sse',
      active_sessions: 0,
      registered_sessions: 0,
      auth_required: true,
      uptime_ms: 12,
      admission_shadow: {},
      retrieval_resolution: retrievalResolutionStatus(),
      consolidation_automation: {
        enabled: false,
        unhealthy: true,
        degraded: true,
        limitations: [`default: ${limitation}; provider unavailable`],
        workers: [{ name: 'default', enabled: false, health: 'unhealthy', limitation }],
      },
    };
    expect(classifyTraceReadiness(503, body, 'named-tenant')).toEqual({
      status: 503,
      classification: 'expected-logical-multitenant-degraded',
    });
    expect(() => classifyTraceReadiness(503, { status: 'unhealthy' }, 'named-tenant'))
      .toThrow('RET001D_READINESS_INVALID');
    expect(() => classifyTraceReadiness(200, body, 'named-tenant'))
      .toThrow('RET001D_READINESS_INVALID');

    // D1/A6 datastore-probe fields ride on the same 503 body once a probe source is registered.
    const probed = {
      ...body,
      datastores: { neo4j: 'ok', redis: 'ok' },
      embeddings: 'disabled',
      degraded: ['embeddings: disabled (no OPENAI_API_KEY) - lexical/fulltext retrieval only'],
      lifecycle: { mode: 'disabled', last_run_at: null, last_result: 'never' },
    };
    expect(classifyTraceReadiness(503, probed, 'named-tenant')).toEqual({
      status: 503,
      classification: 'expected-logical-multitenant-degraded',
    });
    expect(() => classifyTraceReadiness(503, { ...body, lifecycle: probed.lifecycle }, 'named-tenant'))
      .toThrow('RET001D_READINESS_INVALID');
    expect(() => classifyTraceReadiness(
      503, { ...probed, datastores: { neo4j: 'unreachable', redis: 'ok' } }, 'named-tenant',
    )).toThrow('RET001D_READINESS_INVALID');

    for (const invalid of [
      { ...body, retrieval_resolution: undefined },
      { ...body, retrieval_resolution: { ...retrievalResolutionStatus(), extra: true } },
      {
        ...body,
        retrieval_resolution: {
          ...retrievalResolutionStatus(),
          resolution: { ...retrievalResolutionStatus().resolution, resolved: -1 },
        },
      },
      {
        ...body,
        retrieval_resolution: {
          ...retrievalResolutionStatus(),
          calls: { ...retrievalResolutionStatus().calls, total: 1 },
        },
      },
    ]) {
      expect(() => classifyTraceReadiness(503, invalid, 'named-tenant'))
        .toThrow('RET001D_READINESS_INVALID');
    }
  });

  it('wires the trace runner into package scripts, CI, and a fixed live registry entry', async () => {
    const [pkg, workflow, systems, validator] = await Promise.all([
      readFile(fileURLToPath(new URL('../../../../package.json', import.meta.url)), 'utf8'),
      readFile(fileURLToPath(new URL('../../../../.github/workflows/ci.yml', import.meta.url)), 'utf8'),
      readFile(fileURLToPath(new URL('../../registry/systems.json', import.meta.url)), 'utf8'),
      readFile(fileURLToPath(new URL('../../registry/validate.ts', import.meta.url)), 'utf8'),
    ]);
    expect(pkg).toContain('"bench:lab:retrieval-trace:live"');
    expect(workflow).toContain('Retrieval trace live conformance evidence');
    expect(workflow).toContain('memberry-retrieval-trace-live-conformance-');
    expect(workflow).toContain('Capture exact service container identities');
    expect(workflow).toContain("docker inspect --format='{{.Image}}'");
    expect(workflow).toContain('MEMBERRY_TRACE_LIVE_REDIS_IMAGE_ID');
    expect(workflow).toContain('MEMBERRY_TRACE_LIVE_NEO4J_IMAGE_ID');
    expect(systems).toContain('memberry-retrieval-trace-live-conformance-v1');
    expect(validator).toContain("system.contract === 'retrieval-trace-live-conformance-v1'");
  });

  it('binds ranked fixture markers to the actual architecture fulltext index fields, never entity name', async () => {
    const schema = await readFile(
      fileURLToPath(new URL('../../../../packages/arch/src/schema.ts', import.meta.url)), 'utf8',
    );
    expect(schema).toContain(
      "ON EACH [e.responsibility, e.interface_desc, e.internals]",
    );
    expect(schema).not.toMatch(/entity_arch_content[^\n]+e\.name/);
  });

  it('rejects relabeled or redirected trace conformance registrations', async () => {
    const registry = JSON.parse(await readFile(
      fileURLToPath(new URL('../../registry/systems.json', import.meta.url)), 'utf8',
    )) as { systems: Array<Record<string, unknown>> };
    const system = registry.systems.find(({ id }) => id === 'memberry-retrieval-trace-live-conformance-v1')!;
    system.mode = 'fixture';
    system.fidelityDetail = 'production-core / fixture-persistence';
    system.adapter = 'bench/lab/adapters/memberry-live.ts';
    const errors = validateSystemRegistry(registry);
    expect(errors.some((error) => error.includes('must use live fidelity'))).toBe(true);
    expect(errors.some((error) => error.includes('composition-root / live-disposable-persistence'))).toBe(true);
    expect(errors.some((error) => error.includes('adapter path is fixed'))).toBe(true);
  });
});
