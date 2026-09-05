// packages/core/src/__tests__/lifecycle-pass.anti-entropy.test.ts
//
// Item 13c: prove the anti-entropy pass runs through the ONE shared
// `runLifecyclePass` and that the extraction-queue stats it reports (the
// numbers the scheduler copies onto /readyz `lifecycle.anti_entropy`) come
// from the extraction port. Uses the REAL AntiEntropyEngine over fake ports;
// the sibling lifecycle-pass.test.ts mocks anti-entropy.js module-wide,
// hence a separate file (same shape as lifecycle-pass.hebbian-drain.test.ts).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../lifecycle.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lifecycle.js')>()),
  LifecycleEngine: vi.fn(function (this: { run: () => Promise<unknown> }) {
    this.run = async () => ({ run_id: 'lc', started_at: 't', dry_run: false, scopes: [], failures: [] });
  }),
}));
vi.mock('@memberry/neo4j', () => ({
  LifecycleStore: vi.fn(function (this: Record<string, unknown>) {
    this.listProjectRoots = async () => [];
    this.deriveProjectTag = async () => null;
    this.linkOrphanEpisodics = async () => ({ linked: 0, ids: [] });
  }),
}));
vi.mock('@memberry/redis', () => ({
  ProposalStore: vi.fn(function () { /* fake */ }),
  EpisodicBuffer: vi.fn(function (this: { length: () => Promise<number> }) {
    this.length = async () => 0;
  }),
}));

import { runLifecyclePass } from '../lifecycle-pass.js';
import type { CoreServices } from '../services-factory.js';

const stats = vi.fn(async () => ({ pending: 4, inflight: 1, deadLettered: 2 }));
const groupHealth = vi.fn(async () => ({ pelCount: 0, oldestIdleMs: 0, consumers: [] }));

function fakeCore(): CoreServices {
  return {
    driver: {},
    redis: { mget: async () => [null, null] },
    signals: { groupHealth, removeIdleConsumers: async () => [] },
    queue: { size: async () => 0, peek: async () => [] },
    extractionQueue: { stats },
  } as unknown as CoreServices;
}

let exportDir: string;
const savedFlag = process.env['MEMBERRY_LIFECYCLE_ANTIENTROPY'];

beforeEach(() => {
  exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-entropy-pass-'));
  delete process.env['MEMBERRY_LIFECYCLE_ANTIENTROPY'];
  stats.mockClear();
  groupHealth.mockClear();
});
afterEach(() => {
  fs.rmSync(exportDir, { recursive: true, force: true });
  if (savedFlag === undefined) delete process.env['MEMBERRY_LIFECYCLE_ANTIENTROPY'];
  else process.env['MEMBERRY_LIFECYCLE_ANTIENTROPY'] = savedFlag;
});

function config() {
  return { mode: 'live', dryRun: false, batchRows: 2, exportDir } as never;
}

describe('runLifecyclePass runs anti-entropy (real AntiEntropyEngine, fake ports)', () => {
  it('MEMBERRY_LIFECYCLE_ANTIENTROPY=live: the anti_entropy section carries the extraction port stats', async () => {
    process.env['MEMBERRY_LIFECYCLE_ANTIENTROPY'] = 'live';

    const out = await runLifecyclePass(fakeCore(), { config: config() });

    expect(out.anti_entropy?.extraction).toEqual({ pending: 4, inflight: 1, dead_lettered: 2 });
    expect(out.anti_entropy?.failures).toEqual([]);
    expect(stats).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(path.join(exportDir, 'anti-entropy'))).toHaveLength(1);
  });

  it('flag unset: no anti_entropy section and the ports are never called', async () => {
    const out = await runLifecyclePass(fakeCore(), { config: config() });

    expect(out).not.toHaveProperty('anti_entropy');
    expect(stats).not.toHaveBeenCalled();
    expect(groupHealth).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(exportDir, 'anti-entropy'))).toBe(false);
  });
});
