// packages/retrieval/src/__tests__/feedback.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeedbackTracker, type FeedbackRedisLayer } from '../feedback.js';
import type { FeedbackSignal, SourceType } from '../types.js';

// ─── Mock Redis layer ────────────────────────────────────────────────────────

function createMockRedis(): FeedbackRedisLayer {
  return {
    zincrby: vi.fn().mockResolvedValue(1),
    zrevrangeWithScores: vi.fn().mockResolvedValue([]),
    lpush: vi.fn().mockResolvedValue(1),
    ltrim: vi.fn().mockResolvedValue(undefined),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('FeedbackTracker', () => {
  let redis: ReturnType<typeof createMockRedis>;
  let tracker: FeedbackTracker;

  beforeEach(() => {
    redis = createMockRedis();
    tracker = new FeedbackTracker(redis);
  });

  describe('recordFeedback', () => {
    it('increments entity boosts by +1 for positive feedback', async () => {
      const signal: FeedbackSignal = {
        query: 'AuthService login flow',
        result_id: 'sem-123',
        source_type: 'semantic',
        was_useful: true,
        session_id: 'sess-1',
        timestamp: '2025-01-01T00:00:00Z',
      };

      await tracker.recordFeedback(signal);

      // "AuthService" is extracted as a capitalized word entity name
      const zincrCalls = (redis.zincrby as ReturnType<typeof vi.fn>).mock.calls;
      // Should have entity boost calls + source type boost call
      const entityBoostCalls = zincrCalls.filter(
        (c: unknown[]) => c[0] === 'amp:feedback:entity_boost',
      );
      expect(entityBoostCalls.length).toBeGreaterThan(0);
      // All entity increments should be +1 for positive feedback
      for (const call of entityBoostCalls) {
        expect(call[1]).toBe(1);
      }
    });

    it('decrements entity boosts by -0.5 for negative feedback', async () => {
      const signal: FeedbackSignal = {
        query: 'AuthService',
        result_id: 'sem-456',
        source_type: 'semantic',
        was_useful: false,
        session_id: 'sess-1',
        timestamp: '2025-01-01T00:00:00Z',
      };

      await tracker.recordFeedback(signal);

      const zincrCalls = (redis.zincrby as ReturnType<typeof vi.fn>).mock.calls;
      const entityBoostCalls = zincrCalls.filter(
        (c: unknown[]) => c[0] === 'amp:feedback:entity_boost',
      );
      for (const call of entityBoostCalls) {
        expect(call[1]).toBe(-0.5);
      }
    });

    it('boosts source type in sorted set', async () => {
      const signal: FeedbackSignal = {
        query: 'test query',
        result_id: 'sym-1',
        source_type: 'symbol',
        was_useful: true,
        session_id: 'sess-1',
        timestamp: '2025-01-01T00:00:00Z',
      };

      await tracker.recordFeedback(signal);

      const zincrCalls = (redis.zincrby as ReturnType<typeof vi.fn>).mock.calls;
      const sourceBoostCall = zincrCalls.find(
        (c: unknown[]) => c[0] === 'amp:feedback:source_boost',
      );
      expect(sourceBoostCall).toBeDefined();
      expect(sourceBoostCall![2]).toBe('symbol');
      expect(sourceBoostCall![1]).toBe(1);
    });

    it('logs feedback event and trims to max log size', async () => {
      const signal: FeedbackSignal = {
        query: 'test',
        result_id: 'id-1',
        source_type: 'semantic',
        was_useful: true,
        session_id: 'sess-1',
        timestamp: '2025-01-01T00:00:00Z',
      };

      await tracker.recordFeedback(signal);

      expect(redis.lpush).toHaveBeenCalledWith(
        'amp:feedback:log',
        JSON.stringify(signal),
      );
      expect(redis.ltrim).toHaveBeenCalledWith(
        'amp:feedback:log',
        0,
        9999, // MAX_LOG_SIZE - 1
      );
    });

    it('extracts multiple entity name patterns from query', async () => {
      const signal: FeedbackSignal = {
        query: 'AuthService uses user-store via snake_case_util',
        result_id: 'id-1',
        source_type: 'semantic',
        was_useful: true,
        session_id: 'sess-1',
        timestamp: '2025-01-01T00:00:00Z',
      };

      await tracker.recordFeedback(signal);

      const zincrCalls = (redis.zincrby as ReturnType<typeof vi.fn>).mock.calls;
      const entityMembers = zincrCalls
        .filter((c: unknown[]) => c[0] === 'amp:feedback:entity_boost')
        .map((c: unknown[]) => c[2]);

      // Should extract: AuthService (CamelCase), user-store (kebab), snake_case_util (snake)
      expect(entityMembers).toContain('AuthService');
      expect(entityMembers).toContain('user-store');
      expect(entityMembers).toContain('snake_case_util');
    });
  });

  describe('getBoosts', () => {
    it('returns normalized entity boosts in 0-1 range', async () => {
      (redis.zrevrangeWithScores as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([
          { member: 'AuthService', score: 10 },
          { member: 'UserStore', score: 5 },
          { member: 'Logger', score: 2 },
        ])
        .mockResolvedValueOnce([]); // source types

      const boosts = await tracker.getBoosts();

      expect(boosts.entity_boosts['AuthService']).toBe(1.0); // max / max
      expect(boosts.entity_boosts['UserStore']).toBe(0.5); // 5 / 10
      expect(boosts.entity_boosts['Logger']).toBe(0.2); // 2 / 10
    });

    it('excludes entities with non-positive scores', async () => {
      (redis.zrevrangeWithScores as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([
          { member: 'Good', score: 5 },
          { member: 'Bad', score: 0 },
          { member: 'Worse', score: -1 },
        ])
        .mockResolvedValueOnce([]);

      const boosts = await tracker.getBoosts();

      expect(boosts.entity_boosts['Good']).toBeDefined();
      expect(boosts.entity_boosts['Bad']).toBeUndefined();
      expect(boosts.entity_boosts['Worse']).toBeUndefined();
    });

    it('returns source type boosts capped at 0.5', async () => {
      (redis.zrevrangeWithScores as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([]) // entities
        .mockResolvedValueOnce([
          { member: 'semantic', score: 10 },
          { member: 'symbol', score: 5 },
        ]);

      const boosts = await tracker.getBoosts();

      expect(boosts.source_type_boosts.semantic).toBe(0.5); // capped at 0.5
      expect(boosts.source_type_boosts.symbol).toBe(0.25); // (5/10) * 0.5
    });

    it('returns zero boosts for all source types when no data', async () => {
      (redis.zrevrangeWithScores as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const boosts = await tracker.getBoosts();

      expect(boosts.source_type_boosts.semantic).toBe(0);
      expect(boosts.source_type_boosts.episodic).toBe(0);
      expect(boosts.source_type_boosts.symbol).toBe(0);
      expect(boosts.source_type_boosts.arch_entity).toBe(0);
      expect(boosts.source_type_boosts.aspect).toBe(0);
    });

    it('preserves the exact legacy five-key public boost object and Redis call shape', async () => {
      const boosts = await tracker.getBoosts();

      expect(boosts).toEqual({
        entity_boosts: {},
        source_type_boosts: {
          semantic: 0,
          episodic: 0,
          symbol: 0,
          arch_entity: 0,
          aspect: 0,
        },
      });
      expect(redis.zrevrangeWithScores).toHaveBeenCalledTimes(2);
      expect(redis.zrevrangeWithScores).toHaveBeenNthCalledWith(1, 'amp:feedback:entity_boost', 0, 49);
      expect(redis.zrevrangeWithScores).toHaveBeenNthCalledWith(2, 'amp:feedback:source_boost', 0, 10);
    });

    it('ignores unknown source types from Redis', async () => {
      (redis.zrevrangeWithScores as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { member: 'unknown_type', score: 10 },
          { member: 'semantic', score: 5 },
        ]);

      const boosts = await tracker.getBoosts();

      // unknown_type should not appear
      expect(boosts.source_type_boosts).not.toHaveProperty('unknown_type');
      expect(boosts.source_type_boosts.semantic).toBeGreaterThan(0);
    });
  });

  describe('tenant isolation', () => {
    // Stateful in-memory Redis keyed by the actual Redis key, so a write under
    // one tenant's key is only visible to a read of that same key. This is what
    // makes the cross-tenant test meaningful (the top-level mock is stateless).
    function createStatefulRedis(): FeedbackRedisLayer {
      const zsets = new Map<string, Map<string, number>>();
      const set = (key: string): Map<string, number> => {
        let m = zsets.get(key);
        if (!m) { m = new Map(); zsets.set(key, m); }
        return m;
      };
      return {
        zincrby: vi.fn(async (key: string, increment: number, member: string) => {
          const m = set(key);
          const next = (m.get(member) ?? 0) + increment;
          m.set(member, next);
          return next;
        }),
        zrevrangeWithScores: vi.fn(async (key: string, start: number, stop: number) => {
          const m = zsets.get(key);
          if (!m) return [];
          return [...m.entries()]
            .map(([member, score]) => ({ member, score }))
            .sort((a, b) => b.score - a.score)
            .slice(start, stop + 1);
        }),
        lpush: vi.fn().mockResolvedValue(1),
        ltrim: vi.fn().mockResolvedValue(undefined),
      };
    }

    function signal(query: string): FeedbackSignal {
      return {
        query,
        result_id: 'sem-1',
        source_type: 'semantic',
        was_useful: true,
        session_id: 'sess-1',
        timestamp: '2025-01-01T00:00:00Z',
      };
    }

    it('does not leak one tenant\'s boosts to another tenant', async () => {
      const sharedRedis = createStatefulRedis();
      const t = new FeedbackTracker(sharedRedis);

      // Tenant 'acme' records feedback that boosts the "AcmeSecret" entity.
      await t.recordFeedback(signal('AcmeSecret'), 'acme');

      // Tenant 'globex' must NOT see acme's boost (different key namespace).
      const globexBoosts = await t.getBoosts('globex');
      expect(globexBoosts.entity_boosts['AcmeSecret']).toBeUndefined();

      // The owning tenant 'acme' DOES see its own boost.
      const acmeBoosts = await t.getBoosts('acme');
      expect(acmeBoosts.entity_boosts['AcmeSecret']).toBe(1.0);
    });

    it('namespaces non-default tenant keys with the tenant segment', async () => {
      const redis = createStatefulRedis();
      const t = new FeedbackTracker(redis);

      await t.recordFeedback(signal('Widget'), 'acme');

      const keysWritten = (redis.zincrby as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0]);
      expect(keysWritten).toContain('amp:feedback:acme:entity_boost');
      expect(keysWritten).toContain('amp:feedback:acme:source_boost');
      // Must NOT touch the un-namespaced (default/global) keys.
      expect(keysWritten).not.toContain('amp:feedback:entity_boost');
      expect(keysWritten).not.toContain('amp:feedback:source_boost');
    });

    it('default tenant round-trips on the un-namespaced (legacy) keys', async () => {
      const redis = createStatefulRedis();
      const t = new FeedbackTracker(redis);

      // No tenant arg → default tenant → original keys (back-compat, no cold start).
      await t.recordFeedback(signal('LegacyEntity'));

      const entityKeys = (redis.zincrby as ReturnType<typeof vi.fn>).mock.calls
        .map((c: unknown[]) => c[0])
        .filter((k: string) => k.includes('entity_boost'));
      expect(entityKeys).toContain('amp:feedback:entity_boost');

      const boosts = await t.getBoosts();
      expect(boosts.entity_boosts['LegacyEntity']).toBe(1.0);

      // An explicit 'default' tenant resolves to the same legacy keys/data.
      const explicitDefault = await t.getBoosts('default');
      expect(explicitDefault.entity_boosts['LegacyEntity']).toBe(1.0);
    });
  });

  describe('inferUsage', () => {
    it('records positive feedback for result IDs found in store content', async () => {
      const resultIds = ['abcdef1234567890', 'xyz99887766554433'];
      const storeContent = 'Based on abcdef12 analysis, the auth system...';

      const count = await tracker.inferUsage(storeContent, resultIds, 'sess-1');

      expect(count).toBe(1); // Only first ID matched (short prefix)
      expect(redis.zincrby).toHaveBeenCalled();
    });

    it('matches full result IDs in content', async () => {
      const resultIds = ['exact-match-id-here'];
      const storeContent = 'Using exact-match-id-here for reference';

      const count = await tracker.inferUsage(storeContent, resultIds, 'sess-1');

      expect(count).toBe(1);
    });

    it('returns 0 when no result IDs match', async () => {
      const resultIds = ['no-match-at-all-abc'];
      const storeContent = 'Completely unrelated content';

      const count = await tracker.inferUsage(storeContent, resultIds, 'sess-1');

      expect(count).toBe(0);
      // Only the initial calls from beforeEach should exist
    });

    it('handles empty result IDs array', async () => {
      const count = await tracker.inferUsage('some content', [], 'sess-1');
      expect(count).toBe(0);
    });

    it('records feedback for multiple matching IDs', async () => {
      const resultIds = ['match1-abcdefgh', 'match2-ijklmnop'];
      const storeContent = 'Used match1-a and match2-i for analysis';

      const count = await tracker.inferUsage(storeContent, resultIds, 'sess-1');

      expect(count).toBe(2);
    });
  });
});
