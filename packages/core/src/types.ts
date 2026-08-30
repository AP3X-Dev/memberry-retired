// Type-only import (erased at runtime) — no import cycle with advisor.ts.
import type { AdvisorRecommendationV1 } from './advisor.js';

// === Node Types ===

/**
 * Durable memory classification supplied at capture time and preserved through
 * consolidation. Optional for backward compatibility with existing graph rows.
 */
export type MemoryType =
  | 'decision'
  | 'pattern'
  | 'convention'
  | 'architecture'
  | 'preference'
  | 'fact'
  | 'general';

export interface EpisodicNode {
  id: string;
  session_id: string;
  agent_id: string;
  task: string;
  content: string;
  embedding?: number[];
  outcome?: 'approved' | 'revised' | 'rejected' | 'abandoned';
  memory_type?: MemoryType;
  signals?: Signal[];
  created_at: string;
  ttl?: number;
  scope?: string;
  tags?: string[];
  /** Tenant this node belongs to (defaults to DEFAULT_TENANT). */
  tenant_id?: string;
  /** MEM-006 reversible lifecycle flag: excluded from retrieval, kept by export/import. */
  archived?: boolean;
}

export interface SemanticNode {
  id: string;
  content: string;
  embedding?: number[];
  confidence: number;
  signal_count: number;
  created_at: string;
  updated_at: string;
  decay_class: 'volatile' | 'stable' | 'permanent';
  memory_type?: MemoryType;
  tags: string[];
  /** Canonical project scope (e.g. "project:amp"). Structural tenancy — enforced in read paths, not advisory. */
  scope?: string;
  /** Tenant this node belongs to (defaults to DEFAULT_TENANT). */
  tenant_id?: string;
  valid_at?: string;
  invalid_at?: string;
  /** MEM-006 reversible lifecycle flag: excluded from retrieval, kept by export/import. */
  archived?: boolean;
}

export interface EntityNode {
  id: string;
  name: string;
  type: string;
  aliases: string[];
  created_at: string;
}

export interface AgentNode {
  id: string;
  name: string;
  type: string;
  created_at: string;
}

export interface ModelNode {
  id: string;
  name: string;
  provider: string;
}

// === Signals ===

export type SignalType = 'reinforcement' | 'correction' | 'contradiction';

export interface Signal {
  type: SignalType;
  target_id: string;
  detail: string;
}

export interface StreamSignal extends Signal {
  source_session: string;
  agent_id: string;
  timestamp: string;
  /** Project scope that emitted the signal. Optional for legacy stream entries. */
  scope?: string;
  /** Tenant that emitted the signal. Missing legacy entries belong to DEFAULT_TENANT. */
  tenant_id?: string;
}

// === LOAD ===

export interface LoadScope {
  task: string;
  entities?: string[];
  /** @internal RET-002C authoritative stable Entity.id lane; not tool-wired. */
  resolvedEntityIds?: unknown;
  tags?: string[];
  max_tokens?: number;
  temporal?: TemporalOptions;
  session_id?: string;
  /** Tenant to scope retrieval to (defaults to DEFAULT_TENANT). */
  tenantId?: string;
  /**
   * Precomputed embedding of `task`, shared by the caller (e.g. the unified
   * assembler embeds the query once and reuses it across intent / code / memory).
   * When present, the vector-search channel uses it instead of re-embedding the
   * task. Excluded from the load cache key (hashScope) — it's derived from `task`.
   */
  queryVector?: number[];
}

export interface MemoryContext {
  markdown: string;
  tokens: number;
  sources: string[];
  assembled_at: string;
}

// === STORE ===

export interface EpisodeInput {
  session_id: string;
  agent_id: string;
  task: string;
  content: string;
  outcome?: 'approved' | 'revised' | 'rejected' | 'abandoned';
  memory_type?: MemoryType;
  signals?: Signal[];
  entities?: string[];
  /** IDX-001A additive retrieval keys; original episode content is never rewritten. */
  facts?: string[];
  /** Entity-bound surface forms. Each entity_id must also appear in entities. */
  aliases?: Array<{ entity_id: string; values: string[] }>;
  model_id?: string;
  scope?: string;
  tags?: string[];
  /** Tenant to write this episode under (defaults to DEFAULT_TENANT). */
  tenantId?: string;
}

// === Consolidation ===

export type ProposalType = 'promote' | 'merge' | 'supersede' | 'decay' | 'reinforce' | 'reclass';

export interface ConsolidationProposal {
  id: string;
  type: ProposalType;
  scope: string;
  affected_ids: string[];
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  score: number;
  created_at: string;
  /** MEM-008 review-queue risk recommendation (metadata only; never read by apply). */
  advisor?: AdvisorRecommendationV1;
}

// === Session ===

export interface SessionState {
  agent_id: string;
  task: string;
  stage: string;
  loaded_memories: string[];
  pending_signals: Signal[];
}

// === Config ===

export interface AMPConfig {
  redis: { url: string };
  neo4j: { uri: string; user: string; password: string };
  embedding: { provider: 'openai'; apiKey: string };
  cache: { defaultTTL: number; contextTTL: number; embeddingTTL: number };
  consolidation: {
    autoApply: boolean;
    signalThreshold: number;
    /**
     * Episodic->Semantic promotion knobs. Omitted keys fall back to the
     * MEMBERRY_PROMOTE_* env vars, then to built-in defaults
     * (see PROMOTE_DEFAULTS in consolidation.ts).
     */
    promote?: {
      /** Episodes that must agree before a claim is proposed. Default 3. */
      minClusterSize?: number;
      /** Cosine similarity for two episodes to share a cluster. Default 0.82. */
      similarityThreshold?: number;
      /** Max promote proposals per run; 0 disables promotion. Default 3. */
      maxPerRun?: number;
      /** Max unpromoted episodes examined per run. Default 200. */
      maxCandidates?: number;
    };
  };
  exportPath: string;
  /** When true, all write paths (store, block mutations) are rejected. Set via MEMBERRY_READONLY. */
  readonly?: boolean;
  /** When true, episode content/task is secret-redacted before persistence. Set via MEMBERRY_REDACT_ON_INGEST. */
  redactOnIngest?: boolean;
  /** Default-off MEM-001 shadow observation wiring; never changes admission. */
  admissionShadow?: { enabled: boolean; timeoutMs: number };
  /**
   * Per-task chat-completion model selection (see packages/core/src/llm.ts).
   * Omitted keys fall back to DEFAULT_MODELS. Sourced from AMP_MODEL_* env vars.
   */
  models?: {
    extraction?: string;
    synthesis?: string;
    dream?: string;
  };
}

// === Embedding ===

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  /**
   * Whether semantic vector search is usable with this provider.
   * `false` signals a degraded/no-key provider whose vectors are meaningless
   * (e.g. all-zeros): callers MUST skip vector queries and fall back to
   * deterministic lexical/fulltext retrieval rather than ranking on noise.
   * `undefined` is treated as available (real providers and test mocks).
   */
  readonly available?: boolean;
}

// === Audit ===

/** A mutation an actor performed, for the append-only audit trail. */
export interface AuditEntry {
  /** Who performed the action (agent/token identity). */
  actor: string;
  /** What happened: store | block_insert | block_replace | block_rewrite | block_promote | block_archive | consolidate | bootstrap | ... */
  action: string;
  /** Project/scope the mutation targeted, if known. */
  scope?: string;
  /** The id of the node/block affected, if known. */
  target_id?: string;
  /** Free-text detail (e.g. block name, task summary). Never include secrets. */
  detail?: string;
}

/** Append-only audit sink. Implementations must never throw into the caller's path. */
export interface AuditSink {
  append(entry: AuditEntry): Promise<void>;
}

// === Injection telemetry ===
//
// Every context injection (load/context/ask/hook) gets logged so retrieval can
// later be judged by observed outcomes instead of voluntary feedback. Phase 0
// of the rebuild ships the schema; Phase 3 wires writes + usage detection.

/** Usage label for an injection, observed after the fact from transcripts. */
export type InjectionUsage = 'unknown' | 'used' | 'ignored' | 'contradicted';

/** One context injection: which memory was handed to an agent, when, for what. */
export interface InjectionLogEntry {
  /** Session the context was injected into, when known. */
  session_id?: string;
  /** Project scope of the load (e.g. "project:amp"). */
  scope?: string;
  /** Task text the context was assembled for. Truncate at the call site. */
  task?: string;
  /** Injected node ids, in rank order (rank = array position). */
  source_ids: string[];
  /** Ranked scores parallel to source_ids, when the channel produces them. */
  scores?: number[];
  /** Total tokens of the injected context. */
  tokens?: number;
  /** Channel that produced the injection: load | context | ask | grep | hook. */
  channel?: string;
  /** Tenant the injection was served under (defaults to DEFAULT_TENANT). */
  tenant_id?: string;
}

/** A persisted injection record, including observed-usage fields. */
export interface InjectionRecord extends InjectionLogEntry {
  id: string;
  injected_at: string;
  usage: InjectionUsage;
  usage_detail?: string;
  usage_observed_at?: string;
}

/** Injection sink. Append is best-effort: never throws into the caller's path. */
export interface InjectionSink {
  /** Returns the new record id, or null when the append failed (best-effort). */
  append(entry: InjectionLogEntry): Promise<string | null>;
}

export interface ExtractionProvider {
  extractAll(content: string): Promise<{
    entities: Array<{ name: string; type?: string; description?: string }>;
    claims: Array<{ content: string; about: string[]; confidence: number; tags: string[] }>;
  }>;
}

// === Signal weights ===

export const SIGNAL_WEIGHTS: Record<SignalType, number> = {
  correction: 5.0,
  contradiction: 3.0,
  reinforcement: 1.0,
};

export const RECENCY_DECAY_DAYS = 7;

/**
 * Tenant a request/node belongs to. Multi-tenancy is OPT-IN: when no tenants are
 * configured, everything is this single implicit tenant and behavior is
 * unchanged. Legacy nodes with no `tenant_id` are treated as the default tenant,
 * so enabling tenancy requires no data migration. See SECURITY.md / THREAT-MODEL.md.
 */
export const DEFAULT_TENANT = 'default';

/** Default embedding dimension (OpenAI text-embedding-3-small). */
export const DEFAULT_EMBEDDING_DIM = 1536;

function resolveEmbeddingDim(): number {
  const raw = process.env['MEMBERRY_EMBEDDING_DIM'] ?? process.env['AMP_EMBEDDING_DIM'];
  if (!raw) return DEFAULT_EMBEDDING_DIM;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 8 || n > 12288) {
    console.error(
      `[memberry] Ignoring invalid MEMBERRY_EMBEDDING_DIM="${raw}" ` +
      `(must be an integer in 8..12288); using ${DEFAULT_EMBEDDING_DIM}.`,
    );
    return DEFAULT_EMBEDDING_DIM;
  }
  return n;
}

/**
 * Embedding dimension used across all Neo4j vector indexes.
 * Defaults to 1536 (text-embedding-3-small); override with MEMBERRY_EMBEDDING_DIM
 * to pin a deployment to a different model (e.g. 3072 for text-embedding-3-large).
 * Changing this requires recreating the vector indexes — verifySchema() detects drift.
 */
export const EMBEDDING_DIM = resolveEmbeddingDim();
// === Temporal Facts ===

export type FactStatus = 'active' | 'invalidated' | 'disputed' | 'tentative';
export type FactScope = 'user' | 'project' | 'repo' | 'agent' | 'session';

/**
 * How a fact came to be known:
 *   deductive — explicitly stated or directly derived (the default; explicit capture)
 *   inductive — generalized from patterns across episodes (consolidation-minted)
 *   abductive — a best-guess hypothesis (dream-minted; low confidence, to be confirmed/killed)
 */
export type InferenceType = 'deductive' | 'inductive' | 'abductive';

export interface FactNode {
  id: string;
  subject: string;
  predicate: string;
  original_predicate?: string;   // preserved when normalization changed the predicate
  object: string;
  entity_id: string | null;      // canonical Entity.id — primary lookup key
  source_episode_ids: string[];
  valid_at: string;
  invalid_at: string | null;
  confidence: number;
  status: FactStatus;
  /** Provenance of the claim. Defaults to 'deductive' when absent (legacy rows). */
  inference_type?: InferenceType;
  supersedes_fact_id: string | null;
  scope: FactScope;
  embedding?: number[];
  tags: string[];
  created_at: string;
  updated_at: string;
  /** Tenant this fact belongs to (defaults to DEFAULT_TENANT). */
  tenant_id?: string;
}

export interface FactInput {
  subject: string;
  predicate: string;
  object: string;
  source_episode_ids: string[];
  valid_at?: string;
  confidence?: number;
  inference_type?: InferenceType;
  scope?: FactScope;
  tags?: string[];
}

export interface TemporalOptions {
  time_mode?: 'current' | 'historical' | 'interval' | 'evolution';
  as_of?: string;
  from?: string;
  to?: string;
  include_invalidated?: boolean;
}

export interface FactDiff {
  entity: string;
  from: string;
  to: string;
  added: FactNode[];
  invalidated: FactNode[];
  changed: Array<{ before: FactNode; after: FactNode }>;
}

export interface FactTimeline {
  entity: string;
  facts: Array<FactNode & { event: 'created' | 'invalidated' | 'disputed' | 'superseded'; at: string }>;
}

// === Memory Tiers ===

export type MemoryTier = 'core' | 'working' | 'archive';

export interface MemoryBlock {
  id: string;
  name: string;
  tier: MemoryTier;
  content: string;
  scope: string;
  agent_id?: string;
  session_id?: string;
  max_tokens?: number;
  created_at: string;
  updated_at: string;
  /** Tenant this block belongs to (defaults to DEFAULT_TENANT). */
  tenant_id?: string;
}

export interface MemoryBlockInput {
  name: string;
  tier: MemoryTier;
  content: string;
  scope: string;
  agent_id?: string;
  session_id?: string;
  max_tokens?: number;
}

export const DEFAULT_BLOCKS: Array<{ name: string; tier: MemoryTier; description: string }> = [
  { name: 'persona', tier: 'core', description: 'Agent identity and capabilities' },
  { name: 'user', tier: 'core', description: 'User profile, preferences, role' },
  { name: 'current_objective', tier: 'core', description: 'What the agent is working on' },
  { name: 'working_state', tier: 'working', description: 'Scratchpad, partial results, current branch' },
  { name: 'project_state', tier: 'core', description: 'Project conventions, active decisions' },
  { name: 'open_questions', tier: 'working', description: 'Unresolved items needing attention' },
  // Machine-owned, auto-regenerated by the dream pass (see dream.ts refreshCards).
  // Kept separate from the human-authored `user`/`project_state` blocks so the
  // dream pass never clobbers human content.
  { name: 'project_card', tier: 'core', description: 'Auto-generated compact project summary (dream-refreshed)' },
  { name: 'user_card', tier: 'core', description: 'Auto-generated compact user summary (dream-refreshed)' },
];

/** Machine-owned core blocks that the dream pass regenerates. Rendered after human blocks. */
export const CARD_BLOCK_NAMES = ['project_card', 'user_card'] as const;
