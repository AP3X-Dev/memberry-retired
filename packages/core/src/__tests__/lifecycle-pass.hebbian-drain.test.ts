// packages/core/src/__tests__/lifecycle-pass.hebbian-drain.test.ts
//
// Item 13b: prove the hebbian feedback ring actually drains through the ONE
// shared `runLifecyclePass` (the in-process scheduler runs nothing else).
// Uses the REAL HebbianEngine over a fake in-memory Redis ring; the sibling
// lifecycle-pass.test.ts mocks hebbian.js module-wide, hence a separate file.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { applyUsage } = vi.hoisted(() => ({
  applyUsage: vi.fn(async (_tenant: string, rows: Array<{ id: string }>) => ({
    applied: rows.map((r) => ({ id: r.id, scope: null })),
  })),
}));

vi.mock('../lifecycle.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lifecycle.js')>()),
  LifecycleEngine: vi.fn(function (this: { run: () => Promise<unknown> }) {
    this.run = async () => ({ run_id: 'lc', started_at: 't', dry_run: false, scopes: [], failures: [] });
  }),
}));
vi.mock('@memberry/neo4j', () => ({
  LifecycleStore: vi.fn(function (this: Record<string, unknown>) {
    this.listScopes = async () => [];
    this.applyUsage = applyUsage;
  }),
}));
vi.mock('@memberry/redis', () => ({
  ProposalStore: vi.fn(function () { /* fake */ }),
  EpisodicBuffer: vi.fn(function () { /* fake */ }),
}));

import { runLifecyclePass } from '../lifecycle-pass.js';
import type { CoreServices } from '../services-factory.js';

const RING_KEY = 'amp:feedback:log';

/** In-memory stand-in for the two ioredis calls the pass adapts into HebbianRingPort. */
function fakeRedis(initial: string[]) {
  const lists = new Map<string, string[]>([[RING_KEY, [...initial]]]);
  return {
    lists,
    rpop: async (key: string, count: number): Promise<string[] | null> => {
      const list = lists.get(key) ?? [];
      if (list.length === 0) return null;
      return list.splice(-count, count).reverse();
    },
    llen: async (key: string): Promise<number> => (lists.get(key) ?? []).length,
  };
}

function record(id: string): string {
  return JSON.stringify({ result_id: id, source_type: 'semantic', was_useful: true, timestamp: '2026-01-01T00:00:00.000Z' });
}

let exportDir: string;
const savedFlag = process.env['MEMBERRY_LIFECYCLE_HEBBIAN'];

beforeEach(() => {
  exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hebbian-drain-'));
  delete process.env['MEMBERRY_LIFECYCLE_HEBBIAN'];
  applyUsage.mockClear();
});
afterEach(() => {
  fs.rmSync(exportDir, { recursive: true, force: true });
  if (savedFlag === undefined) delete process.env['MEMBERRY_LIFECYCLE_HEBBIAN'];
  else process.env['MEMBERRY_LIFECYCLE_HEBBIAN'] = savedFlag;
});

function config() {
  return { mode: 'live', dryRun: false, batchRows: 2, exportDir } as never;
}

describe('runLifecyclePass drains the hebbian ring (real HebbianEngine, fake ring)', () => {
  it('MEMBERRY_LIFECYCLE_HEBBIAN=live: ring length goes to 0 and the hebbian section reports the drained count', async () => {
    process.env['MEMBERRY_LIFECYCLE_HEBBIAN'] = 'live';
    const redis = fakeRedis([record('a'), record('b'), record('c')]);
    const core = { driver: {}, redis } as unknown as CoreServices;

    const out = await runLifecyclePass(core, { config: config() });

    expect(redis.lists.get(RING_KEY)).toEqual([]);
    expect(out.hebbian?.tenants).toHaveLength(1);
    expect(out.hebbian?.tenants[0]).toMatchObject({ ring_key: RING_KEY, drained: 3, applied: 3, malformed: 0 });
    expect(out.hebbian?.failures).toEqual([]);
    expect(applyUsage).toHaveBeenCalledTimes(1);
  });

  it('flag unset: the ring is untouched and no hebbian section is returned', async () => {
    const redis = fakeRedis([record('a'), record('b')]);
    const core = { driver: {}, redis } as unknown as CoreServices;

    const out = await runLifecyclePass(core, { config: config() });

    expect(redis.lists.get(RING_KEY)).toHaveLength(2);
    expect(out).not.toHaveProperty('hebbian');
    expect(applyUsage).not.toHaveBeenCalled();
  });
});
