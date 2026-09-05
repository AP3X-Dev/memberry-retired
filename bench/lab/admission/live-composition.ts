#!/usr/bin/env tsx

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify, types as nodeUtilTypes } from 'node:util';

import type { Driver } from 'neo4j-driver';

import { parseAdmissionObservationV1 } from '../../../packages/core/src/admission.js';
import {
  DOMAIN_DESCRIPTIONS,
  DOMAIN_TOOL_NAMES_MAP,
  type ToolDomain,
} from '../../../packages/mcp/src/tools.js';
import { createNeo4jDriver } from '../../../packages/neo4j/src/driver.js';
import { hasClosedRetrievalResolutionStatusV1 } from '../contracts/retrieval-resolution-status.js';

const execFileAsync = promisify(execFile);
const OBSERVATION_KEYS = [
  'id', 'tenant_id', 'project_scope', 'contract_version', 'capture_state', 'memory_class', 'outcome',
  'tenant_scope', 'safe_project_scope', 'sensitivity', 'redaction_configured', 'has_signals',
  'has_entities', 'has_model', 'policy_id', 'policy_version', 'recommended_tier',
  'would_change_baseline', 'reason_code', 'observed_at',
] as const;
const REDACTED_KEY = /(?:authorization|token|password|secret|content|task)/i;
const DEFAULT_STARTUP_TIMEOUT_MS = 300_000;
const DEFAULT_SHADOW_TIMEOUT_MS = 50;
const MAX_HTTP_RESPONSE_BYTES = 256 * 1024;
const MCP_PROTOCOL_VERSION = '2025-03-26';
const TENANT_DOMAIN_ORDER = ['memory', 'temporal', 'admin', 'retrieval'] as const satisfies readonly ToolDomain[];
const CANONICAL_TENANT_DOMAINS = Object.freeze(TENANT_DOMAIN_ORDER.map((domain) => Object.freeze({
  domain,
  description: DOMAIN_DESCRIPTIONS[domain],
  tools: Object.freeze([...DOMAIN_TOOL_NAMES_MAP[domain]]),
})));

export interface AdmissionLiveConfig {
  readonly token: string;
  readonly neo4jUser: string;
  readonly neo4jPassword: string;
  readonly mcpUrl: string;
  readonly redisUrl: string;
  readonly neo4jUri: string;
  readonly host: '127.0.0.1' | '::1' | 'localhost';
  readonly port: number;
  readonly timeoutMs: number;
  readonly startupTimeoutMs: number;
  readonly evidencePath?: string;
  readonly safeConfig: Readonly<Record<string, unknown>>;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonRecord;
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`MEM-001D2 live evidence requires ${name}`);
  return value;
}

function loopbackUrl(raw: string, protocols: readonly string[], name: string): URL {
  if (/%[0-9a-f]{2}/i.test(raw)) throw new Error(`${name} must not contain percent-encoded components`);
  let parsed: URL;
  try { parsed = new URL(raw); }
  catch { throw new Error(`${name} must be a valid loopback URL`); }
  if (!protocols.includes(parsed.protocol)) throw new Error(`${name} must use ${protocols.join(' or ')}`);
  if (parsed.search || parsed.hash) throw new Error(`${name} must not contain query or fragment components`);
  if (parsed.pathname !== '' && parsed.pathname !== '/') throw new Error(`${name} must use the root path only`);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!['127.0.0.1', '::1', 'localhost'].includes(hostname)) {
    throw new Error(`${name} must be loopback-only`);
  }
  if (parsed.username || parsed.password) throw new Error(`${name} must not embed credentials`);
  return parsed;
}

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^\d+$/.test(raw.trim())) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} is out of bounds`);
  return value;
}

export function resolveAdmissionLiveConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AdmissionLiveConfig {
  if (env.MEMBERRY_ADMISSION_LIVE_ALLOW_WRITES?.trim().toLowerCase() !== 'true') {
    throw new Error('MEM-001D2 live evidence is fail-closed; set MEMBERRY_ADMISSION_LIVE_ALLOW_WRITES=true');
  }
  if (env.MEMBERRY_ADMISSION_LIVE_DISPOSABLE?.trim().toLowerCase() !== 'true') {
    throw new Error('MEM-001D2 live evidence is fail-closed; set MEMBERRY_ADMISSION_LIVE_DISPOSABLE=true');
  }

  const token = required(env, 'MEMBERRY_ADMISSION_LIVE_API_TOKEN');
  const neo4jUser = required(env, 'MEMBERRY_ADMISSION_LIVE_NEO4J_USER');
  const neo4jPassword = required(env, 'MEMBERRY_ADMISSION_LIVE_NEO4J_PASSWORD');
  const mcp = loopbackUrl(required(env, 'MEMBERRY_ADMISSION_LIVE_MCP_URL'), ['http:'], 'MCP URL');
  const redis = loopbackUrl(required(env, 'MEMBERRY_ADMISSION_LIVE_REDIS_URL'), ['redis:', 'rediss:'], 'Redis URL');
  const neo4j = loopbackUrl(required(env, 'MEMBERRY_ADMISSION_LIVE_NEO4J_URI'), ['bolt:', 'neo4j:'], 'Neo4j URI');
  const host = mcp.hostname.replace(/^\[|\]$/g, '') as AdmissionLiveConfig['host'];
  const port = mcp.port ? Number(mcp.port) : mcp.protocol === 'https:' ? 443 : 80;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('MCP URL requires a valid port');
  const timeoutMs = boundedInteger(
    env.MEMBERRY_ADMISSION_LIVE_TIMEOUT_MS,
    DEFAULT_SHADOW_TIMEOUT_MS,
    1,
    1_000,
    'MEMBERRY_ADMISSION_LIVE_TIMEOUT_MS',
  );
  const startupTimeoutMs = boundedInteger(
    env.MEMBERRY_ADMISSION_LIVE_STARTUP_TIMEOUT_MS,
    DEFAULT_STARTUP_TIMEOUT_MS,
    1_000,
    300_000,
    'MEMBERRY_ADMISSION_LIVE_STARTUP_TIMEOUT_MS',
  );
  const safeConfig = Object.freeze({
    mcpUrl: mcp.toString().replace(/\/$/, ''),
    redisUrl: redis.toString().replace(/\/$/, ''),
    neo4jUri: neo4j.toString().replace(/\/$/, ''),
    host,
    port,
    timeoutMs,
    startupTimeoutMs,
    writeAuthorization: 'explicit-disposable-only',
    modes: ['default-off', 'shadow-enabled'],
  });
  return Object.freeze({
    token,
    neo4jUser,
    neo4jPassword,
    mcpUrl: String(safeConfig.mcpUrl),
    redisUrl: String(safeConfig.redisUrl),
    neo4jUri: String(safeConfig.neo4jUri),
    host,
    port,
    timeoutMs,
    startupTimeoutMs,
    ...(env.MEMBERRY_ADMISSION_LIVE_EVIDENCE_PATH?.trim()
      ? { evidencePath: resolve(env.MEMBERRY_ADMISSION_LIVE_EVIDENCE_PATH.trim()) }
      : {}),
    safeConfig,
  });
}

const ADMISSION_SHADOW_KEYS = [
  'schema_version', 'enabled', 'mode', 'health', 'affects_readiness', 'delivery',
  'recovery', 'completeness', 'durable_retry', 'self_healing', 'history_complete',
  'history_scope', 'crash_gap_possible', 'stopping', 'last_failure_code',
  'registered_runtimes', 'timeout_ms', 'max_in_flight', 'counters',
] as const;
const ADMISSION_SHADOW_COUNTER_KEYS = [
  'prepared', 'preparation_failures', 'append_attempts', 'appended', 'append_failures',
  'timed_out', 'capacity_rejected', 'shutdown_skipped', 'late_appended', 'late_failures',
  'reserved', 'in_flight',
] as const;
const ADMISSION_SHADOW_FAILURE_CODES = [
  'preparation_failed', 'append_failed', 'timed_out', 'capacity_rejected', 'shutdown_skipped',
] as const;
function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function expectedArrayValue(value: unknown, index: number): unknown {
  return Array.isArray(value) ? value[index] : undefined;
}

export function assertReadinessContract(
  value: unknown,
  expectedEnabled: boolean,
  expectedTimeoutMs = DEFAULT_SHADOW_TIMEOUT_MS,
  allowDegraded = false,
): JsonRecord {
  const body = record(value, 'readiness');
  if (!exactKeys(body, [
    'status', 'admission_shadow', 'evidence_http_status', 'evidence_readiness_class',
  ])) throw new Error('readiness shape is not closed');
  if (body.status !== 'ready') throw new Error('readiness.status must be ready');
  const shadow = record(body.admission_shadow, 'readiness.admission_shadow');
  if (!exactKeys(shadow, ADMISSION_SHADOW_KEYS)) {
    throw new Error('readiness admission_shadow shape is not closed');
  }
  const exact: Record<string, unknown> = {
    schema_version: 1,
    enabled: expectedEnabled,
    mode: expectedEnabled ? 'shadow' : 'disabled',
    affects_readiness: false,
    delivery: 'best-effort-bounded-terminal',
    recovery: 'none',
    completeness: 'not-provable',
    durable_retry: false,
    self_healing: false,
    history_complete: false,
    history_scope: 'process-lifetime',
    crash_gap_possible: expectedEnabled,
    stopping: false,
  };
  for (const [key, expected] of Object.entries(exact)) {
    if (!Object.is(shadow[key], expected)) throw new Error(`readiness admission_shadow.${key} is not truthful`);
  }
  const allowedHealth = expectedEnabled
    ? (allowDegraded ? ['healthy', 'degraded'] : ['healthy'])
    : ['disabled'];
  if (!allowedHealth.includes(String(shadow.health))) {
    throw new Error('readiness admission_shadow.health is not truthful');
  }
  if (shadow.registered_runtimes !== 1) {
    throw new Error('readiness admission_shadow.registered_runtimes must be exactly one');
  }
  if (!Array.isArray(shadow.timeout_ms) || shadow.timeout_ms.length !== 1
    || shadow.timeout_ms[0] !== expectedTimeoutMs) throw new Error('readiness admission_shadow.timeout_ms is invalid');
  if (shadow.max_in_flight !== 32) {
    throw new Error('readiness admission_shadow.max_in_flight must be exactly 32');
  }
  if (shadow.last_failure_code !== null
    && !ADMISSION_SHADOW_FAILURE_CODES.some((code) => code === shadow.last_failure_code)) {
    throw new Error('readiness admission_shadow.last_failure_code is invalid');
  }
  const counters = record(shadow.counters, 'readiness.admission_shadow.counters');
  if (!exactKeys(counters, ADMISSION_SHADOW_COUNTER_KEYS)) {
    throw new Error('readiness admission_shadow counters shape is not closed');
  }
  if (ADMISSION_SHADOW_COUNTER_KEYS.some((key) => !isNonnegativeSafeInteger(counters[key]))) {
    throw new Error('readiness admission_shadow counters values are invalid');
  }
  return readinessEvidenceProjection(body, shadow);
}

export function readinessEvidenceProjection(body: JsonRecord, shadow: JsonRecord): JsonRecord {
  if (!exactKeys(body, [
    'status', 'admission_shadow', 'evidence_http_status', 'evidence_readiness_class',
  ]) || !hasClosedAdmissionShadowShape(shadow)) {
    throw new Error('MEM001D2_READINESS_EVIDENCE_SHAPE_INVALID');
  }
  const httpStatus = body.evidence_http_status;
  const readinessClass = body.evidence_readiness_class;
  if (httpStatus !== 503 || readinessClass !== 'expected-logical-multitenant-degraded') {
    throw new Error('MEM001D2_READINESS_EVIDENCE_CLASS_INVALID');
  }
  const counters = record(shadow.counters, 'readiness.admission_shadow.counters');
  return {
    schema_version: shadow.schema_version,
    enabled: shadow.enabled,
    mode: shadow.mode,
    health: shadow.health,
    affects_readiness: shadow.affects_readiness,
    delivery: shadow.delivery,
    recovery: shadow.recovery,
    completeness: shadow.completeness,
    durable_retry: shadow.durable_retry,
    self_healing: shadow.self_healing,
    history_complete: shadow.history_complete,
    history_scope: shadow.history_scope,
    crash_gap_possible: shadow.crash_gap_possible,
    stopping: shadow.stopping,
    last_failure_code: shadow.last_failure_code,
    registered_runtimes: shadow.registered_runtimes,
    timeout_ms: [expectedArrayValue(shadow.timeout_ms, 0)],
    max_in_flight: shadow.max_in_flight,
    counters: Object.fromEntries(ADMISSION_SHADOW_COUNTER_KEYS.map((key) => [key, counters[key]])),
    evidence_http_status: httpStatus,
    evidence_readiness_class: readinessClass,
  };
}

export interface ObservationInspection {
  readonly scope: { readonly tenantId: string; readonly projectScope: string; readonly episodeId: string };
  readonly properties: Readonly<Record<string, unknown>>;
  readonly observationCount: number;
  readonly exactLinkCount: number;
}

export function assertContentFreeObservation(inspection: ObservationInspection): Readonly<Record<string, unknown>> {
  if (inspection.observationCount !== 1 || inspection.exactLinkCount !== 1) {
    throw new Error('live evidence requires exactly one linked AdmissionObservation');
  }
  const keys = Reflect.ownKeys(inspection.properties);
  if (keys.length !== OBSERVATION_KEYS.length
    || keys.some((key) => typeof key !== 'string' || !OBSERVATION_KEYS.includes(key as (typeof OBSERVATION_KEYS)[number]))) {
    throw new Error('AdmissionObservation must be content-free and use only the frozen safe property set');
  }
  if (inspection.properties.tenant_id !== inspection.scope.tenantId
    || inspection.properties.project_scope !== inspection.scope.projectScope) {
    throw new Error('AdmissionObservation scope does not match its Episodic');
  }
  if (inspection.properties.capture_state !== 'accepted-nonduplicate'
    || inspection.properties.contract_version !== '1.0.0'
    || inspection.properties.memory_class !== 'general'
    || inspection.properties.outcome !== 'unspecified'
    || inspection.properties.tenant_scope !== 'resolved'
    || inspection.properties.safe_project_scope !== 'resolved'
    || inspection.properties.sensitivity !== 'not-detected'
    || inspection.properties.redaction_configured !== false
    || inspection.properties.has_signals !== false
    || inspection.properties.has_entities !== false
    || inspection.properties.has_model !== false
    || inspection.properties.policy_id !== 'baseline-parity-admission'
    || inspection.properties.policy_version !== '1.0.0'
    || inspection.properties.recommended_tier !== 'episodic'
    || inspection.properties.reason_code !== 'baseline-parity-accepted-nonduplicate'
    || inspection.properties.would_change_baseline !== false) {
    throw new Error('AdmissionObservation safe facts do not describe the accepted baseline write');
  }
  parseAdmissionObservationV1({
    contractVersion: inspection.properties.contract_version,
    safeFacts: {
      contractVersion: inspection.properties.contract_version,
      captureState: inspection.properties.capture_state,
      memoryClass: inspection.properties.memory_class,
      outcome: inspection.properties.outcome,
      tenantScope: inspection.properties.tenant_scope,
      projectScope: inspection.properties.safe_project_scope,
      sensitivity: inspection.properties.sensitivity,
      redactionConfigured: inspection.properties.redaction_configured,
      hasSignals: inspection.properties.has_signals,
      hasEntities: inspection.properties.has_entities,
      hasModel: inspection.properties.has_model,
    },
    recommendation: {
      contractVersion: inspection.properties.contract_version,
      policyId: inspection.properties.policy_id,
      policyVersion: inspection.properties.policy_version,
      recommendedTier: inspection.properties.recommended_tier,
      wouldChangeBaseline: inspection.properties.would_change_baseline,
      reasonCode: inspection.properties.reason_code,
    },
    observedAt: inspection.properties.observed_at,
  });
  return inspection.properties;
}

export function sanitizeAdmissionEvidence(value: unknown, forbiddenValues: readonly string[]): unknown {
  const secrets = forbiddenValues.filter(Boolean).sort((a, b) => b.length - a.length);
  const sanitizeString = (raw: string): string => {
    let result = raw.replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]');
    for (const secret of secrets) result = result.split(secret).join('[REDACTED]');
    return result;
  };
  const ancestors = new WeakSet<object>();
  const visit = (current: unknown, key?: string, depth = 0): unknown => {
    if (depth > 64) throw new Error('admission evidence canonicalization rejected excessive nesting');
    if (current === null || typeof current === 'boolean') return current;
    if (typeof current === 'string') return sanitizeString(current);
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new Error('admission evidence canonicalization rejected non-finite number');
      return current;
    }
    if (typeof current !== 'object') {
      throw new Error(`admission evidence canonicalization rejected ${typeof current} value`);
    }
    if (nodeUtilTypes.isProxy(current)) throw new Error('admission evidence canonicalization rejected proxy container');
    if (ancestors.has(current)) throw new Error('admission evidence canonicalization rejected circular structure');
    const prototype = Object.getPrototypeOf(current);
    const array = Array.isArray(current);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw new Error('admission evidence canonicalization accepts only arrays and plain records');
    }
    const keys = Reflect.ownKeys(current);
    if (keys.some((candidate) => typeof candidate === 'symbol')) {
      throw new Error('admission evidence canonicalization rejected symbol key');
    }
    const descriptors = Object.getOwnPropertyDescriptors(current);
    ancestors.add(current);
    try {
      if (array) {
        const lengthDescriptor = descriptors.length;
        if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value')) {
          throw new Error('admission evidence canonicalization rejected exotic array');
        }
        const length = current.length;
        const allowedKeys = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
        if (keys.length !== length + 1 || keys.some((candidate) => !allowedKeys.has(String(candidate)))) {
          throw new Error('admission evidence canonicalization rejected sparse or exotic array');
        }
        return Array.from({ length }, (_, index) => {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
            throw new Error('admission evidence canonicalization rejected array accessor');
          }
          return visit(descriptor.value, undefined, depth + 1);
        });
      }
      const output: Record<string, unknown> = {};
      for (const candidate of keys) {
        const entryKey = String(candidate);
        const descriptor = descriptors[entryKey];
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
          throw new Error('admission evidence canonicalization rejected accessor property');
        }
        if (descriptor.enumerable !== true) {
          throw new Error('admission evidence canonicalization rejected non-enumerable property');
        }
        Object.defineProperty(output, entryKey, {
          value: REDACTED_KEY.test(entryKey)
            ? '[REDACTED]'
            : visit(descriptor.value, entryKey, depth + 1),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return output;
    } finally {
      ancestors.delete(current);
    }
  };
  return visit(value);
}

function integer(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'object' && value !== null && 'toNumber' in value
    && typeof (value as { toNumber?: unknown }).toNumber === 'function') {
    return (value as { toNumber(): number }).toNumber();
  }
  return Number.NaN;
}

async function boundedResponseText(response: Response, diagnosticPrefix: string): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_HTTP_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error(`${diagnosticPrefix}_RESPONSE_TOO_LARGE`);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_HTTP_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new Error(`${diagnosticPrefix}_RESPONSE_TOO_LARGE`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof Error && error.message === `${diagnosticPrefix}_RESPONSE_TOO_LARGE`) throw error;
    throw new Error(`${diagnosticPrefix}_RESPONSE_READ_FAILURE`);
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

function parseMcpEnvelope(contentType: string, raw: string): JsonRecord | undefined {
  if (!raw.trim()) return undefined;
  let encoded = raw;
  if (contentType.toLowerCase().includes('text/event-stream')) {
    encoded = raw.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim();
    if (!encoded) return undefined;
  }
  try { return record(JSON.parse(encoded), 'MCP response'); }
  catch { throw new Error('MEM001D2_MCP_RESPONSE_INVALID'); }
}

class BoundedAdmissionMcpTransport {
  private sessionId?: string;
  private nextId = 1;

  constructor(private readonly config: AdmissionLiveConfig) {}

  private async request(body: JsonRecord, withSession = true): Promise<JsonRecord | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.config.token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    if (withSession && this.sessionId) {
      headers['mcp-session-id'] = this.sessionId;
      headers['mcp-protocol-version'] = MCP_PROTOCOL_VERSION;
    }
    let response: Response;
    try {
      response = await fetch(new URL('/mcp', this.config.mcpUrl), {
        method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal,
      });
    } catch {
      clearTimeout(timer);
      throw new Error('MEM001D2_MCP_NETWORK_FAILURE');
    }
    try {
      if (!withSession) {
        const candidate = response.headers.get('mcp-session-id');
        this.pendingSessionId = candidate && /^[A-Za-z0-9._~-]{1,200}$/.test(candidate) ? candidate : undefined;
      }
      const raw = await boundedResponseText(response, 'MEM001D2_MCP');
      if (!response.ok) throw new Error('MEM001D2_MCP_HTTP_FAILURE');
      const envelope = parseMcpEnvelope(response.headers.get('content-type') ?? '', raw);
      if (envelope?.error !== undefined) throw new Error('MEM001D2_MCP_RPC_FAILURE');
      return envelope;
    } finally {
      clearTimeout(timer);
    }
  }

  private async initialize(): Promise<void> {
    if (this.sessionId) return;
    const envelope = await this.request({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'memberry-admission-live-evidence', version: '1.0.0' },
      },
    }, false);
    let result: JsonRecord | undefined;
    try { result = envelope ? record(envelope.result, 'MCP initialize result') : undefined; }
    catch { throw new Error('MEM001D2_MCP_INITIALIZE_INVALID'); }
    if (result?.protocolVersion !== MCP_PROTOCOL_VERSION) throw new Error('MEM001D2_MCP_INITIALIZE_INVALID');
    const sessionId = this.pendingSessionId;
    if (!sessionId) throw new Error('MEM001D2_MCP_SESSION_INVALID');
    this.sessionId = sessionId;
    await this.request({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  private pendingSessionId?: string;

  async call(tool: string, args: JsonRecord): Promise<string> {
    await this.initialize();
    const envelope = await this.request({
      jsonrpc: '2.0', id: this.nextId++, method: 'tools/call', params: { name: tool, arguments: args },
    });
    if (!envelope) throw new Error('MEM001D2_MCP_TOOL_RESPONSE_INVALID');
    let result: JsonRecord;
    try { result = record(envelope.result, 'MCP tool result'); }
    catch { throw new Error('MEM001D2_MCP_TOOL_RESPONSE_INVALID'); }
    if (result.isError === true || !Array.isArray(result.content)) throw new Error('MEM001D2_MCP_TOOL_FAILURE');
    const text: string[] = [];
    for (const part of result.content) {
      let item: JsonRecord;
      try { item = record(part, 'MCP tool content'); }
      catch { throw new Error('MEM001D2_MCP_TOOL_RESPONSE_INVALID'); }
      if (item.type !== 'text' || typeof item.text !== 'string') {
        throw new Error('MEM001D2_MCP_TOOL_RESPONSE_INVALID');
      }
      text.push(item.text);
    }
    return text.join('\n');
  }
}

async function readiness(config: AdmissionLiveConfig): Promise<JsonRecord> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let response: Response;
  try {
    response = await fetch(new URL('/readyz', config.mcpUrl), {
      headers: { authorization: `Bearer ${config.token}` },
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    throw new Error('MEM001D2_READINESS_NETWORK_FAILURE');
  }
  try {
    if (!response.ok && response.status !== 503) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error(`MEM001D2_READINESS_HTTP_${response.status}`);
    }
    const raw = await boundedResponseText(response, 'MEM001D2_READINESS');
    let body: JsonRecord;
    try { body = record(JSON.parse(raw), 'readiness'); }
    catch {
      if (response.status === 503) throw new Error('MEM001D2_READINESS_HTTP_503');
      throw new Error('MEM001D2_READINESS_RESPONSE_INVALID');
    }
    if (response.status !== 503) {
      throw new Error('MEM001D2_READINESS_STATUS_MISMATCH');
    }
    if (!isExpectedDisposableMultiTenantDegradation(body)) {
      throw new Error('MEM001D2_READINESS_HTTP_503');
    }
    return {
      status: body.status,
      admission_shadow: body.admission_shadow,
      evidence_http_status: 503,
      evidence_readiness_class: 'expected-logical-multitenant-degraded',
    };
  } finally { clearTimeout(timer); }
}

const LOGICAL_MULTI_TENANT_LIMITATION =
  'shared logical multi-tenant consolidation and wiki publication are disabled to prevent cross-tenant disclosure';
const NO_PROVIDER_LIMITATION =
  'recurring/synthesized semantic promotion is unavailable without an LLM/embedding provider; approved classified decisions still promote and episodic recall remains available';
const EXPECTED_DISPOSABLE_LIMITATION = `${LOGICAL_MULTI_TENANT_LIMITATION}; ${NO_PROVIDER_LIMITATION}`;
const EXPECTED_AGGREGATE_LIMITATION = `default: ${EXPECTED_DISPOSABLE_LIMITATION}`;

function exactKeys(value: JsonRecord, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length
    && keys.every((key) => typeof key === 'string' && expected.includes(key));
}

function hasClosedAdmissionShadowShape(value: unknown): boolean {
  let shadow: JsonRecord;
  let counters: JsonRecord;
  try {
    shadow = record(value, 'admission shadow');
    counters = record(shadow.counters, 'admission shadow counters');
  } catch { return false; }
  return exactKeys(shadow, ADMISSION_SHADOW_KEYS)
    && exactKeys(counters, ADMISSION_SHADOW_COUNTER_KEYS)
    && ADMISSION_SHADOW_COUNTER_KEYS.every((key) => isNonnegativeSafeInteger(counters[key]))
    && shadow.schema_version === 1
    && typeof shadow.enabled === 'boolean'
    && ['shadow', 'disabled'].includes(String(shadow.mode))
    && ['healthy', 'degraded', 'disabled'].includes(String(shadow.health))
    && shadow.affects_readiness === false
    && shadow.delivery === 'best-effort-bounded-terminal'
    && shadow.recovery === 'none'
    && shadow.completeness === 'not-provable'
    && shadow.durable_retry === false
    && shadow.self_healing === false
    && shadow.history_complete === false
    && shadow.history_scope === 'process-lifetime'
    && typeof shadow.crash_gap_possible === 'boolean'
    && shadow.stopping === false
    && (shadow.last_failure_code === null
      || ADMISSION_SHADOW_FAILURE_CODES.some((code) => code === shadow.last_failure_code))
    && shadow.registered_runtimes === 1
    && Array.isArray(shadow.timeout_ms) && shadow.timeout_ms.length === 1
    && isNonnegativeSafeInteger(shadow.timeout_ms[0]) && shadow.timeout_ms[0] > 0
    && shadow.max_in_flight === 32;
}

/** Datastore-probe readiness fields (/readyz D1/A6). `datastores`, `embeddings`
 *  and `degraded` arrive together when a probe source is registered; `retrieval`
 *  and `lifecycle` are reported only when their producers exist. A server
 *  without a probe source carries none of them. */
const READINESS_PROBE_KEYS = ['datastores', 'embeddings', 'degraded'] as const;
const READINESS_OPTIONAL_KEYS = ['retrieval', 'lifecycle'] as const;

function hasClosedReadinessProbeShape(body: JsonRecord): boolean {
  const present = READINESS_PROBE_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(body, key));
  if (present.length === 0) {
    return !READINESS_OPTIONAL_KEYS.some((key) => Object.prototype.hasOwnProperty.call(body, key));
  }
  if (present.length !== READINESS_PROBE_KEYS.length) return false;
  let datastores: JsonRecord;
  try { datastores = record(body.datastores, 'readiness datastores'); }
  catch { return false; }
  if (!exactKeys(datastores, ['neo4j', 'redis'])
    || datastores.neo4j !== 'ok' || datastores.redis !== 'ok') return false;
  if (body.embeddings !== 'ok' && body.embeddings !== 'disabled' && body.embeddings !== 'degraded') return false;
  if (!Array.isArray(body.degraded) || !body.degraded.every((entry) => typeof entry === 'string')) return false;
  for (const key of READINESS_OPTIONAL_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    try { record(body[key], `readiness ${key}`); }
    catch { return false; }
  }
  return true;
}

function isExpectedDisposableMultiTenantDegradation(body: JsonRecord): boolean {
  const baseKeys = [
    'status', 'service', 'transport', 'active_sessions', 'registered_sessions',
    'auth_required', 'uptime_ms', 'consolidation_automation', 'admission_shadow',
    'retrieval_resolution',
  ];
  const probeKeys = [...READINESS_PROBE_KEYS, ...READINESS_OPTIONAL_KEYS]
    .filter((key) => Object.prototype.hasOwnProperty.call(body, key));
  if (!exactKeys(body, [...baseKeys, ...probeKeys])
    || body.status !== 'ready' || body.service !== 'memberry-mcp' || body.transport !== 'sse'
    || body.auth_required !== true || !isNonnegativeSafeInteger(body.active_sessions)
    || !isNonnegativeSafeInteger(body.registered_sessions) || body.active_sessions !== body.registered_sessions
    || typeof body.uptime_ms !== 'number' || !Number.isFinite(body.uptime_ms) || body.uptime_ms < 0
    || !hasClosedAdmissionShadowShape(body.admission_shadow)
    || !hasClosedRetrievalResolutionStatusV1(body.retrieval_resolution)
    || !hasClosedReadinessProbeShape(body)) return false;
  let automation: JsonRecord;
  try { automation = record(body.consolidation_automation, 'consolidation automation'); }
  catch { return false; }
  if (!exactKeys(automation, ['enabled', 'unhealthy', 'degraded', 'limitations', 'workers'])
    || automation.enabled !== false || automation.unhealthy !== true || automation.degraded !== true
    || !Array.isArray(automation.limitations) || automation.limitations.length !== 1
    || automation.limitations[0] !== EXPECTED_AGGREGATE_LIMITATION
    || !Array.isArray(automation.workers) || automation.workers.length !== 1) return false;
  let worker: JsonRecord;
  try { worker = record(automation.workers[0], 'consolidation worker'); }
  catch { return false; }
  if (!exactKeys(worker, [
    'name', 'enabled', 'readonly', 'running_scope', 'queued_scopes', 'last_attempt_at',
    'last_success_at', 'last_error', 'limitation', 'health', 'stale', 'exhausted_failure',
    'discovery', 'publication', 'pending_retries',
  ]) || worker.name !== 'default' || worker.enabled !== false || worker.readonly !== false
    || worker.running_scope !== null || !Array.isArray(worker.queued_scopes) || worker.queued_scopes.length !== 0
    || worker.last_attempt_at !== null || worker.last_success_at !== null || worker.last_error !== null
    || worker.limitation !== EXPECTED_DISPOSABLE_LIMITATION || worker.health !== 'unhealthy'
    || worker.stale !== false || worker.exhausted_failure !== false
    || !Array.isArray(worker.pending_retries) || worker.pending_retries.length !== 0) return false;
  let discovery: JsonRecord;
  let publication: JsonRecord;
  try {
    discovery = record(worker.discovery, 'consolidation discovery');
    publication = record(worker.publication, 'consolidation publication');
  } catch { return false; }
  return exactKeys(discovery, ['last_error', 'pending_retry', 'exhausted_failure'])
    && discovery.last_error === null && discovery.pending_retry === null && discovery.exhausted_failure === false
    && exactKeys(publication, [
      'needed_since', 'last_success_at', 'last_error', 'pending_retry', 'exhausted_failure',
      'dirty_version', 'published_version',
    ])
    && publication.needed_since === null && publication.last_success_at === null
    && publication.last_error === null && publication.pending_retry === null
    && publication.exhausted_failure === false && publication.dirty_version === null
    && publication.published_version === null;
}

export interface AdmissionReadinessWaitDependencies {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const DEFAULT_READINESS_WAIT_DEPENDENCIES: AdmissionReadinessWaitDependencies = {
  now: Date.now,
  sleep: (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
};

function readinessFailureCode(error: unknown): string {
  return error instanceof Error && /^MEM001D2_[A-Z0-9_]+$/.test(error.message)
    ? error.message
    : 'MEM001D2_READINESS_UNKNOWN_FAILURE';
}

function retryableReadinessFailure(code: string): boolean {
  return code === 'MEM001D2_READINESS_NETWORK_FAILURE' || code === 'MEM001D2_READINESS_HTTP_503';
}

export async function waitForAdmissionReadiness(
  probe: () => Promise<JsonRecord>,
  timeoutMs: number,
  dependencies: AdmissionReadinessWaitDependencies = DEFAULT_READINESS_WAIT_DEPENDENCIES,
): Promise<JsonRecord> {
  const deadline = dependencies.now() + timeoutMs;
  let lastFailure = 'MEM001D2_READINESS_NETWORK_FAILURE';
  while (dependencies.now() < deadline) {
    try { return await probe(); }
    catch (error) {
      const code = readinessFailureCode(error);
      if (!retryableReadinessFailure(code)) throw new Error(code);
      lastFailure = code;
      await dependencies.sleep(250);
    }
  }
  throw new Error(`MEM001D2_READINESS_STARTUP_TIMEOUT__${lastFailure}`);
}

async function assertStreamableHttpMcp(config: AdmissionLiveConfig): Promise<void> {
  const transport = new BoundedAdmissionMcpTransport(config);
  const raw = await transport.call('berry_tools', { action: 'list' });
  let payload: JsonRecord;
  try { payload = record(JSON.parse(raw), 'berry_tools Streamable HTTP probe'); }
  catch { throw new Error('MEM001D2_MCP_REGISTRY_INVALID'); }
  if (Reflect.ownKeys(payload).length !== 1 || !Array.isArray(payload.domains)
    || payload.domains.length !== CANONICAL_TENANT_DOMAINS.length) {
    throw new Error('MEM001D2_MCP_REGISTRY_INVALID');
  }
  for (let index = 0; index < CANONICAL_TENANT_DOMAINS.length; index++) {
    const expected = CANONICAL_TENANT_DOMAINS[index]!;
    let domain: JsonRecord;
    try { domain = record(payload.domains[index], 'berry_tools domain'); }
    catch { throw new Error('MEM001D2_MCP_REGISTRY_INVALID'); }
    if (Reflect.ownKeys(domain).length !== 4 || domain.domain !== expected.domain
      || domain.description !== expected.description
      || domain.enabled !== false || !Array.isArray(domain.tools)
      || domain.tools.length !== expected.tools.length
      || domain.tools.some((tool, toolIndex) => tool !== expected.tools[toolIndex])) {
      throw new Error('MEM001D2_MCP_REGISTRY_INVALID');
    }
  }
}

export async function probeAdmissionCompositionRoot(config: AdmissionLiveConfig): Promise<JsonRecord> {
  const ready = await readiness(config);
  if (ready.status !== 'ready') throw new Error('authenticated /readyz did not report ready');
  await assertStreamableHttpMcp(config);
  return ready;
}

export function compositionRootCommand(): { readonly executable: string; readonly args: readonly string[] } {
  return {
    executable: process.execPath,
    args: ['--import', 'tsx', 'packages/mcp/src/server.ts'],
  };
}

export function childEnvironment(
  config: AdmissionLiveConfig,
  enabled: boolean,
  exportPath: string,
  tenantId: string,
): NodeJS.ProcessEnv {
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
    MEMBERRY_TENANT_TOKENS: `${tenantId}:${config.token}`,
    MEMBERRY_EXPORT_PATH: exportPath,
    MEMBERRY_ADMISSION_SHADOW_ENABLED: enabled ? 'true' : 'false',
    MEMBERRY_ADMISSION_SHADOW_TIMEOUT_MS: String(config.timeoutMs),
    MEMBERRY_CONSOLIDATION_ENABLED: 'false',
    MEMBERRY_WIKI_AUTOREFRESH: 'false',
    OPENAI_API_KEY: '',
  };
}

export interface StoppableChild {
  readonly exitCode: number | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: 'exit', listener: (...args: unknown[]) => void): unknown;
  off?(event: 'exit', listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: 'exit', listener: (...args: unknown[]) => void): unknown;
}

function waitForConfirmedExit(child: StoppableChild, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.off) child.off('exit', onExit);
      else child.removeListener?.('exit', onExit);
      resolvePromise(exited || child.exitCode !== null);
    };
    const onExit = () => finish(true);
    child.once('exit', onExit);
    timer = setTimeout(() => finish(false), timeoutMs);
  });
}

export async function stopChildProcessBounded(
  child: StoppableChild,
  gracefulTimeoutMs = 10_000,
  forceTimeoutMs = 2_000,
): Promise<void> {
  if (child.exitCode !== null) return;
  const failures: Error[] = [];
  let gracefulSent = false;
  try { gracefulSent = child.kill('SIGTERM'); }
  catch (error) { failures.push(error instanceof Error ? error : new Error(String(error))); }
  const gracefulExit = child.exitCode !== null
    || (gracefulSent && await waitForConfirmedExit(child, gracefulTimeoutMs));
  if (!gracefulExit && child.exitCode === null) {
    let forceSent = false;
    try { forceSent = child.kill('SIGKILL'); }
    catch (error) { failures.push(error instanceof Error ? error : new Error(String(error))); }
    const forcedExit = child.exitCode !== null
      || (forceSent && await waitForConfirmedExit(child, forceTimeoutMs));
    if (!forcedExit || child.exitCode === null) failures.push(new Error('child process has no confirmed exit after SIGKILL'));
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, failures.map(({ message }) => message).join('; '));
  }
}

export interface CleanupStep {
  readonly name: string;
  run(): Promise<void>;
}

export interface CleanupStepFailure {
  readonly name: string;
  readonly error: Error;
}

export async function runBoundedCleanupSteps(
  steps: readonly CleanupStep[],
  timeoutMs = 20_000,
): Promise<CleanupStepFailure[]> {
  const failures: CleanupStepFailure[] = [];
  for (const step of steps) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => step.run()),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`${step.name} cleanup exceeded ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
    } catch (error) {
      failures.push({ name: step.name, error: error instanceof Error ? error : new Error(String(error)) });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return failures;
}

export interface AdmissionLiveResourceDriver {
  close(): Promise<void>;
}

export interface AdmissionLiveResourceDependencies<TDriver extends AdmissionLiveResourceDriver> {
  createDriver(): TDriver;
  createTemp(): Promise<string>;
  getGitState(): Promise<{ sha: string; dirty: boolean }>;
  removeTemp(path: string): Promise<void>;
}

export interface AdmissionLiveResources<TDriver extends AdmissionLiveResourceDriver> {
  readonly driver: TDriver;
  readonly exportPath: string;
  readonly git: { readonly sha: string; readonly dirty: boolean };
}

export async function acquireAdmissionLiveResources<TDriver extends AdmissionLiveResourceDriver>(
  dependencies: AdmissionLiveResourceDependencies<TDriver>,
  cleanupTimeoutMs = 20_000,
): Promise<AdmissionLiveResources<TDriver>> {
  let driver: TDriver | undefined;
  let exportPath: string | undefined;
  try {
    driver = dependencies.createDriver();
    exportPath = await dependencies.createTemp();
    const git = await dependencies.getGitState();
    return { driver, exportPath, git };
  } catch (error) {
    const cleanupSteps: CleanupStep[] = [];
    if (driver) {
      const acquiredDriver = driver;
      cleanupSteps.push({ name: 'driver-close', run: () => acquiredDriver.close() });
    }
    if (exportPath) {
      const acquiredExportPath = exportPath;
      cleanupSteps.push({
        name: 'temporary-export-remove',
        run: () => dependencies.removeTemp(acquiredExportPath),
      });
    }
    const cleanupFailures = await runBoundedCleanupSteps(cleanupSteps, cleanupTimeoutMs);
    const failures = [
      error instanceof Error ? error : new Error(String(error)),
      ...cleanupFailures.map(({ name, error: cleanupError }) =>
        new Error(`${name}: ${cleanupError.message}`, { cause: cleanupError })),
    ];
    throw new AggregateError(failures, failures.map(({ message }) => message).join('; '));
  }
}

class ServerProcess {
  private readonly child: ChildProcess;
  private log = '';

  constructor(private readonly config: AdmissionLiveConfig, enabled: boolean, exportPath: string, tenantId: string) {
    const command = compositionRootCommand();
    this.child = spawn(command.executable, command.args, {
      cwd: process.cwd(),
      env: childEnvironment(config, enabled, exportPath, tenantId),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const collect = (chunk: Buffer | string) => {
      this.log = `${this.log}${chunk.toString()}`.slice(-65_536);
    };
    this.child.stdout?.on('data', collect);
    this.child.stderr?.on('data', collect);
  }

  async waitUntilReady(): Promise<JsonRecord> {
    let ready: JsonRecord;
    try {
      ready = await waitForAdmissionReadiness(async () => {
        if (this.child.exitCode !== null) throw new Error('MEM001D2_COMPOSITION_ROOT_EXITED');
        return readiness(this.config);
      }, this.config.startupTimeoutMs);
    } catch (error) {
      throw new Error(`${readinessFailureCode(error)}: ${this.safeLog()}`);
    }
    try {
      await assertStreamableHttpMcp(this.config);
      return ready;
    } catch (error) {
      throw new Error(`${readinessFailureCode(error)}: ${this.safeLog()}`);
    }
  }

  safeLog(): string {
    return String(sanitizeAdmissionEvidence(this.log, [this.config.token, this.config.neo4jPassword]));
  }

  async stop(): Promise<void> {
    await stopChildProcessBounded(this.child);
  }
}

export interface FixtureCounts {
  readonly episodes: number;
  readonly observations: number;
  readonly projectEntities: number;
}

type FixtureCountStage = 'DEFAULT_OFF' | 'ENABLED_BEFORE_FAILURES' | 'ENABLED_AFTER_FAILURES' | 'CLEANUP';

function boundedCountDiagnostic(value: number): string {
  return Number.isSafeInteger(value) && value >= 0 ? String(value) : 'INVALID';
}

export function assertFixtureCounts(
  stage: FixtureCountStage,
  actual: FixtureCounts,
  expected: FixtureCounts,
): void {
  if (actual.episodes === expected.episodes
    && actual.observations === expected.observations
    && actual.projectEntities === expected.projectEntities) return;
  const actualCode = `E${boundedCountDiagnostic(actual.episodes)}`
    + `_O${boundedCountDiagnostic(actual.observations)}`
    + `_P${boundedCountDiagnostic(actual.projectEntities)}`;
  const expectedCode = `E${boundedCountDiagnostic(expected.episodes)}`
    + `_O${boundedCountDiagnostic(expected.observations)}`
    + `_P${boundedCountDiagnostic(expected.projectEntities)}`;
  throw new Error(`MEM001D2_${stage}_COUNTS_${actualCode}_EXPECTED_${expectedCode}`);
}

async function scopeCounts(
  driver: Driver,
  tenantId: string,
  projectScope: string,
  projectName: string,
): Promise<FixtureCounts> {
  const session = driver.session();
  try {
    const result = await session.run(
      `OPTIONAL MATCH (e:Episodic {tenant_id: $tenantId, scope: $projectScope})
       OPTIONAL MATCH (o:AdmissionObservation {tenant_id: $tenantId, project_scope: $projectScope})
       OPTIONAL MATCH (p:Entity {name: $projectName})
       RETURN count(DISTINCT e) AS episodes,
              count(DISTINCT o) AS observations,
              count(DISTINCT p) AS projectEntities`,
      { tenantId, projectScope, projectName },
    );
    return {
      episodes: integer(result.records[0]?.get('episodes')),
      observations: integer(result.records[0]?.get('observations')),
      projectEntities: integer(result.records[0]?.get('projectEntities')),
    };
  } finally { await session.close(); }
}

async function inspectObservation(
  driver: Driver,
  scope: ObservationInspection['scope'],
): Promise<ObservationInspection> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (e:Episodic {id: $episodeId, tenant_id: $tenantId, scope: $projectScope})
       OPTIONAL MATCH (o:AdmissionObservation {tenant_id: $tenantId, project_scope: $projectScope})-[r:OBSERVES]->(e)
       RETURN count(DISTINCT o) AS observationCount,
              count(r) AS exactLinkCount,
              collect(properties(o)) AS propertySets`,
      scope,
    );
    const row = result.records[0];
    const propertySets = (row?.get('propertySets') ?? []) as Array<Record<string, unknown>>;
    return {
      scope,
      observationCount: integer(row?.get('observationCount')),
      exactLinkCount: integer(row?.get('exactLinkCount')),
      properties: propertySets[0] ?? {},
    };
  } finally { await session.close(); }
}

async function waitForObservation(driver: Driver, scope: ObservationInspection['scope']): Promise<ObservationInspection> {
  const deadline = Date.now() + 10_000;
  let latest = await inspectObservation(driver, scope);
  while (latest.observationCount !== 1 && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    latest = await inspectObservation(driver, scope);
  }
  return latest;
}

async function cleanupScopes(
  driver: Driver,
  tenantId: string,
  projectScopes: readonly string[],
  projectNames: readonly string[],
): Promise<void> {
  const session = driver.session();
  try {
    await session.executeWrite(async (tx) => {
      await tx.run(
        'MATCH (o:AdmissionObservation {tenant_id: $tenantId}) WHERE o.project_scope IN $projectScopes DETACH DELETE o',
        { tenantId, projectScopes },
      );
      await tx.run(
        'MATCH (e:Episodic {tenant_id: $tenantId}) WHERE e.scope IN $projectScopes DETACH DELETE e',
        { tenantId, projectScopes },
      );
      await tx.run(
        `MATCH (p:Entity)
         WHERE p.name IN $projectNames
           AND p.type = 'project'
           AND p.auto_created = true
           AND p.description = 'Auto-created from berry_store on first reference'
           AND p.id STARTS WITH 'auto-proj-'
         DETACH DELETE p`,
        { projectNames },
      );
    });
  } finally { await session.close(); }
}

async function gitState(): Promise<{ sha: string; dirty: boolean }> {
  const [{ stdout: sha }, { stdout: status }] = await Promise.all([
    execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd() }),
    execFileAsync('git', ['status', '--porcelain'], { cwd: process.cwd() }),
  ]);
  return { sha: sha.trim(), dirty: status.trim().length > 0 };
}

function expectStoreId(text: string): string {
  const match = /^id:([^\s]+)$/m.exec(text);
  if (!match?.[1]) throw new Error('berry_store did not return a nonduplicate Episodic id');
  return match[1];
}

async function runAdmissionLiveCompositionEvidence(config: AdmissionLiveConfig): Promise<JsonRecord> {
  const { driver, git, exportPath } = await acquireAdmissionLiveResources({
    createDriver: () => createNeo4jDriver(config.neo4jUri, config.neo4jUser, config.neo4jPassword),
    createTemp: () => mkdtemp(resolve(tmpdir(), 'memberry-mem001d2-')),
    getGitState: gitState,
    removeTemp: (path) => rm(path, { recursive: true, force: true }),
  });
  const runSegment = `${Date.now().toString(36)}-${randomUUID().replaceAll('-', '').slice(0, 12)}`.toLowerCase();
  const tenantId = `mem001d2-${runSegment}`;
  const defaultScope = `project:memberry-eval-mem001d2-${runSegment}-default-off`;
  const enabledScope = `project:memberry-eval-mem001d2-${runSegment}-enabled`;
  const scopes = [defaultScope, enabledScope];
  const projectNames = scopes.map((scope) => scope.slice('project:'.length));
  const sessionId = `mem001d2-${runSegment}`;
  const defaultContent = `MEM001D2-${runSegment}-default synthetic admission fixture`;
  const enabledContent = `MEM001D2-${runSegment}-enabled synthetic admission fixture`;
  const invalidContent = `MEM001D2-${runSegment}-invalid synthetic admission fixture`;
  const forbidden = [config.token, config.neo4jPassword, defaultContent, enabledContent, invalidContent];
  let active: ServerProcess | undefined;
  let proof: JsonRecord = {};
  let cleanup: FixtureCounts | undefined;
  let executionFailure: Error | undefined;

  try {
    await driver.getServerInfo();
    active = new ServerProcess(config, false, exportPath, tenantId);
    const defaultReady = assertReadinessContract(await active.waitUntilReady(), false, config.timeoutMs);
    const defaultTransport = new BoundedAdmissionMcpTransport(config);
    const defaultEpisodeId = expectStoreId(await defaultTransport.call('berry_store', {
      session_id: sessionId,
      task: 'MEM-001D2 default-off composition evidence',
      content: defaultContent,
      memory_type: 'general',
      scope: defaultScope,
      tags: [defaultScope, 'evaluation-lab', 'observability'],
    }));
    const defaultCounts = await scopeCounts(driver, tenantId, defaultScope, projectNames[0]!);
    assertFixtureCounts('DEFAULT_OFF', defaultCounts, {
      episodes: 1, observations: 0, projectEntities: 0,
    });
    await active.stop();
    active = undefined;

    active = new ServerProcess(config, true, exportPath, tenantId);
    const enabledReady = assertReadinessContract(await active.waitUntilReady(), true, config.timeoutMs);
    const enabledTransport = new BoundedAdmissionMcpTransport(config);
    const enabledEpisodeId = expectStoreId(await enabledTransport.call('berry_store', {
      session_id: sessionId,
      task: 'MEM-001D2 enabled composition evidence',
      content: enabledContent,
      memory_type: 'general',
      scope: enabledScope,
      tags: [enabledScope, 'evaluation-lab', 'observability'],
    }));
    const observation = await waitForObservation(driver, {
      tenantId,
      projectScope: enabledScope,
      episodeId: enabledEpisodeId,
    });
    const safeProperties = assertContentFreeObservation(observation);
    const beforeDuplicate = await scopeCounts(driver, tenantId, enabledScope, projectNames[1]!);
    const duplicate = await enabledTransport.call('berry_store', {
      session_id: `${sessionId}-duplicate`,
      task: 'MEM-001D2 duplicate composition evidence',
      content: enabledContent,
      memory_type: 'general',
      scope: enabledScope,
      tags: [enabledScope, 'evaluation-lab', 'observability'],
    });
    if (duplicate.trim() !== 'duplicate:true') throw new Error('duplicate store did not report duplicate:true');

    let invalidRejected = false;
    try {
      await enabledTransport.call('berry_store', {
        session_id: `${sessionId}-invalid`,
        task: 'MEM-001D2 invalid store composition evidence',
        content: invalidContent,
        memory_type: 'general',
        scope: enabledScope,
        tags: [enabledScope, 'evaluation-lab', 'observability'],
        signals: [{ type: 'reinforcement', target_id: `non-semantic-${runSegment}`, detail: 'synthetic invalid target' }],
      });
    } catch { invalidRejected = true; }
    if (!invalidRejected) throw new Error('invalid signal target store must fail closed');
    const afterFailures = await scopeCounts(driver, tenantId, enabledScope, projectNames[1]!);
    const enabledExpected = { episodes: 1, observations: 1, projectEntities: 0 } as const;
    assertFixtureCounts('ENABLED_BEFORE_FAILURES', beforeDuplicate, enabledExpected);
    assertFixtureCounts('ENABLED_AFTER_FAILURES', afterFailures, enabledExpected);
    const finalReady = assertReadinessContract(await readiness(config), true, config.timeoutMs, true);
    const counters = record(finalReady.counters, 'readiness.admission_shadow.counters');
    const storedWithinDeadline = counters.appended === 1 && counters.timed_out === 0 && counters.late_appended === 0;
    const storedAfterDeadline = counters.appended === 0 && counters.timed_out === 1 && counters.late_appended === 1;
    if (counters.prepared !== 1 || counters.append_attempts !== 1
      || (!storedWithinDeadline && !storedAfterDeadline)
      || counters.preparation_failures !== 0 || counters.append_failures !== 0
      || counters.capacity_rejected !== 0 || counters.shutdown_skipped !== 0 || counters.late_failures !== 0) {
      throw new Error('enabled readiness counters do not prove exactly one successful sidecar attempt');
    }
    proof = {
      fidelity: 'composition-root / live-disposable-persistence',
      transport: 'streamable-http-mcp',
      defaultOff: {
        scope: { tenantId, projectScope: defaultScope, episodeId: defaultEpisodeId },
        counts: defaultCounts,
        readiness: defaultReady,
        transportProbe: {
          endpointPath: '/mcp',
          readinessPath: '/readyz',
          protocol: 'streamable-http',
          readonlyTool: 'berry_tools:list',
          status: 'passed',
        },
      },
      enabled: {
        scope: { tenantId, projectScope: enabledScope, episodeId: enabledEpisodeId },
        counts: afterFailures,
        observation: safeProperties,
        duplicate: true,
        invalidRejected,
        sidecarDelivery: storedWithinDeadline ? 'stored-within-deadline' : 'stored-after-timeout',
        readinessBefore: enabledReady,
        readinessAfter: finalReady,
        transportProbe: {
          endpointPath: '/mcp',
          readinessPath: '/readyz',
          protocol: 'streamable-http',
          readonlyTool: 'berry_tools:list',
          status: 'passed',
        },
      },
    };
  } catch (error) {
    executionFailure = error instanceof Error ? error : new Error(String(error));
  }

  const cleanupFailures = await runBoundedCleanupSteps([
    {
      name: 'process-stop',
      run: async () => {
        if (!active) return;
        await active.stop();
        active = undefined;
      },
    },
    {
      name: 'graph-cleanup',
      run: async () => {
        await cleanupScopes(driver, tenantId, scopes, projectNames);
        const residuals = await Promise.all(scopes.map((scope, index) =>
          scopeCounts(driver, tenantId, scope, projectNames[index]!)));
        cleanup = residuals.reduce<FixtureCounts>(
          (total, value) => ({
            episodes: total.episodes + value.episodes,
            observations: total.observations + value.observations,
            projectEntities: total.projectEntities + value.projectEntities,
          }),
          { episodes: 0, observations: 0, projectEntities: 0 },
        );
        assertFixtureCounts('CLEANUP', cleanup, {
          episodes: 0, observations: 0, projectEntities: 0,
        });
      },
    },
    { name: 'driver-close', run: () => driver.close() },
    { name: 'temporary-export-remove', run: () => rm(exportPath, { recursive: true, force: true }) },
  ]);
  if (executionFailure || cleanupFailures.length > 0) {
    const failures = [
      ...(executionFailure ? [executionFailure] : []),
      ...cleanupFailures.map(({ name, error }) => new Error(`${name}: ${error.message}`, { cause: error })),
    ];
    throw new AggregateError(failures, failures.map(({ message }) => message).join('; '));
  }

  const evidence = sanitizeAdmissionEvidence({
    schemaVersion: 1,
    packet: 'MEM-001D2',
    generatedAt: new Date().toISOString(),
    git,
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    config: config.safeConfig,
    result: proof,
    cleanup: {
      neo4jFixtureState: cleanup,
      disposableServiceOwnership: 'caller-provided-loopback-services',
      redisContainerTeardown: 'outside-runner-scope',
      neo4jContainerTeardown: 'outside-runner-scope',
      temporaryExportPathRemoved: true,
    },
  }, forbidden) as JsonRecord;
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  for (const excluded of forbidden) {
    if (excluded && serialized.includes(excluded)) throw new Error('sanitized evidence retained an excluded value');
  }
  if (config.evidencePath) {
    await mkdir(dirname(config.evidencePath), { recursive: true });
    await writeFile(config.evidencePath, serialized, 'utf8');
  }
  return evidence;
}

async function main(): Promise<void> {
  const evidence = await runAdmissionLiveCompositionEvidence(resolveAdmissionLiveConfig());
  console.log(JSON.stringify({
    ok: true,
    packet: evidence.packet,
    fidelity: (evidence.result as JsonRecord).fidelity,
    sha: (evidence.git as JsonRecord).sha,
    cleanup: evidence.cleanup,
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
