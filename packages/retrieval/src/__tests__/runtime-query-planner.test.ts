import { describe, expect, it, vi } from 'vitest';
import { RuntimeQueryPlannerError,
  buildRuntimeQueryPlanV1,
  buildRuntimeQueryPlannerReceiptV1,
} from '../runtime-query-planner.js';

describe('RET-002C2 authenticated runtime query planner', () => {
  it('keeps only authenticated tenant and canonical project in authority and snapshots sorted hint aliases', () => {
    const input = {
      tenantId: 'tenant-a', projectName: 'project:memberry',
      entityScope: ['Resolver', 'alias', 'Resolver'], asOf: '2026-08-16T12:00:00.000Z',
    };
    const plan = buildRuntimeQueryPlanV1(input);
    input.entityScope[0] = 'mutated';
    expect(plan.authority).toEqual({
      tenantId: 'tenant-a',
      callerScopes: { projects: ['project:memberry'], repositories: [], entities: [], symbols: [] },
    });
    expect(plan.hints).toEqual({ source: 'task', repositories: [], entities: ['Resolver', 'alias'], symbols: [] });
    expect(plan.temporalFrame).toEqual({ mode: 'as-of', asOf: '2026-08-16T12:00:00.000Z' });
    expect(Object.isFrozen(plan.hints.entities)).toBe(true);
  });

  it('creates an independently copied trusted project receipt from the canonical caller snapshot', () => {
    const receipt = buildRuntimeQueryPlannerReceiptV1({
      tenantId: 'tenant-a', projectName: 'project:memberry', entityScope: ['Resolver'],
    });
    expect(receipt.trustedProjectScopes).toEqual(['project:memberry']);
    expect(receipt.trustedProjectScopes).not.toBe(receipt.plan.authority.callerScopes.projects);
    expect(Object.isFrozen(receipt.trustedProjectScopes)).toBe(true);
    expect(Object.isFrozen(receipt)).toBe(true);
  });

  it('accepts ordinary internal spaces in non-authoritative entity display-name hints', () => {
    const plan = buildRuntimeQueryPlanV1({
      tenantId: 'tenant-a', projectName: 'project:memberry',
      entityScope: ['SOP lifecycle', 'Call Context Resolver'],
    });
    expect(plan.hints.entities).toEqual(['Call Context Resolver', 'SOP lifecycle']);
  });

  it('accepts npm-scoped package names as entity hints', () => {
    const plan = buildRuntimeQueryPlanV1({
      tenantId: 'tenant-a', projectName: 'project:memberry', entityScope: ['@memberry/core'],
    });
    expect(plan.hints.entities).toEqual(['@memberry/core']);
  });

  it.each([
    ['', ['entity']], ['memberry', ['entity']], ['project:Memberry', ['entity']],
    ['project:memberry', []], ['project:memberry', Array.from({ length: 17 }, (_, i) => `e${i}`)],
    ['project:memberry', ['tenant:foreign']], ['project:memberry', [' leading']],
    ['project:memberry', ['trailing ']], ['project:memberry', ['bad\tspace']],
    ['project:memberry', ['@']], ['project:memberry', ['@/x']],
    ['project:memberry', ['@@x']], ['project:memberry', ['@ x']],
  ])('rejects invalid project/hint input with one fixed value-free error', (projectName, entityScope) => {
    expect(() => buildRuntimeQueryPlanV1({ tenantId: 'tenant-a', projectName, entityScope }))
      .toThrowError('runtime_query_planner:invalid_request');
  });

  it('rejects proxy, revoked, accessor, sparse, extra, and custom-prototype inputs without invoking hooks', () => {
    const hooks = vi.fn();
    const proxy = new Proxy(['entity'], { get: () => { hooks(); return undefined; } });
    const revoked = Proxy.revocable(['entity'], {}); revoked.revoke();
    const accessor: unknown[] = [];
    Object.defineProperty(accessor, '0', { enumerable: true, get: () => { hooks(); return 'entity'; } });
    Object.defineProperty(accessor, 'length', { value: 1 });
    const sparse = new Array(1);
    const extra = Object.assign(['entity'], { secret: 'blocked' });
    const custom = Object.assign(Object.create(Array.prototype), { 0: 'entity', length: 1 });
    for (const entityScope of [proxy, revoked.proxy, accessor, sparse, extra, custom]) {
      expect(() => buildRuntimeQueryPlanV1({ tenantId: 'tenant-a', projectName: 'project:memberry', entityScope }))
        .toThrowError('runtime_query_planner:invalid_request');
    }
    expect(hooks).not.toHaveBeenCalled();
  });

  it('RuntimeQueryPlannerError carries a reason only for resolution_failed and keeps the code prefix stable', () => {
    const denied = new RuntimeQueryPlannerError('resolution_failed', 'entity_not_found');
    expect(denied.message).toBe('runtime_query_planner:resolution_failed:entity_not_found');
    expect(denied.reason).toBe('entity_not_found');
    const bare = new RuntimeQueryPlannerError('resolution_failed');
    expect(bare.message).toBe('runtime_query_planner:resolution_failed');
    expect(bare.reason).toBeUndefined();
    const invalid = new RuntimeQueryPlannerError('invalid_request', 'entity_not_found');
    expect(invalid.message).toBe('runtime_query_planner:invalid_request');
    expect(invalid.reason).toBeUndefined();
  });

});
