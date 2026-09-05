// packages/mcp/src/bootstrap.ts
// Wires up Redis, Neo4j, embedding, and core services from environment variables.

import { z } from 'zod';
import { DistributedLock, ProposalStore } from '@memberry/redis';
import { runMigrations, checkVectorIndexDimensions, checkVectorIndexCoverage, ProvenanceTraversal } from '@memberry/neo4j';
import fs from 'node:fs';
import path from 'node:path';
import { ConsolidationEngine, BootstrapGraphService, createCoreServices, buildDreamEngine, buildExtractionConsumer, readEnv, defaultExportPath, DEFAULT_TENANT, resolveLifecycleConfig, runLifecyclePass, parseBoolFlag, getAllowedBaseDir, warnUnknownMemberryEnv } from '@memberry/core';
import type { CoreServices, LifecyclePassResult } from '@memberry/core';
import { setServiceInstances, setTenantContainer } from './tools.js';
import {
  initResearchSchema,
  ExperimentStore,
  CampaignStore,
  HypothesisNavigator,
  ResearchContextBuilder,
  ContradictionDetector,
  ResearchConsolidation,
  setResearchServiceInstances,
} from '@memberry/research';
import {
  initArchSchema,
  ArchEntityStore,
  AspectStore,
  StructuralRelationStore,
  ImpactAnalyzer,
  DriftDetector,
  ArchContextBuilder,
  setArchServiceInstances,
} from '@memberry/arch';
import {
  initCodeSchema,
  CodeIndexer,
  SymbolStore,
  CodeSearch,
  CodeWatcher,
  extractFilePaths,
  confineReindexPath,
  getReindexBaseDir,
  setCodeServiceInstances,
} from '@memberry/code';
import {
  UnifiedAssembler,
  FeedbackTracker,
  ScopedEntityResolver,
  setRetrievalServiceInstances,
  RERANKER_SHADOW_PROVIDER_IDENTITY,
  RerankerShadowCoordinatorV1,
  baselineIdentityRerankerScoreV1,
  createLocalRerankerProviderV1,
  createServedRerankerProviderV1,
  createCodeRerankerV1,
  type RerankerShadowSnapshotV1,
} from '@memberry/retrieval';
import {
  WikiCompiler,
  IngestionService,
  WikiLinter,
  WikiEditReconciler,
  DefaultDocumentConverter,
  CachingDocumentConverter,
  setWikiServiceInstances,
} from '@memberry/wiki';
import type { CompileInput, CompileV2Result } from '@memberry/wiki';
import {
  configureWikiAutorefresh,
  isWikiAutorefreshEnabled,
  resolveWikiOutputDir,
} from './wiki-autorefresh.js';
import {
  ConsolidationCoordinator,
  recoverEpisodeScopes,
  resolveConsolidationCoordinatorConfig,
  resolveEpisodeScope,
} from './consolidation-coordinator.js';
import {
  initGraphSchema,
  GraphSnapshotService,
  GraphReportService,
  GraphExportService,
  PrImpactService,
  GitHubCliProvider,
  setGraphServiceInstances,
} from '@memberry/graph';
import { registerAdmissionShadowStatusSources } from './admission-shadow-status.js';
import { registerReadinessProbeSource, type LifecycleReadiness } from './server.js';

export interface BootstrapHandles {
  /** Call to disconnect Redis and Neo4j cleanly. */
  shutdown(): Promise<void>;
  /** RET-004B content-free aggregate proof; absent while default-off. */
  rerankerShadowSnapshot?(): RerankerShadowSnapshotV1;
}

/** A per-tenant dedicated-datastore config (the value side of MEMBERRY_TENANT_DATASTORES). */
export interface TenantDatastoreConfig {
  neo4jUri: string;
  neo4jUser?: string;
  neo4jPassword: string;
  redisUrl: string;
  openaiKey?: string;
}

export type BootstrapRerankerModeV1 = 'disabled' | 'shadow' | 'served';

/** Resolve the exact bootstrap-owned response mode without trimming, coercion,
 * aliases, or value reflection. This runs before every startup effect. */
export function resolveBootstrapRerankerModeV1(raw: string | undefined): BootstrapRerankerModeV1 {
  if (raw === undefined || raw === '' || raw === 'disabled') return 'disabled';
  if (raw === 'shadow') return 'shadow';
  if (raw === 'served') return 'served';
  throw new Error('reranker_mode:invalid');
}

async function discoverConcreteScopes(
  driver: ReturnType<typeof createCoreServices>['driver'],
  tenantId: string,
): Promise<string[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (e:Episodic)
       WHERE coalesce(e.tenant_id, $defaultTenant) = $tenantId
       RETURN e.scope AS scope, e.tags AS tags, e.task AS task, e.content AS content`,
      { tenantId, defaultTenant: DEFAULT_TENANT },
    );
    return recoverEpisodeScopes(result.records.map((record) => ({
      scope: record.get('scope') == null ? undefined : String(record.get('scope')),
      tags: Array.isArray(record.get('tags'))
        ? (record.get('tags') as unknown[]).map(String)
        : undefined,
      task: record.get('task') == null ? undefined : String(record.get('task')),
      content: record.get('content') == null ? undefined : String(record.get('content')),
    })));
  } finally {
    await session.close();
  }
}

// OPT-37: shape-validate MEMBERRY_TENANT_DATASTORES. neo4jUri/neo4jPassword/redisUrl
// are REQUIRED — they are exactly what makes an entry a *dedicated* store. Without
// validation, a non-object value (a string is iterated char-by-char by
// Object.entries) or an entry missing those fields would silently construct a
// core pointing at the localhost DEFAULTS — i.e. the SHARED instance — so a tenant
// the operator believed was physically isolated would actually be colocated. Fail
// closed instead. `.strict()` also rejects typo'd keys that would be ignored.
const TenantDatastoreSchema = z
  .object({
    neo4jUri: z.string().min(1),
    neo4jUser: z.string().min(1).optional(),
    neo4jPassword: z.string().min(1),
    redisUrl: z.string().min(1),
    openaiKey: z.string().min(1).optional(),
  })
  .strict();
const TenantDatastoresSchema = z.record(z.string().min(1), TenantDatastoreSchema);

/**
 * Parse + validate MEMBERRY_TENANT_DATASTORES. Returns {} when unset/empty.
 * Throws (fail-closed, at startup) on invalid JSON, a non-object root, or any
 * entry missing/typoing a required field — never silently falls back to the
 * shared localhost datastore. Error messages name the offending key PATH only,
 * never the value, so a password is not echoed into logs.
 */
export function parseTenantDatastores(
  raw: string | undefined,
): Record<string, TenantDatastoreConfig> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `MEMBERRY_TENANT_DATASTORES is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      'MEMBERRY_TENANT_DATASTORES must be a JSON object mapping tenant -> { neo4jUri, neo4jPassword, redisUrl, neo4jUser?, openaiKey? }',
    );
  }
  const result = TenantDatastoresSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`MEMBERRY_TENANT_DATASTORES is malformed: ${detail}`);
  }
  return result.data;
}

// ─── MEM-006 in-process scheduler (item 13a) ─────────────────────────────────
// Under Docker nothing installs the systemd timer, so the CLI-only lifecycle
// pass never ran: memory never decayed/archived and the hebbian feedback ring
// grew unbounded. The server now runs the SAME `runLifecyclePass` on a timer.

export interface LifecycleSchedulerDeps {
  run: () => Promise<LifecyclePassResult>;
  intervalMs: number;
  log?: (line: string) => void;
}

export function startLifecycleScheduler(deps: LifecycleSchedulerDeps): { stop(): void; status(): LifecycleReadiness } {
  const log = deps.log ?? ((line) => console.error(line));
  let running = false;
  // 13b: last-pass record surfaced on /readyz `lifecycle`.
  let status: LifecycleReadiness = { mode: 'live', last_run_at: null, last_result: 'never' };
  const tick = async (): Promise<void> => {
    if (running) {
      log('[lifecycle] skipped: previous pass still running');
      status = { ...status, last_result: 'skipped' };
      return;
    }
    running = true;
    const startedAt = new Date().toISOString();
    try {
      const pass = await deps.run();
      log(
        `[lifecycle] pass complete: scopes=${pass.scopes.length} failures=${pass.failures.length}`
        + (pass.hebbian ? ` hebbian_tenants=${pass.hebbian.tenants.length} hebbian_failures=${pass.hebbian.failures.length}` : '')
        + (pass.anti_entropy ? ` anti_entropy_failures=${pass.anti_entropy.failures.length}` : ''),
      );
      status = {
        mode: 'live', last_run_at: startedAt, last_result: 'ok',
        ...(pass.hebbian ? { hebbian_drained: pass.hebbian.tenants.reduce((n, t) => n + t.drained, 0) } : {}),
        ...(pass.anti_entropy ? { anti_entropy: { ...pass.anti_entropy.extraction, failures: pass.anti_entropy.failures.length } } : {}),
      };
    } catch (err) {
      // Class only: a lifecycle error message can carry scope names/ids. A Node
      // errno code (EACCES, ENOSPC) is a fixed string and far more actionable
      // than the bare constructor name, so prefer it when present.
      const errorClass = err instanceof Error
        ? ((err as NodeJS.ErrnoException).code ?? err.constructor.name)
        : typeof err;
      log(`[lifecycle] pass failed: ${errorClass}`);
      status = { mode: 'live', last_run_at: startedAt, last_result: 'failed', last_error_class: errorClass };
    } finally {
      running = false;
    }
  };
  const unref = (t: ReturnType<typeof setTimeout>) => { if (typeof t.unref === 'function') t.unref(); };
  let interval: ReturnType<typeof setInterval> | undefined;
  const initial = setTimeout(() => {
    void tick();
    interval = setInterval(() => { void tick(); }, deps.intervalMs);
    unref(interval);
  }, 5 * 60_000);
  unref(initial);
  return {
    stop() {
      clearTimeout(initial);
      if (interval) clearInterval(interval);
    },
    status: () => status,
  };
}

export const DEFAULT_LIFECYCLE_INTERVAL_MS = 24 * 3_600_000;
export const MIN_LIFECYCLE_INTERVAL_MS = 3_600_000;

/** MEMBERRY_LIFECYCLE_INTERVAL_MS: unset → default silently; non-numeric → default,
 *  below minimum → minimum; both substitutions warn once at boot (13b). */
export function parseLifecycleIntervalMs(
  raw: string | undefined,
  log: (line: string) => void = (line) => console.error(line),
): number {
  if (raw === undefined) return DEFAULT_LIFECYCLE_INTERVAL_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    log(`[lifecycle] MEMBERRY_LIFECYCLE_INTERVAL_MS invalid, using default ${DEFAULT_LIFECYCLE_INTERVAL_MS}`);
    return DEFAULT_LIFECYCLE_INTERVAL_MS;
  }
  if (parsed < MIN_LIFECYCLE_INTERVAL_MS) {
    log(`[lifecycle] MEMBERRY_LIFECYCLE_INTERVAL_MS below minimum, using ${MIN_LIFECYCLE_INTERVAL_MS}`);
    return MIN_LIFECYCLE_INTERVAL_MS;
  }
  return parsed;
}

// ─── Code watch on boot (item 14b, audit A3) ─────────────────────────────────
// The CodeWatcher was constructed at boot but only berry_code_watch ever armed
// it, so after a restart the code index went stale until an agent asked. Roots
// are the root_path persisted on project entities by ingest (item 14a); each is
// re-confined against the allowed base and checked on disk before watching.
// Logs carry the project NAME only, never the path.

/** Structural subset of neo4j-driver's Driver (mcp has no direct driver dependency). */
interface ProjectRootReader {
  session(): {
    run(query: string): Promise<{ records: Array<{ get(key: string): unknown }> }>;
    close(): Promise<unknown>;
  };
}

export interface CodeWatchOnBootDeps {
  driver: ProjectRootReader;
  watcher: { watch(root: string): unknown };
  allowedBaseDir: string;
  /** Resolves true when `p` exists and is a directory. */
  exists?: (p: string) => Promise<boolean>;
  log?: (line: string) => void;
}

async function isDirectory(p: string): Promise<boolean> {
  try { return (await fs.promises.stat(p)).isDirectory(); } catch { return false; }
}

export async function startCodeWatchOnBoot(deps: CodeWatchOnBootDeps): Promise<void> {
  const log = deps.log ?? ((line) => console.error(line));
  const exists = deps.exists ?? isDirectory;
  const base = path.resolve(deps.allowedBaseDir);
  let roots: Array<{ name: string; root: string }>;
  try {
    const session = deps.driver.session();
    try {
      const result = await session.run(
        `MATCH (e:Entity {type: 'project'}) WHERE e.root_path IS NOT NULL RETURN e.name AS name, e.root_path AS root`,
      );
      roots = result.records.map((r) => ({ name: String(r.get('name')), root: String(r.get('root')) }));
    } finally {
      await session.close();
    }
  } catch (err) {
    log(`[code-watch] boot watch failed: ${err instanceof Error ? err.constructor.name : typeof err}`);
    return;
  }
  for (const { name, root } of roots) {
    const abs = path.resolve(root);
    if (!abs.startsWith(base + path.sep) && abs !== base) {
      log(`[code-watch] root outside allowed base, skipped: ${name}`);
      continue;
    }
    if (!(await exists(abs))) {
      log(`[code-watch] root missing on disk, skipped: ${name}`);
      continue;
    }
    try {
      deps.watcher.watch(abs);
      log(`[code-watch] watching ${name}`);
    } catch (err) {
      log(`[code-watch] watch failed: ${err instanceof Error ? err.constructor.name : typeof err}, skipped: ${name}`);
    }
  }
}

export async function bootstrap(): Promise<BootstrapHandles> {
  // Item 20a (audit C10): one warning per MEMBERRY_* env not in MEMBERRY_FLAGS. Never throws.
  warnUnknownMemberryEnv(process.env, (line) => console.error(line));
  const queryPlannerEnabled = process.env['MEMBERRY_QUERY_PLANNER_V1'] === '1';
  const candidateChannelEnabled = process.env['MEMBERRY_CANDIDATE_CHANNEL_V1'] === '1';
  // RET-007 v4: default-off second retrieval pass over the memory channel.
  const multihopExpansionEnabled = process.env['MEMBERRY_MULTIHOP_EXPANSION_V1'] === '1';
  const episodicRecallEnabled = process.env['MEMBERRY_EPISODIC_RECALL_V1'] === '1';
  const episodicIdentifierReserveEnabled = process.env['MEMBERRY_EPISODIC_IDENTIFIER_RESERVE_V1'] === '1';
  const rerankerMode = resolveBootstrapRerankerModeV1(process.env['MEMBERRY_RERANKER_V1']);
  if (rerankerMode === 'shadow' && (!queryPlannerEnabled || !candidateChannelEnabled)) {
    throw new Error('reranker_shadow:prerequisite_unavailable');
  }
  if (rerankerMode === 'served' && (!queryPlannerEnabled || !candidateChannelEnabled)) {
    throw new Error('reranker_served:prerequisite_unavailable');
  }
  const rerankerShadowCoordinator = rerankerMode === 'shadow'
    ? new RerankerShadowCoordinatorV1(
      createLocalRerankerProviderV1(
        RERANKER_SHADOW_PROVIDER_IDENTITY,
        baselineIdentityRerankerScoreV1,
      ),
      () => {},
    )
    : null;
  const servedReranker = rerankerMode === 'served'
    ? createServedRerankerProviderV1()
    : null;
  const neo4jUri = process.env['NEO4J_URI']?.trim() || 'bolt://localhost:7687';
  const neo4jUser = process.env['NEO4J_USER']?.trim() || 'neo4j';
  const neo4jPassword = process.env['NEO4J_PASSWORD'] ?? '';
  const redisUrl = process.env['REDIS_URL']?.trim() || 'redis://localhost:6379';
  const openaiKey = process.env['OPENAI_API_KEY']?.trim() ?? '';
  const exportPath = readEnv('MEMBERRY_EXPORT_PATH') ?? defaultExportPath();

  // Build the shared core load/store kit through the single construction path
  // used by both the MCP server and the CLI hook commands (@memberry/core
  // services-factory). The factory builds clients lazily and does not own the
  // schema lifecycle — the server connects-and-verifies below.
  const core = createCoreServices({ neo4jUri, neo4jUser, neo4jPassword, redisUrl, openaiKey, exportPath });
  const {
    driver,
    redis,
    cache,
    signals,
    queue,
    scopedQuery,
    episodic,
    factStore: factStoreInstance,
    semantic,
    embedding,
    llm,
    config,
    ampService,
    memoryBlocks: memoryBlockServiceInstance,
  } = core;

  // Connect-and-verify + initialise schema (idempotent).
  await redis.ping();
  console.error('[memberry-mcp] Redis connected');
  await driver.getServerInfo();
  console.error('[memberry-mcp] Neo4j connected');

  // ─── Operational status tracking ────────────────────────────────────────────
  const status = {
    redis: true,
    neo4j: true,
    embeddings: !!openaiKey,
    degraded: [] as string[],
  };

  const migration = await runMigrations(driver);
  console.error(
    `[memberry-mcp] Neo4j schema verified (migrations: ${migration.version} applied` +
    `${migration.applied.length > 0 ? `, +${migration.applied.length} new: ${migration.applied.join(', ')}` : ''})`,
  );
  // Drift guard: a vector index whose dimension no longer matches EMBEDDING_DIM
  // would silently break similarity search. Surface it loudly with a remediation hint.
  const dimDrift = await checkVectorIndexDimensions(driver);
  if (dimDrift.length > 0) {
    for (const d of dimDrift) {
      console.error(
        `[memberry-mcp] WARNING: vector index "${d.name}" has dimension ${d.actual} but ` +
        `EMBEDDING_DIM is ${d.expected}. Drop and recreate it (DROP INDEX ${d.name}) ` +
        `or set MEMBERRY_EMBEDDING_DIM=${d.actual} to match.`,
      );
    }
    status.degraded.push(`schema: ${dimDrift.length} vector index dimension mismatch`);
  }
  // IDX-003: an index with the right shape and nothing in it is just as broken,
  // and unlike a dimension mismatch it produces no error anywhere — the channel
  // returns zero rows and reports success. Say so at boot.
  const underCoveredVectorIndexes = await checkVectorIndexCoverage(driver);
  for (const idx of underCoveredVectorIndexes) {
    // State the RATIO, not just the fact. Saying "has no embeddings" about a label that has 63%
    // of them sends the reader looking for a wiring bug that is not there.
    const pct = (idx.ratio * 100).toFixed(1);
    console.error(
      `[memberry-mcp] WARNING: :${idx.label} embedding coverage is ${idx.embedded}/${idx.nodes} ` +
      `(${pct}%). Vector search over ${idx.label} silently misses the un-embedded remainder on ` +
      `every query while reporting success. Backfill with: ` +
      `node scripts/backfill-symbol-embeddings.mjs (Symbol) ` +
      `or node scripts/backfill-embeddings.mjs (Semantic).`,
    );
  }
  if (underCoveredVectorIndexes.length > 0) {
    status.degraded.push(
      `vectors: ${underCoveredVectorIndexes
        .map((i) => `${i.label} ${i.embedded}/${i.nodes} embedded`)
        .join(', ')}`,
    );
  }

  // Services the MCP server needs beyond the core load/store kit.
  // Pass the shared embedding provider so consolidation-promoted and superseded
  // semantics get a content embedding at write time and land in the
  // semantic_embedding vector index (without it they were write-only).
  // `semantic` comes from CoreServices (constructed there with the same shared
  // embedding provider) so the store used by AMPService's signal-target
  // validation and the one used by consolidation are the SAME instance.
  const lock = new DistributedLock(redis);
  const proposals = new ProposalStore(redis);
  const provenanceTraversal = new ProvenanceTraversal(driver);

  if (!openaiKey) {
    status.degraded.push('embeddings: disabled (no OPENAI_API_KEY) — lexical/fulltext retrieval only');
    console.error('[memberry-mcp] No OPENAI_API_KEY — semantic vector search is DISABLED. ' +
      'Retrieval falls back to deterministic lexical + fulltext ranking (no random results). ' +
      'Set OPENAI_API_KEY to enable embeddings.');
  }

  const consolidationEngine = new ConsolidationEngine(
    { lock, signals, queue, cache, proposals },
    // OPT-102: wire the episodic accessor so _deriveTenantFromEpisodes can read
    // source episodes' tenant_id. Without it, a promote/supersede whose
    // after.tenant_id is unset would mis-attribute the consolidated semantic to
    // DEFAULT_TENANT in multi-tenant mode. EpisodicStore exposes getById +
    // getTenantsByIds (OPT-45) — matching the optional ConsolidationNeo4jLayer.episodic.
    {
      semantic,
      episodic: {
        getById: (id) => episodic.getById(id),
        getTenantsByIds: (ids) => episodic.getTenantsByIds(ids),
        findPromotable: (scope, limit) => episodic.findPromotable(scope, limit, DEFAULT_TENANT),
      },
      fact: factStoreInstance,
    },
    config,
    // The promote path synthesizes clustered episodes into one durable claim;
    // without an LLM it stays inert and only signal-driven proposals are made.
    llm,
  );

  // Build bootstrap service (embedding provider so seeded semantics are
  // vector-recallable, matching the consolidation/supersede write paths).
  const bootstrapGraphService = new BootstrapGraphService(driver, embedding);

  // Background "dream" pass (generative gap-filling + abductive hypotheses).
  const dreamEngine = buildDreamEngine(core);

  // Adapt ConsolidationEngine to the IConsolidationEngine interface expected by tools
  const consolidationAdapter = {
    run: (scope?: string) => consolidationEngine.run(scope ?? 'global'),
    status: () => consolidationEngine.status(),
    review: async (proposalId: string) => {
      const proposal = await proposals.get(proposalId);
      return proposal ?? { error: 'not found' };
    },
    apply: async (proposalId: string, decision: 'approve' | 'reject') => {
      try {
        return await consolidationEngine.apply(proposalId, decision);
      } catch (err) {
        return { applied: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    dream: (scope: string) => dreamEngine.run(scope),
  };

  // A global consolidation run is unsafe for project isolation: it can inspect
  // episodes from multiple scopes in one candidate set. The coordinator always
  // discovers and schedules concrete scopes, and serializes them
  // process-wide because the underlying signal consumer group is shared.
  // Logical multi-tenant mode is deliberately fail-closed until the core run
  // API accepts a tenant discriminator. Dedicated tenant datastores get their
  // own isolated coordinator below.
  // Configure the compiler before evaluating enablement so the guard checks the
  // actual env-resolved output directory (not its /app/wiki initial default).
  const rawWikiCompiler = new WikiCompiler(driver, { tenantId: DEFAULT_TENANT });
  configureWikiAutorefresh({
    recompile: (outputDir: string) => rawWikiCompiler.compile(outputDir),
    outputDir: resolveWikiOutputDir(),
  });
  const logicalMultiTenant = Boolean(readEnv('MEMBERRY_TENANT_TOKENS'));
  if (logicalMultiTenant) {
    // The current full wiki compiler is graph-global. Publishing it in a shared
    // logical multi-tenant datastore would leak tenant knowledge, so fail closed
    // until generation queries carry a tenant boundary.
    process.env['MEMBERRY_WIKI_AUTOREFRESH'] = 'false';
  }
  const wikiPublicationEnabled = !logicalMultiTenant && isWikiAutorefreshEnabled();
  const automationLimitations = [
    logicalMultiTenant
      ? 'shared logical multi-tenant consolidation and wiki publication are disabled to prevent cross-tenant disclosure'
      : null,
    !openaiKey
      ? 'recurring/synthesized semantic promotion is unavailable without an LLM/embedding provider; approved classified decisions still promote and episodic recall remains available'
      : null,
    !logicalMultiTenant && !wikiPublicationEnabled
      ? 'automatic wiki publication is disabled; graph memory remains available but served wiki freshness is not managed'
      : null,
  ].filter((value): value is string => value !== null);
  const defaultCoordinatorConfig = resolveConsolidationCoordinatorConfig(config.readonly === true);
  const consolidationCoordinator = new ConsolidationCoordinator({
    name: 'default',
    config: {
      ...defaultCoordinatorConfig,
      enabled: defaultCoordinatorConfig.enabled && !logicalMultiTenant,
    },
    run: (scope) => consolidationEngine.run(scope),
    discoverScopes: () => discoverConcreteScopes(driver, DEFAULT_TENANT),
    // Auto-applied promotion/reinforcement changes must reach the served wiki;
    // the existing publisher coalesces this into a safe full-generation build.
    // Use the compiler promise directly so publication failure is observable;
    // the coordinator retries publication separately and never re-applies a
    // graph mutation merely because rendering failed.
    onMutation: wikiPublicationEnabled
      ? async () => { await rawWikiCompiler.compile(resolveWikiOutputDir()); }
      : undefined,
    publicationState: wikiPublicationEnabled ? {
      markDirty: () => redis.incr('memberry:wiki:generation:dirty'),
      versions: async () => {
        const [dirty, published] = await redis.mget(
          'memberry:wiki:generation:dirty',
          'memberry:wiki:generation:published',
        );
        return { dirty: Number(dirty ?? 0), published: Number(published ?? 0) };
      },
      markPublished: async (version) => {
        await redis.set('memberry:wiki:generation:published', String(version));
      },
    } : undefined,
    limitation: automationLimitations.length > 0 ? automationLimitations.join('; ') : undefined,
    forceUnhealthy: logicalMultiTenant,
  });
  if (logicalMultiTenant && defaultCoordinatorConfig.enabled) {
    console.error(
      '[memberry-mcp] consolidation automation disabled for the shared logical multi-tenant datastore; ' +
      'tenant-qualified core consolidation is required to preserve isolation',
    );
  }

  // Inject into MCP tools (codeIndexer injected later after Code services init)
  setServiceInstances({
    ampService,
    consolidationEngine: consolidationAdapter,
    scopedQuery,
    bootstrapService: bootstrapGraphService,
    memoryBlockService: memoryBlockServiceInstance,
    factStore: factStoreInstance,
    provenance: provenanceTraversal,
  });

  console.error('[memberry-mcp] Memory block and fact services initialized');

  // ─── Research services ─────────────────────────────────────────────────────
  await initResearchSchema(driver);
  console.error('[memberry-mcp] Research schema verified');

  const experimentStore = new ExperimentStore(driver);
  const campaignStore = new CampaignStore(driver);
  const hypothesisNavigator = new HypothesisNavigator(driver);
  const researchContextBuilder = new ResearchContextBuilder(driver);
  const contradictionDetector = new ContradictionDetector(driver);
  const researchConsolidation = new ResearchConsolidation(driver);

  setResearchServiceInstances({
    experimentStore,
    campaignStore,
    contextBuilder: researchContextBuilder,
    hypothesisNavigator,
    contradictionDetector,
    researchConsolidation,
  });

  console.error('[memberry-mcp] Research services initialized');

  // ─── Arch services ─────────────────────────────────────────────────────────
  await initArchSchema(driver);
  console.error('[memberry-mcp] Arch schema verified');

  const archEntityStore = new ArchEntityStore(driver);
  const aspectStore = new AspectStore(driver);
  const relationStore = new StructuralRelationStore(driver);
  const impactAnalyzer = new ImpactAnalyzer(driver);
  const driftDetector = new DriftDetector(driver);
  const archContextBuilder = new ArchContextBuilder(driver);

  setArchServiceInstances({
    archEntityStore,
    aspectStore,
    relationStore,
    impactAnalyzer,
    driftDetector,
    archContextBuilder,
  });

  console.error('[memberry-mcp] Arch services initialized');

  // ─── Code intelligence services ────────────────────────────────────────────
  await initCodeSchema(driver);
  console.error('[memberry-mcp] Code schema verified');

  // IDX-003: pass the shared embedding provider so indexed Symbols get a dense
  // vector and land in the symbol_embedding index. Without it they were
  // write-only and the code.dense-vector channel was inert on every query.
  const codeIndexerService = new CodeIndexer(driver, embedding);
  const symbolStoreService = new SymbolStore(driver);
  // IDX-004: the code plane borrows the BM25F reranker that has served the memory plane for
  // months. Injected here because packages/mcp is the only package that depends on both, and
  // packages/retrieval already depends on packages/code so the import cannot run the other way.
  // Inert until BOTH MEMBERRY_CODE_RERANK_V1=1 and a caller passes `rerank: true` — only the
  // berry_code_search handler does, which is what keeps this off the assembler.
  const codeSearchService = new CodeSearch(driver, embedding, createCodeRerankerV1());
  const codeWatcherService = new CodeWatcher(codeIndexerService, symbolStoreService);

  // Wire post-store hook: re-index files mentioned in stored episode content.
  // SECURITY: stored content is fully UNTRUSTED. An agent (or ingested content)
  // can put a traversal/absolute path in it (e.g. `../../../../etc/secrets/x.py`)
  // to coax the re-indexer into reading arbitrary source files into the queryable
  // graph. Confine every extracted path to the ingest base BEFORE it reaches
  // queueReindex; confinement failures are silently dropped (this is a background
  // hook — they must never throw into the store() caller path).
  const originalStore = ampService.store.bind(ampService);
  ampService.store = async (input) => {
    const result = await originalStore(input);
    if (!result.duplicate && input.content) {
      try {
        const filePaths = extractFilePaths(input.content);
        // OPT-68: pin the confinement base so the watcher re-validates the path
        // against the SAME base at read time (closing the queue→read TOCTOU).
        const reindexBase = getReindexBaseDir();
        for (const fp of filePaths) {
          const confined = confineReindexPath(fp, reindexBase);
          if (confined === null) {
            console.error(`[memberry-mcp] dropped out-of-base re-index path from stored content: ${fp}`);
            continue;
          }
          codeWatcherService.queueReindex(confined, reindexBase);
        }
      } catch (err: unknown) {
        // Post-store hook failures are non-fatal
      }

      // Publication is debounced, retried independently of consolidation, and
      // surfaced in /readyz. A renderer failure can never fail the store or
      // cause an already-applied graph mutation to execute twice.
      await consolidationCoordinator.schedulePublication();
      consolidationCoordinator.schedule(resolveEpisodeScope(input));
    }
    return result;
  };

  setCodeServiceInstances({
    codeIndexer: codeIndexerService,
    codeSearch: codeSearchService,
    symbolStore: symbolStoreService,
    codeWatcher: codeWatcherService,
  });

  // Re-inject with codeIndexer now available so berry_ingest_codebase works.
  // NOTE: every service must be re-passed here — setServiceInstances does a full
  // reset, so an omitted service is cleared. (Previously `provenance` was dropped
  // on this second call, silently disabling berry_provenance.)
  setServiceInstances({
    ampService,
    consolidationEngine: consolidationAdapter,
    scopedQuery,
    bootstrapService: bootstrapGraphService,
    memoryBlockService: memoryBlockServiceInstance,
    factStore: factStoreInstance,
    codeIndexer: codeIndexerService,
    provenance: provenanceTraversal,
  });

  console.error('[memberry-mcp] Code services initialized');

  // ─── Retrieval services ────────────────────────────────────────────────────
  const feedbackRedis = {
    zincrby: async (key: string, inc: number, member: string) => {
      const result = await redis.zincrby(key, inc, member);
      return parseFloat(result);
    },
    zrevrangeWithScores: async (key: string, start: number, stop: number) => {
      const raw = await redis.zrevrange(key, start, stop, 'WITHSCORES');
      const pairs: Array<{ member: string; score: number }> = [];
      for (let i = 0; i < raw.length; i += 2) {
        pairs.push({ member: raw[i], score: parseFloat(raw[i + 1]) });
      }
      return pairs;
    },
    lpush: async (key: string, value: string) => redis.lpush(key, value),
    ltrim: async (key: string, start: number, stop: number) => { await redis.ltrim(key, start, stop); },
  };

  const unifiedAssembler = new UnifiedAssembler(
    driver,
    feedbackRedis,
    codeSearchService,
    ampService,
    embedding,
    llm,
    servedReranker,
  );
  if (multihopExpansionEnabled) {
    unifiedAssembler.enableMultihopExpansionV1({ policy: 'evidence-bridge', clock: () => Date.now() });
  }
  if (episodicRecallEnabled) unifiedAssembler.enableEpisodicRecallV1();
  if (episodicIdentifierReserveEnabled) unifiedAssembler.enableEpisodicIdentifierReserveV1();
  const feedbackTrackerService = new FeedbackTracker(feedbackRedis);
  const dedicatedTenantCandidateDrivers = new Map<string, typeof driver>();

  // ─── Wiki services ─────────────────────────────────────────────────────────
  // WikiCompiler.compile() accepts outputDir plus an optional project tag; the
  // IWikiCompiler interface used by MCP tools accepts a CompileInput object.
  const wikiCompilerAdapter = {
    compile: async (input: CompileInput): Promise<CompileV2Result> =>
      rawWikiCompiler.compile(input.output_dir, input.project_tag),
  };
  // Document conversion (PDF/Office/HTML/RTF → text) via optional system tools,
  // with a SHA-256 manifest cache under .amp/converted. No npm dependencies.
  const documentConverter = new CachingDocumentConverter(new DefaultDocumentConverter());
  const ingestionServiceInstance = new IngestionService(driver, undefined, documentConverter);
  const wikiLinterInstance = new WikiLinter(driver);
  const editReconcilerInstance = new WikiEditReconciler(driver);

  setWikiServiceInstances({
    wikiCompiler: wikiCompilerAdapter,
    ingestionService: ingestionServiceInstance,
    wikiLinter: wikiLinterInstance,
    editReconciler: editReconcilerInstance,
  });

  console.error('[memberry-mcp] Wiki services initialized');

  // ─── Graph analytics services ──────────────────────────────────────────────
  await initGraphSchema(driver);
  console.error('[memberry-mcp] Graph schema verified');

  const graphSnapshotService = new GraphSnapshotService(driver);
  const graphReportService = new GraphReportService(graphSnapshotService);
  const graphExportService = new GraphExportService(graphSnapshotService);
  const prImpactService = new PrImpactService(graphSnapshotService, new GitHubCliProvider(), driver);

  setGraphServiceInstances({
    snapshotService: graphSnapshotService,
    reportService: graphReportService,
    exportService: graphExportService,
    prImpactService,
  });

  console.error('[memberry-mcp] Graph services initialized');

  // ─── Durable fact-extraction consumer ──────────────────────────────────────
  // store() enqueues extraction jobs to a Redis Stream; this long-lived worker
  // drains them, so extraction survives a process restart (orphaned jobs are
  // reclaimed via XAUTOCLAIM) and permanent failures land in a dead-letter queue.
  // ─── Per-tenant dedicated datastores (graduation seam) ──────────────────────
  // MEMBERRY_TENANT_DATASTORES = {"acme":{"neo4jUri":"bolt://...","neo4jPassword":"...","redisUrl":"redis://..."}}
  // Tenants listed here get their OWN Neo4j/Redis (physical isolation); all other
  // tenants share this instance with a tenant_id filter (logical isolation).
  const dedicatedTenantCores: Array<Pick<CoreServices, 'close' | 'admissionShadow'>> = [];
  const dedicatedTenantCoordinators: ConsolidationCoordinator[] = [];
  const tenantDatastores = parseTenantDatastores(readEnv('MEMBERRY_TENANT_DATASTORES'));
  {
    for (const [tenant, ds] of Object.entries(tenantDatastores)) {
      const tcore = createCoreServices({
        neo4jUri: ds.neo4jUri, neo4jUser: ds.neo4jUser, neo4jPassword: ds.neo4jPassword,
        redisUrl: ds.redisUrl, openaiKey: ds.openaiKey ?? openaiKey, exportPath,
      });
      await tcore.redis.ping();
      await tcore.driver.getServerInfo();
      await runMigrations(tcore.driver);
      const tenantProposals = new ProposalStore(tcore.redis);
      const tenantConsolidation = new ConsolidationEngine(
        {
          lock: new DistributedLock(tcore.redis),
          signals: tcore.signals,
          queue: tcore.queue,
          cache: tcore.cache,
          proposals: tenantProposals,
        },
        {
          semantic: tcore.semantic,
          episodic: {
            getById: (id) => tcore.episodic.getById(id),
            getTenantsByIds: (ids) => tcore.episodic.getTenantsByIds(ids),
            findPromotable: (scope, limit) => tcore.episodic.findPromotable(scope, limit, tenant),
          },
          fact: tcore.factStore,
        },
        tcore.config,
        tcore.llm,
      );
      const tenantConsolidationAdapter = {
        run: (scope?: string) => tenantConsolidation.run(scope ?? 'global'),
        status: () => tenantConsolidation.status(),
        review: async (proposalId: string) =>
          (await tenantProposals.get(proposalId)) ?? { error: 'not found' },
        apply: async (proposalId: string, decision: 'approve' | 'reject') => {
          try {
            return await tenantConsolidation.apply(proposalId, decision);
          } catch (err) {
            return { applied: false, error: err instanceof Error ? err.message : String(err) };
          }
        },
      };
      const tenantCoordinator = new ConsolidationCoordinator({
        name: `tenant:${tenant}`,
        config: resolveConsolidationCoordinatorConfig(tcore.config.readonly === true),
        run: (scope) => tenantConsolidation.run(scope),
        discoverScopes: () => discoverConcreteScopes(tcore.driver, tenant),
        limitation: 'the shared wiki publisher does not render this dedicated tenant datastore',
      });
      const tenantStore = tcore.ampService.store.bind(tcore.ampService);
      tcore.ampService.store = async (input) => {
        const result = await tenantStore(input);
        if (!result.duplicate) tenantCoordinator.schedule(resolveEpisodeScope(input));
        return result;
      };
      setTenantContainer(tenant, {
        ampService: tcore.ampService,
        consolidationEngine: tenantConsolidationAdapter,
        scopedQuery: tcore.scopedQuery,
        memoryBlockService: tcore.memoryBlocks,
        factStore: tcore.factStore,
      });
      dedicatedTenantCandidateDrivers.set(tenant, tcore.driver);
      dedicatedTenantCores.push(tcore);
      dedicatedTenantCoordinators.push(tenantCoordinator);
      console.error(`[memberry-mcp] tenant "${tenant}" bound to a dedicated datastore`);
    }
  }

  setRetrievalServiceInstances({
    assembler: unifiedAssembler,
    feedbackTracker: feedbackTrackerService,
    queryPlannerEnabled,
    candidateChannelEnabled,
    rerankerShadowCoordinator,
    multihopExpansionEnabled,
    candidateDriver: driver,
    projectScopeDriver: driver,
    tenantCandidateDrivers: dedicatedTenantCandidateDrivers,
    resolverFactory: (authority) => {
      const resolver = new ScopedEntityResolver(driver, authority);
      return { resolve: (plan) => resolver.resolve(plan) };
    },
  });

  console.error('[memberry-mcp] Retrieval services initialized');

  const extractionConsumer = buildExtractionConsumer(core);
  await extractionConsumer.start();
  try {
    const xstats = await core.extractionQueue.stats();
    console.error(
      `[memberry-mcp] Extraction consumer started ` +
      `(pending=${xstats.pending}, inflight=${xstats.inflight}, dead-lettered=${xstats.deadLettered})`,
    );
  } catch {
    console.error('[memberry-mcp] Extraction consumer started');
  }

  // Start only after every graph/wiki service is ready. The immediate catch-up
  // timer recovers stores missed while the process was down; periodic discovery
  // repairs any missed hot-path trigger without a user call.
  consolidationCoordinator.start();
  for (const coordinator of dedicatedTenantCoordinators) coordinator.start();

  // MEM-006 retention/archive pass, in-process, behind the existing flag.
  // Flag not live => nothing is constructed (CLI/systemd path unchanged).
  const lifecycleConfig = resolveLifecycleConfig(defaultExportPath());
  if (lifecycleConfig.mode === 'live') {
    // Fail loud at boot, not once per scope per pass: the export root must be writable.
    try { fs.mkdirSync(path.join(lifecycleConfig.exportDir, 'lifecycle'), { recursive: true }); }
    catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
      console.error(`[memberry-mcp] WARNING: lifecycle export dir is not writable (${code}); every lifecycle pass will fail until MEMBERRY_LIFECYCLE_EXPORT_DIR points at a writable directory`);
    }
  }
  const lifecycleScheduler = lifecycleConfig.mode === 'live'
    ? startLifecycleScheduler({
        run: () => runLifecyclePass(core, { config: lifecycleConfig }),
        // MEMBERRY_LIFECYCLE_INTERVAL_MS — pass cadence in ms; default 24h, minimum 1h (flag inventory: item 20a).
        intervalMs: parseLifecycleIntervalMs(readEnv('MEMBERRY_LIFECYCLE_INTERVAL_MS')),
      })
    : null;
  if (lifecycleScheduler) console.error('[memberry-mcp] Lifecycle scheduler started (first pass in 5 min)');

  // Item 14b: re-arm the code watcher for persisted project roots. Fire-and-
  // forget: never awaited, errors are logged inside the helper, flag unset =>
  // the query never runs. shutdown() already calls codeWatcherService.stopAll().
  // MEMBERRY_CODE_WATCH_ON_BOOT — watch persisted project root_paths at boot; loose bool, default off (flag inventory: item 20a).
  if (parseBoolFlag(readEnv('MEMBERRY_CODE_WATCH_ON_BOOT'), false)) {
    void startCodeWatchOnBoot({
      driver,
      watcher: codeWatcherService,
      allowedBaseDir: getAllowedBaseDir(),
    });
  }

  if (status.degraded.length > 0) {
    console.error(`[memberry-mcp] DEGRADED MODE — ${status.degraded.length} issue(s):`);
    for (const issue of status.degraded) {
      console.error(`  - ${issue}`);
    }
  } else {
    console.error('[memberry-mcp] All services initialized — fully operational');
  }

  // Register only after bootstrap has succeeded so an initialization failure
  // cannot leave stale process-global readiness sources behind.
  const unregisterAdmissionShadowStatus = registerAdmissionShadowStatusSources([
    core.admissionShadow,
    ...dedicatedTenantCores.map((tenantCore) => tenantCore.admissionShadow),
  ]);
  // D1/A6: /readyz probes the live datastores per request and echoes the
  // degraded list computed above; embeddings state is reported, not fatal.
  const unregisterReadinessProbe = registerReadinessProbeSource({
    neo4j: driver,
    redis,
    embeddings: !openaiKey
      ? 'disabled'
      : (dimDrift.length > 0 || underCoveredVectorIndexes.length > 0) ? 'degraded' : 'ok',
    degraded: status.degraded,
    // C4: expose the collection-size probe window so an operator can see when
    // RRF fusion is running on a stale or absent collection size.
    retrieval: () => {
      const probe = unifiedAssembler.collectionSizeStatus();
      return {
        collection_size: {
          state: probe.state,
          cached_at: probe.cachedAt,
          ...(probe.lastErrorClass !== undefined ? { last_error_class: probe.lastErrorClass } : {}),
        },
      };
    },
    // 13b: last in-process lifecycle pass; no scheduler => disabled/never.
    lifecycle: () => lifecycleScheduler?.status() ?? { mode: 'disabled', last_run_at: null, last_result: 'never' },
  });

  return {
    ...(rerankerShadowCoordinator
      ? { rerankerShadowSnapshot: () => rerankerShadowCoordinator.snapshot() }
      : {}),
    async shutdown() {
      if (rerankerShadowCoordinator) {
        try { await rerankerShadowCoordinator.shutdown(); } catch { /* best-effort */ }
      }
      lifecycleScheduler?.stop();
      try { await consolidationCoordinator.stop(); } catch { /* best-effort */ }
      for (const coordinator of dedicatedTenantCoordinators) {
        try { await coordinator.stop(); } catch { /* best-effort */ }
      }
      try { await extractionConsumer.stop(); } catch { /* best-effort */ }
      for (const tc of dedicatedTenantCores) { try { await tc.close(); } catch { /* already closed */ } }
      try { codeWatcherService.stopAll(); } catch { /* best-effort */ }
      // Core close drains admission sidecars for at most one second before the
      // shared Neo4j driver is closed, then preserves the existing Redis/driver
      // best-effort shutdown behavior.
      try { await core.close(); } catch { /* already closed */ }
      unregisterAdmissionShadowStatus();
      unregisterReadinessProbe();
    },
  };
}
