import neo4j, { Record as Neo4jRecord, type Driver } from 'neo4j-driver';
import { types as nodeUtilTypes } from 'node:util';
import { FactStore } from '@memberry/neo4j';
import { EMBEDDING_DIM, type FactNode } from '@memberry/core';

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
import {
  applyServedRerankerV1,
  createServedRerankerProviderV1,
} from './served-reranker.js';
import type { RetrievalResult } from './types.js';

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
// Episodic and MemoryBlock writers use Nano ID, whose URL alphabet permits a
// leading "_" or "-". Keep this evidence-only grammar aligned with persisted
// IDs so one valid row cannot fail the entire source channel.
const SAFE_EVIDENCE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._:@/+~-]*$/;
export const EPISODIC_STRUCTURED_INDEX_FLAG = 'MEMBERRY_EPISODIC_STRUCTURED_INDEX_V1';
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
  readonly queryText?: string;
  readonly queryVector?: readonly number[];
}

interface ReceiptState {
  readonly tenantId: string;
  readonly projectScope: string;
  readonly resolvedEntityId: string;
  readonly asOf?: string;
}

interface SourceSpec {
  readonly channel:
    | 'memory.scope' | 'memory.semantic-vector' | 'memory.episodic-vector'
    | 'memory.block' | 'arch.entity';
  readonly sourceType: 'semantic' | 'episodic' | 'block' | 'arch_entity';
  readonly query: string;
  readonly requiresVector?: true;
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
MATCH (s:Semantic)
WHERE (s.tenant_id = $tenantId OR (s.tenant_id IS NULL AND $tenantId = $defaultTenant))
  AND (s.scope = $projectScope OR $projectScope IN coalesce(s.tags, []))
  AND coalesce(s.archived, false) = false
OPTIONAL MATCH (s)-[r:ABOUT]->(target)
WITH root, target, s, r
WHERE (r IS NOT NULL AND (($asOf IS NULL AND r.invalid_at IS NULL)
    OR ($asOf IS NOT NULL AND coalesce(r.valid_at, '1970-01-01T00:00:00.000Z') <= $asOf
      AND (r.invalid_at IS NULL OR r.invalid_at > $asOf))))
  OR (r IS NULL AND target = root
    AND (($asOf IS NULL AND s.invalid_at IS NULL)
      OR ($asOf IS NOT NULL
        AND coalesce(s.valid_at, s.created_at, '1970-01-01T00:00:00.000Z') <= $asOf
        AND (s.invalid_at IS NULL OR s.invalid_at > $asOf))))
WITH DISTINCT root, target, s.id AS evidenceId,
     coalesce(s.memory_type, 'Semantic') AS title,
     s.content AS content,
     coalesce(s.confidence, 0.0) AS score
${COMMON_RETURN}`;

// The project proof and target relationship are evaluated before similarity. This deliberately
// avoids the unsafe shape used by the legacy global vector reader (global top-K followed by
// authorization filtering), where foreign neighbours can starve valid in-scope evidence.
const SEMANTIC_VECTOR_QUERY = `${PROJECT_PROOF}
MATCH (s:Semantic)
WHERE (s.tenant_id = $tenantId OR (s.tenant_id IS NULL AND $tenantId = $defaultTenant))
  AND (s.scope = $projectScope OR $projectScope IN coalesce(s.tags, []))
  AND coalesce(s.archived, false) = false
  AND s.embedding IS NOT NULL
OPTIONAL MATCH (s)-[r:ABOUT]->(target)
WITH root, target, s, r
WHERE (r IS NOT NULL AND (($asOf IS NULL AND r.invalid_at IS NULL)
    OR ($asOf IS NOT NULL AND coalesce(r.valid_at, '1970-01-01T00:00:00.000Z') <= $asOf
      AND (r.invalid_at IS NULL OR r.invalid_at > $asOf))))
  OR (r IS NULL AND target = root
    AND (($asOf IS NULL AND s.invalid_at IS NULL)
      OR ($asOf IS NOT NULL
        AND coalesce(s.valid_at, s.created_at, '1970-01-01T00:00:00.000Z') <= $asOf
        AND (s.invalid_at IS NULL OR s.invalid_at > $asOf))))
WITH DISTINCT root, target, s, vector.similarity.cosine(s.embedding, $queryVector) AS score
WHERE score IS NOT NULL
WITH root, target, s.id AS evidenceId,
     coalesce(s.memory_type, 'Semantic') AS title,
     s.content AS content,
     score
${COMMON_RETURN}`;

const EPISODIC_VECTOR_QUERY = `${PROJECT_PROOF}
MATCH (ep:Episodic)-[r:REFERENCES]->(target)
WHERE (ep.tenant_id = $tenantId OR (ep.tenant_id IS NULL AND $tenantId = $defaultTenant))
  AND (ep.scope = $projectScope OR $projectScope IN coalesce(ep.tags, []))
  AND coalesce(ep.archived, false) = false
  AND ep.embedding IS NOT NULL
  AND coalesce(ep.content, '') <> ''
  AND (($asOf IS NULL AND r.invalid_at IS NULL)
    OR ($asOf IS NOT NULL AND coalesce(r.valid_at, '1970-01-01T00:00:00.000Z') <= $asOf
      AND (r.invalid_at IS NULL OR r.invalid_at > $asOf)))
WITH DISTINCT root, target, ep, vector.similarity.cosine(ep.embedding, $queryVector) AS score
WHERE score IS NOT NULL
WITH root, target, ep.id AS evidenceId,
     coalesce(ep.memory_type, 'Episodic') AS title,
     CASE WHEN coalesce(ep.task, '') = '' THEN ep.content ELSE ep.task + '\n\n' + ep.content END AS content,
     score
${COMMON_RETURN}`;

// IDX-001A: preserve the authorized direct candidate set, then expand only the
// top five episodes that reference the query-planner target. Each seed may add
// one best-scoring active episode through a different, shared canonical Entity.
// This is the zero-regression winner from the frozen 60-case lab gate. Derived
// keys and expanded episodes are re-qualified to the authenticated scope even
// though their parent/seed was already qualified (defence in depth).
const EPISODIC_STRUCTURED_VECTOR_QUERY = `${PROJECT_PROOF}
MATCH (ep:Episodic)-[r:REFERENCES]->(target)
WHERE (ep.tenant_id = $tenantId OR (ep.tenant_id IS NULL AND $tenantId = $defaultTenant))
  AND (ep.scope = $projectScope OR $projectScope IN coalesce(ep.tags, []))
  AND coalesce(ep.archived, false) = false
  AND ep.embedding IS NOT NULL
  AND coalesce(ep.content, '') <> ''
  AND (($asOf IS NULL AND r.invalid_at IS NULL)
    OR ($asOf IS NOT NULL AND coalesce(r.valid_at, '1970-01-01T00:00:00.000Z') <= $asOf
      AND (r.invalid_at IS NULL OR r.invalid_at > $asOf)))
WITH DISTINCT root, target, ep, vector.similarity.cosine(ep.embedding, $queryVector) AS originalScore
OPTIONAL MATCH (ep)-[:HAS_INDEX_KEY]->(key:EpisodicIndexKey)
WHERE key.tenant_id = $tenantId
  AND key.project_scope = $projectScope
  AND key.schema_version = 1
  AND key.embedding IS NOT NULL
WITH root, target, ep, originalScore,
     max(vector.similarity.cosine(key.embedding, $queryVector)) AS keyScore
WITH root, target, ep,
     CASE WHEN keyScore IS NULL OR originalScore >= keyScore THEN originalScore ELSE keyScore END AS score
WHERE score IS NOT NULL
WITH root, target, ep, score
ORDER BY score DESC, ep.id ASC
WITH root, target, collect({ ep: ep, score: score })[0..$rowLimit] AS base
UNWIND range(0, size(base) - 1) AS baseIndex
WITH root, target, baseIndex, base[baseIndex] AS item
CALL {
  WITH item
  RETURN item.ep AS candidate, item.score AS candidateScore
  UNION ALL
  WITH root, target, baseIndex, item
  WITH root, target, baseIndex, item
  WHERE baseIndex < 5
  MATCH (item.ep)-[seedRef:REFERENCES]->(bridge:Entity)<-[neighborRef:REFERENCES]-(neighbor:Episodic)
  WHERE bridge <> target
    AND neighbor <> item.ep
    AND (neighbor.tenant_id = $tenantId
      OR (neighbor.tenant_id IS NULL AND $tenantId = $defaultTenant))
    AND (neighbor.scope = $projectScope OR $projectScope IN coalesce(neighbor.tags, []))
    AND coalesce(neighbor.archived, false) = false
    AND neighbor.embedding IS NOT NULL
    AND coalesce(neighbor.content, '') <> ''
    AND (($asOf IS NULL AND seedRef.invalid_at IS NULL AND neighborRef.invalid_at IS NULL)
      OR ($asOf IS NOT NULL
        AND coalesce(seedRef.valid_at, '1970-01-01T00:00:00.000Z') <= $asOf
        AND (seedRef.invalid_at IS NULL OR seedRef.invalid_at > $asOf)
        AND coalesce(neighborRef.valid_at, '1970-01-01T00:00:00.000Z') <= $asOf
        AND (neighborRef.invalid_at IS NULL OR neighborRef.invalid_at > $asOf)))
  WITH DISTINCT item, neighbor,
       vector.similarity.cosine(neighbor.embedding, $queryVector) AS neighborOriginalScore
  OPTIONAL MATCH (neighbor)-[:HAS_INDEX_KEY]->(neighborKey:EpisodicIndexKey)
  WHERE neighborKey.tenant_id = $tenantId
    AND neighborKey.project_scope = $projectScope
    AND neighborKey.schema_version = 1
    AND neighborKey.embedding IS NOT NULL
  WITH item, neighbor, neighborOriginalScore,
       max(vector.similarity.cosine(neighborKey.embedding, $queryVector)) AS neighborKeyScore
  WITH item, neighbor,
       CASE WHEN neighborKeyScore IS NULL OR neighborOriginalScore >= neighborKeyScore
         THEN neighborOriginalScore ELSE neighborKeyScore END AS neighborScore
  WHERE neighborScore IS NOT NULL
  ORDER BY neighborScore DESC, neighbor.id ASC
  LIMIT 1
  RETURN neighbor AS candidate,
       CASE WHEN neighborScore >= item.score - 0.000001
         THEN neighborScore ELSE item.score - 0.000001 END AS candidateScore
}
WITH root, target, candidate, max(candidateScore) AS score
WITH root, target, candidate.id AS evidenceId,
     candidate AS ep,
     coalesce(ep.memory_type, 'Episodic') AS title,
     CASE WHEN coalesce(ep.task, '') = '' THEN ep.content ELSE ep.task + '\n\n' + ep.content END AS content,
     score
${COMMON_RETURN}`;

const ARCH_QUERY = `${PROJECT_PROOF}
WITH root, target, target.id AS evidenceId,
     coalesce(target.name, target.id) AS title,
     coalesce(target.responsibility, target.interface_desc, target.name, target.id) AS content,
     1.0 AS score
${COMMON_RETURN}`;

// A planner receipt carries no working-session authority, so the candidate path may expose only
// project-scoped, sessionless core blocks. Working blocks remain available through the explicit
// session-bound MemoryBlock tools and can never bleed into an unrelated agent session here.
const BLOCK_QUERY = `${PROJECT_PROOF}
MATCH (b:MemoryBlock {scope: $projectScope})
WHERE (b.tenant_id = $tenantId OR (b.tenant_id IS NULL AND $tenantId = $defaultTenant))
  AND b.tier = 'core'
  AND b.session_id IS NULL
  AND b.id IS NOT NULL
  AND b.content IS NOT NULL
  AND b.content <> ''
WITH DISTINCT root, target, b.id AS evidenceId,
     coalesce(b.name, 'MemoryBlock') AS title,
     b.content AS content,
     0.5 AS score
${COMMON_RETURN}`;

const SOURCES: readonly SourceSpec[] = FREEZE([
  FREEZE({ channel: 'memory.scope', sourceType: 'semantic', query: SCOPE_QUERY }),
  FREEZE({
    channel: 'memory.semantic-vector', sourceType: 'semantic', query: SEMANTIC_VECTOR_QUERY,
    requiresVector: true,
  }),
  FREEZE({
    channel: 'memory.episodic-vector', sourceType: 'episodic', query: EPISODIC_VECTOR_QUERY,
    requiresVector: true,
  }),
  FREEZE({ channel: 'memory.block', sourceType: 'block', query: BLOCK_QUERY }),
  FREEZE({ channel: 'arch.entity', sourceType: 'arch_entity', query: ARCH_QUERY }),
]);

function snapshotQueryVector(input: readonly number[] | undefined): readonly number[] | undefined {
  if (input === undefined) return undefined;
  if (IS_PROXY(input) || !ARRAY_IS_ARRAY(input) || GET_PROTOTYPE(input) !== ARRAY_PROTOTYPE
    || input.length !== EMBEDDING_DIM || OWN_KEYS(input).length !== input.length + 1) {
    throw new Error('candidate_runtime:invalid_query_vector');
  }
  const snapshot: number[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const value = ownData(input, String(index));
    if (typeof value !== 'number' || !IS_FINITE(value) || OBJECT_IS(value, -0)) {
      throw new Error('candidate_runtime:invalid_query_vector');
    }
    snapshot[index] = value;
  }
  return FREEZE(snapshot);
}

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
    || resolvedEntityId !== state.resolvedEntityId || REGEXP_EXEC(SAFE_EVIDENCE_ID, evidenceId) === null
    || typeof score !== 'number' || !IS_FINITE(score) || score < 0 || score > 1 || OBJECT_IS(score, -0)) {
    throw new SourceFailure('invalid-result');
  }
  const temporalFrame = state.asOf === undefined
    ? FREEZE({ mode: 'current' as const })
    : FREEZE({ mode: 'as-of' as const, asOf: state.asOf });
  const provenance = spec.sourceType === 'semantic'
    ? FREEZE({ kind: 'semantic' as const, semanticId: evidenceId })
    : spec.sourceType === 'episodic'
      ? FREEZE({ kind: 'episodic' as const, episodeId: evidenceId })
    : spec.sourceType === 'block'
      ? FREEZE({ kind: 'block' as const, blockId: evidenceId })
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
      || REGEXP_EXEC(SAFE_EVIDENCE_ID, evidenceId) === null || SET_HAS(ids, evidenceId)
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

async function rerankAuthorizedFacts(
  queryText: string | undefined,
  candidates: readonly CandidateChannelCandidateV1[],
): Promise<readonly CandidateChannelCandidateV1[]> {
  if (queryText === undefined || queryText.length === 0 || candidates.length < 2) return candidates;
  if (queryText.length > 5_000) throw new SourceFailure('invalid-result');
  const byId = new Map(candidates.map((candidate) => [candidate.evidenceId, candidate]));
  const results: RetrievalResult[] = candidates.map((candidate) => ({
    id: candidate.evidenceId,
    source_type: 'fact',
    title: candidate.title,
    content: candidate.content,
    score: candidate.score,
    metadata: {},
  }));
  const outcome = await applyServedRerankerV1(queryText, results, createServedRerankerProviderV1());
  if (outcome.outcome !== 'reranked') return candidates;
  return FREEZE(outcome.results.map((result, index) => {
    const candidate = byId.get(result.id);
    if (!candidate) throw new SourceFailure('invalid-result');
    return FREEZE({ ...candidate, rank: index + 1, score: result.score });
  }));
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
    const queryVector = snapshotQueryVector(options.queryVector);
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
      // Six served memory/architecture channels can each contribute up to the sealed per-channel
      // cap. Keep the aggregate within the contract's 512 hard ceiling so a full earlier channel
      // cannot evict a valid later MemoryBlock or architecture settlement merely because it runs
      // later.
      limits: Object.freeze({ maxCandidatesPerChannel: MAX_ROWS, maxCandidatesAggregate: 384 }),
    });
    const roster: Array<CandidateChannelRunnerRosterV1[number]> = [];
    for (const channel of RETRIEVAL_TRACE_CHANNEL_ORDER) {
      const spec = SOURCES.find((item) => item.channel === channel);
      const isFact = channel === 'memory.fact';
      const enabled = (spec || isFact)
        && (!spec?.requiresVector || queryVector !== undefined)
        && (channel === 'arch.entity' ? options.includeArchitecture : options.includeMemory);
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
              candidates = await rerankAuthorizedFacts(options.queryText, parseFacts(rawFacts, state));
            } else {
              session = this.driver.session({ defaultAccessMode: 'READ' });
              tx = session.beginTransaction({ timeout: QUERY_TIMEOUT_MS });
              const sourceQuery = channel === 'memory.episodic-vector'
                && process.env[EPISODIC_STRUCTURED_INDEX_FLAG] === '1'
                ? EPISODIC_STRUCTURED_VECTOR_QUERY
                : spec!.query;
              const raw = await bounded(tx.run(sourceQuery, {
                tenantId: state.tenantId,
                defaultTenant: DEFAULT_TENANT,
                projectScope: state.projectScope,
                entityId: state.resolvedEntityId,
                asOf: state.asOf ?? null,
                // The sealed contract caps every channel at MAX_ROWS. Bound the database query
                // at that cap instead of requesting N+1 and discarding the entire channel when
                // additional authorized rows exist.
                rowLimit: neo4j.int(MAX_ROWS),
                ...(spec!.requiresVector ? { queryVector } : {}),
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
