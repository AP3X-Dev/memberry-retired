// packages/core/src/__tests__/cli.regression.test.ts
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const CLI_SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../cli.ts'),
  'utf-8',
);
const SNAPSHOT_SERVICE_SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../../../../deploy/systemd/memberry-snapshot.service'),
  'utf-8',
);
const ROOT_GITIGNORE = fs.readFileSync(
  path.resolve(__dirname, '../../../../.gitignore'),
  'utf-8',
);

describe('cli.ts regression', () => {
  it('BUG-0002: must not use execSync with interpolated strings (shell injection)', () => {
    // Before the fix, runSnapshot() used execSync with a caller-controlled commit
    // message. Snapshot publishing has since been removed completely.

    // Verify no execSync usage with template literals or string concatenation
    const execSyncWithTemplate = /execSync\s*\(\s*`/;
    const execSyncWithConcat = /execSync\s*\(\s*['"][^'"]*['"]\s*\+/;
    const execSyncWithVariable = /execSync\s*\(\s*[a-zA-Z]/;

    expect(CLI_SOURCE).not.toMatch(execSyncWithTemplate);
    expect(CLI_SOURCE).not.toMatch(execSyncWithConcat);
    expect(CLI_SOURCE).not.toMatch(execSyncWithVariable);

    // No synchronous child-process primitive belongs in this top-level CLI.
    const importsExecSync = /import\s*\{[^}]*\bexecSync\b[^}]*\}\s*from\s*['"]child_process['"]/;
    expect(CLI_SOURCE).not.toMatch(importsExecSync);
    expect(CLI_SOURCE).not.toContain('execFileSync');
  });

  it('rejects legacy Git-publishing flags before exporting memory', () => {
    const snapshotStart = CLI_SOURCE.indexOf('async function runSnapshot');
    const snapshotEnd = CLI_SOURCE.indexOf('async function runDream', snapshotStart);
    const snapshotSource = CLI_SOURCE.slice(snapshotStart, snapshotEnd);
    const guard = snapshotSource.indexOf("Object.hasOwn(flags, 'commit')");
    const exportCall = snapshotSource.indexOf('await runExport({');

    expect(guard).toBeGreaterThanOrEqual(0);
    expect(snapshotSource).toContain("Object.hasOwn(flags, 'message')");
    expect(snapshotSource).toContain('snapshot:git_publishing_disabled');
    expect(exportCall).toBeGreaterThan(guard);
    expect(snapshotSource.slice(exportCall)).toContain('path: snapshotPath');
    expect(snapshotSource).not.toMatch(/['"]git['"]/);
    expect(snapshotSource).not.toContain("['add', '-f'");
    expect(snapshotSource).not.toContain("['commit'");
    expect(CLI_SOURCE).not.toContain('[--commit]');
    expect(CLI_SOURCE).not.toContain('[--message');
  });

  it('ships nightly snapshots as ignored local exports only', () => {
    expect(SNAPSHOT_SERVICE_SOURCE).toContain('snapshot --path ./.memberry');
    expect(SNAPSHOT_SERVICE_SOURCE).not.toContain('--commit');
    expect(ROOT_GITIGNORE).toMatch(/^\.memberry\/$/m);
    expect(ROOT_GITIGNORE).toMatch(/^\.amp\/$/m);
  });

  it('wires the setup/configure/project/doctor spine into the dispatcher', () => {
    // Source-pin the new top-level command tokens so the dispatcher can't silently
    // lose them. Their full behavior lands in follow-up tasks; the routing is here.
    for (const token of ["case 'setup'", "case 'configure'", "case 'project'", "case 'doctor'"]) {
      expect(CLI_SOURCE, `cli.ts must handle ${token}`).toContain(token);
    }
  });

  it('delegates the new commands to their modules', () => {
    expect(CLI_SOURCE).toContain('await runSetup(flags)');
    expect(CLI_SOURCE).toContain('await runConfigure(positionals, flags)');
    expect(CLI_SOURCE).toContain('await runProject(positionals, flags)');
    expect(CLI_SOURCE).toContain('await runDoctor(flags)');
  });
});
