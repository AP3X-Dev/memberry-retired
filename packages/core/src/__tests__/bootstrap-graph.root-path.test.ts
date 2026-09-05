// packages/core/src/__tests__/bootstrap-graph.root-path.test.ts
//
// Item 14a: berry_ingest_codebase persists the confined ingest root as
// `root_path` on the project Entity so the code watcher can be restarted at
// boot (14b). Pins that mergeEntity SETs it (parameterized, overwrite) only
// when the entity carries one, and that the query text is unchanged otherwise.
// Imports from src (not @memberry/core) so it runs without a rebuilt dist.

import { describe, it, expect, vi } from 'vitest';
import type { Driver } from 'neo4j-driver';
import { BootstrapGraphService, type BootstrapEntity } from '../bootstrap-graph.js';

type MergeEntityFn = (
  session: unknown,
  entity: BootstrapEntity,
  result: { entities_created: number; entities_existing: number },
  projectScope?: string,
) => Promise<string>;

function makeService() {
  const run = vi.fn(async () => ({
    records: [{ get: (k: string) => (k === 'id' ? 'ent-1' : k === 'isNew' ? true : null) }],
  }));
  const session = { run, close: async () => {} };
  const driver = { session: () => session, close: async () => {} } as unknown as Driver;
  const service = new BootstrapGraphService(driver);
  const merge = (service as unknown as { mergeEntity: MergeEntityFn }).mergeEntity.bind(service);
  return { run, session, merge };
}

const result = () => ({ entities_created: 0, entities_existing: 0 });

describe('BootstrapGraphService mergeEntity root_path', () => {
  it('SETs e.root_path from a parameter when the entity carries root_path', async () => {
    const { run, session, merge } = makeService();
    await merge(session, { name: 'app', type: 'project', root_path: '/w/app' }, result());

    expect(run).toHaveBeenCalledTimes(1);
    const [query, params] = run.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(query).toContain('e.root_path = $rootPath');
    expect(query).not.toContain('/w/app');
    expect(params.rootPath).toBe('/w/app');
  });

  it('emits no root_path clause or param when the entity has none', async () => {
    const { run, session, merge } = makeService();
    await merge(session, { name: 'mod', type: 'module' }, result());

    const [query, params] = run.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(query).not.toContain('root_path');
    expect(params).not.toHaveProperty('rootPath');
  });
});
