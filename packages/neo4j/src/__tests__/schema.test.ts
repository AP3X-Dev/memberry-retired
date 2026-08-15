// packages/neo4j/src/__tests__/schema.test.ts
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { createNeo4jDriver } from '../driver.js';
import { initSchema, verifySchema } from '../schema.js';

const NEO4J_URI = process.env.NEO4J_URI || 'bolt://localhost:7687';
const NEO4J_USER = process.env.NEO4J_USER || 'neo4j';
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || 'password';

// Probe whether Neo4j is reachable before running schema tests
async function isNeo4jReachable(uri: string, user: string, password: string): Promise<boolean> {
  const probe = createNeo4jDriver(uri, user, password);
  try {
    await probe.getServerInfo();
    return true;
  } catch {
    return false;
  } finally {
    await probe.close().catch(() => {});
  }
}

describe('Neo4j Schema', () => {
  let neo4jAvailable = false;
  const driver = createNeo4jDriver(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD);

  beforeAll(async () => {
    neo4jAvailable = await isNeo4jReachable(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD);
    if (!neo4jAvailable) {
      console.warn(`[skip] Neo4j not reachable at ${NEO4J_URI} — skipping schema tests`);
    }
  });

  afterAll(async () => {
    await driver.close().catch(() => {});
  });

  it('should run initSchema without errors', async () => {
    if (!neo4jAvailable) return;
    await expect(initSchema(driver)).resolves.toBeUndefined();
  });

  it('should verify schema returns expected constraint and index counts', async () => {
    if (!neo4jAvailable) return;
    // Run initSchema first to ensure schema is set up
    await initSchema(driver);
    const result = await verifySchema(driver);

    // 10 constraints defined in initSchema (incl. memblock_scope_name_tenant,
    // semantic_dedupe_unique, admission_observation_id) — keep the floor aligned
    // so dropping a concurrency-critical uniqueness guard is caught.
    expect(result.constraintCount).toBeGreaterThanOrEqual(10);
    // At least 4 plain indexes + 2 fulltext + 2 vector = 8 indexes
    // (Neo4j also creates backing indexes for constraints, so count may be higher)
    expect(result.indexCount).toBeGreaterThanOrEqual(8);
  });

  it('should be idempotent — running initSchema twice does not throw', async () => {
    if (!neo4jAvailable) return;
    await expect(initSchema(driver)).resolves.toBeUndefined();
    await expect(initSchema(driver)).resolves.toBeUndefined();
  });
});
