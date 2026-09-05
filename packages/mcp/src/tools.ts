// packages/mcp/src/tools.ts
import path from 'node:path';
import { z } from 'zod';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { LoadScope, MemoryContext, EpisodeInput, MemoryTier, FactTimeline, FactDiff, TemporalOptions } from '@memberry/core';
import { DEFAULT_TENANT, getAllowedBaseDir } from '@memberry/core';
import { resolveProjectTag } from '@memberry/code';
import { parseAmpUri, uriToLoadScope } from './uri.js';
import { scanCodebase, type CodebaseScan } from './codebase-scanner.js';
import { assertSafeRegex, capScanText, UnsafeRegexError } from './safe-regex.js';
import { recompileWikiNow } from './wiki-autorefresh.js';

export type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';

// ─── Service interfaces (injected, no concrete imports) ──────────────────────

export interface IAMPService {
  load(scope: LoadScope): Promise<MemoryContext>;
  store(input: EpisodeInput): Promise<{ id: string; duplicate: boolean }>;
}

export interface IConsolidationEngine {
  run(scope?: string): Promise<unknown>;
  status(): Promise<unknown>;
  review(proposalId: string): Promise<unknown>;
  apply(proposalId: string, decision: 'approve' | 'reject'): Promise<{ applied: boolean }>;
  /** Background generative pass: fill gaps + mint abductive hypotheses for a scope. */
  dream?(scope: string): Promise<unknown>;
}

export interface IScopedQuery {
  rawCypher(cypher: string, limit: number, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>[]>;
}

/**
 * Bounded server-side transaction timeout (ms) for berry_grep's regex (`=~`)
 * Cypher. assertSafeRegex() shape-rejects the worst exponential patterns up
 * front (OPT-06); this timeout is the residual backstop (OPT-07) so any runaway
 * server-side regex — including polynomial shapes that slip the static screen —
 * self-aborts on Neo4j instead of pinning the shared instance for the whole
 * deployment. OPT-72: tightened 5000→2000 (grep is meant to be a quick search;
 * the 4k scan cap + shape screen already bound the regex, so a tighter backstop
 * costs nothing legitimate). berry_query's raw path is now ALSO bounded — by the
 * rawCypher DEFAULT timeout (OPT-72), not this grep-specific value.
 */
const GREP_QUERY_TIMEOUT_MS = 2000;

export interface IMemoryBlockService {
  read(scope: string, name: string, sessionId?: string, tenantId?: string): Promise<{ id: string; name: string; tier: string; content: string; scope: string; session_id?: string; created_at: string; updated_at: string } | null>;
  insert(scope: string, name: string, text: string, sessionId?: string, tenantId?: string): Promise<{ id: string; name: string; tier: string; content: string; scope: string }>;
  replace(scope: string, name: string, oldText: string, newText: string, sessionId?: string, tenantId?: string): Promise<{ id: string; name: string; tier: string; content: string; scope: string }>;
  rewrite(scope: string, name: string, content: string, sessionId?: string, tenantId?: string): Promise<{ id: string; name: string; tier: string; content: string; scope: string }>;
  promote(scope: string, name: string, fromTier: string, toTier: string, sessionId?: string, tenantId?: string): Promise<{ id: string; name: string; tier: string; content: string; scope: string }>;
  archive(scope: string, name: string, sessionId?: string, tenantId?: string): Promise<string>;
}

export interface IBootstrapGraphService {
  bootstrap(input: {
    project_name: string;
    project_tag: string;
    description: string;
    domain: string;
    entities: Array<{ name: string; type: string; description?: string; parent?: string; root_path?: string }>;
    semantic_seeds: Array<{ claim: string; domain: string; confidence?: number; about?: string[]; tags?: string[] }>;
    agents: Array<{ id: string; name: string; type: string }>;
  }): Promise<{
    entities_created: number;
    entities_existing: number;
    agents_created: number;
    agents_existing: number;
    semantics_created: number;
    relationships_created: number;
    project_entity_id: string;
  }>;
  isBootstrapped(projectName: string): Promise<boolean>;
  status(projectName: string): Promise<Record<string, unknown>>;
}

export interface IFactStore {
  timeline(entityName: string, tenantId?: string): Promise<FactTimeline>;
  diff(entityName: string, from: string, to: string, tenantId?: string): Promise<FactDiff>;
}

export interface IProvenanceTraversal {
  traceOrigin(semanticId: string): Promise<Array<{ id: string; label: string; content: string; relationship: string }>>;
  supersessionHistory(semanticId: string): Promise<Array<{ id: string; content: string; confidence: number }>>;
}

export interface ICodeIndexerService {
  indexProject(rootPath: string, options?: { include?: string[]; exclude?: string[]; projectTag?: string }): Promise<{
    files_parsed: number;
    files_skipped: number;
    symbols_created: number;
    symbols_updated: number;
    relations_created: number;
    errors: Array<{ file: string; error: string }>;
  }>;
  /**
   * T6/gap-12 bridge: link the just-indexed Component file nodes (created by
   * indexProject's ensureFileEntities) to their module Entities and the project,
   * so the wiki compiler's CONTAINS traversal discovers them. Idempotent; scoped
   * to files under `rootPath`. `knownModules` is the scanner's authoritative
   * module list ({name, relPath}); each component is mapped to a module by
   * LONGEST directory-prefix so module names agree byte-for-byte with the
   * bootstrap (a monorepo file under `packages/core/...` → module `core`, not
   * `packages`). Returns the number of file→module links processed.
   */
  linkComponentsToProject?(
    rootPath: string,
    projectName: string,
    knownModules?: Array<{ name: string; relPath: string }>,
  ): Promise<number>;
}

// ─── Service container ────────────────────────────────────────────────────────
//
// The tool layer depends on a single typed container of services rather than a
// scatter of module-level singletons. A process-default container backs the
// legacy setServiceInstances() injection point, while buildToolHandlers() and
// registerTools() also accept an explicit container — the seam that makes
// per-session / multi-tenant service isolation possible without process globals.

export interface ServiceContainer {
  ampService: IAMPService | null;
  consolidationEngine: IConsolidationEngine | null;
  scopedQuery: IScopedQuery | null;
  bootstrapService: IBootstrapGraphService | null;
  memoryBlockService: IMemoryBlockService | null;
  factStore: IFactStore | null;
  codeIndexerService: ICodeIndexerService | null;
  provenanceTraversal: IProvenanceTraversal | null;
  /** Tenant this container's tool calls are bound to (defaults to DEFAULT_TENANT). */
  tenantId: string;
  /** Authenticated actor for this session (recorded in the audit trail; defaults to 'mcp'). */
  actor: string;
}

/** Build a container, defaulting any service not supplied to null. */
export function createServiceContainer(partial: Partial<ServiceContainer> = {}): ServiceContainer {
  return {
    ampService: partial.ampService ?? null,
    consolidationEngine: partial.consolidationEngine ?? null,
    scopedQuery: partial.scopedQuery ?? null,
    bootstrapService: partial.bootstrapService ?? null,
    memoryBlockService: partial.memoryBlockService ?? null,
    factStore: partial.factStore ?? null,
    codeIndexerService: partial.codeIndexerService ?? null,
    provenanceTraversal: partial.provenanceTraversal ?? null,
    tenantId: partial.tenantId ?? DEFAULT_TENANT,
    actor: partial.actor ?? 'mcp',
  };
}

/** Process-default container, populated by setServiceInstances() at bootstrap. */
const defaultContainer: ServiceContainer = createServiceContainer();

/**
 * Graduation seam: tenants with a dedicated datastore get their own service
 * container (Option C — physical isolation for that tenant); all others share
 * the process-default services with a tenant_id filter (Option A — logical).
 */
const tenantContainers = new Map<string, ServiceContainer>();

/** Register a dedicated service set for a tenant (built from its own datastore). */
export function setTenantContainer(tenantId: string, services: Partial<ServiceContainer>): void {
  tenantContainers.set(tenantId, createServiceContainer({ ...services, tenantId }));
}

/** A container bound to a tenant (+ authenticated actor): dedicated services if registered, else shared defaults. */
export function coreContainerForTenant(tenantId: string, actor = 'mcp'): ServiceContainer {
  const dedicated = tenantContainers.get(tenantId);
  return dedicated ? { ...dedicated, actor } : { ...defaultContainer, tenantId, actor };
}

/**
 * Tools that are proven tenant-isolated and therefore safe to expose to a
 * tenant-bound (multi-tenant) session. Everything else is withheld by
 * default-deny until its data path is tenant-scoped (see THREAT-MODEL.md).
 * Grows as Phase 2 scopes grep/blocks/facts/context.
 */
export const TENANT_SAFE_TOOLS: ReadonlySet<string> = new Set([
  // Core memory read/write/search — all tenant-scoped at the data layer
  // (episodes, semantics, facts, blocks, grep all filter by tenant_id).
  'berry_load', 'berry_store', 'berry_grep',
  'berry_memory_read', 'berry_memory_insert', 'berry_memory_replace',
  'berry_memory_rewrite', 'berry_memory_promote', 'berry_memory_archive',
  'berry_timeline', 'berry_fact_diff',
  // Registered by the retrieval package (tenant-bound); listed here for docs.
  'berry_context', 'berry_ask',
  'berry_tools',
]);

export function setServiceInstances(services: {
  ampService: IAMPService;
  consolidationEngine: IConsolidationEngine;
  scopedQuery: IScopedQuery;
  bootstrapService: IBootstrapGraphService;
  memoryBlockService?: IMemoryBlockService;
  factStore?: IFactStore;
  codeIndexer?: ICodeIndexerService;
  provenance?: IProvenanceTraversal;
}): void {
  // Full reset of the default container (a service omitted from `services` is
  // cleared). Bootstrap injects in two phases and re-passes every service it
  // wants retained on the second call — see bootstrap.ts.
  defaultContainer.ampService = services.ampService;
  defaultContainer.consolidationEngine = services.consolidationEngine;
  defaultContainer.scopedQuery = services.scopedQuery;
  defaultContainer.bootstrapService = services.bootstrapService;
  defaultContainer.memoryBlockService = services.memoryBlockService ?? null;
  defaultContainer.factStore = services.factStore ?? null;
  defaultContainer.codeIndexerService = services.codeIndexer ?? null;
  defaultContainer.provenanceTraversal = services.provenance ?? null;
}

// ─── Tool name constants ──────────────────────────────────────────────────────

export const TOOL_NAMES = [
  'berry_load', 'berry_store', 'berry_grep', 'berry_query', 'berry_consolidate', 'berry_resolve', 'berry_bootstrap',
  'berry_ingest_codebase', 'berry_provenance',
  'berry_memory_read', 'berry_memory_insert', 'berry_memory_replace', 'berry_memory_rewrite',
  'berry_memory_promote', 'berry_memory_archive',
  'berry_timeline', 'berry_fact_diff',
  'berry_tools',
] as const;

// ─── Progressive disclosure types ────────────────────────────────────────────

/** Domain names for progressive disclosure grouping. */
export type ToolDomain =
  | 'memory' | 'temporal' | 'admin' | 'research'
  | 'code' | 'arch' | 'wiki' | 'retrieval'
  | 'graph';

/** The full domain registry: maps domain name → registered tool handles. */
export type ToolRegistry = Map<ToolDomain, RegisteredTool[]>;

/** Domain metadata for the berry_tools list action. */
export interface DomainInfo {
  domain: ToolDomain;
  description: string;
  tools: string[];
  enabled: boolean;
}

/** Domain descriptions for documentation. */
export const DOMAIN_DESCRIPTIONS: Record<ToolDomain, string> = {
  memory: 'Block memory operations: replace, rewrite, promote, archive',
  temporal: 'Temporal queries: timeline, fact diff',
  admin: 'Administrative: raw queries, consolidation, bootstrap, resolve, codebase ingestion, provenance',
  research: 'Research campaigns: init, log, context, tree, contradictions, consolidate',
  code: 'Code intelligence: index, search, AST-grep, symbols, deps, context, file watcher',
  arch: 'Architecture: register, relate, aspects, impact, drift, context',
  wiki: 'Wiki: compile, ingest, lint',
  retrieval: 'Retrieval feedback (berry_context stays in Tier 1)',
  graph: 'Graph analytics: deterministic, project-scoped graph audit report',
};

/** Which core tools go into which Tier 2 domain. */
export const CORE_DOMAIN_TOOLS: Record<string, ToolDomain> = {
  berry_memory_replace: 'memory',
  berry_memory_rewrite: 'memory',
  berry_memory_promote: 'memory',
  berry_memory_archive: 'memory',
  berry_timeline: 'temporal',
  berry_fact_diff: 'temporal',
  berry_query: 'admin',
  berry_consolidate: 'admin',
  berry_bootstrap: 'admin',
  berry_resolve: 'admin',
  berry_ingest_codebase: 'admin',
  berry_provenance: 'admin',
};

// ─── Zod schemas ─────────────────────────────────────────────────────────────

export const AmpLoadSchema = {
  task: z.string().max(5000).describe('Task description for context assembly'),
  entities: z.array(z.string()).optional().describe('Entity names to scope the query'),
  tags: z.array(z.string()).optional().describe('Tags to scope the query'),
  max_tokens: z.number().int().positive().optional().default(4000).describe('Max tokens for context window'),
  temporal: z.object({
    time_mode: z.enum(['current', 'historical', 'interval', 'evolution']).optional().describe('Temporal query mode'),
    // OPT-40: bound the timestamp strings (were unbounded z.string()). NOT
    // z.string().datetime() — the documented contract accepts date-only values
    // ("2025-06-01") as well as full ISO ("2021-03-01T00:00:00.000Z"), which
    // .datetime() would reject. .max(40) bounds the unbounded-length DoS vector
    // while preserving both accepted forms (full ISO+ms+offset is ~29 chars).
    as_of: z.string().max(40).optional().describe('ISO timestamp/date for historical mode'),
    from: z.string().max(40).optional().describe('Interval start (ISO timestamp/date)'),
    to: z.string().max(40).optional().describe('Interval end (ISO timestamp/date)'),
    include_invalidated: z.boolean().optional().describe('Include invalidated facts in evolution mode'),
  }).optional().describe('Temporal filtering options for fact queries'),
};

export const AmpStoreSchema = {
  session_id: z.string().max(500).describe('Session identifier'),
  task: z.string().max(5000).describe('Task description for this episode'),
  content: z.string().max(10000).describe('Episodic content to store'),
  entities: z.array(z.string().max(200)).max(32).optional().describe('Canonical Entity IDs to link to this episode'),
  facts: z.array(z.string().max(500)).max(32).optional()
    .describe('Atomic single-clause facts used as additive retrieval keys; requires canonical project scope'),
  aliases: z.array(z.object({
    entity_id: z.string().max(200),
    values: z.array(z.string().max(500)).min(1).max(16),
  }).strict()).max(32).optional()
    .describe('Entity-bound aliases used as additive retrieval keys; entity_id must also appear in entities'),
  model_id: z.string().max(500).optional().describe('Model ID to link to this episode'),
  scope: z.string().max(500).optional().describe('Canonical scope for this episode, usually project:<name>'),
  tags: z.array(z.string().max(500)).optional().describe('Tags for this episode. Include project:<name> for project scoping.'),
  outcome: z
    .enum(['approved', 'revised', 'rejected', 'abandoned'])
    .optional()
    .describe('Outcome of the episode'),
  memory_type: z
    .enum(['decision', 'pattern', 'convention', 'architecture', 'preference', 'fact', 'general'])
    .optional()
    .describe('Durable memory classification. Use decision with outcome=approved for autonomous one-source promotion; patterns and conventions still require recurrence.'),
  signals: z
    .array(
      z.object({
        type: z.enum(['reinforcement', 'correction', 'contradiction']),
        // OPT-36: bound the per-signal fields and the array length so a single
        // berry_store call can't attach an unbounded signal payload (the other
        // string fields in this schema are already .max()-bounded; signals were
        // the gap). target_id matches the 500-char id convention; detail mirrors
        // the 2000-char description bound used elsewhere.
        target_id: z.string().max(500),
        detail: z.string().max(2000),
      }),
    )
    .max(50)
    .optional()
    .describe('Signals associated with this episode'),
};

const AmpQuerySchema = {
  query: z.string().max(5000).describe('Cypher query to run against Neo4j'),
  limit: z.number().int().positive().max(100).optional().default(10).describe('Maximum number of results, capped at 100'),
};

const AmpConsolidateSchema = {
  action: z.enum(['run', 'status', 'review', 'dream']).describe('Consolidation action: run/status/review, or "dream" (background gap-filling + abductive hypotheses for a scope)'),
  scope: z.string().max(2000).optional().describe('Entity or tag scope for "run"/"dream" actions (e.g. project:amp)'),
  proposal_id: z.string().max(2000).optional().describe('Proposal ID for "review" action'),
  decision: z
    .enum(['approve', 'reject'])
    .optional()
    .describe('Decision for "review" action (approve or reject)'),
};

const AmpResolveSchema = {
  uri: z.string().max(500).describe('MemBerry URI to resolve (memberry://entity/Name or memberry://tag/name)'),
  max_tokens: z.number().int().positive().optional().default(2000).describe('Max tokens for resolved content'),
  stage_context: z.string().max(2000).optional().describe('Current stage description for relevance ranking'),
};

const AmpBootstrapSchema = {
  project_name: z.string().max(500).describe('Project name (e.g. "oni-core", "my-api")'),
  project_tag: z.string().max(500).describe('Project scope tag (e.g. "project:oni-core")'),
  description: z.string().max(10000).describe('One-line project description'),
  domain: z.string().max(2000).describe('Project domain (e.g. "agent-orchestration", "e-commerce", "ml-training")'),
  entities: z.array(z.object({
    name: z.string().max(500).describe('Entity name'),
    type: z.string().max(2000).describe('Entity type: project, module, service, component, team, person, tool'),
    description: z.string().max(2000).optional().describe('What this entity is'),
    parent: z.string().max(2000).optional().describe('Parent entity name — creates a CONTAINS relationship'),
  })).describe('Entities to create (modules, services, components, teams, etc.)'),
  semantic_seeds: z.array(z.object({
    claim: z.string().max(2000).describe('The principle or observation, stated concisely'),
    domain: z.string().max(500).describe('Domain tag (architecture, performance, testing, security, etc.)'),
    confidence: z.number().min(0).max(1).optional().default(0.3).describe('Initial confidence (default 0.3 = prior/observation)'),
    about: z.array(z.string()).optional().describe('Entity names this principle is ABOUT'),
    tags: z.array(z.string()).optional().describe('Additional tags'),
  })).optional().default([]).describe('Seed semantic principles — low-confidence priors from repo analysis'),
  agents: z.array(z.object({
    id: z.string().max(500).describe('Agent identifier (e.g. "mcp", "researcher-1")'),
    name: z.string().max(500).describe('Human-readable name'),
    type: z.string().max(5000).describe('Agent type: assistant, sentinel, fixer, researcher'),
  })).optional().default([{ id: 'mcp', name: 'Claude Code', type: 'assistant' }])
    .describe('Agents that will interact with this project'),
};

const AmpIngestCodebaseSchema = {
  path: z.string().max(500).describe('Root path of the codebase to ingest'),
  project_name: z.string().max(200).optional().describe('Project name. Auto-detected from package.json/pyproject.toml if omitted.'),
  project_tag: z.string().max(200).optional().describe('Project tag (e.g., "project:my-app"). Auto-generated from name if omitted.'),
  description: z.string().max(1000).optional().describe('One-line project description. Auto-detected if omitted.'),
  domain: z.string().max(200).optional().describe('Project domain (e.g., "web-app", "CLI tool"). Auto-detected if omitted.'),
  languages: z.array(z.enum(['typescript', 'javascript', 'python', 'go', 'rust'])).optional()
    .describe('Languages to index. Auto-detected if omitted.'),
  exclude_patterns: z.array(z.string()).optional()
    .describe('Glob patterns to exclude (e.g., ["node_modules", "dist"]). Defaults to common excludes.'),
};

const AmpMemoryReadSchema = {
  block: z.string().max(500).describe('Block name (e.g. "persona", "user", "working_state")'),
  scope: z.string().max(500).optional().describe('Project scope tag (e.g. "project:my-project")'),
  session_id: z.string().max(500).optional().describe('Session ID for working-tier blocks'),
};

const AmpMemoryInsertSchema = {
  block: z.string().max(500).describe('Block name'),
  text: z.string().max(5000).describe('Text to append to the block'),
  scope: z.string().max(500).optional().describe('Project scope tag'),
  session_id: z.string().max(500).optional().describe('Session ID for working-tier blocks'),
};

const AmpMemoryReplaceSchema = {
  block: z.string().max(500).describe('Block name'),
  old_text: z.string().max(5000).describe('Exact text to find and replace'),
  new_text: z.string().max(5000).describe('Replacement text'),
  scope: z.string().max(500).optional().describe('Project scope tag'),
  session_id: z.string().max(500).optional().describe('Session ID for working-tier blocks'),
};

const AmpMemoryRewriteSchema = {
  block: z.string().max(500).describe('Block name'),
  content: z.string().max(10000).describe('New content to overwrite the entire block'),
  scope: z.string().max(500).optional().describe('Project scope tag'),
  session_id: z.string().max(500).optional().describe('Session ID for working-tier blocks'),
};

const AmpMemoryPromoteSchema = {
  block: z.string().max(500).describe('Block name'),
  from_tier: z.enum(['core', 'working', 'archive']).describe('Current tier of the block'),
  to_tier: z.enum(['core', 'working', 'archive']).describe('Target tier to promote/demote to'),
  scope: z.string().max(500).optional().describe('Project scope tag'),
  session_id: z.string().max(500).optional().describe('Session ID for finding working-tier blocks'),
};

const AmpMemoryArchiveSchema = {
  block: z.string().max(500).describe('Block name to archive'),
  scope: z.string().max(500).optional().describe('Project scope tag'),
  session_id: z.string().max(500).optional().describe('Session ID for working-tier blocks'),
};

export const AmpTimelineSchema = {
  entity: z.string().max(200).describe('Entity name to get timeline for'),
  include_episodes: z.boolean().optional().describe('Include linked episodes in timeline (default false)'),
  // OPT-39: was .int().max(100) only — a 0 fell through to "return all" and a
  // negative limit did tl.facts.slice(0, -n) (silently dropped the LAST n facts).
  // Require a positive int so the handler's slice is always well-defined.
  limit: z.number().int().positive().max(100).optional().describe('Maximum number of facts to return (1–100)'),
};

const AmpFactDiffSchema = {
  entity: z.string().max(200).describe('Entity name to diff'),
  from: z.string().describe('Start timestamp (ISO format)'),
  to: z.string().describe('End timestamp (ISO format)'),
};

const AmpToolsSchema = {
  action: z.enum(['list', 'enable', 'disable']).describe('Action to perform'),
  domain: z.string().optional().describe('Domain name: memory, temporal, admin, research, code, arch, wiki, retrieval. Or "all" to enable/disable everything.'),
};

const AmpGrepSchema = {
  pattern: z.string().max(500).describe('Text pattern to search for. Supports exact string or regex (when regex=true).'),
  regex: z.boolean().optional().describe('Treat pattern as a regular expression. Default: false (exact substring match).'),
  node_types: z.array(z.enum(['episodic', 'semantic', 'fact', 'block', 'entity'])).optional()
    .describe('Node types to search. Default: all types.'),
  scope: z.string().optional().describe('Project scope tag to filter by (e.g., "project:amp").'),
  case_sensitive: z.boolean().optional().describe('Case-sensitive matching. Default: false.'),
  limit: z.number().int().positive().max(50).optional().describe('Max results to return. Default: 20.'),
};

const AmpProvenanceSchema = {
  semantic_id: z.string().max(200).describe('Semantic node ID to trace (e.g. "amp-sem-xyz"). Get IDs from berry_load/berry_grep results.'),
};

// ─── Handler implementations ─────────────────────────────────────────────────

type ToolResult = Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>;

export type ToolHandlers = {
  berry_load: (args: {
    task: string;
    entities?: string[];
    tags?: string[];
    max_tokens?: number;
    temporal?: TemporalOptions;
  }) => ToolResult;
  berry_store: (args: {
    session_id: string;
    task: string;
    content: string;
    outcome?: 'approved' | 'revised' | 'rejected' | 'abandoned';
    memory_type?: 'decision' | 'pattern' | 'convention' | 'architecture' | 'preference' | 'fact' | 'general';
    signals?: Array<{ type: 'reinforcement' | 'correction' | 'contradiction'; target_id: string; detail: string }>;
    entities?: string[];
    facts?: string[];
    aliases?: Array<{ entity_id: string; values: string[] }>;
    model_id?: string;
    scope?: string;
    tags?: string[];
  }) => ToolResult;
  berry_grep: (args: {
    pattern: string;
    regex?: boolean;
    node_types?: Array<'episodic' | 'semantic' | 'fact' | 'block' | 'entity'>;
    scope?: string;
    case_sensitive?: boolean;
    limit?: number;
  }) => ToolResult;
  berry_query: (args: { query: string; limit?: number }) => ToolResult;
  berry_provenance: (args: { semantic_id: string }) => ToolResult;
  berry_consolidate: (args: {
    action: 'run' | 'status' | 'review' | 'dream';
    scope?: string;
    proposal_id?: string;
    decision?: 'approve' | 'reject';
  }) => ToolResult;
  berry_resolve: (args: {
    uri: string;
    max_tokens?: number;
    stage_context?: string;
  }) => ToolResult;
  berry_bootstrap: (args: {
    project_name: string;
    project_tag: string;
    description: string;
    domain: string;
    entities: Array<{ name: string; type: string; description?: string; parent?: string }>;
    semantic_seeds?: Array<{ claim: string; domain: string; confidence?: number; about?: string[]; tags?: string[] }>;
    agents?: Array<{ id: string; name: string; type: string }>;
  }) => ToolResult;
  berry_ingest_codebase: (args: {
    path: string;
    project_name?: string;
    project_tag?: string;
    description?: string;
    domain?: string;
    languages?: Array<'typescript' | 'javascript' | 'python' | 'go' | 'rust'>;
    exclude_patterns?: string[];
  }) => ToolResult;
  berry_memory_read: (args: { block: string; scope?: string; session_id?: string }) => ToolResult;
  berry_memory_insert: (args: { block: string; text: string; scope?: string; session_id?: string }) => ToolResult;
  berry_memory_replace: (args: { block: string; old_text: string; new_text: string; scope?: string; session_id?: string }) => ToolResult;
  berry_memory_rewrite: (args: { block: string; content: string; scope?: string; session_id?: string }) => ToolResult;
  berry_memory_promote: (args: { block: string; from_tier: MemoryTier; to_tier: MemoryTier; scope?: string; session_id?: string }) => ToolResult;
  berry_memory_archive: (args: { block: string; scope?: string; session_id?: string }) => ToolResult;
  berry_timeline: (args: { entity: string; include_episodes?: boolean; limit?: number }) => ToolResult;
  berry_fact_diff: (args: { entity: string; from: string; to: string }) => ToolResult;
};

function textContent(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text' as const, text }] };
}

/** True when a backward-compatible result shape reports at least one mutation. */
function reportsMutation(result: unknown, fields: string[]): boolean {
  if (typeof result !== 'object' || result === null) return false;
  const record = result as Record<string, unknown>;
  return fields.some((field) => {
    const value = record[field];
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'number') return Number.isFinite(value) && value > 0;
    return value === true;
  });
}

function normalizeBoundedPositiveInt(value: number | undefined, defaultValue: number, maxValue: number): number {
  if (value == null) return defaultValue;
  const floored = Math.floor(value);
  if (!Number.isFinite(floored) || floored <= 0) return defaultValue;
  return Math.min(floored, maxValue);
}

export function buildToolHandlers(container: ServiceContainer = defaultContainer): ToolHandlers {
  // Destructure once into closure-captured locals. Handlers reference these by
  // the same names they used as module globals, so their bodies are unchanged —
  // but each call to buildToolHandlers can now be bound to a different container.
  const {
    ampService,
    consolidationEngine,
    scopedQuery,
    bootstrapService,
    memoryBlockService,
    factStore,
    codeIndexerService,
    provenanceTraversal,
    tenantId,
    actor,
  } = container;
  return {
    async berry_load(args) {
      if (!ampService) throw new Error('AMPService not initialised');
      const scope: LoadScope = {
        task: args.task,
        entities: args.entities,
        tags: args.tags,
        max_tokens: args.max_tokens ?? 4000,
        temporal: args.temporal,
        tenantId,
      };
      const ctx = await ampService.load(scope);
      return textContent(ctx.markdown);
    },

    async berry_store(args) {
      if (!ampService) throw new Error('AMPService not initialised');
      const input: EpisodeInput = {
        session_id: args.session_id,
        agent_id: actor,
        task: args.task,
        content: args.content,
        outcome: args.outcome,
        memory_type: args.memory_type,
        signals: args.signals,
        entities: args.entities,
        facts: args.facts,
        aliases: args.aliases,
        model_id: args.model_id,
        scope: args.scope,
        tags: args.tags,
        tenantId,
      };
      const result = await ampService.store(input);
      if (result.duplicate) {
        return textContent('duplicate:true');
      }
      return textContent(`id:${result.id}`);
    },

    async berry_grep(args) {
      if (!scopedQuery) throw new Error('ScopedQuery not initialised');

      const pattern = args.pattern;
      const isRegex = args.regex ?? false;
      const caseSensitive = args.case_sensitive ?? false;
      const limit = normalizeBoundedPositiveInt(args.limit, 20, 50);
      const nodeTypes = args.node_types ?? ['episodic', 'semantic', 'fact', 'block', 'entity'];

      // Validate regex if regex mode.
      //
      // SECURITY (OPT-06): the user `pattern` is re-compiled with `new RegExp`
      // and executed JS-side (.test()/.exec()) against untrusted stored content
      // on the single-threaded event loop with no time bound — a catastrophic-
      // backtracking pattern (e.g. `(a+)+$`) is a one-call event-loop DoS. We
      // pre-screen the pattern with a conservative static ReDoS heuristic and
      // REJECT dangerous shapes BEFORE the pattern is ever compiled or run, so
      // this is the single chokepoint guarding every downstream .test()/.exec()
      // site (extractSnippet + the per-node-type match() loops below). This is a
      // best-effort interim screen, NOT a proof of safety; the robust linear-
      // time fix (re2) is deferred. See safe-regex.ts.
      if (isRegex) {
        try {
          assertSafeRegex(pattern);
          new RegExp(pattern);
        } catch (e) {
          if (e instanceof UnsafeRegexError) {
            return textContent(`**Error:** Unsafe regular expression rejected: ${e.message}`);
          }
          return textContent(`**Error:** Invalid regular expression: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // Build the Neo4j match expression for a given field
      const grepParams = {
        grepPattern: pattern,
        grepPatternLower: pattern.toLowerCase(),
        grepRegex: caseSensitive ? `.*${pattern}.*` : `(?i).*${pattern}.*`,
        grepScope: args.scope ?? '',
        grepTenant: tenantId,
      };

      // SECURITY (OPT-07): only the regex path builds `=~ $grepRegex` Cypher,
      // whose Java-regex evaluation runs server-side with no inherent bound. Bind
      // a transaction timeout on that path so a runaway regex self-aborts instead
      // of pinning shared Neo4j. Non-regex grep (CONTAINS) is index-friendly and
      // keeps the prior unbounded behaviour (undefined → no transactionConfig).
      const grepTimeoutMs = isRegex ? GREP_QUERY_TIMEOUT_MS : undefined;

      // Mandatory tenant isolation per node type. The default tenant also matches
      // legacy rows with no tenant_id; a named tenant matches strictly.
      const tenantIsDefault = tenantId === DEFAULT_TENANT;
      function tFilter(alias: string): string {
        return tenantIsDefault
          ? `(${alias}.tenant_id IS NULL OR ${alias}.tenant_id = $grepTenant)`
          : `${alias}.tenant_id = $grepTenant`;
      }

      function matchExpr(field: string): string {
        if (isRegex) {
          return `${field} =~ $grepRegex`;
        }
        if (caseSensitive) {
          return `${field} CONTAINS $grepPattern`;
        }
        return `toLower(${field}) CONTAINS $grepPatternLower`;
      }

      interface GrepResult {
        id: string;
        node_type: string;
        matched_field: string;
        snippet: string;
        score: number;
        meta?: Record<string, unknown>;
      }

      const results: GrepResult[] = [];
      const seenIds = new Set<string>();

      // Audit B1: a failed per-type query must not read as a genuine no-hit.
      // Reasons are value-free classes — never the raw message, which may
      // carry Cypher text, hosts, or stored values.
      const failed: Array<{ type: string; reason: string }> = [];
      function recordFailure(type: string, err: unknown): void {
        const code = (err as { code?: string })?.code ?? '';
        const msg = err instanceof Error ? err.message : String(err);
        const reason = /TimedOut|timeout/i.test(code + msg) ? 'timeout'
          : /regex|regular expression|pattern/i.test(msg) ? 'invalid-regex'
          : 'query-failed';
        failed.push({ type, reason });
        console.error(`[berry_grep] ${type} query failed: ${reason}`);
      }

      // Helper: extract snippet around match
      function extractSnippet(fullText: string, pat: string, isRx: boolean, isCaseSens: boolean): string {
        if (!fullText) return '';
        // SECURITY (OPT-06): bound the input handed to rx.exec() so even a
        // pattern that slips the static screen has bounded backtracking work.
        const text = capScanText(fullText);
        let matchIdx = -1;
        let matchLen = pat.length;

        if (isRx) {
          try {
            const flags = isCaseSens ? '' : 'i';
            const rx = new RegExp(pat, flags);
            const m = rx.exec(text);
            if (m) {
              matchIdx = m.index;
              matchLen = m[0].length;
            }
          } catch (err: unknown) {
            console.error("[tools] Suppressed error:", err);
            matchIdx = -1;
          }
        } else {
          if (isCaseSens) {
            matchIdx = text.indexOf(pat);
          } else {
            matchIdx = text.toLowerCase().indexOf(pat.toLowerCase());
          }
        }

        if (matchIdx === -1) {
          return text.length > 200 ? text.slice(0, 200) + '...' : text;
        }

        const contextChars = 100;
        const start = Math.max(0, matchIdx - contextChars);
        const end = Math.min(text.length, matchIdx + matchLen + contextChars);
        let snippet = text.slice(start, end);

        if (start > 0) snippet = '...' + snippet;
        if (end < text.length) snippet = snippet + '...';

        // Bold the matched text in the snippet
        const matchedText = text.slice(matchIdx, matchIdx + matchLen);
        snippet = snippet.replace(matchedText, `**${matchedText}**`);

        return snippet;
      }

      // Helper: add result with dedup
      function addResult(id: string, nodeType: string, matchedField: string, fieldValue: string, score: number, meta?: Record<string, unknown>): void {
        if (seenIds.has(id) || results.length >= limit) return;
        seenIds.add(id);
        results.push({
          id,
          node_type: nodeType,
          matched_field: matchedField,
          snippet: extractSnippet(fieldValue, pattern, isRegex, caseSensitive),
          score,
          meta,
        });
      }

      // Execute queries per node type
      const perTypeLimit = limit;

      if (nodeTypes.includes('episodic')) {
        // Structural tenancy: scope matches the enforced scope column (or a
        // project tag on legacy rows) — not free text in the task.
        const scopeFilter = args.scope ? ' AND (e.scope = $grepScope OR $grepScope IN e.tags)' : '';
        // MEM-006: lifecycle-archived episodes stay out of grep (coalesce passes
        // validateReadOnlyCypher; legacy rows lack the property).
        const cypher = `MATCH (e:Episodic) WHERE (${matchExpr('e.content')} OR ${matchExpr('e.task')})${scopeFilter} AND ${tFilter('e')} AND coalesce(e.archived, false) = false RETURN e ORDER BY e.created_at DESC`;
        try {
          const rows = await scopedQuery.rawCypher(cypher, perTypeLimit, grepParams, grepTimeoutMs);
          for (const row of rows) {
            const e = row.e as Record<string, unknown>;
            const content = (e.content as string) ?? '';
            const task = (e.task as string) ?? '';
            const contentMatch = isRegex
              ? new RegExp(pattern, caseSensitive ? '' : 'i').test(capScanText(content))
              : caseSensitive ? content.includes(pattern) : content.toLowerCase().includes(pattern.toLowerCase());
            const matchedField = contentMatch ? 'content' : 'task';
            const matchedValue = contentMatch ? content : task;
            addResult(
              e.id as string, 'episodic', matchedField, matchedValue, 1,
              { task, created_at: e.created_at },
            );
          }
        } catch (err: unknown) {
          recordFailure('episodic', err);
        }
      }

      if (nodeTypes.includes('semantic')) {
        const scopeFilter = args.scope ? ' AND (s.scope = $grepScope OR $grepScope IN s.tags)' : '';
        const cypher = `MATCH (s:Semantic) WHERE ${matchExpr('s.content')}${scopeFilter} AND ${tFilter('s')} AND coalesce(s.archived, false) = false RETURN s ORDER BY s.confidence DESC`;
        try {
          const rows = await scopedQuery.rawCypher(cypher, perTypeLimit, grepParams, grepTimeoutMs);
          for (const row of rows) {
            const s = row.s as Record<string, unknown>;
            addResult(
              s.id as string, 'semantic', 'content', (s.content as string) ?? '', 2,
              { confidence: s.confidence },
            );
          }
        } catch (err: unknown) {
          recordFailure('semantic', err);
        }
      }

      if (nodeTypes.includes('fact')) {
        const scopeFilter = args.scope ? ' AND f.scope = $grepScope' : '';
        // By default only search active facts — invalidated facts are historical noise
        const statusFilter = ` AND f.status = 'active'`;
        const cypher = `MATCH (f:Fact) WHERE (${matchExpr('f.subject')} OR ${matchExpr('f.predicate')} OR ${matchExpr('f.object')})${scopeFilter}${statusFilter} AND ${tFilter('f')} RETURN f ORDER BY f.updated_at DESC`;
        try {
          const rows = await scopedQuery.rawCypher(cypher, perTypeLimit, grepParams, grepTimeoutMs);
          for (const row of rows) {
            const f = row.f as Record<string, unknown>;
            const sub = (f.subject as string) ?? '';
            const pred = (f.predicate as string) ?? '';
            const obj = (f.object as string) ?? '';
            const combined = `${sub} ${pred} ${obj}`;
            const subMatch = isRegex
              ? new RegExp(pattern, caseSensitive ? '' : 'i').test(capScanText(sub))
              : caseSensitive ? sub.includes(pattern) : sub.toLowerCase().includes(pattern.toLowerCase());
            addResult(
              f.id as string, 'fact', subMatch ? 'subject' : 'predicate/object', combined, 1,
              { status: f.status, valid_at: f.valid_at },
            );
          }
        } catch (err: unknown) {
          recordFailure('fact', err);
        }
      }

      if (nodeTypes.includes('block')) {
        const scopeFilter = args.scope ? ' AND b.scope = $grepScope' : '';
        const cypher = `MATCH (b:MemoryBlock) WHERE (${matchExpr('b.content')} OR ${matchExpr('b.name')})${scopeFilter} AND ${tFilter('b')} RETURN b ORDER BY b.updated_at DESC`;
        try {
          const rows = await scopedQuery.rawCypher(cypher, perTypeLimit, grepParams, grepTimeoutMs);
          for (const row of rows) {
            const b = row.b as Record<string, unknown>;
            const content = (b.content as string) ?? '';
            const name = (b.name as string) ?? '';
            const nameMatch = isRegex
              ? new RegExp(pattern, caseSensitive ? '' : 'i').test(capScanText(name))
              : caseSensitive ? name.includes(pattern) : name.toLowerCase().includes(pattern.toLowerCase());
            addResult(
              `${b.scope}/${b.name}`, 'block', nameMatch ? 'name' : 'content',
              nameMatch ? name : content, nameMatch ? 2 : 1,
              { scope: b.scope, tier: b.tier },
            );
          }
        } catch (err: unknown) {
          recordFailure('block', err);
        }
      }

      if (nodeTypes.includes('entity')) {
        // Search name, description, and aliases
        const aliasMatch = isRegex
          ? 'any(a IN COALESCE(ent.aliases, []) WHERE a =~ $grepRegex)'
          : caseSensitive
            ? 'any(a IN COALESCE(ent.aliases, []) WHERE a CONTAINS $grepPattern)'
            : 'any(a IN COALESCE(ent.aliases, []) WHERE toLower(a) CONTAINS $grepPatternLower)';
        const descMatch = `ent.description IS NOT NULL AND ${matchExpr('ent.description')}`;
        const cypher = `MATCH (ent:Entity) WHERE (${matchExpr('ent.name')} OR (${descMatch}) OR ${aliasMatch}) AND ${tFilter('ent')} RETURN ent`;
        try {
          const rows = await scopedQuery.rawCypher(cypher, perTypeLimit, grepParams, grepTimeoutMs);
          for (const row of rows) {
            const ent = row.ent as Record<string, unknown>;
            const name = (ent.name as string) ?? '';
            const desc = (ent.description as string) ?? '';
            const nameMatch = isRegex
              ? new RegExp(pattern, caseSensitive ? '' : 'i').test(capScanText(name))
              : caseSensitive ? name.includes(pattern) : name.toLowerCase().includes(pattern.toLowerCase());
            addResult(
              ent.id as string, 'entity', nameMatch ? 'name' : 'description',
              nameMatch ? name : (desc || name), nameMatch ? 3 : 1,
              { type: ent.type },
            );
          }
        } catch (err: unknown) {
          recordFailure('entity', err);
        }
      }

      // Sort by score (higher = more relevant), then by node type priority
      results.sort((a, b) => b.score - a.score);

      // Render markdown
      if (failed.length > 0 && failed.length >= nodeTypes.length) {
        const reasons = [...new Set(failed.map(f => f.reason))].join(', ');
        return { ...textContent(`berry_grep: all ${failed.length} node-type queries failed (${reasons})`), isError: true };
      }
      const partialLine = failed.length > 0
        ? `_partial: ${failed.map(f => f.type).join(', ')} unavailable (${[...new Set(failed.map(f => f.reason))].join(', ')})_\n`
        : '';

      if (results.length === 0) {
        return textContent(`## Grep Results: "${pattern}" (0 matches)\n${partialLine}\n_No matches found._`);
      }

      const lines: string[] = [`## Grep Results: "${pattern}" (${results.length} match${results.length === 1 ? '' : 'es'})\n${partialLine}`];

      // Group by node type
      const grouped = new Map<string, GrepResult[]>();
      for (const r of results) {
        const list = grouped.get(r.node_type) ?? [];
        list.push(r);
        grouped.set(r.node_type, list);
      }

      const typeOrder = ['entity', 'semantic', 'fact', 'episodic', 'block'];
      const typeLabels: Record<string, string> = {
        entity: 'Entities',
        semantic: 'Semantic',
        fact: 'Facts',
        episodic: 'Episodic',
        block: 'Blocks',
      };

      for (const type of typeOrder) {
        const items = grouped.get(type);
        if (!items || items.length === 0) continue;

        lines.push(`### ${typeLabels[type]}`);
        for (const item of items) {
          const metaStr = item.meta
            ? Object.entries(item.meta)
                .filter(([, v]) => v != null)
                .map(([k, v]) => `${k}: ${v}`)
                .join(', ')
            : '';
          const metaPart = metaStr ? ` (${metaStr})` : '';
          lines.push(`- **[${item.id}]**${metaPart}`);
          lines.push(`  ${item.snippet}`);
        }
        lines.push('');
      }

      return textContent(lines.join('\n'));
    },

    async berry_query(args) {
      if (!scopedQuery) throw new Error('ScopedQuery not initialised');

      const limit = args.limit ?? 10;
      const rows = await scopedQuery.rawCypher(args.query, limit);
      return textContent(JSON.stringify(rows, null, 2));
    },

    async berry_provenance(args) {
      if (!provenanceTraversal) throw new Error('ProvenanceTraversal not initialised');
      const [origin, supersessions] = await Promise.all([
        provenanceTraversal.traceOrigin(args.semantic_id),
        provenanceTraversal.supersessionHistory(args.semantic_id),
      ]);

      const clip = (s: string) => (s.length > 160 ? s.slice(0, 160) + '…' : s);
      const lines: string[] = [`# Provenance: ${args.semantic_id}`, ''];

      lines.push('## Origin lineage (PROMOTED_FROM episodic · SUPERSEDES chain)');
      if (origin.length === 0) {
        lines.push('_No origin lineage found — node is a root, or the ID does not exist._');
      } else {
        for (const n of origin) {
          lines.push(`- **${n.label}** \`${n.id}\` —[${n.relationship}]→ ${clip(n.content)}`);
        }
      }
      lines.push('');

      lines.push('## Supersession history (predecessors this node replaced)');
      if (supersessions.length === 0) {
        lines.push('_No superseded predecessors._');
      } else {
        for (const s of supersessions) {
          lines.push(`- \`${s.id}\` (confidence ${s.confidence.toFixed(2)}): ${clip(s.content)}`);
        }
      }

      return textContent(lines.join('\n'));
    },

    async berry_consolidate(args) {
      if (!consolidationEngine) throw new Error('ConsolidationEngine not initialised');
      switch (args.action) {
        case 'run': {
          const effectiveScope = args.scope ?? 'global';
          const result = await consolidationEngine.run(effectiveScope);
          if (reportsMutation(result, ['applied'])) {
            await recompileWikiNow();
          }
          return textContent(JSON.stringify(result, null, 2));
        }
        case 'status': {
          const status = await consolidationEngine.status();
          return textContent(JSON.stringify(status, null, 2));
        }
        case 'review': {
          if (!args.proposal_id) {
            throw new Error('"proposal_id" is required for the "review" action');
          }
          if (args.decision) {
            // Apply the decision
            const applied = await consolidationEngine.apply(args.proposal_id, args.decision);
            if (args.decision === 'approve' && applied.applied) {
              await recompileWikiNow();
            }
            return textContent(JSON.stringify(applied, null, 2));
          }
          // Just review / fetch the proposal
          const proposal = await consolidationEngine.review(args.proposal_id);
          return textContent(JSON.stringify(proposal, null, 2));
        }
        case 'dream': {
          if (!consolidationEngine.dream) {
            throw new Error('Dream pass not available (no LLM configured — set OPENAI_API_KEY)');
          }
          const effectiveScope = args.scope ?? 'global';
          const result = await consolidationEngine.dream(effectiveScope);
          if (reportsMutation(result, ['hypotheses_created', 'cards_refreshed'])) {
            await recompileWikiNow();
          }
          return textContent(JSON.stringify(result, null, 2));
        }
        default: {
          const exhaustiveCheck: never = args.action;
          throw new Error(`Unknown consolidation action: ${String(exhaustiveCheck)}`);
        }
      }
    },

    async berry_resolve(args) {
      if (!ampService) throw new Error('AMPService not initialised');
      const parsed = parseAmpUri(args.uri);
      const scopeParts = uriToLoadScope(parsed);
      const task = args.stage_context ?? `Resolve ${args.uri}`;
      const scope: LoadScope = {
        task,
        ...scopeParts,
        max_tokens: args.max_tokens ?? 2000,
      };
      const ctx = await ampService.load(scope);
      return textContent(ctx.markdown);
    },

    async berry_bootstrap(args) {
      if (!bootstrapService) throw new Error('BootstrapGraphService not initialised');
      const result = await bootstrapService.bootstrap({
        project_name: args.project_name,
        project_tag: args.project_tag,
        description: args.description,
        domain: args.domain,
        entities: args.entities,
        semantic_seeds: args.semantic_seeds ?? [],
        agents: args.agents ?? [{ id: 'mcp', name: 'Claude Code', type: 'assistant' }],
      });
      // gap-15 (T10): immediately materialize the wiki for the freshly-set-up
      // project. Strict no-op unless MEMBERRY_WIKI_AUTOREFRESH is on + the shared
      // output dir exists; always non-fatal (never propagates a recompile error).
      await recompileWikiNow();
      return textContent(JSON.stringify(result, null, 2));
    },

    async berry_ingest_codebase(args) {
      if (!bootstrapService) throw new Error('BootstrapGraphService not initialised');

      // Validate path is within the allowed base dir to prevent directory
      // traversal (mirrors the confinement applied by sibling code tools
      // berry_code_index, berry_code_ast_grep, and berry_code_watch in
      // packages/code/src/tools.ts). The base honors MEMBERRY_INGEST_ALLOW_DIR
      // (e.g. /workspace in docker) via the shared @memberry/core helper.
      const baseDir = getAllowedBaseDir();
      const absPath = path.resolve(args.path);
      if (!absPath.startsWith(baseDir + path.sep) && absPath !== baseDir) {
        throw new Error(`Path must be within project root: ${args.path}`);
      }

      // Phase 1: Scan the codebase
      const scan: CodebaseScan = await scanCodebase(absPath, {
        languages: args.languages,
        excludePatterns: args.exclude_patterns,
      });

      // Resolve final metadata (user overrides > scan detection)
      const projectName = args.project_name ?? scan.name;
      // Canonical tag — matches query-time resolution in @memberry/code so the tag
      // stamped on Symbol nodes and the bootstrap project entity are byte-identical.
      const projectTag = resolveProjectTag(args.project_tag, projectName) ?? `project:${projectName}`;
      const description = args.description ?? scan.description;
      const domain = args.domain ?? scan.domain;

      // Phase 2: Bootstrap the graph
      // Item 14a: persist the confined ingest root so the watcher can be restarted at boot.
      const projectEntity = { name: projectName, type: 'project' as const, description, root_path: absPath };
      const moduleEntities = scan.modules.map((m) => ({
        name: m.name,
        type: m.type,
        description: m.description,
        parent: m.parent === scan.name ? projectName : m.parent,
        ...(m.aliases && m.aliases.length > 0 ? { aliases: m.aliases } : {}),
      }));

      // gap-16: generate human-readable baseline semantic seeds for the project
      // root AND for every bootstrapped module, so wiki module pages are no longer
      // bare stubs. Seeds are low-confidence priors (~0.3) the consolidation pass
      // can later reinforce or supersede. A run-local dedupe guard skips any
      // exact-duplicate claim string; the createSemantic MERGE handles cross-run
      // idempotency.
      type Seed = { claim: string; domain: string; confidence?: number; about?: string[] };
      const semanticSeeds: Seed[] = [];
      const seenClaims = new Set<string>();
      const pushSeed = (seed: Seed): void => {
        const claim = seed.claim.trim();
        if (!claim || seenClaims.has(claim)) return;
        seenClaims.add(claim);
        semanticSeeds.push({ ...seed, claim });
      };

      // Relative entry-point paths (project-root-relative, forward slashes) — used
      // both for the enriched overview seed and for per-module entry-point seeds.
      const relEntryPoints = scan.entryPoints.map((e) =>
        path.relative(absPath, e).split(path.sep).join('/'),
      );
      const languageList = scan.languages.join(', ');

      // 1. Project-overview seed — enriched with the module list (and entry points)
      //    so the project page is substantive, not a one-liner.
      if (description || scan.modules.length > 0) {
        const overviewParts: string[] = [];
        if (description) overviewParts.push(description);
        if (scan.modules.length > 0) {
          overviewParts.push(`Modules: ${scan.modules.map((m) => m.name).join(', ')}`);
        }
        if (relEntryPoints.length > 0) {
          overviewParts.push(`Entry points: ${relEntryPoints.join(', ')}`);
        }
        pushSeed({
          claim: overviewParts.join('. ') + '.',
          domain: 'project-overview',
          confidence: 0.3,
          about: [projectName],
        });
      }

      // 2. Languages seed (root).
      if (scan.languages.length > 0) {
        pushSeed({
          claim: `${projectName} is built with ${languageList}`,
          domain: 'technology',
          confidence: 0.5,
          about: [projectName],
        });
      }

      // 3. Per-module seeds — RESPONSIBILITY, ENTRY-POINT, RELATIONSHIP-SUMMARY.
      for (const m of scan.modules) {
        // RESPONSIBILITY
        const desc = (m.description ?? '').trim();
        pushSeed({
          claim: `${m.name} is a ${m.type} module` + (desc ? `: ${desc}` : ''),
          domain: 'architecture',
          confidence: 0.3,
          about: [m.name],
        });

        // ENTRY-POINT — only when this module owns an entry point. A relative
        // entry path is "under" the module when it has a path segment equal to
        // the module name (matches workspace dirs, top-level source dirs, and
        // src/<name> subdirs without needing the scanner to expose module paths).
        const moduleEntries = relEntryPoints.filter((p) =>
          p.split('/').includes(m.name),
        );
        if (moduleEntries.length > 0) {
          pushSeed({
            claim: `${m.name} entry point(s): ${moduleEntries.join(', ')}`,
            domain: 'architecture',
            confidence: 0.3,
            about: [m.name],
          });
        }

        // RELATIONSHIP-SUMMARY
        pushSeed({
          claim:
            `${m.name} is part of ${projectName}` +
            (languageList ? ` and is written in ${languageList}` : ''),
          domain: 'architecture',
          confidence: 0.3,
          about: [m.name],
        });
      }

      const bootstrapResult = await bootstrapService.bootstrap({
        project_name: projectName,
        project_tag: projectTag,
        description,
        domain,
        entities: [projectEntity, ...moduleEntities],
        semantic_seeds: semanticSeeds,
        agents: [{ id: 'mcp', name: 'Claude Code', type: 'assistant' }],
      });

      // Phase 3: Recursive code indexing
      let indexResult = {
        files_parsed: 0,
        files_skipped: 0,
        symbols_created: 0,
        symbols_updated: 0,
        relations_created: 0,
        errors: [] as Array<{ file: string; error: string }>,
      };

      if (codeIndexerService && scan.sourceFiles.length > 0) {
        // Stamp the canonical project tag (already resolved above) onto every
        // symbol so later berry_code_search/symbols/deps scope by s.project_tag.
        indexResult = await codeIndexerService.indexProject(absPath, {
          exclude: args.exclude_patterns,
          projectTag,
        });

        // Bridge (T6/gap-12): indexProject's ensureFileEntities created
        // `(:Entity:Component {path})` nodes but left them unlinked, so the wiki
        // compiler's `(project)-[:CONTAINS*1..]->(e)` traversal can't see them.
        // Wire each file node to its module Entity and the project here — where
        // the resolved projectName + this run's indexed files are both in scope.
        // Idempotent and scoped to files under absPath; non-fatal (the rest of
        // ingestion already succeeded if this throws).
        if (codeIndexerService.linkComponentsToProject) {
          try {
            // Pass the scanner's authoritative module dirs so the bridge maps
            // each component to a module by LONGEST directory-prefix — e.g. a
            // file under `packages/core/...` resolves to module `core` (the name
            // the bootstrap created), not the `packages` workspace root.
            const knownModules = scan.modules
              .filter((m): m is typeof m & { relPath: string } => typeof m.relPath === 'string' && m.relPath.length > 0)
              .map((m) => ({ name: m.name, relPath: m.relPath }));
            await codeIndexerService.linkComponentsToProject(absPath, projectName, knownModules);
          } catch (err: unknown) {
            console.error('[berry_ingest_codebase] component→project bridge failed (non-fatal):', err);
          }
        }
      }

      // Phase 4: Seed memory blocks
      let blocksSeeded = 0;
      if (memoryBlockService) {
        const moduleList = scan.modules.map((m) => m.name).join(', ');
        const projectStateText = [
          `Project: ${projectName}`,
          description ? `Description: ${description}` : null,
          `Languages: ${scan.languages.join(', ')}`,
          moduleList ? `Modules: ${moduleList}` : null,
          `Files indexed: ${indexResult.files_parsed}`,
          `Symbols: ${indexResult.symbols_created + indexResult.symbols_updated}`,
        ].filter(Boolean).join('. ') + '.';

        try {
          await memoryBlockService.insert(projectTag, 'project_state', projectStateText, undefined, tenantId);
          blocksSeeded++;
        } catch (err: unknown) {
          // Non-fatal — block may already exist
        }

        const personaText = `Agent working on ${projectName}. Domain: ${domain}. Languages: ${scan.languages.join(', ')}.`;
        try {
          await memoryBlockService.insert(projectTag, 'persona', personaText, undefined, tenantId);
          blocksSeeded++;
        } catch (err: unknown) {
          // Non-fatal
        }
      }

      // Phase 5: Return summary
      const totalEntities = bootstrapResult.entities_created + bootstrapResult.entities_existing;
      const lines = [
        '## Codebase Ingestion Complete\n',
        `**Project:** ${projectName} (${projectTag})`,
        `**Domain:** ${domain}`,
        `**Languages:** ${scan.languages.join(', ') || 'none detected'}`,
        `**Source files found:** ${scan.sourceFiles.length}`,
        `**Files indexed:** ${indexResult.files_parsed}`,
        `**Files skipped:** ${indexResult.files_skipped}`,
        `**Symbols created:** ${indexResult.symbols_created}`,
        `**Symbols updated:** ${indexResult.symbols_updated}`,
        `**Code relationships:** ${indexResult.relations_created}`,
        `**Entities bootstrapped:** ${totalEntities} (${bootstrapResult.entities_created} new, ${bootstrapResult.entities_existing} existing)`,
        `**Semantic seeds:** ${bootstrapResult.semantics_created}`,
        `**Memory blocks seeded:** ${blocksSeeded}`,
        `**Modules:** ${scan.modules.map((m) => m.name).join(', ') || 'none'}`,
        `**Entry points:** ${scan.entryPoints.length > 0 ? scan.entryPoints.map((e) => e.replace(absPath + '/', '')).join(', ') : 'none found'}`,
      ];

      if (indexResult.errors.length > 0) {
        lines.push('');
        lines.push(`**Indexing errors:** ${indexResult.errors.length}`);
        for (const err of indexResult.errors.slice(0, 10)) {
          lines.push(`- ${err.file}: ${err.error}`);
        }
        if (indexResult.errors.length > 10) {
          lines.push(`- ... and ${indexResult.errors.length - 10} more`);
        }
      }

      // gap-15 (T10): immediately materialize the wiki for the freshly-ingested
      // codebase. Strict no-op unless MEMBERRY_WIKI_AUTOREFRESH is on + the shared
      // output dir exists; always non-fatal.
      await recompileWikiNow();
      return textContent(lines.join('\n'));
    },

    async berry_memory_read(args) {
      if (!memoryBlockService) throw new Error('MemoryBlockService not initialised');
      if (!args.scope) {
        console.warn('[berry_memory_read] No scope provided — using "default". Pass a project tag (e.g. "project:my-project") for proper scoping.');
      }
      const scope = args.scope ?? 'default';
      const block = await memoryBlockService.read(scope, args.block, args.session_id, tenantId);
      if (!block) {
        return textContent(JSON.stringify({ found: false, block: args.block }));
      }
      return textContent(JSON.stringify(block, null, 2));
    },

    async berry_memory_insert(args) {
      if (!memoryBlockService) throw new Error('MemoryBlockService not initialised');
      if (!args.scope) {
        console.warn('[berry_memory_insert] No scope provided — using "default". Pass a project tag (e.g. "project:my-project") for proper scoping.');
      }
      const scope = args.scope ?? 'default';
      const block = await memoryBlockService.insert(scope, args.block, args.text, args.session_id, tenantId);
      return textContent(JSON.stringify({ ok: true, block: block.name, tier: block.tier, length: block.content.length }));
    },

    async berry_memory_replace(args) {
      if (!memoryBlockService) throw new Error('MemoryBlockService not initialised');
      if (!args.scope) {
        console.warn('[berry_memory_replace] No scope provided — using "default". Pass a project tag (e.g. "project:my-project") for proper scoping.');
      }
      const scope = args.scope ?? 'default';
      const block = await memoryBlockService.replace(scope, args.block, args.old_text, args.new_text, args.session_id, tenantId);
      return textContent(JSON.stringify({ ok: true, block: block.name, tier: block.tier, length: block.content.length }));
    },

    async berry_memory_rewrite(args) {
      if (!memoryBlockService) throw new Error('MemoryBlockService not initialised');
      if (!args.scope) {
        console.warn('[berry_memory_rewrite] No scope provided — using "default". Pass a project tag (e.g. "project:my-project") for proper scoping.');
      }
      const scope = args.scope ?? 'default';
      const block = await memoryBlockService.rewrite(scope, args.block, args.content, args.session_id, tenantId);
      return textContent(JSON.stringify({ ok: true, block: block.name, tier: block.tier, length: block.content.length }));
    },

    async berry_memory_promote(args) {
      if (!memoryBlockService) throw new Error('MemoryBlockService not initialised');
      if (!args.scope) {
        console.warn('[berry_memory_promote] No scope provided — using "default". Pass a project tag (e.g. "project:my-project") for proper scoping.');
      }
      const scope = args.scope ?? 'default';
      const block = await memoryBlockService.promote(scope, args.block, args.from_tier, args.to_tier, args.session_id, tenantId);
      return textContent(JSON.stringify({ ok: true, block: block.name, tier: block.tier }));
    },

    async berry_memory_archive(args) {
      if (!memoryBlockService) throw new Error('MemoryBlockService not initialised');
      if (!args.scope) {
        console.warn('[berry_memory_archive] No scope provided — using "default". Pass a project tag (e.g. "project:my-project") for proper scoping.');
      }
      const scope = args.scope ?? 'default';
      const content = await memoryBlockService.archive(scope, args.block, args.session_id, tenantId);
      return textContent(JSON.stringify({ ok: true, block: args.block, archived_length: content.length }));
    },

    async berry_timeline(args) {
      if (!factStore) throw new Error('FactStore not initialised');
      const tl = await factStore.timeline(args.entity, tenantId);
      // OPT-39: only slice for a positive limit. The schema already rejects
      // 0/negative at the MCP boundary; this defends a direct caller too (a
      // negative would otherwise slice off the tail via a negative end index).
      const facts =
        typeof args.limit === 'number' && args.limit > 0 ? tl.facts.slice(0, args.limit) : tl.facts;

      const lines: string[] = [
        `# Timeline: ${tl.entity}`,
        '',
      ];
      for (const f of facts) {
        const status = f.status !== 'active' ? ` [${f.status}]` : '';
        const validRange = f.invalid_at
          ? `${f.valid_at} → ${f.invalid_at}`
          : `${f.valid_at} → present`;
        lines.push(`- **${f.event}** at ${f.at}: **${f.subject}** ${f.predicate} **${f.object}**${status} (${validRange}, confidence: ${f.confidence.toFixed(2)})`);
      }
      if (facts.length === 0) {
        lines.push('_No facts found for this entity._');
      }
      return textContent(lines.join('\n'));
    },

    async berry_fact_diff(args) {
      if (!factStore) throw new Error('FactStore not initialised');
      const d = await factStore.diff(args.entity, args.from, args.to, tenantId);

      const lines: string[] = [
        `# Fact Diff: ${d.entity}`,
        `**From:** ${d.from}`,
        `**To:** ${d.to}`,
        '',
      ];

      if (d.added.length > 0) {
        lines.push('## Added');
        for (const f of d.added) {
          lines.push(`- **${f.subject}** ${f.predicate} **${f.object}** (confidence: ${f.confidence.toFixed(2)}, since: ${f.valid_at.split('T')[0]})`);
        }
        lines.push('');
      }

      if (d.invalidated.length > 0) {
        lines.push('## Invalidated');
        for (const f of d.invalidated) {
          lines.push(`- ~~**${f.subject}** ${f.predicate} **${f.object}**~~ (was valid: ${f.valid_at.split('T')[0]} → ${f.invalid_at?.split('T')[0] ?? '?'})`);
        }
        lines.push('');
      }

      if (d.changed.length > 0) {
        lines.push('## Changed');
        for (const c of d.changed) {
          lines.push(`- **${c.before.subject}** ${c.before.predicate}: ~~${c.before.object}~~ → **${c.after.object}** (confidence: ${c.after.confidence.toFixed(2)})`);
        }
        lines.push('');
      }

      if (d.added.length === 0 && d.invalidated.length === 0 && d.changed.length === 0) {
        lines.push('_No changes detected in this time range._');
      }

      return textContent(lines.join('\n'));
    },
  };
}

// ─── Tool annotations ────────────────────────────────────────────────────────

const ANN_READONLY: ToolAnnotations = { readOnlyHint: true };
const ANN_READONLY_IDEMPOTENT: ToolAnnotations = { readOnlyHint: true, idempotentHint: true };
const ANN_IDEMPOTENT: ToolAnnotations = { idempotentHint: true };
const ANN_DESTRUCTIVE: ToolAnnotations = { destructiveHint: true };
// Mutating, non-destructive tools. MUST be a non-empty object: the MCP SDK's
// server.tool() overload parser treats an empty `{}` as a zero-param Zod raw
// shape (isZodRawShapeCompat returns true for `{}`), which shifts the real
// handler out of the callback slot and makes the tool throw
// "typedHandler is not a function" on every call. Never pass `{}` as annotations.
const ANN_WRITE: ToolAnnotations = { readOnlyHint: false };

// ─── Tool registration ────────────────────────────────────────────────────────

export interface RegisteredToolSet {
  /** Tier 1 tools — always enabled. */
  tier1: RegisteredTool[];
  /** Tier 2 tools from core package, grouped by domain. */
  domains: Map<ToolDomain, RegisteredTool[]>;
  /** All registered tool handles (Tier 1 + Tier 2). */
  all: RegisteredTool[];
}

/**
 * Register core MemBerry tools on the given server.
 * Returns handles grouped by tier for progressive disclosure.
 */
export function registerTools(
  server: McpServer,
  toolRegistry?: ToolRegistry,
  container: ServiceContainer = defaultContainer,
  opts: { multiTenant?: boolean } = {},
): RegisteredToolSet {
  let handlers = buildToolHandlers(container);
  if (opts.multiTenant) {
    // Default-deny: in a tenant-bound session, every tool NOT proven
    // tenant-isolated is replaced with a refusal, so a not-yet-scoped path can
    // never serve cross-tenant data even if the tenant enables its domain.
    const gated = { ...handlers } as Record<string, (args: unknown) => ToolResult>;
    for (const name of Object.keys(gated)) {
      if (!TENANT_SAFE_TOOLS.has(name)) {
        gated[name] = async () => textContent(
          `**Error:** "${name}" is not available in multi-tenant mode yet (tenant scoping pending). ` +
          `Tenant-safe tools: ${[...TENANT_SAFE_TOOLS].join(', ')}.`,
        );
      }
    }
    handlers = gated as unknown as ToolHandlers;
  }
  const tier1: RegisteredTool[] = [];
  const domains = new Map<ToolDomain, RegisteredTool[]>();

  // Helper to push to domain bucket
  function addToDomain(domain: ToolDomain, handle: RegisteredTool): void {
    let list = domains.get(domain);
    if (!list) { list = []; domains.set(domain, list); }
    list.push(handle);
  }

  // ─── Tier 1 — always enabled ─────────────────────────────────────────────

  tier1.push(server.tool(
    'berry_load',
    'Load memory context for a task. Returns assembled markdown ready for the context window.',
    AmpLoadSchema,
    ANN_READONLY_IDEMPOTENT,
    handlers.berry_load,
  ));

  tier1.push(server.tool(
    'berry_store',
    'Store an episodic memory. Classify durable knowledge with memory_type. An explicit decision with outcome=approved is promoted automatically by the coordinator; patterns and conventions require recurring independent evidence. Returns the new episode ID.',
    AmpStoreSchema,
    ANN_WRITE,
    handlers.berry_store,
  ));

  tier1.push(server.tool(
    'berry_memory_read',
    'Read a memory block by name. Returns the block content, tier, and metadata.',
    AmpMemoryReadSchema,
    ANN_READONLY_IDEMPOTENT,
    handlers.berry_memory_read,
  ));

  tier1.push(server.tool(
    'berry_memory_insert',
    'Append text to a memory block. Creates the block if it does not exist.',
    AmpMemoryInsertSchema,
    ANN_WRITE,
    handlers.berry_memory_insert,
  ));

  tier1.push(server.tool(
    'berry_grep',
    'Search memory content by text pattern (exact string or regex) across all node types: episodic, semantic, fact, block, entity. Returns matched snippets with context.',
    AmpGrepSchema,
    ANN_READONLY_IDEMPOTENT,
    handlers.berry_grep,
  ));

  // ─── Tier 2 — memory domain ──────────────────────────────────────────────

  addToDomain('memory', server.tool(
    'berry_memory_replace',
    'Find and replace text within a memory block. Throws if old_text is not found.',
    AmpMemoryReplaceSchema,
    ANN_WRITE,
    handlers.berry_memory_replace,
  ));

  addToDomain('memory', server.tool(
    'berry_memory_rewrite',
    'Overwrite the entire content of a memory block. Creates the block if it does not exist.',
    AmpMemoryRewriteSchema,
    ANN_WRITE,
    handlers.berry_memory_rewrite,
  ));

  addToDomain('memory', server.tool(
    'berry_memory_promote',
    'Change the tier of a memory block (e.g. working → core). Promoting to core persists to Neo4j.',
    AmpMemoryPromoteSchema,
    ANN_WRITE,
    handlers.berry_memory_promote,
  ));

  addToDomain('memory', server.tool(
    'berry_memory_archive',
    'Archive a memory block: returns its content for the caller to store as an episodic entry, then deletes the block.',
    AmpMemoryArchiveSchema,
    ANN_DESTRUCTIVE,
    handlers.berry_memory_archive,
  ));

  // ─── Tier 2 — temporal domain ────────────────────────────────────────────

  addToDomain('temporal', server.tool(
    'berry_timeline',
    'Chronological fact history for an entity. Shows all facts with creation, invalidation, dispute, and supersession events ordered by time.',
    AmpTimelineSchema,
    ANN_READONLY_IDEMPOTENT,
    handlers.berry_timeline,
  ));

  addToDomain('temporal', server.tool(
    'berry_fact_diff',
    'Show what facts changed about an entity between two timestamps. Returns added, invalidated, and changed facts.',
    AmpFactDiffSchema,
    ANN_READONLY_IDEMPOTENT,
    handlers.berry_fact_diff,
  ));

  // ─── Tier 2 — admin domain ───────────────────────────────────────────────

  addToDomain('admin', server.tool(
    'berry_query',
    'Run a raw Cypher query against the Neo4j knowledge graph. Returns JSON rows.',
    AmpQuerySchema,
    ANN_READONLY_IDEMPOTENT,
    handlers.berry_query,
  ));

  addToDomain('admin', server.tool(
    'berry_consolidate',
    'Manage memory consolidation: run a consolidation pass, check status, or review a proposal.',
    AmpConsolidateSchema,
    ANN_WRITE,
    handlers.berry_consolidate,
  ));

  addToDomain('admin', server.tool(
    'berry_bootstrap',
    'Bootstrap the knowledge graph for a project. Creates Entity nodes (project, modules, services, components), Agent nodes, seed Semantic principles, and CONTAINS/ABOUT relationships. Idempotent — safe to run multiple times. Call this ONCE when first working with a new project to seed the graph so that berry_store/berry_load/berry_consolidate have structure to work with.',
    AmpBootstrapSchema,
    ANN_IDEMPOTENT,
    handlers.berry_bootstrap,
  ));

  addToDomain('admin', server.tool(
    'berry_resolve',
    'Resolve an MemBerry URI (memberry://entity/Name or memberry://tag/name) to rendered markdown. Use for loading Layer 3 reference material referenced in MWP stage CONTEXT.md files.',
    AmpResolveSchema,
    ANN_READONLY,
    handlers.berry_resolve,
  ));

  addToDomain('admin', server.tool(
    'berry_ingest_codebase',
    'One-shot codebase ingestion: scans repo structure, bootstraps the knowledge graph with project/module entities, indexes all source code via tree-sitter, and seeds memory blocks. Use for first-time project setup. Combines berry_bootstrap + berry_code_index + memory seeding in one call.',
    AmpIngestCodebaseSchema,
    { openWorldHint: true } satisfies ToolAnnotations,
    handlers.berry_ingest_codebase,
  ));

  addToDomain('admin', server.tool(
    'berry_provenance',
    'Trace the full lifecycle of a semantic memory node: its origin lineage (PROMOTED_FROM the episode it was consolidated from, and any SUPERSEDES chain) plus its supersession history (the predecessors it replaced, with their confidence). Use to audit where a piece of knowledge came from and how it evolved. Pass a semantic_id from berry_load/berry_grep results.',
    AmpProvenanceSchema,
    ANN_READONLY_IDEMPOTENT,
    handlers.berry_provenance,
  ));

  // ─── Tier 1 — berry_tools gateway ──────────────────────────────────────────

  tier1.push(server.tool(
    'berry_tools',
    'Progressive disclosure gateway. List available tool domains and enable/disable them on demand. Tier 1 tools (berry_load, berry_store, berry_grep, berry_memory_read, berry_memory_insert, berry_context, berry_tools) are always available. All other tools are grouped into domains that start disabled to reduce context window pollution.',
    AmpToolsSchema,
    ANN_READONLY_IDEMPOTENT,
    async (args: { action: 'list' | 'enable' | 'disable'; domain?: string }) => {
      // Use the registry passed at server creation time
      const registry = toolRegistry;
      if (!registry) {
        return textContent(JSON.stringify({ error: 'Tool registry not available' }));
      }

      switch (args.action) {
        case 'list': {
          const domainList: DomainInfo[] = [];
          for (const [domainName, handles] of registry.entries()) {
            const desc = DOMAIN_DESCRIPTIONS[domainName] ?? domainName;
            const toolNames = DOMAIN_TOOL_NAMES_MAP[domainName] ?? [];
            const enabled = handles.length > 0 && handles[0].enabled;
            domainList.push({
              domain: domainName,
              description: desc,
              tools: toolNames,
              enabled,
            });
          }
          return textContent(JSON.stringify({ domains: domainList }, null, 2));
        }
        case 'enable': {
          if (!args.domain) {
            return textContent(JSON.stringify({ error: 'domain parameter required for enable action' }));
          }
          if (args.domain === 'all') {
            for (const handles of registry.values()) {
              for (const h of handles) h.enable();
            }
            server.sendToolListChanged();
            return textContent(JSON.stringify({ ok: true, action: 'enabled', domain: 'all' }));
          }
          const handles = registry.get(args.domain as ToolDomain);
          if (!handles) {
            return textContent(JSON.stringify({ error: `Unknown domain: ${args.domain}. Available: ${[...registry.keys()].join(', ')}` }));
          }
          for (const h of handles) h.enable();
          server.sendToolListChanged();
          return textContent(JSON.stringify({ ok: true, action: 'enabled', domain: args.domain }));
        }
        case 'disable': {
          if (!args.domain) {
            return textContent(JSON.stringify({ error: 'domain parameter required for disable action' }));
          }
          if (args.domain === 'all') {
            for (const handles of registry.values()) {
              for (const h of handles) h.disable();
            }
            server.sendToolListChanged();
            return textContent(JSON.stringify({ ok: true, action: 'disabled', domain: 'all' }));
          }
          const handles = registry.get(args.domain as ToolDomain);
          if (!handles) {
            return textContent(JSON.stringify({ error: `Unknown domain: ${args.domain}. Available: ${[...registry.keys()].join(', ')}` }));
          }
          for (const h of handles) h.disable();
          server.sendToolListChanged();
          return textContent(JSON.stringify({ ok: true, action: 'disabled', domain: args.domain }));
        }
        default: {
          return textContent(JSON.stringify({ error: `Unknown action: ${args.action}` }));
        }
      }
    },
  ));

  // Merge core domains into toolRegistry if provided
  if (toolRegistry) {
    for (const [domain, handles] of domains.entries()) {
      const existing = toolRegistry.get(domain);
      if (existing) {
        existing.unshift(...handles);
      } else {
        toolRegistry.set(domain, handles);
      }
    }
  }

  const all = [...tier1];
  for (const handles of domains.values()) {
    all.push(...handles);
  }

  return { tier1, domains, all };
}

// ─── Domain tool name mapping ────────────────────────────────────────────────

/**
 * Tools that are always enabled (Tier 1) and therefore intentionally absent
 * from DOMAIN_TOOL_NAMES_MAP. Kept explicit so the drift-guard test can verify
 * that every registered tool is accounted for as either Tier 1 or a domain tool.
 */
export const ALWAYS_ON_TOOL_NAMES = [
  'berry_load', 'berry_store', 'berry_grep', 'berry_memory_read', 'berry_memory_insert',
  'berry_tools', 'berry_context', 'berry_ask',
] as const;

/** Map of domain → tool names, for listing in berry_tools. */
export const DOMAIN_TOOL_NAMES_MAP: Record<ToolDomain, string[]> = {
  memory: ['berry_memory_replace', 'berry_memory_rewrite', 'berry_memory_promote', 'berry_memory_archive'],
  temporal: ['berry_timeline', 'berry_fact_diff'],
  admin: ['berry_query', 'berry_consolidate', 'berry_bootstrap', 'berry_resolve', 'berry_ingest_codebase', 'berry_provenance'],
  research: ['berry_research_init', 'berry_research_log', 'berry_research_context', 'berry_research_tree', 'berry_research_contradictions', 'berry_research_consolidate'],
  code: ['berry_code_index', 'berry_code_search', 'berry_code_ast_grep', 'berry_code_symbols', 'berry_code_deps', 'berry_code_context', 'berry_code_watch'],
  arch: ['berry_arch_register', 'berry_arch_relate', 'berry_arch_aspect', 'berry_impact', 'berry_arch_drift', 'berry_arch_context'],
  wiki: ['berry_compile', 'berry_ingest', 'berry_lint', 'berry_braindump', 'berry_wiki_sync'],
  retrieval: ['berry_feedback'],
  graph: ['berry_graph_report', 'berry_graph_export', 'berry_pr_impact', 'berry_pr_conflicts'],
};
