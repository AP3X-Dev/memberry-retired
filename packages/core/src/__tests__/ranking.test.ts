// packages/core/src/__tests__/ranking.test.ts
import { describe, it, expect } from 'vitest';
import { rankMemories, rankNormalizeRelevance, boostByIdentifierOverlap, taskIdentifiers, budgetTokens, estimateTokens } from '../ranking.js';
import type { SemanticNode } from '../types.js';

function makeNode(
  overrides: Partial<SemanticNode> & { relevanceScore?: number },
): SemanticNode & { relevanceScore?: number } {
  const base: SemanticNode = {
    id: 'node-1',
    content: 'Test content',
    confidence: 0.5,
    signal_count: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    decay_class: 'stable',
    tags: [],
  };
  return { ...base, ...overrides };
}

describe('rankMemories', () => {
  it('high confidence + recent node ranks before low confidence + old node', () => {
    const now = new Date('2025-01-10T00:00:00Z');

    const recent = makeNode({
      id: 'recent',
      confidence: 0.9,
      updated_at: '2025-01-09T00:00:00Z', // 1 day old
    });

    const old = makeNode({
      id: 'old',
      confidence: 0.2,
      updated_at: '2024-12-01T00:00:00Z', // ~40 days old
    });

    const ranked = rankMemories([old, recent], now);

    expect(ranked[0].id).toBe('recent');
    expect(ranked[1].id).toBe('old');
  });

  it('low confidence + old node ranks last', () => {
    const now = new Date('2025-01-10T00:00:00Z');

    const highConf = makeNode({
      id: 'high',
      confidence: 0.95,
      updated_at: '2025-01-09T00:00:00Z',
    });

    const midConf = makeNode({
      id: 'mid',
      confidence: 0.5,
      updated_at: '2025-01-08T00:00:00Z',
    });

    const lowOld = makeNode({
      id: 'low-old',
      confidence: 0.1,
      updated_at: '2024-11-01T00:00:00Z', // ~70 days old
    });

    const ranked = rankMemories([lowOld, midConf, highConf], now);

    expect(ranked[0].id).toBe('high');
    expect(ranked[ranked.length - 1].id).toBe('low-old');
  });

  it('high relevance score boosts a low-confidence item above default-relevance item', () => {
    const now = new Date('2025-01-10T00:00:00Z');
    const updatedAt = '2025-01-09T00:00:00Z'; // same age for both

    const lowConfHighRel = makeNode({
      id: 'low-conf-high-rel',
      confidence: 0.3,
      updated_at: updatedAt,
      relevanceScore: 0.99,
    });

    const midConfDefaultRel = makeNode({
      id: 'mid-conf-default-rel',
      confidence: 0.5,
      updated_at: updatedAt,
      // relevanceScore not set → defaults to 0.5
    });

    // low-conf-high-rel score = 0.3 * recency * 0.99
    // mid-conf-default-rel score = 0.5 * recency * 0.5
    // 0.3 * 0.99 = 0.297 > 0.5 * 0.5 = 0.25 → low-conf-high-rel wins
    const ranked = rankMemories([midConfDefaultRel, lowConfHighRel], now);

    expect(ranked[0].id).toBe('low-conf-high-rel');
  });

  it('missing relevanceScore defaults to 0.5', () => {
    const now = new Date('2025-01-10T00:00:00Z');
    const updatedAt = now.toISOString();

    const node = makeNode({ id: 'n1', confidence: 1.0, updated_at: updatedAt });
    const ranked = rankMemories([node], now);

    // score = 1.0 * exp(0) * 0.5 = 0.5
    expect(ranked[0].score).toBeCloseTo(0.5, 5);
  });

  it('returns nodes with a score property attached', () => {
    const now = new Date();
    const node = makeNode({ id: 'n1' });
    const ranked = rankMemories([node], now);

    expect(ranked[0]).toHaveProperty('score');
    expect(typeof ranked[0].score).toBe('number');
  });

  it('keeps a finite score when updated_at is invalid', () => {
    const node = makeNode({
      id: 'bad-date',
      confidence: 0.8,
      updated_at: 'not-a-date',
      relevanceScore: 0.7,
    });

    const ranked = rankMemories([node], new Date('2025-01-10T00:00:00Z'));

    expect(Number.isFinite(ranked[0].score)).toBe(true);
  });

  // Slice 5. A three-week-old approved decision that the vector channel matched
  // (relevance 0.75) versus a three-day-old scope-only node (default relevance 0.5).
  // Under the bare exponential (RECENCY_DECAY_DAYS = 7) age wins ~9:1; under
  // MEMBERRY_MEMORY_RANK_V2 the recency floor keeps relevance in charge.
  const oldRelevant = () => makeNode({
    id: 'old-relevant', confidence: 0.9, relevanceScore: 0.75,
    updated_at: new Date(Date.now() - 21 * 86_400_000).toISOString(),
  });
  const newDefault = () => makeNode({
    id: 'new-default', confidence: 0.9,
    updated_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  });

  it('without MEMBERRY_MEMORY_RANK_V2, a 3-day-old default-relevance node outranks a 21-day-old relevant one', () => {
    const prev = process.env.MEMBERRY_MEMORY_RANK_V2;
    delete process.env.MEMBERRY_MEMORY_RANK_V2;
    try {
      expect(rankMemories([oldRelevant(), newDefault()]).map((n) => n.id)).toEqual(['new-default', 'old-relevant']);
    } finally {
      if (prev !== undefined) process.env.MEMBERRY_MEMORY_RANK_V2 = prev;
    }
  });

  it('with MEMBERRY_MEMORY_RANK_V2=1, the recency floor lets the relevant 21-day-old node win', () => {
    const prev = process.env.MEMBERRY_MEMORY_RANK_V2;
    process.env.MEMBERRY_MEMORY_RANK_V2 = '1';
    try {
      const ranked = rankMemories([newDefault(), oldRelevant()]);
      expect(ranked.map((n) => n.id)).toEqual(['old-relevant', 'new-default']);
      // floor 0.95: a node of infinite age keeps 95% of its recency weight
      const ancient = rankMemories([makeNode({ id: 'ancient', confidence: 1, relevanceScore: 1, updated_at: '2000-01-01T00:00:00.000Z' })]);
      expect(ancient[0].score).toBeCloseTo(0.95, 5);
    } finally {
      if (prev === undefined) delete process.env.MEMBERRY_MEMORY_RANK_V2; else process.env.MEMBERRY_MEMORY_RANK_V2 = prev;
    }
  });

  it('rankNormalizeRelevance is identity without the flag and rank-linear 1.0..0.5 with it', () => {
    const hits = [{ id: 'a', score: 0.815 }, { id: 'b', score: 0.809 }, { id: 'c', score: 0.79 }];
    const prev = process.env.MEMBERRY_MEMORY_RANK_V2;
    delete process.env.MEMBERRY_MEMORY_RANK_V2;
    try {
      expect(rankNormalizeRelevance(hits)).toBe(hits);
      process.env.MEMBERRY_MEMORY_RANK_V2 = '1';
      expect(rankNormalizeRelevance(hits).map((h) => h.score)).toEqual([1, 0.75, 0.5]);
      expect(rankNormalizeRelevance([hits[0]]).map((h) => h.score)).toEqual([1]);
      expect(rankNormalizeRelevance([])).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.MEMBERRY_MEMORY_RANK_V2; else process.env.MEMBERRY_MEMORY_RANK_V2 = prev;
    }
  });

  it('taskIdentifiers keeps packet ids, decision numbers and SHAs, lowercased and unique', () => {
    expect(taskIdentifiers('Resume after RET-005A closure commit ff64db6f and Decision 66; RET-005A again, MEM-001D2, LAB-011'))
      .toEqual(['ret-005a', 'ff64db6f', 'mem-001d2', 'lab-011']);
    expect(taskIdentifiers('what changed in retrieval')).toEqual([]);
  });

  it('boostByIdentifierOverlap is identity without the flag and adds the matched share with it', () => {
    const nodes = [
      { id: 'hit-all', content: 'RET-005A closed at ff64db6f', relevanceScore: 0.6 },
      { id: 'hit-half', content: 'ret-005a only' },
      { id: 'miss', content: 'nothing relevant', relevanceScore: 0.9 },
    ];
    const prev = process.env.MEMBERRY_MEMORY_LEXICAL_V1;
    delete process.env.MEMBERRY_MEMORY_LEXICAL_V1;
    try {
      expect(boostByIdentifierOverlap('RET-005A ff64db6f', nodes)).toBe(nodes);
      process.env.MEMBERRY_MEMORY_LEXICAL_V1 = '1';
      const boosted = boostByIdentifierOverlap('RET-005A ff64db6f', nodes);
      expect(boosted.map((n) => n.relevanceScore)).toEqual([1.6, 1.0, 0.9]);
      expect(boostByIdentifierOverlap('no identifiers here', nodes)).toBe(nodes);
    } finally {
      if (prev === undefined) delete process.env.MEMBERRY_MEMORY_LEXICAL_V1; else process.env.MEMBERRY_MEMORY_LEXICAL_V1 = prev;
    }
  });

  it('returns empty array for empty input', () => {
    expect(rankMemories([], new Date())).toEqual([]);
  });
});

describe('budgetTokens', () => {
  it('takes items in order until budget is exceeded', () => {
    const items = [
      { tokens: 100, label: 'a' },
      { tokens: 200, label: 'b' },
      { tokens: 300, label: 'c' },
    ];

    const result = budgetTokens(items, 350);

    expect(result).toHaveLength(2);
    expect(result[0].label).toBe('a');
    expect(result[1].label).toBe('b');
  });

  it('includes all items when budget is large enough', () => {
    const items = [{ tokens: 50 }, { tokens: 50 }, { tokens: 50 }];
    const result = budgetTokens(items, 200);
    expect(result).toHaveLength(3);
  });

  it('zero budget returns empty array', () => {
    const items = [{ tokens: 10 }, { tokens: 20 }];
    expect(budgetTokens(items, 0)).toEqual([]);
  });

  it('negative budget returns empty array', () => {
    const items = [{ tokens: 10 }];
    expect(budgetTokens(items, -5)).toEqual([]);
  });

  it('stops before an item that would exceed budget', () => {
    const items = [{ tokens: 100 }, { tokens: 100 }, { tokens: 100 }];
    // budget = 150 → takes first (100), second would push total to 200 > 150, stops
    const result = budgetTokens(items, 150);
    expect(result).toHaveLength(1);
    expect(result[0].tokens).toBe(100);
  });

  it('returns empty array when first item already exceeds budget', () => {
    const items = [{ tokens: 500 }];
    expect(budgetTokens(items, 100)).toEqual([]);
  });

  it('skips oversized items and continues filling the remaining budget', () => {
    const items = [
      { tokens: 500, label: 'oversized' },
      { tokens: 40, label: 'first-fit' },
      { tokens: 70, label: 'too-large-after-first-fit' },
      { tokens: 30, label: 'second-fit' },
    ];

    const result = budgetTokens(items, 100);

    expect(result.map((item) => item.label)).toEqual(['first-fit', 'second-fit']);
  });
});

describe('estimateTokens', () => {
  it('returns ceil(length / 4)', () => {
    expect(estimateTokens('abcd')).toBe(1); // 4/4 = 1
    expect(estimateTokens('abcde')).toBe(2); // ceil(5/4) = 2
    expect(estimateTokens('')).toBe(0); // ceil(0/4) = 0
    expect(estimateTokens('a')).toBe(1); // ceil(1/4) = 1
  });

  it('handles longer strings', () => {
    const text = 'a'.repeat(100);
    expect(estimateTokens(text)).toBe(25); // 100/4 = 25
  });
});
