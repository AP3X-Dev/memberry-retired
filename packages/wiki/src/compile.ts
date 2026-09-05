// packages/wiki/src/compile.ts
// V2 compiler: walks the MemBerry graph and compiles a multi-project wiki with
// subdirectory layout, episodic history, library, topics, and portal homepage.

import type { Driver } from 'neo4j-driver';
import { writeFile, mkdir, rm, readdir, open, readFile, unlink, stat, lstat, rename } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type {
  CompileV2Result,
  EntityInfo,
  EpisodicEntry,
  ProjectData,
  SourceInfo,
  LibraryPage,
  TopicData,
  PortalData,
  ArticleFrontmatter,
  ResolvedClaim,
} from './types.js';
import {
  fetchAllProjects,
  fetchEpisodicProjectScopes,
  fetchProjectEntities,
  fetchEntitiesModifiedByProject,
  fetchSemanticsForEntity,
  fetchEpisodicsForProject,
  fetchEpisodicsForEntities,
  fetchHierarchy,
  fetchBacklinks,
  fetchRelatedEntities,
  fetchSourcesForEntity,
  fetchInboundLinkCount,
  fetchAllSources,
  fetchClaimsForSource,
  fetchAllTags,
  fetchAllSemantics,
  fetchGraphStats,
  fetchRecentEpisodics,
} from './queries.js';
import type { HierarchyRef } from './queries.js';
import { DEFAULT_TENANT } from '@memberry/core';
import {
  renderFrontmatter,
  renderEntityArticle,
  renderProjectIndex,
  renderPortalHomepage,
  renderLibraryIndex,
  renderLibraryPage,
  renderTopicIndex,
  renderTopicPage,
  renderDecisionsPage,
  renderPatternsPage,
  renderRecentChanges,
  renderProjectGraph,
  renderDisambiguationStub,
  patternKnowledgeCount,
  isDecisionSemantic,
} from './renderers.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Repo-relative path for a code entity. Indexed file paths look like
 * `/app/<repo>-index-<hash>/<relative>`; strip the container + index-root prefix
 * so the wiki can display and disambiguate by `src/engine/__init__.py` instead of
 * a bare, collision-prone basename. Falls back to the input if there is no
 * index-root segment.
 */
export function relativeEntityPath(path: string | undefined | null): string {
  if (!path) return '';
  const segs = path.replace(/\\/g, '/').split('/').filter(Boolean);
  const idx = segs.findIndex((s) => s.includes('-index-'));
  const rel = idx >= 0 ? segs.slice(idx + 1) : segs;
  return rel.join('/') || path;
}

/** Reserve a unique slug, suffixing `-2`, `-3`, … on collision. */
function uniquifySlug(slug: string, used: Set<string>): string {
  const base = slug || 'entity';
  let candidate = base;
  let n = 2;
  while (used.has(candidate)) candidate = `${base}-${n++}`;
  used.add(candidate);
  return candidate;
}

/**
 * Give every entity a unique `slug`. Names that are unique within the set keep
 * their plain name-slug (so existing name-based wikilinks keep resolving); names
 * shared by 2+ entities (e.g. 36 distinct `__init__.py` files) are disambiguated
 * by their repo-relative path. The bare name-slug of a colliding group is reserved
 * for a disambiguation stub (written by the compile loop), so residual name-based
 * links never dead-end.
 */
function assignUniqueSlugs(entities: EntityInfo[]): void {
  const byBase = new Map<string, EntityInfo[]>();
  for (const e of entities) {
    const base = slugify(e.name);
    const list = byBase.get(base);
    if (list) list.push(e);
    else byBase.set(base, [e]);
  }
  const used = new Set<string>();
  // Pass 1: reserve every unique name-slug and every colliding base (the latter
  // for its stub) BEFORE assigning any path-slug, so path-slugs can't steal them.
  for (const [base, group] of byBase) {
    if (group.length === 1) group[0].slug = uniquifySlug(base, used);
    else used.add(base);
  }
  // Pass 2: colliding names disambiguate by repo-relative path.
  for (const [base, group] of byBase) {
    if (group.length <= 1) continue;
    for (const e of group) {
      const rel = relativeEntityPath(e.path);
      e.slug = uniquifySlug(rel ? slugify(rel) : base, used);
    }
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── OPT-9: cross-process compile lock ───────────────────────────────────────
//
// The served wiki dir (`/app/wiki`) is a Docker named-volume MOUNT POINT shared
// by TWO writers, each of which calls WikiCompiler.compile():
//   1. the wiki SERVICE container's startup `build` (compile + serve + watch), and
//   2. the MCP container's autorefresh recompile on ingest.
// Both clear-then-rebuild the same directory. Without a lock their child-rm /
// re-emit phases interleave, so one writer deletes files the other just wrote and
// the served wiki is transiently structurally incomplete. An advisory lockfile in
// the output dir, acquired with O_EXCL, serializes the two compiles: whichever
// acquires first runs to completion, the other waits and then runs. Because the
// guard lives INSIDE compile() (which both writers call), one change protects both.

/**
 * OPT-10: top-level sentinel the compiler rewrites LAST on every compile. The
 * served viewer watches for changes to this single top-level file (reliable under
 * fs.watch, unlike the nested project dirs) to trigger a full cache rebuild after
 * an MCP-side recompile. Exported so the viewer references the exact same name.
 */
export const COMPILED_MARKER_FILENAME = '.compiled';

/**
 * The compiler never mutates the directory currently served by the viewer.
 * Complete trees live below this private directory and a tiny pointer selects
 * the active global tree. Keeping both names stable also makes the layout
 * portable across the MCP/wiki containers sharing a named volume.
 */
export const WIKI_GENERATIONS_DIRNAME = '.generations';
export const ACTIVE_GENERATION_FILENAME = '.active-generation';
const GLOBAL_GENERATIONS_DIRNAME = 'global';
const SCOPED_GENERATIONS_DIRNAME = 'scoped';
const GENERATIONS_TO_RETAIN = 3;

interface ActiveGenerationPointer {
  version: 1;
  path: string;
  published_at: string;
}

function parseActiveGenerationPointer(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as Partial<ActiveGenerationPointer>;
    return typeof parsed.path === 'string' ? parsed.path : null;
  } catch {
    // Early development builds used a plain relative path. Accepting it keeps
    // those volumes readable while all new publications use versioned JSON.
    return trimmed;
  }
}

function isGlobalGenerationPath(value: string): boolean {
  const normalized = value.replace(/\\/g, '/');
  return /^\.generations\/global\/gen-[a-zA-Z0-9-]+$/.test(normalized);
}

/**
 * Resolve the immutable tree selected by the atomic pointer. A volume created
 * before generation publication has no pointer and therefore continues to
 * serve its legacy root tree unchanged.
 */
export async function resolvePublishedWikiDir(outputDir: string): Promise<string> {
  let relativePath: string | null = null;
  try {
    relativePath = parseActiveGenerationPointer(
      await readFile(join(outputDir, ACTIVE_GENERATION_FILENAME), 'utf-8'),
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  if (relativePath && isGlobalGenerationPath(relativePath)) {
    const generationDir = join(outputDir, ...relativePath.replace(/\\/g, '/').split('/'));
    try {
      const [generationStat, markerStat] = await Promise.all([
        lstat(generationDir),
        stat(join(generationDir, COMPILED_MARKER_FILENAME)),
      ]);
      if (generationStat.isDirectory() && !generationStat.isSymbolicLink() && markerStat.isFile()) return generationDir;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  // A pointer can be lost/corrupted by an interrupted volume migration or refer
  // to a manually removed tree. Recover by selecting the newest completed
  // generation; `.building-*` directories and trees without the final marker
  // are never eligible. If none exist, retain pre-generation root compatibility.
  const globalDir = join(outputDir, WIKI_GENERATIONS_DIRNAME, GLOBAL_GENERATIONS_DIRNAME);
  let entries: import('node:fs').Dirent[] = [];
  try {
    entries = await readdir(globalDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  for (const entry of entries
    .filter((candidate) => candidate.isDirectory() && candidate.name.startsWith('gen-'))
    .sort((left, right) => right.name.localeCompare(left.name))) {
    const candidate = join(globalDir, entry.name);
    try {
      if ((await stat(join(candidate, COMPILED_MARKER_FILENAME))).isFile()) return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return outputDir;
}

async function publishGenerationPointer(outputDir: string, generationName: string): Promise<void> {
  const relativePath = `${WIKI_GENERATIONS_DIRNAME}/${GLOBAL_GENERATIONS_DIRNAME}/${generationName}`;
  const pointer: ActiveGenerationPointer = {
    version: 1,
    path: relativePath,
    published_at: new Date().toISOString(),
  };
  const pointerPath = join(outputDir, ACTIVE_GENERATION_FILENAME);
  const tempPath = join(outputDir, `${ACTIVE_GENERATION_FILENAME}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, JSON.stringify(pointer), 'utf-8');
    // Same-directory rename is the portable atomic publication primitive for
    // the shared Docker volume. If replacement is unsupported, fail closed and
    // leave the previous pointer/tree active rather than unlinking it first.
    await rename(tempPath, pointerPath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
}

async function cleanupOldGenerations(parentDir: string, activeName: string): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(parentDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }

  const completed = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('gen-'))
    .map((entry) => entry.name)
    .sort()
    .reverse();

  // The compile lock proves no other writer is using a `.building-*` tree.
  // Removing crash residue here prevents incomplete generations accumulating
  // forever while keeping all completed rollback candidates untouched.
  for (const entry of entries.filter((candidate) => candidate.isDirectory() && candidate.name.startsWith('.building-'))) {
    await rm(join(parentDir, entry.name), { recursive: true, force: true }).catch((err) => {
      console.error('[wiki-compile] Failed to clean incomplete generation:', entry.name, err instanceof Error ? err.message : err);
    });
  }
  const keep = new Set([activeName, ...completed.slice(0, GENERATIONS_TO_RETAIN)]);
  for (const name of completed) {
    if (keep.has(name)) continue;
    try {
      await rm(join(parentDir, name), { recursive: true, force: true });
    } catch (err) {
      // Publication already succeeded. Cleanup is bounded best-effort and must
      // never roll back a healthy active tree.
      console.error('[wiki-compile] Failed to clean stale generation:', name, err instanceof Error ? err.message : err);
    }
  }
}

export const COMPILE_LOCK_FILENAME = '.compile.lock';
/** Cold graph compiles can take many minutes; a one-minute lease was unsafe. */
const COMPILE_LOCK_STALE_MS = 30 * 60_000;
/** Renew often enough that a healthy slow compile never approaches expiry. */
const COMPILE_LOCK_HEARTBEAT_MS = 60_000;
/** Allow one contender to observe and recover a full stale lease. */
const COMPILE_LOCK_TIMEOUT_MS = 35 * 60_000;
/** Poll interval while waiting for the holder to release. */
const COMPILE_LOCK_RETRY_MS = 250;

export interface WikiCompilerOptions {
  /** Tenant whose Semantic/Episodic nodes are compiled (defaults to DEFAULT_TENANT). */
  tenantId?: string;
  /** @internal Primarily exposed for deterministic lease-contention tests. */
  compileLockStaleMs?: number;
  /** @internal Primarily exposed for deterministic lease-contention tests. */
  compileLockHeartbeatMs?: number;
  /** @internal Primarily exposed for deterministic lease-contention tests. */
  compileLockTimeoutMs?: number;
  /** @internal Primarily exposed for deterministic lease-contention tests. */
  compileLockRetryMs?: number;
}

interface CompileLockTimings {
  staleMs: number;
  heartbeatMs: number;
  timeoutMs: number;
  retryMs: number;
}

function compileLockTimings(options: WikiCompilerOptions): CompileLockTimings {
  const timings = {
    staleMs: options.compileLockStaleMs ?? COMPILE_LOCK_STALE_MS,
    heartbeatMs: options.compileLockHeartbeatMs ?? COMPILE_LOCK_HEARTBEAT_MS,
    timeoutMs: options.compileLockTimeoutMs ?? COMPILE_LOCK_TIMEOUT_MS,
    retryMs: options.compileLockRetryMs ?? COMPILE_LOCK_RETRY_MS,
  };
  if (Object.values(timings).some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error('Wiki compile lock timings must be positive finite numbers');
  }
  if (timings.heartbeatMs >= timings.staleMs) {
    throw new Error('Wiki compile lock heartbeat must be shorter than its stale lease');
  }
  return timings;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface CompileLockPayload {
  pid: number;
  at: string;
  token: string;
}

interface CompileLockLease {
  token: string;
  handle: FileHandle;
}

/** Lockfile payload includes a unique owner token for owner-safe release. */
function lockPayload(token: string): string {
  return JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token });
}

function parseLockPayload(body: string): CompileLockPayload | null {
  try {
    const parsed = JSON.parse(body) as Partial<CompileLockPayload>;
    if (typeof parsed.pid !== 'number' || typeof parsed.at !== 'string' || typeof parsed.token !== 'string') return null;
    if (Number.isNaN(Date.parse(parsed.at)) || parsed.token.length === 0) return null;
    return parsed as CompileLockPayload;
  } catch {
    return null;
  }
}

async function lockAgeMs(lockPath: string, body: string): Promise<number | null> {
  const parsed = parseLockPayload(body);
  if (parsed) return Date.now() - Date.parse(parsed.at);
  try {
    const legacy = JSON.parse(body) as { at?: unknown };
    if (typeof legacy.at === 'string' && !Number.isNaN(Date.parse(legacy.at))) {
      return Date.now() - Date.parse(legacy.at);
    }
  } catch { /* fall through to filesystem age */ }
  // A contender can observe the file in the tiny window between O_EXCL create
  // and payload write. Use mtime for malformed/legacy files instead of declaring
  // them stale immediately and deleting a live owner's lock.
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Acquire the cross-process compile lock for `outputDir`. Resolves once held.
 * Uses `open(path, 'wx')` (O_EXCL) as the atomic create-or-fail primitive. On
 * contention it waits and retries; if the existing lock is older than the stale
 * threshold, it breaks the lock and retries. After the overall timeout it fails
 * closed instead of running a second clear-and-rebuild concurrently. The dir is
 * created first so the lockfile has somewhere to live; this is mount-safe.
 */
async function acquireCompileLock(outputDir: string, timings: CompileLockTimings): Promise<CompileLockLease> {
  await mkdir(outputDir, { recursive: true });
  const lockPath = join(outputDir, COMPILE_LOCK_FILENAME);
  const deadline = Date.now() + timings.timeoutMs;
  const token = randomUUID();

  for (;;) {
    try {
      const handle = await open(lockPath, 'wx');
      try {
        await handle.writeFile(lockPayload(token), 'utf-8');
        // Keep this handle open for owner-safe heartbeat writes. If a stale-lock
        // contender ever unlinks the path, writes through this handle stay on
        // the old inode and cannot overwrite a successor's lock.
        return { token, handle };
      } catch (err) {
        await handle.close().catch(() => {});
        throw err;
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        // Windows can report EPERM rather than EEXIST when another process
        // keeps the lock FileHandle open. Treat it as contention only when the
        // exact lock path still exists; unrelated permission failures surface.
        if (code !== 'EPERM') throw err;
        try {
          await lstat(lockPath);
        } catch {
          throw err;
        }
      }

      // Contention: inspect the holder. Break it if it looks stale.
      let body: string | null = null;
      try {
        body = await readFile(lockPath, 'utf-8');
      } catch (readErr) {
        if ((readErr as NodeJS.ErrnoException).code === 'ENOENT') continue;
      }
      const ageMs = body === null ? null : await lockAgeMs(lockPath, body);
      if (ageMs !== null && ageMs > timings.staleMs) {
        // Re-read before breaking so we do not remove a successor lock that
        // replaced the stale file while it was being inspected.
        let current: string | null = null;
        try { current = await readFile(lockPath, 'utf-8'); } catch { /* retry */ }
        if (current !== body || current === null) continue;
        const currentAgeMs = await lockAgeMs(lockPath, current);
        if (currentAgeMs === null || currentAgeMs <= timings.staleMs) continue;
        await rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for wiki compile lock after ${timings.timeoutMs}ms`);
      }
      await sleep(timings.retryMs);
    }
  }
}

/** Renew a held lease until stopped, but never write through another owner's path. */
function startCompileLockHeartbeat(
  outputDir: string,
  lease: CompileLockLease,
  heartbeatMs: number,
): () => Promise<void> {
  const lockPath = join(outputDir, COMPILE_LOCK_FILENAME);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> = Promise.resolve();

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      inFlight = (async () => {
        try {
          const current = parseLockPayload(await readFile(lockPath, 'utf-8'));
          if (!current || current.token !== lease.token) {
            stopped = true;
            return;
          }
          const payload = Buffer.from(lockPayload(lease.token), 'utf-8');
          await lease.handle.truncate(0);
          await lease.handle.write(payload, 0, payload.length, 0);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            stopped = true;
            return;
          }
          console.error('[wiki-compile] Compile lock heartbeat failed:', err instanceof Error ? err.message : err);
        } finally {
          schedule();
        }
      })();
    }, heartbeatMs);
    timer.unref?.();
  };
  schedule();

  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await inFlight;
    await lease.handle.close().catch(() => {});
  };
}

/** Release the compile lock. Best-effort; a missing lockfile is not an error. */
async function releaseCompileLock(outputDir: string, token: string): Promise<void> {
  const lockPath = join(outputDir, COMPILE_LOCK_FILENAME);
  try {
    const current = parseLockPayload(await readFile(lockPath, 'utf-8'));
    if (!current || current.token !== token) return;
    await unlink(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[wiki-compile] Failed to release compile lock:', err instanceof Error ? err.message : err);
    }
  }
}

/**
 * gap-13: extract the bare project name from the STRUCTURED fields berry_store
 * persists — `ep.scope` (e.g. "project:agent-assist-cr") first, then any
 * `project:*` entry in `ep.tags`. Returns '' if neither carries a project scope.
 * This is the canonical association; the task/content `[project:…]` prefix and
 * the session_id heuristic remain only as fallbacks (see deriveEpisodicScope).
 */
export function structuredEpisodicScope(ep: EpisodicEntry): string {
  if (ep.scope && /^project:/i.test(ep.scope)) return ep.scope.replace(/^project:/i, '');
  const tag = (ep.tags ?? []).find((t) => /^project:/i.test(t));
  if (tag) return tag.replace(/^project:/i, '');
  return '';
}

/**
 * Best-effort project attribution for an episode. gap-13: PREFER the structured
 * `ep.scope`/`ep.tags` (canonical, set by berry_store); only when absent fall
 * back to the `[project:…]` task prefix, then a `[project:…]` prefix in content,
 * then a known project name appearing as a token in its session_id
 * (e.g. session-20260608-ag3ntic-morph → ag3ntic). Returns '' if none match.
 */
export function deriveEpisodicScope(ep: EpisodicEntry, knownSlugs: string[]): string {
  const structured = structuredEpisodicScope(ep);
  if (structured) return structured;
  if (ep.project_scope) return ep.project_scope;
  const fromContent = (ep.content ?? '').match(/^\[project:([^\]]+)\]/);
  if (fromContent) return fromContent[1];
  const sid = (ep.session_id ?? '').toLowerCase();
  for (const slug of knownSlugs) { // caller sorts longest-first → most specific wins
    if (slug.length < 3) continue;
    if (new RegExp('(^|[^a-z0-9])' + escapeRegExp(slug) + '($|[^a-z0-9])').test(sid)) return slug;
  }
  return '';
}

/** Resolve entity references in claim text to [[wikilinks]] */
export function resolveInlineLinks(text: string, entityRefs: string[], projectSlug: string): string {
  let resolved = text;
  const sorted = [...entityRefs].sort((a, b) => b.length - a.length);
  for (const ref of sorted) {
    const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'gi');
    const entitySlug = slugify(ref);
    const wikilink = `[[projects/${projectSlug}/${entitySlug}|${ref}]]`;
    resolved = resolved.replace(re, (match, offset) => {
      // Avoid double-linking: skip if this match is inside an existing [[wikilink]]
      const before = resolved.slice(0, offset);
      const openCount = (before.match(/\[\[/g) ?? []).length;
      const closeCount = (before.match(/\]\]/g) ?? []).length;
      if (openCount > closeCount) return match;
      return wikilink;
    });
  }
  return resolved;
}

async function writeMarkdown(filePath: string, content: string): Promise<void> {
  await mkdir(join(filePath, '..'), { recursive: true });
  await writeFile(filePath, content, 'utf-8');
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function projectNameScore(name: string): number {
  const trimmed = name.trim();
  let score = 0;
  if (!/^__.*__$/.test(trimmed)) score += 100;
  if (/[A-Z]/.test(trimmed)) score += 10;
  if (/\s/.test(trimmed)) score += 5;
  if (!trimmed.includes('_')) score += 3;
  if (!/^[a-z0-9-]+$/.test(trimmed)) score += 2;
  return score;
}

function chooseProjectEntity(a: EntityInfo, b: EntityInfo): EntityInfo {
  const preferred = projectNameScore(b.name) > projectNameScore(a.name) ? b : a;
  const fallback = preferred === a ? b : a;
  return {
    ...preferred,
    description: preferred.description ?? fallback.description,
    aliases: preferred.aliases ?? fallback.aliases,
    created_at: preferred.created_at ?? fallback.created_at,
  };
}

function mergeProjectData(a: ProjectData, b: ProjectData): ProjectData {
  const substantive = uniqueById([...a.substantive_entities, ...b.substantive_entities]);
  const substantiveIds = new Set(substantive.map((e) => e.id));
  const sparse = uniqueById([...a.sparse_entities, ...b.sparse_entities])
    .filter((e) => !substantiveIds.has(e.id));
  const episodics = uniqueById([...a.episodics, ...b.episodics])
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
  const semantics = uniqueById([...a.semantics, ...b.semantics]);

  return {
    entity: chooseProjectEntity(a.entity, b.entity),
    entities: uniqueById([...a.entities, ...b.entities]),
    substantive_entities: substantive,
    sparse_entities: sparse,
    episodics,
    semantics,
  };
}

function isInternalProjectName(name: string): boolean {
  return name.trim().startsWith('__');
}

function hasHumanNavigableContent(project: ProjectData): boolean {
  return project.entities.length > 0 || project.semantics.length > 0 || project.episodics.length > 0;
}

function canonicalizeHumanProjects(projects: ProjectData[]): ProjectData[] {
  const bySlug = new Map<string, ProjectData>();
  for (const project of projects) {
    const slug = slugify(project.entity.name);
    const key = slug || project.entity.name.trim().toLowerCase();
    const existing = bySlug.get(key);
    bySlug.set(key, existing ? mergeProjectData(existing, project) : project);
  }

  return [...bySlug.values()]
    .filter((project) => !isInternalProjectName(project.entity.name))
    .filter(hasHumanNavigableContent)
    .sort((a, b) => a.entity.name.localeCompare(b.entity.name));
}

function normalizeCompileScope(projectTag: string | undefined): string | null {
  const trimmed = projectTag?.trim();
  if (!trimmed || trimmed === 'all' || trimmed === '*' || trimmed.toLowerCase() === 'project:all') {
    return null;
  }
  return trimmed.replace(/^project:/i, '');
}

function sameProjectScope(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase() || slugify(left) === slugify(right);
}

function semanticProjectScopes(sem: { tags: string[]; scope?: string }): string[] {
  const scopes: string[] = [];
  if (sem.scope && /^project:/i.test(sem.scope)) scopes.push(sem.scope.replace(/^project:/i, ''));
  for (const tag of sem.tags) {
    if (/^project:/i.test(tag)) scopes.push(tag.replace(/^project:/i, ''));
  }
  return [...new Set(scopes.filter(Boolean))];
}

function semanticPrimaryProjectScope(sem: { tags: string[]; scope?: string }): string | null {
  return semanticProjectScopes(sem)[0] ?? null;
}

function semanticMatchesScope(sem: { tags: string[]; scope?: string }, projectScope: string | null): boolean {
  if (!projectScope) return true;
  return semanticProjectScopes(sem).some((scope) => sameProjectScope(scope, projectScope));
}

function entityMatchesScope(entity: EntityInfo, projectScope: string | null): boolean {
  return !projectScope || sameProjectScope(entity.name, projectScope) || sameProjectScope(entity.slug, projectScope);
}

function episodicMatchesScope(ep: EpisodicEntry, projectScope: string | null): boolean {
  if (!projectScope) return true;
  // gap-13: structured `ep.scope`/`ep.tags` is the primary association; the
  // task-prefix-derived `project_scope` stays as a back-compat fallback. Both
  // sides are normalized through sameProjectScope (lowercase + slugify) so
  // `project:agent-assist-cr` compares equal regardless of which source it came
  // from.
  const structured = structuredEpisodicScope(ep);
  if (structured && sameProjectScope(structured, projectScope)) return true;
  return ep.project_scope != null && sameProjectScope(ep.project_scope, projectScope);
}

function sourceMatchesScope(source: SourceInfo, projectScope: string | null): boolean {
  if (!projectScope) return true;
  const sourceScope = source.project_tag.replace(/^project:/i, '');
  return sameProjectScope(sourceScope, projectScope);
}

// ─── Main compiler ──────────────────────────────────────────────────────────

export class WikiCompiler {
  constructor(private driver: Driver, private options: WikiCompilerOptions = {}) {}

  async compile(outputDir: string, projectTag = 'all'): Promise<CompileV2Result> {
    const projectScope = normalizeCompileScope(projectTag);
    const result: CompileV2Result = {
      projects_compiled: 0,
      articles_compiled: 0,
      episodics_rendered: 0,
      library_pages: 0,
      topic_pages: 0,
      cross_project_pages: 0,
      output_dir: outputDir,
    };

    // Serialize generation creation and publication across the MCP autorefresh
    // writer and the wiki-service startup writer. Readers never wait on this
    // lock: they keep resolving the previous immutable active generation until
    // the final pointer rename below.
    const lockTimings = compileLockTimings(this.options);
    const lockLease = await acquireCompileLock(outputDir, lockTimings);
    const stopLockHeartbeat = startCompileLockHeartbeat(outputDir, lockLease, lockTimings.heartbeatMs);
    const generationName = `gen-${Date.now().toString().padStart(13, '0')}-${randomUUID()}`;
    const generationParent = projectScope
      ? join(outputDir, WIKI_GENERATIONS_DIRNAME, SCOPED_GENERATIONS_DIRNAME, slugify(projectScope) || 'project')
      : join(outputDir, WIKI_GENERATIONS_DIRNAME, GLOBAL_GENERATIONS_DIRNAME);
    const buildingDir = join(generationParent, `.building-${generationName}`);
    const generationDir = join(generationParent, generationName);
    try {
      await mkdir(generationParent, { recursive: true });
      await this.compileLocked(buildingDir, projectScope, result);
      await rename(buildingDir, generationDir);

      if (projectScope) {
        // Scoped compiles are intentionally unpublished artifacts. Publishing
        // one would replace the complete served portal with a partial project
        // tree. Return its concrete location so CLI/MCP callers can inspect or
        // export it without affecting the global viewer.
        result.output_dir = generationDir;
      } else {
        await publishGenerationPointer(outputDir, generationName);
        // Top-level notification only; the selected tree has its own .compiled
        // marker. Watchers that miss the pointer rename still observe this file.
        await writeFile(join(outputDir, COMPILED_MARKER_FILENAME), generationName, 'utf-8').catch((err) => {
          console.error('[wiki-compile] Published generation but failed to update watcher marker:', err instanceof Error ? err.message : err);
        });
      }
      await cleanupOldGenerations(generationParent, generationName).catch((err) => {
        console.error('[wiki-compile] Published generation but cleanup failed:', err instanceof Error ? err.message : err);
      });
      return result;
    } catch (err) {
      // An incomplete directory is never reachable from the active pointer.
      // Remove it eagerly; if the process crashes, its `.building-*` name keeps
      // it distinguishable and a later maintenance pass can remove it safely.
      await rm(buildingDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    } finally {
      await stopLockHeartbeat();
      await releaseCompileLock(outputDir, lockLease.token);
    }
  }

  private async compileLocked(
    outputDir: string,
    projectScope: string | null,
    result: CompileV2Result,
  ): Promise<CompileV2Result> {
    const tenantId = this.options.tenantId ?? DEFAULT_TENANT;
    // Every compile targets a new private generation directory. No served tree
    // is cleared or mutated while requests are reading it.
    await mkdir(outputDir, { recursive: true });

    // ── Phase 0: Pre-fetch shared data ─────────────────────────────

    // Fetch all semantics ONCE and build indexes for O(1) lookups
    const allSemantics = (await fetchAllSemantics(this.driver, tenantId))
      .filter((sem) => semanticMatchesScope(sem, projectScope));

    // Index: entity name (lowercase) → semantics ABOUT that entity
    const semanticsByEntity = new Map<string, typeof allSemantics>();
    // Index: entity name (lowercase) → semantics that MENTION entity in content
    const semanticsMentioningEntity = new Map<string, typeof allSemantics>();
    // Index: tag → semantics carrying that tag
    const semanticsByTag = new Map<string, typeof allSemantics>();

    for (const sem of allSemantics) {
      // Build entity index (by ABOUT relationship)
      for (const entityName of sem.entities) {
        const key = entityName.toLowerCase();
        const existing = semanticsByEntity.get(key) ?? [];
        existing.push(sem);
        semanticsByEntity.set(key, existing);
      }

      // Build tag index
      for (const tag of sem.tags) {
        const existing = semanticsByTag.get(tag) ?? [];
        existing.push(sem);
        semanticsByTag.set(tag, existing);
      }
    }

    // Build mention index (which semantics mention an entity by name in content)
    // We need all unique entity names first, so defer this until after entity discovery

    // ── Phase 1: Discover all projects ────────────────────────────────

    const projectEntities = (await fetchAllProjects(this.driver))
      .filter((project) => entityMatchesScope(project, projectScope));
    const episodicOnlyScopes = (await fetchEpisodicProjectScopes(this.driver, tenantId))
      .filter((scope) => !projectScope || sameProjectScope(scope, projectScope));

    // Build full project list: entity-based + episodic-only (virtual)
    let allProjectData: ProjectData[] = [];

    // OPT-58: accumulate every entity's episodics fetched in Phase 1 (the OPT-22
    // batched fetchEpisodicsForEntities scan) into a global ID→episodics map, so
    // Phase 2 can REUSE it instead of re-running fetchEpisodicsForEntity per entity
    // (the per-entity result is identical — same predicate/ORDER/LIMIT, proven in
    // queries.test.ts). Stable IDs prevent same-named entities in different
    // projects from sharing history.
    const entityEpisodicsById = new Map<string, EpisodicEntry[]>();

    // Entity-based projects
    for (const projectEntity of projectEntities) {
      const projectName = projectEntity.name;
      const projectScope = projectName; // e.g. "mars-fps"

      const [containedEntities, modifiedEntities, episodics] = await Promise.all([
        fetchProjectEntities(this.driver, projectName),
        fetchEntitiesModifiedByProject(this.driver, projectScope, tenantId),
        fetchEpisodicsForProject(this.driver, projectScope, tenantId),
      ]);

      // Merge contained and modified entities, dedup by id
      const entityMap = new Map<string, EntityInfo>();
      for (const e of containedEntities) entityMap.set(e.id, e);
      for (const e of modifiedEntities) {
        if (!entityMap.has(e.id)) entityMap.set(e.id, e);
      }
      const entities = [...entityMap.values()];

      // Build mention index for this project's entities (lazy, cached)
      for (const entity of entities) {
        const key = entity.name.toLowerCase();
        if (!semanticsMentioningEntity.has(key)) {
          const mentions = allSemantics.filter(
            (s) => s.content.toLowerCase().includes(key),
          );
          semanticsMentioningEntity.set(key, mentions);
        }
      }

      // Classify: substantive = 1+ semantic OR 1+ episodic mention
      const substantive: EntityInfo[] = [];
      const sparse: EntityInfo[] = [];

      // Batch-fetch episodics for all entities in this project in ONE :Episodic
      // scan (vs one full-label scan per entity). Same per-entity ORDER/LIMIT.
      const entityEpisodicMap = await fetchEpisodicsForEntities(
        this.driver,
        entities.map((entity) => ({ id: entity.id, name: entity.name })),
        projectScope,
        tenantId,
      );
      // OPT-58: feed the global map so Phase 2 reuses these results.
      for (const [entityId, eps] of entityEpisodicMap) entityEpisodicsById.set(entityId, eps);

      for (const entity of entities) {
        const key = entity.name.toLowerCase();
        const semCount = (semanticsByEntity.get(key) ?? []).length;
        const entityEpisodics = entityEpisodicMap.get(entity.id) ?? [];
        const semMentions = semanticsMentioningEntity.get(key) ?? [];
        if (semCount > 0 || entityEpisodics.length > 0 || semMentions.length > 0) {
          substantive.push(entity);
        } else {
          sparse.push(entity);
        }
      }

      // Project-level data includes every explicitly project-scoped semantic,
      // including claims with no ABOUT edge. Unscoped claims ABOUT a contained
      // entity remain useful, but explicitly other-project claims never leak in.
      const semantics: ProjectData['semantics'] = allSemantics
        .filter((sem) => semanticMatchesScope(sem, projectScope));
      const seenSemanticIds = new Set(semantics.map((sem) => sem.id));
      for (const entity of entities) {
        const sems = semanticsByEntity.get(entity.name.toLowerCase()) ?? [];
        for (const sem of sems) {
          if (semanticProjectScopes(sem).length > 0) continue;
          if (seenSemanticIds.has(sem.id)) continue;
          seenSemanticIds.add(sem.id);
          semantics.push(sem);
        }
      }

      allProjectData.push({
        entity: projectEntity,
        entities,
        substantive_entities: substantive,
        sparse_entities: sparse,
        episodics,
        semantics,
      });
    }

    // Memory-only projects (virtual): episodics, semantics, or both can establish
    // a project before an Entity node has been bootstrapped.
    for (const scope of episodicOnlyScopes) {
      const episodics = await fetchEpisodicsForProject(this.driver, scope, tenantId);
      const semantics = allSemantics.filter((sem) => semanticMatchesScope(sem, scope));
      if (episodics.length === 0 && semantics.length === 0) continue;

      const virtualEntity: EntityInfo = {
        id: `virtual-${scope}`,
        name: scope,
        type: 'project',
        slug: slugify(scope),
        description: `Project discovered from scoped memory (no Entity node).`,
        created_at: episodics[episodics.length - 1]?.created_at ?? new Date().toISOString(),
      };

      allProjectData.push({
        entity: virtualEntity,
        entities: [],
        substantive_entities: [],
        sparse_entities: [],
        episodics,
        semantics,
      });
    }

    allProjectData = canonicalizeHumanProjects(allProjectData);

    // ── Phase 2: Build entity articles per project ────────────────────

    for (const project of allProjectData) {
      const projectSlug = slugify(project.entity.name);
      const projectDir = join(outputDir, 'projects', projectSlug);

      // Disambiguate per-file articles by path so same-named files (e.g. 36
      // '__init__.py') each get their own reachable page instead of colliding
      // onto one overwritten slug. Runs post-canonicalization on the final set.
      assignUniqueSlugs(project.substantive_entities);

      // Index substantive entities by id so hierarchy refs can resolve to the
      // page-bearing entity's disambiguated slug; everything else renders as
      // plain text (no dead link).
      const substantiveById = new Map(project.substantive_entities.map((e) => [e.id, e] as const));

      // Build articles for substantive entities
      for (const entity of project.substantive_entities) {
        // OPT-58: reuse the Phase-1 batched episodics (identical per-entity result)
        // instead of re-fetching per entity — one fewer DB round-trip per article.
        const entityEpisodics = entityEpisodicsById.get(entity.id) ?? [];
        const [entitySemantics, hierarchy, backlinks, seeAlso, sources, inboundCount] =
          await Promise.all([
            fetchSemanticsForEntity(this.driver, entity.name, tenantId),
            fetchHierarchy(this.driver, entity.id),
            fetchBacklinks(this.driver, entity.name, tenantId),
            fetchRelatedEntities(this.driver, entity.name),
            fetchSourcesForEntity(this.driver, entity.name, tenantId),
            fetchInboundLinkCount(this.driver, entity.name, tenantId),
          ]);
        const semantics = entitySemantics.filter((sem) => {
          const scopes = semanticProjectScopes(sem);
          return scopes.length === 0 || semanticMatchesScope(sem, project.entity.name);
        });

        // Group semantics by domain tag into sections
        const sectionMap = new Map<string, ResolvedClaim[]>();
        let totalConfidence = 0;
        let confidenceCount = 0;

        for (const sem of semantics) {
          const otherRefs = sem.entity_refs.filter((r) => r !== entity.name);
          const claim: ResolvedClaim = {
            content: resolveInlineLinks(sem.content, otherRefs, projectSlug),
            confidence: sem.confidence,
            memberry_id: sem.id,
            memory_type: sem.memory_type,
            source_refs: [],
            entity_refs: otherRefs,
          };

          totalConfidence += sem.confidence;
          confidenceCount++;

          const domainTag = sem.tags.find((t) => !t.startsWith('project:')) ?? 'general';
          const existing = sectionMap.get(domainTag) ?? [];
          existing.push(claim);
          sectionMap.set(domainTag, existing);
        }

        const sections = [...sectionMap.entries()].map(([tag, claims]) => ({
          heading: tag.charAt(0).toUpperCase() + tag.slice(1).replace(/-/g, ' '),
          claims,
        }));

        const allTags = [...new Set(semantics.flatMap((s) => s.tags))];
        const avgConfidence = confidenceCount > 0 ? totalConfidence / confidenceCount : 0;

        // Resolve hierarchy refs to render descriptors: a child/parent that has
        // its own page links to that page's path-disambiguated slug; pageless
        // (sparse or cross-project) relatives render as plain path text so they
        // never dead-end.
        const resolveRef = (ref: HierarchyRef) => {
          const sub = substantiveById.get(ref.id);
          return sub
            ? { slug: sub.slug, display: relativeEntityPath(sub.path) || sub.name, hasPage: true }
            : { display: relativeEntityPath(ref.path) || ref.name, hasPage: false };
        };
        const resolvedHierarchy = {
          parent: hierarchy.parent ? resolveRef(hierarchy.parent) : undefined,
          children: hierarchy.children.map(resolveRef),
        };

        const frontmatter: ArticleFrontmatter = {
          entity: entity.slug,
          type: entity.type,
          confidence: avgConfidence,
          sources: sources.length,
          inbound_links: inboundCount,
          last_compiled: new Date().toISOString().split('T')[0],
          memberry_id: entity.id,
          aliases: entity.aliases ?? [],
          tags: allTags,
          parent: resolvedHierarchy.parent?.display,
          children: resolvedHierarchy.children.length > 0
            ? resolvedHierarchy.children.map((c) => c.display)
            : undefined,
        };

        const articleData = {
          entity,
          frontmatter,
          sections,
          backlinks,
          see_also: seeAlso,
          sources,
          hierarchy: resolvedHierarchy,
          projectSlug,
        };

        const markdown = renderEntityArticle(articleData, entityEpisodics);
        await writeMarkdown(join(projectDir, `${entity.slug}.md`), markdown);
        result.articles_compiled++;
        result.episodics_rendered += entityEpisodics.length;
      }

      // Disambiguation stubs: when 2+ substantive entities shared a name-slug,
      // their articles now live at path-based slugs, leaving the bare name-slug
      // free. Emit a stub there so residual name-based links (hierarchy,
      // backlinks, inline) still resolve and route to the specific file.
      const bySharedSlug = new Map<string, EntityInfo[]>();
      for (const entity of project.substantive_entities) {
        const base = slugify(entity.name);
        const list = bySharedSlug.get(base);
        if (list) list.push(entity);
        else bySharedSlug.set(base, [entity]);
      }
      for (const [base, group] of bySharedSlug) {
        if (group.length <= 1) continue;
        const variants = group.map((e) => ({
          slug: e.slug,
          display: relativeEntityPath(e.path) || e.name,
          type: e.type,
        }));
        const stub = renderDisambiguationStub(projectSlug, group[0].name, variants);
        await writeMarkdown(join(projectDir, `${base}.md`), stub);
        result.articles_compiled++;
      }

      // Graph page
      const graphMarkdown = renderProjectGraph(project);
      await writeMarkdown(join(projectDir, '_graph.md'), graphMarkdown);

      // Project index
      const indexMarkdown = renderProjectIndex(project);
      await writeMarkdown(join(projectDir, '_index.md'), indexMarkdown);

      result.projects_compiled++;
    }

    // ── Phase 3: Library ──────────────────────────────────────────────

    const allSources = (await fetchAllSources(this.driver))
      .filter((source) => sourceMatchesScope(source, projectScope));

    if (allSources.length > 0) {
      const libraryDir = join(outputDir, 'library');
      const claimCounts = new Map<string, number>();

      for (const source of allSources) {
        const claims = await fetchClaimsForSource(this.driver, source.id, tenantId);
        claimCounts.set(source.id, claims.length);

        const entityLinks = [...new Set(claims.flatMap((c) => c.entity_refs))];

        const page: LibraryPage = {
          source,
          claims,
          entity_links: entityLinks,
        };

        const markdown = renderLibraryPage(page);
        await writeMarkdown(join(libraryDir, `${slugify(source.title)}.md`), markdown);
        result.library_pages++;
      }

      // Library index
      const libraryIndexMarkdown = renderLibraryIndex(allSources, claimCounts);
      await writeMarkdown(join(libraryDir, '_index.md'), libraryIndexMarkdown);
    } else {
      // Always create library directory with empty-state index
      const libraryDir = join(outputDir, 'library');
      const emptyLibrary = renderFrontmatter({ title: 'Source Library', compiled: new Date().toISOString().split('T')[0], sources: 0 }) + '\n\n# Source Library\n\n*No sources indexed yet. Sources will appear here as they are added to the knowledge graph.*\n';
      await writeMarkdown(join(libraryDir, '_index.md'), emptyLibrary);
    }

    // ── Phase 4: Topics ───────────────────────────────────────────────

    const allTags = projectScope
      ? [...semanticsByTag.entries()].map(([tag, sems]) => ({
          tag,
          count: sems.length,
          projects: [projectScope],
        }))
      : await fetchAllTags(this.driver, tenantId);
    const qualifiedTags = allTags.filter((t) => projectScope ? t.count > 0 : (t.count >= 3 || t.projects.length >= 2));

    // Build tag→projects map from pre-fetched allSemantics (no extra query)
    const tagProjectMap = new Map<string, Set<string>>();
    for (const sem of allSemantics) {
      const proj = semanticPrimaryProjectScope(sem);
      for (const tag of sem.tags) {
        if (tag.startsWith('project:')) continue;
        const projects = tagProjectMap.get(tag) ?? new Set();
        if (proj) projects.add(proj);
        tagProjectMap.set(tag, projects);
      }
    }

    // Merge: count >= 3 OR 2+ projects
    const topicTagSet = new Set(qualifiedTags.map((t) => t.tag));
    for (const [tag, projects] of tagProjectMap) {
      if (projects.size >= 2) topicTagSet.add(tag);
    }

    // Pre-build co-occurring tag map: for each tag, which other topic-tags co-occur
    // This avoids the O(topics * allSemantics) nested scan
    const coTagMap = new Map<string, Set<string>>();
    for (const sem of allSemantics) {
      const nonProjectTags = sem.tags.filter((t) => !t.startsWith('project:'));
      for (const tag of nonProjectTags) {
        if (!topicTagSet.has(tag)) continue;
        for (const other of nonProjectTags) {
          if (other !== tag && topicTagSet.has(other)) {
            const existing = coTagMap.get(tag) ?? new Set();
            existing.add(other);
            coTagMap.set(tag, existing);
          }
        }
      }
    }

    if (topicTagSet.size > 0) {
      const topicsDir = join(outputDir, 'topics');
      const topicDataList: TopicData[] = [];

      for (const tag of topicTagSet) {
        // Use pre-indexed semanticsByTag instead of per-tag DB query
        const tagSems = semanticsByTag.get(tag) ?? [];

        // Determine projects this tag appears in
        const projects = new Set<string>();
        const entities = new Set<string>();
        const semanticsWithProject: TopicData['semantics'] = [];

        for (const sem of tagSems) {
          for (const e of sem.entities) entities.add(e);
          // Project is already available from the full semantic data (no .find() needed)
          const proj = semanticPrimaryProjectScope(sem) ?? 'unscoped';
          projects.add(proj);

          semanticsWithProject.push({
            content: sem.content,
            confidence: sem.confidence,
            project: proj,
            entities: sem.entities,
          });
        }

        // Use pre-built co-tag map instead of scanning allSemantics
        const coTags = coTagMap.get(tag) ?? new Set<string>();

        const topicData: TopicData = {
          tag,
          slug: slugify(tag),
          semantics: semanticsWithProject,
          episodics: [], // Could fetch scoped episodics but keeping it light
          projects: [...projects],
          related_tags: [...coTags],
          related_entities: [...entities],
        };

        topicDataList.push(topicData);

        const markdown = renderTopicPage(topicData);
        await writeMarkdown(join(topicsDir, `${slugify(tag)}.md`), markdown);
        result.topic_pages++;
      }

      // Topics index
      const topicIndexMarkdown = renderTopicIndex(topicDataList);
      await writeMarkdown(join(topicsDir, '_index.md'), topicIndexMarkdown);
    } else {
      // Always create topics directory with empty-state index
      const topicsDir = join(outputDir, 'topics');
      const emptyTopics = renderFrontmatter({ title: 'Topics', compiled: new Date().toISOString().split('T')[0], topics: 0 }) + '\n\n# Topics\n\n*No topics discovered yet. Topics emerge when tags appear across multiple projects or reach critical mass.*\n';
      await writeMarkdown(join(topicsDir, '_index.md'), emptyTopics);
    }

    // ── Phase 5: Cross-project pages ──────────────────────────────────

    // Decisions page
    const decisionsMarkdown = renderDecisionsPage(allSemantics);
    await writeMarkdown(join(outputDir, '_decisions.md'), decisionsMarkdown);
    result.cross_project_pages++;

    // Patterns page
    const patternsMarkdown = renderPatternsPage(allSemantics);
    await writeMarkdown(join(outputDir, '_patterns.md'), patternsMarkdown);
    result.cross_project_pages++;

    // Recent changes — attribute each episode to its project: task prefix, else a
    // [project:…] prefix in content, else a known project named in the session_id.
    const knownProjectSlugs = [...new Set([
      ...allProjectData.map((p) => slugify(p.entity.name)),
      ...episodicOnlyScopes.map((s) => slugify(s)),
    ])].filter(Boolean).sort((a, b) => b.length - a.length);
    const recentEpisodics = (await fetchRecentEpisodics(this.driver, 50, tenantId))
      .map((ep) => ({ ...ep, project_scope: deriveEpisodicScope(ep, knownProjectSlugs) }))
      .filter((ep) => episodicMatchesScope(ep, projectScope));
    const recentMarkdown = renderRecentChanges(recentEpisodics);
    await writeMarkdown(join(outputDir, '_recent.md'), recentMarkdown);
    result.cross_project_pages++;

    // ── Phase 6: Portal homepage ──────────────────────────────────────

    const graphStats = await fetchGraphStats(this.driver);
    const portalStats = projectScope
      ? {
          total_entities: allProjectData.reduce((sum, project) => sum + project.entities.length, 0),
          // Raw Fact nodes aren't tracked per-project here; fall back to the global count.
          total_facts: graphStats.total_facts,
          total_semantics: allSemantics.length,
          total_episodics: allProjectData.reduce((sum, project) => sum + project.episodics.length, 0),
          total_sources: allSources.length,
        }
      : graphStats;

    // Derived counts, computed from the same in-scope data the pages render — so the
    // portal tiles always match the pages and auto-update on every recompile.
    const totalPatterns = patternKnowledgeCount(allSemantics);
    const totalDecisions = allSemantics.filter((sem) => {
      if (!isDecisionSemantic(sem)) return false;
      const project = semanticPrimaryProjectScope(sem) ?? 'unscoped';
      return !isInternalProjectName(project);
    }).length;
    const totalTopics = result.topic_pages;
    const humanRecentEpisodics = recentEpisodics.filter(
      (ep) => !ep.project_scope || !isInternalProjectName(ep.project_scope),
    );

    const portalData: PortalData = {
      projects: allProjectData.map((p) => ({
        name: p.entity.name,
        slug: slugify(p.entity.name),
        description: p.entity.description ?? null,
        entity_count: p.entities.length,
        semantic_count: p.semantics.length,
        episodic_count: p.episodics.length,
        last_activity: p.episodics[0]?.created_at ?? null,
      })),
      recent_changes: humanRecentEpisodics.slice(0, 10),
      top_decisions: allSemantics
        .filter((s) => isDecisionSemantic(s))
        .filter((s) => {
          const project = semanticPrimaryProjectScope(s) ?? 'unscoped';
          return !isInternalProjectName(project);
        })
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 15)
        .map((s) => ({
          content: s.content,
          confidence: s.confidence,
          project: semanticPrimaryProjectScope(s) ?? 'unscoped',
          entities: s.entities,
        })),
      stats: {
        ...portalStats,
        total_projects: allProjectData.length,
        total_decisions: totalDecisions,
        total_patterns: totalPatterns,
        total_topics: totalTopics,
      },
    };

    const portalMarkdown = renderPortalHomepage(portalData);
    await writeMarkdown(join(outputDir, '_index.md'), portalMarkdown);

    // OPT-10: write a SINGLE TOP-LEVEL sentinel LAST, after every page is on disk.
    // The served viewer watches the wiki dir with fs.watch, which is unreliable for
    // nested dirs (projects/<slug>/<entity>.md) on Linux — so an MCP-side recompile
    // could leave the viewer's sidebar/search cache stale. A top-level file is the
    // one path fs.watch reliably reports; the viewer rebuilds its full cache when
    // this marker changes. Written last so its mtime bump means "compile is done".
    await writeFile(join(outputDir, COMPILED_MARKER_FILENAME), new Date().toISOString(), 'utf-8');

    return result;
  }
}
