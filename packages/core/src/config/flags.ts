// packages/core/src/config/flags.ts
//
// Single source of truth for every MEMBERRY_* environment variable read
// anywhere under packages/*/src (item 20a). `flags.inventory.test.ts` greps the
// source tree and fails on any read that is not declared here, and on any entry
// here that no longer has a read site. This file DECLARES; it never reads env
// and never changes a default — `default` records what the read site applies.
//
// `kind`: bool | int | string | mode | path | secret. Floats and JSON blobs are
// `string` (the doc says so). `owner` is the package holding the primary read.

export type MemberryFlagKind = 'bool' | 'int' | 'string' | 'mode' | 'path' | 'secret';
export type MemberryFlagOwner =
  | 'core' | 'mcp' | 'retrieval' | 'neo4j' | 'redis' | 'code' | 'arch' | 'wiki' | 'graph' | 'research' | 'bench';

export interface MemberryFlag {
  readonly name: string;
  readonly kind: MemberryFlagKind;
  /** The value the code applies when the variable is unset, as a string. */
  readonly default: string;
  readonly doc: string;
  readonly owner: MemberryFlagOwner;
}

const f = (
  name: string,
  kind: MemberryFlagKind,
  def: string,
  owner: MemberryFlagOwner,
  doc: string,
): MemberryFlag => ({ name, kind, default: def, doc, owner });

export const MEMBERRY_FLAGS: ReadonlyArray<MemberryFlag> = Object.freeze([
  // ── core: admission (MEM-002 / MEM-FR-3) ─────────────────────────────────
  f('MEMBERRY_ADMISSION_FEATURE_PRODUCER_V1', 'mode', 'disabled', 'core',
    'Safe-facts feature producer inside the routing shadow: disabled|live (exact strings; live requires MEMBERRY_ADMISSION_ROUTING_V1=shadow).'),
  f('MEMBERRY_ADMISSION_ROUTING_V1', 'mode', 'disabled', 'core',
    'Five-tier admission routing staging flag: disabled|shadow (exact; "served" is rejected as not qualified).'),
  f('MEMBERRY_ADMISSION_ROUTING_PROTECTED_SENSITIVITY_MIN_PERMILLE', 'int', '500', 'core',
    'Routing threshold (digits only, permille): sensitivity at/above this routes protected.'),
  f('MEMBERRY_ADMISSION_ROUTING_CANDIDATE_DURABILITY_MIN_PERMILLE', 'int', '600', 'core',
    'Routing threshold (permille): minimum durability for the candidate tier.'),
  f('MEMBERRY_ADMISSION_ROUTING_CANDIDATE_EVIDENCE_QUALITY_MIN_PERMILLE', 'int', '600', 'core',
    'Routing threshold (permille): minimum evidence quality for the candidate tier.'),
  f('MEMBERRY_ADMISSION_ROUTING_DISCARD_SALIENCE_MAX_PERMILLE', 'int', '100', 'core',
    'Routing threshold (permille): salience at/below this may route to discard.'),
  f('MEMBERRY_ADMISSION_ROUTING_DISCARD_DURABILITY_MAX_PERMILLE', 'int', '200', 'core',
    'Routing threshold (permille): durability at/below this may route to discard (must be <= working max).'),
  f('MEMBERRY_ADMISSION_ROUTING_WORKING_DURABILITY_MAX_PERMILLE', 'int', '300', 'core',
    'Routing threshold (permille): durability at/below this routes to working (must be < candidate min).'),
  f('MEMBERRY_ADMISSION_SHADOW_ENABLED', 'bool', 'false', 'core',
    'Run the admission shadow evaluator alongside the baseline route: true|false only (anything else throws at boot).'),
  f('MEMBERRY_ADMISSION_SHADOW_TIMEOUT_MS', 'int', '50', 'core',
    'Per-episode admission shadow budget in ms, digits only, 1..1000.'),

  // ── core: confidence calibration (MEM-004) ───────────────────────────────
  f('MEMBERRY_CALIBRATION_REINFORCEMENT_WEIGHT', 'int', '10', 'core',
    'Calibration signal weight for reinforcements (digits only).'),
  f('MEMBERRY_CALIBRATION_CORRECTION_WEIGHT', 'int', '50', 'core',
    'Calibration signal weight for corrections (digits only).'),
  f('MEMBERRY_CALIBRATION_CONTRADICTION_WEIGHT', 'int', '30', 'core',
    'Calibration signal weight for contradictions (digits only).'),
  f('MEMBERRY_CALIBRATION_MIN_SIGNAL_WEIGHT', 'int', '10', 'core',
    'Minimum summed signal weight before a node counts as observed (raw weight units, not permille).'),

  // ── core: lifecycle (MEM-006 / MEM-007 / MEM-006H) ───────────────────────
  f('MEMBERRY_LIFECYCLE_V1', 'mode', 'disabled', 'core',
    'Lifecycle pass gate: disabled|live; unrecognised values warn and disable.'),
  f('MEMBERRY_LIFECYCLE_ANTIENTROPY', 'mode', 'disabled', 'core',
    'Anti-entropy sub-pass (re-link/reclaim/GC only): disabled|live.'),
  f('MEMBERRY_LIFECYCLE_HEBBIAN', 'mode', 'disabled', 'core',
    'Hebbian usage-modulated decay sub-pass: disabled|live.'),
  f('MEMBERRY_LIFECYCLE_DRY_RUN', 'bool', 'false', 'core',
    'Lifecycle pass reports without mutating: loose bool (1|true|yes|on).'),
  f('MEMBERRY_LIFECYCLE_EXPORT_DIR', 'path', '<MEMBERRY_EXPORT_PATH>', 'core',
    'Root for export-before-mutate lifecycle artifacts; blank throws; default is the memory export path.'),
  f('MEMBERRY_LIFECYCLE_SIDECAR_BUDGET', 'int', '5000', 'core',
    'Per-(tenant, scope, label) non-protected sidecar row budget, 100..1000000; malformed throws.'),
  f('MEMBERRY_LIFECYCLE_SIDECAR_MAX_AGE_DAYS', 'int', '180', 'core',
    'Non-protected sidecar rows older than this are deleted regardless of budget, 7..3650.'),
  f('MEMBERRY_LIFECYCLE_ARCHIVE_HALFLIFE_MULTIPLIER', 'int', '2', 'core',
    'Archive at half_life x multiplier, 1..10.'),
  f('MEMBERRY_LIFECYCLE_DECAY_CONFIDENCE_FLOOR', 'string', '0.1', 'core',
    'Float 0.01..0.5: decay proposals never propose confidence below this.'),
  f('MEMBERRY_LIFECYCLE_MAX_DECAY_PROPOSALS_PER_SCOPE', 'int', '25', 'core',
    'Per-(tenant, scope) cap on emitted decay proposals, 1..500.'),
  f('MEMBERRY_LIFECYCLE_DECAY_COOLDOWN_DAYS', 'int', '30', 'core',
    'No decay re-emission for a node within this many days of decay_proposed_at, 1..365.'),
  f('MEMBERRY_LIFECYCLE_BATCH_ROWS', 'int', '1000', 'core',
    'Batch size for IN TRANSACTIONS lifecycle mutations, 100..10000.'),
  f('MEMBERRY_ANTIENTROPY_CONSUMER_GC_IDLE_MS', 'int', '604800000', 'core',
    'Idle ms before a Redis stream consumer name is GC-eligible, 3600000..31536000000 (7d default).'),

  // ── core: consolidation / promotion ──────────────────────────────────────
  f('MEMBERRY_CONSOLIDATION_AUTO_APPLY', 'bool', 'false', 'core',
    'Auto-apply corroborated promotions and positive reinforcement instead of queuing for review; loose bool.'),
  f('MEMBERRY_FACT_PROTECT_CONFIDENCE', 'string', '0.75', 'core',
    'Float clamped to 0..1: facts at/above this confidence are not overwritten by lower-confidence extraction contradictions.'),
  f('MEMBERRY_PROMOTE_MIN_CLUSTER', 'int', '3', 'core',
    'Minimum episodic cluster size to promote to a semantic, clamped 2..50.'),
  f('MEMBERRY_PROMOTE_SIMILARITY', 'string', '0.82', 'core',
    'Float clamped 0..1: cosine similarity threshold for promotion clustering.'),
  f('MEMBERRY_PROMOTE_MAX_PER_RUN', 'int', '3', 'core',
    'Maximum promotions per consolidation run, clamped 0..50.'),
  f('MEMBERRY_PROMOTE_MAX_CANDIDATES', 'int', '200', 'core',
    'Maximum episodic candidates scanned per promotion run, clamped 10..2000.'),

  // ── core: service / protections ──────────────────────────────────────────
  f('MEMBERRY_READONLY', 'bool', 'false', 'core',
    'Reject every write path (store, block mutations, consolidation); loose bool.'),
  f('MEMBERRY_REDACT_ON_INGEST', 'bool', 'false', 'core',
    'Secret-redact episode content before persistence (core store and wiki ingest); loose bool.'),
  f('MEMBERRY_REQUIRE_PROJECT_TAG', 'bool', 'true', 'core',
    'Require a project:<tag> on every store; only the exact string "false" disables.'),
  f('MEMBERRY_EMBEDDING_DIM', 'int', '1536', 'core',
    'Vector index dimension, integer 8..12288; invalid values log and fall back (legacy AMP_EMBEDDING_DIM honoured).'),
  f('MEMBERRY_EXPORT_PATH', 'path', './.memberry', 'core',
    'On-disk memory export directory; default ./.memberry when present, else legacy ./.amp.'),
  f('MEMBERRY_MODEL_EXTRACTION', 'string', 'gpt-4o-mini', 'core',
    'LLM model override for fact extraction.'),
  f('MEMBERRY_MODEL_SYNTHESIS', 'string', 'gpt-4o', 'core',
    'LLM model override for berry_ask synthesis.'),
  f('MEMBERRY_MODEL_DREAM', 'string', 'gpt-4o', 'core',
    'LLM model override for the dream engine.'),
  f('MEMBERRY_INGEST_ALLOW_DIR', 'path', '<process.cwd()>', 'core',
    'Confinement base for ingest/index/watch/compile paths (e.g. /workspace in docker).'),
  f('MEMBERRY_SETTINGS_PATH', 'path', '~/.config/memberry/settings.json', 'core',
    'Persisted hook-settings file the wiki UI writes and hook CLIs read (legacy ~/.config/amp fallback).'),

  // ── core: hooks / CLI ────────────────────────────────────────────────────
  f('MEMBERRY_HOOK_TIMEOUT_MS', 'int', '800', 'core',
    'Per-turn UserPromptSubmit load budget in ms (env > settings file > default; floor 50).'),
  f('MEMBERRY_HOOK_TURN_TOKENS', 'int', '1500', 'core',
    'Token budget for per-turn injected context (env > settings file > default; floor 200).'),
  f('MEMBERRY_HOOK_SESSION_TIMEOUT_MS', 'int', '8000', 'core',
    'SessionStart load budget in ms (env > settings file > default).'),
  f('MEMBERRY_MCP_URL', 'string', 'http://<MEMBERRY_PUBLIC_HOST>:<MCP_PORT>/mcp', 'core',
    'MCP endpoint used by the configure/doctor/project CLIs when --url is not passed.'),
  f('MEMBERRY_PUBLIC_HOST', 'string', 'localhost', 'core',
    'Host the CLIs compose into the default MCP URL when MEMBERRY_MCP_URL is unset.'),
  f('MEMBERRY_INDEXER_BASE_URL', 'string', 'http://127.0.0.1:11434/v1', 'core',
    'OpenAI-compatible endpoint for the structured-index CLI (--endpoint overrides).'),
  f('MEMBERRY_INDEXER_MODEL', 'string', 'qwen2.5:3b-instruct', 'core',
    'Model name for the structured-index CLI (--model overrides).'),

  // ── mcp: auth / tenancy ──────────────────────────────────────────────────
  f('MEMBERRY_API_TOKEN', 'secret', '', 'mcp',
    'Global bearer token; unset generates a per-process session token (also read by the CLIs and readyz check).'),
  f('MEMBERRY_API_TOKENS', 'secret', '', 'mcp',
    'Per-actor named tokens "alice:tokA,bob:tokB".'),
  f('MEMBERRY_TENANT_TOKENS', 'secret', '', 'mcp',
    'Per-tenant tokens "acme:tokA,globex:tokB"; presence enables logical multi-tenancy and disables the wiki compiler.'),
  f('MEMBERRY_TENANT_DATASTORES', 'secret', '', 'mcp',
    'JSON map tenant -> { neo4jUri, neo4jPassword, redisUrl, neo4jUser?, openaiKey? } for dedicated-datastore tenants.'),
  f('MEMBERRY_ALLOW_UNAUTHENTICATED', 'bool', 'false', 'mcp',
    'Accept unauthenticated requests; strict bool (only the exact string "true").'),
  f('MEMBERRY_ALLOW_DEFAULT_TENANT', 'bool', 'false', 'mcp',
    'Let non-tenant tokens fall back to the default tenant; strict bool (only "true").'),
  f('MEMBERRY_CAPABILITY_POLICIES_V1', 'string', '', 'mcp',
    'JSON capability-policy runtime config; unset means no policy lookup.'),

  // ── mcp: HTTP server ─────────────────────────────────────────────────────
  f('MEMBERRY_HOST', 'string', '', 'mcp',
    'Bind interface for the MCP server (falls back to HOST; unset binds all interfaces).'),
  f('MEMBERRY_MAX_BODY_BYTES', 'int', '1000000', 'mcp',
    'Maximum POST body bytes; non-positive/unparseable falls back.'),
  f('MEMBERRY_HTTP_HEADERS_TIMEOUT_MS', 'int', '20000', 'mcp',
    'Node headersTimeout (slowloris guard); positive int.'),
  f('MEMBERRY_HTTP_REQUEST_TIMEOUT_MS', 'int', '30000', 'mcp',
    'Node requestTimeout; clamped up to headersTimeout.'),
  f('MEMBERRY_HTTP_KEEPALIVE_TIMEOUT_MS', 'int', '10000', 'mcp',
    'Node keepAliveTimeout; positive int.'),
  f('MEMBERRY_SHUTDOWN_TIMEOUT_MS', 'int', '5000', 'mcp',
    'Grace period for in-flight requests on SIGTERM/SIGINT before forced exit.'),

  // ── mcp: retrieval staging flags (read once at bootstrap) ────────────────
  f('MEMBERRY_QUERY_PLANNER_V1', 'bool', '0', 'mcp',
    'Enable the query planner; exact "1" only.'),
  f('MEMBERRY_CANDIDATE_CHANNEL_V1', 'bool', '0', 'mcp',
    'Enable the candidate retrieval channel; exact "1" only.'),
  f('MEMBERRY_MULTIHOP_EXPANSION_V1', 'bool', '0', 'mcp',
    'RET-007 v4 second retrieval pass over the memory channel; exact "1" only.'),
  f('MEMBERRY_EPISODIC_RECALL_V1', 'bool', '0', 'mcp',
    'Enable episodic recall channel; exact "1" only.'),
  f('MEMBERRY_EPISODIC_IDENTIFIER_RESERVE_V1', 'bool', '0', 'mcp',
    'Reserve identifier slots for episodic recall; exact "1" only.'),
  f('MEMBERRY_RERANKER_V1', 'mode', 'disabled', 'mcp',
    'Memory-plane reranker: disabled|shadow|served (shadow/served require planner + candidate channel).'),

  // ── mcp: consolidation coordinator ───────────────────────────────────────
  f('MEMBERRY_CONSOLIDATION_ENABLED', 'bool', 'true', 'mcp',
    'Run the in-process consolidation coordinator; loose bool.'),
  f('MEMBERRY_CONSOLIDATION_STARTUP_DELAY_MS', 'int', '2000', 'mcp',
    'Delay before the first consolidation pass (>= 0).'),
  f('MEMBERRY_CONSOLIDATION_DEBOUNCE_MS', 'int', '5000', 'mcp',
    'Debounce window after a store before consolidating (>= 0).'),
  f('MEMBERRY_CONSOLIDATION_INTERVAL_MS', 'int', '900000', 'mcp',
    'Catch-up interval between consolidation passes (>= 1).'),
  f('MEMBERRY_CONSOLIDATION_RETRY_BASE_MS', 'int', '1000', 'mcp',
    'Base backoff for a failed consolidation run.'),
  f('MEMBERRY_CONSOLIDATION_RETRY_MAX_MS', 'int', '60000', 'mcp',
    'Backoff ceiling for a failed consolidation run.'),
  f('MEMBERRY_CONSOLIDATION_MAX_RETRIES', 'int', '5', 'mcp',
    'Retries before a consolidation scope is marked unhealthy (>= 0).'),
  f('MEMBERRY_CONSOLIDATION_HEALTH_GRACE_MS', 'int', '120000', 'mcp',
    'Grace period before consolidation failures affect /readyz (>= 0).'),
  f('MEMBERRY_CONSOLIDATION_STALE_AFTER_MS', 'int', '3600000', 'mcp',
    'Age after which a scope with no successful run is reported stale.'),

  // ── mcp: lifecycle scheduler / boot ──────────────────────────────────────
  f('MEMBERRY_LIFECYCLE_INTERVAL_MS', 'int', '86400000', 'mcp',
    'Lifecycle pass cadence in ms when MEMBERRY_LIFECYCLE_V1=live; minimum 3600000, invalid falls back (warns once).'),
  f('MEMBERRY_CODE_WATCH_ON_BOOT', 'bool', 'false', 'mcp',
    'Re-arm the code watcher at boot for persisted project root_paths; loose bool.'),

  // ── mcp: readyz check CLI ────────────────────────────────────────────────
  f('MEMBERRY_READYZ_PROTOCOL', 'string', 'http', 'mcp',
    'Scheme for the composed /readyz URL.'),
  f('MEMBERRY_READYZ_HOST', 'string', '127.0.0.1', 'mcp',
    'Host for the composed /readyz URL.'),
  f('MEMBERRY_READYZ_URL', 'string', '<protocol>://<host>:<port>/readyz', 'mcp',
    'Full /readyz URL override for the readiness check.'),
  f('MEMBERRY_READYZ_TIMEOUT_MS', 'int', '15000', 'mcp',
    'Total time the readiness check waits for ready.'),
  f('MEMBERRY_READYZ_INTERVAL_MS', 'int', '500', 'mcp',
    'Poll interval of the readiness check.'),

  // ── wiki ─────────────────────────────────────────────────────────────────
  f('MEMBERRY_WIKI_AUTOREFRESH', 'bool', 'false', 'wiki',
    'Recompile the wiki after ingest/index when the output dir exists; loose bool; forced off under MEMBERRY_TENANT_TOKENS.'),
  f('MEMBERRY_WIKI_OUTPUT_DIR', 'path', '/app/wiki', 'wiki',
    'Compiled wiki output directory (server autorefresh default /app/wiki; berry_compile default ./wiki).'),
  f('MEMBERRY_WIKI_HOST', 'string', '', 'wiki',
    'Bind interface for the wiki viewer (falls back to MEMBERRY_HOST, then HOST).'),
  f('MEMBERRY_WIKI_PUBLIC_LABEL', 'string', '', 'wiki',
    'Optional footer label (e.g. public host) shown by the wiki viewer.'),

  // ── retrieval ────────────────────────────────────────────────────────────
  f('MEMBERRY_ASK_MAX_EVIDENCE_ITEM_CHARS', 'int', '4000', 'retrieval',
    'Per-item cap on evidence chars fed to berry_ask synthesis; positive int.'),
  f('MEMBERRY_EPISODIC_STRUCTURED_INDEX_V1', 'bool', '0', 'retrieval',
    'Use the episodic structured index in the candidate channel; exact "1" only.'),
  f('MEMBERRY_TRACE_VALIDATION_DIAGNOSTICS', 'mode', '', 'retrieval',
    'Set to "enabled" to print the failing trace-validation stage to stderr.'),

  // ── code ─────────────────────────────────────────────────────────────────
  f('MEMBERRY_KIND_RANK_V1', 'bool', '0', 'code',
    'IDX-002A kind/test-path rank prior in code search; exact "1", read once at module load.'),
  f('MEMBERRY_CODE_SCOPE_V2', 'bool', '0', 'code',
    'IDX-002B scope non-code rows out of code search; exact "1", read once at module load.'),
  f('MEMBERRY_CODE_RERANK_V1', 'bool', '0', 'code',
    'IDX-004 retrieve-wide-then-rerank for berry_code_search (caller must also pass rerank:true); exact "1".'),
  f('MEMBERRY_MAX_PARSE_FILE_BYTES', 'int', '2097152', 'code',
    'Skip tree-sitter parsing of files larger than this; positive int.'),

  // ── neo4j ────────────────────────────────────────────────────────────────
  f('MEMBERRY_RAW_CYPHER_TIMEOUT_MS', 'int', '15000', 'neo4j',
    'Transaction timeout applied to every raw Cypher path (berry_query, grep); positive int.'),
  f('MEMBERRY_STRICT_TENANT', 'bool', '0', 'neo4j',
    'Discovery mode: throw when resolveTenant() is reached without a tenant; exact "1".'),

  // ── redis ────────────────────────────────────────────────────────────────
  f('MEMBERRY_PROPOSAL_TTL_SECONDS', 'int', '0', 'redis',
    'TTL for review-gated proposals; 0/absent means durable (no expiry).'),
]);

const KNOWN = new Set(MEMBERRY_FLAGS.map((flag) => flag.name));

/**
 * Boot-time typo detection (audit C10): log one line per MEMBERRY_* variable
 * present in `env` that is not a declared flag. Never throws; legacy AMP_*
 * aliases are ignored (readEnv handles their deprecation warning). Returns the
 * unknown names so callers/tests can inspect them.
 */
export function warnUnknownMemberryEnv(
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void,
): string[] {
  const unknown = Object.keys(env)
    .filter((key) => key.startsWith('MEMBERRY_') && !KNOWN.has(key))
    .sort();
  for (const name of unknown) {
    log(`[memberry] unknown env ${name} is not a declared flag (typo?); it has no effect.`);
  }
  return unknown;
}
