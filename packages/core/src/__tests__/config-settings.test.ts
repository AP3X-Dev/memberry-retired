// packages/core/src/__tests__/config-settings.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadSettings,
  loadRawSettings,
  saveSettings,
  getSettingsPath,
  resolveNumber,
  DEFAULT_SETTINGS,
} from '../config/settings.js';
import { getConfigStatus } from '../config/status.js';

let dir: string;
let file: string;
const ENV = process.env;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-cfg-'));
  file = path.join(dir, 'settings.json');
  process.env.AMP_SETTINGS_PATH = file;
  delete process.env.AMP_HOOK_TIMEOUT_MS;
  delete process.env.AMP_HOOK_TURN_TOKENS;
  delete process.env.AMP_HOOK_SESSION_TIMEOUT_MS;
});
afterEach(() => {
  delete process.env.AMP_SETTINGS_PATH;
  delete ENV.AMP_HOOK_TIMEOUT_MS;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('settings store', () => {
  it('getSettingsPath honours AMP_SETTINGS_PATH', () => {
    expect(getSettingsPath()).toBe(file);
  });

  it('returns defaults when no file exists', () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    expect(loadRawSettings()).toBeNull();
  });

  it('saves a patch, merges with current, and reads it back', () => {
    saveSettings({ hooks: { timeoutMs: 1234, turnTokens: 2222, sessionTimeoutMs: 9999 } });
    expect(fs.existsSync(file)).toBe(true);
    expect(loadSettings().hooks.timeoutMs).toBe(1234);
    saveSettings({ hooks: { ...loadSettings().hooks, turnTokens: 3333 } });
    expect(loadSettings().hooks.turnTokens).toBe(3333);
    expect(loadSettings().hooks.timeoutMs).toBe(1234); // preserved
  });

  it('survives a corrupt file by falling back to defaults', () => {
    fs.writeFileSync(file, '{ not json');
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    expect(loadRawSettings()).toBeNull();
  });
});

describe('resolveNumber precedence (env > file > default)', () => {
  it('uses default when nothing else is set', () => {
    expect(resolveNumber('AMP_HOOK_TIMEOUT_MS', NaN, 800)).toEqual({ value: 800, source: 'default' });
  });
  it('uses the file value over the default', () => {
    expect(resolveNumber('AMP_HOOK_TIMEOUT_MS', 1500, 800)).toEqual({ value: 1500, source: 'file' });
  });
  it('uses the env var over the file value', () => {
    process.env.AMP_HOOK_TIMEOUT_MS = '250';
    expect(resolveNumber('AMP_HOOK_TIMEOUT_MS', 1500, 800)).toEqual({ value: 250, source: 'env' });
  });
});

describe('getConfigStatus source attribution', () => {
  it('does not expose admission shadow configuration through wiki settings', () => {
    expect(getConfigStatus().server).not.toHaveProperty('admissionShadow');
  });

  it('reports default before any save', () => {
    expect(getConfigStatus().hookTuning.timeoutMs).toEqual({ value: 800, source: 'default' });
  });
  it('reports file after a save', () => {
    saveSettings({ hooks: { ...loadSettings().hooks, timeoutMs: 999 } });
    expect(getConfigStatus().hookTuning.timeoutMs).toEqual({ value: 999, source: 'file' });
  });
  it('reports env when an env override is present', () => {
    saveSettings({ hooks: { ...loadSettings().hooks, timeoutMs: 999 } });
    process.env.AMP_HOOK_TIMEOUT_MS = '321';
    expect(getConfigStatus().hookTuning.timeoutMs).toEqual({ value: 321, source: 'env' });
  });
  it('surfaces live env-derived server facts', () => {
    const prev = process.env.AMP_REQUIRE_PROJECT_TAG;
    process.env.AMP_REQUIRE_PROJECT_TAG = 'false';
    expect(getConfigStatus().server.requireProjectTag).toBe(false);
    if (prev === undefined) delete process.env.AMP_REQUIRE_PROJECT_TAG;
    else process.env.AMP_REQUIRE_PROJECT_TAG = prev;
  });
  it('reports the effective consolidation auto-apply environment', () => {
    const prev = process.env.MEMBERRY_CONSOLIDATION_AUTO_APPLY;
    process.env.MEMBERRY_CONSOLIDATION_AUTO_APPLY = 'true';
    expect(getConfigStatus().server.consolidation.autoApply).toBe(true);
    if (prev === undefined) delete process.env.MEMBERRY_CONSOLIDATION_AUTO_APPLY;
    else process.env.MEMBERRY_CONSOLIDATION_AUTO_APPLY = prev;
  });
});
