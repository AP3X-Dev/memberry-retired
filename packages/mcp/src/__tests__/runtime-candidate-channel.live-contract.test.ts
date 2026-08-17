import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CHILD_TIMEOUT_MS = 45_000;
const OUTER_TIMEOUT_MS = 60_000;
const REQUIRED_TIMEOUT_MARGIN_MS = 10_000;

describe('RET-003B required live-mode contract', () => {
  it('exits nonzero before any database attempt when required mode lacks disposable opt-in', () => {
    const vitest = fileURLToPath(new URL('../../../../node_modules/vitest/vitest.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [
      vitest, 'run', 'packages/mcp/src/__tests__/runtime-candidate-channel.live.test.ts',
    ], {
      cwd: fileURLToPath(new URL('../../../..', import.meta.url)),
      env: {
        ...process.env,
        MEMBERRY_RET003B_LIVE_MODE: 'required',
        MEMBERRY_RET003B_DISPOSABLE_OPT_IN: '',
      },
      encoding: 'utf8', timeout: CHILD_TIMEOUT_MS,
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('ret003b_live:disposable_opt_in_required');
    expect(`${result.stdout}${result.stderr}`).not.toContain('database connection attempted');
  }, OUTER_TIMEOUT_MS);

  it('fails closed for an unrecognized nonempty live mode', () => {
    const vitest = fileURLToPath(new URL('../../../../node_modules/vitest/vitest.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [
      vitest, 'run', 'packages/mcp/src/__tests__/runtime-candidate-channel.live.test.ts',
    ], {
      cwd: fileURLToPath(new URL('../../../..', import.meta.url)),
      env: { ...process.env, MEMBERRY_RET003B_LIVE_MODE: 'typo-enabled' },
      encoding: 'utf8', timeout: CHILD_TIMEOUT_MS,
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('ret003b_live:invalid_mode');
  }, OUTER_TIMEOUT_MS);

  it('keeps a strict bounded outer margin over delayed nested child execution', () => {
    const controlledDelayMs = 25;
    const result = spawnSync(process.execPath, [
      '-e', `setTimeout(() => process.exit(7), ${controlledDelayMs})`,
    ], { encoding: 'utf8', timeout: CHILD_TIMEOUT_MS });
    expect(result.status).toBe(7);
    expect(OUTER_TIMEOUT_MS - CHILD_TIMEOUT_MS).toBeGreaterThanOrEqual(REQUIRED_TIMEOUT_MARGIN_MS);
  }, OUTER_TIMEOUT_MS);
});
