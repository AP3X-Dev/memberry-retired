#!/usr/bin/env node
// packages/wiki/src/cli.ts
// Wiki CLI -- compile, serve, lint commands.
// Usage: npx tsx packages/wiki/src/cli.ts <command> [options]

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createNeo4jDriver } from '@memberry/neo4j';
import { DEFAULT_TENANT } from '@memberry/core';
import { WikiCompiler } from './compile.js';
import { initWikiSchema } from './ingest.js';
import { WikiLinter, formatLintReport } from './lint.js';
import { startWikiViewer } from './viewer.js';
import { WikiEditReconciler, parseFrontmatter } from './reconcile.js';
import { assertWikiTenantSafe } from './tenant-safety.js';

// ─── Arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  command: string;
  flags: Record<string, string | boolean>;
} {
  const [, , command = '', ...rest] = argv;
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }

  return { command, flags };
}

// ─── Environment ──────────────────────────────────────────────────────────────

const neo4jUri = process.env['NEO4J_URI']?.trim() || 'bolt://localhost:7687';
const neo4jUser = process.env['NEO4J_USER']?.trim() || 'neo4j';
const neo4jPassword = process.env['NEO4J_PASSWORD'] ?? '';

// ─── Commands ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv);
  assertWikiTenantSafe(command);

  if (!command || command === 'help') {
    console.log(`Usage: wiki-cli <command> [options]

Commands:
  compile   Compile the knowledge graph into wiki markdown
  serve     Start the wiki viewer HTTP server (editable round-trip enabled)
  lint      Run health checks on the knowledge graph
  build     Compile + start viewer (combined)
  sync      Reconcile a human-edited wiki file back into the graph

Options:
  --output         Output directory (default: ./wiki)
  --port           Viewer port (default: 3200)
  --project        Project tag for compile/lint/sync (default compile: all)
  --tenant         Tenant whose memory is compiled/linted (default: default)
  --checks         Comma-separated lint checks to run (default: all)
  --summary-only   lint: print summary counts only (default: full issue detail)
  --file           Edited markdown file to reconcile (sync)
`);
    process.exit(0);
  }

  const driver = createNeo4jDriver(neo4jUri, neo4jUser, neo4jPassword);

  try {
    await driver.getServerInfo();
    console.error('[wiki-cli] Neo4j connected');

    await initWikiSchema(driver);

    const outputDir = (flags['output'] as string) ?? path.resolve(process.cwd(), 'wiki');
    const port = parseInt((flags['port'] as string) ?? '3200', 10);
    const projectTag = (flags['project'] as string) ?? 'all';
    const tenantId = (flags['tenant'] as string) ?? DEFAULT_TENANT;

    switch (command) {
      case 'compile': {
        const compiler = new WikiCompiler(driver, { tenantId });
        console.error('[wiki-cli] Compiling wiki...');

        const result = await compiler.compile(outputDir, projectTag);

        console.error(`[wiki-cli] Done.`);
        console.error(`  Projects:       ${result.projects_compiled}`);
        console.error(`  Articles:       ${result.articles_compiled}`);
        console.error(`  Episodics:      ${result.episodics_rendered}`);
        console.error(`  Library pages:  ${result.library_pages}`);
        console.error(`  Topic pages:    ${result.topic_pages}`);
        console.error(`  Cross-project:  ${result.cross_project_pages}`);
        console.error(`  Output:         ${result.output_dir}`);
        break;
      }

      case 'serve': {
        await startWikiViewer({
          port,
          wiki_dir: outputDir,
          project_tag: 'all',
          driver,
        });
        console.error(`[wiki-cli] Viewer running at http://0.0.0.0:${port}`);
        // Keep process alive
        await new Promise(() => {});
        break;
      }

      case 'sync': {
        // Reconcile a human-edited wiki file back into the graph.
        const file = (flags['file'] as string) ?? (flags['_'] as string);
        if (!file) {
          console.error('[wiki-cli] --file <path> required for sync');
          process.exit(1);
        }
        const editedMd = await readFile(file, 'utf-8');
        const fm = parseFrontmatter(editedMd);
        const tag = (flags['project'] as string)
          ?? fm.tags.find((t) => t.startsWith('project:'))
          ?? 'project:unscoped';
        const reconciler = new WikiEditReconciler(driver);
        const result = await reconciler.reconcile({ project_tag: tag, edited_md: editedMd, driver });
        console.error(`[wiki-cli] Synced ${file}: ${result.corrected} corrected, ${result.added} added (no removals without original).`);
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'lint': {
        const lintProjectTag = flags['project'] as string;
        if (!lintProjectTag) {
          console.error('[wiki-cli] --project required for lint');
          process.exit(1);
        }

        const linter = new WikiLinter(driver);
        const checks = flags['checks']
          ? (flags['checks'] as string).split(',') as any[]
          : undefined;

        const result = await linter.lint({
          project_tag: lintProjectTag,
          checks,
        }, tenantId);
        // gap-17: print per-issue detail by default; --summary-only for the
        // terse counts. Shares formatLintReport with the MCP berry_lint handler.
        const summaryOnly = flags['summary-only'] === true;
        console.log(formatLintReport(result, { summaryOnly }));
        break;
      }

      case 'build': {
        // Compile then serve
        const compiler = new WikiCompiler(driver, { tenantId });
        console.error('[wiki-cli] Compiling wiki...');

        const result = await compiler.compile(outputDir, projectTag);

        console.error(`[wiki-cli] Compiled: ${result.projects_compiled} projects, ${result.articles_compiled} articles`);

        await startWikiViewer({
          port,
          wiki_dir: outputDir,
          project_tag: 'all',
          driver,
        });
        console.error(`[wiki-cli] Viewer running at http://0.0.0.0:${port}`);
        await new Promise(() => {});
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        process.exit(1);
    }
  } finally {
    await driver.close();
  }
}

main().catch((err) => {
  console.error('[wiki-cli] Fatal:', err);
  process.exit(1);
});
