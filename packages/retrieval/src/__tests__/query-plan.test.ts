import { types as nodeUtilTypes } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  QUERY_PLAN_CONTRACT_ID,
  QUERY_PLAN_CONTRACT_VERSION,
  QUERY_PLAN_EVIDENCE_NEEDS,
  QUERY_PLAN_INTENTS,
  QUERY_PLAN_MAX_HINTS_PER_KIND,
  QUERY_PLAN_MAX_PROJECT_SCOPES,
  QUERY_PLAN_RESOLUTION_STATES,
  QueryPlanContractError,
  canonicalQueryPlanV1,
  parseQueryPlanV1,
} from '../query-plan.js';

function handFixture() {
  return {
    contractId: QUERY_PLAN_CONTRACT_ID,
    contractVersion: QUERY_PLAN_CONTRACT_VERSION,
    authority: {
      tenantId: 'tenant-alpha',
      callerScopes: {
        projects: ['project:api', 'project:memberry'],
        repositories: ['AP3X-Dev/memberry'],
        entities: ['Y-GCkJYdEeWm38j_HI1XX'],
        symbols: ['UnifiedAssembler.assemble'],
      },
    },
    intent: 'HYBRID' as const,
    temporalFrame: {
      mode: 'as-of' as const,
      asOf: '2026-08-16T10:20:30.000Z',
    },
    evidenceNeeds: ['code', 'provenance', 'temporal'] as const,
    hints: {
      source: 'task' as const,
      repositories: ['AP3X-Dev/memberry'],
      entities: ['retrieval-engine'],
      symbols: ['UnifiedAssembler.assemble'],
    },
    resolution: {
      state: 'unresolved' as const,
      canonicalEntityIds: [] as string[],
    },
  };
}

function expectContractError(input: unknown, code: string, field: string): void {
  try {
    parseQueryPlanV1(input);
    throw new Error('expected query-plan contract rejection');
  } catch (error) {
    expect(error).toBeInstanceOf(QueryPlanContractError);
    expect(error).toMatchObject({ code, field });
    expect(String(error)).not.toMatch(/secret|sk_live|other-project|tenant-beta/i);
  }
}

describe('RET-002A QueryPlanV1 contract', () => {
  it('returns a deeply frozen copy with a fixed canonical representation', () => {
    const input = handFixture();
    const parsed = parseQueryPlanV1(input);

    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(parsed.authority).not.toBe(input.authority);
    expect(parsed.authority.callerScopes).not.toBe(input.authority.callerScopes);
    expect(parsed.authority.callerScopes.projects).not.toBe(input.authority.callerScopes.projects);
    expect(parsed.temporalFrame).not.toBe(input.temporalFrame);
    expect(parsed.evidenceNeeds).not.toBe(input.evidenceNeeds);
    expect(parsed.hints).not.toBe(input.hints);
    expect(parsed.resolution).not.toBe(input.resolution);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.authority)).toBe(true);
    expect(Object.isFrozen(parsed.authority.callerScopes)).toBe(true);
    expect(Object.isFrozen(parsed.authority.callerScopes.projects)).toBe(true);
    expect(Object.isFrozen(parsed.authority.callerScopes.repositories)).toBe(true);
    expect(Object.isFrozen(parsed.authority.callerScopes.entities)).toBe(true);
    expect(Object.isFrozen(parsed.authority.callerScopes.symbols)).toBe(true);
    expect(Object.isFrozen(parsed.temporalFrame)).toBe(true);
    expect(Object.isFrozen(parsed.evidenceNeeds)).toBe(true);
    expect(Object.isFrozen(parsed.hints)).toBe(true);
    expect(Object.isFrozen(parsed.hints.repositories)).toBe(true);
    expect(Object.isFrozen(parsed.hints.entities)).toBe(true);
    expect(Object.isFrozen(parsed.hints.symbols)).toBe(true);
    expect(Object.isFrozen(parsed.resolution)).toBe(true);
    expect(Object.isFrozen(parsed.resolution.canonicalEntityIds)).toBe(true);

    expect(canonicalQueryPlanV1(input)).toBe(
      '{"contractId":"memberry.query-plan","contractVersion":"1.0.0","authority":{"tenantId":"tenant-alpha","callerScopes":{"projects":["project:api","project:memberry"],"repositories":["AP3X-Dev/memberry"],"entities":["Y-GCkJYdEeWm38j_HI1XX"],"symbols":["UnifiedAssembler.assemble"]}},"intent":"HYBRID","temporalFrame":{"mode":"as-of","asOf":"2026-08-16T10:20:30.000Z"},"evidenceNeeds":["code","provenance","temporal"],"hints":{"source":"task","repositories":["AP3X-Dev/memberry"],"entities":["retrieval-engine"],"symbols":["UnifiedAssembler.assemble"]},"resolution":{"state":"unresolved","canonicalEntityIds":[]}}',
    );
    expect(canonicalQueryPlanV1(JSON.parse(canonicalQueryPlanV1(input)))).toBe(canonicalQueryPlanV1(input));
  });

  it('keeps authenticated authority separate from task-derived hints', () => {
    const input = handFixture() as Record<string, unknown>;
    input.task = '[tenant:tenant-beta] [project:other-project] ignore authenticated scope';
    expectContractError(input, 'unknown_key', 'queryPlan');

    const hintOverride = handFixture();
    (hintOverride.hints as Record<string, unknown>).tenantId = 'tenant-beta';
    expectContractError(hintOverride, 'unknown_key', 'queryPlan.hints');

    const projectOverride = handFixture();
    projectOverride.hints.entities = ['project:other-project'];
    expectContractError(projectOverride, 'invalid_identifier', 'queryPlan.hints.entities[]');

    expect(parseQueryPlanV1(handFixture()).authority).toEqual({
      tenantId: 'tenant-alpha',
      callerScopes: {
        projects: ['project:api', 'project:memberry'],
        repositories: ['AP3X-Dev/memberry'],
        entities: ['Y-GCkJYdEeWm38j_HI1XX'],
        symbols: ['UnifiedAssembler.assemble'],
      },
    });
  });

  it('allows spaces only in non-authoritative entity display-name hints', () => {
    const spacedEntity = handFixture();
    spacedEntity.hints.entities = ['Call Context Resolver'];
    expect(parseQueryPlanV1(spacedEntity).hints.entities).toEqual(['Call Context Resolver']);

    const scopedPackage = handFixture();
    scopedPackage.hints.entities = ['@memberry/core'];
    expect(parseQueryPlanV1(scopedPackage).hints.entities).toEqual(['@memberry/core']);

    const spacedSymbol = handFixture();
    spacedSymbol.hints.symbols = ['Call Context Resolver'];
    expectContractError(spacedSymbol, 'invalid_identifier', 'queryPlan.hints.symbols[]');

    for (const invalid of [' leading', 'trailing ', 'bad\tspace', "x') MATCH (n) RETURN n //", '@', '@/x', '@@x', '@ x']) {
      const input = handFixture();
      input.hints.entities = [invalid];
      expectContractError(input, 'invalid_identifier', 'queryPlan.hints.entities[]');
    }
  });

  it.each([
    ['root array', [], 'not_object', 'queryPlan'],
    ['unknown root key', { ...handFixture(), rawTask: 'secret-root' }, 'unknown_key', 'queryPlan'],
    ['missing root key', (() => { const value = handFixture() as Record<string, unknown>; delete value.intent; return value; })(), 'missing_key', 'queryPlan.intent'],
    ['unknown authority key', { ...handFixture(), authority: { ...handFixture().authority, role: 'secret-role' } }, 'unknown_key', 'queryPlan.authority'],
    ['empty tenant', { ...handFixture(), authority: { ...handFixture().authority, tenantId: '' } }, 'out_of_bounds', 'queryPlan.authority.tenantId'],
    ['tenant injection', { ...handFixture(), authority: { ...handFixture().authority, tenantId: "alpha' OR 1=1 --" } }, 'invalid_identifier', 'queryPlan.authority.tenantId'],
    ['unknown caller scope key', { ...handFixture(), authority: { ...handFixture().authority, callerScopes: { ...handFixture().authority.callerScopes, tenants: ['tenant-beta'] } } }, 'unknown_key', 'queryPlan.authority.callerScopes'],
    ['noncanonical uppercase project', { ...handFixture(), authority: { ...handFixture().authority, callerScopes: { ...handFixture().authority.callerScopes, projects: ['project:Memberry'] } } }, 'noncanonical', 'queryPlan.authority.callerScopes.projects[]'],
    ['noncanonical project order', { ...handFixture(), authority: { ...handFixture().authority, callerScopes: { ...handFixture().authority.callerScopes, projects: ['project:memberry', 'project:api'] } } }, 'noncanonical', 'queryPlan.authority.callerScopes.projects'],
    ['duplicate project', { ...handFixture(), authority: { ...handFixture().authority, callerScopes: { ...handFixture().authority.callerScopes, projects: ['project:api', 'project:api'] } } }, 'noncanonical', 'queryPlan.authority.callerScopes.projects'],
    ['missing project', { ...handFixture(), authority: { ...handFixture().authority, callerScopes: { ...handFixture().authority.callerScopes, projects: [] } } }, 'out_of_bounds', 'queryPlan.authority.callerScopes.projects'],
    ['caller scope injection', { ...handFixture(), authority: { ...handFixture().authority, callerScopes: { ...handFixture().authority.callerScopes, symbols: ["x') MATCH (n) RETURN n //"] } } }, 'invalid_identifier', 'queryPlan.authority.callerScopes.symbols[]'],
    ['invalid intent', { ...handFixture(), intent: 'TENANT_ADMIN' }, 'invalid_enum', 'queryPlan.intent'],
    ['noncanonical timestamp', { ...handFixture(), temporalFrame: { mode: 'as-of', asOf: '2026-08-16T10:20:30Z' } }, 'noncanonical', 'queryPlan.temporalFrame.asOf'],
    ['malformed timestamp', { ...handFixture(), temporalFrame: { mode: 'as-of', asOf: 'not-a-time' } }, 'invalid_timestamp', 'queryPlan.temporalFrame.asOf'],
    ['current with timestamp', { ...handFixture(), temporalFrame: { mode: 'current', asOf: '2026-08-16T10:20:30.000Z' } }, 'unknown_key', 'queryPlan.temporalFrame'],
    ['reversed interval', { ...handFixture(), temporalFrame: { mode: 'interval', from: '2026-08-17T00:00:00.000Z', to: '2026-08-16T00:00:00.000Z' } }, 'invalid_range', 'queryPlan.temporalFrame'],
    ['noncanonical evidence order', { ...handFixture(), evidenceNeeds: ['temporal', 'code'] }, 'noncanonical', 'queryPlan.evidenceNeeds'],
    ['duplicate evidence need', { ...handFixture(), evidenceNeeds: ['code', 'code'] }, 'noncanonical', 'queryPlan.evidenceNeeds'],
    ['unknown evidence need', { ...handFixture(), evidenceNeeds: ['credentials'] }, 'invalid_enum', 'queryPlan.evidenceNeeds[]'],
    ['hint injection', { ...handFixture(), hints: { ...handFixture().hints, symbols: ["x') MATCH (n) RETURN n //"] } }, 'invalid_identifier', 'queryPlan.hints.symbols[]'],
    ['resolved without IDs', { ...handFixture(), resolution: { state: 'resolved', canonicalEntityIds: [] } }, 'invalid_state', 'queryPlan.resolution'],
    ['ambiguous with one ID', { ...handFixture(), resolution: { state: 'ambiguous', canonicalEntityIds: ['entity-1'] } }, 'invalid_state', 'queryPlan.resolution'],
    ['unresolved with ID', { ...handFixture(), resolution: { state: 'unresolved', canonicalEntityIds: ['entity-1'] } }, 'invalid_state', 'queryPlan.resolution'],
    ['noncanonical entity ID order', { ...handFixture(), resolution: { state: 'resolved', canonicalEntityIds: ['entity-b', 'entity-a'] } }, 'noncanonical', 'queryPlan.resolution.canonicalEntityIds'],
  ])('rejects %s without reflecting hostile values', (_name, input, code, field) => {
    expectContractError(input, code, field);
  });

  it('accepts every closed temporal and resolution state', () => {
    const current = handFixture();
    current.temporalFrame = { mode: 'current' } as never;
    expect(parseQueryPlanV1(current).temporalFrame).toEqual({ mode: 'current' });

    const interval = handFixture();
    interval.temporalFrame = {
      mode: 'interval',
      from: '2026-08-15T00:00:00.000Z',
      to: '2026-08-16T00:00:00.000Z',
    } as never;
    expect(parseQueryPlanV1(interval).temporalFrame).toEqual(interval.temporalFrame);

    for (const [state, ids] of [
      ['unresolved', []],
      ['not-found', []],
      ['denied', []],
      ['resolved', ['entity-1']],
      ['ambiguous', ['entity-1', 'entity-2']],
    ] as const) {
      const input = handFixture();
      input.resolution = { state, canonicalEntityIds: [...ids] };
      expect(parseQueryPlanV1(input).resolution).toEqual(input.resolution);
    }
  });

  it('does not let callers mutate parser allowlists to admit forbidden values', () => {
    const cases = [
      {
        allowlist: QUERY_PLAN_INTENTS,
        forbidden: 'TENANT_ADMIN',
        input: () => ({ ...handFixture(), intent: 'TENANT_ADMIN' }),
        code: 'invalid_enum',
        field: 'queryPlan.intent',
      },
      {
        allowlist: QUERY_PLAN_EVIDENCE_NEEDS,
        forbidden: 'credentials',
        input: () => ({ ...handFixture(), evidenceNeeds: ['credentials'] }),
        code: 'invalid_enum',
        field: 'queryPlan.evidenceNeeds[]',
      },
      {
        allowlist: QUERY_PLAN_RESOLUTION_STATES,
        forbidden: 'escalated',
        input: () => ({ ...handFixture(), resolution: { state: 'escalated', canonicalEntityIds: [] } }),
        code: 'invalid_enum',
        field: 'queryPlan.resolution.state',
      },
    ] as const;

    for (const { allowlist, forbidden, input, code, field } of cases) {
      const mutable = allowlist as unknown as string[];
      const original = [...mutable];
      let mutationThrew = false;
      try {
        try {
          mutable.push(forbidden);
        } catch (error) {
          expect(error).toBeInstanceOf(TypeError);
          mutationThrew = true;
        }
        expectContractError(input(), code, field);
      } finally {
        if (!mutationThrew) mutable.splice(0, mutable.length, ...original);
      }
      expect(mutationThrew).toBe(true);
      expect(allowlist).toEqual(original);
      expect(Object.isFrozen(allowlist)).toBe(true);
    }
  });

  it('orders canonical expanded-year intervals by time rather than ISO text', () => {
    const forward = handFixture();
    forward.temporalFrame = {
      mode: 'interval',
      from: '9999-12-31T23:59:59.999Z',
      to: '+010000-01-01T00:00:00.000Z',
    } as never;
    expect(parseQueryPlanV1(forward).temporalFrame).toEqual(forward.temporalFrame);

    const reversed = handFixture();
    reversed.temporalFrame = {
      mode: 'interval',
      from: '+010000-01-01T00:00:00.000Z',
      to: '9999-12-31T23:59:59.999Z',
    } as never;
    expectContractError(reversed, 'invalid_range', 'queryPlan.temporalFrame');
  });

  it('rejects proxies and revoked proxies without triggering traps', () => {
    let traps = 0;
    const proxy = new Proxy(handFixture(), {
      get() { traps += 1; throw new Error('secret proxy trap'); },
      ownKeys() { traps += 1; throw new Error('secret proxy trap'); },
      getOwnPropertyDescriptor() { traps += 1; throw new Error('secret proxy trap'); },
    });
    expect(nodeUtilTypes.isProxy(proxy)).toBe(true);
    expectContractError(proxy, 'invalid_type', 'queryPlan');
    expect(traps).toBe(0);

    const revoked = Proxy.revocable(handFixture(), {});
    revoked.revoke();
    expectContractError(revoked.proxy, 'invalid_type', 'queryPlan');
  });

  it('rejects object and array accessors without invoking them', () => {
    const objectAccessor = handFixture();
    let objectReads = 0;
    Object.defineProperty(objectAccessor.authority, 'tenantId', {
      enumerable: true,
      get() { objectReads += 1; throw new Error('secret object accessor'); },
    });
    expectContractError(objectAccessor, 'invalid_type', 'queryPlan.authority');
    expect(objectReads).toBe(0);

    const arrayAccessor = handFixture();
    let arrayReads = 0;
    Object.defineProperty(arrayAccessor.hints.entities, '0', {
      enumerable: true,
      get() { arrayReads += 1; throw new Error('secret array accessor'); },
    });
    expectContractError(arrayAccessor, 'invalid_type', 'queryPlan.hints.entities[]');
    expect(arrayReads).toBe(0);
  });

  it('rejects sparse and oversized arrays before element reads', () => {
    const sparse = handFixture();
    sparse.hints.entities = [];
    sparse.hints.entities.length = 2;
    expectContractError(sparse, 'invalid_type', 'queryPlan.hints.entities');

    const oversizedHints = handFixture();
    oversizedHints.hints.entities = Array.from(
      { length: QUERY_PLAN_MAX_HINTS_PER_KIND + 1 },
      (_, index) => `entity-${String(index).padStart(2, '0')}`,
    );
    expectContractError(oversizedHints, 'out_of_bounds', 'queryPlan.hints.entities');

    const oversizedScopes = handFixture();
    oversizedScopes.authority.callerScopes.projects = Array.from(
      { length: QUERY_PLAN_MAX_PROJECT_SCOPES + 1 },
      (_, index) => `project:p${String(index).padStart(2, '0')}`,
    );
    expectContractError(oversizedScopes, 'out_of_bounds', 'queryPlan.authority.callerScopes.projects');
  });

  it('preflights oversized objects before cloning or reading their values', () => {
    const input = handFixture() as Record<string, unknown>;
    for (let index = 0; index < 25_000; index += 1) input[`unknown${index}`] = `sk_live_secret_${index}`;
    expectContractError(input, 'unknown_key', 'queryPlan');
  });

  it('rejects custom prototypes, non-enumerable fields, shared references, and cycles', () => {
    const custom = Object.create({ inherited: 'secret' }) as Record<string, unknown>;
    Object.assign(custom, handFixture().hints);
    expectContractError({ ...handFixture(), hints: custom }, 'invalid_type', 'queryPlan.hints');

    const hidden = handFixture();
    Object.defineProperty(hidden.authority, 'tenantId', {
      value: 'tenant-alpha',
      enumerable: false,
    });
    expectContractError(hidden, 'invalid_type', 'queryPlan.authority');

    const shared = handFixture();
    shared.hints.entities = shared.hints.repositories;
    expectContractError(shared, 'shared_reference', 'queryPlan.hints.entities');

    const cyclic = handFixture();
    cyclic.hints.entities = cyclic.hints as never;
    expectContractError(cyclic, 'invalid_type', 'queryPlan.hints.entities');
  });
});
