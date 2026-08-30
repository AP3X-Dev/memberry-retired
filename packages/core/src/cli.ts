#!/usr/bin/env node
// packages/core/src/cli.ts
// MemBerry CLI — export, import, snapshot commands.
// Usage: npx memberry <command> [options]

import { execFileSync } from 'child_process';
import { createNeo4jDriver, TenantAdmin, LifecycleStore, EpisodicIndexStore } from '@memberry/neo4j';
import { writeFileSync } from 'fs';
import { createRedisClient, ProposalStore, EpisodicBuffer } from '@memberry/redis';
import { exportAll, exportFiltered } from './export.js';
import { defaultExportPath } from './config/settings.js';
import { importFromPath, type ImportStrategy } from './import.js';
import { runHookCommand } from './cli/hook.js';
import { runContextCommand } from './cli/context.js';
import { runHooksCommand } from './cli/install.js';
import { runRunCommand } from './cli/run.js';
import { runSetup } from './cli/setup.js';
import { runConfigure } from './cli/configure.js';
import { runProject } from './cli/project.js';
import { runDoctor } from './cli/doctor.js';
import { createCoreServices, buildDreamEngine } from './services-factory.js';
import { LifecycleEngine } from './lifecycle.js';
import { AntiEntropyEngine, type AntiEntropyRunResult } from './anti-entropy.js';
import { HebbianEngine, type HebbianRunResult } from './hebbian.js';
import { resolveAntiEntropyConfig, resolveHebbianConfig, resolveLifecycleConfig } from './config/lifecycle.js';
import { OpenAiLlmClient } from './llm.js';
import { extractEpisodeStructuredIndexV1 } from './structured-index-extractor.js';
import { buildEpisodeIndexKeysV1 } from './structured-index.js';
import { DEFAULT_TENANT } from './types.js';

// ─── Arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
} {
  // argv = ['node', 'cli.ts', 'command', ...rest]
  const [, , command = '', ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++; // consume value
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(arg);
    }
  }

  return { command, positionals, flags };
}

// ─── Environment ──────────────────────────────────────────────────────────────

function loadEnv(): {
  neo4jUri: string;
  neo4jUser: string;
  neo4jPassword: string;
  redisUrl: string;
} {
  const neo4jUri = process.env['NEO4J_URI']?.trim() || 'bolt://localhost:7687';
  const neo4jUser = process.env['NEO4J_USER']?.trim() || 'neo4j';
  const neo4jPassword = process.env['NEO4J_PASSWORD'] ?? '';
  const redisUrl = process.env['REDIS_URL']?.trim() || 'redis://localhost:6379';
  return { neo4jUri, neo4jUser, neo4jPassword, redisUrl };
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function runExport(flags: Record<string, string | boolean>): Promise<void> {
  const exportPath = String(flags['path'] ?? defaultExportPath());
  const entities = flags['entity'] ? [String(flags['entity'])] : [];
  const tags = flags['tag'] ? [String(flags['tag'])] : [];

  const { neo4jUri, neo4jUser, neo4jPassword } = loadEnv();
  const driver = createNeo4jDriver(neo4jUri, neo4jUser, neo4jPassword);

  try {
    console.log(`Exporting to ${exportPath}...`);
    const hasFilter = entities.length > 0 || tags.length > 0;
    const result = hasFilter
      ? await exportFiltered(driver, exportPath, { entities, tags })
      : await exportAll(driver, exportPath);

    console.log(`Export complete: ${result.exported} exported, ${result.skipped} skipped`);
    if (result.errors.length > 0) {
      console.error('Errors:');
      for (const e of result.errors) console.error(`  ${e}`);
    }
  } finally {
    await driver.close();
  }
}

async function runImport(flags: Record<string, string | boolean>): Promise<void> {
  const importPath = String(flags['path'] ?? defaultExportPath());
  const strategy = (flags['strategy'] as ImportStrategy | undefined) ?? 'confidence-weighted';
  const dryRun = flags['dry-run'] === true;

  const { neo4jUri, neo4jUser, neo4jPassword, redisUrl } = loadEnv();
  const driver = createNeo4jDriver(neo4jUri, neo4jUser, neo4jPassword);
  const redis = createRedisClient(redisUrl);

  try {
    console.log(`Importing from ${importPath}${dryRun ? ' (dry-run)' : ''}...`);
    const result = await importFromPath(driver, redis, importPath, { strategy, dryRun });

    console.log('Import complete:');
    console.log(`  added:     ${result.added}`);
    console.log(`  modified:  ${result.modified}`);
    console.log(`  deleted:   ${result.deleted}`);
    console.log(`  unchanged: ${result.unchanged}`);
  } finally {
    await driver.close();
    redis.disconnect();
  }
}

async function runSnapshot(flags: Record<string, string | boolean>): Promise<void> {
  const snapshotPath = String(flags['path'] ?? defaultExportPath());
  const shouldCommit = flags['commit'] === true;
  const message =
    typeof flags['message'] === 'string'
      ? flags['message']
      : `MemBerry snapshot ${new Date().toISOString().slice(0, 10)}`;

  // 1. Run full export
  await runExport({ path: snapshotPath });

  if (!shouldCommit) return;

  // 2. Stage snapshot changes. The default .memberry path is intentionally ignored
  // in source worktrees, so snapshot commits must force-add this explicit path.
  try {
    execFileSync('git', ['add', '-f', snapshotPath], { stdio: 'inherit' });
  } catch (err) {
    console.error('git add failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // 3. Check if there are staged snapshot changes only.
  try {
    execFileSync('git', ['diff', '--cached', '--quiet', '--', snapshotPath], { stdio: 'inherit' });
    // Exit code 0 means no changes
    console.log('No changes to commit — snapshot is already up to date.');
    return;
  } catch (err: unknown) {
    // Non-zero exit = there are staged snapshot changes — proceed with commit.
  }

  // 4. Commit only the snapshot path, preserving any unrelated staged work.
  try {
    execFileSync('git', ['commit', '-m', message, '--', snapshotPath], { stdio: 'inherit' });
    console.log(`Snapshot committed: ${message}`);
  } catch (err) {
    console.error('git commit failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function runDream(flags: Record<string, string | boolean>): Promise<void> {
  const scope = String(flags['scope'] ?? 'project:global');
  const maxEntities = flags['max-entities'] ? Number(flags['max-entities']) : undefined;
  const noCards = flags['no-cards'] === true;

  const core = createCoreServices();
  try {
    if (!core.llm.available) {
      console.error('[dream] no OPENAI_API_KEY configured — nothing to do.');
      return; // nothing to do without an LLM; avoid building the engine + a duplicate log
    }
    const engine = buildDreamEngine(core);
    const result = await engine.run(scope, {
      ...(maxEntities && Number.isFinite(maxEntities) ? { maxEntities } : {}),
      ...(noCards ? { cards: false } : {}),
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await core.close();
  }
}

function boundedIntFlag(flags: Record<string, string | boolean>, name: string, fallback: number, max: number): number {
  const value = flags[name] === undefined ? fallback : Number(flags[name]);
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`--${name} must be an integer in 1..${max}`);
  return value;
}

async function runIndexBackfill(positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  const action = positionals[0] ?? 'status';
  const projectScope = String(flags['scope'] ?? '');
  const tenantId = String(flags['tenant'] ?? DEFAULT_TENANT);
  if (!/^project:[a-z0-9][a-z0-9._-]*$/.test(projectScope)) {
    throw new Error('Pass canonical --scope project:<name>');
  }
  const core = createCoreServices();
  const store = new EpisodicIndexStore(core.driver);
  try {
    if (action === 'status') {
      console.log(JSON.stringify(await store.stats({ tenantId, projectScope }), null, 2));
      return;
    }
    if (action === 'reset') {
      if (flags['yes'] !== true) throw new Error('index-backfill reset requires --yes');
      const deleted = await store.deleteDerived({ tenantId, projectScope });
      console.log(JSON.stringify({ deleted, tenant: tenantId, scope: projectScope }));
      return;
    }
    if (action !== 'run') throw new Error('index-backfill action must be run, status, or reset');
    if (flags['yes'] !== true) throw new Error('index-backfill run requires --yes');
    if (core.embedding.available === false) throw new Error('index-backfill requires a configured embedding provider');

    const endpoint = String(flags['endpoint'] ?? process.env['MEMBERRY_INDEXER_BASE_URL'] ?? 'http://127.0.0.1:11434/v1');
    const parsedEndpoint = new URL(endpoint);
    if (!['127.0.0.1', 'localhost', '::1'].includes(parsedEndpoint.hostname)) {
      throw new Error('index-backfill endpoint must be local loopback');
    }
    const model = String(flags['model'] ?? process.env['MEMBERRY_INDEXER_MODEL'] ?? 'qwen2.5:3b-instruct');
    const maxEpisodes = boundedIntFlag(flags, 'max-episodes', 100, 10_000);
    const batchSize = boundedIntFlag(flags, 'batch-size', 10, 100);
    const timeoutSeconds = boundedIntFlag(flags, 'timeout-seconds', 60, 600);
    const delayMs = boundedIntFlag(flags, 'delay-ms', 250, 5_000);
    const llm = new OpenAiLlmClient('local-indexer', { extraction: model }, parsedEndpoint.toString());
    let cursor: { createdAt: string; id: string } | undefined;
    let examined = 0;
    let indexed = 0;
    let empty = 0;
    let failed = 0;

    while (examined < maxEpisodes) {
      const batch = await store.nextBackfillBatch({
        tenantId, projectScope, limit: Math.min(batchSize, maxEpisodes - examined), ...(cursor ? { after: cursor } : {}),
      });
      if (batch.length === 0) break;
      for (const episode of batch) {
        examined += 1;
        cursor = { createdAt: episode.createdAt, id: episode.id };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1_000);
        timer.unref?.();
        try {
          const structured = await extractEpisodeStructuredIndexV1({
            content: episode.content, projectScope, llm, model, signal: controller.signal,
          });
          if (!structured) { empty += 1; continue; }
          const texts = [...structured.facts, ...structured.aliases.flatMap(({ values }) => values)];
          const keys = buildEpisodeIndexKeysV1({
            episodeId: episode.id,
            structured,
            embeddings: await core.embedding.embedBatch(texts),
            source: 'backfill', tenantId, projectScope, createdAt: new Date().toISOString(),
          });
          await store.replaceBackfillKeys(episode, keys);
          indexed += 1;
        } catch {
          failed += 1;
        } finally {
          clearTimeout(timer);
        }
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    console.log(JSON.stringify({ examined, indexed, empty, failed, tenant: tenantId, scope: projectScope, model }));
    if (failed > 0) process.exitCode = 2;
  } finally {
    await core.close();
  }
}

async function runLifecycle(positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  const config = resolveLifecycleConfig(defaultExportPath());

  // `memberry lifecycle unarchive --id <id>` — the rollback path. Deliberately
  // NOT behind the flag gate: rollback must work after the flag is turned off.
  if (positionals[0] === 'unarchive') {
    const id = typeof flags['id'] === 'string' ? (flags['id'] as string) : '';
    if (!id) throw new Error('Pass a node id: memberry lifecycle unarchive --id <id>');
    const { neo4jUri, neo4jUser, neo4jPassword } = loadEnv();
    const driver = createNeo4jDriver(neo4jUri, neo4jUser, neo4jPassword);
    try {
      const count = await new LifecycleStore(driver).setArchived([id], false, new Date().toISOString(), config.batchRows);
      console.log(count > 0 ? `Unarchived ${id}.` : `No Episodic/Semantic node found with id ${id}.`);
    } finally {
      await driver.close();
    }
    return;
  }

  // Flag gate: the pass runs only when MEMBERRY_LIFECYCLE_V1=live.
  if (config.mode !== 'live') {
    console.log('[lifecycle] MEMBERRY_LIFECYCLE_V1 is not "live" — nothing to do.');
    return;
  }

  const core = createCoreServices();
  try {
    const store = new LifecycleStore(core.driver);

    // MEM-006H hebbian pass: drains the feedback ring BEFORE the lifecycle
    // pass so tonight's usage protects tonight's plan. Behind its own
    // sub-flag; disabled => the engine is never constructed and the
    // LifecycleEngine runs the MEM-006 status quo.
    const hebbianConfig = resolveHebbianConfig();
    let hebbianResult: HebbianRunResult | undefined;
    if (hebbianConfig.mode === 'live') {
      const hebbianEngine = new HebbianEngine({
        ring: {
          rpopBatch: async (key, count) => (await core.redis.rpop(key, count)) ?? [],
          llen: (key) => core.redis.llen(key),
        },
        graph: store,
        config: hebbianConfig,
        lifecycle: config,
      });
      hebbianResult = await hebbianEngine.run({
        ...(flags['dry-run'] === true ? { dryRun: true } : {}),
      });
    }

    const engine = new LifecycleEngine({
      store,
      proposals: new ProposalStore(core.redis),
      config,
      ...(hebbianConfig.mode === 'live' ? { hebbian: hebbianConfig } : {}),
    });
    const result = await engine.run({
      ...(typeof flags['scope'] === 'string' ? { scope: flags['scope'] as string } : {}),
      ...(flags['dry-run'] === true ? { dryRun: true } : {}),
    });

    // MEM-007 anti-entropy pass: rides the same job AFTER the lifecycle pass,
    // behind its own sub-flag so the first automated graph writes outside
    // bootstrap are killable without disabling retention/archive. Disabled
    // sub-flag => the engine is never constructed (MEM-006 behavior untouched).
    let antiEntropyResult: AntiEntropyRunResult | undefined;
    const antiEntropyConfig = resolveAntiEntropyConfig();
    if (antiEntropyConfig.mode === 'live') {
      const episodicBuffer = new EpisodicBuffer(core.redis);
      const antiEntropyEngine = new AntiEntropyEngine({
        graph: new LifecycleStore(core.driver),
        streams: {
          groupHealth: (group) => core.signals.groupHealth(group),
          removeIdleConsumers: (group, minIdleMs) => core.signals.removeIdleConsumers(group, minIdleMs),
          bufferLength: () => episodicBuffer.length(),
        },
        queue: { size: () => core.queue.size(), peek: (count) => core.queue.peek(count) },
        extraction: { stats: () => core.extractionQueue.stats() },
        kv: { mget: (...keys) => core.redis.mget(...keys) },
        config: antiEntropyConfig,
        lifecycle: config,
      });
      antiEntropyResult = await antiEntropyEngine.run({
        ...(flags['dry-run'] === true ? { dryRun: true } : {}),
      });
    }

    console.log(JSON.stringify({
      ...result,
      ...(hebbianResult ? { hebbian: hebbianResult } : {}),
      ...(antiEntropyResult ? { anti_entropy: antiEntropyResult } : {}),
    }, null, 2));
    // A failed scope/drain/drift class must surface to systemd; successes stay applied.
    if (
      result.failures.length > 0
      || (hebbianResult?.failures.length ?? 0) > 0
      || (antiEntropyResult?.failures.length ?? 0) > 0
    ) {
      process.exitCode = 1;
    }
  } finally {
    await core.close();
  }
}

async function runExtraction(positionals: string[], _flags: Record<string, string | boolean>): Promise<void> {
  const sub = positionals[0] ?? 'status';
  const core = createCoreServices();
  try {
    if (sub === 'replay') {
      const moved = await core.extractionQueue.replayDeadLetters();
      console.log(`Replayed ${moved} dead-lettered extraction job(s) back onto the queue.`);
    } else {
      // status (default)
      const s = await core.extractionQueue.stats();
      console.log(JSON.stringify({
        pending: s.pending,
        inflight: s.inflight,
        dead_lettered: s.deadLettered,
      }, null, 2));
    }
  } finally {
    await core.close();
  }
}

async function runTenant(positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  const sub = positionals[0] ?? 'stats';
  const tenant = typeof flags['tenant'] === 'string' ? (flags['tenant'] as string) : '';
  if (!tenant) throw new Error('Pass a tenant: --tenant <name>');
  const core = createCoreServices();
  try {
    const admin = new TenantAdmin(core.driver);
    if (sub === 'export') {
      const data = await admin.export(tenant);
      const out = typeof flags['out'] === 'string' ? (flags['out'] as string) : '';
      if (out) { writeFileSync(out, JSON.stringify(data, null, 2)); console.log(`Exported tenant "${tenant}" to ${out}`); }
      else console.log(JSON.stringify(data, null, 2));
    } else if (sub === 'delete') {
      if (flags['yes'] !== true) {
        const c = await admin.stats(tenant);
        console.error(`Refusing to delete without --yes. Tenant "${tenant}" has:`, JSON.stringify(c));
        return;
      }
      const removed = await admin.delete(tenant);
      console.log(`Deleted tenant "${tenant}":`, JSON.stringify(removed));
    } else {
      // stats (default)
      console.log(JSON.stringify(await admin.stats(tenant), null, 2));
    }
  } finally {
    await core.close();
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // `run` passes its tail (including `--`) through untouched, so handle it before
  // the shared flag parser swallows the wrapped command's own flags.
  if (process.argv[2] === 'run') {
    await runRunCommand(process.argv.slice(3));
    return;
  }

  const { command, positionals, flags } = parseArgs(process.argv);

  switch (command) {
    case 'export':
      await runExport(flags);
      break;

    case 'import':
      await runImport(flags);
      break;

    case 'snapshot':
      await runSnapshot(flags);
      break;

    case 'dream':
      // `memberry dream --scope project:x` — background gap-filling + abductive hypotheses.
      await runDream(flags);
      break;

    case 'index-backfill':
      await runIndexBackfill(positionals, flags);
      break;

    case 'lifecycle':
      // `memberry lifecycle [--scope project:x] [--dry-run]` — flag-gated pass;
      // `memberry lifecycle unarchive --id <id>` — reverse one archive.
      await runLifecycle(positionals, flags);
      break;

    case 'extraction':
      // `memberry extraction status|replay` — durable fact-extraction queue admin.
      await runExtraction(positionals, flags);
      break;

    case 'tenant':
      // `memberry tenant stats|export|delete --tenant <name> [--out f] [--yes]`
      await runTenant(positionals, flags);
      break;

    case 'setup':
      // `memberry setup [flags]` — shell out to scripts/setup.sh (the guided installer).
      await runSetup(flags);
      break;

    case 'configure':
      // `memberry configure <claude|codex>` — point an agent at a running server.
      await runConfigure(positionals, flags);
      break;

    case 'project':
      // `memberry project setup <path>` — per-project setup (dispatches on positionals[0]).
      await runProject(positionals, flags);
      break;

    case 'doctor':
      // `memberry doctor` — diagnose a MemBerry install and report fixes.
      await runDoctor(flags);
      break;

    case 'hook':
      // `memberry hook <agent> <event>` — harness-driven, JSON over stdin/stdout.
      await runHookCommand(positionals);
      break;

    case 'context':
      // `memberry context materialize ...`
      await runContextCommand(positionals[0] ?? '', flags);
      break;

    case 'hooks':
      // `memberry hooks <install|uninstall|status> ...`
      await runHooksCommand(positionals[0] ?? '', flags);
      break;

    default:
      console.error(`Unknown command: "${command}"`);
      console.error('Usage: memberry <command> [options]');
      console.error('');
      console.error('Setup & diagnostics commands:');
      console.error('  setup      [--mode local|server] [--with-wiki] [--db-only] [--yes] [--reconfigure] ...   (stand up the stack via scripts/setup.sh)');
      console.error('  configure  <claude|codex>   (point an agent at a running MemBerry server)');
      console.error('  project    setup <path>     (per-project MemBerry setup)');
      console.error('  doctor                      (diagnose a MemBerry install)');
      console.error('');
      console.error('Memory snapshot commands:');
      console.error('  export    [--path ./.memberry] [--entity Name] [--tag tag]');
      console.error('  import    [--path ./.memberry] [--strategy confidence-weighted|overwrite] [--dry-run]');
      console.error('  snapshot  [--path ./.memberry] [--commit] [--message "..."]');
      console.error('');
      console.error('Background memory commands:');
      console.error('  dream      [--scope project:x] [--max-entities N] [--no-cards]');
      console.error('  lifecycle  [--scope project:x] [--dry-run] | unarchive --id <id>   (MEMBERRY_LIFECYCLE_V1=live gates the pass; MEMBERRY_LIFECYCLE_ANTIENTROPY=live adds the anti-entropy pass)');
      console.error('  extraction status|replay   (durable fact-extraction queue: counts / replay dead-letters)');
      console.error('  index-backfill run|status|reset --scope project:x [--tenant t] [--yes]   (IDX-001A local-model derived keys)');
      console.error('  tenant stats|export|delete --tenant <name> [--out file] [--yes]   (per-tenant admin)');
      console.error('');
      console.error('Agent hook commands:');
      console.error('  hooks install --agent claude|codex|hermes [--scope project|global] [--refresh wrapper|timer] [--with-mcp]');
      console.error('  hooks uninstall --agent claude|codex|hermes [--scope project|global]');
      console.error('  hooks status');
      console.error('  context materialize --agent codex|hermes [--file PATH] [--scope project:x] [--task "..."] [--max-tokens N]');
      console.error('  run --agent codex|hermes -- <command> [args...]');
      console.error('  hook <agent> <event>   (invoked by the harness, not by hand)');
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
