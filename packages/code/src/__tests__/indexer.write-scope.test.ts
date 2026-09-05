// packages/code/src/__tests__/indexer.write-scope.test.ts
// Pins the indexer's write-path scoping (opt #8, A2 + A4):
//   (a) `indexProject({ skipTests })` drops `isTestPath` files from the walk;
//       default false keeps today's baseline (test files ARE indexed).
//   (b) `ensureFileEntities` stamps `project_scope` on the Component MERGE,
//       carrying the canonical `project:<slug>` tag (null when unscoped).

import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, sep } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  parseFile: vi.fn(),
  symbolStore: {
    getHashesByFile: vi.fn(),
    upsertSymbols: vi.fn(),
    getByFile: vi.fn(),
  },
  resolveImportsBatch: vi.fn(),
  linkAllSymbolsToEntities: vi.fn(),
}));

vi.mock('../parser.js', () => ({ parseFile: mocks.parseFile }));
vi.mock('../symbol-store.js', () => ({ SymbolStore: vi.fn(() => mocks.symbolStore) }));
vi.mock('../resolver.js', () => ({
  ImportResolver: vi.fn(() => ({
    resolveImportsBatch: mocks.resolveImportsBatch,
    linkAllSymbolsToEntities: mocks.linkAllSymbolsToEntities,
  })),
}));

function makeDriver() {
  const session = {
    run: vi.fn(async () => ({ records: [{ get: () => 0 }] })),
    close: vi.fn(),
  };
  return { driver: { session: vi.fn(() => session) }, session };
}

// Root-relative, forward-slash path for cross-platform assertions.
function rel(p: unknown, root: string): string {
  return String(p).slice(root.length).split(sep).join('/');
}

function componentMergeCall(session: ReturnType<typeof makeDriver>['session']) {
  const call = session.run.mock.calls.find(
    ([q]) => typeof q === 'string' && q.includes('MERGE (e:Entity:Component'),
  ) as [string, Record<string, unknown>] | undefined;
  expect(call, 'ensureFileEntities query issued').toBeDefined();
  return { query: call![0], params: call![1] };
}

describe('CodeIndexer.indexProject write-path scoping', () => {
  let root: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.parseFile.mockImplementation(async (file_path: string) => ({
      file_path, language: 'typescript', symbols: [], imports: [], relations: [],
    }));
    mocks.symbolStore.getHashesByFile.mockResolvedValue(new Set<string>());
    mocks.symbolStore.getByFile.mockResolvedValue([]);
    mocks.resolveImportsBatch.mockResolvedValue(0);
    mocks.linkAllSymbolsToEntities.mockResolvedValue(0);

    root = await mkdtemp(join(tmpdir(), 'amp-idx-scope-'));
    await mkdir(join(root, 'src', '__tests__'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    await writeFile(join(root, 'src', 'a.test.ts'), 'export const t = 1;\n');
    await writeFile(join(root, 'src', '__tests__', 'b.ts'), 'export const b = 1;\n');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('default (skipTests unset) indexes test files too — baseline preserved', async () => {
    const { CodeIndexer } = await import('../indexer.js');
    const { driver } = makeDriver();
    const result = await new CodeIndexer(driver as never).indexProject(root);

    expect(result.files_parsed).toBe(3);
    const parsed = mocks.parseFile.mock.calls.map(([p]) => rel(p, root)).sort();
    expect(parsed).toEqual(['/src/__tests__/b.ts', '/src/a.test.ts', '/src/a.ts']);
  });

  it('skipTests: true drops isTestPath files from the walk', async () => {
    const { CodeIndexer } = await import('../indexer.js');
    const { driver, session } = makeDriver();
    const result = await new CodeIndexer(driver as never).indexProject(root, { skipTests: true });

    expect(result.files_parsed).toBe(1);
    expect(mocks.parseFile.mock.calls.map(([p]) => rel(p, root))).toEqual(['/src/a.ts']);
    // The Component MERGE sees the same filtered set — no test-file entities.
    const { params } = componentMergeCall(session);
    expect((params.paths as string[]).map((p) => rel(p, root))).toEqual(['/src/a.ts']);
  });

  it('ensureFileEntities stamps project_scope from projectTag', async () => {
    const { CodeIndexer } = await import('../indexer.js');
    const { driver, session } = makeDriver();
    await new CodeIndexer(driver as never).indexProject(root, { projectTag: 'project:memberry' });

    const { query, params } = componentMergeCall(session);
    expect(query).toContain('ON CREATE SET');
    expect(query).toContain('e.project_scope = $projectScope');
    // Existing NULL-scope rows heal on re-index without clobbering a set scope.
    expect(query).toContain('ON MATCH SET e.project_scope = coalesce(e.project_scope, $projectScope)');
    expect(params.projectScope).toBe('project:memberry');
  });

  it('ensureFileEntities passes projectScope null when no projectTag is given', async () => {
    const { CodeIndexer } = await import('../indexer.js');
    const { driver, session } = makeDriver();
    await new CodeIndexer(driver as never).indexProject(root);

    const { params } = componentMergeCall(session);
    expect(params).toHaveProperty('projectScope', null);
  });
});
