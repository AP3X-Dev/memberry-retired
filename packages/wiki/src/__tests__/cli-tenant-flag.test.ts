// packages/wiki/src/__tests__/cli-tenant-flag.test.ts
// Item 5b: `--tenant` reaches every WikiCompiler construction and the linter.
// cli.ts runs main() on import against a live driver, so this pins the wiring
// at source level rather than executing the CLI.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync(new URL('../cli.ts', import.meta.url), 'utf8');

describe('wiki CLI --tenant plumbing', () => {
  it('reads --tenant with DEFAULT_TENANT as the fallback', () => {
    expect(src).toMatch(/const tenantId = \(flags\['tenant'\] as string\) \?\? DEFAULT_TENANT/);
  });

  it('passes tenantId to every WikiCompiler construction', () => {
    const ctors = src.match(/new WikiCompiler\([^)]*\)/g) ?? [];
    expect(ctors).toHaveLength(2);
    for (const c of ctors) expect(c).toBe('new WikiCompiler(driver, { tenantId })');
  });

  it('passes tenantId to lint', () => {
    expect(src).toMatch(/linter\.lint\(\{[\s\S]*?\}, tenantId\)/);
  });
});
