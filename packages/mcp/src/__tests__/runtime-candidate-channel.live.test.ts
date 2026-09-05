import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import neo4j, { type Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const servedProviderControl = vi.hoisted(() => ({
  factoryCalls: 0,
  fail: false,
  serializedRequests: [] as string[],
}));

vi.mock('@memberry/retrieval', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@memberry/retrieval')>();
  return {
    ...actual,
    createServedRerankerProviderV1: () => {
      servedProviderControl.factoryCalls += 1;
      const provider = actual.createServedRerankerProviderV1();
      return Object.freeze({
        identity: provider.identity,
        run: async (...args: Parameters<typeof provider.run>) => {
          servedProviderControl.serializedRequests.push(String(args[0]));
          if (servedProviderControl.fail) throw new Error('ret010d_test_provider_failure');
          return provider.run(...args);
        },
      });
    },
  };
});
import { bootstrap, type BootstrapHandles } from '../bootstrap.js';
import { RETRIEVAL_TRACE_CHANNEL_ORDER } from '@memberry/retrieval';
import { closeSSEHandle, createAMPServer, type SSEHandle } from '../server.js';
import { writeCandidateLiveEvidenceV1 } from './runtime-candidate-channel-live-evidence.js';
import { writeRerankerShadowLiveEvidenceV1 } from './runtime-reranker-shadow-live-evidence.js';

const LIVE_MODE = process.env['MEMBERRY_RET003B_LIVE_MODE'];
if (LIVE_MODE !== undefined && LIVE_MODE !== '' && LIVE_MODE !== 'off' && LIVE_MODE !== 'required') {
  throw new Error('ret003b_live:invalid_mode');
}
const REQUIRED = LIVE_MODE === 'required';
const OPTED_IN = process.env['MEMBERRY_RET003B_DISPOSABLE_OPT_IN'] === '1';
if (REQUIRED && !OPTED_IN) throw new Error('ret003b_live:disposable_opt_in_required');
if (REQUIRED && process.platform !== 'linux') throw new Error('ret003b_live:evidence_platform_unsupported');
const ENABLED = REQUIRED && OPTED_IN;
const RUN = `ret003b-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
const OWNER = `${RUN}-owner`;
const TENANT = `${RUN}-tenant`;
const FOREIGN = `${RUN}-foreign`;
const TOKEN = `${RUN}-tenant-token-0123456789abcdef`;
const DEFAULT_TOKEN = `${RUN}-default-token-0123456789abcdef`;
const PROJECT = `project:${RUN}`;
const DEFAULT_PROJECT = `project:${RUN}-default`;
const EMPTY_PROJECT = `project:${RUN}-empty`;
const AMBIGUOUS_PROJECT = `project:${RUN}-ambiguous`;
const FOREIGN_PROJECT = `project:${RUN}-foreign`;
const HINT = `${RUN}-hint`;
const DEFAULT_HINT = `${RUN}-default-hint`;
const ENTITY_ID = `${RUN}-entity`;
const DEFAULT_ENTITY_ID = `${RUN}-default-entity`;
const RET010D_PROJECT = `project:${RUN}-ret010d`;
const RET010D_HINT = `${RUN}-ret010d-hint`;
const RET010D_ENTITY_ID = `${RUN}-ret010d-entity`;
const RET010D_QUERY = 'cobalt';
const RET010D_BASELINE_ID = `${RUN}-ret010d-baseline`;
const RET010D_LEXICAL_ID = `${RUN}-ret010d-lexical`;
const RET010D_FOREIGN_TENANT = `${RUN}-ret010d-foreign-tenant-secret`;
const RET010D_FOREIGN_PROJECT = `${RUN}-ret010d-foreign-project-secret`;
const RET010D_FUTURE = `${RUN}-ret010d-future-secret`;

let mainDriver: Driver | undefined;
let dedicatedDriver: Driver | undefined;
let bootstrapHandles: BootstrapHandles | undefined;
let mcpHandle: SSEHandle | undefined;
let fakeOpenAI: Server | undefined;
let tenantClient: Client | undefined;
let defaultClient: Client | undefined;
let cleanupCount = -1;
let succeeded = false;
let unauthenticatedStatus = -1;
let baselineParityBytes = '';
let shadowSnapshot: Record<string, number> | undefined;
const fakeLlmBodies: string[] = [];
const savedEnv = new Map<string, string | undefined>();
const ENV_KEYS = [
  'NEO4J_URI', 'NEO4J_USER', 'NEO4J_PASSWORD', 'REDIS_URL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL',
  'MEMBERRY_API_TOKEN', 'MEMBERRY_API_TOKENS', 'MEMBERRY_TENANT_TOKENS', 'MEMBERRY_ALLOW_UNAUTHENTICATED',
  'MEMBERRY_ALLOW_DEFAULT_TENANT', 'MEMBERRY_TENANT_DATASTORES', 'MEMBERRY_QUERY_PLANNER_V1',
  'MEMBERRY_CANDIDATE_CHANNEL_V1', 'MEMBERRY_READONLY', 'MEMBERRY_WIKI_AUTOREFRESH',
  'MEMBERRY_RERANKER_V1',
] as const;

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}

async function fixture(driver: Driver, prefix: string, tenant: string, hint: string, entityId: string): Promise<void> {
  const session = driver.session({ defaultAccessMode: neo4j.session.WRITE });
  try {
    await session.run(
      `CREATE (p:Entity {id:$projectId,name:$projectName,type:'project',tenant_id:$tenant,ret003b_owner:$owner})
       CREATE (e:Entity {id:$entityId,name:$entityName,type:'module',aliases:[$hint],responsibility:'Safe architecture',ret003b_owner:$owner})
       CREATE (p)-[:CONTAINS]->(e)
       CREATE (s:Semantic {id:$semanticId,content:'Safe scoped memory',confidence:0.9,scope:$projectScope,tenant_id:$tenant,ret003b_owner:$owner})
       CREATE (s)-[:ABOUT {valid_at:'2026-01-01T00:00:00.000Z'}]->(e)
       CREATE (past:Semantic {id:$pastSemanticId,content:'Past bounded memory',confidence:0.7,scope:$projectScope,tenant_id:$tenant,ret003b_owner:$owner})
       CREATE (past)-[:ABOUT {valid_at:'2026-01-01T00:00:00.000Z',invalid_at:'2026-06-01T00:00:00.000Z'}]->(e)
       CREATE (future:Semantic {id:$futureSemanticId,content:'Future excluded memory',confidence:1.0,scope:$projectScope,tenant_id:$tenant,ret003b_owner:$owner})
       CREATE (future)-[:ABOUT {valid_at:'2027-01-01T00:00:00.000Z',invalid_at:'2028-01-01T00:00:00.000Z'}]->(e)
       CREATE (f:Fact {id:$factId,subject:'safe',predicate:'uses',object:'bounded source',entity_id:$entityId,scope:'project',tenant_id:$tenant,confidence:0.8,status:'active',valid_at:'2026-01-01T00:00:00.000Z',invalid_at:null,source_episode_ids:[],tags:[$projectScope],created_at:'2026-01-01T00:00:00.000Z',updated_at:'2026-01-01T00:00:00.000Z',ret003b_owner:$owner})
       CREATE (pf:Fact {id:$pastFactId,subject:'past',predicate:'was',object:'valid',entity_id:$entityId,scope:'project',tenant_id:$tenant,confidence:0.7,status:'invalidated',valid_at:'2026-01-01T00:00:00.000Z',invalid_at:'2026-06-01T00:00:00.000Z',source_episode_ids:[],tags:[$projectScope],created_at:'2026-01-01T00:00:00.000Z',updated_at:'2026-06-01T00:00:00.000Z',ret003b_owner:$owner})
       CREATE (b:MemoryBlock {id:$blockId,name:'Core fixture',content:$blockContent,scope:$projectScope,tier:'core',tenant_id:$tenant,ret003b_owner:$owner})
       CREATE (wb:MemoryBlock {id:$workingBlockId,name:'Working fixture',content:$workingBlockContent,scope:$projectScope,tier:'working',session_id:$workingSession,tenant_id:$tenant,ret003b_owner:$owner})
       CREATE (fs:Semantic {id:$foreignSemanticId,content:'FOREIGN SEMANTIC SECRET',confidence:1.0,scope:$projectScope,tenant_id:$foreign,ret003b_owner:$owner})
       CREATE (fs)-[:ABOUT {valid_at:'2026-01-01T00:00:00.000Z'}]->(e)
       CREATE (ff:Fact {id:$foreignFactId,subject:'FOREIGN',predicate:'FACT',object:'SECRET',entity_id:$entityId,scope:'project',tenant_id:$foreign,confidence:1.0,status:'active',valid_at:'2026-01-01T00:00:00.000Z',invalid_at:null,source_episode_ids:[],tags:[$projectScope],created_at:'2026-01-01T00:00:00.000Z',updated_at:'2026-01-01T00:00:00.000Z',ret003b_owner:$owner})
       CREATE (fb:MemoryBlock {id:$foreignBlockId,name:'Foreign fixture',content:$foreignBlockContent,scope:$projectScope,tier:'core',tenant_id:$foreign,ret003b_owner:$owner})`,
      {
        projectId: `${prefix}-project`, projectName: prefix, projectScope: `project:${prefix}`,
        entityId, entityName: `${prefix}-display`, hint, tenant, foreign: FOREIGN, owner: OWNER,
        semanticId: `${prefix}-semantic`, pastSemanticId: `${prefix}-semantic-past`, futureSemanticId: `${prefix}-semantic-future`,
        factId: `${prefix}-fact`, pastFactId: `${prefix}-fact-past`,
        blockId: `${prefix}-block`, blockContent: `${prefix}-core-block`,
        workingBlockId: `${prefix}-working-block`, workingBlockContent: `${prefix}-working-block-secret`,
        workingSession: `${prefix}-working-session`,
        foreignSemanticId: `${prefix}-semantic-foreign`, foreignFactId: `${prefix}-fact-foreign`,
        foreignBlockId: `${prefix}-block-foreign`, foreignBlockContent: `${prefix}-foreign-block-secret`,
      },
    );
  } finally { await session.close(); }
}

async function connectClient(token: string, port: number, name: string): Promise<Client> {
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  return client;
}

async function stopComposition(): Promise<void> {
  await tenantClient?.close(); tenantClient = undefined;
  await defaultClient?.close(); defaultClient = undefined;
  if (mcpHandle) await closeSSEHandle(mcpHandle, 3_000); mcpHandle = undefined;
  await bootstrapHandles?.shutdown(); bootstrapHandles = undefined;
}

async function startRerankerComposition(
  mode: undefined | 'disabled' | 'served',
  name: string,
): Promise<void> {
  process.env['MEMBERRY_QUERY_PLANNER_V1'] = '1';
  process.env['MEMBERRY_CANDIDATE_CHANNEL_V1'] = '1';
  if (mode === undefined) delete process.env['MEMBERRY_RERANKER_V1'];
  else process.env['MEMBERRY_RERANKER_V1'] = mode;
  bootstrapHandles = await bootstrap();
  mcpHandle = await createAMPServer().startSSE(0);
  const port = (mcpHandle.httpServer.address() as AddressInfo).port;
  tenantClient = await connectClient(TOKEN, port, `${name}-dedicated`);
  defaultClient = await connectClient(DEFAULT_TOKEN, port, `${name}-default`);
}

function ret010dArgs(strategy: 'ranked' | 'auto' | 'deterministic', includeTrace = false): Record<string, unknown> {
  return {
    task: RET010D_QUERY,
    strategy,
    project_name: RET010D_PROJECT,
    entity_scope: [RET010D_HINT],
    include_code: false,
    include_arch: false,
    include_memory: true,
    include_trace: includeTrace,
    max_tokens: 6,
    as_of: '2026-08-01T00:00:00.000Z',
  };
}

function resultText(result: { content: unknown }, index = 0): string {
  if (!Array.isArray(result.content)) throw new Error('ret010d_test:text_block_missing');
  const item = result.content[index];
  if (typeof item !== 'object' || item === null || Array.isArray(item)
    || (item as Record<string, unknown>).type !== 'text'
    || typeof (item as Record<string, unknown>).text !== 'string') {
    throw new Error('ret010d_test:text_block_missing');
  }
  return (item as Record<string, string>).text;
}

async function candidateOffBytes(value: undefined | '01', args: Record<string, unknown>): Promise<string> {
  delete process.env['MEMBERRY_RERANKER_V1'];
  if (value === undefined) delete process.env['MEMBERRY_CANDIDATE_CHANNEL_V1'];
  else process.env['MEMBERRY_CANDIDATE_CHANNEL_V1'] = value;
  bootstrapHandles = await bootstrap();
  mcpHandle = await createAMPServer().startSSE(0);
  const port = (mcpHandle.httpServer.address() as AddressInfo).port;
  tenantClient = await connectClient(TOKEN, port, `ret003b-off-${value ?? 'unset'}`);
  const ordinary = await tenantClient.callTool({ name: 'berry_context', arguments: { ...args, include_trace: false } });
  const traced = await tenantClient.callTool({ name: 'berry_context', arguments: { ...args, include_trace: true } });
  const ask = await tenantClient.callTool({ name: 'berry_ask', arguments: {
    question: 'safe?', reasoning_level: 'low', project_name: PROJECT, entity_scope: [HINT],
  } });
  const bytes = JSON.stringify([ordinary, traced, ask]);
  await stopComposition();
  return bytes;
}

// B-3: a hint that names no Entity degrades to the task-text path, loudly, instead of failing.
async function fallbackNote(name: string, args: Record<string, unknown>): Promise<void> {
  const result = await tenantClient!.callTool({ name, arguments: args });
  const text = JSON.stringify(result);
  expect(result.isError).not.toBe(true);
  expect(text).toContain('**Entity scope:** unresolved (entity_not_found); answered from task text');
  expect(text).not.toContain(RUN);
}

async function fixedFailure(name: string, args: Record<string, unknown>): Promise<void> {
  let text = '';
  try { text = JSON.stringify(await tenantClient!.callTool({ name, arguments: args })); }
  catch (error) { text = error instanceof Error ? error.message : String(error); }
  expect(text).toContain('runtime_query_planner:resolution_failed');
  expect(text).not.toContain(RUN);
}

describe.skipIf(!ENABLED)('RET-003B required real-bootstrap HTTP candidate composition', () => {
  beforeAll(async () => {
    for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
    const mainUri = process.env['NEO4J_URI'] ?? 'bolt://127.0.0.1:7687';
    const dedicatedUri = process.env['MEMBERRY_RET003B_DEDICATED_NEO4J_URI'];
    if (!dedicatedUri) throw new Error('ret003b_live:dedicated_neo4j_required');
    const user = process.env['NEO4J_USER'] ?? 'neo4j';
    const password = process.env['NEO4J_PASSWORD'] ?? 'testpassword';
    mainDriver = neo4j.driver(mainUri, neo4j.auth.basic(user, password));
    dedicatedDriver = neo4j.driver(dedicatedUri, neo4j.auth.basic(user, password));
    await Promise.all([mainDriver.verifyConnectivity(), dedicatedDriver.verifyConnectivity()]);
    for (const source of [mainDriver, dedicatedDriver]) {
      const session = source.session({ defaultAccessMode: neo4j.session.WRITE });
      try {
        await session.run('MATCH (n {ret003b_owner:$owner}) DETACH DELETE n', { owner: OWNER });
        const zero = await session.run('MATCH (n {ret003b_owner:$owner}) RETURN count(n) AS count', { owner: OWNER });
        expect(zero.records[0]!.get('count').toNumber()).toBe(0);
      } finally { await session.close(); }
    }
    await fixture(mainDriver, `${RUN}-default`, 'default', DEFAULT_HINT, DEFAULT_ENTITY_ID);
    await fixture(dedicatedDriver, RUN, TENANT, HINT, ENTITY_ID);
    const controls = dedicatedDriver.session({ defaultAccessMode: neo4j.session.WRITE });
    try {
      await controls.run(
        `CREATE (empty:Entity {id:$emptyId,name:$emptyName,type:'project',tenant_id:$tenant,ret003b_owner:$owner})
         CREATE (ap:Entity {id:$ambiguousProjectId,name:$ambiguousProjectName,type:'project',tenant_id:$tenant,ret003b_owner:$owner})
         CREATE (aa:Entity {id:$ambiguousAId,name:'Ambiguous A',type:'module',aliases:[$hint],ret003b_owner:$owner})
         CREATE (ab:Entity {id:$ambiguousBId,name:'Ambiguous B',type:'module',aliases:[$hint],ret003b_owner:$owner})
         CREATE (ap)-[:CONTAINS]->(aa)
         CREATE (ap)-[:CONTAINS]->(ab)
         CREATE (fp:Entity {id:$foreignProjectId,name:$foreignProjectName,type:'project',tenant_id:$foreign,ret003b_owner:$owner})
         CREATE (fe:Entity {id:$foreignEntityId,name:'Foreign root secret',type:'module',aliases:[$hint],ret003b_owner:$owner})
         CREATE (fp)-[:CONTAINS]->(fe)
         CREATE (rp:Entity {id:$ret010dProjectId,name:$ret010dProject,type:'project',tenant_id:$tenant,ret003b_owner:$owner})
         CREATE (re:Entity {id:$ret010dEntityId,name:$ret010dEntityName,type:'module',aliases:[$ret010dHint],ret003b_owner:$owner})
         CREATE (rp)-[:CONTAINS]->(re)
         CREATE (rb:Semantic {id:$ret010dBaselineId,content:'stable baseline memory',confidence:0.99,scope:$ret010dScope,tenant_id:$tenant,ret003b_owner:$owner})
         CREATE (rl:Semantic {id:$ret010dLexicalId,content:$ret010dLexicalContent,confidence:0.01,scope:$ret010dScope,tenant_id:$tenant,ret003b_owner:$owner})
         CREATE (rb)-[:ABOUT {valid_at:'2026-01-01T00:00:00.000Z'}]->(re)
         CREATE (rl)-[:ABOUT {valid_at:'2026-01-01T00:00:00.000Z'}]->(re)
         CREATE (rt:Semantic {id:$ret010dForeignTenantId,content:$ret010dForeignTenant,confidence:1.0,scope:$ret010dScope,tenant_id:$foreign,ret003b_owner:$owner})
         CREATE (rt)-[:ABOUT {valid_at:'2026-01-01T00:00:00.000Z'}]->(re)
         CREATE (rf:Semantic {id:$ret010dFutureId,content:$ret010dFuture,confidence:1.0,scope:$ret010dScope,tenant_id:$tenant,ret003b_owner:$owner})
         CREATE (rf)-[:ABOUT {valid_at:'2099-01-01T00:00:00.000Z'}]->(re)
         CREATE (rop:Entity {id:$ret010dForeignProjectNode,name:$ret010dForeignProjectName,type:'project',tenant_id:$tenant,ret003b_owner:$owner})
         CREATE (roe:Entity {id:$ret010dForeignEntity,name:$ret010dForeignEntityName,type:'module',ret003b_owner:$owner})
         CREATE (rop)-[:CONTAINS]->(roe)
         CREATE (ros:Semantic {id:$ret010dForeignProjectId,content:$ret010dForeignProject,confidence:1.0,scope:$ret010dForeignScope,tenant_id:$tenant,ret003b_owner:$owner})
         CREATE (ros)-[:ABOUT {valid_at:'2026-01-01T00:00:00.000Z'}]->(roe)`,
        {
          emptyId: `${RUN}-empty-project`, emptyName: `${RUN}-empty`,
          ambiguousProjectId: `${RUN}-ambiguous-project`, ambiguousProjectName: `${RUN}-ambiguous`,
          ambiguousAId: `${RUN}-ambiguous-a`, ambiguousBId: `${RUN}-ambiguous-b`,
          foreignProjectId: `${RUN}-foreign-project`, foreignProjectName: `${RUN}-foreign`,
          foreignEntityId: `${RUN}-foreign-entity`, tenant: TENANT, foreign: FOREIGN, hint: HINT, owner: OWNER,
          ret010dProjectId: `${RUN}-ret010d-project-node`, ret010dProject: `${RUN}-ret010d`,
          ret010dEntityId: RET010D_ENTITY_ID, ret010dEntityName: `${RUN}-ret010d-display`, ret010dHint: RET010D_HINT,
          ret010dScope: RET010D_PROJECT, ret010dBaselineId: RET010D_BASELINE_ID,
          ret010dLexicalId: RET010D_LEXICAL_ID, ret010dLexicalContent: RET010D_QUERY,
          ret010dForeignTenantId: `${RUN}-ret010d-foreign-tenant-id`, ret010dForeignTenant: RET010D_FOREIGN_TENANT,
          ret010dFutureId: `${RUN}-ret010d-future-id`, ret010dFuture: RET010D_FUTURE,
          ret010dForeignProjectNode: `${RUN}-ret010d-foreign-project-node`,
          ret010dForeignProjectName: `${RUN}-ret010d-foreign-project`,
          ret010dForeignEntity: `${RUN}-ret010d-foreign-entity`,
          ret010dForeignEntityName: `${RUN}-ret010d-foreign-display`,
          ret010dForeignProjectId: `${RUN}-ret010d-foreign-project-id`,
          ret010dForeignProject: RET010D_FOREIGN_PROJECT,
          ret010dForeignScope: `project:${RUN}-ret010d-foreign-project`,
        },
      );
    } finally { await controls.close(); }

    fakeOpenAI = createServer((request, response) => {
      if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > 1_000_000) request.destroy(new Error('ret010d_test_llm_body_oversized'));
      });
      request.on('end', () => {
        fakeLlmBodies.push(body);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          id: 'ret003b-fixture', object: 'chat.completion', created: 0, model: 'fixture',
          choices: [{ index: 0, message: { role: 'assistant', content: '{"answer":"live","cited":[1]}' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
      });
    });
    await new Promise<void>((resolve) => fakeOpenAI!.listen(0, '127.0.0.1', resolve));
    const fakePort = (fakeOpenAI.address() as AddressInfo).port;
    process.env['NEO4J_URI'] = mainUri;
    process.env['NEO4J_USER'] = user;
    process.env['NEO4J_PASSWORD'] = password;
    process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://127.0.0.1:6379';
    process.env['OPENAI_API_KEY'] = 'ret003b-fixture-key';
    process.env['OPENAI_BASE_URL'] = `http://127.0.0.1:${fakePort}/v1`;
    process.env['MEMBERRY_API_TOKEN'] = DEFAULT_TOKEN;
    delete process.env['MEMBERRY_API_TOKENS'];
    process.env['MEMBERRY_TENANT_TOKENS'] = `${TENANT}:${TOKEN}`;
    process.env['MEMBERRY_ALLOW_DEFAULT_TENANT'] = 'true';
    delete process.env['MEMBERRY_ALLOW_UNAUTHENTICATED'];
    process.env['MEMBERRY_QUERY_PLANNER_V1'] = '1';
    process.env['MEMBERRY_CANDIDATE_CHANNEL_V1'] = '1';
    process.env['MEMBERRY_READONLY'] = 'true';
    process.env['MEMBERRY_WIKI_AUTOREFRESH'] = 'false';
    process.env['MEMBERRY_TENANT_DATASTORES'] = JSON.stringify({
      [TENANT]: { neo4jUri: dedicatedUri, neo4jUser: user, neo4jPassword: password, redisUrl: process.env['REDIS_URL'] },
    });
    delete process.env['MEMBERRY_RERANKER_V1'];
    bootstrapHandles = await bootstrap();
    mcpHandle = await createAMPServer().startSSE(0);
    const port = (mcpHandle.httpServer.address() as AddressInfo).port;
    tenantClient = await connectClient(TOKEN, port, 'ret004b-disabled-parity');
    const parityArgs = {
      task: 'safe', strategy: 'ranked', project_name: PROJECT, entity_scope: [HINT],
      include_code: true, include_arch: true, include_memory: true,
    };
    const disabledOrdinary = await tenantClient.callTool({ name: 'berry_context', arguments: { ...parityArgs, include_trace: false } });
    const disabledTraced = await tenantClient.callTool({ name: 'berry_context', arguments: { ...parityArgs, include_trace: true } });
    const disabledAsk = await tenantClient.callTool({ name: 'berry_ask', arguments: {
      question: 'safe?', reasoning_level: 'low', project_name: PROJECT, entity_scope: [HINT],
    } });
    baselineParityBytes = JSON.stringify([disabledOrdinary, disabledTraced, disabledAsk]);
    await stopComposition();

    process.env['MEMBERRY_RERANKER_V1'] = 'shadow';
    bootstrapHandles = await bootstrap();
    mcpHandle = await createAMPServer().startSSE(0);
    const shadowPort = (mcpHandle.httpServer.address() as AddressInfo).port;
    const unauth = await fetch(`http://127.0.0.1:${shadowPort}/mcp`, {
      method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ret003b', version: '1' },
      } }),
    });
    unauthenticatedStatus = unauth.status;
    await unauth.body?.cancel();
    tenantClient = await connectClient(TOKEN, shadowPort, 'ret003b-dedicated');
    defaultClient = await connectClient(DEFAULT_TOKEN, shadowPort, 'ret003b-default');
  }, 90_000);

  afterAll(async () => {
    let failure: unknown;
    try { await stopComposition(); } catch (error) { failure ??= error; }
    let total = 0;
    for (const source of [mainDriver, dedicatedDriver]) {
      if (!source) continue;
      try {
        const session = source.session({ defaultAccessMode: neo4j.session.WRITE });
        try {
          await session.run('MATCH (n {ret003b_owner:$owner}) DETACH DELETE n', { owner: OWNER });
          const result = await session.run('MATCH (n {ret003b_owner:$owner}) RETURN count(n) AS count', { owner: OWNER });
          total += result.records[0]!.get('count').toNumber();
        } finally { await session.close(); }
      } catch (error) { failure ??= error; }
      try { await source.close(); } catch (error) { failure ??= error; }
    }
    cleanupCount = total;
    if (fakeOpenAI) await new Promise<void>((resolve) => fakeOpenAI!.close(() => resolve()));
    restoreEnv();
    if (cleanupCount !== 0) failure ??= new Error('ret003b_live:cleanup_failed');
    if (failure !== undefined) throw failure;
    if (succeeded) {
      await writeCandidateLiveEvidenceV1();
      await writeRerankerShadowLiveEvidenceV1();
    }
  }, 30_000);

  it('proves real default and dedicated routing, temporal boundaries, isolation, and all three handlers', async () => {
    expect(unauthenticatedStatus).toBe(401);
    const args = {
      task: 'safe', strategy: 'ranked', project_name: PROJECT, entity_scope: [HINT],
      include_code: true, include_arch: true, include_memory: true, include_trace: true,
    };
    const first = await tenantClient!.callTool({ name: 'berry_context', arguments: args });
    const second = await tenantClient!.callTool({ name: 'berry_context', arguments: args });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    const blocks = first.content as Array<{ text: string }>;
    expect(blocks[0]!.text).toContain(`${RUN}-semantic`);
    expect(blocks[0]!.text).toContain(`${RUN}-fact`);
    expect(blocks[0]!.text).toContain(`${RUN}-core-block`);
    expect(blocks[0]!.text).toContain(ENTITY_ID);
    expect(blocks[0]!.text).not.toContain('FOREIGN');
    expect(blocks[0]!.text).not.toContain(`${RUN}-foreign-block-secret`);
    expect(blocks[0]!.text).not.toContain(`${RUN}-working-block-secret`);
    expect(blocks[0]!.text).not.toContain('Past bounded memory');
    expect(blocks[0]!.text).not.toContain('Future excluded memory');
    const trace = JSON.parse(blocks[1]!.text) as { events: Array<Record<string, unknown>> };
    const terminals = trace.events.filter((event) => event.kind === 'channel-terminal');
    const successfulChannels = [
      'memory.scope', 'memory.fact', 'memory.block', 'arch.entity',
    ];
    const successfulChannelSet = new Set(successfulChannels);
    expect(terminals.map((event) => event.channel)).toEqual(RETRIEVAL_TRACE_CHANNEL_ORDER);
    expect(terminals.filter((event) => event.outcome === 'success').map((event) => event.channel))
      .toEqual(successfulChannels);
    expect(terminals.filter((event) => event.code === 'unavailable').map((event) => event.channel))
      .toEqual(RETRIEVAL_TRACE_CHANNEL_ORDER.filter((channel) => !successfulChannelSet.has(channel)));

    const defaultResult = await defaultClient!.callTool({ name: 'berry_context', arguments: {
      ...args, project_name: DEFAULT_PROJECT, entity_scope: [DEFAULT_HINT], include_trace: false,
    } });
    const defaultBytes = JSON.stringify(defaultResult);
    expect(defaultBytes).toContain(DEFAULT_ENTITY_ID);
    expect(defaultBytes).not.toContain(ENTITY_ID);

    const asOf = await tenantClient!.callTool({ name: 'berry_context', arguments: {
      ...args, include_trace: false, as_of: '2026-03-01T00:00:00.000Z',
    } });
    const asOfBytes = JSON.stringify(asOf);
    expect(asOfBytes).toContain('Past bounded memory');
    expect(asOfBytes).toContain(`${RUN}-fact-past`);
    expect(asOfBytes).not.toContain('Future excluded memory');
    const ask = await tenantClient!.callTool({ name: 'berry_ask', arguments: {
      question: 'safe?', reasoning_level: 'low', project_name: PROJECT, entity_scope: [HINT],
    } });
    expect(JSON.stringify(ask)).toContain('live');
    const ordinaryParity = await tenantClient!.callTool({ name: 'berry_context', arguments: { ...args, include_trace: false } });
    expect(JSON.stringify([ordinaryParity, first, ask])).toBe(baselineParityBytes);

    await fallbackNote('berry_context', { task: 'empty', project_name: EMPTY_PROJECT, entity_scope: [HINT] });
    await fixedFailure('berry_context', { task: 'ambiguous', project_name: AMBIGUOUS_PROJECT, entity_scope: [HINT] });
    await fixedFailure('berry_context', { task: 'foreign', project_name: FOREIGN_PROJECT, entity_scope: [HINT] });

    const session = dedicatedDriver!.session({ defaultAccessMode: neo4j.session.WRITE });
    try {
      await session.run(
        `MATCH (e:Entity {id:$entityId})
         CREATE (bad:Semantic {id:$id,content:'malformed source probe',confidence:2.0,scope:$scope,tenant_id:$tenant,ret003b_owner:$owner})
         CREATE (bad)-[:ABOUT]->(e)`,
        { entityId: ENTITY_ID, id: `${RUN}-malformed`, scope: PROJECT, tenant: TENANT, owner: OWNER },
      );
    } finally { await session.close(); }
    const isolated = await tenantClient!.callTool({ name: 'berry_context', arguments: args });
    const isolatedBlocks = isolated.content as Array<{ text: string }>;
    expect(isolatedBlocks[0]!.text).not.toContain('malformed source probe');
    expect(isolatedBlocks[0]!.text).toContain(`${RUN}-fact`);
    expect(isolatedBlocks[0]!.text).toContain(ENTITY_ID);
    const isolatedTrace = JSON.parse(isolatedBlocks[1]!.text) as { events: Array<Record<string, unknown>> };
    expect(isolatedTrace.events).toContainEqual(expect.objectContaining({
      kind: 'channel-terminal', channel: 'memory.scope', outcome: 'safe-failure', code: 'query-failed',
    }));
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const snapshot = bootstrapHandles?.rerankerShadowSnapshot?.();
      if (snapshot && snapshot.inFlight === 0 && snapshot.completed >= 3) { shadowSnapshot = snapshot as Record<string, number>; break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(shadowSnapshot).toMatchObject({ reranked: expect.any(Number), inFlight: 0 });
    expect(shadowSnapshot!.reranked).toBeGreaterThanOrEqual(3);
    const snapshotBytes = JSON.stringify(shadowSnapshot);
    for (const secret of [RUN, TENANT, PROJECT, ENTITY_ID, HINT, 'Safe scoped memory']) expect(snapshotBytes).not.toContain(secret);
    await stopComposition();
    const unsetBytes = await candidateOffBytes(undefined, args);
    const aliasBytes = await candidateOffBytes('01', args);
    expect(aliasBytes).toBe(unsetBytes);

    const askArgs = {
      question: RET010D_QUERY,
      reasoning_level: 'low',
      project_name: RET010D_PROJECT,
      entity_scope: [RET010D_HINT],
      as_of: '2026-08-01T00:00:00.000Z',
    };
    await startRerankerComposition(undefined, 'ret010d-default-off');
    const defaultOffRanked = await tenantClient!.callTool({
      name: 'berry_context', arguments: ret010dArgs('ranked'),
    });
    const defaultOffTraced = await tenantClient!.callTool({
      name: 'berry_context', arguments: ret010dArgs('ranked', true),
    });
    const defaultOffAsk = await tenantClient!.callTool({ name: 'berry_ask', arguments: askArgs });
    const defaultOffDeterministic = await tenantClient!.callTool({
      name: 'berry_context', arguments: ret010dArgs('deterministic'),
    });
    const defaultOffDeterministicTraced = await tenantClient!.callTool({
      name: 'berry_context', arguments: ret010dArgs('deterministic', true),
    });
    expect(servedProviderControl.serializedRequests).toHaveLength(0);
    await stopComposition();

    await startRerankerComposition('disabled', 'ret010d-disabled');
    const disabledRanked = await tenantClient!.callTool({
      name: 'berry_context', arguments: ret010dArgs('ranked'),
    });
    const disabledTraced = await tenantClient!.callTool({
      name: 'berry_context', arguments: ret010dArgs('ranked', true),
    });
    const disabledAsk = await tenantClient!.callTool({ name: 'berry_ask', arguments: askArgs });
    const disabledDeterministic = await tenantClient!.callTool({
      name: 'berry_context', arguments: ret010dArgs('deterministic'),
    });
    const disabledDeterministicTraced = await tenantClient!.callTool({
      name: 'berry_context', arguments: ret010dArgs('deterministic', true),
    });
    expect(JSON.stringify([
      disabledRanked, disabledTraced, disabledAsk, disabledDeterministic, disabledDeterministicTraced,
    ])).toBe(JSON.stringify([
      defaultOffRanked, defaultOffTraced, defaultOffAsk, defaultOffDeterministic, defaultOffDeterministicTraced,
    ]));
    expect(resultText(disabledRanked)).toContain(RET010D_BASELINE_ID);
    expect(resultText(disabledRanked)).not.toContain(RET010D_LEXICAL_ID);
    expect(servedProviderControl.serializedRequests).toHaveLength(0);
    await stopComposition();

    servedProviderControl.fail = false;
    await startRerankerComposition('served', 'ret010d-served');
    const servedRanked = await tenantClient!.callTool({
      name: 'berry_context', arguments: ret010dArgs('ranked'),
    });
    const servedAuto = await tenantClient!.callTool({
      name: 'berry_context', arguments: ret010dArgs('auto'),
    });
    const servedAutoTraced = await tenantClient!.callTool({
      name: 'berry_context', arguments: ret010dArgs('auto', true),
    });
    const servedTraced = await tenantClient!.callTool({
      name: 'berry_context', arguments: ret010dArgs('ranked', true),
    });
    const servedDefault = await defaultClient!.callTool({ name: 'berry_context', arguments: {
      task: 'safe', strategy: 'ranked', project_name: DEFAULT_PROJECT, entity_scope: [DEFAULT_HINT],
      include_code: false, include_arch: true, include_memory: true, include_trace: false,
    } });
    expect(resultText(servedDefault)).toContain(DEFAULT_ENTITY_ID);
    expect(resultText(servedDefault)).not.toContain(RET010D_ENTITY_ID);
    const servedMarkdown = resultText(servedRanked);
    expect(servedMarkdown).toContain(RET010D_LEXICAL_ID);
    expect(servedMarkdown).not.toContain(RET010D_BASELINE_ID);
    expect(resultText(servedAuto)).toBe(servedMarkdown);
    const servedTraceText = resultText(servedTraced, 1);
    const servedTrace = JSON.parse(servedTraceText) as {
      algorithmVersion: string;
      events: Array<Record<string, unknown>>;
    };
    expect(servedTrace.algorithmVersion).toBe('ranked-v2');
    expect(servedTrace.events.filter(({ kind }) => kind === 'reranker-stage')).toEqual([
      expect.objectContaining({
        kind: 'reranker-stage', outcome: 'reranked',
        provider: {
          providerId: 'memberry.local.lexical', modelId: 'bm25f-query-v1',
          calibrationId: 'fixed-blend-v1', locality: 'local',
        },
      }),
    ]);
    const servedAutoTrace = JSON.parse(resultText(servedAutoTraced, 1)) as {
      algorithmVersion: string;
      events: Array<Record<string, unknown>>;
    };
    expect(servedAutoTrace.algorithmVersion).toBe('ranked-v2');
    expect(servedAutoTrace.events.filter(({ kind }) => kind === 'reranker-stage')).toHaveLength(1);
    const callsBeforeDeterministic = servedProviderControl.serializedRequests.length;
    const servedDeterministic = await tenantClient!.callTool({
      name: 'berry_context', arguments: ret010dArgs('deterministic'),
    });
    const servedDeterministicTraced = await tenantClient!.callTool({
      name: 'berry_context', arguments: ret010dArgs('deterministic', true),
    });
    expect(JSON.stringify(servedDeterministic)).toBe(JSON.stringify(disabledDeterministic));
    expect(JSON.stringify(servedDeterministicTraced)).toBe(JSON.stringify(disabledDeterministicTraced));
    expect(servedProviderControl.serializedRequests).toHaveLength(callsBeforeDeterministic);
    const deterministicTrace = JSON.parse(resultText(servedDeterministicTraced, 1)) as {
      algorithmVersion: string;
      events: Array<Record<string, unknown>>;
    };
    expect(deterministicTrace.algorithmVersion).toBe('ranked-v1');
    expect(deterministicTrace.events.some(({ kind }) => kind === 'reranker-stage')).toBe(false);
    const llmBeforeServedAsk = fakeLlmBodies.length;
    const servedAsk = await tenantClient!.callTool({ name: 'berry_ask', arguments: askArgs });
    expect(fakeLlmBodies).toHaveLength(llmBeforeServedAsk + 1);
    const servedLlmRequest = JSON.parse(fakeLlmBodies.at(-1)!) as {
      messages: Array<{ content: string }>;
    };
    const servedLlmPrompt = servedLlmRequest.messages.map(({ content }) => content).join('\n');
    expect(servedLlmPrompt).toContain(`[1] (${RET010D_LEXICAL_ID})\n${RET010D_QUERY}`);
    expect(resultText(servedAsk)).toContain(`**Cited:** ${RET010D_LEXICAL_ID}`);
    expect(resultText(servedAsk)).toContain(`<!-- ${RET010D_LEXICAL_ID} -->\n[1] ${RET010D_QUERY}`);
    for (const sentinel of [
      RET010D_FOREIGN_TENANT, RET010D_FOREIGN_PROJECT, RET010D_FUTURE,
      `${RUN}-ret010d-foreign-tenant-id`, `${RUN}-ret010d-foreign-project-id`, `${RUN}-ret010d-future-id`,
      `${RUN}-ret010d-foreign-project`, `${RUN}-ret010d-foreign-entity`, FOREIGN,
    ]) {
      expect(servedProviderControl.serializedRequests.join('\n')).not.toContain(sentinel);
      expect(servedMarkdown).not.toContain(sentinel);
      expect(servedTraceText).not.toContain(sentinel);
      expect(resultText(servedAutoTraced, 1)).not.toContain(sentinel);
      expect(servedLlmPrompt).not.toContain(sentinel);
      expect(resultText(servedAsk)).not.toContain(sentinel);
    }
    await stopComposition();

    servedProviderControl.fail = true;
    await startRerankerComposition('served', 'ret010d-provider-failure');
    const failedRanked = await tenantClient!.callTool({
      name: 'berry_context', arguments: ret010dArgs('ranked'),
    });
    const failedTraced = await tenantClient!.callTool({
      name: 'berry_context', arguments: ret010dArgs('ranked', true),
    });
    const failedAsk = await tenantClient!.callTool({ name: 'berry_ask', arguments: askArgs });
    expect(JSON.stringify(failedRanked)).toBe(JSON.stringify(disabledRanked));
    expect(JSON.stringify(failedAsk)).toBe(JSON.stringify(disabledAsk));
    const failedTrace = JSON.parse(resultText(failedTraced, 1)) as {
      algorithmVersion: string;
      events: Array<Record<string, unknown>>;
    };
    expect(failedTrace.algorithmVersion).toBe('ranked-v2');
    expect(failedTrace.events.filter(({ kind }) => kind === 'reranker-stage')).toEqual([
      expect.objectContaining({ kind: 'reranker-stage', outcome: 'baseline', reason: 'not-reranked' }),
    ]);
    await stopComposition();
    servedProviderControl.fail = false;
    expect(servedProviderControl.factoryCalls).toBe(2);
    succeeded = true;
  }, 240_000);
});

if (!ENABLED) console.error('[skip] RET-003B required live proof disabled; no database connection attempted');
