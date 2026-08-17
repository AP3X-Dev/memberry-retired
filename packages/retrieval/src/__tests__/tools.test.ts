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
  serializeApprovedRetrievalTrace,
  type IUnifiedAssembler,
  type IFeedbackTracker,
  type RetrievalTraceValidationRuntime,
  type RetrievalTraceValidationStage,
  type IRuntimeCandidateChannelService,
} from '../tools.js';
import { canonicalTraceJson, RETRIEVAL_TRACE_CHANNEL_ORDER } from '../trace.js';
import type { RetrievalTraceV1 } from '../trace.js';
import type { UnifiedContext } from '../types.js';
import type { QueryPlanV1 } from '../query-plan.js';
import type { ScopedEntityTrustedAuthorityV1 } from '../scoped-entity-resolver.js';
import { readRuntimeQueryPlannerAuthorityV1 } from '../runtime-query-planner.js';
import { UnifiedAssembler } from '../assembler.js';

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

function makeAssembler(): IUnifiedAssembler {
  return {
    assemble: vi.fn().mockResolvedValue(emptyCtx()),
    assembleTraced: vi.fn().mockResolvedValue({ context: emptyCtx(), trace: approvedTrace }),
    renderMarkdown: vi.fn().mockReturnValue('# md'),
    ask: vi.fn().mockResolvedValue({ answer: 'a', cited_ids: [], evidence: [], level: 'medium' }),
    askFromContext: vi.fn().mockResolvedValue({ answer: 'a', cited_ids: [], evidence: [], level: 'medium' }),
    assembleCandidateExecution: vi.fn().mockReturnValue({ context: emptyCtx(), trace: approvedTrace }),
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

  it('berry_context include_trace=true preserves forced-ranked isolation for named tenants', async () => {
    const assembler = makeAssembler();
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, createRetrievalContainer({ assembler, tenantId: 'acme' }));

    await handlers.get('berry_context')!({ task: 'what depends on auth', strategy: 'deterministic', include_trace: true });

    expect(assembler.assembleTraced).toHaveBeenCalledWith(
      'what depends on auth',
      expect.objectContaining({ strategy: 'ranked', tenantId: 'acme' }),
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
    const container = createRetrievalContainer({
      assembler,
      tenantId: 'tenant-a',
      authenticated: options.authenticated ?? true,
      queryPlannerEnabled: options.enabled ?? true,
      resolverFactory,
    });
    return { assembler, resolve, resolverFactory, container };
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
      ? { task: 'blocked', project_name: 'Memberry', entity_scope: ['Resolver'] }
      : { question: 'blocked', project_name: 'Memberry', entity_scope: ['Resolver'] };
    await expect(handlers.get(tool)!(args)).rejects.toThrowError('runtime_query_planner:invalid_request');
    expect(resolverFactory).not.toHaveBeenCalled();
    expect(assembler.assemble).not.toHaveBeenCalled();
    expect(assembler.ask).not.toHaveBeenCalled();
    expect(assembler.renderMarkdown).not.toHaveBeenCalled();
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
      task: 'safe', strategy: 'ranked', project_name: 'project:memberry',
      entity_scope: ['Resolver', 'alias', 'Resolver'], include_trace: traced,
    });
    const authority = resolverFactory.mock.calls[0]![0];
    const plan = resolve.mock.calls[0]![0] as QueryPlanV1;
    expect(authority).toEqual({ tenantId: 'tenant-a', projectScopes: ['project:memberry'] });
    expect(plan.hints.entities).toEqual(['Resolver', 'alias']);
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
      question: 'safe', reasoning_level: 'high', project_name: 'project:memberry', entity_scope: ['Resolver'],
    });
    expect(assembler.ask).toHaveBeenCalledWith('safe', expect.objectContaining({
      level: 'high', tenantId: 'tenant-a', resolvedEntityIds: ['entity-stable'],
    }));
  });
});

describe('RET-003B candidate-channel runtime wiring', () => {
  function candidateContainer(options: { candidate?: boolean; planner?: boolean; authenticated?: boolean } = {}) {
    const assembler = makeAssembler();
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
      }),
    };
  }

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
      expect.anything(), { includeArchitecture: true, includeMemory: true },
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
