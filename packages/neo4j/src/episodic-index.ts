import type { Driver } from 'neo4j-driver';
import type { EpisodeIndexKeyNodeV1 } from '@memberry/core';

export interface EpisodicIndexCursorV1 { createdAt: string; id: string }
export interface EpisodicIndexBackfillEpisodeV1 extends EpisodicIndexCursorV1 {
  content: string;
  tenantId: string;
  projectScope: string;
}

export class EpisodicIndexStore {
  constructor(private readonly driver: Driver) {}

  async nextBackfillBatch(input: {
    tenantId: string;
    projectScope: string;
    limit: number;
    after?: EpisodicIndexCursorV1;
  }): Promise<EpisodicIndexBackfillEpisodeV1[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new Error('structured_index_backfill:invalid_limit');
    }
    const session = this.driver.session({ defaultAccessMode: 'READ' });
    try {
      const result = await session.run(
        `MATCH (ep:Episodic)
         WHERE ep.tenant_id = $tenantId
           AND ep.scope = $projectScope
           AND coalesce(ep.archived, false) = false
           AND coalesce(ep.content, '') <> ''
           AND ($afterCreatedAt IS NULL OR ep.created_at > $afterCreatedAt
             OR (ep.created_at = $afterCreatedAt AND ep.id > $afterId))
           AND NOT EXISTS { (ep)-[:HAS_INDEX_KEY]->(:EpisodicIndexKey {schema_version: 1}) }
           AND NOT EXISTS { (ep)-[:HAS_INDEX_OUTCOME]->(:EpisodicIndexOutcome {schema_version: 1}) }
         RETURN ep.id AS id, ep.created_at AS createdAt, ep.content AS content
         ORDER BY ep.created_at ASC, ep.id ASC
         LIMIT $limit`,
        {
          tenantId: input.tenantId,
          projectScope: input.projectScope,
          afterCreatedAt: input.after?.createdAt ?? null,
          afterId: input.after?.id ?? '',
          limit: input.limit,
        },
      );
      return result.records.map((record) => ({
        id: record.get('id') as string,
        createdAt: record.get('createdAt') as string,
        content: record.get('content') as string,
        tenantId: input.tenantId,
        projectScope: input.projectScope,
      }));
    } finally {
      await session.close();
    }
  }

  async markBackfillEmpty(episode: EpisodicIndexBackfillEpisodeV1): Promise<void> {
    const session = this.driver.session();
    try {
      await session.executeWrite(async (tx) => {
        const owner = await tx.run(
          `MATCH (ep:Episodic {id: $episodeId, tenant_id: $tenantId, scope: $projectScope})
           RETURN count(ep) AS count`,
          { episodeId: episode.id, tenantId: episode.tenantId, projectScope: episode.projectScope },
        );
        if (Number(owner.records[0]?.get('count') ?? 0) !== 1) {
          throw new Error('structured_index_backfill:episode_not_owned');
        }
        await tx.run(
          `MATCH (ep:Episodic {id: $episodeId})
           MERGE (outcome:EpisodicIndexOutcome {id: $outcomeId})
           ON CREATE SET outcome.episode_id = $episodeId,
                         outcome.outcome = 'empty',
                         outcome.schema_version = 1,
                         outcome.source = 'backfill',
                         outcome.tenant_id = $tenantId,
                         outcome.project_scope = $projectScope,
                         outcome.created_at = $createdAt
           MERGE (ep)-[:HAS_INDEX_OUTCOME]->(outcome)`,
          {
            episodeId: episode.id,
            outcomeId: `eio1:${episode.id}:empty`,
            tenantId: episode.tenantId,
            projectScope: episode.projectScope,
            createdAt: new Date().toISOString(),
          },
        );
      });
    } finally {
      await session.close();
    }
  }

  async replaceBackfillKeys(
    episode: EpisodicIndexBackfillEpisodeV1,
    keys: readonly EpisodeIndexKeyNodeV1[],
  ): Promise<void> {
    if (keys.some((key) => key.episode_id !== episode.id || key.tenant_id !== episode.tenantId
      || key.project_scope !== episode.projectScope || key.source !== 'backfill')) {
      throw new Error('structured_index_backfill:key_authority_mismatch');
    }
    const session = this.driver.session();
    try {
      await session.executeWrite(async (tx) => {
        const owner = await tx.run(
          `MATCH (ep:Episodic {id: $episodeId, tenant_id: $tenantId, scope: $projectScope})
           RETURN count(ep) AS count`,
          { episodeId: episode.id, tenantId: episode.tenantId, projectScope: episode.projectScope },
        );
        const count = Number(owner.records[0]?.get('count') ?? 0);
        if (count !== 1) throw new Error('structured_index_backfill:episode_not_owned');
        await tx.run(
          `MATCH (:Episodic {id: $episodeId})-[:HAS_INDEX_KEY]->(old:EpisodicIndexKey {source: 'backfill'})
           DETACH DELETE old`,
          { episodeId: episode.id },
        );
        if (keys.length > 0) {
          await tx.run(
            `UNWIND $keys AS key
             MATCH (ep:Episodic {id: $episodeId})
             CREATE (k:EpisodicIndexKey {
               id: key.id, episode_id: key.episode_id, kind: key.kind,
               value: key.value, entity_id: key.entity_id, embedding: key.embedding,
               schema_version: key.schema_version, source: key.source,
               source_hash: key.source_hash, tenant_id: key.tenant_id,
               project_scope: key.project_scope, created_at: key.created_at
             })
             MERGE (ep)-[:HAS_INDEX_KEY]->(k)`,
            { episodeId: episode.id, keys },
          );
        }
      });
    } finally {
      await session.close();
    }
  }

  async deleteDerived(input: { tenantId: string; projectScope: string }): Promise<number> {
    const session = this.driver.session();
    try {
      return await session.executeWrite(async (tx) => {
        const result = await tx.run(
          `OPTIONAL MATCH (key:EpisodicIndexKey {tenant_id: $tenantId, project_scope: $projectScope})
           WITH count(key) AS keyCount
           OPTIONAL MATCH (outcome:EpisodicIndexOutcome {tenant_id: $tenantId, project_scope: $projectScope})
           RETURN keyCount + count(outcome) AS count`,
          input,
        );
        const count = Number(result.records[0]?.get('count') ?? 0);
        await tx.run(
          `MATCH (key:EpisodicIndexKey {tenant_id: $tenantId, project_scope: $projectScope})
           DETACH DELETE key`,
          input,
        );
        await tx.run(
          `MATCH (outcome:EpisodicIndexOutcome {tenant_id: $tenantId, project_scope: $projectScope})
           DETACH DELETE outcome`,
          input,
        );
        return count;
      });
    } finally {
      await session.close();
    }
  }

  async stats(input: { tenantId: string; projectScope: string }): Promise<{
    episodes: number; indexed: number; empty: number; keys: number;
  }> {
    const session = this.driver.session({ defaultAccessMode: 'READ' });
    try {
      const result = await session.run(
        `MATCH (ep:Episodic {tenant_id: $tenantId, scope: $projectScope})
         OPTIONAL MATCH (ep)-[:HAS_INDEX_KEY]->(key:EpisodicIndexKey {schema_version: 1})
         WITH ep, collect(key) AS keys
         OPTIONAL MATCH (ep)-[:HAS_INDEX_OUTCOME]->(outcome:EpisodicIndexOutcome {schema_version: 1, outcome: 'empty'})
         RETURN count(DISTINCT ep) AS episodes,
                count(DISTINCT CASE WHEN size(keys) > 0 THEN ep END) AS indexed,
                count(DISTINCT CASE WHEN outcome IS NOT NULL THEN ep END) AS empty,
                sum(size(keys)) AS keys`,
        input,
      );
      const record = result.records[0];
      return {
        episodes: Number(record?.get('episodes') ?? 0),
        indexed: Number(record?.get('indexed') ?? 0),
        empty: Number(record?.get('empty') ?? 0),
        keys: Number(record?.get('keys') ?? 0),
      };
    } finally {
      await session.close();
    }
  }
}
