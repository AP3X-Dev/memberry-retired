// packages/neo4j/src/gds.ts
import neo4j, { type Driver } from 'neo4j-driver';
import { archivedWhere } from './query.js';

export interface SimilarPair {
  nodeA: string;
  nodeB: string;
  similarity: number;
}

export interface RankedNode {
  id: string;
  content: string;
  score: number;
}

export interface CommunityNode {
  id: string;
  content: string;
  communityId: string;
}

export class GDSAlgorithms {
  constructor(private driver: Driver) {}

  /**
   * Pairwise cosine similarity on Semantic nodes scoped to an entity.
   * Uses `gds.similarity.cosine`. The candidate list is capped at `limit`
   * nodes before the O(n²) cross join and the result is capped at `limit` pairs.
   * Throws a value-free `similarity_unavailable` error on any failure (GDS
   * plugin missing, driver error); the original message goes to stderr only.
   */
  async findSimilarSemantics(
    entityName: string,
    threshold = 0.7,
    limit = 200,
  ): Promise<SimilarPair[]> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        `MATCH (s:Semantic)-[:ABOUT]->(e:Entity {name: $entityName})
         WHERE s.embedding IS NOT NULL AND ${archivedWhere('s')}
         WITH collect({id: s.id, embedding: s.embedding}) AS nodes
         WITH nodes[0..$limit] AS nodes
         UNWIND nodes AS a
         UNWIND nodes AS b
         WITH a, b WHERE a.id < b.id
         RETURN a.id AS nodeA, b.id AS nodeB,
                gds.similarity.cosine(a.embedding, b.embedding) AS similarity
         ORDER BY similarity DESC
         LIMIT $limit`,
        { entityName, limit: neo4j.int(limit) },
      );

      return result.records
        .map((r) => ({
          nodeA: r.get('nodeA') as string,
          nodeB: r.get('nodeB') as string,
          similarity: r.get('similarity') as number,
        }))
        .filter((p) => p.similarity >= threshold);
    } catch (err: unknown) {
      console.error(`[gds] findSimilarSemantics failed: ${err instanceof Error ? err.message : String(err)}`);
      throw new Error('similarity_unavailable');
    } finally {
      await session.close();
    }
  }

  /**
   * Ranks Semantic nodes within an entity scope using
   * `signal_count * confidence` as a proxy PageRank score.
   */
  async pageRank(entityName: string): Promise<RankedNode[]> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        `MATCH (s:Semantic)-[:ABOUT]->(e:Entity {name: $entityName})
         WHERE ${archivedWhere('s')}
         WITH s, (s.signal_count * s.confidence) AS score
         RETURN s.id AS id, s.content AS content, score
         ORDER BY score DESC`,
        { entityName },
      );

      return result.records.map((r) => ({
        id: r.get('id') as string,
        content: r.get('content') as string,
        score: r.get('score') as number,
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Groups Semantic nodes by the Entity they are connected to via ABOUT.
   * Each entity forms a "community"; nodes not connected to any entity
   * get communityId = "unassigned".
   */
  async communityDetection(): Promise<CommunityNode[]> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        `MATCH (s:Semantic)
         WHERE ${archivedWhere('s')}
         OPTIONAL MATCH (s)-[:ABOUT]->(e:Entity)
         RETURN s.id AS id, s.content AS content,
                coalesce(e.id, 'unassigned') AS communityId
         ORDER BY communityId, s.id`,
      );

      return result.records.map((r) => ({
        id: r.get('id') as string,
        content: r.get('content') as string,
        communityId: r.get('communityId') as string,
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Counts episodic CORRECTS relationships per Semantic node within
   * the scope of a given entity.
   */
  async findCorrectionClusters(
    entityName: string,
  ): Promise<Array<{ targetId: string; correctionCount: number }>> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        `MATCH (s:Semantic)-[:ABOUT]->(e:Entity {name: $entityName})
         WHERE ${archivedWhere('s')}
         OPTIONAL MATCH (ep:Episodic)-[:CORRECTS]->(s)
         WITH s, count(ep) AS correctionCount
         WHERE correctionCount > 0
         RETURN s.id AS targetId, correctionCount
         ORDER BY correctionCount DESC`,
        { entityName },
      );

      return result.records.map((r) => ({
        targetId: r.get('targetId') as string,
        correctionCount: (r.get('correctionCount') as { toNumber: () => number } | number) instanceof Object && 'toNumber' in (r.get('correctionCount') as object)
          ? (r.get('correctionCount') as { toNumber: () => number }).toNumber()
          : (r.get('correctionCount') as number),
      }));
    } finally {
      await session.close();
    }
  }
}
