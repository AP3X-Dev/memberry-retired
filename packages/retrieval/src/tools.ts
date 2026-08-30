// packages/retrieval/src/tools.ts
// The berry_context MCP tool — unified super-load.

import { z } from 'zod';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { Driver } from 'neo4j-driver';
import { DEFAULT_TENANT } from '@memberry/core';
import type { UnifiedContext, RetrievalStrategy } from './types.js';
import { types as nodeUtilTypes } from 'node:util';
import type { RetrievalTraceV1 } from './trace.js';
import type { QueryPlanV1 } from './query-plan.js';
import {
  ScopedEntityResolver,
  type ScopedEntityResolutionResultV1,
  type ScopedEntityTrustedAuthorityV1,
} from './scoped-entity-resolver.js';
import {
  buildRuntimeQueryPlannerReceiptV1,
  readRuntimeQueryPlannerAuthorityV1,
  resolveRuntimeQueryPlannerAuthorityV1,
  RuntimeQueryPlannerError,
  type RuntimeQueryPlannerResolvedReceiptV1,
} from './runtime-query-planner.js';
import {
  assertRetrievalTraceConformant,
  canonicalTraceJson,
  replayRetrievalTrace,
} from './trace.js';
import {
  RuntimeCandidateChannelService,
  type RuntimeCandidateDriver,
  type RuntimeCandidateExecuteOptions,
} from './runtime-candidate-channel.js';
import type { CandidateChannelExecutionResultV1 } from './candidate-channel.js';
import { askRetrievalTokenBudget, type ServedMultihopProbeV1 } from './assembler.js';
import {
  buildRetrievalExplanationViewV1,
  renderRetrievalExplanationTextV1,
} from './retrieval-explanation-view.js';
import type { RerankerShadowCoordinatorPortV1 } from './reranker-shadow.js';
import type { RetrievalResult } from './types.js';
import {
  observeRetrievalResolutionV1,
  recordRetrievalCallV1,
  recordRetrievalResolutionFailureV1,
  type RetrievalRoutingShapeV1,
} from './resolution-observability.js';

// ─── Service interface (injected) ────────────────────────────────────────────

export interface IUnifiedAssembler {
  readonly servedRerankerEnabled?: boolean;
  candidateQueryVector?(task: string): Promise<number[] | undefined>;
  assemble(task: string, options?: {
    strategy?: RetrievalStrategy;
    include_code?: boolean;
    include_arch?: boolean;
    include_memory?: boolean;
    max_tokens?: number;
    entity_scope?: string[];
    tag_scope?: string[];
    project_name?: string;
    as_of?: string;
    tenantId?: string;
    resolvedEntityIds?: unknown;
    servedRerankerDisabled?: true;
  }): Promise<UnifiedContext>;
  assembleTraced(task: string, options?: {
    strategy?: RetrievalStrategy;
    include_code?: boolean;
    include_arch?: boolean;
    include_memory?: boolean;
    max_tokens?: number;
    entity_scope?: string[];
    tag_scope?: string[];
    project_name?: string;
    as_of?: string;
    tenantId?: string;
    resolvedEntityIds?: unknown;
    servedRerankerDisabled?: true;
  }): Promise<{ context: UnifiedContext; trace: RetrievalTraceV1 }>;
  renderMarkdown(ctx: UnifiedContext): string;
  ask(question: string, options?: {
    level?: 'minimal' | 'low' | 'medium' | 'high' | 'max';
    entity_scope?: string[];
    tag_scope?: string[];
    project_name?: string;
    as_of?: string;
    tenantId?: string;
    resolvedEntityIds?: unknown;
  }): Promise<{
    answer: string;
    cited_ids: string[];
    evidence: Array<{ id: string; content: string }>;
    level: string;
  }>;
  askFromContext?(question: string, context: UnifiedContext, level?: 'minimal' | 'low' | 'medium' | 'high' | 'max'): Promise<{
    answer: string;
    cited_ids: string[];
    evidence: Array<{ id: string; content: string }>;
    level: string;
  }>;
  assembleCandidateExecution?(
    task: string,
    execution: CandidateChannelExecutionResultV1,
    maxTokens: number,
    includeArchitecture: boolean,
    includeMemory: boolean,
    traced?: boolean,
    postDedupObserver?: (candidates: readonly RetrievalResult[]) => void,
  ): { context: UnifiedContext; trace?: RetrievalTraceV1 };
  assembleCandidateExecutionServed?(
    task: string,
    execution: CandidateChannelExecutionResultV1,
    maxTokens: number,
    includeArchitecture: boolean,
    includeMemory: boolean,
    traced?: boolean,
    multihopProbe?: ServedMultihopProbeV1,
    options?: { includeCode?: boolean },
  ): Promise<{ context: UnifiedContext; trace?: RetrievalTraceV1 }>;
}

export interface IRuntimeCandidateChannelService {
  execute(receipt: RuntimeQueryPlannerResolvedReceiptV1, options: RuntimeCandidateExecuteOptions): Promise<CandidateChannelExecutionResultV1>;
}

export interface IFeedbackTracker {
  recordFeedback(signal: {
    query: string;
    result_id: string;
    source_type: string;
    was_useful: boolean;
    session_id: string;
    timestamp: string;
  }, tenantId?: string): Promise<void>;
}

// ─── Service container ────────────────────────────────────────────────────────
//
// The tool layer depends on a single typed container of services rather than a
// scatter of module-level singletons. A process-default container backs the
// legacy setRetrievalServiceInstances() injection point, while
// registerRetrievalTools() also accepts an explicit container — the seam that
// makes per-session / multi-tenant service isolation possible without process
// globals.

export interface RetrievalServiceContainer {
  assembler: IUnifiedAssembler | null;
  feedbackTracker: IFeedbackTracker | null;
  /** Tenant this container's tools are bound to. Threaded into every assemble/ask. */
  tenantId: string;
  /** Explicit request authentication eligibility. Never inferred from tenantId. */
  authenticated: boolean;
  /** Process-captured, exact default-off RET-002C2 feature switch. */
  queryPlannerEnabled: boolean;
  resolverFactory: RuntimeScopedEntityResolverFactory | null;
  /** Process-captured exact-default-off RET-003B switch. */
  candidateChannelEnabled: boolean;
  candidateRuntime: IRuntimeCandidateChannelService | null;
  /** Process-global RET-004B capacity coordinator, shared by all tenant containers. */
  rerankerShadowCoordinator: RerankerShadowCoordinatorPortV1 | null;
  /** Process-captured exact-default-off RET-007 v4 switch (MEMBERRY_MULTIHOP_EXPANSION_V1). */
  multihopExpansionEnabled: boolean;
}

export interface RuntimeScopedEntityResolver {
  resolve(plan: QueryPlanV1): Promise<ScopedEntityResolutionResultV1>;
}

export type RuntimeScopedEntityResolverFactory = (
  authority: ScopedEntityTrustedAuthorityV1,
) => RuntimeScopedEntityResolver;

/** Build a container, defaulting any service not supplied to null. */
export function createRetrievalContainer(partial: Partial<RetrievalServiceContainer> = {}): RetrievalServiceContainer {
  return {
    assembler: partial.assembler ?? null,
    feedbackTracker: partial.feedbackTracker ?? null,
    tenantId: partial.tenantId ?? DEFAULT_TENANT,
    authenticated: partial.authenticated ?? false,
    queryPlannerEnabled: partial.queryPlannerEnabled ?? false,
    resolverFactory: partial.resolverFactory ?? null,
    candidateChannelEnabled: partial.candidateChannelEnabled ?? false,
    candidateRuntime: partial.candidateRuntime ?? null,
    rerankerShadowCoordinator: partial.rerankerShadowCoordinator ?? null,
    multihopExpansionEnabled: partial.multihopExpansionEnabled ?? false,
  };
}

/** Process-default container, populated by setRetrievalServiceInstances() at bootstrap. */
const defaultContainer: RetrievalServiceContainer = createRetrievalContainer();
const tenantCandidateRuntimes = new Map<string, IRuntimeCandidateChannelService>();
const tenantResolverFactories = new Map<string, RuntimeScopedEntityResolverFactory>();

/** A retrieval container bound to a tenant, reusing the shared assembler. */
export function retrievalContainerForTenant(tenantId: string, authenticated = false): RetrievalServiceContainer {
  return {
    ...defaultContainer,
    tenantId,
    authenticated,
    candidateRuntime: tenantCandidateRuntimes.get(tenantId) ?? defaultContainer.candidateRuntime,
    resolverFactory: tenantResolverFactories.get(tenantId) ?? defaultContainer.resolverFactory,
  };
}

/** Bind a physically isolated tenant's candidate reads and resolver to one driver. */
function setRetrievalTenantCandidateDriver(tenantId: string, driver: Driver & RuntimeCandidateDriver): void {
  tenantCandidateRuntimes.set(tenantId, new RuntimeCandidateChannelService(driver));
  tenantResolverFactories.set(tenantId, (authority) => {
    const resolver = new ScopedEntityResolver(driver, authority);
    return { resolve: (plan) => resolver.resolve(plan) };
  });
}

export function setRetrievalServiceInstances(services: {
  assembler: IUnifiedAssembler;
  feedbackTracker: IFeedbackTracker;
  queryPlannerEnabled?: boolean;
  resolverFactory?: RuntimeScopedEntityResolverFactory;
  candidateChannelEnabled?: boolean;
  candidateRuntime?: IRuntimeCandidateChannelService;
  rerankerShadowCoordinator?: RerankerShadowCoordinatorPortV1 | null;
  candidateDriver?: RuntimeCandidateDriver;
  tenantCandidateDrivers?: ReadonlyMap<string, Driver & RuntimeCandidateDriver>;
  multihopExpansionEnabled?: boolean;
}): void {
  // Full reset of the default container (a service omitted from `services` is
  // cleared), mirroring packages/mcp/src/tools.ts setServiceInstances().
  defaultContainer.assembler = services.assembler ?? null;
  defaultContainer.feedbackTracker = services.feedbackTracker ?? null;
  defaultContainer.queryPlannerEnabled = services.queryPlannerEnabled ?? false;
  defaultContainer.resolverFactory = services.resolverFactory ?? null;
  defaultContainer.candidateChannelEnabled = services.candidateChannelEnabled ?? false;
  defaultContainer.candidateRuntime = services.candidateRuntime
    ?? (services.candidateDriver ? new RuntimeCandidateChannelService(services.candidateDriver) : null);
  defaultContainer.rerankerShadowCoordinator = services.rerankerShadowCoordinator ?? null;
  defaultContainer.multihopExpansionEnabled = services.multihopExpansionEnabled ?? false;
  tenantCandidateRuntimes.clear();
  tenantResolverFactories.clear();
  if (services.tenantCandidateDrivers) {
    for (const [tenantId, driver] of services.tenantCandidateDrivers) {
      setRetrievalTenantCandidateDriver(tenantId, driver);
    }
  }
}

// ─── Tool names ──────────────────────────────────────────────────────────────

export const RETRIEVAL_TOOL_NAMES = ['berry_context', 'berry_ask', 'berry_feedback'] as const;

function textContent(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text' as const, text }] };
}

function candidateShadowObserver(
  coordinator: RerankerShadowCoordinatorPortV1 | null,
  receipt: RuntimeQueryPlannerResolvedReceiptV1,
  execution: CandidateChannelExecutionResultV1,
  query: string,
): ((candidates: readonly RetrievalResult[]) => void) | undefined {
  if (!coordinator) return undefined;
  return (candidates) => {
    try {
      coordinator.trySchedule(() => ({ receipt, execution, query, candidates }));
    } catch {
      // Shadow scheduling never changes the baseline response or error surface.
    }
  };
}

function fixedPlannerFailure(code: RuntimeQueryPlannerError['code']): RuntimeQueryPlannerError {
  return new RuntimeQueryPlannerError(code);
}

function ownDataValue(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    || descriptor.enumerable !== true) throw fixedPlannerFailure('resolution_failed');
  return descriptor.value;
}

function oneResolvedEntityId(input: unknown): readonly [string] {
  try {
    if (typeof input !== 'object' || input === null || nodeUtilTypes.isProxy(input)
      || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype
      || Reflect.ownKeys(input).length !== 2) throw fixedPlannerFailure('resolution_failed');
    const resolution = ownDataValue(input, 'resolution');
    const diagnostics = ownDataValue(input, 'diagnostics');
    if (typeof diagnostics !== 'object' || diagnostics === null || nodeUtilTypes.isProxy(diagnostics)
      || !Array.isArray(diagnostics) || Object.getPrototypeOf(diagnostics) !== Array.prototype
      || Reflect.ownKeys(diagnostics).length !== 1) {
      throw fixedPlannerFailure('resolution_failed');
    }
    const diagnosticsLength = Object.getOwnPropertyDescriptor(diagnostics, 'length');
    if (!diagnosticsLength || !Object.prototype.hasOwnProperty.call(diagnosticsLength, 'value')
      || diagnosticsLength.value !== 0) throw fixedPlannerFailure('resolution_failed');
    if (typeof resolution !== 'object' || resolution === null || nodeUtilTypes.isProxy(resolution)
      || Array.isArray(resolution) || Object.getPrototypeOf(resolution) !== Object.prototype
      || Reflect.ownKeys(resolution).length !== 2
      || ownDataValue(resolution, 'state') !== 'resolved') {
      throw fixedPlannerFailure('resolution_failed');
    }
    const ids = ownDataValue(resolution, 'canonicalEntityIds');
    if (typeof ids !== 'object' || ids === null || nodeUtilTypes.isProxy(ids)
      || !Array.isArray(ids) || Object.getPrototypeOf(ids) !== Array.prototype) {
      throw fixedPlannerFailure('resolution_failed');
    }
    const length = Object.getOwnPropertyDescriptor(ids, 'length');
    const id = Object.getOwnPropertyDescriptor(ids, '0');
    if (!length || length.value !== 1 || Reflect.ownKeys(ids).length !== 2
      || !id || !Object.prototype.hasOwnProperty.call(id, 'value') || id.enumerable !== true
      || typeof id.value !== 'string' || id.value.length < 1 || id.value.length > 200
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id.value)) {
      throw fixedPlannerFailure('resolution_failed');
    }
    return Object.freeze([id.value]) as readonly [string];
  } catch (error) {
    if (error instanceof RuntimeQueryPlannerError) throw error;
    throw fixedPlannerFailure('resolution_failed');
  }
}

/**
 * RL-018 — is this request anchorable by the runtime query planner at all?
 *
 * The planner resolves to EXACTLY ONE entity (`runtime-candidate-channel.ts:328` pins
 * `resolvedEntityIds: [state.resolvedEntityId]`, and every channel query is parameterised on it).
 * A caller who names no entity is asking an ordinary open question, not sending a malformed
 * request: 5 of the 13 real mined `berry_context` calls carry no `entity_scope` (4 of those
 * still carry a project, 1 carries neither). Before this, every one of them was unanswerable —
 * `runtime_query_planner:invalid_request` on both tools.
 *
 * Unanchored requests take the task-text path instead. That is not a degraded mode: it is the
 * same path both tools take with the planner flag off, it still honours `entity_scope` and
 * `project_name` as ordinary filters, and it KEEPS the episodic vector channel that the
 * resolved-id lane disables (`core/service.ts:1284-1291`).
 *
 * ABSENT, NEVER INVALID — and the ONLY thing that counts as absent is the entity anchor.
 *
 * This predicate deliberately does NOT also require `project_name`, and the first version of it
 * did. That was a real defect, caught in review: requiring both made the predicate an AND, so a
 * caller could name an entity, omit `project_name`, and convert an entity-anchored request into
 * an unvalidated task-text sweep — skipping `SAFE_HINT` and `RESERVED_AUTHORITY_HINT` on their
 * own `entity_scope`. That is precisely the shape-your-request-to-weaken-the-path class as the
 * authentication bypass below, and it also contradicted every prose description of the routing.
 *
 * So: entity supplied → the planner judges the whole request, including the missing project,
 * which `buildRuntimeQueryPlannerReceiptV1` rejects as `invalid_request`. That shape appears in
 * ZERO of the 13 mined calls, so nothing real regresses, and a caller who names an entity gets a
 * loud error rather than a silently different engine. An explicitly empty array counts as absent;
 * anything else present is the planner's to judge.
 *
 * Tenant note: the task-text path opens no exposure the candidate path closed. It gates the code
 * plane on `isDefaultTenant` itself (`assembler.ts:1036`, `:1105`), so a named tenant gets the
 * same `code_plane: tenant-scope` either way.
 */
function plannerAnchored(args: { entity_scope?: unknown }): boolean {
  const scope = args.entity_scope;
  return scope !== undefined && !(Array.isArray(scope) && scope.length === 0);
}

function retrievalRoutingShape(
  anchored: boolean,
  resolverEnabled: boolean,
): RetrievalRoutingShapeV1 {
  if (!anchored) return 'unanchored';
  return resolverEnabled ? 'anchored-resolver' : 'anchored-legacy';
}

/**
 * RL-018 — anchoring decides WHICH path answers a request, never WHETHER the caller may ask.
 *
 * The planner owns the authentication gate (`resolveRuntimeQueryPlannerAuthorityV1` and
 * `resolveRuntimeEntityIds` both check `authenticated` first). An unanchored request skips the
 * planner, so without this it would skip that gate too — omitting `entity_scope` would have been
 * an authentication bypass. Pinned by tools.test.ts "candidate-on preserves authentication-first
 * error precedence when the planner is unavailable" and "authenticates before checking candidate
 * runtime availability", both of which send an unanchored `{ task: 'blocked' }`.
 *
 * Precedence is unchanged for anchored requests: this raises the identical error the planner would
 * have raised, only a few lines earlier. With BOTH switches off there is no planner to
 * authenticate against, and the historical unauthenticated legacy path stays exactly as it was.
 */
function assertPlannerAuthentication(
  candidateChannelEnabled: boolean,
  queryPlannerEnabled: boolean,
  authenticated: boolean,
): void {
  if ((candidateChannelEnabled || queryPlannerEnabled) && !authenticated) {
    throw fixedPlannerFailure('authentication_required');
  }
}

function assertPlannerAuthenticationObserved(
  candidateChannelEnabled: boolean,
  queryPlannerEnabled: boolean,
  authenticated: boolean,
): void {
  try {
    assertPlannerAuthentication(candidateChannelEnabled, queryPlannerEnabled, authenticated);
  } catch (error) {
    recordRetrievalResolutionFailureV1(error);
    throw error;
  }
}

async function resolveRuntimeEntityIds(
  authenticated: boolean,
  resolverFactory: RuntimeScopedEntityResolverFactory | null,
  tenantId: string,
  projectName: unknown,
  entityScope: unknown,
  asOf: unknown,
): Promise<readonly [string]> {
  if (!authenticated) throw fixedPlannerFailure('authentication_required');
  if (!resolverFactory) throw fixedPlannerFailure('unavailable');
  const receipt = buildRuntimeQueryPlannerReceiptV1({
    tenantId,
    projectName,
    entityScope,
    ...(asOf !== undefined ? { asOf } : {}),
  });
  try {
    const resolver = resolverFactory(Object.freeze({
      tenantId, projectScopes: receipt.trustedProjectScopes,
    }));
    if (typeof resolver !== 'object' || resolver === null || nodeUtilTypes.isProxy(resolver)) {
      throw fixedPlannerFailure('resolution_failed');
    }
    const descriptor = Object.getOwnPropertyDescriptor(resolver, 'resolve');
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      || typeof descriptor.value !== 'function') throw fixedPlannerFailure('resolution_failed');
    return oneResolvedEntityId(await descriptor.value.call(resolver, receipt.plan));
  } catch (error) {
    if (error instanceof RuntimeQueryPlannerError) throw error;
    throw fixedPlannerFailure('resolution_failed');
  }
}

function tracedTextContent(markdown: string, traceJson: string, explanation?: string): {
  content: Array<{ type: 'text'; text: string }>;
} {
  const content = [
    { type: 'text' as const, text: markdown },
    { type: 'text' as const, text: traceJson },
  ];
  if (explanation !== undefined) content.push({ type: 'text' as const, text: explanation });
  return { content };
}

export const RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_ENV = 'MEMBERRY_TRACE_VALIDATION_DIAGNOSTICS';
export const RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_ENABLED = 'enabled';

export const RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_LINES = Object.freeze({
  IN_MEMORY_CONFORMANCE: 'MEMBERRY_TRACE_VALIDATION_STAGE=IN_MEMORY_CONFORMANCE',
  IN_MEMORY_REPLAY: 'MEMBERRY_TRACE_VALIDATION_STAGE=IN_MEMORY_REPLAY',
  CANONICALIZATION: 'MEMBERRY_TRACE_VALIDATION_STAGE=CANONICALIZATION',
  EXPOSED_JSON_PARSE: 'MEMBERRY_TRACE_VALIDATION_STAGE=EXPOSED_JSON_PARSE',
  EXPOSED_CONFORMANCE: 'MEMBERRY_TRACE_VALIDATION_STAGE=EXPOSED_CONFORMANCE',
  EXPOSED_REPLAY: 'MEMBERRY_TRACE_VALIDATION_STAGE=EXPOSED_REPLAY',
} as const);

export type RetrievalTraceValidationStage = keyof typeof RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_LINES;

export interface RetrievalTraceValidationRuntime {
  readonly inMemoryConformance: (trace: unknown) => void;
  readonly inMemoryReplay: (trace: RetrievalTraceV1) => unknown;
  readonly canonicalization: (trace: RetrievalTraceV1) => string;
  readonly exposedJsonParse: (canonical: string) => unknown;
  readonly exposedConformance: (trace: unknown) => void;
  readonly exposedReplay: (trace: RetrievalTraceV1) => unknown;
}

const DEFAULT_TRACE_VALIDATION_RUNTIME: RetrievalTraceValidationRuntime = Object.freeze({
  inMemoryConformance: assertRetrievalTraceConformant,
  inMemoryReplay: replayRetrievalTrace,
  canonicalization: canonicalTraceJson,
  exposedJsonParse: JSON.parse,
  exposedConformance: assertRetrievalTraceConformant,
  exposedReplay: replayRetrievalTrace,
});

function failTraceValidation(stage: RetrievalTraceValidationStage): never {
  if (process.env[RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_ENV]
    === RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_ENABLED) {
    try { console.error(RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_LINES[stage]); }
    catch { /* The public failure remains stable even if stderr is unavailable. */ }
  }
  throw new Error('Retrieval trace validation failed');
}

/** Validate both the in-memory value and the exact canonical bytes before they
 * cross the MCP boundary. All rejection paths are deliberately value-free. */
export function serializeApprovedRetrievalTrace(
  trace: unknown,
  runtime: RetrievalTraceValidationRuntime = DEFAULT_TRACE_VALIDATION_RUNTIME,
): string {
  try { runtime.inMemoryConformance(trace); }
  catch { return failTraceValidation('IN_MEMORY_CONFORMANCE'); }
  const inMemory = trace as RetrievalTraceV1;
  try { runtime.inMemoryReplay(inMemory); }
  catch { return failTraceValidation('IN_MEMORY_REPLAY'); }
  let canonical: string;
  try { canonical = runtime.canonicalization(inMemory); }
  catch { return failTraceValidation('CANONICALIZATION'); }
  let exposed: unknown;
  try { exposed = runtime.exposedJsonParse(canonical); }
  catch { return failTraceValidation('EXPOSED_JSON_PARSE'); }
  try { runtime.exposedConformance(exposed); }
  catch { return failTraceValidation('EXPOSED_CONFORMANCE'); }
  try { runtime.exposedReplay(exposed as RetrievalTraceV1); }
  catch { return failTraceValidation('EXPOSED_REPLAY'); }
  return canonical;
}

// ─── Tool registration ────────────────────────────────────────────────────────

export interface RetrievalRegisteredTools {
  /** Tier 1 tool — berry_context, always enabled. */
  tier1: RegisteredTool[];
  /** Tier 2 tools — berry_feedback, disabled by default. */
  tier2: RegisteredTool[];
}

export function registerRetrievalTools(
  server: McpServer,
  container: RetrievalServiceContainer = defaultContainer,
): RetrievalRegisteredTools {
  // Destructure once into closure-captured locals. Handlers reference these by
  // the same names they used as module globals, so their bodies are unchanged —
  // but each call to registerRetrievalTools can now be bound to a different container.
  const {
    assembler, feedbackTracker, tenantId, authenticated, queryPlannerEnabled, resolverFactory,
    candidateChannelEnabled, candidateRuntime,
    rerankerShadowCoordinator, multihopExpansionEnabled,
  } = container;
  // RET-007 v4 served-arm probe, built PER CALL from the call's own sealed
  // receipt (projectScope / temporal frame) so the bridge resolves against the
  // same authority as pass 1. `bridge` is a bare name; fact-lexical supplies
  // none and returns null before touching the resolver. Any planner error
  // (not found / ambiguous / diagnostics) fails closed to null.
  const servedMultihopProbe = (
    receipt: RuntimeQueryPlannerResolvedReceiptV1,
    options: RuntimeCandidateExecuteOptions,
  ): ServedMultihopProbeV1 => async ({ bridge }) => {
    if (!bridge || !candidateRuntime) return null;
    const sealed = readRuntimeQueryPlannerAuthorityV1(receipt);
    try {
      const bridgeReceipt = await resolveRuntimeQueryPlannerAuthorityV1({
        authenticated,
        plannerEnabled: queryPlannerEnabled,
        resolverFactory,
        tenantId,
        projectName: sealed.projectScope,
        entityScope: [bridge],
        ...(sealed.temporalFrame.mode === 'as-of' ? { asOf: sealed.temporalFrame.asOf } : {}),
      });
      return await candidateRuntime.execute(bridgeReceipt, options);
    } catch (error) {
      if (error instanceof RuntimeQueryPlannerError) return null;
      throw error;
    }
  };
  const tier1: RegisteredTool[] = [];
  const tier2: RegisteredTool[] = [];

  // ─── berry_context (Tier 1) ───────────────────────────────────────────────
  tier1.push(server.tool(
    'berry_context',
    'Unified super-load: assembles context combining architecture (hierarchy, dependencies, aspects), code (symbols, signatures, docs), and memory (semantic principles, episodic history) into a single response. Three strategies: "auto" (default — classifies query intent and routes automatically), "ranked" (hybrid search with RRF fusion, query expansion, and feedback boosts — best for exploration), "deterministic" (Yggdrasil-style 5-step assembly — same graph state always produces same output, best for architectural queries). Use this as your primary context-loading tool when you need a complete picture.',
    {
      task: z.string().max(5000).describe('Task description (what you are about to do)'),
      strategy: z.enum(['auto', 'ranked', 'deterministic']).optional().default('auto')
        .describe('Retrieval strategy: "auto" (classifies intent and routes), "ranked" for exploration, "deterministic" for architectural queries'),
      include_code: z.boolean().optional().default(true).describe('Include code symbols in results'),
      include_arch: z.boolean().optional().default(true).describe('Include architectural context'),
      include_memory: z.boolean().optional().default(true).describe('Include semantic/episodic memory'),
      max_tokens: z.number().int().positive().optional().default(8000).describe('Max tokens for the assembled context'),
      entity_scope: z.array(z.string()).optional().describe('Scope to specific entities'),
      tag_scope: z.array(z.string()).optional().describe('Scope to specific tags'),
      project_name: z.string().max(2000).optional().describe('Project name for scoping'),
      as_of: z.string().optional().describe('ISO 8601 timestamp for point-in-time queries. When set, only knowledge valid at this time is included.'),
      include_trace: z.boolean().optional().default(false)
        .describe('Include a validated canonical retrieval trace as a second text block'),
      explain: z.boolean().optional().default(false)
        .describe('Requires include_trace. Add a human-readable explanation of why this evidence was selected as a third text block'),
    },
    { readOnlyHint: true, idempotentHint: true } satisfies ToolAnnotations,
    async (args) => {
      if (!assembler) throw new Error('Retrieval services not initialised');
      const anchored = plannerAnchored(args);
      recordRetrievalCallV1(
        'berry_context',
        retrievalRoutingShape(anchored, candidateChannelEnabled || queryPlannerEnabled),
      );
      assertPlannerAuthenticationObserved(candidateChannelEnabled, queryPlannerEnabled, authenticated);
      // RL-018: an unanchored request cannot enter the candidate channel — it is pinned to one
      // resolved entity by construction. Fall through to the task-text path rather than reject.
      if (candidateChannelEnabled && anchored) {
        const servedCandidate = assembler.servedRerankerEnabled === true
          && args.strategy !== 'deterministic';
        if (!candidateRuntime || !assembler.assembleCandidateExecution
          || (servedCandidate && !assembler.assembleCandidateExecutionServed)) {
          throw new Error('candidate_runtime:unavailable');
        }
        const queryVectorPromise = args.include_memory && assembler.candidateQueryVector
          ? assembler.candidateQueryVector(args.task)
          : Promise.resolve(undefined);
        const receipt = await observeRetrievalResolutionV1(() => resolveRuntimeQueryPlannerAuthorityV1({
          authenticated,
          plannerEnabled: queryPlannerEnabled,
          resolverFactory,
          tenantId,
          projectName: args.project_name,
          entityScope: args.entity_scope,
          ...(args.as_of !== undefined ? { asOf: args.as_of } : {}),
        }));
        const queryVector = await queryVectorPromise;
        const executeOptions: RuntimeCandidateExecuteOptions = {
          includeArchitecture: args.include_arch,
          includeMemory: args.include_memory,
          ...(queryVector !== undefined ? { queryVector } : {}),
        };
        const execution = await candidateRuntime.execute(receipt, executeOptions);
        const shadowObserver = servedCandidate || args.strategy === 'deterministic'
          ? undefined
          : candidateShadowObserver(rerankerShadowCoordinator, receipt, execution, args.task);
        const assembled = servedCandidate && multihopExpansionEnabled
          ? await assembler.assembleCandidateExecutionServed!(
            args.task, execution, args.max_tokens, args.include_arch, args.include_memory, args.include_trace === true,
            servedMultihopProbe(receipt, executeOptions),
            { includeCode: args.include_code === true },
          )
          : servedCandidate
          ? await assembler.assembleCandidateExecutionServed!(
            args.task, execution, args.max_tokens, args.include_arch, args.include_memory, args.include_trace === true,
            undefined, { includeCode: args.include_code === true },
          )
          : shadowObserver
          ? assembler.assembleCandidateExecution(
            args.task, execution, args.max_tokens, args.include_arch, args.include_memory, args.include_trace === true,
            shadowObserver,
          )
          : assembler.assembleCandidateExecution(
            args.task, execution, args.max_tokens, args.include_arch, args.include_memory, args.include_trace === true,
          );
        // COD-010: the UNSERVED candidate runtime composes memory/arch only — when
        // code was requested, disclose the drop instead of returning a successful-
        // looking context without code. tenant-scope outranks candidate-channel
        // so the stated reason matches the legacy path for the same request.
        // COD-010b: the SERVED arm fetches code itself and owns the real status,
        // so its context passes through untouched.
        const md = assembler.renderMarkdown(
          args.include_code === true && !servedCandidate
            ? {
              ...assembled.context,
              code_plane: {
                outcome: 'unsupported',
                reason: tenantId !== DEFAULT_TENANT ? 'tenant-scope' : 'candidate-channel',
              },
            }
            : assembled.context,
        );
        if (args.include_trace !== true) return textContent(md);
        if (!assembled.trace) throw new Error('candidate_runtime:unavailable');
        if (args.explain !== true) return tracedTextContent(md, serializeApprovedRetrievalTrace(assembled.trace));
        return tracedTextContent(
          md,
          serializeApprovedRetrievalTrace(assembled.trace),
          renderRetrievalExplanationTextV1(buildRetrievalExplanationViewV1(assembled.trace)),
        );
      }
      // Tenant safety: the deterministic strategy queries un-tenant-stamped
      // Entity/Aspect nodes, so it is not safe for a named tenant. Force the
      // ranked path (memory is tenant-filtered; arch entities strict-match to
      // empty for a named tenant — no cross-tenant leak).
      const forcedRanked = tenantId !== DEFAULT_TENANT && args.strategy === 'deterministic';
      const strategy = tenantId !== DEFAULT_TENANT ? 'ranked' : (args.strategy as RetrievalStrategy);
      const options = {
        strategy,
        include_code: args.include_code,
        include_arch: args.include_arch,
        include_memory: args.include_memory,
        max_tokens: args.max_tokens,
        entity_scope: args.entity_scope,
        tag_scope: args.tag_scope,
        project_name: args.project_name,
        as_of: args.as_of,
        tenantId,
        ...(forcedRanked ? { servedRerankerDisabled: true as const } : {}),
      };
      // RL-018: `undefined` here is the already-supported task-text shape — the same value this
      // takes with the planner flag off. Only anchored requests pay for resolution.
      const resolvedEntityIds = queryPlannerEnabled && anchored
        ? await observeRetrievalResolutionV1(() => resolveRuntimeEntityIds(
          authenticated, resolverFactory, tenantId, args.project_name, args.entity_scope, args.as_of,
        ))
        : undefined;
      const runtimeOptions = resolvedEntityIds === undefined
        ? options
        : { ...options, resolvedEntityIds };
      // Keep the historical path byte/call/allocation-identical unless the
      // caller explicitly opts in. In particular, omitted and false do not
      // allocate trace collectors or invoke trace validation.
      if (args.include_trace !== true) {
        const ctx = await assembler.assemble(args.task, runtimeOptions);
        const md = assembler.renderMarkdown(ctx);
        return textContent(md);
      }
      const traced = await assembler.assembleTraced(args.task, runtimeOptions);
      const md = assembler.renderMarkdown(traced.context);
      const traceJson = serializeApprovedRetrievalTrace(traced.trace);
      if (args.explain !== true) return tracedTextContent(md, traceJson);
      return tracedTextContent(
        md,
        traceJson,
        renderRetrievalExplanationTextV1(buildRetrievalExplanationViewV1(traced.trace)),
      );
    },
  ));

  // ─── berry_ask (Tier 1 — dialectic retrieval) ─────────────────────────────
  tier1.push(server.tool(
    'berry_ask',
    'Ask a natural-language question about everything in memory and get a synthesized, CITED answer — not raw chunks. Combines facts via explicit inference, says so when evidence is insufficient, and returns the supporting node IDs. reasoning_level (minimal|low|medium|high|max) trades latency/cost for depth. Use this when the answer requires reasoning over multiple memories; use berry_context when you want the raw assembled context.',
    {
      question: z.string().max(2000).describe('A natural-language question about the user/project/codebase memory'),
      reasoning_level: z.enum(['minimal', 'low', 'medium', 'high', 'max']).optional().default('medium')
        .describe('Depth/cost knob: minimal=terse lookup, max=report-style synthesis'),
      entity_scope: z.array(z.string()).optional().describe('Scope to specific entities'),
      tag_scope: z.array(z.string()).optional().describe('Scope to specific tags'),
      project_name: z.string().max(2000).optional().describe('Project name for scoping'),
      as_of: z.string().optional().describe('ISO 8601 timestamp — answer as of a point in time'),
    },
    { readOnlyHint: true, idempotentHint: true } satisfies ToolAnnotations,
    async (args) => {
      if (!assembler) throw new Error('Retrieval services not initialised');
      const anchored = plannerAnchored(args);
      recordRetrievalCallV1(
        'berry_ask',
        retrievalRoutingShape(anchored, candidateChannelEnabled || queryPlannerEnabled),
      );
      assertPlannerAuthenticationObserved(candidateChannelEnabled, queryPlannerEnabled, authenticated);
      // RL-018: same routing as berry_context — berry_ask shares the constraint verbatim.
      if (candidateChannelEnabled && anchored) {
        const servedCandidate = assembler.servedRerankerEnabled === true;
        if (!candidateRuntime || !assembler.askFromContext || !assembler.assembleCandidateExecution
          || (servedCandidate && !assembler.assembleCandidateExecutionServed)) {
          throw new Error('candidate_runtime:unavailable');
        }
        const queryVectorPromise = assembler.candidateQueryVector
          ? assembler.candidateQueryVector(args.question)
          : Promise.resolve(undefined);
        const receipt = await observeRetrievalResolutionV1(() => resolveRuntimeQueryPlannerAuthorityV1({
          authenticated,
          plannerEnabled: queryPlannerEnabled,
          resolverFactory,
          tenantId,
          projectName: args.project_name,
          entityScope: args.entity_scope,
          ...(args.as_of !== undefined ? { asOf: args.as_of } : {}),
        }));
        const queryVector = await queryVectorPromise;
        const executeOptions: RuntimeCandidateExecuteOptions = {
          includeArchitecture: true,
          includeMemory: true,
          ...(queryVector !== undefined ? { queryVector } : {}),
        };
        const execution = await candidateRuntime.execute(receipt, executeOptions);
        const shadowObserver = servedCandidate
          ? undefined
          : candidateShadowObserver(rerankerShadowCoordinator, receipt, execution, args.question);
        const assembled = servedCandidate && multihopExpansionEnabled
          ? await assembler.assembleCandidateExecutionServed!(
            args.question, execution, askRetrievalTokenBudget(args.reasoning_level), true, true, false,
            servedMultihopProbe(receipt, executeOptions),
            // berry_ask has no include_code input, so code is never requested here.
            { includeCode: false },
          )
          : servedCandidate
          ? await assembler.assembleCandidateExecutionServed!(
            args.question, execution, askRetrievalTokenBudget(args.reasoning_level), true, true, false,
            undefined, { includeCode: false },
          )
          : shadowObserver
          ? assembler.assembleCandidateExecution(
            args.question, execution, askRetrievalTokenBudget(args.reasoning_level), true, true, false,
            shadowObserver,
          )
          : assembler.assembleCandidateExecution(
            args.question, execution, askRetrievalTokenBudget(args.reasoning_level), true, true, false,
          );
        const r = await assembler.askFromContext(args.question, assembled.context, args.reasoning_level);
        const lines = [
          `# Answer`, ``, r.answer, ``,
          `**Reasoning level:** ${r.level} · **Cited:** ${r.cited_ids.length ? r.cited_ids.join(', ') : 'none'}`,
          ``, `## Evidence`,
          ...r.evidence.map((e, i) => `<!-- ${e.id} -->\n[${i + 1}] ${e.content}`),
        ];
        return textContent(lines.join('\n'));
      }
      const resolvedEntityIds = queryPlannerEnabled && anchored
        ? await observeRetrievalResolutionV1(() => resolveRuntimeEntityIds(
          authenticated, resolverFactory, tenantId, args.project_name, args.entity_scope, args.as_of,
        ))
        : undefined;
      const r = await assembler.ask(args.question, {
        level: args.reasoning_level,
        entity_scope: args.entity_scope,
        tag_scope: args.tag_scope,
        project_name: args.project_name,
        as_of: args.as_of,
        tenantId,
        ...(resolvedEntityIds !== undefined ? { resolvedEntityIds } : {}),
      });
      const lines = [
        `# Answer`,
        ``,
        r.answer,
        ``,
        `**Reasoning level:** ${r.level} · **Cited:** ${r.cited_ids.length ? r.cited_ids.join(', ') : 'none'}`,
        ``,
        `## Evidence`,
        ...r.evidence.map((e, i) => `<!-- ${e.id} -->\n[${i + 1}] ${e.content}`),
      ];
      return textContent(lines.join('\n'));
    },
  ));

  // ─── berry_feedback (Tier 2 — retrieval domain) ──────────────────────────
  tier2.push(server.tool(
    'berry_feedback',
    'Record feedback on retrieval results. Tell MemBerry which results were useful and which were not. This improves future retrieval rankings over time.',
    {
      result_id: z.string().max(500).describe('ID of the result to give feedback on'),
      was_useful: z.boolean().describe('Whether this result was useful for your task'),
      session_id: z.string().max(500).describe('Current session ID'),
      query: z.string().max(2000).optional().default('').describe('The original query that produced this result'),
      source_type: z.enum(['semantic', 'episodic', 'symbol', 'arch_entity', 'aspect']).optional().default('semantic')
        .describe('Type of the result'),
    },
    { readOnlyHint: true } satisfies ToolAnnotations,
    async (args) => {
      if (!feedbackTracker) throw new Error('Retrieval services not initialised');
      // Scope the write to this container's tenant so one tenant's feedback
      // never re-ranks another tenant's retrieval (covert ranking channel).
      await feedbackTracker.recordFeedback({
        query: args.query,
        result_id: args.result_id,
        source_type: args.source_type,
        was_useful: args.was_useful,
        session_id: args.session_id,
        timestamp: new Date().toISOString(),
      }, tenantId);
      return textContent(JSON.stringify({ recorded: true, result_id: args.result_id, was_useful: args.was_useful }));
    },
  ));

  return { tier1, tier2 };
}
