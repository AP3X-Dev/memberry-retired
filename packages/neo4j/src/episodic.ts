// packages/neo4j/src/episodic.ts
import { type Driver } from 'neo4j-driver';
import {
  DEFAULT_TENANT,
  type EpisodeIndexKeyNodeV1,
  type EpisodicNode,
  type Signal,
} from '@memberry/core';
import { temporalSetClause } from './temporal-edges.js';
import { archivedWhere } from './query.js';

export class EpisodicStore {
  constructor(private driver: Driver) {}

  /**
   * Shared CREATE query + params so create() and createWithLinks() (OPT-53) build
   * the Episodic node IDENTICALLY — single source of truth, no drift.
   * OPT-44: the conditional embedding SET keeps the property ABSENT when none is
   * given, so the persisted node matches the previous two-step (CREATE then SET) path.
   */
  private buildCreate(node: EpisodicNode): { query: string; params: Record<string, unknown> } {
    const query = `
      CREATE (e:Episodic {
        id: $id,
        session_id: $session_id,
        agent_id: $agent_id,
        task: $task,
        content: $content,
        outcome: $outcome,
        memory_type: $memory_type,
        created_at: $created_at,
        ttl: $ttl,
        scope: $scope,
        tags: $tags,
        tenant_id: $tenant_id
      })
      ${node.embedding ? 'SET e.embedding = $embedding' : ''}
      RETURN e.id AS id`;
    const params: Record<string, unknown> = {
      id: node.id,
      session_id: node.session_id,
      agent_id: node.agent_id,
      task: node.task,
      content: node.content,
      outcome: node.outcome ?? null,
      memory_type: node.memory_type ?? null,
      created_at: node.created_at,
      ttl: node.ttl ?? null,
      scope: node.scope ?? null,
      tags: node.tags ?? [],
      tenant_id: node.tenant_id ?? null,
      ...(node.embedding ? { embedding: node.embedding } : {}),
    };
    return { query, params };
  }

  async create(node: EpisodicNode): Promise<string> {
    const session = this.driver.session();
    try {
      const { query, params } = this.buildCreate(node);
      const result = await session.run(query, params);
      return result.records[0].get('id') as string;
    } finally {
      await session.close();
    }
  }

  /**
   * OPT-53: create the episode AND its structural graph edges (agent / entities /
   * model) in ONE managed write transaction, so a mid-failure can't leave a
   * partially-linked episode. The prior path did CREATE then fanned the links out
   * as SEPARATE un-transacted round-trips: a link failure orphaned the episode
   * with missing edges, and the caller's retry minted a fresh duplicate. Each
   * statement reuses the exact same Cypher as create()/linkTo* (so the resulting
   * graph is identical); the links are best-effort MATCH→MERGE (a missing
   * Agent/Entity/Model target is skipped, exactly as the per-edge methods do).
   * Signal links and their Redis side-effects stay OUT of this tx (Redis can't
   * share a Neo4j transaction) and remain a separate post-commit step.
   */
  async createWithLinks(
    node: EpisodicNode,
    links: { agentId?: string; entityIds?: string[]; modelId?: string },
    indexKeys?: readonly EpisodeIndexKeyNodeV1[],
  ): Promise<string> {
    const session = this.driver.session();
    try {
      return await session.executeWrite(async (tx) => {
        if (indexKeys && indexKeys.length > 0) {
          if (!node.scope || !/^project:[a-z0-9][a-z0-9._-]*$/.test(node.scope)) {
            throw new Error('structured_index:canonical_project_scope_required');
          }
          const tenantId = node.tenant_id ?? DEFAULT_TENANT;
          const entityIds = [...new Set(links.entityIds ?? [])];
          if (entityIds.length > 0) {
            // Authorize every supplied Entity ID against exactly one path from
            // this tenant's project root before creating either the episode or
            // its derived keys. A foreign or ambiguous ID rejects atomically.
            const authorized = await tx.run(
              `UNWIND $entityIds AS entityId
               MATCH (root:Entity {type: 'project'})
               WHERE toLower(root.name) = substring($projectScope, 8)
                 AND (root.tenant_id = $tenantId OR (root.tenant_id IS NULL AND $tenantId = $defaultTenant))
               MATCH path = (root)-[:CONTAINS*0..64]->(entity:Entity {id: entityId})
               WHERE all(scopedNode IN nodes(path) WHERE
                 scopedNode.tenant_id IS NULL OR scopedNode.tenant_id = $tenantId)
               WITH entityId, count(DISTINCT path) AS pathCount
               WHERE pathCount = 1
               RETURN collect(entityId) AS ids`,
              { entityIds, projectScope: node.scope, tenantId, defaultTenant: DEFAULT_TENANT },
            );
            const ids = (authorized.records[0]?.get('ids') as string[] | undefined) ?? [];
            if (ids.length !== entityIds.length || entityIds.some((id) => !ids.includes(id))) {
              throw new Error('structured_index:entity_out_of_scope');
            }
          }
          for (const key of indexKeys) {
            if (key.episode_id !== node.id || key.tenant_id !== tenantId || key.project_scope !== node.scope
              || (key.entity_id !== undefined && !entityIds.includes(key.entity_id))) {
              throw new Error('structured_index:key_authority_mismatch');
            }
          }
        }

        const { query, params } = this.buildCreate(node);
        await tx.run(query, params);

        if (links.agentId) {
          await tx.run(
            `MATCH (e:Episodic {id: $episodicId}), (a:Agent {id: $agentId})
             MERGE (e)-[:GENERATED_BY]->(a)`,
            { episodicId: node.id, agentId: links.agentId },
          );
        }
        if (links.entityIds && links.entityIds.length > 0) {
          await tx.run(
            `MATCH (e:Episodic {id: $episodicId})
             UNWIND $entityIds AS entityId
             MATCH (ent:Entity {id: entityId})
             MERGE (e)-[r:REFERENCES]->(ent)
             ${temporalSetClause('r')}`,
            { episodicId: node.id, entityIds: links.entityIds, now: new Date().toISOString() },
          );
        }
        if (links.modelId) {
          await tx.run(
            `MATCH (e:Episodic {id: $episodicId}), (m:Model {id: $modelId})
             MERGE (e)-[:USED_MODEL]->(m)`,
            { episodicId: node.id, modelId: links.modelId },
          );
        }
        if (indexKeys && indexKeys.length > 0) {
          await tx.run(
            `UNWIND $indexKeys AS key
             MATCH (e:Episodic {id: $episodicId})
             CREATE (k:EpisodicIndexKey {
               id: key.id,
               episode_id: key.episode_id,
               kind: key.kind,
               value: key.value,
               entity_id: key.entity_id,
               embedding: key.embedding,
               schema_version: key.schema_version,
               source: key.source,
               source_hash: key.source_hash,
               tenant_id: key.tenant_id,
               project_scope: key.project_scope,
               created_at: key.created_at
             })
             MERGE (e)-[:HAS_INDEX_KEY]->(k)`,
            { episodicId: node.id, indexKeys },
          );
        }
        return node.id;
      });
    } finally {
      await session.close();
    }
  }

  /**
   * OPT-45: project tenant_id for many episodes in ONE query (UNWIND), instead
   * of one getById per id. Returns one entry per FOUND episode (its tenant_id,
   * or null when unset); a missing episode yields no row (omitted) — matching the
   * per-id derivation loop where a missing episode simply doesn't contribute.
   */
  async getTenantsByIds(ids: string[]): Promise<Array<string | null>> {
    if (ids.length === 0) return [];
    const session = this.driver.session();
    try {
      const result = await session.run(
        `UNWIND $ids AS id MATCH (e:Episodic {id: id}) RETURN e.tenant_id AS tenant`,
        { ids },
      );
      return result.records.map((r) => (r.get('tenant') as string | null) ?? null);
    } finally {
      await session.close();
    }
  }

  /**
   * Episodes eligible for consolidation into a Semantic node: in-scope, carrying
   * an embedding (so they can be clustered), OR explicitly approved decisions
   * (which need no synthesis vector), and not already the source of a promotion.
   * Approved decisions sort first so a large legacy recurrence backlog cannot
   * starve a newly authorized decision behind maxCandidates.
   *
   * This is the input side of the promote path. Before it existed, the
   * consolidation engine could only ever see Redis signals, so the entire
   * episodic->semantic promotion was unreachable regardless of how many
   * episodes were stored.
   */
  async findPromotable(
    scope: string | undefined,
    limit: number,
    tenantId?: string,
  ): Promise<EpisodicNode[]> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        `MATCH (e:Episodic)
         WHERE ($scope IS NULL OR e.scope = $scope)
           AND ($tenantId IS NULL OR coalesce(e.tenant_id, $tenantId) = $tenantId)
           AND ${archivedWhere('e')}
           AND (
             (e.memory_type = 'decision' AND e.outcome = 'approved')
             OR e.embedding IS NOT NULL
           )
           AND NOT EXISTS { MATCH (:Semantic)-[:PROMOTED_FROM]->(e) }
         RETURN e
         ORDER BY CASE
           WHEN e.memory_type = 'decision' AND e.outcome = 'approved' THEN 0
           WHEN e.memory_type IN ['pattern', 'convention'] THEN 1
           ELSE 2
         END ASC, e.created_at ASC, e.id ASC
         LIMIT toInteger($limit)`,
        { scope: scope ?? null, tenantId: tenantId ?? null, limit },
      );
      return result.records.map((r) =>
        this.mapEpisodic(r.get('e').properties as Record<string, unknown>),
      );
    } finally {
      await session.close();
    }
  }

  /**
   * MEM-005: keyset continuation window for the promotion fetch. Identical
   * eligibility, exclusion, and ordering to findPromotable, plus a keyset
   * predicate over the computed tier so a pass can resume strictly after the
   * position `after` instead of restarting from the head — the fix for the
   * head-of-order starvation findPromotable alone cannot avoid.
   */
  async findPromotableKeyset(
    scope: string | undefined,
    limit: number,
    tenantId: string | undefined,
    after: { classTier: number; createdAt: string; id: string },
  ): Promise<EpisodicNode[]> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        `MATCH (e:Episodic)
         WHERE ($scope IS NULL OR e.scope = $scope)
           AND ($tenantId IS NULL OR coalesce(e.tenant_id, $tenantId) = $tenantId)
           AND ${archivedWhere('e')}
           AND (
             (e.memory_type = 'decision' AND e.outcome = 'approved')
             OR e.embedding IS NOT NULL
           )
           AND NOT EXISTS { MATCH (:Semantic)-[:PROMOTED_FROM]->(e) }
         WITH e, CASE
           WHEN e.memory_type = 'decision' AND e.outcome = 'approved' THEN 0
           WHEN e.memory_type IN ['pattern', 'convention'] THEN 1
           ELSE 2
         END AS tier
         WHERE tier > $afterTier
            OR (tier = $afterTier AND e.created_at > $afterCreatedAt)
            OR (tier = $afterTier AND e.created_at = $afterCreatedAt AND e.id > $afterId)
         RETURN e
         ORDER BY tier ASC, e.created_at ASC, e.id ASC
         LIMIT toInteger($limit)`,
        {
          scope: scope ?? null,
          tenantId: tenantId ?? null,
          limit,
          afterTier: after.classTier,
          afterCreatedAt: after.createdAt,
          afterId: after.id,
        },
      );
      return result.records.map((r) =>
        this.mapEpisodic(r.get('e').properties as Record<string, unknown>),
      );
    } finally {
      await session.close();
    }
  }

  /** Shared Episodic mapping so getById and findPromotable build the node
   *  IDENTICALLY — single source of truth, no drift. */
  private mapEpisodic(props: Record<string, unknown>): EpisodicNode {
    return {
      id: props.id as string,
      session_id: props.session_id as string,
      agent_id: props.agent_id as string,
      task: props.task as string,
      content: props.content as string,
      outcome: (props.outcome as EpisodicNode['outcome']) ?? undefined,
      memory_type: (props.memory_type as EpisodicNode['memory_type']) ?? undefined,
      created_at: props.created_at as string,
      ttl: props.ttl != null ? (props.ttl as number) : undefined,
      embedding: props.embedding != null ? (props.embedding as number[]) : undefined,
      scope: props.scope != null ? (props.scope as string) : undefined,
      tags: props.tags != null ? (props.tags as string[]) : undefined,
      tenant_id: props.tenant_id != null ? (props.tenant_id as string) : undefined,
    };
  }

  async getById(id: string): Promise<EpisodicNode | null> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        `MATCH (e:Episodic {id: $id}) RETURN e`,
        { id },
      );

      if (result.records.length === 0) {
        return null;
      }

      return this.mapEpisodic(result.records[0].get('e').properties as Record<string, unknown>);
    } finally {
      await session.close();
    }
  }

  async linkToAgent(episodicId: string, agentId: string): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run(
        `MATCH (e:Episodic {id: $episodicId}), (a:Agent {id: $agentId})
         MERGE (e)-[:GENERATED_BY]->(a)`,
        { episodicId, agentId },
      );
    } finally {
      await session.close();
    }
  }

  async linkToEntity(episodicId: string, entityId: string): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run(
        `MATCH (e:Episodic {id: $episodicId}), (ent:Entity {id: $entityId})
         MERGE (e)-[r:REFERENCES]->(ent)
         ${temporalSetClause('r')}`,
        { episodicId, entityId, now: new Date().toISOString() },
      );
    } finally {
      await session.close();
    }
  }

  async linkToModel(episodicId: string, modelId: string): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run(
        `MATCH (e:Episodic {id: $episodicId}), (m:Model {id: $modelId})
         MERGE (e)-[:USED_MODEL]->(m)`,
        { episodicId, modelId },
      );
    } finally {
      await session.close();
    }
  }

  async linkSignal(episodicId: string, signal: Signal, tenantId: string = DEFAULT_TENANT): Promise<void> {
    const relTypeMap: Record<Signal['type'], string> = {
      reinforcement: 'REINFORCES',
      correction: 'CORRECTS',
      contradiction: 'CONTRADICTS',
    };
    const relType = relTypeMap[signal.type];
    if (!relType) {
      throw new Error(`Unrecognised signal type: ${String(signal.type)}`);
    }

    const session = this.driver.session();
    try {
      // Relationship types cannot be parameterized in Cypher, so build dynamically
      await session.run(
        `MATCH (e:Episodic {id: $episodicId}), (s:Semantic {id: $targetId})
         WHERE coalesce(e.tenant_id, $defaultTenant) = $tenantId
           AND coalesce(s.tenant_id, $defaultTenant) = $tenantId
         MERGE (e)-[r:${relType}]->(s)
         SET r.detail = $detail
         ${temporalSetClause('r')}`,
        {
          episodicId,
          targetId: signal.target_id,
          detail: signal.detail,
          tenantId,
          defaultTenant: DEFAULT_TENANT,
          now: new Date().toISOString(),
        },
      );
    } finally {
      await session.close();
    }
  }
}
