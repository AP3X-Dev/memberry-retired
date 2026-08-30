import { describe, expect, it, vi } from 'vitest';
import type { Driver } from 'neo4j-driver';
import type { EpisodeIndexKeyNodeV1 } from '@memberry/core';
import { EpisodicIndexStore } from '../episodic-index.js';

function record(values: Record<string, unknown>) {
  return { get: (key: string) => values[key] };
}

describe('IDX-001A backfill store', () => {
  it('uses scoped keyset pagination and skips already-indexed episodes', async () => {
    const run = vi.fn(async () => ({ records: [record({
      id: 'ep2', createdAt: '2026-08-30T00:00:00.000Z', content: 'fact',
    })] }));
    const close = vi.fn(async () => undefined);
    const driver = { session: () => ({ run, close }) } as unknown as Driver;
    const rows = await new EpisodicIndexStore(driver).nextBackfillBatch({
      tenantId: 'tenant-a', projectScope: 'project:memberry', limit: 10,
      after: { createdAt: '2026-08-29T00:00:00.000Z', id: 'ep1' },
    });
    expect(run.mock.calls[0]![0]).toContain('ep.tenant_id = $tenantId');
    expect(run.mock.calls[0]![0]).toContain('ep.scope = $projectScope');
    expect(run.mock.calls[0]![0]).toContain('NOT EXISTS { (ep)-[:HAS_INDEX_KEY]');
    expect(run.mock.calls[0]![1]).toMatchObject({
      tenantId: 'tenant-a', projectScope: 'project:memberry', afterId: 'ep1', limit: 10,
    });
    expect(rows).toEqual([expect.objectContaining({ id: 'ep2', tenantId: 'tenant-a' })]);
    expect(close).toHaveBeenCalledOnce();
  });

  it('replaces only backfill keys after proving exact episode ownership', async () => {
    const queries: string[] = [];
    const run = vi.fn(async (query: string) => {
      queries.push(query);
      return query.includes('RETURN count(ep)')
        ? { records: [record({ count: 1 })] }
        : { records: [] };
    });
    const close = vi.fn(async () => undefined);
    const driver = { session: () => ({
      executeWrite: (work: (tx: { run: typeof run }) => unknown) => work({ run }), close,
    }) } as unknown as Driver;
    const key: EpisodeIndexKeyNodeV1 = {
      id: 'eik1:ep1:x', episode_id: 'ep1', kind: 'fact', value: 'fact', embedding: [1],
      schema_version: 1, source: 'backfill', source_hash: 'x', tenant_id: 'tenant-a',
      project_scope: 'project:memberry', created_at: '2026-08-30T00:00:00.000Z',
    };
    await new EpisodicIndexStore(driver).replaceBackfillKeys({
      id: 'ep1', createdAt: key.created_at, content: 'fact',
      tenantId: 'tenant-a', projectScope: 'project:memberry',
    }, [key]);
    expect(queries[0]).toContain('tenant_id: $tenantId, scope: $projectScope');
    expect(queries[1]).toContain("source: 'backfill'");
    expect(queries[2]).toContain('CREATE (k:EpisodicIndexKey');
    expect(close).toHaveBeenCalledOnce();
  });

  it('rolls back by deleting only derived keys in the exact tenant/project', async () => {
    const calls: Array<[string, unknown]> = [];
    const run = vi.fn(async (query: string, params: unknown) => {
      calls.push([query, params]);
      return query.includes('RETURN count(key)')
        ? { records: [record({ count: 3 })] }
        : { records: [] };
    });
    const close = vi.fn(async () => undefined);
    const driver = { session: () => ({
      executeWrite: (work: (tx: { run: typeof run }) => unknown) => work({ run }), close,
    }) } as unknown as Driver;
    await expect(new EpisodicIndexStore(driver).deleteDerived({
      tenantId: 'tenant-a', projectScope: 'project:memberry',
    })).resolves.toBe(3);
    expect(calls).toHaveLength(2);
    expect(calls[1]![0]).toContain('DETACH DELETE key');
    expect(calls[1]![0]).not.toContain('DELETE ep');
    expect(calls[1]![1]).toEqual({ tenantId: 'tenant-a', projectScope: 'project:memberry' });
    expect(close).toHaveBeenCalledOnce();
  });
});
