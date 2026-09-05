// packages/core/src/config/bool-flag.ts
//
// Single boolean-env parser for every MEMBERRY_* on/off flag. The mode is a
// deliberate safety asymmetry (audit A7; PRP §8.4):
//
// - PROTECTIONS (MEMBERRY_READONLY, MEMBERRY_REDACT_ON_INGEST,
//   MEMBERRY_CONSOLIDATION_ENABLED, ...) parse LOOSE: `1|true|yes|on`,
//   case-insensitive, trimmed. An operator writing `=1` must never silently
//   turn a protection off.
// - RELAXATIONS (MEMBERRY_ALLOW_UNAUTHENTICATED, MEMBERRY_ALLOW_DEFAULT_TENANT)
//   parse STRICT: only the exact string `true`. A typo must never open the
//   server.
//
// Unset / blank / unrecognised values return `fallback` in both modes.

const LOOSE_TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export function parseBoolFlag(
  raw: string | undefined,
  fallback: boolean,
  opts: { strict?: boolean } = {},
): boolean {
  if (raw === undefined) return fallback;
  if (opts.strict) return raw === 'true';
  const value = raw.trim().toLowerCase();
  return value === '' ? fallback : LOOSE_TRUTHY.has(value);
}
