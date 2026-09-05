// packages/code/src/indexer.ts
// Project and file indexing pipeline.

import { readdir, stat } from 'fs/promises';
import { resolve, extname, relative, sep } from 'path';
import { type Driver } from 'neo4j-driver';
import { parseFile } from './parser.js';
import { ImportResolver } from './resolver.js';
import { SymbolStore } from './symbol-store.js';
import { generateLexicalVector } from './vectors.js';
import type { EmbeddingProvider } from '@memberry/core';
import type { SupportedLanguage, SymbolKind, SymbolNode, IndexResult } from './types.js';
import { detectLanguage, isMcpConfigBasename, isTestPath } from './types.js';

interface RelationSymbolFallback {
  name?: string;
  kind?: SymbolKind;
  start_line?: number;
}

interface RelationResolutionFallback {
  from?: RelationSymbolFallback;
  to?: RelationSymbolFallback;
}

/**
 * Build a composite key string for symbol identity.
 * Encodes name + kind + parent_symbol to uniquely identify symbols even when
 * names are shared across classes or overloaded within the same file.
 */
function compositeKey(name: string, kind: SymbolKind | string, parentSymbol: string | null): string {
  return `${name}\0${kind}\0${parentSymbol ?? ''}`;
}

// Default directories/patterns to skip
const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '__pycache__',
  '.venv', 'venv', 'env', '.env', 'target', 'vendor', '.amp', '.lab',
  '.yggdrasil', '.codebase', 'coverage', '.nyc_output',
]);

const EXCLUDE_FILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
]);

/**
 * The text a symbol is indexed BY. Single source of truth: the lexical, sparse,
 * and dense vectors must all describe the same text, or the channels disagree
 * about what a symbol is.
 */
export function symbolVectorText(symbol: Pick<SymbolNode, 'name' | 'signature' | 'doc_comment'>): string {
  return [symbol.name, symbol.signature, symbol.doc_comment].filter(Boolean).join(' ');
}

export class CodeIndexer {
  private symbolStore: SymbolStore;
  private resolver: ImportResolver;

  /**
   * `embedding` is OPTIONAL and its absence is the defect IDX-003 fixes: without
   * it every indexed Symbol had `embedding: null`, so the `symbol_embedding`
   * vector index was empty and the `code.dense-vector` channel returned nothing
   * on every query while reporting success. Code search was lexical-only.
   * Same shape as BootstrapGraph, which had this exact bug on the memory side.
   */
  constructor(private driver: Driver, private embedding?: EmbeddingProvider) {
    this.symbolStore = new SymbolStore(driver);
    this.resolver = new ImportResolver(driver);
  }

  /**
   * Dense-embed a batch of symbols in place. Best-effort: an embedding outage
   * must degrade retrieval to the lexical channels, never fail the index write,
   * so a throw here is logged and swallowed and the symbols still get stored.
   */
  private async embedSymbols(symbols: SymbolNode[]): Promise<void> {
    if (symbols.length === 0) return;
    if (!this.embedding || this.embedding.available === false) return;
    try {
      const vectors = await this.embedding.embedBatch(symbols.map(symbolVectorText));
      symbols.forEach((symbol, i) => {
        const vector = vectors[i];
        // A short/empty vector is a provider contract violation, not a symbol we
        // should store a broken embedding for — leave it lexical-only.
        if (!Array.isArray(vector) || vector.length === 0) return;
        symbol.embedding = vector;
      });
    } catch (err: unknown) {
      console.error(
        '[memberry-code] symbol embedding failed; indexing lexical-only for this batch:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Index an entire project directory.
   * Walks the file tree, parses recognized source files, creates Symbol nodes and edges.
   *
   * `skipTests` (opt #8/A2): drop `isTestPath` files from the walk, matching the
   * watcher's default. Defaults to `false` so today's bulk index (which includes
   * test files) is unchanged; flipping the default is a separate item.
   */
  async indexProject(
    rootPath: string,
    options?: { include?: string[]; exclude?: string[]; projectTag?: string; skipTests?: boolean },
  ): Promise<IndexResult> {
    const result: IndexResult = {
      files_parsed: 0,
      files_skipped: 0,
      symbols_created: 0,
      symbols_updated: 0,
      relations_created: 0,
      errors: [],
    };

    const extraExcludes = new Set(options?.exclude ?? []);
    const walked = await this.walkDirectory(rootPath, extraExcludes);
    const files = options?.skipTests ? walked.filter((f) => !isTestPath(f)) : walked;

    // Filter to include patterns if specified
    const filtered = options?.include
      ? files.filter((f) => options.include!.some((pattern) => f.includes(pattern)))
      : files;

    // Phase 1: Parse all files and create symbols. Cache parse results for Phase 2.
    // Files are independent (disjoint per-file Symbol sets), so index them with
    // bounded concurrency to overlap each file's Neo4j round-trips instead of
    // running them strictly one-at-a-time. The cap protects the Neo4j session pool
    // (each indexFile opens its sessions serially, so peak ≈ FILE_CONCURRENCY).
    // Result totals are order-independent sums, so the outcome is identical to the
    // serial loop; per-file errors stay isolated.
    const FILE_CONCURRENCY = 8;
    const parseCache = new Map<string, Awaited<ReturnType<typeof parseFile>>>();

    for (let i = 0; i < filtered.length; i += FILE_CONCURRENCY) {
      const chunk = filtered.slice(i, i + FILE_CONCURRENCY);
      const outcomes = await Promise.all(
        chunk.map(async (filePath) => {
          const language = detectLanguage(filePath);
          if (!language) return { kind: 'skip' as const };
          try {
            return { kind: 'ok' as const, filePath, fileResult: await this.indexFile(filePath, language, options?.projectTag) };
          } catch (err) {
            return {
              kind: 'err' as const,
              error: { file: relative(rootPath, filePath), error: err instanceof Error ? err.message : String(err) },
            };
          }
        }),
      );

      for (const outcome of outcomes) {
        if (outcome.kind === 'skip') {
          result.files_skipped++;
        } else if (outcome.kind === 'err') {
          result.errors.push(outcome.error);
          result.files_skipped++;
        } else {
          result.files_parsed++;
          result.symbols_created += outcome.fileResult.symbols_created;
          result.symbols_updated += outcome.fileResult.symbols_updated;
          result.relations_created += outcome.fileResult.relations_created;
          // Cache the parse from indexFile for Phase 2 (no re-parsing needed)
          if (outcome.fileResult.parsed.imports.length > 0) {
            parseCache.set(outcome.filePath, outcome.fileResult.parsed);
          }
        }
      }
    }

    // Phase 2: Create Entity:Component nodes for indexed files and resolve imports.
    // Uses cached parse results --- no re-parsing.
    await this.ensureFileEntities(filtered, options?.projectTag);

    // Resolve ALL imports in one batch: in-memory path resolution against the set
    // of indexed files + a single UNWIND round-trip, instead of an fs.stat storm
    // (up to 11 stats/import) plus one Neo4j round-trip per import.
    const indexedPaths = new Set(filtered.filter((f) => detectLanguage(f)));
    const allImports = Array.from(parseCache.values()).flatMap((p) => p.imports);
    try {
      result.relations_created += await this.resolver.resolveImportsBatch(allImports, rootPath, indexedPaths);
    } catch (err: unknown) {
      // Import resolution failures are non-fatal
    }

    // Phase 3: Batch link all symbols to their Entity:Component nodes
    const linkedCount = await this.resolver.linkAllSymbolsToEntities();
    result.relations_created += linkedCount;

    return result;
  }

  /**
   * Index a single file. Incremental: checks content_hash to skip unchanged symbols.
   *
   * `projectTag` (T5/gap-11): the canonical `project:<slug>` scope to stamp on the
   * file's symbols. Pass `undefined` (e.g. the watcher's context-free reindex) to
   * PRESERVE any existing stored scope on the matched symbols (COALESCE in
   * upsertSymbols), keeping re-indexing scope-safe.
   */
  async indexFile(
    filePath: string,
    language: SupportedLanguage,
    projectTag?: string,
  ): Promise<{ symbols_created: number; symbols_updated: number; relations_created: number; parsed: Awaited<ReturnType<typeof parseFile>> }> {
    const parsed = await parseFile(filePath, language);
    let created = 0;
    let updated = 0;
    let relationsCreated = 0;

    // Check which symbols already exist with same content_hash (unchanged)
    const existingHashes = await this.symbolStore.getHashesByFile(filePath);

    // Collect changed symbols (content-hash skip preserved), generating vectors,
    // then upsert them in ONE batched round-trip instead of findByCompositeKey +
    // create/update per symbol (was O(N) round-trips for N changed symbols).
    const changed: SymbolNode[] = [];
    for (const symbol of parsed.symbols) {
      if (existingHashes.has(symbol.content_hash)) {
        // Symbol unchanged --- skip
        continue;
      }

      // Generate the one lexical vector that has a production reader.
      const vectorText = symbolVectorText(symbol);
      symbol.lexical_vector = generateLexicalVector(vectorText);

      changed.push(symbol);
    }

    // Dense vectors in ONE batched provider call per file, AFTER the changed set
    // is known — embedding is the expensive step and unchanged symbols are
    // skipped by content_hash, so a no-op reindex costs nothing.
    await this.embedSymbols(changed);

    // Single batched UNWIND MERGE: identical composite-key identity, property set,
    // and create-vs-update outcome as the prior per-symbol loop.
    if (changed.length > 0) {
      const upsert = await this.symbolStore.upsertSymbols(changed, projectTag);
      created += upsert.created;
      updated += upsert.updated;
    }

    // Create intra-file relationships in ONE batched round-trip per relationship
    // type — was one Neo4j round-trip + session PER relation (O(R) for a dense
    // file, often tens–hundreds). Parser IDs are transient, so include stable
    // symbol metadata as a fallback when unchanged symbols are skipped by hash;
    // the per-endpoint ORDER BY tie-break is ported per-row into the batch.
    const symbolById = new Map(parsed.symbols.map((symbol) => [symbol.id, symbol]));
    relationsCreated += await this.resolveRelationsBatch(parsed.relations, filePath, symbolById);

    // Remove symbols that no longer exist in the file (batch delete).
    // Use composite keys (name+kind+parent_symbol) to correctly identify stale symbols
    // even when multiple symbols share the same name (overloads, same-named methods in
    // different classes, nested symbols).
    const currentKeys = new Set(
      parsed.symbols.map((s) => compositeKey(s.name, s.kind, s.parent_symbol)),
    );
    const allExisting = await this.symbolStore.getByFile(filePath);
    const toDelete = allExisting.filter(
      (ex) => !currentKeys.has(compositeKey(ex.name, ex.kind, ex.parent_symbol)),
    );
    if (toDelete.length > 0) {
      const session = this.driver.session();
      try {
        await session.run(
          'MATCH (s:Symbol) WHERE s.id IN $ids DETACH DELETE s',
          { ids: toDelete.map((s) => s.id) },
        );
      } finally {
        await session.close();
      }
    }

    return { symbols_created: created, symbols_updated: updated, relations_created: relationsCreated, parsed };
  }

  // --- Private helpers -------------------------------------------------------

  /**
   * Ensure Entity:Component nodes exist for all indexed files.
   * Creates them if missing so symbols can be linked via DEFINED_IN.
   *
   * `projectTag` (opt #8/A4): the same canonical `project:<slug>` scope stamped on
   * the file's symbols, written as `project_scope` ON CREATE. ON MATCH it only
   * fills a NULL scope so legacy unscoped rows heal on re-index while an already
   * scoped row is never clobbered; `null` (no tag) leaves the property untouched.
   */
  private async ensureFileEntities(filePaths: string[], projectTag?: string): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run(
        `UNWIND $paths AS path
         MERGE (e:Entity:Component {path: path})
         ON CREATE SET e.id = randomUUID(), e.name = last(split(path, '/')),
                       e.type = 'component', e.domain = 'source',
                       e.created_at = $now, e.project_scope = $projectScope
         ON MATCH SET e.project_scope = coalesce(e.project_scope, $projectScope)`,
        {
          paths: filePaths.filter((f) => detectLanguage(f)),
          now: new Date().toISOString(),
          projectScope: projectTag ?? null,
        },
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Bridge (T6/gap-12): make a freshly-indexed project's file nodes
   * wiki-discoverable.
   *
   * `ensureFileEntities` creates `(:Entity:Component {path})` nodes for each
   * indexed file but never links them to a project, so the wiki compiler's
   * `fetchProjectEntities` — which discovers entities via
   * `(project:Entity{type:'project'})-[:CONTAINS*1..]->(e)` — can't see them.
   * This links each Component to its MODULE — matched by LONGEST directory-prefix
   * against the codebase-scanner's `knownModules` (so a monorepo file under
   * `packages/core/...` maps to module `core`, not the `packages` workspace root)
   * — and wires `(project)-[:CONTAINS]->(module)-[:CONTAINS]->(component)`. With
   * no `knownModules` it falls back to the file's top-level directory.
   *
   * Scoped to THIS run: only Component nodes whose `path` starts with `absPath`
   * are touched — never global/unscoped component nodes. Fully idempotent
   * (MERGE everywhere); re-ingesting the same project creates no duplicate edges.
   * The module Entity's `type` is set ON CREATE only, so a module the bootstrap
   * already created with `type:'module'` is never clobbered.
   *
   * @returns the number of {module, component} link pairs processed.
   */
  async linkComponentsToProject(
    absPath: string,
    projectName: string,
    knownModules?: KnownModule[],
  ): Promise<number> {
    const session = this.driver.session();
    try {
      // Read back the EXACT `path` values ensureFileEntities stored for this run.
      // Scope by a SEPARATOR-BOUNDED prefix so a sibling dir (e.g. `/x/proj2`)
      // can't be over-matched when this root is `/x/proj` — confines the bridge
      // to the files just indexed under this root (never unscoped/global nodes).
      const absPathPrefix = absPath.endsWith(sep) ? absPath : absPath + sep;
      const found = await session.run(
        `MATCH (c:Entity:Component)
         WHERE c.path = $absPath OR c.path STARTS WITH $absPathPrefix
         RETURN c.path AS path`,
        { absPath, absPathPrefix },
      );
      const componentPaths = found.records.map((r) => r.get('path') as string);
      const links = computeComponentModuleLinks(absPath, projectName, componentPaths, knownModules);
      if (links.length === 0) return 0;

      // A root-level file's module IS the project (the "sensible default"); attach
      // those components straight to the project (no project→project self-loop).
      const moduleLinks = links.filter((l) => l.moduleName !== projectName);
      const rootLinks = links.filter((l) => l.moduleName === projectName);
      const now = new Date().toISOString();

      // ONE batched, idempotent UNWIND for module-backed files. project + module
      // entities are MERGEd by name; module.type is set ON CREATE only (never
      // overwrites a bootstrap 'module'); project.type is a safety-net ON CREATE.
      // All edges are MERGE → re-ingest can't fork edges.
      if (moduleLinks.length > 0) {
        await session.run(
          `MERGE (project:Entity {name: $projectName})
             ON CREATE SET project.id = randomUUID(), project.type = 'project',
                           project.created_at = $now
           WITH project
           UNWIND $links AS link
           MERGE (m:Entity {name: link.moduleName})
             ON CREATE SET m.id = randomUUID(), m.type = 'module',
                           m.description = 'Source module: ' + link.moduleName,
                           m.created_at = $now
           MERGE (project)-[:CONTAINS]->(m)
           WITH m, link
           MATCH (c:Entity:Component {path: link.componentPath})
           MERGE (m)-[:CONTAINS]->(c)`,
          { projectName, links: moduleLinks, now },
        );
      }

      // Root-level files: link directly to the project (no module hop, no self-loop).
      if (rootLinks.length > 0) {
        await session.run(
          `MERGE (project:Entity {name: $projectName})
             ON CREATE SET project.id = randomUUID(), project.type = 'project',
                           project.created_at = $now
           WITH project
           UNWIND $links AS link
           MATCH (c:Entity:Component {path: link.componentPath})
           MERGE (project)-[:CONTAINS]->(c)`,
          { projectName, links: rootLinks, now },
        );
      }
      return links.length;
    } finally {
      await session.close();
    }
  }

  private async resolveRelationsBatch(
    relations: Array<{ from_symbol: string; to_symbol: string; type: string }>,
    filePath: string,
    symbolById: Map<string, SymbolNode>,
  ): Promise<number> {
    // Validate relation types against known symbol relationships --- prevents
    // Cypher injection (the type is interpolated below, never a bind param, since
    // Neo4j can't parameterise relationship types).
    const VALID_SYMBOL_RELS = new Set(['SYMBOL_CALLS', 'SYMBOL_IMPORTS', 'SYMBOL_INHERITS', 'SYMBOL_IMPLEMENTS', 'SYMBOL_CONTAINS']);

    // Group the file's relations by (validated) type. One UNWIND round-trip per
    // type means ≤5 round-trips/file instead of one per relation.
    const rowsByType = new Map<string, Array<Record<string, unknown>>>();
    for (const rel of relations) {
      if (!VALID_SYMBOL_RELS.has(rel.type)) continue;
      const fromFb = relationFallback(symbolById.get(rel.from_symbol));
      const toFb = relationFallback(symbolById.get(rel.to_symbol));
      const list = rowsByType.get(rel.type) ?? [];
      list.push({
        fromRef: rel.from_symbol,
        toRef: rel.to_symbol,
        fromName: fromFb?.name ?? null,
        fromKind: fromFb?.kind ?? null,
        fromStartLine: fromFb?.start_line ?? null,
        toName: toFb?.name ?? null,
        toKind: toFb?.kind ?? null,
        toStartLine: toFb?.start_line ?? null,
      });
      rowsByType.set(rel.type, list);
    }
    if (rowsByType.size === 0) return 0;

    let resolved = 0;
    const session = this.driver.session();
    try {
      for (const [type, rows] of rowsByType) {
        // Per-row endpoint resolution + ORDER BY tie-break, identical to the prior
        // per-relation query, ported into correlated CALL{} subqueries so the whole
        // batch runs in one round-trip. A row whose from/to can't be resolved is
        // dropped by its subquery (no edge), exactly as the old OPTIONAL-MATCH +
        // `WHERE … IS NOT NULL` did.
        const result = await session.run(
          `UNWIND $rows AS row
           CALL {
             WITH row
             OPTIONAL MATCH (from:Symbol)
             WHERE from.id = row.fromRef
                OR (
                  row.fromName IS NOT NULL
                  AND from.name = row.fromName
                  AND from.file_path = $filePath
                  AND (row.fromKind IS NULL OR from.kind = row.fromKind)
                  AND (row.fromStartLine IS NULL OR from.start_line = row.fromStartLine)
                )
                OR (from.name = row.fromRef AND from.file_path = $filePath)
             WITH from, row
             WHERE from IS NOT NULL
             RETURN from
             ORDER BY CASE
               WHEN from.id = row.fromRef THEN 0
               WHEN row.fromStartLine IS NOT NULL AND from.start_line = row.fromStartLine THEN 1
               ELSE 2
             END
             LIMIT 1
           }
           CALL {
             WITH row
             OPTIONAL MATCH (to:Symbol)
             WHERE to.id = row.toRef
                OR (
                  row.toName IS NOT NULL
                  AND to.name = row.toName
                  AND to.file_path = $filePath
                  AND (row.toKind IS NULL OR to.kind = row.toKind)
                  AND (row.toStartLine IS NULL OR to.start_line = row.toStartLine)
                )
                OR (to.name = row.toRef AND to.file_path = $filePath)
                OR to.name = row.toRef
             WITH to, row
             WHERE to IS NOT NULL
             RETURN to
             ORDER BY CASE
               WHEN to.id = row.toRef THEN 0
               WHEN row.toStartLine IS NOT NULL AND to.file_path = $filePath AND to.start_line = row.toStartLine THEN 1
               WHEN to.file_path = $filePath THEN 2
               ELSE 3
             END
             LIMIT 1
           }
           MERGE (from)-[:${type}]->(to)
           RETURN count(*) AS created`,
          { rows, filePath },
        );
        const c = result.records[0]?.get('created');
        resolved += typeof c === 'number' ? c : c ? (c as { toNumber(): number }).toNumber() : 0;
      }
      return resolved;
    } finally {
      await session.close();
    }
  }

  private async walkDirectory(
    dirPath: string,
    extraExcludes: Set<string>,
  ): Promise<string[]> {
    const files: string[] = [];

    async function walk(dir: string): Promise<void> {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const name = entry.name;
        // Skip excluded dirs and dotfiles — but let through known config files
        // whose basename starts with '.' (e.g. `.mcp.json`).
        if (EXCLUDE_DIRS.has(name) || extraExcludes.has(name) || (name.startsWith('.') && !isMcpConfigBasename(name)))
          continue;

        const fullPath = resolve(dir, name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          if (EXCLUDE_FILES.has(name)) continue;
          if (detectLanguage(name)) {
            files.push(fullPath);
          }
        }
      }
    }

    await walk(dirPath);
    return files;
  }
}

function relationFallback(symbol: SymbolNode | undefined): RelationSymbolFallback | undefined {
  if (!symbol) return undefined;
  return {
    name: symbol.name,
    kind: symbol.kind,
    start_line: symbol.start_line,
  };
}

/** One file→module link the wiki bridge will MERGE into the graph. */
export interface ComponentModuleLink {
  /** The module Entity name a component belongs to (or projectName for root files). */
  moduleName: string;
  /** The exact `path` value stored on the `:Entity:Component` node. */
  componentPath: string;
}

/**
 * A workspace/source module the codebase-scanner discovered, as the bridge needs
 * it: the Entity `name` the bootstrap created, plus the module's directory
 * `relPath` (project-root-relative, forward slashes — e.g. `packages/core`,
 * `src`, `src/auth`). The bridge matches each component to a module by LONGEST
 * `relPath` prefix, so module names agree byte-for-byte with the bootstrap.
 */
export interface KnownModule {
  name: string;
  relPath: string;
}

/**
 * Pure mapping used by {@link CodeIndexer.linkComponentsToProject} (T6/gap-12).
 *
 * For each indexed Component `path`, derive its MODULE so the file links to the
 * SAME module Entity the bootstrap created (not a forked junk one):
 *
 * 1. When `knownModules` is supplied (the ingest path — the scanner's
 *    authoritative module list is in scope), match the component to the module
 *    whose directory `relPath` is the LONGEST prefix of the component's
 *    directory. In a monorepo a file at `packages/core/src/x.ts` thus maps to
 *    module `core` (relPath `packages/core`), NOT the `packages` workspace root.
 *    This is the fix for the reader/writer mismatch: the scanner names a
 *    `packages/*` module by its leaf dir (`core`), so deriving the module from
 *    the TOP-LEVEL dir (`packages`) minted a junk module that captured every
 *    component while the real per-package modules got none.
 *
 * 2. With no `knownModules` (e.g. the watcher's context-free reindex), fall back
 *    to the file's first path segment under the root — preserves the prior
 *    single-level layout behaviour.
 *
 * A file with no matching module and no subdirectory is attached to the project
 * itself (moduleName = projectName) — a sensible default rather than minting a
 * junk module from a bare filename.
 *
 * Exported (and side-effect-free) so the bridge can be unit/live-tested directly.
 */
export function computeComponentModuleLinks(
  absPath: string,
  projectName: string,
  componentPaths: string[],
  knownModules?: KnownModule[],
): ComponentModuleLink[] {
  // Pre-split each known module's relPath into directory segments once, and sort
  // longest-first so the FIRST prefix match is the most specific (longest) one.
  const modules = (knownModules ?? [])
    .map((m) => ({ name: m.name, segments: m.relPath.split(/[\\/]/).filter(Boolean) }))
    .filter((m) => m.segments.length > 0)
    .sort((a, b) => b.segments.length - a.segments.length);

  const links: ComponentModuleLink[] = [];
  for (const componentPath of componentPaths) {
    // `relative` is platform-correct (uses the same `path` module the indexer
    // walked with), so this works whether the stored path uses '/' or '\'.
    const rel = relative(absPath, componentPath);
    // Outside the root (shouldn't happen — caller scopes by STARTS WITH) → skip.
    if (!rel || rel.startsWith('..')) continue;
    const segments = rel.split(/[\\/]/).filter(Boolean);
    // The component's DIRECTORY segments (drop the filename).
    const dirSegments = segments.slice(0, -1);

    let moduleName: string | undefined;
    if (modules.length > 0) {
      // Longest-prefix match against the scanner's known module directories.
      for (const m of modules) {
        if (isPrefix(m.segments, dirSegments)) {
          moduleName = m.name;
          break;
        }
      }
    }

    // Fallback (no known modules, or no module owns this file): use the first
    // directory segment if present, else attach the bare-filename file to the
    // project.
    if (moduleName === undefined) {
      moduleName = dirSegments.length > 0 ? dirSegments[0] : projectName;
    }

    links.push({ moduleName, componentPath });
  }
  return links;
}

/** True when `prefix` is a leading run of directory segments of `segments`. */
function isPrefix(prefix: string[], segments: string[]): boolean {
  if (prefix.length > segments.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i] !== segments[i]) return false;
  }
  return true;
}
