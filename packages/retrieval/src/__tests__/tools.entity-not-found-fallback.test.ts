// packages/retrieval/src/__tests__/tools.entity-not-found-fallback.test.ts
// B-3: an anchored berry_context/berry_ask whose hint names no Entity is ordinary usage (live,
// every resolver-probe failure was `entity_not_found`: symbols, slugs, paths). It degrades to the
// task-text path and says so, instead of failing. Every other denial reason still throws, and the
// resolution is still counted as failed — only the response degrades.
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

const NOTE = '**Entity scope:** unresolved (entity_not_found); answered from task text';

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

function resolution() {
  const status = getRetrievalResolutionProcessStatusV1();
  return status.resolution as Record<string, number | null>;
}

const denied = (code: string) => Object.freeze({
  resolution: Object.freeze({ state: 'denied', canonicalEntityIds: Object.freeze([]) }),
  diagnostics: Object.freeze([code]),
});

function container(diagnostic: string, mode: { candidateChannelEnabled: boolean }) {
  const assembler = makeAssembler(emptyCtx());
  const resolve = vi.fn().mockResolvedValue(denied(diagnostic));
  const candidateRuntime: IRuntimeCandidateChannelService = { execute: vi.fn() };
  const parts = createRetrievalContainer({
    assembler,
    tenantId: 'default',
    authenticated: true,
    queryPlannerEnabled: true,
    resolverFactory: () => ({ resolve }),
    candidateChannelEnabled: mode.candidateChannelEnabled,
    ...(mode.candidateChannelEnabled ? { candidateRuntime } : {}),
  });
  const { server, handlers } = makeServerStub();
  registerRetrievalTools(server as never, parts);
  return { assembler, resolve, candidateRuntime, handlers };
}

void RETRIEVAL_TRACE_CHANNEL_ORDER;

describe('B-3: entity_not_found degrades an anchored call to the task-text path', () => {
  for (const [label, mode] of [
    ['planner on, candidate channel on (production)', { candidateChannelEnabled: true }],
    ['planner on, candidate channel off (legacy)', { candidateChannelEnabled: false }],
  ] as const) {
    it(`berry_context, ${label}: answers from task text, discloses, never enters the candidate runtime, still counts the failure`, async () => {
      const { assembler, resolve, candidateRuntime, handlers } = container('entity_not_found', mode);
      const before = resolution();
      const result = await handlers.get('berry_context')!({
        task: 'what does the resolver do', project_name: 'project:memberry', entity_scope: ['ScopedEntityResolver'],
      }) as { content: Array<{ type: string; text: string }> };
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(candidateRuntime.execute).not.toHaveBeenCalled();
      expect(assembler.assemble).toHaveBeenCalledTimes(1);
      const options = vi.mocked(assembler.assemble).mock.calls[0]![1] as Record<string, unknown>;
      expect(options).not.toHaveProperty('resolvedEntityIds');
      expect(result.content).toHaveLength(1);
      expect(result.content[0]!.text).toBe(`${NOTE}\n\n# md`);
      const after = resolution();
      expect((after.resolution_failed as number) - (before.resolution_failed as number)).toBe(1);
      expect((after.resolved as number) - (before.resolved as number)).toBe(0);
    });

    it(`berry_ask, ${label}: same degradation`, async () => {
      const { assembler, resolve, handlers } = container('entity_not_found', mode);
      const result = await handlers.get('berry_ask')!({
        question: 'what does the resolver do', reasoning_level: 'medium',
        project_name: 'project:memberry', entity_scope: ['ScopedEntityResolver'],
      }) as { content: Array<{ type: string; text: string }> };
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(assembler.askFromContext).not.toHaveBeenCalled();
      expect(assembler.ask).toHaveBeenCalledTimes(1);
      const options = vi.mocked(assembler.ask).mock.calls[0]![1] as Record<string, unknown>;
      expect(options).not.toHaveProperty('resolvedEntityIds');
      expect(result.content[0]!.text.startsWith(`${NOTE}\n\n# Answer`)).toBe(true);
    });

    it(`berry_context, ${label}: every other denial reason still throws with its reason`, async () => {
      for (const reason of ['project_denied', 'entity_ambiguous', 'authority_mismatch', 'entity_id_denied']) {
        const { assembler, handlers } = container(reason, mode);
        await expect(handlers.get('berry_context')!({
          task: 'blocked', project_name: 'project:memberry', entity_scope: ['Resolver'],
        })).rejects.toThrow(`runtime_query_planner:resolution_failed:${reason}`);
        expect(assembler.assemble).not.toHaveBeenCalled();
      }
    });
  }

  it('a resolved entity never sees the note (production shape)', async () => {
    const assembler = makeAssembler(emptyCtx());
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
    const candidateRuntime: IRuntimeCandidateChannelService = { execute: vi.fn().mockResolvedValue(execution) };
    const parts = createRetrievalContainer({
      assembler, tenantId: 'default', authenticated: true, queryPlannerEnabled: true,
      resolverFactory: () => ({ resolve }), candidateChannelEnabled: true, candidateRuntime,
    });
    const { server, handlers } = makeServerStub();
    registerRetrievalTools(server as never, parts);
    const result = await handlers.get('berry_context')!({
      task: 'q', project_name: 'project:memberry', entity_scope: ['memberry'],
    }) as { content: Array<{ type: string; text: string }> };
    expect(candidateRuntime.execute).toHaveBeenCalledTimes(1);
    expect(result.content[0]!.text).toBe('# md');
  });
});
