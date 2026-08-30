import { describe, expect, it, vi } from 'vitest';
import neo4j, { Record as Neo4jRecord } from 'neo4j-driver';
import { EMBEDDING_DIM } from '@memberry/core';

import { canonicalTraceJson, replayRetrievalTrace, RETRIEVAL_TRACE_CHANNEL_ORDER } from '../trace.js';
import { resolveRuntimeQueryPlannerAuthorityV1 } from '../runtime-query-planner.js';
import {
  EPISODIC_STRUCTURED_INDEX_FLAG,
  RuntimeCandidateChannelService,
  type RuntimeCandidateDriver,
} from '../runtime-candidate-channel.js';
import { UnifiedAssembler } from '../assembler.js';
import {
  createServedRerankerProviderV1,
  SERVED_RERANKER_PROVIDER_IDENTITY,
  type ServedRerankerConstructionV1,
} from '../served-reranker.js';
import {
  createRerankerProviderV1,
  parseSerializedRerankerProviderRequestV1,
  serializeRerankerProviderResponseV1,
} from '../reranker.js';

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
        id: source.get('evidenceId'),
        subject: source.has('factSubject') ? source.get('factSubject') : 'subject',
        predicate: source.has('factPredicate') ? source.get('factPredicate') : 'predicate',
        object: source.has('factObject') ? source.get('factObject') : 'object',
        entity_id: entityId, source_episode_ids: [],
        valid_at: source.has('factValidAt') ? source.get('factValidAt') : '2026-01-01T00:00:00.000Z',
        invalid_at: null,
        confidence: source.get('score'), status: 'active', inference_type: 'deductive', supersedes_fact_id: null,
        scope: 'project', tags: [project], tenant_id: 'tenant-a', created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      } }));
      return { records: [record(['ordinal', 'eid', 'facts'], ['0', entityId, facts])] };
    }
    const kind = query.includes('MATCH (ep:Episodic)')
      ? 'episodicVector'
      : query.includes('vector.similarity.cosine(s.embedding')
        ? 'semanticVector'
        : query.includes('MATCH (s:Semantic)')
          ? 'scope'
      : query.includes('MATCH (b:MemoryBlock') ? 'block' : 'arch';
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
    block: [record(
      ['tenantId', 'projectScope', 'resolvedEntityId', 'evidenceId', 'title', 'content', 'score'],
      ['tenant-a', project, entityId, '-project-state', 'project_state', 'Project inventory', 0.5],
    )],
    arch: [record(
      ['tenantId', 'projectScope', 'resolvedEntityId', 'evidenceId', 'title', 'content', 'score'],
      ['tenant-a', project, entityId, entityId, 'Entity', 'Architecture entity', 1],
    )],
  };
}

describe('RET-003B runtime candidate channel service', () => {
  function candidateAssembler(provider: ServedRerankerConstructionV1): UnifiedAssembler {
    return new UnifiedAssembler(
      {} as never,
      { zincrby: vi.fn(), zrevrangeWithScores: vi.fn(), lpush: vi.fn(), ltrim: vi.fn() },
      null,
      null,
      { embed: vi.fn(), embedBatch: vi.fn() },
      null,
      provider,
    );
  }

  it('does not mint authority from a caller-controlled bare object', async () => {
    const mock = driver(validRows());
    const service = new RuntimeCandidateChannelService(mock.driver);
    await expect(service.execute({ contract: 'memberry.runtime-query-planner-resolved-receipt.v1' } as never, {
      includeArchitecture: true, includeMemory: true,
    })).rejects.toThrow('candidate_runtime:invalid_receipt');
    expect(mock.driver.session).not.toHaveBeenCalled();
  });

  it('binds a private receipt and runs only the four authorized channels in canonical order', async () => {
    const mock = driver(validRows());
    const service = new RuntimeCandidateChannelService(mock.driver);
    const receipt = await authorityReceipt();
    const result = await service.execute(receipt, { includeArchitecture: true, includeMemory: true });

    expect(result.settlements.map((item) => item.channel)).toEqual(RETRIEVAL_TRACE_CHANNEL_ORDER);
    expect(result.settlements.filter((item) => item.outcome === 'success').map((item) => item.channel))
      .toEqual(['memory.scope', 'memory.fact', 'memory.block', 'arch.entity']);
    expect(result.candidates.map((item) => item.evidenceId))
      .toEqual(['semantic-1', 'fact-1', '-project-state', entityId]);
    expect(mock.calls).toHaveLength(4);
    for (const [query, params] of mock.calls) {
      if (query.includes('UNWIND $ids AS eid')) expect(params).toMatchObject({ tenantId: 'tenant-a', ids: [entityId] });
      else {
        expect(params).toMatchObject({ tenantId: 'tenant-a', projectScope: project, entityId });
        expect(neo4j.isInt(params.rowLimit)).toBe(true);
        expect(neo4j.integer.toNumber(params.rowLimit as neo4j.Integer)).toBe(64);
      }
    }
  });

  it('ranks semantic and episodic vectors only inside the receipt-authorized entity set', async () => {
    const rows = validRows();
    rows.semanticVector = [record(
      ['tenantId', 'projectScope', 'resolvedEntityId', 'evidenceId', 'title', 'content', 'score'],
      ['tenant-a', project, entityId, 'semantic-1', 'Semantic', 'Scoped memory', 0.95],
    )];
    rows.episodicVector = [record(
      ['tenantId', 'projectScope', 'resolvedEntityId', 'evidenceId', 'title', 'content', 'score'],
      ['tenant-a', project, entityId, '_episode-needle', 'decision', 'episodic needle decision', 0.91],
    )];
    const mock = driver(rows);
    const queryVector = new Array(EMBEDDING_DIM).fill(0);
    queryVector[0] = 1;
    const execution = await new RuntimeCandidateChannelService(mock.driver).execute(
      await authorityReceipt(),
      { includeArchitecture: false, includeMemory: true, queryVector },
    );

    expect(execution.settlements.filter((item) => item.outcome === 'success').map((item) => item.channel))
      .toEqual([
        'memory.scope', 'memory.semantic-vector', 'memory.episodic-vector', 'memory.fact', 'memory.block',
      ]);
    const semanticQuery = mock.calls.find(([query]) => query.includes('vector.similarity.cosine(s.embedding'));
    const episodicQuery = mock.calls.find(([query]) => query.includes('MATCH (ep:Episodic)'));
    expect(semanticQuery?.[0].indexOf('MATCH path')).toBeLessThan(semanticQuery?.[0].indexOf('vector.similarity') ?? -1);
    expect(semanticQuery?.[0]).toContain('OPTIONAL MATCH (s)-[r:ABOUT]->(target)');
    expect(semanticQuery?.[0]).toContain('r IS NULL AND target = root');
    expect(episodicQuery?.[0].indexOf('MATCH path')).toBeLessThan(episodicQuery?.[0].indexOf('vector.similarity') ?? -1);
    expect(episodicQuery?.[0]).toContain('MATCH (ep:Episodic)-[r:REFERENCES]->(target)');
    expect(semanticQuery?.[1]).toMatchObject({
      tenantId: 'tenant-a', projectScope: project, entityId, queryVector,
    });
    expect(episodicQuery?.[1]).toMatchObject({
      tenantId: 'tenant-a', projectScope: project, entityId, queryVector,
    });

    const served = await candidateAssembler(createServedRerankerProviderV1())
      .assembleCandidateExecutionServed('episodic needle decision', execution, 8_000, false, true, true);
    const ids = served.context.sections.flatMap((section) => section.items).map((item) => item.id);
    expect(ids[0]).toBe('_episode-needle');
    expect(ids.filter((id) => id === 'semantic-1')).toHaveLength(1);
    expect(served.trace!.events).toContainEqual(expect.objectContaining({
      kind: 'reranker-stage', outcome: 'reranked',
    }));

    const tight = await candidateAssembler(createServedRerankerProviderV1())
      .assembleCandidateExecutionServed('episodic subject project scoped', execution, 21, false, true, false);
    expect(new Set(tight.context.sections.map((section) => section.source_type)))
      .toEqual(new Set(['semantic', 'episodic', 'fact', 'block']));
    expect(tight.context.token_count).toBeLessThanOrEqual(21);
  });

  it('keeps the legacy episodic query byte path when structured indexing is disabled', async () => {
    const previous = process.env[EPISODIC_STRUCTURED_INDEX_FLAG];
    delete process.env[EPISODIC_STRUCTURED_INDEX_FLAG];
    try {
      const mock = driver(validRows());
      const queryVector = new Array(EMBEDDING_DIM).fill(0);
      await new RuntimeCandidateChannelService(mock.driver).execute(
        await authorityReceipt(),
        { includeArchitecture: false, includeMemory: true, queryVector },
      );
      const query = mock.calls.find(([text]) => text.includes('MATCH (ep:Episodic)'))?.[0];
      expect(query).toContain('MATCH (ep:Episodic)-[r:REFERENCES]->(target)');
      expect(query).not.toContain('HAS_INDEX_KEY');
      expect(query).not.toContain('seedRef:REFERENCES');
    } finally {
      if (previous === undefined) delete process.env[EPISODIC_STRUCTURED_INDEX_FLAG];
      else process.env[EPISODIC_STRUCTURED_INDEX_FLAG] = previous;
    }
  });

  it('bounds structured expansion to query-target seeds and rechecks neighbor scope', async () => {
    const previous = process.env[EPISODIC_STRUCTURED_INDEX_FLAG];
    process.env[EPISODIC_STRUCTURED_INDEX_FLAG] = '1';
    try {
      const mock = driver(validRows());
      const queryVector = new Array(EMBEDDING_DIM).fill(0);
      await new RuntimeCandidateChannelService(mock.driver).execute(
        await authorityReceipt(),
        { includeArchitecture: false, includeMemory: true, queryVector },
      );
      const query = mock.calls.find(([text]) => text.includes('MATCH (ep:Episodic)'))?.[0];
      expect(query).toContain('MATCH (ep:Episodic)-[r:REFERENCES]->(target)');
      expect(query).toContain('WHERE baseIndex < 5');
      expect(query).toContain('bridge <> target');
      expect(query).toContain('neighbor.tenant_id = $tenantId');
      expect(query).toContain('neighbor.scope = $projectScope');
      expect(query).toContain('neighborKey.project_scope = $projectScope');
      expect(query).toContain('LIMIT 1');
    } finally {
      if (previous === undefined) delete process.env[EPISODIC_STRUCTURED_INDEX_FLAG];
      else process.env[EPISODIC_STRUCTURED_INDEX_FLAG] = previous;
    }
  });

  it('lexically reranks only the already-authorized active fact set before fusion', async () => {
    const rows = validRows();
    rows.fact = [
      record(
        ['tenantId', 'projectScope', 'resolvedEntityId', 'evidenceId', 'title', 'content', 'score', 'factSubject', 'factPredicate', 'factObject', 'factValidAt'],
        ['tenant-a', project, entityId, 'fact-recent', 'Fact', 'generic recent state', 1, 'Neuri', 'status', 'running', '2026-02-01T00:00:00.000Z'],
      ),
      record(
        ['tenantId', 'projectScope', 'resolvedEntityId', 'evidenceId', 'title', 'content', 'score', 'factSubject', 'factPredicate', 'factObject', 'factValidAt'],
        ['tenant-a', project, entityId, 'fact-location', 'Fact', 'Neuri located at Desktop', 0.1, 'Neuri', 'located_at', 'Desktop', '2026-01-01T00:00:00.000Z'],
      ),
    ];
    const execution = await new RuntimeCandidateChannelService(driver(rows).driver).execute(
      await authorityReceipt(),
      {
        includeArchitecture: false,
        includeMemory: true,
        queryText: 'Where is Neuri located?',
      },
    );
    const facts = execution.candidates.filter((candidate) => candidate.sourceType === 'fact');
    expect(facts.map((candidate) => candidate.evidenceId)).toEqual(['fact-location', 'fact-recent']);
    expect(facts.map((candidate) => candidate.rank)).toEqual([1, 2]);
  });

  it('rejects malformed query vectors before opening a database session', async () => {
    const mock = driver(validRows());
    await expect(new RuntimeCandidateChannelService(mock.driver).execute(
      await authorityReceipt(),
      { includeArchitecture: false, includeMemory: true, queryVector: [1] },
    )).rejects.toThrow('candidate_runtime:invalid_query_vector');
    expect(mock.driver.session).not.toHaveBeenCalled();
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
    expect(result.candidates.map((item) => item.evidenceId))
      .toEqual(['fact-1', '-project-state', entityId]);
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

  it('serves only project-scoped sessionless core blocks for the sealed tenant', async () => {
    const mock = driver(validRows());
    const service = new RuntimeCandidateChannelService(mock.driver);
    await service.execute(await authorityReceipt(), { includeArchitecture: false, includeMemory: true });
    const blockQuery = mock.calls.find(([query]) => query.includes('MATCH (b:MemoryBlock'))?.[0] ?? '';
    expect(blockQuery).toContain('MATCH (b:MemoryBlock {scope: $projectScope})');
    expect(blockQuery).toContain('b.tenant_id = $tenantId');
    expect(blockQuery).toContain('b.tenant_id IS NULL AND $tenantId = $defaultTenant');
    expect(blockQuery).toContain("b.tier = 'core'");
    expect(blockQuery).toContain('b.session_id IS NULL');
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
      if (query.includes('MATCH (b:MemoryBlock')) return { records: rows.block };
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
    expect(result.candidates.map((item) => item.evidenceId))
      .toEqual(['-project-state', entityId]);
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
    expect(execution.candidates).toHaveLength(4);
    expect(result.context.sections.flatMap((section) => section.items)).toHaveLength(0);
    const trace = result.trace!;
    expect(trace.complete).toBe(true);
    expect(trace.terminalExclusions).toHaveLength(4);
    expect(trace.terminalExclusions.every((item) => item.reasons.includes('token-budget'))).toBe(true);
    expect(() => JSON.parse(canonicalTraceJson(trace))).not.toThrow();
  });

  it('packs short candidates a single long one would crowd out of the same token budget', async () => {
    const scopeRow = (evidenceId: string, content: string) => record(
      ['tenantId', 'projectScope', 'resolvedEntityId', 'evidenceId', 'title', 'content', 'score'],
      ['tenant-a', project, entityId, evidenceId, 'Semantic', content, 0.9],
    );
    const rows = validRows();
    rows.block = [];
    rows.scope = [
      scopeRow('semantic-long', 'L'.repeat(400)),
      scopeRow('semantic-short-a', 'A'.repeat(40)),
      scopeRow('semantic-short-b', 'B'.repeat(40)),
    ];
    const mock = driver(rows);
    const service = new RuntimeCandidateChannelService(mock.driver);
    const receipt = await authorityReceipt();
    const execution = await service.execute(receipt, { includeArchitecture: false, includeMemory: true });
    const assembler = Object.create(UnifiedAssembler.prototype) as UnifiedAssembler;

    const budgeted = assembler.assembleCandidateExecution('task', execution, 100, false, true).context;
    const unbudgeted = assembler.assembleCandidateExecution('task', execution, 8_000, false, true).context;
    const items = budgeted.sections.flatMap((section) => section.items);

    expect(items.map((item) => item.id).sort()).toEqual(['fact-1', 'semantic-short-a', 'semantic-short-b']);
    expect(budgeted.token_count).toBeLessThanOrEqual(100);
    // Rank-greedy first-fit spends the whole budget on the long top-ranked item; the budgeted
    // set must score strictly higher than that single item to beat it.
    const longScore = unbudgeted.sections.flatMap((section) => section.items)
      .find((item) => item.id === 'semantic-long')!.score;
    expect(items.reduce((sum, item) => sum + item.score, 0)).toBeGreaterThan(longScore);
  });

  it('keeps one item that exactly fills the budget over a denser item that strands the rest', async () => {
    const rows = validRows();
    rows.block = [];
    // 40 chars -> 10 tokens, confidence 1 -> provenance 1.1: fills a 10-token budget exactly.
    rows.scope![0] = record(
      ['tenantId', 'projectScope', 'resolvedEntityId', 'evidenceId', 'title', 'content', 'score'],
      ['tenant-a', project, entityId, 'semantic-exact', 'Semantic', 'L'.repeat(40), 1],
    );
    // The fact runtime rebuilds content as "subject predicate object" -> 24 chars -> 6 tokens.
    // Confidence 0 -> provenance 0.9, so it is denser but worth less, and the 4 tokens it
    // leaves behind are too few to hold anything else.
    rows.fact![0] = record(
      ['tenantId', 'projectScope', 'resolvedEntityId', 'evidenceId', 'title', 'content', 'score'],
      ['tenant-a', project, entityId, 'fact-dense', 'Fact', 'subject predicate object', 0],
    );
    const mock = driver(rows);
    const service = new RuntimeCandidateChannelService(mock.driver);
    const receipt = await authorityReceipt();
    const execution = await service.execute(receipt, { includeArchitecture: false, includeMemory: true });
    const assembler = Object.create(UnifiedAssembler.prototype) as UnifiedAssembler;

    const budgeted = assembler.assembleCandidateExecution('task', execution, 10, false, true).context;
    const unbudgeted = assembler.assembleCandidateExecution('task', execution, 8_000, false, true).context;
    const items = budgeted.sections.flatMap((section) => section.items);
    // Density-greedy alone takes the cheap dense item and wastes the remaining 4 tokens; the
    // budget must instead go to the single item worth more that fits inside it.
    const denseScore = unbudgeted.sections.flatMap((section) => section.items)
      .find((item) => item.id === 'fact-dense')!.score;

    expect(items.map((item) => item.id)).toEqual(['semantic-exact']);
    expect(budgeted.token_count).toBe(10);
    expect(items.reduce((sum, item) => sum + item.score, 0)).toBeGreaterThan(denseScore);
  });

  it('fills the budget with two equal-score items over a denser one that strands the rest', async () => {
    const scopeRow = (evidenceId: string, content: string, score: number) => record(
      ['tenantId', 'projectScope', 'resolvedEntityId', 'evidenceId', 'title', 'content', 'score'],
      ['tenant-a', project, entityId, evidenceId, 'Semantic', content, score],
    );
    const rows = validRows();
    rows.block = [];
    // 20 chars -> 5 tokens each: the two confidence-1 rows exactly fill a 10-token budget
    // together. The confidence-0 row is 8 chars -> 2 tokens, so it is denser but worth less,
    // and taking it first leaves 8 tokens that can only hold one of the other two.
    rows.scope = [
      scopeRow('semantic-a-fits', 'A'.repeat(20), 1),
      scopeRow('semantic-b-fits', 'B'.repeat(20), 1),
      scopeRow('semantic-c-dense', 'C'.repeat(8), 0),
    ];
    rows.fact = [];
    const mock = driver(rows);
    const service = new RuntimeCandidateChannelService(mock.driver);
    const receipt = await authorityReceipt();
    const execution = await service.execute(receipt, { includeArchitecture: false, includeMemory: true });
    const assembler = Object.create(UnifiedAssembler.prototype) as UnifiedAssembler;

    const budgeted = assembler.assembleCandidateExecution('task', execution, 10, false, true).context;
    const items = budgeted.sections.flatMap((section) => section.items);
    // Density-greedy takes the cheap dense row first and can then afford only one of the
    // pair; plain rank-order first-fit takes both and spends the whole budget on more value.
    expect(items.map((item) => item.id)).toEqual(['semantic-a-fits', 'semantic-b-fits']);
    expect(budgeted.token_count).toBe(10);
  });

  it('serves only receipt candidates, changes candidate order, and records replayable ranked-v2 evidence', async () => {
    const rows = validRows();
    rows.block = [];
    rows.scope = [
      record(
        ['tenantId', 'projectScope', 'resolvedEntityId', 'evidenceId', 'title', 'content', 'score'],
        ['tenant-a', project, entityId, 'semantic-baseline', 'Generic', 'generic generic text', 1],
      ),
      record(
        ['tenantId', 'projectScope', 'resolvedEntityId', 'evidenceId', 'title', 'content', 'score'],
        ['tenant-a', project, entityId, 'semantic-needle', 'Needle', 'needle needle match', 0.01],
      ),
    ];
    rows.fact = [];
    const mock = driver(rows);
    const execution = await new RuntimeCandidateChannelService(mock.driver).execute(
      await authorityReceipt(), { includeArchitecture: false, includeMemory: true },
    );
    const real = createServedRerankerProviderV1();
    const requests: ReturnType<typeof parseSerializedRerankerProviderRequestV1>[] = [];
    const provider = {
      identity: real.identity,
      run: async (...args: Parameters<typeof real.run>) => {
        requests.push(parseSerializedRerankerProviderRequestV1(args[0]));
        return real.run(...args);
      },
    } as ServedRerankerConstructionV1;
    const assembler = candidateAssembler(provider);
    const baseline = assembler.assembleCandidateExecution('needle', execution, 8_000, false, true);
    const served = await assembler.assembleCandidateExecutionServed('needle', execution, 8_000, false, true, true);

    expect(baseline.context.sections.flatMap((section) => section.items).map((item) => item.id))
      .toEqual(['semantic-baseline', 'semantic-needle']);
    expect(served.context.sections.flatMap((section) => section.items).map((item) => item.id))
      .toEqual(['semantic-needle', 'semantic-baseline']);
    const tightBaseline = assembler.assembleCandidateExecution('needle', execution, 5, false, true);
    const tightServed = await assembler.assembleCandidateExecutionServed('needle', execution, 5, false, true);
    expect(tightBaseline.context.sections.flatMap((section) => section.items).map((item) => item.id))
      .toEqual(['semantic-baseline']);
    expect(tightServed.context.sections.flatMap((section) => section.items).map((item) => item.id))
      .toEqual(['semantic-needle']);
    expect(served.trace!.algorithmVersion).toBe('ranked-v2');
    expect(served.trace!.events).toContainEqual(expect.objectContaining({ kind: 'reranker-stage', outcome: 'reranked' }));
    expect(replayRetrievalTrace(served.trace!).resultOrder).toEqual(served.trace!.resultOrder);
    const rerankerEvent = served.trace!.events.find((event) => event.kind === 'reranker-stage');
    if (rerankerEvent?.kind !== 'reranker-stage') throw new Error('missing reranker stage');
    expect([...rerankerEvent.candidates].sort((a, b) => a.rerankedRank - b.rerankedRank).map((candidate) => candidate.ref))
      .toEqual(served.trace!.resultOrder);
    expect(JSON.stringify(served.trace)).not.toContain('semantic-baseline');
    expect(JSON.stringify(served.trace)).not.toContain('semantic-needle');
    expect(requests).toHaveLength(2);
    expect(requests[0]!.candidates.map((candidate) => candidate.content))
      .toEqual(['generic generic text', 'needle needle match']);
    expect(JSON.stringify(requests)).not.toContain('tenant-foreign-sentinel');
    expect(JSON.stringify(requests)).not.toContain('project:foreign-sentinel');
    expect(JSON.stringify(requests)).not.toContain('time-foreign-sentinel');
  });

  it('keeps the synchronous shadow seam provider-free and falls back inside ranked-v2 on invalid output', async () => {
    const rows = validRows();
    const mock = driver(rows);
    const execution = await new RuntimeCandidateChannelService(mock.driver).execute(
      await authorityReceipt(), { includeArchitecture: false, includeMemory: true },
    );
    const real = createServedRerankerProviderV1();
    const run = vi.fn(real.run);
    const observer = vi.fn();
    const assembler = candidateAssembler({ identity: real.identity, run } as ServedRerankerConstructionV1);
    const sync = assembler.assembleCandidateExecution('subject predicate', execution, 8_000, false, true, false, observer);
    expect(observer).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();

    const invalid = createRerankerProviderV1(
      SERVED_RERANKER_PROVIDER_IDENTITY,
      async () => '{"invalid":true}',
    ) as ServedRerankerConstructionV1;
    const fallback = await candidateAssembler(invalid)
      .assembleCandidateExecutionServed('subject predicate', execution, 8_000, false, true, true);
    expect(fallback.context.sections).toEqual(sync.context.sections);
    expect(fallback.trace!.algorithmVersion).toBe('ranked-v2');
    expect(fallback.trace!.events).toContainEqual(expect.objectContaining({ kind: 'reranker-stage', outcome: 'baseline' }));
  });

  it('RET-Q-004 preserves a reranked top-five episode through density packing only when enabled', async () => {
    const rows = validRows();
    rows.scope = [];
    rows.fact = [];
    rows.block = [];
    const names = ['head', 'target', 'a', 'b', 'c', ...Array.from({ length: 8 }, (_, index) => `low-${index}`)];
    rows.episodicVector = names.map((name, index) => record(
      ['tenantId', 'projectScope', 'resolvedEntityId', 'evidenceId', 'title', 'content', 'score'],
      [
        'tenant-a', project, entityId, `episode-${name}`, 'Episodic',
        `${name} ${name === 'target' ? 't'.repeat(160) : name.startsWith('low-') ? 'tiny' : 'x'.repeat(20)}`,
        0.99 - index * 0.01,
      ],
    ));
    const queryVector = new Array(EMBEDDING_DIM).fill(0);
    queryVector[0] = 1;
    const execution = await new RuntimeCandidateChannelService(driver(rows).driver).execute(
      await authorityReceipt(), { includeArchitecture: false, includeMemory: true, queryVector },
    );
    const rerankScores = new Map([
      ['head', 1], ['a', 0.9], ['b', 0.8], ['c', 0.7], ['target', 0.6],
      ...Array.from({ length: 8 }, (_, index) => [
        `low-${index}`, Number((0.59 - index * 0.01).toFixed(2)),
      ] as const),
    ]);
    const provider = createRerankerProviderV1(
      SERVED_RERANKER_PROVIDER_IDENTITY,
      async (serialized) => {
        const request = parseSerializedRerankerProviderRequestV1(serialized);
        return serializeRerankerProviderResponseV1(
          request,
          SERVED_RERANKER_PROVIDER_IDENTITY,
          request.candidates.map((candidate) => rerankScores.get(candidate.content.split(' ', 1)[0]!) ?? 0),
        );
      },
    ) as ServedRerankerConstructionV1;

    const ordinaryAssembler = candidateAssembler(provider);
    const guardedAssembler = candidateAssembler(provider);
    guardedAssembler.enableEpisodicRecallV1();
    const ordinary = await ordinaryAssembler.assembleCandidateExecutionServed(
      'target', execution, 70, false, true, true,
    );
    const guarded = await guardedAssembler.assembleCandidateExecutionServed(
      'target', execution, 70, false, true, true,
    );
    const ordinaryIds = ordinary.context.sections.flatMap((section) => section.items.map((item) => item.id));
    const guardedIds = guarded.context.sections.flatMap((section) => section.items.map((item) => item.id));

    expect(ordinaryIds).not.toContain('episode-target');
    expect(guardedIds[0]).toBe('episode-head');
    expect(guardedIds.indexOf('episode-target')).toBeGreaterThanOrEqual(0);
    expect(guardedIds.indexOf('episode-target')).toBeLessThan(5);
    expect(guarded.context.token_count).toBeLessThanOrEqual(70);
    expect(replayRetrievalTrace(guarded.trace!).resultOrder).toEqual(guarded.trace!.resultOrder);

    const typedRows = validRows();
    typedRows.scope = [];
    typedRows.fact = [];
    typedRows.block = [];
    typedRows.episodicVector = names.map((name, index) => record(
      ['tenantId', 'projectScope', 'resolvedEntityId', 'evidenceId', 'title', 'content', 'score'],
      [
        'tenant-a', project, entityId, `episode-${name}`, 'decision',
        `${name} ${name === 'target' ? 't'.repeat(160) : name.startsWith('low-') ? 'tiny' : 'x'.repeat(20)}`,
        0.99 - index * 0.01,
      ],
    ));
    const typedExecution = await new RuntimeCandidateChannelService(driver(typedRows).driver).execute(
      await authorityReceipt(), { includeArchitecture: false, includeMemory: true, queryVector },
    );
    const typedAssembler = candidateAssembler(provider);
    typedAssembler.enableEpisodicRecallV1();
    const typed = await typedAssembler.assembleCandidateExecutionServed(
      'target', typedExecution, 70, false, true, true,
    );
    expect(typed.context.sections.flatMap((section) => section.items.map((item) => item.id)))
      .toEqual(ordinaryIds);
  });

  it('RET-Q-005 preserves one exact uncovered identifier through fusion, hostile reranking, and tight packing', async () => {
    const rows = validRows();
    rows.scope = [];
    rows.fact = [];
    rows.block = [];
    rows.episodicVector = Array.from({ length: 64 }, (_, index) => {
      const target = index === 52;
      return record(
        ['tenantId', 'projectScope', 'resolvedEntityId', 'evidenceId', 'title', 'content', 'score'],
        [
          'tenant-a', project, entityId, target ? 'episode-target' : `episode-distractor-${index + 1}`,
          'decision',
          target
            ? `Approved RET-001A2 deterministic trace amendment closure ${'t'.repeat(160)}`
            : `routine unrelated maintenance record ${index + 1}`,
          0.99 - index * 0.001,
        ],
      );
    });
    const queryVector = new Array(EMBEDDING_DIM).fill(0);
    queryVector[0] = 1;
    const execution = await new RuntimeCandidateChannelService(driver(rows).driver).execute(
      await authorityReceipt(), { includeArchitecture: false, includeMemory: true, queryVector },
    );
    expect(execution.candidates.find((candidate) => candidate.evidenceId === 'episode-target'))
      .toMatchObject({ channel: 'memory.episodic-vector', rank: 53 });

    const requests: ReturnType<typeof parseSerializedRerankerProviderRequestV1>[] = [];
    const provider = createRerankerProviderV1(
      SERVED_RERANKER_PROVIDER_IDENTITY,
      async (serialized) => {
        const request = parseSerializedRerankerProviderRequestV1(serialized);
        requests.push(request);
        return serializeRerankerProviderResponseV1(
          request,
          SERVED_RERANKER_PROVIDER_IDENTITY,
          request.candidates.map((candidate, index) => candidate.content.includes('RET-001A2')
            ? 0
            : Number((1 - index * 0.001).toFixed(6))),
        );
      },
    ) as ServedRerankerConstructionV1;
    const ordinaryAssembler = candidateAssembler(provider);
    ordinaryAssembler.enableEpisodicRecallV1();
    const guardedAssembler = candidateAssembler(provider);
    guardedAssembler.enableEpisodicRecallV1();
    guardedAssembler.enableEpisodicIdentifierReserveV1();
    const task = 'Implement approved RET-001A2 deterministic-v2 retrieval trace amendment';

    const ordinary = await ordinaryAssembler.assembleCandidateExecutionServed(
      task, execution, 70, false, true, true,
    );
    const synchronous = guardedAssembler.assembleCandidateExecution(
      task, execution, 70, false, true, true,
    );
    const guarded = await guardedAssembler.assembleCandidateExecutionServed(
      task, execution, 70, false, true, true,
    );
    const ids = (result: typeof ordinary | typeof synchronous) => result.context.sections
      .flatMap((section) => section.items.map((item) => item.id));

    expect(ids(ordinary)).not.toContain('episode-target');
    expect(ids(synchronous)).not.toContain('episode-target');
    expect(ids(guarded).indexOf('episode-target')).toBeGreaterThanOrEqual(0);
    expect(ids(guarded).indexOf('episode-target')).toBeLessThan(5);
    expect(guarded.context.token_count).toBeLessThanOrEqual(70);
    expect(requests.map((request) => request.candidates.length)).toEqual([50, 50]);
    expect(replayRetrievalTrace(guarded.trace!).resultOrder).toEqual(guarded.trace!.resultOrder);
  }, 60_000);

  it('keeps parallel served candidate executions receipt-local', async () => {
    const firstRows = validRows();
    const secondRows = validRows();
    secondRows.scope![0] = record(
      ['tenantId', 'projectScope', 'resolvedEntityId', 'evidenceId', 'title', 'content', 'score'],
      ['tenant-a', project, entityId, 'semantic-other', 'Semantic', 'other query material', 0.9],
    );
    const [firstExecution, secondExecution] = await Promise.all([
      new RuntimeCandidateChannelService(driver(firstRows).driver).execute(
        await authorityReceipt(), { includeArchitecture: false, includeMemory: true },
      ),
      new RuntimeCandidateChannelService(driver(secondRows).driver).execute(
        await authorityReceipt(), { includeArchitecture: false, includeMemory: true },
      ),
    ]);
    const assembler = candidateAssembler(createServedRerankerProviderV1());
    const [first, second] = await Promise.all([
      assembler.assembleCandidateExecutionServed('subject predicate', firstExecution, 8_000, false, true),
      assembler.assembleCandidateExecutionServed('other query', secondExecution, 8_000, false, true),
    ]);
    expect(first.context.sections.flatMap((section) => section.items).map((item) => item.id))
      .not.toContain('semantic-other');
    expect(second.context.sections.flatMap((section) => section.items).map((item) => item.id))
      .toContain('semantic-other');
  });
});
