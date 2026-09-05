// packages/core/src/__tests__/lifecycle-pass.test.ts
//
// Item 13a: `runLifecyclePass` is the ONE implementation shared by the CLI
// `lifecycle` verb and the in-process MCP scheduler. Pins the construction
// recipe extracted from cli.ts: LifecycleStore(core.driver) → optional
// HebbianEngine (only when MEMBERRY_LIFECYCLE_HEBBIAN=live, run BEFORE the
// lifecycle pass) → LifecycleEngine.run → optional AntiEntropyEngine (only
// when MEMBERRY_LIFECYCLE_ANTIENTROPY=live, run AFTER), and the merged
// result shape the CLI prints verbatim.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { calls, lifecycleRun, hebbianRun, antiEntropyRun, LifecycleEngine, HebbianEngine, AntiEntropyEngine } = vi.hoisted(() => {
  const calls: string[] = [];
  const lifecycleRun = vi.fn(async () => {
    calls.push('lifecycle');
    return { run_id: 'lc', started_at: 't', dry_run: false, scopes: [], failures: [] };
  });
  const hebbianRun = vi.fn(async () => {
    calls.push('hebbian');
    return { run_id: 'hb', started_at: 't', dry_run: false, tenants: [], failures: [] };
  });
  const antiEntropyRun = vi.fn(async () => {
    calls.push('anti-entropy');
    return { run_id: 'ae', started_at: 't', dry_run: false, failures: [] };
  });
  const LifecycleEngine = vi.fn(function (this: { run: typeof lifecycleRun }) { this.run = lifecycleRun; });
  const HebbianEngine = vi.fn(function (this: { run: typeof hebbianRun }) { this.run = hebbianRun; });
  const AntiEntropyEngine = vi.fn(function (this: { run: typeof antiEntropyRun }) { this.run = antiEntropyRun; });
  return { calls, lifecycleRun, hebbianRun, antiEntropyRun, LifecycleEngine, HebbianEngine, AntiEntropyEngine };
});

vi.mock('../lifecycle.js', () => ({ LifecycleEngine }));
vi.mock('../hebbian.js', () => ({ HebbianEngine }));
vi.mock('../anti-entropy.js', () => ({ AntiEntropyEngine }));
vi.mock('@memberry/neo4j', () => ({ LifecycleStore: vi.fn(function () { /* fake */ }) }));
vi.mock('@memberry/redis', () => ({
  ProposalStore: vi.fn(function () { /* fake */ }),
  EpisodicBuffer: vi.fn(function () { /* fake */ }),
}));

import { runLifecyclePass } from '../lifecycle-pass.js';
import type { CoreServices } from '../services-factory.js';

const core = { driver: {}, redis: {}, signals: {}, queue: {}, extractionQueue: {} } as unknown as CoreServices;
const ENV = ['MEMBERRY_LIFECYCLE_V1', 'MEMBERRY_LIFECYCLE_HEBBIAN', 'MEMBERRY_LIFECYCLE_ANTIENTROPY'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  calls.length = 0;
  vi.clearAllMocks();
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe('runLifecyclePass', () => {
  it('constructs and runs the LifecycleEngine once and returns its result', async () => {
    const out = await runLifecyclePass(core, { config: { mode: 'live' } as never });
    expect(LifecycleEngine).toHaveBeenCalledTimes(1);
    expect(lifecycleRun).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ run_id: 'lc', started_at: 't', dry_run: false, scopes: [], failures: [] });
    // Sub-flags unset → the optional engines are never constructed.
    expect(HebbianEngine).not.toHaveBeenCalled();
    expect(AntiEntropyEngine).not.toHaveBeenCalled();
    expect(out).not.toHaveProperty('hebbian');
    expect(out).not.toHaveProperty('anti_entropy');
  });

  it('runs Hebbian BEFORE and anti-entropy AFTER the lifecycle pass only when their modes are live', async () => {
    process.env['MEMBERRY_LIFECYCLE_HEBBIAN'] = 'live';
    process.env['MEMBERRY_LIFECYCLE_ANTIENTROPY'] = 'live';
    const out = await runLifecyclePass(core, { config: { mode: 'live' } as never });
    expect(calls).toEqual(['hebbian', 'lifecycle', 'anti-entropy']);
    // Hebbian config reaches the LifecycleEngine only when live (flag-off equivalence).
    expect(LifecycleEngine.mock.calls[0]?.[0]).toMatchObject({ hebbian: { mode: 'live' } });
    expect(out).toMatchObject({ run_id: 'lc', hebbian: { run_id: 'hb' }, anti_entropy: { run_id: 'ae' } });
  });

  it('forwards scope and dryRun to the engines', async () => {
    process.env['MEMBERRY_LIFECYCLE_HEBBIAN'] = 'live';
    await runLifecyclePass(core, { config: { mode: 'live' } as never, scope: 'project:x', dryRun: true });
    expect(lifecycleRun).toHaveBeenCalledWith({ scope: 'project:x', dryRun: true });
    expect(hebbianRun).toHaveBeenCalledWith({ dryRun: true });
  });
});
