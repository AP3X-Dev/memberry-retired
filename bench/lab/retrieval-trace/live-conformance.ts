#!/usr/bin/env tsx

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isNativeError, isProxy } from 'node:util/types';

import type { Driver, QueryResult, Session } from 'neo4j-driver';
import type Redis from 'ioredis';

import { createNeo4jDriver } from '../../../packages/neo4j/src/driver.js';
import { createRedisClient } from '../../../packages/redis/src/client.js';
import { hasClosedRetrievalResolutionStatusV1 } from '../contracts/retrieval-resolution-status.js';
import { hasClosedReadinessProbeShapeV1, presentReadinessProbeKeys } from '../contracts/readiness-probe-status.js';
import type { RetrievalTraceAlgorithmVersion } from '../../../packages/retrieval/src/index.js';
import {
  RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_ENABLED,
  RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_ENV,
  RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_LINES,
  type RetrievalTraceValidationStage,
} from '../../../packages/retrieval/src/tools.js';
import {
  assertTraceConformanceManifest,
  inspectRet010dRerankerStage,
  inspectTraceToolResult,
  sanitizeTraceConformanceManifest,
  observeOrderedMarkdownResultIds,
  type TraceInspectionSummary,
} from './contract.js';

const execFileAsync = promisify(execFile);
const MCP_PROTOCOL_VERSION = '2025-03-26';
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 300_000;
const MAX_HTTP_RESPONSE_BYTES = 4_194_304;
const NAMED_TENANT = 'ret001d-named';
export type Ret010dRuntimeProfile = 'legacy' | 'disabled' | 'served';

type JsonRecord = Record<string, unknown>;

export interface TraceConformanceConfig {
  readonly defaultToken: string;
  readonly namedToken: string;
  readonly neo4jUser: string;
  readonly neo4jPassword: string;
  readonly mcpUrl: string;
  readonly redisUrl: string;
  readonly neo4jUri: string;
  readonly host: '127.0.0.1' | '::1' | 'localhost';
  readonly port: number;
  readonly requestTimeoutMs: number;
  readonly startupTimeoutMs: number;
  readonly evidencePath?: string;
  readonly redisContainerId: string;
  readonly redisImageId: string;
  readonly neo4jContainerId: string;
  readonly neo4jImageId: string;
  readonly safeConfig: Readonly<Record<string, unknown>>;
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`RET-001D live evidence requires ${name}`);
  return value;
}

function loopbackUrl(raw: string, protocols: readonly string[], name: string): URL {
  if (/%[0-9a-f]{2}/i.test(raw)) throw new Error(`${name} must not contain encoded components`);
  let parsed: URL;
  try { parsed = new URL(raw); }
  catch { throw new Error(`${name} must be a valid loopback URL`); }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!protocols.includes(parsed.protocol) || !['127.0.0.1', '::1', 'localhost'].includes(host)) {
    throw new Error(`${name} must be loopback-only and use ${protocols.join(' or ')}`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash
    || (parsed.pathname !== '' && parsed.pathname !== '/')) throw new Error(`${name} must use a credential-free root URL`);
  return parsed;
}

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^\d+$/.test(raw.trim())) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} is out of bounds`);
  return value;
}

function exactIdentity(raw: string, pattern: RegExp, name: string): string {
  if (!pattern.test(raw)) throw new Error(`${name} must be an exact immutable identity`);
  return raw;
}

export function resolveTraceConformanceConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): TraceConformanceConfig {
  if (env.MEMBERRY_TRACE_LIVE_DISPOSABLE?.trim().toLowerCase() !== 'true') {
    throw new Error('RET-001D live evidence is fail-closed; set MEMBERRY_TRACE_LIVE_DISPOSABLE=true');
  }
  const defaultToken = required(env, 'MEMBERRY_TRACE_LIVE_DEFAULT_TOKEN');
  const namedToken = required(env, 'MEMBERRY_TRACE_LIVE_NAMED_TOKEN');
  if (defaultToken === namedToken) throw new Error('RET-001D live evidence requires distinct tenant tokens');
  const mcp = loopbackUrl(required(env, 'MEMBERRY_TRACE_LIVE_MCP_URL'), ['http:'], 'MCP URL');
  const redis = loopbackUrl(required(env, 'MEMBERRY_TRACE_LIVE_REDIS_URL'), ['redis:', 'rediss:'], 'Redis URL');
  const neo4j = loopbackUrl(required(env, 'MEMBERRY_TRACE_LIVE_NEO4J_URI'), ['bolt:', 'neo4j:'], 'Neo4j URI');
  const requestTimeoutMs = boundedInteger(
    env.MEMBERRY_TRACE_LIVE_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS, 100, 60_000,
    'MEMBERRY_TRACE_LIVE_REQUEST_TIMEOUT_MS',
  );
  const startupTimeoutMs = boundedInteger(
    env.MEMBERRY_TRACE_LIVE_STARTUP_TIMEOUT_MS, DEFAULT_STARTUP_TIMEOUT_MS, 1_000, 600_000,
    'MEMBERRY_TRACE_LIVE_STARTUP_TIMEOUT_MS',
  );
  const port = Number(mcp.port || '80');
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) throw new Error('MCP URL port is out of bounds');
  const safeConfig = Object.freeze({
    host: mcp.hostname.replace(/^\[|\]$/g, ''),
    port,
    transport: 'streamable-http-mcp',
    requestTimeoutMs,
    startupTimeoutMs,
    responseByteLimit: MAX_HTTP_RESPONSE_BYTES,
  });
  return Object.freeze({
    defaultToken,
    namedToken,
    neo4jUser: required(env, 'MEMBERRY_TRACE_LIVE_NEO4J_USER'),
    neo4jPassword: required(env, 'MEMBERRY_TRACE_LIVE_NEO4J_PASSWORD'),
    redisContainerId: exactIdentity(required(env, 'MEMBERRY_TRACE_LIVE_REDIS_CONTAINER_ID'), /^[0-9a-f]{64}$/, 'Redis container ID'),
    redisImageId: exactIdentity(required(env, 'MEMBERRY_TRACE_LIVE_REDIS_IMAGE_ID'), /^sha256:[0-9a-f]{64}$/, 'Redis image ID'),
    neo4jContainerId: exactIdentity(required(env, 'MEMBERRY_TRACE_LIVE_NEO4J_CONTAINER_ID'), /^[0-9a-f]{64}$/, 'Neo4j container ID'),
    neo4jImageId: exactIdentity(required(env, 'MEMBERRY_TRACE_LIVE_NEO4J_IMAGE_ID'), /^sha256:[0-9a-f]{64}$/, 'Neo4j image ID'),
    mcpUrl: mcp.toString(),
    redisUrl: redis.toString(),
    neo4jUri: neo4j.toString(),
    host: safeConfig.host as TraceConformanceConfig['host'],
    port,
    requestTimeoutMs,
    startupTimeoutMs,
    ...(env.MEMBERRY_TRACE_LIVE_EVIDENCE_PATH?.trim()
      ? { evidencePath: resolve(env.MEMBERRY_TRACE_LIVE_EVIDENCE_PATH.trim()) }
      : {}),
    safeConfig,
  });
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) return reader.read();
  if (signal.aborted) throw new Error('RET001D_HTTP_BODY_ABORTED');
  const pendingRead = reader.read();
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let aborting = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      action();
    };
    const onAbort = () => {
      aborting = true;
      // Cancellation is not fire-and-forget: drain the pending read before the
      // request is allowed to reject and its finally block can continue.
      void (async () => {
        await reader.cancel().catch(() => undefined);
        await pendingRead.catch(() => undefined);
        settle(() => rejectPromise(new Error('RET001D_HTTP_BODY_ABORTED')));
      })();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    pendingRead.then(
      (result) => { if (!aborting) settle(() => resolvePromise(result)); },
      () => { if (!aborting) settle(() => rejectPromise(new Error('RET001D_HTTP_BODY_READ_FAILED'))); },
    );
  });
}

export async function readBoundedResponseText(
  response: Response,
  limit = MAX_HTTP_RESPONSE_BYTES,
  signal?: AbortSignal,
): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('RET001D_HTTP_BODY_TOO_LARGE');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    while (true) {
      const { value, done } = await readChunk(reader, signal);
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new Error('RET001D_HTTP_BODY_TOO_LARGE');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

function parseEnvelope(contentType: string, raw: string): JsonRecord | undefined {
  if (!raw.trim()) return undefined;
  let json = raw;
  if (contentType.toLowerCase().includes('text/event-stream')) {
    const events = raw.split(/\r?\n\r?\n/).flatMap((event) => {
      const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart()).join('\n').trim();
      return data ? [data] : [];
    });
    if (events.length !== 1) throw new Error('RET001D_MCP_ENVELOPE_INVALID');
    json = events[0]!;
  }
  let value: unknown;
  try { value = JSON.parse(json); }
  catch { throw new Error('RET001D_MCP_ENVELOPE_INVALID'); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('RET001D_MCP_ENVELOPE_INVALID');
  return value as JsonRecord;
}

export class TraceMcpTransport {
  private sessionId?: string;
  private nextId = 1;

  constructor(
    private readonly config: TraceConformanceConfig,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private headers(withSession: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    if (withSession && this.sessionId) {
      headers['mcp-session-id'] = this.sessionId;
      headers['mcp-protocol-version'] = MCP_PROTOCOL_VERSION;
    }
    return headers;
  }

  private async request(body: JsonRecord, withSession = true): Promise<JsonRecord | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(new URL('/mcp', this.config.mcpUrl), {
        method: 'POST', headers: this.headers(withSession), body: JSON.stringify(body), signal: controller.signal,
      });
      const raw = await readBoundedResponseText(response, MAX_HTTP_RESPONSE_BYTES, controller.signal);
      if (controller.signal.aborted) throw new Error('RET001D_MCP_TIMEOUT');
      if (!response.ok) throw new Error(`RET001D_MCP_HTTP_${response.status}`);
      const envelope = parseEnvelope(response.headers.get('content-type') ?? '', raw);
      const requestId = Object.prototype.hasOwnProperty.call(body, 'id') ? body.id : undefined;
      if (requestId !== undefined) {
        if (!Number.isSafeInteger(requestId) || !envelope || envelope.jsonrpc !== '2.0'
          || !Object.prototype.hasOwnProperty.call(envelope, 'id') || envelope.id !== requestId) {
          throw new Error('RET001D_MCP_CORRELATION_INVALID');
        }
      } else if (envelope !== undefined) {
        throw new Error('RET001D_MCP_CORRELATION_INVALID');
      }
      if (envelope?.error !== undefined) throw new Error('RET001D_MCP_RPC_ERROR');
      const pendingSession = response.headers.get('mcp-session-id');
      if (pendingSession) this.sessionId = pendingSession;
      return envelope;
    } catch (error) {
      if (controller.signal.aborted) throw new Error('RET001D_MCP_TIMEOUT');
      if (safeDiagnosticCode(error) !== 'RET001D_INTERNAL_FAILURE') throw error;
      throw new Error('RET001D_MCP_NETWORK');
    } finally {
      clearTimeout(timer);
    }
  }

  private async initialize(): Promise<void> {
    if (this.sessionId) return;
    const envelope = await this.request({
      jsonrpc: '2.0', id: this.nextId++, method: 'initialize', params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'memberry-retrieval-trace-live-conformance', version: '1.0.0' },
      },
    }, false);
    const result = envelope?.result as JsonRecord | undefined;
    if (!result || result.protocolVersion !== MCP_PROTOCOL_VERSION || !this.sessionId) {
      throw new Error('RET001D_MCP_INITIALIZE_INVALID');
    }
    await this.request({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  async call(tool: string, args: JsonRecord): Promise<unknown> {
    await this.initialize();
    const envelope = await this.request({
      jsonrpc: '2.0', id: this.nextId++, method: 'tools/call', params: { name: tool, arguments: args },
    });
    if (!envelope || !('result' in envelope)) throw new Error('RET001D_MCP_TOOL_RESPONSE_INVALID');
    return envelope.result;
  }
}

export interface ReadinessDependencies {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const READINESS_DEPS: ReadinessDependencies = {
  now: Date.now,
  sleep: (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
};

const INTERNAL_DIAGNOSTIC = 'RET001D_INTERNAL_FAILURE';
const MAX_DIAGNOSTIC_CODE_LENGTH = 192;

export const TRACE_INSPECTION_FIXED_CODES = Object.freeze([
  'RET001D_MCP_RESULT_INVALID',
  'RET001D_MCP_TOOL_FAILURE',
  'RET001D_MARKDOWN_INVALID',
  'RET001D_MARKDOWN_REQUEST_MISMATCH',
  'RET001D_SEEDED_RESULT_EMPTY',
  'RET001D_MARKDOWN_PROVENANCE_INVALID',
  'RET001D_MARKDOWN_RESULT_INVALID',
  'RET001D_MARKDOWN_RESULT_COUNT_MISMATCH',
  'RET001D_SEEDED_RESULT_MISSING',
  'RET001D_MARKDOWN_RESULT_ORDER_MISMATCH',
  'RET001D_NO_TRACE_BLOCK_COUNT',
  'RET001D_TRACE_TOO_LARGE',
  'RET001D_TRACE_JSON_INVALID',
  'RET001D_TRACE_CONFORMANCE_INVALID',
  'RET001D_TRACE_ALGORITHM_MISMATCH',
  'RET001D_TRACE_INCOMPLETE',
  'RET001D_TRACE_BOUNDS_INVALID',
  'RET001D_TRACE_NONCANONICAL',
  'RET001D_TRACE_FORBIDDEN_VALUE',
  'RET001D_TRACE_REPLAY_INVALID',
  'RET001D_TRACE_REPLAY_MISMATCH',
  'RET001D_TRACE_CHANNEL_SETTLEMENT_INVALID',
  'RET001D_TRACE_TERMINAL_COVERAGE_INVALID',
  'RET001D_MARKDOWN_TRACE_BINDING_INVALID',
  'RET001D_TRACE_BLOCK_COUNT',
] as const);

export const RET010D_CASE_IDS = Object.freeze([
  'authority-disabled-ranked',
  'authority-served-ranked',
  'authority-disabled-auto',
  'authority-served-auto',
  'authority-disabled-deterministic',
  'authority-served-deterministic',
] as const);

export type Ret010dCaseId = typeof RET010D_CASE_IDS[number];

export const RET010D_CASE_STAGES = Object.freeze([
  'ordinary-call',
  'ordinary-presentation',
  'ordinary-inspection',
  'false-call',
  'false-inspection',
  'traced-call',
  'traced-inspection',
  'presentation-parity',
  'reranker-stage-inspection',
] as const);

export type Ret010dCaseStage = typeof RET010D_CASE_STAGES[number];

const RET010D_CALL_FIXED_CAUSES = Object.freeze([
  'RET001D_HTTP_BODY_ABORTED',
  'RET001D_HTTP_BODY_READ_FAILED',
  'RET001D_HTTP_BODY_TOO_LARGE',
  'RET001D_MCP_CORRELATION_INVALID',
  'RET001D_MCP_ENVELOPE_INVALID',
  'RET001D_MCP_INITIALIZE_INVALID',
  'RET001D_MCP_NETWORK',
  'RET001D_MCP_RPC_ERROR',
  'RET001D_MCP_TIMEOUT',
  'RET001D_MCP_TOOL_RESPONSE_INVALID',
] as const);

const RET010D_PRESENTATION_FIXED_CAUSES = Object.freeze([
  'RET001D_MCP_RESULT_INVALID',
  'RET001D_MCP_TOOL_FAILURE',
  'RET001D_MARKDOWN_INVALID',
  'RET001D_MARKDOWN_REQUEST_MISMATCH',
  'RET001D_SEEDED_RESULT_EMPTY',
  'RET001D_MARKDOWN_PROVENANCE_INVALID',
  'RET001D_MARKDOWN_RESULT_INVALID',
  'RET001D_MARKDOWN_RESULT_COUNT_MISMATCH',
  'RET001D_SEEDED_RESULT_MISSING',
  'RET001D_MARKDOWN_RESULT_ORDER_MISMATCH',
  'RET001D_NO_TRACE_BLOCK_COUNT',
] as const);

const RET010D_TRACED_INSPECTION_FIXED_CAUSES = Object.freeze([
  ...TRACE_INSPECTION_FIXED_CODES,
  'RET010D_TRACE_BLOCK_COUNT',
] as const);

export const RET010D_STAGE_FIXED_CAUSES = Object.freeze({
  'ordinary-call': RET010D_CALL_FIXED_CAUSES,
  'ordinary-presentation': RET010D_PRESENTATION_FIXED_CAUSES,
  'ordinary-inspection': RET010D_PRESENTATION_FIXED_CAUSES,
  'false-call': RET010D_CALL_FIXED_CAUSES,
  'false-inspection': RET010D_PRESENTATION_FIXED_CAUSES,
  'traced-call': RET010D_CALL_FIXED_CAUSES,
  'traced-inspection': RET010D_TRACED_INSPECTION_FIXED_CAUSES,
  'presentation-parity': Object.freeze(['RET010D_PRESENTATION_PARITY_MISMATCH'] as const),
  'reranker-stage-inspection': Object.freeze([
    'RET001D_MCP_RESULT_INVALID',
    'RET001D_MCP_TOOL_FAILURE',
    'RET010D_TRACE_BLOCK_COUNT',
    'RET010D_TRACE_INVALID',
    'RET010D_RERANKER_STAGE_INVALID',
  ] as const),
} satisfies Record<Ret010dCaseStage, readonly string[]>);

const RET010D_CASE_DIAGNOSTIC = Object.freeze({
  'authority-disabled-ranked': 'AUTHORITY_DISABLED_RANKED',
  'authority-served-ranked': 'AUTHORITY_SERVED_RANKED',
  'authority-disabled-auto': 'AUTHORITY_DISABLED_AUTO',
  'authority-served-auto': 'AUTHORITY_SERVED_AUTO',
  'authority-disabled-deterministic': 'AUTHORITY_DISABLED_DETERMINISTIC',
  'authority-served-deterministic': 'AUTHORITY_SERVED_DETERMINISTIC',
} satisfies Record<Ret010dCaseId, string>);

const RET010D_STAGE_DIAGNOSTIC = Object.freeze({
  'ordinary-call': 'ORDINARY_CALL',
  'ordinary-presentation': 'ORDINARY_PRESENTATION',
  'ordinary-inspection': 'ORDINARY_INSPECTION',
  'false-call': 'FALSE_CALL',
  'false-inspection': 'FALSE_INSPECTION',
  'traced-call': 'TRACED_CALL',
  'traced-inspection': 'TRACED_INSPECTION',
  'presentation-parity': 'PRESENTATION_PARITY',
  'reranker-stage-inspection': 'RERANKER_STAGE_INSPECTION',
} satisfies Record<Ret010dCaseStage, string>);

const RET010D_CASE_STAGE_DIAGNOSTICS = new Set<string>();
for (const id of RET010D_CASE_IDS) {
  for (const stage of RET010D_CASE_STAGES) {
    const prefix = `RET010D_CASE_${RET010D_CASE_DIAGNOSTIC[id]}_STAGE_${RET010D_STAGE_DIAGNOSTIC[stage]}`;
    RET010D_CASE_STAGE_DIAGNOSTICS.add(`${prefix}_UNKNOWN`);
    for (const cause of RET010D_STAGE_FIXED_CAUSES[stage]) {
      RET010D_CASE_STAGE_DIAGNOSTICS.add(`${prefix}_${cause.slice('RET001D_'.length)}`);
    }
  }
}

type TraceInspectionFixedCode = typeof TRACE_INSPECTION_FIXED_CODES[number];
type RankedTracedInspectionByCause = {
  readonly [Code in TraceInspectionFixedCode]: Code extends `RET001D_${infer Subreason}`
    ? `RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_${Subreason}`
    : never;
};
type RankedTracedInspectionDiagnostic = RankedTracedInspectionByCause[TraceInspectionFixedCode]
  | 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_UNKNOWN'
  | typeof RANKED_TRACE_VALIDATION_BY_STAGE[RetrievalTraceValidationStage];

const RANKED_TRACED_INSPECTION_UNKNOWN = 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_UNKNOWN';
const TRACE_VALIDATION_PUBLIC_MESSAGE = 'Retrieval trace validation failed';
const RANKED_TRACE_VALIDATION_BY_STAGE = Object.freeze({
  IN_MEMORY_CONFORMANCE: 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_TRACE_VALIDATION_FAILED_IN_MEMORY_CONFORMANCE',
  IN_MEMORY_REPLAY: 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_TRACE_VALIDATION_FAILED_IN_MEMORY_REPLAY',
  CANONICALIZATION: 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_TRACE_VALIDATION_FAILED_CANONICALIZATION',
  EXPOSED_JSON_PARSE: 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_TRACE_VALIDATION_FAILED_EXPOSED_JSON_PARSE',
  EXPOSED_CONFORMANCE: 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_TRACE_VALIDATION_FAILED_EXPOSED_CONFORMANCE',
  EXPOSED_REPLAY: 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_TRACE_VALIDATION_FAILED_EXPOSED_REPLAY',
} as const satisfies Record<RetrievalTraceValidationStage, string>);
const RANKED_TRACED_INSPECTION_BY_CAUSE = Object.freeze({
  RET001D_MCP_RESULT_INVALID: 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_MCP_RESULT_INVALID',
  RET001D_MCP_TOOL_FAILURE: 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_MCP_TOOL_FAILURE',
  RET001D_MARKDOWN_INVALID: 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_MARKDOWN_INVALID',
  RET001D_MARKDOWN_REQUEST_MISMATCH: 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_MARKDOWN_REQUEST_MISMATCH',
  RET001D_SEEDED_RESULT_EMPTY: 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_SEEDED_RESULT_EMPTY',
  RET001D_MARKDOWN_PROVENANCE_INVALID: 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_MARKDOWN_PROVENANCE_INVALID',
  RET001D_MARKDOWN_RESULT_INVALID: 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_MARKDOWN_RESULT_INVALID',
  RET001D_MARKDOWN_RESULT_COUNT_MISMATCH: 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_MARKDOWN_RESULT_COUNT_MISMATCH',
  RET001D_SEEDED_RESULT_MISSING: 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_SEEDED_RESULT_MISSING',
  RET001D_MARKDOWN_RESULT_ORDER_MISMATCH: 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_MARKDOWN_RESULT_ORDER_MISMATCH',
  RET001D_NO_TRACE_BLOCK_COUNT: 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_NO_TRACE_BLOCK_COUNT',
  RET001D_TRACE_TOO_LARGE: 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_TRACE_TOO_LARGE',
  RET001D_TRACE_JSON_INVALID: 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_TRACE_JSON_INVALID',
  RET001D_TRACE_CONFORMANCE_INVALID: 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_TRACE_CONFORMANCE_INVALID',
  RET001D_TRACE_ALGORITHM_MISMATCH: 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_TRACE_ALGORITHM_MISMATCH',
  RET001D_TRACE_INCOMPLETE: 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_TRACE_INCOMPLETE',
  RET001D_TRACE_BOUNDS_INVALID: 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_TRACE_BOUNDS_INVALID',
  RET001D_TRACE_NONCANONICAL: 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_TRACE_NONCANONICAL',
  RET001D_TRACE_FORBIDDEN_VALUE: 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_TRACE_FORBIDDEN_VALUE',
  RET001D_TRACE_REPLAY_INVALID: 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_TRACE_REPLAY_INVALID',
  RET001D_TRACE_REPLAY_MISMATCH: 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_TRACE_REPLAY_MISMATCH',
  RET001D_TRACE_CHANNEL_SETTLEMENT_INVALID: 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_TRACE_CHANNEL_SETTLEMENT_INVALID',
  RET001D_TRACE_TERMINAL_COVERAGE_INVALID: 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_TRACE_TERMINAL_COVERAGE_INVALID',
  RET001D_MARKDOWN_TRACE_BINDING_INVALID: 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_MARKDOWN_TRACE_BINDING_INVALID',
  RET001D_TRACE_BLOCK_COUNT: 'RET001D_CASE_RANKED_STAGE_TRACED_INSPECTION_TRACE_BLOCK_COUNT',
} as const satisfies RankedTracedInspectionByCause);
const RANKED_TRACED_INSPECTION_DIAGNOSTICS = new Set<string>([
  RANKED_TRACED_INSPECTION_UNKNOWN,
  ...Object.values(RANKED_TRACE_VALIDATION_BY_STAGE),
  ...Object.values(RANKED_TRACED_INSPECTION_BY_CAUSE),
]);

const STATIC_DIAGNOSTIC_CODES = new Set([
  'RET001D_CASE_STAGE_DIAGNOSTIC_INVALID',
  'RET001D_CLEANUP_OR_CASE_COUNT_INVALID',
  'RET001D_COMPOSITION_ROOT_EXITED',
  'RET001D_COMPOSITION_ROOT_STOP_TIMEOUT',
  'RET001D_EVIDENCE_FAILED',
  'RET001D_EVIDENCE_WRITE_FAILED',
  'RET001D_EVIDENCE_WRITE_TIMEOUT',
  'RET001D_FALSE_PARITY_MISMATCH',
  'RET001D_GIT_DIRTY',
  'RET001D_GIT_STATE_FAILED',
  'RET001D_HTTP_BODY_ABORTED',
  'RET001D_HTTP_BODY_READ_FAILED',
  'RET001D_HTTP_BODY_TOO_LARGE',
  INTERNAL_DIAGNOSTIC,
  'RET001D_MANIFEST_FORBIDDEN_VALUE',
  'RET001D_MCP_CORRELATION_INVALID',
  'RET001D_MCP_ENVELOPE_INVALID',
  'RET001D_MCP_INITIALIZE_INVALID',
  'RET001D_MCP_NETWORK',
  'RET001D_MCP_RPC_ERROR',
  'RET001D_MCP_TIMEOUT',
  'RET001D_MCP_TOOL_RESPONSE_INVALID',
  'RET001D_NEO4J_CLEANUP_FAILED',
  'RET001D_NEO4J_CLOSE_FAILED',
  'RET001D_NEO4J_PREFLIGHT_FAILED',
  'RET001D_NEO4J_RESIDUAL_INVALID',
  'RET001D_NEO4J_RESIDUAL_QUERY_FAILED',
  'RET001D_NEO4J_SEED_FAILED',
  'RET001D_NEO4J_SEED_READBACK_CARDINALITY',
  'RET001D_NEO4J_SEED_READBACK_FAILED',
  'RET001D_NEO4J_SEED_READBACK_INVALID',
  'RET001D_NEO4J_SEED_READBACK_MISMATCH',
  'RET001D_NEO4J_SESSION_CLOSE_FAILED',
  'RET001D_NEO4J_VERSION_FAILED',
  'RET001D_NEO4J_VERSION_INVALID',
  'RET001D_READINESS_INVALID',
  'RET001D_READINESS_NETWORK',
  'RET001D_READINESS_TIMEOUT__RET001D_READINESS_NETWORK',
  'RET001D_READINESS_UNKNOWN',
  'RET001D_RANKED_MARKER_INVALID',
  'RET001D_REDIS_CLEANUP_FAILED',
  'RET001D_REDIS_KEY_BOUND',
  'RET001D_REDIS_OWNERSHIP_FAILED',
  'RET001D_REDIS_OWNERSHIP_INVALID',
  'RET001D_REDIS_PREFLIGHT_FAILED',
  'RET001D_REDIS_SCAN_FAILED',
  'RET001D_REDIS_VERSION_FAILED',
  'RET001D_REDIS_VERSION_INVALID',
  'RET001D_SEEDED_DIAGNOSTIC_BOUND',
  'RET001D_SEEDED_DIAGNOSTIC_INVALID',
  'RET001D_SEEDED_RESULT_MISSING',
  'RET001D_SERVICE_IDENTITY_MISSING',
  'RET001D_TEMP_CREATE_FAILED',
  'RET001D_TENANT_ISOLATION_FAILURE',
  'RET001D_TRACE_BLOCK_COUNT',
  'RET001D_TRACED_PARITY_MISMATCH',
  'RET010D_CASE_STAGE_DIAGNOSTIC_INVALID',
  'RET010D_CHILD_PROFILE_INVALID',
  'RET010D_DETERMINISTIC_BYPASS_MISMATCH',
  'RET010D_MANIFEST_KEYS',
  'RET010D_MANIFEST_SHAPE',
  'RET010D_MATCHED_CONTROL_UNCHANGED',
  'RET010D_NEO4J_SEED_FAILED',
  'RET010D_NEO4J_SESSION_CLOSE_FAILED',
]);

function validSeededCaseDiagnostic(match: RegExpMatchArray): boolean {
  const stage = match[2];
  const classification = match[3];
  if (classification === undefined) return true;
  if (stage !== 'ORDINARY_PRESENTATION') return false;
  const counts = match.slice(4, 9).map(Number);
  if (counts.length !== 5 || counts.some((count) => !Number.isSafeInteger(count) || count < 0 || count > 512)) {
    return false;
  }
  const [expectedCount, alternateCount, projectCount, otherCount, totalCount] = counts as [number, number, number, number, number];
  if (expectedCount + alternateCount + projectCount + otherCount !== totalCount) return false;
  const expectedClassification = expectedCount > 0
    ? 'EXPECTED'
    : alternateCount > 0
      ? 'ALTERNATE'
      : projectCount > 0
        ? 'PROJECT_ONLY'
        : 'NONE';
  return classification === expectedClassification;
}

function validDynamicDiagnostic(code: string): boolean {
  if (/^RET001D_MCP_HTTP_[1-5][0-9]{2}$/.test(code)) return true;
  if (RET010D_CASE_STAGE_DIAGNOSTICS.has(code)) return true;
  if (RANKED_TRACED_INSPECTION_DIAGNOSTICS.has(code)) return true;
  const match = code.match(
    /^RET001D_CASE_(DETERMINISTIC|RANKED|AUTO|NAMED_TENANT_FORCED_RANKED)_STAGE_(ORDINARY_CALL|ORDINARY_PRESENTATION|ORDINARY_INSPECTION|FALSE_CALL|FALSE_INSPECTION|TRACED_CALL|TRACED_INSPECTION|FALSE_PARITY|TRACED_PARITY|TENANT_ISOLATION)(?:_SEEDED_(EXPECTED|ALTERNATE|PROJECT_ONLY|NONE)_E(0|[1-9][0-9]{0,2})_A(0|[1-9][0-9]{0,2})_P(0|[1-9][0-9]{0,2})_O(0|[1-9][0-9]{0,2})_T(0|[1-9][0-9]{0,2}))?$/,
  );
  return match !== null && !(match[1] === 'RANKED' && match[2] === 'TRACED_INSPECTION')
    && validSeededCaseDiagnostic(match);
}

function safeNativeErrorMessage(error: unknown): string | undefined {
  try {
    if (typeof error !== 'object' || error === null || Array.isArray(error)
      || isProxy(error) || !isNativeError(error)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(error, 'message');
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string'
      || descriptor.get !== undefined || descriptor.set !== undefined
      || descriptor.value.length === 0 || descriptor.value.length > MAX_DIAGNOSTIC_CODE_LENGTH) {
      return undefined;
    }
    return descriptor.value;
  } catch {
    return undefined;
  }
}

export function safeDiagnosticCode(error: unknown): string {
  const code = safeNativeErrorMessage(error);
  return code !== undefined && (STATIC_DIAGNOSTIC_CODES.has(code) || validDynamicDiagnostic(code))
    ? code
    : INTERNAL_DIAGNOSTIC;
}

export async function runAbortableOperation<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  timeoutCode: string,
  failureCode: string,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const result = await operation(controller.signal);
    if (timedOut) throw new Error(timeoutCode);
    return result;
  } catch {
    throw new Error(timedOut ? timeoutCode : failureCode);
  } finally {
    clearTimeout(timer);
  }
}

function readinessErrorCode(error: unknown): string {
  const code = safeDiagnosticCode(error);
  return code === 'RET001D_INTERNAL_FAILURE' ? 'RET001D_READINESS_UNKNOWN' : code;
}

export async function waitForTraceReadiness<T>(
  probe: () => Promise<T>,
  timeoutMs: number,
  dependencies: ReadinessDependencies = READINESS_DEPS,
): Promise<T> {
  const deadline = dependencies.now() + timeoutMs;
  let last = 'RET001D_READINESS_NETWORK';
  while (dependencies.now() < deadline) {
    try { return await probe(); }
    catch (error) {
      const code = readinessErrorCode(error);
      if (code !== 'RET001D_READINESS_NETWORK') throw new Error(code);
      last = code;
      await dependencies.sleep(250);
    }
  }
  throw new Error(`RET001D_READINESS_TIMEOUT__${last}`);
}

const LOGICAL_MULTI_TENANT_LIMITATION =
  'shared logical multi-tenant consolidation and wiki publication are disabled to prevent cross-tenant disclosure';

function exactStringKeys(value: JsonRecord, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every((key) => typeof key === 'string' && keys.includes(key));
}

function expectedNamedDegradation(body: JsonRecord): boolean {
  if (!exactStringKeys(body, [
    'status', 'service', 'transport', 'active_sessions', 'registered_sessions',
    'auth_required', 'uptime_ms', 'consolidation_automation', 'admission_shadow',
    'retrieval_resolution', ...presentReadinessProbeKeys(body),
  ]) || !hasClosedReadinessProbeShapeV1(body)
    || body.status !== 'ready' || body.service !== 'memberry-mcp' || body.transport !== 'sse'
    || body.auth_required !== true || !Number.isSafeInteger(body.active_sessions)
    || !Number.isSafeInteger(body.registered_sessions) || body.active_sessions !== body.registered_sessions
    || typeof body.uptime_ms !== 'number' || !Number.isFinite(body.uptime_ms) || body.uptime_ms < 0
    || typeof body.admission_shadow !== 'object' || body.admission_shadow === null
    || Array.isArray(body.admission_shadow)
    || !hasClosedRetrievalResolutionStatusV1(body.retrieval_resolution)) return false;
  if (typeof body.consolidation_automation !== 'object' || body.consolidation_automation === null
    || Array.isArray(body.consolidation_automation)) return false;
  const automation = body.consolidation_automation as JsonRecord;
  if (!exactStringKeys(automation, ['enabled', 'unhealthy', 'degraded', 'limitations', 'workers'])
    || automation.enabled !== false || automation.unhealthy !== true || automation.degraded !== true
    || !Array.isArray(automation.limitations) || automation.limitations.length !== 1
    || typeof automation.limitations[0] !== 'string'
    || !automation.limitations[0].includes(LOGICAL_MULTI_TENANT_LIMITATION)
    || !Array.isArray(automation.workers) || automation.workers.length !== 1) return false;
  const worker = automation.workers[0];
  return typeof worker === 'object' && worker !== null && !Array.isArray(worker)
    && (worker as JsonRecord).name === 'default'
    && (worker as JsonRecord).enabled === false
    && (worker as JsonRecord).health === 'unhealthy'
    && typeof (worker as JsonRecord).limitation === 'string'
    && String((worker as JsonRecord).limitation).includes(LOGICAL_MULTI_TENANT_LIMITATION);
}

export function classifyTraceReadiness(
  status: number,
  body: unknown,
  mode: 'single-default' | 'named-tenant',
): { status: number; classification: 'ready' | 'expected-logical-multitenant-degraded' } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('RET001D_READINESS_INVALID');
  const record = body as JsonRecord;
  if (mode === 'single-default' && status === 200 && record.status === 'ready'
    && record.service === 'memberry-mcp' && record.auth_required === true) {
    return { status: 200, classification: 'ready' };
  }
  if (mode === 'named-tenant' && status === 503 && expectedNamedDegradation(record)) {
    return { status: 503, classification: 'expected-logical-multitenant-degraded' };
  }
  throw new Error('RET001D_READINESS_INVALID');
}

async function readiness(
  config: TraceConformanceConfig,
  token: string,
  mode: 'single-default' | 'named-tenant',
): Promise<{ status: number; classification: 'ready' | 'expected-logical-multitenant-degraded' }> {
  const signal = AbortSignal.timeout(config.requestTimeoutMs);
  let response: Response;
  try {
    response = await fetch(new URL('/readyz', config.mcpUrl), {
      headers: { authorization: `Bearer ${token}` }, signal,
    });
  } catch { throw new Error('RET001D_READINESS_NETWORK'); }
  let raw: string;
  try { raw = await readBoundedResponseText(response, 256 * 1024, signal); }
  catch { throw new Error(signal.aborted ? 'RET001D_READINESS_NETWORK' : 'RET001D_READINESS_INVALID'); }
  let body: JsonRecord;
  try { body = JSON.parse(raw) as JsonRecord; }
  catch { throw new Error('RET001D_READINESS_INVALID'); }
  return classifyTraceReadiness(response.status, body, mode);
}

export function compositionRootCommand(): { readonly executable: string; readonly args: readonly string[] } {
  return { executable: process.execPath, args: ['--import', 'tsx', 'packages/mcp/src/server.ts'] };
}

const MAX_TRACE_VALIDATION_DIAGNOSTIC_LINE_BYTES = 256;
const TRACE_VALIDATION_DIAGNOSTIC_WAIT_MS = 100;
const TRACE_VALIDATION_STAGE_BY_LINE = new Map<string, RetrievalTraceValidationStage>(
  Object.entries(RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_LINES)
    .map(([stage, line]) => [line, stage as RetrievalTraceValidationStage]),
);

/** A bounded line parser for the disposable child's diagnostic-only stderr.
 * Unknown bytes are discarded; the observable state contains only a closed
 * stage enum, or no stage when the stream repeats/conflicts. */
export class TraceValidationStderrParser {
  private line: number[] = [];
  private overlong = false;
  private captured: RetrievalTraceValidationStage | undefined;
  private conflicted = false;
  private generation = 0;
  private streamClosed = false;
  private terminal: { readonly kind: 'stage'; readonly stage: RetrievalTraceValidationStage }
    | { readonly kind: 'invalid' } | undefined;
  private readonly waiters = new Set<{
    readonly generation: number;
    readonly resolve: (stage: RetrievalTraceValidationStage | undefined) => void;
    readonly timer: ReturnType<typeof setTimeout>;
  }>();

  reset(): number {
    this.resolveWaiters(undefined);
    this.generation += 1;
    this.line = [];
    this.overlong = false;
    this.captured = undefined;
    this.conflicted = false;
    this.terminal = this.streamClosed ? { kind: 'invalid' } : undefined;
    return this.generation;
  }

  invalidate(): void {
    this.line = [];
    this.overlong = false;
    this.captured = undefined;
    this.conflicted = true;
    this.settle({ kind: 'invalid' });
  }

  push(chunk: Uint8Array | string, generation = this.generation): void {
    if (generation !== this.generation || this.terminal !== undefined || this.streamClosed) return;
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    for (const byte of bytes) {
      if (byte === 10) {
        if (!this.overlong) this.acceptLine();
        this.line = [];
        this.overlong = false;
      } else if (!this.overlong) {
        if (this.line.length >= MAX_TRACE_VALIDATION_DIAGNOSTIC_LINE_BYTES) {
          this.line = [];
          this.overlong = true;
        } else {
          this.line.push(byte);
        }
      }
    }
  }

  stage(): RetrievalTraceValidationStage | undefined {
    if (this.terminal?.kind === 'stage') return this.terminal.stage;
    return this.terminal !== undefined || this.conflicted ? undefined : this.captured;
  }

  waitForTerminal(generation: number): Promise<RetrievalTraceValidationStage | undefined> {
    if (generation !== this.generation) return Promise.resolve(undefined);
    if (this.terminal !== undefined) {
      return Promise.resolve(this.terminal.kind === 'stage' ? this.terminal.stage : undefined);
    }
    return new Promise((resolvePromise) => {
      const waiter = {
        generation,
        resolve: resolvePromise,
        timer: setTimeout(() => {
          if (generation === this.generation) {
            this.settle(this.captured !== undefined && !this.conflicted
              ? { kind: 'stage', stage: this.captured }
              : { kind: 'invalid' });
          } else {
            this.waiters.delete(waiter);
            resolvePromise(undefined);
          }
        }, TRACE_VALIDATION_DIAGNOSTIC_WAIT_MS),
      };
      this.waiters.add(waiter);
    });
  }

  end(generation = this.generation): void { this.closeStream(generation); }

  error(generation = this.generation): void { this.closeStream(generation); }

  close(generation = this.generation): void { this.closeStream(generation); }

  private closeStream(generation: number): void {
    if (generation !== this.generation) return;
    this.streamClosed = true;
    this.settle({ kind: 'invalid' });
  }

  private acceptLine(): void {
    if (this.line.at(-1) === 13) this.line.pop();
    const stage = TRACE_VALIDATION_STAGE_BY_LINE.get(String.fromCharCode(...this.line));
    if (stage === undefined) return;
    if (this.captured !== undefined || this.conflicted) {
      this.captured = undefined;
      this.conflicted = true;
      this.settle({ kind: 'invalid' });
      return;
    }
    this.captured = stage;
  }

  private settle(terminal: NonNullable<TraceValidationStderrParser['terminal']>): void {
    if (this.terminal !== undefined) return;
    this.terminal = terminal;
    this.resolveWaiters(terminal.kind === 'stage' ? terminal.stage : undefined);
  }

  private resolveWaiters(stage: RetrievalTraceValidationStage | undefined): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(stage);
    }
    this.waiters.clear();
  }
}

export function childEnvironment(
  config: TraceConformanceConfig,
  mode: 'single-default' | 'named-tenant',
  exportPath: string,
  runtimeProfile: Ret010dRuntimeProfile = 'legacy',
): NodeJS.ProcessEnv {
  if (runtimeProfile !== 'legacy' && runtimeProfile !== 'disabled' && runtimeProfile !== 'served') {
    throw new Error('RET010D_CHILD_PROFILE_INVALID');
  }
  const inherited = Object.fromEntries(
    ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'PATHEXT', 'COMSPEC']
      .flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]]),
  );
  return {
    ...inherited,
    NODE_ENV: 'test',
    PORT: String(config.port),
    MCP_PORT: String(config.port),
    MEMBERRY_HOST: config.host,
    REDIS_URL: config.redisUrl,
    NEO4J_URI: config.neo4jUri,
    NEO4J_USER: config.neo4jUser,
    NEO4J_PASSWORD: config.neo4jPassword,
    ...(mode === 'single-default'
      ? { MEMBERRY_API_TOKEN: config.defaultToken }
      : { MEMBERRY_TENANT_TOKENS: `${NAMED_TENANT}:${config.namedToken}` }),
    MEMBERRY_EXPORT_PATH: exportPath,
    MEMBERRY_CONSOLIDATION_ENABLED: 'false',
    MEMBERRY_WIKI_AUTOREFRESH: 'false',
    ...(runtimeProfile === 'legacy' ? {} : {
      MEMBERRY_QUERY_PLANNER_V1: '1',
      MEMBERRY_CANDIDATE_CHANNEL_V1: '1',
      MEMBERRY_RERANKER_V1: runtimeProfile,
    }),
    [RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_ENV]: RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_ENABLED,
    OPENAI_API_KEY: '',
  };
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolvePromise(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
    if (child.exitCode !== null) finish(true);
  });
}

async function stopChild(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  const exited = await waitForChildExit(child, timeoutMs);
  if (exited) return;
  child.kill('SIGKILL');
  const killed = await waitForChildExit(child, 5_000);
  if (!killed) throw new Error('RET001D_COMPOSITION_ROOT_STOP_TIMEOUT');
}

class CompositionRoot {
  private readonly child: ChildProcess;
  private readonly traceValidationDiagnostics = new TraceValidationStderrParser();
  private stderrDataListener: ((chunk: Buffer) => void) | undefined;

  constructor(
    private readonly config: TraceConformanceConfig,
    private readonly mode: 'single-default' | 'named-tenant',
    exportPath: string,
    runtimeProfile: Ret010dRuntimeProfile = 'legacy',
  ) {
    const command = compositionRootCommand();
    this.child = spawn(command.executable, command.args, {
      cwd: process.cwd(), env: childEnvironment(config, mode, exportPath, runtimeProfile),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    if (this.child.stderr === null) {
      this.traceValidationDiagnostics.invalidate();
    } else {
      this.stderrDataListener = (chunk: Buffer) => this.traceValidationDiagnostics.push(chunk, 0);
      this.child.stderr.on('data', this.stderrDataListener);
      this.child.stderr.on('error', () => this.traceValidationDiagnostics.error());
      this.child.stderr.on('end', () => this.traceValidationDiagnostics.end());
      this.child.stderr.on('close', () => this.traceValidationDiagnostics.close());
    }
  }

  async waitUntilReady(): Promise<{ status: number; classification: 'ready' | 'expected-logical-multitenant-degraded' }> {
    const token = this.mode === 'single-default' ? this.config.defaultToken : this.config.namedToken;
    try {
      const evidence = await waitForTraceReadiness(async () => {
        if (this.child.exitCode !== null) throw new Error('RET001D_COMPOSITION_ROOT_EXITED');
        return readiness(this.config, token, this.mode);
      }, this.config.startupTimeoutMs);
      const probe = new TraceMcpTransport(this.config, token);
      await probe.call('berry_tools', { action: 'list' });
      return evidence;
    } catch (error) {
      throw new Error(readinessErrorCode(error));
    }
  }

  resetTraceValidationDiagnostic(): number {
    const generation = this.traceValidationDiagnostics.reset();
    if (this.child.stderr !== null && this.stderrDataListener !== undefined) {
      this.child.stderr.removeListener('data', this.stderrDataListener);
      this.stderrDataListener = (chunk: Buffer) => this.traceValidationDiagnostics.push(chunk, generation);
      this.child.stderr.on('data', this.stderrDataListener);
    }
    return generation;
  }

  traceValidationDiagnosticStage(generation: number): Promise<RetrievalTraceValidationStage | undefined> {
    return this.traceValidationDiagnostics.waitForTerminal(generation);
  }

  stop(): Promise<void> { return stopChild(this.child); }
}

interface FixtureIdentity {
  readonly run: string;
  readonly defaultProject: string;
  readonly defaultTarget: string;
  readonly namedProject: string;
  readonly namedTarget: string;
  readonly defaultRankedMarker: string;
  readonly namedRankedMarker: string;
  readonly defaultContent: string;
  readonly namedContent: string;
  readonly decoyContent: string;
}

interface Ret010dFixtureIdentity {
  readonly projectName: string;
  readonly projectScope: string;
  readonly target: string;
  readonly query: string;
  readonly baselineId: string;
  readonly lexicalId: string;
  readonly foreignTenantId: string;
  readonly foreignProjectId: string;
  readonly futureId: string;
  readonly foreignTenantContent: string;
  readonly foreignProjectContent: string;
  readonly futureContent: string;
}

interface SeedReadbackFixture {
  readonly run: string;
  readonly defaultProject: string;
  readonly defaultTarget: string;
  readonly namedProject: string;
  readonly namedTarget: string;
  readonly defaultRankedMarker: string;
  readonly namedRankedMarker: string;
}

export interface VerifiedSeedTarget {
  readonly projectId: string;
  readonly projectName: string;
  readonly projectTenant: 'default' | typeof NAMED_TENANT;
  readonly targetId: string;
  readonly targetName: string;
  readonly targetTenant: 'default' | typeof NAMED_TENANT;
  readonly targetResponsibility: string;
}

export interface VerifiedSeedReadback {
  readonly run: string;
  readonly default: VerifiedSeedTarget;
  readonly named: VerifiedSeedTarget;
}

const MIN_LIVE_RUN_TIMESTAMP_LENGTH = 1;
const MAX_LIVE_RUN_TIMESTAMP_LENGTH = 11;
const LIVE_RUN_NONCE_HEX_LENGTH = 12;
const RANKED_MARKER_PREFIX_LENGTH = 8;
const MAX_RANKED_MARKER_LENGTH = RANKED_MARKER_PREFIX_LENGTH
  + MAX_LIVE_RUN_TIMESTAMP_LENGTH + LIVE_RUN_NONCE_HEX_LENGTH;
const CANONICAL_LIVE_RUN_PATTERN = new RegExp(
  `^(?:0|[1-9a-z][0-9a-z]{${MIN_LIVE_RUN_TIMESTAMP_LENGTH - 1},${MAX_LIVE_RUN_TIMESTAMP_LENGTH - 1}})`
  + `-[0-9a-f]{${LIVE_RUN_NONCE_HEX_LENGTH}}$`,
);

function rankedMarkerInvalid(): never {
  throw new Error('RET001D_RANKED_MARKER_INVALID');
}

function validRankedMarker(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_RANKED_MARKER_LENGTH
    && /^[a-z0-9]+$/.test(value);
}

export function rankedFixtureMarkers(run: string): Readonly<{ default: string; named: string }> {
  if (typeof run !== 'string' || !CANONICAL_LIVE_RUN_PATTERN.test(run)) return rankedMarkerInvalid();
  const compact = run.replaceAll('-', '');
  const markers = { default: `ret001dd${compact}`, named: `ret001dn${compact}` };
  if (!validRankedMarker(markers.default) || !validRankedMarker(markers.named)
    || markers.default === markers.named) return rankedMarkerInvalid();
  return Object.freeze(markers);
}

interface TraceFixtureQueryIdentity {
  readonly defaultTarget: string;
  readonly namedTarget: string;
  readonly defaultRankedMarker: string;
  readonly namedRankedMarker: string;
}

export function traceFixtureQueries(fixture: TraceFixtureQueryIdentity): Readonly<{
  deterministic: string;
  ranked: string;
  auto: string;
  named: string;
}> {
  if (!validRankedMarker(fixture.defaultRankedMarker) || !validRankedMarker(fixture.namedRankedMarker)
    || fixture.defaultRankedMarker === fixture.namedRankedMarker
    || typeof fixture.defaultTarget !== 'string' || fixture.defaultTarget.length === 0
    || typeof fixture.namedTarget !== 'string' || fixture.namedTarget.length === 0) return rankedMarkerInvalid();
  return Object.freeze({
    deterministic: fixture.defaultTarget,
    ranked: fixture.defaultRankedMarker,
    auto: `what depends on ${fixture.defaultTarget}`,
    named: fixture.namedRankedMarker,
  });
}

export function traceFixtureForbiddenValues(
  secrets: readonly string[],
  fixture: Pick<FixtureIdentity,
    'defaultContent' | 'namedContent' | 'decoyContent' | 'defaultRankedMarker' | 'namedRankedMarker'>,
  queries: Readonly<Record<string, string>>,
): readonly string[] {
  return Object.freeze([...new Set([
    ...secrets,
    fixture.defaultContent, fixture.namedContent, fixture.decoyContent,
    fixture.defaultRankedMarker, fixture.namedRankedMarker,
    ...Object.values(queries),
  ])]);
}

export function tenantIsolationForbiddenValues(
  scope: 'default' | 'named-tenant',
  fixture: Pick<FixtureIdentity,
    'run' | 'defaultContent' | 'namedContent' | 'decoyContent' | 'defaultRankedMarker' | 'namedRankedMarker'>,
): readonly string[] {
  const decoy = [`ret001d-decoy-${fixture.run}`, fixture.decoyContent];
  if (scope === 'default') {
    return Object.freeze([
      `ret001d-np-${fixture.run}`, `ret001d-nt-${fixture.run}`, `ret001d-ns-${fixture.run}`,
      `ret001d-named-project-${fixture.run}`, `ret001d-named-target-${fixture.run}`,
      fixture.namedContent, fixture.namedRankedMarker, ...decoy,
    ]);
  }
  return Object.freeze([
    `ret001d-dp-${fixture.run}`, `ret001d-dt-${fixture.run}`, `ret001d-dd-${fixture.run}`,
    `ret001d-da-${fixture.run}`, `ret001d-ds-${fixture.run}`,
    `ret001d-default-project-${fixture.run}`, `ret001d-default-target-${fixture.run}`,
    `ret001d-dependency-${fixture.run}`, fixture.defaultContent, fixture.defaultRankedMarker, ...decoy,
  ]);
}

async function neo4jRun(
  session: Session,
  query: string,
  params: Record<string, unknown>,
  timeoutMs: number,
  failureCode: string,
): Promise<QueryResult> {
  try {
    return await session.run(query, params, { timeout: timeoutMs });
  } catch {
    throw new Error(failureCode);
  }
}

async function seedFixtures(driver: Driver, fixture: FixtureIdentity, timeoutMs: number): Promise<void> {
  const session = driver.session();
  try {
    await neo4jRun(session,
      `CREATE (dp:Entity {id:$dpid, name:$defaultProject, type:'project', category:'project', tenant_id:'default', ret001d_run:$run, created_at:$now})
       CREATE (dt:Entity {id:$dtid, name:$defaultTarget, type:'service', category:'service', tenant_id:'default', ret001d_run:$run, responsibility:$defaultRankedMarker, created_at:$now})
       CREATE (dd:Entity {id:$ddid, name:$defaultDependency, type:'module', category:'module', tenant_id:'default', ret001d_run:$run, interface_desc:'synthetic interface', created_at:$now})
       CREATE (da:Aspect {id:$daid, name:'ret001d-safety', stability_tier:'protocol', description:'synthetic trace aspect', ret001d_run:$run})
       CREATE (ds:Semantic {id:$dsid, content:$defaultContent, confidence:0.91, signal_count:1, created_at:$now, updated_at:$now, decay_class:'stable', memory_type:'architecture', tags:[$defaultScope], scope:$defaultScope, tenant_id:'default', ret001d_run:$run})
       CREATE (dp)-[:CONTAINS {ret001d_run:$run}]->(dt)
       CREATE (dt)-[:USES {ret001d_run:$run}]->(dd)
       CREATE (da)-[:APPLIES_TO {ret001d_run:$run}]->(dt)
       CREATE (ds)-[:ABOUT {ret001d_run:$run}]->(dt)
       CREATE (np:Entity {id:$npid, name:$namedProject, type:'project', category:'project', tenant_id:$namedTenant, ret001d_run:$run, created_at:$now})
       CREATE (nt:Entity {id:$ntid, name:$namedTarget, type:'service', category:'service', tenant_id:$namedTenant, ret001d_run:$run, responsibility:$namedRankedMarker, created_at:$now})
       CREATE (ns:Semantic {id:$nsid, content:$namedContent, confidence:0.89, signal_count:1, created_at:$now, updated_at:$now, decay_class:'stable', memory_type:'architecture', tags:[$namedScope], scope:$namedScope, tenant_id:$namedTenant, ret001d_run:$run})
       CREATE (np)-[:CONTAINS {ret001d_run:$run}]->(nt)
       CREATE (ns)-[:ABOUT {ret001d_run:$run}]->(nt)
       CREATE (:Semantic {id:$decoyId, content:$decoyContent, confidence:0.99, signal_count:9, created_at:$now, updated_at:$now, decay_class:'stable', memory_type:'architecture', tags:['project:ret001d-decoy'], scope:'project:ret001d-decoy', tenant_id:'ret001d-decoy', ret001d_run:$run})`,
      {
        run: fixture.run, now: new Date().toISOString(), namedTenant: NAMED_TENANT,
        dpid: `ret001d-dp-${fixture.run}`, dtid: `ret001d-dt-${fixture.run}`, ddid: `ret001d-dd-${fixture.run}`,
        daid: `ret001d-da-${fixture.run}`, dsid: `ret001d-ds-${fixture.run}`,
        npid: `ret001d-np-${fixture.run}`, ntid: `ret001d-nt-${fixture.run}`, nsid: `ret001d-ns-${fixture.run}`,
        decoyId: `ret001d-decoy-${fixture.run}`,
        defaultProject: fixture.defaultProject, defaultTarget: fixture.defaultTarget,
        defaultRankedMarker: fixture.defaultRankedMarker,
        defaultDependency: `ret001d-dependency-${fixture.run}`, defaultScope: `project:${fixture.defaultProject}`,
        namedProject: fixture.namedProject, namedTarget: fixture.namedTarget, namedScope: `project:${fixture.namedProject}`,
        namedRankedMarker: fixture.namedRankedMarker,
        defaultContent: fixture.defaultContent, namedContent: fixture.namedContent, decoyContent: fixture.decoyContent,
      }, timeoutMs, 'RET001D_NEO4J_SEED_FAILED');
  } finally {
    await session.close().catch(() => { throw new Error('RET001D_NEO4J_SESSION_CLOSE_FAILED'); });
  }
}

async function seedRet010dFixtures(
  driver: Driver,
  run: string,
  fixture: Ret010dFixtureIdentity,
  timeoutMs: number,
): Promise<void> {
  const session = driver.session();
  try {
    await neo4jRun(session,
      `CREATE (p:Entity {id:$projectId, name:$project, type:'project', category:'project', tenant_id:'default', ret001d_run:$run, created_at:$now})
       CREATE (e:Entity {id:$targetId, name:$target, type:'service', category:'service', aliases:[$target], tenant_id:'default', ret001d_run:$run, created_at:$now})
       CREATE (p)-[:CONTAINS {ret001d_run:$run}]->(e)
       CREATE (baseline:Semantic {id:$baselineId, content:'stable baseline memory', confidence:0.99, signal_count:9, created_at:$now, updated_at:$now, decay_class:'stable', memory_type:'architecture', tags:[$scope], scope:$scope, tenant_id:'default', ret001d_run:$run})
       CREATE (lexical:Semantic {id:$lexicalId, content:$lexicalContent, confidence:0.01, signal_count:1, created_at:$now, updated_at:$now, decay_class:'stable', memory_type:'architecture', tags:[$scope], scope:$scope, tenant_id:'default', ret001d_run:$run})
       CREATE (baseline)-[:ABOUT {ret001d_run:$run, valid_at:'2026-01-01T00:00:00.000Z'}]->(e)
       CREATE (lexical)-[:ABOUT {ret001d_run:$run, valid_at:'2026-01-01T00:00:00.000Z'}]->(e)
       CREATE (foreignTenant:Semantic {id:$foreignTenantId, content:$foreignTenantContent, confidence:1.0, signal_count:9, created_at:$now, updated_at:$now, decay_class:'stable', memory_type:'architecture', tags:[$scope], scope:$scope, tenant_id:'ret010d-foreign', ret001d_run:$run})
       CREATE (foreignTenant)-[:ABOUT {ret001d_run:$run, valid_at:'2026-01-01T00:00:00.000Z'}]->(e)
       CREATE (future:Semantic {id:$futureId, content:$futureContent, confidence:1.0, signal_count:9, created_at:$now, updated_at:$now, decay_class:'stable', memory_type:'architecture', tags:[$scope], scope:$scope, tenant_id:'default', ret001d_run:$run})
       CREATE (future)-[:ABOUT {ret001d_run:$run, valid_at:'2099-01-01T00:00:00.000Z'}]->(e)
       CREATE (op:Entity {id:$foreignProjectEntityId, name:$foreignProjectName, type:'project', category:'project', tenant_id:'default', ret001d_run:$run, created_at:$now})
       CREATE (oe:Entity {id:$foreignProjectTargetId, name:$foreignProjectTarget, type:'service', category:'service', tenant_id:'default', ret001d_run:$run, created_at:$now})
       CREATE (op)-[:CONTAINS {ret001d_run:$run}]->(oe)
       CREATE (foreignProject:Semantic {id:$foreignProjectId, content:$foreignProjectContent, confidence:1.0, signal_count:9, created_at:$now, updated_at:$now, decay_class:'stable', memory_type:'architecture', tags:[$foreignScope], scope:$foreignScope, tenant_id:'default', ret001d_run:$run})
       CREATE (foreignProject)-[:ABOUT {ret001d_run:$run, valid_at:'2026-01-01T00:00:00.000Z'}]->(oe)`,
      {
        run, now: new Date().toISOString(), projectId: `ret010d-project-${run}`, project: fixture.projectName,
        targetId: `ret010d-target-${run}`, target: fixture.target, scope: fixture.projectScope,
        baselineId: fixture.baselineId, lexicalId: fixture.lexicalId,
        lexicalContent: fixture.query,
        foreignTenantId: fixture.foreignTenantId, foreignTenantContent: fixture.foreignTenantContent,
        futureId: fixture.futureId, futureContent: fixture.futureContent,
        foreignProjectEntityId: `ret010d-foreign-project-entity-${run}`,
        foreignProjectName: `ret010d-foreign-project-${run}`,
        foreignProjectTargetId: `ret010d-foreign-target-entity-${run}`,
        foreignProjectTarget: `ret010d-foreign-target-${run}`,
        foreignProjectId: fixture.foreignProjectId, foreignProjectContent: fixture.foreignProjectContent,
        foreignScope: `project:ret010d-foreign-project-${run}`,
      }, timeoutMs, 'RET010D_NEO4J_SEED_FAILED');
  } finally {
    await session.close().catch(() => { throw new Error('RET010D_NEO4J_SESSION_CLOSE_FAILED'); });
  }
}

interface SeedReadbackRecord { get(key: string): unknown }

function seedReadbackInvalid(): never {
  throw new Error('RET001D_NEO4J_SEED_READBACK_INVALID');
}

function seedReadbackMethod(record: unknown): (key: string) => unknown {
  try {
    if (typeof record !== 'object' || record === null || Array.isArray(record) || isProxy(record)) {
      return seedReadbackInvalid();
    }
    const own = Object.getOwnPropertyDescriptor(record, 'get');
    const prototype = own ? undefined : Object.getPrototypeOf(record);
    if (!own && (typeof prototype !== 'object' || prototype === null || isProxy(prototype))) {
      return seedReadbackInvalid();
    }
    const descriptor = own ?? Object.getOwnPropertyDescriptor(prototype!, 'get');
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function'
      || descriptor.get !== undefined || descriptor.set !== undefined) return seedReadbackInvalid();
    return descriptor.value as (key: string) => unknown;
  } catch {
    return seedReadbackInvalid();
  }
}

function seedReadbackString(
  record: SeedReadbackRecord,
  method: (key: string) => unknown,
  key: string,
): string {
  let value: unknown;
  try { value = method.call(record, key); }
  catch { return seedReadbackInvalid(); }
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new Error('RET001D_NEO4J_SEED_READBACK_MISMATCH');
  }
  return value;
}

function seedReadbackFixture(fixture: SeedReadbackFixture): SeedReadbackFixture {
  const keys = [
    'run', 'defaultProject', 'defaultTarget', 'namedProject', 'namedTarget',
    'defaultRankedMarker', 'namedRankedMarker',
  ] as const;
  let values: SeedReadbackFixture;
  try {
    if (typeof fixture !== 'object' || fixture === null || Array.isArray(fixture) || isProxy(fixture)) {
      return seedReadbackInvalid();
    }
    values = Object.fromEntries(keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(fixture, key);
      if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string'
        || descriptor.value.length === 0 || descriptor.value.length > 512) return seedReadbackInvalid();
      return [key, descriptor.value];
    })) as unknown as SeedReadbackFixture;
  } catch {
    return seedReadbackInvalid();
  }
  let derivedMarkers: Readonly<{ default: string; named: string }>;
  try { derivedMarkers = rankedFixtureMarkers(values.run); }
  catch { return seedReadbackInvalid(); }
  if (values.defaultRankedMarker === values.namedRankedMarker
    || values.defaultRankedMarker !== derivedMarkers.default
    || values.namedRankedMarker !== derivedMarkers.named) {
    throw new Error('RET001D_NEO4J_SEED_READBACK_MISMATCH');
  }
  return Object.freeze({
    ...values,
    defaultRankedMarker: derivedMarkers.default,
    namedRankedMarker: derivedMarkers.named,
  });
}

export function parseSeedReadback(
  records: readonly SeedReadbackRecord[],
  fixture: SeedReadbackFixture,
): VerifiedSeedReadback {
  let safeRecords: readonly SeedReadbackRecord[];
  try {
    if (!Array.isArray(records) || isProxy(records)) return seedReadbackInvalid();
    if (records.length !== 2) {
      throw new Error('RET001D_NEO4J_SEED_READBACK_CARDINALITY');
    }
    safeRecords = [0, 1].map((index) => {
      const descriptor = Object.getOwnPropertyDescriptor(records, String(index));
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return seedReadbackInvalid();
      return descriptor.value as SeedReadbackRecord;
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'RET001D_NEO4J_SEED_READBACK_CARDINALITY') throw error;
    return seedReadbackInvalid();
  }
  const truthFixture = seedReadbackFixture(fixture);
  const expectedMarkers = rankedFixtureMarkers(truthFixture.run);
  if (safeRecords.length !== 2) {
    throw new Error('RET001D_NEO4J_SEED_READBACK_CARDINALITY');
  }
  const parsed = safeRecords.map((record) => {
    const method = seedReadbackMethod(record);
    return Object.freeze({
      projectId: seedReadbackString(record, method, 'projectId'),
      projectName: seedReadbackString(record, method, 'projectName'),
      projectTenant: seedReadbackString(record, method, 'projectTenant'),
      targetId: seedReadbackString(record, method, 'targetId'),
      targetName: seedReadbackString(record, method, 'targetName'),
      targetTenant: seedReadbackString(record, method, 'targetTenant'),
      targetResponsibility: seedReadbackString(record, method, 'targetResponsibility'),
    });
  });
  const expected = [
    Object.freeze({
      projectId: `ret001d-dp-${truthFixture.run}`,
      projectName: truthFixture.defaultProject,
      projectTenant: 'default',
      targetId: `ret001d-dt-${truthFixture.run}`,
      targetName: truthFixture.defaultTarget,
      targetTenant: 'default',
      targetResponsibility: expectedMarkers.default,
    }),
    Object.freeze({
      projectId: `ret001d-np-${truthFixture.run}`,
      projectName: truthFixture.namedProject,
      projectTenant: NAMED_TENANT,
      targetId: `ret001d-nt-${truthFixture.run}`,
      targetName: truthFixture.namedTarget,
      targetTenant: NAMED_TENANT,
      targetResponsibility: expectedMarkers.named,
    }),
  ] as const;
  for (let index = 0; index < expected.length; index++) {
    const actual = parsed[index];
    const truth = expected[index];
    if (!actual || Object.keys(truth).some((key) => actual[key as keyof typeof actual] !== truth[key as keyof typeof truth])) {
      throw new Error('RET001D_NEO4J_SEED_READBACK_MISMATCH');
    }
  }
  return Object.freeze({
    run: truthFixture.run,
    default: parsed[0] as VerifiedSeedTarget,
    named: parsed[1] as VerifiedSeedTarget,
  });
}

async function readBackSeedFixtures(
  driver: Driver,
  fixture: SeedReadbackFixture,
  timeoutMs: number,
): Promise<VerifiedSeedReadback> {
  const session = driver.session();
  try {
    const result = await neo4jRun(session,
      `MATCH (project:Entity)-[contains:CONTAINS]->(target:Entity)
       WHERE project.ret001d_run = $run
         AND target.ret001d_run = $run
         AND contains.ret001d_run = $run
       RETURN project.id AS projectId,
              project.name AS projectName,
              project.tenant_id AS projectTenant,
              target.id AS targetId,
              target.name AS targetName,
              target.tenant_id AS targetTenant,
              target.responsibility AS targetResponsibility
       ORDER BY target.id
       LIMIT 3`,
      { run: fixture.run }, timeoutMs, 'RET001D_NEO4J_SEED_READBACK_FAILED');
    return parseSeedReadback(result.records, fixture);
  } finally {
    await session.close().catch(() => { throw new Error('RET001D_NEO4J_SESSION_CLOSE_FAILED'); });
  }
}

interface ResidualRecord { get(key: string): unknown }

function exactResidualNumber(value: unknown): number {
  let resolved = value;
  if (typeof value === 'object' && value !== null) {
    const method = (value as { toNumber?: unknown }).toNumber;
    if (typeof method !== 'function') throw new Error('RET001D_NEO4J_RESIDUAL_INVALID');
    resolved = method.call(value);
  }
  if (!Number.isSafeInteger(resolved) || Number(resolved) < 0) throw new Error('RET001D_NEO4J_RESIDUAL_INVALID');
  return Number(resolved);
}

export function parseResidualCounts(records: readonly ResidualRecord[]): { nodes: number; relationships: number } {
  if (records.length !== 1 || typeof records[0]?.get !== 'function') {
    throw new Error('RET001D_NEO4J_RESIDUAL_INVALID');
  }
  return {
    nodes: exactResidualNumber(records[0].get('nodes')),
    relationships: exactResidualNumber(records[0].get('relationships')),
  };
}

async function cleanupFixtures(
  driver: Driver,
  run: string,
  timeoutMs: number,
): Promise<{ nodes: number; relationships: number }> {
  const session = driver.session();
  try {
    await neo4jRun(session, 'MATCH (n {ret001d_run:$run}) DETACH DELETE n', { run },
      timeoutMs, 'RET001D_NEO4J_CLEANUP_FAILED');
    const result = await neo4jRun(session,
      `CALL {
         MATCH (n) WHERE n.ret001d_run = $run
         RETURN count(n) AS nodes
       }
       CALL {
         MATCH ()-[r]->() WHERE r.ret001d_run = $run
         RETURN count(r) AS relationships
       }
       RETURN nodes, relationships`,
      { run }, timeoutMs, 'RET001D_NEO4J_RESIDUAL_QUERY_FAILED');
    return parseResidualCounts(result.records);
  } finally {
    await session.close().catch(() => { throw new Error('RET001D_NEO4J_SESSION_CLOSE_FAILED'); });
  }
}

export async function scanRedisKeys(redis: Redis, timeoutMs: number): Promise<Set<string>> {
  void timeoutMs; // ioredis enforces the configured native commandTimeout.
  const keys = new Set<string>();
  let cursor = '0';
  let pages = 0;
  const seenNonterminalCursors = new Set<string>();
  do {
    pages++;
    if (pages > 4_096) throw new Error('RET001D_REDIS_KEY_BOUND');
    let scan: unknown;
    try { scan = await redis.scan(cursor, 'COUNT', 200); }
    catch { throw new Error('RET001D_REDIS_SCAN_FAILED'); }
    const { cursor: next, page } = parseRedisScanPage(scan);
    if (next !== '0' && seenNonterminalCursors.has(next)) throw new Error('RET001D_REDIS_SCAN_FAILED');
    if (next !== '0') seenNonterminalCursors.add(next);
    cursor = next;
    for (const key of page) {
      keys.add(key);
      if (keys.size > 4_096) throw new Error('RET001D_REDIS_KEY_BOUND');
    }
  } while (cursor !== '0');
  return keys;
}

function exactDenseDataArray(value: unknown, maximumLength: number): unknown[] | undefined {
  try {
    if (!Array.isArray(value) || isProxy(value)) return undefined;
    const length = Object.getOwnPropertyDescriptor(value, 'length');
    if (!length || !('value' in length) || !Number.isSafeInteger(length.value)
      || length.value < 0 || length.value > maximumLength || length.enumerable) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length.value + 1 || !keys.includes('length')) return undefined;
    const items: unknown[] = [];
    for (let index = 0; index < length.value; index++) {
      const key = String(index);
      if (!keys.includes(key)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || descriptor.get !== undefined
        || descriptor.set !== undefined || !descriptor.enumerable) return undefined;
      items.push(descriptor.value);
    }
    return items;
  } catch {
    return undefined;
  }
}

export function parseRedisScanPage(value: unknown): { cursor: string; page: string[] } {
  const tuple = exactDenseDataArray(value, 2);
  if (!tuple || tuple.length !== 2 || typeof tuple[0] !== 'string'
    || !/^(?:0|[1-9]\d{0,19})$/.test(tuple[0])
    || BigInt(tuple[0]) > 18_446_744_073_709_551_615n) throw new Error('RET001D_REDIS_SCAN_FAILED');
  const rawPage = exactDenseDataArray(tuple[1], 4_096);
  if (!rawPage) throw new Error('RET001D_REDIS_SCAN_FAILED');
  const page: string[] = [];
  for (const key of rawPage) {
    if (typeof key !== 'string' || key.length === 0 || key.length > 1_024) {
      throw new Error('RET001D_REDIS_SCAN_FAILED');
    }
    page.push(key);
  }
  return { cursor: tuple[0], page };
}

export function parseRedisSingleton(value: unknown): string | undefined {
  const items = exactDenseDataArray(value, 1);
  if (!items || items.length !== 1 || typeof items[0] !== 'string'
    || items[0].length === 0 || items[0].length > 1_024) return undefined;
  return items[0];
}

interface RedisOwnedChannel {
  readonly contextPattern: RegExp;
  readonly expectedSource: string;
  readonly nodeKey: string;
  readonly scopeKey: string;
}

interface RedisOwnedProof {
  readonly contextKey: string;
  readonly nodeKey: string;
  readonly rawContext: string;
  readonly scopeKey: string;
}

interface RedisOwnedProofResult {
  readonly candidateContext?: string;
  readonly invalid: boolean;
  readonly proof?: RedisOwnedProof;
}

function redisOwnedChannels(run: string): readonly RedisOwnedChannel[] {
  return [
    {
      contextPattern: /^amp:ctx:[0-9a-f]{16}$/,
      expectedSource: `ret001d-ds-${run}`,
      nodeKey: `amp:deps:ret001d-ds-${run}`,
      scopeKey: `amp:scope-deps:project:ret001d-default-project-${run}`,
    },
    {
      contextPattern: /^amp:ctx:ret001d-named:[0-9a-f]{16}$/,
      expectedSource: `ret001d-ns-${run}`,
      nodeKey: `amp:deps:ret001d-named:ret001d-ns-${run}`,
      scopeKey: `amp:scope-deps:ret001d-named:project:ret001d-named-project-${run}`,
    },
  ];
}

function validRedisOwnershipToken(token: unknown): token is string {
  return typeof token === 'string' && /^[0-9a-f]{32}$/.test(token);
}

export async function setRedisOwnershipMarker(
  redis: Redis,
  before: ReadonlySet<string>,
  run: string,
  token: string,
): Promise<string> {
  if (typeof run !== 'string' || !CANONICAL_LIVE_RUN_PATTERN.test(run) || !validRedisOwnershipToken(token)) {
    throw new Error('RET001D_REDIS_OWNERSHIP_INVALID');
  }
  const marker = `memberry:lab:ret001d:${run}:ownership`;
  if (before.has(marker)
    || redisOwnedChannels(run).some(({ nodeKey, scopeKey }) => before.has(nodeKey) || before.has(scopeKey))) {
    throw new Error('RET001D_REDIS_OWNERSHIP_INVALID');
  }
  let result: unknown;
  try { result = await redis.set(marker, token, 'EX', 900, 'NX'); }
  catch { throw new Error('RET001D_REDIS_OWNERSHIP_FAILED'); }
  if (result !== 'OK') throw new Error('RET001D_REDIS_OWNERSHIP_INVALID');
  return marker;
}

function exactOwnedCache(raw: unknown, expectedSource: string): boolean {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 1_048_576) return false;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { return false; }
  const root = exactPlainDataRecord(parsed, ['markdown', 'tokens', 'sources', 'assembled_at']);
  if (!root) return false;
  const markdown = Object.getOwnPropertyDescriptor(root, 'markdown')!.value;
  const tokens = Object.getOwnPropertyDescriptor(root, 'tokens')!.value;
  const sources = Object.getOwnPropertyDescriptor(root, 'sources')!.value;
  const assembledAt = Object.getOwnPropertyDescriptor(root, 'assembled_at')!.value;
  const sourceItems = exactDenseDataArray(sources, 1);
  return typeof markdown === 'string' && markdown.length <= 1_048_576
    && Number.isSafeInteger(tokens) && tokens >= 0
    && typeof assembledAt === 'string' && assembledAt.length > 0 && assembledAt.length <= 128
    && sourceItems?.length === 1 && sourceItems[0] === expectedSource;
}

async function proveRedisChannel(
  redis: Redis,
  before: ReadonlySet<string>,
  created: ReadonlySet<string>,
  channel: RedisOwnedChannel,
): Promise<RedisOwnedProofResult> {
  const nodeCreated = created.has(channel.nodeKey);
  const scopeCreated = created.has(channel.scopeKey);
  if (before.has(channel.nodeKey) || before.has(channel.scopeKey)) return { invalid: true };
  if (!nodeCreated && !scopeCreated) return { invalid: false };
  if (!nodeCreated || !scopeCreated) return { invalid: true };

  let nodeMembers: unknown;
  let scopeMembers: unknown;
  try {
    nodeMembers = await redis.smembers(channel.nodeKey);
    scopeMembers = await redis.smembers(channel.scopeKey);
  } catch {
    return { invalid: true };
  }
  const nodeContext = parseRedisSingleton(nodeMembers);
  const scopeContext = parseRedisSingleton(scopeMembers);
  if (!nodeContext || nodeContext !== scopeContext) return { invalid: true };
  const contextKey = nodeContext;
  if (!channel.contextPattern.test(contextKey) || before.has(contextKey) || !created.has(contextKey)) {
    return { candidateContext: contextKey, invalid: true };
  }
  let cached: unknown;
  try { cached = await redis.get(contextKey); }
  catch { return { candidateContext: contextKey, invalid: true }; }
  if (typeof cached !== 'string' || !exactOwnedCache(cached, channel.expectedSource)) {
    return { candidateContext: contextKey, invalid: true };
  }
  return {
    candidateContext: contextKey,
    invalid: false,
    proof: { contextKey, nodeKey: channel.nodeKey, rawContext: cached, scopeKey: channel.scopeKey },
  };
}

const REDIS_OWNERSHIP_CAS = `
local key_count = #KEYS
if key_count < 1 or ((key_count - 1) % 3) ~= 0 then return -1 end
local proof_count = (key_count - 1) / 3
if #ARGV ~= 1 + proof_count then return -2 end
if key_count > 7 then return -14 end
for left = 1, key_count - 1 do
  for right = left + 1, key_count do
    if KEYS[left] == KEYS[right] then return -13 end
  end
end
if redis.call('TYPE', KEYS[1]).ok ~= 'string' then return -3 end
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -4 end
for proof = 0, proof_count - 1 do
  local context_index = 2 + (proof * 3)
  local node_index = context_index + 1
  local scope_index = context_index + 2
  local context_key = KEYS[context_index]
  if redis.call('TYPE', context_key).ok ~= 'string' then return -5 end
  if redis.call('TYPE', KEYS[node_index]).ok ~= 'set' then return -6 end
  if redis.call('TYPE', KEYS[scope_index]).ok ~= 'set' then return -7 end
  if redis.call('SCARD', KEYS[node_index]) ~= 1 then return -8 end
  if redis.call('SCARD', KEYS[scope_index]) ~= 1 then return -9 end
  local node_members = redis.call('SMEMBERS', KEYS[node_index])
  local scope_members = redis.call('SMEMBERS', KEYS[scope_index])
  if #node_members ~= 1 or node_members[1] ~= context_key then return -10 end
  if #scope_members ~= 1 or scope_members[1] ~= context_key then return -11 end
  if redis.call('GET', context_key) ~= ARGV[2 + proof] then return -12 end
end
return redis.call('DEL', unpack(KEYS))
`;

export async function cleanupOwnedRedisKeys(
  redis: Redis,
  before: ReadonlySet<string>,
  run: string,
  token: string,
  timeoutMs: number,
): Promise<{ ownedCreated: number; ownedRemaining: number; unexpectedNewKeys: number }> {
  if (typeof run !== 'string' || !CANONICAL_LIVE_RUN_PATTERN.test(run) || !validRedisOwnershipToken(token)) {
    throw new Error('RET001D_REDIS_OWNERSHIP_INVALID');
  }
  const residualBeforeCleanup = await scanRedisKeys(redis, timeoutMs);
  const created = new Set([...residualBeforeCleanup].filter((key) => !before.has(key)));
  const marker = `memberry:lab:ret001d:${run}:ownership`;
  if (before.has(marker)) throw new Error('RET001D_REDIS_OWNERSHIP_INVALID');
  let invalid = false;
  if (!created.has(marker)) invalid = true;

  const proofResults: RedisOwnedProofResult[] = [];
  for (const channel of redisOwnedChannels(run)) {
    const result = await proveRedisChannel(redis, before, created, channel);
    proofResults.push(result);
    if (result.invalid) invalid = true;
  }
  const candidates = proofResults.flatMap(({ candidateContext }) => candidateContext ? [candidateContext] : []);
  const duplicatedContexts = new Set(candidates.filter((value, index) => candidates.indexOf(value) !== index));
  if (duplicatedContexts.size > 0) {
    invalid = true;
  }
  const proofs = proofResults.flatMap(({ proof }) => (
    proof && !duplicatedContexts.has(proof.contextKey) ? [proof] : []
  ));
  const explicitKeys = [marker, ...proofs.flatMap(({ contextKey, nodeKey, scopeKey }) => (
    [contextKey, nodeKey, scopeKey]
  ))];
  if (explicitKeys.length > 7 || new Set(explicitKeys).size !== explicitKeys.length) {
    throw new Error('RET001D_REDIS_OWNERSHIP_INVALID');
  }

  let deleted: unknown;
  try {
    deleted = await redis.eval(
      REDIS_OWNERSHIP_CAS,
      explicitKeys.length,
      ...explicitKeys,
      token,
      ...proofs.map(({ rawContext }) => rawContext),
    );
  } catch {
    throw new Error('RET001D_REDIS_CLEANUP_FAILED');
  }
  if (typeof deleted !== 'number' || deleted !== explicitKeys.length) {
    throw new Error('RET001D_REDIS_OWNERSHIP_INVALID');
  }
  const residual = await scanRedisKeys(redis, timeoutMs);
  const owned = new Set(explicitKeys);
  const result = {
    ownedCreated: explicitKeys.length,
    ownedRemaining: [...owned].filter((key) => residual.has(key)).length,
    unexpectedNewKeys: [...residual].filter((key) => !before.has(key) && !owned.has(key)).length,
  };
  if (invalid) throw new Error('RET001D_REDIS_OWNERSHIP_INVALID');
  return result;
}

interface LiveCase {
  readonly id: 'deterministic' | 'ranked' | 'auto' | 'named-tenant-forced-ranked';
  readonly requestedStrategy: 'deterministic' | 'ranked' | 'auto';
  readonly expectedAlgorithm: RetrievalTraceAlgorithmVersion;
  readonly authScope: 'default' | 'named-tenant';
  readonly task: string;
  readonly projectName: string;
  readonly expectedStrategy: 'deterministic' | 'ranked';
  readonly requiredPresentationId: string;
}

export type LiveCaseStage =
  | 'ordinary-call'
  | 'ordinary-presentation'
  | 'ordinary-inspection'
  | 'false-call'
  | 'false-inspection'
  | 'traced-call'
  | 'traced-inspection'
  | 'false-parity'
  | 'traced-parity'
  | 'tenant-isolation';

const LIVE_CASE_DIAGNOSTIC = Object.freeze({
  deterministic: 'DETERMINISTIC',
  ranked: 'RANKED',
  auto: 'AUTO',
  'named-tenant-forced-ranked': 'NAMED_TENANT_FORCED_RANKED',
} satisfies Record<LiveCase['id'], string>);

const LIVE_STAGE_DIAGNOSTIC = Object.freeze({
  'ordinary-call': 'ORDINARY_CALL',
  'ordinary-presentation': 'ORDINARY_PRESENTATION',
  'ordinary-inspection': 'ORDINARY_INSPECTION',
  'false-call': 'FALSE_CALL',
  'false-inspection': 'FALSE_INSPECTION',
  'traced-call': 'TRACED_CALL',
  'traced-inspection': 'TRACED_INSPECTION',
  'false-parity': 'FALSE_PARITY',
  'traced-parity': 'TRACED_PARITY',
  'tenant-isolation': 'TENANT_ISOLATION',
} satisfies Record<LiveCaseStage, string>);

function rankedTracedInspectionDiagnosticCode(cause: unknown): RankedTracedInspectionDiagnostic {
  const innerCode = safeNativeErrorMessage(cause);
  if (innerCode === undefined
    || !Object.prototype.hasOwnProperty.call(RANKED_TRACED_INSPECTION_BY_CAUSE, innerCode)) {
    return RANKED_TRACED_INSPECTION_UNKNOWN;
  }
  return RANKED_TRACED_INSPECTION_BY_CAUSE[innerCode as TraceInspectionFixedCode];
}

function exactPlainDataRecord(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedKeys.length || keys.some((key) => typeof key !== 'string')
    || expectedKeys.some((key) => !keys.includes(key))) return undefined;
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || descriptor.get !== undefined
      || descriptor.set !== undefined || !descriptor.enumerable) return undefined;
  }
  return value as Record<string, unknown>;
}

function exactSingleDenseItem(value: unknown): unknown | undefined {
  if (!Array.isArray(value) || isProxy(value)) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes('0') || !keys.includes('length')) return undefined;
  const item = Object.getOwnPropertyDescriptor(value, '0');
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!item || !('value' in item) || item.get !== undefined || item.set !== undefined || !item.enumerable
    || !length || !('value' in length) || length.value !== 1 || length.enumerable) return undefined;
  return item.value;
}

type RankedTraceMcpEnvelope = 'non-error' | 'trace-validation-failed' | 'unknown-error';

function classifyRankedTraceMcpEnvelope(result: unknown): RankedTraceMcpEnvelope {
  try {
    const nonErrorRoot = exactPlainDataRecord(result, ['content']);
    if (nonErrorRoot) return 'non-error';
    const root = exactPlainDataRecord(result, ['content', 'isError']);
    if (!root) return 'unknown-error';
    const isError = Object.getOwnPropertyDescriptor(root, 'isError')!.value;
    if (isError === false) return 'non-error';
    if (isError !== true) return 'unknown-error';
    const content = Object.getOwnPropertyDescriptor(root, 'content')!.value;
    const rawItem = exactSingleDenseItem(content);
    if (rawItem === undefined) return 'unknown-error';
    const item = exactPlainDataRecord(rawItem, ['type', 'text']);
    if (!item) return 'unknown-error';
    const type = Object.getOwnPropertyDescriptor(item, 'type')!.value;
    const text = Object.getOwnPropertyDescriptor(item, 'text')!.value;
    if (type !== 'text' || text !== TRACE_VALIDATION_PUBLIC_MESSAGE) {
      return 'unknown-error';
    }
    return 'trace-validation-failed';
  } catch {
    return 'unknown-error';
  }
}

function rankedTraceValidationStageDiagnostic(traceValidationStage: unknown): RankedTracedInspectionDiagnostic {
  if (typeof traceValidationStage !== 'string'
    || !Object.prototype.hasOwnProperty.call(RANKED_TRACE_VALIDATION_BY_STAGE, traceValidationStage)) {
    return RANKED_TRACED_INSPECTION_UNKNOWN;
  }
  return RANKED_TRACE_VALIDATION_BY_STAGE[traceValidationStage as RetrievalTraceValidationStage];
}

export function rankedTraceMcpErrorDiagnostic(
  result: unknown,
  traceValidationStage?: unknown,
): RankedTracedInspectionDiagnostic | undefined {
  const envelope = classifyRankedTraceMcpEnvelope(result);
  if (envelope === 'non-error') return undefined;
  if (envelope === 'unknown-error') return RANKED_TRACED_INSPECTION_UNKNOWN;
  return rankedTraceValidationStageDiagnostic(traceValidationStage);
}

export async function rankedTraceMcpErrorDiagnosticAfterCapture(
  result: unknown,
  awaitTerminal: () => Promise<unknown>,
): Promise<RankedTracedInspectionDiagnostic | undefined> {
  const envelope = classifyRankedTraceMcpEnvelope(result);
  if (envelope === 'non-error') return undefined;
  if (envelope === 'unknown-error') return RANKED_TRACED_INSPECTION_UNKNOWN;
  try {
    return rankedTraceValidationStageDiagnostic(await awaitTerminal());
  } catch {
    return RANKED_TRACED_INSPECTION_UNKNOWN;
  }
}

export function caseStageDiagnosticCode(
  id: LiveCase['id'],
  stage: LiveCaseStage,
  cause?: unknown,
): string {
  void cause;
  if (typeof id !== 'string' || typeof stage !== 'string'
    || !Object.prototype.hasOwnProperty.call(LIVE_CASE_DIAGNOSTIC, id)
    || !Object.prototype.hasOwnProperty.call(LIVE_STAGE_DIAGNOSTIC, stage)) {
    throw new Error('RET001D_CASE_STAGE_DIAGNOSTIC_INVALID');
  }
  if (id === 'ranked' && stage === 'traced-inspection') {
    return rankedTracedInspectionDiagnosticCode(cause);
  }
  return `RET001D_CASE_${LIVE_CASE_DIAGNOSTIC[id]}_STAGE_${LIVE_STAGE_DIAGNOSTIC[stage]}`;
}

async function atCaseStage<T>(
  id: LiveCase['id'],
  stage: LiveCaseStage,
  operation: () => T | Promise<T>,
): Promise<T> {
  try { return await operation(); }
  catch (error) { throw new Error(caseStageDiagnosticCode(id, stage, error)); }
}

export interface SeededPresentationClassification {
  readonly classification: 'expected' | 'alternate' | 'project-only' | 'none';
  readonly expectedCount: number;
  readonly alternateCount: number;
  readonly projectCount: number;
  readonly otherCount: number;
  readonly totalCount: number;
}

function presentationIdentityTruth(
  id: LiveCase['id'],
  readback: VerifiedSeedReadback,
): { expected: string; alternate: string; projects: readonly string[] } {
  const target = id === 'named-tenant-forced-ranked' ? readback.named : readback.default;
  const rankedPresentation = target.targetId;
  const deterministicPresentation = `target-${target.targetName}`;
  const expected = id === 'deterministic' || id === 'auto' ? deterministicPresentation : rankedPresentation;
  return Object.freeze({
    expected,
    alternate: expected === rankedPresentation ? deterministicPresentation : rankedPresentation,
    projects: Object.freeze([target.projectId, `target-${target.projectName}`]),
  });
}

export function classifySeededPresentation(
  id: LiveCase['id'],
  readback: VerifiedSeedReadback,
  resultIds: readonly string[],
): SeededPresentationClassification {
  if (resultIds.length > 512 || resultIds.some((value) => typeof value !== 'string' || value.length === 0 || value.length > 512)) {
    throw new Error('RET001D_SEEDED_DIAGNOSTIC_BOUND');
  }
  const truth = presentationIdentityTruth(id, readback);
  const expectedCount = resultIds.filter((value) => value === truth.expected).length;
  const alternateCount = resultIds.filter((value) => value === truth.alternate).length;
  const projectCount = resultIds.filter((value) => truth.projects.includes(value)).length;
  const otherCount = resultIds.length - expectedCount - alternateCount - projectCount;
  const classification = expectedCount > 0
    ? 'expected'
    : alternateCount > 0
      ? 'alternate'
      : projectCount > 0
        ? 'project-only'
        : 'none';
  return Object.freeze({
    classification, expectedCount, alternateCount, projectCount, otherCount, totalCount: resultIds.length,
  });
}

function diagnosticResultIds(result: unknown): readonly string[] {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new Error('RET001D_SEEDED_DIAGNOSTIC_BOUND');
  }
  const content = (result as JsonRecord).content;
  if (!Array.isArray(content) || content.length !== 1) throw new Error('RET001D_SEEDED_DIAGNOSTIC_BOUND');
  const part = content[0];
  if (typeof part !== 'object' || part === null || Array.isArray(part)
    || typeof (part as JsonRecord).text !== 'string') throw new Error('RET001D_SEEDED_DIAGNOSTIC_BOUND');
  const resultIds = [...((part as JsonRecord).text as string).matchAll(/^<!-- ([^<>\r\n]+?)(?: — .*)? -->$/gm)]
    .map((match) => match[1]!.trim());
  if (resultIds.length > 512 || resultIds.some((value) => value.length === 0 || value.length > 512)) {
    throw new Error('RET001D_SEEDED_DIAGNOSTIC_BOUND');
  }
  return Object.freeze(resultIds);
}

export function seededMissingDiagnosticCode(
  id: LiveCase['id'],
  observed: SeededPresentationClassification,
): string {
  const prefix = caseStageDiagnosticCode(id, 'ordinary-presentation');
  const expectedKeys = [
    'classification', 'expectedCount', 'alternateCount', 'projectCount', 'otherCount', 'totalCount',
  ] as const;
  let values: Record<(typeof expectedKeys)[number], unknown>;
  try {
    if (typeof observed !== 'object' || observed === null || Array.isArray(observed) || isProxy(observed)) {
      throw new Error('invalid');
    }
    const prototype = Object.getPrototypeOf(observed);
    if (prototype !== Object.prototype && prototype !== null) throw new Error('invalid');
    const keys = Reflect.ownKeys(observed);
    if (keys.length !== expectedKeys.length
      || keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key as typeof expectedKeys[number]))) {
      throw new Error('invalid');
    }
    values = Object.fromEntries(expectedKeys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(observed, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable
        || descriptor.get !== undefined || descriptor.set !== undefined) throw new Error('invalid');
      return [key, descriptor.value];
    })) as Record<(typeof expectedKeys)[number], unknown>;
  } catch {
    throw new Error('RET001D_SEEDED_DIAGNOSTIC_INVALID');
  }
  const classifications = ['expected', 'alternate', 'project-only', 'none'] as const;
  if (!classifications.includes(values.classification as typeof classifications[number])) {
    throw new Error('RET001D_SEEDED_DIAGNOSTIC_INVALID');
  }
  const counts = expectedKeys.slice(1).map((key) => values[key]);
  if (counts.some((count) => !Number.isSafeInteger(count) || Number(count) < 0 || Number(count) > 512)) {
    throw new Error('RET001D_SEEDED_DIAGNOSTIC_INVALID');
  }
  const expectedCount = Number(values.expectedCount);
  const alternateCount = Number(values.alternateCount);
  const projectCount = Number(values.projectCount);
  const otherCount = Number(values.otherCount);
  const totalCount = Number(values.totalCount);
  if (expectedCount + alternateCount + projectCount + otherCount !== totalCount) {
    throw new Error('RET001D_SEEDED_DIAGNOSTIC_INVALID');
  }
  const consistentClassification = expectedCount > 0
    ? 'expected'
    : alternateCount > 0
      ? 'alternate'
      : projectCount > 0
        ? 'project-only'
        : 'none';
  if (values.classification !== consistentClassification) {
    throw new Error('RET001D_SEEDED_DIAGNOSTIC_INVALID');
  }
  const classification = consistentClassification.replace('-', '_').toUpperCase();
  return `${prefix}_SEEDED_${classification}`
    + `_E${expectedCount}_A${alternateCount}_P${projectCount}`
    + `_O${otherCount}_T${totalCount}`;
}

export function requiredPresentationIdForCase(
  id: LiveCase['id'],
  readback: VerifiedSeedReadback,
): string {
  return presentationIdentityTruth(id, readback).expected;
}

async function executeCase(
  transport: TraceMcpTransport,
  compositionRoot: CompositionRoot,
  liveCase: LiveCase,
  readback: VerifiedSeedReadback,
  forbidden: readonly string[],
  isolationForbidden: readonly string[],
): Promise<JsonRecord> {
  const baseArgs = {
    task: liveCase.task,
    strategy: liveCase.requestedStrategy,
    include_code: false,
    include_arch: true,
    include_memory: true,
    max_tokens: 4_000,
    project_name: liveCase.projectName,
  };
  const ordinaryResult = await atCaseStage(liveCase.id, 'ordinary-call',
    () => transport.call('berry_context', baseArgs));
  let expectedResultIds: readonly string[];
  try {
    expectedResultIds = observeOrderedMarkdownResultIds(ordinaryResult, {
      expectedTask: liveCase.task,
      expectedStrategy: liveCase.expectedStrategy,
      requiredResultIds: [liveCase.requiredPresentationId],
    });
  } catch (error) {
    if (safeDiagnosticCode(error) === 'RET001D_SEEDED_RESULT_MISSING') {
      const observed = classifySeededPresentation(liveCase.id, readback, diagnosticResultIds(ordinaryResult));
      throw new Error(seededMissingDiagnosticCode(liveCase.id, observed));
    }
    throw new Error(caseStageDiagnosticCode(liveCase.id, 'ordinary-presentation', error));
  }
  const responseExpectation = {
    expectedTask: liveCase.task,
    expectedStrategy: liveCase.expectedStrategy,
    expectedResultIds,
  } as const;
  const omitted = await atCaseStage(liveCase.id, 'ordinary-inspection', () => inspectTraceToolResult(ordinaryResult, {
    mode: 'omitted', ...responseExpectation,
  }));
  const explicitFalseResult = await atCaseStage(liveCase.id, 'false-call',
    () => transport.call('berry_context', { ...baseArgs, include_trace: false }));
  const explicitFalse = await atCaseStage(liveCase.id, 'false-inspection', () => inspectTraceToolResult(explicitFalseResult, {
    mode: 'false', ...responseExpectation,
  }));
  const traceValidationGeneration = compositionRoot.resetTraceValidationDiagnostic();
  const tracedResult = await atCaseStage(liveCase.id, 'traced-call',
    () => transport.call('berry_context', { ...baseArgs, include_trace: true }));
  if (liveCase.id === 'ranked') {
    const mcpErrorDiagnostic = await rankedTraceMcpErrorDiagnosticAfterCapture(
      tracedResult,
      () => compositionRoot.traceValidationDiagnosticStage(traceValidationGeneration),
    );
    if (mcpErrorDiagnostic !== undefined) throw new Error(mcpErrorDiagnostic);
  }
  const traced = await atCaseStage(liveCase.id, 'traced-inspection', () => {
    const inspected = inspectTraceToolResult(tracedResult, {
      mode: 'true', expectedAlgorithm: liveCase.expectedAlgorithm, forbiddenValues: forbidden, ...responseExpectation,
    });
    if (!('trace' in inspected)) throw new Error('RET001D_TRACE_BLOCK_COUNT');
    return inspected;
  });
  await atCaseStage(liveCase.id, 'false-parity', () => {
    if (omitted.markdown !== explicitFalse.markdown) throw new Error('RET001D_FALSE_PARITY_MISMATCH');
  });
  await atCaseStage(liveCase.id, 'traced-parity', () => {
    if (omitted.markdown !== traced.markdown) throw new Error('RET001D_TRACED_PARITY_MISMATCH');
  });
  await atCaseStage(liveCase.id, 'tenant-isolation', () => {
    if (isolationForbidden.some((value) => traced.markdown.includes(value))) {
      throw new Error('RET001D_TENANT_ISOLATION_FAILURE');
    }
  });
  const summary: TraceInspectionSummary = traced.trace;
  return {
    id: liveCase.id,
    requestedStrategy: liveCase.requestedStrategy,
    actualAlgorithm: summary.algorithmVersion,
    authScope: liveCase.authScope,
    contentBlocks: { omitted: 1, false: 1, traced: 2 },
    parity: { falseEqualsOmitted: true, tracedMarkdownEqualsOrdinary: true },
    trace: summary,
  };
}

const RET010D_LIVE_CASES = Object.freeze({
  'authority-disabled-ranked': ['disabled', 'ranked', 'ranked-v1'],
  'authority-served-ranked': ['served', 'ranked', 'ranked-v2'],
  'authority-disabled-auto': ['disabled', 'auto', 'ranked-v1'],
  'authority-served-auto': ['served', 'auto', 'ranked-v2'],
  'authority-disabled-deterministic': ['disabled', 'deterministic', 'ranked-v1'],
  'authority-served-deterministic': ['served', 'deterministic', 'ranked-v1'],
} as const satisfies Record<
  Ret010dCaseId,
  readonly [
    Exclude<Ret010dRuntimeProfile, 'legacy'>,
    'ranked' | 'auto' | 'deterministic',
    RetrievalTraceAlgorithmVersion,
  ]
>);

export function ret010dCaseStageDiagnosticCode(
  id: Ret010dCaseId,
  stage: Ret010dCaseStage,
  cause?: unknown,
): string {
  if (typeof id !== 'string' || typeof stage !== 'string'
    || !Object.prototype.hasOwnProperty.call(RET010D_CASE_DIAGNOSTIC, id)
    || !Object.prototype.hasOwnProperty.call(RET010D_STAGE_DIAGNOSTIC, stage)) {
    throw new Error('RET010D_CASE_STAGE_DIAGNOSTIC_INVALID');
  }
  const prefix = `RET010D_CASE_${RET010D_CASE_DIAGNOSTIC[id]}_STAGE_${RET010D_STAGE_DIAGNOSTIC[stage]}`;
  const innerCode = safeNativeErrorMessage(cause);
  if (innerCode === undefined
    || !(RET010D_STAGE_FIXED_CAUSES[stage] as readonly string[]).includes(innerCode)) {
    return `${prefix}_UNKNOWN`;
  }
  return `${prefix}_${innerCode.slice('RET001D_'.length)}`;
}

async function atRet010dCaseStage<T>(
  id: Ret010dCaseId,
  stage: Ret010dCaseStage,
  operation: () => T | Promise<T>,
): Promise<T> {
  try { return await operation(); }
  catch (error) { throw new Error(ret010dCaseStageDiagnosticCode(id, stage, error)); }
}

interface Ret010dExecutedCase {
  readonly manifest: JsonRecord;
  readonly markdown: string;
  readonly presentationOrderDigest: string;
}

async function executeRet010dCase(
  transport: TraceMcpTransport,
  id: Ret010dCaseId,
  fixture: Ret010dFixtureIdentity,
  forbidden: readonly string[],
): Promise<Ret010dExecutedCase> {
  const [runtimeProfile, requestedStrategy, expectedAlgorithm] = RET010D_LIVE_CASES[id];
  const servedAttempt = expectedAlgorithm === 'ranked-v2';
  const requiredId = servedAttempt ? fixture.lexicalId : fixture.baselineId;
  const baseArgs = {
    task: fixture.query,
    strategy: requestedStrategy,
    as_of: '2026-08-01T00:00:00.000Z',
    include_code: false,
    include_arch: false,
    include_memory: true,
    max_tokens: 6,
    project_name: fixture.projectScope,
    entity_scope: [fixture.target],
  };
  const ordinaryResult = await atRet010dCaseStage(id, 'ordinary-call',
    () => transport.call('berry_context', baseArgs));
  const resultIds = await atRet010dCaseStage(id, 'ordinary-presentation',
    () => observeOrderedMarkdownResultIds(ordinaryResult, {
      expectedTask: fixture.query,
      expectedStrategy: 'ranked',
      requiredResultIds: [requiredId],
    }));
  const expectation = {
    expectedTask: fixture.query,
    expectedStrategy: 'ranked' as const,
    expectedResultIds: resultIds,
  };
  const omitted = await atRet010dCaseStage(id, 'ordinary-inspection',
    () => inspectTraceToolResult(ordinaryResult, { mode: 'omitted', ...expectation }));
  const explicitFalseResult = await atRet010dCaseStage(id, 'false-call',
    () => transport.call('berry_context', { ...baseArgs, include_trace: false }));
  const explicitFalse = await atRet010dCaseStage(id, 'false-inspection',
    () => inspectTraceToolResult(explicitFalseResult, { mode: 'false', ...expectation }));
  const tracedResult = await atRet010dCaseStage(id, 'traced-call',
    () => transport.call('berry_context', { ...baseArgs, include_trace: true }));
  const traced = await atRet010dCaseStage(id, 'traced-inspection', () => {
    const inspected = inspectTraceToolResult(tracedResult, {
      mode: 'true', expectedAlgorithm, forbiddenValues: forbidden, ...expectation,
    });
    if (!('trace' in inspected)) throw new Error('RET010D_TRACE_BLOCK_COUNT');
    return inspected;
  });
  await atRet010dCaseStage(id, 'presentation-parity', () => {
    if (omitted.markdown !== explicitFalse.markdown || omitted.markdown !== traced.markdown) {
      throw new Error('RET010D_PRESENTATION_PARITY_MISMATCH');
    }
  });
  const rerankerStage = await atRet010dCaseStage(id, 'reranker-stage-inspection',
    () => inspectRet010dRerankerStage(
      tracedResult,
      servedAttempt ? 'reranked' : 'absent',
    ));
  const presentationOrderDigest = `sha256:${createHash('sha256')
    .update(JSON.stringify(resultIds)).digest('hex')}`;
  return Object.freeze({
    markdown: omitted.markdown,
    presentationOrderDigest,
    manifest: {
      id,
      runtimeProfile,
      requestedStrategy,
      actualAlgorithm: traced.trace.algorithmVersion,
      contentBlocks: { omitted: 1, false: 1, traced: 2 },
      parity: { falseEqualsOmitted: true, tracedMarkdownEqualsOrdinary: true },
      presentationCount: resultIds.length,
      presentationOrderDigest,
      rerankerStage,
      trace: traced.trace,
    },
  });
}

async function gitState(timeoutMs: number): Promise<{ sha: string; dirty: false }> {
  const [{ stdout: sha }, { stdout: status }] = await Promise.all([
    execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), timeout: timeoutMs }),
    execFileAsync('git', ['status', '--porcelain'], { cwd: process.cwd(), timeout: timeoutMs }),
  ]);
  if (status.trim().length > 0) throw new Error('RET001D_GIT_DIRTY');
  return { sha: sha.trim(), dirty: false };
}

async function observeRedisVersion(redis: Redis): Promise<string> {
  let info: string;
  try { info = await redis.info('server'); }
  catch { throw new Error('RET001D_REDIS_VERSION_FAILED'); }
  const matches = [...info.matchAll(/^redis_version:([^\r\n]+)$/gm)];
  if (matches.length !== 1 || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(matches[0]![1]!)) {
    throw new Error('RET001D_REDIS_VERSION_INVALID');
  }
  return matches[0]![1]!;
}

async function observeNeo4jVersion(driver: Driver, timeoutMs: number): Promise<string> {
  const session = driver.session();
  try {
    const result = await neo4jRun(session,
      `CALL dbms.components() YIELD name, versions WHERE name = 'Neo4j Kernel' RETURN versions`,
      {}, timeoutMs, 'RET001D_NEO4J_VERSION_FAILED');
    if (result.records.length !== 1) throw new Error('RET001D_NEO4J_VERSION_INVALID');
    const versions = result.records[0]!.get('versions');
    if (!Array.isArray(versions) || versions.length !== 1 || typeof versions[0] !== 'string'
      || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(versions[0])) {
      throw new Error('RET001D_NEO4J_VERSION_INVALID');
    }
    return versions[0];
  } finally {
    await session.close().catch(() => { throw new Error('RET001D_NEO4J_SESSION_CLOSE_FAILED'); });
  }
}

export async function runTraceLiveConformanceEvidence(config: TraceConformanceConfig): Promise<JsonRecord> {
  const run = `${Date.now().toString(36)}-${randomUUID().replaceAll('-', '').slice(0, 12)}`.toLowerCase();
  const redisOwnershipToken = randomUUID().replaceAll('-', '').toLowerCase();
  const rankedMarkers = rankedFixtureMarkers(run);
  const fixture: FixtureIdentity = {
    run,
    defaultProject: `ret001d-default-project-${run}`,
    defaultTarget: `ret001d-default-target-${run}`,
    namedProject: `ret001d-named-project-${run}`,
    namedTarget: `ret001d-named-target-${run}`,
    defaultRankedMarker: rankedMarkers.default,
    namedRankedMarker: rankedMarkers.named,
    defaultContent: `RET001D ${run} default synthetic semantic content`,
    namedContent: `RET001D ${run} named synthetic semantic content`,
    decoyContent: `RET001D ${run} cross-tenant decoy must never appear`,
  };
  const ret010dFixture: Ret010dFixtureIdentity = {
    projectName: `ret010d-project-${run}`,
    projectScope: `project:ret010d-project-${run}`,
    target: `ret010d-target-${run}`,
    query: 'cobalt',
    baselineId: `ret010d-baseline-${run}`,
    lexicalId: `ret010d-lexical-${run}`,
    foreignTenantId: `ret010d-foreign-tenant-${run}`,
    foreignProjectId: `ret010d-foreign-project-memory-${run}`,
    futureId: `ret010d-future-${run}`,
    foreignTenantContent: `RET010D ${run} foreign tenant sentinel`,
    foreignProjectContent: `RET010D ${run} foreign project sentinel`,
    futureContent: `RET010D ${run} future sentinel`,
  };
  const queries = traceFixtureQueries(fixture);
  const forbidden = traceFixtureForbiddenValues(
    [config.defaultToken, config.namedToken, config.neo4jPassword], fixture, queries,
  );
  const allForbidden = Object.freeze([...new Set([...forbidden,
    run,
    ret010dFixture.projectName, ret010dFixture.projectScope,
    ret010dFixture.target, ret010dFixture.query,
    ret010dFixture.baselineId, ret010dFixture.lexicalId,
    'stable baseline memory',
    ret010dFixture.foreignTenantId, ret010dFixture.foreignProjectId, ret010dFixture.futureId,
    ret010dFixture.foreignTenantContent, ret010dFixture.foreignProjectContent, ret010dFixture.futureContent,
    'ret010d-foreign',
    `ret010d-project-${run}`, `ret010d-target-${run}`,
    `ret010d-foreign-project-entity-${run}`, `ret010d-foreign-project-${run}`,
    `ret010d-foreign-target-entity-${run}`, `ret010d-foreign-target-${run}`,
    `project:ret010d-foreign-project-${run}`,
  ])]);
  let driver: Driver | undefined;
  let redis: Redis | undefined;
  let tempPath: string | undefined;
  let redisBefore = new Set<string>();
  let redisSnapshotEstablished = false;
  let redisMarkerClaimed = false;
  let active: CompositionRoot | undefined;
  let childProcessesStopped = false;
  let tempRemoved = false;
  let graphResidual = { nodes: -1, relationships: -1 };
  let redisResidual = { ownedCreated: -1, ownedRemaining: -1, unexpectedNewKeys: -1 };
  let executionError: Error | undefined;
  let observedServices: JsonRecord | undefined;
  const cases: JsonRecord[] = [];
  const ret010dCases: JsonRecord[] = [];
  const readinessEvidence: Array<{ mode: string; status: number; classification: string }> = [];

  try {
    try { tempPath = await mkdtemp(resolve(tmpdir(), 'memberry-ret001d-')); }
    catch { throw new Error('RET001D_TEMP_CREATE_FAILED'); }
    const exportPath = resolve(tempPath, 'export');
    driver = createNeo4jDriver(config.neo4jUri, config.neo4jUser, config.neo4jPassword);
    redis = createRedisClient(config.redisUrl, {
      connectTimeout: config.requestTimeoutMs,
      commandTimeout: config.requestTimeoutMs,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    // The shared wrapper logs only when it is the sole error listener. This second,
    // content-free listener keeps infrastructure errors out of evidence artifacts.
    redis.on('error', () => undefined);
    redisBefore = await scanRedisKeys(redis, config.requestTimeoutMs);
    redisSnapshotEstablished = true;
    try { await driver.getServerInfo(); }
    catch { throw new Error('RET001D_NEO4J_PREFLIGHT_FAILED'); }
    try { await redis.ping(); }
    catch { throw new Error('RET001D_REDIS_PREFLIGHT_FAILED'); }
    observedServices = {
      redis: {
        containerId: config.redisContainerId,
        imageId: config.redisImageId,
        version: await observeRedisVersion(redis),
      },
      neo4j: {
        containerId: config.neo4jContainerId,
        imageId: config.neo4jImageId,
        version: await observeNeo4jVersion(driver, config.requestTimeoutMs),
      },
    };
    await setRedisOwnershipMarker(redis, redisBefore, run, redisOwnershipToken);
    redisMarkerClaimed = true;
    await seedFixtures(driver, fixture, config.requestTimeoutMs);
    const seedReadback = await readBackSeedFixtures(driver, fixture, config.requestTimeoutMs);
    active = new CompositionRoot(config, 'single-default', exportPath);
    readinessEvidence.push({ mode: 'single-default', ...await active.waitUntilReady() });
    const defaultTransport = new TraceMcpTransport(config, config.defaultToken);
    const defaultIsolation = tenantIsolationForbiddenValues('default', fixture);
    cases.push(await executeCase(defaultTransport, active, {
      id: 'deterministic', requestedStrategy: 'deterministic', expectedAlgorithm: 'deterministic-v2',
      authScope: 'default', task: queries.deterministic, projectName: fixture.defaultProject,
      expectedStrategy: 'deterministic',
      requiredPresentationId: requiredPresentationIdForCase('deterministic', seedReadback),
    }, seedReadback, [...forbidden, ...defaultIsolation], defaultIsolation));
    cases.push(await executeCase(defaultTransport, active, {
      id: 'ranked', requestedStrategy: 'ranked', expectedAlgorithm: 'ranked-v1',
      authScope: 'default', task: queries.ranked, projectName: fixture.defaultProject,
      expectedStrategy: 'ranked', requiredPresentationId: requiredPresentationIdForCase('ranked', seedReadback),
    }, seedReadback, [...forbidden, ...defaultIsolation], defaultIsolation));
    cases.push(await executeCase(defaultTransport, active, {
      id: 'auto', requestedStrategy: 'auto', expectedAlgorithm: 'deterministic-v2',
      authScope: 'default', task: queries.auto, projectName: fixture.defaultProject,
      expectedStrategy: 'deterministic', requiredPresentationId: requiredPresentationIdForCase('auto', seedReadback),
    }, seedReadback, [...forbidden, ...defaultIsolation], defaultIsolation));
    await active.stop();
    active = undefined;

    active = new CompositionRoot(config, 'named-tenant', exportPath);
    readinessEvidence.push({ mode: 'named-tenant', ...await active.waitUntilReady() });
    const namedTransport = new TraceMcpTransport(config, config.namedToken);
    const namedIsolation = tenantIsolationForbiddenValues('named-tenant', fixture);
    cases.push(await executeCase(namedTransport, active, {
      id: 'named-tenant-forced-ranked', requestedStrategy: 'deterministic', expectedAlgorithm: 'ranked-v1',
      authScope: 'named-tenant', task: queries.named, projectName: fixture.namedProject,
      expectedStrategy: 'ranked',
      requiredPresentationId: requiredPresentationIdForCase('named-tenant-forced-ranked', seedReadback),
    }, seedReadback, [...forbidden, ...namedIsolation], namedIsolation));
    await active.stop();
    active = undefined;

    await seedRet010dFixtures(driver, run, ret010dFixture, config.requestTimeoutMs);
    active = new CompositionRoot(config, 'single-default', exportPath, 'disabled');
    await active.waitUntilReady();
    const disabledTransport = new TraceMcpTransport(config, config.defaultToken);
    const disabledRanked = await executeRet010dCase(
      disabledTransport, 'authority-disabled-ranked', ret010dFixture, allForbidden,
    );
    const disabledAuto = await executeRet010dCase(
      disabledTransport, 'authority-disabled-auto', ret010dFixture, allForbidden,
    );
    const disabledDeterministic = await executeRet010dCase(
      disabledTransport, 'authority-disabled-deterministic', ret010dFixture, allForbidden,
    );
    ret010dCases.push(disabledRanked.manifest, disabledAuto.manifest, disabledDeterministic.manifest);
    await active.stop();
    active = undefined;

    active = new CompositionRoot(config, 'single-default', exportPath, 'served');
    await active.waitUntilReady();
    const servedTransport = new TraceMcpTransport(config, config.defaultToken);
    const servedRanked = await executeRet010dCase(
      servedTransport, 'authority-served-ranked', ret010dFixture, allForbidden,
    );
    const servedAuto = await executeRet010dCase(
      servedTransport, 'authority-served-auto', ret010dFixture, allForbidden,
    );
    const servedDeterministic = await executeRet010dCase(
      servedTransport, 'authority-served-deterministic', ret010dFixture, allForbidden,
    );
    ret010dCases.push(servedRanked.manifest, servedAuto.manifest, servedDeterministic.manifest);
    if (disabledRanked.presentationOrderDigest === servedRanked.presentationOrderDigest
      || disabledAuto.presentationOrderDigest === servedAuto.presentationOrderDigest) {
      throw new Error('RET010D_MATCHED_CONTROL_UNCHANGED');
    }
    if (disabledDeterministic.presentationOrderDigest !== servedDeterministic.presentationOrderDigest
      || disabledDeterministic.markdown !== servedDeterministic.markdown) {
      throw new Error('RET010D_DETERMINISTIC_BYPASS_MISMATCH');
    }
    await active.stop();
    active = undefined;
    childProcessesStopped = true;
  } catch (error) {
    executionError = new Error(safeDiagnosticCode(error));
  } finally {
    const cleanupErrors: Error[] = [];
    try { if (active) await active.stop(); childProcessesStopped = true; }
    catch (error) { cleanupErrors.push(new Error(safeDiagnosticCode(error))); }
    try {
      if (driver) graphResidual = await cleanupFixtures(driver, run, config.requestTimeoutMs);
    } catch (error) { cleanupErrors.push(new Error(safeDiagnosticCode(error))); }
    try {
      if (redis && redisSnapshotEstablished && redisMarkerClaimed) {
        redisResidual = await cleanupOwnedRedisKeys(
          redis, redisBefore, run, redisOwnershipToken, config.requestTimeoutMs,
        );
      }
    } catch (error) { cleanupErrors.push(new Error(safeDiagnosticCode(error))); }
    try {
      if (driver) await driver.close().catch(() => { throw new Error('RET001D_NEO4J_CLOSE_FAILED'); });
    } catch (error) { cleanupErrors.push(new Error(safeDiagnosticCode(error))); }
    try {
      if (redis) redis.disconnect();
    } catch (error) { cleanupErrors.push(new Error(safeDiagnosticCode(error))); }
    try {
      if (tempPath) {
        await rm(tempPath, { recursive: true, force: true });
      }
      tempRemoved = true;
    } catch (error) { cleanupErrors.push(new Error(safeDiagnosticCode(error))); }
    if (cleanupErrors.length) {
      const errors = [...(executionError ? [executionError] : []), ...cleanupErrors];
      throw new AggregateError(errors, 'RET001D_EVIDENCE_FAILED');
    }
  }

  if (executionError) throw executionError;
  if (cases.length !== 4 || ret010dCases.length !== 6
    || graphResidual.nodes !== 0 || graphResidual.relationships !== 0
    || redisResidual.ownedCreated !== 7 || redisResidual.ownedRemaining !== 0
    || redisResidual.unexpectedNewKeys !== 0) {
    throw new Error('RET001D_CLEANUP_OR_CASE_COUNT_INVALID');
  }
  if (!observedServices) throw new Error('RET001D_SERVICE_IDENTITY_MISSING');
  let observedGit: { sha: string; dirty: false };
  try { observedGit = await gitState(config.requestTimeoutMs); }
  catch { throw new Error('RET001D_GIT_STATE_FAILED'); }
  const manifestTruth = {
    git: observedGit,
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    config: config.safeConfig,
    services: observedServices,
  } as const;
  const manifest = sanitizeTraceConformanceManifest({
    schemaVersion: 1,
    packet: 'RET-001D',
    generatedAt: new Date().toISOString(),
    git: manifestTruth.git,
    runtime: manifestTruth.runtime,
    config: config.safeConfig,
    services: observedServices,
    result: {
      fidelity: 'composition-root / live-disposable-persistence',
      cases,
      ret010dCases,
      readiness: {
        singleDefault: {
          httpStatus: readinessEvidence.find(({ mode }) => mode === 'single-default')?.status,
          classification: readinessEvidence.find(({ mode }) => mode === 'single-default')?.classification,
        },
        namedTenant: {
          httpStatus: readinessEvidence.find(({ mode }) => mode === 'named-tenant')?.status,
          classification: readinessEvidence.find(({ mode }) => mode === 'named-tenant')?.classification,
        },
      },
      invariants: {
        canonicalValidation: true,
        replayResultOrder: true,
        noTraceParity: true,
        secretContentSafety: true,
        boundedExecution: true,
        tenantIsolation: true,
      },
    },
    cleanup: {
      fixtureNodesRemaining: graphResidual.nodes,
      fixtureRelationshipsRemaining: graphResidual.relationships,
      redisKeysRemaining: redisResidual.ownedRemaining + redisResidual.unexpectedNewKeys,
      childProcessesStopped,
      temporaryExportPathRemoved: tempRemoved,
      disposableServiceOwnership: 'caller-provided-loopback-services',
    },
  }, allForbidden, manifestTruth) as JsonRecord;
  assertTraceConformanceManifest(manifest, manifestTruth);
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  for (const value of allForbidden) if (value && serialized.includes(value)) throw new Error('RET001D_MANIFEST_FORBIDDEN_VALUE');
  if (config.evidencePath) {
    try {
      await mkdir(dirname(config.evidencePath), { recursive: true });
      await runAbortableOperation(
        (signal) => writeFile(config.evidencePath!, serialized, { encoding: 'utf8', signal }),
        config.requestTimeoutMs, 'RET001D_EVIDENCE_WRITE_TIMEOUT', 'RET001D_EVIDENCE_WRITE_FAILED',
      );
    } catch (error) {
      if (safeDiagnosticCode(error) !== 'RET001D_INTERNAL_FAILURE') throw error;
      throw new Error('RET001D_EVIDENCE_WRITE_FAILED');
    }
  }
  return manifest;
}

async function main(): Promise<void> {
  const evidence = await runTraceLiveConformanceEvidence(resolveTraceConformanceConfig());
  console.log(JSON.stringify({
    ok: true,
    packet: evidence.packet,
    sha: (evidence.git as JsonRecord).sha,
    caseCount: ((evidence.result as JsonRecord).cases as unknown[]).length,
    cleanup: evidence.cleanup,
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(safeDiagnosticCode(error));
    process.exitCode = 1;
  });
}
