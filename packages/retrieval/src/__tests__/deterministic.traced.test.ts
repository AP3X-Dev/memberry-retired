import { describe, expect, it, vi } from 'vitest';
import { Record as Neo4jRecord } from 'neo4j-driver';

import { UnifiedAssembler } from '../assembler.js';
import {
  assertRetrievalTraceConformant,
  assertRetrievalTraceSecretSafe,
  replayRetrievalTrace,
  RetrievalTraceCollector,
  validateRetrievalTrace,
} from '../trace.js';

const PRIVATE_ENTITY_ID = 'entity-sk_live_12345678901234567890';

function record(values: Record<string, unknown>) {
  return new Neo4jRecord(Object.keys(values), Object.values(values));
}

function result(rows: Array<Record<string, unknown>>) {
  return { records: rows.map(record) };
}

function entityResponses() {
  return [
    result([]),
    result([{
      targetName: 'AuthService',
      e: { properties: {
        id: PRIVATE_ENTITY_ID,
        name: 'AuthService',
        category: 'service',
        responsibility: 'Handles authentication',
      } },
    }]),
    result([]),
    result([]),
    result([]),
    result([]),
  ];
}

function makeAssembler(responses: Array<ReturnType<typeof result> | Error> = entityResponses()) {
  let query = 0;
  const calls: Array<[string, Record<string, unknown>]> = [];
  const driver = {
    session: vi.fn(() => ({
      run: vi.fn(async (queryText: string, params: Record<string, unknown> = {}) => {
        calls.push([queryText, params]);
        const response = responses[query++] ?? result([]);
        if (response instanceof Error) throw response;
        return response;
      }),
      close: vi.fn(async () => undefined),
    })),
  };
  const redis = { get: vi.fn(async () => null), set: vi.fn(async () => undefined) };
  const embedding = { available: false, embed: vi.fn(), embedBatch: vi.fn() };
  return { assembler: new UnifiedAssembler(driver as never, redis, null, null, embedding), driver, calls };
}

describe('UnifiedAssembler.assembleTraced deterministic runtime', () => {
  it('preserves ordinary sections and attributes direct entity output to arch.entity', async () => {
    const options = {
      strategy: 'deterministic' as const,
      entity_scope: ['AuthService'],
      max_tokens: 1_000,
    };
    const ordinary = await makeAssembler().assembler.assemble('auth graph', options);
    const traced = await makeAssembler().assembler.assembleTraced('auth graph', options);

    expect(traced.context.sections).toEqual(ordinary.sections);
    expect(traced.trace.algorithmVersion).toBe('deterministic-v2');
    expect(traced.trace.candidates).toEqual([
      expect.objectContaining({
        sourceType: 'arch_entity',
        channels: [expect.objectContaining({ channel: 'arch.entity', rank: 1 })],
      }),
    ]);
    assertRetrievalTraceConformant(traced.trace);
    assertRetrievalTraceSecretSafe(traced.trace);
    expect(JSON.stringify(traced.trace)).not.toContain(PRIVATE_ENTITY_ID);
  });

  it('keeps the no-match sentinel out of a complete content-free trace', async () => {
    const task = 'private-sk_live_12345678901234567890 no entity';
    const traced = await makeAssembler([result([]), result([])]).assembler.assembleTraced(task, {
      strategy: 'deterministic',
    });

    expect(traced.context.sections[0]?.heading).toBe('No matching entities found');
    expect(traced.trace.candidates).toEqual([]);
    expect(traced.trace.resultOrder).toEqual([]);
    expect(JSON.stringify(traced.trace)).not.toContain(task);
    assertRetrievalTraceConformant(traced.trace);
  });

  it('accounts for fulltext discovery failure and deterministic fallback without leaking the error', async () => {
    const canary = 'index-sk_live_12345678901234567890';
    const responses = [
      new Error(canary),
      result([{ name: 'AuthService' }]),
      ...entityResponses(),
    ];
    const traced = await makeAssembler(responses).assembler.assembleTraced('find auth', {
      strategy: 'deterministic',
    });

    expect(traced.trace.events).toContainEqual(expect.objectContaining({
      kind: 'channel-terminal', channel: 'arch.fulltext', outcome: 'safe-failure', code: 'query-failed',
    }));
    expect(traced.context.sections.some((section) => section.heading === 'Target Components')).toBe(true);
    expect(JSON.stringify(traced.trace)).not.toContain(canary);
    assertRetrievalTraceConformant(traced.trace);
  });

  it('assigns contiguous channel-local ranks from final deterministic section order', async () => {
    const responses = entityResponses();
    responses[0] = result([
      { targetName: 'AuthService', name: 'Deep', depth: 4, responsibility: 'deep' },
      { targetName: 'AuthService', name: 'Root', depth: 0, responsibility: 'root' },
    ]);
    const traced = await makeAssembler(responses).assembler.assembleTraced('auth graph', {
      strategy: 'deterministic', entity_scope: ['AuthService'],
    });

    expect(traced.context.sections[0]?.items.map((item) => item.id)).toEqual(['hier-Root', 'hier-Deep']);
    expect(traced.trace.candidates
      .filter((candidate) => candidate.channels[0]?.channel === 'arch.hierarchy')
      .map((candidate) => candidate.channels[0]?.rank)).toEqual([1, 2]);
    expect(replayRetrievalTrace(traced.trace).resultOrder).toEqual(traced.trace.resultOrder);
  });

  it('records oversized source-final candidates as token-budget exclusions', async () => {
    const responses = entityResponses();
    responses[0] = result([
      { targetName: 'AuthService', name: 'Oversized', depth: 0, responsibility: 'x'.repeat(2_000) },
      { targetName: 'AuthService', name: 'Useful', depth: 1, responsibility: 'small' },
    ]);
    const traced = await makeAssembler(responses).assembler.assembleTraced('auth graph', {
      strategy: 'deterministic', entity_scope: ['AuthService'], max_tokens: 100,
    });
    const hierarchy = traced.trace.candidates
      .filter((candidate) => candidate.channels[0]?.channel === 'arch.hierarchy');
    const excludedRef = hierarchy.find((candidate) => candidate.channels[0]?.rank === 1)?.ref;

    expect(traced.context.sections[0]?.items.map((item) => item.id)).toEqual(['hier-Useful']);
    expect(traced.trace.terminalExclusions).toContainEqual(expect.objectContaining({
      ref: excludedRef, outcome: 'excluded', reasons: ['token-budget'],
    }));
    assertRetrievalTraceConformant(traced.trace);
  });

  it('contains a deterministic query failure as secret-safe channel accounting', async () => {
    const canary = 'query-sk_live_12345678901234567890';
    const responses = entityResponses();
    responses[0] = new Error(canary);
    const traced = await makeAssembler(responses).assembler.assembleTraced('auth graph', {
      strategy: 'deterministic', entity_scope: ['AuthService'],
    });

    expect(traced.trace.events).toContainEqual(expect.objectContaining({
      kind: 'channel-terminal', channel: 'arch.hierarchy', outcome: 'safe-failure', code: 'query-failed',
    }));
    expect(traced.context.sections.some((section) => section.heading === 'Target Components')).toBe(true);
    expect(JSON.stringify(traced.trace)).not.toContain(canary);
    assertRetrievalTraceConformant(traced.trace);
  });

  it('keeps surviving dependency context while marking partial channel evidence incomplete', async () => {
    const canary = 'dependent-sk_live_12345678901234567890';
    const responses = entityResponses();
    responses[2] = result([{
      targetName: 'AuthService', name: 'UserStore', relation: 'USES', interface_desc: 'CRUD',
    }]);
    responses[3] = new Error(canary);
    const traced = await makeAssembler(responses).assembler.assembleTraced('auth graph', {
      strategy: 'deterministic', entity_scope: ['AuthService'],
    });

    expect(traced.context.sections.find((section) => section.heading === 'Dependencies & Dependents')
      ?.items.map((item) => item.id)).toEqual(['dep-AuthService-UserStore']);
    expect(traced.trace.complete).toBe(false);
    expect(traced.trace.incompleteReasons).toContain('channel-gap');
    expect(JSON.stringify(traced.trace)).not.toContain(canary);
  });

  it('captures the full bounded deterministic context under the raised trace ceiling', async () => {
    const responses = entityResponses();
    responses[0] = result(Array.from({ length: 140 }, (_, index) => ({
      targetName: 'AuthService', name: `Ancestor${index}`, depth: index, responsibility: 'context',
    })));
    const traced = await makeAssembler(responses).assembler.assembleTraced('auth graph', {
      strategy: 'deterministic', entity_scope: ['AuthService'], max_tokens: 100_000,
    });

    expect(traced.context.sections[0]?.items).toHaveLength(140);
    expect(traced.trace.candidates).toHaveLength(141);
    expect(traced.trace.complete).toBe(true);
    expect(traced.trace.incompleteReasons).not.toContain('limit-overflow');
  });

  it('matches semantic temporal query truth for empty and valid as_of values', async () => {
    for (const [asOf, applied] of [
      ['', false],
      ['2026-08-15T12:00:00.000Z', true],
    ] as const) {
      const { assembler, calls } = makeAssembler();
      const traced = await assembler.assembleTraced('auth graph', {
        strategy: 'deterministic', entity_scope: ['AuthService'], as_of: asOf,
      });
      const semanticCall = calls.find(([queryText]) => queryText.includes('MATCH (s:Semantic)'));

      expect(traced.trace.requestShape.temporalFilterApplied).toBe(applied);
      expect(semanticCall).toBeDefined();
      expect(semanticCall![0].includes('s.created_at <= $asOf')).toBe(applied);
      expect(Object.hasOwn(semanticCall![1], 'asOf')).toBe(applied);
      if (applied) expect(semanticCall![1].asOf).toBe(asOf);
    }
  });

  it('returns a secret-safe bounded incomplete fallback when finalization fails once', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T12:00:00.000Z'));
    const options = { strategy: 'deterministic' as const, entity_scope: ['AuthService'] };
    const ordinary = await makeAssembler().assembler.assemble('auth graph', options);
    const finalize = vi.spyOn(RetrievalTraceCollector.prototype, 'finalize')
      .mockImplementationOnce(() => { throw new Error('finalize-sk_live_12345678901234567890'); });
    try {
      const traced = await makeAssembler().assembler.assembleTraced('auth graph', options);
      expect(traced.context).toEqual(ordinary);
      expect(traced.trace.complete).toBe(false);
      expect(traced.trace.candidates).toEqual([]);
      expect(traced.trace.events).toEqual([]);
      expect(validateRetrievalTrace(traced.trace)).toEqual([]);
      assertRetrievalTraceSecretSafe(traced.trace);
      expect(JSON.stringify(traced.trace)).not.toContain('sk_live');
    } finally {
      finalize.mockRestore();
      vi.useRealTimers();
    }
  });

  it('fails only the trace when its observer rejects a candidate', async () => {
    const ordinary = await makeAssembler().assembler.assemble('auth graph', {
      strategy: 'deterministic', entity_scope: ['AuthService'],
    });
    const addCandidate = vi.spyOn(RetrievalTraceCollector.prototype, 'addCandidate')
      .mockImplementationOnce(() => { throw new Error('trace observer failed'); });
    try {
      const traced = await makeAssembler().assembler.assembleTraced('auth graph', {
        strategy: 'deterministic', entity_scope: ['AuthService'],
      });
      expect(traced.context.sections).toEqual(ordinary.sections);
      expect(traced.trace.complete).toBe(false);
      expect(traced.trace.incompleteReasons.length).toBeGreaterThan(0);
    } finally {
      addCandidate.mockRestore();
    }
  });

  it('does not invoke trace collector methods on the ordinary deterministic path', async () => {
    const attempt = vi.spyOn(RetrievalTraceCollector.prototype, 'attemptChannel');
    try {
      const { assembler, driver } = makeAssembler();
      const context = await assembler.assemble('auth graph', {
        strategy: 'deterministic', entity_scope: ['AuthService'],
      });
      expect(context.sections.some((section) => section.heading === 'Target Components')).toBe(true);
      expect(driver.session).toHaveBeenCalledTimes(6);
      expect(attempt).not.toHaveBeenCalled();
    } finally {
      attempt.mockRestore();
    }
  });
});
