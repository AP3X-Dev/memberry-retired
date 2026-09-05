// packages/mcp/src/__tests__/ingest-codebase.test.ts
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises';
import { join, resolve } from 'path';
import {
  buildToolHandlers,
  setServiceInstances,
  type IAMPService,
  type IConsolidationEngine,
  type IScopedQuery,
  type IBootstrapGraphService,
  type IMemoryBlockService,
  type ICodeIndexerService,
} from '../tools.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockAmpService: IAMPService = {
  load: vi.fn().mockResolvedValue({ markdown: '', tokens: 0, sources: [], assembled_at: '' }),
  store: vi.fn().mockResolvedValue({ id: 'ep-1', duplicate: false }),
};

const mockConsolidationEngine: IConsolidationEngine = {
  run: vi.fn().mockResolvedValue({}),
  status: vi.fn().mockResolvedValue({}),
  review: vi.fn().mockResolvedValue({}),
  apply: vi.fn().mockResolvedValue({ applied: true }),
};

const mockScopedQuery: IScopedQuery = {
  rawCypher: vi.fn().mockResolvedValue([]),
};

const mockBootstrapService: IBootstrapGraphService = {
  bootstrap: vi.fn().mockResolvedValue({
    entities_created: 5,
    entities_existing: 0,
    agents_created: 1,
    agents_existing: 0,
    semantics_created: 2,
    relationships_created: 4,
    project_entity_id: 'ent-test',
  }),
  isBootstrapped: vi.fn().mockResolvedValue(false),
  status: vi.fn().mockResolvedValue({ bootstrapped: false }),
};

const mockMemoryBlockService: IMemoryBlockService = {
  read: vi.fn().mockResolvedValue(null),
  insert: vi.fn().mockResolvedValue({ id: 'b-1', name: 'test', tier: 'core', content: '', scope: '' }),
  replace: vi.fn().mockResolvedValue({ id: 'b-1', name: 'test', tier: 'core', content: '', scope: '' }),
  rewrite: vi.fn().mockResolvedValue({ id: 'b-1', name: 'test', tier: 'core', content: '', scope: '' }),
  promote: vi.fn().mockResolvedValue({ id: 'b-1', name: 'test', tier: 'core', content: '', scope: '' }),
  archive: vi.fn().mockResolvedValue(''),
};

const mockCodeIndexer: ICodeIndexerService = {
  indexProject: vi.fn().mockResolvedValue({
    files_parsed: 10,
    files_skipped: 2,
    symbols_created: 50,
    symbols_updated: 0,
    relations_created: 30,
    errors: [],
  }),
  // T6/gap-12: bridge that links indexed Component file nodes to module/project
  // entities so the wiki can discover them. Mocked here to keep these unit tests
  // service-free; the real bridge is live-tested in component-project-bridge.live.test.ts.
  linkComponentsToProject: vi.fn().mockResolvedValue(2),
};

// ─── Temp project ─────────────────────────────────────────────────────────────

let tempDir: string;

beforeAll(async () => {
  // berry_ingest_codebase confines `path` to process.cwd() (mirroring the
  // sibling code tools), so the legitimate fixture project must live under cwd
  // for ingestion to be accepted.
  tempDir = await mkdtemp(join(process.cwd(), 'amp-ingest-test-'));

  await writeFile(
    join(tempDir, 'package.json'),
    JSON.stringify({
      name: 'my-test-app',
      description: 'A test application',
      dependencies: { react: '^18.0.0' },
    }),
  );

  await mkdir(join(tempDir, 'src'), { recursive: true });
  await writeFile(join(tempDir, 'src', 'index.ts'), 'export const main = () => {};\n');
  await writeFile(join(tempDir, 'src', 'app.ts'), 'export class App {}\n');
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  setServiceInstances({
    ampService: mockAmpService,
    consolidationEngine: mockConsolidationEngine,
    scopedQuery: mockScopedQuery,
    bootstrapService: mockBootstrapService,
    memoryBlockService: mockMemoryBlockService,
    codeIndexer: mockCodeIndexer,
  });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('berry_ingest_codebase handler', () => {
  it('scans, bootstraps, indexes, and seeds in one call', async () => {
    const handlers = buildToolHandlers();
    const result = await handlers.berry_ingest_codebase({ path: tempDir });

    // Should have called bootstrap
    expect(mockBootstrapService.bootstrap).toHaveBeenCalledTimes(1);
    const bootstrapArgs = (mockBootstrapService.bootstrap as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(bootstrapArgs.project_name).toBe('my-test-app');
    expect(bootstrapArgs.project_tag).toBe('project:my-test-app');
    expect(bootstrapArgs.description).toBe('A test application');

    // Item 14a: the confined absolute ingest root is persisted on the project
    // entity only (modules carry no root_path) so the watcher can restart at boot.
    const projectEntity = bootstrapArgs.entities.find((e: { type: string }) => e.type === 'project');
    expect(projectEntity.root_path).toBe(resolve(tempDir));
    for (const e of bootstrapArgs.entities.filter((e: { type: string }) => e.type !== 'project')) {
      expect(e).not.toHaveProperty('root_path');
    }

    // Should have called code indexer
    expect(mockCodeIndexer.indexProject).toHaveBeenCalledTimes(1);

    // T6/gap-12: should have run the component→project wiki bridge with the
    // resolved project name so indexed file nodes become wiki-discoverable.
    expect(mockCodeIndexer.linkComponentsToProject).toHaveBeenCalledTimes(1);
    // OPT-2: the bridge now also receives the scanner's module list (with relPath)
    // so it can map components to the real per-package module by longest dir prefix.
    expect(mockCodeIndexer.linkComponentsToProject).toHaveBeenCalledWith(tempDir, 'my-test-app', expect.any(Array));

    // Should have seeded memory blocks
    expect(mockMemoryBlockService.insert).toHaveBeenCalledTimes(2);

    // Should return summary markdown
    const text = result.content[0].text;
    expect(text).toContain('Codebase Ingestion Complete');
    expect(text).toContain('my-test-app');
    expect(text).toContain('project:my-test-app');
    expect(text).toContain('Files indexed:** 10');
    expect(text).toContain('Symbols created:** 50');
  });

  it('uses user-provided overrides over auto-detection', async () => {
    const handlers = buildToolHandlers();
    await handlers.berry_ingest_codebase({
      path: tempDir,
      project_name: 'custom-name',
      project_tag: 'project:custom',
      description: 'Custom description',
      domain: 'custom-domain',
    });

    const bootstrapArgs = (mockBootstrapService.bootstrap as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(bootstrapArgs.project_name).toBe('custom-name');
    expect(bootstrapArgs.project_tag).toBe('project:custom');
    expect(bootstrapArgs.description).toBe('Custom description');
    expect(bootstrapArgs.domain).toBe('custom-domain');
  });

  it('passes exclude patterns to code indexer', async () => {
    const handlers = buildToolHandlers();
    await handlers.berry_ingest_codebase({
      path: tempDir,
      exclude_patterns: ['vendor', 'generated'],
    });

    // T5/gap-11: the resolved canonical project tag is threaded into indexProject
    // so indexed symbols are stamped with s.project_tag. Default project name
    // 'my-test-app' (from the mock scan) → 'project:my-test-app'.
    expect(mockCodeIndexer.indexProject).toHaveBeenCalledWith(
      tempDir,
      { exclude: ['vendor', 'generated'], projectTag: 'project:my-test-app' },
    );
  });

  it('works without code indexer (graceful degradation)', async () => {
    // Set up without code indexer
    setServiceInstances({
      ampService: mockAmpService,
      consolidationEngine: mockConsolidationEngine,
      scopedQuery: mockScopedQuery,
      bootstrapService: mockBootstrapService,
      memoryBlockService: mockMemoryBlockService,
      // No codeIndexer
    });

    const handlers = buildToolHandlers();
    const result = await handlers.berry_ingest_codebase({ path: tempDir });

    // Should still bootstrap
    expect(mockBootstrapService.bootstrap).toHaveBeenCalledTimes(1);

    // Should return summary with zero index counts
    const text = result.content[0].text;
    expect(text).toContain('Files indexed:** 0');
    expect(text).toContain('Symbols created:** 0');
  });

  it('works without memory block service', async () => {
    setServiceInstances({
      ampService: mockAmpService,
      consolidationEngine: mockConsolidationEngine,
      scopedQuery: mockScopedQuery,
      bootstrapService: mockBootstrapService,
      codeIndexer: mockCodeIndexer,
      // No memoryBlockService
    });

    const handlers = buildToolHandlers();
    const result = await handlers.berry_ingest_codebase({ path: tempDir });

    const text = result.content[0].text;
    expect(text).toContain('Memory blocks seeded:** 0');
  });

  it('generates correct project tag from name with special characters', async () => {
    const handlers = buildToolHandlers();
    await handlers.berry_ingest_codebase({
      path: tempDir,
      project_name: 'My Cool Project!',
    });

    const bootstrapArgs = (mockBootstrapService.bootstrap as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(bootstrapArgs.project_tag).toBe('project:my-cool-project');
  });

  it('throws when bootstrap service is not initialised', async () => {
    setServiceInstances({
      ampService: mockAmpService,
      consolidationEngine: mockConsolidationEngine,
      scopedQuery: mockScopedQuery,
      bootstrapService: null as unknown as IBootstrapGraphService,
    });

    const handlers = buildToolHandlers();
    await expect(handlers.berry_ingest_codebase({ path: tempDir })).rejects.toThrow(
      'BootstrapGraphService not initialised',
    );
  });

  it('includes indexing errors in the summary', async () => {
    (mockCodeIndexer.indexProject as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      files_parsed: 8,
      files_skipped: 4,
      symbols_created: 30,
      symbols_updated: 0,
      relations_created: 20,
      errors: [
        { file: 'broken.ts', error: 'Syntax error' },
        { file: 'bad.ts', error: 'Parse failed' },
      ],
    });

    const handlers = buildToolHandlers();
    const result = await handlers.berry_ingest_codebase({ path: tempDir });

    const text = result.content[0].text;
    expect(text).toContain('Indexing errors:** 2');
    expect(text).toContain('broken.ts: Syntax error');
    expect(text).toContain('bad.ts: Parse failed');
  });

  it('creates semantic seeds for description and languages', async () => {
    const handlers = buildToolHandlers();
    await handlers.berry_ingest_codebase({ path: tempDir });

    const bootstrapArgs = (mockBootstrapService.bootstrap as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(bootstrapArgs.semantic_seeds.length).toBeGreaterThanOrEqual(2);

    // gap-16: the project-overview seed now leads with the description but is
    // enriched with the module list (the fixture's src/ becomes a 'src' module),
    // so it is substantive rather than a bare one-liner.
    const descSeed = bootstrapArgs.semantic_seeds.find(
      (s: { domain: string }) => s.domain === 'project-overview',
    );
    expect(descSeed).toBeDefined();
    expect(descSeed.claim).toContain('A test application');
    expect(descSeed.claim).toContain('Modules:');
    expect(descSeed.about).toEqual(['my-test-app']);

    const langSeed = bootstrapArgs.semantic_seeds.find(
      (s: { claim: string }) => s.claim.includes('built with'),
    );
    expect(langSeed).toBeDefined();
    expect(langSeed.domain).toBe('technology');
  });

  it('gap-16: generates per-module semantic seeds so module pages are not stubs', async () => {
    const handlers = buildToolHandlers();
    await handlers.berry_ingest_codebase({ path: tempDir });

    const bootstrapArgs = (mockBootstrapService.bootstrap as ReturnType<typeof vi.fn>).mock.calls[0][0];

    // The real scanner discovers the fixture's src/ as a module. Every module
    // entity must own at least one ABOUT seed (responsibility + relationship).
    const moduleEntities = bootstrapArgs.entities.filter(
      (e: { type: string }) => e.type !== 'project',
    );
    expect(moduleEntities.length).toBeGreaterThanOrEqual(1);

    for (const mod of moduleEntities) {
      const moduleSeeds = bootstrapArgs.semantic_seeds.filter(
        (s: { about?: string[] }) => (s.about ?? []).includes(mod.name),
      );
      expect(moduleSeeds.length).toBeGreaterThanOrEqual(1);

      // RESPONSIBILITY seed: "<name> is a <type> module".
      const responsibility = moduleSeeds.find((s: { claim: string }) =>
        s.claim.startsWith(`${mod.name} is a `) && s.claim.includes('module'),
      );
      expect(responsibility).toBeDefined();
      expect(responsibility.domain).toBe('architecture');

      // RELATIONSHIP-SUMMARY seed: "<name> is part of <project>".
      const relationship = moduleSeeds.find((s: { claim: string }) =>
        s.claim.includes(`is part of ${bootstrapArgs.project_name}`),
      );
      expect(relationship).toBeDefined();
    }
  });

  it('gap-16: skips exact-duplicate claim strings within one run', async () => {
    const handlers = buildToolHandlers();
    await handlers.berry_ingest_codebase({ path: tempDir });

    const bootstrapArgs = (mockBootstrapService.bootstrap as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const claims = bootstrapArgs.semantic_seeds.map((s: { claim: string }) => s.claim);
    expect(new Set(claims).size).toBe(claims.length);
  });

  // ─── OPT-15: path confinement ────────────────────────────────────────────────
  // berry_ingest_codebase previously accepted any absolute/relative path with no
  // restriction, unlike its sibling code tools (berry_code_index,
  // berry_code_ast_grep, berry_code_watch) which confine `path` to process.cwd().
  // These mirror the siblings' confinement: same root, same error shape
  // ("Path must be within project root: <arg>").

  it('OPT-15: rejects a relative `..` traversal path outside the project root', async () => {
    const handlers = buildToolHandlers();
    await expect(handlers.berry_ingest_codebase({ path: '../../etc' })).rejects.toThrow(
      'Path must be within project root',
    );
    // Confinement must trip BEFORE any scan/bootstrap/index work happens.
    expect(mockBootstrapService.bootstrap).not.toHaveBeenCalled();
    expect(mockCodeIndexer.indexProject).not.toHaveBeenCalled();
  });

  it('OPT-15: rejects an absolute path outside the project root', async () => {
    const handlers = buildToolHandlers();
    // Resolves outside cwd on every platform (parent of cwd + sibling dir).
    const outside = resolve(process.cwd(), '..', 'totally-outside-amp-opt');
    await expect(handlers.berry_ingest_codebase({ path: outside })).rejects.toThrow(
      `Path must be within project root: ${outside}`,
    );
    expect(mockBootstrapService.bootstrap).not.toHaveBeenCalled();
  });

  it('OPT-15: rejects a sibling dir that shares the root as a string prefix', async () => {
    const handlers = buildToolHandlers();
    // `${cwd}EVIL` starts with cwd lexically but is NOT inside `cwd + sep`.
    const lookalike = process.cwd() + 'EVIL';
    await expect(handlers.berry_ingest_codebase({ path: lookalike })).rejects.toThrow(
      'Path must be within project root',
    );
    expect(mockBootstrapService.bootstrap).not.toHaveBeenCalled();
  });

  it('OPT-15: accepts a legitimate in-root path (no over-rejection)', async () => {
    // tempDir lives under process.cwd(), so ingestion must proceed normally.
    const handlers = buildToolHandlers();
    const result = await handlers.berry_ingest_codebase({ path: tempDir });

    expect(mockBootstrapService.bootstrap).toHaveBeenCalledTimes(1);
    expect(mockCodeIndexer.indexProject).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain('Codebase Ingestion Complete');
  });
});
