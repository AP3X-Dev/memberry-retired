// packages/core/src/services-factory.ts
//
// Single construction path for the core memory services (load/store + memory
// blocks). Both the MCP server (packages/mcp/src/bootstrap.ts) and the CLI hook
// commands (packages/core/src/cli/*) build their services through this factory
// so the two transports can never drift apart in how they wire AMPService.
//
// The factory is a *pure builder*: it creates clients and services but does NOT
// connect-and-verify or initialise the Neo4j schema. That keeps it cheap enough
// to call from a latency-sensitive hook. Callers that own the schema lifecycle
// (the MCP server) run initSchema() themselves.

import {
  createRedisClient,
  ContextCache,
  EmbeddingCache,
  DedupChecker,
  SignalStream,
  ConsolidationQueue,
  ExtractionQueue,
  DistributedLock,
  BlockStore as RedisBlockStore,
} from '@memberry/redis';
import {
  createNeo4jDriver,
  EpisodicStore,
  SemanticStore,
  ScopedQuery,
  FactStore,
  AuditLogStore,
  AdmissionObservationStore,
  AdmissionRoutingRecommendationStore,
  BlockStore as Neo4jBlockStore,
} from '@memberry/neo4j';
import { AMPService } from './service.js';
import { MemoryBlockService } from './blocks.js';
import { OpenAIEmbedding } from './embedding.js';
import { CachingEmbeddingProvider } from './caching-embedding.js';
import { OpenAiLlmClient, NullLlmClient, type LlmClient } from './llm.js';
import { KeyedSerialQueue } from './serial-queue.js';
import { DreamEngine, type DreamGraphLayer, type DreamBlockLayer } from './dream.js';
import { ExtractionConsumer } from './extraction-consumer.js';
import { EMBEDDING_DIM, type EmbeddingProvider, type AMPConfig } from './types.js';
import { readEnv, defaultExportPath } from './config/settings.js';
import { parseBoolFlag } from './config/bool-flag.js';
import { AdmissionShadowRuntime, resolveAdmissionShadowConfig } from './admission-shadow.js';
import {
  AdmissionRoutingModeError,
  resolveAdmissionRoutingModeV1,
  resolveTierRoutingConfig,
} from './admission-routing.js';
import {
  AdmissionFeatureProducerModeError,
  resolveAdmissionFeatureProducerModeV1,
} from './admission-features-v2.js';
import { produceAdmissionFeatureEnvelopeV2 } from './admission-feature-producer.js';

export interface CoreServicesEnv {
  neo4jUri?: string;
  neo4jUser?: string;
  neo4jPassword?: string;
  redisUrl?: string;
  openaiKey?: string;
  exportPath?: string;
}

/**
 * The shared low-level kit. The CLI uses `ampService` + `memoryBlocks` + `close`.
 * The MCP bootstrap also uses the connection primitives to build the remaining
 * (consolidation/research/arch/code/...) services on top.
 */
export interface CoreServices {
  driver: ReturnType<typeof createNeo4jDriver>;
  redis: ReturnType<typeof createRedisClient>;
  cache: ContextCache;
  embeddings: EmbeddingCache;
  dedup: DedupChecker;
  signals: SignalStream;
  queue: ConsolidationQueue;
  /** Durable fact-extraction job queue (drained by the ExtractionConsumer). */
  extractionQueue: ExtractionQueue;
  episodic: EpisodicStore;
  /** Semantic-node store. Shared so the MCP bootstrap and AMPService use ONE
   *  instance (and one embedding provider) rather than constructing their own. */
  semantic: SemanticStore;
  scopedQuery: ScopedQuery;
  factStore: FactStore;
  /** Append-only mutation audit trail. */
  audit: AuditLogStore;
  embedding: EmbeddingProvider;
  /** Shared chat-completion client (NullLlmClient when no API key). */
  llm: LlmClient;
  /** Per-entity write serializer shared across passes (dream, extraction). */
  serialQueue: KeyedSerialQueue;
  config: AMPConfig;
  ampService: AMPService;
  memoryBlocks: MemoryBlockService;
  /** Process-local default-off MEM-001 shadow runtime and secret-free status source. */
  admissionShadow: AdmissionShadowRuntime;
  /** Disconnect Redis and close the Neo4j driver. Best-effort. */
  close(): Promise<void>;
}

function nonBlank(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized ? normalized : fallback;
}

function resolveEnv(env: CoreServicesEnv = {}): Required<CoreServicesEnv> {
  return {
    neo4jUri: nonBlank(env.neo4jUri ?? process.env['NEO4J_URI'], 'bolt://localhost:7687'),
    neo4jUser: nonBlank(env.neo4jUser ?? process.env['NEO4J_USER'], 'neo4j'),
    neo4jPassword: env.neo4jPassword ?? process.env['NEO4J_PASSWORD'] ?? '',
    redisUrl: nonBlank(env.redisUrl ?? process.env['REDIS_URL'], 'redis://localhost:6379'),
    openaiKey: (env.openaiKey ?? process.env['OPENAI_API_KEY'] ?? '').trim(),
    exportPath: nonBlank(env.exportPath ?? readEnv('MEMBERRY_EXPORT_PATH'), defaultExportPath()),
  };
}

/**
 * Build a *disabled* embedding provider for when no OpenAI key is set.
 *
 * It still returns zero vectors so writes never crash, but `available: false`
 * tells every retrieval path to SKIP vector search entirely and rank on
 * deterministic lexical/fulltext signals instead. This is the difference
 * between "no semantic search" (correct) and "semantic search over noise"
 * (the old behaviour, which silently returned random results).
 */
function disabledEmbedding(): EmbeddingProvider {
  return {
    available: false,
    embed: async () => new Array(EMBEDDING_DIM).fill(0),
    embedBatch: async (texts: string[]) => texts.map(() => new Array(EMBEDDING_DIM).fill(0)),
  };
}

/**
 * Construct the core memory services from environment (or explicit overrides).
 * Does not connect-and-verify or run initSchema — see file header.
 */
export function createCoreServices(env: CoreServicesEnv = {}): CoreServices {
  const { neo4jUri, neo4jUser, neo4jPassword, redisUrl, openaiKey, exportPath } = resolveEnv(env);
  // Strict shadow configuration is validated before allocating clients so a
  // malformed opt-in cannot leak partially constructed Redis/Neo4j handles.
  const admissionShadowConfig = resolveAdmissionShadowConfig();
  // MEM-003 routing shadow staging, also resolved before any client allocation:
  // the routing seam lives inside the shadow attempt and cannot run without it,
  // and a malformed flag or threshold must not leak Redis/Neo4j handles.
  const admissionRoutingMode = resolveAdmissionRoutingModeV1();
  if (admissionRoutingMode === 'shadow' && !admissionShadowConfig.enabled) {
    throw new AdmissionRoutingModeError('prerequisite_unavailable');
  }
  const admissionRoutingConfig = admissionRoutingMode === 'shadow'
    ? resolveTierRoutingConfig()
    : undefined;
  // MEM-002 producer staging, resolved before any client allocation: the
  // producer's only seam is the routing continuation, so `live` requires the
  // routing shadow to already be staged.
  const admissionFeatureProducerMode = resolveAdmissionFeatureProducerModeV1();
  if (admissionFeatureProducerMode === 'live' && admissionRoutingMode !== 'shadow') {
    throw new AdmissionFeatureProducerModeError('prerequisite_unavailable');
  }

  const redis = createRedisClient(redisUrl);
  const driver = createNeo4jDriver(neo4jUri, neo4jUser, neo4jPassword);

  const cache = new ContextCache(redis);
  const embeddings = new EmbeddingCache(redis);
  const dedup = new DedupChecker(redis);
  const signals = new SignalStream(redis);
  const queue = new ConsolidationQueue(redis);
  const extractionQueue = new ExtractionQueue(redis);

  const episodic = new EpisodicStore(driver);
  const scopedQuery = new ScopedQuery(driver);
  const factStore = new FactStore(driver);

  // Read-through embedding cache: identical query strings (retrieval, code
  // search, intent classification) re-hit the OpenAI embeddings API every time
  // otherwise. The Redis `embeddings` EmbeddingCache (constructed above) is
  // wired in front of the RAW provider via CachingEmbeddingProvider, so all the
  // downstream services that receive this single shared instance (AMPService
  // here; CodeSearch + UnifiedAssembler in the MCP bootstrap) gain caching for
  // free. The cache is best-effort — a cache failure falls through to the inner
  // provider (see caching-embedding.ts). The disabled (no-key) provider returns
  // meaningless zero vectors and stays unwrapped so it is never cached and its
  // `available: false` degraded signal is preserved.
  const embedding: EmbeddingProvider = openaiKey
    ? new CachingEmbeddingProvider(new OpenAIEmbedding(openaiKey), embeddings)
    : disabledEmbedding();

  // Constructed after `embedding` so promoted/superseded semantics get a
  // content embedding at write time (otherwise they are write-only — invisible
  // to vector recall). Shared with the MCP bootstrap via CoreServices.
  const semanticStore = new SemanticStore(driver, embedding);

  // Per-task model overrides from env (MEMBERRY_MODEL_*); omitted keys fall back to DEFAULT_MODELS.
  const models: NonNullable<AMPConfig['models']> = {};
  const mExtraction = readEnv('MEMBERRY_MODEL_EXTRACTION');
  if (mExtraction) models.extraction = mExtraction;
  const mSynthesis = readEnv('MEMBERRY_MODEL_SYNTHESIS');
  if (mSynthesis) models.synthesis = mSynthesis;
  const mDream = readEnv('MEMBERRY_MODEL_DREAM');
  if (mDream) models.dream = mDream;

  // Protections parse loose (see config/bool-flag.ts): `=1` must not silently
  // leave the core writable or persist unredacted secrets.
  const readonlyMode = parseBoolFlag(readEnv('MEMBERRY_READONLY'), false);
  const redactOnIngest = parseBoolFlag(readEnv('MEMBERRY_REDACT_ON_INGEST'), false);
  // Keep the library-safe default review-first. Integrated deployments opt in
  // through compose/systemd; the ConsolidationEngine itself only auto-applies
  // corroborated promotions and positive reinforcement. Corrections,
  // contradictions, supersedes, and decay remain in the review queue.
  const autoApplyConsolidation = parseBoolFlag(readEnv('MEMBERRY_CONSOLIDATION_AUTO_APPLY'), false);
  const config: AMPConfig = {
    redis: { url: redisUrl },
    neo4j: { uri: neo4jUri, user: neo4jUser, password: neo4jPassword },
    embedding: { provider: 'openai', apiKey: openaiKey },
    cache: { defaultTTL: 300, contextTTL: 300, embeddingTTL: 86400 },
    consolidation: { autoApply: autoApplyConsolidation, signalThreshold: 3 },
    exportPath,
    readonly: readonlyMode,
    redactOnIngest,
    admissionShadow: admissionShadowConfig,
    ...(Object.keys(models).length > 0 ? { models } : {}),
  };

  const llm: LlmClient = openaiKey ? new OpenAiLlmClient(openaiKey, config.models ?? {}) : new NullLlmClient();
  const serialQueue = new KeyedSerialQueue();

  const redisBlockStore = new RedisBlockStore(redis);
  const neo4jBlockStore = new Neo4jBlockStore(driver);
  const cacheInvalidator = {
    invalidateByScope: async (scope: string, tenantId?: string): Promise<void> => {
      await cache.invalidateByScope(scope, tenantId);
    },
  };
  const memoryBlocks = new MemoryBlockService(redisBlockStore, neo4jBlockStore, cacheInvalidator, readonlyMode);
  const audit = new AuditLogStore(driver);
  const admissionShadow = new AdmissionShadowRuntime({
    ...admissionShadowConfig,
    ...(admissionShadowConfig.enabled ? { sink: new AdmissionObservationStore(driver) } : {}),
    ...(admissionRoutingConfig
      ? {
          routing: {
            config: admissionRoutingConfig,
            sink: new AdmissionRoutingRecommendationStore(driver),
            ...(admissionFeatureProducerMode === 'live'
              ? { produceEnvelope: produceAdmissionFeatureEnvelopeV2 }
              : {}),
          },
        }
      : {}),
  });

  const ampService = new AMPService(
    { cache, embeddings, dedup, signals, queue, extraction: extractionQueue },
    { episodic, query: scopedQuery, fact: factStore, semantic: semanticStore },
    embedding,
    config,
    memoryBlocks,
    audit,
    admissionShadowConfig.enabled ? admissionShadow : undefined,
  );

  return {
    driver,
    redis,
    cache,
    embeddings,
    dedup,
    signals,
    queue,
    extractionQueue,
    episodic,
    semantic: semanticStore,
    scopedQuery,
    factStore,
    audit,
    embedding,
    llm,
    serialQueue,
    config,
    ampService,
    memoryBlocks,
    admissionShadow,
    async close() {
      try { await admissionShadow.stopAndDrain(); } catch { /* bounded and best-effort */ }
      try { await redis.quit(); } catch { /* already closed */ }
      try { await driver.close(); } catch { /* already closed */ }
    },
  };
}

/**
 * Build the background "dream" engine from constructed core services. The graph
 * layer scopes entities by the project Entity's CONTAINS tree; facts/blocks/LLM
 * and the per-entity serializer are taken from the core kit. See dream.ts.
 */
export function buildDreamEngine(core: CoreServices): DreamEngine {
  const graph: DreamGraphLayer = {
    async entitiesInScope(scopeTag: string, limit: number) {
      const projectName = scopeTag.replace(/^project:/i, '');
      const session = core.driver.session();
      try {
        const res = await session.run(
          `MATCH (project:Entity) WHERE toLower(project.name) = toLower($projectName)
           MATCH (project)-[:CONTAINS*0..3]->(e:Entity)
           RETURN DISTINCT e.name AS name, e.id AS entity_id
           LIMIT toInteger($limit)`,
          { projectName, limit },
        );
        return res.records.map((r) => ({
          name: String(r.get('name')),
          entity_id: String(r.get('entity_id')),
        }));
      } finally {
        await session.close();
      }
    },
  };

  const blocks: DreamBlockLayer = {
    read: (scope, name) => core.memoryBlocks.read(scope, name),
    rewrite: (scope, name, content) => core.memoryBlocks.rewrite(scope, name, content),
  };

  return new DreamEngine({
    graph,
    fact: core.factStore,
    llm: core.llm,
    blocks,
    config: core.config,
    serialize: (key, fn) => core.serialQueue.run(key, fn),
    // Cross-process scope lock (same DistributedLock the ConsolidationEngine uses),
    // so dream (CLI/timer) and consolidation (MCP) can't mutate one scope at once.
    lock: new DistributedLock(core.redis),
  });
}

/**
 * Build the durable fact-extraction consumer from constructed core services.
 * Long-lived: the MCP server starts it and stops it on shutdown. It drains the
 * ExtractionQueue and runs each job through AMPService.processExtraction.
 */
export function buildExtractionConsumer(core: CoreServices): ExtractionConsumer {
  return new ExtractionConsumer(
    core.extractionQueue,
    (content, episodeId, tenantId) => core.ampService.processExtraction(content, episodeId, tenantId),
  );
}
