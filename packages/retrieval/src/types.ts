// packages/retrieval/src/types.ts
// Unified retrieval types — blending arch + code + memory into one system.

// === Retrieval result (unified across all sources) ===

export const RETRIEVAL_SOURCE_TYPES = Object.freeze([
  'semantic', 'episodic', 'symbol', 'arch_entity', 'aspect', 'fact', 'block',
] as const);

export type SourceType = typeof RETRIEVAL_SOURCE_TYPES[number];

export interface RetrievalResult {
  id: string;
  source_type: SourceType;
  title: string;
  content: string;
  score: number;
  metadata: Record<string, unknown>;
}

// === Retrieval strategies ===

export type RetrievalStrategy = 'auto' | 'ranked' | 'deterministic';

export interface RetrievalOptions {
  strategy: RetrievalStrategy;
  include_code: boolean;
  include_arch: boolean;
  include_memory: boolean;
  max_tokens: number;
  entity_scope?: string[];
  tag_scope?: string[];
  project_name?: string;
  as_of?: string;
}

// === Code-plane status (COD-010 fail-loud) ===

export type CodePlaneUnsupportedReason =
  | 'code-layer-missing'     // no code layer wired
  | 'tenant-scope'           // non-default tenant: Symbol nodes are not tenant-stamped
  | 'stable-id-lane'         // resolved-entity stable-ID lane bypasses search channels
  | 'deterministic-strategy' // deterministic assembly has no code channel
  | 'candidate-channel';     // candidate runtime composes memory/arch only

export interface CodePlaneStatusV1 {
  readonly outcome: 'served' | 'no-results' | 'unsupported' | 'failed';
  readonly reason?: CodePlaneUnsupportedReason | 'query-failed' | 'invalid-result' | 'budget-evicted';
  readonly results?: number;    // DELIVERED symbol items (K) — what the response actually contains
  readonly candidates?: number; // channel rows before dedup/rerank/budget (N)
}

// === Unified context (the super-load output) ===

export interface UnifiedContext {
  task: string;
  strategy: RetrievalStrategy;
  sections: ContextSection[];
  token_count: number;
  assembled_at: string;
  // Present exactly when the caller requested code (include_code true after
  // defaulting): why the response does or does not contain code evidence.
  code_plane?: CodePlaneStatusV1;
}

export interface ContextSection {
  heading: string;
  source_type: SourceType;
  items: ContextItem[];
}

export interface ContextItem {
  id: string;
  content: string;
  score: number;
  metadata: Record<string, unknown>;
}

// === Feedback ===

export interface FeedbackSignal {
  query: string;
  result_id: string;
  source_type: SourceType;
  was_useful: boolean;
  session_id: string;
  timestamp: string;
}

export interface BoostFactors {
  entity_boosts: Record<string, number>;
  source_type_boosts: Record<Exclude<SourceType, 'fact' | 'block'>, number>
    & Partial<Record<SourceType, number>>;
}

// === Query analysis ===

export interface QueryStats {
  totalTokens: number;
  identifierDensity: number;
  avgTokenLen: number;
  narrativeHint: boolean;
  graphHint: boolean;
}

export interface AdaptiveWeights {
  denseWeight: number;
  lexicalVectorWeight: number;
  lexicalTextWeight: number;
}
