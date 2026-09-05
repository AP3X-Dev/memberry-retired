import { isProxy } from 'node:util/types';

type JsonRecord = Record<string, unknown>;

/** D1/A6 datastore-probe readiness fields on `/readyz`. The three probe fields
 *  arrive together once the server registers a probe source; `retrieval` and
 *  `lifecycle` are reported only when their producers exist. A server without a
 *  probe source carries none of them. Live lab harnesses pin the exact readiness
 *  key list, so they consult this one place instead of each carrying a copy. */
export const READINESS_PROBE_KEYS = ['datastores', 'embeddings', 'degraded'] as const;
export const READINESS_OPTIONAL_PROBE_KEYS = ['retrieval', 'lifecycle'] as const;
const ALL_PROBE_KEYS: readonly string[] = [...READINESS_PROBE_KEYS, ...READINESS_OPTIONAL_PROBE_KEYS];
const EMBEDDINGS_STATES: readonly unknown[] = ['ok', 'disabled', 'degraded'];

function record(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isProxy(value)
    ? value as JsonRecord
    : undefined;
}

function has(body: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

/** The probe keys this body carries, for appending to a harness exact key list. */
export function presentReadinessProbeKeys(body: JsonRecord): string[] {
  return ALL_PROBE_KEYS.filter((key) => has(body, key));
}

/** True when the body carries either no probe fields at all, or exactly the
 *  closed probe shape with both datastores reachable. Anything looser fails. */
export function hasClosedReadinessProbeShapeV1(body: JsonRecord): boolean {
  const present = READINESS_PROBE_KEYS.filter((key) => has(body, key));
  if (present.length === 0) return !READINESS_OPTIONAL_PROBE_KEYS.some((key) => has(body, key));
  if (present.length !== READINESS_PROBE_KEYS.length) return false;
  const datastores = record(body.datastores);
  if (!datastores) return false;
  const keys = Reflect.ownKeys(datastores);
  if (keys.length !== 2 || datastores.neo4j !== 'ok' || datastores.redis !== 'ok') return false;
  if (!EMBEDDINGS_STATES.includes(body.embeddings)) return false;
  if (!Array.isArray(body.degraded) || !body.degraded.every((entry) => typeof entry === 'string')) return false;
  return READINESS_OPTIONAL_PROBE_KEYS.every((key) => !has(body, key) || record(body[key]) !== undefined);
}
