// packages/retrieval/src/feedback.ts
// Usage feedback tracking — makes retrieval improve over time without ML.
// Tracks which results agents actually use, boosts those in future queries.

import type { FeedbackSignal, BoostFactors, SourceType } from './types.js';
import { resolveTenant, isDefaultTenant } from '@memberry/neo4j';

// ─── Redis interface (injected, not concrete) ─────────────────────────────────

export interface FeedbackRedisLayer {
  zincrby(key: string, increment: number, member: string): Promise<number>;
  zrevrangeWithScores(key: string, start: number, stop: number): Promise<Array<{ member: string; score: number }>>;
  lpush(key: string, value: string): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<void>;
}

// ─── Feedback tracker ────────────────────────────────────────────────────────

const FEEDBACK_PREFIX = 'amp:feedback';
const MAX_LOG_SIZE = 10000;

// Per-tenant key namespacing. Feedback boosts re-rank retrieval, so a shared
// (process-global) key set lets one tenant's feedback poison another tenant's
// rankings AND co-mingles tenant-private entity names in the shared boost set.
// The DEFAULT (single-tenant / legacy) tenant keeps the original un-namespaced
// keys so existing boost data is preserved with no cold start; every named
// tenant gets its own isolated `amp:feedback:<tenant>:*` namespace.
function entityBoostKey(tenant: string): string {
  return isDefaultTenant(tenant) ? `${FEEDBACK_PREFIX}:entity_boost` : `${FEEDBACK_PREFIX}:${tenant}:entity_boost`;
}
function sourceBoostKey(tenant: string): string {
  return isDefaultTenant(tenant) ? `${FEEDBACK_PREFIX}:source_boost` : `${FEEDBACK_PREFIX}:${tenant}:source_boost`;
}
function feedbackLogKey(tenant: string): string {
  return isDefaultTenant(tenant) ? `${FEEDBACK_PREFIX}:log` : `${FEEDBACK_PREFIX}:${tenant}:log`;
}

export class FeedbackTracker {
  constructor(private redis: FeedbackRedisLayer) {}

  /**
   * Record that a result was used (or ignored) by an agent.
   * Positive feedback boosts the entity and source type for future queries.
   * Writes are scoped to `tenantId` so one tenant's feedback never re-ranks
   * another tenant's retrieval (defaults to the DEFAULT tenant when absent).
   */
  async recordFeedback(signal: FeedbackSignal, tenantId?: string): Promise<void> {
    const tenant = resolveTenant(tenantId);
    const increment = signal.was_useful ? 1 : -0.5;

    // Boost the entities mentioned in the result
    const entityNames = extractEntityNames(signal.query);
    for (const entity of entityNames) {
      await this.redis.zincrby(entityBoostKey(tenant), increment, entity);
    }

    // Boost the source type
    await this.redis.zincrby(sourceBoostKey(tenant), increment, signal.source_type);

    // Log the feedback event
    await this.redis.lpush(feedbackLogKey(tenant), JSON.stringify(signal));
    await this.redis.ltrim(feedbackLogKey(tenant), 0, MAX_LOG_SIZE - 1);
  }

  /**
   * Get current boost factors for RRF fusion.
   * Returns normalized boosts (0.0–1.0 range) for entities and source types.
   * Reads are scoped to `tenantId` so boosts never cross tenant boundaries
   * (defaults to the DEFAULT tenant when absent).
   */
  async getBoosts(tenantId?: string): Promise<BoostFactors> {
    const tenant = resolveTenant(tenantId);

    // Top 50 entity boosts
    const entityScores = await this.redis.zrevrangeWithScores(entityBoostKey(tenant), 0, 49);
    const maxEntityScore = entityScores.length > 0 ? entityScores[0].score : 1;

    const entity_boosts: Record<string, number> = {};
    for (const { member, score } of entityScores) {
      if (score > 0) {
        entity_boosts[member] = Math.min(1.0, score / Math.max(maxEntityScore, 1));
      }
    }

    // Source type boosts
    const sourceScores = await this.redis.zrevrangeWithScores(sourceBoostKey(tenant), 0, 10);
    const maxSourceScore = sourceScores.length > 0 ? sourceScores[0].score : 1;

    const source_type_boosts: BoostFactors['source_type_boosts'] = {
      semantic: 0,
      episodic: 0,
      symbol: 0,
      arch_entity: 0,
      aspect: 0,
    };
    for (const { member, score } of sourceScores) {
      if (score > 0 && member in source_type_boosts) {
        source_type_boosts[member as Exclude<SourceType, 'fact'>] = Math.min(0.5, score / Math.max(maxSourceScore, 1) * 0.5);
      }
    }

    return { entity_boosts, source_type_boosts };
  }

  /**
   * Infer feedback from agent behavior: if a result_id appears in a subsequent
   * berry_store content, the agent used it.
   */
  async inferUsage(storeContent: string, recentResultIds: string[], sessionId: string, tenantId?: string): Promise<number> {
    let usageCount = 0;
    for (const resultId of recentResultIds) {
      // Simple heuristic: if the result ID or a key term from the result appears in store content
      const shortId = resultId.slice(0, 8);
      const wasUsed = storeContent.includes(shortId) || storeContent.includes(resultId);
      if (wasUsed) {
        await this.recordFeedback({
          query: '',
          result_id: resultId,
          source_type: 'semantic',
          was_useful: true,
          session_id: sessionId,
          timestamp: new Date().toISOString(),
        }, tenantId);
        usageCount++;
      }
    }
    return usageCount;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractEntityNames(text: string): string[] {
  // Extract potential entity names: capitalized words, kebab-case, snake_case identifiers
  const patterns = text.match(/[A-Z][a-zA-Z]+|[a-z]+(?:-[a-z]+)+|[a-z]+(?:_[a-z]+)+/g) ?? [];
  return [...new Set(patterns)].slice(0, 10);
}
