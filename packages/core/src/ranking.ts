// packages/core/src/ranking.ts
import type { SemanticNode, FactNode } from './types.js';
import { RECENCY_DECAY_DAYS } from './types.js';
import { readEnv } from './config/settings.js';

/** Facts decay 4x slower than semantics — they represent consolidated truth */
const FACT_DECAY_MULTIPLIER = 4;

/**
 * Slice 5 (2026-09-05). With RECENCY_DECAY_DAYS = 7 the bare exponential scores a
 * three-week-old approved decision ~13x below a three-day-old one, so no relevance
 * signal can lift it: measured live, the same four newest semantics topped every
 * berry_load regardless of the question, and 25 of 28 real agent calls missed their
 * adjudicated answer (bench/eval/SELECTION-LOG.md). Under MEMBERRY_MEMORY_RANK_V2
 * two things change together, because each alone measured worse than both:
 *   1. recency is floored at 0.95 — a <=5% tiebreak, not a gate;
 *   2. vector-channel relevance is the hit's RANK inside its channel, not its raw
 *      cosine — live cosines sit in 0.79..0.82, too flat to order anything.
 * In-process matrix on the 28 berry_load cases (bench/eval/memory-load-measure.mts),
 * Answer@5 / MRR: baseline 0.07 / 0.03; floor .5 alone 0.25 / 0.16; floor .5 + rank
 * 0.46 / 0.28; floor .8 + rank 0.50 / 0.34; floor .95 + rank 0.50 / 0.38 (shipped).
 * Read per call so a flag flip needs no restart.
 * ponytail: constants, not knobs; a second measured value earns a flag.
 */
export const RECENCY_FLOOR_V2 = 0.95;
export function memoryRankV2(): boolean {
  return readEnv('MEMBERRY_MEMORY_RANK_V2') === '1';
}
function recencyFactor(ageDays: number): number {
  const decay = Math.exp(-ageDays / RECENCY_DECAY_DAYS);
  return memoryRankV2() ? RECENCY_FLOOR_V2 + (1 - RECENCY_FLOOR_V2) * decay : decay;
}

/**
 * V2 relevance for one vector channel's hits, in delivered order: top hit 1.0, last
 * hit 0.5 (= the default relevance of a scope-only node), linear between. Identity
 * when the flag is off. Pure; the channel lists stay separate so the semantic and
 * episodic channels each keep a 1.0.
 */
export function rankNormalizeRelevance<T extends { score: number }>(hits: T[]): T[] {
  if (!memoryRankV2() || hits.length === 0) return hits;
  const last = hits.length - 1;
  return hits.map((hit, i) => ({ ...hit, score: last === 0 ? 1 : 1 - 0.5 * (i / last) }));
}

/**
 * MEMBERRY_MEMORY_LEXICAL_V1 (2026-09-05). Real agent questions name identifiers — packet ids,
 * decision numbers, commit SHAs — and the answer's content contains them, but the vector channel
 * ranked such answers 12th..15th of 20 on a flat 0.71..1.0 cosine spread, and berry_load has no
 * lexical signal at all (berry_context's served reranker has one; core cannot import it).
 * In-process matrix on the 28 berry_load cases with RANK_V2 on: Answer@5 / @10 / MRR —
 * weight 0: 0.50 / 0.54 / 0.38; 0.5: 0.71 / 0.71 / 0.63; 1.0: 0.79 / 0.86 / 0.66 (shipped);
 * 2.0: 0.79 / 0.86 / 0.67. Adjudication of those cases also grepped on identifiers, so the
 * berry_context cases and the 46-case subset are the independent check post-deploy.
 * ponytail: substring overlap on a closed identifier shape; a tokeniser earns its place only
 * if a measured failure needs it.
 */
export const LEXICAL_IDENTIFIER_WEIGHT_V1 = 1.0;
const IDENTIFIER_PATTERN = /[A-Za-z]*\d[A-Za-z0-9-]*|[A-Z]{2,}[A-Za-z0-9-]*-[A-Za-z0-9-]+/g;

export function memoryLexicalV1(): boolean {
  return readEnv('MEMBERRY_MEMORY_LEXICAL_V1') === '1';
}

/** Identifier-shaped tokens of a task string, lowercased, unique, length >= 4. */
export function taskIdentifiers(task: string): readonly string[] {
  const found = task.match(IDENTIFIER_PATTERN) ?? [];
  return [...new Set(found.map((token) => token.toLowerCase()).filter((token) => token.length >= 4))];
}

/**
 * Adds weight * (share of the task's identifiers present in the content) to each node's
 * relevance (default 0.5 when unset). Pure; identity when the flag is off or the task names no
 * identifier.
 */
export function boostByIdentifierOverlap<T extends { content: string; relevanceScore?: number }>(
  task: string,
  nodes: T[],
): T[] {
  if (!memoryLexicalV1()) return nodes;
  const identifiers = taskIdentifiers(task);
  if (identifiers.length === 0) return nodes;
  return nodes.map((node) => {
    const content = node.content.toLowerCase();
    const hits = identifiers.filter((token) => content.includes(token)).length;
    if (hits === 0) return node;
    return { ...node, relevanceScore: (node.relevanceScore ?? 0.5) + LEXICAL_IDENTIFIER_WEIGHT_V1 * (hits / identifiers.length) };
  });
}

export function rankMemories(
  memories: Array<SemanticNode & { relevanceScore?: number }>,
  now: Date = new Date(),
): Array<SemanticNode & { score: number }> {
  const scored = memories.map((memory) => {
    const ageDays = ageInDays(memory.updated_at, now);
    const recencyScore = recencyFactor(ageDays);
    const relevance = memory.relevanceScore ?? 0.5;
    const score = memory.confidence * recencyScore * relevance;
    return { ...memory, score };
  });

  return scored.sort((a, b) => b.score - a.score);
}

export function budgetTokens<T extends { tokens: number }>(items: T[], maxTokens: number): T[] {
  if (maxTokens <= 0) return [];

  const result: T[] = [];
  let used = 0;

  for (const item of items) {
    if (item.tokens > maxTokens || used + item.tokens > maxTokens) continue;
    result.push(item);
    used += item.tokens;
  }

  return result;
}

export function estimateTokens(text: string): number {
  // ~4 chars per token
  return Math.ceil(text.length / 4);
}

/**
 * Per-status ranking multiplier for facts. In historical/interval/evolution temporal
 * modes, fact sets can include non-active facts, so ranking MUST demote them — a
 * superseded fact must never rank alongside the current truth ("what is true now").
 *   active      — current truth, full weight
 *   tentative   — observed once, not yet confirmed; ranks below active
 *   disputed    — contradicted but not resolved; penalized
 *   invalidated — superseded by a newer fact; strongly demoted (kept for history, not trusted)
 */
const FACT_STATUS_MULTIPLIER: Record<FactNode['status'], number> = {
  active: 1.0,
  tentative: 0.7,
  disputed: 0.5,
  invalidated: 0.15,
};

/**
 * Per-inference-type ranking multiplier. Guesses must rank below knowns so the
 * dream pass's abductive hypotheses never crowd out explicit facts:
 *   deductive — explicit/derived, full weight
 *   inductive — generalized from patterns, slightly demoted
 *   abductive — a hypothesis, strongly demoted (still surfaced, clearly secondary)
 */
const FACT_INFERENCE_MULTIPLIER: Record<NonNullable<FactNode['inference_type']>, number> = {
  deductive: 1.0,
  inductive: 0.85,
  abductive: 0.5,
};

/**
 * Rank facts by confidence, recency (using valid_at), status, and inference type.
 * Current (active, deductive) facts rank above tentative/disputed/abductive ones.
 */
export function rankFacts(
  facts: FactNode[],
  now: Date = new Date(),
): FactNode[] {
  const scored = facts.map((fact) => {
    const ageDays = ageInDays(fact.valid_at, now);
    const recencyScore = Math.exp(-ageDays / (RECENCY_DECAY_DAYS * FACT_DECAY_MULTIPLIER));
    const statusMultiplier = FACT_STATUS_MULTIPLIER[fact.status] ?? 1.0;
    const inferenceMultiplier = FACT_INFERENCE_MULTIPLIER[fact.inference_type ?? 'deductive'] ?? 1.0;
    const score = fact.confidence * recencyScore * statusMultiplier * inferenceMultiplier;
    return { fact, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.fact);
}

function ageInDays(timestamp: string, now: Date): number {
  const parsed = new Date(timestamp).getTime();
  if (!Number.isFinite(parsed)) return 0;

  const ageMs = now.getTime() - parsed;
  if (!Number.isFinite(ageMs) || ageMs < 0) return 0;

  return ageMs / (1000 * 60 * 60 * 24);
}
