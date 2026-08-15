import {
  TrustedAdmissionPreprocessorV1,
  createAdmissionObservationV1,
  type AdmissionClock,
  type AdmissionObservationV1,
  type TrustedAdmissionInputV1,
} from './admission.js';

export const ADMISSION_SHADOW_DEFAULT_TIMEOUT_MS = 50;
export const ADMISSION_SHADOW_MAX_TIMEOUT_MS = 1_000;
export const ADMISSION_SHADOW_MAX_IN_FLIGHT = 32;
export const ADMISSION_SHADOW_MAX_DRAIN_MS = 1_000;

export interface AdmissionShadowConfig {
  readonly enabled: boolean;
  readonly timeoutMs: number;
}

export type AdmissionShadowConfigErrorCode = 'invalid_enabled' | 'invalid_timeout';

/** Closed configuration failures name only the field, never its supplied value. */
export class AdmissionShadowConfigError extends Error {
  constructor(readonly code: AdmissionShadowConfigErrorCode) {
    super(`admission_shadow_config:${code}`);
    this.name = 'AdmissionShadowConfigError';
  }
}

export function resolveAdmissionShadowConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AdmissionShadowConfig {
  const rawEnabled = env['MEMBERRY_ADMISSION_SHADOW_ENABLED']?.trim().toLowerCase();
  let enabled = false;
  if (rawEnabled && rawEnabled !== 'false') {
    if (rawEnabled !== 'true') throw new AdmissionShadowConfigError('invalid_enabled');
    enabled = true;
  }

  const rawTimeout = env['MEMBERRY_ADMISSION_SHADOW_TIMEOUT_MS']?.trim();
  let timeoutMs = ADMISSION_SHADOW_DEFAULT_TIMEOUT_MS;
  if (rawTimeout) {
    if (!/^[0-9]+$/.test(rawTimeout)) throw new AdmissionShadowConfigError('invalid_timeout');
    timeoutMs = Number(rawTimeout);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > ADMISSION_SHADOW_MAX_TIMEOUT_MS) {
      throw new AdmissionShadowConfigError('invalid_timeout');
    }
  }
  return Object.freeze({ enabled, timeoutMs });
}

export interface AdmissionObservationScope {
  readonly tenantId: string;
  readonly projectScope: string;
  readonly episodeId: string;
}

/** Structural boundary implemented by the Neo4j AdmissionObservationStore. */
export interface AdmissionObservationSink {
  persist(
    scope: AdmissionObservationScope,
    observation: AdmissionObservationV1,
  ): Promise<AdmissionObservationV1>;
}

export type AdmissionShadowAppendResult =
  | 'disabled'
  | 'stored'
  | 'failed'
  | 'timed-out'
  | 'capacity-rejected'
  | 'shutdown-skipped';

export interface AdmissionShadowAttempt {
  prepare(input: TrustedAdmissionInputV1): AdmissionObservationV1 | null;
  append(scope: AdmissionObservationScope, observation: AdmissionObservationV1): Promise<AdmissionShadowAppendResult>;
  cancel(): void;
}

/** Minimal dependency accepted by AMPService; all calls are still defensively contained there. */
export interface AdmissionShadowHook {
  readonly enabled: boolean;
  /** Reserve bounded capacity before AMPService reads any sensitivity input. */
  begin(): AdmissionShadowAttempt | null;
}

export type AdmissionShadowFailureCode =
  | 'preparation_failed'
  | 'append_failed'
  | 'timed_out'
  | 'capacity_rejected'
  | 'shutdown_skipped';

export interface AdmissionShadowSnapshot {
  readonly schemaVersion: 1;
  readonly enabled: boolean;
  readonly mode: 'disabled' | 'shadow';
  readonly health: 'disabled' | 'healthy' | 'degraded';
  readonly delivery: 'best-effort-bounded-terminal';
  readonly recovery: 'none';
  readonly completeness: 'not-provable';
  readonly durableRetry: false;
  readonly selfHealing: false;
  readonly historyComplete: false;
  readonly historyScope: 'process-lifetime';
  readonly crashGapPossible: boolean;
  readonly stopping: boolean;
  readonly timeoutMs: number;
  readonly maxInFlight: typeof ADMISSION_SHADOW_MAX_IN_FLIGHT;
  readonly reserved: number;
  readonly inFlight: number;
  readonly prepared: number;
  readonly preparationFailures: number;
  readonly appendAttempts: number;
  readonly appended: number;
  readonly appendFailures: number;
  readonly timedOut: number;
  readonly capacityRejected: number;
  readonly shutdownSkipped: number;
  readonly lateAppended: number;
  readonly lateFailures: number;
  readonly lastFailureCode: AdmissionShadowFailureCode | null;
}

export interface AdmissionShadowRuntimeOptions extends AdmissionShadowConfig {
  readonly sink?: AdmissionObservationSink;
  readonly clock?: AdmissionClock;
}

type Settled = 'stored' | 'failed';

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  try {
    const candidate = timer as ReturnType<typeof setTimeout> & { unref?: () => unknown };
    if (typeof candidate.unref === 'function') candidate.unref();
  } catch {
    // Timer liveness is an optimization only; never perturb the caller path.
  }
}

/**
 * Process-local, shadow-only admission observation runtime.
 *
 * It deliberately owns no queue, retry, scan, or healing loop. A process crash
 * after the episode commit can leave a gap until MEM-007 supplies durable
 * anti-entropy. Status counters are therefore process-lifetime lower bounds.
 */
export class AdmissionShadowRuntime implements AdmissionShadowHook {
  readonly enabled: boolean;
  private readonly timeoutMs: number;
  private readonly sink?: AdmissionObservationSink;
  private readonly clock: AdmissionClock;
  private readonly inFlight = new Set<Promise<Settled>>();
  private stopping = false;
  private reserved = 0;
  private prepared = 0;
  private preparationFailures = 0;
  private appendAttempts = 0;
  private appended = 0;
  private appendFailures = 0;
  private timedOut = 0;
  private capacityRejected = 0;
  private shutdownSkipped = 0;
  private lateAppended = 0;
  private lateFailures = 0;
  private lastFailureCode: AdmissionShadowFailureCode | null = null;

  constructor(options: AdmissionShadowRuntimeOptions) {
    if (typeof options.enabled !== 'boolean') throw new AdmissionShadowConfigError('invalid_enabled');
    if (!Number.isSafeInteger(options.timeoutMs)
      || options.timeoutMs < 1
      || options.timeoutMs > ADMISSION_SHADOW_MAX_TIMEOUT_MS) {
      throw new AdmissionShadowConfigError('invalid_timeout');
    }
    this.enabled = options.enabled;
    this.timeoutMs = options.timeoutMs;
    this.sink = options.sink;
    this.clock = options.clock ?? { now: () => new Date() };
  }

  begin(): AdmissionShadowAttempt | null {
    if (!this.enabled) return null;
    if (this.stopping) {
      this.shutdownSkipped += 1;
      this.lastFailureCode = 'shutdown_skipped';
      return null;
    }
    if (this.reserved + this.inFlight.size >= ADMISSION_SHADOW_MAX_IN_FLIGHT) {
      this.capacityRejected += 1;
      this.lastFailureCode = 'capacity_rejected';
      return null;
    }

    this.reserved += 1;
    let active = true;
    let prepared = false;
    const release = (): boolean => {
      if (!active) return false;
      active = false;
      this.reserved -= 1;
      return true;
    };

    return Object.freeze({
      prepare: (input: TrustedAdmissionInputV1): AdmissionObservationV1 | null => {
        if (!active || prepared) return null;
        try {
          const safeFacts = new TrustedAdmissionPreprocessorV1().preprocess(input);
          const observation = createAdmissionObservationV1({ safeFacts }, this.clock);
          this.prepared += 1;
          prepared = true;
          return observation;
        } catch {
          this.preparationFailures += 1;
          this.lastFailureCode = 'preparation_failed';
          release();
          return null;
        }
      },
      append: async (
        scope: AdmissionObservationScope,
        observation: AdmissionObservationV1,
      ): Promise<AdmissionShadowAppendResult> => {
        if (!active) return 'failed';
        if (!prepared) {
          release();
          this.appendFailures += 1;
          this.lastFailureCode = 'append_failed';
          return 'failed';
        }
        if (this.stopping) {
          release();
          this.shutdownSkipped += 1;
          this.lastFailureCode = 'shutdown_skipped';
          return 'shutdown-skipped';
        }
        release();
        return this.persist(scope, observation);
      },
      cancel: (): void => { release(); },
    });
  }

  private async persist(
    scope: AdmissionObservationScope,
    observation: AdmissionObservationV1,
  ): Promise<AdmissionShadowAppendResult> {
    this.appendAttempts += 1;
    if (!this.sink) {
      this.appendFailures += 1;
      this.lastFailureCode = 'append_failed';
      return 'failed';
    }
    let exceededDeadline = false;
    let tracked!: Promise<Settled>;
    tracked = Promise.resolve()
      .then(() => this.sink!.persist(scope, observation))
      .then(
        (): Settled => {
          if (exceededDeadline) this.lateAppended += 1;
          return 'stored';
        },
        (): Settled => {
          if (exceededDeadline) {
            this.lateFailures += 1;
            this.lastFailureCode = 'append_failed';
          }
          return 'failed';
        },
      )
      .finally(() => {
        this.inFlight.delete(tracked);
      });
    this.inFlight.add(tracked);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'timed-out'>((resolve) => {
      timer = setTimeout(() => resolve('timed-out'), this.timeoutMs);
      unrefTimer(timer);
    });
    try {
      const outcome = await Promise.race([tracked, deadline]);
      if (outcome === 'timed-out') {
        exceededDeadline = true;
        this.timedOut += 1;
        this.lastFailureCode = 'timed_out';
        return 'timed-out';
      }
      if (outcome === 'stored') {
        this.appended += 1;
        return 'stored';
      }
      this.appendFailures += 1;
      this.lastFailureCode = 'append_failed';
      return 'failed';
    } catch {
      // `tracked` is deliberately rejection-free, but contain hostile thenables
      // and platform failures here as a final non-interference boundary.
      this.appendFailures += 1;
      this.lastFailureCode = 'append_failed';
      return 'failed';
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async stopAndDrain(requestedMs = ADMISSION_SHADOW_MAX_DRAIN_MS): Promise<void> {
    this.stopping = true;
    if (this.inFlight.size === 0) return;
    const timeoutMs = Number.isFinite(requestedMs)
      ? Math.max(0, Math.min(Math.floor(requestedMs), ADMISSION_SHADOW_MAX_DRAIN_MS))
      : ADMISSION_SHADOW_MAX_DRAIN_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      unrefTimer(timer);
    });
    try {
      await Promise.race([
        Promise.allSettled([...this.inFlight]).then(() => undefined),
        deadline,
      ]);
    } catch {
      // Shutdown is best effort and must continue to the shared driver close.
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  snapshot(): AdmissionShadowSnapshot {
    const degraded = this.preparationFailures + this.appendFailures + this.timedOut
      + this.capacityRejected + this.shutdownSkipped + this.lateFailures > 0;
    return Object.freeze({
      schemaVersion: 1,
      enabled: this.enabled,
      mode: this.enabled ? 'shadow' : 'disabled',
      health: this.enabled ? (degraded ? 'degraded' : 'healthy') : 'disabled',
      delivery: 'best-effort-bounded-terminal',
      recovery: 'none',
      completeness: 'not-provable',
      durableRetry: false,
      selfHealing: false,
      historyComplete: false,
      historyScope: 'process-lifetime',
      crashGapPossible: this.enabled,
      stopping: this.stopping,
      timeoutMs: this.timeoutMs,
      maxInFlight: ADMISSION_SHADOW_MAX_IN_FLIGHT,
      reserved: this.reserved,
      inFlight: this.inFlight.size,
      prepared: this.prepared,
      preparationFailures: this.preparationFailures,
      appendAttempts: this.appendAttempts,
      appended: this.appended,
      appendFailures: this.appendFailures,
      timedOut: this.timedOut,
      capacityRejected: this.capacityRejected,
      shutdownSkipped: this.shutdownSkipped,
      lateAppended: this.lateAppended,
      lateFailures: this.lateFailures,
      lastFailureCode: this.lastFailureCode,
    });
  }
}
