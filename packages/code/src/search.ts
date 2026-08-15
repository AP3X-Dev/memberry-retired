// packages/code/src/search.ts
// Hybrid search: vector + fulltext + graph-boosted with RRF fusion.
// Blends code symbols with semantic memories into a unified result set.

import neo4j, { type Driver } from 'neo4j-driver';
import type { CodeSearchResult, CodeContext } from './types.js';
import type {
  EmbeddingProvider,
} from '@memberry/core';
import { generateLexicalVector } from './vectors.js';

type InternalRetrievalChannel = 'code.fulltext' | 'code.lexical-vector' | 'code.dense-vector' | 'code.semantic-vector';
type InternalRetrievalChannelObservation =
  | { channel: InternalRetrievalChannel; outcome: 'success' }
  | { channel: InternalRetrievalChannel; outcome: 'safe-failure'; code: 'unavailable' | 'timeout' | 'query-failed' | 'invalid-result' };
interface InternalRetrievalCandidateObservation {
  privateId: string;
  sourceType: 'symbol' | 'semantic';
  channels: Array<{ channel: InternalRetrievalChannel; rank: number; score?: number }>;
  evidence: { confidence?: number; sourceCount?: number; superseded?: boolean; invalidated?: boolean };
  estimatedTokens: number;
}
interface InternalRetrievalObservation {
  channels: InternalRetrievalChannelObservation[];
  candidates: InternalRetrievalCandidateObservation[];
  finalIds: string[];
}
interface InternallyObserved<T> { value: T; observation: InternalRetrievalObservation }
class InternalObservedSearchError extends Error {
  constructor(readonly observation: InternalRetrievalObservation, options?: { cause?: unknown }) {
    super('internal observed code search failed', options);
    this.name = 'InternalObservedSearchError';
  }
}

interface CodeContextFilters {
  language?: string;
  file_path?: string;
  kind?: string;
  /** Canonical single-scope project tag (`project:<slug>`) — see SymbolScopeOptions. */
  project_tag?: string;
}

/**
 * The shared symbol-scope filter shape used by the fulltext WHERE and the
 * vector/lexical post-filters. `project_tag` (T5/gap-11) is the PRIMARY scope:
 * a symbol matches when its stored `project_tag` equals the tag, OR (as a
 * FALLBACK for legacy un-stamped symbols) it has no stored tag and matches the
 * `file_path` substring heuristic. `project_tag` is applied BEFORE the path
 * heuristic in every channel.
 */
interface SymbolScopeOptions {
  language?: string;
  file_path?: string;
  kind?: string;
  project_tag?: string;
}

export class CodeSearch {
  constructor(
    private driver: Driver,
    private embedding: EmbeddingProvider,
  ) {}

  /**
   * Hybrid search across Symbol nodes AND Semantic memories.
   * 1. Fulltext search on symbol names/signatures/doc_comments
   * 2. Vector search on symbol embeddings (if available)
   * 3. Vector search on semantic memories
   * 4. RRF fusion to produce a single ranked list
   */
  async search(
    query: string,
    options?: {
      language?: string;
      file_path?: string;
      kind?: string;
      project_tag?: string;
      limit?: number;
      include_semantics?: boolean;
      expandedTokens?: string[];
      as_of?: string;
      queryVector?: number[];
    },
  ): Promise<CodeSearchResult[]> {
    return this.searchStandard(query, options, false);
  }

  /** @internal Fresh structural observation for ranked RET-001B tracing. */
  async searchObserved(
    query: string,
    options?: {
      language?: string;
      file_path?: string;
      kind?: string;
      project_tag?: string;
      limit?: number;
      include_semantics?: boolean;
      expandedTokens?: string[];
      as_of?: string;
      queryVector?: number[];
    },
  ): Promise<InternallyObserved<CodeSearchResult[]>> {
    return this.searchStandard(query, options, true);
  }

  private async searchStandard(
    query: string,
    options: Parameters<CodeSearch['search']>[1] | undefined,
    observed: false,
  ): Promise<CodeSearchResult[]>;
  private async searchStandard(
    query: string,
    options: Parameters<CodeSearch['search']>[1] | undefined,
    observed: true,
  ): Promise<InternallyObserved<CodeSearchResult[]>>;
  private async searchStandard(
    query: string,
    options: {
      language?: string;
      file_path?: string;
      kind?: string;
      project_tag?: string;
      limit?: number;
      include_semantics?: boolean;
      expandedTokens?: string[];
      as_of?: string;
      queryVector?: number[];
    } | undefined,
    observed: boolean,
  ): Promise<CodeSearchResult[] | InternallyObserved<CodeSearchResult[]>> {
    const limit = options?.limit ?? 20;
    const includeSemantics = options?.include_semantics ?? true;
    const channelOutcomes = observed
      ? new Map<InternalRetrievalChannel, InternalRetrievalChannelObservation>()
      : undefined;
    const settle = observed
      ? (entry: InternalRetrievalChannelObservation): void => { channelOutcomes!.set(entry.channel, entry); }
      : undefined;

    // OPT-49: embed the query ONCE and share the vector across the two dense
    // channels (symbol + semantic), which each used to embed it separately. The
    // promise is created here (before the fan-out) so the embed still overlaps
    // fulltext/lexical; both dense channels await this SAME promise instead of
    // issuing a second embed. Deterministic embed → byte-identical query vector.
    //
    // Shared query embedding: when the unified assembler already embedded the task
    // (options.queryVector), reuse it instead of embedding a third time here.
    const queryVectorPromise: Promise<number[] | null> =
      options?.queryVector !== undefined
        ? Promise.resolve(options.queryVector)
        : this.embedding.available === false ? Promise.resolve(null) : this.embedding.embed(query);

    // 4-way parallel: fulltext + dense vector + lexical vector + semantic
    const fulltextPromise = this.fulltextSearch(options?.expandedTokens?.join(' ') ?? query, limit, options);
    const observedFulltextPromise = observed
      ? fulltextPromise.then(
          (value) => { settle!({ channel: 'code.fulltext', outcome: 'success' }); return value; },
          (error) => { settle!({ channel: 'code.fulltext', outcome: 'safe-failure', code: 'query-failed' }); throw error; },
        )
      : fulltextPromise;
    const searches = [
      observedFulltextPromise,
      observed
        ? this.vectorSearch(query, limit, options, queryVectorPromise, settle)
        : this.vectorSearch(query, limit, options, queryVectorPromise),
      observed
        ? this.lexicalVectorSearch(query, limit, options, settle)
        : this.lexicalVectorSearch(query, limit, options),
      includeSemantics
        ? observed
          ? this.semanticVectorSearch(query, limit, options?.as_of, queryVectorPromise, settle)
          : this.semanticVectorSearch(query, limit, options?.as_of, queryVectorPromise)
        : Promise.resolve([]),
    ] as const;
    let fulltextResults: CodeSearchResult[];
    let vectorResults: CodeSearchResult[];
    let lexicalResults: CodeSearchResult[];
    let semanticResults: CodeSearchResult[];
    if (observed) {
      const settled = await Promise.allSettled(searches);
      const rejected = settled.find((entry) => entry.status === 'rejected');
      if (rejected?.status === 'rejected') {
        throw new InternalObservedSearchError({
          channels: [...channelOutcomes!.values()], candidates: [], finalIds: [],
        }, { cause: rejected.reason });
      }
      [fulltextResults, vectorResults, lexicalResults, semanticResults] = settled.map(
        (entry) => (entry as PromiseFulfilledResult<CodeSearchResult[]>).value,
      ) as [CodeSearchResult[], CodeSearchResult[], CodeSearchResult[], CodeSearchResult[]];
    } else {
      [fulltextResults, vectorResults, lexicalResults, semanticResults] = await Promise.all(searches);
    }

    // RRF fusion across all result lists (source_type already set per list)
    const allLists: CodeSearchResult[][] = [fulltextResults, lexicalResults, vectorResults, semanticResults];
    const fused = rrfFusion(allLists, limit);

    if (!observed) return fused;

    const observation: InternalRetrievalObservation = { channels: [], candidates: [], finalIds: [] };
    {
      const channels = [
        'code.fulltext', 'code.lexical-vector', 'code.dense-vector', 'code.semantic-vector',
      ] as const;
      observation.channels = channels.flatMap((channel) => {
        const entry = channelOutcomes!.get(channel);
        return entry ? [entry] : [];
      });
      const channelLists = [
        ['code.fulltext', fulltextResults],
        ['code.lexical-vector', lexicalResults],
        ['code.dense-vector', vectorResults],
        ['code.semantic-vector', semanticResults],
      ] as const;
      const candidates = new Map<string, InternalRetrievalCandidateObservation>();
      for (const [channel, results] of channelLists) {
        results.forEach((result, index) => {
          const candidate = candidates.get(result.id) ?? {
            privateId: result.id,
            sourceType: result.source_type,
            channels: [],
            evidence: {},
            estimatedTokens: Math.ceil((result.signature.length + result.doc_comment.length + 50) / 4),
          };
          candidate.channels.push({ channel, rank: index + 1, score: result.score });
          candidates.set(result.id, candidate);
        });
      }
      observation.candidates = [...candidates.values()];
      observation.finalIds = fused.map((result) => result.id);
    }
    return { value: fused, observation };
  }

  /**
   * Build code-aware context for a task.
   * Returns relevant symbols + semantic memories, token-budgeted.
   */
  async buildContext(
    task: string,
    maxTokens = 6000,
    as_of?: string,
    filters?: CodeContextFilters,
  ): Promise<CodeContext> {
    const results = await this.search(task, { limit: 30, include_semantics: true, as_of, ...filters });

    const symbols: CodeSearchResult[] = [];
    const semantics: Array<{ id: string; content: string; confidence: number }> = [];
    let tokenCount = 0;

    for (const result of results) {
      const estimatedTokens = Math.ceil((result.signature.length + result.doc_comment.length + 50) / 4);
      if (tokenCount + estimatedTokens > maxTokens) continue;

      if (result.source_type === 'symbol') {
        symbols.push(result);
      } else {
        semantics.push({
          id: result.id,
          content: result.doc_comment || result.signature,
          confidence: result.score,
        });
      }
      tokenCount += estimatedTokens;
    }

    return { task, symbols, semantic_memories: semantics, token_count: tokenCount };
  }

  /**
   * Render code context as markdown.
   */
  renderContextMarkdown(ctx: CodeContext): string {
    const lines: string[] = [];
    lines.push(`# Code Context`);
    lines.push(`**Task:** ${ctx.task}`);
    lines.push('');

    if (ctx.symbols.length > 0) {
      lines.push('## Relevant Symbols');
      lines.push('');
      for (const s of ctx.symbols) {
        lines.push(`### ${s.name} (${s.kind}) — ${s.file_path}:${s.start_line}`);
        lines.push(`\`${s.signature}\``);
        if (s.doc_comment) lines.push(`> ${s.doc_comment.split('\n')[0]}`);
        lines.push('');
      }
    }

    if (ctx.semantic_memories.length > 0) {
      lines.push('## Related Knowledge');
      lines.push('');
      for (const m of ctx.semantic_memories) {
        lines.push(`- [${m.confidence.toFixed(2)}] ${m.content}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  // ─── Private search strategies ──────────────────────────────────────────

  private async fulltextSearch(
    query: string,
    limit: number,
    options?: SymbolScopeOptions,
  ): Promise<CodeSearchResult[]> {
    const session = this.driver.session();
    try {
      // Escape special Lucene characters for fulltext search
      const escaped = query
        .replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, '\\$&')
        .replace(/\b(AND|OR|NOT|TO)\b/g, '"$1"');

      const filters: string[] = [];
      const params: Record<string, unknown> = {
        query: `${escaped}*`,
        limit: neo4j.int(limit),
      };

      if (options?.language) {
        filters.push('s.language = $language');
        params.language = options.language;
      }
      // Project scope FIRST (T5/gap-11): the stored canonical tag is the primary
      // filter; the file_path substring heuristic applies only as a FALLBACK for
      // symbols with no stored project_tag. When no tag is supplied, the prior
      // file_path-only behavior is preserved.
      const scope = buildSymbolScopeCypher('s', options?.project_tag, options?.file_path);
      if (scope.clause) {
        filters.push(scope.clause);
        Object.assign(params, scope.params);
      }
      if (options?.kind) {
        filters.push('s.kind = $kind');
        params.kind = options.kind;
      }

      const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

      const result = await session.run(
        `CALL db.index.fulltext.queryNodes('symbol_search', $query)
         YIELD node AS s, score
         ${whereClause}
         RETURN s, score
         ORDER BY score DESC
         LIMIT $limit`,
        params,
      );

      return result.records.map((r) => {
        const props = r.get('s').properties as Record<string, unknown>;
        return {
          id: props.id as string,
          source_type: 'symbol' as const,
          name: props.name as string,
          kind: props.kind as string,
          language: (props.language as string) ?? '',
          file_path: props.file_path as string,
          start_line: toNum(props.start_line),
          signature: (props.signature as string) ?? '',
          doc_comment: (props.doc_comment as string) ?? '',
          score: r.get('score') as number,
        };
      });
    } finally {
      await session.close();
    }
  }

  private async vectorSearch(
    query: string,
    limit: number,
    options?: SymbolScopeOptions,
    queryVectorPromise?: Promise<number[] | null>,
    observe?: (entry: InternalRetrievalChannelObservation) => void,
  ): Promise<CodeSearchResult[]> {
    // No usable embeddings → skip dense vector search; fulltext + deterministic
    // lexical-vector search still run and carry the fused result.
    if (this.embedding.available === false) {
      observe?.({ channel: 'code.dense-vector', outcome: 'safe-failure', code: 'unavailable' });
      return [];
    }
    try {
      // OPT-49: reuse the query vector search() embedded once; fall back to
      // embedding here for any direct caller that didn't pass one.
      const queryEmbedding = queryVectorPromise ? await queryVectorPromise : await this.embedding.embed(query);
      if (!queryEmbedding) return [];
      const candidateLimit = candidateLimitForPostFilters(limit, options);
      const session = this.driver.session();
      try {
        const result = await session.run(
          `CALL db.index.vector.queryNodes('symbol_embedding', $limit, $embedding)
           YIELD node AS s, score
           RETURN s, score`,
          { limit: neo4j.int(candidateLimit), embedding: queryEmbedding },
        );

        let results = result.records.map((r) => {
          const props = r.get('s').properties as Record<string, unknown>;
          return {
            id: props.id as string,
            source_type: 'symbol' as const,
            name: props.name as string,
            kind: props.kind as string,
            language: (props.language as string) ?? '',
            file_path: props.file_path as string,
            start_line: toNum(props.start_line),
            signature: (props.signature as string) ?? '',
            doc_comment: (props.doc_comment as string) ?? '',
            score: r.get('score') as number,
            project_tag: (props.project_tag as string) || undefined,
          };
        });

        // Project scope FIRST (T5/gap-11): filter by the stored canonical tag
        // BEFORE the file_path path heuristic. The path substring is a FALLBACK
        // for symbols with no stored project_tag.
        results = applyScopePostFilter(results, options);
        // Remaining post-filters (language matches the symbol's language property, not file extension)
        if (options?.language) results = results.filter((r) => r.language === options.language);
        if (options?.kind) results = results.filter((r) => r.kind === options.kind);

        const value = results.slice(0, limit).map(stripScratch);
        observe?.({ channel: 'code.dense-vector', outcome: 'success' });
        return value;
      } finally {
        await session.close();
      }
    } catch (err) {
      if (observe) console.error('[memberry-code] Symbol vector search failed [query-failed]');
      else console.error('[memberry-code] Symbol vector search failed (falling back to fulltext):', err instanceof Error ? err.message : err);
      observe?.({ channel: 'code.dense-vector', outcome: 'safe-failure', code: 'query-failed' });
      return [];
    }
  }

  private async lexicalVectorSearch(
    query: string,
    limit: number,
    options?: SymbolScopeOptions,
    observe?: (entry: InternalRetrievalChannelObservation) => void,
  ): Promise<CodeSearchResult[]> {
    try {
      const lexVec = generateLexicalVector(query);
      const candidateLimit = candidateLimitForPostFilters(limit, options);
      const session = this.driver.session();
      try {
        const result = await session.run(
          `CALL db.index.vector.queryNodes('symbol_lexical', $limit, $vector)
           YIELD node AS s, score
           RETURN s, score`,
          { limit: neo4j.int(candidateLimit), vector: lexVec },
        );

        let results = result.records.map((r) => {
          const props = r.get('s').properties as Record<string, unknown>;
          return {
            id: props.id as string,
            source_type: 'symbol' as const,
            name: props.name as string,
            kind: props.kind as string,
            language: (props.language as string) ?? '',
            file_path: props.file_path as string,
            start_line: toNum(props.start_line),
            signature: (props.signature as string) ?? '',
            doc_comment: (props.doc_comment as string) ?? '',
            score: r.get('score') as number,
            project_tag: (props.project_tag as string) || undefined,
          };
        });

        // Project scope FIRST (T5/gap-11), then the remaining post-filters.
        results = applyScopePostFilter(results, options);
        if (options?.language) results = results.filter((r) => r.language === options.language);
        if (options?.kind) results = results.filter((r) => r.kind === options.kind);

        const value = results.slice(0, limit).map(stripScratch);
        observe?.({ channel: 'code.lexical-vector', outcome: 'success' });
        return value;
      } finally {
        await session.close();
      }
    } catch (err) {
      if (observe) console.error('[memberry-code] Lexical vector search failed [query-failed]');
      else console.error('[memberry-code] Lexical vector search failed:', err instanceof Error ? err.message : err);
      observe?.({ channel: 'code.lexical-vector', outcome: 'safe-failure', code: 'query-failed' });
      return [];
    }
  }

  private async semanticVectorSearch(
    query: string,
    limit: number,
    asOf?: string,
    queryVectorPromise?: Promise<number[] | null>,
    observe?: (entry: InternalRetrievalChannelObservation) => void,
  ): Promise<CodeSearchResult[]> {
    if (this.embedding.available === false) {
      observe?.({ channel: 'code.semantic-vector', outcome: 'safe-failure', code: 'unavailable' });
      return [];
    }
    try {
      // OPT-49: reuse the query vector search() embedded once (shared with the
      // symbol dense channel); fall back to embedding for direct callers.
      const queryEmbedding = queryVectorPromise ? await queryVectorPromise : await this.embedding.embed(query);
      if (!queryEmbedding) return [];
      const semanticLimit = Math.min(limit, 10);
      const candidateLimit = candidateLimitForTemporalFilter(semanticLimit, Boolean(asOf));
      const session = this.driver.session();
      try {
        // When as_of is provided, post-filter semantic nodes to those created before the cutoff
        const temporalFilter = asOf ? 'WHERE s.created_at <= $asOf' : '';
        const result = await session.run(
          `CALL db.index.vector.queryNodes('semantic_embedding', $limit, $embedding)
           YIELD node AS s, score
           ${temporalFilter}
           RETURN s, score`,
          { limit: neo4j.int(candidateLimit), embedding: queryEmbedding, ...(asOf ? { asOf } : {}) },
        );

        const value = result.records.map((r) => {
          const props = r.get('s').properties as Record<string, unknown>;
          return {
            id: props.id as string,
            source_type: 'semantic' as const,
            name: `[Semantic] ${(props.id as string).slice(0, 12)}`,
            kind: 'semantic',
            file_path: '',
            start_line: 0,
            signature: (props.content as string) ?? '',
            doc_comment: '',
            score: (r.get('score') as number) * 0.8, // Slightly discount semantics vs code matches
          };
        }).slice(0, semanticLimit);
        observe?.({ channel: 'code.semantic-vector', outcome: 'success' });
        return value;
      } finally {
        await session.close();
      }
    } catch (err) {
      if (observe) console.error('[memberry-code] Semantic vector search failed [query-failed]');
      else console.error('[memberry-code] Semantic vector search failed:', err instanceof Error ? err.message : err);
      observe?.({ channel: 'code.semantic-vector', outcome: 'safe-failure', code: 'query-failed' });
      return [];
    }
  }
}

// ─── Reciprocal Rank Fusion (generic) ─────────────────────────────────────────
// Same algorithm as @memberry/retrieval's rrfFusion but operates on any
// { id: string; score: number } type. The retrieval version adds dynamic k,
// normalization, feedback boosts, and MMR — this is the lightweight path for
// direct berry_code_search calls.

function rrfFusion<T extends { id: string; score: number }>(
  rankedLists: T[][],
  limit: number,
  k = 60,
): T[] {
  const scores = new Map<string, { result: T; score: number }>();

  for (const list of rankedLists) {
    for (let rank = 0; rank < list.length; rank++) {
      const result = list[rank];
      const existing = scores.get(result.id);
      const rrfScore = 1 / (k + rank + 1);

      if (existing) {
        existing.score += rrfScore;
        if (result.score > existing.result.score) {
          existing.result = result;
        }
      } else {
        scores.set(result.id, { result, score: rrfScore });
      }
    }
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => ({ ...entry.result, score: entry.score }));
}

function toNum(val: unknown): number {
  if (typeof val === 'number') return val;
  if (val != null && typeof val === 'object' && 'toNumber' in val) {
    return (val as { toNumber: () => number }).toNumber();
  }
  return 0;
}

function candidateLimitForPostFilters(
  limit: number,
  options?: SymbolScopeOptions,
): number {
  if (!options?.language && !options?.file_path && !options?.kind && !options?.project_tag) return limit;
  return boundedOverfetchLimit(limit);
}

// ─── Project-scope filtering (T5/gap-11) ──────────────────────────────────────
//
// A canonical single-scope `project_tag` is the PRIMARY scope filter. A symbol
// matches a scope when its stored project_tag equals the tag, OR — as a FALLBACK
// for legacy symbols indexed before scoping (no stored tag) — it has no stored
// tag and (if a file_path hint is present) matches the path substring. The tag
// check is always applied BEFORE the path heuristic.

/**
 * Build the project-scope WHERE fragment for a Cypher symbol alias. Mirrors the
 * symbol-store helper so the fulltext channel scopes identically to findSymbols.
 */
function buildSymbolScopeCypher(
  alias: string,
  projectTag: string | undefined,
  filePath: string | undefined,
): { clause: string; params: Record<string, unknown> } {
  const tag = projectTag?.trim();
  const fp = filePath?.trim();

  if (tag) {
    const params: Record<string, unknown> = { project_tag: tag };
    if (fp) {
      params.file_path = fp;
      return {
        clause: `(${alias}.project_tag = $project_tag OR (${alias}.project_tag IS NULL AND toLower(${alias}.file_path) CONTAINS toLower($file_path)))`,
        params,
      };
    }
    return {
      clause: `(${alias}.project_tag = $project_tag OR ${alias}.project_tag IS NULL)`,
      params,
    };
  }

  if (fp) {
    return {
      clause: `toLower(${alias}.file_path) CONTAINS toLower($file_path)`,
      params: { file_path: fp },
    };
  }

  return { clause: '', params: {} };
}

/** The scratch fields a candidate carries through scope filtering (dropped before return). */
interface ScopeScratch {
  project_tag?: string;
  file_path: string;
}

/**
 * Apply the project scope as the FIRST post-filter on vector/lexical candidates,
 * BEFORE the file_path path heuristic. Matches buildSymbolScopeCypher semantics:
 * tag-equality first, path-substring only as a fallback for un-stamped symbols.
 * When no project_tag is supplied, preserves the prior file_path-only behavior.
 * Generic over the element type so the caller's literal `source_type` survives.
 */
function applyScopePostFilter<T extends ScopeScratch>(
  results: T[],
  options?: SymbolScopeOptions,
): T[] {
  const tag = options?.project_tag?.trim();
  const fp = options?.file_path?.trim();

  if (tag) {
    return results.filter((r) => {
      if (r.project_tag === tag) return true; // PRIMARY: stored canonical tag
      if (r.project_tag) return false;         // stamped for a different project
      // FALLBACK: legacy un-stamped symbol — admit, narrowed by path hint if given.
      return fp ? includesCaseInsensitive(r.file_path, fp) : true;
    });
  }

  if (fp) return results.filter((r) => includesCaseInsensitive(r.file_path, fp));
  return results;
}

/** Drop the scratch `project_tag` field so the public CodeSearchResult shape is unchanged. */
function stripScratch<T extends { project_tag?: string }>(r: T): Omit<T, 'project_tag'> {
  const { project_tag: _omit, ...rest } = r;
  return rest;
}

function candidateLimitForTemporalFilter(limit: number, hasTemporalFilter: boolean): number {
  if (!hasTemporalFilter) return limit;
  return boundedOverfetchLimit(limit);
}

function boundedOverfetchLimit(limit: number): number {
  return Math.min(Math.max(limit * 5, 50), 200);
}

function includesCaseInsensitive(value: string, search: string): boolean {
  return value.toLowerCase().includes(search.toLowerCase());
}
