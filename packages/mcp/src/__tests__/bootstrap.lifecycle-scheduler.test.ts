// packages/mcp/src/__tests__/bootstrap.lifecycle-scheduler.test.ts
//
// Item 13a (audit A1/D2/D3): the MEM-006 lifecycle pass runs in-process
// behind MEMBERRY_LIFECYCLE_V1=live instead of only via the CLI/systemd
// timer nobody installs under Docker. Fake-timer tests pin the scheduler
// contract; source assertions pin the bootstrap wiring (bootstrap() itself
// needs live Neo4j/Redis, so it is not executed here).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { startLifecycleScheduler, parseLifecycleIntervalMs } from '../bootstrap.js';

const BOOTSTRAP_SOURCE = fs.readFileSync(path.resolve(__dirname, '../bootstrap.ts'), 'utf-8');
const MIN = 60_000;
const HOUR = 3_600_000;

function summary() {
  return { run_id: 'r', started_at: 't', dry_run: false, scopes: [{}, {}], failures: [] };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('startLifecycleScheduler', () => {
  it('runs 5 minutes after boot, then once per interval, and logs the summary counts', async () => {
    const run = vi.fn(async () => summary());
    const log = vi.fn();
    const handle = startLifecycleScheduler({ run, intervalMs: HOUR, log });
    await vi.advanceTimersByTimeAsync(5 * MIN - 1);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(run).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledWith('[lifecycle] pass complete: scopes=2 failures=0');
    handle.stop();
  });

  it('skips a tick while the previous pass is still running', async () => {
    let release!: () => void;
    const run = vi.fn(() => new Promise<ReturnType<typeof summary>>((resolve) => { release = () => resolve(summary()); }));
    const log = vi.fn();
    const handle = startLifecycleScheduler({ run, intervalMs: HOUR, log });
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(run).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('[lifecycle] skipped: previous pass still running');
    release();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(run).toHaveBeenCalledTimes(2);
    handle.stop();
  });

  it('a thrown pass is logged by error class (never message) and the schedule continues', async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new RangeError('secret-bearing message'))
      .mockResolvedValue(summary());
    const log = vi.fn();
    const handle = startLifecycleScheduler({ run, intervalMs: HOUR, log });
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(log).toHaveBeenCalledWith('[lifecycle] pass failed: RangeError');
    expect(log.mock.calls.flat().join('\n')).not.toContain('secret-bearing');
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(run).toHaveBeenCalledTimes(2);
    handle.stop();
  });

  it('a thrown errno error is reported by its code, which is fixed and actionable', async () => {
    const log = vi.fn();
    const failure = Object.assign(new Error("EACCES: permission denied, mkdir '.amp/lifecycle'"), { code: 'EACCES' });
    const handle = startLifecycleScheduler({ run: vi.fn().mockRejectedValue(failure), intervalMs: 3_600_000, log });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(log).toHaveBeenCalledWith('[lifecycle] pass failed: EACCES');
    expect(handle.status()).toMatchObject({ last_result: 'failed', last_error_class: 'EACCES' });
    expect(JSON.stringify(handle.status())).not.toContain('.amp');
    handle.stop();
  });

  it('stop() clears both timers so nothing runs afterwards', async () => {
    const run = vi.fn(async () => summary());
    const handle = startLifecycleScheduler({ run, intervalMs: HOUR, log: () => {} });
    handle.stop();
    await vi.advanceTimersByTimeAsync(5 * MIN + 2 * HOUR);
    expect(run).not.toHaveBeenCalled();
    const handle2 = startLifecycleScheduler({ run, intervalMs: HOUR, log: () => {} });
    await vi.advanceTimersByTimeAsync(5 * MIN + HOUR);
    expect(run).toHaveBeenCalledTimes(2);
    handle2.stop();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(run).toHaveBeenCalledTimes(2);
  });

  // Item 13b: readiness visibility of the last pass.
  it('status() moves never -> ok with last_run_at and the hebbian drained count from the pass result', async () => {
    const run = vi.fn(async () => ({
      ...summary(),
      hebbian: { run_id: 'hb', started_at: 't', dry_run: false, failures: [], tenants: [{ drained: 3 }, { drained: 4 }] },
    }));
    const handle = startLifecycleScheduler({ run, intervalMs: HOUR, log: () => {} });
    expect(handle.status()).toEqual({ mode: 'live', last_run_at: null, last_result: 'never' });
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(handle.status()).toEqual({ mode: 'live', last_run_at: expect.any(String), last_result: 'ok', hebbian_drained: 7 });
    expect(Number.isNaN(Date.parse(handle.status().last_run_at as string))).toBe(false);
    handle.stop();
  });

  // Item 13c: anti-entropy extraction stats + failure count from the pass result.
  it('status() carries anti_entropy mapped from the pass result, and omits it when the section is absent', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({
        ...summary(),
        anti_entropy: { extraction: { pending: 4, inflight: 1, dead_lettered: 2 }, failures: [{ class: 'signals', error: 'x' }] },
      })
      .mockResolvedValue(summary());
    const handle = startLifecycleScheduler({ run, intervalMs: HOUR, log: () => {} });
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(handle.status().anti_entropy).toEqual({ pending: 4, inflight: 1, dead_lettered: 2, failures: 1 });
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(handle.status()).not.toHaveProperty('anti_entropy');
    handle.stop();
  });

  it('status() reports failed with the error class (never the message) when the pass throws', async () => {
    const run = vi.fn().mockRejectedValue(new RangeError('secret-bearing message'));
    const handle = startLifecycleScheduler({ run, intervalMs: HOUR, log: () => {} });
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(handle.status()).toEqual({ mode: 'live', last_run_at: expect.any(String), last_result: 'failed', last_error_class: 'RangeError' });
    expect(JSON.stringify(handle.status())).not.toContain('secret-bearing');
    handle.stop();
  });
});

describe('parseLifecycleIntervalMs', () => {
  it('below the 1h minimum clamps to the minimum and warns once', () => {
    const log = vi.fn();
    expect(parseLifecycleIntervalMs('1000', log)).toBe(HOUR);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('[lifecycle] MEMBERRY_LIFECYCLE_INTERVAL_MS below minimum, using 3600000');
  });

  it('non-numeric falls back to the 24h default and warns once', () => {
    const log = vi.fn();
    expect(parseLifecycleIntervalMs('soon', log)).toBe(24 * HOUR);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('[lifecycle] MEMBERRY_LIFECYCLE_INTERVAL_MS invalid, using default 86400000');
  });

  it('valid is returned as given; unset is the default, silently', () => {
    const log = vi.fn();
    expect(parseLifecycleIntervalMs(String(2 * HOUR), log)).toBe(2 * HOUR);
    expect(parseLifecycleIntervalMs(undefined, log)).toBe(24 * HOUR);
    expect(log).not.toHaveBeenCalled();
  });
});

describe('bootstrap.ts lifecycle wiring', () => {
  it('constructs the scheduler only when MEMBERRY_LIFECYCLE_V1 resolves live, after the coordinator starts, on the shared core', () => {
    const start = BOOTSTRAP_SOURCE.indexOf('consolidationCoordinator.start();');
    const wiring = BOOTSTRAP_SOURCE.indexOf('resolveLifecycleConfig(defaultExportPath())');
    expect(start).toBeGreaterThan(0);
    expect(wiring).toBeGreaterThan(start);
    expect(BOOTSTRAP_SOURCE).toContain("lifecycleConfig.mode === 'live'");
    expect(BOOTSTRAP_SOURCE).toContain('runLifecyclePass(core, { config: lifecycleConfig })');
    expect(BOOTSTRAP_SOURCE).toContain("'MEMBERRY_LIFECYCLE_INTERVAL_MS'");
    expect(BOOTSTRAP_SOURCE).toContain('lifecycleScheduler?.stop()');
    // 13b: the readiness accessor is registered and degrades to disabled/never without a scheduler.
    expect(BOOTSTRAP_SOURCE).toContain("lifecycle: () => lifecycleScheduler?.status() ?? { mode: 'disabled', last_run_at: null, last_result: 'never' }");
  });
});
