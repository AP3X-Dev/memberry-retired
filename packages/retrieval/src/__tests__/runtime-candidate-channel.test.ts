import { describe, expect, it, vi } from 'vitest';
import { Record as Neo4jRecord } from 'neo4j-driver';

import { canonicalTraceJson, RETRIEVAL_TRACE_CHANNEL_ORDER } from '../trace.js';
import { resolveRuntimeQueryPlannerAuthorityV1 } from '../runtime-query-planner.js';
import {
  RuntimeCandidateChannelService,
  type RuntimeCandidateDriver,
} from '../runtime-candidate-channel.js';
import { UnifiedAssembler } from '../assembler.js';

const project = 'project:memberry';
const entityId = 'entity-memberry';

function record(keys: string[], values: unknown[]): Neo4jRecord {
  return new Neo4jRecord(keys, values, Object.fromEntries(keys.map((key, index) => [key, index])));
}

async function authorityReceipt(asOf?: string) {
  return resolveRuntimeQueryPlannerAuthorityV1({
    authenticated: true,
    plannerEnabled: true,
    tenantId: 'tenant-a',
    projectName: project,
    entityScope: ['memberry'],
    ...(asOf === undefined ? {} : { asOf }),
    resolverFactory: () => ({ resolve: async () => ({
      resolution: { state: 'resolved', canonicalEntityIds: [entityId] }, diagnostics: [],
    }) }),
  });
}

function driver(rows: Record<string, Neo4jRecord[]>): { driver: RuntimeCandidateDriver; calls: Array<[string, Record<string, unknown>]> } {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const run = async (query: string, params: Record<string, unknown>) => {
    calls.push([query, params]);
    if (query.includes('UNWIND $ids AS eid')) {
      const facts = (rows.fact ?? []).map((source) => ({ properties: {
        id: source.get('evidenceId'), subject: 'subject', predicate: 'predicate', object: 'object',
        entity_id: entityId, source_episode_ids: [], valid_at: '2026-01-01T00:00:00.000Z', invalid_at: null,
        confidence: source.get('score'), status: 'active', inference_type: 'deductive', supersedes_fact_id: null,
        scope: 'project', tags: [project], tenant_id: 'tenant-a', created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      } }));
      return { records: [record(['ordinal', 'eid', 'facts'], ['0', entityId, facts])] };
    }
    const kind = query.includes('MATCH (s:Semantic)') ? 'scope' : 'arch';
    return { records: rows[kind] ?? [] };
  };
  const session = {
    run,
    beginTransaction: vi.fn(() => ({ run, commit: vi.fn(async () => undefined), rollback: vi.fn(async () => undefined) })),
    close: vi.fn(async () => undefined),
  };
  return { driver: { session: vi.fn(() => session) }, calls };
}

function validRows(): Record<string, Neo4jRecord[]> {
  return {
    scope: [record(
      ['tenantId', 'projectScope', 'resolvedEntityId', 'evidenceId', 'title', 'content', 'score'],
      ['tenant-a', project, entityId, 'semantic-1', 'Semantic', 'Scoped memory', 0.9],
    )],
    fact: [record(
      ['tenantId', 'projectScope', 'resolvedEntityId', 'evidenceId', 'title', 'content', 'score'],
      ['tenant-a', project, entityId, 'fact-1', 'Fact', 'subject predicate object', 0.8],
    )],
    arch: [record(
      ['tenantId', 'projectScope', 'resolvedEntityId', 'evidenceId', 'title', 'content', 'score'],
      ['tenant-a', project, entityId, entityId, 'Entity', 'Architecture entity', 1],
    )],
  };
}

describe('RET-003B runtime candidate channel service', () => {
  it('does not mint authority from a caller-controlled bare object', async () => {
    const mock = driver(validRows());
    const service = new RuntimeCandidateChannelService(mock.driver);
    await expect(service.execute({ contract: 'memberry.runtime-query-planner-resolved-receipt.v1' } as never, {
      includeArchitecture: true, includeMemory: true,
    })).rejects.toThrow('candidate_runtime:invalid_receipt');
    expect(mock.driver.session).not.toHaveBeenCalled();
  });

  it('binds a private receipt and runs only the three authorized channels in canonical order', async () => {
    const mock = driver(validRows());
    const service = new RuntimeCandidateChannelService(mock.driver);
    const receipt = await authorityReceipt();
    const result = await service.execute(receipt, { includeArchitecture: true, includeMemory: true });

    expect(result.settlements.map((item) => item.channel)).toEqual(RETRIEVAL_TRACE_CHANNEL_ORDER);
    expect(result.settlements.filter((item) => item.outcome === 'success').map((item) => item.channel))
      .toEqual(['memory.scope', 'memory.fact', 'arch.entity']);
    expect(result.candidates.map((item) => item.evidenceId))
      .toEqual(['semantic-1', 'fact-1', entityId]);
    expect(mock.calls).toHaveLength(3);
    for (const [query, params] of mock.calls) {
      if (query.includes('UNWIND $ids AS eid')) expect(params).toMatchObject({ tenantId: 'tenant-a', ids: [entityId] });
      else expect(params).toMatchObject({ tenantId: 'tenant-a', projectScope: project, entityId });
    }
  });

  it('rejects an unissued or foreign-service receipt before opening a session', async () => {
    const first = driver(validRows());
    const service = new RuntimeCandidateChannelService(first.driver);
    const foreign = Object.freeze({ contract: 'memberry.runtime-query-planner-resolved-receipt.v1' });
    await expect(service.execute(foreign as never, {
      includeArchitecture: true, includeMemory: true,
    })).rejects.toThrow('candidate_runtime:invalid_receipt');
    expect(first.driver.session).not.toHaveBeenCalled();
  });

  it('discards a substituted authority row while successful siblings survive', async () => {
    const rows = validRows();
    rows.scope![0] = record(
      ['tenantId', 'projectScope', 'resolvedEntityId', 'evidenceId', 'title', 'content', 'score'],
      ['tenant-foreign', project, entityId, 'foreign-secret', 'Secret', 'DO NOT RETURN', 1],
    );
    const mock = driver(rows);
    const service = new RuntimeCandidateChannelService(mock.driver);
    const receipt = await authorityReceipt();
    const result = await service.execute(receipt, { includeArchitecture: true, includeMemory: true });
    expect(result.settlements.find((item) => item.channel === 'memory.scope'))
      .toMatchObject({ outcome: 'safe-failure', code: 'query-failed' });
    expect(JSON.stringify(result)).not.toContain('foreign-secret');
    expect(result.candidates.map((item) => item.evidenceId)).toEqual(['fact-1', entityId]);
  });

  it('binds current and as-of temporal authority into every source query', async () => {
    const mock = driver(validRows());
    const service = new RuntimeCandidateChannelService(mock.driver);
    const receipt = await authorityReceipt('2026-08-16T10:20:30.000Z');
    await service.execute(receipt, { includeArchitecture: true, includeMemory: true });
    expect(mock.calls.find(([query]) => query.includes('MATCH (s:Semantic)'))?.[1].asOf)
      .toBe('2026-08-16T10:20:30.000Z');
    expect(mock.calls.find(([query]) => query.includes('UNWIND $ids AS eid'))?.[1].as_of)
      .toBe('2026-08-16T10:20:30.000Z');
    expect(mock.calls.find(([query]) => query.includes('arch.entity') || query.includes('target.id AS evidenceId'))?.[0])
      .not.toContain('$asOf');
  });

  it('accepts the exact per-source row cap without truncating it', async () => {
    const rows = validRows();
    rows.scope = Array.from({ length: 64 }, (_, index) => record(
      ['tenantId', 'projectScope', 'resolvedEntityId', 'evidenceId', 'title', 'content', 'score'],
      ['tenant-a', project, entityId, `semantic-${String(index).padStart(2, '0')}`, 'Semantic', `Scoped memory ${index}`, 1 - index / 100],
    ));
    const mock = driver(rows);
    const service = new RuntimeCandidateChannelService(mock.driver);
    const receipt = await authorityReceipt();
    const result = await service.execute(receipt, { includeArchitecture: false, includeMemory: true });
    expect(result.settlements.find((item) => item.channel === 'memory.scope'))
      .toMatchObject({ outcome: 'success', candidateCount: 64 });
    expect(result.candidates.filter((item) => item.channel === 'memory.scope')).toHaveLength(64);
  });

  it('uses production FactScope semantics instead of treating the project tag as Fact.scope', async () => {
    const mock = driver(validRows());
    const service = new RuntimeCandidateChannelService(mock.driver);
    const receipt = await authorityReceipt();
    await service.execute(receipt, { includeArchitecture: false, includeMemory: true });
    const factQuery = mock.calls.find(([query]) => query.includes('UNWIND $ids AS eid'))?.[0] ?? '';
    expect(factQuery).not.toContain('f.scope = $projectScope');
  });

  it('lets a later higher-confidence channel win a one-item token budget', async () => {
    const rows = validRows();
    rows.scope![0] = record(
      ['tenantId', 'projectScope', 'resolvedEntityId', 'evidenceId', 'title', 'content', 'score'],
      ['tenant-a', project, entityId, 'semantic-low', 'Semantic', 'x'.repeat(40), 0.01],
    );
    rows.fact![0] = record(
      ['tenantId', 'projectScope', 'resolvedEntityId', 'evidenceId', 'title', 'content', 'score'],
      ['tenant-a', project, entityId, 'fact-high', 'Fact', 'y'.repeat(40), 1],
    );
    const mock = driver(rows);
    const service = new RuntimeCandidateChannelService(mock.driver);
    const receipt = await authorityReceipt();
    const execution = await service.execute(receipt, { includeArchitecture: false, includeMemory: true });
    const assembler = Object.create(UnifiedAssembler.prototype) as UnifiedAssembler;
    const result = assembler.assembleCandidateExecution('task', execution, 10, false, true);
    expect(result.context.sections.flatMap((section) => section.items).map((item) => item.id)).toEqual(['fact-high']);
  });

  it('does not invoke excluded real sources and leaves all other channels unavailable', async () => {
    const mock = driver(validRows());
    const service = new RuntimeCandidateChannelService(mock.driver);
    const receipt = await authorityReceipt();
    const result = await service.execute(receipt, { includeArchitecture: false, includeMemory: false });
    expect(mock.driver.session).not.toHaveBeenCalled();
    expect(result.candidates).toEqual([]);
    expect(result.settlements).toHaveLength(15);
    expect(result.settlements.every((item) => item.outcome === 'safe-failure' && item.code === 'unavailable')).toBe(true);
  });

  it('rejects hostile or unissued receipt roots with zero hooks and zero sessions', async () => {
    const mock = driver(validRows());
    const service = new RuntimeCandidateChannelService(mock.driver);
    const hooks = vi.fn();
    const accessor = { contract: 'memberry.runtime-query-planner-resolved-receipt.v1' };
    Object.defineProperty(accessor, 'contract', { enumerable: true, get: () => { hooks(); return 'x'; } });
    const revoked = Proxy.revocable(accessor, {}); revoked.revoke();
    for (const input of [accessor, revoked.proxy, { contract: 'memberry.runtime-query-planner-resolved-receipt.v1' }]) {
      await expect(service.execute(input as never, { includeArchitecture: true, includeMemory: true }))
        .rejects.toThrow('candidate_runtime:invalid_receipt');
    }
    expect(hooks).not.toHaveBeenCalled();
    expect(mock.driver.session).not.toHaveBeenCalled();
  });

  it('discards a records proxy and an N+1 channel without suppressing valid siblings', async () => {
    const hooks = vi.fn();
    const rows = validRows();
    const calls: string[] = [];
    const run = async (query: string) => {
      calls.push(query);
      if (query.includes('UNWIND $ids AS eid')) return {
        records: [record(['ordinal', 'eid', 'facts'], ['0', entityId, Array.from({ length: 65 }, () => ({ properties: {} }))])],
      };
      if (query.includes('MATCH (s:Semantic)')) return { records: new Proxy([], { get: () => { hooks(); return undefined; } }) };
      return { records: rows.arch };
    };
    const session = {
      run,
      beginTransaction: vi.fn(() => ({ run, commit: vi.fn(async () => undefined), rollback: vi.fn(async () => undefined) })),
      close: vi.fn(async () => undefined),
    };
    const service = new RuntimeCandidateChannelService({ session: vi.fn(() => session) });
    const receipt = await authorityReceipt();
    const result = await service.execute(receipt, { includeArchitecture: true, includeMemory: true });
    expect(hooks).not.toHaveBeenCalled();
    expect(result.candidates.map((item) => item.evidenceId)).toEqual([entityId]);
    expect(result.settlements.filter((item) => item.outcome === 'safe-failure' && item.code === 'query-failed'))
      .toHaveLength(1);
    expect(result.settlements).toContainEqual(expect.objectContaining({
      channel: 'memory.fact', outcome: 'safe-failure', code: 'budget-exceeded',
    }));
    const assembler = Object.create(UnifiedAssembler.prototype) as UnifiedAssembler;
    const composed = assembler.assembleCandidateExecution('task', result, 8_000, true, true, true);
    expect(composed.trace!.incompleteReasons).toEqual(expect.arrayContaining(['limit-overflow', 'channel-gap']));
    expect(composed.trace!.events.filter((event) => event.kind === 'channel-terminal'
      && event.channel === 'memory.fact')).toHaveLength(0);
  });

  it('cancels a timed-out transaction before bounded close and ignores late settlement', async () => {
    vi.useFakeTimers();
    try {
      let resolveLate!: (value: unknown) => void;
      const rollback = vi.fn(async () => undefined);
      const close = vi.fn(async () => undefined);
      const run = vi.fn(() => new Promise((resolve) => { resolveLate = resolve; }));
      const service = new RuntimeCandidateChannelService({ session: vi.fn(() => ({
        run: vi.fn(), beginTransaction: () => ({ run, commit: vi.fn(), rollback }), close,
      } as never)) });
      const receipt = await authorityReceipt();
      const pending = service.execute(receipt, { includeArchitecture: true, includeMemory: false });
      await vi.advanceTimersByTimeAsync(2_001);
      const result = await pending;
      const before = JSON.stringify(result);
      expect(rollback).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      resolveLate({ records: validRows().arch });
      await vi.runAllTimersAsync();
      expect(JSON.stringify(result)).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps cross-channel identical evidence IDs distinct in context and trace output truth', async () => {
    const rows = validRows();
    rows.scope![0] = record(
      ['tenantId', 'projectScope', 'resolvedEntityId', 'evidenceId', 'title', 'content', 'score'],
      ['tenant-a', project, entityId, 'shared-id', 'Semantic', 'short', 1],
    );
    rows.fact![0] = record(
      ['tenantId', 'projectScope', 'resolvedEntityId', 'evidenceId', 'title', 'content', 'score'],
      ['tenant-a', project, entityId, 'shared-id', 'Fact', 'z'.repeat(80), 0.5],
    );
    const mock = driver(rows);
    const service = new RuntimeCandidateChannelService(mock.driver);
    const receipt = await authorityReceipt();
    const execution = await service.execute(receipt, { includeArchitecture: false, includeMemory: true });
    const assembler = Object.create(UnifiedAssembler.prototype) as UnifiedAssembler;
    const result = assembler.assembleCandidateExecution('Identifier_Name?', execution, 2, false, true, true);
    const trace = result.trace!;
    const outputs = trace.events.filter((event) => event.kind === 'ranked-output');
    const items = result.context.sections.flatMap((section) => section.items);
    expect(outputs).toHaveLength(items.length);
    expect(trace.requestShape.queryForm).toBe('identifier-heavy');
    const archTemporal = trace.events.filter((event) => event.kind === 'candidate-filter'
      && event.name === 'temporal' && event.outcome === 'pass');
    expect(archTemporal).toHaveLength(0);
  });

  it('preserves fact provenance as a fact context section', async () => {
    const mock = driver(validRows());
    const service = new RuntimeCandidateChannelService(mock.driver);
    const receipt = await authorityReceipt();
    const execution = await service.execute(receipt, { includeArchitecture: false, includeMemory: true });
    const assembler = Object.create(UnifiedAssembler.prototype) as UnifiedAssembler;
    const result = assembler.assembleCandidateExecution('task', execution, 8_000, false, true);
    expect(result.context.sections.find((section) => section.items.some((item) => item.id === 'fact-1'))?.source_type)
      .toBe('fact');
  });

  it('records exact-ID arch.entity authority as entity-pass while leaving temporal not-applicable', async () => {
    const mock = driver(validRows());
    const service = new RuntimeCandidateChannelService(mock.driver);
    const receipt = await authorityReceipt();
    const execution = await service.execute(receipt, { includeArchitecture: true, includeMemory: false });
    const assembler = Object.create(UnifiedAssembler.prototype) as UnifiedAssembler;
    const result = assembler.assembleCandidateExecution('task', execution, 8_000, true, false, true);
    const filters = result.trace!.events.filter((event) => event.kind === 'candidate-filter');
    expect(filters).toContainEqual(expect.objectContaining({ name: 'entity', outcome: 'pass' }));
    expect(filters).toContainEqual(expect.objectContaining({ name: 'temporal', outcome: 'not-applicable' }));
    expect(filters).not.toContainEqual(expect.objectContaining({ name: 'temporal', outcome: 'pass' }));
  });

  it('settles a hung source as timeout and closes the session', async () => {
    vi.useFakeTimers();
    try {
      const close = vi.fn(async () => undefined);
      const service = new RuntimeCandidateChannelService({
        session: vi.fn(() => ({
          run: vi.fn(),
          beginTransaction: () => ({ run: vi.fn(() => new Promise(() => undefined)), commit: vi.fn(), rollback: vi.fn() }),
          close,
        })),
      });
      const receipt = await authorityReceipt();
      const pending = service.execute(receipt, { includeArchitecture: true, includeMemory: false });
      await vi.advanceTimersByTimeAsync(2_001);
      const result = await pending;
      expect(result.settlements.find((item) => item.channel === 'arch.entity'))
        .toMatchObject({ outcome: 'safe-failure', code: 'timeout' });
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies the token budget without changing canonical execution and traces the exclusion', async () => {
    const mock = driver(validRows());
    const service = new RuntimeCandidateChannelService(mock.driver);
    const receipt = await authorityReceipt();
    const execution = await service.execute(receipt, { includeArchitecture: true, includeMemory: true });
    const assembler = Object.create(UnifiedAssembler.prototype) as UnifiedAssembler;
    const result = assembler.assembleCandidateExecution('task', execution, 1, true, true, true);
    expect(execution.candidates).toHaveLength(3);
    expect(result.context.sections.flatMap((section) => section.items)).toHaveLength(0);
    const trace = result.trace!;
    expect(trace.complete).toBe(true);
    expect(trace.terminalExclusions).toHaveLength(3);
    expect(trace.terminalExclusions.every((item) => item.reasons.includes('token-budget'))).toBe(true);
    expect(() => JSON.parse(canonicalTraceJson(trace))).not.toThrow();
  });
});
