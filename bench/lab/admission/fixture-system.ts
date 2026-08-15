import { parseAdmissionObservationV1, type AdmissionObservationV1 } from '../../../packages/core/src/admission.js';
import { AdmissionShadowRuntime, type AdmissionObservationSink } from '../../../packages/core/src/admission-shadow.js';
import { AMPService, type Neo4jLayer, type RedisLayer } from '../../../packages/core/src/service.js';
import type { AMPConfig, AuditSink, EpisodeInput, EpisodicNode } from '../../../packages/core/src/types.js';
import {
  ADMISSION_STRUCTURAL_CONTRACT_VERSION,
  ADMISSION_STRUCTURAL_FIDELITY,
  validateAdmissionStructuralInput,
  type AdmissionDeliveryOutcome,
  type AdmissionStructuralCapability,
  type AdmissionStructuralObservationRecord,
  type AdmissionStructuralOperationExecution,
  type AdmissionStructuralScenarioInput,
  type AdmissionStructuralSystem,
  type AdmissionStructuralSystemExecution,
} from '../contracts/admission.js';

const ALL_CAPABILITIES: readonly AdmissionStructuralCapability[] = [
  'baseline-effects', 'shadow-observation', 'fault-injection', 'late-settlement',
  'tenant-isolation', 'pre-redaction', 'default-off',
];
export const ADMISSION_STRUCTURAL_FIXED_CLOCK = '2026-08-14T18:00:00.000Z';
export const ADMISSION_STRUCTURAL_SEED = 1001;

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function cloneEpisodeInput(value: AdmissionStructuralScenarioInput['operations'][number]['input']): EpisodeInput {
  return {
    session_id: value.session_id,
    agent_id: value.agent_id,
    task: value.task,
    content: value.content,
    tenantId: value.tenantId,
    ...(value.tags ? { tags: [...value.tags] } : {}),
    ...(value.scope !== undefined ? { scope: value.scope } : {}),
    ...(value.memory_type !== undefined ? { memory_type: value.memory_type } : {}),
    ...(value.outcome !== undefined ? { outcome: value.outcome } : {}),
    ...(value.signals ? { signals: value.signals.map((signal) => ({ ...signal })) } : {}),
    ...(value.entities ? { entities: [...value.entities] } : {}),
    ...(value.model_id !== undefined ? { model_id: value.model_id } : {}),
  };
}

function normalizeTrace(value: unknown, episodeIds: ReadonlySet<string>): unknown {
  if (typeof value === 'string') {
    if (episodeIds.has(value)) return '<episode>';
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return '<time>';
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => normalizeTrace(entry, episodeIds));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, child]) => [key, normalizeTrace(child, episodeIds)]));
  }
  return value;
}

function config(input: AdmissionStructuralScenarioInput): AMPConfig {
  return {
    redis: { url: 'redis://fixture' },
    neo4j: { uri: 'bolt://fixture', user: 'neo4j', password: '' },
    embedding: { provider: 'openai', apiKey: '' },
    cache: { defaultTTL: 300, contextTTL: 300, embeddingTTL: 86400 },
    consolidation: { autoApply: false, signalThreshold: 3 },
    exportPath: '/tmp/memberry-admission-lab',
    redactOnIngest: input.config.redactOnIngest,
    admissionShadow: { enabled: input.config.shadowEnabled, timeoutMs: input.config.timeoutMs },
  };
}

class FixtureObservationSink implements AdmissionObservationSink {
  readonly records: Array<Omit<AdmissionStructuralObservationRecord, 'operationId'>> = [];
  readonly pending = new Map<string, Deferred>();
  currentOperation = '';

  constructor(private readonly faults: Readonly<Record<string, 'reject' | 'commit-then-late-success'>>) {}

  async persist(scope: AdmissionStructuralObservationRecord['scope'], observation: AdmissionObservationV1): Promise<AdmissionObservationV1> {
    const parsed = parseAdmissionObservationV1(observation);
    const mode = this.faults[this.currentOperation];
    if (mode === 'reject') throw new Error('admission_fixture:sidecar_rejected');
    this.records.push({ scope: Object.freeze({ ...scope }), observation: parsed });
    if (mode === 'commit-then-late-success') {
      const wait = deferred();
      this.pending.set(this.currentOperation, wait);
      await wait.promise;
    }
    return parsed;
  }
}

interface FixtureLayers {
  redis: RedisLayer;
  neo4j: Neo4jLayer;
  audit: AuditSink;
  trace: unknown[];
  committed: EpisodicNode[];
  currentOperation: { value: string };
}

function fixtureLayers(input: AdmissionStructuralScenarioInput): FixtureLayers {
  const trace: unknown[] = [];
  const committed: EpisodicNode[] = [];
  const seen = new Set<string>();
  const currentOperation = { value: '' };
  const baselineFailures = new Set(input.faults?.baseline ?? []);

  const redis: RedisLayer = {
    cache: {
      get: async () => null,
      set: async () => undefined,
      invalidateByScope: async (scope, tenantId) => { trace.push({ kind: 'cache-scope', scope, tenantId }); return 0; },
      invalidateByNodeId: async (id, tenantId) => { trace.push({ kind: 'cache-node', id, tenantId }); return 0; },
    },
    embeddings: { get: async () => null, set: async () => undefined },
    dedup: {
      isDuplicate: async () => false,
      markSeen: async () => undefined,
      checkAndMark: async (agentId, hash) => {
        trace.push({ kind: 'dedup-check', agentId, hash });
        const key = `${agentId}\u0000${hash}`;
        if (seen.has(key)) return true;
        seen.add(key);
        return false;
      },
      unmark: async (agentId, hash) => {
        trace.push({ kind: 'dedup-unmark', agentId, hash });
        seen.delete(`${agentId}\u0000${hash}`);
      },
    },
    signals: {
      publish: async (signal) => { trace.push({ kind: 'signal-publish', signal }); return 'fixture-signal'; },
    },
    queue: {
      incrementScore: async (id, increment) => { trace.push({ kind: 'queue-score', id, increment }); return 1; },
    },
  };

  const neo4j: Neo4jLayer = {
    episodic: {
      create: async () => { throw new Error('admission_fixture:unexpected_create_path'); },
      createWithLinks: async (node, links) => {
        if (baselineFailures.has(currentOperation.value)) throw new Error('admission_fixture:baseline_failed');
        committed.push(structuredClone(node));
        trace.push({ kind: 'episode-create', node, links });
        return node.id;
      },
      linkToAgent: async () => undefined,
      linkToEntity: async () => undefined,
      linkToModel: async () => undefined,
      linkSignal: async (id, signal, tenantId) => { trace.push({ kind: 'signal-link', id, signal, tenantId }); },
    },
    query: { byScope: async () => [], byVector: async () => [] },
    semantic: {
      existingIds: async (ids) => {
        trace.push({ kind: 'semantic-existing', ids });
        return ids.filter((id) => id.startsWith('semantic-valid-'));
      },
    },
  };
  const audit: AuditSink = {
    append: async (entry) => { trace.push({ kind: 'audit', entry }); },
  };
  return { redis, neo4j, audit, trace, committed, currentOperation };
}

function deliveryDelta(before: Record<string, number | boolean | string | null>, after: Record<string, number | boolean | string | null>): AdmissionDeliveryOutcome {
  if (Number(after.timedOut) > Number(before.timedOut)) return 'timed-out';
  if (Number(after.appendFailures) > Number(before.appendFailures)) return 'failed';
  if (Number(after.appended) > Number(before.appended)) return 'stored';
  return 'not-attempted';
}

export class ProductionCoreFixtureSystem implements AdmissionStructuralSystem {
  readonly executionMode = 'fixture' as const;
  readonly fidelity = ADMISSION_STRUCTURAL_FIDELITY;
  readonly contractVersion = ADMISSION_STRUCTURAL_CONTRACT_VERSION;
  readonly capabilities = new Set(ALL_CAPABILITIES);

  constructor(
    readonly id: 'memberry-admission-baseline-fixture-v1' | 'memberry-admission-shadow-fixture-v1',
    private readonly arm: 'control' | 'candidate',
  ) {}

  async execute(input: AdmissionStructuralScenarioInput): Promise<AdmissionStructuralSystemExecution> {
    if (this.executionMode !== 'fixture' || this.fidelity !== ADMISSION_STRUCTURAL_FIDELITY) {
      return this.empty(input, 'unsupported', 'wrong-fidelity');
    }
    const validation = validateAdmissionStructuralInput(input);
    if (validation.length) return this.empty(input, 'failed', undefined, 'invalid-input');
    if (input.requiredCapabilities.some((capability) => !this.capabilities.has(capability))) {
      return this.empty(input, 'unsupported', 'missing-capability');
    }

    const layers = fixtureLayers(input);
    const sink = new FixtureObservationSink(input.faults?.sidecar ?? {});
    const enabled = this.arm === 'candidate' && input.config.shadowEnabled;
    const runtime = new AdmissionShadowRuntime({
      enabled,
      timeoutMs: input.config.timeoutMs,
      ...(enabled ? { sink } : {}),
      clock: { now: () => new Date(ADMISSION_STRUCTURAL_FIXED_CLOCK) },
    });
    const embeddingFailures = new Set(input.faults?.embedding ?? []);
    const service = new AMPService(
      layers.redis,
      layers.neo4j,
      {
        embed: async (content) => {
          layers.trace.push({ kind: 'embedding', content });
          if (embeddingFailures.has(layers.currentOperation.value)) throw new Error('admission_fixture:embedding_failed');
          return [0.125, 0.25, 0.5];
        },
        embedBatch: async () => [],
      },
      config({ ...input, config: { ...input.config, shadowEnabled: enabled } }),
      undefined,
      layers.audit,
      enabled ? runtime : undefined,
    );
    const operations: AdmissionStructuralOperationExecution[] = [];
    const readsByOperation: Array<{ kind: 'input-reads'; operationId: string; keys: string[] }> = [];
    const episodeIds = new Set<string>();

    for (const operation of input.operations) {
      layers.currentOperation.value = operation.id;
      sink.currentOperation = operation.id;
      const reads: string[] = [];
      const episodeInput = cloneEpisodeInput(operation.input);
      const observedInput = new Proxy(episodeInput, {
        get(target, key, receiver) {
          reads.push(String(key));
          return Reflect.get(target, key, receiver);
        },
      });
      const traceOffset = layers.trace.length;
      const before = runtime.snapshot() as unknown as Record<string, number | boolean | string | null>;
      let baselineOutcome: AdmissionStructuralOperationExecution['baselineOutcome'];
      let episodeId: string | undefined;
      // Production deliberately unrefs its bounded timeout. The standalone
      // fixture runner owns process liveness while awaiting that real path so a
      // required timeout case cannot become a silent zero-work CLI exit.
      const runnerLiveness = setInterval(() => undefined, 1_000);
      try {
        const result = await service.store(observedInput);
        baselineOutcome = result.duplicate ? 'duplicate' : 'accepted';
        if (result.id) { episodeId = result.id; episodeIds.add(result.id); }
      } catch {
        const dedupTouched = layers.trace.slice(traceOffset).some((entry) => {
          const record = entry as { kind?: string };
          return record.kind === 'dedup-check';
        });
        baselineOutcome = dedupTouched ? 'failed' : 'rejected';
      } finally {
        clearInterval(runnerLiveness);
      }
      const after = runtime.snapshot() as unknown as Record<string, number | boolean | string | null>;
      operations.push({
        operationId: operation.id,
        baselineOutcome,
        delivery: deliveryDelta(before, after),
        ...(episodeId ? { episodeId } : {}),
      });
      readsByOperation.push({ kind: 'input-reads', operationId: operation.id, keys: reads });
      const pending = sink.pending.get(operation.id);
      if (pending) {
        pending.resolve();
        await pending.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }

    const operationByEpisode = new Map(operations.filter((operation) => operation.episodeId)
      .map((operation) => [operation.episodeId!, operation.operationId]));
    const observations: AdmissionStructuralObservationRecord[] = sink.records.map((record) => ({
      scope: record.scope,
      // Strip the module-local validation brand before crossing into the
      // independently loaded scorer. The scorer re-parses this content-free
      // data with its own production parser instance.
      observation: structuredClone(record.observation),
      operationId: operationByEpisode.get(record.scope.episodeId) ?? 'unmapped',
    }));
    const runtimeSnapshot = runtime.snapshot() as unknown as Record<string, number | boolean | string | null>;
    return {
      scenarioId: input.id,
      split: input.split,
      systemId: this.id,
      executionMode: this.executionMode,
      fidelity: this.fidelity,
      outcome: 'scored',
      operations,
      baselineTrace: normalizeTrace([...readsByOperation, ...layers.trace], episodeIds) as readonly unknown[],
      observations,
      committedEpisodeCount: layers.committed.length,
      runtime: runtimeSnapshot,
    };
  }

  private empty(
    input: AdmissionStructuralScenarioInput,
    outcome: 'unsupported' | 'failed',
    unsupportedCode?: 'missing-capability' | 'wrong-fidelity',
    failureCode?: 'invalid-input' | 'system-failure',
  ): AdmissionStructuralSystemExecution {
    return {
      scenarioId: input.id,
      split: input.split,
      systemId: this.id,
      executionMode: this.executionMode,
      fidelity: this.fidelity,
      outcome,
      ...(unsupportedCode ? { unsupportedCode } : {}),
      ...(failureCode ? { failureCode } : {}),
      operations: [], baselineTrace: [], observations: [], committedEpisodeCount: 0, runtime: {},
    };
  }
}
