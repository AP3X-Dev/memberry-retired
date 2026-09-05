// packages/neo4j/src/fact.ts
import neo4j, { Record as Neo4jRecord, type Driver } from 'neo4j-driver';
import { isProxy } from 'node:util/types';
import { nanoid } from 'nanoid';
import type { FactNode, FactTimeline, FactDiff, TemporalOptions } from '@memberry/core';
import { EntityResolver } from './entity-resolver.js';
import { temporalSetClause } from './temporal-edges.js';
import { tenantWhere, resolveTenant, TENANT_PARAM } from './tenant.js';

export class FactStore {
  private resolver: EntityResolver;

  constructor(private driver: Driver) {
    this.resolver = new EntityResolver(driver);
  }

  async create(fact: FactNode): Promise<string> {
    const session = this.driver.session();
    const tx = session.beginTransaction();
    try {
      // Resolve subject to canonical entity WITHIN the transaction
      // so entity creation/alias mutation is atomic with fact creation
      const resolved = await this.resolver.resolve(fact.subject, 'concept', tx);

      // Create the Fact node with entity_id for canonical lookup
      await tx.run(
        `CREATE (f:Fact {
          id: $id,
          subject: $subject,
          predicate: $predicate,
          object: $object,
          entity_id: $entity_id,
          source_episode_ids: $source_episode_ids,
          valid_at: $valid_at,
          invalid_at: $invalid_at,
          confidence: $confidence,
          status: $status,
          inference_type: $inference_type,
          supersedes_fact_id: $supersedes_fact_id,
          scope: $scope,
          tags: $tags,
          tenant_id: $tenant_id,
          created_at: $created_at,
          updated_at: $updated_at
        })`,
        {
          id: fact.id,
          subject: fact.subject,
          predicate: fact.predicate,
          object: fact.object,
          entity_id: resolved.id,
          source_episode_ids: fact.source_episode_ids,
          valid_at: fact.valid_at,
          invalid_at: fact.invalid_at,
          confidence: fact.confidence,
          status: fact.status,
          inference_type: fact.inference_type ?? 'deductive',
          supersedes_fact_id: fact.supersedes_fact_id,
          scope: fact.scope,
          tags: fact.tags,
          tenant_id: resolveTenant(fact.tenant_id),
          created_at: fact.created_at,
          updated_at: fact.updated_at,
        },
      );

      // Link SOURCED_FROM → Episodic for each source episode. OPT-43: one batched
      // UNWIND MERGE instead of a MERGE round-trip per episode. Graph-identical —
      // each episodeId still does MATCH (f),(e:Episodic{id}) + MERGE the edge, so
      // a missing Episodic is skipped exactly as the per-row loop skipped it.
      if (fact.source_episode_ids.length > 0) {
        await tx.run(
          `UNWIND $episodeIds AS episodeId
           MATCH (f:Fact {id: $factId}), (e:Episodic {id: episodeId})
           MERGE (f)-[:SOURCED_FROM]->(e)`,
          { factId: fact.id, episodeIds: fact.source_episode_ids },
        );
      }

      // Link FACT_ABOUT → canonical Entity (resolved by EntityResolver)
      await tx.run(
        `MATCH (f:Fact {id: $factId}), (e:Entity {id: $entityId})
         MERGE (f)-[r:FACT_ABOUT]->(e)
         ${temporalSetClause('r')}`,
        { factId: fact.id, entityId: resolved.id, now: new Date().toISOString() },
      );

      // Set embedding if provided
      if (fact.embedding) {
        await tx.run(
          `MATCH (f:Fact {id: $id}) SET f.embedding = $embedding`,
          { id: fact.id, embedding: fact.embedding },
        );
      }

      // Link SUPERSEDES → old Fact if supersedes_fact_id is set
      if (fact.supersedes_fact_id) {
        await tx.run(
          `MATCH (newF:Fact {id: $newId}), (oldF:Fact {id: $oldId})
           MERGE (newF)-[:SUPERSEDES_FACT]->(oldF)`,
          { newId: fact.id, oldId: fact.supersedes_fact_id },
        );
      }

      await tx.commit();
      return fact.id;
    } catch (err) {
      await tx.rollback();
      throw err;
    } finally {
      await session.close();
    }
  }

  async getById(id: string): Promise<FactNode | null> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        'MATCH (f:Fact {id: $id}) RETURN f',
        { id },
      );
      if (result.records.length === 0) return null;
      return mapFactNode(result.records[0].get('f').properties);
    } finally {
      await session.close();
    }
  }

  async getActive(entityName: string, options?: TemporalOptions, tenantId?: string): Promise<FactNode[]> {
    // Resolve entityName to canonical ID via EntityResolver (handles
    // exact match, case-insensitive, and alias matching)
    const resolved = await this.resolver.resolveExisting(entityName);
    if (!resolved) return []; // No known entity → no facts

    const session = this.driver.session();
    try {
      const timeMode = options?.time_mode ?? 'current';
      const tenant = resolveTenant(tenantId);
      const tFilter = tenantWhere('f', tenant); // tenant isolation
      let cypher: string;
      const params: Record<string, unknown> = { entityId: resolved.id, [TENANT_PARAM]: tenant };

      switch (timeMode) {
        case 'current':
          cypher = `
            MATCH (f:Fact) WHERE f.entity_id = $entityId
              AND f.status = 'active' AND f.invalid_at IS NULL
              AND ${tFilter}
            RETURN f ORDER BY f.valid_at DESC`;
          break;

        case 'historical':
          params.as_of = options?.as_of ?? new Date().toISOString();
          cypher = `
            MATCH (f:Fact) WHERE f.entity_id = $entityId
              AND f.valid_at <= $as_of AND (f.invalid_at IS NULL OR f.invalid_at > $as_of)
              AND ${tFilter}
            RETURN f ORDER BY f.valid_at DESC`;
          break;

        case 'interval':
          params.from = options?.from ?? '1970-01-01T00:00:00.000Z';
          params.to = options?.to ?? new Date().toISOString();
          cypher = `
            MATCH (f:Fact) WHERE f.entity_id = $entityId
              AND f.valid_at <= $to AND (f.invalid_at IS NULL OR f.invalid_at > $from)
              AND ${tFilter}
            RETURN f ORDER BY f.valid_at DESC`;
          break;

        case 'evolution':
          if (options?.include_invalidated) {
            cypher = `
              MATCH (f:Fact) WHERE f.entity_id = $entityId
                AND ${tFilter}
              RETURN f ORDER BY f.valid_at ASC`;
          } else {
            cypher = `
              MATCH (f:Fact) WHERE f.entity_id = $entityId
                AND f.status <> 'invalidated'
                AND ${tFilter}
              RETURN f ORDER BY f.valid_at ASC`;
          }
          break;

        default: {
          const _exhaustive: never = timeMode;
          throw new Error(`Unknown time_mode: ${String(_exhaustive)}`);
        }
      }

      const result = await session.run(cypher, params);
      return result.records.map((r) => mapFactNode(r.get('f').properties));
    } finally {
      await session.close();
    }
  }

  /**
   * OPT-41: batched getActive for many entity names. Resolution stays per-entity
   * (unchanged precedence semantics), but ALL resolved entities' active facts are
   * fetched in ONE round-trip (UNWIND distinct ids → per-id ordered collect)
   * instead of one fact query per entity — collapsing the load() hot path from
   * O(2N) round-trips to O(N resolves + 1 fetch). Returns one FactNode[] per
   * input name, in input order, each IDENTICAL to getActive(name, options,
   * tenantId): same per-mode filter, same `ORDER BY f.valid_at`. Callers that
   * dedup+rank the union are therefore output-identical. (Batching the resolve
   * too would mean replicating EntityResolver precedence in one query — deferred.)
   */
  async getActiveBatch(
    entityNames: string[],
    options?: TemporalOptions,
    tenantId?: string,
  ): Promise<FactNode[][]> {
    if (entityNames.length === 0) return [];
    const resolved = await Promise.all(entityNames.map((n) => this.resolver.resolveExisting(n)));
    const ids = resolved.map((r) => (r ? r.id : null));
    const distinct = [...new Set(ids.filter((x): x is string => x !== null))];
    if (distinct.length === 0) return entityNames.map(() => []);

    const timeMode = options?.time_mode ?? 'current';
    const tenant = resolveTenant(tenantId);
    const tFilter = tenantWhere('f', tenant);
    const params: Record<string, unknown> = { ids: distinct, [TENANT_PARAM]: tenant };

    // Mirror getActive's per-mode filter + sort EXACTLY (see the switch above).
    let factFilter: string;
    let order: 'ASC' | 'DESC';
    switch (timeMode) {
      case 'current':
        factFilter = `f.status = 'active' AND f.invalid_at IS NULL`;
        order = 'DESC';
        break;
      case 'historical':
        params.as_of = options?.as_of ?? new Date().toISOString();
        factFilter = `f.valid_at <= $as_of AND (f.invalid_at IS NULL OR f.invalid_at > $as_of)`;
        order = 'DESC';
        break;
      case 'interval':
        params.from = options?.from ?? '1970-01-01T00:00:00.000Z';
        params.to = options?.to ?? new Date().toISOString();
        factFilter = `f.valid_at <= $to AND (f.invalid_at IS NULL OR f.invalid_at > $from)`;
        order = 'DESC';
        break;
      case 'evolution':
        factFilter = options?.include_invalidated ? 'true' : `f.status <> 'invalidated'`;
        order = 'ASC';
        break;
      default: {
        const _exhaustive: never = timeMode;
        throw new Error(`Unknown time_mode: ${String(_exhaustive)}`);
      }
    }

    const session = this.driver.session();
    try {
      // OPTIONAL MATCH + collect inside the per-id subquery so an id with no
      // matching facts still yields a row (→ [] for that position) rather than
      // being eliminated; $ids is distinct so there is no aggregation-merge.
      const cypher = `
        UNWIND $ids AS eid
        CALL {
          WITH eid
          OPTIONAL MATCH (f:Fact) WHERE f.entity_id = eid AND ${factFilter} AND ${tFilter}
          WITH f ORDER BY f.valid_at ${order}
          RETURN collect(f) AS facts
        }
        RETURN eid, facts`;
      const result = await session.run(cypher, params);
      const byId = new Map<string, FactNode[]>();
      for (const rec of result.records) {
        const eid = rec.get('eid') as string;
        const nodes = rec.get('facts') as Array<{ properties: Record<string, unknown> }>;
        byId.set(eid, nodes.map((n) => mapFactNode(n.properties)));
      }
      // Map back to input order (duplicate names share their resolved id's facts).
      return ids.map((id) => (id ? (byId.get(id) ?? []) : []));
    } finally {
      await session.close();
    }
  }

  /**
   * @internal RET-002C bounded stable-ID path. This deliberately never touches
   * EntityResolver: a missing/invalid ID is an empty result, never a name query.
   */
  async getActiveByEntityIdsBatch(
    entityIds: string[],
    options?: TemporalOptions,
    tenantId?: string,
  ): Promise<FactNode[][]> {
    const ids = normalizeEntityIds(entityIds);
    if (ids.length === 0) return [];
    const timeMode = options?.time_mode ?? 'current';
    const tenant = resolveTenant(tenantId);
    const tFilter = tenantWhere('f', tenant);
    const params: Record<string, unknown> = { ids, [TENANT_PARAM]: tenant };
    let factFilter: string;
    let order: 'ASC' | 'DESC';
    switch (timeMode) {
      case 'current':
        factFilter = `f.status = 'active' AND f.invalid_at IS NULL`;
        order = 'DESC';
        break;
      case 'historical':
        params.as_of = options?.as_of ?? new Date().toISOString();
        factFilter = `f.valid_at <= $as_of AND (f.invalid_at IS NULL OR f.invalid_at > $as_of)`;
        order = 'DESC';
        break;
      case 'interval':
        params.from = options?.from ?? '1970-01-01T00:00:00.000Z';
        params.to = options?.to ?? new Date().toISOString();
        factFilter = `f.valid_at <= $to AND (f.invalid_at IS NULL OR f.invalid_at > $from)`;
        order = 'DESC';
        break;
      case 'evolution':
        factFilter = options?.include_invalidated ? 'true' : `f.status <> 'invalidated'`;
        order = 'ASC';
        break;
      default: {
        const _exhaustive: never = timeMode;
        throw new Error(`Unknown time_mode: ${String(_exhaustive)}`);
      }
    }
    const session = this.driver.session();
    let primaryError: unknown;
    try {
      const result = await withFactBatchDeadline(session.run(
        `UNWIND $ids AS eid
         WITH eid, head([ordinal IN range(0, size($ids) - 1) WHERE $ids[ordinal] = eid]) AS ordinal
         CALL {
           WITH eid
           OPTIONAL MATCH (f:Fact) WHERE f.entity_id = eid AND ${factFilter} AND ${tFilter}
           WITH f ORDER BY f.valid_at ${order}, f.id ASC
           LIMIT $perIdFetch
           RETURN collect(f) AS facts
         }
         WITH ordinal, eid, facts
         ORDER BY ordinal
         RETURN toString(ordinal) AS ordinal, eid, facts`,
        // Bound the query at the cap so an over-documented entity yields its top facts instead of
        // failing the whole batch. FACTS_PER_ENTITY_FETCH remains only as the parse-side tolerance
        // that turns a provider returning more than requested into fact_id_batch_overflow.
        { ...params, perIdFetch: neo4j.int(FACTS_PER_ENTITY_LIMIT) },
        { timeout: FACT_ID_BATCH_SERVER_TIMEOUT_MS },
      ));
      const records = snapshotFactBatchRecords(result);
      if (records.length !== ids.length) {
        throw new Error('fact_id_batch_invalid');
      }
      const output: FactNode[][] = [];
      const budget = createFactParseBudget();
      for (let index = 0; index < ids.length; index += 1) {
        const [ordinalValue, eid, nodesValue] = records[index];
        const ordinal = readBatchOrdinal(ordinalValue);
        if (ordinal !== index || eid !== ids[index]) {
          throw new Error('fact_id_batch_invalid');
        }
        const nodes = snapshotDenseDataArray(nodesValue, FACTS_PER_ENTITY_FETCH);
        if (nodes.length > FACTS_PER_ENTITY_LIMIT) {
          throw new Error('fact_id_batch_overflow');
        }
        const facts: FactNode[] = [];
        let previousFactOrder: { validAt: string; id: string } | undefined;
        for (const node of nodes) {
          if (node === null || typeof node !== 'object' || isProxy(node)) {
            throw new Error('fact_id_batch_invalid');
          }
          let properties: Record<string, unknown>;
          try {
            properties = snapshotFactProperties(node);
          } catch {
            throw new Error('fact_id_batch_invalid_record');
          }
          if (typeof properties.entity_id !== 'string' || properties.entity_id !== eid
            || !SAFE_ENTITY_ID.test(properties.entity_id)) {
            throw new Error('fact_id_batch_invalid_record');
          }
          const factTenant = properties.tenant_id;
          if (tenant === 'default'
            ? factTenant !== undefined && factTenant !== 'default'
            : factTenant !== tenant) {
            throw new Error('fact_id_batch_invalid_record');
          }
          validateFactStableProperties(properties, budget);
          const currentOrder = { validAt: properties.valid_at as string, id: properties.id as string };
          if (previousFactOrder && !factOrderFollows(previousFactOrder, currentOrder, order)) {
            throw new Error('fact_id_batch_invalid_record');
          }
          previousFactOrder = currentOrder;
          facts.push(mapFactNode(properties));
        }
        output.push(facts);
      }
      return output;
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try {
        await closeFactBatchSession(session);
      } catch (closeError) {
        if (primaryError === undefined) throw closeError;
      }
    }
  }

  async invalidate(id: string, invalidAt: string, supersededById?: string): Promise<void> {
    const session = this.driver.session();
    try {
      const now = new Date().toISOString();
      await session.run(
        `MATCH (f:Fact {id: $id})
         SET f.status = 'invalidated', f.invalid_at = $invalidAt, f.updated_at = $now`,
        { id, invalidAt, now },
      );

      if (supersededById) {
        await session.run(
          `MATCH (newF:Fact {id: $newId}), (oldF:Fact {id: $oldId})
           MERGE (newF)-[:SUPERSEDES_FACT]->(oldF)`,
          { newId: supersededById, oldId: id },
        );
      }
    } finally {
      await session.close();
    }
  }

  async dispute(id: string): Promise<void> {
    const session = this.driver.session();
    try {
      const now = new Date().toISOString();
      await session.run(
        `MATCH (f:Fact {id: $id})
         SET f.status = 'disputed', f.updated_at = $now`,
        { id, now },
      );
    } finally {
      await session.close();
    }
  }

  async timeline(entityName: string, tenantId?: string): Promise<FactTimeline> {
    const resolved = await this.resolver.resolveExisting(entityName);
    if (!resolved) return { entity: entityName, facts: [] };

    const session = this.driver.session();
    try {
      const tenant = resolveTenant(tenantId);
      const result = await session.run(
        `MATCH (f:Fact) WHERE f.entity_id = $entityId
           AND ${tenantWhere('f', tenant)}
         RETURN f ORDER BY f.valid_at ASC`,
        { entityId: resolved.id, [TENANT_PARAM]: tenant },
      );

      const facts = result.records.map((r) => {
        const fact = mapFactNode(r.get('f').properties);
        let event: 'created' | 'invalidated' | 'disputed' | 'superseded';
        let at: string;

        if (fact.status === 'invalidated') {
          event = fact.supersedes_fact_id ? 'superseded' : 'invalidated';
          at = fact.invalid_at ?? fact.updated_at;
        } else if (fact.status === 'disputed') {
          event = 'disputed';
          at = fact.updated_at;
        } else {
          event = 'created';
          at = fact.valid_at;
        }

        return { ...fact, event, at };
      });

      return { entity: entityName, facts };
    } finally {
      await session.close();
    }
  }

  async diff(entityName: string, from: string, to: string, tenantId?: string): Promise<FactDiff> {
    const resolved = await this.resolver.resolveExisting(entityName);
    if (!resolved) return { entity: entityName, from, to, added: [], invalidated: [], changed: [] };

    const session = this.driver.session();
    try {
      const tenant = resolveTenant(tenantId);
      const tFilter = tenantWhere('f', tenant);
      // Facts active at 'from' timestamp
      const fromResult = await session.run(
        `MATCH (f:Fact) WHERE f.entity_id = $entityId
           AND f.valid_at <= $from AND (f.invalid_at IS NULL OR f.invalid_at > $from)
           AND ${tFilter}
         RETURN f`,
        { entityId: resolved.id, from, [TENANT_PARAM]: tenant },
      );
      const fromFacts = fromResult.records.map((r) => mapFactNode(r.get('f').properties));

      // Facts active at 'to' timestamp
      const toResult = await session.run(
        `MATCH (f:Fact) WHERE f.entity_id = $entityId
           AND f.valid_at <= $to AND (f.invalid_at IS NULL OR f.invalid_at > $to)
           AND ${tFilter}
         RETURN f`,
        { entityId: resolved.id, to, [TENANT_PARAM]: tenant },
      );
      const toFacts = toResult.records.map((r) => mapFactNode(r.get('f').properties));

      const fromIds = new Set(fromFacts.map((f) => f.id));
      const toIds = new Set(toFacts.map((f) => f.id));

      // Added: in 'to' but not in 'from'
      const added = toFacts.filter((f) => !fromIds.has(f.id));

      // Invalidated: in 'from' but not in 'to'
      const invalidated = fromFacts.filter((f) => !toIds.has(f.id));

      // Changed: facts that supersede other facts — find pairs
      const changed: Array<{ before: FactNode; after: FactNode }> = [];
      for (const addedFact of added) {
        if (addedFact.supersedes_fact_id) {
          const beforeFact = invalidated.find((f) => f.id === addedFact.supersedes_fact_id);
          if (beforeFact) {
            changed.push({ before: beforeFact, after: addedFact });
          }
        }
      }

      // Remove changed items from added/invalidated to avoid double-counting
      const changedBeforeIds = new Set(changed.map((c) => c.before.id));
      const changedAfterIds = new Set(changed.map((c) => c.after.id));

      return {
        entity: entityName,
        from,
        to,
        added: added.filter((f) => !changedAfterIds.has(f.id)),
        invalidated: invalidated.filter((f) => !changedBeforeIds.has(f.id)),
        changed,
      };
    } finally {
      await session.close();
    }
  }

  async findBySubjectPredicate(
    subject: string,
    predicate: string,
    tenantId?: string,
    opts?: { includeTentative?: boolean },
  ): Promise<FactNode[]> {
    // Resolve subject to canonical entity_id first — same resolution
    // path as getActive/timeline/diff to avoid fragmentation
    const resolved = await this.resolver.resolveExisting(subject);
    if (!resolved) return []; // No known entity → no facts

    const session = this.driver.session();
    try {
      const tenant = resolveTenant(tenantId);
      // OPT-70: callers reconciling extraction-origin facts opt into seeing
      // `tentative` contenders so an unconfirmed fact can be corroborated and
      // promoted. Default = active-only — byte-identical for every existing
      // caller (e.g. consolidation). The status list is a bound parameter; no
      // caller-derived value is interpolated into the Cypher.
      const statuses = opts?.includeTentative ? ['active', 'tentative'] : ['active'];
      const result = await session.run(
        `MATCH (f:Fact)
         WHERE f.entity_id = $entityId
           AND toLower(f.predicate) = toLower($predicate)
           AND f.status IN $statuses
           AND ${tenantWhere('f', tenant)}
         RETURN f
         ORDER BY f.valid_at DESC`,
        { entityId: resolved.id, predicate, statuses, [TENANT_PARAM]: tenant },
      );
      return result.records.map((r) => mapFactNode(r.get('f').properties));
    } finally {
      await session.close();
    }
  }

  async setEmbedding(id: string, embedding: number[]): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run(
        `MATCH (f:Fact {id: $id}) SET f.embedding = $embedding`,
        { id, embedding },
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Link two facts that were co-extracted from the same episode.
   * Creates a bidirectional SAME_EPISODE edge (stored as undirected via single direction).
   */
  async linkCoExtracted(factId1: string, factId2: string, episodeId: string): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run(
        `MATCH (f1:Fact {id: $id1}), (f2:Fact {id: $id2})
         MERGE (f1)-[r:SAME_EPISODE]->(f2)
         SET r.episode_id = $episodeId, r.created_at = COALESCE(r.created_at, $now)`,
        { id1: factId1, id2: factId2, episodeId, now: new Date().toISOString() },
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Update the confidence score of a fact.
   * Used by staleness detection to decay confidence of unmentioned facts.
   */
  async updateConfidence(id: string, confidence: number): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run(
        'MATCH (f:Fact {id: $id}) SET f.confidence = $confidence, f.updated_at = $now',
        { id, confidence, now: new Date().toISOString() },
      );
    } finally {
      await session.close();
    }
  }

  /**
   * OPT-42: apply many confidence updates in ONE round-trip (UNWIND SET),
   * instead of one updateConfidence query per fact. End-state is identical to
   * calling updateConfidence for each {id, confidence} (same SET of confidence +
   * updated_at); all rows just share one updated_at timestamp. No-op on empty.
   */
  async updateConfidenceBatch(updates: Array<{ id: string; confidence: number }>): Promise<void> {
    if (updates.length === 0) return;
    const session = this.driver.session();
    try {
      await session.run(
        `UNWIND $updates AS u
         MATCH (f:Fact {id: u.id})
         SET f.confidence = u.confidence, f.updated_at = $now`,
        { updates, now: new Date().toISOString() },
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Promote a tentative fact that explicit evidence has now corroborated: mark it
   * active and raise its confidence. Used when a real episode yields the same
   * subject/predicate/object a prior tentative fact already claimed.
   *
   * `inferenceType` defaults to 'deductive', which is right for an abductive
   * hypothesis that explicit evidence has just confirmed. Pass the fact's own type
   * to PRESERVE it.
   *
   * Why that option exists: promoting and relabelling used to be one welded
   * operation. An inductive fact is a generalization, and rewriting it to deductive
   * would destroy that provenance — so rather than separate the two, inductive facts
   * were excluded from promotion entirely (`core/service.ts` promotable gate). The
   * result was that consolidation's own output could accumulate corroboration
   * forever and never become servable: measured 2026-08-28, every one of the 340
   * tentative facts holding two or more distinct source episodes was inductive,
   * while active facts stood at 152. Splitting the two lets a generalization be
   * confirmed as a generalization.
   */
  async corroborate(
    id: string,
    confidence: number,
    inferenceType: 'deductive' | 'inductive' | 'abductive' = 'deductive',
  ): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run(
        `MATCH (f:Fact {id: $id})
         SET f.status = 'active', f.inference_type = $inferenceType,
             f.confidence = $confidence, f.updated_at = $now`,
        { id, confidence, inferenceType, now: new Date().toISOString() },
      );
    } finally {
      await session.close();
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const SAFE_ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MAX_RESOLVED_ENTITY_IDS = 32;
const FACTS_PER_ENTITY_LIMIT = 64;
const FACTS_PER_ENTITY_FETCH = FACTS_PER_ENTITY_LIMIT + 1;
const FACT_ID_BATCH_SERVER_TIMEOUT_MS = 5_000;
const FACT_ID_BATCH_WALL_TIMEOUT_MS = 6_000;
const FACT_ID_BATCH_CLOSE_TIMEOUT_MS = 1_000;
const MAX_FACT_SOURCE_EPISODES = 256;
const MAX_FACT_TAGS = 256;
const MAX_FACT_EMBEDDING_DIMENSIONS = 8_192;
const MAX_FACT_PROPERTY_KEYS = 64;
const MAX_FACT_STRING_BYTES = 16_384;
const MAX_FACT_TOTAL_STRING_BYTES = 512 * 1024;
const MAX_FACT_TOTAL_VALUES = 32_768;
const FACT_PROPERTY_KEYS = Object.freeze([
  'id', 'subject', 'predicate', 'object', 'entity_id', 'source_episode_ids',
  'valid_at', 'invalid_at', 'confidence', 'status', 'inference_type',
  'supersedes_fact_id', 'scope', 'tags', 'created_at', 'updated_at',
  'tenant_id', 'embedding',
] as const);

async function withFactBatchDeadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('fact_id_batch_timeout')), FACT_ID_BATCH_WALL_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function closeFactBatchSession(session: { close: () => unknown }): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('fact_id_batch_close_failed')), FACT_ID_BATCH_CLOSE_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    await Promise.race([
      Promise.resolve().then(() => session.close()).catch(() => {
        throw new Error('fact_id_batch_close_failed');
      }),
      deadline,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function readBatchOrdinal(value: unknown): number {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) return -1;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : -1;
}

function snapshotFactBatchRecords(result: unknown): unknown[][] {
  if (result === null || typeof result !== 'object' || isProxy(result)) {
    throw new Error('fact_id_batch_invalid');
  }
  const recordsDescriptor = Object.getOwnPropertyDescriptor(result, 'records');
  if (!recordsDescriptor || !('value' in recordsDescriptor)) throw new Error('fact_id_batch_invalid');
  const records = snapshotDenseDataArray(recordsDescriptor.value, MAX_RESOLVED_ENTITY_IDS);
  const snapshots: unknown[][] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === null || typeof record !== 'object' || isProxy(record)
      || Object.getPrototypeOf(record) !== Neo4jRecord.prototype) {
      throw new Error('fact_id_batch_invalid');
    }
    const keysDescriptor = Object.getOwnPropertyDescriptor(record, 'keys');
    const lengthDescriptor = Object.getOwnPropertyDescriptor(record, 'length');
    const fieldsDescriptor = Object.getOwnPropertyDescriptor(record, '_fields');
    const lookupDescriptor = Object.getOwnPropertyDescriptor(record, '_fieldLookup');
    if (!keysDescriptor || !('value' in keysDescriptor)
      || !lengthDescriptor || !('value' in lengthDescriptor)
      || !fieldsDescriptor || !('value' in fieldsDescriptor)
      || !lookupDescriptor || !('value' in lookupDescriptor)) {
      throw new Error('fact_id_batch_invalid');
    }
    if (lengthDescriptor.value !== 3) throw new Error('fact_id_batch_invalid');
    const ownKeys = Reflect.ownKeys(record);
    if (ownKeys.length !== 4 || !['keys', 'length', '_fields', '_fieldLookup'].every((key) => ownKeys.includes(key))) {
      throw new Error('fact_id_batch_invalid');
    }
    const keys = snapshotDenseDataArray(keysDescriptor.value, 3);
    const fields = snapshotDenseDataArray(fieldsDescriptor.value, 3);
    const lookup = lookupDescriptor.value;
    if (lookup === null || typeof lookup !== 'object' || isProxy(lookup)
      || (Object.getPrototypeOf(lookup) !== Object.prototype && Object.getPrototypeOf(lookup) !== null)
      || !hasDataValue(lookup, 'ordinal', 0) || !hasDataValue(lookup, 'eid', 1) || !hasDataValue(lookup, 'facts', 2)
      || countEnumerableKeys(lookup, 3) !== 3
      || keys.length !== 3 || fields.length !== 3
      || keys[0] !== 'ordinal' || keys[1] !== 'eid' || keys[2] !== 'facts') {
      throw new Error('fact_id_batch_invalid');
    }
    snapshots.push(fields);
  }
  return snapshots;
}

function snapshotDenseDataArray(value: unknown, maxLength: number): unknown[] {
  if (isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error('fact_id_batch_invalid');
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined;
  if (!Number.isInteger(length) || length < 0 || length > maxLength) throw new Error('fact_id_batch_invalid');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || !keys.includes('length')) throw new Error('fact_id_batch_invalid');
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) throw new Error('fact_id_batch_invalid');
    snapshot.push(descriptor.value);
  }
  return snapshot;
}

function snapshotFactProperties(node: object): Record<string, unknown> {
  const descriptor = Object.getOwnPropertyDescriptor(node, 'properties');
  if (!descriptor || !('value' in descriptor) || descriptor.value === null
    || typeof descriptor.value !== 'object' || isProxy(descriptor.value)
    || (Object.getPrototypeOf(descriptor.value) !== Object.prototype && Object.getPrototypeOf(descriptor.value) !== null)) {
    throw new Error('fact_id_batch_invalid');
  }
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  if (countEnumerableKeys(descriptor.value, MAX_FACT_PROPERTY_KEYS) > MAX_FACT_PROPERTY_KEYS) {
    throw new Error('fact_id_batch_invalid');
  }
  for (const key of FACT_PROPERTY_KEYS) {
    const property = Object.getOwnPropertyDescriptor(descriptor.value, key);
    if (!property) continue;
    if (!('value' in property)) throw new Error('fact_id_batch_invalid');
    snapshot[key] = key === 'source_episode_ids'
      ? snapshotDenseDataArray(property.value, MAX_FACT_SOURCE_EPISODES)
      : key === 'tags'
        ? snapshotDenseDataArray(property.value, MAX_FACT_TAGS)
        : key === 'embedding'
          ? snapshotDenseDataArray(property.value, MAX_FACT_EMBEDDING_DIMENSIONS)
          : property.value;
  }
  return snapshot;
}

type FactParseBudget = { values: number; stringBytes: number };

function createFactParseBudget(): FactParseBudget {
  return { values: 0, stringBytes: 0 };
}

function consumeFactValue(budget: FactParseBudget, value: unknown): void {
  budget.values += 1;
  if (budget.values > MAX_FACT_TOTAL_VALUES) throw new Error('fact_id_batch_invalid_record');
  if (typeof value === 'string') {
    const remainingStringBytes = MAX_FACT_TOTAL_STRING_BYTES - budget.stringBytes;
    if (value.length > MAX_FACT_STRING_BYTES || value.length > remainingStringBytes) {
      throw new Error('fact_id_batch_invalid_record');
    }
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes > MAX_FACT_STRING_BYTES) throw new Error('fact_id_batch_invalid_record');
    budget.stringBytes += bytes;
    if (budget.stringBytes > MAX_FACT_TOTAL_STRING_BYTES) throw new Error('fact_id_batch_invalid_record');
  }
}

function validateFactStableProperties(properties: Record<string, unknown>, budget: FactParseBudget): void {
  if (typeof properties.id !== 'string' || properties.id.length === 0 || properties.id.length > 200
    || !SAFE_ENTITY_ID.test(properties.id)
    || typeof properties.valid_at !== 'string' || properties.valid_at.length === 0) {
    throw new Error('fact_id_batch_invalid_record');
  }
  for (const key of FACT_PROPERTY_KEYS) {
    const value = properties[key];
    if (value === undefined) continue;
    consumeFactValue(budget, value);
    if (key === 'source_episode_ids' || key === 'tags') {
      if (!Array.isArray(value)) throw new Error('fact_id_batch_invalid_record');
      for (const item of value) {
        if (typeof item !== 'string') throw new Error('fact_id_batch_invalid_record');
        consumeFactValue(budget, item);
      }
    } else if (key === 'embedding') {
      if (!Array.isArray(value)) throw new Error('fact_id_batch_invalid_record');
      for (const item of value) {
        if (typeof item !== 'number' || !Number.isFinite(item)) throw new Error('fact_id_batch_invalid_record');
        consumeFactValue(budget, item);
      }
    } else if (key === 'confidence') {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('fact_id_batch_invalid_record');
    } else if (key === 'invalid_at' || key === 'supersedes_fact_id') {
      if (value !== null && typeof value !== 'string') throw new Error('fact_id_batch_invalid_record');
    } else if (typeof value !== 'string') {
      throw new Error('fact_id_batch_invalid_record');
    }
  }
}

function factOrderFollows(
  previous: { validAt: string; id: string },
  current: { validAt: string; id: string },
  order: 'ASC' | 'DESC',
): boolean {
  const timeComparison = compareStableCodeUnits(current.validAt, previous.validAt);
  if (order === 'DESC' ? timeComparison > 0 : timeComparison < 0) return false;
  if (timeComparison === 0 && compareStableCodeUnits(current.id, previous.id) <= 0) return false;
  return true;
}

function compareStableCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasDataValue(object: object, key: string, expected: unknown): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return !!descriptor && 'value' in descriptor && descriptor.value === expected;
}

function countEnumerableKeys(object: object, cap: number): number {
  let count = 0;
  for (const _key in object) {
    count += 1;
    if (count > cap) return count;
  }
  return count;
}

function normalizeEntityIds(value: unknown): string[] {
  if (isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error('resolved_entity_ids_invalid');
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined;
  if (!Number.isInteger(length) || length < 0 || length > MAX_RESOLVED_ENTITY_IDS) throw new Error('resolved_entity_ids_invalid');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || !keys.includes('length')) throw new Error('resolved_entity_ids_invalid');
  const ids: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    if (!keys.includes(key)) throw new Error('resolved_entity_ids_invalid');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string') {
      throw new Error('resolved_entity_ids_invalid');
    }
    const id = descriptor.value;
    if (id.length === 0 || id.length > 200 || !SAFE_ENTITY_ID.test(id)) {
      throw new Error('resolved_entity_ids_invalid');
    }
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
  }
  return Object.freeze(ids) as string[];
}

function mapFactNode(props: Record<string, unknown>): FactNode {
  const now = new Date().toISOString();
  return {
    id: typeof props.id === 'string' ? props.id : '',
    subject: typeof props.subject === 'string' ? props.subject : '',
    predicate: typeof props.predicate === 'string' ? props.predicate : '',
    object: typeof props.object === 'string' ? props.object : '',
    entity_id: typeof props.entity_id === 'string' ? props.entity_id : null,
    source_episode_ids: Array.isArray(props.source_episode_ids) ? (props.source_episode_ids as string[]) : [],
    valid_at: typeof props.valid_at === 'string' ? props.valid_at : now,
    invalid_at: typeof props.invalid_at === 'string' ? props.invalid_at : null,
    confidence: typeof props.confidence === 'number' ? props.confidence : 0.5,
    status: typeof props.status === 'string' ? (props.status as FactNode['status']) : 'tentative',
    inference_type: typeof props.inference_type === 'string' ? (props.inference_type as FactNode['inference_type']) : 'deductive',
    supersedes_fact_id: typeof props.supersedes_fact_id === 'string' ? props.supersedes_fact_id : null,
    scope: typeof props.scope === 'string' ? (props.scope as FactNode['scope']) : 'project',
    tags: Array.isArray(props.tags) ? (props.tags as string[]) : [],
    created_at: typeof props.created_at === 'string' ? props.created_at : now,
    updated_at: typeof props.updated_at === 'string' ? props.updated_at : now,
    ...(typeof props.tenant_id === 'string' && { tenant_id: props.tenant_id }),
    ...(props.embedding != null && Array.isArray(props.embedding) && { embedding: props.embedding as number[] }),
  };
}
