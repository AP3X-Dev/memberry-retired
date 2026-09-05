// packages/core/src/__tests__/bootstrap-graph.identifier-guard.test.ts
//
// Audit C7: mergeRelationship interpolates the relationship type into Cypher
// (types cannot be parameters). Pins that anything outside the closed allowlist
// is rejected BEFORE session.run, and that the error never echoes the input.
// Imports from src (not @memberry/core) so it runs without a rebuilt dist.

import { describe, it, expect, vi } from 'vitest';
import type { Driver } from 'neo4j-driver';
import { BootstrapGraphService } from '../bootstrap-graph.js';

type MergeFn = (
  session: unknown,
  fromId: string,
  toId: string,
  relType: string,
  result: { relationships_created: number },
) => Promise<void>;

function makeService() {
  const run = vi.fn(async () => ({ records: [] }));
  const session = { run, close: async () => {} };
  const driver = { session: () => session, close: async () => {} } as unknown as Driver;
  const service = new BootstrapGraphService(driver);
  const merge = (service as unknown as { mergeRelationship: MergeFn }).mergeRelationship.bind(service);
  return { run, session, merge };
}

const INJECTED_REL = 'X] MERGE (n) SET n.pwned=true //';

describe('BootstrapGraphService mergeRelationship identifier guard', () => {
  it('rejects an injection-shaped relType before session.run', async () => {
    const { run, session, merge } = makeService();
    const result = { relationships_created: 0 };

    await expect(merge(session, 'a', 'b', INJECTED_REL, result))
      .rejects.toThrow('invalid_relationship_type');
    expect(run).not.toHaveBeenCalled();
    expect(result.relationships_created).toBe(0);
  });

  it('rejects a label-shaped payload in the relType slot before session.run', async () => {
    const { run, session, merge } = makeService();

    await expect(merge(session, 'a', 'b', 'Entity) DETACH DELETE (n', { relationships_created: 0 }))
      .rejects.toThrow('invalid_relationship_type');
    expect(run).not.toHaveBeenCalled();
  });

  it('does not echo the offending value in the thrown message', async () => {
    const { session, merge } = makeService();
    let message = '';
    try { await merge(session, 'a', 'b', INJECTED_REL, { relationships_created: 0 }); } catch (e) { message = String(e); }
    expect(message).not.toBe('');
    expect(message).not.toContain('pwned');
  });

  it('accepts every relationship type bootstrap() actually uses', async () => {
    const { run, session, merge } = makeService();
    const result = { relationships_created: 0 };
    // Enumerated from the two mergeRelationship call sites in bootstrap():
    // project-CONTAINS->entity and parent-CONTAINS->child.
    const legitimate = ['CONTAINS'];
    for (const rel of legitimate) {
      await merge(session, 'a', 'b', rel, result);
    }
    expect(run).toHaveBeenCalledTimes(legitimate.length);
    expect((run.mock.calls[0] as unknown[])[0]).toContain('[:CONTAINS]');
    expect(result.relationships_created).toBe(legitimate.length);
  });
});
