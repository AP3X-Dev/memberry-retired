// packages/mcp/src/__tests__/tools.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const recompileWikiNow = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../wiki-autorefresh.js', () => ({ recompileWikiNow }));

import {
  buildToolHandlers,
  setServiceInstances,
  type IAMPService,
  type IConsolidationEngine,
  type IScopedQuery,
  type IMemoryBlockService,
} from '../tools.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockAmpService: IAMPService = {
  load: vi.fn().mockResolvedValue({
    markdown: '# Memory Context\n\ntest content',
    tokens: 42,
    sources: ['id-1'],
    assembled_at: '2026-01-01T00:00:00.000Z',
  }),
  store: vi.fn().mockResolvedValue({ id: 'ep-abc123', duplicate: false }),
};

const mockConsolidationEngine: IConsolidationEngine = {
  run: vi.fn().mockResolvedValue({ proposalCount: 3 }),
  status: vi.fn().mockResolvedValue({ pending: 5, lastRun: '2026-01-01T00:00:00.000Z' }),
  review: vi.fn().mockResolvedValue({ id: 'prop-1', type: 'promote', score: 0.9 }),
  apply: vi.fn().mockResolvedValue({ applied: true }),
  dream: vi.fn().mockResolvedValue({ hypotheses_created: 0, cards_refreshed: 0 }),
};

const mockScopedQuery: IScopedQuery = {
  rawCypher: vi.fn().mockResolvedValue([{ n: { id: 'sem-1', content: 'test' } }]),
};

const mockMemoryBlockService: IMemoryBlockService = {
  read: vi.fn().mockResolvedValue({
    id: 'block-1',
    name: 'persona',
    tier: 'core',
    content: 'You are a helpful assistant.',
    scope: 'project:test',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }),
  insert: vi.fn().mockResolvedValue({
    id: 'block-1', name: 'persona', tier: 'core',
    content: 'You are a helpful assistant. And wise.',
    scope: 'project:test',
  }),
  replace: vi.fn().mockResolvedValue({
    id: 'block-1', name: 'persona', tier: 'core',
    content: 'You are a wise assistant.',
    scope: 'project:test',
  }),
  rewrite: vi.fn().mockResolvedValue({
    id: 'block-1', name: 'persona', tier: 'core',
    content: 'Completely new persona.',
    scope: 'project:test',
  }),
  promote: vi.fn().mockResolvedValue({
    id: 'block-1', name: 'working_state', tier: 'core',
    content: 'promoted content',
    scope: 'project:test',
  }),
  archive: vi.fn().mockResolvedValue('archived block content'),
};

// ─── Setup ────────────────────────────────────────────────────────────────────

const mockBootstrapService = {
  bootstrap: vi.fn().mockResolvedValue({
    entities_created: 1, entities_existing: 0,
    agents_created: 1, agents_existing: 0,
    semantics_created: 0, relationships_created: 0,
    project_entity_id: 'test-id',
  }),
  isBootstrapped: vi.fn().mockResolvedValue(false),
  status: vi.fn().mockResolvedValue({ bootstrapped: false }),
};

beforeEach(() => {
  vi.clearAllMocks();
  setServiceInstances({
    ampService: mockAmpService,
    consolidationEngine: mockConsolidationEngine,
    scopedQuery: mockScopedQuery,
    bootstrapService: mockBootstrapService,
    memoryBlockService: mockMemoryBlockService,
  });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('berry_load handler', () => {
  it('calls AMPService.load with correct scope and returns markdown', async () => {
    const handlers = buildToolHandlers();
    const result = await handlers.berry_load({
      task: 'Write brand copy',
      entities: ['ClientX'],
      tags: ['brand-voice'],
      max_tokens: 2000,
    });

    expect(mockAmpService.load).toHaveBeenCalledWith({
      task: 'Write brand copy',
      entities: ['ClientX'],
      tags: ['brand-voice'],
      max_tokens: 2000,
      temporal: undefined,
      tenantId: 'default',
    });
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('# Memory Context');
  });

  it('uses default max_tokens when not provided', async () => {
    const handlers = buildToolHandlers();
    await handlers.berry_load({ task: 'test task' });

    expect(mockAmpService.load).toHaveBeenCalledWith(
      expect.objectContaining({ max_tokens: 4000 }),
    );
  });

  it('throws when AMPService is not initialised', async () => {
    // Reset service instances
    setServiceInstances({
      ampService: null as unknown as IAMPService,
      consolidationEngine: mockConsolidationEngine,
      scopedQuery: mockScopedQuery,
    bootstrapService: mockBootstrapService,
    });
    const handlers = buildToolHandlers();
    await expect(handlers.berry_load({ task: 'test' })).rejects.toThrow('AMPService not initialised');
  });
});

describe('berry_store handler', () => {
  it('calls AMPService.store and returns id', async () => {
    const handlers = buildToolHandlers();
    const result = await handlers.berry_store({
      session_id: 'sess-1',
      task: 'Write copy',
      content: 'Some content here',
      outcome: 'approved',
      memory_type: 'decision',
    });

    expect(mockAmpService.store).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: 'sess-1',
        task: 'Write copy',
        content: 'Some content here',
        outcome: 'approved',
        memory_type: 'decision',
        agent_id: 'mcp',
      }),
    );
    expect(result.content[0].text).toContain('id:ep-abc123');
  });

  it('returns duplicate:true when store reports duplicate', async () => {
    vi.mocked(mockAmpService.store).mockResolvedValueOnce({ id: '', duplicate: true });
    const handlers = buildToolHandlers();
    const result = await handlers.berry_store({
      session_id: 'sess-1',
      task: 'test',
      content: 'duplicate content',
    });
    expect(result.content[0].text).toBe('duplicate:true');
  });

  it('passes signals to AMPService.store', async () => {
    const handlers = buildToolHandlers();
    const signals = [
      { type: 'reinforcement' as const, target_id: 'sem-1', detail: 'good tone' },
    ];
    await handlers.berry_store({
      session_id: 'sess-2',
      task: 'review',
      content: 'content',
      signals,
    });

    expect(mockAmpService.store).toHaveBeenCalledWith(
      expect.objectContaining({ signals }),
    );
  });

  it('passes project scope metadata to AMPService.store', async () => {
    const handlers = buildToolHandlers();
    await handlers.berry_store({
      session_id: 'sess-3',
      task: 'capture decision',
      content: 'content',
      tags: ['project:amp', 'hardening'],
      entities: ['entity-amp'],
      model_id: 'gpt-5',
      scope: 'project:amp',
    } as never);

    expect(mockAmpService.store).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: ['project:amp', 'hardening'],
        entities: ['entity-amp'],
        model_id: 'gpt-5',
        scope: 'project:amp',
      }),
    );
  });
});

describe('berry_query handler', () => {
  it('calls rawCypher with query and limit', async () => {
    const handlers = buildToolHandlers();
    const result = await handlers.berry_query({
      query: 'MATCH (n:Semantic) RETURN n',
      limit: 5,
    });

    expect(mockScopedQuery.rawCypher).toHaveBeenCalledWith(
      'MATCH (n:Semantic) RETURN n',
      5,
    );
    expect(result.content[0].type).toBe('text');
    const parsed = JSON.parse(result.content[0].text);
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('uses default limit of 10 when not provided', async () => {
    const handlers = buildToolHandlers();
    await handlers.berry_query({ query: 'MATCH (n) RETURN n' });
    expect(mockScopedQuery.rawCypher).toHaveBeenCalledWith(expect.any(String), 10);
  });

  it('allows read-only CALL subqueries and delegates validation to ScopedQuery', async () => {
    const handlers = buildToolHandlers();
    const query = 'CALL { MATCH (n:Semantic) RETURN n } RETURN n';

    await expect(handlers.berry_query({ query, limit: 5 })).resolves.toEqual(
      expect.objectContaining({ content: expect.any(Array) }),
    );

    expect(mockScopedQuery.rawCypher).toHaveBeenCalledWith(query, 5);
  });

  it('throws when ScopedQuery is not initialised', async () => {
    setServiceInstances({
      ampService: mockAmpService,
      consolidationEngine: mockConsolidationEngine,
      scopedQuery: null as unknown as IScopedQuery,
      bootstrapService: mockBootstrapService,
    });
    const handlers = buildToolHandlers();
    await expect(handlers.berry_query({ query: 'MATCH (n) RETURN n' })).rejects.toThrow(
      'ScopedQuery not initialised',
    );
  });
});

describe('berry_provenance handler', () => {
  const mockProvenance = {
    traceOrigin: vi.fn().mockResolvedValue([
      { id: 'amp-ep-1', label: 'Episodic', content: 'Original session where this was decided', relationship: 'PROMOTED_FROM' },
    ]),
    supersessionHistory: vi.fn().mockResolvedValue([
      { id: 'amp-sem-old', content: 'Old superseded claim', confidence: 0.42 },
    ]),
  };

  it('traces origin lineage and supersession history into markdown', async () => {
    setServiceInstances({
      ampService: mockAmpService,
      consolidationEngine: mockConsolidationEngine,
      scopedQuery: mockScopedQuery,
      bootstrapService: mockBootstrapService,
      provenance: mockProvenance,
    });
    const handlers = buildToolHandlers();
    const result = await handlers.berry_provenance({ semantic_id: 'amp-sem-xyz' });

    expect(mockProvenance.traceOrigin).toHaveBeenCalledWith('amp-sem-xyz');
    expect(mockProvenance.supersessionHistory).toHaveBeenCalledWith('amp-sem-xyz');
    const text = result.content[0].text;
    expect(text).toContain('# Provenance: amp-sem-xyz');
    expect(text).toContain('PROMOTED_FROM');
    expect(text).toContain('amp-ep-1');
    expect(text).toContain('amp-sem-old');
    expect(text).toContain('0.42');
  });

  it('renders empty-state sections when no lineage exists', async () => {
    setServiceInstances({
      ampService: mockAmpService,
      consolidationEngine: mockConsolidationEngine,
      scopedQuery: mockScopedQuery,
      bootstrapService: mockBootstrapService,
      provenance: { traceOrigin: vi.fn().mockResolvedValue([]), supersessionHistory: vi.fn().mockResolvedValue([]) },
    });
    const handlers = buildToolHandlers();
    const result = await handlers.berry_provenance({ semantic_id: 'amp-sem-root' });
    expect(result.content[0].text).toContain('No origin lineage found');
    expect(result.content[0].text).toContain('No superseded predecessors');
  });

  it('throws when ProvenanceTraversal is not initialised', async () => {
    setServiceInstances({
      ampService: mockAmpService,
      consolidationEngine: mockConsolidationEngine,
      scopedQuery: mockScopedQuery,
      bootstrapService: mockBootstrapService,
      // provenance intentionally omitted
    });
    const handlers = buildToolHandlers();
    await expect(handlers.berry_provenance({ semantic_id: 'x' })).rejects.toThrow(
      'ProvenanceTraversal not initialised',
    );
  });
});

describe('berry_resolve handler', () => {
  it('resolves entity URI correctly (calls load with entities scope)', async () => {
    const handlers = buildToolHandlers();
    const result = await handlers.berry_resolve({ uri: 'amp://entity/ClientX' });

    expect(mockAmpService.load).toHaveBeenCalledWith(
      expect.objectContaining({
        entities: ['ClientX'],
        max_tokens: 2000,
      }),
    );
    const callArgs = vi.mocked(mockAmpService.load).mock.calls[0][0];
    expect(callArgs).not.toHaveProperty('tags');
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('# Memory Context');
  });

  it('resolves tag URI correctly (calls load with tags scope)', async () => {
    const handlers = buildToolHandlers();
    await handlers.berry_resolve({ uri: 'amp://tag/brand-voice' });

    expect(mockAmpService.load).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: ['brand-voice'],
        max_tokens: 2000,
      }),
    );
    const callArgs = vi.mocked(mockAmpService.load).mock.calls[0][0];
    expect(callArgs).not.toHaveProperty('entities');
  });

  it('uses stage_context as the task parameter', async () => {
    const handlers = buildToolHandlers();
    await handlers.berry_resolve({
      uri: 'amp://entity/ClientX',
      stage_context: 'Writing brand copy for ClientX landing page',
    });

    expect(mockAmpService.load).toHaveBeenCalledWith(
      expect.objectContaining({
        task: 'Writing brand copy for ClientX landing page',
      }),
    );
  });

  it('synthesizes a default task when stage_context is omitted', async () => {
    const handlers = buildToolHandlers();
    await handlers.berry_resolve({ uri: 'amp://entity/ClientX' });

    expect(mockAmpService.load).toHaveBeenCalledWith(
      expect.objectContaining({
        task: 'Resolve amp://entity/ClientX',
      }),
    );
  });

  it('throws on invalid URI', async () => {
    const handlers = buildToolHandlers();
    await expect(handlers.berry_resolve({ uri: 'not-an-amp-uri' })).rejects.toThrow(
      'Invalid MemBerry URI',
    );
  });

  it('throws when AMPService is not initialised', async () => {
    setServiceInstances({
      ampService: null as unknown as IAMPService,
      consolidationEngine: mockConsolidationEngine,
      scopedQuery: mockScopedQuery,
    bootstrapService: mockBootstrapService,
    });
    const handlers = buildToolHandlers();
    await expect(handlers.berry_resolve({ uri: 'amp://entity/ClientX' })).rejects.toThrow(
      'AMPService not initialised',
    );
  });
});

describe('berry_consolidate handler', () => {
  it('calls run action correctly', async () => {
    const handlers = buildToolHandlers();
    const result = await handlers.berry_consolidate({ action: 'run', scope: 'ClientX' });

    expect(mockConsolidationEngine.run).toHaveBeenCalledWith('ClientX');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.proposalCount).toBe(3);
  });

  it('calls run without scope — defaults to global', async () => {
    const handlers = buildToolHandlers();
    await handlers.berry_consolidate({ action: 'run' });
    expect(mockConsolidationEngine.run).toHaveBeenCalledWith('global');
  });

  it('recompiles the wiki after a run applies graph mutations', async () => {
    vi.mocked(mockConsolidationEngine.run).mockResolvedValueOnce({
      skipped: false,
      proposals: [],
      applied: ['prop-1'],
    });
    const handlers = buildToolHandlers();

    await handlers.berry_consolidate({ action: 'run', scope: 'project:test' });

    expect(recompileWikiNow).toHaveBeenCalledOnce();
  });

  it('does not request a wiki recompile after a run applies nothing', async () => {
    vi.mocked(mockConsolidationEngine.run).mockResolvedValueOnce({
      skipped: false,
      proposals: [],
      applied: [],
    });
    const handlers = buildToolHandlers();

    await handlers.berry_consolidate({ action: 'run', scope: 'project:test' });

    expect(recompileWikiNow).not.toHaveBeenCalled();
  });

  it('calls status action correctly', async () => {
    const handlers = buildToolHandlers();
    const result = await handlers.berry_consolidate({ action: 'status' });

    expect(mockConsolidationEngine.status).toHaveBeenCalled();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.pending).toBe(5);
  });

  it('calls review action to fetch a proposal', async () => {
    const handlers = buildToolHandlers();
    const result = await handlers.berry_consolidate({
      action: 'review',
      proposal_id: 'prop-1',
    });

    expect(mockConsolidationEngine.review).toHaveBeenCalledWith('prop-1');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.id).toBe('prop-1');
  });

  it('calls review action with decision to apply', async () => {
    const handlers = buildToolHandlers();
    const result = await handlers.berry_consolidate({
      action: 'review',
      proposal_id: 'prop-1',
      decision: 'approve',
    });

    expect(mockConsolidationEngine.apply).toHaveBeenCalledWith('prop-1', 'approve');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.applied).toBe(true);
    expect(recompileWikiNow).toHaveBeenCalledOnce();
  });

  it('does not request a wiki recompile when review rejects a proposal', async () => {
    vi.mocked(mockConsolidationEngine.apply).mockResolvedValueOnce({ applied: false });
    const handlers = buildToolHandlers();

    await handlers.berry_consolidate({
      action: 'review',
      proposal_id: 'prop-1',
      decision: 'reject',
    });

    expect(recompileWikiNow).not.toHaveBeenCalled();
  });

  it('recompiles the wiki after dream creates hypotheses', async () => {
    vi.mocked(mockConsolidationEngine.dream!).mockResolvedValueOnce({
      hypotheses_created: 2,
      cards_refreshed: 0,
    });
    const handlers = buildToolHandlers();

    await handlers.berry_consolidate({ action: 'dream', scope: 'project:test' });

    expect(recompileWikiNow).toHaveBeenCalledOnce();
  });

  it('throws when review action is missing proposal_id', async () => {
    const handlers = buildToolHandlers();
    await expect(
      handlers.berry_consolidate({ action: 'review' }),
    ).rejects.toThrow('"proposal_id" is required');
  });

  it('throws when ConsolidationEngine is not initialised', async () => {
    setServiceInstances({
      ampService: mockAmpService,
      consolidationEngine: null as unknown as IConsolidationEngine,
      scopedQuery: mockScopedQuery,
      bootstrapService: mockBootstrapService,
    });
    const handlers = buildToolHandlers();
    await expect(handlers.berry_consolidate({ action: 'status' })).rejects.toThrow(
      'ConsolidationEngine not initialised',
    );
  });
});

// ─── Memory block tools ────────────────────────────────────────────────────

describe('berry_memory_read handler', () => {
  it('reads a block and returns JSON', async () => {
    const handlers = buildToolHandlers();
    const result = await handlers.berry_memory_read({ block: 'persona', scope: 'project:test' });
    expect(mockMemoryBlockService.read).toHaveBeenCalledWith('project:test', 'persona', undefined, 'default');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.name).toBe('persona');
    expect(parsed.content).toBe('You are a helpful assistant.');
  });

  it('returns found:false when block does not exist', async () => {
    vi.mocked(mockMemoryBlockService.read).mockResolvedValueOnce(null);
    const handlers = buildToolHandlers();
    const result = await handlers.berry_memory_read({ block: 'nonexistent' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.found).toBe(false);
  });

  it('uses default scope when not provided', async () => {
    const handlers = buildToolHandlers();
    await handlers.berry_memory_read({ block: 'persona' });
    expect(mockMemoryBlockService.read).toHaveBeenCalledWith('default', 'persona', undefined, 'default');
  });

  it('passes session_id for working blocks', async () => {
    const handlers = buildToolHandlers();
    await handlers.berry_memory_read({ block: 'working_state', scope: 'project:test', session_id: 'sess-1' });
    expect(mockMemoryBlockService.read).toHaveBeenCalledWith('project:test', 'working_state', 'sess-1', 'default');
  });
});

describe('berry_memory_insert handler', () => {
  it('inserts text and returns result', async () => {
    const handlers = buildToolHandlers();
    const result = await handlers.berry_memory_insert({
      block: 'persona',
      text: ' And wise.',
      scope: 'project:test',
    });
    expect(mockMemoryBlockService.insert).toHaveBeenCalledWith('project:test', 'persona', ' And wise.', undefined, 'default');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.block).toBe('persona');
  });
});

describe('berry_memory_replace handler', () => {
  it('replaces text and returns result', async () => {
    const handlers = buildToolHandlers();
    const result = await handlers.berry_memory_replace({
      block: 'persona',
      old_text: 'helpful',
      new_text: 'wise',
      scope: 'project:test',
    });
    expect(mockMemoryBlockService.replace).toHaveBeenCalledWith('project:test', 'persona', 'helpful', 'wise', undefined, 'default');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
  });
});

describe('berry_memory_rewrite handler', () => {
  it('rewrites block and returns result', async () => {
    const handlers = buildToolHandlers();
    const result = await handlers.berry_memory_rewrite({
      block: 'persona',
      content: 'Completely new persona.',
      scope: 'project:test',
    });
    expect(mockMemoryBlockService.rewrite).toHaveBeenCalledWith('project:test', 'persona', 'Completely new persona.', undefined, 'default');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.block).toBe('persona');
  });
});

describe('berry_memory_promote handler', () => {
  it('promotes block tier and returns result', async () => {
    const handlers = buildToolHandlers();
    const result = await handlers.berry_memory_promote({
      block: 'working_state',
      from_tier: 'working',
      to_tier: 'core',
      scope: 'project:test',
    });
    expect(mockMemoryBlockService.promote).toHaveBeenCalledWith('project:test', 'working_state', 'working', 'core', undefined, 'default');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.tier).toBe('core');
  });
});

describe('berry_memory_archive handler', () => {
  it('archives block and returns content length', async () => {
    const handlers = buildToolHandlers();
    const result = await handlers.berry_memory_archive({
      block: 'persona',
      scope: 'project:test',
    });
    expect(mockMemoryBlockService.archive).toHaveBeenCalledWith('project:test', 'persona', undefined, 'default');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.archived_length).toBe('archived block content'.length);
  });
});

describe('memory block tools throw when service not initialised', () => {
  it('berry_memory_read throws', async () => {
    setServiceInstances({
      ampService: mockAmpService,
      consolidationEngine: mockConsolidationEngine,
      scopedQuery: mockScopedQuery,
      bootstrapService: mockBootstrapService,
      // memoryBlockService omitted
    });
    const handlers = buildToolHandlers();
    await expect(handlers.berry_memory_read({ block: 'persona' })).rejects.toThrow('MemoryBlockService not initialised');
  });
});

// ─── berry_grep tests ─────────────────────────────────────────────────────────

describe('berry_grep handler', () => {
  it('performs exact string match across node types and returns markdown', async () => {
    // Mock rawCypher to return results for different node types
    const mockResults = {
      episodic: [{ e: { id: 'ep-1', content: 'We decided to use JWT tokens for auth', task: '[project:amp] refactor auth', created_at: '2026-04-05T00:00:00Z' } }],
      semantic: [{ s: { id: 'sem-1', content: 'Auth module uses JWT for stateless authentication', confidence: 0.85 } }],
      fact: [{ f: { id: 'fact-1', subject: 'auth-module', predicate: 'uses', object: 'JWT', status: 'active', valid_at: '2026-03-15', updated_at: '2026-04-01' } }],
      block: [{ b: { scope: 'project:amp', name: 'project_state', content: 'current auth uses JWT tokens', tier: 'core', updated_at: '2026-04-01' } }],
      entity: [{ ent: { id: 'ent-1', name: 'JWT', description: 'JSON Web Token standard', type: 'concept' } }],
    };

    let callIndex = 0;
    vi.mocked(mockScopedQuery.rawCypher).mockImplementation(async (cypher: string) => {
      if (cypher.includes('Episodic')) return mockResults.episodic;
      if (cypher.includes('Semantic')) return mockResults.semantic;
      if (cypher.includes('Fact')) return mockResults.fact;
      if (cypher.includes('MemoryBlock')) return mockResults.block;
      if (cypher.includes('Entity')) return mockResults.entity;
      return [];
    });

    const handlers = buildToolHandlers();
    const result = await handlers.berry_grep({ pattern: 'JWT' });

    expect(result.content[0].type).toBe('text');
    const text = result.content[0].text;
    expect(text).toContain('## Grep Results: "JWT"');
    expect(text).toContain('5 matches');
    expect(text).toContain('### Entities');
    expect(text).toContain('### Semantic');
    expect(text).toContain('### Facts');
    expect(text).toContain('### Episodic');
    expect(text).toContain('### Blocks');
    expect(text).toContain('**JWT**');
  });

  it('supports regex matching', async () => {
    vi.mocked(mockScopedQuery.rawCypher).mockImplementation(async (cypher: string) => {
      // Check that the regex pattern is used in the query
      if (cypher.includes('=~') && cypher.includes('Semantic')) {
        return [{ s: { id: 'sem-1', content: 'Uses JWT or OAuth2 for auth', confidence: 0.7 } }];
      }
      return [];
    });

    const handlers = buildToolHandlers();
    const result = await handlers.berry_grep({ pattern: 'JWT|OAuth2', regex: true });

    const text = result.content[0].text;
    expect(text).toContain('## Grep Results: "JWT|OAuth2"');
    expect(text).toContain('1 match');
  });

  it('returns error for invalid regex', async () => {
    const handlers = buildToolHandlers();
    const result = await handlers.berry_grep({ pattern: '[invalid', regex: true });

    const text = result.content[0].text;
    expect(text).toContain('**Error:**');
    expect(text).toContain('Invalid regular expression');
  });

  it('supports case-sensitive matching', async () => {
    vi.mocked(mockScopedQuery.rawCypher).mockImplementation(async (cypher: string, _limit: number, params?: Record<string, unknown>) => {
      // Case-sensitive should use CONTAINS directly with the parameter, without toLower.
      if (cypher.includes('Semantic') && cypher.includes('CONTAINS $grepPattern') && !cypher.includes('toLower') && params?.grepPattern === 'JWT') {
        return [{ s: { id: 'sem-1', content: 'Uses JWT tokens', confidence: 0.9 } }];
      }
      return [];
    });

    const handlers = buildToolHandlers();
    const result = await handlers.berry_grep({ pattern: 'JWT', case_sensitive: true });

    const text = result.content[0].text;
    expect(text).toContain('1 match');
  });

  it('filters by node type', async () => {
    vi.mocked(mockScopedQuery.rawCypher).mockImplementation(async (cypher: string) => {
      if (cypher.includes('Semantic')) {
        return [{ s: { id: 'sem-1', content: 'Uses JWT tokens', confidence: 0.9 } }];
      }
      // Should not be called for other types
      return [];
    });

    const handlers = buildToolHandlers();
    const result = await handlers.berry_grep({ pattern: 'JWT', node_types: ['semantic'] });

    const text = result.content[0].text;
    expect(text).toContain('1 match');
    expect(text).toContain('### Semantic');
    expect(text).not.toContain('### Episodic');
    expect(text).not.toContain('### Facts');
    // Verify rawCypher was only called once (for semantic)
    expect(mockScopedQuery.rawCypher).toHaveBeenCalledTimes(1);
  });

  it('filters by scope', async () => {
    vi.mocked(mockScopedQuery.rawCypher).mockImplementation(async (cypher: string, _limit: number, params?: Record<string, unknown>) => {
      // Episodic scope filter via the structural scope column (tag fallback for legacy rows)
      if (cypher.includes('Episodic') && cypher.includes('(e.scope = $grepScope OR $grepScope IN e.tags)') && params?.grepScope === 'project:amp') {
        return [{ e: { id: 'ep-1', content: 'JWT auth decision', task: '[project:amp] auth', created_at: '2026-04-05' } }];
      }
      // Semantic scope filter via the structural scope column (tag fallback for legacy rows)
      if (cypher.includes('Semantic') && cypher.includes('(s.scope = $grepScope OR $grepScope IN s.tags)') && params?.grepScope === 'project:amp') {
        return [{ s: { id: 'sem-1', content: 'JWT pattern used', confidence: 0.8 } }];
      }
      // Fact scope filter via f.scope
      if (cypher.includes('Fact') && cypher.includes('f.scope = $grepScope') && params?.grepScope === 'project:amp') {
        return [];
      }
      // Block scope filter via b.scope
      if (cypher.includes('MemoryBlock') && cypher.includes('b.scope = $grepScope') && params?.grepScope === 'project:amp') {
        return [];
      }
      return [];
    });

    const handlers = buildToolHandlers();
    const result = await handlers.berry_grep({ pattern: 'JWT', scope: 'project:amp' });

    const text = result.content[0].text;
    expect(text).toContain('2 matches');
  });

  it('generates snippets with bold matches and context', async () => {
    const longContent = 'A'.repeat(150) + 'JWT' + 'B'.repeat(150);
    vi.mocked(mockScopedQuery.rawCypher).mockImplementation(async (cypher: string) => {
      if (cypher.includes('Semantic')) {
        return [{ s: { id: 'sem-1', content: longContent, confidence: 0.5 } }];
      }
      return [];
    });

    const handlers = buildToolHandlers();
    const result = await handlers.berry_grep({ pattern: 'JWT', node_types: ['semantic'] });

    const text = result.content[0].text;
    // Should have ellipsis for truncation and bold match
    expect(text).toContain('...');
    expect(text).toContain('**JWT**');
  });

  it('returns empty results message when nothing matches', async () => {
    vi.mocked(mockScopedQuery.rawCypher).mockResolvedValue([]);

    const handlers = buildToolHandlers();
    const result = await handlers.berry_grep({ pattern: 'nonexistent_pattern_xyz' });

    const text = result.content[0].text;
    expect(text).toContain('0 matches');
    expect(text).toContain('_No matches found._');
  });

  // Audit B1: a failed per-type query must never render as a genuine no-hit.
  describe('query failure surfacing', () => {
    const SECRET_ERR = 'ServiceUnavailable: could not connect to bolt://secret:7687';
    function failFor(types: string[], message = SECRET_ERR): void {
      vi.mocked(mockScopedQuery.rawCypher).mockImplementation(async (cypher: string) => {
        const label = cypher.includes('Episodic') ? 'Episodic'
          : cypher.includes('Semantic') ? 'Semantic'
          : cypher.includes('Fact') ? 'Fact'
          : cypher.includes('MemoryBlock') ? 'MemoryBlock' : 'Entity';
        if (types.includes(label)) throw new Error(message);
        if (label === 'Semantic') return [{ s: { id: 'sem-1', content: 'uses JWT', confidence: 0.9 } }];
        return [];
      });
    }

    it('one type failing renders a partial line and keeps other matches', async () => {
      failFor(['Fact']);
      const handlers = buildToolHandlers();
      const result = await handlers.berry_grep({ pattern: 'JWT' });
      const text = result.content[0].text;
      expect(result.isError).toBeFalsy();
      expect(text).toContain('1 match');
      expect(text).toContain('### Semantic');
      expect(text).toMatch(/partial: fact unavailable \(query-failed\)/);
      expect(text).not.toContain('bolt://secret');
    });

    it('all types failing returns isError with a value-free message', async () => {
      failFor(['Episodic', 'Semantic', 'Fact', 'MemoryBlock', 'Entity']);
      const handlers = buildToolHandlers();
      const result = await handlers.berry_grep({ pattern: 'JWT' });
      const text = result.content[0].text;
      expect(result.isError).toBe(true);
      expect(text).toContain('berry_grep: all 5 node-type queries failed (query-failed)');
      expect(text).not.toContain('bolt://secret');
      expect(text).not.toContain('No matches found');
    });

    it('classifies timeouts and keeps the partial line on a zero-match render', async () => {
      failFor(['Entity'], 'Neo.ClientError.Transaction.TransactionTimedOut: The transaction has been terminated');
      const handlers = buildToolHandlers();
      const result = await handlers.berry_grep({ pattern: 'JWT', node_types: ['entity', 'block'] });
      const text = result.content[0].text;
      expect(result.isError).toBeFalsy();
      expect(text).toContain('(0 matches)');
      expect(text).toMatch(/partial: entity unavailable \(timeout\)/);
    });

    it('genuine zero matches with no failures is unchanged', async () => {
      vi.mocked(mockScopedQuery.rawCypher).mockResolvedValue([]);
      const handlers = buildToolHandlers();
      const result = await handlers.berry_grep({ pattern: 'nothing_here' });
      const text = result.content[0].text;
      expect(result.isError).toBeFalsy();
      expect(text).toBe('## Grep Results: "nothing_here" (0 matches)\n\n_No matches found._');
      expect(text).not.toContain('partial:');
    });

    it('node_types restricted to semantic and semantic throws → isError', async () => {
      failFor(['Semantic']);
      const handlers = buildToolHandlers();
      const result = await handlers.berry_grep({ pattern: 'JWT', node_types: ['semantic'] });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('all 1 node-type queries failed');
      expect(result.content[0].text).not.toContain('bolt://secret');
    });
  });

  it('deduplicates results by ID', async () => {
    // Return the same entity from multiple queries — should appear only once
    vi.mocked(mockScopedQuery.rawCypher).mockImplementation(async (cypher: string) => {
      if (cypher.includes('Entity')) {
        return [
          { ent: { id: 'ent-1', name: 'JWT', description: 'JSON Web Token', type: 'concept' } },
          { ent: { id: 'ent-1', name: 'JWT', description: 'JSON Web Token', type: 'concept' } },
        ];
      }
      return [];
    });

    const handlers = buildToolHandlers();
    const result = await handlers.berry_grep({ pattern: 'JWT', node_types: ['entity'] });

    const text = result.content[0].text;
    expect(text).toContain('1 match');
  });

  it('throws when ScopedQuery is not initialised', async () => {
    setServiceInstances({
      ampService: mockAmpService,
      consolidationEngine: mockConsolidationEngine,
      scopedQuery: null as unknown as IScopedQuery,
      bootstrapService: mockBootstrapService,
    });
    const handlers = buildToolHandlers();
    await expect(handlers.berry_grep({ pattern: 'test' })).rejects.toThrow('ScopedQuery not initialised');
  });

  it('handles query failures gracefully per node type', async () => {
    vi.mocked(mockScopedQuery.rawCypher).mockImplementation(async (cypher: string) => {
      if (cypher.includes('Episodic')) throw new Error('DB error');
      if (cypher.includes('Semantic')) {
        return [{ s: { id: 'sem-1', content: 'test pattern match', confidence: 0.5 } }];
      }
      if (cypher.includes('Fact')) throw new Error('DB error');
      if (cypher.includes('MemoryBlock')) throw new Error('DB error');
      if (cypher.includes('Entity')) throw new Error('DB error');
      return [];
    });

    const handlers = buildToolHandlers();
    const result = await handlers.berry_grep({ pattern: 'test' });

    // Should still return results from semantic even though others failed
    const text = result.content[0].text;
    expect(text).toContain('1 match');
    expect(text).toContain('### Semantic');
  });

  it('respects limit parameter', async () => {
    const manyResults = Array.from({ length: 10 }, (_, i) => ({
      s: { id: `sem-${i}`, content: `JWT usage pattern ${i}`, confidence: 0.5 },
    }));
    vi.mocked(mockScopedQuery.rawCypher).mockImplementation(async (cypher: string) => {
      if (cypher.includes('Semantic')) return manyResults;
      return [];
    });

    const handlers = buildToolHandlers();
    const result = await handlers.berry_grep({ pattern: 'JWT', node_types: ['semantic'], limit: 3 });

    const text = result.content[0].text;
    expect(text).toContain('3 matches');
  });

  it('normalizes fractional and invalid direct-call limits before querying and counting results', async () => {
    const manyResults = Array.from({ length: 4 }, (_, i) => ({
      s: { id: `sem-${i}`, content: `JWT usage pattern ${i}`, confidence: 0.5 },
    }));
    vi.mocked(mockScopedQuery.rawCypher).mockImplementation(async (cypher: string) => {
      if (cypher.includes('Semantic')) return manyResults;
      return [];
    });

    const handlers = buildToolHandlers();
    const fractional = await handlers.berry_grep({ pattern: 'JWT', node_types: ['semantic'], limit: 2.8 });
    expect(fractional.content[0].text).toContain('2 matches');
    expect(mockScopedQuery.rawCypher).toHaveBeenLastCalledWith(
      expect.stringContaining('Semantic'),
      2,
      expect.any(Object),
      undefined, // non-regex grep path passes no tx timeout (OPT-07: only =~ regex path is timed)
    );

    vi.mocked(mockScopedQuery.rawCypher).mockClear();
    const invalid = await handlers.berry_grep({ pattern: 'JWT', node_types: ['semantic'], limit: -5 as never });
    expect(invalid.content[0].text).toContain('4 matches');
    expect(mockScopedQuery.rawCypher).toHaveBeenLastCalledWith(
      expect.stringContaining('Semantic'),
      20,
      expect.any(Object),
      undefined, // non-regex grep path passes no tx timeout (OPT-07)
    );
  });

  it('passes special characters in exact-match patterns as parameters', async () => {
    vi.mocked(mockScopedQuery.rawCypher).mockImplementation(async (cypher: string, _limit: number, params?: Record<string, unknown>) => {
      if (cypher.includes('Semantic') && cypher.includes('$grepPatternLower') && params?.grepPattern === "it's") {
        return [{ s: { id: 'sem-1', content: "it's a test", confidence: 0.5 } }];
      }
      return [];
    });

    const handlers = buildToolHandlers();
    const result = await handlers.berry_grep({ pattern: "it's", node_types: ['semantic'] });

    const text = result.content[0].text;
    expect(text).toContain('1 match');
  });

  // ─── ReDoS screen (OPT-06) ────────────────────────────────────────────────
  //
  // These assert the static screen REJECTS catastrophic-backtracking patterns
  // BEFORE they reach any .test()/.exec(). They never execute a hanging regex —
  // each asserts the rejection response, proving the pattern is short-circuited.

  it('rejects a nested-quantifier ReDoS pattern (regex mode) before executing it', async () => {
    // Classic catastrophic backtracking; must be rejected, not run.
    vi.mocked(mockScopedQuery.rawCypher).mockResolvedValue([]);
    const handlers = buildToolHandlers();
    const result = await handlers.berry_grep({ pattern: '(a+)+$', regex: true });

    const text = result.content[0].text;
    expect(text).toContain('**Error:**');
    expect(text).toContain('Unsafe regular expression');
    // Proof it short-circuited: no Cypher query was ever issued.
    expect(mockScopedQuery.rawCypher).not.toHaveBeenCalled();
  });

  it('rejects a quantified-alternation ReDoS pattern (regex mode) before executing it', async () => {
    vi.mocked(mockScopedQuery.rawCypher).mockResolvedValue([]);
    const handlers = buildToolHandlers();
    const result = await handlers.berry_grep({ pattern: '(a|aa)+$', regex: true });

    const text = result.content[0].text;
    expect(text).toContain('**Error:**');
    expect(text).toContain('Unsafe regular expression');
    expect(mockScopedQuery.rawCypher).not.toHaveBeenCalled();
  });

  it('rejects a huge bounded-repetition pattern (regex mode) before executing it', async () => {
    vi.mocked(mockScopedQuery.rawCypher).mockResolvedValue([]);
    const handlers = buildToolHandlers();
    const result = await handlers.berry_grep({ pattern: 'a{2000}', regex: true });

    const text = result.content[0].text;
    expect(text).toContain('**Error:**');
    expect(text).toContain('Unsafe regular expression');
    expect(mockScopedQuery.rawCypher).not.toHaveBeenCalled();
  });

  it('does not over-reject benign regex patterns', async () => {
    // Each of these is a legitimate pattern that MUST pass the screen and run.
    vi.mocked(mockScopedQuery.rawCypher).mockImplementation(async (cypher: string) => {
      if (cypher.includes('Semantic')) {
        return [{ s: { id: 'sem-1', content: 'foo and bar and a word', confidence: 0.5 } }];
      }
      return [];
    });
    const handlers = buildToolHandlers();

    for (const pattern of ['foo.*bar', '\\bword\\b', 'JWT|OAuth2', 'a{1,10}']) {
      vi.mocked(mockScopedQuery.rawCypher).mockClear();
      const result = await handlers.berry_grep({ pattern, regex: true, node_types: ['semantic'] });
      const text = result.content[0].text;
      expect(text).not.toContain('Unsafe regular expression');
      // It reached the query layer (was not screened out).
      expect(mockScopedQuery.rawCypher).toHaveBeenCalled();
    }
  });

  it('does not screen non-regex (exact substring) patterns', async () => {
    // A literal containing regex metachars must NOT be treated as a ReDoS shape
    // when regex=false — it is a plain substring search.
    vi.mocked(mockScopedQuery.rawCypher).mockResolvedValue([]);
    const handlers = buildToolHandlers();
    const result = await handlers.berry_grep({ pattern: '(a+)+$', node_types: ['semantic'] });

    const text = result.content[0].text;
    expect(text).not.toContain('Unsafe regular expression');
    expect(mockScopedQuery.rawCypher).toHaveBeenCalled();
  });

  it('parameterizes pattern and scope instead of interpolating user text into Cypher', async () => {
    const dangerousPattern = "JWT' OR 1=1 //";
    const dangerousScope = "project:amp' OR true //";

    vi.mocked(mockScopedQuery.rawCypher).mockResolvedValue([]);

    const handlers = buildToolHandlers();
    await handlers.berry_grep({
      pattern: dangerousPattern,
      scope: dangerousScope,
      node_types: ['semantic'],
    });

    expect(mockScopedQuery.rawCypher).toHaveBeenCalledTimes(1);
    const [cypher, limit, params] = vi.mocked(mockScopedQuery.rawCypher).mock.calls[0];
    expect(limit).toBe(20);
    expect(cypher).toContain('s.content');
    expect(cypher).toContain('$grepPatternLower');
    expect(cypher).toContain('$grepScope');
    expect(cypher).not.toContain(dangerousPattern);
    expect(cypher).not.toContain(dangerousScope);
    expect(params).toMatchObject({
      grepPattern: dangerousPattern,
      grepPatternLower: dangerousPattern.toLowerCase(),
      grepScope: dangerousScope,
    });
  });

  it('OPT-07/OPT-72: passes a tightened transaction timeout (2000ms) on the regex (=~) grep path', async () => {
    vi.mocked(mockScopedQuery.rawCypher).mockResolvedValue([]);

    const handlers = buildToolHandlers();
    await handlers.berry_grep({ pattern: 'JWT|OAuth2', regex: true, node_types: ['semantic'] });

    expect(mockScopedQuery.rawCypher).toHaveBeenCalledTimes(1);
    const [, , , timeoutMs] = vi.mocked(mockScopedQuery.rawCypher).mock.calls[0];
    expect(timeoutMs).toBe(2000); // OPT-72 tightened 5000→2000
  });

  it('OPT-72: the non-regex grep path passes no explicit timeout (bounded by the rawCypher default)', async () => {
    vi.mocked(mockScopedQuery.rawCypher).mockResolvedValue([]);

    const handlers = buildToolHandlers();
    await handlers.berry_grep({ pattern: 'JWT', node_types: ['semantic'] });

    expect(mockScopedQuery.rawCypher).toHaveBeenCalledTimes(1);
    const [, , , timeoutMs] = vi.mocked(mockScopedQuery.rawCypher).mock.calls[0];
    // The handler passes no explicit per-call timeout here; rawCypher applies its
    // 15s DEFAULT (OPT-72) so this path is bounded too — it is NOT unbounded.
    expect(timeoutMs).toBeUndefined();
  });
});
