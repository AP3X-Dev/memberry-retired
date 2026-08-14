import { createHash } from 'node:crypto';

import type {
  AdapterCapability,
  AdapterHealth,
  AdapterStats,
  CleanupResult,
  FeedbackRequest,
  IngestRequest,
  IngestResult,
  LabAdapter,
  LabMemory,
  LabNamespace,
  QueryRequest,
  QueryResponse,
} from '../contracts/adapter.js';
import { LAB_CONTRACT_VERSION } from '../contracts/adapter.js';

const PROTOCOL_VERSION = '2025-03-26';
const FIXTURE_MARKER = 'MEMBERRY_LAB_ID';

export interface MemberryTenantEndpoint {
  baseUrl: string;
  token: string;
}

export interface MemberryToolTransport {
  health(): Promise<AdapterHealth>;
  call(tool: string, args: Record<string, unknown>): Promise<string>;
  close?(): Promise<void>;
}

export interface MemberryLiveAdapterOptions {
  /** Token-bound endpoints, keyed by the tenant name used in scenarios. */
  tenants: Readonly<Record<string, MemberryTenantEndpoint>>;
  /** Must be explicitly true. The default live adapter is read-only. */
  allowSyntheticWrites?: boolean;
  requestTimeoutMs?: number;
  transportFactory?: (endpoint: MemberryTenantEndpoint) => MemberryToolTransport;
}

interface NamespaceCounters {
  memories: number;
  queries: number;
  feedbackEvents: number;
}

function namespaceKey(namespace: LabNamespace): string {
  return `${namespace.runId}\u0000${namespace.tenant}\u0000${namespace.project}`;
}

function safeSegment(value: string): string {
  const readable = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
  const suffix = createHash('sha256').update(value).digest('hex').slice(0, 10);
  return `${readable || 'scope'}-${suffix}`;
}

/**
 * Every live run gets a project tag that cannot collide with normal project
 * memory. The tag is deterministic so ingest and query agree after a restart.
 */
export function liveProjectScope(namespace: LabNamespace, project = namespace.project): string {
  return `project:memberry-eval-${safeSegment(`${namespace.runId}:${namespace.tenant}:${project}`)}`;
}

function fixtureContent(memory: LabMemory): string {
  return `[${FIXTURE_MARKER}:${memory.id}] ${memory.content}`;
}

function validFixtureId(id: string): boolean {
  return /^[A-Za-z0-9._:-]{1,200}$/.test(id);
}

export function parseFixtureResults(markdown: string, limit: number): QueryResponse['results'] {
  const marker = new RegExp(`\\[${FIXTURE_MARKER}:([^\\]\\r\\n]+)\\]`, 'g');
  const results: Array<{ id: string; score: number; content?: string; metadata?: Readonly<Record<string, unknown>> }> = [];
  const seen = new Set<string>();
  for (const match of markdown.matchAll(marker)) {
    const id = match[1]?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const rank = results.length;
    const after = (match.index ?? 0) + match[0].length;
    const nextHeading = markdown.indexOf('\n## ', after);
    const content = markdown.slice(after, nextHeading < 0 ? undefined : nextHeading).trim();
    results.push({ id, score: 1 / (rank + 1), content, metadata: { live: true, rank: rank + 1 } });
    if (results.length >= limit) break;
  }
  return results;
}

function parseRpcPayload(contentType: string, body: string): unknown {
  if (!body.trim()) return undefined;
  if (contentType.toLowerCase().includes('text/event-stream')) {
    const data = body
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim();
    return data ? JSON.parse(data) : undefined;
  }
  return JSON.parse(body);
}

function rpcError(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const error = (payload as { error?: { message?: unknown } }).error;
  return typeof error?.message === 'string' ? error.message : undefined;
}

function toolText(payload: unknown): string {
  const result = (payload as { result?: { isError?: boolean; content?: Array<{ type?: string; text?: string }> } })?.result;
  const text = result?.content?.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n') ?? '';
  if (result?.isError) throw new Error(text || 'MemBerry MCP tool returned isError');
  return text;
}

/** Minimal Streamable HTTP MCP client used by the live evaluation adapter. */
export class HttpMemberryTransport implements MemberryToolTransport {
  private sessionId?: string;
  private protocolVersion = PROTOCOL_VERSION;
  private nextId = 1;

  constructor(
    private readonly endpoint: MemberryTenantEndpoint,
    private readonly timeoutMs = 10_000,
  ) {}

  private async request(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(new URL(path, this.endpoint.baseUrl), { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private headers(withSession = true): Record<string, string> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.endpoint.token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    if (withSession && this.sessionId) {
      headers['mcp-session-id'] = this.sessionId;
      headers['mcp-protocol-version'] = this.protocolVersion;
    }
    return headers;
  }

  private async post(body: Record<string, unknown>, withSession = true): Promise<unknown> {
    const response = await this.request('/mcp', {
      method: 'POST',
      headers: this.headers(withSession),
      body: JSON.stringify(body),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`MemBerry MCP HTTP ${response.status}: ${raw.slice(0, 300)}`);
    const payload = parseRpcPayload(response.headers.get('content-type') ?? '', raw);
    const error = rpcError(payload);
    if (error) throw new Error(`MemBerry MCP RPC error: ${error}`);
    return payload;
  }

  private async initialize(): Promise<void> {
    if (this.sessionId) return;
    const response = await this.request('/mcp', {
      method: 'POST',
      headers: this.headers(false),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: this.nextId++,
        method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'memberry-evaluation-lab', version: LAB_CONTRACT_VERSION },
        },
      }),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`MemBerry MCP initialize HTTP ${response.status}: ${raw.slice(0, 300)}`);
    const payload = parseRpcPayload(response.headers.get('content-type') ?? '', raw) as {
      result?: { protocolVersion?: string };
    } | undefined;
    const error = rpcError(payload);
    if (error) throw new Error(`MemBerry MCP initialize error: ${error}`);
    this.sessionId = response.headers.get('mcp-session-id') ?? undefined;
    if (!this.sessionId) throw new Error('MemBerry MCP initialize returned no mcp-session-id');
    this.protocolVersion = payload?.result?.protocolVersion ?? PROTOCOL_VERSION;
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  async health(): Promise<AdapterHealth> {
    try {
      const response = await this.request('/readyz', {
        headers: { authorization: `Bearer ${this.endpoint.token}` },
      });
      return response.ok
        ? { status: 'ready', details: { httpStatus: response.status } }
        : { status: response.status === 503 ? 'degraded' : 'unavailable', details: { httpStatus: response.status } };
    } catch (error) {
      return { status: 'unavailable', details: { error: error instanceof Error ? error.message : String(error) } };
    }
  }

  async call(tool: string, args: Record<string, unknown>): Promise<string> {
    await this.initialize();
    const payload = await this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    });
    return toolText(payload);
  }
}

/**
 * Real MemBerry adapter. It does not pretend to support cleanup or historical
 * ingest because the public MCP contract cannot safely provide those today.
 * A unique synthetic project scope is the isolation boundary instead.
 */
export class MemberryLiveAdapter implements LabAdapter {
  readonly id = 'memberry-live-mcp';
  readonly displayName = 'MemBerry Live (MCP)';
  readonly executionMode = 'live' as const;
  readonly contractVersion = LAB_CONTRACT_VERSION;
  readonly capabilities: ReadonlySet<AdapterCapability>;

  private readonly transports = new Map<string, MemberryToolTransport>();
  private readonly counters = new Map<string, NamespaceCounters>();

  constructor(private readonly options: MemberryLiveAdapterOptions) {
    const capabilities: AdapterCapability[] = ['namespaces', 'project-scope'];
    if (Object.keys(options.tenants).length > 1) capabilities.push('tenant-scope');
    this.capabilities = new Set(capabilities);
  }

  private transport(tenant: string): MemberryToolTransport | undefined {
    const endpoint = this.options.tenants[tenant];
    if (!endpoint) return undefined;
    let transport = this.transports.get(tenant);
    if (!transport) {
      transport = this.options.transportFactory?.(endpoint)
        ?? new HttpMemberryTransport(endpoint, this.options.requestTimeoutMs);
      this.transports.set(tenant, transport);
    }
    return transport;
  }

  private count(namespace: LabNamespace): NamespaceCounters {
    const key = namespaceKey(namespace);
    let value = this.counters.get(key);
    if (!value) {
      value = { memories: 0, queries: 0, feedbackEvents: 0 };
      this.counters.set(key, value);
    }
    return value;
  }

  async health(): Promise<AdapterHealth> {
    const tenants = Object.keys(this.options.tenants);
    if (!tenants.length) return { status: 'unavailable', details: { reason: 'no tenant endpoints configured' } };
    const statuses = await Promise.all(tenants.map(async (tenant) => [tenant, await this.transport(tenant)!.health()] as const));
    const status = statuses.some(([, health]) => health.status === 'unavailable')
      ? 'unavailable'
      : statuses.some(([, health]) => health.status === 'degraded') || !this.options.allowSyntheticWrites
        ? 'degraded'
        : 'ready';
    return {
      status,
      details: {
        syntheticWrites: this.options.allowSyntheticWrites === true,
        tenants: Object.fromEntries(statuses),
      },
    };
  }

  async ingest(request: IngestRequest): Promise<IngestResult> {
    const started = performance.now();
    const rejected: Array<{ id: string; reason: string }> = [];
    let accepted = 0;
    if (!this.options.allowSyntheticWrites) {
      return {
        accepted: 0,
        rejected: request.memories.map((memory) => ({ id: memory.id, reason: 'synthetic live writes are disabled' })),
        durationMs: performance.now() - started,
      };
    }

    for (const memory of request.memories) {
      const tenant = memory.tenant ?? request.namespace.tenant;
      const project = memory.project ?? request.namespace.project;
      const transport = this.transport(tenant);
      if (!transport) {
        rejected.push({ id: memory.id, reason: `no token-bound endpoint configured for tenant ${tenant}` });
        continue;
      }
      if (!validFixtureId(memory.id) || !memory.content.trim()) {
        rejected.push({ id: memory.id, reason: 'id must be a marker-safe identifier and content is required' });
        continue;
      }
      const scope = liveProjectScope({ ...request.namespace, tenant }, project);
      try {
        const result = await transport.call('berry_store', {
          session_id: `eval-${safeSegment(request.namespace.runId)}`,
          task: `Evaluation fixture ${memory.id}`,
          content: fixtureContent(memory),
          memory_type: memory.kind === 'decision' ? 'decision' : memory.kind === 'pattern' ? 'pattern' : 'general',
          scope,
          tags: [scope, 'evaluation-lab', `eval-run:${safeSegment(request.namespace.runId)}`],
        });
        if (!/^id:|duplicate:true/m.test(result)) throw new Error(`unexpected berry_store response: ${result.slice(0, 160)}`);
        accepted += 1;
      } catch (error) {
        rejected.push({ id: memory.id, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    this.count(request.namespace).memories += accepted;
    return { accepted, rejected, durationMs: performance.now() - started };
  }

  async query(request: QueryRequest): Promise<QueryResponse> {
    const started = performance.now();
    const transport = this.transport(request.namespace.tenant);
    if (!transport) throw new Error(`no token-bound endpoint configured for tenant ${request.namespace.tenant}`);
    if (request.asOf) {
      throw new Error('memberry-live-mcp does not support historical ingest; temporal-filtering is not advertised');
    }
    const scope = liveProjectScope(request.namespace);
    const markdown = await transport.call('berry_load', {
      task: request.query,
      tags: [scope],
      max_tokens: request.tokenBudget ?? Math.max(1000, request.limit * 250),
    });
    this.count(request.namespace).queries += 1;
    return {
      results: parseFixtureResults(markdown, request.limit),
      durationMs: performance.now() - started,
    };
  }

  /**
   * Exact post-ingest verification for disposable live smoke tests. This uses
   * berry_grep instead of pretending that an embedding-free berry_load proves
   * semantic retrieval quality. Full evaluation queries still use berry_load.
   */
  async verifySyntheticFixture(namespace: LabNamespace, fixtureId: string): Promise<boolean> {
    if (!validFixtureId(fixtureId)) throw new Error('fixture id is not marker-safe');
    const transport = this.transport(namespace.tenant);
    if (!transport) throw new Error(`no token-bound endpoint configured for tenant ${namespace.tenant}`);
    const markdown = await transport.call('berry_grep', {
      pattern: `${FIXTURE_MARKER}:${fixtureId}`,
      node_types: ['episodic'],
      scope: liveProjectScope(namespace),
      limit: 5,
    });
    // berry_grep deliberately bolds the matched substring in its Markdown
    // snippet (`[**MEMBERRY_LAB_ID:id**]`). Remove only that renderer markup
    // before checking the exact marker envelope.
    return markdown.replaceAll('**', '').includes(`[${FIXTURE_MARKER}:${fixtureId}]`);
  }

  async feedback(_request: FeedbackRequest): Promise<void> {
    throw new Error('memberry-live-mcp does not advertise feedback capability');
  }

  async stats(namespace: LabNamespace): Promise<AdapterStats> {
    const counters = this.count(namespace);
    return {
      ...counters,
      details: { source: 'adapter-local', durableBackendStats: false },
    };
  }

  async cleanup(namespace: LabNamespace): Promise<CleanupResult> {
    // The public MCP surface intentionally has no broad delete/reset operation.
    // Synthetic scopes are retained for audit and can be removed only by a
    // separately authorized, tenant-scoped maintenance workflow.
    this.counters.delete(namespaceKey(namespace));
    return { deleted: 0 };
  }
}

export function memberryLiveOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): MemberryLiveAdapterOptions {
  const tenant = env.MEMBERRY_LAB_TENANT_ID?.trim();
  const token = env.MEMBERRY_LAB_API_TOKEN?.trim();
  const baseUrl = env.MEMBERRY_LAB_MCP_URL?.trim();
  const tenants: Record<string, MemberryTenantEndpoint> = {};
  if (tenant && token && baseUrl) tenants[tenant] = { token, baseUrl };
  return {
    tenants,
    allowSyntheticWrites: env.MEMBERRY_LAB_ALLOW_WRITES?.toLowerCase() === 'true',
    requestTimeoutMs: Number.parseInt(env.MEMBERRY_LAB_TIMEOUT_MS ?? '10000', 10),
  };
}
