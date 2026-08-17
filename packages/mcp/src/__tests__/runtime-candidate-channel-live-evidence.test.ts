import { chmod, link, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  candidateEvidenceAuthorityV1,
  hasExactCandidateEvidenceParentPermissionsV1,
  writeCandidateLiveEvidenceV1,
  writeCandidateLiveEvidenceTestCoreV1,
} from './runtime-candidate-channel-live-evidence.js';

const roots: string[] = [];
const originalRoot = process.env['RUNNER_TEMP'];
const originalPath = process.env['MEMBERRY_RET003B_EVIDENCE_PATH'];
const linux = process.platform === 'linux' ? it : it.skip;

async function authority(): Promise<{ root: string; parent: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), 'memberry-ret003b-evidence-'));
  roots.push(root);
  const parent = join(root, 'memberry-candidate-channel-live');
  await mkdir(parent, { mode: 0o700 });
  await chmod(parent, 0o700);
  const path = join(parent, 'evidence.json');
  process.env['RUNNER_TEMP'] = root;
  process.env['MEMBERRY_RET003B_EVIDENCE_PATH'] = path;
  return { root, parent, path };
}

async function code(work: Promise<unknown>): Promise<string> {
  const error = await work.then(() => new Error('unexpected success'), (value: unknown) => value);
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code) : 'FAILED';
}

afterEach(async () => {
  if (originalRoot === undefined) delete process.env['RUNNER_TEMP']; else process.env['RUNNER_TEMP'] = originalRoot;
  if (originalPath === undefined) delete process.env['MEMBERRY_RET003B_EVIDENCE_PATH'];
  else process.env['MEMBERRY_RET003B_EVIDENCE_PATH'] = originalPath;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('RET-003B secure fixed evidence writer', () => {
  it('accepts exact 0700 only and requires the exact resolved path', () => {
    expect(hasExactCandidateEvidenceParentPermissionsV1(0o40700n)).toBe(true);
    for (const mode of [0o40755n, 0o40711n, 0o41700n]) expect(hasExactCandidateEvidenceParentPermissionsV1(mode)).toBe(false);
    const root = resolve(tmpdir());
    process.env['RUNNER_TEMP'] = root;
    process.env['MEMBERRY_RET003B_EVIDENCE_PATH'] = join(root, 'wrong', 'evidence.json');
    expect(() => candidateEvidenceAuthorityV1()).toThrow('ret003b_live:path_invalid');
  });

  it('rejects caller payloads before filesystem or hooks', async () => {
    const hooks = vi.fn();
    const proxy = new Proxy({}, { get: () => { hooks(); return undefined; }, ownKeys: () => { hooks(); return []; } });
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    for (const hostile of [proxy, revoked.proxy, { toJSON: () => hooks() }, { extra: true }]) {
      const target = await authority();
      expect(await code(writeCandidateLiveEvidenceV1(hostile))).toBe('INPUT_INVALID');
      await expect(readFile(target.path)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(hooks).not.toHaveBeenCalled();
  });

  linux('writes once with 0600 and rejects an existing leaf', async () => {
    const target = await authority();
    await writeCandidateLiveEvidenceV1();
    expect(await readFile(target.path, 'utf8')).toContain('"contract":"RET-003B"');
    expect((await lstat(target.path)).mode & 0o7777).toBe(0o600);
    expect(await code(writeCandidateLiveEvidenceV1())).toBe('EXISTS');
  });

  linux('rejects loose or symlink parents and symlink/hardlink leaves', async () => {
    let target = await authority();
    await chmod(target.parent, 0o755);
    expect(await code(writeCandidateLiveEvidenceV1())).toBe('PARENT_INVALID');

    target = await authority();
    const realParent = join(target.root, 'real-parent');
    await rm(target.parent, { recursive: true });
    await mkdir(realParent, { mode: 0o700 });
    await symlink(realParent, target.parent, 'dir');
    expect(await code(writeCandidateLiveEvidenceV1())).toBe('PARENT_INVALID');

    target = await authority();
    const leafTarget = join(target.root, 'leaf-target');
    await writeFile(leafTarget, 'x');
    await symlink(leafTarget, target.path, 'file');
    expect(await code(writeCandidateLiveEvidenceV1())).toBe('LEAF_LINK');

    target = await authority();
    const hardTarget = join(target.root, 'hard-target');
    await writeFile(hardTarget, 'x');
    await link(hardTarget, target.path);
    expect(await code(writeCandidateLiveEvidenceV1())).toBe('LEAF_HARDLINK');
  });

  linux('rejects a parent identity swap after exclusive open', async () => {
    const target = await authority();
    const moved = join(target.root, 'moved-parent');
    expect(await code(writeCandidateLiveEvidenceTestCoreV1(async () => {
      await rename(target.parent, moved);
      await mkdir(target.parent, { mode: 0o700 });
      await chmod(target.parent, 0o700);
    }))).toBe('PARENT_CHANGED');
  });
});
