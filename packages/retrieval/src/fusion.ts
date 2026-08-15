// packages/retrieval/src/fusion.ts
// Reciprocal Rank Fusion: merges multiple ranked lists into one.
// Enhanced with dynamic k scaling, normalization, and MMR diversification.

import type { RetrievalResult, BoostFactors } from './types.js';
import {
  scaleRrfK,
  normalizeScores,
  mmrDiversify,
  provenanceQualityMultiplier,
  type RankedMmrObservation,
} from './scoring.js';

/** @internal Structural-only observer for the outer ranked algorithm. */
export interface RankedFusionObserver {
  rrf(result: RetrievalResult, value: number): void;
  score(result: RetrievalResult, name: 'feedback-multiplier' | 'provenance-multiplier' | 'lexical-multiplier' | 'normalized', value: number): void;
  candidateWindow(result: RetrievalResult, admitted: boolean): void;
  finalScore(result: RetrievalResult, value: number): void;
  mmr(observation: RankedMmrObservation): void;
}

/**
 * Reciprocal Rank Fusion across N ranked lists.
 * score(d) = sum(1 / (k + rank_i(d))) for each list i where d appears.
 *
 * @param lists - Multiple ranked result lists from different retrieval strategies
 * @param limit - Maximum results to return
 * @param k - Base RRF constant (default 60, scaled dynamically for large collections)
 * @param boosts - Optional per-entity and per-source-type boost factors from feedback
 * @param collectionSize - Optional total collection size for dynamic k scaling and normalization
 * @param postBoost - Optional function to apply score boost after RRF but before MMR diversification
 */
export function rrfFusion(
  lists: RetrievalResult[][],
  limit: number,
  k = 60,
  boosts?: BoostFactors,
  collectionSize?: number,
  postBoost?: (result: RetrievalResult) => number,
  observer?: RankedFusionObserver,
): RetrievalResult[] {
  // Dynamic k scaling for large collections
  const effectiveK = collectionSize ? scaleRrfK(k, collectionSize) : k;

  const scores = new Map<string, { result: RetrievalResult; rrfScore: number }>();

  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const result = list[rank];
      const rrfScore = 1 / (effectiveK + rank + 1);

      const existing = scores.get(result.id);
      if (existing) {
        existing.rrfScore += rrfScore;
        // Keep the result with more content
        if (result.content.length > existing.result.content.length) {
          existing.result = { ...result };
        }
      } else {
        scores.set(result.id, { result: { ...result }, rrfScore });
      }
    }
  }

  if (observer) for (const entry of scores.values()) observer.rrf(entry.result, entry.rrfScore);

  // Apply boost factors from feedback history.
  // OPT-51: hoist the entity-boost entries out of the per-candidate loop (they
  // are identical for every candidate, so rebuilding the array N times was pure
  // waste) and skip the inner scan entirely when there are no entity boosts
  // (cold-start / no-feedback tenants). Substring-match semantics and the
  // per-candidate multiplication order are unchanged → output-identical.
  // entity_boosts is already bounded to the top 50 (FeedbackTracker.getBoosts).
  if (boosts) {
    const entityBoostEntries = Object.entries(boosts.entity_boosts);
    for (const entry of scores.values()) {
      const beforeFeedback = entry.rrfScore;
      if (entityBoostEntries.length > 0) {
        const { content, title } = entry.result;
        for (const [entity, boost] of entityBoostEntries) {
          if (content.includes(entity) || title.includes(entity)) {
            entry.rrfScore *= (1 + boost);
          }
        }
      }

      const sourceBoost = boosts.source_type_boosts[entry.result.source_type];
      if (sourceBoost) {
        entry.rrfScore *= (1 + sourceBoost);
      }
      observer?.score(entry.result, 'feedback-multiplier', entry.rrfScore / beforeFeedback);
    }
  } else if (observer) {
    for (const entry of scores.values()) observer.score(entry.result, 'feedback-multiplier', 1);
  }

  // Apply bounded provenance quality before normalization/MMR. This keeps the
  // rank-fusion shape intact while demoting invalidated/superseded memories and
  // lightly favoring high-confidence, source-backed results.
  for (const entry of scores.values()) {
    const multiplier = provenanceQualityMultiplier(entry.result);
    entry.rrfScore *= multiplier;
    observer?.score(entry.result, 'provenance-multiplier', multiplier);
  }

  // Sort by score
  const sorted = [...scores.values()].sort((a, b) => b.rrfScore - a.rrfScore);
  if (observer) {
    const windowSize = Math.min(sorted.length, limit * 2);
    for (let index = 0; index < sorted.length; index++) {
      observer.candidateWindow(sorted[index]!.result, index < windowSize);
    }
  }
  let results = sorted
    .slice(0, limit * 2) // Over-fetch for MMR (diversification will trim)
    .map((entry) => ({ ...entry.result, score: entry.rrfScore }));

  // Z-score + sigmoid normalization for large collections
  if (collectionSize) {
    results = normalizeScores(results, collectionSize);
    if (observer) for (const result of results) observer.score(result, 'normalized', result.score);
  }

  // Apply optional post-RRF boost (before MMR so diversity selection uses boosted scores)
  if (postBoost) {
    for (const result of results) {
      const before = result.score;
      result.score = postBoost(result);
      observer?.score(result, 'lexical-multiplier', before === 0 ? 1 : result.score / before);
    }
    results.sort((a, b) => b.score - a.score);
  }

  // MMR diversification: reduce redundancy (operates on final boosted scores)
  if (observer) for (const result of results) observer.finalScore(result, result.score);
  results = mmrDiversify(results, limit, 0.7, observer ? (observation) => observer.mmr(observation) : undefined);

  return results;
}

/**
 * Dedup results by ID. Keeps the one with the highest score.
 */
export function dedup(results: RetrievalResult[]): RetrievalResult[] {
  const seen = new Map<string, RetrievalResult>();
  for (const r of results) {
    const existing = seen.get(r.id);
    if (!existing || r.score > existing.score) {
      seen.set(r.id, r);
    }
  }
  return [...seen.values()];
}
