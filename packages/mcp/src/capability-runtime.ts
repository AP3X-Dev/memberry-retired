import { Buffer as NodeBuffer } from 'node:buffer';
import { types as nodeUtilTypes } from 'node:util';

import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CAPABILITY_POLICY_CONTRACT_ID,
  CAPABILITY_POLICY_CONTRACT_VERSION,
  evaluateCapabilityV1,
  parseActorCapabilityPolicyV1,
  parseCapabilityCheckRequestV1,
  type ActorCapabilityPolicyV1,
  type CapabilityCheckRequestV1,
  type CapabilityOperationV1,
  type CapabilityScopeV1,
} from '@memberry/core';

export const CAPABILITY_RUNTIME_MAX_CONFIG_BYTES_V1 = 65_536 as const;
export const CAPABILITY_RUNTIME_MAX_POLICIES_V1 = 128 as const;

const CONFIG_ERROR_MESSAGE = 'capability_runtime:invalid-config';
const IDENTITY_ERROR_MESSAGE = 'capability_runtime:invalid-identity';
const BINDING_ERROR_MESSAGE = 'capability_runtime:unsupported-binding';
const OBJECT_PROTOTYPE = Object.prototype;
const ARRAY_PROTOTYPE = Array.prototype;
const MAP_GET = Function.prototype.call.bind(Map.prototype.get) as <K, V>(
  map: Map<K, V>, key: K,
) => V | undefined;
const MAP_HAS = Function.prototype.call.bind(Map.prototype.has) as <K, V>(
  map: Map<K, V>, key: K,
) => boolean;
const MAP_SET = Function.prototype.call.bind(Map.prototype.set) as <K, V>(
  map: Map<K, V>, key: K, value: V,
) => Map<K, V>;
const STRING_STARTS_WITH = Function.prototype.call.bind(String.prototype.startsWith) as (
  value: string,
  search: string,
) => boolean;
const REAL_MCP_TOOL = McpServer.prototype.tool as RuntimeToolMethod;

export class CapabilityRuntimeConfigError extends Error {
  constructor(message = CONFIG_ERROR_MESSAGE) {
    super(message);
    this.name = 'CapabilityRuntimeConfigError';
  }
}

export type CapabilityPolicyLookupV1 = (
  tenantId: string,
  actorId: string,
) => ActorCapabilityPolicyV1 | undefined;

interface ToolCapabilityMetadataV1 {
  readonly domainId: string;
  readonly toolId: string;
  readonly operation: CapabilityOperationV1 | 'dynamic';
  readonly scopeRule: 'tenant-only' | 'exact-scope';
}

type RuntimeToolHandler = (this: unknown, ...args: unknown[]) => unknown;
type RuntimeToolMethod = (this: McpServer, name: string, ...args: unknown[]) => RegisteredTool;

const TOOL_CAPABILITY_METADATA_V1 = Object.freeze([
  { domainId: 'memory', toolId: 'berry_load', operation: 'read', scopeRule: 'tenant-only' },
  { domainId: 'memory', toolId: 'berry_store', operation: 'create', scopeRule: 'exact-scope' },
  { domainId: 'memory', toolId: 'berry_memory_read', operation: 'read', scopeRule: 'exact-scope' },
  { domainId: 'memory', toolId: 'berry_memory_insert', operation: 'update', scopeRule: 'exact-scope' },
  { domainId: 'memory', toolId: 'berry_grep', operation: 'read', scopeRule: 'tenant-only' },
  { domainId: 'memory', toolId: 'berry_memory_replace', operation: 'update', scopeRule: 'exact-scope' },
  { domainId: 'memory', toolId: 'berry_memory_rewrite', operation: 'update', scopeRule: 'exact-scope' },
  { domainId: 'memory', toolId: 'berry_memory_promote', operation: 'update', scopeRule: 'exact-scope' },
  { domainId: 'memory', toolId: 'berry_memory_archive', operation: 'delete', scopeRule: 'exact-scope' },
  { domainId: 'temporal', toolId: 'berry_timeline', operation: 'read', scopeRule: 'tenant-only' },
  { domainId: 'temporal', toolId: 'berry_fact_diff', operation: 'read', scopeRule: 'tenant-only' },
  { domainId: 'admin', toolId: 'berry_query', operation: 'admin', scopeRule: 'tenant-only' },
  { domainId: 'admin', toolId: 'berry_consolidate', operation: 'dynamic', scopeRule: 'tenant-only' },
  { domainId: 'admin', toolId: 'berry_bootstrap', operation: 'create', scopeRule: 'tenant-only' },
  { domainId: 'admin', toolId: 'berry_resolve', operation: 'read', scopeRule: 'tenant-only' },
  { domainId: 'admin', toolId: 'berry_ingest_codebase', operation: 'create', scopeRule: 'tenant-only' },
  { domainId: 'admin', toolId: 'berry_provenance', operation: 'read', scopeRule: 'tenant-only' },
  { domainId: 'tools', toolId: 'berry_tools', operation: 'dynamic', scopeRule: 'tenant-only' },
  { domainId: 'retrieval', toolId: 'berry_context', operation: 'read', scopeRule: 'tenant-only' },
  { domainId: 'retrieval', toolId: 'berry_ask', operation: 'read', scopeRule: 'tenant-only' },
  { domainId: 'retrieval', toolId: 'berry_feedback', operation: 'update', scopeRule: 'tenant-only' },
  { domainId: 'research', toolId: 'berry_research_init', operation: 'create', scopeRule: 'tenant-only' },
  { domainId: 'research', toolId: 'berry_research_log', operation: 'create', scopeRule: 'tenant-only' },
  { domainId: 'research', toolId: 'berry_research_context', operation: 'read', scopeRule: 'tenant-only' },
  { domainId: 'research', toolId: 'berry_research_tree', operation: 'read', scopeRule: 'tenant-only' },
  { domainId: 'research', toolId: 'berry_research_contradictions', operation: 'read', scopeRule: 'tenant-only' },
  { domainId: 'research', toolId: 'berry_research_consolidate', operation: 'update', scopeRule: 'tenant-only' },
  { domainId: 'arch', toolId: 'berry_arch_register', operation: 'update', scopeRule: 'tenant-only' },
  { domainId: 'arch', toolId: 'berry_arch_relate', operation: 'create', scopeRule: 'tenant-only' },
  { domainId: 'arch', toolId: 'berry_arch_aspect', operation: 'dynamic', scopeRule: 'tenant-only' },
  { domainId: 'arch', toolId: 'berry_impact', operation: 'read', scopeRule: 'tenant-only' },
  { domainId: 'arch', toolId: 'berry_arch_drift', operation: 'dynamic', scopeRule: 'tenant-only' },
  { domainId: 'arch', toolId: 'berry_arch_context', operation: 'read', scopeRule: 'tenant-only' },
  { domainId: 'code', toolId: 'berry_code_index', operation: 'update', scopeRule: 'tenant-only' },
  { domainId: 'code', toolId: 'berry_code_search', operation: 'read', scopeRule: 'tenant-only' },
  { domainId: 'code', toolId: 'berry_code_ast_grep', operation: 'read', scopeRule: 'tenant-only' },
  { domainId: 'code', toolId: 'berry_code_symbols', operation: 'read', scopeRule: 'tenant-only' },
  { domainId: 'code', toolId: 'berry_code_deps', operation: 'read', scopeRule: 'tenant-only' },
  { domainId: 'code', toolId: 'berry_code_context', operation: 'read', scopeRule: 'tenant-only' },
  { domainId: 'code', toolId: 'berry_code_watch', operation: 'dynamic', scopeRule: 'tenant-only' },
  { domainId: 'wiki', toolId: 'berry_compile', operation: 'update', scopeRule: 'tenant-only' },
  { domainId: 'wiki', toolId: 'berry_ingest', operation: 'create', scopeRule: 'tenant-only' },
  { domainId: 'wiki', toolId: 'berry_lint', operation: 'read', scopeRule: 'tenant-only' },
  { domainId: 'wiki', toolId: 'berry_braindump', operation: 'create', scopeRule: 'tenant-only' },
  { domainId: 'wiki', toolId: 'berry_wiki_sync', operation: 'update', scopeRule: 'tenant-only' },
  { domainId: 'graph', toolId: 'berry_graph_report', operation: 'read', scopeRule: 'tenant-only' },
  { domainId: 'graph', toolId: 'berry_graph_export', operation: 'dynamic', scopeRule: 'tenant-only' },
  { domainId: 'graph', toolId: 'berry_pr_impact', operation: 'read', scopeRule: 'tenant-only' },
  { domainId: 'graph', toolId: 'berry_pr_conflicts', operation: 'read', scopeRule: 'tenant-only' },
] as const satisfies readonly ToolCapabilityMetadataV1[]);

const metadataByTool = new Map<string, ToolCapabilityMetadataV1>();
for (const metadata of TOOL_CAPABILITY_METADATA_V1) {
  if (MAP_HAS(metadataByTool, metadata.toolId)) throw new CapabilityRuntimeConfigError();
  MAP_SET(metadataByTool, metadata.toolId, metadata);
}

export const CAPABILITY_TOOL_NAMES_V1 = Object.freeze(
  TOOL_CAPABILITY_METADATA_V1.map((metadata) => metadata.toolId),
);

function genericConfigFailure(): never {
  throw new CapabilityRuntimeConfigError();
}

function readDensePolicyArray(input: unknown): readonly unknown[] {
  if (typeof input !== 'object'
    || input === null
    || nodeUtilTypes.isProxy(input)
    || !Array.isArray(input)
    || Object.getPrototypeOf(input) !== ARRAY_PROTOTYPE) return genericConfigFailure();

  const lengthDescriptor = Object.getOwnPropertyDescriptor(input, 'length');
  if (lengthDescriptor === undefined
    || !Object.hasOwn(lengthDescriptor, 'value')
    || typeof lengthDescriptor.value !== 'number'
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
    || lengthDescriptor.enumerable !== false
    || lengthDescriptor.configurable !== false) return genericConfigFailure();

  const length = lengthDescriptor.value;
  if (length > CAPABILITY_RUNTIME_MAX_POLICIES_V1) return genericConfigFailure();
  if (Reflect.ownKeys(input).length !== length + 1) return genericConfigFailure();

  const values: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (descriptor === undefined
      || !Object.hasOwn(descriptor, 'value')
      || descriptor.enumerable !== true) return genericConfigFailure();
    Object.defineProperty(values, index, {
      value: descriptor.value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return values;
}

export function parseCapabilityRuntimeConfigValueV1(input: unknown): CapabilityPolicyLookupV1 {
  try {
    const values = readDensePolicyArray(input);
    const policiesByTenant = new Map<string, Map<string, ActorCapabilityPolicyV1>>();
    for (let index = 0; index < values.length; index += 1) {
      const policy = parseActorCapabilityPolicyV1(values[index]);
      let policiesByActor = MAP_GET(policiesByTenant, policy.tenantId);
      if (policiesByActor === undefined) {
        policiesByActor = new Map<string, ActorCapabilityPolicyV1>();
        MAP_SET(policiesByTenant, policy.tenantId, policiesByActor);
      }
      if (MAP_HAS(policiesByActor, policy.actorId)) return genericConfigFailure();
      MAP_SET(policiesByActor, policy.actorId, policy);
    }

    const lookup: CapabilityPolicyLookupV1 = (tenantId, actorId) => {
      const policiesByActor = MAP_GET(policiesByTenant, tenantId);
      return policiesByActor === undefined ? undefined : MAP_GET(policiesByActor, actorId);
    };
    return Object.freeze(lookup);
  } catch {
    return genericConfigFailure();
  }
}

export function parseCapabilityRuntimeConfigV1(
  raw: string | undefined,
): CapabilityPolicyLookupV1 | undefined {
  if (raw === undefined || raw === '') return undefined;
  try {
    if (raw.length > CAPABILITY_RUNTIME_MAX_CONFIG_BYTES_V1) return genericConfigFailure();
    if (NodeBuffer.byteLength(raw, 'utf8') > CAPABILITY_RUNTIME_MAX_CONFIG_BYTES_V1) {
      return genericConfigFailure();
    }
    return parseCapabilityRuntimeConfigValueV1(JSON.parse(raw));
  } catch {
    return genericConfigFailure();
  }
}

export function validateCapabilityRuntimeIdentityV1(tenantId: string, actorId: string): void {
  try {
    parseCapabilityCheckRequestV1({
      contractId: CAPABILITY_POLICY_CONTRACT_ID,
      contractVersion: CAPABILITY_POLICY_CONTRACT_VERSION,
      actorId,
      tenantId,
      scope: { kind: 'tenant' },
      domainId: 'memory',
      toolId: 'berry_load',
      operation: 'read',
    });
  } catch {
    throw new CapabilityRuntimeConfigError(IDENTITY_ERROR_MESSAGE);
  }
}

interface OwnArgumentValue {
  readonly valid: boolean;
  readonly present: boolean;
  readonly value?: unknown;
}

function ownArgumentValue(args: unknown, key: string): OwnArgumentValue {
  if (typeof args !== 'object'
    || args === null
    || nodeUtilTypes.isProxy(args)
    || Array.isArray(args)) return { valid: false, present: false };
  const prototype = Object.getPrototypeOf(args);
  if (prototype !== OBJECT_PROTOTYPE && prototype !== null) return { valid: false, present: false };
  const descriptor = Object.getOwnPropertyDescriptor(args, key);
  if (descriptor === undefined) return { valid: true, present: false };
  if (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
    return { valid: false, present: true };
  }
  return { valid: true, present: true, value: descriptor.value };
}

function hasNonEmptyStringArgument(args: unknown, key: string): boolean {
  const argument = ownArgumentValue(args, key);
  return argument.valid
    && argument.present
    && typeof argument.value === 'string'
    && argument.value.length > 0;
}

function dynamicOperation(toolId: string, args: unknown): CapabilityOperationV1 | undefined {
  const action = ownArgumentValue(args, 'action');
  if (!action.valid || !action.present || typeof action.value !== 'string') return undefined;

  if (toolId === 'berry_consolidate') {
    if (action.value === 'status') return 'read';
    if (action.value === 'run' || action.value === 'dream') return 'admin';
    if (action.value !== 'review') return undefined;
    const proposal = ownArgumentValue(args, 'proposal_id');
    if (!proposal.valid || !proposal.present || typeof proposal.value !== 'string' || proposal.value.length === 0) {
      return undefined;
    }
    const decision = ownArgumentValue(args, 'decision');
    if (!decision.valid) return undefined;
    if (!decision.present || decision.value === undefined) return 'read';
    return decision.value === 'approve' || decision.value === 'reject' ? 'admin' : undefined;
  }

  if (toolId === 'berry_tools') {
    if (action.value === 'list') return 'read';
    if (action.value !== 'enable' && action.value !== 'disable') return undefined;
    const domain = ownArgumentValue(args, 'domain');
    return domain.valid && domain.present && typeof domain.value === 'string' && domain.value.length > 0
      ? 'update'
      : undefined;
  }

  if (toolId === 'berry_arch_aspect') {
    if (!hasNonEmptyStringArgument(args, 'name')) return undefined;
    if (action.value === 'create') return 'create';
    if (action.value === 'apply') {
      return hasNonEmptyStringArgument(args, 'entity_name') ? 'update' : undefined;
    }
    if (action.value === 'remove') {
      return hasNonEmptyStringArgument(args, 'entity_name') ? 'delete' : undefined;
    }
    if (action.value === 'list' || action.value === 'get') return 'read';
    return undefined;
  }

  if (toolId === 'berry_arch_drift') {
    if (action.value === 'mark_fresh') {
      return hasNonEmptyStringArgument(args, 'entity_name') ? 'update' : undefined;
    }
    if (action.value === 'check') {
      return hasNonEmptyStringArgument(args, 'entity_name') ? 'read' : undefined;
    }
    if (action.value === 'check_all') {
      return hasNonEmptyStringArgument(args, 'project_name') ? 'read' : undefined;
    }
    if (action.value === 'list_stale') return 'read';
    return undefined;
  }

  if (toolId === 'berry_code_watch') {
    if (action.value === 'start') {
      return hasNonEmptyStringArgument(args, 'path') ? 'create' : undefined;
    }
    if (action.value === 'stop') return 'delete';
    if (action.value === 'status') return 'read';
    return undefined;
  }

  return undefined;
}

function graphExportOperation(args: unknown): CapabilityOperationV1 | undefined {
  if (args === undefined) return 'read';
  const outputPath = ownArgumentValue(args, 'output_path');
  if (!outputPath.valid) return undefined;
  if (!outputPath.present || outputPath.value === undefined) return 'read';
  return typeof outputPath.value === 'string' ? 'create' : undefined;
}

function operationFor(
  metadata: ToolCapabilityMetadataV1,
  args: unknown,
): CapabilityOperationV1 | undefined {
  if (metadata.operation !== 'dynamic') return metadata.operation;
  if (metadata.toolId === 'berry_graph_export') return graphExportOperation(args);
  return dynamicOperation(metadata.toolId, args);
}

function scopeFor(
  metadata: ToolCapabilityMetadataV1,
  args: unknown,
  identity: { readonly tenantId: string; readonly actorId: string },
  operation: CapabilityOperationV1,
): CapabilityScopeV1 {
  const tenantScope: CapabilityScopeV1 = { kind: 'tenant' };
  if (metadata.scopeRule !== 'exact-scope') return tenantScope;
  const scope = ownArgumentValue(args, 'scope');
  if (!scope.valid
    || !scope.present
    || typeof scope.value !== 'string'
    || !STRING_STARTS_WITH(scope.value, 'project:')) return tenantScope;
  try {
    return parseCapabilityCheckRequestV1({
      contractId: CAPABILITY_POLICY_CONTRACT_ID,
      contractVersion: CAPABILITY_POLICY_CONTRACT_VERSION,
      actorId: identity.actorId,
      tenantId: identity.tenantId,
      scope: { kind: 'project', projectId: scope.value },
      domainId: metadata.domainId,
      toolId: metadata.toolId,
      operation,
    }).scope;
  } catch {
    return tenantScope;
  }
}

export function capabilityRequestForToolV1(
  identity: { readonly tenantId: string; readonly actorId: string },
  toolId: string,
  args: unknown,
): CapabilityCheckRequestV1 | undefined {
  const metadata = MAP_GET(metadataByTool, toolId);
  if (metadata === undefined) return undefined;
  const operation = operationFor(metadata, args);
  if (operation === undefined) return undefined;
  try {
    return parseCapabilityCheckRequestV1({
      contractId: CAPABILITY_POLICY_CONTRACT_ID,
      contractVersion: CAPABILITY_POLICY_CONTRACT_VERSION,
      actorId: identity.actorId,
      tenantId: identity.tenantId,
      scope: scopeFor(metadata, args, identity, operation),
      domainId: metadata.domainId,
      toolId: metadata.toolId,
      operation,
    });
  } catch {
    return undefined;
  }
}

export function assertCapabilityToolMatrixV1(toolNames: readonly string[]): void {
  if (toolNames.length !== TOOL_CAPABILITY_METADATA_V1.length) {
    throw new CapabilityRuntimeConfigError(BINDING_ERROR_MESSAGE);
  }
  const seen = new Set<string>();
  for (const toolName of toolNames) {
    if (seen.has(toolName) || !MAP_HAS(metadataByTool, toolName)) {
      throw new CapabilityRuntimeConfigError(BINDING_ERROR_MESSAGE);
    }
    seen.add(toolName);
  }
  if (seen.size !== TOOL_CAPABILITY_METADATA_V1.length) {
    throw new CapabilityRuntimeConfigError(BINDING_ERROR_MESSAGE);
  }
}

function isRegistrationObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSupportedToolRegistration(args: readonly unknown[]): boolean {
  if (args.length < 1 || args.length > 4 || typeof args[args.length - 1] !== 'function') return false;
  const prefixLength = args.length - 1;
  if (prefixLength === 0) return true;
  if (prefixLength === 1) return typeof args[0] === 'string' || isRegistrationObject(args[0]);
  if (prefixLength === 2) {
    return (typeof args[0] === 'string' && isRegistrationObject(args[1]))
      || (isRegistrationObject(args[0]) && isRegistrationObject(args[1]));
  }
  return typeof args[0] === 'string'
    && isRegistrationObject(args[1])
    && isRegistrationObject(args[2]);
}

function deniedToolResult(): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: 'text', text: '**Error:** capability denied' }],
    isError: true,
  };
}

export function installCapabilityRuntimeInterposerV1(
  server: McpServer,
  identity: { readonly tenantId: string; readonly actorId: string },
  policy: ActorCapabilityPolicyV1 | undefined,
): void {
  validateCapabilityRuntimeIdentityV1(identity.tenantId, identity.actorId);
  if (Object.hasOwn(server, 'tool') || typeof REAL_MCP_TOOL !== 'function') {
    throw new CapabilityRuntimeConfigError(BINDING_ERROR_MESSAGE);
  }

  const interposedTool: RuntimeToolMethod = function interposedTool(
    this: McpServer,
    name: string,
    ...registrationArgs: unknown[]
  ): RegisteredTool {
    if (this !== server
      || typeof name !== 'string'
      || !MAP_HAS(metadataByTool, name)
      || !isSupportedToolRegistration(registrationArgs)) {
      throw new CapabilityRuntimeConfigError(BINDING_ERROR_MESSAGE);
    }

    const originalHandler = registrationArgs[registrationArgs.length - 1] as RuntimeToolHandler;
    const wrappedHandler: RuntimeToolHandler = function wrappedHandler(this: unknown, ...callbackArgs: unknown[]) {
      const validatedArgs = callbackArgs.length === 2 ? callbackArgs[0] : undefined;
      const request = capabilityRequestForToolV1(identity, name, validatedArgs);
      if (policy === undefined || request === undefined) return deniedToolResult();
      try {
        if (!evaluateCapabilityV1(policy, request).allowed) return deniedToolResult();
      } catch {
        return deniedToolResult();
      }
      return Reflect.apply(originalHandler, this, callbackArgs);
    };

    const forwarded = registrationArgs.slice();
    forwarded[forwarded.length - 1] = wrappedHandler;
    return Reflect.apply(REAL_MCP_TOOL, server, [name, ...forwarded]);
  };

  Object.defineProperty(server, 'tool', {
    value: interposedTool,
    writable: false,
    enumerable: false,
    configurable: false,
  });
}
