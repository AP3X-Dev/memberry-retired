// packages/wiki/src/__tests__/queries.test.ts
// Tests for query helper functions (pure logic, no Neo4j needed).

import { describe, it, expect, vi } from 'vitest';
import { extractProjectScope } from '../queries.js';
import type { Driver, Session, Result } from 'neo4j-driver';

// ─── extractProjectScope ────────────────────────────────────────────────────

describe('extractProjectScope', () => {
  it('extracts project name from task prefix', () => {
    expect(extractProjectScope('[project:mars-fps] Fix enemy AI')).toBe('mars-fps');
  });

  it('extracts multi-word project names', () => {
    expect(extractProjectScope('[project:agent-assist] Update prompts')).toBe('agent-assist');
  });

  it('extracts simple project names', () => {
    expect(extractProjectScope('[project:amp] Add wiki tests')).toBe('amp');
  });

  it('returns null when no project prefix exists', () => {
    expect(extractProjectScope('Fix a bug in the code')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractProjectScope('')).toBeNull();
  });

  it('returns null when prefix is not at start', () => {
    expect(extractProjectScope('Task: [project:amp] something')).toBeNull();
  });

  it('handles project names with numbers', () => {
    expect(extractProjectScope('[project:v2-api] Deploy')).toBe('v2-api');
  });

  it('extracts only up to the closing bracket', () => {
    expect(extractProjectScope('[project:my-app] [project:other] task')).toBe('my-app');
  });
});

// ─── Mock helpers for query function tests ──────────────────────────────────

function mockRecord(data: Record<string, unknown>) {
  return {
    get(key: string) { return data[key]; },
    keys: Object.keys(data),
  };
}

function mockResult(records: ReturnType<typeof mockRecord>[] = []): Result {
  return { records } as unknown as Result;
}

// ─── Query function tests with mocked driver ───────────────────────────────

describe('fetchAllProjects', () => {
  it('returns EntityInfo array from project entities', async () => {
    const { fetchAllProjects } = await import('../queries.js');

    const mockSession = {
      run: vi.fn(async () => mockResult([
        mockRecord({
          id: 'ent-1',
          name: 'mars-fps',
          type: 'project',
          description: 'A space shooter',
          aliases: ['mars'],
          created_at: '2026-01-01T00:00:00Z',
        }),
        mockRecord({
          id: 'ent-2',
          name: 'amp',
          type: 'project',
          description: 'Agent memory',
          aliases: null,
          created_at: '2026-02-01T00:00:00Z',
        }),
      ])),
      close: vi.fn(async () => {}),
    } as unknown as Session;

    const driver = { session: vi.fn(() => mockSession) } as unknown as Driver;

    const projects = await fetchAllProjects(driver);

    expect(projects).toHaveLength(2);
    expect(projects[0].name).toBe('mars-fps');
    expect(projects[0].slug).toBe('mars-fps');
    expect(projects[0].type).toBe('project');
    expect(projects[1].name).toBe('amp');
    expect(projects[1].slug).toBe('amp');
  });
});

describe('fetchGraphStats', () => {
  it('returns counts keyed by label', async () => {
    const { fetchGraphStats } = await import('../queries.js');

    const mockSession = {
      run: vi.fn(async () => mockResult([
        mockRecord({ label: 'Entity', cnt: 20 }),
        mockRecord({ label: 'Fact', cnt: 99 }),
        mockRecord({ label: 'Semantic', cnt: 4 }),
        mockRecord({ label: 'Episodic', cnt: 219 }),
        mockRecord({ label: 'Source', cnt: 0 }),
      ])),
      close: vi.fn(async () => {}),
    } as unknown as Session;

    const driver = { session: vi.fn(() => mockSession) } as unknown as Driver;

    const stats = await fetchGraphStats(driver);

    expect(stats.total_entities).toBe(20);
    expect(stats.total_facts).toBe(99);
    expect(stats.total_semantics).toBe(4);
    expect(stats.total_episodics).toBe(219);
    expect(stats.total_sources).toBe(0);
  });

  it('returns zeros when graph is empty', async () => {
    const { fetchGraphStats } = await import('../queries.js');

    const mockSession = {
      run: vi.fn(async () => mockResult([])),
      close: vi.fn(async () => {}),
    } as unknown as Session;

    const driver = { session: vi.fn(() => mockSession) } as unknown as Driver;

    const stats = await fetchGraphStats(driver);

    expect(stats.total_entities).toBe(0);
    expect(stats.total_facts).toBe(0);
    expect(stats.total_semantics).toBe(0);
    expect(stats.total_episodics).toBe(0);
    expect(stats.total_sources).toBe(0);
  });
});

describe('fetchEpisodicProjectScopes', () => {
  it('returns project scopes from episodic task prefixes', async () => {
    const { fetchEpisodicProjectScopes } = await import('../queries.js');

    const mockSession = {
      run: vi.fn(async () => mockResult([
        mockRecord({ proj: 'agent-assist' }),
        mockRecord({ proj: 'client-portal' }),
      ])),
      close: vi.fn(async () => {}),
    } as unknown as Session;

    const driver = { session: vi.fn(() => mockSession) } as unknown as Driver;

    const scopes = await fetchEpisodicProjectScopes(driver);

    expect(scopes).toEqual(['agent-assist', 'client-portal']);
  });

  // gap-13: scopes are also discovered from the structured ep.scope / ep.tags,
  // not only the legacy task-prefix split.
  it('discovers scopes from structured ep.scope and ep.tags as well as the task prefix', async () => {
    const { fetchEpisodicProjectScopes } = await import('../queries.js');

    const mockSession = {
      run: vi.fn(async () => mockResult([])),
      close: vi.fn(async () => {}),
    } as unknown as Session;
    const driver = { session: vi.fn(() => mockSession) } as unknown as Driver;

    await fetchEpisodicProjectScopes(driver);

    const cypher = (mockSession.run as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    // structured scope: strip the 'project:' prefix (8 chars) from ep.scope
    expect(cypher).toContain("ep.scope STARTS WITH 'project:'");
    expect(cypher).toContain('substring(ep.scope, 8)');
    // structured tags: every 'project:*' tag contributes a bare name
    expect(cypher).toContain("[t IN coalesce(ep.tags, []) WHERE t STARTS WITH 'project:' | substring(t, 8)]");
    // FALLBACK: legacy task-prefix split is retained
    expect(cypher).toContain("ep.task STARTS WITH '[project:'");
    // Semantic-only projects must also become virtual wiki projects. Both the
    // canonical s.scope property and project:* tags are valid scope sources.
    expect(cypher).toContain('MATCH (s:Semantic)');
    expect(cypher).toContain("s.scope IS NOT NULL AND s.scope STARTS WITH 'project:'");
    expect(cypher).toContain("[t IN coalesce(s.tags, []) WHERE t STARTS WITH 'project:' | substring(t, 8)]");
    // existing "no project Entity yet" filter preserved
    expect(cypher).toContain("OPTIONAL MATCH (e:Entity {type: 'project'})");
    expect(cypher).toContain('WITH proj WHERE e IS NULL');
  });
});

describe('semantic scope attribution', () => {
  it('surfaces s.scope from all-semantic queries', async () => {
    const { fetchAllSemantics } = await import('../queries.js');
    const mockSession = {
      run: vi.fn(async () => mockResult([mockRecord({
        id: 'sem-scoped',
        content: 'Scoped independently of tags',
        confidence: 0.8,
        tags: ['architecture'],
        scope: 'project:memberry',
        entities: [],
      })])),
      close: vi.fn(async () => {}),
    } as unknown as Session;

    const semantics = await fetchAllSemantics({ session: vi.fn(() => mockSession) } as unknown as Driver);

    expect(semantics[0].scope).toBe('project:memberry');
    const cypher = (mockSession.run as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(cypher).toContain('s.scope AS scope');
    expect(cypher).toContain('NOT EXISTS { MATCH (:Semantic)-[:SUPERSEDES]->(s) }');
    expect(cypher).toContain('[about:ABOUT]');
    expect(cypher).toContain('about.invalid_at IS NULL');
  });

  it('surfaces s.scope from entity-semantic queries', async () => {
    const { fetchSemanticsForEntity } = await import('../queries.js');
    const mockSession = {
      run: vi.fn(async () => mockResult([mockRecord({
        id: 'sem-entity-scoped',
        content: 'Entity claim',
        confidence: 0.8,
        tags: [],
        scope: 'project:memberry',
        updated_at: '2026-08-14T00:00:00Z',
        entity_refs: [],
      })])),
      close: vi.fn(async () => {}),
    } as unknown as Session;

    const semantics = await fetchSemanticsForEntity(
      { session: vi.fn(() => mockSession) } as unknown as Driver,
      'memberry',
    );

    expect(semantics[0].scope).toBe('project:memberry');
    const cypher = (mockSession.run as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(cypher).toContain('s.scope AS scope');
    expect(cypher).toContain('NOT EXISTS { MATCH (:Semantic)-[:SUPERSEDES]->(s) }');
    expect(cypher).toContain('about.invalid_at IS NULL');
    expect(cypher).toContain('otherAbout.invalid_at IS NULL');
  });

  it('counts only active semantics linked by active ABOUT edges', async () => {
    const { fetchSemanticCountForEntity } = await import('../queries.js');
    const mockSession = {
      run: vi.fn(async () => mockResult([mockRecord({ cnt: 2 })])),
      close: vi.fn(async () => {}),
    } as unknown as Session;

    expect(await fetchSemanticCountForEntity(
      { session: vi.fn(() => mockSession) } as unknown as Driver,
      'memberry',
    )).toBe(2);

    const cypher = (mockSession.run as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(cypher).toContain('NOT EXISTS { MATCH (:Semantic)-[:SUPERSEDES]->(s) }');
    expect(cypher).toContain('[about:ABOUT]');
    expect(cypher).toContain('about.invalid_at IS NULL');
  });
});

// ─── gap-13: structured scope/tags WHERE + RETURN (pinned query text) ─────────

describe('fetchEpisodicsForProject (gap-13 structured scope)', () => {
  it('matches episodes by ep.scope, ep.tags, OR the task-prefix fallback', async () => {
    const { fetchEpisodicsForProject } = await import('../queries.js');

    const mockSession = {
      run: vi.fn(async () => mockResult([])),
      close: vi.fn(async () => {}),
    } as unknown as Session;
    const driver = { session: vi.fn(() => mockSession) } as unknown as Driver;

    await fetchEpisodicsForProject(driver, 'agent-assist-cr');

    const call = (mockSession.run as ReturnType<typeof vi.fn>).mock.calls[0];
    const cypher = call[0] as string;
    const params = call[1] as { canonTag: string; taskTag: string };

    // WHERE now matches structured scope/tags PLUS the task-prefix fallback.
    expect(cypher).toContain('ep.scope = $canonTag OR $canonTag IN ep.tags OR ep.task CONTAINS $taskTag');
    // RETURN surfaces the structured fields for compile.ts.
    expect(cypher).toContain('ep.scope AS scope, ep.tags AS tags');
    // canonTag is the project tag lowercased to match berry_store (NOT slugified);
    // taskTag is the legacy bracketed prefix used for back-compat.
    expect(params.canonTag).toBe('project:agent-assist-cr');
    expect(params.taskTag).toBe('[project:agent-assist-cr]');
  });

  it('surfaces ep.scope and ep.tags onto each returned EpisodicEntry', async () => {
    const { fetchEpisodicsForProject } = await import('../queries.js');

    const mockSession = {
      run: vi.fn(async () => mockResult([
        mockRecord({
          id: 'ep-1',
          task: 'did a thing',
          content: 'no prefix here',
          outcome: 'approved',
          session_id: 'sess-1',
          created_at: '2026-04-09T12:00:00Z',
          scope: 'project:agent-assist-cr',
          tags: ['project:agent-assist-cr'],
        }),
      ])),
      close: vi.fn(async () => {}),
    } as unknown as Session;
    const driver = { session: vi.fn(() => mockSession) } as unknown as Driver;

    const episodes = await fetchEpisodicsForProject(driver, 'agent-assist-cr');

    expect(episodes).toHaveLength(1);
    expect(episodes[0].scope).toBe('project:agent-assist-cr');
    expect(episodes[0].tags).toEqual(['project:agent-assist-cr']);
    expect(episodes[0].project_scope).toBe('agent-assist-cr');
  });
});

describe('fetchEntitiesModifiedByProject (gap-13 structured scope)', () => {
  it('matches MODIFIED episodes by ep.scope, ep.tags, OR the task-prefix fallback', async () => {
    const { fetchEntitiesModifiedByProject } = await import('../queries.js');

    const mockSession = {
      run: vi.fn(async () => mockResult([])),
      close: vi.fn(async () => {}),
    } as unknown as Session;
    const driver = { session: vi.fn(() => mockSession) } as unknown as Driver;

    await fetchEntitiesModifiedByProject(driver, 'agent-assist-cr');

    const call = (mockSession.run as ReturnType<typeof vi.fn>).mock.calls[0];
    const cypher = call[0] as string;
    const params = call[1] as { canonTag: string; taskTag: string };

    expect(cypher).toContain('(ep:Episodic)-[:MODIFIED]->(e:Entity)');
    expect(cypher).toContain('ep.scope = $canonTag OR $canonTag IN ep.tags OR ep.task CONTAINS $taskTag');
    expect(params.canonTag).toBe('project:agent-assist-cr');
    expect(params.taskTag).toBe('[project:agent-assist-cr]');
  });
});

describe('fetchAllTags', () => {
  it('returns tag list with counts', async () => {
    const { fetchAllTags } = await import('../queries.js');

    const mockSession = {
      run: vi.fn(async () => mockResult([
        mockRecord({ tag: 'architecture', count: 8, projects: [] }),
        mockRecord({ tag: 'api-design', count: 3, projects: [] }),
      ])),
      close: vi.fn(async () => {}),
    } as unknown as Session;

    const driver = { session: vi.fn(() => mockSession) } as unknown as Driver;

    const tags = await fetchAllTags(driver);

    expect(tags).toHaveLength(2);
    expect(tags[0].tag).toBe('architecture');
    expect(tags[0].count).toBe(8);
  });
});

describe('fetchEpisodicsForEntities (batched single-scan)', () => {
  it('scans :Episodic once for many entities and groups rows per entity', async () => {
    const { fetchEpisodicsForEntities } = await import('../queries.js');

    // One UNWIND scan returns rows for two entities, each tagged with stable ID.
    const mockSession = {
      run: vi.fn(async () => mockResult([
        mockRecord({
          entity_id: 'ent-auth',
          name: 'auth-module',
          id: 'ep-1',
          task: '[project:amp] Harden auth-module',
          content: 'Fixed token refresh in auth-module',
          outcome: 'approved',
          session_id: 'sess-1',
          created_at: '2026-04-09T12:00:00Z',
        }),
        mockRecord({
          entity_id: 'ent-auth',
          name: 'auth-module',
          id: 'ep-2',
          task: 'General auth-module review',
          content: 'Reviewed auth-module flows',
          outcome: null,
          session_id: 'sess-2',
          created_at: '2026-04-08T12:00:00Z',
        }),
        mockRecord({
          entity_id: 'ent-wiki',
          name: 'wiki',
          id: 'ep-3',
          task: '[project:amp] wiki compile perf',
          content: 'Batched wiki episodic scan',
          outcome: 'approved',
          session_id: 'sess-3',
          created_at: '2026-04-07T12:00:00Z',
        }),
      ])),
      close: vi.fn(async () => {}),
    } as unknown as Session;

    const driver = { session: vi.fn(() => mockSession) } as unknown as Driver;

    const grouped = await fetchEpisodicsForEntities(driver, [
      { id: 'ent-auth', name: 'auth-module' },
      { id: 'ent-wiki', name: 'wiki' },
    ], 'amp');

    // ONE label scan for the whole batch, not one per entity.
    expect((mockSession.run as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);

    // Same per-entity episodics + same project_scope extraction as the
    // per-entity fetchEpisodicsForEntity would have returned.
    expect(grouped.get('ent-auth')?.map((e) => e.id)).toEqual(['ep-1', 'ep-2']);
    expect(grouped.get('ent-auth')?.[0].project_scope).toBe('amp');
    expect(grouped.get('ent-auth')?.[1].project_scope).toBeNull();
    expect(grouped.get('ent-wiki')?.map((e) => e.id)).toEqual(['ep-3']);
    expect(grouped.get('ent-wiki')?.[0].project_scope).toBe('amp');
  });

  it('preserves the per-entity ORDER/LIMIT contract in the Cypher (CALL{} subquery)', async () => {
    const { fetchEpisodicsForEntities } = await import('../queries.js');

    const mockSession = {
      run: vi.fn(async () => mockResult([])),
      close: vi.fn(async () => {}),
    } as unknown as Session;
    const driver = { session: vi.fn(() => mockSession) } as unknown as Driver;

    await fetchEpisodicsForEntities(driver, [{ id: 'ent-x', name: 'x' }], 'alpha');

    const cypher = (mockSession.run as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const params = (mockSession.run as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, unknown>;
    // Single scan via UNWIND, per-name top-20 preserved inside a CALL{} subquery.
    expect(cypher).toContain('UNWIND $entities AS entity');
    expect(cypher).toContain('CALL {');
    expect(cypher).toContain('ORDER BY ep.created_at DESC');
    expect(cypher).toContain('LIMIT 20');
    expect(cypher).toContain('ep.scope = $canonTag');
    expect(cypher).toContain('$canonTag IN coalesce(ep.tags, [])');
    expect(cypher).toContain('ep.task CONTAINS entity.name OR ep.content CONTAINS entity.name');
    expect(cypher).toContain('[:MODIFIED]->(e:Entity) WHERE e.id = entity.id');
    expect(params.canonTag).toBe('project:alpha');
    expect(params.entities).toEqual([{ id: 'ent-x', name: 'x' }]);
  });

  it('returns an empty map without touching the DB for an empty name list', async () => {
    const { fetchEpisodicsForEntities } = await import('../queries.js');

    const sessionFactory = vi.fn();
    const driver = { session: sessionFactory } as unknown as Driver;

    const grouped = await fetchEpisodicsForEntities(driver, [], 'alpha');

    expect(grouped.size).toBe(0);
    expect(sessionFactory).not.toHaveBeenCalled();
  });

  it('binds alpha entity history to alpha scope and ID, excluding beta identity', async () => {
    const { fetchEpisodicsForEntities } = await import('../queries.js');
    const mockSession = {
      run: vi.fn(async () => mockResult([])),
      close: vi.fn(async () => {}),
    } as unknown as Session;
    const driver = { session: vi.fn(() => mockSession) } as unknown as Driver;

    await fetchEpisodicsForEntities(
      driver,
      [{ id: 'alpha-shared-name-id', name: 'SharedEngine' }],
      'alpha',
    );

    const [cypher, params] = (mockSession.run as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Record<string, unknown>];
    expect(params).toMatchObject({
      canonTag: 'project:alpha',
      taskTag: '[project:alpha]',
      entities: [{ id: 'alpha-shared-name-id', name: 'SharedEngine' }],
    });
    expect(JSON.stringify(params)).not.toContain('beta-shared-name-id');
    expect(cypher).toContain('[:MODIFIED]->(e:Entity) WHERE e.id = entity.id');
    expect(cypher).toContain('ep.scope = $canonTag');
  });
});

describe('fetchRecentEpisodics', () => {
  it('returns episodic entries with structured scope and tags preserved', async () => {
    const { fetchRecentEpisodics } = await import('../queries.js');

    const mockSession = {
      run: vi.fn(async () => mockResult([
        mockRecord({
          id: 'ep-1',
          task: '[project:amp] Add wiki tests',
          content: 'Added lint and ingest tests',
          outcome: 'approved',
          session_id: 'sess-1',
          created_at: '2026-04-09T12:00:00Z',
          scope: 'project:amp',
          tags: ['project:amp', 'wiki'],
        }),
        mockRecord({
          id: 'ep-2',
          task: 'General exploration',
          content: 'Explored codebase',
          outcome: null,
          session_id: 'sess-2',
          created_at: '2026-04-09T11:00:00Z',
        }),
      ])),
      close: vi.fn(async () => {}),
    } as unknown as Session;

    const driver = { session: vi.fn(() => mockSession) } as unknown as Driver;

    const episodes = await fetchRecentEpisodics(driver, 10);

    expect(episodes).toHaveLength(2);
    expect(episodes[0].project_scope).toBe('amp');
    expect(episodes[0].scope).toBe('project:amp');
    expect(episodes[0].tags).toEqual(['project:amp', 'wiki']);
    expect(episodes[1].project_scope).toBeNull();

    const cypher = (mockSession.run as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(cypher).toContain('ep.scope AS scope, ep.tags AS tags');
  });
});

// ─── Tenant predicate on every Semantic/Episodic read (audit C3) ──────────────

type RunCall = { query: string; params: Record<string, unknown> };

function recordingDriver(rows: ReturnType<typeof mockRecord>[] = []): { driver: Driver; calls: RunCall[] } {
  const calls: RunCall[] = [];
  const session = {
    run: vi.fn(async (query: string, params: Record<string, unknown> = {}) => {
      calls.push({ query, params });
      return mockResult(rows);
    }),
    close: vi.fn(async () => {}),
  } as unknown as Session;
  return { driver: { session: vi.fn(() => session) } as unknown as Driver, calls };
}

describe('tenant predicate on Semantic/Episodic reads', () => {
  const TENANT = 'tenant-a';
  const ENTITY = [{ id: 'ent-1', name: 'thing' }];
  // Every exported query that matches a Semantic or Episodic node. A new fetch
  // that touches those labels must be added here (and must carry $tenantId).
  const cases: Array<[string, (q: typeof import('../queries.js'), d: Driver) => Promise<unknown>]> = [
    ['fetchEpisodicProjectScopes', (q, d) => q.fetchEpisodicProjectScopes(d, TENANT)],
    ['fetchEntitiesModifiedByProject', (q, d) => q.fetchEntitiesModifiedByProject(d, 'p', TENANT)],
    ['fetchSemanticsForEntity', (q, d) => q.fetchSemanticsForEntity(d, 'thing', TENANT)],
    ['fetchSemanticCountForEntity', (q, d) => q.fetchSemanticCountForEntity(d, 'thing', TENANT)],
    ['fetchAllSemantics', (q, d) => q.fetchAllSemantics(d, TENANT)],
    ['fetchEpisodicsForProject', (q, d) => q.fetchEpisodicsForProject(d, 'p', TENANT)],
    ['fetchEpisodicsForEntity', (q, d) => q.fetchEpisodicsForEntity(d, 'thing', 'p', 'ent-1', TENANT)],
    ['fetchEpisodicsForEntities', (q, d) => q.fetchEpisodicsForEntities(d, ENTITY, 'p', TENANT)],
    ['fetchRecentEpisodics', (q, d) => q.fetchRecentEpisodics(d, 10, TENANT)],
    ['fetchBacklinks', (q, d) => q.fetchBacklinks(d, 'thing', TENANT)],
    ['fetchClaimsForSource', (q, d) => q.fetchClaimsForSource(d, 'src-1', TENANT)],
    ['fetchAllTags', (q, d) => q.fetchAllTags(d, TENANT)],
    ['fetchSemanticsForTag', (q, d) => q.fetchSemanticsForTag(d, 'tag', TENANT)],
    ['fetchInboundLinkCount', (q, d) => q.fetchInboundLinkCount(d, 'thing', TENANT)],
    ['fetchSourcesForEntity', (q, d) => q.fetchSourcesForEntity(d, 'thing', TENANT)],
  ];

  it.each(cases)('%s carries $tenantId on every Semantic/Episodic MATCH', async (_name, call) => {
    const queries = await import('../queries.js');
    const { driver, calls } = recordingDriver();
    await call(queries, driver);
    expect(calls.length).toBeGreaterThan(0);
    for (const { query, params } of calls) {
      const sites = (query.match(/MATCH \((s:Semantic|ep:Episodic)\)/g) ?? []).length;
      expect(sites).toBeGreaterThan(0);
      const guarded = (query.match(/\b(s|ep)\.tenant_id = \$tenantId/g) ?? []).length;
      expect(guarded).toBe(sites);
      expect(params.tenantId).toBe(TENANT);
      expect(params.defaultTenant).toBe('default');
    }
  });

  it('every exported fetch that mentions Semantic/Episodic is in the table', async () => {
    const queries = await import('../queries.js');
    const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../queries.ts', import.meta.url), 'utf8'));
    const covered = new Set(cases.map(([name]) => name));
    for (const name of Object.keys(queries).filter((k) => k.startsWith('fetch'))) {
      const body = src.slice(src.indexOf(`export async function ${name}(`));
      const end = body.indexOf('\nexport ', 1);
      const fn = end === -1 ? body : body.slice(0, end);
      if (/\((s:Semantic|ep:Episodic)\)/.test(fn)) expect(covered, `${name} missing from tenant table`).toContain(name);
    }
  });

  it('defaults to the default tenant so existing callers keep single-tenant behaviour', async () => {
    const { fetchAllSemantics } = await import('../queries.js');
    const { driver, calls } = recordingDriver();
    await fetchAllSemantics(driver);
    expect(calls[0].params).toMatchObject({ tenantId: 'default', defaultTenant: 'default' });
  });

  it('two-tenant fixture: tenant a sees rows, tenant b sees none', async () => {
    const { fetchAllSemantics, fetchEpisodicsForProject } = await import('../queries.js');
    const row = mockRecord({
      id: 'x', content: 'secret-a', confidence: 1, memory_type: null, tags: [], scope: null, entities: [],
      task: 't', outcome: null, session_id: 's', created_at: '2026-01-01',
    });
    const session = {
      run: vi.fn(async (query: string, params: Record<string, unknown> = {}) => {
        const alias = query.includes('(s:Semantic)') ? 's' : 'ep';
        const guarded = query.includes(`${alias}.tenant_id = $tenantId OR (${alias}.tenant_id IS NULL AND $tenantId = $defaultTenant)`);
        return mockResult(guarded && params.tenantId === 'a' ? [row] : []);
      }),
      close: vi.fn(async () => {}),
    } as unknown as Session;
    const driver = { session: vi.fn(() => session) } as unknown as Driver;

    expect(await fetchAllSemantics(driver, 'a')).toHaveLength(1);
    expect(await fetchAllSemantics(driver, 'b')).toHaveLength(0);
    expect(await fetchEpisodicsForProject(driver, 'p', 'a')).toHaveLength(1);
    expect(await fetchEpisodicsForProject(driver, 'p', 'b')).toHaveLength(0);
  });
});
