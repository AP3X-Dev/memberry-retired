// Keeps the Episodic -> Semantic lifecycle moving without requiring an agent
// or operator to remember to call berry_consolidate. The coordinator is
// intentionally MCP-local: it owns process timers and operational status while
// the core ConsolidationEngine remains the single authority for proposal policy.

import { parseBoolFlag, readEnv } from '@memberry/core';

export interface ConsolidationRunResult {
  skipped?: boolean;
  reason?: string;
  applied?: string[];
}

export interface ConsolidationCoordinatorConfig {
  enabled: boolean;
  readonly: boolean;
  startupDelayMs: number;
  debounceMs: number;
  catchupIntervalMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  maxRetries: number;
  healthGraceMs: number;
  staleAfterMs: number;
}

export interface ConsolidationCoordinatorSnapshot {
  name: string;
  enabled: boolean;
  readonly: boolean;
  running_scope: string | null;
  queued_scopes: string[];
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  limitation: string | null;
  health: 'disabled' | 'readonly' | 'starting' | 'healthy' | 'recovering' | 'unhealthy';
  stale: boolean;
  exhausted_failure: boolean;
  discovery: {
    last_error: string | null;
    pending_retry: { attempt: number; next_at: string } | null;
    exhausted_failure: boolean;
  };
  publication: {
    needed_since: string | null;
    last_success_at: string | null;
    last_error: string | null;
    pending_retry: { attempt: number; next_at: string } | null;
    exhausted_failure: boolean;
    dirty_version: number | null;
    published_version: number | null;
  };
  pending_retries: Array<{ scope: string; attempt: number; next_at: string }>;
}

export interface ConsolidationCoordinatorOptions {
  name?: string;
  config: ConsolidationCoordinatorConfig;
  run(scope: string): Promise<ConsolidationRunResult>;
  discoverScopes(): Promise<string[]>;
  /** Called after a run applies graph mutations. Publication remains best effort. */
  onMutation?: () => void | Promise<void>;
  logger?: Pick<Console, 'error'>;
  /** Explicitly surfaced when this worker cannot cover part of the lifecycle. */
  limitation?: string;
  forceUnhealthy?: boolean;
  publicationState?: {
    markDirty(): Promise<number>;
    versions(): Promise<{ dirty: number; published: number }>;
    markPublished(version: number): Promise<void>;
  };
}

const coordinators = new Map<string, ConsolidationCoordinator>();

/** Protections (READONLY, CONSOLIDATION_ENABLED) parse loose — see core config/bool-flag.ts. */
function truthy(raw: string | undefined, fallback: boolean): boolean {
  return parseBoolFlag(raw, fallback);
}

function positiveInt(name: string, fallback: number, minimum = 1): number {
  const parsed = Number.parseInt(readEnv(name) ?? '', 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

/** Resolve lifecycle automation once at bootstrap. Explicit env always wins. */
export function resolveConsolidationCoordinatorConfig(
  readonly = truthy(readEnv('MEMBERRY_READONLY'), false),
): ConsolidationCoordinatorConfig {
  return {
    enabled: truthy(readEnv('MEMBERRY_CONSOLIDATION_ENABLED'), true),
    readonly,
    startupDelayMs: positiveInt('MEMBERRY_CONSOLIDATION_STARTUP_DELAY_MS', 2_000, 0),
    debounceMs: positiveInt('MEMBERRY_CONSOLIDATION_DEBOUNCE_MS', 5_000, 0),
    catchupIntervalMs: positiveInt('MEMBERRY_CONSOLIDATION_INTERVAL_MS', 15 * 60_000),
    retryBaseMs: positiveInt('MEMBERRY_CONSOLIDATION_RETRY_BASE_MS', 1_000),
    retryMaxMs: positiveInt('MEMBERRY_CONSOLIDATION_RETRY_MAX_MS', 60_000),
    maxRetries: positiveInt('MEMBERRY_CONSOLIDATION_MAX_RETRIES', 5, 0),
    healthGraceMs: positiveInt('MEMBERRY_CONSOLIDATION_HEALTH_GRACE_MS', 120_000, 0),
    staleAfterMs: positiveInt('MEMBERRY_CONSOLIDATION_STALE_AFTER_MS', 60 * 60_000),
  };
}

/** Readiness-safe process snapshot. It contains no memory content or secrets. */
export function getConsolidationAutomationHealth(): Record<string, unknown> {
  const workers = [...coordinators.values()].map((coordinator) => coordinator.snapshot());
  return {
    enabled: workers.some((worker) => worker.enabled && !worker.readonly),
    unhealthy: workers.some((worker) => worker.health === 'unhealthy'),
    degraded: workers.some((worker) =>
      worker.limitation !== null || worker.health === 'recovering' || worker.health === 'unhealthy'),
    limitations: workers
      .filter((worker) => worker.limitation !== null)
      .map((worker) => `${worker.name}: ${worker.limitation}`),
    workers,
  };
}

function unref(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  if (typeof timer.unref === 'function') timer.unref();
}

function canonicalScope(scope: string | undefined): string | null {
  const value = scope?.trim().toLowerCase();
  return value && value !== 'global' ? value : null;
}

/** Apply the same store attribution precedence to current and legacy episodes. */
export function resolveEpisodeScope(input: {
  scope?: string;
  tags?: string[];
  task?: string;
  content?: string;
}): string | undefined {
  const explicit = canonicalScope(input.scope);
  if (explicit) return explicit;
  const tag = input.tags?.find((candidate) => candidate.toLowerCase().startsWith('project:'));
  if (tag) return canonicalScope(tag) ?? undefined;
  const prefixed = input.task?.match(/^\[project:([\w.-]+)\]/i)
    ?? input.content?.match(/^\[project:([\w.-]+)\]/i);
  return prefixed ? `project:${prefixed[1].toLowerCase()}` : undefined;
}

/** Unique concrete scopes recovered from modern and pre-scope Episodic rows. */
export function recoverEpisodeScopes(
  episodes: Array<{ scope?: string; tags?: string[]; task?: string; content?: string }>,
): string[] {
  return [...new Set(episodes.map(resolveEpisodeScope).filter((scope): scope is string => !!scope))]
    .sort();
}

export class ConsolidationCoordinator {
  private readonly name: string;
  private readonly config: ConsolidationCoordinatorConfig;
  private readonly run: ConsolidationCoordinatorOptions['run'];
  private readonly discoverScopes: ConsolidationCoordinatorOptions['discoverScopes'];
  private readonly onMutation?: ConsolidationCoordinatorOptions['onMutation'];
  private readonly logger: Pick<Console, 'error'>;
  private readonly limitation: string | null;
  private readonly forceUnhealthy: boolean;
  private readonly publicationState?: ConsolidationCoordinatorOptions['publicationState'];
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retries = new Map<string, { attempt: number; nextAt: string }>();
  private readonly queue = new Map<string, number>();
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private discoveryRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private discoveryRetry: { attempt: number; nextAt: string } | null = null;
  private discoveryLastError: string | null = null;
  private discoveryExhausted = false;
  private drainPromise: Promise<void> | null = null;
  private discovering = false;
  private stopped = true;
  private runningScope: string | null = null;
  private lastAttemptAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastError: string | null = null;
  private startedAt: number | null = null;
  private exhaustedFailure = false;
  private publicationNeededSince: string | null = null;
  private publicationLastSuccessAt: string | null = null;
  private publicationLastError: string | null = null;
  private publicationRetry: { attempt: number; nextAt: string } | null = null;
  private publicationRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private publicationDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private publicationPromise: Promise<void> | null = null;
  private publicationQueued = false;
  private publicationExhausted = false;
  private publicationDirtyVersion: number | null = null;
  private publicationPublishedVersion: number | null = null;

  constructor(options: ConsolidationCoordinatorOptions) {
    this.name = options.name ?? 'default';
    this.config = options.config;
    this.run = options.run;
    this.discoverScopes = options.discoverScopes;
    this.onMutation = options.onMutation;
    this.logger = options.logger ?? console;
    this.limitation = options.limitation ?? null;
    this.forceUnhealthy = options.forceUnhealthy ?? false;
    this.publicationState = options.publicationState;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.startedAt = Date.now();
    coordinators.set(this.name, this);
    if (!this.config.enabled || this.config.readonly) {
      this.logger.error(
        `[memberry-mcp] consolidation automation ${this.config.readonly ? 'read-only no-op' : 'disabled'} (${this.name})`,
      );
      return;
    }

    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.recoverPublicationIntent().finally(() => this.catchUp());
    }, this.config.startupDelayMs);
    unref(this.startupTimer);
    this.intervalTimer = setInterval(() => void this.catchUp(), this.config.catchupIntervalMs);
    unref(this.intervalTimer);
    this.logger.error(
      `[memberry-mcp] consolidation automation started (${this.name}; debounce=${this.config.debounceMs}ms, catch-up=${this.config.catchupIntervalMs}ms)`,
    );
  }

  /** Debounced hot-path hook called only after a non-duplicate successful store. */
  schedule(scope: string | undefined): void {
    if (this.stopped || !this.config.enabled || this.config.readonly) return;
    const canonical = canonicalScope(scope);
    if (!canonical) return;
    const existing = this.debounceTimers.get(canonical);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(canonical);
      this.enqueue(canonical, 0);
    }, this.config.debounceMs);
    this.debounceTimers.set(canonical, timer);
    unref(timer);
  }

  /** Debounced, retrying publication hook for every successful graph store. */
  async schedulePublication(): Promise<void> {
    if (this.stopped || !this.config.enabled || this.config.readonly || !this.onMutation) return;
    this.publicationNeededSince ??= new Date().toISOString();
    if (this.publicationState) {
      try {
        this.publicationDirtyVersion = await this.publicationState.markDirty();
      } catch (error: unknown) {
        this.publicationLastError = `could not persist publication intent: ${error instanceof Error ? error.message : String(error)}`;
        this.publicationExhausted = true;
        this.logger.error(`[memberry-mcp] ${this.publicationLastError}`);
      }
    }
    if (this.publicationDebounceTimer) clearTimeout(this.publicationDebounceTimer);
    this.publicationDebounceTimer = setTimeout(() => {
      this.publicationDebounceTimer = null;
      void this.publish(0);
    }, this.config.debounceMs);
    unref(this.publicationDebounceTimer);
  }

  /** Discover concrete scopes; never use a cross-scope global run. */
  async catchUp(attempt = 0): Promise<void> {
    if (this.stopped || !this.config.enabled || this.config.readonly || this.discovering) return;
    this.discovering = true;
    try {
      const scopes = await this.discoverScopes();
      for (const raw of scopes) {
        const scope = canonicalScope(raw);
        if (scope) this.enqueue(scope, 0);
      }
      // Reconcile derived wiki state conservatively on every startup/periodic
      // catch-up. This closes the unavoidable cross-datastore crash window in
      // which Neo4j committed a store but the process died before Redis could
      // record dirty publication intent. Atomic generations make an unchanged
      // rebuild safe; durable retry/version state keeps failures observable.
      if (!this.publicationNeededSince && !this.publicationPromise
        && !this.publicationRetryTimer && !this.publicationDebounceTimer) {
        await this.schedulePublication();
      }
      this.lastSuccessAt = new Date().toISOString();
      this.discoveryLastError = null;
      this.discoveryRetry = null;
      this.discoveryExhausted = false;
      if (this.publicationNeededSince && !this.publicationPromise
        && !this.publicationRetryTimer && !this.publicationDebounceTimer) {
        void this.publish(0);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.discoveryLastError = message;
      this.logger.error(`[memberry-mcp] consolidation scope discovery failed (${this.name}): ${message}`);
      if (!this.stopped && attempt < this.config.maxRetries) {
        const delay = this.retryDelay(attempt);
        this.discoveryRetry = {
          attempt: attempt + 1,
          nextAt: new Date(Date.now() + delay).toISOString(),
        };
        this.discoveryRetryTimer = setTimeout(() => {
          this.discoveryRetryTimer = null;
          this.discoveryRetry = null;
          void this.catchUp(attempt + 1);
        }, delay);
        unref(this.discoveryRetryTimer);
      } else if (!this.stopped) {
        this.discoveryExhausted = true;
      }
    } finally {
      this.discovering = false;
    }
  }

  snapshot(): ConsolidationCoordinatorSnapshot {
    const enabled = this.config.enabled && !this.config.readonly;
    const outsideGrace = this.startedAt !== null
      && Date.now() - this.startedAt >= this.config.healthGraceMs;
    const stale = enabled && outsideGrace && (
      this.lastSuccessAt === null
      || Date.now() - Date.parse(this.lastSuccessAt) > this.config.staleAfterMs
    );
    const unhealthy = this.forceUnhealthy || (enabled && outsideGrace
      && (stale || this.exhaustedFailure || this.discoveryExhausted || this.publicationExhausted));
    const recovering = enabled && !unhealthy && (
      this.lastError !== null || this.retries.size > 0
      || this.discoveryLastError !== null || this.discoveryRetry !== null
      || this.publicationLastError !== null || this.publicationRetry !== null
    );
    const health: ConsolidationCoordinatorSnapshot['health'] = this.forceUnhealthy
      ? 'unhealthy'
      : !this.config.enabled
      ? 'disabled'
      : this.config.readonly
        ? 'readonly'
        : unhealthy
            ? 'unhealthy'
            : recovering
              ? 'recovering'
              : !outsideGrace && this.lastSuccessAt === null
                ? 'starting'
                : 'healthy';
    return {
      name: this.name,
      enabled: this.config.enabled,
      readonly: this.config.readonly,
      running_scope: this.runningScope,
      queued_scopes: [...this.queue.keys()].sort(),
      last_attempt_at: this.lastAttemptAt,
      last_success_at: this.lastSuccessAt,
      last_error: this.lastError ?? (this.discoveryLastError ? `scope discovery: ${this.discoveryLastError}` : null),
      limitation: this.limitation,
      health,
      stale,
      exhausted_failure: this.exhaustedFailure || this.discoveryExhausted,
      discovery: {
        last_error: this.discoveryLastError,
        pending_retry: this.discoveryRetry
          ? { attempt: this.discoveryRetry.attempt, next_at: this.discoveryRetry.nextAt }
          : null,
        exhausted_failure: this.discoveryExhausted,
      },
      publication: {
        needed_since: this.publicationNeededSince,
        last_success_at: this.publicationLastSuccessAt,
        last_error: this.publicationLastError,
        pending_retry: this.publicationRetry
          ? { attempt: this.publicationRetry.attempt, next_at: this.publicationRetry.nextAt }
          : null,
        exhausted_failure: this.publicationExhausted,
        dirty_version: this.publicationDirtyVersion,
        published_version: this.publicationPublishedVersion,
      },
      pending_retries: [...this.retries.entries()]
        .map(([scope, retry]) => ({ scope, attempt: retry.attempt, next_at: retry.nextAt }))
        .sort((a, b) => a.scope.localeCompare(b.scope)),
    };
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    if (this.discoveryRetryTimer) clearTimeout(this.discoveryRetryTimer);
    if (this.publicationRetryTimer) clearTimeout(this.publicationRetryTimer);
    if (this.publicationDebounceTimer) clearTimeout(this.publicationDebounceTimer);
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    this.retryTimers.clear();
    this.retries.clear();
    this.queue.clear();
    await this.drainPromise;
    await this.publicationPromise;
    coordinators.delete(this.name);
  }

  private enqueue(scope: string, attempt: number): void {
    if (this.stopped) return;
    const current = this.queue.get(scope);
    if (current === undefined || attempt < current) this.queue.set(scope, attempt);
    if (!this.drainPromise) {
      this.drainPromise = this.drain().finally(() => { this.drainPromise = null; });
    }
  }

  private async drain(): Promise<void> {
    while (!this.stopped && this.queue.size > 0) {
      const next = this.queue.entries().next().value as [string, number] | undefined;
      if (!next) return;
      const [scope, attempt] = next;
      this.queue.delete(scope);
      this.runningScope = scope;
      this.lastAttemptAt = new Date().toISOString();
      try {
        const result = await this.run(scope);
        if (result.skipped && result.reason === 'lock_held') {
          throw new Error('distributed consolidation lock is held');
        }
        this.lastSuccessAt = new Date().toISOString();
        this.lastError = null;
        this.exhaustedFailure = false;
        this.clearRetry(scope);
        if ((result.applied?.length ?? 0) > 0 && this.onMutation) {
          await this.schedulePublication();
        }
        this.logger.error(
          `[memberry-mcp] consolidation completed (${this.name}; scope=${scope}; applied=${result.applied?.length ?? 0})`,
        );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.lastError = `${scope}: ${message}`;
        this.logger.error(`[memberry-mcp] consolidation failed (${this.name}; scope=${scope}): ${message}`);
        this.scheduleRetry(scope, attempt + 1);
      } finally {
        this.runningScope = null;
      }
    }
  }

  private scheduleRetry(scope: string, attempt: number): void {
    this.clearRetry(scope);
    if (this.stopped) return;
    if (attempt > this.config.maxRetries) {
      this.exhaustedFailure = true;
      return;
    }
    const delay = this.retryDelay(attempt - 1);
    const nextAt = new Date(Date.now() + delay).toISOString();
    this.retries.set(scope, { attempt, nextAt });
    const timer = setTimeout(() => {
      this.retryTimers.delete(scope);
      this.retries.delete(scope);
      this.enqueue(scope, attempt);
    }, delay);
    this.retryTimers.set(scope, timer);
    unref(timer);
  }

  private clearRetry(scope: string): void {
    const timer = this.retryTimers.get(scope);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(scope);
    this.retries.delete(scope);
  }

  private retryDelay(zeroBasedAttempt: number): number {
    return Math.min(this.config.retryMaxMs, this.config.retryBaseMs * (2 ** zeroBasedAttempt));
  }

  /** Publication retries are independent: never re-run an already-applied graph mutation. */
  private async publish(attempt: number): Promise<void> {
    if (this.stopped || !this.onMutation) return;
    if (this.publicationPromise) {
      this.publicationQueued = true;
      return;
    }
    this.publicationPromise = (async () => {
      try {
        let compileVersion = this.publicationDirtyVersion;
        if (this.publicationState) {
          const versions = await this.publicationState.versions();
          this.publicationDirtyVersion = versions.dirty;
          this.publicationPublishedVersion = versions.published;
          compileVersion = versions.dirty;
          if (versions.dirty <= versions.published) {
            this.publicationNeededSince = null;
            this.publicationLastError = null;
            this.publicationExhausted = false;
            return;
          }
        }
        await this.onMutation?.();
        if (this.publicationState && compileVersion !== null) {
          await this.publicationState.markPublished(compileVersion);
          const latest = await this.publicationState.versions();
          this.publicationDirtyVersion = latest.dirty;
          this.publicationPublishedVersion = latest.published;
          if (latest.dirty > latest.published) this.publicationQueued = true;
        }
        this.publicationLastSuccessAt = new Date().toISOString();
        this.publicationLastError = null;
        this.publicationRetry = null;
        this.publicationExhausted = false;
        if (!this.publicationQueued) this.publicationNeededSince = null;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.publicationLastError = message;
        this.logger.error(`[memberry-mcp] wiki publication failed (${this.name}): ${message}`);
        this.publicationQueued = false;
        const nextAttempt = attempt + 1;
        if (nextAttempt > this.config.maxRetries) {
          this.publicationExhausted = true;
          return;
        }
        const delay = this.retryDelay(attempt);
        this.publicationRetry = {
          attempt: nextAttempt,
          nextAt: new Date(Date.now() + delay).toISOString(),
        };
        this.publicationRetryTimer = setTimeout(() => {
          this.publicationRetryTimer = null;
          this.publicationRetry = null;
          void this.publish(nextAttempt);
        }, delay);
        unref(this.publicationRetryTimer);
      }
    })();
    try {
      await this.publicationPromise;
    } finally {
      this.publicationPromise = null;
      if (this.publicationQueued && !this.publicationRetryTimer && !this.stopped) {
        this.publicationQueued = false;
        void this.publish(0);
      }
    }
  }

  private async recoverPublicationIntent(): Promise<void> {
    if (this.stopped || !this.onMutation || !this.publicationState) return;
    try {
      const versions = await this.publicationState.versions();
      this.publicationDirtyVersion = versions.dirty;
      this.publicationPublishedVersion = versions.published;
      if (versions.dirty > versions.published) {
        this.publicationNeededSince ??= new Date().toISOString();
        await this.publish(0);
      }
    } catch (error: unknown) {
      this.publicationLastError = `could not recover publication intent: ${error instanceof Error ? error.message : String(error)}`;
      this.publicationExhausted = true;
      this.logger.error(`[memberry-mcp] ${this.publicationLastError}`);
    }
  }
}
