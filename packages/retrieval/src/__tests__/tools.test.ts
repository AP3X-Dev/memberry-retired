// packages/retrieval/src/__tests__/tools.test.ts
// Tenant-isolation wiring for the retrieval tool layer: the container carries a
// tenantId and registerRetrievalTools threads it into every assemble()/ask().
import { readFileSync } from 'node:fs';
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  createRetrievalContainer,
  retrievalContainerForTenant,
  RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_ENABLED,
  RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_ENV,
  RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_LINES,
  registerRetrievalTools,
  setRetrievalServiceInstances,
  serializeApprovedRetrievalTrace,
  type IUnifiedAssembler,
  type IFeedbackTracker,
  type RetrievalTraceValidationRuntime,
  type RetrievalTraceValidationStage,
  type IRuntimeCandidateChannelService,
} from '../tools.js';
import { canonicalTraceJson, replayRetrievalTrace, RETRIEVAL_TRACE_CHANNEL_ORDER } from '../trace.js';
import type { RetrievalTraceV1 } from '../trace.js';
import type { UnifiedContext } from '../types.js';
import type { QueryPlanV1 } from '../query-plan.js';
import type { ScopedEntityTrustedAuthorityV1 } from '../scoped-entity-resolver.js';
import { readRuntimeQueryPlannerAuthorityV1, RuntimeQueryPlannerError, RUNTIME_QUERY_PLANNER_DENIAL_REASONS_V1 } from '../runtime-query-planner.js';
import { UnifiedAssembler } from '../assembler.js';
import { createServedRerankerProviderV1 } from '../served-reranker.js';

const approvedTrace = JSON.parse(readFileSync(
  new URL('./fixtures/retrieval-trace-deterministic-v2.json', import.meta.url),
  'utf8',
)) as RetrievalTraceV1;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function traceValidationRuntime(): RetrievalTraceValidationRuntime {
  const canonical = canonicalTraceJson(approvedTrace);
  return {
    inMemoryConformance: vi.fn(),
    inMemoryReplay: vi.fn(),
    canonicalization: vi.fn(() => canonical),
    exposedJsonParse: vi.fn(() => approvedTrace),
    exposedConformance: vi.fn(),
    exposedReplay: vi.fn(),
  };
}

const validationStageRuntimeKeys = {
  IN_MEMORY_CONFORMANCE: 'inMemoryConformance',
  IN_MEMORY_REPLAY: 'inMemoryReplay',
  CANONICALIZATION: 'canonicalization',
  EXPOSED_JSON_PARSE: 'exposedJsonParse',
  EXPOSED_CONFORMANCE: 'exposedConformance',
  EXPOSED_REPLAY: 'exposedReplay',
} as const satisfies Record<RetrievalTraceValidationStage, keyof RetrievalTraceValidationRuntime>;

describe('retrieval trace validation runtime diagnostics', () => {
  it.each(Object.keys(validationStageRuntimeKeys) as RetrievalTraceValidationStage[])(
    'reports only the fixed %s stage and preserves the public error',
    (stage) => {
      vi.stubEnv(RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_ENV, RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_ENABLED);
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const runtime = traceValidationRuntime();
      vi.mocked(runtime[validationStageRuntimeKeys[stage]]).mockImplementation(() => {
        throw new Error('sk_live_NEVER_REFLECT_STAGE_SECRET');
      });

      expect(() => serializeApprovedRetrievalTrace(approvedTrace, runtime))
        .toThrowError('Retrieval trace validation failed');
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_LINES[stage]);
      expect(JSON.stringify(log.mock.calls)).not.toContain('sk_live_NEVER_REFLECT_STAGE_SECRET');
    },
  );

  it.each([undefined, '', '1', 'true', 'ENABLED', 'enabled '])(
    'does not log when the diagnostic opt-in is %s',
    (flag) => {
      if (flag === undefined) vi.stubEnv(RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_ENV, undefined);
      else vi.stubEnv(RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_ENV, flag);
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const runtime = traceValidationRuntime();
      vi.mocked(runtime.inMemoryConformance).mockImplementation(() => { throw new Error('secret'); });

      expect(() => serializeApprovedRetrievalTrace(approvedTrace, runtime))
        .toThrowError('Retrieval trace validation failed');
      expect(log).not.toHaveBeenCalled();
    },
  );

  it('keeps successful bytes and logging unchanged while the opt-in is enabled', () => {
    vi.stubEnv(RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_ENV, RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_ENABLED);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(serializeApprovedRetrievalTrace(approvedTrace)).toBe(canonicalTraceJson(approvedTrace));
    expect(log).not.toHaveBeenCalled();
  });

  it('still throws the fixed public error if console.error itself throws', () => {
    vi.stubEnv(RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_ENV, RETRIEVAL_TRACE_VALIDATION_DIAGNOSTIC_ENABLED);
    vi.spyOn(console, 'error').mockImplementation(() => { throw new Error('hostile stderr secret'); });
    const runtime = traceValidationRuntime();
    vi.mocked(runtime.inMemoryConformance).mockImplementation(() => { throw new Error('trace secret'); });

    expect(() => serializeApprovedRetrievalTrace(approvedTrace, runtime))
      .toThrowError('Retrieval trace validation failed');
  });
});

function emptyCtx(): UnifiedContext {
  return { task: 'q', strategy: 'ranked', sections: [], token_count: 0, assembled_at: '2026-06-07T00:00:00.000Z' };
}

function makeAssembler(served = false): IUnifiedAssembler {
  return {
    servedRerankerEnabled: served,
    assemble: vi.fn().mockResolvedValue(emptyCtx()),
    assembleTraced: vi.fn().mockResolvedValue({ context: emptyCtx(), trace: approvedTrace }),
    renderMarkdown: vi.fn().mockReturnValue('# md'),
    ask: vi.fn().mockResolvedValue({ answer: 'a', cited_ids: [], evidence: [], level: 'medium' }),
    askFromContext: vi.fn().mockResolvedValue({ answer: 'a', cited_ids: [], evidence: [], level: 'medium' }),
    assembleCandidateExecution: vi.fn().mockReturnValue({ context: emptyCtx(), trace: approvedTrace }),
    assembleCandidateExecutionServed: vi.fn().mockResolvedValue({ context: emptyCtx(), trace: approvedTrace }),
  };
}

function makeFeedback(): IFeedbackTracker {
  return { recordFeedback: vi.fn().mockResolvedValue(undefined) };
}

/**
 * Minimal McpServer stub: server.tool(name, desc, schema, annotations, handler)
 * captures each registered handler by tool name so we can invoke it directly.
 */
function makeServerStub() {
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  const server = {
    tool: vi.fn((name: string, ...rest: unknown[]) => {
      const handler = rest[rest.length - 1] as (args: Record<string, unknown>) => Promise<unknown>;
      handlers.set(name, handler);
      return { enable: vi.fn(), disable: vi.fn() } as unknown;
    }),
  };
  return { server, handlers };
}

describe('registerRetrievalTools — tenant threading', () => {
  it('createRetrievalContainer defaults tenantId to the default tenant', () => {
    expect(createRetrievalContainer().tenantId).toBe('default');
    expect(createRetrievalContainer({ tenantId: 'acme' }).tenantId).toBe('acme');
    expect(createRetrievalContainer({ tenantId: 'acme' }).authenticated).toBe(false);
    expect(retrievalContainerForTenant('acme').authenticated).toBe(false);
    expect(retrievalContainerForTenant('acme', true).authenticated).toBe(true);
  });

  it('berry_context passes the container tenantId into assemble()', async () => {
    const assembler = makeAssembler();
    const { server, handlers } = makeServerStub();
    const container = createRetrievalContainer({ assembler, feedbackTracker: makeFeedback(), tenantId: 'acme' });

    registerRetrievalTools(server as never, container);
    await handlers.get('berry_context')!({ task: 'find auth', strategy: 'auto' });

    expect(assembler.assemble).toHaveBeenCalledWith(
      'find auth',
      expect.objectContaining({ tenantId: 'acme' }),
    );
  });

  it.each([undefined, false])('berry_context include_trace=%s preserves the ordinary single-call single-block path', async (includeTrace) => {
    const assembler = makeAssembler();
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, createRetrievalContainer({ assembler }));

    const args = { task: 'find auth', strategy: 'ranked', ...(includeTrace === undefined ? {} : { include_trace: includeTrace }) };
    const result = await handlers.get('berry_context')!(args) as { content: Array<{ type: string; text: string }> };

    expect(assembler.assemble).toHaveBeenCalledTimes(1);
    expect(assembler.assembleTraced).not.toHaveBeenCalled();
    expect(assembler.renderMarkdown).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ content: [{ type: 'text', text: '# md' }] });
  });

  it('berry_context include_trace=true returns unchanged markdown then canonical approved trace JSON', async () => {
    const assembler = makeAssembler();
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, createRetrievalContainer({ assembler }));

    const result = await handlers.get('berry_context')!({
      task: 'find auth', strategy: 'deterministic', include_trace: true,
    }) as { content: Array<{ type: string; text: string }> };

    expect(assembler.assemble).not.toHaveBeenCalled();
    expect(assembler.assembleTraced).toHaveBeenCalledWith(
      'find auth',
      expect.objectContaining({ strategy: 'deterministic', tenantId: 'default' }),
    );
    expect(result.content).toEqual([
      { type: 'text', text: '# md' },
      { type: 'text', text: canonicalTraceJson(approvedTrace) },
    ]);
  });

  it('berry_context trace_detail=summary uses the ordinary path and returns bounded content-free diagnostics', async () => {
    const assembler = makeAssembler();
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, createRetrievalContainer({ assembler, tenantId: 'acme' }));

    const result = await handlers.get('berry_context')!({
      task: 'sk_live_NEVER_EXPOSE_SUMMARY_TASK',
      strategy: 'ranked',
      include_code: false,
      include_arch: false,
      include_memory: true,
      max_tokens: 6_500,
      project_name: 'secret-project-name',
      entity_scope: ['secret-entity-name'],
      include_trace: true,
      trace_detail: 'summary',
    }) as { content: Array<{ type: string; text: string }> };

    expect(assembler.assemble).toHaveBeenCalledTimes(1);
    expect(assembler.assembleTraced).not.toHaveBeenCalled();
    expect(result.content[0]).toEqual({ type: 'text', text: '# md' });
    const summary = JSON.parse(result.content[1]!.text);
    expect(summary).toMatchObject({
      schemaVersion: '1.0.0', kind: 'retrieval-trace-summary', bounded: true, replayable: false,
      requestShape: { tenantScope: 'named', projectScopeApplied: true, entityScope: 'one' },
    });
    expect(result.content[1]!.text).not.toContain('NEVER_EXPOSE');
    expect(result.content[1]!.text).not.toContain('secret-project-name');
    expect(result.content[1]!.text).not.toContain('secret-entity-name');
  });

  it('rejects explain with bounded summary before retrieval work begins', async () => {
    const assembler = makeAssembler();
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, createRetrievalContainer({ assembler }));

    await expect(handlers.get('berry_context')!({
      task: 'find auth', strategy: 'ranked', include_trace: true, trace_detail: 'summary', explain: true,
    })).rejects.toThrow('Retrieval trace summary does not support explain');
    expect(assembler.assemble).not.toHaveBeenCalled();
    expect(assembler.assembleTraced).not.toHaveBeenCalled();
  });

  it('berry_context include_trace=true preserves forced-ranked isolation for named tenants', async () => {
    const assembler = makeAssembler();
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, createRetrievalContainer({ assembler, tenantId: 'acme' }));

    await handlers.get('berry_context')!({ task: 'what depends on auth', strategy: 'deterministic', include_trace: true });

    expect(assembler.assembleTraced).toHaveBeenCalledWith(
      'what depends on auth',
      expect.objectContaining({ strategy: 'ranked', tenantId: 'acme', servedRerankerDisabled: true }),
    );
  });

  it('fails trace exposure closed with a value-free error', async () => {
    const assembler = makeAssembler();
    const credential = 'sk_live_NEVER_ECHO_THIS';
    vi.mocked(assembler.assembleTraced).mockResolvedValue({
      context: emptyCtx(),
      trace: { ...approvedTrace, credential } as unknown as RetrievalTraceV1,
    });
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, createRetrievalContainer({ assembler }));

    let message = '';
    try {
      await handlers.get('berry_context')!({ task: 'find auth', strategy: 'ranked', include_trace: true });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe('Retrieval trace validation failed');
    expect(message).not.toContain(credential);
  });

  it('berry_ask passes the container tenantId into ask()', async () => {
    const assembler = makeAssembler();
    const { server, handlers } = makeServerStub();
    const container = createRetrievalContainer({ assembler, feedbackTracker: makeFeedback(), tenantId: 'acme' });

    registerRetrievalTools(server as never, container);
    await handlers.get('berry_ask')!({ question: 'does X use Y?', reasoning_level: 'medium' });

    expect(assembler.ask).toHaveBeenCalledWith(
      'does X use Y?',
      expect.objectContaining({ tenantId: 'acme' }),
    );
  });

  it('defaults to the default tenant when none is supplied to the container', async () => {
    const assembler = makeAssembler();
    const { server, handlers } = makeServerStub();
    const container = createRetrievalContainer({ assembler, feedbackTracker: makeFeedback() });

    registerRetrievalTools(server as never, container);
    await handlers.get('berry_context')!({ task: 't', strategy: 'auto' });

    expect(assembler.assemble).toHaveBeenCalledWith(
      't',
      expect.objectContaining({ tenantId: 'default' }),
    );
  });

  it('berry_feedback threads the container tenantId into recordFeedback()', async () => {
    const feedbackTracker = makeFeedback();
    const { server, handlers } = makeServerStub();
    const container = createRetrievalContainer({ assembler: makeAssembler(), feedbackTracker, tenantId: 'acme' });

    registerRetrievalTools(server as never, container);
    await handlers.get('berry_feedback')!({
      result_id: 'sem-1',
      was_useful: true,
      session_id: 'sess-1',
      query: 'auth flow',
      source_type: 'semantic',
    });

    // Second positional arg is the resolved tenant — pins that the feedback
    // write is tenant-scoped, not process-global.
    expect(feedbackTracker.recordFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ result_id: 'sem-1', was_useful: true }),
      'acme',
    );
  });
});

describe('RET-002C2 authenticated planner wiring', () => {
  function plannerContainer(options: {
    authenticated?: boolean;
    enabled?: boolean;
    state?: 'resolved' | 'ambiguous' | 'not-found' | 'denied';
    ids?: string[];
    result?: unknown;
    projectScope?: string;
  } = {}) {
    const assembler = makeAssembler();
    const defaultResult = Object.freeze({
      resolution: Object.freeze({
        state: options.state ?? 'resolved',
        canonicalEntityIds: Object.freeze(options.ids ?? ['entity-stable']),
      }),
      diagnostics: Object.freeze([]),
    });
    const resolve = vi.fn().mockResolvedValue(options.result ?? defaultResult);
    const resolverFactory = vi.fn((_authority: ScopedEntityTrustedAuthorityV1) => ({ resolve }));
    const resolveProjectScope = vi.fn().mockResolvedValue(options.projectScope);
    const container = createRetrievalContainer({
      assembler,
      tenantId: 'tenant-a',
      authenticated: options.authenticated ?? true,
      queryPlannerEnabled: options.enabled ?? true,
      projectScopeResolver: { resolve: resolveProjectScope },
      resolverFactory,
    });
    return { assembler, resolve, resolveProjectScope, resolverFactory, container };
  }

  it('keeps the flag-off ordinary, traced, and ask calls exact and never touches the resolver', async () => {
    const { assembler, resolverFactory, container } = plannerContainer({ enabled: false });
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, container);
    await handlers.get('berry_context')!({ task: 'legacy', strategy: 'ranked', project_name: 'memberry', entity_scope: ['Resolver'] });
    await handlers.get('berry_context')!({ task: 'legacy trace', strategy: 'ranked', project_name: 'memberry', entity_scope: ['Resolver'], include_trace: true });
    await handlers.get('berry_ask')!({ question: 'legacy ask', reasoning_level: 'low', project_name: 'memberry', entity_scope: ['Resolver'] });
    expect(resolverFactory).not.toHaveBeenCalled();
    expect(assembler.assemble).toHaveBeenCalledWith('legacy', {
      strategy: 'ranked', include_code: undefined, include_arch: undefined, include_memory: undefined,
      max_tokens: undefined, entity_scope: ['Resolver'], tag_scope: undefined,
      project_name: 'memberry', as_of: undefined, tenantId: 'tenant-a',
    });
    expect(assembler.assembleTraced).toHaveBeenCalledWith('legacy trace', {
      strategy: 'ranked', include_code: undefined, include_arch: undefined, include_memory: undefined,
      max_tokens: undefined, entity_scope: ['Resolver'], tag_scope: undefined,
      project_name: 'memberry', as_of: undefined, tenantId: 'tenant-a',
    });
    expect(assembler.ask).toHaveBeenCalledWith('legacy ask', {
      level: 'low', entity_scope: ['Resolver'], tag_scope: undefined,
      project_name: 'memberry', as_of: undefined, tenantId: 'tenant-a',
    });
  });

  it('requires explicit authenticated eligibility before planning and does zero downstream work', async () => {
    const { assembler, resolverFactory, container } = plannerContainer({ authenticated: false });
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, container);
    await expect(handlers.get('berry_context')!({
      task: 'blocked', project_name: 'project:memberry', entity_scope: ['Resolver'],
    })).rejects.toThrowError('runtime_query_planner:authentication_required');
    expect(resolverFactory).not.toHaveBeenCalled();
    expect(assembler.assemble).not.toHaveBeenCalled();
    expect(assembler.assembleTraced).not.toHaveBeenCalled();
    expect(assembler.ask).not.toHaveBeenCalled();
    expect(assembler.renderMarkdown).not.toHaveBeenCalled();
  });

  it.each(['berry_context', 'berry_ask'] as const)('%s rejects invalid enabled authority before resolver or downstream', async (tool) => {
    const { assembler, resolverFactory, container } = plannerContainer();
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, container);
    const args = tool === 'berry_context'
      ? { task: 'blocked', project_name: 'project:memberry/foreign', entity_scope: ['Resolver'] }
      : { question: 'blocked', project_name: 'project:memberry/foreign', entity_scope: ['Resolver'] };
    await expect(handlers.get(tool)!(args)).rejects.toThrowError('runtime_query_planner:invalid_request');
    expect(resolverFactory).not.toHaveBeenCalled();
    expect(assembler.assemble).not.toHaveBeenCalled();
    expect(assembler.ask).not.toHaveBeenCalled();
    expect(assembler.renderMarkdown).not.toHaveBeenCalled();
  });

  it('keeps oversized display-derived scopes on the planner invalid-request path', async () => {
    const { assembler, resolveProjectScope, resolverFactory, container } = plannerContainer();
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, container);

    await expect(handlers.get('berry_context')!({
      task: 'blocked', project_name: 'A'.repeat(129), entity_scope: ['Resolver'],
    })).rejects.toThrowError('runtime_query_planner:invalid_request');
    expect(resolveProjectScope).not.toHaveBeenCalled();
    expect(resolverFactory).not.toHaveBeenCalled();
    expect(assembler.assemble).not.toHaveBeenCalled();
  });

  it.each([
    ['berry_context', 'Guardrail Control Plane'],
    ['berry_ask', 'project:Guardrail Control Plane'],
    ['berry_context', 'Memberry'],
    ['berry_ask', 'project:canonical_scope.v1'],
  ] as const)('%s canonicalizes safe project display name %s before planning', async (tool, projectName) => {
    const { assembler, resolverFactory, resolve, container } = plannerContainer();
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, container);
    const args = tool === 'berry_context'
      ? { task: 'safe', project_name: projectName, entity_scope: ['hhHACiJJL5t7AUBJyA2UU'] }
      : { question: 'safe', project_name: projectName, entity_scope: ['hhHACiJJL5t7AUBJyA2UU'] };

    await handlers.get(tool)!(args);

    const expectedScope = projectName === 'Memberry'
      ? 'project:memberry'
      : projectName === 'project:canonical_scope.v1'
      ? projectName
      : 'project:guardrail-control-plane';
    expect(resolverFactory).toHaveBeenCalledWith({
      tenantId: 'tenant-a', projectScopes: [expectedScope],
    });
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({
      authority: expect.objectContaining({
        callerScopes: expect.objectContaining({ projects: [expectedScope] }),
      }),
    }));
    const downstream = tool === 'berry_context' ? assembler.assemble : assembler.ask;
    expect(downstream).toHaveBeenCalledWith('safe', expect.objectContaining({
      project_name: expectedScope, resolvedEntityIds: ['entity-stable'],
    }));
  });

  it('uses the bootstrap-owned scope for DealerBot3.0 instead of the display-derived guess', async () => {
    const { assembler, resolveProjectScope, resolverFactory, container } = plannerContainer({
      projectScope: 'project:dealerbot',
    });
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, container);

    await handlers.get('berry_context')!({
      task: 'Implement DealerBot3.0 UI-04B Campaign Policies and Approvals',
      project_name: 'DealerBot3.0',
      entity_scope: ['ent-YOX6g9puSeht'],
      tag_scope: ['project:dealerbot', 'guardrail-parity', 'ui-catch-up'],
      strategy: 'deterministic',
      include_arch: true,
      include_code: true,
      include_memory: true,
      max_tokens: 5000,
    });

    expect(resolveProjectScope).toHaveBeenCalledWith('project:dealerbot3-0');
    expect(resolverFactory).toHaveBeenCalledWith({
      tenantId: 'tenant-a', projectScopes: ['project:dealerbot'],
    });
    expect(assembler.assemble).toHaveBeenCalledWith(
      'Implement DealerBot3.0 UI-04B Campaign Policies and Approvals',
      expect.objectContaining({
        project_name: 'project:dealerbot',
        resolvedEntityIds: ['entity-stable'],
      }),
    );
  });

  it.each([
    ['ambiguous', ['entity-a', 'entity-b']], ['not-found', []], ['denied', []], ['resolved', []], ['resolved', ['a', 'b']],
  ] as const)('fails resolver state %s/%s closed before assembly', async (state, ids) => {
    const { assembler, container } = plannerContainer({ state, ids: [...ids] });
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, container);
    await expect(handlers.get('berry_context')!({
      task: 'blocked', project_name: 'project:memberry', entity_scope: ['Resolver'],
    })).rejects.toThrowError('runtime_query_planner:resolution_failed');
    expect(assembler.assemble).not.toHaveBeenCalled();
    expect(assembler.renderMarkdown).not.toHaveBeenCalled();
  });

  // entity_not_found is the one reason that degrades instead of throwing (B-3); see
  // tools.entity-not-found-fallback.test.ts.
  it.each(RUNTIME_QUERY_PLANNER_DENIAL_REASONS_V1.filter((reason) => reason !== 'entity_not_found'))('carries the resolver diagnostic %s as a structured reason on resolution_failed', async (reason) => {
    const result = { resolution: { state: 'denied', canonicalEntityIds: [] }, diagnostics: [reason] };
    const { assembler, container } = plannerContainer({ result });
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, container);
    const failure = await handlers.get('berry_context')!({
      task: 'blocked', project_name: 'project:memberry', entity_scope: ['Resolver'],
    }).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(RuntimeQueryPlannerError);
    expect((failure as RuntimeQueryPlannerError).code).toBe('resolution_failed');
    expect((failure as RuntimeQueryPlannerError).reason).toBe(reason);
    expect((failure as Error).message).toBe(`runtime_query_planner:resolution_failed:${reason}`);
    expect(assembler.assemble).not.toHaveBeenCalled();
  });

  it('takes the first diagnostic as the reason and drops the reason for an unknown code', async () => {
    for (const [diagnostics, reason] of [
      [['entity_ambiguous', 'entity_not_found'], 'entity_ambiguous'],
      [['made_up_code'], undefined],
      [['entity_not_found', 'made_up_code'], undefined],
    ] as const) {
      const result = { resolution: { state: 'denied', canonicalEntityIds: [] }, diagnostics: [...diagnostics] };
      const { container } = plannerContainer({ result });
      const { server, handlers } = makeServerStub();
      registerRetrievalTools(server as never, container);
      const failure = await handlers.get('berry_context')!({
        task: 'blocked', project_name: 'project:memberry', entity_scope: ['Resolver'],
      }).then(() => null, (error: unknown) => error) as RuntimeQueryPlannerError;
      expect(failure.code).toBe('resolution_failed');
      expect(failure.reason).toBe(reason);
      expect(failure.message).toBe(reason === undefined
        ? 'runtime_query_planner:resolution_failed'
        : `runtime_query_planner:resolution_failed:${reason}`);
    }
  });

  it('requires diagnostics to be an exact dense empty data array without hooks or downstream work', async () => {
    const hooks = vi.fn();
    const accessor: unknown[] = [];
    Object.defineProperty(accessor, '0', { enumerable: true, get: () => { hooks(); return 'secret'; } });
    Object.defineProperty(accessor, 'length', { value: 1 });
    const sparse = new Array(1);
    const extra = Object.assign([], { secret: 'blocked' });
    const revoked = Proxy.revocable([], {}); revoked.revoke();
    for (const diagnostics of [['nonempty'], sparse, accessor, extra, revoked.proxy]) {
      const result = {
        resolution: { state: 'resolved', canonicalEntityIds: ['entity-stable'] }, diagnostics,
      };
      const { assembler, container } = plannerContainer({ result });
      const { server, handlers } = makeServerStub();
      registerRetrievalTools(server as never, container);
      await expect(handlers.get('berry_context')!({
        task: 'blocked', project_name: 'project:memberry', entity_scope: ['Resolver'],
      })).rejects.toThrowError('runtime_query_planner:resolution_failed');
      expect(assembler.assemble).not.toHaveBeenCalled();
      expect(assembler.renderMarkdown).not.toHaveBeenCalled();
    }
    expect(hooks).not.toHaveBeenCalled();
  });

  it.each([
    ['ordinary', false], ['traced', true],
  ] as const)('threads one fresh resolved ID through %s context with independent authority arrays', async (_label, traced) => {
    const { assembler, resolverFactory, resolve, container } = plannerContainer();
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, container);
    await handlers.get('berry_context')!({
      task: 'safe', strategy: 'ranked', project_name: 'memberry',
      entity_scope: ['Resolver', 'Call Context Resolver', 'alias', 'Resolver'], include_trace: traced,
    });
    const authority = resolverFactory.mock.calls[0]![0];
    const plan = resolve.mock.calls[0]![0] as QueryPlanV1;
    expect(authority).toEqual({ tenantId: 'tenant-a', projectScopes: ['project:memberry'] });
    expect(plan.hints.entities).toEqual(['Call Context Resolver', 'Resolver', 'alias']);
    expect(authority.projectScopes).not.toBe(plan.authority.callerScopes.projects);
    const call = traced ? assembler.assembleTraced : assembler.assemble;
    expect(call).toHaveBeenCalledWith('safe', expect.objectContaining({
      tenantId: 'tenant-a', project_name: 'project:memberry', resolvedEntityIds: ['entity-stable'],
    }));
    const passedIds = vi.mocked(call).mock.calls[0]![1]!.resolvedEntityIds as string[];
    expect(passedIds).not.toBe((await resolve.mock.results[0]!.value).resolution.canonicalEntityIds);
    expect(Object.isFrozen(passedIds)).toBe(true);
  });

  it('resolves before berry_ask and threads the fresh ID into synthesis retrieval', async () => {
    const { assembler, container } = plannerContainer();
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, container);
    await handlers.get('berry_ask')!({
      question: 'safe', reasoning_level: 'high', project_name: 'memberry', entity_scope: ['SOP lifecycle'],
    });
    expect(assembler.ask).toHaveBeenCalledWith('safe', expect.objectContaining({
      level: 'high', tenantId: 'tenant-a', project_name: 'project:memberry', resolvedEntityIds: ['entity-stable'],
    }));
  });
});

describe('RET-003B candidate-channel runtime wiring', () => {
  function candidateContainer(options: {
    candidate?: boolean; planner?: boolean; authenticated?: boolean; shadow?: boolean; served?: boolean;
  } = {}) {
    const assembler = makeAssembler(options.served ?? false);
    const resolution = Object.freeze({
      resolution: Object.freeze({ state: 'resolved', canonicalEntityIds: Object.freeze(['entity-stable']) }),
      diagnostics: Object.freeze([]),
    });
    const resolve = vi.fn().mockResolvedValue(resolution);
    const execution = Object.freeze({
      contractId: 'memberry.candidate-channel' as const,
      contractVersion: '1.0.0' as const,
      request: Object.freeze({
        contractId: 'memberry.candidate-channel' as const,
        contractVersion: '1.0.0' as const,
        tenantId: 'tenant-a', projectScope: 'project:memberry',
        resolvedEntityIds: Object.freeze(['entity-stable']),
        temporalFrame: Object.freeze({ mode: 'current' as const }),
        plannedChannels: RETRIEVAL_TRACE_CHANNEL_ORDER,
        limits: Object.freeze({ maxCandidatesPerChannel: 64, maxCandidatesAggregate: 128 }),
      }),
      candidates: Object.freeze([]),
      settlements: Object.freeze(RETRIEVAL_TRACE_CHANNEL_ORDER.map((channel) => Object.freeze({
        contractId: 'memberry.candidate-channel' as const,
        contractVersion: '1.0.0' as const,
        channel, outcome: 'safe-failure' as const, code: 'unavailable' as const,
      }))),
    });
    const candidateRuntime: IRuntimeCandidateChannelService = {
      execute: vi.fn().mockResolvedValue(execution),
    };
    const rerankerShadowCoordinator = options.shadow ? {
      trySchedule: vi.fn().mockReturnValue(true),
      shutdown: vi.fn().mockResolvedValue(undefined),
      snapshot: vi.fn().mockReturnValue(Object.freeze({ inFlight: 0 })),
    } : null;
    const candidateAssembler = Object.create(UnifiedAssembler.prototype) as UnifiedAssembler;
    vi.mocked(assembler.assembleCandidateExecution!).mockImplementation((...args) => (
      candidateAssembler.assembleCandidateExecution(...args)
    ));
    return {
      assembler, resolve, candidateRuntime,
      container: createRetrievalContainer({
        assembler,
        tenantId: 'tenant-a',
        authenticated: options.authenticated ?? true,
        queryPlannerEnabled: options.planner ?? true,
        resolverFactory: () => ({ resolve }),
        candidateChannelEnabled: options.candidate ?? true,
        candidateRuntime,
        rerankerShadowCoordinator,
      }),
      rerankerShadowCoordinator,
    };
  }

  it('shares the exact process-default coordinator pointer with every tenant container and resets it when omitted', () => {
    const assembler = makeAssembler();
    const feedbackTracker = makeFeedback();
    const coordinator = {
      trySchedule: vi.fn().mockReturnValue(true), shutdown: vi.fn(), snapshot: vi.fn(),
    };
    setRetrievalServiceInstances({ assembler, feedbackTracker, rerankerShadowCoordinator: coordinator });
    expect(retrievalContainerForTenant('default').rerankerShadowCoordinator).toBe(coordinator);
    expect(retrievalContainerForTenant('tenant-a').rerankerShadowCoordinator).toBe(coordinator);
    setRetrievalServiceInstances({ assembler, feedbackTracker });
    expect(retrievalContainerForTenant('tenant-a').rerankerShadowCoordinator).toBeNull();
  });

  it.each([
    ['ordinary context', 'berry_context', { task: 'safe', project_name: 'project:memberry', entity_scope: ['Resolver'] }],
    ['traced context', 'berry_context', { task: 'safe', project_name: 'project:memberry', entity_scope: ['Resolver'], include_trace: true, include_arch: true, include_memory: true }],
    ['ask', 'berry_ask', { question: 'safe?', project_name: 'project:memberry', entity_scope: ['Resolver'] }],
  ] as const)('%s closes the sealed receipt into the post-dedup shadow thunk', async (_label, tool, args) => {
    const { container, rerankerShadowCoordinator } = candidateContainer({ shadow: true });
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, container);
    await handlers.get(tool)!(args);
    expect(rerankerShadowCoordinator!.trySchedule).toHaveBeenCalledTimes(1);
    const thunk = vi.mocked(rerankerShadowCoordinator!.trySchedule).mock.calls[0]![0] as () => Record<string, unknown>;
    const scheduled = thunk();
    expect(readRuntimeQueryPlannerAuthorityV1(scheduled.receipt)).toMatchObject({
      tenantId: 'tenant-a', projectScope: 'project:memberry', resolvedEntityId: 'entity-stable',
    });
    expect(scheduled).toMatchObject({ query: tool === 'berry_ask' ? 'safe?' : 'safe' });
  });

  it('keeps an explicit deterministic context request shadow-free', async () => {
    const { container, rerankerShadowCoordinator } = candidateContainer({ shadow: true });
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, container);
    await handlers.get('berry_context')!({
      task: 'stable', strategy: 'deterministic', project_name: 'project:memberry', entity_scope: ['Resolver'],
      max_tokens: 8_000, include_arch: true, include_memory: true,
    });
    expect(rerankerShadowCoordinator!.trySchedule).not.toHaveBeenCalled();
    expect(container.assembler!.assembleCandidateExecution).toHaveBeenCalledWith(
      'stable', expect.anything(), 8_000, true, true, false,
    );
  });

  it('canonicalizes a documented display project name on deterministic candidate context', async () => {
    const { container, resolve, candidateRuntime } = candidateContainer();
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, container);

    await handlers.get('berry_context')!({
      task: 'Write an exact resumption handoff after an interrupted verification run.',
      project_name: 'Guardrail Control Plane',
      tag_scope: ['project:guardrail-control-plane', 'clean-room', 'deterministic-enforcement'],
      entity_scope: ['hhHACiJJL5t7AUBJyA2UU'],
      include_arch: true,
      include_code: true,
      include_memory: true,
      max_tokens: 3_000,
      strategy: 'deterministic',
    });

    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({
      authority: expect.objectContaining({
        callerScopes: expect.objectContaining({ projects: ['project:guardrail-control-plane'] }),
      }),
      hints: expect.objectContaining({ entities: ['hhHACiJJL5t7AUBJyA2UU'] }),
    }));
    const receipt = vi.mocked(candidateRuntime.execute).mock.calls[0]![0];
    expect(readRuntimeQueryPlannerAuthorityV1(receipt)).toMatchObject({
      tenantId: 'tenant-a',
      projectScope: 'project:guardrail-control-plane',
      resolvedEntityId: 'entity-stable',
    });
  });

  it('berry_context raw deterministic for a named tenant forces ranked-v1 through the exact disable latch', async () => {
    const assembler = makeAssembler(true);
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, createRetrievalContainer({ assembler, tenantId: 'acme' }));

    await handlers.get('berry_context')!({ task: 'stable', strategy: 'deterministic' });

    expect(assembler.assemble).toHaveBeenCalledWith('stable', expect.objectContaining({
      strategy: 'ranked', tenantId: 'acme', servedRerankerDisabled: true,
    }));
  });

  it('keeps default-tenant deterministic exact with a served-enabled assembler', async () => {
    const assembler = makeAssembler(true);
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, createRetrievalContainer({ assembler }));
    await handlers.get('berry_context')!({ task: 'stable', strategy: 'deterministic' });
    expect(assembler.assemble).toHaveBeenCalledWith('stable', expect.objectContaining({
      strategy: 'deterministic', tenantId: 'default',
    }));
    expect(vi.mocked(assembler.assemble).mock.calls[0]![1]).not.toHaveProperty('servedRerankerDisabled');
  });

  it.each(['auto', 'ranked'] as const)('uses the served candidate method for %s and ignores a shadow pointer', async (strategy) => {
    const { assembler, candidateRuntime, container, rerankerShadowCoordinator } = candidateContainer({
      served: true, shadow: true,
    });
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, container);
    await handlers.get('berry_context')!({
      task: 'served', strategy, project_name: 'project:memberry', entity_scope: ['Resolver'],
      max_tokens: 8_000, include_arch: true, include_memory: true,
    });

    expect(candidateRuntime.execute).toHaveBeenCalledTimes(1);
    // COD-010b: `options` at position 8 (probe at 7 stays undefined when the
    // multihop flag is off). Every pre-existing argument claim is unchanged.
    expect(assembler.assembleCandidateExecutionServed).toHaveBeenCalledWith(
      'served', expect.anything(), 8_000, true, true, false, undefined, { includeCode: false },
    );
    expect(assembler.assembleCandidateExecution).not.toHaveBeenCalled();
    expect(rerankerShadowCoordinator!.trySchedule).not.toHaveBeenCalled();
  });

  it('passes the assembler query vector only to memory-enabled anchored candidate execution', async () => {
    const { assembler, candidateRuntime, container } = candidateContainer({ served: true });
    const queryVector = [0.25, 0.75];
    assembler.candidateQueryVector = vi.fn().mockResolvedValue(queryVector);
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, container);
    await handlers.get('berry_context')!({
      task: 'vector query', strategy: 'ranked', project_name: 'memberry', entity_scope: ['Resolver'],
      include_arch: false, include_memory: true,
    });
    expect(assembler.candidateQueryVector).toHaveBeenCalledWith('vector query');
    expect(candidateRuntime.execute).toHaveBeenCalledWith(expect.anything(), {
      includeArchitecture: false, includeMemory: true, queryText: 'vector query', queryVector,
    });
  });

  it('keeps deterministic candidate context on the synchronous v1 path with a served provider present', async () => {
    const { assembler, container } = candidateContainer({ served: true, shadow: true });
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, container);
    await handlers.get('berry_context')!({
      task: 'stable', strategy: 'deterministic', project_name: 'project:memberry', entity_scope: ['Resolver'],
      max_tokens: 8_000, include_arch: true, include_memory: true,
    });
    expect(assembler.assembleCandidateExecution).toHaveBeenCalledWith(
      'stable', expect.anything(), 8_000, true, true, false,
    );
    expect(assembler.assembleCandidateExecutionServed).not.toHaveBeenCalled();
  });

  it('candidate summary diagnostics do not allocate the full trace collector', async () => {
    const { assembler, container } = candidateContainer();
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, container);

    const result = await handlers.get('berry_context')!({
      task: 'bounded', strategy: 'ranked', project_name: 'project:memberry', entity_scope: ['Resolver'],
      max_tokens: 8_000, include_code: false, include_arch: true, include_memory: true,
      include_trace: true, trace_detail: 'summary',
    }) as { content: Array<{ text: string }> };

    expect(assembler.assembleCandidateExecution).toHaveBeenCalledWith(
      'bounded', expect.anything(), 8_000, true, true, false,
    );
    expect(JSON.parse(result.content[1]!.text)).toMatchObject({
      kind: 'retrieval-trace-summary', bounded: true, replayable: false,
    });
  });

  it('checks the selected served method before candidate execution', async () => {
    const { assembler, candidateRuntime, container } = candidateContainer({ served: true });
    delete assembler.assembleCandidateExecutionServed;
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, container);
    await expect(handlers.get('berry_context')!({
      task: 'blocked', strategy: 'ranked', project_name: 'project:memberry', entity_scope: ['Resolver'],
    })).rejects.toThrow('candidate_runtime:unavailable');
    expect(candidateRuntime.execute).not.toHaveBeenCalled();
  });

  it('runs the real in-process handler through receipt execution and the served assembler', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ answer: 'served synthesis', cited: [1] }));
    const realAssembler = new UnifiedAssembler(
      {} as never,
      { zincrby: vi.fn(), zrevrangeWithScores: vi.fn(), lpush: vi.fn(), ltrim: vi.fn() },
      null,
      null,
      { available: false, embed: vi.fn(), embedBatch: vi.fn() },
      { available: true, chat, modelFor: vi.fn(() => 'test-model') },
      createServedRerankerProviderV1(),
    );
    const execution = {
      contractId: 'memberry.candidate-channel' as const,
      contractVersion: '1.0.0' as const,
      request: {
        contractId: 'memberry.candidate-channel' as const,
        contractVersion: '1.0.0' as const,
        tenantId: 'tenant-a', projectScope: 'project:memberry', resolvedEntityIds: ['entity-stable'],
        temporalFrame: { mode: 'current' as const }, plannedChannels: ['memory.scope' as const],
        limits: { maxCandidatesPerChannel: 64, maxCandidatesAggregate: 128 },
      },
      candidates: [
        {
          contractId: 'memberry.candidate-channel' as const, contractVersion: '1.0.0' as const,
          channel: 'memory.scope' as const, tenantId: 'tenant-a', projectScope: 'project:memberry',
          resolvedEntityId: 'entity-stable', temporalFrame: { mode: 'current' as const },
          sourceType: 'semantic' as const, evidenceId: 'baseline-first', rank: 1, score: 1,
          title: 'Generic', content: 'unrelated generic material',
          provenance: { kind: 'semantic' as const, semanticId: 'baseline-first' },
        },
        {
          contractId: 'memberry.candidate-channel' as const, contractVersion: '1.0.0' as const,
          channel: 'memory.scope' as const, tenantId: 'tenant-a', projectScope: 'project:memberry',
          resolvedEntityId: 'entity-stable', temporalFrame: { mode: 'current' as const },
          sourceType: 'semantic' as const, evidenceId: 'needle-second', rank: 2, score: 0.01,
          title: 'Needle', content: 'needle needle needle',
          provenance: { kind: 'semantic' as const, semanticId: 'needle-second' },
        },
      ],
      settlements: [{
        contractId: 'memberry.candidate-channel' as const, contractVersion: '1.0.0' as const,
        channel: 'memory.scope' as const, outcome: 'success' as const, candidateCount: 2,
      }],
    };
    const candidateRuntime = { execute: vi.fn().mockResolvedValue(execution) };
    const resolverFactory = () => ({ resolve: vi.fn().mockResolvedValue({
      resolution: { state: 'resolved' as const, canonicalEntityIds: ['entity-stable'] }, diagnostics: [],
    }) });
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, createRetrievalContainer({
      assembler: realAssembler, tenantId: 'tenant-a', authenticated: true, queryPlannerEnabled: true,
      resolverFactory, candidateChannelEnabled: true, candidateRuntime,
    }));

    const response = await handlers.get('berry_context')!({
      task: 'needle', strategy: 'ranked', project_name: 'project:memberry', entity_scope: ['Resolver'],
      include_arch: false, include_memory: true, max_tokens: 8_000, include_trace: true,
    }) as { content: Array<{ text: string }> };
    expect(candidateRuntime.execute).toHaveBeenCalledTimes(1);
    expect(response.content[0]!.text.indexOf('needle needle needle'))
      .toBeLessThan(response.content[0]!.text.indexOf('unrelated generic material'));
    const trace = JSON.parse(response.content[1]!.text) as RetrievalTraceV1;
    expect(trace.algorithmVersion).toBe('ranked-v2');
    expect(replayRetrievalTrace(trace).resultOrder).toEqual(trace.resultOrder);
    expect(response.content[1]!.text).toBe(canonicalTraceJson(trace));

    const askResponse = await handlers.get('berry_ask')!({
      question: 'needle', reasoning_level: 'high', project_name: 'project:memberry', entity_scope: ['Resolver'],
    }) as { content: Array<{ text: string }> };
    expect(candidateRuntime.execute).toHaveBeenCalledTimes(2);
    expect(chat).toHaveBeenCalledTimes(1);
    const prompt = chat.mock.calls[0]![0] as Array<{ role: string; content: string }>;
    const evidencePrompt = prompt.find((message) => message.role === 'user')!.content;
    expect(evidencePrompt.indexOf('needle needle needle'))
      .toBeLessThan(evidencePrompt.indexOf('unrelated generic material'));
    expect(askResponse.content[0]!.text).toContain('served synthesis');
    expect(askResponse.content[0]!.text).toContain('needle-second');
    expect(askResponse.content[0]!.text).toContain('needle needle needle');
  });

  it('candidate-off preserves all three exact legacy adapters and performs zero candidate work', async () => {
    const { assembler, candidateRuntime, container } = candidateContainer({ candidate: false, planner: false });
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, container);
    await handlers.get('berry_context')!({ task: 'legacy', strategy: 'ranked' });
    await handlers.get('berry_context')!({ task: 'legacy traced', strategy: 'ranked', include_trace: true });
    await handlers.get('berry_ask')!({ question: 'legacy ask', reasoning_level: 'low' });
    expect(candidateRuntime.execute).not.toHaveBeenCalled();
    expect(assembler.assemble).toHaveBeenCalledTimes(1);
    expect(assembler.assembleTraced).toHaveBeenCalledTimes(1);
    expect(assembler.ask).toHaveBeenCalledTimes(1);
  });

  it('candidate-on preserves authentication-first error precedence when the planner is unavailable', async () => {
    const { assembler, resolve, candidateRuntime, container } = candidateContainer({ planner: false, authenticated: false });
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, container);
    await expect(handlers.get('berry_context')!({ task: 'blocked' }))
      .rejects.toThrow('runtime_query_planner:authentication_required');
    expect(resolve).not.toHaveBeenCalled();
    expect(candidateRuntime.execute).not.toHaveBeenCalled();
    expect(assembler.assemble).not.toHaveBeenCalled();
  });

  it('authenticates before checking candidate runtime availability', async () => {
    const { assembler, resolve, container } = candidateContainer({ authenticated: false });
    container.candidateRuntime = null;
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, container);
    await expect(handlers.get('berry_context')!({ task: 'blocked' }))
      .rejects.toThrow('runtime_query_planner:authentication_required');
    expect(resolve).not.toHaveBeenCalled();
    expect(assembler.assemble).not.toHaveBeenCalled();
  });

  it('ordinary context resolves then uses only the receipt-bound candidate adapter', async () => {
    const { assembler, resolve, candidateRuntime, container } = candidateContainer();
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, container);
    const result = await handlers.get('berry_context')!({
      task: 'task [project:foreign] [tenant:foreign]', strategy: 'auto',
      project_name: 'project:memberry', entity_scope: ['Resolver'],
      include_arch: true, include_memory: true, include_code: true, max_tokens: 8_000,
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(candidateRuntime.execute).toHaveBeenCalledWith(
      expect.anything(), {
        includeArchitecture: true,
        includeMemory: true,
        queryText: 'task [project:foreign] [tenant:foreign]',
      },
    );
    expect(assembler.assembleCandidateExecution).toHaveBeenCalledWith(
      'task [project:foreign] [tenant:foreign]', expect.anything(), 8_000, true, true, false,
    );
    expect(assembler.assemble).not.toHaveBeenCalled();
    expect(assembler.assembleTraced).not.toHaveBeenCalled();
    expect(assembler.ask).not.toHaveBeenCalled();
    expect(result).toEqual({ content: [{ type: 'text', text: '# md' }] });
  });

  it('uses the independently sealed project and temporal frame even if caller args mutate during resolution', async () => {
    const { resolve, candidateRuntime, container } = candidateContainer();
    const request = {
      task: 'safe', strategy: 'ranked', project_name: 'project:memberry', entity_scope: ['Resolver'],
      as_of: '2026-08-16T10:20:30.000Z', include_arch: true, include_memory: true, max_tokens: 8_000,
    };
    resolve.mockImplementation(async () => {
      request.project_name = 'project:foreign';
      request.as_of = '2027-01-01T00:00:00.000Z';
      return Object.freeze({
        resolution: Object.freeze({ state: 'resolved', canonicalEntityIds: Object.freeze(['entity-stable']) }),
        diagnostics: Object.freeze([]),
      });
    });
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, container);
    await handlers.get('berry_context')!(request);
    const sealed = readRuntimeQueryPlannerAuthorityV1(vi.mocked(candidateRuntime.execute).mock.calls[0]![0]);
    expect(sealed).toMatchObject({
      tenantId: 'tenant-a', projectScope: 'project:memberry', resolvedEntityId: 'entity-stable',
      temporalFrame: { mode: 'as-of', asOf: '2026-08-16T10:20:30.000Z' },
    });
  });

  it('ask uses the same candidate adapter and synthesizes only the returned context', async () => {
    const { assembler, candidateRuntime, container } = candidateContainer();
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, container);
    await handlers.get('berry_ask')!({
      question: 'safe?', reasoning_level: 'high', project_name: 'project:memberry', entity_scope: ['Resolver'],
    });
    expect(candidateRuntime.execute).toHaveBeenCalledTimes(1);
    expect(assembler.askFromContext).toHaveBeenCalledWith('safe?', expect.anything(), 'high');
    expect(assembler.ask).not.toHaveBeenCalled();
    expect(assembler.assemble).not.toHaveBeenCalled();
  });

  it('feeds berry_ask the exact served candidate context', async () => {
    const { assembler, container } = candidateContainer({ served: true, shadow: true });
    const servedContext = {
      ...emptyCtx(),
      sections: [{ heading: 'Memories', source_type: 'semantic' as const, items: [{
        id: 'served-id', content: 'served evidence', score: 1, metadata: {},
      }] }],
    };
    vi.mocked(assembler.assembleCandidateExecutionServed!).mockResolvedValue({ context: servedContext });
    vi.mocked(assembler.askFromContext!).mockResolvedValue({
      answer: 'served answer', cited_ids: ['served-id'],
      evidence: [{ id: 'served-id', content: 'served evidence' }], level: 'high',
    });
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, container);
    const result = await handlers.get('berry_ask')!({
      question: 'served?', reasoning_level: 'high', project_name: 'project:memberry', entity_scope: ['Resolver'],
    }) as { content: Array<{ text: string }> };
    expect(assembler.assembleCandidateExecutionServed).toHaveBeenCalledTimes(1);
    expect(assembler.askFromContext).toHaveBeenCalledWith('served?', servedContext, 'high');
    expect(assembler.assembleCandidateExecution).not.toHaveBeenCalled();
    expect(result.content[0]!.text).toContain('served answer');
    expect(result.content[0]!.text).toContain('served-id');
    expect(result.content[0]!.text).toContain('served evidence');
  });

  it.each([
    ['minimal', 1_500], ['low', 3_000], ['medium', 6_000], ['high', 10_000], ['max', 16_000],
  ] as const)('propagates the %s reasoning-level retrieval budget', async (level, maxTokens) => {
    const { candidateRuntime, container } = candidateContainer();
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, container);
    await handlers.get('berry_ask')!({
      question: 'safe?', reasoning_level: level, project_name: 'project:memberry', entity_scope: ['Resolver'],
    });
    expect(candidateRuntime.execute).toHaveBeenCalledTimes(1);
    expect(container.assembler!.assembleCandidateExecution).toHaveBeenCalledWith(
      'safe?', expect.anything(), maxTokens, true, true, false,
    );
  });

  it('traced context uses the same candidate execution and exposes canonical content-free trace bytes', async () => {
    const { assembler, candidateRuntime, container } = candidateContainer();
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, container);
    const result = await handlers.get('berry_context')!({
      task: 'safe', strategy: 'ranked', project_name: 'project:memberry', entity_scope: ['Resolver'],
      include_arch: true, include_memory: true, include_code: true, max_tokens: 8_000, include_trace: true,
    }) as { content: Array<{ text: string }> };
    expect(candidateRuntime.execute).toHaveBeenCalledTimes(1);
    expect(assembler.assembleTraced).not.toHaveBeenCalled();
    expect(result.content).toHaveLength(2);
    const trace = JSON.parse(result.content[1]!.text) as RetrievalTraceV1;
    expect(trace.requestShape.plannedChannels).toEqual(RETRIEVAL_TRACE_CHANNEL_ORDER);
    expect(trace.complete).toBe(true);
  });
});
