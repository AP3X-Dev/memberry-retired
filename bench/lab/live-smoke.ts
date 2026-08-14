#!/usr/bin/env tsx

import { MemberryLiveAdapter, memberryLiveOptionsFromEnv } from './adapters/memberry-live.js';

function requireLiveConfiguration(): void {
  const missing = [
    'MEMBERRY_LAB_TENANT_ID',
    'MEMBERRY_LAB_API_TOKEN',
    'MEMBERRY_LAB_MCP_URL',
  ].filter((name) => !process.env[name]?.trim());
  if (process.env.MEMBERRY_LAB_ALLOW_WRITES?.toLowerCase() !== 'true') {
    missing.push('MEMBERRY_LAB_ALLOW_WRITES=true');
  }
  if (missing.length) {
    throw new Error(`Live lab smoke is fail-closed; missing explicit disposable test configuration: ${missing.join(', ')}`);
  }
}

async function main(): Promise<void> {
  requireLiveConfiguration();
  const runId = `live-smoke-${Date.now()}-${process.pid}`;
  const tenant = process.env.MEMBERRY_LAB_TENANT_ID!;
  const namespace = { runId, tenant, project: 'live-smoke' };
  const marker = `lab-marker-${runId}`;
  const adapter = new MemberryLiveAdapter(memberryLiveOptionsFromEnv());

  const health = await adapter.health();
  if (health.status !== 'ready') throw new Error(`live adapter is not ready: ${JSON.stringify(health.details)}`);

  const ingest = await adapter.ingest({
    namespace,
    memories: [{
      id: 'live-smoke-current',
      content: `${marker} uses a synthetic cranberry endpoint for integration verification`,
      kind: 'fact',
      recordedAt: new Date().toISOString(),
    }],
  });
  if (ingest.accepted !== 1 || ingest.rejected.length) {
    throw new Error(`live ingest failed: ${JSON.stringify(ingest)}`);
  }

  const verified = await adapter.verifySyntheticFixture(namespace, 'live-smoke-current');
  if (!verified) {
    throw new Error('berry_grep did not return the synthetic fixture from its isolated project scope');
  }

  const cleanup = await adapter.cleanup(namespace);
  if (cleanup.deleted !== 0 || adapter.capabilities.has('cleanup')) {
    throw new Error('live adapter must not claim destructive cleanup capability');
  }
  console.log(JSON.stringify({
    ok: true,
    adapter: adapter.id,
    health: health.status,
    accepted: ingest.accepted,
    exactVerification: 'berry_grep',
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
