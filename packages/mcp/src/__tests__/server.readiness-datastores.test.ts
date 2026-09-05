// packages/mcp/src/__tests__/server.readiness-datastores.test.ts
// D1/A6: /readyz must reflect Neo4j + Redis reachability and the bootstrap degraded list.
import { describe, it, expect } from 'vitest';
import type { AddressInfo } from 'node:net';
import {
  closeSSEHandle,
  createAMPServer,
  readinessStatusCode,
  registerReadinessProbeSource,
  type ReadinessProbeSource,
} from '../server.js';

const TOKEN = 'test-readiness-token';

async function withReadyz(
  source: ReadinessProbeSource,
  run: (fetchReadyz: () => Promise<Response>) => Promise<void>,
): Promise<void> {
  const previousToken = process.env.AMP_API_TOKEN;
  const previousUnauthenticated = process.env.AMP_ALLOW_UNAUTHENTICATED;
  process.env.AMP_API_TOKEN = TOKEN;
  delete process.env.AMP_ALLOW_UNAUTHENTICATED;

  const unregister = registerReadinessProbeSource(source);
  const handle = await createAMPServer().startSSE(0);
  const { port } = handle.httpServer.address() as AddressInfo;
  try {
    await run(() => fetch(`http://127.0.0.1:${port}/readyz`, { headers: { authorization: `Bearer ${TOKEN}` } }));
  } finally {
    unregister();
    await closeSSEHandle(handle, 500);
    if (previousToken === undefined) delete process.env.AMP_API_TOKEN;
    else process.env.AMP_API_TOKEN = previousToken;
    if (previousUnauthenticated === undefined) delete process.env.AMP_ALLOW_UNAUTHENTICATED;
    else process.env.AMP_ALLOW_UNAUTHENTICATED = previousUnauthenticated;
  }
}

const okNeo4j = { getServerInfo: async () => ({}) };
const okRedis = { ping: async () => 'PONG' };

describe('/readyz datastore probes', () => {
  it('returns 503 with datastores.neo4j "unreachable" when getServerInfo rejects', async () => {
    await withReadyz(
      { neo4j: { getServerInfo: async () => { throw new Error('ECONNREFUSED'); } }, redis: okRedis, embeddings: 'ok', degraded: [] },
      async (fetchReadyz) => {
        const res = await fetchReadyz();
        expect(res.status).toBe(503);
        const body = await res.json() as { datastores: Record<string, string> };
        expect(body.datastores.neo4j).toBe('unreachable');
        expect(body.datastores.redis).toBe('ok');
      },
    );
  });

  it('returns 503 with datastores.redis "unreachable" when ping rejects', async () => {
    await withReadyz(
      { neo4j: okNeo4j, redis: { ping: async () => { throw new Error('ECONNREFUSED'); } }, embeddings: 'ok', degraded: [] },
      async (fetchReadyz) => {
        const res = await fetchReadyz();
        expect(res.status).toBe(503);
        const body = await res.json() as { datastores: Record<string, string> };
        expect(body.datastores.redis).toBe('unreachable');
        expect(body.datastores.neo4j).toBe('ok');
      },
    );
  });

  it('returns 200 with both "ok", echoes the bootstrap degraded list, and keeps existing fields', async () => {
    const degraded = ['embeddings: disabled (no OPENAI_API_KEY) — lexical/fulltext retrieval only'];
    await withReadyz(
      { neo4j: okNeo4j, redis: okRedis, embeddings: 'disabled', degraded },
      async (fetchReadyz) => {
        const res = await fetchReadyz();
        // Embeddings disabled is a documented mode: reported, never a 503.
        expect(res.status).toBe(200);
        const body = await res.json() as Record<string, unknown>;
        expect(body).toMatchObject({
          status: 'ready',
          service: 'memberry-mcp',
          datastores: { neo4j: 'ok', redis: 'ok' },
          embeddings: 'disabled',
          degraded,
        });
        expect(body.consolidation_automation).toBeDefined();
        expect(body.admission_shadow).toBeDefined();
        expect(body.retrieval_resolution).toBeDefined();
      },
    );
  });

  it('returns 503 within the probe timeout when a probe never resolves', async () => {
    await withReadyz(
      { neo4j: { getServerInfo: () => new Promise(() => {}) }, redis: okRedis, embeddings: 'ok', degraded: [], probeTimeoutMs: 50 },
      async (fetchReadyz) => {
        const started = Date.now();
        const res = await fetchReadyz();
        expect(Date.now() - started).toBeLessThan(1_000);
        expect(res.status).toBe(503);
        const body = await res.json() as { datastores: Record<string, string> };
        expect(body.datastores.neo4j).toBe('unreachable');
      },
    );
  });

  it('echoes retrieval.collection_size from the accessor and never flips readiness on it', async () => {
    await withReadyz(
      {
        neo4j: okNeo4j, redis: okRedis, embeddings: 'ok', degraded: [],
        retrieval: () => ({ collection_size: { state: 'timeout', cached_at: 1234, last_error_class: 'Error' } }),
      },
      async (fetchReadyz) => {
        const res = await fetchReadyz();
        expect(res.status).toBe(200);
        const body = await res.json() as { retrieval: { collection_size: Record<string, unknown> } };
        expect(body.retrieval.collection_size).toEqual({ state: 'timeout', cached_at: 1234, last_error_class: 'Error' });
      },
    );
  });

  it('echoes lifecycle from the accessor (13b) and never flips readiness on a failed pass', async () => {
    await withReadyz(
      {
        neo4j: okNeo4j, redis: okRedis, embeddings: 'ok', degraded: [],
        lifecycle: () => ({ mode: 'live', last_run_at: '2026-09-02T00:00:00.000Z', last_result: 'failed', last_error_class: 'RangeError' }),
      },
      async (fetchReadyz) => {
        const res = await fetchReadyz();
        expect(res.status).toBe(200);
        const body = await res.json() as { lifecycle: Record<string, unknown> };
        expect(body.lifecycle.last_result).toBe('failed');
        expect(body.lifecycle).toEqual({ mode: 'live', last_run_at: '2026-09-02T00:00:00.000Z', last_result: 'failed', last_error_class: 'RangeError' });
      },
    );
  });

  it('echoes lifecycle.anti_entropy from the accessor (13c)', async () => {
    await withReadyz(
      {
        neo4j: okNeo4j, redis: okRedis, embeddings: 'ok', degraded: [],
        lifecycle: () => ({
          mode: 'live', last_run_at: '2026-09-02T00:00:00.000Z', last_result: 'ok',
          anti_entropy: { pending: 4, inflight: 1, dead_lettered: 2, failures: 0 },
        }),
      },
      async (fetchReadyz) => {
        const res = await fetchReadyz();
        expect(res.status).toBe(200);
        const body = await res.json() as { lifecycle: { anti_entropy: Record<string, number> } };
        expect(body.lifecycle.anti_entropy.dead_lettered).toBe(2);
        expect(body.lifecycle.anti_entropy).toEqual({ pending: 4, inflight: 1, dead_lettered: 2, failures: 0 });
      },
    );
  });

  it('omits retrieval when no accessor is registered', async () => {
    await withReadyz(
      { neo4j: okNeo4j, redis: okRedis, embeddings: 'ok', degraded: [] },
      async (fetchReadyz) => {
        const body = await (await fetchReadyz()).json() as Record<string, unknown>;
        expect(body).not.toHaveProperty('retrieval');
      },
    );
  });

  it('readinessStatusCode flips to 503 only for unhealthy automation or an unreachable datastore', () => {
    const ok = { neo4j: 'ok', redis: 'ok' } as const;
    expect(readinessStatusCode({ unhealthy: false }, ok)).toBe(200);
    expect(readinessStatusCode({ unhealthy: false }, { ...ok, neo4j: 'unreachable' })).toBe(503);
    expect(readinessStatusCode({ unhealthy: false }, { ...ok, redis: 'unreachable' })).toBe(503);
    expect(readinessStatusCode({ unhealthy: true }, ok)).toBe(503);
  });
});
