/**
 * Content-free structural observations shared by retrieval-producing packages.
 *
 * @internal These records may carry private graph identifiers while in-process.
 * They are an instrumentation seam, not a public trace or persistence format.
 * Only @memberry/retrieval may translate them into bounded local trace refs.
 */
export type InternalRetrievalChannel =
  | 'memory.scope' | 'memory.semantic-vector' | 'memory.episodic-vector' | 'memory.fact'
  | 'memory.block' | 'memory.graph' | 'code.fulltext' | 'code.lexical-vector'
  | 'code.dense-vector' | 'code.semantic-vector' | 'arch.fulltext';

export type InternalRetrievalFailureCode = 'unavailable' | 'timeout' | 'query-failed' | 'invalid-result';

export type InternalRetrievalChannelObservation =
  | { channel: InternalRetrievalChannel; outcome: 'success' }
  | { channel: InternalRetrievalChannel; outcome: 'safe-failure'; code: InternalRetrievalFailureCode };

export interface InternalRetrievalCandidateChannel {
  channel: InternalRetrievalChannel;
  rank: number;
  score?: number;
}

export interface InternalRetrievalCandidateObservation {
  /** Private join handle. Runtime adapters must never serialize this value. */
  privateId: string;
  sourceType: 'semantic' | 'episodic' | 'symbol' | 'arch_entity' | 'aspect' | 'fact' | 'block';
  channels: InternalRetrievalCandidateChannel[];
  evidence: {
    confidence?: number;
    sourceCount?: number;
    superseded?: boolean;
    invalidated?: boolean;
  };
  estimatedTokens: number;
}

export interface InternalRetrievalObservation {
  channels: InternalRetrievalChannelObservation[];
  candidates: InternalRetrievalCandidateObservation[];
  /** Private IDs in the exact order returned by the producing layer. */
  finalIds: string[];
}

export interface InternallyObserved<T> {
  value: T;
  observation: InternalRetrievalObservation;
}

/** @internal Carries settled structural accounting when the standard value fails. */
export class InternalObservedRetrievalError extends Error {
  constructor(
    readonly observation: InternalRetrievalObservation,
    options?: { cause?: unknown },
  ) {
    super('internal observed retrieval failed', options);
    this.name = 'InternalObservedRetrievalError';
  }
}
