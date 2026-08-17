import { Record as Neo4jRecord, type Driver } from 'neo4j-driver';
import { types as nodeUtilTypes } from 'node:util';
import { FactStore } from '@memberry/neo4j';
import type { FactNode } from '@memberry/core';

import {
  CANDIDATE_CHANNEL_CONTRACT_ID,
  CANDIDATE_CHANNEL_CONTRACT_VERSION,
  canonicalCandidateChannelRunnerResultV1,
  executeCandidateChannelsV1,
  type CandidateChannelCandidateV1,
  type CandidateChannelExecutionResultV1,
  type CandidateChannelRequestV1,
  type CandidateChannelRunnerResultV1,
  type CandidateChannelRunnerRosterV1,
  type CandidateChannelSerializedResultV1,
} from './candidate-channel.js';
import { RETRIEVAL_TRACE_CHANNEL_ORDER, type RetrievalTraceChannel } from './trace.js';
import {
  readRuntimeQueryPlannerAuthorityV1,
  type RuntimeQueryPlannerResolvedReceiptV1,
} from './runtime-query-planner.js';

const OWN_KEYS = Reflect.ownKeys;
const GET_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const GET_PROTOTYPE = Object.getPrototypeOf;
const HAS_OWN = Object.hasOwn;
const FREEZE = Object.freeze;
const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_PROTOTYPE = Array.prototype;
const IS_PROXY = nodeUtilTypes.isProxy;
const IS_SAFE_INTEGER = Number.isSafeInteger;
const IS_FINITE = Number.isFinite;
const OBJECT_IS = Object.is;
const REGEXP_EXEC = Function.prototype.call.bind(RegExp.prototype.exec) as (pattern: RegExp, value: string) => RegExpExecArray | null;
const SET_HAS = Function.prototype.call.bind(Set.prototype.has) as (set: Set<string>, value: string) => boolean;
const SET_ADD = Function.prototype.call.bind(Set.prototype.add) as (set: Set<string>, value: string) => Set<string>;
const DEFAULT_TENANT = 'default';
const MAX_ROWS = 64;
const QUERY_TIMEOUT_MS = 2_000;
const CLOSE_TIMEOUT_MS = 500;
const SAFE_TENANT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_PROJECT = /^project:[a-z0-9][a-z0-9._-]*$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/;
const EXPECTED_FIELDS = FREEZE([
  'tenantId', 'projectScope', 'resolvedEntityId', 'evidenceId', 'title', 'content', 'score',
]);

export interface RuntimeCandidateDriver {
  session(config?: unknown): {
    run(query: string, params?: Record<string, unknown>, config?: { timeout: number }): Promise<unknown>;
    beginTransaction(config?: { timeout: number }): {
      run(query: string, params: Record<string, unknown>): Promise<unknown>;
      commit(): Promise<void>;
      rollback(): Promise<void>;
    };
    close(): Promise<void>;
  };
}

export interface RuntimeCandidateExecuteOptions {
  readonly includeArchitecture: boolean;
  readonly includeMemory: boolean;
}

interface ReceiptState {
  readonly tenantId: string;
  readonly projectScope: string;
  readonly resolvedEntityId: string;
  readonly asOf?: string;
}

interface SourceSpec {
  readonly channel: 'memory.scope' | 'arch.entity';
  readonly sourceType: 'semantic' | 'arch_entity';
  readonly query: string;
}

class SourceFailure extends Error {
  constructor(readonly code: 'timeout' | 'query-failed' | 'invalid-result' | 'budget-exceeded') { super(code); }
}

const PROJECT_PROOF = `
CALL {
  MATCH path = (root:Entity {type: 'project'})-[:CONTAINS*0..64]->(target:Entity {id: $entityId})
  WHERE toLower(root.name) = substring($projectScope, 8)
    AND (root.tenant_id = $tenantId OR (root.tenant_id IS NULL AND $tenantId = $defaultTenant))
    AND all(scopedNode IN nodes(path) WHERE
      (scopedNode.tenant_id IS NULL OR scopedNode.tenant_id = $tenantId)
      AND (scopedNode.type <> 'project' OR scopedNode = root))
  WITH DISTINCT path
  LIMIT 2
  RETURN collect(path) AS authorizedPaths
}
WITH authorizedPaths
WHERE size(authorizedPaths) = 1
WITH head(authorizedPaths) AS authorizedPath
WITH head(nodes(authorizedPath)) AS root, last(nodes(authorizedPath)) AS target`;

const COMMON_RETURN = `
RETURN CASE WHEN root.tenant_id IS NULL THEN $defaultTenant ELSE root.tenant_id END AS tenantId,
       'project:' + toLower(root.name) AS projectScope,
       target.id AS resolvedEntityId,
       evidenceId,
       title,
       content,
       score
ORDER BY score DESC, evidenceId ASC
LIMIT $rowLimit`;

const SCOPE_QUERY = `${PROJECT_PROOF}
MATCH (s:Semantic)-[r:ABOUT]->(target)
WHERE (s.tenant_id = $tenantId OR (s.tenant_id IS NULL AND $tenantId = $defaultTenant))
  AND (s.scope = $projectScope OR $projectScope IN coalesce(s.tags, []))
  AND (($asOf IS NULL AND r.invalid_at IS NULL)
    OR ($asOf IS NOT NULL AND coalesce(r.valid_at, '1970-01-01T00:00:00.000Z') <= $asOf
      AND (r.invalid_at IS NULL OR r.invalid_at > $asOf)))
WITH DISTINCT root, target, s.id AS evidenceId,
     coalesce(s.memory_type, 'Semantic') AS title,
     s.content AS content,
     coalesce(s.confidence, 0.0) AS score
${COMMON_RETURN}`;

const ARCH_QUERY = `${PROJECT_PROOF}
WITH root, target, target.id AS evidenceId,
     coalesce(target.name, target.id) AS title,
     coalesce(target.responsibility, target.interface_desc, target.name, target.id) AS content,
     1.0 AS score
${COMMON_RETURN}`;

const SOURCES: readonly SourceSpec[] = FREEZE([
  FREEZE({ channel: 'memory.scope', sourceType: 'semantic', query: SCOPE_QUERY }),
  FREEZE({ channel: 'arch.entity', sourceType: 'arch_entity', query: ARCH_QUERY }),
]);

function ownData(input: object, key: PropertyKey): unknown {
  const descriptor = GET_DESCRIPTOR(input, key);
  if (!descriptor || !HAS_OWN(descriptor, 'value')) throw new SourceFailure('invalid-result');
  return descriptor.value;
}

function safeString(value: unknown, max = 65_536): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) throw new SourceFailure('invalid-result');
  return value;
}

function denseDataArray(input: unknown, expectedLength?: number): readonly unknown[] {
  if (IS_PROXY(input) || !ARRAY_IS_ARRAY(input) || GET_PROTOTYPE(input) !== ARRAY_PROTOTYPE) {
    throw new SourceFailure('invalid-result');
  }
  const length = ownData(input, 'length');
  if (!IS_SAFE_INTEGER(length) || (expectedLength !== undefined && length !== expectedLength)
    || (length as number) > MAX_ROWS + 1 || OWN_KEYS(input).length !== (length as number) + 1) {
    throw new SourceFailure('invalid-result');
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < (length as number); index += 1) snapshot[index] = ownData(input, String(index));
  return FREEZE(snapshot);
}

function parseRecord(input: unknown, state: ReceiptState, spec: SourceSpec, rank: number): CandidateChannelCandidateV1 {
  if (typeof input !== 'object' || input === null || IS_PROXY(input)
    || GET_PROTOTYPE(input) !== Neo4jRecord.prototype
    || OWN_KEYS(input).length !== 4
    || !['keys', 'length', '_fields', '_fieldLookup'].every((key) => HAS_OWN(input, key))
    || ownData(input, 'length') !== EXPECTED_FIELDS.length) throw new SourceFailure('invalid-result');
  const keys = denseDataArray(ownData(input, 'keys'), EXPECTED_FIELDS.length);
  const fields = denseDataArray(ownData(input, '_fields'), EXPECTED_FIELDS.length);
  const lookup = ownData(input, '_fieldLookup');
  if (typeof lookup !== 'object' || lookup === null || IS_PROXY(lookup)
    || GET_PROTOTYPE(lookup) !== Object.prototype || OWN_KEYS(lookup).length !== EXPECTED_FIELDS.length) {
    throw new SourceFailure('invalid-result');
  }
  for (let index = 0; index < EXPECTED_FIELDS.length; index += 1) {
    const key = EXPECTED_FIELDS[index]!;
    if (keys[index] !== key || ownData(lookup, key) !== index) throw new SourceFailure('invalid-result');
  }
  const tenantId = safeString(fields[0], 128);
  const projectScope = safeString(fields[1], 136);
  const resolvedEntityId = safeString(fields[2], 200);
  const evidenceId = safeString(fields[3], 200);
  const title = safeString(fields[4]);
  const content = safeString(fields[5]);
  const score = fields[6];
  if (tenantId !== state.tenantId || projectScope !== state.projectScope
    || resolvedEntityId !== state.resolvedEntityId || REGEXP_EXEC(SAFE_ID, evidenceId) === null
    || typeof score !== 'number' || !IS_FINITE(score) || score < 0 || score > 1 || OBJECT_IS(score, -0)) {
    throw new SourceFailure('invalid-result');
  }
  const temporalFrame = state.asOf === undefined
    ? FREEZE({ mode: 'current' as const })
    : FREEZE({ mode: 'as-of' as const, asOf: state.asOf });
  const provenance = spec.sourceType === 'semantic'
    ? FREEZE({ kind: 'semantic' as const, semanticId: evidenceId })
    : FREEZE({ kind: 'arch_entity' as const, entityId: evidenceId });
  return FREEZE({
    contractId: CANDIDATE_CHANNEL_CONTRACT_ID,
    contractVersion: CANDIDATE_CHANNEL_CONTRACT_VERSION,
    channel: spec.channel,
    tenantId, projectScope, resolvedEntityId, temporalFrame,
    sourceType: spec.sourceType,
    evidenceId, rank, score, title, content, provenance,
  });
}

function parseRows(result: unknown, state: ReceiptState, spec: SourceSpec): readonly CandidateChannelCandidateV1[] {
  if (typeof result !== 'object' || result === null || IS_PROXY(result)) throw new SourceFailure('invalid-result');
  const records = denseDataArray(ownData(result, 'records'));
  if (records.length > MAX_ROWS) throw new SourceFailure('budget-exceeded');
  const candidates: CandidateChannelCandidateV1[] = [];
  let previousScore = Infinity;
  let previousId = '';
  const ids = new Set<string>();
  for (let index = 0; index < records.length; index += 1) {
    const candidate = parseRecord(records[index], state, spec, index + 1);
    if (candidate.score > previousScore
      || (candidate.score === previousScore && previousId !== '' && candidate.evidenceId < previousId)
    || SET_HAS(ids, candidate.evidenceId)) throw new SourceFailure('invalid-result');
    previousScore = candidate.score;
    previousId = candidate.evidenceId;
    SET_ADD(ids, candidate.evidenceId);
    candidates[index] = candidate;
  }
  return FREEZE(candidates);
}

function parseFacts(input: unknown, state: ReceiptState): readonly CandidateChannelCandidateV1[] {
  const batches = denseDataArray(input, 1);
  const facts = denseDataArray(batches[0]);
  if (facts.length > MAX_ROWS) throw new SourceFailure('budget-exceeded');
  const candidates: CandidateChannelCandidateV1[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < facts.length; index += 1) {
    const fact = facts[index];
    if (typeof fact !== 'object' || fact === null || IS_PROXY(fact)
      || GET_PROTOTYPE(fact) !== Object.prototype) throw new SourceFailure('invalid-result');
    const evidenceId = safeString(ownData(fact, 'id'), 200);
    const entityId = ownData(fact, 'entity_id');
    const tenantId = GET_DESCRIPTOR(fact, 'tenant_id') === undefined ? undefined : ownData(fact, 'tenant_id');
    const subject = safeString(ownData(fact, 'subject'));
    const predicate = safeString(ownData(fact, 'predicate'));
    const object = safeString(ownData(fact, 'object'));
    const score = ownData(fact, 'confidence');
    if (entityId !== state.resolvedEntityId || (state.tenantId === DEFAULT_TENANT
      ? tenantId !== undefined && tenantId !== DEFAULT_TENANT : tenantId !== state.tenantId)
      || REGEXP_EXEC(SAFE_ID, evidenceId) === null || SET_HAS(ids, evidenceId)
      || typeof score !== 'number' || !IS_FINITE(score) || score < 0 || score > 1 || OBJECT_IS(score, -0)) {
      throw new SourceFailure('invalid-result');
    }
    SET_ADD(ids, evidenceId);
    candidates[index] = FREEZE({
      contractId: CANDIDATE_CHANNEL_CONTRACT_ID,
      contractVersion: CANDIDATE_CHANNEL_CONTRACT_VERSION,
      channel: 'memory.fact' as const,
      tenantId: state.tenantId,
      projectScope: state.projectScope,
      resolvedEntityId: state.resolvedEntityId,
      temporalFrame: state.asOf === undefined
        ? FREEZE({ mode: 'current' as const })
        : FREEZE({ mode: 'as-of' as const, asOf: state.asOf }),
      sourceType: 'fact' as const,
      evidenceId,
      rank: index + 1,
      score,
      title: 'Fact',
      content: `${subject} ${predicate} ${object}`,
      provenance: FREEZE({ kind: 'fact' as const, factId: evidenceId }),
    });
  }
  return FREEZE(candidates);
}

function failure(channel: RetrievalTraceChannel, code: 'unavailable' | 'timeout' | 'query-failed'): CandidateChannelRunnerResultV1 {
  return Object.freeze({
    contractId: CANDIDATE_CHANNEL_CONTRACT_ID,
    contractVersion: CANDIDATE_CHANNEL_CONTRACT_VERSION,
    channel, outcome: 'safe-failure', code,
  });
}

function success(channel: RetrievalTraceChannel, candidates: readonly CandidateChannelCandidateV1[]): CandidateChannelRunnerResultV1 {
  return Object.freeze({
    contractId: CANDIDATE_CHANNEL_CONTRACT_ID,
    contractVersion: CANDIDATE_CHANNEL_CONTRACT_VERSION,
    channel, outcome: 'success', candidateCount: candidates.length, candidates,
  });
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new SourceFailure('timeout')), timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function overflowSerialized(channel: RetrievalTraceChannel): CandidateChannelSerializedResultV1 {
  return `{"contractId":"${CANDIDATE_CHANNEL_CONTRACT_ID}","contractVersion":"${CANDIDATE_CHANNEL_CONTRACT_VERSION}","channel":"${channel}","outcome":"success","candidateCount":${MAX_ROWS + 1},"candidates":[]}` as CandidateChannelSerializedResultV1;
}

export class RuntimeCandidateChannelService {
  constructor(private readonly driver: RuntimeCandidateDriver) {}

  async execute(
    receipt: RuntimeQueryPlannerResolvedReceiptV1,
    options: RuntimeCandidateExecuteOptions,
  ): Promise<CandidateChannelExecutionResultV1> {
    let authority: ReturnType<typeof readRuntimeQueryPlannerAuthorityV1>;
    try { authority = readRuntimeQueryPlannerAuthorityV1(receipt); }
    catch { throw new Error('candidate_runtime:invalid_receipt'); }
    const state: ReceiptState = Object.freeze({
      tenantId: authority.tenantId,
      projectScope: authority.projectScope,
      resolvedEntityId: authority.resolvedEntityId,
      ...(authority.temporalFrame.mode === 'as-of' ? { asOf: authority.temporalFrame.asOf } : {}),
    });
    const temporalFrame = authority.temporalFrame;
    const request: CandidateChannelRequestV1 = Object.freeze({
      contractId: CANDIDATE_CHANNEL_CONTRACT_ID,
      contractVersion: CANDIDATE_CHANNEL_CONTRACT_VERSION,
      tenantId: state.tenantId,
      projectScope: state.projectScope,
      resolvedEntityIds: Object.freeze([state.resolvedEntityId]),
      temporalFrame,
      plannedChannels: RETRIEVAL_TRACE_CHANNEL_ORDER,
      limits: Object.freeze({ maxCandidatesPerChannel: MAX_ROWS, maxCandidatesAggregate: 128 }),
    });
    const roster: Array<CandidateChannelRunnerRosterV1[number]> = [];
    for (const channel of RETRIEVAL_TRACE_CHANNEL_ORDER) {
      const spec = SOURCES.find((item) => item.channel === channel);
      const isFact = channel === 'memory.fact';
      const enabled = (spec || isFact) && (channel === 'arch.entity' ? options.includeArchitecture : options.includeMemory);
      if ((!spec && !isFact) || !enabled) {
        roster.push(Object.freeze({ channel, run: () => failure(channel, 'unavailable') }));
        continue;
      }
      roster.push(Object.freeze({
        channel,
        run: async (): Promise<CandidateChannelSerializedResultV1> => {
          let result: CandidateChannelRunnerResultV1;
          let session: ReturnType<RuntimeCandidateDriver['session']> | undefined;
          let tx: ReturnType<ReturnType<RuntimeCandidateDriver['session']>['beginTransaction']> | undefined;
          let committed = false;
          let earlier: unknown;
          try {
            let candidates: readonly CandidateChannelCandidateV1[];
            if (isFact) {
              const temporal = state.asOf === undefined
                ? { time_mode: 'current' as const }
                : { time_mode: 'historical' as const, as_of: state.asOf };
              const rawFacts = await new FactStore(this.driver as unknown as Driver)
                .getActiveByEntityIdsBatch([state.resolvedEntityId], temporal, state.tenantId);
              candidates = parseFacts(rawFacts, state);
            } else {
              session = this.driver.session({ defaultAccessMode: 'READ' });
              tx = session.beginTransaction({ timeout: QUERY_TIMEOUT_MS });
              const raw = await bounded(tx.run(spec!.query, {
                tenantId: state.tenantId,
                defaultTenant: DEFAULT_TENANT,
                projectScope: state.projectScope,
                entityId: state.resolvedEntityId,
                asOf: state.asOf ?? null,
                rowLimit: MAX_ROWS + 1,
              }), QUERY_TIMEOUT_MS);
              candidates = parseRows(raw, state, spec!);
              await bounded(tx.commit(), CLOSE_TIMEOUT_MS);
              committed = true;
            }
            result = success(channel, candidates);
          } catch (error) {
            earlier = error;
            const message = error instanceof Error ? error.message : '';
            const code = error instanceof SourceFailure ? error.code
              : message === 'fact_id_batch_overflow' ? 'budget-exceeded'
                : message === 'fact_id_batch_timeout' ? 'timeout' : 'query-failed';
            if (code === 'budget-exceeded') return overflowSerialized(channel);
            result = failure(channel, code === 'invalid-result' ? 'query-failed'
              : code === 'timeout' ? 'timeout' : 'query-failed');
          } finally {
            if (tx && !committed) {
              try { await bounded(tx.rollback(), CLOSE_TIMEOUT_MS); } catch { /* preserve source outcome */ }
            }
            if (session) {
              try { await bounded(session.close(), CLOSE_TIMEOUT_MS); }
              catch (error) {
                if (earlier === undefined) result = failure(
                  channel,
                  error instanceof SourceFailure && error.code === 'timeout' ? 'timeout' : 'query-failed',
                );
              }
            }
          }
          return canonicalCandidateChannelRunnerResultV1(result!, request, channel);
        },
      }));
    }
    return executeCandidateChannelsV1(request, Object.freeze(roster));
  }
}
