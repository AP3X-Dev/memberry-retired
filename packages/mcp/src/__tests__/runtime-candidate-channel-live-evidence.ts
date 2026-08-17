import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

const DIRECTORY = 'memberry-candidate-channel-live';
const FILENAME = 'evidence.json';
const ENV = 'MEMBERRY_RET003B_EVIDENCE_PATH';
const BYTES = '{"contract":"RET-003B","mode":"required","disposable":true,"realBootstrap":true,"centralHttpAuthentication":true,"defaultAndDedicatedRouting":true,"realChannels":3,"unavailableChannels":12,"deterministicRepeat":true,"candidateOffPlannerOnParity":true,"sourceFailureIsolated":true,"cleanupCount":0}\n';

type Code = 'INPUT_INVALID' | 'PATH_INVALID' | 'PLATFORM_UNSUPPORTED' | 'PARENT_INVALID'
  | 'PARENT_CHANGED' | 'LEAF_LINK' | 'LEAF_HARDLINK' | 'EXISTS' | 'LEAF_INVALID' | 'WRITE_FAILED';

export class CandidateLiveEvidenceError extends Error {
  constructor(readonly code: Code) {
    super(`ret003b_live:${code.toLowerCase()}`);
    this.name = 'CandidateLiveEvidenceError';
  }
}

interface Stats {
  dev: bigint; ino: bigint; uid: bigint; mode: bigint; nlink: bigint; size: bigint;
  isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean;
}
interface Identity { dev: bigint; ino: bigint; uid: bigint; mode: bigint; nlink: bigint; size?: bigint }

function fail(code: Code): CandidateLiveEvidenceError { return new CandidateLiveEvidenceError(code); }

export function hasExactCandidateEvidenceParentPermissionsV1(mode: bigint): boolean {
  return (mode & 0o7777n) === 0o700n;
}

export function candidateEvidenceAuthorityV1(): Readonly<{ parent: string; path: string }> {
  const root = process.env['RUNNER_TEMP'];
  const requested = process.env[ENV];
  if (typeof root !== 'string' || root.length === 0 || root.includes('\0')
    || !isAbsolute(root) || resolve(root) !== root) throw fail('PATH_INVALID');
  const parent = join(root, DIRECTORY);
  const path = join(parent, FILENAME);
  if (requested !== path) throw fail('PATH_INVALID');
  return Object.freeze({ parent, path });
}

function uid(): bigint {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function'
    || typeof fsConstants.O_NOFOLLOW !== 'number' || fsConstants.O_NOFOLLOW === 0) {
    throw fail('PLATFORM_UNSUPPORTED');
  }
  return BigInt(process.getuid());
}

async function parentIdentity(path: string, owner: bigint): Promise<Identity> {
  try {
    const s = await lstat(path, { bigint: true }) as unknown as Stats;
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== owner || s.nlink < 1n
      || !hasExactCandidateEvidenceParentPermissionsV1(s.mode) || await realpath(path) !== path) {
      throw fail('PARENT_INVALID');
    }
    return Object.freeze({ dev: s.dev, ino: s.ino, uid: s.uid, mode: s.mode, nlink: s.nlink });
  } catch (error) {
    if (error instanceof CandidateLiveEvidenceError) throw error;
    throw fail('PARENT_INVALID');
  }
}

function same(left: Identity, right: Identity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid
    && left.mode === right.mode && left.nlink === right.nlink;
}

async function assertParent(path: string, owner: bigint, expected: Identity): Promise<void> {
  if (!same(await parentIdentity(path, owner), expected)) throw fail('PARENT_CHANGED');
}

async function rejectLeaf(path: string): Promise<void> {
  try {
    const s = await lstat(path, { bigint: true }) as unknown as Stats;
    if (s.isSymbolicLink()) throw fail('LEAF_LINK');
    if (s.nlink !== 1n) throw fail('LEAF_HARDLINK');
    throw fail('EXISTS');
  } catch (error) {
    if (error instanceof CandidateLiveEvidenceError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw fail('WRITE_FAILED');
  }
}

function leaf(s: Stats, owner: bigint, size: bigint, expected?: Identity): Identity {
  if (!s.isFile() || s.isSymbolicLink() || s.uid !== owner || (s.mode & 0o7777n) !== 0o600n
    || s.nlink !== 1n || s.size !== size) throw fail('LEAF_INVALID');
  const value = Object.freeze({ dev: s.dev, ino: s.ino, uid: s.uid, mode: s.mode, nlink: s.nlink, size: s.size });
  if (expected && !same(value, expected)) throw fail('LEAF_INVALID');
  return value;
}

export async function writeCandidateLiveEvidenceTestCoreV1(afterOpen?: () => Promise<void>): Promise<void> {
  const authority = candidateEvidenceAuthorityV1();
  const owner = uid();
  const parent = await parentIdentity(authority.parent, owner);
  await rejectLeaf(authority.path);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let closed = false;
  try {
    handle = await open(
      authority.path,
      fsConstants.O_NOFOLLOW | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    if (afterOpen) await afterOpen();
    await assertParent(authority.parent, owner, parent);
    const opened = leaf(await handle.stat({ bigint: true }) as unknown as Stats, owner, 0n);
    await handle.writeFile(BYTES, 'utf8');
    await handle.sync();
    const size = BigInt(Buffer.byteLength(BYTES, 'utf8'));
    leaf(await handle.stat({ bigint: true }) as unknown as Stats, owner, size, opened);
    await assertParent(authority.parent, owner, parent);
    await handle.close(); closed = true;
    leaf(await lstat(authority.path, { bigint: true }) as unknown as Stats, owner, size, opened);
    await assertParent(authority.parent, owner, parent);
  } catch (error) {
    if (handle && !closed) {
      try { await handle.close(); } catch { throw fail('WRITE_FAILED'); }
    }
    if (error instanceof CandidateLiveEvidenceError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw fail('EXISTS');
    if (code === 'ELOOP') throw fail('LEAF_LINK');
    throw fail('WRITE_FAILED');
  }
}

export async function writeCandidateLiveEvidenceV1(...unexpected: readonly unknown[]): Promise<void> {
  if (unexpected.length !== 0) throw fail('INPUT_INVALID');
  return writeCandidateLiveEvidenceTestCoreV1();
}
