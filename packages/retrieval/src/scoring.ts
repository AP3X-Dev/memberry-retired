// packages/retrieval/src/scoring.ts
// Enhanced scoring: dynamic RRF k, lexical text scoring, z-score normalization,
// adaptive weights, MMR diversification.
// Ported from Context-Engine scripts/hybrid/ranking.py

import type { RetrievalResult, QueryStats, AdaptiveWeights, SourceType } from './types.js';

// ─── Configuration ───────────────────────────────────────────────────────────

const LARGE_COLLECTION_THRESHOLD = 10_000;
const MAX_RRF_K_SCALE = 3.0;
const LEXICAL_TEXT_SAT = 12.0; // tanh saturation
// MMR redundancy similarity for two DISTINCT symbols in the same file. A hard 1.0
// (max penalty) evicts legitimately-relevant sibling symbols — extremely common in
// code memory (e.g. authorizeCharge/captureCharge/voidCharge in charge.ts). Same file
// is a redundancy *signal*, not proof, so penalize but let strong relevance override.
const SAME_FILE_MMR_SIM = 0.55;

// ─── Dynamic RRF K ───────────────────────────────────────────────────────────

/**
 * Scale RRF k for large collections.
 * Larger k spreads score distribution, preventing top-heavy ranking.
 */
export function scaleRrfK(baseK: number, collectionSize: number): number {
  if (collectionSize < LARGE_COLLECTION_THRESHOLD) return baseK;
  const scale = 1.0 + Math.log10(collectionSize / LARGE_COLLECTION_THRESHOLD);
  return Math.round(baseK * Math.min(scale, MAX_RRF_K_SCALE));
}

// ─── Lexical Text Scoring ────────────────────────────────────────────────────

/**
 * Score a result by lexical text matching against the query.
 * Higher scores for exact symbol matches, path matches, and code occurrences.
 */
export function lexicalTextScore(
  queryTokens: string[],
  metadata: { name?: string; file_path?: string; signature?: string; content?: string },
): number {
  let score = 0;
  // Strip a trailing " (kind)" decoration so the exact-name signal actually fires —
  // callers pass titles like "validateToken (function)", which previously never
  // matched the (highest-weight) exact branch and collapsed to a substring nudge.
  const rawNameOrig = stripKindSuffix(metadata.name ?? '');
  const rawName = rawNameOrig.toLowerCase();
  const nameWordSet = new Set(identifierWords(rawNameOrig));
  const filePath = (metadata.file_path ?? '').toLowerCase();
  const pathParts = filePath.split('/');
  const fileName = pathParts[pathParts.length - 1] ?? '';
  const signature = (metadata.signature ?? '').toLowerCase();
  const content = (metadata.content ?? '').toLowerCase().slice(0, 2000);

  let nameWordHits = 0;

  for (const token of queryTokens) {
    const t = token.toLowerCase();

    // Name matching — exact identifier signals weigh far more than substring noise.
    // An identifier lookup ("validateToken") must rank the exact symbol decisively
    // above docs that merely mention one of its words.
    if (rawName && rawName === t) {
      score += 3.0; // whole symbol name equals this token
    } else if (nameWordSet.has(t)) {
      score += 2.0; // exact word within a camelCase/snake_case identifier
      nameWordHits++;
    } else if (t.length >= 3 && rawName.includes(t)) {
      score += 0.6; // weak substring — a typed prefix/fragment
    }

    // Path segment match
    if (pathParts.some((p) => p.includes(t))) {
      score += 0.8;
      // Filename bonus
      if (fileName.includes(t)) {
        score += 0.3;
      }
    }

    // Signature match
    if (signature.includes(t)) {
      score += 1.2;
    }

    // Content occurrence
    if (content.includes(t)) {
      score += 1.0;
    }
  }

  // Full-identifier reconstruction: the query covers every word of a multi-word
  // identifier (e.g. ["validate","token"] → validateToken). Strongest lexical signal.
  if (nameWordSet.size >= 2 && nameWordHits === nameWordSet.size) {
    score += 2.0;
  }

  // Normalize via tanh saturation: bounded in [0, 1]
  return Math.tanh(score / LEXICAL_TEXT_SAT);
}

/** Strip a trailing " (kind)" decoration, e.g. "AuthService (class)" → "AuthService". */
function stripKindSuffix(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/** Split an identifier into lowercase word parts on camelCase/snake/non-alnum bounds. */
function identifierWords(s: string): string[] {
  const out: string[] = [];
  for (const part of s.split(/[^A-Za-z0-9]+/)) {
    const matches = part.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+/g);
    if (matches) {
      for (const w of matches) {
        const lw = w.toLowerCase();
        if (lw.length > 1) out.push(lw);
      }
    }
  }
  return out;
}

// ─── Score Normalization ─────────────────────────────────────────────────────

/**
 * Z-score + sigmoid normalization for large result sets.
 * Spreads compressed score distributions.
 */
export function normalizeScores(results: RetrievalResult[], collectionSize: number): RetrievalResult[] {
  if (collectionSize < LARGE_COLLECTION_THRESHOLD || results.length < 3) return results;

  const scores = results.map((r) => r.score);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance = scores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / scores.length;
  const std = Math.sqrt(variance);

  if (std < 1e-10) return results; // All scores identical

  return results.map((r) => {
    const z = (r.score - mean) / std;
    const normalized = 1.0 / (1.0 + Math.exp(-z * 0.5)); // Sigmoid with gentle slope
    return { ...r, score: normalized };
  });
}

// ─── Provenance Quality ──────────────────────────────────────────────────────

/**
 * Bounded ranking multiplier derived from provenance metadata.
 *
 * Results with no provenance metadata stay neutral. Current, high-confidence
 * results backed by multiple source episodes receive a small boost; invalidated
 * or superseded results are strongly demoted but not removed.
 */
export function provenanceQualityMultiplier(result: RetrievalResult): number {
  const metadata = result.metadata ?? {};
  let hasSignal = false;
  let multiplier = 1;

  const confidence = finiteNumber(metadata['confidence']);
  if (confidence !== undefined) {
    hasSignal = true;
    multiplier += (clamp(confidence, 0, 1) - 0.5) * 0.2;
  }

  const sourceCount = Array.isArray(metadata['source_episode_ids'])
    ? metadata['source_episode_ids'].filter(Boolean).length
    : 0;
  if (sourceCount > 0) {
    hasSignal = true;
    multiplier += Math.min(sourceCount, 5) * 0.03;
  }

  const signalCount = finiteNumber(metadata['signal_count']);
  if (signalCount !== undefined && signalCount > 0) {
    hasSignal = true;
    multiplier += Math.min(signalCount, 10) * 0.01;
  }

  let invalidated = false;
  if (metadata['invalidated_at'] || metadata['superseded_by']) {
    hasSignal = true;
    multiplier *= 0.15;
    invalidated = true;
  }

  // Invalidated/superseded memories may fall BELOW the normal low-confidence floor — a
  // stale fact should rank far beneath even a weak active one, so it drops out of the
  // top context entirely rather than merely being demoted within it (stale-leak control).
  const floor = invalidated ? 0.05 : 0.25;
  return hasSignal ? clamp(multiplier, floor, 1.3) : 1;
}

// ─── Adaptive Weights ────────────────────────────────────────────────────────

/**
 * Compute query-adaptive weights for different scoring signals.
 * Adjusts based on query characteristics.
 */
export function computeQueryStats(query: string): QueryStats {
  const tokens = query.split(/\s+/).filter(Boolean);
  const identifierPattern = /^[A-Z][a-z]+[A-Z]|^[a-z]+[A-Z]|^[a-z]+_[a-z]+|^[a-z]+\.[a-z]+/;
  const identifierCount = tokens.filter((t) => identifierPattern.test(t)).length;

  const lower = query.toLowerCase();
  const narrativeHint = /\b(how|why|explain|describe|what is|what does|purpose)\b/.test(lower);
  const graphHint = /\b(who calls|callers?|depends|imports?|inherits?|references?|usages?)\b/.test(lower);

  return {
    totalTokens: tokens.length,
    identifierDensity: tokens.length > 0 ? identifierCount / tokens.length : 0,
    avgTokenLen: tokens.length > 0 ? tokens.reduce((sum, t) => sum + t.length, 0) / tokens.length : 0,
    narrativeHint,
    graphHint,
  };
}

// ─── Source-type intent ──────────────────────────────────────────────────────

// Explicit code-type words signal the user wants code symbols, not prose. A query
// like "payment charge functions" or "find the AuthService class" should favor Symbol
// results over high-confidence semantic memories that merely mention the topic.
const SYMBOL_TYPE_HINTS = new Set([
  'function', 'functions', 'func', 'fn', 'method', 'methods', 'class', 'classes',
  'interface', 'interfaces', 'struct', 'enum', 'def', 'symbol', 'symbols',
]);

/**
 * Infer a source-type preference from explicit type words in the query.
 * Returns per-source-type multiplicative boosts (additive over 1.0) to merge into
 * the feedback boosts already applied in rrfFusion. Empty when no strong hint.
 */
export function inferSourceTypeBoost(query: string): Partial<Record<SourceType, number>> {
  const tokens = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.some((t) => SYMBOL_TYPE_HINTS.has(t))) {
    return { symbol: 0.25 };
  }
  return {};
}

export function adaptiveWeights(stats: QueryStats): AdaptiveWeights {
  // Base weights
  let denseWeight = 1.5;
  let lexicalVectorWeight = 0.2;
  let lexicalTextWeight = 0.2;

  // High identifier density → boost exact matching
  if (stats.identifierDensity > 0.5) {
    lexicalTextWeight += 0.15;
    lexicalVectorWeight += 0.1;
    denseWeight -= 0.2;
  }

  // Narrative questions → boost semantic/dense
  if (stats.narrativeHint) {
    denseWeight += 0.3;
    lexicalTextWeight -= 0.1;
  }

  // Graph queries → boost lexical (exact symbol names matter)
  if (stats.graphHint) {
    lexicalTextWeight += 0.2;
    lexicalVectorWeight += 0.15;
  }

  return { denseWeight, lexicalVectorWeight, lexicalTextWeight };
}

// ─── MMR Diversification ─────────────────────────────────────────────────────

/**
 * Maximal Marginal Relevance: reduce redundancy in results.
 * Uses path/symbol-based similarity to penalize near-duplicates.
 * Lambda controls relevance vs diversity trade-off (0.7 = favor relevance).
 */
export function mmrDiversify(
  ranked: RetrievalResult[],
  k: number = 60,
  lambda: number = 0.7,
  observer?: RankedMmrObserver,
): RetrievalResult[] {
  if (ranked.length <= 1) {
    if (ranked.length === 1) observer?.({
      round: 1,
      selected: ranked[0]!,
      records: [{ candidate: ranked[0]!, relevance: 1, pairwise: [] }],
      lambda,
    });
    return ranked;
  }
  k = Math.min(k, ranked.length);

  // Bound candidate set to top 200 by relevance to avoid O(n·k) blowup on large inputs
  const maxCandidates = Math.min(ranked.length, 200);

  // Pre-compute path parts for similarity (avoid repeated splitting)
  const pathPartsCache = ranked.slice(0, maxCandidates).map((r) => {
    const path = (r.metadata.file_path as string) ?? (r.metadata.name as string) ?? '';
    return new Set(path.split('/').filter(Boolean));
  });

  // Normalize relevance to [0,1] so it is comparable to the [0,1] similarity term.
  // RRF scores are tiny in absolute terms (~0.01–0.04); combined raw, the diversity
  // penalty (1-λ)·maxSim utterly dwarfs λ·relevance and MMR degenerates into pure
  // diversity sorting that ignores relevance. Min-max scaling restores the trade-off.
  let minScore = Infinity;
  let maxScore = -Infinity;
  for (let i = 0; i < maxCandidates; i++) {
    const s = ranked[i].score;
    if (s < minScore) minScore = s;
    if (s > maxScore) maxScore = s;
  }
  const scoreRange = maxScore - minScore;
  const relNorm = (idx: number): number =>
    scoreRange > 1e-12 ? (ranked[idx].score - minScore) / scoreRange : 1;

  const selected: RetrievalResult[] = [];
  const selectedIndices: number[] = []; // Track indices explicitly for cache lookups
  const remaining = new Set(Array.from({ length: maxCandidates }, (_, i) => i));

  // Start with highest-relevance item
  let bestIdx = 0;
  let bestScore = -Infinity;
  for (const idx of remaining) {
    if (ranked[idx].score > bestScore) {
      bestScore = ranked[idx].score;
      bestIdx = idx;
    }
  }
  observer?.({
    round: 1,
    selected: ranked[bestIdx]!,
    records: [...remaining].map((idx) => ({
      candidate: ranked[idx]!,
      relevance: relNorm(idx),
      pairwise: [],
    })),
    lambda,
  });
  selected.push(ranked[bestIdx]);
  selectedIndices.push(bestIdx);
  remaining.delete(bestIdx);

  // Greedy selection with pre-computed similarity
  while (selected.length < k && remaining.size > 0) {
    let bestMmrIdx = -1;
    let bestMmrScore = -Infinity;

    const roundRecords = observer ? [] as RankedMmrObservation['records'] : undefined;
    for (const idx of remaining) {
      const relevance = relNorm(idx);

      // Max similarity to any already-selected item (early exit on identical item)
      let maxSim = 0;
      const pairwise = observer ? [] as Array<{ selected: RetrievalResult; similarity: number }> : undefined;
      for (let si = 0; si < selected.length; si++) {
        const selIdx = selectedIndices[si];
        const sim = fastSimilarity(ranked[idx], selected[si], pathPartsCache[idx], pathPartsCache[selIdx]);
        pairwise?.push({ selected: selected[si]!, similarity: sim });
        if (sim >= 1.0) {
          maxSim = 1.0;
          // A trace must carry similarity to every previously selected ref so
          // replay can derive the maximum independently. Ordinary calls keep
          // the historical early exit and its exact performance/output.
          if (!observer) break;
        } // Identical (same name+file) — max penalty
        if (sim > maxSim) maxSim = sim;
      }

      const mmrScore = lambda * relevance - (1 - lambda) * maxSim;
      roundRecords?.push({ candidate: ranked[idx]!, relevance, pairwise: pairwise ?? [] });
      if (mmrScore > bestMmrScore) {
        bestMmrScore = mmrScore;
        bestMmrIdx = idx;
      }
    }

    if (bestMmrIdx === -1) break;
    observer?.({
      round: selected.length + 1,
      selected: ranked[bestMmrIdx]!,
      records: roundRecords!,
      lambda,
    });
    selected.push(ranked[bestMmrIdx]);
    selectedIndices.push(bestMmrIdx);
    remaining.delete(bestMmrIdx);
  }

  // Append any remaining items beyond the bounded candidate set (already sorted by relevance)
  if (selected.length < k && ranked.length > maxCandidates) {
    for (let i = maxCandidates; i < ranked.length && selected.length < k; i++) {
      selected.push(ranked[i]);
    }
  }

  return selected;
}

/** @internal Exact bounded inputs used by the ranked MMR implementation. */
export interface RankedMmrObservation {
  round: number;
  selected: RetrievalResult;
  records: Array<{
    candidate: RetrievalResult;
    relevance: number;
    pairwise: Array<{ selected: RetrievalResult; similarity: number }>;
  }>;
  lambda: number;
}

/** @internal Runtime tracing seam; omitted on every ordinary call. */
export type RankedMmrObserver = (observation: RankedMmrObservation) => void;

/**
 * Fast similarity using pre-computed path part sets. Used by MMR.
 */
function fastSimilarity(
  a: RetrievalResult,
  b: RetrievalResult,
  partsA?: Set<string>,
  partsB?: Set<string>,
): number {
  const pathA = (a.metadata.file_path as string) ?? '';
  const pathB = (b.metadata.file_path as string) ?? '';

  const nameA = (a.metadata.name as string) ?? a.title;
  const nameB = (b.metadata.name as string) ?? b.title;

  // Identical symbol (same name AND file) is true redundancy — full penalty.
  if (pathA && pathB && pathA === pathB && nameA && nameB && nameA === nameB) return 1.0;

  // Distinct symbols in the same file: a redundancy signal, not a duplicate.
  if (pathA && pathB && pathA === pathB) return SAME_FILE_MMR_SIM;

  if (nameA && nameB && nameA === nameB) return 0.8;

  // Jaccard similarity on pre-computed path parts
  const setA = partsA ?? new Set(pathA.split('/').filter(Boolean));
  const setB = partsB ?? new Set(pathB.split('/').filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const p of setA) {
    if (setB.has(p)) intersection++;
  }
  const union = setA.size + setB.size - intersection;

  return union > 0 ? 0.5 * (intersection / union) : 0;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
