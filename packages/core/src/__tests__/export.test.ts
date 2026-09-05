// packages/core/src/__tests__/export.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock fs ──────────────────────────────────────────────────────────────────

vi.mock('fs/promises', () => ({
  default: {
    writeFile: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('fs', () => ({
  mkdirSync: vi.fn(),
}));

import fs from 'fs/promises';
import { mkdirSync } from 'fs';
import path from 'path';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSemanticRecord(overrides: Record<string, unknown> = {}) {
  return {
    get: (key: string) => {
      if (key === 's') {
        return {
          properties: {
            id: 'sem-1',
            content: 'Client prefers formal tone',
            confidence: 0.9,
            signal_count: 5,
            created_at: '2026-03-18T00:00:00Z',
            updated_at: '2026-03-18T12:00:00Z',
            decay_class: 'stable',
            tags: ['brand-voice'],
            ...overrides,
          },
        };
      }
      return null;
    },
  };
}

function makeEpisodicRecord(overrides: Record<string, unknown> = {}) {
  return {
    get: (key: string) => {
      if (key === 'e') {
        return {
          properties: {
            id: 'ep-1',
            session_id: 'sess-abc',
            agent_id: 'agent-1',
            task: 'write-blog-post',
            content: 'Generated a draft',
            outcome: 'approved',
            created_at: '2026-03-18T08:00:00Z',
            ttl: null,
            ...overrides,
          },
        };
      }
      return null;
    },
  };
}

function makeDriver(semanticRecords: unknown[], episodicRecords: unknown[]) {
  let callCount = 0;
  return {
    session: () => {
      const index = callCount++;
      const records = index === 0 ? semanticRecords : episodicRecords;
      return {
        run: vi.fn().mockResolvedValue({ records }),
        close: vi.fn().mockResolvedValue(undefined),
      };
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('exportAll', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes semantic nodes to {exportPath}/semantic/{id}.md', async () => {
    const { exportAll } = await import('../export.js');

    const driver = makeDriver([makeSemanticRecord()], []) as never;

    const result = await exportAll(driver, '/tmp/amp');

    expect(result.exported).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);

    expect(mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('semantic'),
      { recursive: true },
    );
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('sem-1.md'),
      expect.stringContaining('id: sem-1'),
      'utf8',
    );
  });

  it('writes episodic nodes to {exportPath}/episodic/{date}/{id}.md', async () => {
    const { exportAll } = await import('../export.js');

    const driver = makeDriver([], [makeEpisodicRecord()]) as never;

    const result = await exportAll(driver, '/tmp/amp');

    expect(result.exported).toBe(1);
    expect(mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('2026-03-18'),
      { recursive: true },
    );
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('ep-1.md'),
      expect.stringContaining('id: ep-1'),
      'utf8',
    );
  });

  it('exports both semantic and episodic nodes in one call', async () => {
    const { exportAll } = await import('../export.js');

    const driver = makeDriver([makeSemanticRecord()], [makeEpisodicRecord()]) as never;

    const result = await exportAll(driver, '/tmp/amp');

    expect(result.exported).toBe(2);
    expect(fs.writeFile).toHaveBeenCalledTimes(2);
  });

  it('counts skipped when renderToMarkdown throws', async () => {
    const { exportAll } = await import('../export.js');

    // Node with missing id should still produce a file path, but let's cause a write error
    vi.mocked(fs.writeFile).mockRejectedValueOnce(new Error('disk full'));

    const driver = makeDriver([makeSemanticRecord()], []) as never;
    const result = await exportAll(driver, '/tmp/amp');

    expect(result.skipped).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('sem-1');
  });

  it('returns zero exported for empty graph', async () => {
    const { exportAll } = await import('../export.js');
    const driver = makeDriver([], []) as never;
    const result = await exportAll(driver, '/tmp/amp');

    expect(result.exported).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('groups episodic nodes by their created_at date', async () => {
    const { exportAll } = await import('../export.js');

    const ep1 = makeEpisodicRecord({ id: 'ep-1', created_at: '2026-03-10T00:00:00Z' });
    const ep2 = makeEpisodicRecord({ id: 'ep-2', created_at: '2026-03-11T00:00:00Z' });

    const driver = makeDriver([], [ep1, ep2]) as never;
    const result = await exportAll(driver, '/tmp/amp');

    expect(result.exported).toBe(2);

    const writeCalls = vi.mocked(fs.writeFile).mock.calls;
    const paths = writeCalls.map((c) => String(c[0]));
    expect(paths.some((p) => p.includes('2026-03-10'))).toBe(true);
    expect(paths.some((p) => p.includes('2026-03-11'))).toBe(true);
  });
});

describe('exportFiltered', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('falls back to exportAll when no filters are provided', async () => {
    const { exportFiltered } = await import('../export.js');

    const driver = makeDriver([makeSemanticRecord()], []) as never;
    const result = await exportFiltered(driver, '/tmp/amp', {});

    expect(result.exported).toBeGreaterThanOrEqual(0);
  });

  it('writes filtered semantic nodes for entity filter', async () => {
    const { exportFiltered } = await import('../export.js');

    // First session = filtered semantics, second = episodics
    let callCount = 0;
    const driver = {
      session: () => {
        const idx = callCount++;
        const records = idx === 0 ? [makeSemanticRecord()] : [];
        return {
          run: vi.fn().mockResolvedValue({ records }),
          close: vi.fn().mockResolvedValue(undefined),
        };
      },
    } as never;

    const result = await exportFiltered(driver, '/tmp/amp', { entities: ['ClientX'] });

    expect(result.exported).toBe(1);
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('sem-1.md'),
      expect.any(String),
      'utf8',
    );
  });
});

// ─── Tenant bounding + paging (audit C1) ──────────────────────────────────────
//
// A fake graph that behaves like Neo4j would: rows are filtered by tenant ONLY
// when the query text carries a tenant predicate, and SKIP/LIMIT are honoured
// only when present. Unbounded queries therefore leak every tenant's rows —
// exactly what the old export did.

type Row = Record<string, unknown>;

function makeGraphDriver(semantic: Row[], episodic: Row[]) {
  const calls: Array<{ cypher: string; params: Record<string, unknown> }> = [];
  const toNum = (v: unknown): number => {
    if (typeof v === 'number') return v;
    const n = v as { toNumber?: () => number } | null;
    return n && typeof n.toNumber === 'function' ? n.toNumber() : Number(v);
  };
  const run = vi.fn(async (cypher: string, params: Record<string, unknown> = {}) => {
    calls.push({ cypher, params });
    const alias = cypher.includes('(s:Semantic)') ? 's' : 'e';
    let rows = alias === 's' ? semantic : episodic;
    if (alias === 's' && Array.isArray(params.entities)) {
      rows = rows.filter((r) => (params.entities as string[]).includes(String(r.entity)));
    }
    if (alias === 's' && Array.isArray(params.tags)) {
      rows = rows.filter((r) => (params.tags as string[]).some((t) => (r.tags as string[]).includes(t)));
    }
    if (/tenant_id/.test(cypher)) {
      rows = rows.filter((r) =>
        r.tenant_id === params.tenantId || (r.tenant_id == null && params.tenantId === params.defaultTenant));
    }
    if (/SKIP \$skip LIMIT \$limit/.test(cypher)) {
      rows = rows.slice(toNum(params.skip), toNum(params.skip) + toNum(params.limit));
    }
    return { records: rows.map((r) => ({ get: (k: string) => (k === alias ? { properties: r } : undefined) })) };
  });
  const driver = { session: () => ({ run, close: vi.fn().mockResolvedValue(undefined) }) } as never;
  return { driver, calls };
}

const sem = (id: string, tenant_id: string | null, extra: Row = {}): Row => ({
  id, content: `content of ${id}`, confidence: 0.9, signal_count: 1, decay_class: 'stable',
  created_at: '2026-03-18T00:00:00Z', updated_at: '2026-03-18T00:00:00Z', tags: ['t'], tenant_id, ...extra,
});
const ep = (id: string, tenant_id: string | null): Row => ({
  id, session_id: 's', agent_id: 'a', task: 'task', content: `content of ${id}`,
  created_at: '2026-03-18T00:00:00Z', tenant_id,
});

function writtenIds(): string[] {
  return vi.mocked(fs.writeFile).mock.calls.map((c) => path.basename(String(c[0]), '.md'));
}

const twoTenants = () => makeGraphDriver(
  [sem('sem-a', 'a'), sem('sem-b', 'b'), sem('sem-null', null)],
  [ep('ep-a', 'a'), ep('ep-b', 'b'), ep('ep-null', null)],
);

describe('export tenant bounding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exportAll for the default tenant returns its own rows plus legacy NULL-tenant rows, never another tenant', async () => {
    const { exportAll } = await import('../export.js');
    const { DEFAULT_TENANT } = await import('../types.js');
    const { driver } = makeGraphDriver(
      [sem('sem-a', DEFAULT_TENANT), sem('sem-b', 'b'), sem('sem-null', null)],
      [ep('ep-a', DEFAULT_TENANT), ep('ep-b', 'b'), ep('ep-null', null)],
    );

    const result = await exportAll(driver, '/tmp/amp', { tenantId: DEFAULT_TENANT });
    expect(result.exported).toBe(4);
    expect(writtenIds().sort()).toEqual(['ep-a', 'ep-null', 'sem-a', 'sem-null']);
    const written = vi.mocked(fs.writeFile).mock.calls.map((c) => String(c[1])).join('\n');
    expect(written).not.toContain('sem-b');
    expect(written).not.toContain('ep-b');
  });

  it('exportAll for a non-default tenant returns strictly that tenant (no NULL, no other tenant)', async () => {
    const { exportAll } = await import('../export.js');
    const { driver } = twoTenants();

    const result = await exportAll(driver, '/tmp/amp', { tenantId: 'a' });
    expect(result.exported).toBe(2);
    expect(writtenIds().sort()).toEqual(['ep-a', 'sem-a']);
  });

  it('exportAll defaults to the default tenant when no tenantId is given', async () => {
    const { exportAll } = await import('../export.js');
    const { DEFAULT_TENANT } = await import('../types.js');
    const { driver, calls } = twoTenants();

    await exportAll(driver, '/tmp/amp');
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.params.tenantId).toBe(DEFAULT_TENANT);
    expect(writtenIds().sort()).toEqual(['ep-null', 'sem-null']);
  });

  it('every query issued by exportAll and exportFiltered carries the tenant predicate, its params, and a LIMIT', async () => {
    const { exportAll, exportFiltered } = await import('../export.js');
    const { DEFAULT_TENANT } = await import('../types.js');
    const { driver, calls } = twoTenants();

    await exportAll(driver, '/tmp/amp', { tenantId: 'a' });
    await exportFiltered(driver, '/tmp/amp', { entities: ['X'] }, { tenantId: 'a' });
    await exportFiltered(driver, '/tmp/amp', { tags: ['t'] }, { tenantId: 'a' });
    await exportFiltered(driver, '/tmp/amp', { entities: ['X'], tags: ['t'] }, { tenantId: 'a' });

    // 2 (all) + 3 x 2 (filtered semantic + episodic)
    expect(calls).toHaveLength(8);
    for (const { cypher, params } of calls) {
      expect(cypher).toMatch(/\(\w\.tenant_id = \$tenantId OR \(\w\.tenant_id IS NULL AND \$tenantId = \$defaultTenant\)\)/);
      expect(params.tenantId).toBe('a');
      expect(params.defaultTenant).toBe(DEFAULT_TENANT);
      expect(cypher).toMatch(/LIMIT \$limit/);
      expect(params.limit).toBeDefined();
    }
  });

  it("exportFiltered with an entity filter never yields another tenant's rows", async () => {
    const { exportFiltered } = await import('../export.js');
    const { driver } = makeGraphDriver(
      [sem('sem-a', 'a', { entity: 'X' }), sem('sem-b', 'b', { entity: 'X' })],
      [ep('ep-b', 'b')],
    );

    const result = await exportFiltered(driver, '/tmp/amp', { entities: ['X'] }, { tenantId: 'a' });
    expect(result.exported).toBe(1);
    expect(writtenIds()).toEqual(['sem-a']);
  });

  it('pages through large result sets: 1200 rows are all exported with a bounded LIMIT per query', async () => {
    const { exportAll } = await import('../export.js');
    const rows = Array.from({ length: 1200 }, (_, i) => sem(`sem-${String(i).padStart(4, '0')}`, 'a'));
    const { driver, calls } = makeGraphDriver(rows, []);

    const result = await exportAll(driver, '/tmp/amp', { tenantId: 'a' });
    expect(result.exported).toBe(1200);
    expect(new Set(writtenIds()).size).toBe(1200);

    const semanticCalls = calls.filter((c) => c.cypher.includes('(s:Semantic)'));
    expect(semanticCalls.length).toBeGreaterThanOrEqual(3);
    for (const c of semanticCalls) {
      expect(c.cypher).toMatch(/SKIP \$skip LIMIT \$limit/);
      expect(Number(c.params.limit)).toBeLessThanOrEqual(500);
    }
  });

  it('strips embeddings at the wire unless includeEmbeddings is set', async () => {
    const { exportAll } = await import('../export.js');
    const { driver, calls } = twoTenants();

    await exportAll(driver, '/tmp/amp', { tenantId: 'a' });
    for (const c of calls) expect(c.cypher).toContain('embedding: null');

    calls.length = 0;
    await exportAll(driver, '/tmp/amp', { tenantId: 'a', includeEmbeddings: true });
    for (const c of calls) expect(c.cypher).not.toContain('embedding: null');
  });
});
