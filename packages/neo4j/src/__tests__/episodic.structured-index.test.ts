import { describe, expect, it, vi } from 'vitest';
import type { EpisodeIndexKeyNodeV1, EpisodicNode } from '@memberry/core';
import { EpisodicStore } from '../episodic.js';

const node: EpisodicNode = {
  id: 'ep1', session_id: 's', agent_id: 'a', task: 't', content: 'A uses B',
  embedding: [0.1], created_at: '2026-08-30T00:00:00.000Z',
  tenant_id: 'tenant1', scope: 'project:memberry', tags: ['project:memberry'],
};
const key: EpisodeIndexKeyNodeV1 = {
  id: 'eik1:ep1:x', episode_id: 'ep1', kind: 'alias', value: 'A', entity_id: 'ent1',
  embedding: [0.2], schema_version: 1, source: 'agent', source_hash: 'x',
  tenant_id: 'tenant1', project_scope: 'project:memberry', created_at: node.created_at,
};

function driverWithAuthorized(ids: string[], projectCount = 1) {
  const queries: string[] = [];
  const run = vi.fn(async (query: string) => {
    queries.push(query);
    if (query.includes('RETURN count(DISTINCT root) AS count')) {
      return { records: [{ get: () => projectCount }] };
    }
    if (query.includes('RETURN collect(entityId) AS ids')) {
      return { records: [{ get: () => ids }] };
    }
    return { records: [{ get: () => 'ep1' }] };
  });
  const tx = { run };
  const close = vi.fn(async () => undefined);
  const driver = {
    session: () => ({ executeWrite: (work: (value: typeof tx) => unknown) => work(tx), close }),
  };
  return { driver, queries, close };
}

describe('IDX-001A atomic EpisodicIndexKey persistence', () => {
  it('authorizes entity IDs first and creates keys in the episode transaction', async () => {
    const fake = driverWithAuthorized(['ent1']);
    const store = new EpisodicStore(fake.driver as never);
    await expect(store.createWithLinks(node, { entityIds: ['ent1'] }, [key])).resolves.toBe('ep1');
    expect(fake.queries[0]).toContain("root:Entity {type: 'project'}");
    expect(fake.queries[1]).toContain('CONTAINS*0..64');
    expect(fake.queries.some((query) => query.includes('CREATE (e:Episodic'))).toBe(true);
    expect(fake.queries.some((query) => query.includes('CREATE (k:EpisodicIndexKey'))).toBe(true);
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it('rejects foreign entities before creating the episode or any key', async () => {
    const fake = driverWithAuthorized([]);
    const store = new EpisodicStore(fake.driver as never);
    await expect(store.createWithLinks(node, { entityIds: ['ent1'] }, [key]))
      .rejects.toThrow('structured_index:entity_out_of_scope');
    expect(fake.queries).toHaveLength(2);
    expect(fake.queries.every((query) => !query.includes('CREATE (e:Episodic'))).toBe(true);
  });

  it('rejects fact-only writes unless the tenant owns exactly one project root', async () => {
    const fake = driverWithAuthorized([], 0);
    const store = new EpisodicStore(fake.driver as never);
    await expect(store.createWithLinks(node, {}, [{ ...key, kind: 'fact', entity_id: undefined }]))
      .rejects.toThrow('structured_index:project_out_of_scope');
    expect(fake.queries).toHaveLength(1);
    expect(fake.queries[0]).not.toContain('CREATE (e:Episodic');
  });

  it('rejects key scope/tenant/episode mismatches before persistence', async () => {
    const fake = driverWithAuthorized([]);
    const store = new EpisodicStore(fake.driver as never);
    await expect(store.createWithLinks(node, {}, [{ ...key, entity_id: undefined, tenant_id: 'foreign' }]))
      .rejects.toThrow('structured_index:key_authority_mismatch');
    expect(fake.queries).toHaveLength(1);
  });
});
