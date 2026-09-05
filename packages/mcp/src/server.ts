// packages/mcp/src/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { registerTools, coreContainerForTenant, TOOL_NAMES } from './tools.js';
import type { ToolRegistry } from './tools.js';
import { DEFAULT_TENANT } from '@memberry/core';
import { registerResearchTools, RESEARCH_TOOL_NAMES } from '@memberry/research';
import { registerArchTools, ARCH_TOOL_NAMES } from '@memberry/arch';
import { registerCodeTools, CODE_TOOL_NAMES } from '@memberry/code';
import {
  getRetrievalResolutionProcessStatusV1,
  registerRetrievalTools,
  retrievalContainerForTenant,
  RETRIEVAL_TOOL_NAMES,
} from '@memberry/retrieval';
import { registerWikiTools, WIKI_TOOL_NAMES } from '@memberry/wiki';
import { registerGraphTools, GRAPH_TOOL_NAMES } from '@memberry/graph';
import { parseBoolFlag, readEnv, resolvePort } from '@memberry/core';
import { getConsolidationAutomationHealth } from './consolidation-coordinator.js';
import { getAdmissionShadowProcessStatus } from './admission-shadow-status.js';
import {
  assertCapabilityToolMatrixV1,
  CapabilityRuntimeConfigError,
  installCapabilityRuntimeInterposerV1,
  parseCapabilityRuntimeConfigV1,
  validateCapabilityRuntimeIdentityV1,
} from './capability-runtime.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface SSEHandle {
  /** The underlying Node HTTP server. */
  httpServer: ReturnType<typeof createServer>;
  /** Active SSE transports keyed by session ID. */
  transports: Map<string, SSEServerTransport>;
  /** Per-session MCP servers keyed by session ID. */
  servers: Map<string, McpServer>;
  /** Active Streamable HTTP transports keyed by MCP session ID. */
  streamableTransports: Map<string, StreamableHTTPServerTransport>;
  /** Per-session Streamable HTTP MCP servers keyed by MCP session ID. */
  streamableServers: Map<string, McpServer>;
  /**
   * Identity (tenant + actor) bound to each session at creation time, keyed by
   * the SAME session ID used in the transport maps (both SSE and Streamable).
   * Follow-up requests must re-present a token resolving to this identity, or
   * they are rejected — this prevents one valid token from driving another
   * tenant's session.
   */
  sessionIdentity: Map<string, { tenant: string; actor: string }>;
}

/** Pure status selector kept separate so degraded readiness policy is testable.
 *  An unreachable datastore is an outage; embeddings disabled/degraded is a
 *  documented mode and is only reported. */
export function readinessStatusCode(
  automation: { unhealthy?: boolean },
  datastores?: DatastoreReadiness,
): 200 | 503 {
  if (automation.unhealthy === true) return 503;
  if (datastores && (datastores.neo4j === 'unreachable' || datastores.redis === 'unreachable')) return 503;
  return 200;
}

// ─── Datastore readiness probes (D1/A6) ──────────────────────────────────────

export type DatastoreReadiness = { neo4j: 'ok' | 'unreachable'; redis: 'ok' | 'unreachable' };

/** Registered by bootstrap once the datastores are connected (same process-global
 *  pattern as the consolidation and admission-shadow status sources). */
export interface ReadinessProbeSource {
  neo4j: { getServerInfo(): Promise<unknown> };
  redis: { ping(): Promise<unknown> };
  embeddings: 'ok' | 'disabled' | 'degraded';
  degraded: readonly string[];
  /** Per-probe bound; default DEFAULT_READYZ_PROBE_TIMEOUT_MS. */
  probeTimeoutMs?: number;
  /** C4: last collection-size probe window from the retrieval assembler. Reported
   *  only — a stale/absent collection size never flips readiness to 503. */
  retrieval?: () => RetrievalReadiness;
  /** 13b: last in-process lifecycle pass. Reported only — a failed pass never flips readiness to 503. */
  lifecycle?: () => LifecycleReadiness;
}

export interface RetrievalReadiness {
  collection_size: { state: string; cached_at: number; last_error_class?: string };
}

export interface LifecycleReadiness {
  mode: 'disabled' | 'live';
  last_run_at: string | null;
  last_result: 'ok' | 'failed' | 'skipped' | 'never';
  last_error_class?: string;
  hebbian_drained?: number;
  /** 13c: extraction-queue stats + failure count from the last pass's anti-entropy section. */
  anti_entropy?: { pending: number; inflight: number; dead_lettered: number; failures: number };
}

export const DEFAULT_READYZ_PROBE_TIMEOUT_MS = 1_500;

let readinessProbeSource: ReadinessProbeSource | null = null;

export function registerReadinessProbeSource(source: ReadinessProbeSource): () => void {
  readinessProbeSource = source;
  return () => { if (readinessProbeSource === source) readinessProbeSource = null; };
}

async function probe(run: () => Promise<unknown>, timeoutMs: number): Promise<'ok' | 'unreachable'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      run(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('probe timed out')), timeoutMs); }),
    ]);
    return 'ok';
  } catch {
    return 'unreachable';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Live Neo4j + Redis reachability plus the bootstrap-computed embedding state.
 *  Returns undefined when no source is registered (embedded/test servers). */
export async function getDatastoreReadiness(): Promise<
  {
    datastores: DatastoreReadiness;
    embeddings: ReadinessProbeSource['embeddings'];
    degraded: string[];
    retrieval?: RetrievalReadiness;
    lifecycle?: LifecycleReadiness;
  } | undefined
> {
  const src = readinessProbeSource;
  if (!src) return undefined;
  const timeoutMs = src.probeTimeoutMs ?? DEFAULT_READYZ_PROBE_TIMEOUT_MS;
  const [neo4j, redis] = await Promise.all([
    probe(() => src.neo4j.getServerInfo(), timeoutMs),
    probe(() => src.redis.ping(), timeoutMs),
  ]);
  return {
    datastores: { neo4j, redis },
    embeddings: src.embeddings,
    degraded: [...src.degraded],
    ...(src.retrieval ? { retrieval: src.retrieval() } : {}),
    ...(src.lifecycle ? { lifecycle: src.lifecycle() } : {}),
  };
}

export interface AMPMCPServer {
  /** The underlying McpServer instance. */
  server: McpServer;
  /** Names of all registered tools. */
  toolNames: readonly string[];
  /** Start listening via SSE (HTTP) on the given port. */
  startSSE(port?: number): Promise<SSEHandle>;
  /** Start listening via stdio. */
  startStdio(): Promise<void>;
}

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

/**
 * Default cap on the number of bytes read from a POST request body. MCP
 * JSON-RPC bodies are tiny (tool args), so 1 MB is generous while still
 * preventing an attacker from exhausting memory with an unbounded body.
 * Overridable via MEMBERRY_MAX_BODY_BYTES (falls back to AMP_MAX_BODY_BYTES).
 */
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 1_000_000;

/**
 * OPT-62: resolve the network interface the HTTP server binds to. Previously the
 * bind host was hardcoded (Node `listen(port)` with no host → ALL interfaces),
 * so the systemd/.env `HOST` var and any intent to restrict to loopback were
 * silently ignored. Precedence: MEMBERRY_HOST (canonical, AMP_HOST legacy via
 * readEnv) → the generic HOST env (mirrors how PORT is read) → undefined.
 *
 * `undefined` PRESERVES the prior all-interfaces bind, so the default behavior
 * (and the LAN-accessible deployment) is unchanged. A security-conscious operator
 * can now set MEMBERRY_HOST=127.0.0.1 to restrict the server to loopback. Whether
 * the DEFAULT should flip to loopback is a deployment-posture decision (it would
 * break LAN access) — tracked as a Blocked item, not changed here.
 */
export function resolveListenHost(): string | undefined {
  const h = readEnv('MEMBERRY_HOST') ?? process.env['HOST'];
  const trimmed = h?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * HTTP receive-timeout defaults guarding against slow-client (slowloris) DoS.
 * Node's defaults leave the server exposed: requestTimeout defaults to 300_000ms
 * (5 minutes) and headersTimeout to ~60_000ms, so a slow trickle can hold a
 * connection — and a connection-pool slot — open far longer than any legitimate
 * MCP request needs. These bound how long the server will WAIT TO RECEIVE the
 * request (headers + body), NOT how long the response may stay open, so a
 * long-lived SSE GET response is unaffected (its tiny request is read instantly).
 *
 * Overridable via MEMBERRY_HTTP_HEADERS_TIMEOUT_MS / MEMBERRY_HTTP_REQUEST_TIMEOUT_MS /
 * MEMBERRY_HTTP_KEEPALIVE_TIMEOUT_MS (each with the legacy AMP_HTTP_* fallback).
 *
 * Ordering constraint: Node requires requestTimeout === 0 or
 * requestTimeout >= headersTimeout, so the request-receipt window is never
 * shorter than the headers-receipt window. Defaults satisfy this
 * (30_000 >= 20_000).
 */
export const DEFAULT_HTTP_HEADERS_TIMEOUT_MS = 20_000;
export const DEFAULT_HTTP_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_HTTP_KEEPALIVE_TIMEOUT_MS = 10_000;

/**
 * Sanity bounds on a single token parsed from MEMBERRY_API_TOKENS /
 * MEMBERRY_TENANT_TOKENS. The lower bound rejects parse artifacts (a stray
 * fragment left by a misplaced delimiter); the upper bound rejects an
 * obviously-corrupt giant value. These are deliberately permissive — real
 * tokens sit comfortably inside the range — they only catch misconfiguration,
 * not enforce a credential policy.
 */
export const MIN_API_TOKEN_LEN = 4;
export const MAX_API_TOKEN_LEN = 4_096;

/**
 * Parse a comma-separated `name:token` list (MEMBERRY_API_TOKENS /
 * MEMBERRY_TENANT_TOKENS) into a sink via `onValid`. Each entry is split on the
 * FIRST `:`; entries that are empty, lack a `:`, have an empty half, or carry a
 * token whose length is outside [MIN_API_TOKEN_LEN, MAX_API_TOKEN_LEN] are
 * SKIPPED WITH A WARNING rather than silently dropped (the previous behavior
 * masked typos and could silently disable auth / multi-tenant mode). A non-empty
 * var that yields zero valid pairs is also warned.
 *
 * CONSTRAINT (documented, not escapable): because the delimiters are literal,
 * a name or token may NOT contain `,` or `:` — such a value is split apart and
 * will be reported as malformed. Warnings log the entry's position and (for a
 * well-formed-but-rejected entry) its NAME only — never a token value.
 */
export function parseTokenPairs(
  raw: string | undefined,
  varName: string,
  onValid: (name: string, token: string) => void,
): void {
  if (!raw) return;
  const entries = raw.split(',');
  let accepted = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i].trim();
    if (!entry) continue; // tolerate empty/trailing commas silently
    const idx = entry.indexOf(':');
    const name = idx > 0 ? entry.slice(0, idx).trim() : '';
    const token = idx > 0 ? entry.slice(idx + 1).trim() : '';
    if (idx <= 0 || !name || !token) {
      console.error(
        `[memberry] ${varName}: skipping malformed entry #${i + 1} (expected "name:token" with non-empty halves; names/tokens may not contain ',' or ':').`,
      );
      continue;
    }
    if (token.length < MIN_API_TOKEN_LEN || token.length > MAX_API_TOKEN_LEN) {
      console.error(
        `[memberry] ${varName}: skipping entry #${i + 1} ("${name}") — token length ${token.length} outside [${MIN_API_TOKEN_LEN}..${MAX_API_TOKEN_LEN}].`,
      );
      continue;
    }
    onValid(name, token);
    accepted++;
  }
  if (accepted === 0) {
    console.error(
      `[memberry] WARNING: ${varName} is set but yielded ZERO valid "name:token" pairs — check the delimiters and token length.`,
    );
  }
}

/**
 * Thrown by readJsonBody when the request body exceeds the configured cap,
 * either from the Content-Length header (early reject) or the streaming
 * backstop. The /mcp handler distinguishes this from a JSON parse error to
 * surface HTTP 413 (Payload Too Large) instead of 400.
 */
export class RequestBodyTooLargeError extends Error {
  constructor(message = 'Request body too large') {
    super(message);
    this.name = 'RequestBodyTooLargeError';
  }
}

export async function closeSSEHandle(
  handle: SSEHandle,
  timeoutMs: number = DEFAULT_SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  const transports = [
    ...Array.from(handle.transports.values()),
    ...Array.from(handle.streamableTransports.values()),
  ];

  await settleWithin(
    Promise.all(transports.map(async (transport) => {
      try {
        await transport.close();
      } catch {
        // Best-effort close; shutdown should continue so systemd can restart.
      }
    })),
    timeoutMs,
    'SSE transport shutdown',
  );

  handle.transports.clear();
  handle.servers.clear();
  handle.streamableTransports.clear();
  handle.streamableServers.clear();
  handle.sessionIdentity.clear();

  if (!handle.httpServer.listening) return;

  await settleWithin(
    new Promise<void>((resolve) => {
      handle.httpServer.close(() => resolve());
    }),
    timeoutMs,
    'HTTP server shutdown',
    () => {
      handle.httpServer.closeIdleConnections?.();
      handle.httpServer.closeAllConnections?.();
    },
  );
}

async function settleWithin<T>(
  operation: Promise<T>,
  timeoutMs: number,
  description: string,
  onTimeout?: () => void,
): Promise<T | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<undefined>((resolve) => {
    timeout = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        // Ignore timeout cleanup failures; the caller is already degrading.
      }
      console.error(`[memberry-mcp] Timed out during ${description} after ${timeoutMs}ms; continuing shutdown.`);
      resolve(undefined);
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Register all tools on a server with progressive disclosure.
 * Returns the ToolRegistry for the berry_tools gateway.
 */
function registerAllTools(
  server: McpServer,
  opts: { tenantId?: string; actor?: string; multiTenant?: boolean; authenticated?: boolean } = {},
): ToolRegistry {
  const toolRegistry: ToolRegistry = new Map();

  // Register core tools — returns Tier 1 (always-on) + core domains (Tier 2).
  // In multi-tenant mode, bind the session's tenant and apply default-deny so
  // only tenant-isolated tools are usable.
  const container = (opts.multiTenant || opts.actor)
    ? coreContainerForTenant(opts.tenantId ?? DEFAULT_TENANT, opts.actor ?? 'mcp')
    : undefined;
  registerTools(server, toolRegistry, container, { multiTenant: opts.multiTenant });

  // Retrieval (berry_context / berry_ask) IS tenant-scoped, so it is registered
  // for tenant sessions too — bound to the session's tenant. (berry_feedback is
  // Tier 2 and stays disabled by default.)
  const retrievalContainer = opts.multiTenant
    ? retrievalContainerForTenant(opts.tenantId ?? DEFAULT_TENANT, opts.authenticated === true)
    : opts.authenticated === true
      ? retrievalContainerForTenant(opts.tenantId ?? DEFAULT_TENANT, true)
      : undefined;
  const retrievalResult = registerRetrievalTools(server, retrievalContainer);
  const existingRetrieval = toolRegistry.get('retrieval') ?? [];
  existingRetrieval.push(...retrievalResult.tier2);
  toolRegistry.set('retrieval', existingRetrieval);

  // The remaining satellite domains are not yet tenant-scoped, so they are only
  // registered for single-tenant sessions (withheld from tenant sessions).
  if (!opts.multiTenant) {
    const researchHandles = registerResearchTools(server);
    toolRegistry.set('research', researchHandles);

    const archHandles = registerArchTools(server);
    toolRegistry.set('arch', archHandles);

    const codeHandles = registerCodeTools(server);
    toolRegistry.set('code', codeHandles);

    const wikiHandles = registerWikiTools(server);
    toolRegistry.set('wiki', wikiHandles);

    const graphHandles = registerGraphTools(server);
    toolRegistry.set('graph', graphHandles);
  }

  // Disable all Tier 2 tools by default
  for (const handles of toolRegistry.values()) {
    for (const h of handles) h.disable();
  }

  return toolRegistry;
}

export function createAMPServer(): AMPMCPServer {
  const capabilityPolicyLookup = parseCapabilityRuntimeConfigV1(
    readEnv('MEMBERRY_CAPABILITY_POLICIES_V1'),
  );
  const toolNames = [
    ...TOOL_NAMES,
    ...RESEARCH_TOOL_NAMES,
    ...ARCH_TOOL_NAMES,
    ...CODE_TOOL_NAMES,
    ...RETRIEVAL_TOOL_NAMES,
    ...WIKI_TOOL_NAMES,
    ...GRAPH_TOOL_NAMES,
  ];
  assertCapabilityToolMatrixV1(toolNames);
  const server = new McpServer({ name: 'memberry-mcp', version: '0.1.0' });
  if (capabilityPolicyLookup !== undefined) {
    installCapabilityRuntimeInterposerV1(
      server,
      { tenantId: DEFAULT_TENANT, actorId: 'mcp' },
      undefined,
    );
  }

  // Register all MemBerry tools with progressive disclosure
  registerAllTools(server);

  // ─── SSE transport ────────────────────────────────────────────────────────

  async function startSSE(port = 3101): Promise<SSEHandle> {
    const transports = new Map<string, SSEServerTransport>();
    const servers = new Map<string, McpServer>();
    const streamableTransports = new Map<string, StreamableHTTPServerTransport>();
    const streamableServers = new Map<string, McpServer>();
    // sessionId → identity bound at creation time. Follow-up requests on an
    // existing session must re-present a token resolving to this same identity.
    const sessionIdentity = new Map<string, { tenant: string; actor: string }>();

    // ── Security helpers ───────────────────────────────────────────────────
    const ALLOWED_ORIGINS = new Set([
      'http://localhost',
      'https://localhost',
      'http://127.0.0.1',
      'https://127.0.0.1',
      'http://[::1]',
      'https://[::1]',
    ]);

    /** Return true if the origin is localhost (with any port) or absent (non-browser). */
    function isOriginAllowed(origin: string | undefined): boolean {
      if (!origin) return true; // non-browser clients don't send Origin
      try {
        const parsed = new URL(origin);
        const bare = `${parsed.protocol}//${parsed.hostname}`;
        return ALLOWED_ORIGINS.has(bare);
      } catch (err: unknown) {
        console.error("[server] Suppressed error:", err);
        return false;
      }
    }

    // ── Request body cap ─────────────────────────────────────────────────
    // Cap the bytes read from a POST body to prevent memory-exhaustion DoS.
    // Overridable via MEMBERRY_MAX_BODY_BYTES (legacy AMP_MAX_BODY_BYTES);
    // a non-positive/unparseable value falls back to the default.
    const maxBodyBytes = (() => {
      const raw = readEnv('MEMBERRY_MAX_BODY_BYTES');
      if (raw === undefined) return DEFAULT_MAX_REQUEST_BODY_BYTES;
      const parsed = Number.parseInt(raw, 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_REQUEST_BODY_BYTES;
    })();

    // ── Auth token resolution ────────────────────────────────────────────
    // Priority: MEMBERRY_API_TOKEN env var → unauthenticated opt-out → generated session token
    // Safety-relaxing flag: strict parse, only the exact string `true` opens it.
    const allowUnauthenticated = parseBoolFlag(readEnv('MEMBERRY_ALLOW_UNAUTHENTICATED'), false, { strict: true });
    if (capabilityPolicyLookup !== undefined && allowUnauthenticated) {
      throw new CapabilityRuntimeConfigError();
    }

    // Per-actor named tokens: MEMBERRY_API_TOKENS="alice:tokenA,bob:tokenB".
    // Each token maps to an actor identity, so a leaked token can be revoked
    // individually instead of rotating one shared secret for everyone.
    const tokenToActor = new Map<string, string>();
    parseTokenPairs(readEnv('MEMBERRY_API_TOKENS'), 'MEMBERRY_API_TOKENS', (name, tok) => {
      tokenToActor.set(tok, name);
    });

    // Per-tenant tokens: MEMBERRY_TENANT_TOKENS="acme:tokA,globex:tokB". Presence
    // of any tenant token turns on multi-tenant mode; each token binds a request
    // to its tenant. Tenant tokens are also valid auth tokens (actor = tenant).
    const tokenToTenant = new Map<string, string>();
    parseTokenPairs(readEnv('MEMBERRY_TENANT_TOKENS'), 'MEMBERRY_TENANT_TOKENS', (tenant, tok) => {
      tokenToTenant.set(tok, tenant);
      if (!tokenToActor.has(tok)) tokenToActor.set(tok, tenant);
    });
    const multiTenantMode = tokenToTenant.size > 0;

    // OPT-29: fail-closed tenant binding. In multi-tenant mode a token that
    // authenticates (the global MEMBERRY_API_TOKEN or a per-actor
    // MEMBERRY_API_TOKENS entry) but is NOT a tenant token would silently
    // operate on the DEFAULT tenant — reading the default bucket and writing
    // feedback/cache into the shared default bucket (the residual flagged by the
    // OPT-26/27 reviews). Such non-tenant tokens are rejected unless the operator
    // explicitly opts back into the legacy default-tenant fallback.
    // Safety-relaxing flag: strict parse, only the exact string `true` opens it.
    const allowDefaultTenant = parseBoolFlag(readEnv('MEMBERRY_ALLOW_DEFAULT_TENANT'), false, { strict: true });

    // effectiveToken is the single-token / "is auth on?" sentinel kept for the
    // status payload; actual validation goes through tokenToActor.
    let effectiveToken: string | null;

    const apiToken = readEnv('MEMBERRY_API_TOKEN');
    if (apiToken) {
      effectiveToken = apiToken;
      tokenToActor.set(apiToken, 'default');
    } else if (tokenToActor.size > 0) {
      effectiveToken = '<multi>'; // named tokens only — auth still required
    } else if (allowUnauthenticated) {
      effectiveToken = null;
      console.error(
        '[memberry] WARNING: MEMBERRY_ALLOW_UNAUTHENTICATED=true — server accepts unauthenticated requests.',
      );
    } else {
      effectiveToken = randomUUID();
      tokenToActor.set(effectiveToken, 'default');
      console.error(
        `[memberry] No MEMBERRY_API_TOKEN set. Generated session token: ${effectiveToken}. Set MEMBERRY_ALLOW_UNAUTHENTICATED=true to disable auth.`,
      );
    }

    if (capabilityPolicyLookup !== undefined) {
      for (const [token, actor] of tokenToActor) {
        const configuredTenant = tokenToTenant.get(token);
        if (multiTenantMode && !allowDefaultTenant && configuredTenant === undefined) continue;
        const tenant = multiTenantMode ? (configuredTenant ?? DEFAULT_TENANT) : DEFAULT_TENANT;
        validateCapabilityRuntimeIdentityV1(tenant, actor);
      }
    }

    if (tokenToActor.size > 0) {
      const actors = [...new Set(tokenToActor.values())].join(', ');
      console.error(`[memberry] auth: ${tokenToActor.size} token(s) configured for actor(s): ${actors}`);
    }

    /** Constant-time match of a presented token → actor name, or null. */
    function actorForToken(provided: string): string | null {
      const a = Buffer.from(provided);
      for (const [tok, actor] of tokenToActor) {
        const b = Buffer.from(tok);
        if (a.length === b.length && timingSafeEqual(a, b)) return actor;
      }
      return null;
    }

    /** Resolve the acting identity for a request, or null if unauthenticated. */
    function actorFor(req: IncomingMessage): string | null {
      if (effectiveToken === null) return 'anonymous'; // auth explicitly disabled
      const header = req.headers['authorization'] ?? '';
      const m = /^Bearer (.+)$/.exec(header);
      return m ? actorForToken(m[1]) : null;
    }

    /** Extract the bearer token from a request, or null if absent/malformed. */
    function bearerToken(req: IncomingMessage): string | null {
      const header = req.headers['authorization'] ?? '';
      const m = /^Bearer (.+)$/.exec(header);
      return m ? m[1] : null;
    }

    /** Constant-time match of a presented token → tenant name, or null. */
    function tenantForToken(provided: string): string | null {
      const a = Buffer.from(provided);
      for (const [tok, tenant] of tokenToTenant) {
        const b = Buffer.from(tok);
        if (a.length === b.length && timingSafeEqual(a, b)) return tenant;
      }
      return null;
    }

    /** Resolve the tenant for a request from its bearer token (constant-time). */
    function tenantFor(req: IncomingMessage): string {
      if (!multiTenantMode) return DEFAULT_TENANT;
      const tok = bearerToken(req);
      if (tok === null) return DEFAULT_TENANT;
      return tenantForToken(tok) ?? DEFAULT_TENANT;
    }

    if (multiTenantMode) {
      console.error(
        `[memberry] multi-tenant mode ON (${tokenToTenant.size} tenant token(s)) — ` +
        `tenant sessions get the default-deny core tool set (${'berry_load, berry_store, berry_tools'}).`,
      );
      console.error(
        allowDefaultTenant
          ? '[memberry] WARNING: MEMBERRY_ALLOW_DEFAULT_TENANT=true — non-tenant tokens fall back to the DEFAULT tenant (legacy, not isolated).'
          : '[memberry] tenant binding REQUIRED — non-tenant tokens are rejected (set MEMBERRY_ALLOW_DEFAULT_TENANT=true to restore the legacy default-tenant fallback).',
      );
    }

    /**
     * For a follow-up request resolving an existing session, verify the token
     * presented now resolves to the SAME identity bound when the session was
     * created. Returns true if the request may proceed (no bound identity yet,
     * or identity matches). Returns false on a tenant/actor mismatch — the
     * caller must reject with 403 and NOT forward to the transport. This blocks
     * one valid token from driving another tenant's session via session id.
     */
    function sessionIdentityMatches(sessionId: string, req: IncomingMessage): boolean {
      const bound = sessionIdentity.get(sessionId);
      if (!bound) return true; // no recorded identity → nothing to enforce
      const tenant = tenantFor(req);
      const actor = actorFor(req) ?? 'mcp';
      return bound.tenant === tenant && bound.actor === actor;
    }

    /** Require a matching Bearer token (any configured actor) unless auth is off.
     *  In multi-tenant mode the token must ADDITIONALLY be a tenant token (OPT-29
     *  fail-closed) — otherwise it would silently fall back to DEFAULT_TENANT —
     *  unless MEMBERRY_ALLOW_DEFAULT_TENANT=true restores the legacy fallback. */
    function isAuthorized(req: IncomingMessage): boolean {
      if (effectiveToken === null) return true; // auth explicitly disabled via opt-out
      if (actorFor(req) === null) return false; // no / invalid token
      if (multiTenantMode && !allowDefaultTenant) {
        const tok = bearerToken(req);
        // A valid-but-non-tenant token resolves to DEFAULT_TENANT; reject it.
        if (tok === null || tenantForToken(tok) === null) return false;
      }
      return true;
    }

    function setCorsHeaders(res: ServerResponse, origin: string | undefined): void {
      // Echo back the specific allowed origin (never "*")
      const allowedOrigin = origin && isOriginAllowed(origin) ? origin : 'http://localhost';
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Max-Age', '86400');
    }

    const startedAt = Date.now();

    function statusPayload(status: 'ok' | 'ready'): Record<string, unknown> {
      return {
        status,
        service: 'memberry-mcp',
        transport: 'sse',
        active_sessions: transports.size + streamableTransports.size,
        registered_sessions: servers.size + streamableServers.size,
        auth_required: effectiveToken !== null,
        uptime_ms: Date.now() - startedAt,
        consolidation_automation: getConsolidationAutomationHealth(),
      };
    }

    function sendJson(res: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
      res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    }

    function sendMcpJsonError(
      res: ServerResponse,
      statusCode: number,
      message: string,
      code = -32000,
    ): void {
      sendJson(res, statusCode, {
        jsonrpc: '2.0',
        error: { code, message },
        id: null,
      });
    }

    function getSingleHeader(value: string | string[] | undefined): string | undefined {
      return Array.isArray(value) ? value[0] : value;
    }

    function isInitializeBody(body: unknown): boolean {
      return Array.isArray(body) ? body.some(isInitializeRequest) : isInitializeRequest(body);
    }

    async function readJsonBody(req: IncomingMessage): Promise<unknown> {
      // Early reject: if Content-Length is present and already over the cap,
      // refuse before reading any of the body. (req is drained/destroyed by the
      // caller after the 413 response is written, so the upload is halted.)
      const contentLengthHeader = getSingleHeader(req.headers['content-length']);
      if (contentLengthHeader !== undefined) {
        const declared = Number.parseInt(contentLengthHeader, 10);
        if (Number.isFinite(declared) && declared > maxBodyBytes) {
          throw new RequestBodyTooLargeError();
        }
      }

      // Streaming backstop: track accumulated bytes and stop consuming as soon
      // as the cap is exceeded. Stop BEFORE buffering the offending chunk so we
      // never hold more than the cap in memory. This catches chunked /
      // no-Content-Length bodies and bodies whose actual size exceeds a lying
      // (smaller) Content-Length header.
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of req) {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        total += buf.length;
        if (total > maxBodyBytes) {
          throw new RequestBodyTooLargeError();
        }
        chunks.push(buf);
      }

      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return undefined;
      return JSON.parse(raw);
    }

    const httpServer = createServer(
      async (req: IncomingMessage, res: ServerResponse) => {
        try {
          const url = req.url ?? '/';
          const requestUrl = new URL(url, 'http://localhost');
          const pathname = requestUrl.pathname;
          const origin = req.headers['origin'] as string | undefined;

          // ── CORS preflight ───────────────────────────────────────────────
          if (req.method === 'OPTIONS') {
            if (!isOriginAllowed(origin)) {
              res.writeHead(403);
              res.end('Forbidden: origin not allowed');
              return;
            }
            setCorsHeaders(res, origin);
            res.writeHead(204);
            res.end();
            return;
          }

          // ── Origin validation ────────────────────────────────────────────
          if (!isOriginAllowed(origin)) {
            res.writeHead(403);
            res.end('Forbidden: origin not allowed');
            return;
          }

          // ── Non-streaming liveness check ─────────────────────────────────
          // Intentionally unauthenticated: it exposes no secrets and lets local
          // service managers verify process liveness without reading token files.
          if (req.method === 'GET' && pathname === '/healthz') {
            setCorsHeaders(res, origin);
            sendJson(res, 200, statusPayload('ok'));
            return;
          }

          // ── Token auth (required by default) ──────────────────────────────
          if (!isAuthorized(req)) {
            res.writeHead(401);
            res.end('Unauthorized: invalid or missing Bearer token');
            return;
          }

          // Set CORS headers on every response
          setCorsHeaders(res, origin);

          // ── Authenticated readiness check ────────────────────────────────
          if (req.method === 'GET' && pathname === '/readyz') {
            const readiness = await getDatastoreReadiness();
            const body: Record<string, unknown> = {
              ...statusPayload('ready'),
              admission_shadow: getAdmissionShadowProcessStatus(),
              retrieval_resolution: getRetrievalResolutionProcessStatusV1(),
              ...readiness,
            };
            const automation = body['consolidation_automation'] as { unhealthy?: boolean };
            // During startup grace and while bounded retries are pending the
            // service remains ready. Only stale/exhausted enabled automation is
            // genuinely unhealthy; disabled/read-only modes are explicit but
            // do not create a false outage. An unreachable datastore does.
            sendJson(res, readinessStatusCode(automation, readiness?.datastores), body);
            return;
          }

          if (pathname === '/mcp') {
            const sessionId = getSingleHeader(req.headers['mcp-session-id']);
            let parsedBody: unknown;

            if (req.method === 'POST') {
              try {
                parsedBody = await readJsonBody(req);
              } catch (err) {
                if (err instanceof RequestBodyTooLargeError) {
                  // Write the 413 first, THEN tear down the request socket so any
                  // still-uploading client stops sending without us buffering the
                  // rest of the body. Order matters: destroying before writing
                  // would race the response off the wire.
                  sendMcpJsonError(res, 413, 'Payload too large', -32600);
                  req.destroy();
                } else {
                  sendMcpJsonError(res, 400, 'Parse error: Invalid JSON', -32700);
                }
                return;
              }
            }

            let streamableTransport = sessionId ? streamableTransports.get(sessionId) : undefined;

            if (sessionId && !streamableTransport) {
              if (transports.has(sessionId)) {
                sendMcpJsonError(res, 400, 'Bad Request: Session exists but uses a different transport protocol');
                return;
              }

              sendMcpJsonError(res, 404, 'Session not found');
              return;
            }

            if (!streamableTransport) {
              if (req.method !== 'POST' || !isInitializeBody(parsedBody)) {
                sendMcpJsonError(res, 400, 'Bad Request: No valid session ID provided');
                return;
              }

              const tenant = tenantFor(req);
              const actor = actorFor(req) ?? 'mcp';
              const perSessionServer = new McpServer({ name: 'memberry-mcp', version: '0.1.0' });
              if (capabilityPolicyLookup !== undefined) {
                installCapabilityRuntimeInterposerV1(
                  perSessionServer,
                  { tenantId: tenant, actorId: actor },
                  capabilityPolicyLookup(tenant, actor),
                );
              }
              registerAllTools(perSessionServer, {
                tenantId: tenant,
                actor,
                multiTenant: multiTenantMode,
                authenticated: effectiveToken !== null,
              });

              let nextTransport: StreamableHTTPServerTransport | undefined;
              nextTransport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                enableJsonResponse: true,
                onsessioninitialized: (newSessionId) => {
                  if (!nextTransport) return;
                  streamableTransports.set(newSessionId, nextTransport);
                  streamableServers.set(newSessionId, perSessionServer);
                  // Bind the creating identity to the freshly minted session id so
                  // follow-up /mcp requests must re-present a matching token.
                  sessionIdentity.set(newSessionId, { tenant, actor });
                },
              });

              nextTransport.onclose = () => {
                const sid = nextTransport?.sessionId;
                if (!sid) return;
                streamableTransports.delete(sid);
                streamableServers.delete(sid);
                sessionIdentity.delete(sid);
              };

              await perSessionServer.connect(nextTransport);
              streamableTransport = nextTransport;
            } else if (sessionId && !sessionIdentityMatches(sessionId, req)) {
              // Existing session resolved by id: the presented token must map to
              // the identity that created it, otherwise this is a cross-tenant
              // hijack attempt. Reject before forwarding to the transport.
              sendMcpJsonError(res, 403, 'Forbidden: session/token mismatch');
              return;
            }

            await streamableTransport.handleRequest(req, res, parsedBody);
            return;
          }

          if (req.method === 'GET' && pathname === '/sse') {
            // Create a fresh McpServer per connection (SDK limitation: one transport per server)
            const tenant = tenantFor(req);
            const actor = actorFor(req) ?? 'mcp';
            const perSessionServer = new McpServer({ name: 'memberry-mcp', version: '0.1.0' });
            if (capabilityPolicyLookup !== undefined) {
              installCapabilityRuntimeInterposerV1(
                perSessionServer,
                { tenantId: tenant, actorId: actor },
                capabilityPolicyLookup(tenant, actor),
              );
            }
            registerAllTools(perSessionServer, {
              tenantId: tenant,
              actor,
              multiTenant: multiTenantMode,
              authenticated: effectiveToken !== null,
            });

            const transport = new SSEServerTransport('/messages', res);
            transports.set(transport.sessionId, transport);
            servers.set(transport.sessionId, perSessionServer);
            // Bind the creating identity so follow-up /messages requests must
            // re-present a token resolving to this same tenant/actor.
            sessionIdentity.set(transport.sessionId, { tenant, actor });

            transport.onclose = () => {
              transports.delete(transport.sessionId);
              servers.delete(transport.sessionId);
              sessionIdentity.delete(transport.sessionId);
            };

            await perSessionServer.connect(transport);
            return;
          }

          if (req.method === 'POST' && pathname === '/messages') {
            // Route POST message to the correct session
            const sessionId = requestUrl.searchParams.get('sessionId');
            const transport = sessionId ? transports.get(sessionId) : undefined;

            if (!sessionId || !transport) {
              res.writeHead(404);
              res.end('Session not found');
              return;
            }

            // The presented token must resolve to the identity that created this
            // SSE session; otherwise reject before forwarding to the transport so
            // a valid token cannot drive another tenant's session.
            if (!sessionIdentityMatches(sessionId, req)) {
              res.writeHead(403);
              res.end('Forbidden: session/token mismatch');
              return;
            }

            // OPT-73: the SSE transport would otherwise read the body itself via
            // getRawBody(limit: 4mb) — the configurable OPT-08 cap
            // (MEMBERRY_MAX_BODY_BYTES, default 1MB) did NOT apply to /messages, so
            // an operator couldn't tighten the SSE POST limit and it diverged from
            // /mcp. Pre-read with the SAME capped reader and hand the parsed body to
            // the SDK (it uses `parsedBody ?? getRawBody(...)`, so a provided body
            // skips its own read) → both POST paths now honor one configurable cap.
            let parsedBody: unknown;
            try {
              parsedBody = await readJsonBody(req);
            } catch (err) {
              if (err instanceof RequestBodyTooLargeError) {
                res.writeHead(413);
                res.end('Payload too large');
                req.destroy();
              } else {
                res.writeHead(400);
                res.end('Parse error: Invalid JSON');
              }
              return;
            }
            // An empty body is never a valid JSON-RPC message; reject explicitly
            // (passing undefined would make the SDK re-read the already-consumed
            // stream).
            if (parsedBody === undefined) {
              res.writeHead(400);
              res.end('Parse error: empty body');
              return;
            }

            await transport.handlePostMessage(req, res, parsedBody);
            return;
          }

          res.writeHead(404);
          res.end('Not found');
        } catch (err) {
          console.error('[memberry-mcp] Unhandled error in HTTP handler:', err);
          if (!res.headersSent) {
            res.writeHead(500);
            res.end('Internal Server Error');
          }
        }
      },
    );

    // ── Slowloris (slow-client) DoS guard ────────────────────────────────────
    // Bound how long the server will WAIT TO RECEIVE a request. Without these,
    // Node's requestTimeout default (300_000ms) lets a slow trickle hold a
    // connection — and a pool slot — open for 5 minutes. These limits apply to
    // request RECEIPT (headers/body), not response duration, so the long-lived
    // SSE GET response stays alive (its empty request finishes reading at once).
    // Each is env-overridable; a non-positive/unparseable value falls back to
    // the default. The ordering invariant (requestTimeout >= headersTimeout) is
    // enforced after resolution so a partial override can't misconfigure Node.
    const resolveTimeoutMs = (canonical: string, fallback: number): number => {
      const raw = readEnv(canonical);
      if (raw === undefined) return fallback;
      const parsed = Number.parseInt(raw, 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    };
    httpServer.keepAliveTimeout = resolveTimeoutMs(
      'MEMBERRY_HTTP_KEEPALIVE_TIMEOUT_MS',
      DEFAULT_HTTP_KEEPALIVE_TIMEOUT_MS,
    );
    httpServer.headersTimeout = resolveTimeoutMs(
      'MEMBERRY_HTTP_HEADERS_TIMEOUT_MS',
      DEFAULT_HTTP_HEADERS_TIMEOUT_MS,
    );
    const requestTimeout = resolveTimeoutMs(
      'MEMBERRY_HTTP_REQUEST_TIMEOUT_MS',
      DEFAULT_HTTP_REQUEST_TIMEOUT_MS,
    );
    // Node requires requestTimeout === 0 or requestTimeout >= headersTimeout.
    // Clamp up so a too-low override (or a raised headersTimeout) can't trip
    // Node's warning or leave the receive window misordered.
    httpServer.requestTimeout = Math.max(requestTimeout, httpServer.headersTimeout);

    // OPT-62: bind to the configured host when set (MEMBERRY_HOST / HOST), else
    // keep the prior all-interfaces bind (no host arg) so default behavior + the
    // LAN-accessible deployment are unchanged.
    const listenHost = resolveListenHost();
    await new Promise<void>((resolve, reject) => {
      if (listenHost) httpServer.listen(port, listenHost, () => resolve());
      else httpServer.listen(port, () => resolve());
      httpServer.once('error', reject);
    });

    console.error(`[memberry-mcp] SSE server listening on http://${listenHost ?? 'localhost'}:${port}/sse`);

    return { httpServer, transports, servers, streamableTransports, streamableServers, sessionIdentity };
  }

  // ─── Stdio transport ──────────────────────────────────────────────────────

  async function startStdio(): Promise<void> {
    if (capabilityPolicyLookup !== undefined) throw new CapabilityRuntimeConfigError();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('[memberry-mcp] stdio transport connected');
  }

  return {
    server,
    toolNames,
    startSSE,
    startStdio,
  };
}

// ─── CLI entrypoint ───────────────────────────────────────────────────────────

// When run directly via `tsx src/server.ts` or `node dist/server.js`
const isMain =
  // ESM: import.meta.url === process.argv[1] resolved URL
  (typeof process !== 'undefined' &&
    process.argv[1] != null &&
    // Works both for tsx (ts path) and compiled js (dist path)
    (process.argv[1].endsWith('server.ts') || process.argv[1].endsWith('server.js')));

if (isMain) {
  const useStdio = process.argv.includes('--stdio');

  // Bootstrap: connect Redis + Neo4j, create services, inject into tools
  import('./bootstrap.js')
    .then(({ bootstrap }) => bootstrap())
    .then(async (handles) => {
      const amp = createAMPServer();

      let sseHandle: SSEHandle | undefined;
      if (useStdio) {
        await amp.startStdio();
      } else {
        const port = resolvePort(process.env);
        sseHandle = await amp.startSSE(port);
      }

      // ── Graceful shutdown ───────────────────────────────────────────────
      let shuttingDown = false;
      const shutdownTimeoutMs = parseInt(readEnv('MEMBERRY_SHUTDOWN_TIMEOUT_MS') ?? String(DEFAULT_SHUTDOWN_TIMEOUT_MS), 10);

      async function gracefulShutdown(signal: string): Promise<void> {
        if (shuttingDown) return;
        shuttingDown = true;
        console.error(`[memberry-mcp] ${signal} received — shutting down gracefully`);

        if (sseHandle) {
          await closeSSEHandle(sseHandle, shutdownTimeoutMs);
        }

        await settleWithin(
          handles.shutdown(),
          shutdownTimeoutMs,
          'Redis/Neo4j shutdown',
        );

        console.error('[memberry-mcp] Shutdown complete');
        process.exit(0);
      }

      process.on('SIGTERM', () => {
        gracefulShutdown('SIGTERM').catch((err: unknown) => {
          console.error('[memberry-mcp] Error during SIGTERM shutdown:', err);
          process.exit(1);
        });
      });
      process.on('SIGINT', () => {
        gracefulShutdown('SIGINT').catch((err: unknown) => {
          console.error('[memberry-mcp] Error during SIGINT shutdown:', err);
          process.exit(1);
        });
      });
    })
    .catch((err: unknown) => {
      console.error('[memberry-mcp] Fatal startup error:', err);
      process.exit(1);
    });
}
