#!/usr/bin/env tsx

import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  close as fsClose, closeSync as fsCloseSync, constants as fsConstants, fstat as fsFstat,
  fstatSync, read as fsRead,
} from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { types as utilTypes } from 'node:util';

import { pairedEfficiencyInterval } from '../stats.js';

type JsonRecord = Record<string, unknown>;
type FixtureLane = readonly JsonRecord[];
type EfficiencyPair = {
  scenarioId: string; probeId: string; controlCoverage: number; controlTokens: number;
  candidateCoverage: number; candidateTokens: number;
};

const FAILURE = 'RET010_HOLDOUT_GATE_FAILED\n';
const FINALIZE_FAILURE = 'RET010_HOLDOUT_FINALIZE_FAILED\n';
const POSITIVE = /^[1-9][0-9]*$/;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const TEST_KEYS = [
  'RET010_HOLDOUT_TEST_RUNNER_TEMP', 'RET010_HOLDOUT_TEST_GIT_COMMIT',
  'RET010_HOLDOUT_TEST_RUN_ID', 'RET010_HOLDOUT_TEST_RUN_ATTEMPT',
  'RET010_HOLDOUT_TEST_APPROVAL_SHA256', 'RET010_HOLDOUT_TEST_GATE_OUTCOME',
] as const;
const RUN_TEST_KEYS = TEST_KEYS.slice(0, -1);
const PROD_KEYS = [
  'RUNNER_TEMP', 'GITHUB_ACTIONS', 'GITHUB_EVENT_PATH', 'GITHUB_EVENT_NAME',
  'GITHUB_REPOSITORY', 'GITHUB_REF', 'GITHUB_SHA', 'GITHUB_RUN_ID',
  'GITHUB_RUN_ATTEMPT', 'RET010_HOLDOUT_QUALIFICATION_SHA',
  'RET010_HOLDOUT_APPROVAL_DIGEST', 'RET010_HOLDOUT_GATE_OUTCOME',
] as const;
const ROW_KEYS = [
  'scenarioId', 'probeId', 'controlMetric', 'candidateMetric', 'controlCoverage',
  'controlTokens', 'candidateCoverage', 'candidateTokens', 'staleLeakRate',
  'isolationLeakRate', 'duplicateRate', 'unknownResultRate',
] as const;
const ORDINALS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10'] as const;
const FAILURE_CLASS_BY_STAGE = Object.freeze({
  'source-integrity': 'custody', approval: 'custody', 'load-holdout': 'harness',
  'recall-comparison': 'model', 'precision-comparison': 'model', efficiency: 'metric',
  'quality-policy': 'metric', 'safety-policy': 'safety', artifact: 'custody',
} as const);
const REJECTION = new Error('ret010');
const APPROVAL_PATH = 'bench/lab/ret010/approved-dev.json';
const arrayIsArray = Array.isArray;
const arrayPrototype = Array.prototype;
const objectCreate = Object.create;
const objectDefineProperty = Object.defineProperty;
const objectDefineProperties = Object.defineProperties;
const objectFreeze = Object.freeze;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectKeys = Object.keys;
const objectPrototype = Object.prototype;
const reflectApply = Reflect.apply;
const reflectOwnKeys = Reflect.ownKeys;
const setAdd = Set.prototype.add;
const setHas = Set.prototype.has;
const isProxy = utilTypes.isProxy;

function reject(): never { throw REJECTION; }
function hex40(value: unknown): value is string { return typeof value === 'string' && HEX40.test(value); }
function hex64(value: unknown): value is string { return typeof value === 'string' && HEX64.test(value); }
function positiveString(value: unknown): value is string { return typeof value === 'string' && POSITIVE.test(value); }
function record(value: unknown): JsonRecord {
  if (value === null || typeof value !== 'object' || isProxy(value) || arrayIsArray(value)) reject();
  const proto = objectGetPrototypeOf(value);
  if (proto !== objectPrototype && proto !== null) reject();
  return value as JsonRecord;
}
function exactData(value: JsonRecord, expected: readonly string[]): readonly unknown[] {
  if (isProxy(value)) reject();
  const keys = objectKeys(value);
  if (keys.length !== expected.length) reject();
  const values: unknown[] = [];
  for (let index = 0; index < expected.length; index += 1) {
    const name = expected[index]!;
    if (keys[index] !== name) reject();
    const descriptor = objectGetOwnPropertyDescriptor(value, name);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) reject();
    appendOwn(values, descriptor.value);
  }
  if (reflectOwnKeys(value).length !== expected.length) reject();
  return objectFreeze(values);
}
function exact(value: JsonRecord, expected: readonly string[]): void {
  exactData(value, expected);
}
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)
    && value >= 0 && value <= 1;
}
function token(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0)
    && value >= 0 && value <= 1_000_000;
}
function canonical(value: JsonRecord): Buffer { return Buffer.from(JSON.stringify(value) + '\n'); }
function sha256(value: Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
function decimal(value: unknown): string {
  if (typeof value !== 'string' || !POSITIVE.test(value)) reject();
  return value;
}
function appendOwn<T>(target: T[], value: T): void {
  const length = objectGetOwnPropertyDescriptor(target, 'length');
  if (!length || !('value' in length) || !Number.isSafeInteger(length.value)) reject();
  objectDefineProperty(target, length.value, {
    value, enumerable: true, writable: true, configurable: true,
  });
}
function environmentNames(): string[] {
  const names = Object.keys(process.env); const folded = new Set<string>();
  for (const name of names) {
    const fold = name.toUpperCase();
    if (folded.has(fold)) reject();
    folded.add(fold);
    if ((fold.startsWith('RET010_') || fold.startsWith('GITHUB_')
      || fold === 'NODE_ENV' || fold === 'NODE_OPTIONS' || fold === 'NODE_PATH')
      && name !== fold) reject();
  }
  return names;
}

function parseJson(bytes: Uint8Array): unknown {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) reject();
  const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  let cursor = 0;
  const white = () => { while (cursor < text.length && /[\x20\t\r\n]/.test(text[cursor]!)) cursor += 1; };
  const string = (): string => {
    if (text[cursor++] !== '"') reject();
    let raw = '"';
    for (;;) {
      if (cursor >= text.length) reject();
      const character = text[cursor++]!; raw += character;
      if (character === '"') break;
      if (character === '\\') {
        if (cursor >= text.length) reject();
        const escaped = text[cursor++]!; raw += escaped;
        if (escaped === 'u') {
          const hex = text.slice(cursor, cursor + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) reject();
          raw += hex; cursor += 4;
        }
      } else if (character.charCodeAt(0) < 0x20) reject();
    }
    try { return JSON.parse(raw) as string; } catch { reject(); }
  };
  const number = (): number => {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(cursor));
    if (!match) reject();
    cursor += match[0].length;
    const result = Number(match[0]);
    if (!Number.isFinite(result)) reject();
    return result;
  };
  const value = (): unknown => {
    white();
    if (text[cursor] === '"') return string();
    if (text[cursor] === '{') {
      cursor += 1; white();
      const result = Object.create(null) as JsonRecord; const seen = new Set<string>();
      if (text[cursor] === '}') { cursor += 1; return result; }
      for (;;) {
        white(); const name = string(); white();
        if (seen.has(name) || text[cursor++] !== ':') reject();
        seen.add(name);
        Object.defineProperty(result, name, { value: value(), enumerable: true, writable: true });
        white(); const separator = text[cursor++];
        if (separator === '}') return result;
        if (separator !== ',') reject();
      }
    }
    if (text[cursor] === '[') {
      cursor += 1; white(); const result: unknown[] = [];
      if (text[cursor] === ']') { cursor += 1; return result; }
      let index = 0;
      for (;;) {
        Object.defineProperty(result, index++, { value: value(), enumerable: true, writable: true });
        white(); const separator = text[cursor++];
        if (separator === ']') return result;
        if (separator !== ',') reject();
      }
    }
    if (text.startsWith('true', cursor)) { cursor += 4; return true; }
    if (text.startsWith('false', cursor)) { cursor += 5; return false; }
    if (text.startsWith('null', cursor)) { cursor += 4; return null; }
    return number();
  };
  const result = value(); white();
  if (cursor !== text.length) reject();
  return result;
}

type GitRunner = (args: readonly string[], maximum?: number) => Buffer;
function hardenedGit(args: readonly string[], maximum = 5_000_000,
  transport: typeof spawnSync = spawnSync): Buffer {
  const environment: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv;
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.toUpperCase().startsWith('GIT_')) Object.defineProperty(environment, name, {
      value, enumerable: true, writable: true, configurable: true,
    });
  }
  for (const [name, value] of Object.entries({
    GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
  })) Object.defineProperty(environment, name, { value, enumerable: true, writable: true });
  Object.freeze(environment);
  const stdio: ['ignore', 'pipe', 'pipe'] = ['ignore', 'pipe', 'pipe'];
  Object.freeze(stdio);
  const spawnOptions = { cwd: process.cwd(), env: environment, encoding: 'buffer' as const,
    maxBuffer: maximum, stdio, timeout: 30_000, killSignal: 'SIGKILL' as const,
    windowsHide: true };
  Object.freeze(spawnOptions);
  const result = transport('git', [
    '--no-replace-objects', '--no-optional-locks', '-c', 'core.fsmonitor=false',
    '-c', 'core.untrackedCache=false', ...args,
  ], spawnOptions);
  if (result.error || result.signal !== null || result.status !== 0
    || !Buffer.isBuffer(result.stdout) || !Buffer.isBuffer(result.stderr)
    || result.stderr.length !== 0 || result.stdout.length > maximum) reject();
  return result.stdout;
}

function gitBlobSha1(bytes: Buffer): string {
  const decimalLength = String(bytes.byteLength);
  const headerLength = 5 + decimalLength.length + 1;
  const owned = Buffer.alloc(headerLength + bytes.byteLength);
  owned.write('blob ', 0, 5, 'ascii');
  owned.write(decimalLength, 5, decimalLength.length, 'ascii');
  owned[headerLength - 1] = 0;
  bytes.copy(owned, headerLength);
  return createHash('sha1').update(owned).digest('hex');
}

function gitBlob(ref: string, path: string, git: GitRunner = hardenedGit): { bytes: Buffer; id: string } {
  if (!hex40(ref) || path.length === 0 || path.includes('\0')) reject();
  const bytes = git(['cat-file', 'blob', `${ref}:${path}`]);
  const rawId = git(['rev-parse', `${ref}:${path}`], 128).toString('utf8');
  if (!/^[0-9a-f]{40}\n$/.test(rawId)) reject();
  const id = rawId.slice(0, -1);
  if (gitBlobSha1(bytes) !== id) reject();
  return { bytes, id };
}
function textLf(bytes: Uint8Array): Buffer {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return Buffer.from(text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
}
function validateHoldoutPolicy(child: string, git: GitRunner = hardenedGit): void {
  const committed = gitBlob(child, 'bench/lab/ret010/holdout-policy.json', git).bytes;
  const expected = {
    schemaVersion: 1, controlAdapterId: 'memberry-retrieval-core-disabled-v1',
    candidateAdapterId: 'memberry-retrieval-core-served-v1',
    dataset: { id: 'memberry-g2-holdout-holdout', split: 'holdout' },
    lanes: {
      recall: { dimension: 'recall', probes: 10, k: 10, minimumDelta: 0 },
      precision: { dimension: 'precision', probes: 10, k: 5, minimumDelta: 0 },
    },
    safety: { maxStaleLeakRate: 0, maxIsolationLeakRate: 0, maxDuplicateRate: 0, maxUnknownResultRate: 0 },
    pairedVectorOrder: ['recall', 'precision'], withinLaneSortKeys: ['scenarioId', 'probeId'],
    efficiency: { outcome: 'measured', method: 'paired-bootstrap', confidenceLevel: 0.95,
      minimumPointDeltaInclusive: 0, minimumOneSided95LowerBound: 0, resamples: 2000,
      minimumPairedProbes: 10, seedRule: 'vector-derived' },
  };
  const parsed = parseJson(committed);
  if (JSON.stringify(parsed) !== JSON.stringify(expected)) reject();
}

function developmentBindings(parent: string, git: GitRunner = hardenedGit): JsonRecord {
  const registry = record(parseJson(gitBlob(parent, 'bench/lab/registry/datasets.json', git).bytes));
  if (!Array.isArray(registry.datasets)) reject();
  const matches = registry.datasets.filter((item) => record(item).id === 'memberry-ret010-dev-v1');
  if (matches.length !== 1) reject();
  const input = textLf(gitBlob(parent, 'bench/lab/datasets/ret010/v1/dev/input.jsonl', git).bytes);
  const oracle = textLf(gitBlob(parent, 'bench/lab/datasets/ret010/v1/dev/oracle.jsonl', git).bytes);
  const descriptor = record(matches[0]);
  if (!Array.isArray(descriptor.artifacts) || descriptor.artifacts.length !== 2) reject();
  const inputDescriptor = record(descriptor.artifacts[0]); const oracleDescriptor = record(descriptor.artifacts[1]);
  if (inputDescriptor.sha256 !== sha256(input) || inputDescriptor.sizeBytes !== input.length
    || oracleDescriptor.sha256 !== sha256(oracle) || oracleDescriptor.sizeBytes !== oracle.length) reject();
  return {
    datasetDescriptorSha256: sha256(Buffer.from(JSON.stringify(descriptor))),
    inputSha256: sha256(input), oracleSha256: sha256(oracle),
    devPolicySha256: sha256(gitBlob(parent, 'bench/lab/ret010/dev-policy.json', git).bytes),
  };
}

type ApprovalDispatch = Readonly<{ approvalBytes: Buffer; child: string; parent: string }>;
type ApprovalLineage = Readonly<{ child: string; parent: string; approvalBlob: string }>;
function approvalLineage(child: string, git: GitRunner = hardenedGit): ApprovalLineage {
  if (!hex40(child)) reject();
  const parents = git(['rev-list', '--parents', '--max-count=1', '--no-abbrev-commit', child], 256);
  const match = /^([0-9a-f]{40}) ([0-9a-f]{40})\n$/.exec(parents.toString('utf8'));
  if (!match || match[1] !== child) reject();
  const parent = match[2]!;
  const diff = git(['diff-tree', '--no-commit-id', '-r', '--find-renames=100%',
    '--find-copies=100%', '--find-copies-harder', '--no-abbrev', '--raw', '-z', parent, child], 1024);
  const prefix = Buffer.from(`:000000 100644 ${'0'.repeat(40)} `);
  const suffix = Buffer.from(` A\0${APPROVAL_PATH}\0`);
  if (diff.length !== prefix.length + 40 + suffix.length
    || !diff.subarray(0, prefix.length).equals(prefix)
    || !diff.subarray(prefix.length + 40).equals(suffix)) reject();
  const approvalBlob = diff.subarray(prefix.length, prefix.length + 40).toString('ascii');
  if (!hex40(approvalBlob)) reject();
  return Object.freeze({ child, parent, approvalBlob });
}

function bindApprovalCommit(lineage: ApprovalLineage, working: Buffer, digest: string,
  git: GitRunner = hardenedGit): ApprovalDispatch {
  if (!hex64(digest)) reject();
  const committed = gitBlob(lineage.child, APPROVAL_PATH, git);
  if (committed.id !== lineage.approvalBlob || !working.equals(committed.bytes)
    || sha256(working) !== digest) reject();
  return Object.freeze({ approvalBytes: working, child: lineage.child, parent: lineage.parent });
}

async function validateHostedDispatch(): Promise<ApprovalDispatch> {
  const env = process.env;
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
    || env.GITHUB_REPOSITORY !== 'AP3X-Dev/memberry'
    || env.GITHUB_REF !== 'refs/heads/master'
    || !hex40(env.RET010_HOLDOUT_QUALIFICATION_SHA)
    || env.RET010_HOLDOUT_QUALIFICATION_SHA !== env.GITHUB_SHA
    || !hex64(env.RET010_HOLDOUT_APPROVAL_DIGEST)
    || typeof env.GITHUB_EVENT_PATH !== 'string') reject();
  const event = record(parseJson(await readFile(env.GITHUB_EVENT_PATH)));
  const repository = record(event.repository); const inputs = record(event.inputs);
  exact(inputs, ['qualification_sha', 'approval_digest']);
  if (repository.full_name !== 'AP3X-Dev/memberry' || event.ref !== 'master'
    || inputs.qualification_sha !== env.RET010_HOLDOUT_QUALIFICATION_SHA
    || inputs.approval_digest !== env.RET010_HOLDOUT_APPROVAL_DIGEST) reject();
  const head = hardenedGit(['rev-parse', 'HEAD']).toString('utf8');
  const dirty = hardenedGit(['status', '--porcelain=v1', '--untracked-files=all']);
  if (head !== `${env.GITHUB_SHA}\n` || dirty.length !== 0) reject();
  const child = head.slice(0, -1);
  let attached = true;
  try { hardenedGit(['symbolic-ref', '-q', 'HEAD']); } catch { attached = false; }
  if (attached) reject();
  const lineage = approvalLineage(child);
  const path = resolve(process.cwd(), APPROVAL_PATH);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || await realpath(path) !== path) reject();
  const working = await readFile(path);
  const dispatch = bindApprovalCommit(lineage, working, env.RET010_HOLDOUT_APPROVAL_DIGEST);
  validateHoldoutPolicy(child);
  return dispatch;
}

function validateLane(value: unknown, lane: 'recall' | 'precision', identities: Set<object>): FixtureLane {
  if (value === null || typeof value !== 'object' || isProxy(value) || !arrayIsArray(value)
    || objectGetPrototypeOf(value) !== arrayPrototype) reject();
  const keys = reflectOwnKeys(value);
  if (keys.length !== 11 || keys[10] !== 'length') reject();
  const length = objectGetOwnPropertyDescriptor(value, 'length');
  if (!length || !('value' in length) || length.value !== 10 || length.enumerable
    || length.configurable) reject();
  const laneValues: unknown[] = [];
  for (let index = 0; index < 10; index += 1) {
    const name = String(index);
    if (keys[index] !== name) reject();
    const descriptor = objectGetOwnPropertyDescriptor(value, name);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) reject();
    appendOwn(laneValues, descriptor.value);
  }
  const result: JsonRecord[] = [];
  for (let index = 0; index < laneValues.length; index += 1) {
    const raw = laneValues[index];
    const item = record(raw);
    if (reflectApply(setHas, identities, [item])) reject();
    reflectApply(setAdd, identities, [item]);
    const itemValues = exactData(item, ROW_KEYS);
    const ordinal = ORDINALS[index]!;
    if (itemValues[0] !== `fixture-${lane}-${ordinal}`
      || itemValues[1] !== `fixture-probe-${ordinal}`) reject();
    for (const position of [2, 3, 4, 6, 8, 9, 10, 11]) {
      if (!finite(itemValues[position])) reject();
    }
    if (!token(itemValues[5]) || !token(itemValues[7])) reject();
    const copy = objectCreate(null) as JsonRecord;
    for (let position = 0; position < ROW_KEYS.length; position += 1) objectDefineProperty(copy, ROW_KEYS[position]!, {
      value: itemValues[position], enumerable: true, writable: false, configurable: false,
    });
    appendOwn(result, objectFreeze(copy));
  }
  return objectFreeze(result);
}

export function validateHoldoutFixtureRecord(value: unknown): Readonly<JsonRecord> {
  try {
    const source = record(value);
    const sourceValues = exactData(source, ['schemaVersion', 'recall', 'precision']);
    if (sourceValues[0] !== '1' || sourceValues[1] === sourceValues[2]) reject();
    const identities = new Set<object>();
    const result = objectCreate(null) as JsonRecord;
    objectDefineProperties(result, {
      schemaVersion: { value: '1', enumerable: true },
      recall: { value: validateLane(sourceValues[1], 'recall', identities), enumerable: true },
      precision: { value: validateLane(sourceValues[2], 'precision', identities), enumerable: true },
    });
    return objectFreeze(result);
  } catch { reject(); }
}

function identity(test: boolean): JsonRecord {
  const env = process.env;
  const prefix = test ? 'RET010_HOLDOUT_TEST_' : '';
  const gitCommit = test ? env.RET010_HOLDOUT_TEST_GIT_COMMIT : env.GITHUB_SHA;
  const workflowRunId = test ? env.RET010_HOLDOUT_TEST_RUN_ID : env.GITHUB_RUN_ID;
  const workflowRunAttempt = test ? env.RET010_HOLDOUT_TEST_RUN_ATTEMPT : env.GITHUB_RUN_ATTEMPT;
  const approvalSha256 = test ? env.RET010_HOLDOUT_TEST_APPROVAL_SHA256 : env.RET010_HOLDOUT_APPROVAL_DIGEST;
  const nodeMajor = process.versions.node.split('.')[0];
  if (!hex40(gitCommit) || !positiveString(workflowRunId)
    || !positiveString(workflowRunAttempt) || !hex64(approvalSha256)
    || !['20', '22'].includes(nodeMajor)
    || !(new RegExp(`^v${nodeMajor}\\.[0-9]+\\.[0-9]+$`)).test(process.version)) reject();
  if (!test) {
    const head = hardenedGit(['rev-parse', 'HEAD']).toString('utf8');
    const dirty = hardenedGit(['status', '--porcelain=v1', '--untracked-files=all']);
    if (head !== `${gitCommit}\n` || dirty.length !== 0) reject();
  }
  void prefix;
  return {
    gitCommit, nodeMajor, nodeVersion: process.version,
    workflowRunId, workflowRunAttempt, approvalSha256,
  };
}
async function runnerRoot(test: boolean, create: boolean): Promise<string> {
  const value = test ? process.env.RET010_HOLDOUT_TEST_RUNNER_TEMP : process.env.RUNNER_TEMP;
  if (!value || value !== resolve(value)) reject();
  const base = resolve(value);
  await directory(base);
  const family = resolve(base, 'memberry-ret010-holdout');
  const runs = resolve(family, 'runs');
  if (create) {
    await mkdir(family, { recursive: false, mode: 0o700 });
    await mkdir(runs, { recursive: false, mode: 0o700 });
  } else {
    await directory(family); await directory(runs);
  }
  return runs;
}
function receiptName(id: JsonRecord): string {
  return `ret010-holdout-run-${id.workflowRunId}-attempt-${id.workflowRunAttempt}-node-${id.nodeMajor}`;
}
async function directory(value: string): Promise<void> {
  const info = await lstat(value);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(value) !== value) reject();
}
type RetainedOwner = {
  absolute: string;
  handle: Awaited<ReturnType<typeof open>>;
  kind: 'file' | 'directory';
  maximum: number;
  snapshot?: { dev: bigint; ino: bigint; mode: bigint; size: bigint };
  closeAttempted: boolean;
  bytes?: Buffer;
};
type CustodyScope = { owners: RetainedOwner[] };

function retainedSnapshot(stat: { dev: bigint; ino: bigint; mode: bigint; size: bigint }):
{ dev: bigint; ino: bigint; mode: bigint; size: bigint } {
  return Object.freeze({
    dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size,
  });
}
function retainedIdentityMatches(
  stat: { dev: bigint | number; ino: bigint | number; mode: bigint | number; size: bigint | number },
  snapshot: NonNullable<RetainedOwner['snapshot']>, kind: RetainedOwner['kind'],
): boolean {
  return stat.dev === snapshot.dev && stat.ino === snapshot.ino && stat.mode === snapshot.mode
    && (kind === 'directory' || stat.size === snapshot.size);
}
async function retainedCustody<T>(
  operation: (scope: CustodyScope) => Promise<T>,
  lifecycleHooks: { closeHandle?: (owner: RetainedOwner) => Promise<void> } = {},
): Promise<T> {
  const owners: RetainedOwner[] = [];
  const scope = Object.freeze({ owners });
  let result: T | undefined; let operationFailed = false; let failure: unknown;
  try { result = await operation(scope); } catch (error) { operationFailed = true; failure = error; }
  const closeFailures: unknown[] = [];
  for (let index = owners.length - 1; index >= 0; index -= 1) {
    const owner = owners[index]!;
    if (owner.closeAttempted) {
      appendOwn(closeFailures, new Error('ret010'));
      continue;
    }
    owner.closeAttempted = true;
    try {
      if (lifecycleHooks.closeHandle) await lifecycleHooks.closeHandle(owner);
      else await owner.handle.close();
    } catch (error) { appendOwn(closeFailures, error); }
  }
  if (closeFailures.length) {
    failure = operationFailed
      ? new AggregateError([failure, ...closeFailures], 'ret010')
      : new AggregateError(closeFailures, 'ret010');
    operationFailed = true;
  }
  if (operationFailed) throw failure;
  return result as T;
}
async function retainHandle(
  scope: CustodyScope, absolute: string, flags: number, kind: RetainedOwner['kind'],
  maximum = 2_000_000, mode?: number,
): Promise<RetainedOwner> {
  if (typeof fsConstants.O_NOFOLLOW !== 'number') reject();
  await directory(resolve(absolute, '..'));
  const handle = mode === undefined
    ? await open(absolute, flags | fsConstants.O_NOFOLLOW)
    : await open(absolute, flags | fsConstants.O_NOFOLLOW, mode);
  const owner: RetainedOwner = {
    absolute, handle, kind, maximum, snapshot: undefined, bytes: undefined, closeAttempted: false,
  };
  appendOwn(scope.owners, owner);
  const opened = await handle.stat({ bigint: true });
  const current = await lstat(absolute, { bigint: true });
  if (kind === 'directory') {
    if (!opened.isDirectory() || !current.isDirectory() || current.isSymbolicLink()
      || await realpath(absolute) !== absolute) reject();
  } else if (!opened.isFile() || !current.isFile() || current.isSymbolicLink()
    || opened.size > BigInt(maximum)) reject();
  owner.snapshot = retainedSnapshot(opened);
  if (!retainedIdentityMatches(current, owner.snapshot, kind)) reject();
  return owner;
}
async function auditRetained(owner: RetainedOwner, expected?: Buffer): Promise<Buffer | undefined> {
  if (!owner.snapshot) reject();
  const opened = await owner.handle.stat({ bigint: true });
  const current = await lstat(owner.absolute, { bigint: true });
  if (!retainedIdentityMatches(opened, owner.snapshot, owner.kind)
    || !retainedIdentityMatches(current, owner.snapshot, owner.kind)
    || current.isSymbolicLink()) reject();
  if (owner.kind === 'directory') {
    if (!opened.isDirectory() || !current.isDirectory()
      || await realpath(owner.absolute) !== owner.absolute) reject();
    return undefined;
  }
  if (!opened.isFile() || !current.isFile() || opened.size > BigInt(owner.maximum)) reject();
  const bytes = Buffer.alloc(Number(owner.snapshot.size));
  const result = await owner.handle.read(bytes, 0, bytes.length, 0);
  if (result.bytesRead !== bytes.length) reject();
  const after = await owner.handle.stat({ bigint: true });
  if (!retainedIdentityMatches(after, owner.snapshot, owner.kind)
    || (expected && !bytes.equals(expected))) reject();
  return bytes;
}
async function retainRead(scope: CustodyScope, absolute: string, maximum = 2_000_000): Promise<RetainedOwner> {
  const owner = await retainHandle(scope, absolute, fsConstants.O_RDONLY, 'file', maximum);
  owner.bytes = await auditRetained(owner) as Buffer;
  return owner;
}
async function retainDirectory(scope: CustodyScope, absolute: string): Promise<RetainedOwner> {
  return retainHandle(scope, absolute, fsConstants.O_RDONLY, 'directory');
}
async function retainExclusiveWrite(
  scope: CustodyScope, root: string, name: string, value: JsonRecord,
): Promise<RetainedOwner> {
  await directory(root);
  const bytes = canonical(value);
  const owner = await retainHandle(scope, resolve(root, name),
    fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL, 'file', 2_000_000, 0o600);
  const result = await owner.handle.write(bytes, 0, bytes.length, 0);
  if (result.bytesWritten !== bytes.length) reject();
  await owner.handle.sync();
  owner.snapshot = retainedSnapshot(await owner.handle.stat({ bigint: true }));
  if (!((await auditRetained(owner, bytes)) as Buffer).equals(bytes)) reject();
  owner.bytes = bytes;
  return owner;
}
async function writeExclusive(root: string, name: string, value: JsonRecord): Promise<Buffer> {
  return retainedCustody(async (scope) =>
    (await retainExclusiveWrite(scope, root, name, value)).bytes as Buffer);
}
type FixtureFdStat = {
  dev: bigint; ino: bigint; mode: bigint;
  isFIFO(): boolean;
  isSocket?(): boolean;
};
type FixtureFdIo = {
  fstat?: (fd: number) => Promise<FixtureFdStat>;
  read?: (fd: number, buffer: Buffer, offset: number, length: number) => Promise<number>;
  close?: (fd: number) => Promise<void>;
};

function fstatFd(fd: number): Promise<FixtureFdStat> {
  return new Promise((resolveStat, rejectStat) => fsFstat(fd, { bigint: true }, (error, stat) => {
    if (error) rejectStat(error);
    else resolveStat(stat);
  }));
}
function readFd(fd: number, buffer: Buffer, offset: number, length: number): Promise<number> {
  return new Promise((resolveRead, rejectRead) => fsRead(fd, buffer, offset, length, null,
    (error, bytesRead, returned) => {
      if (error) rejectRead(error);
      else if (returned !== buffer) rejectRead(new Error('ret010'));
      else resolveRead(bytesRead);
    }));
}
function closeFd(fd: number): Promise<void> {
  return new Promise((resolveClose, rejectClose) => fsClose(fd, (error) => {
    if (error) rejectClose(error);
    else resolveClose();
  }));
}
function fixturePipe(stat: FixtureFdStat): boolean {
  const format = stat.mode & BigInt(fsConstants.S_IFMT);
  return stat.isFIFO() || stat.isSocket?.() === true
    || format === BigInt(fsConstants.S_IFIFO)
    || (typeof fsConstants.S_IFSOCK === 'number' && format === BigInt(fsConstants.S_IFSOCK));
}
function fixtureFdIdentity(stat: FixtureFdStat): readonly [bigint, bigint, bigint] {
  const identity: [bigint, bigint, bigint] = [stat.dev, stat.ino, stat.mode];
  return Object.freeze(identity);
}
function rejectionCode(value: unknown): unknown {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function') || isProxy(value)) {
    return undefined;
  }
  try {
    const descriptor = objectGetOwnPropertyDescriptor(value, 'code');
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch { return undefined; }
}
async function fixtureBytes(io: FixtureFdIo = {}): Promise<Buffer> {
  const fstat = io.fstat ?? fstatFd; const read = io.read ?? readFd; const close = io.close ?? closeFd;
  const buffer = Buffer.alloc(65_536);
  let initialFstatPending = true; let closeRequired = true;
  let failed = false; let failure: unknown; let length = 0; let complete = false;
  let identity: readonly [bigint, bigint, bigint] | undefined;
  try {
    const before = await fstat(3);
    initialFstatPending = false;
    if (!fixturePipe(before)) reject();
    identity = fixtureFdIdentity(before);
    while (!complete) {
      const available = buffer.length - length;
      const offset = available === 0 ? 0 : length;
      const requested = available === 0 ? 1 : Math.min(4096, available);
      const bytesRead = await read(3, buffer, offset, requested);
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > requested) reject();
      if (bytesRead === 0) { complete = true; break; }
      if (available === 0) reject();
      for (let index = length; index < length + bytesRead; index += 1) {
        if (buffer[index] === 10 && index !== length + bytesRead - 1) reject();
        if (index > 0 && buffer[index - 1] === 10) reject();
      }
      length += bytesRead;
    }
    if (!complete || length === 0 || buffer[length - 1] !== 10) reject();
    const after = await fstat(3);
    if (!fixturePipe(after) || !identity
      || after.dev !== identity[0] || after.ino !== identity[1] || after.mode !== identity[2]) reject();
  } catch (error) {
    if (initialFstatPending && rejectionCode(error) === 'EBADF') closeRequired = false;
    failed = true;
    failure = error;
  }
  if (closeRequired) {
    try { await close(3); } catch (error) {
      failure = failed ? new AggregateError([failure, error], 'ret010') : error;
      failed = true;
    }
  }
  if (failed) throw failure;
  return buffer.subarray(0, length);
}
async function appendStructuredOutput(absolute: string, value: string): Promise<void> {
  const bytes = Buffer.from(value, 'utf8');
  await retainedCustody(async (scope) => {
    const owner = await retainHandle(scope, absolute,
      fsConstants.O_WRONLY | fsConstants.O_APPEND, 'file', 2_000_000);
    const result = await owner.handle.write(bytes, 0, bytes.length, null);
    if (result.bytesWritten !== bytes.length) reject();
    await owner.handle.sync();
  });
}
function fixtureMode(command: 'run' | 'finalize'): boolean {
  const names = environmentNames();
  if (!Object.hasOwn(process.env, 'RET010_HOLDOUT_TEST_FIXTURE')) {
    if (names.some((name) => name.startsWith('RET010_HOLDOUT_TEST_'))) reject();
    return false;
  }
  if (process.env.RET010_HOLDOUT_TEST_FIXTURE !== '1' || process.env.NODE_ENV !== 'test'
    || Object.hasOwn(process.env, 'GITHUB_ACTIONS')) reject();
  const required = command === 'run' ? RUN_TEST_KEYS : TEST_KEYS;
  const allowed = new Set<string>(['RET010_HOLDOUT_TEST_FIXTURE', ...required]);
  for (const key of names) {
    if (key.startsWith('RET010_') && !allowed.has(key)) reject();
    if (key.startsWith('GITHUB_') && !(command === 'finalize' && key === 'GITHUB_OUTPUT')) reject();
  }
  for (const key of PROD_KEYS) if (Object.hasOwn(process.env, key)) reject();
  for (const key of required) if (!Object.hasOwn(process.env, key)) reject();
  return true;
}
type InheritedFd3Io = {
  fstat?: (fd: number) => {
    mode: number;
    isFIFO(): boolean;
    isSocket?(): boolean;
    isFile?(): boolean;
    isDirectory?(): boolean;
    isCharacterDevice?(): boolean;
    isBlockDevice?(): boolean;
  };
  close?: (fd: number) => void;
};
function closeInheritedFd3(io: InheritedFd3Io = {}): void {
  const fstat = io.fstat ?? fstatSync;
  const close = io.close ?? fsCloseSync;
  try {
    const stat = fstat(3);
    const typed = (stat.mode & fsConstants.S_IFMT) !== 0 || stat.isFIFO()
      || stat.isSocket?.() === true || stat.isFile?.() === true
      || stat.isDirectory?.() === true || stat.isCharacterDevice?.() === true
      || stat.isBlockDevice?.() === true;
    if (!typed) return;
    close(3);
  } catch (error) {
    if (rejectionCode(error) === 'EBADF') return;
    reject();
  }
}
function aggregateFixture(value: Readonly<JsonRecord>,
  setStage: (stage: keyof typeof FAILURE_CLASS_BY_STAGE) => void = () => {}): JsonRecord {
  const recall = value.recall as FixtureLane; const precision = value.precision as FixtureLane;
  const all = [...recall, ...precision];
  const mean = (lane: FixtureLane, key: string) =>
    lane.reduce((sum, item) => sum + (item[key] as number), 0) / lane.length;
  const recallDelta = mean(recall, 'candidateMetric') - mean(recall, 'controlMetric');
  const precisionDelta = mean(precision, 'candidateMetric') - mean(precision, 'controlMetric');
  setStage('recall-comparison');
  if (recallDelta < 0) reject();
  setStage('precision-comparison');
  if (precisionDelta < 0) reject();
  const asPairs = (lane: FixtureLane): EfficiencyPair[] => lane.map((item) => ({
    scenarioId: item.scenarioId as string, probeId: item.probeId as string,
    controlCoverage: item.controlCoverage as number, controlTokens: item.controlTokens as number,
    candidateCoverage: item.candidateCoverage as number, candidateTokens: item.candidateTokens as number,
  }));
  const pairs = orderedEfficiencyPairs(asPairs(recall), asPairs(precision));
  setStage('efficiency');
  const interval = pairedEfficiencyInterval(pairs);
  if (interval.outcome !== 'measured' || interval.point === null || interval.lower === null
    || interval.upper === null || interval.oneSidedLower === null
    || interval.point < 0 || interval.oneSidedLower < 0) reject();
  setStage('quality-policy');
  const safety = {
    staleLeakRate: mean(all, 'staleLeakRate'), isolationLeakRate: mean(all, 'isolationLeakRate'),
    duplicateRate: mean(all, 'duplicateRate'), unknownResultRate: mean(all, 'unknownResultRate'),
  };
  setStage('safety-policy');
  if (Object.values(safety).some((entry) => entry !== 0)) reject();
  return {
    recall: { scenarioCount: 10, probeCount: 10, k: 10, metric: 'recallAtK',
      control: mean(recall, 'controlMetric'), candidate: mean(recall, 'candidateMetric'), delta: recallDelta },
    precision: { scenarioCount: 10, probeCount: 10, k: 5, metric: 'precisionAtK',
      control: mean(precision, 'controlMetric'), candidate: mean(precision, 'candidateMetric'), delta: precisionDelta },
    efficiency: interval, safety,
  };
}

function orderedEfficiencyPairs(recall: readonly EfficiencyPair[],
  precision: readonly EfficiencyPair[]): EfficiencyPair[] {
  const copy = (lane: readonly EfficiencyPair[]) => lane.map((pair) => ({
    scenarioId: pair.scenarioId, probeId: pair.probeId,
    controlCoverage: pair.controlCoverage, controlTokens: pair.controlTokens,
    candidateCoverage: pair.candidateCoverage, candidateTokens: pair.candidateTokens,
  }));
  const compare = (left: EfficiencyPair, right: EfficiencyPair) =>
    left.scenarioId < right.scenarioId ? -1 : left.scenarioId > right.scenarioId ? 1
      : left.probeId < right.probeId ? -1 : left.probeId > right.probeId ? 1 : 0;
  return [...copy(recall).sort(compare), ...copy(precision).sort(compare)];
}

function validateApproval(value: unknown, id: JsonRecord, parent: string,
  git: GitRunner = hardenedGit): JsonRecord {
  const approval = record(value);
  exact(approval, ['schemaVersion', 'decision', 'source', 'development', 'node20', 'node22',
    'workflowRunId', 'workflowRunAttempt']);
  const source = record(approval.source);
  exact(source, ['gitCommit', 'modelBlob', 'providerContractBlob', 'adapterBlob',
    'statisticsBlob', 'providerIdentity']);
  const provider = record(source.providerIdentity);
  exact(provider, ['providerId', 'modelId', 'calibrationId', 'locality']);
  const development = record(approval.development);
  exact(development, ['datasetDescriptorSha256', 'inputSha256', 'oracleSha256',
    'devPolicySha256', 'seed', 'aggregateResultSha256']);
  const run = decimal(approval.workflowRunId); const attempt = decimal(approval.workflowRunAttempt);
  for (const [name, major] of [['node20', '20'], ['node22', '22']] as const) {
    const node = record(approval[name]);
    exact(node, ['nodeVersion', 'custodyManifestSha256', 'completionMarkerSha256',
      'artifactName', 'artifactId', 'artifactServiceSha256']);
    if (typeof node.nodeVersion !== 'string'
      || !(new RegExp(`^v${major}\\.[0-9]+\\.[0-9]+$`)).test(node.nodeVersion)
      || node.artifactName !== `memberry-ret010-development-node-${major}-${run}-${attempt}`
      || !positiveString(node.artifactId)) reject();
    for (const key of ['custodyManifestSha256', 'completionMarkerSha256', 'artifactServiceSha256'])
      if (!hex64(node[key])) reject();
  }
  const node20 = record(approval.node20); const node22 = record(approval.node22);
  if (node20.artifactId === node22.artifactId) reject();
  const nodeDigests = [node20.artifactServiceSha256, node20.custodyManifestSha256,
    node20.completionMarkerSha256, node22.artifactServiceSha256,
    node22.custodyManifestSha256, node22.completionMarkerSha256];
  if (new Set(nodeDigests).size !== nodeDigests.length) reject();
  // The committed child approval bytes plus dispatch digest are the post-expiry authority.
  // A uniqueness-preserving two-way swap is therefore a different valid committed authority,
  // while one-way cross-node substitutions are detectable here as duplicates.
  for (const key of ['gitCommit', 'modelBlob', 'providerContractBlob', 'adapterBlob', 'statisticsBlob'])
    if (!hex40(source[key])) reject();
  for (const key of ['datasetDescriptorSha256', 'inputSha256', 'oracleSha256',
    'devPolicySha256', 'aggregateResultSha256']) if (!hex64(development[key])) reject();
  const bindings = developmentBindings(parent, git);
  if (approval.schemaVersion !== '1' || approval.decision !== 'approved'
    || source.gitCommit !== parent || parent === id.gitCommit || !Number.isInteger(development.seed)
    || (development.seed as number) < 0 || (development.seed as number) > 0xffffffff
    || source.modelBlob !== gitBlob(parent, 'packages/retrieval/src/served-reranker.ts', git).id
    || source.providerContractBlob !== gitBlob(parent, 'packages/retrieval/src/reranker.ts', git).id
    || source.adapterBlob !== gitBlob(parent, 'bench/lab/adapters/memberry-retrieval-core.ts', git).id
    || source.statisticsBlob !== gitBlob(parent, 'bench/lab/stats.ts', git).id
    || development.datasetDescriptorSha256 !== bindings.datasetDescriptorSha256
    || development.inputSha256 !== bindings.inputSha256
    || development.oracleSha256 !== bindings.oracleSha256
    || development.devPolicySha256 !== bindings.devPolicySha256
    || JSON.stringify(provider) !== JSON.stringify({ providerId: 'memberry.local.lexical',
      modelId: 'bm25f-query-v1', calibrationId: 'fixed-blend-v1', locality: 'local' })) reject();
  return approval;
}

function validateProductionApproval(dispatch: ApprovalDispatch, id: JsonRecord,
  git: GitRunner = hardenedGit): JsonRecord {
  if (dispatch.child !== id.gitCommit || sha256(dispatch.approvalBytes) !== id.approvalSha256) reject();
  const approval = parseJson(dispatch.approvalBytes) as JsonRecord;
  if (!canonical(approval).equals(dispatch.approvalBytes)) reject();
  return validateApproval(approval, id, dispatch.parent, git);
}

async function productionApprovalBeforeImports(dispatch: ApprovalDispatch, id: JsonRecord,
  beforeRealImports?: () => Promise<void>, git: GitRunner = hardenedGit): Promise<JsonRecord> {
  const approval = validateProductionApproval(dispatch, id, git);
  if (beforeRealImports) await beforeRealImports();
  return approval;
}

function failureReceipt(id: JsonRecord, stage: string): JsonRecord {
  if (!Object.hasOwn(FAILURE_CLASS_BY_STAGE, stage)) reject();
  return {
    schemaVersion: '1', decision: 'failed',
    failureClass: FAILURE_CLASS_BY_STAGE[stage as keyof typeof FAILURE_CLASS_BY_STAGE], stage,
    gitCommit: id.gitCommit, nodeMajor: id.nodeMajor, nodeVersion: id.nodeVersion,
    workflowRunId: id.workflowRunId, workflowRunAttempt: id.workflowRunAttempt,
  };
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0);
}
function validateReceipt(value: unknown, id: JsonRecord): JsonRecord {
  const receipt = record(value);
  if (receipt.decision === 'passed') {
    exact(receipt, ['schemaVersion', 'decision', 'gitCommit', 'nodeMajor', 'nodeVersion',
      'workflowRunId', 'workflowRunAttempt', 'approvalSha256', 'datasetId', 'split',
      'controlAdapterId', 'candidateAdapterId', 'recall', 'precision', 'efficiency', 'safety']);
    for (const [name, k, metric] of [['recall', 10, 'recallAtK'],
      ['precision', 5, 'precisionAtK']] as const) {
      const lane = record(receipt[name]);
      exact(lane, ['scenarioCount', 'probeCount', 'k', 'metric', 'control', 'candidate', 'delta']);
      if (lane.scenarioCount !== 10 || lane.probeCount !== 10 || lane.k !== k || lane.metric !== metric
        || !finite(lane.control) || !finite(lane.candidate) || !finiteNumber(lane.delta)
        || (lane.delta as number) < -1 || (lane.delta as number) > 1
        || lane.delta !== (lane.candidate as number) - (lane.control as number)
        || (lane.delta as number) < 0) reject();
    }
    const efficiency = record(receipt.efficiency);
    exact(efficiency, ['outcome', 'pairedProbes', 'resamples', 'level', 'seed',
      'point', 'lower', 'upper', 'oneSidedLower']);
    if (efficiency.outcome !== 'measured' || efficiency.pairedProbes !== 20
      || efficiency.resamples !== 2000 || efficiency.level !== 0.95
      || !Number.isInteger(efficiency.seed) || (efficiency.seed as number) < 0
      || (efficiency.seed as number) > 0xffffffff
      || !finiteNumber(efficiency.point) || !finiteNumber(efficiency.lower)
      || !finiteNumber(efficiency.upper) || !finiteNumber(efficiency.oneSidedLower)
      || (efficiency.lower as number) > (efficiency.point as number)
      || (efficiency.point as number) > (efficiency.upper as number)
      || (efficiency.oneSidedLower as number) > (efficiency.point as number)
      || (efficiency.point as number) < 0 || (efficiency.oneSidedLower as number) < 0) reject();
    const safety = record(receipt.safety);
    exact(safety, ['staleLeakRate', 'isolationLeakRate', 'duplicateRate', 'unknownResultRate']);
    if (Object.values(safety).some((entry) => entry !== 0)
      || receipt.approvalSha256 !== id.approvalSha256
      || receipt.datasetId !== 'memberry-g2-holdout-holdout' || receipt.split !== 'holdout'
      || receipt.controlAdapterId !== 'memberry-retrieval-core-disabled-v1'
      || receipt.candidateAdapterId !== 'memberry-retrieval-core-served-v1') reject();
  } else if (receipt.decision === 'failed') {
    exact(receipt, ['schemaVersion', 'decision', 'failureClass', 'stage', 'gitCommit',
      'nodeMajor', 'nodeVersion', 'workflowRunId', 'workflowRunAttempt']);
    if (typeof receipt.stage !== 'string' || !Object.hasOwn(FAILURE_CLASS_BY_STAGE, receipt.stage)
      || receipt.failureClass !== FAILURE_CLASS_BY_STAGE[
        receipt.stage as keyof typeof FAILURE_CLASS_BY_STAGE]) reject();
  } else reject();
  if (receipt.schemaVersion !== '1' || receipt.gitCommit !== id.gitCommit
    || receipt.nodeMajor !== id.nodeMajor || receipt.nodeVersion !== id.nodeVersion
    || receipt.workflowRunId !== id.workflowRunId
    || receipt.workflowRunAttempt !== id.workflowRunAttempt) reject();
  return receipt;
}
async function runGate(hooks: {
  fixtureIo?: FixtureFdIo;
  beforeRealImports?: () => Promise<void>;
} = {}): Promise<void> {
  const test = fixtureMode('run');
  const id = identity(test); const parent = await runnerRoot(test, true);
  const root = resolve(parent, receiptName(id));
  await mkdir(root, { recursive: false, mode: 0o700 });
  let stage: keyof typeof FAILURE_CLASS_BY_STAGE = 'source-integrity';
  try {
    if (!test) closeInheritedFd3();
    else stage = 'load-holdout';
    const fixtureInput = test ? await fixtureBytes(hooks.fixtureIo) : undefined;
    const dispatch = test ? undefined : await validateHostedDispatch();
    const approvalBytes = dispatch?.approvalBytes;
    let result: JsonRecord;
    if (test) {
      const bytes = fixtureInput as Buffer;
      if (bytes[bytes.length - 1] !== 10 || bytes.subarray(0, -1).includes(10)) reject();
      const parsed = parseJson(bytes.subarray(0, -1));
      const validated = validateHoldoutFixtureRecord(parsed);
      if (!canonical(validated as JsonRecord).equals(bytes)) reject();
      result = aggregateFixture(validated, (next) => { stage = next; });
    } else {
      // Real holdout imports are delayed until the fixture branch is impossible.
      if (!approvalBytes || !dispatch) reject();
      stage = 'approval';
      await productionApprovalBeforeImports(dispatch, id, hooks.beforeRealImports);
      stage = 'load-holdout';
      const { loadG2HoldoutScenariosForScoring } = await import('../datasets/load-suite.js');
      const { compareRegisteredAdapters } = await import('../registered-adapters.js');
      const recallScenarios = await loadG2HoldoutScenariosForScoring('recall');
      if (recallScenarios.length !== 10
        || new Set(recallScenarios.map((item) => item.input.id)).size !== 10) reject();
      stage = 'recall-comparison';
      const recallReport = await compareRegisteredAdapters({
        runId: 'ret010-holdout-recall', controlId: 'memberry-retrieval-core-disabled-v1',
        candidateId: 'memberry-retrieval-core-served-v1', scenarios: recallScenarios,
        splits: ['holdout'], repoRoot: process.cwd(),
      });
      const recallControl = recallReport.control.metrics.recallAtK;
      const recallCandidate = recallReport.candidate.metrics.recallAtK;
      const recall = { scenarioCount: 10, probeCount: 10, k: 10, metric: 'recallAtK',
        control: recallControl, candidate: recallCandidate, delta: recallCandidate - recallControl };
      if (recall.delta < 0) reject();
      stage = 'load-holdout';
      const precisionScenarios = await loadG2HoldoutScenariosForScoring('precision');
      if (precisionScenarios.length !== 10
        || new Set(precisionScenarios.map((item) => item.input.id)).size !== 10) reject();
      stage = 'precision-comparison';
      const precisionReport = await compareRegisteredAdapters({
        runId: 'ret010-holdout-precision', controlId: 'memberry-retrieval-core-disabled-v1',
        candidateId: 'memberry-retrieval-core-served-v1', scenarios: precisionScenarios,
        splits: ['holdout'], repoRoot: process.cwd(),
      });
      const precisionControl = precisionReport.control.metrics.precisionAtK;
      const precisionCandidate = precisionReport.candidate.metrics.precisionAtK;
      const precision = { scenarioCount: 10, probeCount: 10, k: 5, metric: 'precisionAtK',
        control: precisionControl, candidate: precisionCandidate, delta: precisionCandidate - precisionControl };
      if (precision.delta < 0) reject();
      const reports = [recallReport, precisionReport];
      const lanePairs = reports.map((report) => report.control.scenarioReports.flatMap((scenario) => {
        const candidate = report.candidate.scenarioReports.find((item) => item.scenarioId === scenario.scenarioId);
        if (!candidate || scenario.probes.length !== 1 || candidate.probes.length !== 1) reject();
        const controlProbe = scenario.probes[0]!;
        const candidateProbe = candidate.probes[0]!;
        if (controlProbe.probeId !== candidateProbe.probeId
          || !Number.isSafeInteger(controlProbe.contextTokens)
          || !Number.isSafeInteger(candidateProbe.contextTokens)) reject();
        return [{
          scenarioId: scenario.scenarioId, probeId: controlProbe.probeId,
          controlCoverage: controlProbe.metrics.answerCoverage, controlTokens: controlProbe.contextTokens!,
          candidateCoverage: candidateProbe.metrics.answerCoverage, candidateTokens: candidateProbe.contextTokens!,
        }];
      }));
      const paired = orderedEfficiencyPairs(lanePairs[0]!, lanePairs[1]!);
      stage = 'efficiency';
      const interval = pairedEfficiencyInterval(paired);
      if (paired.length !== 20 || interval.outcome !== 'measured' || interval.point === null
        || interval.oneSidedLower === null || interval.point < 0 || interval.oneSidedLower < 0) reject();
      stage = 'quality-policy';
      if (recall.delta < 0 || precision.delta < 0) reject();
      stage = 'safety-policy';
      const safety = {
        staleLeakRate: Math.max(...reports.map((entry) => entry.candidate.metrics.staleLeakRate)),
        isolationLeakRate: Math.max(...reports.map((entry) => entry.candidate.metrics.isolationLeakRate)),
        duplicateRate: Math.max(...reports.map((entry) => entry.candidate.metrics.duplicateRate)),
        unknownResultRate: Math.max(...reports.map((entry) => entry.candidate.metrics.unknownResultRate)),
      };
      if (Object.values(safety).some((entry) => entry !== 0)) reject();
      result = { recall, precision, efficiency: interval, safety };
    }
    stage = 'artifact';
    const receipt = {
      schemaVersion: '1', decision: 'passed', gitCommit: id.gitCommit,
      nodeMajor: id.nodeMajor, nodeVersion: id.nodeVersion,
      workflowRunId: id.workflowRunId, workflowRunAttempt: id.workflowRunAttempt,
      approvalSha256: id.approvalSha256,
      datasetId: 'memberry-g2-holdout-holdout', split: 'holdout',
      controlAdapterId: 'memberry-retrieval-core-disabled-v1',
      candidateAdapterId: 'memberry-retrieval-core-served-v1',
      recall: result.recall, precision: result.precision,
      efficiency: result.efficiency, safety: result.safety,
    };
    await writeExclusive(root, 'holdout-receipt.json', receipt);
  } catch {
    if ((await readdir(root)).length === 0) {
      await writeExclusive(root, 'holdout-receipt.json', failureReceipt(id, stage));
    }
    throw REJECTION;
  }
}

function checkpointIdentity(test: boolean, expected: JsonRecord): void {
  if (JSON.stringify(identity(test)) !== JSON.stringify(expected)) reject();
}

async function finalizeGate(hooks: {
  beforeUploadPathOutput?: (paths: { evaluation: string; upload: string }) => Promise<void>;
  closeHandle?: (owner: RetainedOwner) => Promise<void>;
  randomBytes?: (size: number) => Buffer;
} = {}): Promise<void> {
  const test = fixtureMode('finalize');
  closeInheritedFd3();
  if (!test) await validateHostedDispatch();
  const id = identity(test); const parent = await runnerRoot(test, false);
  const outcome = test ? process.env.RET010_HOLDOUT_TEST_GATE_OUTCOME : process.env.RET010_HOLDOUT_GATE_OUTCOME;
  if (outcome !== 'success' && outcome !== 'failure') reject();
  const sourceRoot = resolve(parent, receiptName(id));
  const upload = await retainedCustody(async (scope) => {
    const sourceRootOwner = await retainDirectory(scope, sourceRoot);
    if (JSON.stringify((await readdir(sourceRoot)).sort()) !== JSON.stringify(['holdout-receipt.json'])) reject();
    const source = resolve(sourceRoot, 'holdout-receipt.json');
    const sourceOwner = await retainRead(scope, source);
    const sourceBytes = sourceOwner.bytes as Buffer;
    const receipt = validateReceipt(parseJson(sourceBytes), id);
    if (!canonical(receipt).equals(sourceBytes)
      || (outcome === 'success' ? receipt.decision !== 'passed' : receipt.decision !== 'failed')) reject();

    // Frozen source/runtime identity is reacquired while the receipt remains
    // pinned and before any upload leaf exists.
    checkpointIdentity(test, id);
    await auditRetained(sourceRootOwner);
    await auditRetained(sourceOwner, sourceBytes);
    if (JSON.stringify((await readdir(sourceRoot)).sort()) !== JSON.stringify(['holdout-receipt.json'])) reject();
    const leafName = 'ret010-holdout-upload-' + (hooks.randomBytes ?? randomBytes)(32).toString('hex');
    if (!/^ret010-holdout-upload-[0-9a-f]{64}$/.test(leafName)) reject();
    const uploadPath = resolve(parent, leafName);
    await mkdir(uploadPath, { recursive: false, mode: 0o700 });
    const uploadOwner = await retainDirectory(scope, uploadPath);
    const destinationOwner = await retainExclusiveWrite(scope, uploadPath, 'holdout-receipt.json', receipt);
    const marker = {
      schemaVersion: '1', decision: 'complete', bundleKind: outcome,
      gitCommit: id.gitCommit, nodeMajor: id.nodeMajor, nodeVersion: id.nodeVersion,
      workflowRunId: id.workflowRunId, workflowRunAttempt: id.workflowRunAttempt,
      uploadLeafName: leafName,
      allowlist: ['holdout-receipt.json', 'upload-complete.json'],
      payloadSha256: { holdoutReceiptSha256: sha256(sourceBytes) },
    };

    // Marker creation is fenced by the same retained source, destination, and
    // upload-directory owners plus a fresh runtime/source identity checkpoint.
    checkpointIdentity(test, id);
    await auditRetained(sourceRootOwner);
    await auditRetained(sourceOwner, sourceBytes);
    await auditRetained(uploadOwner);
    await auditRetained(destinationOwner, sourceBytes);
    if (JSON.stringify((await readdir(sourceRoot)).sort()) !== JSON.stringify(['holdout-receipt.json'])
      || JSON.stringify((await readdir(uploadPath)).sort()) !== JSON.stringify(['holdout-receipt.json'])) reject();
    const markerOwner = await retainExclusiveWrite(scope, uploadPath, 'upload-complete.json', marker);
    const markerBytes = markerOwner.bytes as Buffer;
    const completionMarkerSha256 = sha256(markerBytes);
    if (hooks.beforeUploadPathOutput) {
      await hooks.beforeUploadPathOutput({ evaluation: sourceRoot, upload: uploadPath });
    }

    // Final post-injection sweep uses only the original retained owners. Every
    // owner is closed once by retainedCustody before structured output begins.
    checkpointIdentity(test, id);
    await auditRetained(sourceRootOwner);
    await auditRetained(sourceOwner, sourceBytes);
    await auditRetained(uploadOwner);
    await auditRetained(destinationOwner, sourceBytes);
    const finalMarker = await auditRetained(markerOwner, markerBytes) as Buffer;
    const finalNames = (await readdir(uploadPath)).sort();
    if (JSON.stringify((await readdir(sourceRoot)).sort()) !== JSON.stringify(['holdout-receipt.json'])
      || JSON.stringify(finalNames) !== JSON.stringify([...marker.allowlist].sort())
      || !finalMarker.equals(canonical(marker))
      || sha256(finalMarker) !== completionMarkerSha256
      || sha256(sourceBytes) !== marker.payloadSha256.holdoutReceiptSha256) reject();
    return uploadPath;
  }, hooks);
  if (typeof process.env.GITHUB_OUTPUT !== 'string' || process.env.GITHUB_OUTPUT.length === 0) reject();
  await appendStructuredOutput(process.env.GITHUB_OUTPUT, `upload_path=${upload}\n`);
}

async function main(): Promise<void> {
  if (process.argv.length !== 3 || JSON.stringify(process.execArgv) !== JSON.stringify(['--import', 'tsx'])) reject();
  environmentNames();
  if (Object.hasOwn(process.env, 'NODE_OPTIONS') || Object.hasOwn(process.env, 'NODE_PATH')) reject();
  if (process.argv[2] === 'run') await runGate();
  else if (process.argv[2] === 'finalize') await finalizeGate();
  else reject();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    try { process.stderr.write(process.argv[2] === 'finalize' ? FINALIZE_FAILURE : FAILURE); } catch { /* fixed */ }
    process.exitCode = 1;
  });
}
