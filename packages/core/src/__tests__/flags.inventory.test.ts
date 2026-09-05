// packages/core/src/__tests__/flags.inventory.test.ts
//
// Item 20a: MEMBERRY_FLAGS is the single source of truth for every MEMBERRY_*
// env read under packages/*/src. This test greps the source tree so that
//   - a new read of an undeclared MEMBERRY_ name fails naming it, and
//   - a declared flag whose last read site is deleted fails as stale.
//
// A "read site" is either a whole string literal equal to the name
// ('MEMBERRY_X' — readEnv('…'), env['…'], pick(env, '…'), positiveInt('…', …),
// parseBoundedInt('…', …), and `const FLAG = 'MEMBERRY_X'` constants later
// passed to process.env[FLAG]) or a `process.env.MEMBERRY_X` property access.
// Comments are stripped first, so mentions in prose, log messages
// ('… (MEMBERRY_READONLY=true) …') and shell snippets do not count.

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { MEMBERRY_FLAGS, warnUnknownMemberryEnv } from '../config/flags.js';

const PACKAGES_ROOT = path.resolve(__dirname, '..', '..', '..');
const SKIP_DIRS = new Set(['__tests__', 'dist', 'node_modules']);
/** The declaration file itself is not a read site (else the stale check is vacuous). */
const DECLARATION_FILE = path.resolve(__dirname, '..', 'config', 'flags.ts');
const SOURCE_EXT = /\.(ts|mts|cts|js|mjs)$/;

/**
 * Tokens the raw grep sees that are provably NOT env variable names. The read
 * rule above already ignores them (none is a whole string literal or a
 * process.env access); they are listed so the exclusion is explicit.
 */
const NOT_ENV_NAMES: ReadonlyArray<[token: string, reason: string]> = [
  ['MEMBERRY_LOGO_ASSET', 'identifier: a URL constant in packages/wiki/src/viewer.ts, never an env key'],
  ['MEMBERRY_MODEL_', 'prefix in a comment (services-factory.ts) naming the MEMBERRY_MODEL_* family'],
  ['MEMBERRY_PROMOTE_', 'prefix in a comment (types.ts) naming the MEMBERRY_PROMOTE_* family'],
  ['MEMBERRY_TRACE_VALIDATION_STAGE', 'stderr diagnostic line label in retrieval/src/tools.ts (`…_STAGE=<stage>`), not read from env'],
  ['MEMBERRY_FLAGS', 'the inventory export itself'],
];

function stripComments(src: string): string {
  return src
    // Keep the newlines so reported line numbers stay accurate.
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ''))
    // `//` only when it starts a line or follows whitespace, so `http://` in
    // string literals survives.
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

function collectReadSites(): Map<string, string[]> {
  const sites = new Map<string, string[]>();
  const re = /(['"`])(MEMBERRY_[A-Z0-9_]+)\1|process\.env\.(MEMBERRY_[A-Z0-9_]+)/g;
  const scan = (file: string): void => {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const token = (m[2] ?? m[3]) as string;
      const line = src.slice(0, m.index).split('\n').length;
      const list = sites.get(token) ?? [];
      list.push(`${path.relative(PACKAGES_ROOT, file).replace(/\\/g, '/')}:${line}`);
      sites.set(token, list);
    }
  };
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (SOURCE_EXT.test(entry.name) && full !== DECLARATION_FILE) {
        scan(full);
      }
    }
  };
  for (const pkg of fs.readdirSync(PACKAGES_ROOT)) {
    const src = path.join(PACKAGES_ROOT, pkg, 'src');
    if (fs.existsSync(src) && fs.statSync(src).isDirectory()) walk(src);
  }
  for (const [token] of NOT_ENV_NAMES) sites.delete(token);
  return sites;
}

describe('MEMBERRY_FLAGS inventory', () => {
  const readSites = collectReadSites();
  const declared = new Set(MEMBERRY_FLAGS.map((flag) => flag.name));

  it('walks a non-trivial source tree', () => {
    expect(readSites.size).toBeGreaterThan(50);
  });

  it('declares every MEMBERRY_ name read under packages/*/src', () => {
    const undeclared = [...readSites.entries()]
      .filter(([token]) => !declared.has(token))
      .map(([token, where]) => `${token} (read at ${where.join(', ')})`);
    expect(undeclared, 'undeclared flags — add them to packages/core/src/config/flags.ts').toEqual([]);
  });

  it('has no stale entry (a declared flag with no read site)', () => {
    const stale = [...declared].filter((name) => !readSites.has(name));
    expect(stale, 'stale flags — remove them from packages/core/src/config/flags.ts').toEqual([]);
  });

  it('has unique names, non-empty docs, and excludes the non-env tokens', () => {
    expect(new Set(MEMBERRY_FLAGS.map((flag) => flag.name)).size).toBe(MEMBERRY_FLAGS.length);
    for (const flag of MEMBERRY_FLAGS) {
      expect(flag.name, flag.name).toMatch(/^MEMBERRY_[A-Z0-9_]+$/);
      expect(flag.doc.trim().length, `${flag.name} doc`).toBeGreaterThan(0);
    }
    for (const [token] of NOT_ENV_NAMES) expect(declared.has(token), token).toBe(false);
  });

  it('declares the two flags waived in cycles 16 and 20', () => {
    expect(declared.has('MEMBERRY_LIFECYCLE_INTERVAL_MS')).toBe(true);
    expect(declared.has('MEMBERRY_CODE_WATCH_ON_BOOT')).toBe(true);
  });
});

describe('warnUnknownMemberryEnv', () => {
  it('logs one line per unknown MEMBERRY_ name, ignores known names, AMP_ aliases and everything else', () => {
    const log = vi.fn();
    const unknown = warnUnknownMemberryEnv(
      {
        MEMBERRY_READONLY: 'true',
        MEMBERRY_REDONLY: '1',
        MEMBERRY_LIFECYLE_INTERVAL_MS: '3600000',
        AMP_READONLY: 'true',
        AMP_NOT_A_FLAG: '1',
        PATH: '/usr/bin',
      },
      log,
    );
    expect(unknown).toEqual(['MEMBERRY_LIFECYLE_INTERVAL_MS', 'MEMBERRY_REDONLY']);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0]?.[0]).toContain('MEMBERRY_LIFECYLE_INTERVAL_MS');
    expect(log.mock.calls[1]?.[0]).toContain('MEMBERRY_REDONLY');
  });

  it('is silent when every MEMBERRY_ name is declared and never throws', () => {
    const log = vi.fn();
    expect(warnUnknownMemberryEnv({ MEMBERRY_HOST: '127.0.0.1', HOME: '/tmp' }, log)).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });
});
