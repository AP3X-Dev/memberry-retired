// packages/core/src/__tests__/service.security.test.ts
//
// Covers the security/tenancy hardening on AMPService:
//   - read-only mode rejects writes
//   - secret redaction at the ingest boundary
//   - the audit trail records stores
//   - no-embedding mode skips vector search in load() (no random context)
//   - project scope is propagated to the scoped query (isolation)

import { describe, it, expect, vi } from 'vitest';
import { AMPService } from '../service.js';
import type { RedisLayer, Neo4jLayer } from '../service.js';
import type { AMPConfig, EpisodeInput, EpisodicNode } from '../types.js';

vi.mock('../extract.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../extract.js')>();
  return { ...actual, extractFacts: vi.fn().mockResolvedValue([]) };
});

function makeConfig(overrides: Partial<AMPConfig> = {}): AMPConfig {
  return {
    redis: { url: 'redis://localhost:6379' },
    neo4j: { uri: 'bolt://localhost:7687', user: 'neo4j', password: 'pw' },
    embedding: { provider: 'openai', apiKey: 'test-key' },
    cache: { defaultTTL: 300, contextTTL: 600, embeddingTTL: 86400 },
    consolidation: { autoApply: false, signalThreshold: 3 },
    exportPath: '/tmp/x',
    ...overrides,
  };
}

function makeRedis(): RedisLayer {
  return {
    cache: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      invalidateByScope: vi.fn().mockResolvedValue(0),
      invalidateByNodeId: vi.fn().mockResolvedValue(0),
    },
    embeddings: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) },
    dedup: {
      isDuplicate: vi.fn().mockResolvedValue(false),
      markSeen: vi.fn().mockResolvedValue(undefined),
      checkAndMark: vi.fn().mockResolvedValue(false),
      unmark: vi.fn().mockResolvedValue(undefined),
    },
    signals: { publish: vi.fn().mockResolvedValue('s1') },
    queue: { incrementScore: vi.fn().mockResolvedValue(1) },
  };
}

function makeNeo4j(createSpy?: ReturnType<typeof vi.fn>, byScopeSpy?: ReturnType<typeof vi.fn>): Neo4jLayer {
  return {
    episodic: {
      create: createSpy ?? vi.fn().mockResolvedValue('ep-1'),
      linkToAgent: vi.fn().mockResolvedValue(undefined),
      linkToEntity: vi.fn().mockResolvedValue(undefined),
      linkToModel: vi.fn().mockResolvedValue(undefined),
      linkSignal: vi.fn().mockResolvedValue(undefined),
    },
    query: {
      byScope: byScopeSpy ?? vi.fn().mockResolvedValue([]),
      byVector: vi.fn().mockResolvedValue([]),
    },
    entity: {
      listProjectNames: vi.fn().mockResolvedValue(['test']),
      upsertProject: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function disabledEmbedding() {
  return { available: false as const, embed: vi.fn().mockResolvedValue(new Array(8).fill(0)), embedBatch: vi.fn().mockResolvedValue([]) };
}
function availableEmbedding() {
  return { available: true as const, embed: vi.fn().mockResolvedValue(new Array(8).fill(0.1)), embedBatch: vi.fn().mockResolvedValue([]) };
}

const baseInput = (over: Partial<EpisodeInput> = {}): EpisodeInput => ({
  session_id: 's', agent_id: 'alice', task: 'do a thing',
  content: 'plain content', tags: ['project:test'], ...over,
});

describe('AMPService read-only mode', () => {
  it('rejects store() when config.readonly is true', async () => {
    const svc = new AMPService(makeRedis(), makeNeo4j(), availableEmbedding(), makeConfig({ readonly: true }));
    await expect(svc.store(baseInput())).rejects.toThrow(/read-only mode/i);
  });

  it('allows store() when not read-only', async () => {
    const svc = new AMPService(makeRedis(), makeNeo4j(), availableEmbedding(), makeConfig());
    const res = await svc.store(baseInput());
    expect(res.duplicate).toBe(false);
    expect(res.id).toBeTruthy();
  });
});

describe('AMPService secret redaction on ingest', () => {
  it('redacts secrets in content before persistence when redactOnIngest=true', async () => {
    const create = vi.fn().mockResolvedValue('ep-1');
    const svc = new AMPService(makeRedis(), makeNeo4j(create), availableEmbedding(), makeConfig({ redactOnIngest: true }));
    await svc.store(baseInput({ content: 'deploy key sk-abcdEFGH1234567890 used here' }));
    const node = create.mock.calls[0][0] as EpisodicNode;
    expect(node.content).toBe('deploy key [REDACTED] used here');
    expect(node.content).not.toContain('sk-abcd');
  });

  it('does NOT redact when redactOnIngest is off (default)', async () => {
    const create = vi.fn().mockResolvedValue('ep-1');
    const svc = new AMPService(makeRedis(), makeNeo4j(create), availableEmbedding(), makeConfig());
    await svc.store(baseInput({ content: 'token sk-abcdEFGH1234567890' }));
    const node = create.mock.calls[0][0] as EpisodicNode;
    expect(node.content).toContain('sk-abcdEFGH1234567890');
  });
});

describe('AMPService audit trail', () => {
  it('appends an audit entry on store with the acting agent', async () => {
    const audit = { append: vi.fn().mockResolvedValue(undefined) };
    const svc = new AMPService(makeRedis(), makeNeo4j(), availableEmbedding(), makeConfig(), undefined, audit);
    await svc.store(baseInput({ agent_id: 'alice' }));
    // audit append is fire-and-forget; allow the microtask to flush.
    await new Promise((r) => setTimeout(r, 5));
    expect(audit.append).toHaveBeenCalledTimes(1);
    const entry = audit.append.mock.calls[0][0];
    expect(entry).toMatchObject({ actor: 'alice', action: 'store', scope: 'project:test' });
  });
});

describe('AMPService no-embedding load (no random context)', () => {
  it('skips vector search when embeddings are unavailable', async () => {
    const byScope = vi.fn().mockResolvedValue([]);
    const neo4j = makeNeo4j(undefined, byScope);
    const svc = new AMPService(makeRedis(), neo4j, disabledEmbedding(), makeConfig());
    await svc.load({ task: 'find the parser', tags: ['project:test'], max_tokens: 2000 });
    expect(neo4j.query.byVector).not.toHaveBeenCalled();
    expect(byScope).toHaveBeenCalled(); // scoped retrieval still runs
  });

  it('DOES use vector search when embeddings are available (control)', async () => {
    const neo4j = makeNeo4j();
    const svc = new AMPService(makeRedis(), neo4j, availableEmbedding(), makeConfig());
    await svc.load({ task: 'find the parser', tags: ['project:test'], max_tokens: 2000 });
    expect(neo4j.query.byVector).toHaveBeenCalled();
  });
});

describe('AMPService durable extraction', () => {
  it('enqueues an extraction job when a durable queue is configured', async () => {
    const enqueue = vi.fn().mockResolvedValue('m1');
    const redis = { ...makeRedis(), extraction: { enqueue } };
    // neo4j with a fact layer so the extraction branch is taken
    const neo4j = makeNeo4j();
    (neo4j as any).fact = { getActive: vi.fn().mockResolvedValue([]) };
    const svc = new AMPService(redis, neo4j, availableEmbedding(), makeConfig());

    await svc.store(baseInput({ content: 'auth uses JWT' }));
    // enqueue is fire-and-forget; let the microtask flush.
    await new Promise((r) => setTimeout(r, 5));

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0]).toMatchObject({ content: 'auth uses JWT' });
    expect(enqueue.mock.calls[0][0].episodeId).toBeTruthy();
  });
});

describe('AMPService tenant isolation (wiring)', () => {
  it('stamps the episode with the tenant on write (defaults to "default")', async () => {
    const create = vi.fn().mockResolvedValue('ep-1');
    const svcDefault = new AMPService(makeRedis(), makeNeo4j(create), availableEmbedding(), makeConfig());
    await svcDefault.store(baseInput());
    expect((create.mock.calls[0][0] as EpisodicNode).tenant_id).toBe('default');

    const create2 = vi.fn().mockResolvedValue('ep-2');
    const svcAcme = new AMPService(makeRedis(), makeNeo4j(create2), availableEmbedding(), makeConfig());
    await svcAcme.store(baseInput({ tenantId: 'acme' }));
    expect((create2.mock.calls[0][0] as EpisodicNode).tenant_id).toBe('acme');
  });

  it('passes the tenant into both scoped and vector retrieval on load', async () => {
    const byScope = vi.fn().mockResolvedValue([]);
    const neo4j = makeNeo4j(undefined, byScope);
    const svc = new AMPService(makeRedis(), neo4j, availableEmbedding(), makeConfig());
    await svc.load({ task: 'x', tags: ['project:test'], max_tokens: 2000, tenantId: 'acme' });
    expect(byScope.mock.calls[0][0].tenantId).toBe('acme');
    // byVector(embedding, limit, tenantId) — tenant is the 3rd arg
    expect((neo4j.query.byVector as any).mock.calls[0][2]).toBe('acme');
  });
});

describe('AMPService project scope isolation', () => {
  it('propagates the project tag to the scoped query', async () => {
    const byScope = vi.fn().mockResolvedValue([]);
    const neo4j = makeNeo4j(undefined, byScope);
    const svc = new AMPService(makeRedis(), neo4j, availableEmbedding(), makeConfig());
    await svc.load({ task: 'x', tags: ['project:alpha'], max_tokens: 1000 });
    const scopeArg = byScope.mock.calls[0][0];
    expect(scopeArg.tags).toContain('project:alpha');
  });
});

describe('AMPService project Entity bootstrap (C13: no acknowledged-but-orphaned store)', () => {
  // listProjectNames in makeNeo4j() knows only 'test', so 'project:newproj' takes the
  // auto-placeholder path every time (fresh service => fresh knownProjectsCache).
  const newProjectInput = () => baseInput({ tags: ['project:newproj'] });

  it('fails the store with a value-free error and writes nothing when upsertProject rejects twice', async () => {
    const create = vi.fn().mockResolvedValue('ep-1');
    const redis = makeRedis();
    const neo4j = makeNeo4j(create);
    (neo4j.entity!.upsertProject as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Neo4j down: bolt://secret-host'));
    const svc = new AMPService(redis, neo4j, availableEmbedding(), makeConfig());

    await expect(svc.store(newProjectInput())).rejects.toThrow(/^project_entity_unavailable$/);
    expect(neo4j.entity!.upsertProject).toHaveBeenCalledTimes(2);
    expect(create).not.toHaveBeenCalled();
    // Dedup marker released so a retry of the same content is not swallowed as a duplicate.
    expect(redis.dedup.unmark).toHaveBeenCalledTimes(1);
  });

  it('succeeds when upsertProject rejects once then resolves (retried exactly once)', async () => {
    const create = vi.fn().mockResolvedValue('ep-1');
    const neo4j = makeNeo4j(create);
    (neo4j.entity!.upsertProject as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce(undefined);
    const svc = new AMPService(makeRedis(), neo4j, availableEmbedding(), makeConfig());

    const res = await svc.store(newProjectInput());
    expect(res.id).toBeTruthy();
    expect(res.duplicate).toBe(false);
    expect(neo4j.entity!.upsertProject).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(1);
    expect((create.mock.calls[0][0] as EpisodicNode).tags).toContain('project:newproj');
  });

  it('keeps storing when no entity store is wired (test doubles / legacy layers)', async () => {
    const create = vi.fn().mockResolvedValue('ep-1');
    const neo4j = makeNeo4j(create);
    delete (neo4j as { entity?: unknown }).entity;
    const svc = new AMPService(makeRedis(), neo4j, availableEmbedding(), makeConfig());

    const res = await svc.store(newProjectInput());
    expect(res.id).toBeTruthy();
    expect(create).toHaveBeenCalledTimes(1);
    expect((create.mock.calls[0][0] as EpisodicNode).tags).toContain('project:newproj');
  });
});
