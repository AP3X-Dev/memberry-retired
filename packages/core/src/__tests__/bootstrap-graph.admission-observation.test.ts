import { describe, expect, it, vi } from 'vitest';
import type { Driver } from 'neo4j-driver';

import { BootstrapGraphService } from '../bootstrap-graph.js';

describe('BootstrapGraphService admission sidecar isolation', () => {
  it('excludes OBSERVES only from the relationship total and preserves every other status field', async () => {
    const values: Record<string, unknown> = {
      bootstrapped: true,
      entityCount: 2,
      agentCount: 3,
      semCount: 5,
      epCount: 7,
      relCount: 11,
    };
    const run = vi.fn(async (_query: string, _params?: Record<string, unknown>) => ({
      records: [{ get: (key: string) => values[key] }],
    }));
    const driver = {
      session: vi.fn(() => ({ run, close: vi.fn(async () => undefined) })),
    } as unknown as Driver;

    await expect(new BootstrapGraphService(driver).status('memberry')).resolves.toEqual({
      bootstrapped: true,
      entities: 2,
      agents: 3,
      semantics: 5,
      episodics: 7,
      relationships: 11,
    });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]![0]).toContain("WHERE type(r) <> 'OBSERVES'");
  });
});
