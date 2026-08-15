import { isProxy } from 'node:util/types';

interface AdmissionShadowStatusSnapshot {
  readonly enabled: boolean;
  readonly health: 'disabled' | 'healthy' | 'degraded';
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
  readonly reserved: number;
  readonly inFlight: number;
  readonly stopping: boolean;
  readonly lastFailureCode: string | null;
  readonly timeoutMs: number;
  readonly maxInFlight: number;
}

export interface AdmissionShadowStatusSource {
  snapshot(): AdmissionShadowStatusSnapshot;
}

const sources = new Map<AdmissionShadowStatusSource, number>();
const CLOSED_FAILURE_CODES = new Set([
  'preparation_failed',
  'append_failed',
  'timed_out',
  'capacity_rejected',
  'shutdown_skipped',
]);

function hasDataSnapshotMethod(source: unknown): source is AdmissionShadowStatusSource {
  if ((typeof source !== 'object' && typeof source !== 'function') || source === null || isProxy(source)) return false;
  try {
    let cursor: object | null = source as object;
    for (let depth = 0; cursor !== null && depth < 8; depth++) {
      const descriptor = Object.getOwnPropertyDescriptor(cursor, 'snapshot');
      if (descriptor) return 'value' in descriptor && typeof descriptor.value === 'function';
      cursor = Object.getPrototypeOf(cursor);
    }
  } catch {
    return false;
  }
  return false;
}

function decrementSource(source: AdmissionShadowStatusSource): void {
  const count = sources.get(source);
  if (count === undefined) return;
  if (count <= 1) sources.delete(source);
  else sources.set(source, count - 1);
}

/** Atomically registers the default and all dedicated runtime status sources. */
export function registerAdmissionShadowStatusSources(
  candidates: readonly AdmissionShadowStatusSource[],
): () => void {
  const unique: AdmissionShadowStatusSource[] = [];
  const seen = new Set<AdmissionShadowStatusSource>();
  for (const candidate of candidates) {
    if (!hasDataSnapshotMethod(candidate)) throw new Error('admission_shadow_status:invalid_source');
    if (!seen.has(candidate)) {
      seen.add(candidate);
      unique.push(candidate);
    }
  }

  const registered: AdmissionShadowStatusSource[] = [];
  try {
    for (const source of unique) {
      sources.set(source, (sources.get(source) ?? 0) + 1);
      registered.push(source);
    }
  } catch {
    for (const source of registered.reverse()) decrementSource(source);
    throw new Error('admission_shadow_status:registration_failed');
  }

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    for (const source of registered) decrementSource(source);
  };
}

export function registerAdmissionShadowStatusSource(source: AdmissionShadowStatusSource): () => void {
  return registerAdmissionShadowStatusSources([source]);
}

function sum(snapshots: readonly AdmissionShadowStatusSnapshot[], key: keyof AdmissionShadowStatusSnapshot): number {
  return snapshots.reduce((total, snapshot) => {
    const value = snapshot[key];
    return total + (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  }, 0);
}

/** Authenticated readiness detail. It intentionally contains no worker names or locators. */
export function getAdmissionShadowProcessStatus(): Record<string, unknown> {
  const snapshots = [...sources.keys()].map((source) => {
    try {
      const snapshot = source.snapshot();
      // Read every property within the containment boundary so an exotic or
      // proxy status source cannot break /readyz or reflect its thrown value.
      const timeoutMs = snapshot.timeoutMs;
      const maxInFlight = snapshot.maxInFlight;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1_000
        || !Number.isSafeInteger(maxInFlight) || maxInFlight < 1 || maxInFlight > 1_024) return null;
      return {
        enabled: snapshot.enabled === true,
        health: snapshot.health,
        prepared: snapshot.prepared,
        preparationFailures: snapshot.preparationFailures,
        appendAttempts: snapshot.appendAttempts,
        appended: snapshot.appended,
        appendFailures: snapshot.appendFailures,
        timedOut: snapshot.timedOut,
        capacityRejected: snapshot.capacityRejected,
        shutdownSkipped: snapshot.shutdownSkipped,
        lateAppended: snapshot.lateAppended,
        lateFailures: snapshot.lateFailures,
        reserved: snapshot.reserved,
        inFlight: snapshot.inFlight,
        stopping: snapshot.stopping === true,
        lastFailureCode: typeof snapshot.lastFailureCode === 'string'
          && CLOSED_FAILURE_CODES.has(snapshot.lastFailureCode)
          ? snapshot.lastFailureCode
          : null,
        timeoutMs,
        maxInFlight,
      } satisfies AdmissionShadowStatusSnapshot;
    } catch { return null; }
  }).filter((snapshot): snapshot is AdmissionShadowStatusSnapshot => snapshot !== null);
  const enabled = snapshots.some((snapshot) => snapshot.enabled);
  const degraded = snapshots.some((snapshot) => snapshot.enabled && snapshot.health === 'degraded');
  const lastFailureCode = [...snapshots].reverse()
    .find((snapshot) => snapshot.lastFailureCode !== null)?.lastFailureCode ?? null;
  const timeoutMs = [...new Set(snapshots.map((snapshot) => snapshot.timeoutMs))]
    .sort((a, b) => a - b);
  const aggregateMaxInFlight = snapshots.reduce((total, snapshot) => total + snapshot.maxInFlight, 0);
  return {
    schema_version: 1,
    enabled,
    mode: enabled ? 'shadow' : 'disabled',
    health: enabled ? (degraded ? 'degraded' : 'healthy') : 'disabled',
    affects_readiness: false,
    delivery: 'best-effort-bounded-terminal',
    recovery: 'none',
    completeness: 'not-provable',
    durable_retry: false,
    self_healing: false,
    history_complete: false,
    history_scope: 'process-lifetime',
    crash_gap_possible: enabled,
    stopping: snapshots.some((snapshot) => snapshot.stopping),
    last_failure_code: lastFailureCode,
    registered_runtimes: snapshots.length,
    timeout_ms: timeoutMs,
    max_in_flight: Number.isSafeInteger(aggregateMaxInFlight) ? aggregateMaxInFlight : null,
    counters: {
      prepared: sum(snapshots, 'prepared'),
      preparation_failures: sum(snapshots, 'preparationFailures'),
      append_attempts: sum(snapshots, 'appendAttempts'),
      appended: sum(snapshots, 'appended'),
      append_failures: sum(snapshots, 'appendFailures'),
      timed_out: sum(snapshots, 'timedOut'),
      capacity_rejected: sum(snapshots, 'capacityRejected'),
      shutdown_skipped: sum(snapshots, 'shutdownSkipped'),
      late_appended: sum(snapshots, 'lateAppended'),
      late_failures: sum(snapshots, 'lateFailures'),
      reserved: sum(snapshots, 'reserved'),
      in_flight: sum(snapshots, 'inFlight'),
    },
  };
}
