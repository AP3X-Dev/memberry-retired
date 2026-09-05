// packages/core/src/consolidation.ts
import { nanoid } from 'nanoid';
import { createHash } from 'node:crypto';
import type {
  ConsolidationProposal,
  StreamSignal,
  SemanticNode,
  EpisodicNode,
  AMPConfig,
  FactNode,
} from './types.js';
import { SIGNAL_WEIGHTS, DEFAULT_TENANT } from './types.js';
import { extractFacts } from './extract.js';
import { semanticDedupeKey } from './bootstrap-graph.js';
import { readEnv } from './config/settings.js';
import type { LlmClient } from './llm.js';
import { clusterHasIndependentCorroborationV1 } from './evidence-diversity.js';
import { attachAdvisorV1 } from './advisor.js';
import {
  advancePromotionCursorV1,
  parsePromotionCursorV1,
  planPromotionFetchV1,
  promotionCursorRedisKeyV1,
  serializePromotionCursorV1,
} from './promotion-scheduler.js';

// ─── Runtime validators ──────────────────────────────────────────────────────

const VALID_DECAY_CLASSES = new Set(['volatile', 'stable', 'permanent']);
const VALID_MEMORY_TYPES = new Set([
  'decision',
  'pattern',
  'convention',
  'architecture',
  'preference',
  'fact',
  'general',
]);
/** Explicitly approved decisions are already authorized by the writer. */
const APPROVED_DECISION_CONFIDENCE = 0.9;
const CONSOLIDATION_LOCK_TTL_SECONDS = 30;
const CONSOLIDATION_LOCK_HEARTBEAT_MS = 10_000;

export function stableId(prefix: string, parts: string[]): string {
  const digest = createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 24);
  return `${prefix}-${digest}`;
}

function normalizedScope(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Fail closed at the global-stream/project boundary. New deliveries carry
 * source scope + tenant; legacy deliveries are treated as DEFAULT_TENANT and
 * are accepted for a project run only when the target has structural scope.
 */
function signalMatchesTarget(
  signal: StreamSignal,
  target: SemanticNode,
  runScope: string,
): boolean {
  const requested = normalizedScope(runScope);
  const isGlobal = requested === '' || requested === 'global';
  const signalScope = signal.scope ? normalizedScope(signal.scope) : undefined;
  const targetScope = target.scope ? normalizedScope(target.scope) : undefined;
  const targetProjectTags = (target.tags ?? [])
    .filter((tag) => /^project:/i.test(tag))
    .map(normalizedScope);

  // Even an unscoped/global maintenance run may not use a source-project
  // signal to mutate a target structurally owned by another project.
  if (signalScope && targetScope && signalScope !== targetScope) return false;
  if (
    signalScope?.startsWith('project:') &&
    targetProjectTags.length > 0 &&
    !targetProjectTags.includes(signalScope)
  ) {
    return false;
  }

  if (!isGlobal) {
    if (signalScope && signalScope !== requested) return false;
    if (targetScope && targetScope !== requested) return false;
    if (requested.startsWith('project:')) {
      // A project run must be supported by the target itself, not merely by an
      // emitter-supplied scope that could point at another project's node.
      if (targetScope !== requested && !targetProjectTags.includes(requested)) return false;
    }
  }

  const sourceTenant = signal.tenant_id?.trim() || DEFAULT_TENANT;
  const targetTenant = target.tenant_id?.trim() || DEFAULT_TENANT;
  return sourceTenant === targetTenant;
}

/**
 * OPT-31: an existing active fact whose confidence is at/above this threshold is
 * treated as ESTABLISHED and is protected from auto-invalidation by a *lower*-
 * confidence, extraction-derived contradiction during (auto-applied)
 * consolidation. Such a contender is instead recorded as a `tentative`
 * superseding candidate — the established fact stays active — so untrusted
 * content can't silently overwrite an authoritative fact; it must be
 * corroborated (or human-approved) to win. Override via
 * MEMBERRY_FACT_PROTECT_CONFIDENCE (clamped to [0,1]; default 0.75).
 */
const DEFAULT_FACT_PROTECT_CONFIDENCE = 0.75;
function factProtectConfidence(): number {
  const raw = readEnv('MEMBERRY_FACT_PROTECT_CONFIDENCE');
  if (raw === undefined) return DEFAULT_FACT_PROTECT_CONFIDENCE;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_FACT_PROTECT_CONFIDENCE;
  return Math.min(1, Math.max(0, parsed));
}

/**
 * Validates that a Record<string, unknown> (e.g. from Redis) has all required
 * SemanticNode fields with correct types.  Returns the validated node or throws.
 */
function parseSemanticNode(raw: Record<string, unknown>, label: string): SemanticNode {
  if (typeof raw.id !== 'string' || raw.id === '') {
    throw new Error(`${label}: missing or invalid "id" (expected non-empty string)`);
  }
  if (typeof raw.content !== 'string') {
    throw new Error(`${label}: missing or invalid "content" (expected string)`);
  }
  if (typeof raw.confidence !== 'number' || !Number.isFinite(raw.confidence)) {
    throw new Error(`${label}: missing or invalid "confidence" (expected finite number)`);
  }
  if (typeof raw.signal_count !== 'number' || !Number.isFinite(raw.signal_count)) {
    throw new Error(`${label}: missing or invalid "signal_count" (expected finite number)`);
  }
  if (typeof raw.created_at !== 'string') {
    throw new Error(`${label}: missing or invalid "created_at" (expected string)`);
  }
  if (typeof raw.updated_at !== 'string') {
    throw new Error(`${label}: missing or invalid "updated_at" (expected string)`);
  }
  if (typeof raw.decay_class !== 'string' || !VALID_DECAY_CLASSES.has(raw.decay_class)) {
    throw new Error(`${label}: missing or invalid "decay_class" (expected 'volatile' | 'stable' | 'permanent')`);
  }
  if (!Array.isArray(raw.tags) || !raw.tags.every((t: unknown) => typeof t === 'string')) {
    throw new Error(`${label}: missing or invalid "tags" (expected string[])`);
  }

  return {
    id: raw.id,
    content: raw.content,
    confidence: raw.confidence,
    signal_count: raw.signal_count,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
    decay_class: raw.decay_class as SemanticNode['decay_class'],
    tags: raw.tags as string[],
    ...(typeof raw.memory_type === 'string' && VALID_MEMORY_TYPES.has(raw.memory_type)
      ? { memory_type: raw.memory_type as SemanticNode['memory_type'] }
      : {}),
    ...(typeof raw.tenant_id === 'string' && raw.tenant_id !== '' ? { tenant_id: raw.tenant_id } : {}),
    ...(Array.isArray(raw.embedding) ? { embedding: raw.embedding as number[] } : {}),
    ...(typeof raw.valid_at === 'string' ? { valid_at: raw.valid_at } : {}),
    ...(typeof raw.invalid_at === 'string' ? { invalid_at: raw.invalid_at } : {}),
  };
}

/**
 * Validates a partial SemanticNode record (the "after" side of a proposal).
 * Only present keys are type-checked; the result is Partial<SemanticNode>.
 */
function parsePartialSemanticNode(raw: Record<string, unknown>, label: string): Partial<SemanticNode> {
  const result: Partial<SemanticNode> = {};

  if ('id' in raw) {
    if (typeof raw.id !== 'string' || raw.id === '') throw new Error(`${label}: invalid "id"`);
    result.id = raw.id;
  }
  if ('content' in raw) {
    if (typeof raw.content !== 'string') throw new Error(`${label}: invalid "content"`);
    result.content = raw.content;
  }
  if ('confidence' in raw) {
    if (typeof raw.confidence !== 'number' || !Number.isFinite(raw.confidence))
      throw new Error(`${label}: invalid "confidence"`);
    result.confidence = raw.confidence;
  }
  if ('signal_count' in raw) {
    if (typeof raw.signal_count !== 'number' || !Number.isFinite(raw.signal_count))
      throw new Error(`${label}: invalid "signal_count"`);
    result.signal_count = raw.signal_count;
  }
  if ('created_at' in raw) {
    if (typeof raw.created_at !== 'string') throw new Error(`${label}: invalid "created_at"`);
    result.created_at = raw.created_at;
  }
  if ('updated_at' in raw) {
    if (typeof raw.updated_at !== 'string') throw new Error(`${label}: invalid "updated_at"`);
    result.updated_at = raw.updated_at;
  }
  if ('decay_class' in raw) {
    if (typeof raw.decay_class !== 'string' || !VALID_DECAY_CLASSES.has(raw.decay_class))
      throw new Error(`${label}: invalid "decay_class"`);
    result.decay_class = raw.decay_class as SemanticNode['decay_class'];
  }
  if ('tags' in raw) {
    if (!Array.isArray(raw.tags) || !raw.tags.every((t: unknown) => typeof t === 'string'))
      throw new Error(`${label}: invalid "tags"`);
    result.tags = raw.tags as string[];
  }
  if ('memory_type' in raw) {
    if (typeof raw.memory_type !== 'string' || !VALID_MEMORY_TYPES.has(raw.memory_type))
      throw new Error(`${label}: invalid "memory_type"`);
    result.memory_type = raw.memory_type as SemanticNode['memory_type'];
  }
  if ('tenant_id' in raw) {
    if (typeof raw.tenant_id !== 'string') throw new Error(`${label}: invalid "tenant_id"`);
    result.tenant_id = raw.tenant_id;
  }
  if ('valid_at' in raw) {
    if (typeof raw.valid_at !== 'string') throw new Error(`${label}: invalid "valid_at"`);
    result.valid_at = raw.valid_at;
  }
  if ('invalid_at' in raw) {
    if (typeof raw.invalid_at !== 'string') throw new Error(`${label}: invalid "invalid_at"`);
    result.invalid_at = raw.invalid_at;
  }

  return result;
}

// ─── Dependency interfaces ────────────────────────────────────────────────────

export interface ConsolidationRedisLayer {
  lock: {
    acquire(scope: string, holder: string, ttlSeconds?: number): Promise<boolean>;
    renew?(scope: string, holder: string, ttlSeconds?: number): Promise<boolean>;
    release(scope: string, holder: string): Promise<boolean>;
  };
  signals: {
    consume(
      group: string,
      consumer: string,
      count: number,
      startId?: string,
    ): Promise<Array<StreamSignal & { stream_id?: string }>>;
    /** Optional for backward compatibility with non-Redis test adapters. */
    ack?(group: string, messageIds: string[]): Promise<number>;
  };
  queue: {
    /** Legacy destructive API retained for adapter compatibility; consolidation
     * no longer uses untyped queue scores to choose a semantic mutation. */
    popHighest?(): Promise<{ member: string; score: number } | null>;
    /** Remove bookkeeping for a target only after its typed signals are durable. */
    remove?(member: string): Promise<number>;
  };
  proposals: {
    save(proposal: ConsolidationProposal): Promise<void>;
    get(id: string): Promise<ConsolidationProposal | null>;
    listPending(): Promise<string[]>;
    remove(id: string): Promise<void>;
  };
  cache: {
    invalidateByNodeId(nodeId: string): Promise<number>;
  };
  /** MEM-005: plain string KV used only to persist the promotion keyset cursor.
   *  All three are optional — a layer without them (every existing adapter and
   *  test double) keeps today's head-only promotion fetch. */
  get?(key: string): Promise<string | null>;
  set?(key: string, value: string): Promise<void>;
  del?(key: string): Promise<void>;
}

export interface ConsolidationFactLayer {
  create(fact: import('./types.js').FactNode): Promise<string>;
  findBySubjectPredicate(
    subject: string,
    predicate: string,
    tenantId?: string,
    opts?: { includeTentative?: boolean },
  ): Promise<import('./types.js').FactNode[]>;
  invalidate(id: string, invalidAt: string, supersededById?: string): Promise<void>;
  dispute(id: string): Promise<void>;
}

export interface ConsolidationNeo4jLayer {
  semantic: {
    getById(id: string): Promise<SemanticNode | null>;
    /** OPT-54: batch-fetch many Semantic nodes in one round-trip. Optional —
     *  _generateProposals falls back to per-id getById when absent. Returns one
     *  entry per FOUND id (missing ids omitted). */
    getByIds?(ids: string[]): Promise<SemanticNode[]>;
    updateConfidence(id: string, confidence: number, applicationKey?: string): Promise<void>;
    /** MEM-006H reclass apply: sets ONLY decay_class through the shared
     *  applied_consolidation_keys ledger (never updated_at — the decay
     *  anchor). Optional for backward compatibility — layers without it
     *  simply cannot apply reclass proposals. */
    updateDecayClass?(
      id: string,
      decayClass: 'volatile' | 'stable' | 'permanent',
      applicationKey?: string,
    ): Promise<void>;
    supersede(oldId: string, newNode: SemanticNode): Promise<string>;
    /**
     * Promote an episodic memory into a new Semantic node.
     * `tenantId` (optional, defaults to the node's tenant_id, then DEFAULT_TENANT)
     * stamps the new Semantic so a non-default tenant can retrieve its own
     * consolidated knowledge. Optional for backward compatibility — layers that
     * don't implement it simply have no promote path.
     */
    promoteFromEpisodic?(
      episodicIds: string[],
      newNode: SemanticNode,
      tenantId?: string,
      /** Content-derived `dedupe_key` set ON CREATE; a collision links onto the existing Semantic. */
      dedupeKey?: string,
    ): Promise<string>;
  };
  /**
   * Optional episodic accessor. When present, the engine reads source episodes'
   * `tenant_id` to determine which tenant a promoted Semantic node belongs to.
   * Optional for backward compatibility — without it, promoted semantics fall
   * back to DEFAULT_TENANT.
   */
  episodic?: {
    getById(id: string): Promise<EpisodicNode | null>;
    /**
     * Episodes eligible for promotion: in-scope, embedded, and not already the
     * source of a PROMOTED_FROM edge. Optional — without it the engine emits no
     * promote proposals and behaves exactly as the signal-only engine did.
     */
    findPromotable?(
      scope: string | undefined,
      limit: number,
      tenantId?: string,
    ): Promise<EpisodicNode[]>;
    /** MEM-005: keyset continuation of the findPromotable order, resuming
     *  strictly after `after`. Optional — without it the engine performs
     *  exactly one full-limit findPromotable fetch, as it always has. */
    findPromotableKeyset?(
      scope: string | undefined,
      limit: number,
      tenantId: string | undefined,
      after: { classTier: number; createdAt: string; id: string },
    ): Promise<EpisodicNode[]>;
    /** OPT-45: batched tenant_id projection for many episodes in ONE query
     *  (optional — _deriveTenantFromEpisodes falls back to per-id getById when
     *  absent). One entry per FOUND episode (its tenant_id, null when unset);
     *  missing episodes are omitted, matching the per-id loop's "doesn't
     *  contribute" behavior. */
    getTenantsByIds?(ids: string[]): Promise<Array<string | null>>;
  };
  fact?: ConsolidationFactLayer;
}

// ─── Result types ─────────────────────────────────────────────────────────────

/** Batch outcome when a source-episode tenant read throws (C5). */
const TENANT_UNRESOLVED = 'tenant_unresolved';

export interface RunResult {
  skipped: boolean;
  reason?: string;
  proposals: ConsolidationProposal[];
  applied: string[];
  /** C5: promote batches skipped because the source tenant could not be read. */
  skipped_tenant_unresolved?: number;
}

// ─── ConsolidationEngine ──────────────────────────────────────────────────────

export class ConsolidationEngine {
  private readonly lockHolder: string;

  /**
   * @param llm Optional chat client used to synthesize a clustered set of
   *   episodes into one durable Semantic claim. Without it (or with a
   *   NullLlmClient), the promote path is inert and the engine falls back to
   *   signal-driven proposals only.
   */
  constructor(
    private redis: ConsolidationRedisLayer,
    private neo4j: ConsolidationNeo4jLayer,
    private config: AMPConfig,
    private llm?: LlmClient,
    private tenantId?: string,
  ) {
    this.lockHolder = `consolidation-engine-${nanoid(8)}`;
  }

  // ─── run ──────────────────────────────────────────────────────────────────

  async run(scope: string): Promise<RunResult> {
    // 1. Acquire distributed lock
    const acquired = await this.redis.lock.acquire(
      scope,
      this.lockHolder,
      CONSOLIDATION_LOCK_TTL_SECONDS,
    );
    if (!acquired) {
      return { skipped: true, reason: 'lock_held', proposals: [], applied: [] };
    }

    let leaseFailure: Error | null = null;
    let heartbeatWork: Promise<void> = Promise.resolve();
    const renewLease = async (): Promise<void> => {
      if (!this.redis.lock.renew || leaseFailure) return;
      try {
        const renewed = await this.redis.lock.renew(
          scope,
          this.lockHolder,
          CONSOLIDATION_LOCK_TTL_SECONDS,
        );
        if (!renewed) leaseFailure = new Error(`Lost consolidation lock for scope ${scope}`);
      } catch (err: unknown) {
        leaseFailure = err instanceof Error ? err : new Error(String(err));
      }
    };
    const heartbeat = this.redis.lock.renew
      ? setInterval(() => {
          heartbeatWork = heartbeatWork.then(renewLease);
        }, CONSOLIDATION_LOCK_HEARTBEAT_MS)
      : null;
    heartbeat?.unref?.();
    const assertLease = (): void => {
      if (leaseFailure) throw leaseFailure;
    };

    try {
      // 2. Consume signals from stream
      const signals = await this.redis.signals.consume(
        'consolidation',
        this.lockHolder,
        100,
      );

      // 3. Generate proposals from typed signal clusters, then from unpromoted
      // episodes. The two are independent: signals adjust EXISTING semantics,
      // promotion mints new ones. Only the signal path existed before, so a
      // graph with no semantics to signal against could never grow any.
      //
      // The legacy sorted-set queue stores only target + numeric score. It does
      // not retain whether the score came from reinforcement, correction, or
      // contradiction, so consuming it as a queue-only decay instruction can
      // invert reinforcement into decay. Typed stream deliveries are now the
      // source of truth; their pending entries safely accumulate across runs.
      const signalBatch = await this._generateProposals(scope, signals);
      const signalProposals = signalBatch.proposals;
      const proposals = [...signalProposals];
      proposals.push(...(await this._generatePromoteProposals(scope)));
      assertLease();

      // 4. Apply or store for review
      const applied: string[] = [];
      const counters = { tenant_unresolved: 0 };
      const durableSignalTargets = new Set<string>();
      const durableSignalProposalIds = new Set<string>();
      const signalProposalIds = new Set(signalProposals.map((proposal) => proposal.id));
      for (const proposal of proposals) {
        assertLease();
        const after = proposal.after as { confidence?: number; memory_type?: string };
        const promoteConfidence = after.confidence ?? 0;
        // An explicitly classified, approved decision is generated only by the
        // dedicated one-source path below. It is safe to apply even when broad
        // autoApply is disabled: `outcome: approved` is the captured approval,
        // while rejected/revised/implicit episodes never enter that path.
        const approvedDecision =
          proposal.type === 'promote' &&
          after.memory_type === 'decision' &&
          promoteConfidence >= 0.8 &&
          proposal.affected_ids.length === 1;
        // Corroborated promotion and positive reinforcement are safe to
        // automate only when broad autoApply is enabled. Contradiction,
        // correction, supersede, and decay remain reviewable.
        const safeConfiguredAutoApply = this.config.consolidation.autoApply && (
          proposal.type === 'reinforce' ||
          (proposal.type === 'promote' && promoteConfidence >= 0.7)
        );
        if (approvedDecision || safeConfiguredAutoApply) {
          const ok = await this._applyProposal(proposal, counters);
          if (ok) {
            applied.push(proposal.id);
            if (signalProposalIds.has(proposal.id)) {
              durableSignalProposalIds.add(proposal.id);
              for (const id of proposal.affected_ids) durableSignalTargets.add(id);
            }
          }
        } else {
          await this.redis.proposals.save(attachAdvisorV1(proposal));
          if (signalProposalIds.has(proposal.id)) {
            durableSignalProposalIds.add(proposal.id);
            for (const id of proposal.affected_ids) durableSignalTargets.add(id);
          }
        }
      }

      // ACK only signal deliveries whose typed cluster produced durable work.
      // Below-threshold deliveries remain pending and are re-read next run; a
      // crash before proposal save/application likewise leaves them available
      // for redelivery. Queue scores are advisory bookkeeping and are cleared
      // only for the same durably handled targets.
      if (this.redis.signals.ack && durableSignalTargets.size > 0) {
        const messageIds = [...durableSignalProposalIds]
          .flatMap((proposalId) => signalBatch.messageIdsByProposal.get(proposalId) ?? []);
        if (messageIds.length > 0) {
          await this.redis.signals.ack('consolidation', [...new Set(messageIds)]);
          if (this.redis.queue.remove) {
            for (const targetId of durableSignalTargets) {
              await this.redis.queue.remove(targetId);
            }
          }
        }
      }

      return { skipped: false, proposals, applied, skipped_tenant_unresolved: counters.tenant_unresolved };
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      await heartbeatWork;
      await this.redis.lock.release(scope, this.lockHolder);
    }
  }

  // ─── review ───────────────────────────────────────────────────────────────

  async review(proposalId: string): Promise<Record<string, unknown>> {
    const proposal = await this.redis.proposals.get(proposalId);
    if (!proposal) throw new Error(`Proposal ${proposalId} not found`);
    return proposal as unknown as Record<string, unknown>;
  }

  // ─── apply ───────────────────────────────────────────────────────────────

  async apply(proposalId: string, decision: 'approve' | 'reject'): Promise<{ applied: boolean }> {
    const proposal = await this.redis.proposals.get(proposalId);
    if (!proposal) throw new Error(`Proposal ${proposalId} not found`);

    if (decision === 'reject') {
      await this.redis.proposals.remove(proposalId);
      return { applied: false };
    }

    // approve: execute the proposal
    const ok = await this._applyProposal(proposal);
    if (ok) await this.redis.proposals.remove(proposalId);
    return { applied: ok };
  }

  // ─── reviewProposal (deprecated — use review + apply) ────────────────────

  async reviewProposal(id: string, decision: 'approve' | 'reject'): Promise<void> {
    const result = await this.apply(id, decision);
    if (decision === 'approve' && !result.applied) {
      throw new Error(`Failed to apply proposal ${id}`);
    }
  }

  // ─── status ───────────────────────────────────────────────────────────────

  async status(): Promise<{ pending: string[] }> {
    const pending = await this.redis.proposals.listPending();
    return { pending };
  }

  // ─── Private: generate proposals ─────────────────────────────────────────

  private async _generateProposals(
    scope: string,
    signals: Array<StreamSignal & { stream_id?: string }>,
  ): Promise<{
    proposals: ConsolidationProposal[];
    messageIdsByProposal: Map<string, string[]>;
  }> {
    const proposals: ConsolidationProposal[] = [];
    const messageIdsByProposal = new Map<string, string[]>();

    // Cluster signals by target_id
    const clusters = new Map<string, { signals: StreamSignal[]; totalWeight: number }>();
    for (const signal of signals) {
      // Modern entries can be rejected before graph I/O. Legacy entries have no
      // source scope and are validated against the target after it is fetched.
      if (
        signal.scope &&
        normalizedScope(scope) !== 'global' &&
        normalizedScope(signal.scope) !== normalizedScope(scope)
      ) {
        continue;
      }
      const existing = clusters.get(signal.target_id) ?? { signals: [], totalWeight: 0 };
      existing.signals.push(signal);
      existing.totalWeight += SIGNAL_WEIGHTS[signal.type] ?? 1;
      clusters.set(signal.target_id, existing);
    }

    // Signal clusters retain their type and remain pending across runs until
    // this threshold is met.
    const clustersToProcess = [...clusters.entries()].filter(
      ([, cluster]) => cluster.totalWeight >= this.config.consolidation.signalThreshold,
    );

    // OPT-54: fetch every needed Semantic node in ONE round-trip instead of N
    // sequential getById calls. Missing ids are simply omitted — the proposal
    // loop below skips them exactly as the original `if (!node)` did.
    // Optional getByIds with a per-id getById fallback (mocks/layers without it).
    const neededIds = clustersToProcess.map(([id]) => id);
    const nodeById = new Map<string, SemanticNode>();
    if (neededIds.length > 0) {
      const semantic = this.neo4j.semantic;
      if (semantic.getByIds) {
        for (const n of await semantic.getByIds(neededIds)) nodeById.set(n.id, n);
      } else {
        for (const id of neededIds) {
          const n = await semantic.getById(id);
          if (n) nodeById.set(n.id, n);
        }
      }
    }

    // Generate proposals from signal clusters that meet threshold (clusters Map order).
    for (const [targetId, cluster] of clustersToProcess) {
      const node = nodeById.get(targetId);
      if (!node) continue;

      const validSignals = cluster.signals.filter((signal) => signalMatchesTarget(signal, node, scope));
      const totalWeight = validSignals.reduce(
        (total, signal) => total + (SIGNAL_WEIGHTS[signal.type] ?? 1),
        0,
      );
      if (totalWeight < this.config.consolidation.signalThreshold) continue;

      const contradictions = validSignals.filter((s) => s.type === 'contradiction');
      const corrections = validSignals.filter((s) => s.type === 'correction');
      const proposalScope = node.scope ?? validSignals.find((signal) => signal.scope)?.scope ?? scope;
      const deliveryIds = validSignals
        .map((signal) => (signal as StreamSignal & { stream_id?: string }).stream_id)
        .filter((id): id is string => typeof id === 'string' && id !== '')
        .sort();
      const proposalId = deliveryIds.length === validSignals.length
        ? stableId('signal', [proposalScope, targetId, ...deliveryIds])
        : nanoid();

      let proposal: ConsolidationProposal;
      if (contradictions.length > 0 || corrections.length > 0) {
        // Propose supersede with adjusted confidence
        const newConfidence = Math.max(0, node.confidence - 0.1 * (corrections.length + contradictions.length));
        proposal = buildSupersedePropsal(proposalId, proposalScope, node, newConfidence, totalWeight);
      } else {
        // Reinforce — the knowledge held true, so RAISE confidence (gently, with
        // diminishing returns toward 1.0). Previously this incorrectly called
        // buildDecayProposal, which DECAYED confidence by 5% — so repeatedly-confirmed
        // (i.e. most-validated) memories lost confidence every cycle, backwards for a
        // memory layer.
        proposal = buildReinforceProposal(proposalId, proposalScope, node, totalWeight);
      }
      proposals.push(proposal);
      messageIdsByProposal.set(
        proposal.id,
        validSignals
          .map((signal) => (signal as StreamSignal & { stream_id?: string }).stream_id)
          .filter((id): id is string => typeof id === 'string' && id !== ''),
      );
    }

    return { proposals, messageIdsByProposal };
  }

  // ─── Private: generate promote proposals ──────────────────────────────────

  /**
   * Mint `promote` proposals from episodes that have never been consolidated.
   *
   * Pipeline: deterministically promote explicitly approved decisions, then
   * cluster all other eligible classifications by embedding similarity, keep
   * clusters at/above minClusterSize, and synthesize each into one durable
   * claim via the LLM.
   *
   * Explicit decisions do not require an LLM. Recurrence-based promotion is
   * skipped (never throws) when synthesis is unavailable or fails.
   */
  private async _generatePromoteProposals(scope: string): Promise<ConsolidationProposal[]> {
    const accessor = this.neo4j.episodic;
    if (!accessor?.findPromotable) return [];

    const cfg = promoteConfig(this.config);
    if (cfg.maxPerRun <= 0) return [];

    // 'global' is the adapter's stand-in for "no scope given" — don't filter on it.
    const scopeFilter = scope && scope !== 'global' ? scope : undefined;

    let candidates: EpisodicNode[];
    try {
      // MEM-005: dual-window fetch. The head window keeps today's first-pass
      // semantics; a persisted keyset cursor drives a continuation window so a
      // stuck eligible-but-unpromotable backlog cannot starve newer evidence.
      // Any scheduler/redis failure degrades to today's full-limit head-only
      // fetch — scheduling must never break a promotion pass. Concurrent runs
      // may race the unguarded cursor read-modify-write; the drift is benign
      // (the cursor jumps; wrap-around still visits every episode).
      let scheduled: EpisodicNode[] | null = null;
      const keyset = accessor.findPromotableKeyset?.bind(accessor);
      if (keyset) {
        try {
          if (
            typeof this.redis.get !== 'function' ||
            typeof this.redis.set !== 'function' ||
            typeof this.redis.del !== 'function'
          ) {
            throw new Error('redis cursor store unavailable');
          }
          const { headLimit, continuationLimit } = planPromotionFetchV1(cfg.maxCandidates);
          const cursorKey = promotionCursorRedisKeyV1(scopeFilter ?? null, this.tenantId ?? null);
          const cursor = parsePromotionCursorV1(await this.redis.get(cursorKey));
          const headBatch = await accessor.findPromotable(scopeFilter, headLimit, this.tenantId);
          // Seed pass (no valid cursor): no continuation fetch; the cursor is
          // seeded from the head batch so pass 2 continues after the window.
          const continuationBatch = cursor
            ? await keyset(scopeFilter, continuationLimit, this.tenantId, cursor)
            : null;
          const next = advancePromotionCursorV1(continuationBatch, continuationLimit, headBatch, headLimit);
          if (next) await this.redis.set(cursorKey, serializePromotionCursorV1(next));
          else await this.redis.del(cursorKey);
          // Union by episode id, head wins — an episode straddling both
          // windows must enter the downstream pipeline exactly once.
          const byId = new Map<string, EpisodicNode>();
          for (const episode of headBatch) byId.set(episode.id, episode);
          for (const episode of continuationBatch ?? []) {
            if (!byId.has(episode.id)) byId.set(episode.id, episode);
          }
          scheduled = [...byId.values()];
        } catch (schedErr: unknown) {
          console.error(
            '[consolidation] scheduler: degraded to head-only fetch:',
            schedErr instanceof Error ? schedErr.message : schedErr,
          );
          scheduled = null;
        }
      }
      candidates =
        scheduled ?? (await accessor.findPromotable(scopeFilter, cfg.maxCandidates, this.tenantId));
    } catch (err: unknown) {
      console.error(
        '[consolidation] findPromotable failed; skipping promote pass:',
        err instanceof Error ? err.message : err,
      );
      return [];
    }
    // Explicit approval is authorization, not inferred recurrence. Promote each
    // approved, explicitly classified decision deterministically without LLM
    // synthesis. This path intentionally excludes implicit, revised, rejected,
    // and abandoned episodes.
    const directDecisions = candidates
      .filter((episode) => episode.memory_type === 'decision' && episode.outcome === 'approved')
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
      .slice(0, cfg.maxPerRun);
    const proposals = directDecisions.map((episode) =>
      buildApprovedDecisionProposal(episode.scope ?? scope, episode),
    );

    const remainingBudget = cfg.maxPerRun - proposals.length;
    if (remainingBudget <= 0 || !this.llm?.available) return proposals;

    // Decision semantics represent approved decisions only. Revised, rejected,
    // abandoned, and implicit decision episodes stay episodic; they do not get
    // a second chance to become decisions through recurrence synthesis.
    const recurringCandidates = candidates.filter((episode) => episode.memory_type !== 'decision');
    if (recurringCandidates.length < cfg.minClusterSize) return proposals;

    // A cluster whose members span projects must not become one semantic — its
    // tags/scope would merge two projects' knowledge. Only reachable on an
    // unscoped ("global") run, where candidates aren't pre-filtered.
    // Never blend unlike explicit classifications into one semantic. Legacy
    // unclassified rows retain their previous behavior in one legacy bucket.
    const byClassification = new Map<string, EpisodicNode[]>();
    for (const episode of recurringCandidates) {
      const key = episode.memory_type ?? '__legacy__';
      const bucket = byClassification.get(key) ?? [];
      bucket.push(episode);
      byClassification.set(key, bucket);
    }
    const clusters = [...byClassification.values()]
      .flatMap((bucket) => clusterByEmbedding(bucket, cfg.similarityThreshold, cfg.minClusterSize))
      .filter((c) => {
        const scopes = new Set(c.map((e) => e.scope ?? ''));
        if (scopes.size === 1) return true;
        console.error(
          `[consolidation] promote: dropped a ${c.length}-episode cluster spanning ${scopes.size} project scopes`,
        );
        return false;
      })
      .filter((c) => {
        if (clusterHasIndependentCorroborationV1(c, { minSources: cfg.minClusterSize, minDistinctEvidence: 2 })) {
          return true;
        }
        console.error(
          `[consolidation] promote: dropped a ${c.length}-episode cluster without independent corroboration`,
        );
        return false;
      });
    if (clusters.length === 0) return proposals;

    // Largest clusters first — the most-corroborated knowledge is promoted while
    // the per-run budget lasts. A skipped cluster is reconsidered next run (its
    // episodes stay unpromoted), so the budget defers work, never drops it.
    const ranked = [...clusters].sort((a, b) => b.length - a.length);
    const selected = ranked.slice(0, remainingBudget);
    if (ranked.length > selected.length) {
      console.error(
        `[consolidation] promote: ${ranked.length} clusters qualified, promoting ${selected.length} this run ` +
          `(remainingBudget=${remainingBudget}); the rest remain unpromoted and are reconsidered next run.`,
      );
    }

    for (const cluster of selected) {
      const synthesized = await this._synthesizeCluster(cluster);
      if (!synthesized) continue;
      proposals.push(buildPromoteProposal(cluster[0]?.scope ?? scope, cluster, synthesized, clusterTags(cluster)));
    }
    return proposals;
  }

  /**
   * Condense one cluster of episodes into a single durable claim. Returns null
   * when the model declines (empty content), the response doesn't parse, or the
   * call fails — a bad synthesis must not become a proposal.
   */
  private async _synthesizeCluster(
    cluster: EpisodicNode[],
  ): Promise<{ content: string; confidence: number; decay_class: SemanticNode['decay_class'] } | null> {
    const llm = this.llm;
    if (!llm) return null;

    // Cap per-episode text so one long episode can't crowd the others out of
    // the prompt — every member must be represented for a claim to generalize.
    const rendered = cluster
      .map((e, i) => `[${i + 1}] task: ${e.task}\n${e.content.slice(0, 1200)}`)
      .join('\n\n');

    let raw: string;
    try {
      raw = await llm.chat(
        [
          { role: 'system', content: PROMOTE_SYNTHESIS_PROMPT },
          { role: 'user', content: rendered.slice(0, 12000) },
        ],
        { model: llm.modelFor('synthesis'), jsonMode: true, maxTokens: 600 },
      );
    } catch (err: unknown) {
      console.error(
        '[consolidation] promote synthesis failed:',
        err instanceof Error ? err.message : err,
      );
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error('[consolidation] promote synthesis returned non-JSON; skipping cluster');
      return null;
    }

    const obj = parsed as Record<string, unknown>;
    const content = typeof obj.content === 'string' ? obj.content.trim() : '';
    if (content === '') return null;

    const rawConfidence = typeof obj.confidence === 'number' && Number.isFinite(obj.confidence)
      ? obj.confidence
      : 0.5;
    const decayClass =
      typeof obj.decay_class === 'string' && VALID_DECAY_CLASSES.has(obj.decay_class)
        ? (obj.decay_class as SemanticNode['decay_class'])
        : 'stable';

    return {
      content,
      // Clamp: a model-supplied confidence is untrusted input, and a >1 value
      // would make the new semantic un-decayable.
      confidence: Math.min(1, Math.max(0, rawConfidence)),
      decay_class: decayClass,
    };
  }

  // ─── Private: apply proposal ──────────────────────────────────────────────

  private async _applyProposal(
    proposal: ConsolidationProposal,
    counters?: { tenant_unresolved: number },
  ): Promise<boolean> {
    try {
      if (proposal.type === 'promote') {
        return await this._applyPromoteProposal(proposal);
      } else if (proposal.type === 'supersede') {
        const before = parseSemanticNode(proposal.before, 'proposal.before');
        const after = parsePartialSemanticNode(proposal.after, 'proposal.after');

        const newNode: SemanticNode = {
          id: stableId('semantic-supersede', [proposal.id, before.id]),
          content: after.content ?? before.content,
          confidence: after.confidence ?? before.confidence,
          signal_count: (before.signal_count ?? 0) + 1,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          decay_class: after.decay_class ?? before.decay_class,
          memory_type: after.memory_type ?? before.memory_type,
          tags: after.tags ?? before.tags ?? [],
          // Carry the tenant forward: the superseding node belongs to the same
          // tenant as the node it replaces (after-side wins if it specifies one).
          tenant_id: after.tenant_id ?? before.tenant_id ?? DEFAULT_TENANT,
        };

        await this.neo4j.semantic.supersede(before.id, newNode);
        await this._invalidateCacheBestEffort(before.id, newNode.id);

        // Fact extraction: optionally extract facts from superseded content
        await this._extractAndStoreFacts(newNode.content, newNode.id, proposal.affected_ids);

        // Dispute related active facts when this is a contradiction-driven supersede
        if (this.neo4j.fact) {
          const lowerConfidence = (after.confidence ?? before.confidence) < before.confidence;
          if (lowerConfidence) {
            await this._disputeRelatedFacts(before.content);
          }
        }
      } else if (proposal.type === 'decay' || proposal.type === 'reinforce') {
        // Both are confidence adjustments applied via updateConfidence; they differ
        // only in direction (decay lowers, reinforce raises).
        const targetId = proposal.affected_ids[0];
        if (targetId) {
          const after = proposal.after as { confidence?: number };
          if (typeof after.confidence === 'number') {
            await this.neo4j.semantic.updateConfidence(targetId, after.confidence, proposal.id);
            await this._invalidateCacheBestEffort(targetId);
          }
        }
      } else if (proposal.type === 'reclass') {
        // MEM-006H: review-gated decay-class change. The proposal id is the
        // idempotency application key (updateDecayClass ledger), so a replayed
        // approval is a no-op.
        const targetId = proposal.affected_ids[0];
        if (targetId) {
          const after = proposal.after as { decay_class?: string };
          if (after.decay_class === 'volatile' || after.decay_class === 'stable' || after.decay_class === 'permanent') {
            if (!this.neo4j.semantic.updateDecayClass) {
              throw new Error('reclass apply requires semantic.updateDecayClass');
            }
            await this.neo4j.semantic.updateDecayClass(targetId, after.decay_class, proposal.id);
            await this._invalidateCacheBestEffort(targetId);
          }
        }
      }
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === TENANT_UNRESOLVED && counters) counters.tenant_unresolved++;
      console.error(
        `[consolidation] _applyProposal failed for proposal ${proposal.id} (type=${proposal.type}): ${message}`,
      );
      return false;
    }
  }

  // ─── Private: apply promote proposal ───────────────────────────────────────

  /**
   * Promote source episodic memory into a new Semantic node.
   *
   * The new Semantic's tenant is derived from the SOURCE episodes
   * (`proposal.affected_ids`, which for a promote proposal are episodic IDs).
   * Consolidation runs per scope, so all source episodes should share one
   * tenant; we use their common tenant, and fall back to DEFAULT_TENANT when no
   * episodic accessor is wired, episodes carry no tenant, or tenants are mixed.
   */
  private async _applyPromoteProposal(proposal: ConsolidationProposal): Promise<boolean> {
    if (!this.neo4j.semantic.promoteFromEpisodic) {
      console.error(
        `[consolidation] _applyPromoteProposal: layer has no promoteFromEpisodic; skipping ${proposal.id}`,
      );
      return false;
    }

    const after = parsePartialSemanticNode(proposal.after, 'proposal.after');
    const sourceEpisodeIds = [...new Set(proposal.affected_ids)];
    const tenantId = await this._deriveTenantFromEpisodes(sourceEpisodeIds, after.tenant_id);

    const now = new Date().toISOString();
    const newNode: SemanticNode = {
      id: after.id ?? nanoid(),
      content: after.content ?? '',
      confidence: after.confidence ?? 0.5,
      signal_count: after.signal_count ?? 1,
      created_at: after.created_at ?? now,
      updated_at: after.updated_at ?? now,
      decay_class: after.decay_class ?? 'stable',
      memory_type: after.memory_type,
      tags: after.tags ?? [],
      tenant_id: tenantId,
    };

    if (sourceEpisodeIds.length === 0) {
      console.error(
        `[consolidation] _applyPromoteProposal: proposal ${proposal.id} has no source episodes`,
      );
      return false;
    }

    // The persistence layer creates the Semantic, every PROMOTED_FROM edge, and
    // inherited ABOUT links in one transaction. Passing the complete cluster is
    // essential: findPromotable excludes episodes by this provenance edge.
    // D10: content-keyed dedupe_key so the semantic_dedupe_unique constraint
    // covers promoted Semantics. Normalization: trim, collapse whitespace runs
    // to one space, lowercase. Tenant is folded into the scope so two tenants
    // never share a key; the `promoted:` prefix keeps it out of the seed/ingest
    // key space.
    const normalizedContent = newNode.content.trim().replace(/\s+/g, ' ').toLowerCase();
    const dedupeKey = `promoted:${semanticDedupeKey(`${tenantId}/${proposal.scope}`, undefined, normalizedContent)}`;
    const newId = await this.neo4j.semantic.promoteFromEpisodic(sourceEpisodeIds, newNode, tenantId, dedupeKey);
    await this._invalidateCacheBestEffort(newId);

    // Extract facts from the promoted content for traceability.
    await this._extractAndStoreFacts(newNode.content, newId, sourceEpisodeIds);

    return true;
  }

  /** Cache is derived state; invalidation failure must not roll back durable graph work. */
  private async _invalidateCacheBestEffort(...nodeIds: string[]): Promise<void> {
    const results = await Promise.allSettled(
      nodeIds.map((nodeId) => this.redis.cache.invalidateByNodeId(nodeId)),
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        console.error(
          '[consolidation] cache invalidation failed after durable mutation (non-critical):',
          result.reason instanceof Error ? result.reason.message : String(result.reason),
        );
      }
    }
  }

  /**
   * Determine the tenant for a set of source episodes.
   *
   * All discovered source episodes must belong to one tenant. An explicit
   * `preferred` tenant must agree with that tenant. Mixed clusters are rejected
   * rather than being written into DEFAULT_TENANT, which would cross an
   * isolation boundary.
   */
  private async _deriveTenantFromEpisodes(
    episodeIds: string[],
    preferred?: string,
  ): Promise<string> {
    const accessor = this.neo4j.episodic;
    if (!accessor || episodeIds.length === 0) return preferred || DEFAULT_TENANT;

    const tenants = new Set<string>();
    let readFailed = false;
    if (accessor.getTenantsByIds) {
      // OPT-45: one batched tenant_id projection instead of one getById per id.
      // Same contribution semantics: a found episode adds (tenant_id ?? DEFAULT);
      // a missing episode yields no row (doesn't contribute).
      try {
        for (const t of await accessor.getTenantsByIds(episodeIds)) {
          tenants.add(t ?? DEFAULT_TENANT);
        }
      } catch {
        readFailed = true; // C5: fail the batch below, never fall through to DEFAULT.
      }
    } else {
      for (const id of episodeIds) {
        try {
          const ep = await accessor.getById(id);
          if (ep) tenants.add(ep.tenant_id ?? DEFAULT_TENANT);
        } catch {
          readFailed = true; // C5: a missing episode (null) is fine; an unreadable one is not.
        }
      }
    }

    // C5 (PRP §4.2 cross-tenant 0): any swallowed read means the cluster's
    // tenant is unproven, so the batch fails instead of resolving to DEFAULT.
    if (readFailed) throw new Error(TENANT_UNRESOLVED);
    if (tenants.size > 1) {
      throw new Error('Cannot promote episodes from multiple tenants');
    }

    const sourceTenant = tenants.size === 1 ? [...tenants][0]! : DEFAULT_TENANT;
    if (preferred && preferred !== sourceTenant) {
      throw new Error(`Promotion tenant ${preferred} does not match source tenant ${sourceTenant}`);
    }
    return preferred || sourceTenant;
  }

  // ─── Private: fact extraction ──────────────────────────────────────────────

  private async _extractAndStoreFacts(
    content: string,
    semanticId: string,
    sourceEpisodeIds: string[] = [],
  ): Promise<void> {
    const factLayer = this.neo4j.fact;
    const apiKey = this.config.embedding.apiKey;
    if (!factLayer || !apiKey) return;

    try {
      const inputs = await extractFacts(content, apiKey, this.config.models?.extraction);
      if (inputs.length === 0) return;

      const now = new Date().toISOString();
      for (const input of inputs) {
        // Use proposal's affected_ids as source episodes for traceability
        const episodeIds = sourceEpisodeIds.length > 0
          ? sourceEpisodeIds
          : input.source_episode_ids;

        // Reconcile against existing facts for this subject + predicate, INCLUDING
        // tentative ones. Without the opt-in this lookup is active-only
        // (`neo4j/fact.ts` — "Default = active-only ... e.g. consolidation"), so a
        // tentative deductive fact minted by extraction was invisible here and this
        // method created an inductive twin of a claim already in the graph. Measured
        // 2026-08-28: 999 groups of byte-identical duplicates, 985 of them exactly one
        // deductive + one inductive twin, all written since the engine started running.
        const existing = await factLayer.findBySubjectPredicate(
          input.subject,
          input.predicate,
          undefined,
          { includeTentative: true },
        );

        // Split the result the way the extraction path already does. Taking
        // `existing[0]` was unsafe once tentative rows are visible: the query orders by
        // `valid_at DESC`, so the head could be a tentative contender, and the OPT-31
        // gate below would then compare a contender against the WRONG fact. Because
        // tentative facts sit at 0.5 and the protect threshold is 0.75, that gate would
        // evaluate `autoInvalidate` true almost every time — inverting the protection it
        // exists to enforce and auto-promoting an uncorroborated claim.
        //
        // `reinforcing` decides dedup and matches ANY status. `current` decides the
        // contradiction and is ACTIVE by construction, which makes all of that
        // structurally unreachable rather than merely unlikely.
        const reinforcing = existing.find((f) => f.object === input.object);
        if (reinforcing) {
          // The claim is already in the graph. Skip — no write of any kind.
          continue;
        }
        const current = existing.find((f) => f.object !== input.object && f.status === 'active');

        if (current) {
          // Different object — a contradiction. Auto-invalidating an ESTABLISHED
          // fact from extraction-derived (potentially untrusted) content would
          // let injected input silently overwrite an authoritative fact (OPT-31).
          // Gate it: an established fact (confidence >= protect threshold) is only
          // auto-invalidated by a contender at least as confident; otherwise the
          // contender is held as `tentative` (the established fact stays active)
          // for corroboration / human review.
          const newConfidence = input.confidence ?? 0.5;
          const protect = factProtectConfidence();
          const autoInvalidate =
            current.confidence < protect || newConfidence >= current.confidence;

          const newFactId = `fact-${nanoid(12)}`;
          const newFact: FactNode = {
            id: newFactId,
            subject: input.subject,
            predicate: input.predicate,
            object: input.object,
            entity_id: null,
            source_episode_ids: episodeIds,
            valid_at: now,
            invalid_at: null,
            confidence: newConfidence,
            status: autoInvalidate ? 'active' : 'tentative',
            inference_type: 'inductive',
            supersedes_fact_id: current.id,
            scope: input.scope ?? 'project',
            tags: input.tags ?? [],
            created_at: now,
            updated_at: now,
          };

          if (autoInvalidate) {
            await factLayer.invalidate(current.id, now, newFactId);
            await factLayer.create(newFact);
          } else {
            // Hold the contradiction: established fact stays active; record the
            // contender as tentative (supersedes link kept for traceability).
            // Predicate is OPT-04-validated snake_case, so it is log-safe;
            // subject/object are NOT logged (untrusted, may carry newlines).
            await factLayer.create(newFact);
            console.error(
              `[consolidation] held extraction-derived contradiction (predicate ` +
              `"${input.predicate}") as tentative: existing confidence ` +
              `${current.confidence} >= protect ${protect}, contender ` +
              `${newConfidence}; existing fact left active for review.`,
            );
          }
        } else {
          // New fact
          const newFact: FactNode = {
            id: `fact-${nanoid(12)}`,
            subject: input.subject,
            predicate: input.predicate,
            object: input.object,
            entity_id: null,
            source_episode_ids: episodeIds,
            valid_at: now,
            invalid_at: null,
            confidence: input.confidence ?? 0.5,
            status: 'tentative',
            inference_type: 'inductive',
            supersedes_fact_id: null,
            scope: input.scope ?? 'project',
            tags: input.tags ?? [],
            created_at: now,
            updated_at: now,
          };
          await factLayer.create(newFact);
        }
      }
    } catch (err) {
      // Non-critical: fact extraction failure should not block consolidation
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[consolidation] fact extraction failed (non-critical): ${message}`);
    }
  }

  private async _disputeRelatedFacts(semanticContent: string): Promise<void> {
    const factLayer = this.neo4j.fact;
    const apiKey = this.config.embedding.apiKey;
    if (!factLayer || !apiKey) return;

    try {
      // Extract facts from the old (now-contradicted) content to find what to dispute
      const oldFacts = await extractFacts(semanticContent, apiKey, this.config.models?.extraction);
      for (const oldFact of oldFacts) {
        const matching = await factLayer.findBySubjectPredicate(
          oldFact.subject,
          oldFact.predicate,
        );
        for (const active of matching) {
          if (active.object === oldFact.object) {
            await factLayer.dispute(active.id);
          }
        }
      }
    } catch (err: unknown) {
      // Non-critical: dispute failure should not block consolidation
    }
  }
}

// ─── Promote: configuration ───────────────────────────────────────────────────

/**
 * Promote-pass knobs, with env overrides. Defaults are deliberately
 * conservative: 3 episodes must agree before their shared knowledge is durable
 * enough to propose, and at most 3 promotions are proposed per run so a first
 * pass over a large backlog can be reviewed rather than dumped.
 */
const PROMOTE_DEFAULTS = {
  minClusterSize: 3,
  similarityThreshold: 0.82,
  maxPerRun: 3,
  maxCandidates: 200,
} as const;

function numFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = readEnv(name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function promoteConfig(config: AMPConfig): {
  minClusterSize: number;
  similarityThreshold: number;
  maxPerRun: number;
  maxCandidates: number;
} {
  const c = config.consolidation.promote;
  return {
    minClusterSize: Math.round(
      c?.minClusterSize ?? numFromEnv('MEMBERRY_PROMOTE_MIN_CLUSTER', PROMOTE_DEFAULTS.minClusterSize, 2, 50),
    ),
    similarityThreshold:
      c?.similarityThreshold ??
      numFromEnv('MEMBERRY_PROMOTE_SIMILARITY', PROMOTE_DEFAULTS.similarityThreshold, 0, 1),
    maxPerRun: Math.round(
      c?.maxPerRun ?? numFromEnv('MEMBERRY_PROMOTE_MAX_PER_RUN', PROMOTE_DEFAULTS.maxPerRun, 0, 50),
    ),
    maxCandidates: Math.round(
      c?.maxCandidates ?? numFromEnv('MEMBERRY_PROMOTE_MAX_CANDIDATES', PROMOTE_DEFAULTS.maxCandidates, 10, 2000),
    ),
  };
}

/** Union of the cluster's tags (deduped, project tags lowercased) — the source
 *  episodes' tags are what make the promoted semantic retrievable by scope. */
function clusterTags(cluster: EpisodicNode[]): string[] {
  const projectTags = new Set<string>();
  const nonProjectCounts = new Map<string, number>();
  for (const ep of cluster) {
    for (const raw of new Set(ep.tags ?? [])) {
      const tag = /^project:/i.test(raw) ? raw.toLowerCase() : raw;
      if (/^project:/i.test(tag)) {
        projectTags.add(tag);
      } else {
        nonProjectCounts.set(tag, (nonProjectCounts.get(tag) ?? 0) + 1);
      }
    }
  }
  const classification = cluster[0]?.memory_type;
  // Pattern/convention tags must themselves recur: one episode's incidental
  // label cannot manufacture a durable pattern/topic in the wiki. Other memory
  // types retain the legacy union behavior for backward compatibility.
  const stableNonProjectTags = [...nonProjectCounts]
    .filter(([, count]) =>
      classification === 'pattern' || classification === 'convention' ? count >= 2 : count >= 1,
    )
    .map(([tag]) => tag)
    .sort();
  return [...[...projectTags].sort(), ...stableNonProjectTags];
}

// ─── Promote: clustering helpers ──────────────────────────────────────────────

/** Cosine similarity of two equal-length vectors. Returns 0 for degenerate input. */
function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Greedy single-pass clustering: each episode joins the first cluster whose
 * SEED it is at least `threshold` similar to, else it seeds a new cluster.
 * Deterministic given a fixed input order (episodes arrive newest-first), which
 * keeps a re-run over the same graph state reproducible.
 *
 * Greedy (not k-means / HDBSCAN) on purpose: the candidate set is capped in the
 * hundreds and only clusters at/above `minSize` survive, so the cost of a
 * slightly suboptimal partition is a missed promotion this cycle, not a wrong
 * one — and the next run reconsiders every still-unpromoted episode.
 */
export function clusterByEmbedding(
  episodes: EpisodicNode[],
  threshold: number,
  minSize: number,
): EpisodicNode[][] {
  const clusters: Array<{ seed: number[]; members: EpisodicNode[] }> = [];

  for (const ep of episodes) {
    const vec = ep.embedding;
    if (!vec || vec.length === 0) continue;
    const hit = clusters.find((c) => cosine(c.seed, vec) >= threshold);
    if (hit) hit.members.push(ep);
    else clusters.push({ seed: vec, members: [ep] });
  }

  return clusters.filter((c) => c.members.length >= minSize).map((c) => c.members);
}

// ─── Promote: synthesis prompt ────────────────────────────────────────────────

const PROMOTE_SYNTHESIS_PROMPT = `You are a memory consolidation system. You are given several related episodic memories from one project — raw session snapshots of what happened.

Write the single durable piece of knowledge they share: the principle, convention, decision, or architectural fact that stays true after these particular sessions are forgotten.

Rules:
- State it as a standalone claim. It must make sense to someone who never sees the source episodes.
- Generalize across the episodes; do not summarize them one by one and do not narrate the sessions ("the agent did X").
- Include the concrete specifics that make the knowledge usable (names, paths, versions, thresholds).
- Omit anything only true of one session (timestamps, one-off errors, transient state).
- If the episodes share no durable knowledge, return an empty string for "content".

Respond with JSON only:
{"content": "...", "confidence": 0.0-1.0, "decay_class": "volatile" | "stable" | "permanent"}

confidence: how strongly the episodes support the claim. decay_class: "volatile" for knowledge that changes often (current task state), "stable" for conventions and architecture, "permanent" for immutable facts.`;

// ─── Proposal builders ────────────────────────────────────────────────────────

function buildPromoteProposal(
  scope: string,
  cluster: EpisodicNode[],
  synthesized: { content: string; confidence: number; decay_class: SemanticNode['decay_class'] },
  tags: string[],
): ConsolidationProposal {
  const now = new Date().toISOString();
  const sourceIds = cluster.map((episode) => episode.id).sort();
  const proposalId = stableId('promote', [scope, ...sourceIds]);
  const memoryType = cluster.every((episode) => episode.memory_type === cluster[0]?.memory_type)
    ? cluster[0]?.memory_type
    : undefined;
  return {
    id: proposalId,
    type: 'promote',
    scope,
    // Source EPISODE ids — promotion persists provenance for the complete
    // cluster and derives the new semantic's tenant from all of them.
    affected_ids: cluster.map((e) => e.id),
    before: {},
    after: {
      id: stableId('semantic', [scope, ...sourceIds]),
      content: synthesized.content,
      confidence: synthesized.confidence,
      signal_count: cluster.length,
      created_at: now,
      updated_at: now,
      decay_class: synthesized.decay_class,
      tags,
      ...(memoryType ? { memory_type: memoryType } : {}),
    } as Record<string, unknown>,
    score: cluster.length,
    created_at: now,
  };
}

/** One approved decision is complete evidence; no generative rewrite is needed. */
function buildApprovedDecisionProposal(
  scope: string,
  episode: EpisodicNode,
): ConsolidationProposal {
  const now = new Date().toISOString();
  const proposalId = stableId('promote-decision', [scope, episode.id]);
  return {
    id: proposalId,
    type: 'promote',
    scope,
    affected_ids: [episode.id],
    before: {},
    after: {
      id: stableId('semantic-decision', [scope, episode.id]),
      content: episode.content,
      confidence: APPROVED_DECISION_CONFIDENCE,
      signal_count: 1,
      created_at: now,
      updated_at: now,
      decay_class: 'stable',
      tags: clusterTags([episode]),
      memory_type: 'decision',
    },
    score: 1,
    created_at: now,
  };
}

function buildSupersedePropsal(
  proposalId: string,
  scope: string,
  node: SemanticNode,
  newConfidence: number,
  score: number,
): ConsolidationProposal {
  return {
    id: proposalId,
    type: 'supersede',
    scope,
    affected_ids: [node.id],
    before: { ...node } as Record<string, unknown>,
    after: {
      ...node,
      confidence: newConfidence,
      updated_at: new Date().toISOString(),
    } as Record<string, unknown>,
    score,
    created_at: new Date().toISOString(),
  };
}

// Gentle confidence gain on reinforcement: move a small fraction toward 1.0, so
// confidence rises with diminishing returns and is bounded at 1.0 (can never exceed it).
const REINFORCE_FACTOR = 0.05;

function buildReinforceProposal(
  proposalId: string,
  scope: string,
  node: SemanticNode,
  score: number,
): ConsolidationProposal {
  const reinforcedConfidence = Math.min(1, node.confidence + (1 - node.confidence) * REINFORCE_FACTOR);
  return {
    id: proposalId,
    type: 'reinforce',
    scope,
    affected_ids: [node.id],
    before: { ...node } as Record<string, unknown>,
    after: {
      confidence: reinforcedConfidence,
    } as Record<string, unknown>,
    score,
    created_at: new Date().toISOString(),
  };
}
