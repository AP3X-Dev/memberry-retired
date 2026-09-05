// packages/mcp/src/__tests__/server.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import {
  closeSSEHandle,
  createAMPServer,
  DEFAULT_HTTP_HEADERS_TIMEOUT_MS,
  DEFAULT_HTTP_REQUEST_TIMEOUT_MS,
  DEFAULT_HTTP_KEEPALIVE_TIMEOUT_MS,
} from '../server.js';
import { TOOL_NAMES, DOMAIN_TOOL_NAMES_MAP, ALWAYS_ON_TOOL_NAMES } from '../tools.js';
import { registerAdmissionShadowStatusSource } from '../admission-shadow-status.js';

async function initializeMcpSession(
  baseUrl: string,
  token: string,
  id: number,
): Promise<Record<string, string>> {
  const baseHeaders = {
    authorization: `Bearer ${token}`,
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
  };
  const initialize = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: baseHeaders,
    body: JSON.stringify({
      jsonrpc: '2.0', id, method: 'initialize',
      params: {
        protocolVersion: '2025-03-26', capabilities: {},
        clientInfo: { name: 'sec001b-test', version: '0.0.0' },
      },
    }),
  });
  expect(initialize.status).toBe(200);
  const sessionId = initialize.headers.get('mcp-session-id');
  const protocolVersion = (await initialize.json() as { result?: { protocolVersion?: string } })
    .result?.protocolVersion ?? '2025-03-26';
  const headers = {
    ...baseHeaders,
    'mcp-session-id': sessionId ?? '',
    'mcp-protocol-version': protocolVersion,
  };
  const initialized = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  expect(initialized.status).toBe(202);
  return headers;
}

async function callMcpTool(
  baseUrl: string,
  headers: Record<string, string>,
  id: number,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args },
    }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<Record<string, unknown>>;
}

async function withSseServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const previousToken = process.env.AMP_API_TOKEN;
  const previousUnauthenticated = process.env.AMP_ALLOW_UNAUTHENTICATED;
  process.env.AMP_API_TOKEN = 'test-health-token';
  delete process.env.AMP_ALLOW_UNAUTHENTICATED;

  const amp = createAMPServer();
  const handle = await amp.startSSE(0);
  const address = handle.httpServer.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await run(baseUrl);
  } finally {
    await closeSSEHandle(handle, 500);
    if (previousToken === undefined) {
      delete process.env.AMP_API_TOKEN;
    } else {
      process.env.AMP_API_TOKEN = previousToken;
    }
    if (previousUnauthenticated === undefined) {
      delete process.env.AMP_ALLOW_UNAUTHENTICATED;
    } else {
      process.env.AMP_ALLOW_UNAUTHENTICATED = previousUnauthenticated;
    }
  }
}

describe('createAMPServer', () => {
  it('SEC-001B leaves the default-off root McpServer method untouched', () => {
    const saved = {
      policy: process.env.MEMBERRY_CAPABILITY_POLICIES_V1,
      legacyPolicy: process.env.AMP_CAPABILITY_POLICIES_V1,
    };
    delete process.env.MEMBERRY_CAPABILITY_POLICIES_V1;
    delete process.env.AMP_CAPABILITY_POLICIES_V1;
    try {
      const amp = createAMPServer();
      expect(Object.hasOwn(amp.server, 'tool')).toBe(false);
      expect(amp.toolNames).toHaveLength(49);
    } finally {
      if (saved.policy === undefined) delete process.env.MEMBERRY_CAPABILITY_POLICIES_V1;
      else process.env.MEMBERRY_CAPABILITY_POLICIES_V1 = saved.policy;
      if (saved.legacyPolicy === undefined) delete process.env.AMP_CAPABILITY_POLICIES_V1;
      else process.env.AMP_CAPABILITY_POLICIES_V1 = saved.legacyPolicy;
    }
  });

  it('SEC-001B reads policy configuration at construction, rejects malformed config, and refuses STDIO before transport', async () => {
    const saved = {
      policy: process.env.MEMBERRY_CAPABILITY_POLICIES_V1,
      legacyPolicy: process.env.AMP_CAPABILITY_POLICIES_V1,
    };
    delete process.env.AMP_CAPABILITY_POLICIES_V1;
    try {
      process.env.MEMBERRY_CAPABILITY_POLICIES_V1 = '{secret-policy';
      expect(() => createAMPServer()).toThrow('capability_runtime:invalid-config');

      process.env.MEMBERRY_CAPABILITY_POLICIES_V1 = '[]';
      const enabled = createAMPServer();
      expect(Object.hasOwn(enabled.server, 'tool')).toBe(true);
      const registry = (enabled.server as unknown as {
        _registeredTools: Record<string, { handler: (...args: unknown[]) => unknown }>;
      })._registeredTools;
      expect(await registry.berry_load!.handler({ task: 'root-must-not-run' }, {})).toEqual({
        content: [{ type: 'text', text: '**Error:** capability denied' }], isError: true,
      });
      delete process.env.MEMBERRY_CAPABILITY_POLICIES_V1;
      await expect(enabled.startStdio()).rejects.toThrow('capability_runtime:invalid-config');
    } finally {
      if (saved.policy === undefined) delete process.env.MEMBERRY_CAPABILITY_POLICIES_V1;
      else process.env.MEMBERRY_CAPABILITY_POLICIES_V1 = saved.policy;
      if (saved.legacyPolicy === undefined) delete process.env.AMP_CAPABILITY_POLICIES_V1;
      else process.env.AMP_CAPABILITY_POLICIES_V1 = saved.legacyPolicy;
    }
  });

  it('SEC-001B rejects capability mode combined with unauthenticated HTTP before listener startup', async () => {
    const saved = {
      policy: process.env.MEMBERRY_CAPABILITY_POLICIES_V1,
      allow: process.env.MEMBERRY_ALLOW_UNAUTHENTICATED,
      legacyAllow: process.env.AMP_ALLOW_UNAUTHENTICATED,
    };
    process.env.MEMBERRY_CAPABILITY_POLICIES_V1 = '[]';
    process.env.MEMBERRY_ALLOW_UNAUTHENTICATED = 'true';
    delete process.env.AMP_ALLOW_UNAUTHENTICATED;
    try {
      const amp = createAMPServer();
      await expect(amp.startSSE(0)).rejects.toThrow('capability_runtime:invalid-config');
    } finally {
      if (saved.policy === undefined) delete process.env.MEMBERRY_CAPABILITY_POLICIES_V1;
      else process.env.MEMBERRY_CAPABILITY_POLICIES_V1 = saved.policy;
      if (saved.allow === undefined) delete process.env.MEMBERRY_ALLOW_UNAUTHENTICATED;
      else process.env.MEMBERRY_ALLOW_UNAUTHENTICATED = saved.allow;
      if (saved.legacyAllow === undefined) delete process.env.AMP_ALLOW_UNAUTHENTICATED;
      else process.env.AMP_ALLOW_UNAUTHENTICATED = saved.legacyAllow;
    }
  });

  it('SEC-001B selects exact tenant/actor policies over Streamable HTTP and denies a missing policy', async () => {
    const saved = {
      policy: process.env.MEMBERRY_CAPABILITY_POLICIES_V1,
      apiTokens: process.env.MEMBERRY_API_TOKENS,
      tenantTokens: process.env.MEMBERRY_TENANT_TOKENS,
      apiToken: process.env.MEMBERRY_API_TOKEN,
      legacyApiToken: process.env.AMP_API_TOKEN,
      allow: process.env.MEMBERRY_ALLOW_UNAUTHENTICATED,
    };
    delete process.env.MEMBERRY_API_TOKEN;
    delete process.env.AMP_API_TOKEN;
    delete process.env.MEMBERRY_ALLOW_UNAUTHENTICATED;
    process.env.MEMBERRY_API_TOKENS = 'alice:tok-alice,bob:tok-bob';
    process.env.MEMBERRY_TENANT_TOKENS = 'acme:tok-alice,globex:tok-bob';
    process.env.MEMBERRY_CAPABILITY_POLICIES_V1 = JSON.stringify([{
      contractId: 'memberry.capability-policy', contractVersion: '1.0.0',
      actorId: 'alice', tenantId: 'acme',
      grants: [{
        scope: { kind: 'tenant' }, domainId: 'tools', toolId: 'berry_tools', operation: 'read',
      }, {
        scope: { kind: 'tenant' }, domainId: 'tools', toolId: 'berry_tools', operation: 'update',
      }, {
        scope: { kind: 'tenant' }, domainId: 'research', toolId: 'berry_research_init', operation: 'create',
      }, {
        scope: { kind: 'tenant' }, domainId: 'admin', toolId: 'berry_query', operation: 'admin',
      }],
    }]);

    const amp = createAMPServer();
    const handle = await amp.startSSE(0);
    const address = handle.httpServer.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const aliceHeaders = await initializeMcpSession(baseUrl, 'tok-alice', 100);
      const aliceSessionServer = [...handle.streamableServers.values()][0]!;
      const aliceRegistry = (aliceSessionServer as unknown as {
        _registeredTools: Record<string, unknown>;
      })._registeredTools;
      expect(aliceRegistry.berry_research_init).toBeUndefined();
      const allowed = await callMcpTool(baseUrl, aliceHeaders, 101, 'berry_tools', { action: 'list' });
      expect(allowed).toMatchObject({ result: { content: [{ type: 'text' }] } });
      expect(JSON.stringify(allowed)).not.toContain('capability denied');

      const enableResearch = await callMcpTool(
        baseUrl, aliceHeaders, 104, 'berry_tools', { action: 'enable', domain: 'research' },
      );
      expect(JSON.stringify(enableResearch)).toContain('Unknown domain');
      const withheld = await callMcpTool(
        baseUrl, aliceHeaders, 105, 'berry_research_init', { campaign: 'must-not-run' },
      );
      expect(aliceRegistry.berry_research_init).toBeUndefined();
      expect(withheld).toMatchObject({
        result: {
          content: [{ type: 'text', text: expect.any(String) }],
          isError: true,
        },
      });
      expect(JSON.stringify(withheld)).not.toContain('must-not-run');

      const enableAdmin = await callMcpTool(
        baseUrl, aliceHeaders, 106, 'berry_tools', { action: 'enable', domain: 'admin' },
      );
      expect(JSON.stringify(enableAdmin)).not.toContain('capability denied');
      const refusedCore = await callMcpTool(
        baseUrl,
        aliceHeaders,
        107,
        'berry_query',
        { query: 'RETURN "tenant-secret-sentinel"', limit: 1 },
      );
      expect(JSON.stringify(refusedCore)).toContain('not available in multi-tenant mode');
      expect(JSON.stringify(refusedCore)).not.toContain('tenant-secret-sentinel');

      const bobHeaders = await initializeMcpSession(baseUrl, 'tok-bob', 102);
      const denied = await callMcpTool(baseUrl, bobHeaders, 103, 'berry_tools', { action: 'list' });
      expect(denied).toMatchObject({
        result: {
          content: [{ type: 'text', text: '**Error:** capability denied' }],
          isError: true,
        },
      });
    } finally {
      await closeSSEHandle(handle, 500);
      if (saved.policy === undefined) delete process.env.MEMBERRY_CAPABILITY_POLICIES_V1; else process.env.MEMBERRY_CAPABILITY_POLICIES_V1 = saved.policy;
      if (saved.apiTokens === undefined) delete process.env.MEMBERRY_API_TOKENS; else process.env.MEMBERRY_API_TOKENS = saved.apiTokens;
      if (saved.tenantTokens === undefined) delete process.env.MEMBERRY_TENANT_TOKENS; else process.env.MEMBERRY_TENANT_TOKENS = saved.tenantTokens;
      if (saved.apiToken === undefined) delete process.env.MEMBERRY_API_TOKEN; else process.env.MEMBERRY_API_TOKEN = saved.apiToken;
      if (saved.legacyApiToken === undefined) delete process.env.AMP_API_TOKEN; else process.env.AMP_API_TOKEN = saved.legacyApiToken;
      if (saved.allow === undefined) delete process.env.MEMBERRY_ALLOW_UNAUTHENTICATED; else process.env.MEMBERRY_ALLOW_UNAUTHENTICATED = saved.allow;
    }
  });

  it('SEC-001B wraps all 49 real single-tenant handlers and missing policy causes zero effects', async () => {
    const saved = {
      policy: process.env.MEMBERRY_CAPABILITY_POLICIES_V1,
      apiToken: process.env.MEMBERRY_API_TOKEN,
      legacyApiToken: process.env.AMP_API_TOKEN,
      apiTokens: process.env.MEMBERRY_API_TOKENS,
      tenantTokens: process.env.MEMBERRY_TENANT_TOKENS,
    };
    process.env.MEMBERRY_CAPABILITY_POLICIES_V1 = '[]';
    process.env.MEMBERRY_API_TOKEN = 'default-token';
    delete process.env.AMP_API_TOKEN;
    delete process.env.MEMBERRY_API_TOKENS;
    delete process.env.MEMBERRY_TENANT_TOKENS;
    const amp = createAMPServer();
    const handle = await amp.startSSE(0);
    const address = handle.httpServer.address() as AddressInfo;
    try {
      await initializeMcpSession(`http://127.0.0.1:${address.port}`, 'default-token', 110);
      const sessionServer = [...handle.streamableServers.values()][0]!;
      const registry = (sessionServer as unknown as {
        _registeredTools: Record<string, { handler: (...args: unknown[]) => unknown }>;
      })._registeredTools;
      expect(Object.keys(registry).sort()).toEqual([...amp.toolNames].sort());
      expect(Object.keys(registry)).toHaveLength(49);
      for (const [name, registered] of Object.entries(registry)) {
        const result = await registered.handler({}, {});
        expect(result, name).toEqual({
          content: [{ type: 'text', text: '**Error:** capability denied' }], isError: true,
        });
      }
    } finally {
      await closeSSEHandle(handle, 500);
      if (saved.policy === undefined) delete process.env.MEMBERRY_CAPABILITY_POLICIES_V1; else process.env.MEMBERRY_CAPABILITY_POLICIES_V1 = saved.policy;
      if (saved.apiToken === undefined) delete process.env.MEMBERRY_API_TOKEN; else process.env.MEMBERRY_API_TOKEN = saved.apiToken;
      if (saved.legacyApiToken === undefined) delete process.env.AMP_API_TOKEN; else process.env.AMP_API_TOKEN = saved.legacyApiToken;
      if (saved.apiTokens === undefined) delete process.env.MEMBERRY_API_TOKENS; else process.env.MEMBERRY_API_TOKENS = saved.apiTokens;
      if (saved.tenantTokens === undefined) delete process.env.MEMBERRY_TENANT_TOKENS; else process.env.MEMBERRY_TENANT_TOKENS = saved.tenantTokens;
    }
  });

  it('SEC-001B installs the same deny-before-effect gate on a real authenticated SSE session', async () => {
    const saved = {
      policy: process.env.MEMBERRY_CAPABILITY_POLICIES_V1,
      apiToken: process.env.MEMBERRY_API_TOKEN,
      legacyApiToken: process.env.AMP_API_TOKEN,
      apiTokens: process.env.MEMBERRY_API_TOKENS,
      tenantTokens: process.env.MEMBERRY_TENANT_TOKENS,
    };
    process.env.MEMBERRY_CAPABILITY_POLICIES_V1 = '[]';
    process.env.MEMBERRY_API_TOKEN = 'sse-default-token';
    delete process.env.AMP_API_TOKEN;
    delete process.env.MEMBERRY_API_TOKENS;
    delete process.env.MEMBERRY_TENANT_TOKENS;
    const amp = createAMPServer();
    const handle = await amp.startSSE(0);
    const address = handle.httpServer.address() as AddressInfo;
    const abort = new AbortController();
    let response: Response | undefined;
    try {
      response = await fetch(`http://127.0.0.1:${address.port}/sse`, {
        headers: { authorization: 'Bearer sse-default-token', accept: 'text/event-stream' },
        signal: abort.signal,
      });
      expect(response.status).toBe(200);
      const sessionServer = [...handle.servers.values()][0]!;
      const registry = (sessionServer as unknown as {
        _registeredTools: Record<string, { handler: (...args: unknown[]) => unknown }>;
      })._registeredTools;
      expect(Object.keys(registry)).toHaveLength(49);
      expect(await registry.berry_load!.handler({ task: 'must-not-run' }, {})).toEqual({
        content: [{ type: 'text', text: '**Error:** capability denied' }], isError: true,
      });
    } finally {
      abort.abort();
      await response?.body?.cancel().catch(() => {});
      await closeSSEHandle(handle, 500);
      if (saved.policy === undefined) delete process.env.MEMBERRY_CAPABILITY_POLICIES_V1; else process.env.MEMBERRY_CAPABILITY_POLICIES_V1 = saved.policy;
      if (saved.apiToken === undefined) delete process.env.MEMBERRY_API_TOKEN; else process.env.MEMBERRY_API_TOKEN = saved.apiToken;
      if (saved.legacyApiToken === undefined) delete process.env.AMP_API_TOKEN; else process.env.AMP_API_TOKEN = saved.legacyApiToken;
      if (saved.apiTokens === undefined) delete process.env.MEMBERRY_API_TOKENS; else process.env.MEMBERRY_API_TOKENS = saved.apiTokens;
      if (saved.tenantTokens === undefined) delete process.env.MEMBERRY_TENANT_TOKENS; else process.env.MEMBERRY_TENANT_TOKENS = saved.tenantTokens;
    }
  });
  it('RET-002C2 derives planner eligibility only from configured HTTP auth and leaves the stdio root ineligible', () => {
    const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
    expect(source).toContain('authenticated: effectiveToken !== null');
    expect(source.match(/authenticated: effectiveToken !== null/g)).toHaveLength(2);
    expect(source).toContain('registerAllTools(server);');
    expect(source).not.toMatch(/authenticated:\s*(?:Boolean\()?opts\.(?:tenantId|actor|multiTenant)/);
  });
  it('returns an AMPMCPServer object', () => {
    const amp = createAMPServer();
    expect(amp).toBeDefined();
    expect(amp.server).toBeDefined();
    expect(typeof amp.startSSE).toBe('function');
    expect(typeof amp.startStdio).toBe('function');
  });

  it('exposes toolNames with all registered tools', () => {
    const amp = createAMPServer();
    expect(amp.toolNames).toBeDefined();
    // Core tools
    expect(amp.toolNames).toContain('berry_load');
    expect(amp.toolNames).toContain('berry_store');
    expect(amp.toolNames).toContain('berry_query');
    expect(amp.toolNames).toContain('berry_consolidate');
    expect(amp.toolNames).toContain('berry_resolve');
    expect(amp.toolNames).toContain('berry_bootstrap');
    // Progressive disclosure gateway
    expect(amp.toolNames).toContain('berry_tools');
    // Retrieval tier 1
    expect(amp.toolNames).toContain('berry_context');
    // Wiki tools (registered but disabled by default)
    expect(amp.toolNames).toContain('berry_compile');
    expect(amp.toolNames).toContain('berry_ingest');
    expect(amp.toolNames).toContain('berry_lint');
    // Extension tools registered from research, arch, code, retrieval, wiki
    expect(amp.toolNames.length).toBeGreaterThanOrEqual(6);
  });

  it('REBRAND-GUARD: the tool surface is exactly 49 berry_* tools with no legacy amp_* names', () => {
    const amp = createAMPServer();
    const names = [...amp.toolNames];
    // Clean cutover: every tool is canonical berry_*; no amp_* survives.
    expect(names.every((n) => n.startsWith('berry_'))).toBe(true);
    expect(names.some((n) => n.startsWith('amp_'))).toBe(false);
    // 8 always-on (Tier 1) + 41 on-demand (Tier 2) = 49.
    expect(names.length).toBe(49);
    expect(ALWAYS_ON_TOOL_NAMES.length).toBe(8);
    expect(Object.values(DOMAIN_TOOL_NAMES_MAP).flat().length).toBe(41);
  });

  it('berry_provenance is registered and discoverable in the admin domain', () => {
    const amp = createAMPServer();
    expect(amp.toolNames).toContain('berry_provenance');
    expect(DOMAIN_TOOL_NAMES_MAP.admin).toContain('berry_provenance');
  });

  it('DRIFT-GUARD: every registered tool is either Tier 1 or listed in DOMAIN_TOOL_NAMES_MAP', () => {
    // The berry_tools(action:"list") gateway reads DOMAIN_TOOL_NAMES_MAP. If a tool
    // is registered (server.tool) but missing from the map AND not Tier 1, an
    // agent can never discover it via the gateway. This guards both directions:
    // no registered tool is unlisted, and no map entry is a phantom.
    const amp = createAMPServer();
    const registered = new Set(amp.toolNames);
    const accountedFor = new Set<string>([
      ...ALWAYS_ON_TOOL_NAMES,
      ...Object.values(DOMAIN_TOOL_NAMES_MAP).flat(),
    ]);

    const registeredButUnlisted = [...registered].filter((t) => !accountedFor.has(t));
    const listedButUnregistered = [...accountedFor].filter((t) => !registered.has(t));

    expect(registeredButUnlisted).toEqual([]);
    expect(listedButUnregistered).toEqual([]);
  });

  it('server is a McpServer instance', () => {
    const amp = createAMPServer();
    // McpServer has a .server property (the underlying Server) and a .connect method
    expect(typeof amp.server.connect).toBe('function');
    expect(typeof amp.server.close).toBe('function');
  });

  // A7: MEMBERRY_ALLOW_UNAUTHENTICATED is a safety-RELAXING flag, so it parses
  // strict — only the exact string `true` opens the server; `1` must not.
  it.each([
    ['1', true],
    ['true', false],
  ])('MEMBERRY_ALLOW_UNAUTHENTICATED=%s → auth_required %s', async (value, authRequired) => {
    const saved = {
      apiToken: process.env.MEMBERRY_API_TOKEN,
      legacyApiToken: process.env.AMP_API_TOKEN,
      apiTokens: process.env.MEMBERRY_API_TOKENS,
      allow: process.env.MEMBERRY_ALLOW_UNAUTHENTICATED,
      legacyAllow: process.env.AMP_ALLOW_UNAUTHENTICATED,
    };
    delete process.env.MEMBERRY_API_TOKEN;
    delete process.env.AMP_API_TOKEN;
    delete process.env.MEMBERRY_API_TOKENS;
    delete process.env.AMP_ALLOW_UNAUTHENTICATED;
    process.env.MEMBERRY_ALLOW_UNAUTHENTICATED = value;
    const handle = await createAMPServer().startSSE(0);
    const baseUrl = `http://127.0.0.1:${(handle.httpServer.address() as AddressInfo).port}`;
    try {
      const health = await fetch(`${baseUrl}/healthz`);
      expect(health.status).toBe(200);
      expect((await health.json() as Record<string, unknown>).auth_required).toBe(authRequired);
      const ready = await fetch(`${baseUrl}/readyz`);
      expect(ready.status === 401).toBe(authRequired);
    } finally {
      await closeSSEHandle(handle, 500);
      if (saved.apiToken === undefined) delete process.env.MEMBERRY_API_TOKEN; else process.env.MEMBERRY_API_TOKEN = saved.apiToken;
      if (saved.legacyApiToken === undefined) delete process.env.AMP_API_TOKEN; else process.env.AMP_API_TOKEN = saved.legacyApiToken;
      if (saved.apiTokens === undefined) delete process.env.MEMBERRY_API_TOKENS; else process.env.MEMBERRY_API_TOKENS = saved.apiTokens;
      if (saved.allow === undefined) delete process.env.MEMBERRY_ALLOW_UNAUTHENTICATED; else process.env.MEMBERRY_ALLOW_UNAUTHENTICATED = saved.allow;
      if (saved.legacyAllow === undefined) delete process.env.AMP_ALLOW_UNAUTHENTICATED; else process.env.AMP_ALLOW_UNAUTHENTICATED = saved.legacyAllow;
    }
  });

  it('can create multiple server instances independently', () => {
    const amp1 = createAMPServer();
    const amp2 = createAMPServer();
    // Each call produces a distinct server object
    expect(amp1.server).not.toBe(amp2.server);
  });

  it('serves unauthenticated liveness without exposing auth material', async () => {
    await withSseServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/healthz`);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/json');

      const body = await response.json() as Record<string, unknown>;
      expect(body).toMatchObject({
        status: 'ok',
        service: 'memberry-mcp',
        transport: 'sse',
        active_sessions: 0,
        auth_required: true,
      });
      expect(body.uptime_ms).toEqual(expect.any(Number));
      expect(body.token).toBeUndefined();
      expect(body.authorization).toBeUndefined();
      expect(body.admission_shadow).toBeUndefined();
    });
  });

  it('requires Bearer auth for readiness and returns non-streaming status', async () => {
    await withSseServer(async (baseUrl) => {
      const unauthenticated = await fetch(`${baseUrl}/readyz`);
      expect(unauthenticated.status).toBe(401);

      const authenticated = await fetch(`${baseUrl}/readyz`, {
        headers: { authorization: 'Bearer test-health-token' },
      });
      expect(authenticated.status).toBe(200);

      const body = await authenticated.json() as Record<string, unknown>;
      expect(body).toMatchObject({
        status: 'ready',
        service: 'memberry-mcp',
        transport: 'sse',
        active_sessions: 0,
        auth_required: true,
        admission_shadow: {
          enabled: false,
          health: 'disabled',
          affects_readiness: false,
          timeout_ms: [],
          max_in_flight: 0,
        },
        retrieval_resolution: {
          schema_version: 1,
          affects_readiness: false,
          history_scope: 'process-lifetime',
          history_complete: false,
          counters_saturated: false,
          caller_type_known: false,
          content_captured: false,
          identity_captured: false,
        },
      });
    });
  });

  it('keeps readiness at 200 when the optional shadow observer is degraded', async () => {
    const unregister = registerAdmissionShadowStatusSource({
      snapshot: () => ({
        enabled: true,
        health: 'degraded',
        prepared: 1,
        preparationFailures: 0,
        appendAttempts: 1,
        appended: 0,
        appendFailures: 1,
        timedOut: 0,
        capacityRejected: 0,
        shutdownSkipped: 0,
        lateAppended: 0,
        lateFailures: 0,
        reserved: 0,
        inFlight: 0,
        stopping: false,
        lastFailureCode: 'append_failed',
        timeoutMs: 50,
        maxInFlight: 32,
      }),
    });
    try {
      await withSseServer(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/readyz`, {
          headers: { authorization: 'Bearer test-health-token' },
        });
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
          admission_shadow: {
            health: 'degraded',
            affects_readiness: false,
            durable_retry: false,
            self_healing: false,
            history_complete: false,
            history_scope: 'process-lifetime',
            stopping: false,
            last_failure_code: 'append_failed',
            timeout_ms: [50],
            max_in_flight: 32,
          },
        });
      });
    } finally {
      unregister();
    }
  });

  it('accepts any configured per-actor token and rejects unknown ones', async () => {
    const saved = {
      tokens: process.env.MEMBERRY_API_TOKENS,
      ampTok: process.env.AMP_API_TOKEN,
      memTok: process.env.MEMBERRY_API_TOKEN,
    };
    delete process.env.AMP_API_TOKEN;
    delete process.env.MEMBERRY_API_TOKEN;
    process.env.MEMBERRY_API_TOKENS = 'alice:tok-alice,bob:tok-bob';

    const amp = createAMPServer();
    const handle = await amp.startSSE(0);
    const address = handle.httpServer.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const alice = await fetch(`${baseUrl}/readyz`, { headers: { authorization: 'Bearer tok-alice' } });
      expect(alice.status).toBe(200);
      const bob = await fetch(`${baseUrl}/readyz`, { headers: { authorization: 'Bearer tok-bob' } });
      expect(bob.status).toBe(200);
      const wrong = await fetch(`${baseUrl}/readyz`, { headers: { authorization: 'Bearer not-a-real-token' } });
      expect(wrong.status).toBe(401);
      const none = await fetch(`${baseUrl}/readyz`);
      expect(none.status).toBe(401);
    } finally {
      await closeSSEHandle(handle, 500);
      if (saved.tokens === undefined) delete process.env.MEMBERRY_API_TOKENS; else process.env.MEMBERRY_API_TOKENS = saved.tokens;
      if (saved.ampTok !== undefined) process.env.AMP_API_TOKEN = saved.ampTok;
      if (saved.memTok !== undefined) process.env.MEMBERRY_API_TOKEN = saved.memTok;
    }
  });

  it('serves Codex-compatible Streamable HTTP sessions on /mcp', async () => {
    await withSseServer(async (baseUrl) => {
      const baseHeaders = {
        authorization: 'Bearer test-health-token',
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      };

      const initialize = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: baseHeaders,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'codex-test', version: '0.0.0' },
          },
        }),
      });

      expect(initialize.status).toBe(200);
      expect(initialize.headers.get('content-type')).toContain('application/json');

      const sessionId = initialize.headers.get('mcp-session-id');
      expect(sessionId).toEqual(expect.any(String));

      const initializeBody = await initialize.json() as {
        jsonrpc?: string;
        id?: number;
        result?: { protocolVersion?: string; serverInfo?: { name?: string } };
      };
      expect(initializeBody).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: { serverInfo: { name: 'memberry-mcp' } },
      });

      const sessionHeaders = {
        ...baseHeaders,
        'mcp-session-id': sessionId ?? '',
        'mcp-protocol-version': initializeBody.result?.protocolVersion ?? '2025-03-26',
      };

      const initialized = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: sessionHeaders,
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        }),
      });
      expect(initialized.status).toBe(202);

      const tools = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: sessionHeaders,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
        }),
      });

      expect(tools.status).toBe(200);
      const toolsBody = await tools.json() as { result?: { tools?: Array<{ name?: string }> } };
      expect(toolsBody.result?.tools?.some((tool) => tool.name === 'berry_load')).toBe(true);
    });
  });

  it('binds a Streamable /mcp session to its creating tenant and 403s a different tenant token on follow-up', async () => {
    const saved = {
      tenantTokens: process.env.MEMBERRY_TENANT_TOKENS,
      apiTokens: process.env.MEMBERRY_API_TOKENS,
      ampTok: process.env.AMP_API_TOKEN,
      memTok: process.env.MEMBERRY_API_TOKEN,
    };
    delete process.env.AMP_API_TOKEN;
    delete process.env.MEMBERRY_API_TOKEN;
    delete process.env.MEMBERRY_API_TOKENS;
    // Two tenant tokens → multi-tenant mode ON. Each token is also a valid auth
    // token, so without session→identity binding either could drive the other's
    // session purely by knowing its session id.
    process.env.MEMBERRY_TENANT_TOKENS = 'acme:tok-acme,globex:tok-globex';

    const amp = createAMPServer();
    const handle = await amp.startSSE(0);
    const address = handle.httpServer.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const initBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'tenant-test', version: '0.0.0' },
      },
    });

    try {
      // (1) acme initializes a Streamable session.
      const initialize = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer tok-acme',
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        body: initBody,
      });
      expect(initialize.status).toBe(200);
      const sessionId = initialize.headers.get('mcp-session-id');
      expect(sessionId).toEqual(expect.any(String));

      const protocolVersion =
        (await initialize.json() as { result?: { protocolVersion?: string } })
          .result?.protocolVersion ?? '2025-03-26';

      // (2) globex presents acme's session id with its OWN (valid) token.
      // This MUST be rejected with 403, not forwarded to acme's transport.
      const hijack = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer tok-globex',
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'mcp-session-id': sessionId ?? '',
          'mcp-protocol-version': protocolVersion,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      });
      expect(hijack.status).toBe(403);

      // (3) Positive: acme's own token on the same session still works.
      const legit = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer tok-acme',
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'mcp-session-id': sessionId ?? '',
          'mcp-protocol-version': protocolVersion,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
      });
      expect(legit.status).toBe(200);
    } finally {
      await closeSSEHandle(handle, 500);
      if (saved.tenantTokens === undefined) delete process.env.MEMBERRY_TENANT_TOKENS; else process.env.MEMBERRY_TENANT_TOKENS = saved.tenantTokens;
      if (saved.apiTokens === undefined) delete process.env.MEMBERRY_API_TOKENS; else process.env.MEMBERRY_API_TOKENS = saved.apiTokens;
      if (saved.ampTok !== undefined) process.env.AMP_API_TOKEN = saved.ampTok;
      if (saved.memTok !== undefined) process.env.MEMBERRY_API_TOKEN = saved.memTok;
    }
  });

  it('does not bind sessions across tenants in single-tenant mode (default identity passes)', async () => {
    // Single-tenant: every token resolves to DEFAULT_TENANT, so a follow-up with
    // a *different but equally valid* per-actor token must still be allowed — the
    // binding check only rejects genuine tenant/actor differences, and in this
    // mode all sessions share the default tenant + default actor.
    const saved = {
      tenantTokens: process.env.MEMBERRY_TENANT_TOKENS,
      apiTokens: process.env.MEMBERRY_API_TOKENS,
      ampTok: process.env.AMP_API_TOKEN,
      memTok: process.env.MEMBERRY_API_TOKEN,
    };
    delete process.env.AMP_API_TOKEN;
    delete process.env.MEMBERRY_API_TOKEN;
    delete process.env.MEMBERRY_TENANT_TOKENS;
    process.env.MEMBERRY_API_TOKEN = 'solo-token';

    const amp = createAMPServer();
    const handle = await amp.startSSE(0);
    const address = handle.httpServer.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const headers = {
      authorization: 'Bearer solo-token',
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };

    try {
      const initialize = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'solo', version: '0.0.0' } },
        }),
      });
      expect(initialize.status).toBe(200);
      const sessionId = initialize.headers.get('mcp-session-id');
      const protocolVersion =
        (await initialize.json() as { result?: { protocolVersion?: string } })
          .result?.protocolVersion ?? '2025-03-26';

      const followUp = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { ...headers, 'mcp-session-id': sessionId ?? '', 'mcp-protocol-version': protocolVersion },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      });
      expect(followUp.status).toBe(200);
    } finally {
      await closeSSEHandle(handle, 500);
      if (saved.tenantTokens !== undefined) process.env.MEMBERRY_TENANT_TOKENS = saved.tenantTokens;
      if (saved.apiTokens !== undefined) process.env.MEMBERRY_API_TOKENS = saved.apiTokens;
      if (saved.ampTok !== undefined) process.env.AMP_API_TOKEN = saved.ampTok; else delete process.env.AMP_API_TOKEN;
      if (saved.memTok !== undefined) process.env.MEMBERRY_API_TOKEN = saved.memTok; else delete process.env.MEMBERRY_API_TOKEN;
    }
  });

  it('OPT-29: in multi-tenant mode a valid NON-tenant token is rejected (fail-closed) unless MEMBERRY_ALLOW_DEFAULT_TENANT=true', async () => {
    const saved = {
      tenantTokens: process.env.MEMBERRY_TENANT_TOKENS,
      apiTokens: process.env.MEMBERRY_API_TOKENS,
      ampTok: process.env.AMP_API_TOKEN,
      memTok: process.env.MEMBERRY_API_TOKEN,
      allowDefault: process.env.MEMBERRY_ALLOW_DEFAULT_TENANT,
    };
    delete process.env.AMP_API_TOKEN;
    delete process.env.MEMBERRY_API_TOKENS;
    delete process.env.MEMBERRY_ALLOW_DEFAULT_TENANT;
    // Multi-tenant mode ON, PLUS a global API token that is NOT a tenant token.
    // Before OPT-29 the admin token authenticated and silently operated on the
    // DEFAULT tenant; now it must be rejected unless the operator opts back in.
    process.env.MEMBERRY_TENANT_TOKENS = 'acme:tok-acme,globex:tok-globex';
    process.env.MEMBERRY_API_TOKEN = 'admin-tok';

    const initBody = (id: number) => JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'opt29', version: '0.0.0' } },
    });

    try {
      // (A) Fail-closed: the non-tenant admin token is rejected with 401, while a
      //     real tenant token still initializes a session (positive control).
      {
        const amp = createAMPServer();
        const handle = await amp.startSSE(0);
        const address = handle.httpServer.address() as AddressInfo;
        const baseUrl = `http://127.0.0.1:${address.port}`;
        try {
          const rejected = await fetch(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: {
              authorization: 'Bearer admin-tok',
              accept: 'application/json, text/event-stream',
              'content-type': 'application/json',
            },
            body: initBody(1),
          });
          expect(rejected.status).toBe(401);

          const ok = await fetch(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: {
              authorization: 'Bearer tok-acme',
              accept: 'application/json, text/event-stream',
              'content-type': 'application/json',
            },
            body: initBody(2),
          });
          expect(ok.status).toBe(200);
        } finally {
          await closeSSEHandle(handle, 500);
        }
      }

      // (B) Explicit opt-in: MEMBERRY_ALLOW_DEFAULT_TENANT=true restores the
      //     legacy default-tenant fallback, so the same non-tenant token works.
      process.env.MEMBERRY_ALLOW_DEFAULT_TENANT = 'true';
      {
        const amp = createAMPServer();
        const handle = await amp.startSSE(0);
        const address = handle.httpServer.address() as AddressInfo;
        const baseUrl = `http://127.0.0.1:${address.port}`;
        try {
          const ok = await fetch(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: {
              authorization: 'Bearer admin-tok',
              accept: 'application/json, text/event-stream',
              'content-type': 'application/json',
            },
            body: initBody(3),
          });
          expect(ok.status).toBe(200);
        } finally {
          await closeSSEHandle(handle, 500);
        }
      }
    } finally {
      if (saved.tenantTokens === undefined) delete process.env.MEMBERRY_TENANT_TOKENS; else process.env.MEMBERRY_TENANT_TOKENS = saved.tenantTokens;
      if (saved.apiTokens === undefined) delete process.env.MEMBERRY_API_TOKENS; else process.env.MEMBERRY_API_TOKENS = saved.apiTokens;
      if (saved.ampTok === undefined) delete process.env.AMP_API_TOKEN; else process.env.AMP_API_TOKEN = saved.ampTok;
      if (saved.memTok === undefined) delete process.env.MEMBERRY_API_TOKEN; else process.env.MEMBERRY_API_TOKEN = saved.memTok;
      if (saved.allowDefault === undefined) delete process.env.MEMBERRY_ALLOW_DEFAULT_TENANT; else process.env.MEMBERRY_ALLOW_DEFAULT_TENANT = saved.allowDefault;
    }
  });

  it('OPT-08: rejects a /mcp POST body over the cap with HTTP 413 (Content-Length early reject)', async () => {
    // Lower the cap via env so the test stays small/fast. readEnv resolves
    // AMP_MAX_BODY_BYTES via its MEMBERRY_* legacy fallback.
    const saved = { cap: process.env.AMP_MAX_BODY_BYTES, capCanon: process.env.MEMBERRY_MAX_BODY_BYTES };
    process.env.AMP_MAX_BODY_BYTES = '1024'; // 1 KB cap
    delete process.env.MEMBERRY_MAX_BODY_BYTES;

    await withSseServer(async (baseUrl) => {
      const headers = {
        authorization: 'Bearer test-health-token',
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      };

      // Body comfortably over the 1 KB cap → real Content-Length over cap.
      const oversized = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'dos-test', version: '0.0.0', pad: 'x'.repeat(4096) },
        },
      });
      expect(oversized.length).toBeGreaterThan(1024);

      const tooLarge = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers, body: oversized });
      // Without the cap this would be parsed (200) or at worst 400; the cap pins 413.
      expect(tooLarge.status).toBe(413);
      const errBody = await tooLarge.json() as { error?: { code?: number; message?: string } };
      expect(errBody.error?.message).toBe('Payload too large');
    });

    if (saved.cap === undefined) delete process.env.AMP_MAX_BODY_BYTES; else process.env.AMP_MAX_BODY_BYTES = saved.cap;
    if (saved.capCanon !== undefined) process.env.MEMBERRY_MAX_BODY_BYTES = saved.capCanon;
  });

  it('OPT-73: applies the configurable body cap to the /messages SSE POST (413 over-cap, legit under-cap passes)', async () => {
    // The SSE transport reads the body itself (getRawBody, fixed 4mb) — the
    // configurable OPT-08 cap did not apply to /messages. After OPT-73 the same
    // MEMBERRY_MAX_BODY_BYTES governs both /mcp and /messages.
    const saved = { cap: process.env.AMP_MAX_BODY_BYTES, capCanon: process.env.MEMBERRY_MAX_BODY_BYTES };
    process.env.AMP_MAX_BODY_BYTES = '1024'; // 1 KB cap
    delete process.env.MEMBERRY_MAX_BODY_BYTES;

    await withSseServer(async (baseUrl) => {
      const auth = { authorization: 'Bearer test-health-token' };

      // Open the SSE stream and read the `endpoint` event to learn the sessionId.
      // Keep the connection OPEN during the /messages POSTs (closing it would tear
      // down the session → 404), then abort in finally.
      const ac = new AbortController();
      const sse = await fetch(`${baseUrl}/sse`, { headers: { ...auth, accept: 'text/event-stream' }, signal: ac.signal });
      expect(sse.status).toBe(200);
      const reader = sse.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let sessionId: string | null = null;
      for (let i = 0; i < 20 && sessionId === null; i++) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const m = buf.match(/sessionId=([0-9a-fA-F-]+)/);
        if (m) sessionId = m[1]!;
      }
      expect(sessionId).toEqual(expect.any(String));

      try {
        const headers = { ...auth, 'content-type': 'application/json' };

        // Over-cap body → 413 (the configurable cap now applies to /messages too).
        const oversized = JSON.stringify({ jsonrpc: '2.0', method: 'x', params: { pad: 'x'.repeat(4096) } });
        expect(oversized.length).toBeGreaterThan(1024);
        const tooLarge = await fetch(`${baseUrl}/messages?sessionId=${sessionId}`, { method: 'POST', headers, body: oversized });
        expect(tooLarge.status).toBe(413);

        // Under-cap valid message → NOT rejected by the cap (legit flow unchanged).
        const ok = await fetch(`${baseUrl}/messages?sessionId=${sessionId}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        });
        expect(ok.status).not.toBe(413);
      } finally {
        ac.abort();
        await reader.cancel().catch(() => {});
      }
    });

    if (saved.cap === undefined) delete process.env.AMP_MAX_BODY_BYTES; else process.env.AMP_MAX_BODY_BYTES = saved.cap;
    if (saved.capCanon !== undefined) process.env.MEMBERRY_MAX_BODY_BYTES = saved.capCanon;
  });

  it('OPT-08: catches an over-cap chunked body with no Content-Length (streaming backstop)', async () => {
    // The Content-Length early check cannot fire when the client uses
    // Transfer-Encoding: chunked (no declared length). Only the streaming
    // backstop can catch this — the real no-Content-Length DoS vector. Use the
    // low-level http client and omit content-length so Node sends chunked.
    const saved = { cap: process.env.AMP_MAX_BODY_BYTES, capCanon: process.env.MEMBERRY_MAX_BODY_BYTES };
    process.env.AMP_MAX_BODY_BYTES = '1024'; // 1 KB cap
    delete process.env.MEMBERRY_MAX_BODY_BYTES;

    await withSseServer(async (baseUrl) => {
      const { request } = await import('node:http');
      const url = new URL(`${baseUrl}/mcp`);

      const status = await new Promise<number>((resolve, reject) => {
        const req = request(
          {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: 'POST',
            headers: {
              authorization: 'Bearer test-health-token',
              accept: 'application/json, text/event-stream',
              'content-type': 'application/json',
              // No content-length → Node uses chunked transfer encoding.
            },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          },
        );
        req.on('error', reject);
        // Stream several chunks totalling well over the 1 KB cap.
        for (let i = 0; i < 8; i++) req.write('x'.repeat(512));
        req.end();
      });

      expect(status).toBe(413);
    });

    if (saved.cap === undefined) delete process.env.AMP_MAX_BODY_BYTES; else process.env.AMP_MAX_BODY_BYTES = saved.cap;
    if (saved.capCanon !== undefined) process.env.MEMBERRY_MAX_BODY_BYTES = saved.capCanon;
  });

  it('OPT-08: a normal small /mcp body is not over-rejected by the cap (happy path)', async () => {
    // Default cap (1 MB) — an ordinary initialize must still succeed with 200.
    await withSseServer(async (baseUrl) => {
      const initialize = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-health-token',
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'small-body-test', version: '0.0.0' },
          },
        }),
      });
      expect(initialize.status).toBe(200);
      expect(initialize.headers.get('mcp-session-id')).toEqual(expect.any(String));
    });
  });

  it('OPT-28: sets conservative receive timeouts on the HTTP server to bound slowloris exposure', async () => {
    // Pure property assertion — no slow-client simulation needed. Without the
    // fix these are Node's defaults (requestTimeout 300_000, keepAliveTimeout
    // 5_000, headersTimeout ~60_000), leaving the slowloris window open.
    const amp = createAMPServer();
    const handle = await amp.startSSE(0);
    try {
      expect(handle.httpServer.headersTimeout).toBe(DEFAULT_HTTP_HEADERS_TIMEOUT_MS);
      expect(handle.httpServer.requestTimeout).toBe(DEFAULT_HTTP_REQUEST_TIMEOUT_MS);
      expect(handle.httpServer.keepAliveTimeout).toBe(DEFAULT_HTTP_KEEPALIVE_TIMEOUT_MS);
      // Node invariant: requestTimeout must be 0 or >= headersTimeout.
      expect(handle.httpServer.requestTimeout).toBeGreaterThanOrEqual(
        handle.httpServer.headersTimeout,
      );
    } finally {
      await closeSSEHandle(handle, 500);
    }
  });

  it('OPT-28: honors MEMBERRY_HTTP_* timeout env overrides (and keeps the request>=headers invariant)', async () => {
    const saved = {
      headers: process.env.MEMBERRY_HTTP_HEADERS_TIMEOUT_MS,
      request: process.env.MEMBERRY_HTTP_REQUEST_TIMEOUT_MS,
      keepAlive: process.env.MEMBERRY_HTTP_KEEPALIVE_TIMEOUT_MS,
    };
    process.env.MEMBERRY_HTTP_HEADERS_TIMEOUT_MS = '7000';
    process.env.MEMBERRY_HTTP_REQUEST_TIMEOUT_MS = '9000';
    process.env.MEMBERRY_HTTP_KEEPALIVE_TIMEOUT_MS = '3000';

    const amp = createAMPServer();
    const handle = await amp.startSSE(0);
    try {
      expect(handle.httpServer.headersTimeout).toBe(7000);
      expect(handle.httpServer.requestTimeout).toBe(9000);
      expect(handle.httpServer.keepAliveTimeout).toBe(3000);
    } finally {
      await closeSSEHandle(handle, 500);
      if (saved.headers === undefined) delete process.env.MEMBERRY_HTTP_HEADERS_TIMEOUT_MS; else process.env.MEMBERRY_HTTP_HEADERS_TIMEOUT_MS = saved.headers;
      if (saved.request === undefined) delete process.env.MEMBERRY_HTTP_REQUEST_TIMEOUT_MS; else process.env.MEMBERRY_HTTP_REQUEST_TIMEOUT_MS = saved.request;
      if (saved.keepAlive === undefined) delete process.env.MEMBERRY_HTTP_KEEPALIVE_TIMEOUT_MS; else process.env.MEMBERRY_HTTP_KEEPALIVE_TIMEOUT_MS = saved.keepAlive;
    }
  });

  it('OPT-28: clamps requestTimeout up to headersTimeout when an override would violate the Node invariant', async () => {
    // requestTimeout (5000) < headersTimeout (8000) would make Node warn/misorder
    // the receive window. The clamp must raise requestTimeout to headersTimeout.
    const saved = {
      headers: process.env.MEMBERRY_HTTP_HEADERS_TIMEOUT_MS,
      request: process.env.MEMBERRY_HTTP_REQUEST_TIMEOUT_MS,
    };
    process.env.MEMBERRY_HTTP_HEADERS_TIMEOUT_MS = '8000';
    process.env.MEMBERRY_HTTP_REQUEST_TIMEOUT_MS = '5000';

    const amp = createAMPServer();
    const handle = await amp.startSSE(0);
    try {
      expect(handle.httpServer.headersTimeout).toBe(8000);
      expect(handle.httpServer.requestTimeout).toBe(8000);
      expect(handle.httpServer.requestTimeout).toBeGreaterThanOrEqual(
        handle.httpServer.headersTimeout,
      );
    } finally {
      await closeSSEHandle(handle, 500);
      if (saved.headers === undefined) delete process.env.MEMBERRY_HTTP_HEADERS_TIMEOUT_MS; else process.env.MEMBERRY_HTTP_HEADERS_TIMEOUT_MS = saved.headers;
      if (saved.request === undefined) delete process.env.MEMBERRY_HTTP_REQUEST_TIMEOUT_MS; else process.env.MEMBERRY_HTTP_REQUEST_TIMEOUT_MS = saved.request;
    }
  });

  it('closes active SSE sessions before waiting for the HTTP server to drain', async () => {
    const previousToken = process.env.AMP_API_TOKEN;
    process.env.AMP_API_TOKEN = 'test-shutdown-token';

    const amp = createAMPServer();
    const handle = await amp.startSSE(0);
    const address = handle.httpServer.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    let response: Response | undefined;

    try {
      response = await fetch(`${baseUrl}/sse`, {
        headers: { authorization: 'Bearer test-shutdown-token' },
      });
      expect(response.status).toBe(200);
      expect(handle.transports.size).toBe(1);

      await closeSSEHandle(handle, 500);

      expect(handle.transports.size).toBe(0);
      expect(handle.servers.size).toBe(0);
      expect(handle.httpServer.listening).toBe(false);
    } finally {
      await response?.body?.cancel().catch(() => {});
      await closeSSEHandle(handle, 500).catch(() => {});
      if (previousToken === undefined) {
        delete process.env.AMP_API_TOKEN;
      } else {
        process.env.AMP_API_TOKEN = previousToken;
      }
    }
  });
});
