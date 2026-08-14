import { describe, expect, it, vi } from 'vitest';

import type { AdapterHealth } from '../contracts/adapter.js';
import {
  liveProjectScope,
  MemberryLiveAdapter,
  parseFixtureResults,
  type MemberryToolTransport,
} from '../adapters/memberry-live.js';

class FakeTransport implements MemberryToolTransport {
  readonly call = vi.fn(async (tool: string, args: Record<string, unknown>) => {
    if (tool === 'berry_store') return `id:${String(args.content).match(/MEMBERRY_LAB_ID:([^\]]+)/)?.[1]}`;
    if (tool === 'berry_grep') return [
      `## Grep Results: "${String(args.pattern)}" (1 match)`,
      `- [**MEMBERRY_LAB_ID:${String(args.pattern).split(':').at(-1)}**] exact fixture`,
    ].join('\n');
    return [
      '## [sem-new] (confidence: 0.90, score: 1.00)',
      '[MEMBERRY_LAB_ID:new] use the current endpoint',
      '## [sem-old] (confidence: 0.40, score: 0.20)',
      '[MEMBERRY_LAB_ID:old] use the retired endpoint',
    ].join('\n');
  });

  async health(): Promise<AdapterHealth> { return { status: 'ready' }; }
}

const namespace = { runId: 'run 42', tenant: 'tenant-a', project: 'api' };

describe('MemberryLiveAdapter', () => {
  it('is read-only unless synthetic writes are explicitly enabled', async () => {
    const adapter = new MemberryLiveAdapter({
      tenants: { 'tenant-a': { baseUrl: 'http://example.test', token: 'secret' } },
      transportFactory: () => new FakeTransport(),
    });
    const result = await adapter.ingest({
      namespace,
      memories: [{ id: 'm1', content: 'synthetic fixture', recordedAt: '2026-01-01T00:00:00Z' }],
    });
    expect(result.accepted).toBe(0);
    expect(result.rejected[0]?.reason).toMatch(/disabled/);
    await expect(adapter.health()).resolves.toMatchObject({ status: 'degraded' });
  });

  it('writes only marker-tagged synthetic memories and maps live markdown back to fixture ids', async () => {
    const transport = new FakeTransport();
    const adapter = new MemberryLiveAdapter({
      tenants: { 'tenant-a': { baseUrl: 'http://example.test', token: 'secret' } },
      allowSyntheticWrites: true,
      transportFactory: () => transport,
    });
    const ingest = await adapter.ingest({
      namespace,
      memories: [{ id: 'new', content: 'use the current endpoint', recordedAt: '2026-01-01T00:00:00Z' }],
    });
    expect(ingest).toMatchObject({ accepted: 1, rejected: [] });
    const storeArgs = transport.call.mock.calls[0]?.[1];
    expect(storeArgs?.content).toContain('[MEMBERRY_LAB_ID:new]');
    expect(storeArgs?.scope).toBe(liveProjectScope(namespace));
    expect(storeArgs?.tags).toContain(liveProjectScope(namespace));

    const response = await adapter.query({ namespace, query: 'endpoint', limit: 2 });
    expect(response.results.map((result) => result.id)).toEqual(['new', 'old']);
    expect(response.results[0]?.score).toBeGreaterThan(response.results[1]?.score ?? 0);
    expect(adapter.capabilities.has('cleanup')).toBe(false);
    await expect(adapter.stats(namespace)).resolves.toMatchObject({ memories: 1, queries: 1 });

    await expect(adapter.verifySyntheticFixture(namespace, 'new')).resolves.toBe(true);
    expect(transport.call).toHaveBeenLastCalledWith('berry_grep', {
      pattern: 'MEMBERRY_LAB_ID:new',
      node_types: ['episodic'],
      scope: liveProjectScope(namespace),
      limit: 5,
    });
  });

  it('rejects fixture ids that could corrupt the marker envelope', async () => {
    const adapter = new MemberryLiveAdapter({
      tenants: { 'tenant-a': { baseUrl: 'http://example.test', token: 'secret' } },
      allowSyntheticWrites: true,
      transportFactory: () => new FakeTransport(),
    });
    const result = await adapter.ingest({
      namespace,
      memories: [{ id: 'bad]id', content: 'synthetic fixture', recordedAt: '2026-01-01T00:00:00Z' }],
    });
    expect(result.accepted).toBe(0);
    expect(result.rejected[0]?.reason).toMatch(/marker-safe/);
    await expect(adapter.verifySyntheticFixture(namespace, 'bad]id')).rejects.toThrow(/marker-safe/);
  });

  it('rejects tenant fixtures when no token-bound tenant endpoint exists', async () => {
    const adapter = new MemberryLiveAdapter({
      tenants: { 'tenant-a': { baseUrl: 'http://example.test', token: 'secret' } },
      allowSyntheticWrites: true,
      transportFactory: () => new FakeTransport(),
    });
    const result = await adapter.ingest({
      namespace,
      memories: [{ id: 'foreign', content: 'foreign fixture', tenant: 'tenant-b', recordedAt: '2026-01-01T00:00:00Z' }],
    });
    expect(result.accepted).toBe(0);
    expect(result.rejected[0]?.reason).toMatch(/tenant tenant-b/);
  });
});

describe('parseFixtureResults', () => {
  it('deduplicates markers and respects ranking order and limit', () => {
    const markdown = '[MEMBERRY_LAB_ID:a] first\n[MEMBERRY_LAB_ID:a] duplicate\n[MEMBERRY_LAB_ID:b] second';
    expect(parseFixtureResults(markdown, 1).map((result) => result.id)).toEqual(['a']);
  });
});
