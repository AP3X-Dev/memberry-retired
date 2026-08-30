// COD-010b — serve code under the live candidate-channel composition.
//
// RED battery (spec docs/agent-runs/specs/2026-08-25-cod010b-code-service.md §Tests,
// plan docs/agent-runs/plans/2026-08-26-cod010b-implementation.md Task 1). Every pin here
// exercises the SERVED candidate arm (`assembleCandidateExecutionServed`, assembler.ts:495)
// with a fake code layer and a minimal fake candidate execution built the way
// assembler.multihop.test.ts:164-194 builds one.
//
// Until Tasks 2-4 land, the served arm hardcodes `includeCode: false` (assembler.ts:616),
// never calls `this.codeLayer`, and emits no `code_plane`, so these fail on absence.

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { UnifiedAssembler } from '../assembler.js';
import type { CandidateChannelExecutionResultV1 } from '../candidate-channel.js';
import { parseSerializedRerankerProviderRequestV1 } from '../reranker.js';
import { createServedRerankerProviderV1, type ServedRerankerConstructionV1 } from '../served-reranker.js';
import { RETRIEVAL_TRACE_CHANNEL_ORDER } from '../trace.js';
import type { RetrievalTraceV1 } from '../trace.js';
import type { UnifiedContext } from '../types.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const TASK = 'where is the served candidate composition assembled';

/** The `{ includeCode?: boolean }` options arg lands at position 8, AFTER `multihopProbe`
 *  (plan re-grounding note 1). The current signature stops at 7, so this shim is how the
 *  pins call the not-yet-existing parameter without a compile error in the test file. */
type ServedCall = (
  task: string,
  execution: CandidateChannelExecutionResultV1,
  maxTokens: number,
  includeArchitecture: boolean,
  includeMemory: boolean,
  traced?: boolean,
  multihopProbe?: undefined,
  options?: { includeCode?: boolean },
) => Promise<{ context: UnifiedContext; trace?: RetrievalTraceV1 }>;

function servedCall(assembler: UnifiedAssembler): ServedCall {
  return assembler.assembleCandidateExecutionServed.bind(assembler) as unknown as ServedCall;
}

/** Canonically-rounded score (RETRIEVAL_TRACE_NUMBER_DECIMALS = 6, trace.ts:790). */
function traceScore(value: number): number {
  return Number(value.toFixed(6));
}

type CodeRow = {
  id: string; source_type: string; name: string; kind: string; file_path: string;
  start_line: number; signature: string; doc_comment: string; score: number;
};

function codeRows(count: number): CodeRow[] {
  return Array.from({ length: count }, (_, index): CodeRow => ({
    id: `sym-${index}`,
    source_type: 'symbol',
    name: `assembleServed${index}`,
    kind: 'function',
    file_path: `packages/retrieval/src/served${index}.ts`,
    start_line: 100 + index,
    signature: `function assembleServed${index}(task: string): Promise<void>`,
    doc_comment: `Served candidate composition helper ${index}.`,
    // Strictly descending, inside (0, 1], and CANONICALLY ROUNDED: the trace validator
    // rejects a score whose float representation is not its own rounded form
    // (trace.ts:787), which silently poisons the whole trace adapter.
    score: traceScore(0.9 - index * 0.002),
  }));
}

/** The `**name** (kind) — \`path:line\`` block the legacy arm builds (assembler.ts:1054). */
function legacyContentBlock(row: CodeRow): string {
  return `**${row.name}** (${row.kind}) — \`${row.file_path}:${row.start_line}\`\n\`${row.signature}\`\n> ${row.doc_comment}`;
}

function makeCodeLayer(rows: CodeRow[] | (() => never)) {
  const search = vi.fn(async () => (typeof rows === 'function' ? rows() : rows));
  return { codeLayer: { search }, search };
}

function makeAssembler(
  codeLayer: { search: ReturnType<typeof vi.fn> } | null,
  reranker: ServedRerankerConstructionV1 = createServedRerankerProviderV1(),
): UnifiedAssembler {
  return new UnifiedAssembler(
    {} as never,
    { zincrby: vi.fn(), zrevrangeWithScores: vi.fn(async () => []), lpush: vi.fn(), ltrim: vi.fn() } as never,
    codeLayer as never,
    null,
    { embed: vi.fn(), embedBatch: vi.fn() } as never,
    null,
    reranker,
  );
}

/** Minimal candidate execution: memory.scope populated, every other planned channel settled
 *  the way the live executor settles it (safe-failure/unavailable, runtime-candidate-channel.ts
 *  :133-134) — INCLUDING `code.fulltext`, which is exactly the observation Task 3 must replace. */
function execution(
  rows: Array<[string, string]>,
  tenantId = 'default',
): CandidateChannelExecutionResultV1 {
  return Object.freeze({
    contractId: 'memberry.candidate-channel' as const,
    contractVersion: '1.0.0' as const,
    request: Object.freeze({
      contractId: 'memberry.candidate-channel' as const,
      contractVersion: '1.0.0' as const,
      tenantId,
      projectScope: 'project:memberry',
      resolvedEntityIds: Object.freeze(['entity-memberry']),
      temporalFrame: Object.freeze({ mode: 'current' as const }),
      plannedChannels: RETRIEVAL_TRACE_CHANNEL_ORDER,
      limits: Object.freeze({ maxCandidatesPerChannel: 64, maxCandidatesAggregate: 128 }),
    }),
    candidates: Object.freeze(rows.map(([evidenceId, content], index) => Object.freeze({
      contractId: 'memberry.candidate-channel' as const,
      contractVersion: '1.0.0' as const,
      channel: 'memory.scope' as const,
      tenantId,
      projectScope: 'project:memberry',
      resolvedEntityId: 'entity-memberry',
      temporalFrame: Object.freeze({ mode: 'current' as const }),
      sourceType: 'semantic' as const,
      evidenceId,
      rank: index + 1,
      score: traceScore(0.9 - index * 0.005),
      title: evidenceId,
      content,
      provenance: Object.freeze({ kind: 'semantic' as const, semanticId: evidenceId }),
    }))),
    settlements: Object.freeze(RETRIEVAL_TRACE_CHANNEL_ORDER.map((channel) => Object.freeze(
      channel === 'memory.scope'
        ? {
          contractId: 'memberry.candidate-channel' as const,
          contractVersion: '1.0.0' as const,
          channel, outcome: 'success' as const,
        }
        : {
          contractId: 'memberry.candidate-channel' as const,
          contractVersion: '1.0.0' as const,
          channel, outcome: 'safe-failure' as const, code: 'unavailable' as const,
        },
    ))),
  }) as unknown as CandidateChannelExecutionResultV1;
}

// Short memory rows: 8 chars -> 2 tokens each, so a tight budget can hold memory while
// evicting every (much longer) symbol item. That asymmetry is what pin 2 measures.
const SHORT_MEMORY: Array<[string, string]> = [
  ['mem-a', 'aaaabbbb'],
  ['mem-b', 'ccccdddd'],
];
function memoryRows(count: number): Array<[string, string]> {
  return Array.from({ length: count }, (_, index): [string, string] =>
    [`mem-${index}`, `memory row ${index} about served candidate composition`]);
}
/** The candidate channel's `maxCandidatesAggregate`. */
const WIDE_MEMORY = memoryRows(128);
// 30 memory + 20 code exercises the complete 50-item served MMR window. Its trace contains
// C(51, 3) = 20,825 pairwise observations, so this is the regression pin for the former 4,096
// collector ceiling that silently erased the reranker stage.
const FULL_MMR_MEMORY = memoryRows(30);

function symbolItems(context: UnifiedContext) {
  return context.sections
    .filter((section) => section.source_type === 'symbol')
    .flatMap((section) => section.items);
}

// ─── Pins ────────────────────────────────────────────────────────────────────

describe('COD-010b served candidate arm serves code', () => {
  it('pin 1: renders served (K of N) with K>0, the ## Code content block, and an agreeing **Sources:** count', async () => {
    const rows = codeRows(3);
    const { codeLayer, search } = makeCodeLayer(rows);
    const assembler = makeAssembler(codeLayer);

    const served = await servedCall(assembler)(
      TASK, execution(SHORT_MEMORY), 8_000, false, true, false, undefined, { includeCode: true },
    );

    expect(search).toHaveBeenCalledTimes(1);
    expect(served.context.code_plane).toEqual({ outcome: 'served', results: expect.any(Number), candidates: 3 });
    const results = (served.context.code_plane as { results: number }).results;
    expect(results).toBeGreaterThan(0);

    const markdown = assembler.renderMarkdown(served.context);
    expect(markdown).toContain(`**Code:** served (${results} of 3)`);
    expect(markdown).toContain('## Code');
    // The delivered symbol items carry the legacy content block verbatim.
    const delivered = symbolItems(served.context);
    expect(delivered).toHaveLength(results);
    for (const item of delivered) {
      const row = rows.find((candidate) => item.content === legacyContentBlock(candidate));
      expect(row, `no legacy content block matched: ${item.content}`).toBeDefined();
    }
    // **Sources:** provenance must agree with the K the **Code:** segment claims.
    expect(markdown).toContain(`symbol:${results}`);
  });

  it('pin 2: renders budget-evicted (0 of N) when no symbol item survives groupAndBudget', async () => {
    const { codeLayer, search } = makeCodeLayer(codeRows(5));
    const assembler = makeAssembler(codeLayer);

    // 6 tokens holds the two 2-token memory rows; every symbol content block is ~30+ tokens.
    const served = await servedCall(assembler)(
      TASK, execution(SHORT_MEMORY), 6, false, true, false, undefined, { includeCode: true },
    );

    expect(search).toHaveBeenCalledTimes(1);
    expect(symbolItems(served.context)).toHaveLength(0);
    expect(served.context.code_plane).toEqual({ outcome: 'no-results', reason: 'budget-evicted', candidates: 5 });
    expect(assembler.renderMarkdown(served.context)).toContain('**Code:** budget-evicted (0 of 5)');
  });

  it("pin 3a(c'): every one of the 20 code rows is present in the fusion input", async () => {
    const { codeLayer } = makeCodeLayer(codeRows(20));
    const assembler = makeAssembler(codeLayer);

    // 30 memory + 20 code fills the served fusion window exactly.
    const served = await servedCall(assembler)(
      TASK, execution(FULL_MMR_MEMORY), 8_000, false, true, true, undefined, { includeCode: true },
    );

    // The trace adapter is CONSTRUCTED with `lists` (assembler.ts:615) and snapshots its
    // candidates from `lists.flat()` (runtime-trace.ts:406), so trace.candidates IS the
    // fusion input. This is also why Task 3 must seed `listsByChannel` before :612, not :630.
    const codeCandidates = served.trace!.candidates.filter((candidate) =>
      candidate.channels.some((channel) => channel.channel === 'code.fulltext'));
    expect(codeCandidates).toHaveLength(20);
    expect(served.trace!.incompleteReasons).toEqual([]);
  }, 15_000);

  it("pin 3b(c'): on a full 128-row memory execution the status is never unavailable and deduped stays <= 50", async () => {
    const { codeLayer } = makeCodeLayer(codeRows(20));
    // The served reranker is handed `deduped` verbatim; capturing its request is the
    // observable for the `rrfFusion(lists, 50, ...)` literal at assembler.ts:630 (NOT the
    // shadow arm's identical literal at :467).
    const real = createServedRerankerProviderV1();
    const rerankerRequests: ReturnType<typeof parseSerializedRerankerProviderRequestV1>[] = [];
    const spy = {
      identity: real.identity,
      run: async (...args: Parameters<typeof real.run>) => {
        rerankerRequests.push(parseSerializedRerankerProviderRequestV1(args[0]));
        return real.run(...args);
      },
    } as ServedRerankerConstructionV1;
    const assembler = makeAssembler(codeLayer, spy);

    const served = await servedCall(assembler)(
      TASK, execution(WIDE_MEMORY), 8_000, false, true, true, undefined, { includeCode: true },
    );
    expect(served.trace!.events).toContainEqual(expect.objectContaining({
      kind: 'reranker-stage', outcome: 'reranked',
    }));

    // (b) the rendered status is derived from the FINAL sections — never `unavailable`.
    const rendered = assembler.renderMarkdown(served.context);
    const segment = rendered.match(/\*\*Code:\*\* (.+)$/m)?.[1];
    expect(segment).toBeDefined();
    expect(segment).not.toContain('unavailable');
    expect(segment).toMatch(/^(served \(\d+ of 20\)|budget-evicted \(0 of 20\))$/);
    expect(segment).toBe(symbolItems(served.context).length === 0
      ? 'budget-evicted (0 of 20)'
      : `served (${symbolItems(served.context).length} of 20)`);

    // (c) deduped.length <= 50 — a change to the served `50` literal breaks this pin
    // instead of silently disabling the reranker via the 128-candidate cliff.
    expect(rerankerRequests).toHaveLength(1);
    expect(rerankerRequests[0]!.candidates.length).toBeLessThanOrEqual(50);
  }, 30_000);

  it('pin 4: the trace declares sources.code, carries the code candidates, and reports NO incomplete reasons', async () => {
    const { codeLayer } = makeCodeLayer(codeRows(3));
    const assembler = makeAssembler(codeLayer);

    const served = await servedCall(assembler)(
      TASK, execution(SHORT_MEMORY), 8_000, false, true, true, undefined, { includeCode: true },
    );

    expect(served.trace!.requestShape.sources.code).toBe(true);
    expect(served.trace!.candidates.filter((candidate) =>
      candidate.channels.some((channel) => channel.channel === 'code.fulltext'))).toHaveLength(3);
    // Empty catches BOTH `candidate-output-gap` (unregistered evidenceByPrivateId) and
    // `channel-accounting-conflict` (a second code.fulltext observation).
    expect(served.trace!.incompleteReasons).toEqual([]);
    expect(served.trace!.complete).toBe(true);
  });

  it('pin 5: a named tenant renders unsupported (tenant-scope) and never calls the code layer', async () => {
    const { codeLayer, search } = makeCodeLayer(codeRows(3));
    const assembler = makeAssembler(codeLayer);

    const served = await servedCall(assembler)(
      TASK, execution(SHORT_MEMORY, 'tenant-a'), 8_000, false, true, false, undefined, { includeCode: true },
    );

    expect(search).not.toHaveBeenCalled();
    expect(served.context.code_plane).toEqual({ outcome: 'unsupported', reason: 'tenant-scope' });
    expect(assembler.renderMarkdown(served.context)).toContain('**Code:** unavailable (tenant-scope)');
  });

  it('pin 6: a throwing code layer renders failed (query-failed), still serves memory, and escapes nothing', async () => {
    const { codeLayer, search } = makeCodeLayer(() => { throw new Error('neo4j down'); });
    const assembler = makeAssembler(codeLayer);

    const served = await servedCall(assembler)(
      TASK, execution(SHORT_MEMORY), 8_000, false, true, false, undefined, { includeCode: true },
    );

    expect(search).toHaveBeenCalledTimes(1);
    expect(served.context.code_plane).toEqual({ outcome: 'failed', reason: 'query-failed' });
    expect(assembler.renderMarkdown(served.context)).toContain('**Code:** failed (query-failed)');
    // Memory is unaffected by the code-plane failure.
    expect(served.context.sections.flatMap((section) => section.items.map((item) => item.id)))
      .toEqual(expect.arrayContaining(['mem-a', 'mem-b']));
  });

  it('pin 7: every live-conformance request literal keeps include_code:false and the end-anchored summary regex carries its pointer comment', () => {
    const liveConformance = readFileSync(
      new URL('../../../../bench/lab/retrieval-trace/live-conformance.ts', import.meta.url), 'utf8');
    const literals = liveConformance.match(/include_code:\s*(true|false)/g) ?? [];
    expect(literals.length).toBeGreaterThan(0);
    expect([...new Set(literals.map((literal) => literal.replace(/\s+/g, ' ')))])
      .toEqual(['include_code: false']);

    // bench/lab/retrieval-trace/contract.ts:139 end-anchors the **Sources:**/**IDs:** summary
    // with `$`, so a trailing ` | **Code:** ...` segment would fail the match. The instrument
    // is NOT changed; it must carry a pointer comment stating that assumption.
    const contract = readFileSync(
      new URL('../../../../bench/lab/retrieval-trace/contract.ts', import.meta.url), 'utf8');
    const lines = contract.split('\n');
    const regexLine = lines.findIndex((line) => line.includes('\\*\\*IDs:\\*\\* (\\d+)$/'));
    expect(regexLine).toBeGreaterThan(0);
    const preceding = lines.slice(Math.max(0, regexLine - 3), regexLine).join('\n');
    expect(preceding).toMatch(/\*\*Code:\*\*/);
  });
});
