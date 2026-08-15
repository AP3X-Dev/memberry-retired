// packages/retrieval/src/index.ts

// Types
export type {
  SourceType,
  RetrievalResult,
  RetrievalStrategy,
  RetrievalOptions,
  UnifiedContext,
  ContextSection,
  ContextItem,
  FeedbackSignal,
  BoostFactors,
} from './types.js';

// Query expansion
export { expandQuery } from './expand.js';
export type { ExpandedQuery } from './expand.js';

// Intent classification
export { classifyIntent } from './intent.js';
export type { QueryIntent, IntentResult } from './intent.js';

// Scoring
export {
  scaleRrfK,
  lexicalTextScore,
  normalizeScores,
  computeQueryStats,
  adaptiveWeights,
  inferSourceTypeBoost,
  mmrDiversify,
} from './scoring.js';

// Fusion
export { rrfFusion, dedup } from './fusion.js';

// Deterministic assembly
export { DeterministicAssembler } from './deterministic.js';

// Feedback
export { FeedbackTracker } from './feedback.js';
export type { FeedbackRedisLayer } from './feedback.js';

// Unified assembler
export { UnifiedAssembler } from './assembler.js';
export type { AssemblerCodeLayer, AssemblerMemoryLayer, TracedUnifiedContext } from './assembler.js';

// Versioned, content-free retrieval trace contract (RET-001A)
export {
  RETRIEVAL_TRACE_VERSION,
  RETRIEVAL_TRACE_NUMBER_DECIMALS,
  RetrievalTraceCollector,
  RetrievalTraceValidationError,
  RetrievalTraceLimitError,
  roundTraceNumber,
  canonicalTraceJson,
  validateRetrievalTrace,
  assertRetrievalTraceSecretSafe,
  assertRetrievalTraceConformant,
  computeRetrievalTraceReplayStateDigest,
  replayRetrievalTrace,
} from './trace.js';
export type {
  RetrievalTraceAlgorithmVersion,
  RetrievalTraceSourceType,
  RetrievalTraceChannel,
  RetrievalTraceFilterName,
  RetrievalTraceExclusionReason,
  RetrievalTraceFailureStage,
  RetrievalTraceFailureCode,
  RetrievalTraceTerminalOutcome,
  RetrievalTraceScoreName,
  RetrievalTraceIncompleteReason,
  RetrievalTraceRequestShapeV1,
  RetrievalTraceChannelStateV1,
  RetrievalTraceEvidenceStateV1,
  RetrievalTraceCandidateDraft,
  RetrievalTraceCandidateV1,
  RetrievalTraceCandidateHandle,
  RetrievalTraceFilterEventInput,
  RetrievalTraceScoreEventInput,
  RetrievalTraceChannelSettlement,
  RetrievalTraceTerminalInput,
  RetrievalTraceMmrRecordInput,
  RetrievalTraceMmrPairwiseInput,
  RetrievalTraceMmrPairwiseV1,
  RetrievalTraceMmrRecordV1,
  RetrievalTraceStageEventV1,
  RetrievalTraceTerminalExclusionV1,
  RetrievalTraceV1,
  RetrievalTraceReplayResult,
  RetrievalTraceCollectorOptions,
} from './trace.js';

// MCP tools
export { registerRetrievalTools, setRetrievalServiceInstances, createRetrievalContainer, retrievalContainerForTenant, RETRIEVAL_TOOL_NAMES } from './tools.js';
export type { IUnifiedAssembler, IFeedbackTracker, RetrievalRegisteredTools, RetrievalServiceContainer } from './tools.js';
