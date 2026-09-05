// packages/mcp/src/codebase-scanner.ts
// Scans a codebase directory to discover project metadata, languages, modules,
// and source files for ingestion into the MemBerry knowledge graph.

import { readFile, readdir, stat } from 'fs/promises';
import { resolve, extname, join, relative, basename } from 'path';

// ─── Types ───────────────────────────────────────────────────────────────────

export type SupportedLanguage =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'sql'
  | 'terraform'
  | 'mcp-config';

export interface DiscoveredModule {
  name: string;
  type: string;
  description: string;
  parent?: string;
  /**
   * The module's directory relative to the project root, normalized to forward
   * slashes (e.g. `packages/core`, `src`, `src/auth`). Used by the code→wiki
   * bridge to map an indexed Component file to THIS module by longest
   * directory-prefix — so a component under `packages/core/...` resolves to the
   * `core` module the scanner named here, not the `packages` workspace root.
   */
  relPath?: string;
  /**
   * Additional retrieval names for the module. A workspace package whose
   * package.json name differs from its directory (e.g. `@memberry/core` in
   * `packages/core`) carries the npm name here so an agent hint naming the
   * package resolves to the same Entity as the directory name.
   */
  aliases?: string[];
}

export interface CodebaseScan {
  name: string;
  description: string;
  domain: string;
  languages: SupportedLanguage[];
  /** Absolute source paths normalized to forward slashes. */
  sourceFiles: string[];
  modules: DiscoveredModule[];
  /** Absolute entry-point paths normalized to forward slashes. */
  entryPoints: string[];
}

export interface ScanOptions {
  languages?: SupportedLanguage[];
  excludePatterns?: string[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

const LANGUAGE_EXTENSIONS: Record<string, SupportedLanguage> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.sql': 'sql',
  '.tf': 'terraform',
  '.tfvars': 'terraform',
  '.hcl': 'terraform',
};

const DEFAULT_EXCLUDE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
  '__pycache__', '.venv', 'venv', 'env', '.env', 'target',
  'vendor', '.amp', '.lab', '.yggdrasil', '.codebase',
  'coverage', '.nyc_output', '.cache', '.turbo', '.parcel-cache',
  '.svelte-kit', '.output', 'out',
]);

const DEFAULT_EXCLUDE_EXTENSIONS = new Set([
  '.min.js', '.min.css', '.map', '.d.ts',
]);

const ENTRY_POINT_NAMES = new Set([
  'main.ts', 'main.tsx', 'index.ts', 'index.tsx',
  'main.js', 'main.jsx', 'index.js', 'index.jsx',
  'main.py', '__main__.py', 'app.py', 'wsgi.py',
  'main.go', 'cmd/main.go',
  'main.rs', 'lib.rs',
]);

const TEST_PATTERNS = [
  /\.test\.\w+$/,
  /\.spec\.\w+$/,
  /__tests__\//,
  /\/test\//,
  /\/tests\//,
  /\.stories\.\w+$/,
];

const SOURCE_DIRS = new Set([
  'src', 'lib', 'app', 'cmd', 'pkg', 'internal', 'core', 'server',
  'client', 'api', 'services', 'modules', 'components',
]);

// ─── Scanner ─────────────────────────────────────────────────────────────────

/**
 * Scan a codebase directory to discover structure, languages, and source files.
 */
export async function scanCodebase(
  rootPath: string,
  options?: ScanOptions,
): Promise<CodebaseScan> {
  const absRoot = resolve(rootPath);
  const userExcludes = new Set(options?.excludePatterns ?? []);

  // 1. Detect project metadata from manifest files
  const metadata = await detectMetadata(absRoot);

  // 2. Walk the file tree and collect source files
  const allFiles = await walkSourceFiles(absRoot, userExcludes);

  // 3. Detect languages from file extensions
  const detectedLanguages = detectLanguages(allFiles);
  const languages = options?.languages ?? detectedLanguages;

  // 4. Filter files to requested languages
  const langExtensions = new Set<string>();
  for (const [ext, lang] of Object.entries(LANGUAGE_EXTENSIONS)) {
    if (languages.includes(lang)) langExtensions.add(ext);
  }
  const sourceFiles = allFiles.filter((f) => {
    const ext = extname(f);
    return langExtensions.has(ext) && !isTestFile(f);
  });

  // 5. Discover modules
  const modules = await discoverModules(absRoot, metadata, sourceFiles, userExcludes);

  // 6. Find entry points
  const entryPoints = sourceFiles.filter((f) => {
    const name = basename(f);
    const relPath = relative(absRoot, f);
    return ENTRY_POINT_NAMES.has(name) || ENTRY_POINT_NAMES.has(relPath);
  });

  return {
    name: metadata.name,
    description: metadata.description,
    domain: metadata.domain,
    languages,
    sourceFiles: sourceFiles.map(toPortablePath),
    modules,
    entryPoints: entryPoints.map(toPortablePath),
  };
}

// ─── Metadata detection ──────────────────────────────────────────────────────

interface ProjectMetadata {
  name: string;
  description: string;
  domain: string;
  workspaces?: string[];
}

async function detectMetadata(rootPath: string): Promise<ProjectMetadata> {
  // Try package.json first
  const packageJson = await readJsonSafe(join(rootPath, 'package.json'));
  if (packageJson) {
    return {
      name: (packageJson.name as string) ?? basename(rootPath),
      description: (packageJson.description as string) ?? '',
      domain: inferDomain(packageJson),
      workspaces: extractWorkspaces(packageJson),
    };
  }

  // Try pyproject.toml (basic key extraction)
  const pyproject = await readTextSafe(join(rootPath, 'pyproject.toml'));
  if (pyproject) {
    const name = extractTomlValue(pyproject, 'name') ?? basename(rootPath);
    const desc = extractTomlValue(pyproject, 'description') ?? '';
    return { name, description: desc, domain: 'python-project' };
  }

  // Try Cargo.toml
  const cargo = await readTextSafe(join(rootPath, 'Cargo.toml'));
  if (cargo) {
    const name = extractTomlValue(cargo, 'name') ?? basename(rootPath);
    const desc = extractTomlValue(cargo, 'description') ?? '';
    return { name, description: desc, domain: 'rust-project' };
  }

  // Try go.mod
  const gomod = await readTextSafe(join(rootPath, 'go.mod'));
  if (gomod) {
    const moduleMatch = gomod.match(/^module\s+(.+)$/m);
    const name = moduleMatch ? moduleMatch[1].split('/').pop()! : basename(rootPath);
    return { name, description: '', domain: 'go-project' };
  }

  // Fallback: use directory name
  return {
    name: basename(rootPath),
    description: '',
    domain: 'unknown',
  };
}

// ─── Module discovery ────────────────────────────────────────────────────────

async function discoverModules(
  rootPath: string,
  metadata: ProjectMetadata,
  sourceFiles: string[],
  userExcludes: Set<string>,
): Promise<DiscoveredModule[]> {
  const modules: DiscoveredModule[] = [];
  const seen = new Set<string>();

  // Strategy 1: npm/pnpm workspaces
  if (metadata.workspaces && metadata.workspaces.length > 0) {
    for (const pattern of metadata.workspaces) {
      const normalizedPattern = pattern.replace(/\\/g, '/').replace(/\/$/, '');
      const isChildGlob = normalizedPattern.endsWith('/*')
        && !normalizedPattern.slice(0, -2).includes('*');

      if (isChildGlob) {
        // Preserve the supported workspace glob behavior: each immediate child
        // of `packages/*` (or equivalent) is a module.
        const wsDir = normalizedPattern.slice(0, -2);
        const wsPath = join(rootPath, wsDir);
        if (isExcludedWorkspacePath(rootPath, wsPath, userExcludes)) continue;

        try {
          const entries = await readdir(wsPath, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const modulePath = join(wsPath, entry.name);
            if (isExcludedWorkspacePath(rootPath, modulePath, userExcludes)) continue;
            await addWorkspaceModule(modulePath);
          }
        } catch {
          // Workspace directory doesn't exist or isn't readable — skip.
        }
        continue;
      }

      // An explicit workspace such as `packages/core` names that directory as
      // the module. Do not enumerate its children (`dist`, `src`, etc.).
      if (!normalizedPattern.includes('*')) {
        const modulePath = join(rootPath, normalizedPattern);
        if (isExcludedWorkspacePath(rootPath, modulePath, userExcludes)) continue;
        try {
          const moduleStat = await stat(modulePath);
          if (moduleStat.isDirectory()) await addWorkspaceModule(modulePath);
        } catch {
          // Explicit workspace doesn't exist or isn't readable — skip.
        }
      }
    }
  }

  async function addWorkspaceModule(modulePath: string): Promise<void> {
    const moduleName = basename(modulePath);
    const pkgJson = await readJsonSafe(join(modulePath, 'package.json'));
    const packageName = (pkgJson?.name as string | undefined) ?? moduleName;
    const desc = (pkgJson?.description as string | undefined) ?? `Workspace package: ${moduleName}`;
    if (seen.has(packageName) || seen.has(moduleName)) return;

    seen.add(packageName);
    seen.add(moduleName);
    modules.push({
      name: moduleName,
      type: 'module',
      description: desc,
      parent: metadata.name,
      relPath: toRelPath(rootPath, modulePath),
      ...(packageName !== moduleName ? { aliases: [packageName] } : {}),
    });
  }

  // Strategy 2: top-level source directories
  try {
    const entries = await readdir(rootPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (DEFAULT_EXCLUDE_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith('.')) continue;

      // Only include known source directories
      if (SOURCE_DIRS.has(entry.name) && !seen.has(entry.name)) {
        seen.add(entry.name);
        modules.push({
          name: entry.name,
          type: 'module',
          description: `Source directory: ${entry.name}/`,
          parent: metadata.name,
          relPath: toRelPath(rootPath, join(rootPath, entry.name)),
        });
      }
    }
  } catch (err: unknown) {
    // Root directory read failed — skip
  }

  // Strategy 3: subdirectories of src/ with multiple source files
  const srcDir = join(rootPath, 'src');
  try {
    const srcStat = await stat(srcDir);
    if (srcStat.isDirectory()) {
      const srcEntries = await readdir(srcDir, { withFileTypes: true });
      for (const entry of srcEntries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.') || entry.name.startsWith('__')) continue;
        const dirPath = join(srcDir, entry.name);
        const filesInDir = sourceFiles.filter((f) => isWithinDirectory(f, dirPath));
        if (filesInDir.length >= 2 && !seen.has(entry.name)) {
          seen.add(entry.name);
          modules.push({
            name: entry.name,
            type: 'component',
            description: `Component: ${entry.name}/ (${filesInDir.length} source files)`,
            parent: metadata.name,
            relPath: toRelPath(rootPath, dirPath),
          });
        }
      }
    }
  } catch (err: unknown) {
    // src/ doesn't exist — skip
  }

  return modules;
}

// ─── File walking ────────────────────────────────────────────────────────────

async function walkSourceFiles(
  rootPath: string,
  userExcludes: Set<string>,
): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err: unknown) {
      console.error("[codebase-scanner] Suppressed error:", err);
      return; // Permission denied or other read error
    }

    for (const entry of entries) {
      const name = entry.name;
      if (DEFAULT_EXCLUDE_DIRS.has(name) || userExcludes.has(name) || name.startsWith('.')) {
        continue;
      }

      const fullPath = resolve(dir, name);

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const ext = extname(name);
        // Skip known non-source extensions
        if (DEFAULT_EXCLUDE_EXTENSIONS.has(ext)) continue;
        // Skip minified/bundled files
        if (name.endsWith('.min.js') || name.endsWith('.min.css')) continue;
        // Only collect recognized language files
        if (LANGUAGE_EXTENSIONS[ext]) {
          files.push(fullPath);
        }
      }
    }
  }

  await walk(rootPath);
  return files;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * The directory `dirPath` relative to `rootPath`, normalized to forward slashes
 * so the code→wiki bridge's prefix match is platform-independent.
 */
function toRelPath(rootPath: string, dirPath: string): string {
  return relative(rootPath, dirPath).split(/[\\/]/).filter(Boolean).join('/');
}

function toPortablePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function isWithinDirectory(filePath: string, dirPath: string): boolean {
  const relPath = relative(dirPath, filePath);
  return relPath.length > 0 && relPath !== '..' && !relPath.startsWith(`..\\`) && !relPath.startsWith('../');
}

function isExcludedWorkspacePath(
  rootPath: string,
  workspacePath: string,
  userExcludes: Set<string>,
): boolean {
  const segments = relative(rootPath, workspacePath).split(/[\\/]/).filter(Boolean);
  return segments.some((segment) => (
    DEFAULT_EXCLUDE_DIRS.has(segment)
    || userExcludes.has(segment)
    || segment.startsWith('.')
  ));
}

function detectLanguages(files: string[]): SupportedLanguage[] {
  const counts = new Map<SupportedLanguage, number>();
  for (const f of files) {
    const ext = extname(f);
    const lang = LANGUAGE_EXTENSIONS[ext];
    if (lang) {
      counts.set(lang, (counts.get(lang) ?? 0) + 1);
    }
  }
  // Sort by file count descending, return languages with at least 1 file
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([lang]) => lang);
}

function isTestFile(filePath: string): boolean {
  const portablePath = toPortablePath(filePath);
  return TEST_PATTERNS.some((p) => p.test(portablePath));
}

function inferDomain(packageJson: Record<string, unknown>): string {
  const deps = {
    ...(packageJson.dependencies as Record<string, string> | undefined ?? {}),
    ...(packageJson.devDependencies as Record<string, string> | undefined ?? {}),
  };
  const depNames = Object.keys(deps);

  if (depNames.some((d) => d.includes('next') || d.includes('nuxt') || d.includes('react') || d.includes('vue') || d.includes('svelte'))) {
    return 'web-app';
  }
  if (depNames.some((d) => d.includes('express') || d.includes('fastify') || d.includes('koa') || d.includes('hono'))) {
    return 'api-server';
  }
  if (depNames.some((d) => d.includes('electron') || d.includes('tauri'))) {
    return 'desktop-app';
  }
  if (depNames.some((d) => d.includes('commander') || d.includes('yargs') || d.includes('meow'))) {
    return 'cli-tool';
  }
  if (packageJson.scripts && typeof packageJson.scripts === 'object') {
    const scripts = Object.keys(packageJson.scripts as Record<string, unknown>);
    if (scripts.some((s) => s.includes('start'))) return 'application';
  }
  return 'library';
}

function extractWorkspaces(packageJson: Record<string, unknown>): string[] | undefined {
  const ws = packageJson.workspaces;
  if (Array.isArray(ws)) return ws as string[];
  if (ws && typeof ws === 'object' && 'packages' in ws) {
    return (ws as { packages: string[] }).packages;
  }
  return undefined;
}

function extractTomlValue(content: string, key: string): string | undefined {
  // Simple TOML key extraction — handles: name = "value"
  const regex = new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm');
  const match = content.match(regex);
  return match ? match[1] : undefined;
}

async function readJsonSafe(path: string): Promise<Record<string, unknown> | null> {
  try {
    const content = await readFile(path, 'utf-8');
    return JSON.parse(content) as Record<string, unknown>;
  } catch (err: unknown) {
    if (!isMissingFileError(err)) console.error('[codebase-scanner] Suppressed error:', err);
    return null;
  }
}

async function readTextSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch (err: unknown) {
    if (!isMissingFileError(err)) console.error('[codebase-scanner] Suppressed error:', err);
    return null;
  }
}

function isMissingFileError(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT';
}
