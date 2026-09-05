// packages/retrieval/src/__tests__/tools.unanchored-routing.test.ts
// RL-018: a berry_context/berry_ask call that names no entity is ordinary usage — 5 of the 13
// real mined berry_context calls are that shape — but the runtime query planner is anchored on
// exactly one resolved entity and rejected every one of them with
// `runtime_query_planner:invalid_request`. Unanchored requests must route to the task-text path.
//
// The pin is two-sided on purpose: routing too little leaves the defect, routing too much would
// let a caller escape the planner by sending a malformed scope. Absent, never invalid.
import { readFileSync } from 'node:fs';
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  createRetrievalContainer,
  registerRetrievalTools,
  type IUnifiedAssembler,
  type IRuntimeCandidateChannelService,
} from '../tools.js';
import { RETRIEVAL_TRACE_CHANNEL_ORDER } from '../trace.js';
import type { RetrievalTraceV1 } from '../trace.js';
import type { UnifiedContext } from '../types.js';
import { getRetrievalResolutionProcessStatusV1 } from '../resolution-observability.js';

const approvedTrace = JSON.parse(readFileSync(
  new URL('./fixtures/retrieval-trace-deterministic-v2.json', import.meta.url),
  'utf8',
)) as RetrievalTraceV1;

afterEach(() => {
  vi.restoreAllMocks();
});

function emptyCtx(): UnifiedContext {
  return { task: 'q', strategy: 'ranked', sections: [], token_count: 0, assembled_at: '2026-06-07T00:00:00.000Z' };
}

function makeAssembler(context: UnifiedContext): IUnifiedAssembler {
  return {
    servedRerankerEnabled: false,
    assemble: vi.fn().mockResolvedValue(context),
    assembleTraced: vi.fn().mockResolvedValue({ context, trace: approvedTrace }),
    renderMarkdown: vi.fn().mockReturnValue('# md'),
    ask: vi.fn().mockResolvedValue({ answer: 'a', cited_ids: [], evidence: [], level: 'medium' }),
    askFromContext: vi.fn().mockResolvedValue({ answer: 'a', cited_ids: [], evidence: [], level: 'medium' }),
    assembleCandidateExecution: vi.fn().mockReturnValue({ context, trace: approvedTrace }),
    assembleCandidateExecutionServed: vi.fn().mockResolvedValue({ context, trace: approvedTrace }),
  };
}

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

function processCounters() {
  const status = getRetrievalResolutionProcessStatusV1();
  return {
    calls: status.calls as Record<string, number>,
    routing: status.routing as Record<string, number>,
    resolution: status.resolution as Record<string, number | null>,
  };
}

/** The live production shape: planner ON, candidate channel ON, resolver that would succeed. */
function liveContainer(context: UnifiedContext) {
  const assembler = makeAssembler(context);
  const resolve = vi.fn().mockResolvedValue(Object.freeze({
    resolution: Object.freeze({ state: 'resolved', canonicalEntityIds: Object.freeze(['entity-stable']) }),
    diagnostics: Object.freeze([]),
  }));
  const execution = Object.freeze({
    contractId: 'memberry.candidate-channel' as const,
    contractVersion: '1.0.0' as const,
    request: Object.freeze({
      contractId: 'memberry.candidate-channel' as const,
      contractVersion: '1.0.0' as const,
      tenantId: 'default',
      projectScope: 'project:memberry',
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
  return {
    assembler,
    resolve,
    candidateRuntime,
    container: createRetrievalContainer({
      assembler,
      tenantId: 'default',
      authenticated: true,
      queryPlannerEnabled: true,
      resolverFactory: () => ({ resolve }),
      candidateChannelEnabled: true,
      candidateRuntime,
    }),
  };
}

function live(context: UnifiedContext) {
  const parts = liveContainer(context);
  const { server, handlers } = makeServerStub();
  registerRetrievalTools(server as never, parts.container);
  return { ...parts, handlers };
}

describe('RL-018 unanchored requests route to the task-text path', () => {
  // Three shapes, all three genuinely present in mined-queries.jsonl's 13 berry_context calls:
  // no entity_scope key (3 calls), an explicit `entity_scope: []` (1 call, q-9a3b156bf8d8), and
  // neither field (1 call). A fourth row -- entities but no project_name -- was listed here as
  // mined and is NOT: it appears in zero real calls, and it is no longer unanchored anyway.
  // See "an entity named without a project" below for where that shape went and why.
  const unanchored: Array<[string, Record<string, unknown>]> = [
    ['no entity_scope key at all', { project_name: 'project:memberry' }],
    ['an explicitly empty entity_scope', { project_name: 'project:memberry', entity_scope: [] }],
    ['neither', {}],
  ];

  for (const [label, scope] of unanchored) {
    it(`berry_context with ${label} assembles from task text and never calls the resolver`, async () => {
      const context = emptyCtx();
      const { assembler, resolve, candidateRuntime, handlers } = live(context);

      const result = await handlers.get('berry_context')!({ task: 'what changed in retrieval', ...scope });

      // Before the fix this threw `runtime_query_planner:invalid_request`.
      expect(result).toEqual({ content: [{ type: 'text', text: '# md' }] });
      expect(resolve).not.toHaveBeenCalled();
      expect(candidateRuntime.execute).not.toHaveBeenCalled();
      expect(assembler.assemble).toHaveBeenCalledTimes(1);
      // The task-text shape: no resolvedEntityIds key, so the episodic vector channel stays on.
      const options = vi.mocked(assembler.assemble).mock.calls[0]![1] as Record<string, unknown>;
      expect(options).not.toHaveProperty('resolvedEntityIds');
      expect(vi.mocked(assembler.assemble).mock.calls[0]![0]).toBe('what changed in retrieval');
    });

    it(`berry_ask with ${label} answers from task text and never calls the resolver`, async () => {
      const { assembler, resolve, handlers } = live(emptyCtx());

      await handlers.get('berry_ask')!({ question: 'why did ranking change', reasoning_level: 'medium', ...scope });

      expect(resolve).not.toHaveBeenCalled();
      expect(assembler.askFromContext).not.toHaveBeenCalled();
      expect(assembler.ask).toHaveBeenCalledTimes(1);
      const options = vi.mocked(assembler.ask).mock.calls[0]![1] as Record<string, unknown>;
      expect(options).not.toHaveProperty('resolvedEntityIds');
    });
  }

  // REGRESSION PIN for a defect in the first cut of this fix. `plannerAnchored` originally
  // required an entity anchor AND a project, which made "name an entity, omit project_name" route
  // to the unvalidated task-text sweep -- letting a caller skip SAFE_HINT/RESERVED_AUTHORITY_HINT
  // on their own entity_scope by dropping an unrelated field. Naming an entity always means the
  // planner judges the request, including the part the caller left out.
  it('an entity named without a project reaches the planner and fails loudly, never the sweep', async () => {
    const { assembler, resolve, candidateRuntime, handlers } = live(emptyCtx());

    await expect(handlers.get('berry_context')!({ task: 'q', entity_scope: ['Resolver'] }))
      .rejects.toThrow('runtime_query_planner:invalid_request');
    await expect(handlers.get('berry_ask')!({ question: 'q', entity_scope: ['Resolver'] }))
      .rejects.toThrow('runtime_query_planner:invalid_request');

    // The point of the pin: it must not have quietly answered from task text instead.
    expect(assembler.assemble).not.toHaveBeenCalled();
    expect(assembler.ask).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(candidateRuntime.execute).not.toHaveBeenCalled();
  });

  it('a reserved-authority hint cannot escape validation by dropping project_name', async () => {
    const { assembler, handlers } = live(emptyCtx());

    await expect(handlers.get('berry_context')!({ task: 'sneaky', entity_scope: ['project:other'] }))
      .rejects.toThrow('runtime_query_planner:invalid_request');

    expect(assembler.assemble).not.toHaveBeenCalled();
  });

  it('an anchored request still takes the candidate channel — the fix routes nothing extra', async () => {
    const { assembler, resolve, candidateRuntime, handlers } = live(emptyCtx());

    await handlers.get('berry_context')!({
      task: 'safe', project_name: 'project:memberry', entity_scope: ['Resolver'],
    });

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(candidateRuntime.execute).toHaveBeenCalledTimes(1);
    expect(assembler.assemble).not.toHaveBeenCalled();
  });

  it('a SUPPLIED but malformed entity_scope still fails loudly — it is not an escape hatch', async () => {
    const { assembler, handlers } = live(emptyCtx());

    // `project:` prefixed hints are reserved authority (RESERVED_AUTHORITY_HINT) and can never
    // be caller-supplied. Present, so the planner judges it — and rejects it.
    await expect(handlers.get('berry_context')!({
      task: 'sneaky', project_name: 'project:memberry', entity_scope: ['project:other'],
    })).rejects.toThrow('runtime_query_planner:invalid_request');

    expect(assembler.assemble).not.toHaveBeenCalled();
  });

  it('a supplied but malformed project_name still fails loudly', async () => {
    const { assembler, handlers } = live(emptyCtx());

    await expect(handlers.get('berry_context')!({
      task: 'sneaky', project_name: 'project:memberry/foreign', entity_scope: ['Resolver'],
    })).rejects.toThrow('runtime_query_planner:invalid_request');

    expect(assembler.assemble).not.toHaveBeenCalled();
  });

  // Routing must not become an authentication bypass. The first cut of this fix skipped the
  // planner for unanchored requests, and the planner is where `authenticated` is checked — so
  // omitting entity_scope silently bought an answer without authenticating. The gate caught it.
  describe('authentication is orthogonal to anchoring', () => {
    function unauthenticated(overrides: Partial<Parameters<typeof createRetrievalContainer>[0]>) {
      const assembler = makeAssembler(emptyCtx());
      const resolve = vi.fn();
      const { server, handlers } = makeServerStub();
      registerRetrievalTools(server as never, createRetrievalContainer({
        assembler, tenantId: 'default', authenticated: false,
        resolverFactory: () => ({ resolve }), ...overrides,
      }));
      return { assembler, resolve, handlers };
    }

    for (const [label, flags] of [
      ['candidate channel on', { candidateChannelEnabled: true, queryPlannerEnabled: true }],
      ['planner on, candidate off', { candidateChannelEnabled: false, queryPlannerEnabled: true }],
    ] as const) {
      it(`rejects an unanchored request from an unauthenticated caller (${label})`, async () => {
        const { assembler, resolve, handlers } = unauthenticated(flags);
        const before = processCounters();

        await expect(handlers.get('berry_context')!({ task: 'blocked' }))
          .rejects.toThrow('runtime_query_planner:authentication_required');
        await expect(handlers.get('berry_ask')!({ question: 'blocked' }))
          .rejects.toThrow('runtime_query_planner:authentication_required');

        const after = processCounters();
        expect(after.calls.total - before.calls.total).toBe(2);
        expect(after.calls.berry_context - before.calls.berry_context).toBe(1);
        expect(after.calls.berry_ask - before.calls.berry_ask).toBe(1);
        expect(after.routing.unanchored - before.routing.unanchored).toBe(2);
        expect((after.resolution.attempted as number) - (before.resolution.attempted as number)).toBe(2);
        expect((after.resolution.authentication_required as number)
          - (before.resolution.authentication_required as number)).toBe(2);
        expect((after.resolution.resolved as number) - (before.resolution.resolved as number)).toBe(0);

        expect(resolve).not.toHaveBeenCalled();
        expect(assembler.assemble).not.toHaveBeenCalled();
        expect(assembler.ask).not.toHaveBeenCalled();
      });
    }

    it('with both switches off there is no planner to authenticate against — legacy path intact', async () => {
      const { assembler, handlers } = unauthenticated({
        candidateChannelEnabled: false, queryPlannerEnabled: false,
      });

      await handlers.get('berry_context')!({ task: 'legacy', strategy: 'ranked' });

      expect(assembler.assemble).toHaveBeenCalledTimes(1);
    });
  });

  it('an anchored request whose entity does not resolve degrades LOUDLY, never silently (B-3, 2026-09-05)', async () => {
    // This pin used to demand a throw here. B-3 reversed the routing call once structured denial
    // reasons showed that, live, every such failure was a symbol, slug or path with no Entity —
    // ordinary usage, never an authority denial. The concern the old pin guarded is unchanged and
    // is what this test now checks: the downgrade must not be SILENT. The response opens with a
    // value-free note, the resolution is still counted as failed, and the candidate runtime is
    // never entered. See tools.entity-not-found-fallback.test.ts for the full matrix.
    const { assembler, candidateRuntime, container } = liveContainer(emptyCtx());
    const notFound = createRetrievalContainer({
      ...container,
      resolverFactory: () => ({
        resolve: vi.fn().mockResolvedValue(Object.freeze({
          resolution: Object.freeze({ state: 'not-found', canonicalEntityIds: Object.freeze([]) }),
          diagnostics: Object.freeze(['entity_not_found']),
        })),
      }),
    });
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, notFound);

    const before = processCounters();
    const result = await handlers.get('berry_context')!({
      task: 'q', project_name: 'project:memberry', entity_scope: ['NoSuchThing'],
    }) as { content: Array<{ type: string; text: string }> };
    const after = processCounters();

    expect(result.content[0]!.text).toBe('**Entity scope:** unresolved (entity_not_found); answered from task text\n\n# md');
    expect(candidateRuntime.execute).not.toHaveBeenCalled();
    expect(assembler.assemble).toHaveBeenCalledTimes(1);
    expect((after.resolution.resolution_failed as number) - (before.resolution.resolution_failed as number)).toBe(1);
  });
});
