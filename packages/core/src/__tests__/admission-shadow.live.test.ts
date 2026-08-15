import { randomUUID } from 'node:crypto';

import {
  AdmissionObservationStore,
  EpisodicStore,
  TenantAdmin,
  createNeo4jDriver,
  runMigrations,
} from '@memberry/neo4j';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AdmissionShadowRuntime } from '../admission-shadow.js';
import { AMPService, type Neo4jLayer, type RedisLayer } from '../service.js';
import type { AMPConfig } from '../types.js';

const LIVE = process.env.MEMBERRY_NEO4J_INTEGRATION === '1';
const describeLive = LIVE ? describe : describe.skip;
const COLD_NEO4J_HOOK_TIMEOUT_MS = 120_000;
const suffix = randomUUID().toLowerCase();
const tenantId = `test-admission-c-${suffix}`;
const projectScope = `project:test-admission-c-${suffix}`;
const driver = createNeo4jDriver(
  process.env.NEO4J_URI || 'bolt://localhost:7687',
  process.env.NEO4J_USER || 'neo4j',
  process.env.NEO4J_PASSWORD || 'password',
);

function redisLayer(): RedisLayer {
  const seen = new Set<string>();
  return {
    cache: {
      get: vi.fn(), set: vi.fn(), invalidateByNodeId: vi.fn(),
      invalidateByScope: vi.fn(async () => 0),
    },
    embeddings: { get: vi.fn(), set: vi.fn() },
    dedup: {
      isDuplicate: vi.fn(), markSeen: vi.fn(), unmark: vi.fn(async () => undefined),
      checkAndMark: vi.fn(async (_agent, hash) => {
        if (seen.has(hash)) return true;
        seen.add(hash);
        return false;
      }),
    },
    signals: { publish: vi.fn() },
    queue: { incrementScore: vi.fn() },
  };
}

function config(): AMPConfig {
  return {
    redis: { url: 'redis://unused' },
    neo4j: { uri: 'live', user: 'neo4j', password: '' },
    embedding: { provider: 'openai', apiKey: '' },
    cache: { defaultTTL: 300, contextTTL: 300, embeddingTTL: 86400 },
    consolidation: { autoApply: false, signalThreshold: 3 },
    exportPath: '/tmp/memberry',
    admissionShadow: { enabled: true, timeoutMs: 50 },
  };
}

function service(enabled: boolean, failEmbedding = false): {
  readonly amp: AMPService;
  readonly shadow: AdmissionShadowRuntime;
} {
  const episodic = new EpisodicStore(driver);
  const neo4j: Neo4jLayer = {
    episodic,
    query: { byScope: vi.fn(), byVector: vi.fn() },
  };
  const shadow = new AdmissionShadowRuntime({
    enabled,
    timeoutMs: 50,
    ...(enabled ? { sink: new AdmissionObservationStore(driver) } : {}),
  });
  return {
    shadow,
    amp: new AMPService(
      redisLayer(),
      neo4j,
      {
        embed: vi.fn(async () => {
          if (failEmbedding) throw new Error('synthetic-embedding-failure');
          return [0.1];
        }),
        embedBatch: vi.fn(),
      },
      config(),
      undefined,
      undefined,
      shadow,
    ),
  };
}

describeLive('MEM-001C live shadow wiring', () => {
  beforeAll(async () => {
    await driver.getServerInfo();
    await runMigrations(driver);
  }, COLD_NEO4J_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    if (LIVE) await new TenantAdmin(driver).delete(tenantId);
    await driver.close().catch(() => undefined);
  }, COLD_NEO4J_HOOK_TIMEOUT_MS);

  it('observes only successful nonduplicates and keeps disabled/failed stores unobserved', async () => {
    const input = (content: string) => ({
      session_id: `session-${suffix}`,
      agent_id: `agent-${suffix}`,
      task: 'disposable MEM-001C integration fixture',
      content,
      tenantId,
      tags: [projectScope],
      memory_type: 'decision' as const,
      outcome: 'approved' as const,
    });

    const enabledService = service(true);
    const accepted = await enabledService.amp.store(input('accepted synthetic memory'));
    expect(accepted.duplicate).toBe(false);
    // The 50ms caller bound may expire on a slow CI Neo4j; shutdown drain makes
    // the eventual sidecar deterministic before the scorer-side assertion.
    await enabledService.shadow.stopAndDrain();
    await expect(enabledService.amp.store(input('accepted synthetic memory')))
      .resolves.toEqual({ id: '', duplicate: true });
    await expect(new AdmissionObservationStore(driver).get({
      tenantId, projectScope, episodeId: accepted.id,
    })).resolves.toMatchObject({
      safeFacts: { captureState: 'accepted-nonduplicate' },
      recommendation: { recommendedTier: 'episodic', wouldChangeBaseline: false },
    });

    const disabled = await service(false).amp.store(input('disabled synthetic memory'));
    await expect(new AdmissionObservationStore(driver).get({
      tenantId, projectScope, episodeId: disabled.id,
    })).resolves.toBeNull();

    await expect(service(true, true).amp.store(input('failed synthetic memory')))
      .rejects.toThrow('synthetic-embedding-failure');

    const session = driver.session();
    try {
      const result = await session.run(
        `MATCH (o:AdmissionObservation {tenant_id: $tenantId})
         RETURN count(o) AS count, collect(keys(o)) AS propertyKeys`,
        { tenantId },
      );
      expect(Number(result.records[0]!.get('count'))).toBe(1);
      const serialized = JSON.stringify(result.records[0]!.get('propertyKeys'));
      expect(serialized).not.toContain('content');
      expect(serialized).not.toContain('task');
      expect(serialized).not.toContain('episode_id');
    } finally {
      await session.close();
    }
  }, 120_000);
});
