// packages/core/src/__tests__/test-files.inventory.test.ts
//
// Item 35: test-files.manifest.txt is the committed inventory of every test file
// in the repository. Metric 1 counts tests that RAN, so a deleted or renamed-away
// test FILE is invisible to it. This test greps the tree so that
//   - a test file on disk that is not in the manifest fails naming it, and
//   - a manifest path with no file on disk fails naming it.
//
// The second direction is the point: removing a test now requires deleting its
// manifest line, which makes the removal a reviewable line in the diff instead of
// something a reader has to notice.
//
// A "test file" is any path matching **/*.test.ts under the repository root,
// excluding node_modules, dist, coverage and dot-directories (the same exclusion
// set as eslint.config.mjs). That glob is the whole rule: every vitest suite in
// this repo is named *.test.ts, and there are no *.spec.* or *.test.js sources.
// The walk starts from a path resolved off __dirname, so it does not depend on
// the working directory vitest was launched from.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/** packages/core/src/__tests__ -> repository root. */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const MANIFEST_FILE = path.join(__dirname, 'test-files.manifest.txt');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage']);
const TEST_FILE = /\.test\.ts$/;

function globTestFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) walk(full);
      } else if (TEST_FILE.test(entry.name)) {
        found.push(path.relative(REPO_ROOT, full).replace(/\\/g, '/'));
      }
    }
  };
  walk(REPO_ROOT);
  return found.sort();
}

function readManifest(): string[] {
  return fs
    .readFileSync(MANIFEST_FILE, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

describe('test file manifest', () => {
  const onDisk = globTestFiles();
  const manifest = readManifest();

  it('globs a non-trivial tree', () => {
    // Guards the vacuous pass: a broken walk returning nothing would otherwise
    // make the "on disk but not in the manifest" direction always green.
    expect(onDisk.length).toBeGreaterThan(300);
  });

  it('lists every test file on disk', () => {
    const known = new Set(manifest);
    const unlisted = onDisk.filter((file) => !known.has(file));
    expect(
      unlisted,
      'new test files — add them to packages/core/src/__tests__/test-files.manifest.txt',
    ).toEqual([]);
  });

  it('has no manifest entry without a file on disk', () => {
    const present = new Set(onDisk);
    const missing = manifest.filter((file) => !present.has(file));
    expect(
      missing,
      'test files that vanished — if the removal is intended, delete these lines from packages/core/src/__tests__/test-files.manifest.txt in the same diff',
    ).toEqual([]);
  });

  it('is sorted and free of duplicates', () => {
    expect(manifest, 'manifest is not sorted').toEqual([...manifest].sort());
    const seen = new Set<string>();
    const duplicates = manifest.filter((file) => !seen.add(file));
    expect(duplicates, 'duplicate manifest entries').toEqual([]);
  });
});
