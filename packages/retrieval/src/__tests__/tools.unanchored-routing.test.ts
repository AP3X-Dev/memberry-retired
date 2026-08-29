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
  // The four real mined shapes. `eval001-d-08` is the first row; `eval001-d-04` is the last.
  const unanchored: Array<[string, Record<string, unknown>]> = [
    ['no entity_scope key at all', { project_name: 'project:memberry' }],
    ['an explicitly empty entity_scope', { project_name: 'project:memberry', entity_scope: [] }],
    ['entities but no project_name', { entity_scope: ['Resolver'] }],
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
      task: 'sneaky', project_name: 'not-a-project-scope', entity_scope: ['Resolver'],
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

        await expect(handlers.get('berry_context')!({ task: 'blocked' }))
          .rejects.toThrow('runtime_query_planner:authentication_required');
        await expect(handlers.get('berry_ask')!({ question: 'blocked' }))
          .rejects.toThrow('runtime_query_planner:authentication_required');

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

  it('an anchored request whose entity does not resolve still fails loudly', async () => {
    // Naming an entity that is not there is a real answer, not a routing problem. It must not
    // silently downgrade into a broad task-text sweep.
    const { assembler, container } = liveContainer(emptyCtx());
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

    await expect(handlers.get('berry_context')!({
      task: 'q', project_name: 'project:memberry', entity_scope: ['NoSuchThing'],
    })).rejects.toThrow('runtime_query_planner:resolution_failed');

    expect(assembler.assemble).not.toHaveBeenCalled();
  });
});
