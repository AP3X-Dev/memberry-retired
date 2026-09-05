import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import neo4j, { type Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ScopedEntityResolver,
  setRetrievalServiceInstances,
  type IUnifiedAssembler,
  type RetrievalTraceV1,
  type UnifiedContext,
} from '@memberry/retrieval';
import { closeSSEHandle, createAMPServer, type SSEHandle } from '../server.js';
import { writePlannerLiveEvidenceV1 } from './runtime-query-planner-live-evidence.js';

const REQUIRED = process.env['MEMBERRY_RET002C2_LIVE_MODE'] === 'required';
const OPTED_IN = process.env['MEMBERRY_RET002C2_DISPOSABLE_OPT_IN'] === '1';
if (REQUIRED && !OPTED_IN) throw new Error('ret002c2_live:disposable_opt_in_required');
if (REQUIRED && process.platform !== 'linux') throw new Error('ret002c2_live:evidence_platform_unsupported');
const ENABLED = REQUIRED && OPTED_IN;
const RUN = `ret002c2-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
const TENANT = `${RUN}-tenant`;
const FOREIGN_TENANT = `${RUN}-foreign-tenant`;
const TOKEN = `${RUN}-token-0123456789abcdef`;
const SAFE_PROJECT = `project:${RUN}`;
const EMPTY_PROJECT = `project:${RUN}-empty`;
const AMBIGUOUS_PROJECT = `project:${RUN}-ambiguous`;
const FOREIGN_PROJECT = `project:${RUN}-foreign`;
const SAFE_HINT = `${RUN}-safe-alias`;
const AMBIGUOUS_HINT = `${RUN}-ambiguous-alias`;
const FOREIGN_HINT = `${RUN}-foreign-alias`;
const SAFE_ENTITY_ID = `${RUN}-safe-entity`;
const OWNER = `${RUN}-owner`;
const approvedTrace = JSON.parse(readFileSync(
  new URL('../../../retrieval/src/__tests__/fixtures/retrieval-trace-deterministic-v2.json', import.meta.url),
  'utf8',
)) as RetrievalTraceV1;

let driver: Driver | undefined;
let handle: SSEHandle | undefined;
let client: Client | undefined;
let cleanupCount = -1;
let succeeded = false;
let unauthenticatedStatus = -1;
const ordinaryIds: string[][] = [];
const tracedIds: string[][] = [];
const askIds: string[][] = [];
const savedEnv = {
  tenantTokens: process.env['MEMBERRY_TENANT_TOKENS'],
  apiToken: process.env['MEMBERRY_API_TOKEN'],
  apiTokens: process.env['MEMBERRY_API_TOKENS'],
  allowUnauthenticated: process.env['MEMBERRY_ALLOW_UNAUTHENTICATED'],
};

function emptyContext(task: string): UnifiedContext {
  return { task, strategy: 'ranked', sections: [], token_count: 0, assembled_at: '2026-08-16T00:00:00.000Z' };
}

// A task-text call (B-3 fallback) carries no resolvedEntityIds; record it as [] so the count
// assertions below can tell "went downstream unanchored" from "went downstream anchored".
function idsFrom(options: { resolvedEntityIds?: unknown }): string[] {
  return 'resolvedEntityIds' in options ? [...(options.resolvedEntityIds as readonly string[])] : [];
}

const FALLBACK_NOTE = '**Entity scope:** unresolved (entity_not_found); answered from task text';

// B-3: a hint that names no Entity degrades to the task-text path, loudly. Never an error,
// never a resolved id downstream, never the caller's values in the note.
async function callMustFallBack(name: string, args: Record<string, unknown>): Promise<void> {
  const result = await client!.callTool({ name, arguments: args });
  const text = JSON.stringify(result);
  expect(result.isError).not.toBe(true);
  expect(text).toContain(FALLBACK_NOTE);
  expect(text).not.toContain(RUN);
}

async function callMustFail(name: string, args: Record<string, unknown>): Promise<void> {
  let failed = false;
  let failureText = '';
  try {
    const result = await client!.callTool({ name, arguments: args });
    failed = result.isError === true;
    failureText = JSON.stringify(result);
  } catch (error) {
    failed = true;
    failureText = error instanceof Error ? error.message : String(error);
  }
  expect(failed).toBe(true);
  expect(failureText).toContain('runtime_query_planner:resolution_failed');
  expect(failureText).not.toContain(RUN);
}

function restoreEnvironment(): void {
  for (const [key, value] of Object.entries({
    MEMBERRY_TENANT_TOKENS: savedEnv.tenantTokens,
    MEMBERRY_API_TOKEN: savedEnv.apiToken,
    MEMBERRY_API_TOKENS: savedEnv.apiTokens,
    MEMBERRY_ALLOW_UNAUTHENTICATED: savedEnv.allowUnauthenticated,
  })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}

describe.skipIf(!ENABLED)('RET-002C2 required authenticated HTTP planner composition', () => {
  beforeAll(async () => {
    driver = neo4j.driver(
      process.env['NEO4J_URI'] ?? 'bolt://127.0.0.1:7687',
      neo4j.auth.basic(
        process.env['NEO4J_USER'] ?? 'neo4j',
        process.env['NEO4J_PASSWORD'] ?? 'testpassword',
      ),
    );
    await driver.verifyConnectivity();
    const session = driver.session({ defaultAccessMode: neo4j.session.WRITE });
    try {
      await session.run(
        `CREATE (safeProject:Entity {
           id: $safeProjectId, name: $safeProjectName, type: 'project', tenant_id: $tenantId,
           ret002c2_owner: $owner
         })
         CREATE (safeEntity:Entity {
           id: $safeEntityId, name: $safeEntityName, type: 'module', aliases: [$safeHint],
           ret002c2_owner: $owner
         })
         CREATE (safeProject)-[:CONTAINS]->(safeEntity)
         CREATE (emptyProject:Entity {
           id: $emptyProjectId, name: $emptyProjectName, type: 'project', tenant_id: $tenantId,
           ret002c2_owner: $owner
         })
         CREATE (ambiguousProject:Entity {
           id: $ambiguousProjectId, name: $ambiguousProjectName, type: 'project', tenant_id: $tenantId,
           ret002c2_owner: $owner
         })
         CREATE (ambiguousA:Entity {
           id: $ambiguousAId, name: $ambiguousAName, type: 'module', aliases: [$ambiguousHint],
           ret002c2_owner: $owner
         })
         CREATE (ambiguousB:Entity {
           id: $ambiguousBId, name: $ambiguousBName, type: 'module', aliases: [$ambiguousHint],
           ret002c2_owner: $owner
         })
         CREATE (ambiguousProject)-[:CONTAINS]->(ambiguousA)
         CREATE (ambiguousProject)-[:CONTAINS]->(ambiguousB)
         CREATE (foreignProject:Entity {
           id: $foreignProjectId, name: $foreignProjectName, type: 'project', tenant_id: $foreignTenant,
           ret002c2_owner: $owner
         })
         CREATE (foreignEntity:Entity {
           id: $foreignEntityId, name: $foreignEntityName, type: 'module', aliases: [$foreignHint],
           ret002c2_owner: $owner
         })
         CREATE (foreignProject)-[:CONTAINS]->(foreignEntity)`,
        {
          safeProjectId: `${RUN}-safe-project`, safeProjectName: RUN,
          safeEntityId: SAFE_ENTITY_ID, safeEntityName: `${RUN}-safe-display`, safeHint: SAFE_HINT,
          emptyProjectId: `${RUN}-empty-project`, emptyProjectName: `${RUN}-empty`,
          ambiguousProjectId: `${RUN}-ambiguous-project`, ambiguousProjectName: `${RUN}-ambiguous`,
          ambiguousAId: `${RUN}-ambiguous-a`, ambiguousAName: `${RUN}-ambiguous-a-display`,
          ambiguousBId: `${RUN}-ambiguous-b`, ambiguousBName: `${RUN}-ambiguous-b-display`,
          ambiguousHint: AMBIGUOUS_HINT,
          foreignProjectId: `${RUN}-foreign-project`, foreignProjectName: `${RUN}-foreign`,
          foreignEntityId: `${RUN}-foreign-entity`, foreignEntityName: `${RUN}-foreign-display`,
          foreignHint: FOREIGN_HINT, tenantId: TENANT, foreignTenant: FOREIGN_TENANT, owner: OWNER,
        },
      );
    } finally {
      await session.close();
    }

    const assembler: IUnifiedAssembler = {
      assemble: vi.fn(async (task, options) => {
        ordinaryIds.push(idsFrom(options));
        return emptyContext(task);
      }),
      assembleTraced: vi.fn(async (task, options) => {
        tracedIds.push(idsFrom(options));
        return { context: emptyContext(task), trace: approvedTrace };
      }),
      renderMarkdown: vi.fn(() => '# live'),
      ask: vi.fn(async (_question, options) => {
        askIds.push(idsFrom(options));
        return { answer: 'live', cited_ids: [], evidence: [], level: 'low' };
      }),
    };
    setRetrievalServiceInstances({
      assembler,
      feedbackTracker: null as never,
      queryPlannerEnabled: true,
      resolverFactory: (authority) => {
        const resolver = new ScopedEntityResolver(driver!, authority);
        return { resolve: (plan) => resolver.resolve(plan) };
      },
    });
    delete process.env['MEMBERRY_API_TOKEN'];
    delete process.env['MEMBERRY_API_TOKENS'];
    delete process.env['MEMBERRY_ALLOW_UNAUTHENTICATED'];
    process.env['MEMBERRY_TENANT_TOKENS'] = `${TENANT}:${TOKEN}`;
    handle = await createAMPServer().startSSE(0);
    const address = handle.httpServer.address() as AddressInfo;
    const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
    const unauthenticated = await fetch(url, {
      method: 'POST',
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ret002c2', version: '1' } },
      }),
    });
    unauthenticatedStatus = unauthenticated.status;
    await unauthenticated.body?.cancel();
    client = new Client({ name: 'ret002c2-live', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    }));
  }, 30_000);

  afterAll(async () => {
    let cleanupFailure: unknown;
    try {
      await client?.close();
    } catch (error) {
      cleanupFailure = error;
    }
    try {
      if (handle) await closeSSEHandle(handle, 2_000);
    } catch (error) {
      cleanupFailure ??= error;
    }
    try {
      if (driver !== undefined) {
        const session = driver.session({ defaultAccessMode: neo4j.session.WRITE });
        try {
          await session.run('MATCH (n:Entity {ret002c2_owner: $owner}) DETACH DELETE n', { owner: OWNER });
          const remaining = await session.run(
            'MATCH (n:Entity {ret002c2_owner: $owner}) RETURN count(n) AS count',
            { owner: OWNER },
          );
          cleanupCount = remaining.records[0]!.get('count').toNumber();
        } finally {
          await session.close();
        }
      }
    } catch (error) {
      cleanupFailure ??= error;
    } finally {
      try {
        await driver?.close();
      } catch (error) {
        cleanupFailure ??= error;
      }
      restoreEnvironment();
    }
    try {
      expect(cleanupCount).toBe(0);
    } catch (error) {
      cleanupFailure ??= error;
    }
    if (cleanupFailure !== undefined) throw cleanupFailure;
    if (succeeded) {
      await writePlannerLiveEvidenceV1();
    }
  }, 30_000);

  it('binds real HTTP auth to one resolver ID and rejects real controls before downstream', async () => {
    expect(unauthenticatedStatus).toBe(401);
    await client!.callTool({ name: 'berry_context', arguments: {
      task: 'ordinary', strategy: 'ranked', project_name: SAFE_PROJECT, entity_scope: [SAFE_HINT],
      include_code: false, include_arch: false, include_memory: false,
    } });
    await client!.callTool({ name: 'berry_context', arguments: {
      task: 'traced', strategy: 'ranked', project_name: SAFE_PROJECT, entity_scope: [SAFE_HINT],
      include_code: false, include_arch: false, include_memory: false, include_trace: true,
    } });
    await client!.callTool({ name: 'berry_ask', arguments: {
      question: 'ask', reasoning_level: 'low', project_name: SAFE_PROJECT, entity_scope: [SAFE_HINT],
    } });
    expect(ordinaryIds).toEqual([[SAFE_ENTITY_ID]]);
    expect(tracedIds).toEqual([[SAFE_ENTITY_ID]]);
    expect(askIds).toEqual([[SAFE_ENTITY_ID]]);

    const downstreamCount = ordinaryIds.length + tracedIds.length + askIds.length;
    await callMustFallBack('berry_context', {
      task: 'not-found', project_name: EMPTY_PROJECT, entity_scope: [SAFE_HINT],
    });
    // The fallback went downstream exactly once, as a task-text call with no resolved id.
    expect(ordinaryIds.length + tracedIds.length + askIds.length).toBe(downstreamCount + 1);
    expect(ordinaryIds.at(-1)).toEqual([]);
    const afterFallbackCount = downstreamCount + 1;
    await callMustFail('berry_context', {
      task: 'ambiguous', project_name: AMBIGUOUS_PROJECT, entity_scope: [AMBIGUOUS_HINT],
    });
    await callMustFail('berry_context', {
      task: 'denied', project_name: FOREIGN_PROJECT, entity_scope: [FOREIGN_HINT],
    });
    // A foreign entity's alias under the caller's OWN project is, from the caller's side, a hint
    // that names nothing: the resolver answers entity_not_found (no existence leak), so B-3
    // degrades it to a task-text ask inside the caller's own project and tenant.
    await callMustFallBack('berry_ask', {
      question: 'foreign', project_name: SAFE_PROJECT, entity_scope: [FOREIGN_HINT],
    });
    expect(askIds.at(-1)).toEqual([]);
    expect(ordinaryIds.length + tracedIds.length + askIds.length).toBe(afterFallbackCount + 1);
    succeeded = true;
  }, 30_000);
});

if (!ENABLED) {
  console.error('[skip] RET-002C2 required live proof disabled; no database connection attempted');
}
