import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  assertContentFreeObservation,
  assertFixtureCounts,
  assertReadinessContract,
  acquireAdmissionLiveResources,
  childEnvironment,
  compositionRootCommand,
  probeAdmissionCompositionRoot,
  resolveAdmissionLiveConfig,
  runBoundedCleanupSteps,
  sanitizeAdmissionEvidence,
  stopChildProcessBounded,
  waitForAdmissionReadiness,
} from '../live-composition.js';

const readiness = (enabled: boolean) => ({
  status: 'ready',
  admission_shadow: {
    schema_version: 1,
    enabled,
    mode: enabled ? 'shadow' : 'disabled',
    health: enabled ? 'healthy' : 'disabled',
    affects_readiness: false,
    delivery: 'best-effort-bounded-terminal',
    recovery: 'none',
    completeness: 'not-provable',
    durable_retry: false,
    self_healing: false,
    history_complete: false,
    history_scope: 'process-lifetime',
    crash_gap_possible: enabled,
    stopping: false,
    last_failure_code: null,
    registered_runtimes: 1,
    timeout_ms: [50],
    max_in_flight: 32,
    counters: {
      prepared: 0,
      preparation_failures: 0,
      append_attempts: 0,
      appended: 0,
      append_failures: 0,
      timed_out: 0,
      capacity_rejected: 0,
      shutdown_skipped: 0,
      late_appended: 0,
      late_failures: 0,
      reserved: 0,
      in_flight: 0,
    },
  },
});

const retrievalResolution = () => ({
  schema_version: 1,
  affects_readiness: false,
  history_scope: 'process-lifetime',
  history_complete: false,
  counters_saturated: false,
  caller_type_known: false,
  content_captured: false,
  identity_captured: false,
  calls: { total: 0, berry_context: 0, berry_ask: 0 },
  routing: { unanchored: 0, anchored_legacy: 0, anchored_resolver: 0 },
  resolution: {
    attempted: 0,
    resolved: 0,
    failed: 0,
    success_rate: null,
    invalid_request: 0,
    resolution_failed: 0,
    authentication_required: 0,
    unavailable: 0,
    other_failure: 0,
  },
});

const canonicalDomains = [
  { domain: 'memory', description: 'Block memory operations: replace, rewrite, promote, archive', tools: ['berry_memory_replace', 'berry_memory_rewrite', 'berry_memory_promote', 'berry_memory_archive'], enabled: false },
  { domain: 'temporal', description: 'Temporal queries: timeline, fact diff', tools: ['berry_timeline', 'berry_fact_diff'], enabled: false },
  { domain: 'admin', description: 'Administrative: raw queries, consolidation, bootstrap, resolve, codebase ingestion, provenance', tools: ['berry_query', 'berry_consolidate', 'berry_bootstrap', 'berry_resolve', 'berry_ingest_codebase', 'berry_provenance'], enabled: false },
  { domain: 'retrieval', description: 'Retrieval feedback (berry_context stays in Tier 1)', tools: ['berry_feedback'], enabled: false },
];

function mcpResponses(domains = canonicalDomains): Response[] {
  return [
    new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26' } }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'mcp-session-id': 'fixture-session' },
    }),
    new Response('', { status: 202 }),
    new Response(JSON.stringify({
      jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: JSON.stringify({ domains }) }] },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  ];
}

function liveConfig() {
  return resolveAdmissionLiveConfig({
    MEMBERRY_ADMISSION_LIVE_ALLOW_WRITES: 'true',
    MEMBERRY_ADMISSION_LIVE_DISPOSABLE: 'true',
    MEMBERRY_ADMISSION_LIVE_API_TOKEN: 'fixture-token',
    MEMBERRY_ADMISSION_LIVE_MCP_URL: 'http://127.0.0.1:3311',
    MEMBERRY_ADMISSION_LIVE_REDIS_URL: 'redis://127.0.0.1:6379',
    MEMBERRY_ADMISSION_LIVE_NEO4J_URI: 'bolt://127.0.0.1:7687',
    MEMBERRY_ADMISSION_LIVE_NEO4J_USER: 'neo4j',
    MEMBERRY_ADMISSION_LIVE_NEO4J_PASSWORD: 'fixture-password',
  });
}

const logicalMultiTenantLimitation =
  'shared logical multi-tenant consolidation and wiki publication are disabled to prevent cross-tenant disclosure';
const noProviderLimitation =
  'recurring/synthesized semantic promotion is unavailable without an LLM/embedding provider; approved classified decisions still promote and episodic recall remains available';
const disposableLimitation = `${logicalMultiTenantLimitation}; ${noProviderLimitation}`;

function expectedDegradedReadiness() {
  return {
    status: 'ready',
    service: 'memberry-mcp',
    transport: 'sse',
    active_sessions: 0,
    registered_sessions: 0,
    auth_required: true,
    uptime_ms: 10,
    consolidation_automation: {
      enabled: false,
      unhealthy: true,
      degraded: true,
      limitations: [`default: ${disposableLimitation}`],
      workers: [{
        name: 'default', enabled: false, readonly: false, running_scope: null,
        queued_scopes: [], last_attempt_at: null, last_success_at: null, last_error: null,
        limitation: disposableLimitation, health: 'unhealthy', stale: false,
        exhausted_failure: false,
        discovery: { last_error: null, pending_retry: null, exhausted_failure: false },
        publication: {
          needed_since: null, last_success_at: null, last_error: null, pending_retry: null,
          exhausted_failure: false, dirty_version: null, published_version: null,
        },
        pending_retries: [],
      }],
    },
    admission_shadow: readiness(false).admission_shadow,
    retrieval_resolution: retrievalResolution(),
  };
}

describe('MEM-001D2 live composition evidence contract', () => {
  it('starts the real HTTP composition root and probes authenticated readiness plus Streamable HTTP MCP', async () => {
    const config = liveConfig();
    const command = compositionRootCommand();
    expect(command.args).toEqual(['--import', 'tsx', 'packages/mcp/src/server.ts']);
    expect(command.args).not.toContain('--stdio');

    const requests: Array<{ url: string; method: string; authorization?: string }> = [];
    const responses = [
      new Response(JSON.stringify(expectedDegradedReadiness()), {
        status: 503, headers: { 'content-type': 'application/json' },
      }),
      ...mcpResponses(),
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: String(input),
        method: init?.method ?? 'GET',
        authorization: headers.get('authorization') ?? undefined,
      });
      const response = responses.shift();
      if (!response) throw new Error('unexpected request');
      return response;
    };
    try {
      await expect(probeAdmissionCompositionRoot(config)).resolves.toMatchObject({ status: 'ready' });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(requests).toEqual([
      { url: 'http://127.0.0.1:3311/readyz', method: 'GET', authorization: 'Bearer fixture-token' },
      { url: 'http://127.0.0.1:3311/mcp', method: 'POST', authorization: 'Bearer fixture-token' },
      { url: 'http://127.0.0.1:3311/mcp', method: 'POST', authorization: 'Bearer fixture-token' },
      { url: 'http://127.0.0.1:3311/mcp', method: 'POST', authorization: 'Bearer fixture-token' },
    ]);
  });

  it('uses closed diagnostics and rejects forged or incomplete Streamable HTTP proof', async () => {
    const config = liveConfig();
    const originalFetch = globalThis.fetch;
    const run = async (responses: Response[]) => {
      globalThis.fetch = async () => {
        const response = responses.shift();
        if (!response) throw new Error('unexpected request');
        return response;
      };
      try { return await probeAdmissionCompositionRoot(config); }
      finally { globalThis.fetch = originalFetch; }
    };

    const forgedSecret = 'FORGED-UPSTREAM-SECRET';
    const forged = run([
      new Response(JSON.stringify(expectedDegradedReadiness()), { status: 503 }),
      new Response(forgedSecret, { status: 500 }),
    ]);
    await expect(forged).rejects.toThrow(/MEM001D2_MCP_HTTP_FAILURE/);
    await expect(forged).rejects.not.toThrow(new RegExp(forgedSecret));

    await expect(run([
      new Response(JSON.stringify(expectedDegradedReadiness()), { status: 503 }),
      ...mcpResponses([]),
    ])).rejects.toThrow(/MEM001D2_MCP_REGISTRY_INVALID/);

    const forgedDescriptions = structuredClone(canonicalDomains);
    forgedDescriptions[0]!.description = 'FORGED_DESCRIPTIONS_ACCEPTED';
    await expect(run([
      new Response(JSON.stringify(expectedDegradedReadiness()), { status: 503 }),
      ...mcpResponses(forgedDescriptions),
    ])).rejects.toThrow(/MEM001D2_MCP_REGISTRY_INVALID/);

    await expect(run([
      new Response(JSON.stringify(expectedDegradedReadiness()), { status: 503 }),
      ...mcpResponses([...canonicalDomains].reverse()),
    ])).rejects.toThrow(/MEM001D2_MCP_REGISTRY_INVALID/);

    const source = await readFile(fileURLToPath(new URL('../live-composition.ts', import.meta.url)), 'utf8');
    expect(source).not.toContain('HttpMemberryTransport');
    expect(source).not.toContain('response.text()');
    expect(source.match(/new BoundedAdmissionMcpTransport/g)?.length).toBe(3);
    expect(source).toContain('DOMAIN_DESCRIPTIONS[domain]');
    expect(source).toContain('DOMAIN_TOOL_NAMES_MAP[domain]');
  });

  it('bounds readiness and Streamable HTTP response bodies while streaming', async () => {
    const config = liveConfig();
    const originalFetch = globalThis.fetch;
    const oversized = () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 40; index++) controller.enqueue(new Uint8Array(8192));
        controller.close();
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const run = async (responses: Response[]) => {
      globalThis.fetch = async () => {
        const response = responses.shift();
        if (!response) throw new Error('unexpected request');
        return response;
      };
      try { return await probeAdmissionCompositionRoot(config); }
      finally { globalThis.fetch = originalFetch; }
    };

    await expect(run([oversized()])).rejects.toThrow(/MEM001D2_READINESS_RESPONSE_TOO_LARGE/);
    await expect(run([
      new Response(JSON.stringify(expectedDegradedReadiness()), { status: 503 }),
      oversized(),
    ])).rejects.toThrow(/MEM001D2_MCP_RESPONSE_TOO_LARGE/);
  });

  it('fails immediately on stable readiness HTTP errors and retries only explicit transient status', async () => {
    const config = liveConfig();
    const originalFetch = globalThis.fetch;
    try {
      for (const status of [401, 403, 404, 500]) {
        let calls = 0;
        globalThis.fetch = async () => {
          calls += 1;
          return new Response('FORGED-READINESS-BODY-SECRET', { status });
        };
        let failure: Error | undefined;
        try {
          await waitForAdmissionReadiness(() => probeAdmissionCompositionRoot(config), 1_000, {
            now: () => 0,
            sleep: async () => { throw new Error('nonretryable readiness status was retried'); },
          });
        } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); }
        expect(failure?.message).toBe(`MEM001D2_READINESS_HTTP_${status}`);
        expect(failure?.message).not.toContain('FORGED-READINESS-BODY-SECRET');
        expect(calls).toBe(1);
      }

      let clock = 0;
      let transientCalls = 0;
      globalThis.fetch = async () => {
        transientCalls += 1;
        return new Response('TRANSIENT-BODY-MUST-NOT-LEAK', { status: 503 });
      };
      let transientFailure: Error | undefined;
      try {
        await waitForAdmissionReadiness(() => probeAdmissionCompositionRoot(config), 600, {
          now: () => clock,
          sleep: async (ms) => { clock += ms; },
        });
      } catch (error) { transientFailure = error instanceof Error ? error : new Error(String(error)); }
      expect(transientCalls).toBe(3);
      expect(transientFailure?.message)
        .toBe('MEM001D2_READINESS_STARTUP_TIMEOUT__MEM001D2_READINESS_HTTP_503');
      expect(transientFailure?.message).not.toContain('TRANSIENT-BODY-MUST-NOT-LEAK');

      const expectedDegraded = expectedDegradedReadiness();

      globalThis.fetch = async () => new Response(JSON.stringify(expectedDegraded), { status: 200 });
      await expect(probeAdmissionCompositionRoot(config))
        .rejects.toThrow('MEM001D2_READINESS_STATUS_MISMATCH');
      globalThis.fetch = async () => new Response(JSON.stringify(readiness(false)), { status: 200 });
      await expect(probeAdmissionCompositionRoot(config))
        .rejects.toThrow('MEM001D2_READINESS_STATUS_MISMATCH');
      const wrongAutomationOver200 = structuredClone(expectedDegraded);
      wrongAutomationOver200.consolidation_automation.unhealthy = false;
      globalThis.fetch = async () => new Response(JSON.stringify(wrongAutomationOver200), { status: 200 });
      await expect(probeAdmissionCompositionRoot(config))
        .rejects.toThrow('MEM001D2_READINESS_STATUS_MISMATCH');

      const negativeSessions = structuredClone(expectedDegraded);
      negativeSessions.active_sessions = -1;
      negativeSessions.registered_sessions = -1;
      globalThis.fetch = async () => new Response(JSON.stringify(negativeSessions), { status: 503 });
      await expect(probeAdmissionCompositionRoot(config))
        .rejects.toThrow('MEM001D2_READINESS_HTTP_503');

      let expected503Calls = 0;
      const expected503Responses = [
        new Response(JSON.stringify(expectedDegraded), { status: 503 }),
        ...mcpResponses(),
      ];
      globalThis.fetch = async () => {
        expected503Calls += 1;
        const response = expected503Responses.shift();
        if (!response) throw new Error('unexpected request');
        return response;
      };
      await expect(waitForAdmissionReadiness(() => probeAdmissionCompositionRoot(config), 1_000, {
        now: () => 0,
        sleep: async () => { throw new Error('expected degraded readiness must not retry'); },
      })).resolves.toMatchObject({
        evidence_http_status: 503,
        evidence_readiness_class: 'expected-logical-multitenant-degraded',
      });
      expect(expected503Calls).toBe(4);

      // D1/A6 readiness probe fields ride on the same 503 body once the server
      // registers a datastore probe source; the harness must accept exactly that
      // closed shape and nothing looser.
      const probed = structuredClone(expectedDegraded) as any;
      probed.datastores = { neo4j: 'ok', redis: 'ok' };
      probed.embeddings = 'disabled';
      probed.degraded = ['embeddings: disabled (no OPENAI_API_KEY) — lexical/fulltext retrieval only'];
      probed.retrieval = { collection_size: { state: 'never', cached_at: 0 } };
      probed.lifecycle = { mode: 'disabled', last_run_at: null, last_result: 'never' };
      const probedResponses = [new Response(JSON.stringify(probed), { status: 503 }), ...mcpResponses()];
      globalThis.fetch = async () => {
        const response = probedResponses.shift();
        if (!response) throw new Error('unexpected request');
        return response;
      };
      await expect(probeAdmissionCompositionRoot(config)).resolves.toMatchObject({
        evidence_http_status: 503,
        evidence_readiness_class: 'expected-logical-multitenant-degraded',
      });

      const hostile: Array<Record<string, unknown>> = [];
      const datastoreExtra = structuredClone(probed) as any;
      datastoreExtra.datastores.note = 'FORGED-UPSTREAM-SECRET';
      hostile.push(datastoreExtra);
      const datastoreUnreachable = structuredClone(probed) as any;
      datastoreUnreachable.datastores.neo4j = 'unreachable';
      hostile.push(datastoreUnreachable);
      const embeddingsUnknown = structuredClone(probed) as any;
      embeddingsUnknown.embeddings = 'FORGED-UPSTREAM-SECRET';
      hostile.push(embeddingsUnknown);
      const partialProbe = structuredClone(expectedDegraded) as any;
      partialProbe.lifecycle = probed.lifecycle;
      hostile.push(partialProbe);
      const probeMissingDegraded = structuredClone(probed) as any;
      delete probeMissingDegraded.degraded;
      hostile.push(probeMissingDegraded);
      const extraWorker = structuredClone(expectedDegraded) as any;
      extraWorker.consolidation_automation.workers.push({ name: 'unrelated' });
      hostile.push(extraWorker);
      const duplicateDefault = structuredClone(expectedDegraded) as any;
      duplicateDefault.consolidation_automation.workers.push(
        structuredClone(duplicateDefault.consolidation_automation.workers[0]),
      );
      hostile.push(duplicateDefault);
      const suffixInjection = structuredClone(expectedDegraded) as any;
      suffixInjection.consolidation_automation.workers[0].limitation += '; FORGED-SECRET-OUTAGE';
      hostile.push(suffixInjection);
      const automationExtra = structuredClone(expectedDegraded) as any;
      automationExtra.consolidation_automation.forged = true;
      hostile.push(automationExtra);
      const workerExtra = structuredClone(expectedDegraded) as any;
      workerExtra.consolidation_automation.workers[0].forged = true;
      hostile.push(workerExtra);
      const forgedSummary = structuredClone(expectedDegraded) as any;
      forgedSummary.consolidation_automation.limitations = ['default: FORGED-SUMMARY'];
      hostile.push(forgedSummary);
      const topLevelExtra = structuredClone(expectedDegraded) as any;
      topLevelExtra.forged = 'FORGED-TOP-LEVEL';
      hostile.push(topLevelExtra);
      const missingAutomation = structuredClone(expectedDegraded) as any;
      delete missingAutomation.consolidation_automation;
      hostile.push(missingAutomation);
      const shadowExtra = structuredClone(expectedDegraded) as any;
      shadowExtra.admission_shadow.note = 'FORGED-UPSTREAM-SECRET';
      hostile.push(shadowExtra);
      const countersExtra = structuredClone(expectedDegraded) as any;
      countersExtra.admission_shadow.counters.note = 'FORGED-UPSTREAM-SECRET';
      hostile.push(countersExtra);
      const missingResolution = structuredClone(expectedDegraded) as any;
      delete missingResolution.retrieval_resolution;
      hostile.push(missingResolution);
      const resolutionExtra = structuredClone(expectedDegraded) as any;
      resolutionExtra.retrieval_resolution.note = 'FORGED-UPSTREAM-SECRET';
      hostile.push(resolutionExtra);
      const resolutionCallsExtra = structuredClone(expectedDegraded) as any;
      resolutionCallsExtra.retrieval_resolution.calls.note = 'FORGED-UPSTREAM-SECRET';
      hostile.push(resolutionCallsExtra);
      const resolutionRoutingExtra = structuredClone(expectedDegraded) as any;
      resolutionRoutingExtra.retrieval_resolution.routing.note = 'FORGED-UPSTREAM-SECRET';
      hostile.push(resolutionRoutingExtra);
      const resolutionOutcomeExtra = structuredClone(expectedDegraded) as any;
      resolutionOutcomeExtra.retrieval_resolution.resolution.note = 'FORGED-UPSTREAM-SECRET';
      hostile.push(resolutionOutcomeExtra);
      const negativeResolutionCounter = structuredClone(expectedDegraded) as any;
      negativeResolutionCounter.retrieval_resolution.resolution.resolved = -1;
      hostile.push(negativeResolutionCounter);
      const inconsistentResolutionCalls = structuredClone(expectedDegraded) as any;
      inconsistentResolutionCalls.retrieval_resolution.calls.total = 1;
      hostile.push(inconsistentResolutionCalls);
      const inconsistentResolutionRate = structuredClone(expectedDegraded) as any;
      inconsistentResolutionRate.retrieval_resolution.resolution.success_rate = 1;
      hostile.push(inconsistentResolutionRate);

      for (const forged of hostile) {
        globalThis.fetch = async () => new Response(JSON.stringify(forged), { status: 503 });
        let failure: Error | undefined;
        try { await probeAdmissionCompositionRoot(config); }
        catch (error) { failure = error instanceof Error ? error : new Error(String(error)); }
        expect(failure?.message).toBe('MEM001D2_READINESS_HTTP_503');
        expect(failure?.message).not.toMatch(/FORGED|SECRET|OUTAGE|SUMMARY/);
      }

      const bootstrapSource = await readFile(fileURLToPath(
        new URL('../../../../packages/mcp/src/bootstrap.ts', import.meta.url),
      ), 'utf8');
      expect(bootstrapSource).toContain(`? '${logicalMultiTenantLimitation}'`);
      expect(bootstrapSource).toContain(`? '${noProviderLimitation}'`);
      expect(bootstrapSource).toContain('forceUnhealthy: logicalMultiTenant');
      const coordinatorSource = await readFile(fileURLToPath(
        new URL('../../../../packages/mcp/src/consolidation-coordinator.ts', import.meta.url),
      ), 'utf8');
      for (const required of [
        'running_scope: this.runningScope', 'queued_scopes:', 'discovery:', 'publication:', 'pending_retries:',
      ]) expect(coordinatorSource).toContain(required);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fails closed unless writes are explicitly disposable and every endpoint is loopback-only', () => {
    const valid = {
      MEMBERRY_ADMISSION_LIVE_ALLOW_WRITES: 'true',
      MEMBERRY_ADMISSION_LIVE_DISPOSABLE: 'true',
      MEMBERRY_ADMISSION_LIVE_API_TOKEN: 'fixture-token',
      MEMBERRY_ADMISSION_LIVE_MCP_URL: 'http://127.0.0.1:3311',
      MEMBERRY_ADMISSION_LIVE_REDIS_URL: 'redis://127.0.0.1:6379',
      MEMBERRY_ADMISSION_LIVE_NEO4J_URI: 'bolt://127.0.0.1:7687',
      MEMBERRY_ADMISSION_LIVE_NEO4J_USER: 'neo4j',
      MEMBERRY_ADMISSION_LIVE_NEO4J_PASSWORD: 'fixture-password',
    };
    expect(() => resolveAdmissionLiveConfig({ ...valid, MEMBERRY_ADMISSION_LIVE_ALLOW_WRITES: 'false' }))
      .toThrow(/ALLOW_WRITES=true/);
    expect(() => resolveAdmissionLiveConfig({ ...valid, MEMBERRY_ADMISSION_LIVE_DISPOSABLE: 'false' }))
      .toThrow(/DISPOSABLE=true/);
    expect(() => resolveAdmissionLiveConfig({ ...valid, MEMBERRY_ADMISSION_LIVE_NEO4J_URI: 'bolt:\/\/192.168.0.25:7687' }))
      .toThrow(/loopback/);
    const unsafeUrls: Array<[keyof typeof valid, string]> = [
      ['MEMBERRY_ADMISSION_LIVE_MCP_URL', 'http://127.0.0.1:3311/?token=topsecret'],
      ['MEMBERRY_ADMISSION_LIVE_REDIS_URL', 'redis://127.0.0.1:6379/#topsecret'],
      ['MEMBERRY_ADMISSION_LIVE_NEO4J_URI', 'bolt://user%3Asecret@127.0.0.1:7687'],
      ['MEMBERRY_ADMISSION_LIVE_MCP_URL', 'http://%31%32%37.0.0.1:3311'],
      ['MEMBERRY_ADMISSION_LIVE_MCP_URL', 'http://127.0.0.2:3311'],
      ['MEMBERRY_ADMISSION_LIVE_REDIS_URL', 'redis://localhost.evil.invalid:6379'],
      ['MEMBERRY_ADMISSION_LIVE_NEO4J_URI', 'bolt://[::ffff:127.0.0.1]:7687'],
      ['MEMBERRY_ADMISSION_LIVE_MCP_URL', 'http://127.0.0.1:3311/plain-path-secret'],
      ['MEMBERRY_ADMISSION_LIVE_REDIS_URL', 'redis://127.0.0.1:6379/plain-path-secret'],
      ['MEMBERRY_ADMISSION_LIVE_NEO4J_URI', 'bolt://127.0.0.1:7687/plain-path-secret'],
    ];
    for (const [name, url] of unsafeUrls) {
      let message = '';
      try { resolveAdmissionLiveConfig({ ...valid, [name]: url }); }
      catch (error) { message = error instanceof Error ? error.message : String(error); }
      expect(message, `${name} ${url}`).not.toBe('');
      expect(message, `${name} ${url}`).not.toContain('topsecret');
      expect(message, `${name} ${url}`).not.toContain('user:secret');
      expect(message, `${name} ${url}`).not.toContain('plain-path-secret');
    }

    expect(resolveAdmissionLiveConfig({
      ...valid,
      MEMBERRY_ADMISSION_LIVE_MCP_URL: 'http://localhost:3311',
      MEMBERRY_ADMISSION_LIVE_REDIS_URL: 'redis://[::1]:6379',
      MEMBERRY_ADMISSION_LIVE_NEO4J_URI: 'bolt://localhost:7687',
    }).host).toBe('localhost');

    const config = resolveAdmissionLiveConfig(valid);
    expect(config.safeConfig).toEqual({
      mcpUrl: 'http://127.0.0.1:3311',
      redisUrl: 'redis://127.0.0.1:6379',
      neo4jUri: 'bolt://127.0.0.1:7687',
      host: '127.0.0.1',
      port: 3311,
      timeoutMs: 50,
      startupTimeoutMs: 300000,
      writeAuthorization: 'explicit-disposable-only',
      modes: ['default-off', 'shadow-enabled'],
    });
    expect(JSON.stringify(config.safeConfig)).not.toContain('fixture-token');
    expect(JSON.stringify(config.safeConfig)).not.toContain('fixture-password');

    process.env.MEM001D2_UNRELATED_PARENT_SECRET = 'must-not-cross-process-boundary';
    try {
      const child = childEnvironment(config, true, 'C:\\fixture-export', 'mem001d2-fixture-tenant');
      expect(child.MEM001D2_UNRELATED_PARENT_SECRET).toBeUndefined();
      expect(child.OPENAI_API_KEY).toBe('');
      expect(child.MEMBERRY_ADMISSION_SHADOW_ENABLED).toBe('true');
      expect(child.MEMBERRY_TENANT_TOKENS).toBe('mem001d2-fixture-tenant:fixture-token');
      expect(child.MEMBERRY_API_TOKEN).toBeUndefined();
    } finally {
      delete process.env.MEM001D2_UNRELATED_PARENT_SECRET;
    }
  });

  it('requires readiness to report the exact default-off and enabled limitations', () => {
    const defaultEvidence = {
      ...readiness(false), evidence_http_status: 503,
      evidence_readiness_class: 'expected-logical-multitenant-degraded',
    };
    const defaultProjection = assertReadinessContract(defaultEvidence, false);
    expect(defaultProjection).toMatchObject({
      mode: 'disabled',
      evidence_http_status: 503,
      evidence_readiness_class: 'expected-logical-multitenant-degraded',
    });
    expect(Object.keys(defaultProjection)).toEqual([
      'schema_version', 'enabled', 'mode', 'health', 'affects_readiness', 'delivery',
      'recovery', 'completeness', 'durable_retry', 'self_healing', 'history_complete',
      'history_scope', 'crash_gap_possible', 'stopping', 'last_failure_code',
      'registered_runtimes', 'timeout_ms', 'max_in_flight', 'counters',
      'evidence_http_status', 'evidence_readiness_class',
    ]);
    const finalEvidenceShape = { result: { defaultOff: { readiness: defaultProjection } } };
    expect(finalEvidenceShape.result.defaultOff.readiness).toMatchObject({
      evidence_http_status: 503,
      evidence_readiness_class: 'expected-logical-multitenant-degraded',
    });
    const enabledEvidence = {
      ...readiness(true), evidence_http_status: 503,
      evidence_readiness_class: 'expected-logical-multitenant-degraded',
    };
    expect(assertReadinessContract(enabledEvidence, true)).toMatchObject({
      mode: 'shadow',
      delivery: 'best-effort-bounded-terminal',
      durable_retry: false,
      self_healing: false,
      history_complete: false,
      crash_gap_possible: true,
    });
    const dishonest = structuredClone(enabledEvidence);
    dishonest.admission_shadow.self_healing = true;
    expect(() => assertReadinessContract(dishonest, true)).toThrow(/self_healing/);

    const shadowInjection = structuredClone(defaultEvidence) as any;
    shadowInjection.admission_shadow.note = 'FORGED-UPSTREAM-SECRET';
    expect(() => assertReadinessContract(shadowInjection, false)).toThrow(/admission_shadow shape/);

    const topLevelInjection = structuredClone(defaultEvidence) as any;
    topLevelInjection.note = 'FORGED-UPSTREAM-SECRET';
    expect(() => assertReadinessContract(topLevelInjection, false)).toThrow(/readiness shape/);

    const countersInjection = structuredClone(defaultEvidence) as any;
    countersInjection.admission_shadow.counters.note = 'FORGED-UPSTREAM-SECRET';
    expect(() => assertReadinessContract(countersInjection, false)).toThrow(/counters shape/);

    const negativeCounter = structuredClone(defaultEvidence) as any;
    negativeCounter.admission_shadow.counters.prepared = -1;
    expect(() => assertReadinessContract(negativeCounter, false)).toThrow(/counters values/);
  });

  it('accepts only one correctly linked content-free observation', () => {
    const scope = { tenantId: 'default', projectScope: 'project:memberry-eval-live', episodeId: 'ep-1' };
    const properties = {
      id: 'admission-observation:sha256:abc', tenant_id: 'default', project_scope: scope.projectScope,
      contract_version: '1.0.0', capture_state: 'accepted-nonduplicate', memory_class: 'general', outcome: 'unspecified',
      tenant_scope: 'resolved', safe_project_scope: 'resolved', sensitivity: 'not-detected', redaction_configured: false,
      has_signals: false, has_entities: false, has_model: false, policy_id: 'baseline-parity-admission', policy_version: '1.0.0',
      recommended_tier: 'episodic', would_change_baseline: false,
      reason_code: 'baseline-parity-accepted-nonduplicate', observed_at: '2026-08-15T00:00:00.000Z',
    };
    expect(assertContentFreeObservation({ scope, properties, observationCount: 1, exactLinkCount: 1 })).toEqual(properties);
    expect(() => assertContentFreeObservation({
      scope,
      properties: { ...properties, content: 'forbidden fixture content' },
      observationCount: 1,
      exactLinkCount: 1,
    })).toThrow(/content-free/);
  });

  it('sanitizes evidence recursively without retaining configured credentials or fixture content', () => {
    expect(sanitizeAdmissionEvidence({
      authorization: 'Bearer fixture-token',
      password: 'fixture-password',
      result: { content: 'synthetic fixture prose', count: 1 },
    }, ['fixture-token', 'fixture-password', 'synthetic fixture prose'])).toEqual({
      authorization: '[REDACTED]',
      password: '[REDACTED]',
      result: { content: '[REDACTED]', count: 1 },
    });
  });

  it('canonicalizes sanitizer input without invoking accessors or accepting exotic containers', () => {
    expect(sanitizeAdmissionEvidence({ nested: [{ token: 'secret' }, { value: 'prefix-secret-suffix' }] }, ['secret']))
      .toEqual({ nested: [{ token: '[REDACTED]' }, { value: 'prefix-[REDACTED]-suffix' }] });

    let reads = 0;
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, 'authorization', {
      enumerable: true,
      get() { reads += 1; return 'Bearer secret'; },
    });
    expect(() => sanitizeAdmissionEvidence(accessor, ['secret'])).toThrow(/accessor/);
    expect(reads).toBe(0);
    expect(() => sanitizeAdmissionEvidence(new Proxy({ value: 'safe' }, {}), [])).toThrow(/proxy/);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => sanitizeAdmissionEvidence(circular, [])).toThrow(/circular/);

    const symbolKey = { value: 'safe' } as Record<PropertyKey, unknown>;
    symbolKey[Symbol('hidden')] = 'secret';
    expect(() => sanitizeAdmissionEvidence(symbolKey, ['secret'])).toThrow(/symbol/);
    expect(() => sanitizeAdmissionEvidence(new Date(), [])).toThrow(/plain records/);

    const prototypeKeys: Record<string, unknown> = {};
    Object.defineProperty(prototypeKeys, '__proto__', {
      value: { polluted: true }, enumerable: true, configurable: true, writable: true,
    });
    Object.defineProperty(prototypeKeys, 'constructor', {
      value: 'fixture-constructor', enumerable: true, configurable: true, writable: true,
    });
    Object.defineProperty(prototypeKeys, 'prototype', {
      value: 'fixture-prototype', enumerable: true, configurable: true, writable: true,
    });
    const canonical = sanitizeAdmissionEvidence(prototypeKeys, []) as Record<string, unknown>;
    expect(Object.getPrototypeOf(canonical)).toBe(Object.prototype);
    expect(Object.hasOwn(canonical, '__proto__')).toBe(true);
    expect(canonical.__proto__).toEqual({ polluted: true });
    expect(Object.hasOwn(canonical, 'constructor')).toBe(true);
    expect(canonical.constructor).toBe('fixture-constructor');
    expect(Object.hasOwn(canonical, 'prototype')).toBe(true);
    expect(canonical.prototype).toBe('fixture-prototype');
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('conditionally releases every acquired initialization resource on git and temp failures', async () => {
    const calls: string[] = [];
    const driver = { close: async () => { calls.push('driver-close'); } };
    await expect(acquireAdmissionLiveResources({
      createDriver: () => driver,
      createTemp: async () => { calls.push('temp-create'); return 'fixture-temp'; },
      getGitState: async () => { throw new Error('git-state-injection'); },
      removeTemp: async (path) => { calls.push(`temp-remove:${path}`); },
    }, 20)).rejects.toThrow(/git-state-injection/);
    expect(calls).toEqual(['temp-create', 'driver-close', 'temp-remove:fixture-temp']);

    calls.length = 0;
    await expect(acquireAdmissionLiveResources({
      createDriver: () => driver,
      createTemp: async () => { throw new Error('mkdtemp-injection'); },
      getGitState: async () => ({ sha: 'a'.repeat(40), dirty: false }),
      removeTemp: async (path) => { calls.push(`temp-remove:${path}`); },
    }, 20)).rejects.toThrow(/mkdtemp-injection/);
    expect(calls).toEqual(['driver-close']);
  });

  it('bounds process exit and continues every cleanup step after stop failure or timeout', async () => {
    class FakeChild extends EventEmitter {
      exitCode: number | null = null;
      readonly signals: string[] = [];
      constructor(private readonly mode: 'never' | 'throw-term-exit-kill') { super(); }
      kill(signal?: NodeJS.Signals | number): boolean {
        this.signals.push(String(signal));
        if (this.mode === 'throw-term-exit-kill' && signal === 'SIGTERM') throw new Error('term injection');
        if (this.mode === 'throw-term-exit-kill' && signal === 'SIGKILL') {
          this.exitCode = 137;
          queueMicrotask(() => this.emit('exit', 137, 'SIGKILL'));
        }
        return true;
      }
    }

    const never = new FakeChild('never');
    await expect(stopChildProcessBounded(never, 5, 5)).rejects.toThrow(/confirmed exit/);
    expect(never.signals).toEqual(['SIGTERM', 'SIGKILL']);

    const injected = new FakeChild('throw-term-exit-kill');
    await expect(stopChildProcessBounded(injected, 5, 20)).rejects.toThrow(/term injection/);
    expect(injected.exitCode).toBe(137);

    const ran: string[] = [];
    const failures = await runBoundedCleanupSteps([
      { name: 'stop', run: () => Promise.reject(new Error('stop failed')) },
      { name: 'graph', run: () => new Promise<void>(() => {}) },
      { name: 'driver', run: async () => { ran.push('driver'); } },
      { name: 'temp', run: async () => { ran.push('temp'); } },
    ], 5);
    expect(failures.map(({ name }) => name)).toEqual(['stop', 'graph']);
    expect(ran).toEqual(['driver', 'temp']);
  });

  it('runs the full lab tests and lab typecheck in both Node unit matrix entries', async () => {
    const root = fileURLToPath(new URL('../../../../', import.meta.url));
    const workflow = await readFile(`${root}/.github/workflows/ci.yml`, 'utf8');
    const unitJob = workflow.slice(workflow.indexOf('  unit:'), workflow.indexOf('  # Full job:'));
    expect(unitJob).toContain('node-version: [20, 22]');
    expect(unitJob).toContain('run: npm run bench:lab:test');
    expect(unitJob).toContain('run: npm run bench:lab:typecheck');
  });

  it('deletes only exact auto-created project fixtures and residual-counts every same-name Entity', async () => {
    const source = await readFile(fileURLToPath(new URL('../live-composition.ts', import.meta.url)), 'utf8');
    expect(source).toContain('p.name IN $projectNames');
    expect(source).toContain("p.type = 'project'");
    expect(source).toContain('p.auto_created = true');
    expect(source).toContain("p.description = 'Auto-created from berry_store on first reference'");
    expect(source).toContain("p.id STARTS WITH 'auto-proj-'");
    expect(source).toContain('count(DISTINCT p) AS projectEntities');
    expect(source).toContain("assertFixtureCounts('CLEANUP', cleanup");
  });

  it('uses exact composition-root project Entity truth and bounded numeric count diagnostics', async () => {
    expect(() => assertFixtureCounts('DEFAULT_OFF', {
      episodes: 1, observations: 0, projectEntities: 0,
    }, {
      episodes: 1, observations: 0, projectEntities: 1,
    })).toThrow('MEM001D2_DEFAULT_OFF_COUNTS_E1_O0_P0_EXPECTED_E1_O0_P1');
    expect(() => assertFixtureCounts('DEFAULT_OFF', {
      episodes: Number.NaN, observations: -1, projectEntities: Number.MAX_SAFE_INTEGER + 1,
    }, {
      episodes: 1, observations: 0, projectEntities: 0,
    })).toThrow('MEM001D2_DEFAULT_OFF_COUNTS_EINVALID_OINVALID_PINVALID_EXPECTED_E1_O0_P0');
    expect(() => assertFixtureCounts('DEFAULT_OFF', {
      episodes: 1, observations: 0, projectEntities: 0,
    }, {
      episodes: 1, observations: 0, projectEntities: 0,
    })).not.toThrow();

    const factorySource = await readFile(fileURLToPath(
      new URL('../../../../packages/core/src/services-factory.ts', import.meta.url),
    ), 'utf8');
    expect(factorySource).not.toContain('EntityStore');
    const constructorStart = factorySource.indexOf('const ampService = new AMPService(');
    const constructorEnd = factorySource.indexOf('\n  );', constructorStart);
    expect(factorySource.slice(constructorStart, constructorEnd)).not.toContain('entity');
  });
});
