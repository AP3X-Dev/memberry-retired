import { types as nodeUtilTypes } from 'node:util';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  CAPABILITY_RUNTIME_MAX_CONFIG_BYTES_V1,
  CAPABILITY_RUNTIME_MAX_POLICIES_V1,
  CAPABILITY_TOOL_NAMES_V1,
  CapabilityRuntimeConfigError,
  assertCapabilityToolMatrixV1,
  capabilityRequestForToolV1,
  installCapabilityRuntimeInterposerV1,
  parseCapabilityRuntimeConfigV1,
  parseCapabilityRuntimeConfigValueV1,
  validateCapabilityRuntimeIdentityV1,
} from '../capability-runtime.js';

const identity = { tenantId: 'acme', actorId: 'alice' } as const;

function policy(
  grants: Array<Record<string, unknown>> = [],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    contractId: 'memberry.capability-policy',
    contractVersion: '1.0.0',
    actorId: identity.actorId,
    tenantId: identity.tenantId,
    grants,
    ...overrides,
  };
}

function grant(
  toolId: string,
  domainId: string,
  operation: 'read' | 'create' | 'update' | 'delete' | 'admin',
  scope: Record<string, unknown> = { kind: 'tenant' },
): Record<string, unknown> {
  return { scope, domainId, toolId, operation };
}

function parsedPolicy(grants: Array<Record<string, unknown>>, overrides: Record<string, unknown> = {}) {
  return parseCapabilityRuntimeConfigValueV1([policy(grants, overrides)])(
    String(overrides.tenantId ?? identity.tenantId),
    String(overrides.actorId ?? identity.actorId),
  );
}

function registeredHandler(server: McpServer, name: string): (...args: unknown[]) => unknown {
  const registry = (server as unknown as {
    _registeredTools: Record<string, { handler: (...args: unknown[]) => unknown }>;
  })._registeredTools;
  return registry[name]!.handler;
}

describe('SEC-001B capability runtime configuration', () => {
  it('keeps absent and empty configuration off, while [] is enabled deny-all', () => {
    expect(parseCapabilityRuntimeConfigV1(undefined)).toBeUndefined();
    expect(parseCapabilityRuntimeConfigV1('')).toBeUndefined();
    const lookup = parseCapabilityRuntimeConfigV1('[]');
    expect(lookup).toEqual(expect.any(Function));
    expect(lookup?.('acme', 'alice')).toBeUndefined();
  });

  it('accepts one policy, selects exact tenant/actor, and exposes only a frozen lookup closure', () => {
    const lookup = parseCapabilityRuntimeConfigV1(JSON.stringify([policy()]));
    expect(Object.isFrozen(lookup)).toBe(true);
    expect(lookup?.('acme', 'alice')).toEqual(policy());
    expect(lookup?.('other', 'alice')).toBeUndefined();
    expect(lookup?.('acme', 'bob')).toBeUndefined();
    expect(Object.isFrozen(lookup?.('acme', 'alice'))).toBe(true);
    expect(Reflect.ownKeys(lookup!).some((key) => String(key).toLowerCase().includes('map'))).toBe(false);
  });

  it('rejects duplicate identities, malformed JSON, non-arrays, sparse/decorated arrays, and count N+1', () => {
    expect(() => parseCapabilityRuntimeConfigValueV1([policy(), policy()]))
      .toThrow(CapabilityRuntimeConfigError);
    expect(() => parseCapabilityRuntimeConfigV1('{')).toThrow(CapabilityRuntimeConfigError);
    expect(() => parseCapabilityRuntimeConfigV1('{}')).toThrow(CapabilityRuntimeConfigError);

    const sparse = new Array(1);
    expect(() => parseCapabilityRuntimeConfigValueV1(sparse)).toThrow(CapabilityRuntimeConfigError);
    const decorated = [policy()];
    Object.defineProperty(decorated, 'extra', { value: true, enumerable: true });
    expect(() => parseCapabilityRuntimeConfigValueV1(decorated)).toThrow(CapabilityRuntimeConfigError);

    const atLimit = Array.from({ length: CAPABILITY_RUNTIME_MAX_POLICIES_V1 }, (_, index) =>
      policy([], { actorId: `actor${index}` }));
    expect(parseCapabilityRuntimeConfigValueV1(atLimit)('acme', 'actor127')).toBeDefined();
    expect(() => parseCapabilityRuntimeConfigValueV1([...atLimit, policy([], { actorId: 'overflow' })]))
      .toThrow(CapabilityRuntimeConfigError);
  });

  it('enforces the UTF-8 byte cap at N and N+1', () => {
    const exact = `[${' '.repeat(CAPABILITY_RUNTIME_MAX_CONFIG_BYTES_V1 - 2)}]`;
    const over = `[${' '.repeat(CAPABILITY_RUNTIME_MAX_CONFIG_BYTES_V1 - 1)}]`;
    expect(parseCapabilityRuntimeConfigV1(exact)).toEqual(expect.any(Function));
    expect(() => parseCapabilityRuntimeConfigV1(over)).toThrow(CapabilityRuntimeConfigError);
    expect(() => parseCapabilityRuntimeConfigV1(`[é${' '.repeat(CAPABILITY_RUNTIME_MAX_CONFIG_BYTES_V1 - 3)}]`))
      .toThrow(CapabilityRuntimeConfigError);
  });

  it('rejects hostile accessors and proxies without invoking their hooks or leaking values', () => {
    let hooks = 0;
    const accessor = [policy()];
    Object.defineProperty(accessor, '0', {
      enumerable: true,
      configurable: true,
      get() { hooks += 1; return policy(); },
    });
    expect(() => parseCapabilityRuntimeConfigValueV1(accessor)).toThrow('capability_runtime:invalid-config');
    expect(hooks).toBe(0);

    const proxy = new Proxy([policy()], {
      get() { hooks += 1; throw new Error('secret-policy'); },
      ownKeys() { hooks += 1; throw new Error('secret-policy'); },
    });
    expect(nodeUtilTypes.isProxy(proxy)).toBe(true);
    expect(() => parseCapabilityRuntimeConfigValueV1(proxy)).toThrow('capability_runtime:invalid-config');
    expect(hooks).toBe(0);
  });

  it('validates token-derived identities through the Core request parser with generic errors', () => {
    expect(() => validateCapabilityRuntimeIdentityV1('acme', 'alice')).not.toThrow();
    expect(() => validateCapabilityRuntimeIdentityV1('secret tenant!', 'secret actor!'))
      .toThrow('capability_runtime:invalid-identity');
    try {
      validateCapabilityRuntimeIdentityV1('secret tenant!', 'secret actor!');
    } catch (error) {
      expect(String(error)).not.toContain('secret');
    }
  });
});

describe('SEC-001B exhaustive capability request matrix', () => {
  const expected = {
    berry_load: ['memory', 'read'], berry_store: ['memory', 'create'],
    berry_memory_read: ['memory', 'read'], berry_memory_insert: ['memory', 'update'],
    berry_grep: ['memory', 'read'], berry_memory_replace: ['memory', 'update'],
    berry_memory_rewrite: ['memory', 'update'], berry_memory_promote: ['memory', 'update'],
    berry_memory_archive: ['memory', 'delete'], berry_timeline: ['temporal', 'read'],
    berry_fact_diff: ['temporal', 'read'], berry_query: ['admin', 'admin'],
    berry_consolidate: ['admin', 'read'], berry_bootstrap: ['admin', 'create'],
    berry_resolve: ['admin', 'read'], berry_ingest_codebase: ['admin', 'create'],
    berry_provenance: ['admin', 'read'], berry_tools: ['tools', 'read'],
    berry_context: ['retrieval', 'read'], berry_ask: ['retrieval', 'read'],
    berry_feedback: ['retrieval', 'update'], berry_research_init: ['research', 'create'],
    berry_research_log: ['research', 'create'], berry_research_context: ['research', 'read'],
    berry_research_tree: ['research', 'read'], berry_research_contradictions: ['research', 'read'],
    berry_research_consolidate: ['research', 'update'], berry_arch_register: ['arch', 'update'],
    berry_arch_relate: ['arch', 'create'], berry_arch_aspect: ['arch', 'read'],
    berry_impact: ['arch', 'read'], berry_arch_drift: ['arch', 'read'],
    berry_arch_context: ['arch', 'read'], berry_code_index: ['code', 'update'],
    berry_code_search: ['code', 'read'], berry_code_ast_grep: ['code', 'read'],
    berry_code_symbols: ['code', 'read'], berry_code_deps: ['code', 'read'],
    berry_code_context: ['code', 'read'], berry_code_watch: ['code', 'read'],
    berry_compile: ['wiki', 'update'], berry_ingest: ['wiki', 'create'],
    berry_lint: ['wiki', 'read'], berry_braindump: ['wiki', 'create'],
    berry_wiki_sync: ['wiki', 'update'], berry_graph_report: ['graph', 'read'],
    berry_graph_export: ['graph', 'read'], berry_pr_impact: ['graph', 'read'],
    berry_pr_conflicts: ['graph', 'read'],
  } as const;

  const defaultArgs: Record<string, Record<string, unknown>> = {
    berry_consolidate: { action: 'status' },
    berry_tools: { action: 'list' },
    berry_arch_aspect: { action: 'list', name: 'security' },
    berry_arch_drift: { action: 'list_stale' },
    berry_code_watch: { action: 'status' },
    berry_graph_export: {},
  };

  it('covers exactly 49 unique names with exact domain/tool/operation requests', () => {
    expect(CAPABILITY_TOOL_NAMES_V1).toHaveLength(49);
    expect(new Set(CAPABILITY_TOOL_NAMES_V1).size).toBe(49);
    expect(Object.keys(expected).sort()).toEqual([...CAPABILITY_TOOL_NAMES_V1].sort());
    assertCapabilityToolMatrixV1(CAPABILITY_TOOL_NAMES_V1);
    expect(() => assertCapabilityToolMatrixV1([...CAPABILITY_TOOL_NAMES_V1, 'berry_unknown']))
      .toThrow(CapabilityRuntimeConfigError);

    for (const toolId of CAPABILITY_TOOL_NAMES_V1) {
      const request = capabilityRequestForToolV1(identity, toolId, defaultArgs[toolId] ?? {});
      expect(request, toolId).toMatchObject({
        tenantId: 'acme', actorId: 'alice', domainId: expected[toolId][0], toolId,
        operation: expected[toolId][1], scope: { kind: 'tenant' },
      });
    }
    expect(capabilityRequestForToolV1(identity, 'berry_unknown', {})).toBeUndefined();
  });

  it.each([
    ['berry_consolidate', { action: 'run' }, 'admin'],
    ['berry_consolidate', { action: 'dream' }, 'admin'],
    ['berry_consolidate', { action: 'review', proposal_id: 'p1' }, 'read'],
    ['berry_consolidate', { action: 'review', proposal_id: 'p1', decision: 'approve' }, 'admin'],
    ['berry_consolidate', { action: 'review', proposal_id: 'p1', decision: 'reject' }, 'admin'],
    ['berry_tools', { action: 'enable', domain: 'memory' }, 'update'],
    ['berry_tools', { action: 'disable', domain: 'memory' }, 'update'],
    ['berry_arch_aspect', { action: 'create', name: 'security' }, 'create'],
    ['berry_arch_aspect', { action: 'apply', name: 'security', entity_name: 'mcp' }, 'update'],
    ['berry_arch_aspect', { action: 'remove', name: 'security', entity_name: 'mcp' }, 'delete'],
    ['berry_arch_aspect', { action: 'get', name: 'security' }, 'read'],
    ['berry_arch_drift', { action: 'mark_fresh', entity_name: 'mcp' }, 'update'],
    ['berry_arch_drift', { action: 'check', entity_name: 'mcp' }, 'read'],
    ['berry_arch_drift', { action: 'check_all', project_name: 'memberry' }, 'read'],
    ['berry_code_watch', { action: 'start', path: 'packages/mcp' }, 'create'],
    ['berry_code_watch', { action: 'stop' }, 'delete'],
    ['berry_graph_export', { output_path: 'graph.json' }, 'create'],
  ])('resolves %s %# to %s', (toolId, args, operation) => {
    expect(capabilityRequestForToolV1(identity, toolId, args)?.operation).toBe(operation);
  });

  it('denies unknown and incomplete dynamic combinations before evaluation', () => {
    expect(capabilityRequestForToolV1(identity, 'berry_tools', { action: 'enable' })).toBeUndefined();
    expect(capabilityRequestForToolV1(identity, 'berry_consolidate', { action: 'review' })).toBeUndefined();
    expect(capabilityRequestForToolV1(identity, 'berry_consolidate', {
      action: 'review', proposal_id: 'p1', decision: 'maybe',
    })).toBeUndefined();
    expect(capabilityRequestForToolV1(identity, 'berry_arch_aspect', { action: 'unknown' })).toBeUndefined();
    expect(capabilityRequestForToolV1(identity, 'berry_arch_aspect', {
      action: 'apply', name: 'security',
    })).toBeUndefined();
    expect(capabilityRequestForToolV1(identity, 'berry_arch_drift', { action: 'check_all' })).toBeUndefined();
    expect(capabilityRequestForToolV1(identity, 'berry_code_watch', { action: 'start' })).toBeUndefined();
    expect(capabilityRequestForToolV1(identity, 'berry_graph_export', { output_path: 1 })).toBeUndefined();
  });

  it('derives project scope for berry_store and the six exact-scope memory block tools', () => {
    const exact = [
      'berry_store',
      'berry_memory_read', 'berry_memory_insert', 'berry_memory_replace',
      'berry_memory_rewrite', 'berry_memory_promote', 'berry_memory_archive',
    ];
    for (const toolId of CAPABILITY_TOOL_NAMES_V1) {
      const request = capabilityRequestForToolV1(identity, toolId, {
        ...defaultArgs[toolId], scope: 'project:memberry', project_tag: 'project:memberry',
      });
      expect(request?.scope.kind, toolId).toBe(exact.includes(toolId) ? 'project' : 'tenant');
    }
    expect(capabilityRequestForToolV1(identity, 'berry_memory_read', { scope: 'PROJECT:memberry' })?.scope)
      .toEqual({ kind: 'tenant' });
    expect(capabilityRequestForToolV1(identity, 'berry_memory_read', { scope: 'project:bad value' })?.scope)
      .toEqual({ kind: 'tenant' });
    expect(capabilityRequestForToolV1(identity, 'berry_memory_insert', { scope: 'project:memberry' })?.operation)
      .toBe('update');
    expect(capabilityRequestForToolV1(identity, 'berry_memory_rewrite', { scope: 'project:memberry' })?.operation)
      .toBe('update');
  });
});

describe('SEC-001B real McpServer interposition', () => {
  it('supports all six SDK overload shapes and preserves real handles and notifications', () => {
    const cases: Array<[string, unknown[]]> = [
      ['berry_load', []],
      ['berry_store', ['description']],
      ['berry_memory_read', [{ scope: z.string().optional() }]],
      ['berry_memory_insert', ['description', { readOnlyHint: false }]],
      ['berry_grep', [{ pattern: z.string() }, { readOnlyHint: true }]],
      ['berry_memory_replace', ['description', { scope: z.string().optional() }, { readOnlyHint: false }]],
    ];
    const grants = [
      grant('berry_load', 'memory', 'read'), grant('berry_store', 'memory', 'create'),
      grant('berry_memory_read', 'memory', 'read'), grant('berry_memory_insert', 'memory', 'update'),
      grant('berry_grep', 'memory', 'read'), grant('berry_memory_replace', 'memory', 'update'),
    ];

    for (const [toolId, prefix] of cases) {
      const server = new McpServer({ name: 'interposer-test', version: '0.0.0' });
      const changed = vi.spyOn(server, 'sendToolListChanged');
      installCapabilityRuntimeInterposerV1(server, identity, parsedPolicy(grants));
      const callback = vi.fn(() => ({ content: [{ type: 'text', text: 'ok' }] }));
      const handle = Reflect.apply(server.tool as (...args: unknown[]) => unknown, server, [
        toolId, ...prefix, callback,
      ]) as {
        description?: string;
        enabled: boolean;
        disable(): void;
        enable(): void;
        update(value: { description?: string }): void;
        remove(): void;
      };
      expect(handle).toBeDefined();
      expect(typeof handle.disable).toBe('function');
      changed.mockClear();
      handle.disable();
      handle.enable();
      handle.update({ description: 'updated without replacing the callback' });
      expect(handle.description).toBe('updated without replacing the callback');
      const registry = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
      expect(registry[toolId]).toBe(handle);
      handle.remove();
      expect(registry[toolId]).toBeUndefined();
      expect(changed).toHaveBeenCalledTimes(4);
    }
  });

  it('allows exactly once and preserves callback receiver, arguments, and result', async () => {
    const server = new McpServer({ name: 'interposer-test', version: '0.0.0' });
    installCapabilityRuntimeInterposerV1(
      server,
      identity,
      parsedPolicy([grant('berry_load', 'memory', 'read')]),
    );
    const receiver = { marker: true };
    const result = { content: [{ type: 'text' as const, text: 'allowed' }] };
    const callback = vi.fn(function callback(this: unknown, ...args: unknown[]) {
      expect(this).toBe(receiver);
      expect(args).toEqual([{ task: 't' }, { requestId: 'r' }]);
      return result;
    });
    server.tool('berry_load', 'description', { task: z.string() }, { readOnlyHint: true }, callback as never);
    const observed = await Reflect.apply(registeredHandler(server, 'berry_load'), receiver, [
      { task: 't' }, { requestId: 'r' },
    ]);
    expect(observed).toBe(result);
    expect(callback).toHaveBeenCalledOnce();
  });

  it.each([
    ['missing policy', undefined],
    ['actor mismatch', parsedPolicy([grant('berry_load', 'memory', 'read')], { actorId: 'bob' })],
    ['tenant mismatch', parsedPolicy([grant('berry_load', 'memory', 'read')], { tenantId: 'other' })],
    ['tool mismatch', parsedPolicy([grant('berry_store', 'memory', 'create')])],
    ['operation mismatch', parsedPolicy([grant('berry_load', 'memory', 'update')])],
  ])('returns the exact denial and invokes zero callbacks for %s', async (_label, selectedPolicy) => {
    const server = new McpServer({ name: 'interposer-test', version: '0.0.0' });
    installCapabilityRuntimeInterposerV1(server, identity, selectedPolicy);
    const callback = vi.fn(() => ({ content: [{ type: 'text', text: 'effect' }] }));
    server.tool('berry_load', 'description', { task: z.string() }, { readOnlyHint: true }, callback as never);
    const observed = await registeredHandler(server, 'berry_load')({ task: 't' }, {});
    expect(observed).toEqual({
      content: [{ type: 'text', text: '**Error:** capability denied' }],
      isError: true,
    });
    expect(callback).not.toHaveBeenCalled();
  });

  it('confines project grants and invokes zero callbacks on mismatch', async () => {
    const server = new McpServer({ name: 'interposer-test', version: '0.0.0' });
    installCapabilityRuntimeInterposerV1(server, identity, parsedPolicy([
      grant('berry_memory_read', 'memory', 'read', { kind: 'project', projectId: 'project:memberry' }),
    ]));
    const callback = vi.fn(() => ({ content: [] }));
    server.tool(
      'berry_memory_read',
      'description',
      { scope: z.string().optional() },
      { readOnlyHint: true },
      callback as never,
    );
    const handler = registeredHandler(server, 'berry_memory_read');
    expect(await handler({ scope: 'project:other' }, {})).toEqual({
      content: [{ type: 'text', text: '**Error:** capability denied' }], isError: true,
    });
    expect(callback).not.toHaveBeenCalled();
    await handler({ scope: 'project:memberry' }, {});
    expect(callback).toHaveBeenCalledOnce();
  });

  it('rejects an unknown 50th tool, unsupported overloads, and a second installation before registration', () => {
    const server = new McpServer({ name: 'interposer-test', version: '0.0.0' });
    installCapabilityRuntimeInterposerV1(server, identity, undefined);
    expect(() => Reflect.apply(server.tool as (...args: unknown[]) => unknown, server, [
      'berry_unknown', () => ({ content: [] }),
    ])).toThrow('capability_runtime:unsupported-binding');
    expect(() => Reflect.apply(server.tool as (...args: unknown[]) => unknown, server, [
      'berry_load', 1, () => ({ content: [] }),
    ])).toThrow('capability_runtime:unsupported-binding');
    expect(() => installCapabilityRuntimeInterposerV1(server, identity, undefined))
      .toThrow('capability_runtime:unsupported-binding');
    const registry = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    expect(Object.keys(registry)).toEqual([]);
  });
});
