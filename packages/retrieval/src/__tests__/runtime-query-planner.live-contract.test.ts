import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('RET-002C2 required live-mode contract', () => {
  it('exits nonzero before any database attempt when required mode lacks disposable opt-in', () => {
    const vitest = fileURLToPath(new URL('../../../../node_modules/vitest/vitest.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [
      vitest, 'run', 'packages/mcp/src/__tests__/runtime-query-planner.live.test.ts',
    ], {
      cwd: fileURLToPath(new URL('../../../..', import.meta.url)),
      env: {
        ...process.env,
        MEMBERRY_RET002C2_LIVE_MODE: 'required',
        MEMBERRY_RET002C2_DISPOSABLE_OPT_IN: '',
      },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('ret002c2_live:disposable_opt_in_required');
    expect(`${result.stdout}${result.stderr}`).not.toContain('database connection attempted');
  }, 30_000);
});
