// packages/mcp/src/__tests__/bootstrap.code-watch-on-boot.test.ts
//
// Item 14b (audit A3): after a restart nothing re-armed the CodeWatcher until
// an agent called berry_code_watch, so the code index went stale. Behind
// MEMBERRY_CODE_WATCH_ON_BOOT the server re-watches every persisted project
// root_path (item 14a) that is still confined and still on disk. Fake-driver
// tests pin the helper; source assertions pin the bootstrap wiring
// (bootstrap() itself needs live Neo4j/Redis, so it is not executed here).

import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { startCodeWatchOnBoot } from '../bootstrap.js';

const BOOTSTRAP_SOURCE = fs.readFileSync(path.resolve(__dirname, '../bootstrap.ts'), 'utf-8');
const BASE = path.resolve('/srv/work');

function fakeDriver(rows: Array<{ name: string; root: string }> | Error) {
  const run = vi.fn(async () => {
    if (rows instanceof Error) throw rows;
    return { records: rows.map((r) => ({ get: (k: string) => (k === 'name' ? r.name : r.root) })) };
  });
  const close = vi.fn(async () => {});
  return { driver: { session: () => ({ run, close }) }, run, close };
}

describe('startCodeWatchOnBoot', () => {
  it('watches the confined, existing root and logs the missing one by name', async () => {
    const existing = path.join(BASE, 'alpha');
    const missing = path.join(BASE, 'beta');
    const { driver, run, close } = fakeDriver([
      { name: 'alpha', root: existing },
      { name: 'beta', root: missing },
    ]);
    const watch = vi.fn();
    const log = vi.fn();
    await startCodeWatchOnBoot({
      driver: driver as never,
      watcher: { watch },
      allowedBaseDir: BASE,
      exists: async (p) => p === existing,
      log,
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(String(run.mock.calls[0]?.[0])).toContain("MATCH (e:Entity {type: 'project'}) WHERE e.root_path IS NOT NULL");
    expect(watch).toHaveBeenCalledTimes(1);
    expect(watch).toHaveBeenCalledWith(existing);
    expect(log).toHaveBeenCalledWith('[code-watch] watching alpha');
    expect(log).toHaveBeenCalledWith('[code-watch] root missing on disk, skipped: beta');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('skips a root outside the allowed base and never logs its path', async () => {
    const outside = path.resolve('/etc/secret-project');
    const { driver } = fakeDriver([{ name: 'evil', root: outside }]);
    const watch = vi.fn();
    const log = vi.fn();
    await startCodeWatchOnBoot({
      driver: driver as never,
      watcher: { watch },
      allowedBaseDir: BASE,
      exists: async () => true,
      log,
    });
    expect(watch).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('[code-watch] root outside allowed base, skipped: evil');
    expect(log.mock.calls.flat().join('\n')).not.toContain('secret-project');
  });

  it('the base dir itself is confined; a sibling with the base as a prefix is not', async () => {
    const { driver } = fakeDriver([
      { name: 'base', root: BASE },
      { name: 'sib', root: BASE + '-evil' },
    ]);
    const watch = vi.fn();
    const log = vi.fn();
    await startCodeWatchOnBoot({ driver: driver as never, watcher: { watch }, allowedBaseDir: BASE, exists: async () => true, log });
    expect(watch).toHaveBeenCalledTimes(1);
    expect(watch).toHaveBeenCalledWith(BASE);
    expect(log).toHaveBeenCalledWith('[code-watch] root outside allowed base, skipped: sib');
  });

  it('a driver rejection is logged by error class (never message) and does not throw', async () => {
    const { driver } = fakeDriver(new RangeError('secret-bearing message'));
    const watch = vi.fn();
    const log = vi.fn();
    await expect(startCodeWatchOnBoot({
      driver: driver as never,
      watcher: { watch },
      allowedBaseDir: BASE,
      exists: async () => true,
      log,
    })).resolves.toBeUndefined();
    expect(watch).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('[code-watch] boot watch failed: RangeError');
    expect(log.mock.calls.flat().join('\n')).not.toContain('secret-bearing');
  });

  it('a throwing watch() is logged by class and the remaining roots are still armed', async () => {
    const a = path.join(BASE, 'a');
    const b = path.join(BASE, 'b');
    const { driver } = fakeDriver([{ name: 'a', root: a }, { name: 'b', root: b }]);
    const watch = vi.fn((root: string) => { if (root === a) throw new TypeError('secret-bearing'); });
    const log = vi.fn();
    await startCodeWatchOnBoot({ driver: driver as never, watcher: { watch }, allowedBaseDir: BASE, exists: async () => true, log });
    expect(watch).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith('[code-watch] watch failed: TypeError, skipped: a');
    expect(log).toHaveBeenCalledWith('[code-watch] watching b');
    expect(log.mock.calls.flat().join('\n')).not.toContain('secret-bearing');
  });
});

describe('bootstrap.ts code-watch-on-boot wiring', () => {
  it('fires after consolidationCoordinator.start() and the lifecycle wiring, behind a loose flag that defaults off, non-blocking', () => {
    const start = BOOTSTRAP_SOURCE.indexOf('consolidationCoordinator.start();');
    const lifecycle = BOOTSTRAP_SOURCE.indexOf('resolveLifecycleConfig(defaultExportPath())');
    const flag = BOOTSTRAP_SOURCE.indexOf("parseBoolFlag(readEnv('MEMBERRY_CODE_WATCH_ON_BOOT'), false)");
    expect(start).toBeGreaterThan(0);
    expect(lifecycle).toBeGreaterThan(start);
    expect(flag).toBeGreaterThan(lifecycle);
    // Not awaited: the query must never delay bootstrap's return.
    expect(BOOTSTRAP_SOURCE).toMatch(/void startCodeWatchOnBoot\(\{/);
    expect(BOOTSTRAP_SOURCE).not.toMatch(/await startCodeWatchOnBoot\(/);
    expect(BOOTSTRAP_SOURCE).toContain('watcher: codeWatcherService');
    expect(BOOTSTRAP_SOURCE).toContain('allowedBaseDir: getAllowedBaseDir()');
    // Flag inventory line for item 20a, same shape as MEMBERRY_LIFECYCLE_INTERVAL_MS.
    expect(BOOTSTRAP_SOURCE).toMatch(/\/\/ MEMBERRY_CODE_WATCH_ON_BOOT — .*default off.*\(flag inventory: item 20a\)/);
  });
});
