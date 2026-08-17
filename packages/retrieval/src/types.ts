// packages/retrieval/src/types.ts
// Unified retrieval types — blending arch + code + memory into one system.

// === Retrieval result (unified across all sources) ===

export type SourceType = 'semantic' | 'episodic' | 'symbol' | 'arch_entity' | 'aspect' | 'fact';

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

// === Unified context (the super-load output) ===

export interface UnifiedContext {
  task: string;
  strategy: RetrievalStrategy;
  sections: ContextSection[];
  token_count: number;
  assembled_at: string;
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
  source_type_boosts: Record<Exclude<SourceType, 'fact'>, number>
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
