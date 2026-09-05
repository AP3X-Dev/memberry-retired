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
export { RETRIEVAL_SOURCE_TYPES } from './types.js';

// Query expansion
export { expandQuery } from './expand.js';
export type { ExpandedQuery } from './expand.js';

// Intent classification
export { classifyIntent } from './intent.js';
export type { QueryIntent, IntentResult } from './intent.js';

// Closed, bounded query-planning boundary (RET-002A)
export {
  QUERY_PLAN_CONTRACT_ID,
  QUERY_PLAN_CONTRACT_VERSION,
  QUERY_PLAN_MAX_PROJECT_SCOPES,
  QUERY_PLAN_MAX_HINTS_PER_KIND,
  QUERY_PLAN_MAX_EVIDENCE_NEEDS,
  QUERY_PLAN_MAX_RESOLVED_ENTITY_IDS,
  QUERY_PLAN_INTENTS,
  QUERY_PLAN_EVIDENCE_NEEDS,
  QUERY_PLAN_RESOLUTION_STATES,
  QueryPlanContractError,
  parseQueryPlanV1,
  canonicalQueryPlanV1,
} from './query-plan.js';

export {
  buildRuntimeQueryPlanV1,
  RuntimeQueryPlannerError,
  RUNTIME_QUERY_PLANNER_DENIAL_REASONS_V1,
  readResolverDenialReasonV1,
} from './runtime-query-planner.js';
export type { RuntimeQueryPlannerDenialReasonV1 } from './runtime-query-planner.js';
export type {
  QueryPlanIntentV1,
  QueryPlanEvidenceNeedV1,
  QueryPlanResolutionStateV1,
  QueryPlanAuthorityV1,
  QueryPlanCallerScopesV1,
  QueryPlanTemporalFrameV1,
  QueryPlanTaskHintsV1,
  QueryPlanResolutionV1,
  QueryPlanV1,
  QueryPlanContractErrorCode,
} from './query-plan.js';

// Closed deterministic candidate-channel boundary (RET-003A)
export {
  CANDIDATE_CHANNEL_CONTRACT_ID,
  CANDIDATE_CHANNEL_CONTRACT_VERSION,
  CANDIDATE_CHANNEL_MAX_PLANNED,
  CANDIDATE_CHANNEL_MAX_PER_CHANNEL,
  CANDIDATE_CHANNEL_DEFAULT_AGGREGATE,
  CANDIDATE_CHANNEL_MAX_AGGREGATE,
  CANDIDATE_CHANNEL_MAX_STRING_BYTES,
  CANDIDATE_CHANNEL_MAX_AGGREGATE_STRING_BYTES,
  CANDIDATE_CHANNEL_MAX_SERIALIZED_BYTES,
  CandidateChannelContractError,
  parseCandidateChannelRequestV1,
  canonicalCandidateChannelRequestV1,
  canonicalCandidateChannelRunnerResultV1,
  executeCandidateChannelsV1,
} from './candidate-channel.js';
export type {
  CandidateChannelFailureCodeV1,
  CandidateChannelExplicitFailureCodeV1,
  CandidateChannelTemporalFrameV1,
  CandidateChannelLimitsV1,
  CandidateChannelRequestV1,
  CandidateChannelProvenanceV1,
  CandidateChannelCandidateV1,
  CandidateChannelRunnerResultV1,
  CandidateChannelSerializedResultV1,
  CandidateChannelRunnerV1,
  CandidateChannelRunnerRegistrationV1,
  CandidateChannelRunnerRosterV1,
  CandidateChannelSettlementV1,
  CandidateChannelExecutionResultV1,
  CandidateChannelContractErrorCodeV1,
} from './candidate-channel.js';

// Closed, privacy-preserving calibrated reranker boundary (RET-004A)
export {
  RERANKER_CONTRACT_ID,
  RERANKER_CONTRACT_VERSION,
  RERANKER_MAX_CANDIDATES,
  RERANKER_MAX_QUERY_BYTES,
  RERANKER_MAX_STRING_BYTES,
  RERANKER_MAX_AGGREGATE_STRING_BYTES,
  RERANKER_MAX_RESPONSE_BYTES,
  RERANKER_DEFAULT_TIMEOUT_MS,
  RERANKER_MAX_TIMEOUT_MS,
  RERANKER_BASELINE_REASON,
  RerankerContractError,
  createRerankerProviderV1,
  executeCalibratedRerankV1,
} from './reranker.js';
export type {
  SerializedRerankerProviderRequestV1,
  RerankerCancellationV1,
  RerankCandidateInputV1,
  RerankInputV1,
  RerankerProviderIdentityV1,
  RerankerProviderCandidateV1,
  RerankerProviderRequestV1,
  RerankerProviderRunV1,
  RerankerProviderV1,
  RerankerOptionsV1,
  RerankedCandidateV1,
  RerankerResultV1,
  RerankerContractErrorCodeV1,
} from './reranker.js';
export {
  baselineIdentityRerankerScoreV1,
  createLocalRerankerProviderV1,
  createHttpsRerankerProviderV1,
} from './reranker-providers.js';

// Default-off authority-bound runtime shadow coordinator (RET-004B)
export {
  RERANKER_SHADOW_MAX_ACTIVE,
  RERANKER_SHADOW_SHUTDOWN_DRAIN_MS,
  RERANKER_SHADOW_PROVIDER_IDENTITY,
  RerankerShadowCoordinatorV1,
  resolveRerankerShadowModeV1,
} from './reranker-shadow.js';
export type {
  RerankerShadowModeV1,
  RerankerShadowWorkV1,
  RerankerShadowObservationV1,
  RerankerShadowSnapshotV1,
  RerankerShadowCoordinatorPortV1,
} from './reranker-shadow.js';
export type {
  LocalRerankerScorerV1,
  RerankerHttpsTransportRequestV1,
  RerankerHttpsTransportResponseV1,
  RerankerHttpsTransportV1,
  HttpsRerankerProviderConfigV1,
} from './reranker-providers.js';

// Frozen local served reranker construction surface (RET-010B)
export {
  SERVED_RERANKER_PROVIDER_IDENTITY,
  createServedRerankerProviderV1,
} from './served-reranker.js';
export type {
  ServedRerankerProviderIdentityV1,
  ServedRerankerConstructionV1,
} from './served-reranker.js';

// IDX-004: the code plane's adapter onto that same served reranker.
export { createCodeRerankerV1 } from './code-reranker.js';

// Read-only project/tenant-qualified stable Entity-ID resolution (RET-002B)
export {
  SCOPED_ENTITY_RESOLVER_MAX_RESULTS,
  SCOPED_ENTITY_RESOLVER_MAX_CONTAINMENT_DEPTH,
  SCOPED_ENTITY_RESOLVER_MAX_AUTHORITATIVE_DEPTH,
  SCOPED_ENTITY_RESOLVER_TIMEOUT_MS,
  ProjectScopeResolver,
  ScopedEntityResolver,
  ScopedEntityResolverError,
} from './scoped-entity-resolver.js';
export type {
  ScopedEntityResolverDiagnosticCode,
  ScopedEntityResolverErrorCode,
  ScopedEntityResolutionResultV1,
  ScopedEntityTrustedAuthorityV1,
} from './scoped-entity-resolver.js';

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
export type { AssemblerCodeLayer, AssemblerMemoryLayer, TracedUnifiedContext, RerankerShadowPostDedupObserverV1 } from './assembler.js';

// Versioned, content-free retrieval trace contract (RET-001A)
export {
  RETRIEVAL_TRACE_VERSION,
  RETRIEVAL_TRACE_NUMBER_DECIMALS,
  RETRIEVAL_TRACE_CHANNEL_ORDER,
  RETRIEVAL_TRACE_DETERMINISTIC_OUTPUT_CHANNEL_ORDER_V2,
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
  RetrievalTraceDeterministicOutputChannelV2,
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
  RetrievalTraceRerankerProviderV2,
  RetrievalTraceRerankerCandidateV2,
  RetrievalTraceRerankerBaselineCandidateV2,
  RetrievalTraceRerankerEventV2,
  RetrievalTraceRerankerOutcomeInput,
  RetrievalTraceStageEventV1,
  RetrievalTraceTerminalExclusionV1,
  RetrievalTraceV1,
  RetrievalTraceReplayResult,
  RetrievalTraceCollectorOptions,
} from './trace.js';

// Operator-facing retrieval explanation view (UI-001A)
export {
  RETRIEVAL_EXPLANATION_VIEW_CONTRACT_ID,
  RETRIEVAL_EXPLANATION_VIEW_CONTRACT_VERSION,
  RETRIEVAL_EXPLANATION_TEXT_MAX_UTF8_BYTES,
  RetrievalExplanationViewContractError,
  buildRetrievalExplanationViewV1,
  renderRetrievalExplanationTextV1,
} from './retrieval-explanation-view.js';
export type {
  RetrievalExplanationViewV1,
  RetrievalExplanationViewErrorCode,
  RetrievalExplanationReplayReceiptV1,
} from './retrieval-explanation-view.js';

// Bounded, content-free operator diagnostic for ordinary retrieval (RET-Q-003)
export {
  RETRIEVAL_TRACE_SUMMARY_VERSION,
  RETRIEVAL_TRACE_SUMMARY_MAX_BYTES,
  RETRIEVAL_TRACE_SUMMARY_MAX_RESULTS,
  buildRetrievalTraceSummaryV1,
  serializeRetrievalTraceSummaryV1,
} from './retrieval-trace-summary.js';
export type {
  RetrievalTraceSummaryRequestV1,
  RetrievalTraceSummaryV1,
} from './retrieval-trace-summary.js';

// MCP tools
export { registerRetrievalTools, setRetrievalServiceInstances, createRetrievalContainer, retrievalContainerForTenant, RETRIEVAL_TOOL_NAMES } from './tools.js';
export {
  RetrievalResolutionObservabilityV1,
  getRetrievalResolutionProcessStatusV1,
} from './resolution-observability.js';
export type {
  IUnifiedAssembler,
  IFeedbackTracker,
  RetrievalRegisteredTools,
  RetrievalServiceContainer,
  RuntimeProjectScopeResolver,
  RuntimeScopedEntityResolver,
  RuntimeScopedEntityResolverFactory,
} from './tools.js';
