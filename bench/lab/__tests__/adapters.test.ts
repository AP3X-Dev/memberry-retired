import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { Bm25BaselineAdapter, RecencyBaselineAdapter, ScopeAwareBm25ControlAdapter } from '../adapters/baselines.js';
import { MemBerryProxyAdapter } from '../adapters/memberry-proxy.js';
import type { LabMemory, LabNamespace } from '../contracts/adapter.js';

const namespace: LabNamespace = { runId: 'adapter-test', tenant: 'alpha', project: 'api' };
const memories: LabMemory[] = [
  { id: 'current', content: 'The API database is PostgreSQL.', tenant: 'alpha', project: 'api', recordedAt: '2026-03-01T00:00:00.000Z' },
  { id: 'stale', content: 'The API database is MySQL.', tenant: 'alpha', project: 'api', recordedAt: '2026-01-01T00:00:00.000Z', invalidatedAt: '2026-02-01T00:00:00.000Z' },
  { id: 'wrong-project', content: 'The API database is SQLite.', tenant: 'alpha', project: 'web', recordedAt: '2026-04-01T00:00:00.000Z' },
  { id: 'wrong-tenant', content: 'The API database is Oracle.', tenant: 'beta', project: 'api', recordedAt: '2026-05-01T00:00:00.000Z' },
];

describe('reference lab adapters', () => {
  it('keeps the proxy namespace-, scope-, and time-aware', async () => {
    const adapter = new MemBerryProxyAdapter();
    await adapter.ingest({ namespace, memories });
    const response = await adapter.query({ namespace, query: 'API database', limit: 10 });
    expect(response.results.map((result) => result.id)).toEqual(['current']);
    expect((await adapter.cleanup(namespace)).deleted).toBe(4);
  });

  it('retains intentionally weak BM25 and recency controls', async () => {
    const bm25 = new Bm25BaselineAdapter();
    const recency = new RecencyBaselineAdapter();
    await bm25.ingest({ namespace, memories });
    await recency.ingest({ namespace, memories });
    expect((await bm25.query({ namespace, query: 'API database', limit: 10 })).results).toHaveLength(4);
    expect((await recency.query({ namespace, query: 'ignored', limit: 1 })).results[0]?.id).toBe('wrong-tenant');
    expect([...bm25.capabilities]).not.toEqual(expect.arrayContaining(['project-scope', 'tenant-scope', 'temporal-filtering']));
    expect([...recency.capabilities]).not.toEqual(expect.arrayContaining(['project-scope', 'tenant-scope', 'temporal-filtering']));
  });

  it('provides a truthful scope-aware frozen BM25 control', async () => {
    const control = new ScopeAwareBm25ControlAdapter();
    await control.ingest({ namespace, memories });
    expect((await control.query({ namespace, query: 'API database', limit: 10 })).results.map((result) => result.id)).toEqual(['current']);
    expect([...control.capabilities]).toEqual(expect.arrayContaining(['project-scope', 'tenant-scope', 'temporal-filtering']));
  });

  it('keeps candidate ranking independent from baseline adapter source', async () => {
    const source = await readFile(new URL('../adapters/memberry-proxy.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from ['"].*baselines/);
    expect(source).toContain("from './proxy-ranking.js'");
  });

  it('rejects duplicate fixture ids instead of silently overwriting them', async () => {
    const adapter = new MemBerryProxyAdapter();
    const result = await adapter.ingest({ namespace, memories: [memories[0], memories[0]] });
    expect(result.accepted).toBe(1);
    expect(result.rejected).toEqual([{ id: 'current', reason: 'duplicate id in request' }]);
  });
});
