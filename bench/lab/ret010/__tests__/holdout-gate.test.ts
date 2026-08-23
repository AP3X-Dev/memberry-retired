import { spawn, spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import * as holdoutGate from '../holdout-gate.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const GATE = resolve(ROOT, 'bench/lab/ret010/holdout-gate.mts');
const STATS = resolve(ROOT, 'bench/lab/stats.ts');
const FIXTURE_ROW_KEYS = [
  'scenarioId', 'probeId', 'controlMetric', 'candidateMetric', 'controlCoverage',
  'controlTokens', 'candidateCoverage', 'candidateTokens', 'staleLeakRate',
  'isolationLeakRate', 'duplicateRate', 'unknownResultRate',
] as const;
const FORBIDDEN_FIXTURE_FIELDS = [
  'aggregate', 'delta', 'qualifyingCount', 'scenarioCount', 'probeCount', 'pairedProbes',
  'seed', 'interval', 'receipt', 'path', 'approval', 'dataset', 'oracle', 'endpoint',
  'module', 'credential', 'exception', 'policyDecision', 'productionIdentity', 'runnerTemp',
  'gitCommit', 'workflowRunId', 'workflowRunAttempt', 'approvalSha256', 'gateOutcome',
  'RUNNER_TEMP', 'GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT',
  'RET010_HOLDOUT_APPROVAL_DIGEST', 'RET010_HOLDOUT_GATE_OUTCOME',
] as const;
const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

function cleanEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv;
  for (const [name, value] of Object.entries(source)) {
    const folded = name.toUpperCase();
    if (folded.startsWith('GITHUB_') || folded.startsWith('RET010_')
      || folded === 'RUNNER_TEMP' || folded.startsWith('NODE_')) continue;
    Object.defineProperty(environment, name, {
      value, enumerable: true, writable: true, configurable: true,
    });
  }
  return environment;
}

async function holdoutRunFixture(ordinal: number) {
  const root = await mkdtemp(join(tmpdir(), 'memberry-ret010-holdout-run-'));
  temporaryRoots.push(root);
  const runner = resolve(root, 'runner');
  await mkdir(runner, { recursive: false });
  const workflowRunId = `${process.pid}${Date.now()}${ordinal}`;
  const workflowRunAttempt = '1';
  const nodeMajor = process.versions.node.split('.')[0]!;
  return {
    runner,
    receipt: resolve(runner, 'memberry-ret010-holdout/runs',
      `ret010-holdout-run-${workflowRunId}-attempt-${workflowRunAttempt}-node-${nodeMajor}`,
      'holdout-receipt.json'),
    environment: {
      ...cleanEnvironment(), NODE_ENV: 'test', RET010_HOLDOUT_TEST_FIXTURE: '1',
      RET010_HOLDOUT_TEST_RUNNER_TEMP: runner,
      RET010_HOLDOUT_TEST_GIT_COMMIT: 'a'.repeat(40),
      RET010_HOLDOUT_TEST_RUN_ID: workflowRunId,
      RET010_HOLDOUT_TEST_RUN_ATTEMPT: workflowRunAttempt,
      RET010_HOLDOUT_TEST_APPROVAL_SHA256: 'b'.repeat(64),
    },
  };
}

function spawnGate(mode: 'run' | 'finalize', environment: NodeJS.ProcessEnv,
  fd3?: Uint8Array): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(process.execPath, ['--import', 'tsx', GATE, mode], {
      cwd: ROOT, env: environment,
      stdio: fd3 === undefined ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', rejectResult);
    child.on('close', (status) => resolveResult({ status, stdout, stderr }));
    if (fd3 !== undefined) {
      const pipe = child.stdio[3] as NodeJS.WritableStream;
      pipe.on('error', () => { /* child may reject before consuming the sealed pipe */ });
      pipe.end(fd3);
    }
  });
}

type SyncChildOptions = Readonly<{
  cwd: string;
  encoding: 'utf8';
  env: NodeJS.ProcessEnv;
}>;
function spawnBounded(args: readonly string[], options: SyncChildOptions) {
  const result = spawnSync(process.execPath, [...args], {
    ...options,
    timeout: 3_000, killSignal: 'SIGKILL',
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).not.toBeNull();
  return result;
}
function spawnExpectedTimeout(args: readonly string[], options: SyncChildOptions) {
  const started = performance.now();
  const result = spawnSync(process.execPath, [...args], {
    ...options, timeout: 2_000, killSignal: 'SIGKILL',
  });
  const elapsedMs = performance.now() - started;
  expect((result.error as NodeJS.ErrnoException | undefined)?.code).toBe('ETIMEDOUT');
  expect(result.status).toBeNull();
  expect(result.signal).toBe('SIGKILL');
  expect(elapsedMs).toBeGreaterThanOrEqual(1_900);
  expect(elapsedMs).toBeLessThan(2_900);
  return { ...result, elapsedMs };
}

async function holdoutFailureFixture(ordinal: number) {
  const root = await mkdtemp(join(tmpdir(), 'memberry-ret010-holdout-finalizer-'));
  temporaryRoots.push(root);
  const runner = resolve(root, 'runner');
  const runs = resolve(runner, 'memberry-ret010-holdout/runs');
  await mkdir(runs, { recursive: true });
  const gitCommit = 'a'.repeat(40);
  const approvalSha256 = 'b'.repeat(64);
  const workflowRunId = `${process.pid}${Date.now()}${ordinal}`;
  const workflowRunAttempt = '1';
  const nodeMajor = process.versions.node.split('.')[0]!;
  const evaluation = resolve(runs,
    `ret010-holdout-run-${workflowRunId}-attempt-${workflowRunAttempt}-node-${nodeMajor}`);
  await mkdir(evaluation, { recursive: false });
  const receipt = {
    schemaVersion: '1', decision: 'failed', failureClass: 'custody', stage: 'artifact',
    gitCommit, nodeMajor, nodeVersion: process.version,
    workflowRunId, workflowRunAttempt,
  };
  await writeFile(resolve(evaluation, 'holdout-receipt.json'), `${JSON.stringify(receipt)}\n`);
  const output = resolve(root, 'github-output');
  await writeFile(output, '');
  return {
    output,
    environment: {
      ...cleanEnvironment(), NODE_ENV: 'test', RET010_HOLDOUT_TEST_FIXTURE: '1',
      RET010_HOLDOUT_TEST_RUNNER_TEMP: runner, RET010_HOLDOUT_TEST_GIT_COMMIT: gitCommit,
      RET010_HOLDOUT_TEST_RUN_ID: workflowRunId,
      RET010_HOLDOUT_TEST_RUN_ATTEMPT: workflowRunAttempt,
      RET010_HOLDOUT_TEST_APPROVAL_SHA256: approvalSha256,
      RET010_HOLDOUT_TEST_GATE_OUTCOME: 'failure', GITHUB_OUTPUT: output,
    },
  };
}

async function instrumentedHoldoutHarness(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'memberry-ret010-holdout-module-'));
  temporaryRoots.push(root);
  const gatePath = resolve(root, 'bench/lab/ret010/holdout-gate.mts');
  const statsPath = resolve(root, 'bench/lab/stats.ts');
  await mkdir(resolve(root, 'bench/lab/ret010'), { recursive: true });
  const source = await readFile(GATE, 'utf8');
  const testExport = '\nexport { aggregateFixture as __testAggregateFixture, approvalLineage as __testApprovalLineage, bindApprovalCommit as __testBindApprovalCommit, closeInheritedFd3 as __testCloseInheritedFd3, failureReceipt as __testFailureReceipt, finalizeGate as __testFinalizeGate, fixtureBytes as __testFixtureBytes, gitBlob as __testGitBlob, hardenedGit as __testHardenedGit, productionApprovalBeforeImports as __testProductionApprovalBeforeImports, retainedCustody as __testRetainedCustody, runGate as __testRunGate, validateProductionApproval as __testValidateProductionApproval };\n';
  expect(source).not.toContain(testExport.trim());
  const statsImport = "import { pairedEfficiencyInterval } from '../stats.js';";
  const statsInstrumentation = `import { pairedEfficiencyInterval as __rawPairedEfficiencyInterval } from '../stats.js';
const pairedEfficiencyInterval = (...args: Parameters<typeof __rawPairedEfficiencyInterval>) => {
  const key = Symbol.for('ret010.holdout.interval.calls');
  (globalThis as Record<symbol, unknown>)[key] = Number((globalThis as Record<symbol, unknown>)[key] ?? 0) + 1;
  (globalThis as Record<symbol, unknown>)[Symbol.for('ret010.holdout.interval.vector')] = args[0].map((pair) => [
    pair.scenarioId, pair.probeId, pair.controlCoverage, pair.controlTokens,
    pair.candidateCoverage, pair.candidateTokens,
  ]);
  return __rawPairedEfficiencyInterval(...args);
};`;
  expect(source.split(statsImport)).toHaveLength(2);
  const publishCall = "await writeExclusive(root, 'holdout-receipt.json', receipt);";
  const publishInstrumentation = `if ((globalThis as Record<symbol, unknown>)[
    Symbol.for('ret010.holdout.skip-instrumented-publish')] !== true) ${publishCall}`;
  expect(source.split(publishCall)).toHaveLength(2);
  const instrumentedCore = source.replace(statsImport, statsInstrumentation)
    .replace(publishCall, publishInstrumentation);
  const instrumented = instrumentedCore + testExport;
  expect(instrumented.slice(0, -testExport.length).replace(statsInstrumentation, statsImport)
    .replace(publishInstrumentation, publishCall)).toBe(source);
  await writeFile(gatePath, instrumented);
  const statsBytes = await readFile(STATS);
  await writeFile(statsPath, statsBytes);
  expect(await readFile(statsPath)).toEqual(statsBytes);
  const loaderPath = resolve(root, 'loader-guard.mjs');
  await writeFile(loaderPath, `
let port;
const forbidden = /(?:datasets[\\/]load-suite|registered-adapters|served-reranker|memberry-retrieval-core|datasets[\\/].*holdout|oracle|undici|node:(?:http|https|http2|net|tls|dgram|dns(?:\\/promises)?)|(?:^|[\\/])ws(?:$|[\\/])|websocket)/i;
export function initialize(data) { port = data.port; port.unref(); }
export async function resolve(specifier, context, nextResolve) {
  const blocked = forbidden.test(specifier);
  port.postMessage({ phase: 'resolve', specifier, blocked });
  if (blocked) throw new Error('forbidden-fixture-loader');
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  const blocked = forbidden.test(url);
  port.postMessage({ phase: 'load', specifier: url, blocked });
  if (blocked) throw new Error('forbidden-fixture-loader');
  return nextLoad(url, context);
}
`);
  const harness = resolve(root, 'harness.mjs');
  await writeFile(harness, `
import fsPromises from 'node:fs/promises';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import { register, syncBuiltinESMExports } from 'node:module';
import { resolve, sep } from 'node:path';
import { MessageChannel, receiveMessageOnPort } from 'node:worker_threads';

const action = process.argv[2];
const intervalCallKey = Symbol.for('ret010.holdout.interval.calls');
const intervalVectorKey = Symbol.for('ret010.holdout.interval.vector');
globalThis[intervalCallKey] = 0;
globalThis[intervalVectorKey] = [];
globalThis[Symbol.for('ret010.holdout.skip-instrumented-publish')] = action === 'run-fixture';
const loaderChannel = new MessageChannel();
loaderChannel.port1.unref();
register(${JSON.stringify(pathToFileURL(loaderPath).href)}, {
  parentURL: import.meta.url,
  data: { port: loaderChannel.port2 },
  transferList: [loaderChannel.port2],
});
const loaderRows = [];
const drainLoader = () => {
  for (;;) {
    const row = receiveMessageOnPort(loaderChannel.port1);
    if (!row) break;
    loaderRows.push(row.message);
  }
};

const originalFs = Object.fromEntries(['lstat', 'mkdir', 'open', 'readFile', 'readdir', 'realpath', 'writeFile']
  .map((name) => [name, fsPromises[name].bind(fsPromises)]));
let guardActive = false;
let forbiddenFileAttempts = 0;
let networkAttempts = 0;
const restorers = [];
const getOwnDescriptor = Object.getOwnPropertyDescriptor;
const getPrototype = Object.getPrototypeOf;
const defineOwn = Object.defineProperty;
const deleteOwn = Reflect.deleteProperty;
const patchNetworkMethod = (owner, name) => {
  let holder = owner;
  let descriptor;
  while (holder && !descriptor) {
    descriptor = getOwnDescriptor(holder, name);
    if (!descriptor) holder = getPrototype(holder);
  }
  if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') return false;
  const ownDescriptor = getOwnDescriptor(owner, name);
  const original = descriptor.value;
  defineOwn(owner, name, {
    configurable: true,
    enumerable: descriptor.enumerable,
    writable: true,
    value: function (...args) {
      if (guardActive) { networkAttempts += 1; throw new Error('forbidden-fixture-network'); }
      return Reflect.apply(original, this, args);
    },
  });
  restorers.unshift(() => {
    if (ownDescriptor) defineOwn(owner, name, ownDescriptor);
    else if (!deleteOwn(owner, name)) throw new Error('fixture-network-restore');
  });
  return true;
};
const runnerRoot = process.env.RET010_HOLDOUT_TEST_RUNNER_TEMP;
const instrumentedRoot = ${JSON.stringify(root)};
const allowedFixturePath = (value) => {
  if (typeof value !== 'string' && !Buffer.isBuffer(value) && !(value instanceof URL)) return false;
  const absolute = resolve(String(value));
  return (typeof runnerRoot === 'string'
      && (absolute === runnerRoot || absolute.startsWith(runnerRoot + sep)))
    || absolute === instrumentedRoot || absolute.startsWith(instrumentedRoot + sep);
};
for (const name of Object.keys(originalFs)) fsPromises[name] = async (...args) => {
  if (guardActive && !allowedFixturePath(args[0])) {
    forbiddenFileAttempts += 1;
    throw new Error('forbidden-fixture-file');
  }
  return originalFs[name](...args);
};
for (const name of ['createReadStream', 'open', 'openSync', 'readFile', 'readFileSync']) {
  const original = fs[name];
  fs[name] = function (...args) {
    if (guardActive && !allowedFixturePath(args[0])) {
      forbiddenFileAttempts += 1;
      throw new Error('forbidden-fixture-file');
    }
    return Reflect.apply(original, this, args);
  };
}
for (const name of ['exec', 'execFile', 'execFileSync', 'spawn', 'spawnSync']) {
  const original = childProcess[name];
  childProcess[name] = function (...args) {
    if (guardActive) { forbiddenFileAttempts += 1; throw new Error('forbidden-fixture-file'); }
    return Reflect.apply(original, this, args);
  };
}
for (const [owner, names] of [[http, ['request', 'get']], [https, ['request', 'get']],
  [http2, ['connect']], [net, ['connect', 'createConnection']], [tls, ['connect']],
  [dns, ['lookup', 'resolve', 'resolve4', 'resolve6']],
  [dnsPromises, ['lookup', 'resolve', 'resolve4', 'resolve6']], [dgram, ['createSocket']]]) for (const name of names) {
  if (!patchNetworkMethod(owner, name)) throw new Error('fixture-network-surface');
}
for (const [owner, names] of [
  [net.Socket.prototype, ['connect']], [tls.TLSSocket.prototype, ['connect']],
  [net.Server.prototype, ['listen']],
  [dns.Resolver.prototype, ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa',
    'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa',
    'resolveSrv', 'resolveTxt', 'reverse']],
  [dnsPromises.Resolver.prototype, ['resolve', 'resolve4', 'resolve6', 'resolveAny',
    'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr',
    'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse']],
  [dgram.Socket.prototype, ['bind', 'connect', 'send', 'sendto']],
  [http.Agent.prototype, ['createConnection']], [https.Agent.prototype, ['createConnection']],
]) for (const name of names) if (!patchNetworkMethod(owner, name)) {
  throw new Error('fixture-network-surface');
}
const originalFetch = globalThis.fetch;
if (originalFetch) patchNetworkMethod(globalThis, 'fetch');
const originalWebSocket = globalThis.WebSocket;
if (typeof originalWebSocket === 'function') {
  const GuardedWebSocket = function (...args) {
    if (guardActive) { networkAttempts += 1; throw new Error('forbidden-fixture-network'); }
    return Reflect.construct(originalWebSocket, args, new.target || originalWebSocket);
  };
  Object.setPrototypeOf(GuardedWebSocket, originalWebSocket);
  GuardedWebSocket.prototype = originalWebSocket.prototype;
  const descriptor = getOwnDescriptor(globalThis, 'WebSocket');
  if (!descriptor || !('value' in descriptor)) throw new Error('fixture-websocket-descriptor');
  defineOwn(globalThis, 'WebSocket', { ...descriptor, value: GuardedWebSocket });
  restorers.unshift(() => defineOwn(globalThis, 'WebSocket', descriptor));
}
syncBuiltinESMExports();
const { __testAggregateFixture, __testCloseInheritedFd3, __testFailureReceipt,
  __testFinalizeGate, __testFixtureBytes, __testRetainedCustody, __testRunGate } = await import(
  ${JSON.stringify(pathToFileURL(gatePath).href)});
const readFile = originalFs.readFile;
const writeFile = originalFs.writeFile;
const attempts = [];
let injected = false;
const boundaryPrefix = Buffer.from('{"x":"');
const boundarySuffix = Buffer.from('"}\\n');
const boundaryPayload = Buffer.concat([
  boundaryPrefix,
  Buffer.alloc(65_536 - boundaryPrefix.length - boundarySuffix.length, 0x61),
  boundarySuffix,
]);
const payload = action === 'fd-chunks' || action === 'fd-boundary'
  ? boundaryPayload
  : action === 'fd-overflow'
    ? Buffer.concat([boundaryPayload, Buffer.from('x')])
    : action.startsWith('fd-probe-')
      ? boundaryPayload
    : action === 'fd-late-trailing'
      ? Buffer.from('{"x":1}\\nx')
      : Buffer.from(process.env.HARNESS_PAYLOAD_BASE64 || '', 'base64');
let cursor = 0;
let fstats = 0;
let readCalls = 0;
let fixtureCloseAttempts = 0;
let inheritedFstats = 0;
let inheritedCloseAttempts = 0;
let realImports = 0;
let fixtureForbiddenFileAttempts = 0;
let fixtureNetworkAttempts = 0;
let fixtureForbiddenLoaderAttempts = 0;
let negativeControlsCaught = 0;
let negativeControlsExpected = 0;
let negativeLoaderBlocks = 0;
const negativeLoaderBlocksExpected = action === 'run-fixture'
  ? (typeof originalWebSocket === 'function' ? 2 : 3)
  : 0;
let negativeNetworkAttempts = 0;
const negativeNetworkAttemptsExpected = action === 'run-fixture'
  ? (typeof originalWebSocket === 'function' ? 9 : 8)
  : 0;
let codeGetterCalls = 0;
const falsyValues = { undefined: undefined, null: null, zero: 0, false: false };
const falsyName = action.split('-').at(-1);
const falsyValue = falsyValues[falsyName];
const encodeFailure = (value) => value === undefined ? 'undefined'
  : value === null ? 'null'
    : value === false ? 'false'
      : value === 0 ? 'zero'
        : value instanceof Error ? value.constructor.name
          : typeof value;
const pipeStat = (identity = 7n) => ({
  dev: 1n, ino: identity, mode: 4096n, isFIFO: () => true,
});
const chunkPlan = action === 'fd-chunks'
  ? [1, 4095, 2, 3071, 17, 8192]
  : action === 'fd-late-trailing'
    ? [Buffer.from('{"x":1}\\n').length, 1]
    : [];
const fixtureIo = {
  fstat: async () => {
    fstats += 1;
    if (action === 'fd-acquire-failure') throw new Error('fstat');
    if (action === 'fd-ebadf') throw Object.assign(new Error('fstat'), { code: 'EBADF' });
    if (action === 'fd-ebadf-accessor') throw Object.defineProperty(new Error('fstat'), 'code', {
      get: () => { codeGetterCalls += 1; throw new Error('getter'); },
    });
    if (action === 'fd-ebadf-proxy') throw new Proxy(new Error('fstat'), {
      getOwnPropertyDescriptor: () => { codeGetterCalls += 1; throw new Error('proxy'); },
    });
    if (action.startsWith('fd-initial-')) throw falsyValue;
    if (action === 'fd-aggregate-initial') throw null;
    if (action === 'fd-post-fstat-failure' && fstats === 2) throw new Error('fstat');
    if (action.startsWith('fd-post-') && fstats === 2
      && Object.hasOwn(falsyValues, falsyName)) throw falsyValue;
    if (action === 'fd-type-failure') return { ...pipeStat(), isFIFO: () => false, mode: 32768n };
    if (action === 'fd-post-type' && fstats === 2) {
      return { ...pipeStat(), isFIFO: () => false, mode: 32768n };
    }
    return pipeStat(action === 'fd-post-identity' && fstats === 2 ? 8n : 7n);
  },
  read: async (_fd, buffer, offset, requested) => {
    readCalls += 1;
    if (action === 'run-caller-exception') throw new Error('caller-secret');
    if (action === 'fd-read-failure' && readCalls === 1) throw new Error('read');
    if (action.startsWith('fd-read-') && readCalls === 1
      && Object.hasOwn(falsyValues, falsyName)) throw falsyValue;
    if (action === 'fd-aggregate-read' && readCalls === 1) throw undefined;
    if (action.startsWith('fd-probe-') && cursor === payload.length) throw falsyValue;
    const planned = chunkPlan.length ? chunkPlan.shift() : requested;
    const amount = Math.min(requested, planned ?? requested, payload.length - cursor);
    if (amount <= 0) return 0;
    payload.copy(buffer, offset, cursor, cursor + amount);
    cursor += amount;
    return amount;
  },
  close: async () => {
    fixtureCloseAttempts += 1;
    if (action === 'fd-close-failure') throw new Error('close');
    if (action.startsWith('fd-close-') && Object.hasOwn(falsyValues, falsyName)) throw falsyValue;
    if (action === 'fd-aggregate-read' || action === 'fd-aggregate-initial') throw false;
  },
};
const hooks = {
  randomBytes: () => Buffer.alloc(32, 0x44),
  beforeUploadPathOutput: action.startsWith('mutation-') ? async ({ evaluation, upload }) => {
    const target = action === 'mutation-source'
      ? resolve(evaluation, 'holdout-receipt.json')
      : action === 'mutation-destination'
        ? resolve(upload, 'holdout-receipt.json')
        : resolve(upload, 'upload-complete.json');
    await writeFile(target, 'hostile-mutation\\n');
  } : undefined,
  closeHandle: action === 'close-failure' ? async (owner) => {
    attempts.push(owner);
    await owner.handle.close();
    if (!injected) { injected = true; throw new Error('injected-close-failure'); }
  } : undefined,
};
let rejected = false;
let acceptedLength = null;
let aggregateResult = null;
let aggregateInputStable = null;
let aggregateDecision = null;
let failureReceiptResult = null;
let failureShape = [];
try {
  if (action === 'retained-falsy-operation') await __testRetainedCustody(async () => { throw undefined; });
  else if (action === 'retained-falsy-aggregate') await __testRetainedCustody(async (scope) => {
    scope.owners.push({ absolute: '<test>', handle: {}, kind: 'file', maximum: 1, closeAttempted: false });
    throw null;
  }, { closeHandle: async () => { throw false; } });
  else if (action.startsWith('inherited-fd3-')) __testCloseInheritedFd3({
    fstat: () => {
      inheritedFstats += 1;
      if (action === 'inherited-fd3-ebadf') throw Object.assign(new Error('closed'), { code: 'EBADF' });
      if (action === 'inherited-fd3-fstat-failure') throw new Error('fstat');
      if (action === 'inherited-fd3-untyped') return {
        mode: 0, isFIFO: () => false, isSocket: () => false, isFile: () => false,
        isDirectory: () => false, isCharacterDevice: () => false, isBlockDevice: () => false,
      };
      return { mode: 4096, isFIFO: () => true };
    },
    close: () => {
      inheritedCloseAttempts += 1;
      if (action === 'inherited-fd3-close-failure') throw new Error('close');
    },
  });
  else if (action.startsWith('fd-')) acceptedLength = (await __testFixtureBytes(fixtureIo)).length;
  else if (action === 'aggregate-fixture') {
    const fixtureValue = JSON.parse(Buffer.from(process.env.HARNESS_PAYLOAD_BASE64, 'base64').toString('utf8'));
    const before = JSON.stringify(fixtureValue);
    aggregateResult = __testAggregateFixture(fixtureValue);
    aggregateInputStable = JSON.stringify(fixtureValue) === before;
    aggregateDecision = 'passed';
  }
  else if (action === 'failure-receipt') {
    const receiptId = {
      gitCommit: 'a'.repeat(40), nodeMajor: '20', nodeVersion: 'v20.19.1',
      workflowRunId: '17', workflowRunAttempt: '2',
    };
    failureReceiptResult = JSON.parse(process.env.HARNESS_STAGES).map(
      (stage) => __testFailureReceipt(receiptId, stage));
  }
  else if (action === 'run-caller-exception') await __testRunGate({ fixtureIo });
  else if (action === 'run-fixture') {
    guardActive = true;
    await __testRunGate({
      fixtureIo,
      beforeRealImports: async () => { realImports += 1; throw new Error('real-import'); },
    });
    drainLoader();
    fixtureForbiddenFileAttempts = forbiddenFileAttempts;
    fixtureNetworkAttempts = networkAttempts;
    fixtureForbiddenLoaderAttempts = loaderRows.filter((row) => row.blocked).length;
    negativeControlsExpected += 1;
    try { await fsPromises.readFile(${JSON.stringify(GATE)}); } catch (error) {
      if (error.message === 'forbidden-fixture-file') negativeControlsCaught += 1;
      else throw error;
    }
    negativeControlsExpected += 1;
    try { https.request('https://forbidden.invalid/'); } catch (error) {
      if (error.message === 'forbidden-fixture-network') negativeControlsCaught += 1;
      else throw error;
    }
    negativeControlsExpected += 1;
    try { await import('../datasets/load-suite.js'); } catch (error) {
      if (error.message === 'forbidden-fixture-loader') negativeControlsCaught += 1;
      else throw error;
    }
    negativeControlsExpected += 1;
    try { http2.connect('https://forbidden.invalid/'); } catch (error) {
      if (error.message === 'forbidden-fixture-network') negativeControlsCaught += 1;
      else throw error;
    }
    negativeControlsExpected += 1;
    try { await dnsPromises.lookup('forbidden.invalid'); } catch (error) {
      if (error.message === 'forbidden-fixture-network') negativeControlsCaught += 1;
      else throw error;
    }
    const directNetworkControl = (operation) => {
      negativeControlsExpected += 1;
      try { operation(); } catch (error) {
        if (error.message === 'forbidden-fixture-network') { negativeControlsCaught += 1; return; }
        throw error;
      }
      throw new Error('fixture-network-negative-control-failed');
    };
    let directSocket;
    directNetworkControl(() => {
      directSocket = new net.Socket();
      directSocket.connect({ host: 'forbidden.invalid', port: 443 });
    });
    directSocket?.destroy();
    let rawSocket; let secureSocket;
    directNetworkControl(() => {
      rawSocket = new net.Socket();
      secureSocket = new tls.TLSSocket(rawSocket);
      secureSocket.connect({ host: 'forbidden.invalid', port: 443 });
    });
    secureSocket?.destroy(); rawSocket?.destroy();
    directNetworkControl(() => {
      const resolver = new dns.Resolver();
      resolver.resolve4('forbidden.invalid', () => {});
    });
    let udpSocket;
    directNetworkControl(() => {
      udpSocket = new dgram.Socket('udp4');
      udpSocket.bind(0);
    });
    try { udpSocket?.unref(); } catch { /* negative-control disposal */ }
    try { udpSocket?.close(); } catch { /* negative-control disposal */ }
    let directAgent;
    directNetworkControl(() => {
      directAgent = new http.Agent();
      directAgent.createConnection({ host: 'forbidden.invalid', port: 80 });
    });
    directAgent?.destroy();
    negativeControlsExpected += 1;
    try { await import('undici'); } catch (error) {
      if (error.message === 'forbidden-fixture-loader') negativeControlsCaught += 1;
      else throw error;
    }
    negativeControlsExpected += 1;
    try {
      if (typeof originalWebSocket === 'function') new globalThis.WebSocket('wss://forbidden.invalid/');
      else await import('ws');
    } catch (error) {
      if (error.message === 'forbidden-fixture-network' || error.message === 'forbidden-fixture-loader') {
        negativeControlsCaught += 1;
      } else throw error;
    }
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
    drainLoader();
    negativeLoaderBlocks = loaderRows.filter((row) => row.blocked).length;
    negativeNetworkAttempts = networkAttempts - fixtureNetworkAttempts;
    guardActive = false;
  }
  else await __testFinalizeGate(hooks);
} catch (error) {
  rejected = true;
  failureShape = error instanceof AggregateError
    ? error.errors.map(encodeFailure)
    : [encodeFailure(error)];
}
guardActive = false;
for (const restore of restorers) try { restore(); } catch (error) {
  rejected = true;
  failureShape.push(encodeFailure(error));
}
syncBuiltinESMExports();
process.stdout.write(JSON.stringify({
  rejected,
  attempts: attempts.length,
  uniqueAttempts: new Set(attempts).size,
  acceptedLength,
  aggregateResult,
  aggregateInputStable,
  aggregateDecision,
  failureReceiptResult,
  fstats,
  readCalls,
  fixtureCloseAttempts,
  ...(action.startsWith('inherited-fd3-') ? { inheritedFstats, inheritedCloseAttempts } : {}),
  realImports,
  fixtureForbiddenFileAttempts,
  fixtureNetworkAttempts,
  fixtureForbiddenLoaderAttempts,
  negativeControlsCaught,
  negativeControlsExpected,
  negativeLoaderBlocks,
  negativeLoaderBlocksExpected,
  negativeNetworkAttempts,
  negativeNetworkAttemptsExpected,
  intervalCalls: globalThis[intervalCallKey],
  intervalVector: globalThis[intervalVectorKey],
  failureShape,
  codeGetterCalls,
  output: process.env.GITHUB_OUTPUT ? await readFile(process.env.GITHUB_OUTPUT, 'utf8') : '',
}));
`);
  return harness;
}

async function instrumentedLineageHarness(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'memberry-ret010-lineage-module-'));
  temporaryRoots.push(root);
  const gatePath = resolve(root, 'bench/lab/ret010/holdout-gate.mts');
  const statsPath = resolve(root, 'bench/lab/stats.ts');
  await mkdir(resolve(root, 'bench/lab/ret010'), { recursive: true });
  const source = await readFile(GATE, 'utf8');
  const testExport = '\nexport { approvalLineage as __testApprovalLineage, bindApprovalCommit as __testBindApprovalCommit, gitBlob as __testGitBlob, hardenedGit as __testHardenedGit, productionApprovalBeforeImports as __testProductionApprovalBeforeImports, validateProductionApproval as __testValidateProductionApproval };\n';
  expect(source).not.toContain(testExport.trim());
  const instrumented = source + testExport;
  expect(instrumented.slice(0, -testExport.length)).toBe(source);
  await writeFile(gatePath, instrumented);
  await writeFile(statsPath, await readFile(STATS));
  const loaderPath = resolve(root, 'lineage-loader.mjs');
  await writeFile(loaderPath, `
let port;
const forbidden = /(?:datasets[\\/]load-suite|registered-adapters|served-reranker|memberry-retrieval-core|holdout|oracle|undici|node:(?:http|https|http2|net|tls|dgram|dns(?:\\/promises)?)|websocket|(?:^|[\\/])ws(?:$|[\\/]))/i;
export function initialize(data) { port = data.port; port.unref(); }
export async function resolve(specifier, context, nextResolve) {
  const blocked = forbidden.test(specifier) && !specifier.includes('holdout-gate.mts');
  port.postMessage({ specifier, blocked });
  if (blocked) throw new Error('forbidden-lineage-loader');
  return nextResolve(specifier, context);
}
`);
  const harness = resolve(root, 'lineage-harness.mjs');
  await writeFile(harness, `
import { createHash } from 'node:crypto';
import { register } from 'node:module';
import { MessageChannel, receiveMessageOnPort } from 'node:worker_threads';
const row = JSON.parse(Buffer.from(process.env.LINEAGE_ROW_BASE64, 'base64').toString('utf8'));
if (row.kind === 'child-timeout') {
  const ignoreSigterm = () => {};
  process.on('SIGTERM', ignoreSigterm);
  process.stdout.write('TIMEOUT_READY:' + process.pid + '\\n');
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
const CHILD = 'c'.repeat(40); const PARENT = 'a'.repeat(40); const BLOB = 'b'.repeat(40);
const channel = new MessageChannel(); channel.port1.unref();
register(${JSON.stringify(pathToFileURL(loaderPath).href)}, {
  parentURL: import.meta.url, data: { port: channel.port2 }, transferList: [channel.port2],
});
let networkAttempts = 0;
const originalFetch = globalThis.fetch;
if (originalFetch) globalThis.fetch = () => { networkAttempts += 1; throw new Error('forbidden-lineage-network'); };
const gate = await import(${JSON.stringify(pathToFileURL(gatePath).href)});
const loaderRows = [];
const drain = () => { for (;;) { const item = receiveMessageOnPort(channel.port1); if (!item) break; loaderRows.push(item.message); } };
const raw = (oldMode, newMode, oldId, newId, status, paths) => Buffer.concat([
  Buffer.from(':' + oldMode + ' ' + newMode + ' ' + oldId + ' ' + newId + ' ' + status + '\\0'),
  ...paths.map((path) => Buffer.from(path + '\\0')),
]);
const canonicalDiff = (blob = BLOB) => raw('000000', '100644', '0'.repeat(40), blob, 'A',
  ['bench/lab/ret010/approved-dev.json']);
const lineageOutputs = () => {
  let parents = Buffer.from(CHILD + ' ' + PARENT + '\\n'); let diff = canonicalDiff();
  switch (row.case) {
    case 'root': parents = Buffer.from(CHILD + '\\n'); break;
    case 'merge': parents = Buffer.from(CHILD + ' ' + PARENT + ' ' + 'd'.repeat(40) + '\\n'); break;
    case 'malformed-parent': parents = Buffer.from('malformed\\n'); break;
    case 'parent-nul': parents = Buffer.from(CHILD + ' ' + PARENT + '\\0\\n'); break;
    case 'parent-trailing': parents = Buffer.from(CHILD + ' ' + PARENT + '\\nextra\\n'); break;
    case 'parent-truncated': parents = Buffer.from(CHILD + ' ' + PARENT.slice(0, 39) + '\\n'); break;
    case 'parent-oversized': parents = Buffer.alloc(257, 0x61); break;
    case 'missing': diff = Buffer.alloc(0); break;
    case 'modified': diff = raw('100644', '100644', 'd'.repeat(40), BLOB, 'M', ['bench/lab/ret010/approved-dev.json']); break;
    case 'renamed': diff = raw('100644', '100644', 'd'.repeat(40), BLOB, 'R100', ['old.json', 'bench/lab/ret010/approved-dev.json']); break;
    case 'copied': diff = raw('100644', '100644', 'd'.repeat(40), BLOB, 'C100', ['old.json', 'bench/lab/ret010/approved-dev.json']); break;
    case 'deleted': diff = raw('100644', '000000', 'd'.repeat(40), '0'.repeat(40), 'D', ['bench/lab/ret010/approved-dev.json']); break;
    case 'case-variant': diff = raw('000000', '100644', '0'.repeat(40), BLOB, 'A', ['bench/lab/ret010/Approved-dev.json']); break;
    case 'symlink': diff = raw('000000', '120000', '0'.repeat(40), BLOB, 'A', ['bench/lab/ret010/approved-dev.json']); break;
    case 'submodule': diff = raw('000000', '160000', '0'.repeat(40), BLOB, 'A', ['bench/lab/ret010/approved-dev.json']); break;
    case 'wrong-mode': diff = raw('000000', '100755', '0'.repeat(40), BLOB, 'A', ['bench/lab/ret010/approved-dev.json']); break;
    case 'second-path': diff = Buffer.concat([canonicalDiff(), raw('000000', '100644', '0'.repeat(40), 'e'.repeat(40), 'A', ['second.txt'])]); break;
    case 'child-source-mutation': diff = Buffer.concat([canonicalDiff(), raw('100644', '100644', 'd'.repeat(40), 'e'.repeat(40), 'M', ['packages/retrieval/src/served-reranker.ts'])]); break;
    case 'diff-nul': diff = Buffer.concat([canonicalDiff(), Buffer.from([0])]); break;
    case 'diff-truncated': diff = canonicalDiff().subarray(0, canonicalDiff().length - 1); break;
    case 'diff-oversized': diff = Buffer.alloc(1025, 0x61); break;
  }
  return { parents, diff };
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const gitBlobId = (bytes) => createHash('sha1').update(Buffer.concat([
  Buffer.from('blob ' + bytes.byteLength + '\\0', 'ascii'), bytes,
])).digest('hex');
const blobFixture = () => {
  const name = row.case.replace(/-mutation$/, '');
  const values = {
    empty: Buffer.alloc(0), nul: Buffer.from([0, 1, 0]),
    'high-bit': Buffer.from([0x80, 0xff, 0x7f]), large: Buffer.alloc(1_000_000, 0xa5),
  };
  const original = values[name];
  if (!original) throw new Error('blob-case');
  const id = gitBlobId(original);
  const served = row.case.endsWith('-mutation')
    ? Buffer.concat([original, Buffer.from([0x00])]) : original;
  return { id, git: (args) => args[0] === 'cat-file' ? served : Buffer.from(id + '\\n') };
};
const approvalFixture = () => {
  const input = Buffer.from('{"input":1}\\n'); const oracle = Buffer.from('{"oracle":1}\\n');
  const descriptor = { id: 'memberry-ret010-dev-v1', artifacts: [
    { sha256: sha256(input), sizeBytes: input.length }, { sha256: sha256(oracle), sizeBytes: oracle.length },
  ] };
  const bytes = new Map([
    ['bench/lab/registry/datasets.json', Buffer.from(JSON.stringify({ datasets: [descriptor] }))],
    ['bench/lab/datasets/ret010/v1/dev/input.jsonl', input],
    ['bench/lab/datasets/ret010/v1/dev/oracle.jsonl', oracle],
    ['bench/lab/ret010/dev-policy.json', Buffer.from('dev-policy')],
    ['packages/retrieval/src/served-reranker.ts', Buffer.from('model')],
    ['packages/retrieval/src/reranker.ts', Buffer.from('provider')],
    ['bench/lab/adapters/memberry-retrieval-core.ts', Buffer.from('adapter')],
    ['bench/lab/stats.ts', Buffer.from('statistics')],
  ]);
  const ids = new Map([...bytes].map(([path, value]) => [path, gitBlobId(value)]));
  const approval = { schemaVersion: '1', decision: 'approved', source: {
    gitCommit: PARENT, modelBlob: ids.get('packages/retrieval/src/served-reranker.ts'),
    providerContractBlob: ids.get('packages/retrieval/src/reranker.ts'),
    adapterBlob: ids.get('bench/lab/adapters/memberry-retrieval-core.ts'),
    statisticsBlob: ids.get('bench/lab/stats.ts'), providerIdentity: {
      providerId: 'memberry.local.lexical', modelId: 'bm25f-query-v1',
      calibrationId: 'fixed-blend-v1', locality: 'local',
    },
  }, development: {
    datasetDescriptorSha256: sha256(Buffer.from(JSON.stringify(descriptor))),
    inputSha256: sha256(input), oracleSha256: sha256(oracle),
    devPolicySha256: sha256(bytes.get('bench/lab/ret010/dev-policy.json')),
    seed: 1, aggregateResultSha256: '7'.repeat(64),
  }, node20: { nodeVersion: 'v20.1.0', custodyManifestSha256: '1'.repeat(64),
    completionMarkerSha256: '2'.repeat(64), artifactName: 'memberry-ret010-development-node-20-9-1',
    artifactId: '20', artifactServiceSha256: '3'.repeat(64) },
  node22: { nodeVersion: 'v22.1.0', custodyManifestSha256: '4'.repeat(64),
    completionMarkerSha256: '5'.repeat(64), artifactName: 'memberry-ret010-development-node-22-9-1',
    artifactId: '22', artifactServiceSha256: '6'.repeat(64) },
  workflowRunId: '9', workflowRunAttempt: '1' };
  const mutate = row.case;
  if (mutate === 'wrong-parent') approval.source.gitCommit = 'd'.repeat(40);
  if (mutate === 'source-child') approval.source.gitCommit = CHILD;
  if (mutate === 'artifact-id-duplicate' || mutate === 'artifact-id-cross-duplicate') approval.node20.artifactId = approval.node22.artifactId;
  for (const [name, field] of [['service', 'artifactServiceSha256'], ['custody', 'custodyManifestSha256'], ['marker', 'completionMarkerSha256']]) {
    if (mutate === name + '-duplicate' || mutate === name + '-cross-duplicate') approval.node20[field] = approval.node22[field];
  }
  if (mutate === 'custody-marker-cross-substitute') approval.node20.custodyManifestSha256 = approval.node22.completionMarkerSha256;
  if (mutate === 'marker-service-cross-substitute') approval.node20.completionMarkerSha256 = approval.node22.artifactServiceSha256;
  if (mutate === 'service-custody-cross-substitute') approval.node20.artifactServiceSha256 = approval.node22.custodyManifestSha256;
  for (const [name, path] of [['model', 'packages/retrieval/src/served-reranker.ts'],
    ['provider', 'packages/retrieval/src/reranker.ts'],
    ['adapter', 'bench/lab/adapters/memberry-retrieval-core.ts'],
    ['statistics', 'bench/lab/stats.ts']]) if (mutate === 'parent-' + name + '-byte-mutation') {
    bytes.set(path, Buffer.concat([bytes.get(path), Buffer.from([0xff])]));
  }
  if (mutate === 'parent-registry-byte-mutation') bytes.set('bench/lab/registry/datasets.json', Buffer.from('{"datasets":[]}'));
  if (mutate === 'parent-input-byte-mutation') bytes.set('bench/lab/datasets/ret010/v1/dev/input.jsonl', Buffer.from('mutated-input\\n'));
  if (mutate === 'parent-oracle-byte-mutation') bytes.set('bench/lab/datasets/ret010/v1/dev/oracle.jsonl', Buffer.from('mutated-oracle\\n'));
  if (mutate === 'parent-dev-policy-byte-mutation') bytes.set('bench/lab/ret010/dev-policy.json', Buffer.from('changed-policy'));
  for (const field of ['artifactId', 'artifactServiceSha256', 'custodyManifestSha256',
    'completionMarkerSha256']) if (mutate === field + '-two-way-swap') {
    const value = approval.node20[field]; approval.node20[field] = approval.node22[field];
    approval.node22[field] = value;
  }
  let approvalBytes = Buffer.from(JSON.stringify(approval) + '\\n');
  const childId = gitBlobId(approvalBytes);
  const id = { gitCommit: CHILD, approvalSha256: sha256(approvalBytes) };
  if (mutate === 'approval-bytes-mismatch') approvalBytes = Buffer.concat([approvalBytes, Buffer.from(' ')]);
  if (mutate === 'approval-digest-mismatch') id.approvalSha256 = '0'.repeat(64);
  const childGit = (args) => args[0] === 'cat-file'
    ? (mutate === 'child-approval-byte-mutation'
      ? Buffer.concat([Buffer.from(JSON.stringify(approval) + '\\n'), Buffer.from([0xff])])
      : Buffer.from(JSON.stringify(approval) + '\\n'))
    : Buffer.from(childId + '\\n');
  const git = (args) => {
    const spec = args.at(-1); const separator = String(spec).indexOf(':');
    const ref = String(spec).slice(0, separator); const path = String(spec).slice(separator + 1);
    if (ref !== PARENT || !bytes.has(path)) throw new Error('fake-git');
    return args[0] === 'cat-file' ? bytes.get(path) : Buffer.from(ids.get(path) + '\\n');
  };
  return { approvalBytes, childId, childGit, id, git };
};
let accepted = false; let beforeImportCalls = 0; let failure = false; let result;
try {
  if (row.kind === 'lineage') {
    const outputs = lineageOutputs();
    let calls = 0;
    const git = (args, maximum) => {
      const expected = calls === 0
        ? ['rev-list', '--parents', '--max-count=1', '--no-abbrev-commit', CHILD]
        : ['diff-tree', '--no-commit-id', '-r', '--find-renames=100%', '--find-copies=100%',
          '--find-copies-harder', '--no-abbrev', '--raw', '-z', PARENT, CHILD];
      const expectedMaximum = calls === 0 ? 256 : 1024;
      if (JSON.stringify(args) !== JSON.stringify(expected) || maximum !== expectedMaximum) {
        throw new Error('lineage-git-contract');
      }
      const value = calls++ === 0 ? outputs.parents : outputs.diff;
      if (value.length > maximum) throw new Error('fake-overflow');
      return value;
    };
    result = gate.__testApprovalLineage(CHILD, git); accepted = true;
  } else if (row.kind === 'git') {
    const transport = (file, args, options) => {
      const expectedArgs = ['--no-replace-objects', '--no-optional-locks', '-c',
        'core.fsmonitor=false', '-c', 'core.untrackedCache=false', 'rev-parse', 'HEAD'];
      if (file !== 'git' || JSON.stringify(args) !== JSON.stringify(expectedArgs)
        || options.cwd !== process.cwd() || options.encoding !== 'buffer'
        || options.maxBuffer !== 128 || options.timeout !== 30000 || options.windowsHide !== true
        || options.killSignal !== 'SIGKILL' || !Object.isFrozen(options)
        || !Object.isFrozen(options.stdio) || !Object.isFrozen(options.env)
        || JSON.stringify(options.stdio) !== JSON.stringify(['ignore', 'pipe', 'pipe'])
        || options.env.GIT_NO_REPLACE_OBJECTS !== '1' || options.env.GIT_NO_LAZY_FETCH !== '1'
        || options.env.GIT_OPTIONAL_LOCKS !== '0' || options.env.GIT_TERMINAL_PROMPT !== '0'
        || Object.hasOwn(options.env, 'GIT_SSH_COMMAND')) throw new Error('hardened-git-contract');
      return {
      error: row.case === 'timeout' ? Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) : undefined,
      signal: row.case === 'timeout' ? 'SIGKILL' : null,
      status: row.case === 'nonzero' ? 1 : 0,
      stdout: Buffer.alloc(row.case === 'oversized' ? 129 : 1, 0x61),
      stderr: Buffer.from(row.case === 'stderr' ? 'hostile' : ''),
      };
    };
    gate.__testHardenedGit(['rev-parse', 'HEAD'], 128, transport); accepted = true;
  } else if (row.kind === 'blob') {
    const value = blobFixture();
    result = gate.__testGitBlob(PARENT, 'blob.bin', value.git); accepted = true;
  } else {
    const value = approvalFixture();
    let lineageCalls = 0;
    const lineage = gate.__testApprovalLineage(CHILD,
      () => lineageCalls++ === 0 ? Buffer.from(CHILD + ' ' + PARENT + '\\n') : canonicalDiff(value.childId));
    const dispatch = gate.__testBindApprovalCommit(lineage, value.approvalBytes,
      value.id.approvalSha256, value.childGit);
    result = await gate.__testProductionApprovalBeforeImports(dispatch, value.id,
      async () => { beforeImportCalls += 1; }, value.git);
    accepted = true;
  }
} catch { failure = true; }
await new Promise((resolveImmediate) => setImmediate(resolveImmediate)); drain();
const forbiddenBefore = loaderRows.filter((item) => item.blocked).length;
let negativeCaught = 0;
try { await import('../datasets/load-suite.js'); } catch (error) {
  if (error.message === 'forbidden-lineage-loader') negativeCaught += 1; else throw error;
}
if (originalFetch) globalThis.fetch = originalFetch;
process.stdout.write(JSON.stringify({ accepted, blobId: result?.id, failure, parent: result?.parent,
  beforeImportCalls, forbiddenBefore, networkAttempts, negativeCaught }));
`);
  return harness;
}

function fixture() {
  const lane = (name: 'recall' | 'precision') => Array.from({ length: 10 }, (_, index) => {
    const ordinal = String(index + 1).padStart(2, '0');
    return {
      scenarioId: `fixture-${name}-${ordinal}`,
      probeId: `fixture-probe-${ordinal}`,
      controlMetric: 0.4,
      candidateMetric: name === 'precision' ? 0.5 : 0.4,
      controlCoverage: 0.4,
      controlTokens: 100,
      candidateCoverage: 0.6,
      candidateTokens: 100,
      staleLeakRate: 0,
      isolationLeakRate: 0,
      duplicateRate: 0,
      unknownResultRate: 0,
    };
  });
  return { schemaVersion: '1', recall: lane('recall'), precision: lane('precision') };
}

type FixtureValue = ReturnType<typeof fixture>;
type FixtureMutationRow = Readonly<{
  label: string;
  ordinal: number;
  mutate(source: FixtureValue): unknown;
}>;

const EXACT_RECORD_MUTATIONS: readonly FixtureMutationRow[] = (() => {
  const mutations: Array<[string, (source: FixtureValue) => unknown]> = [
    ['schema-0', (source) => ((source as unknown as Record<string, unknown>).schemaVersion = '0')],
    ['schema-2', (source) => ((source as unknown as Record<string, unknown>).schemaVersion = '2')],
    ['schema-number', (source) => ((source as unknown as Record<string, unknown>).schemaVersion = 1)],
    ['schema-null', (source) => ((source as unknown as Record<string, unknown>).schemaVersion = null)],
    ['schema-false', (source) => ((source as unknown as Record<string, unknown>).schemaVersion = false)],
    ['schema-missing', (source) => delete (source as unknown as Record<string, unknown>).schemaVersion],
    ['recall-9', (source) => { source.recall.pop(); }],
    ['recall-11', (source) => source.recall.push({ ...source.recall[9]! })],
    ['precision-9', (source) => { source.precision.pop(); }],
    ['precision-11', (source) => source.precision.push({ ...source.precision[9]! })],
    ['duplicate-scenario', (source) => (source.recall[1]!.scenarioId = source.recall[0]!.scenarioId)],
    ['duplicate-probe', (source) => (source.precision[1]!.probeId = source.precision[0]!.probeId)],
    ['cross-lane-id', (source) => (source.precision[0]!.scenarioId = 'fixture-recall-01')],
    ['reordered-rows', (source) => {
      [source.recall[0], source.recall[1]] = [source.recall[1]!, source.recall[0]!];
    }],
    ['metric-negative', (source) => (source.recall[0]!.controlMetric = -0.000001)],
    ['metric-over-one', (source) => (source.recall[0]!.candidateMetric = 1.000001)],
    ['metric-null', (source) => ((source.recall[0] as Record<string, unknown>).controlMetric = null)],
    ['metric-string', (source) => ((source.recall[0] as Record<string, unknown>).controlMetric = '0.4')],
    ['token-negative', (source) => (source.recall[0]!.controlTokens = -1)],
    ['token-over-max', (source) => (source.recall[0]!.candidateTokens = 1_000_001)],
    ['token-fractional', (source) => (source.precision[0]!.controlTokens = 0.5)],
    ['token-string', (source) => ((source.precision[0] as Record<string, unknown>).controlTokens = '1')],
    ['token-null', (source) => ((source.precision[0] as Record<string, unknown>).candidateTokens = null)],
    ['top-key-order', (source) => ({ recall: source.recall, schemaVersion: '1', precision: source.precision })],
    ['row-key-order', (source) => {
      const row = source.recall[0]!;
      source.recall[0] = { probeId: row.probeId, scenarioId: row.scenarioId,
        controlMetric: row.controlMetric, candidateMetric: row.candidateMetric,
        controlCoverage: row.controlCoverage, controlTokens: row.controlTokens,
        candidateCoverage: row.candidateCoverage, candidateTokens: row.candidateTokens,
        staleLeakRate: row.staleLeakRate, isolationLeakRate: row.isolationLeakRate,
        duplicateRate: row.duplicateRate, unknownResultRate: row.unknownResultRate };
    }],
  ];
  for (const name of FORBIDDEN_FIXTURE_FIELDS) {
    mutations.push([`forbidden-record-${name}`,
      (source) => ((source.recall[0] as Record<string, unknown>)[name] = 'forbidden')]);
    mutations.push([`forbidden-top-${name}`,
      (source) => ((source as unknown as Record<string, unknown>)[name] = 'forbidden')]);
  }
  return Object.freeze(mutations.map(([label, mutate], index) => Object.freeze({
    label, mutate, ordinal: 300 + index,
  })));
})();

const RAW_DUPLICATE_ROWS = (() => {
  const rawBase = JSON.stringify(fixture());
  const rows: Array<Readonly<{ label: string; raw: string; ordinal: number }>> = [
    { label: 'negative-zero', raw: rawBase.replace('"controlMetric":0.4', '"controlMetric":-0'), ordinal: 400 },
    ...(['schemaVersion', 'recall', 'precision'] as const).map((name, index) => ({
      label: `duplicate-top-${name}`, raw: rawBase.replace('{', `{"${name}":null,`), ordinal: 401 + index,
    })),
    ...FIXTURE_ROW_KEYS.map((name, index) => ({
      label: `duplicate-row-${name}`,
      raw: rawBase.replace('{"scenarioId"', `{"${name}":null,"scenarioId"`),
      ordinal: 404 + index,
    })),
  ];
  return Object.freeze(rows.map((row) => Object.freeze(row)));
})();

type IdentityRow = Readonly<{
  label: string;
  ordinal: number;
  mutate(source: FixtureValue): void;
}>;
const EXACT_IDENTITY_ROWS: readonly IdentityRow[] = (() => {
  type LaneName = 'recall' | 'precision';
  const rows: IdentityRow[] = [];
  for (const laneName of ['recall', 'precision'] as const) for (let index = 0; index < 10; index += 1) {
    const ordinal = String(index + 1).padStart(2, '0');
    const target = (index + 1) % 10;
    const targetOrdinal = String(target + 1).padStart(2, '0');
    const base = rows.length;
    rows.push(
      { label: `${laneName}-${ordinal}-unique-wrong-scenario`, ordinal: 1_000 + base, mutate: (source) => {
        source[laneName][index]!.scenarioId = `wrong-${laneName}-${ordinal}`;
      } },
      { label: `${laneName}-${ordinal}-unique-wrong-probe`, ordinal: 1_001 + base, mutate: (source) => {
        source[laneName][index]!.probeId = `wrong-probe-${laneName}-${ordinal}`;
      } },
      { label: `${laneName}-${ordinal}-duplicate-scenario`, ordinal: 1_002 + base, mutate: (source) => {
        source[laneName][index]!.scenarioId = `fixture-${laneName}-${targetOrdinal}`;
      } },
      { label: `${laneName}-${ordinal}-duplicate-probe`, ordinal: 1_003 + base, mutate: (source) => {
        source[laneName][index]!.probeId = `fixture-probe-${targetOrdinal}`;
      } },
      { label: `${laneName}-${ordinal}-reordered-identity`, ordinal: 1_004 + base, mutate: (source) => {
        [source[laneName][index], source[laneName][target]] = [
          source[laneName][target]!, source[laneName][index]!,
        ];
      } },
      { label: `${laneName}-${ordinal}-cross-lane-scenario`, ordinal: 1_005 + base, mutate: (source) => {
        const other: LaneName = laneName === 'recall' ? 'precision' : 'recall';
        source[laneName][index]!.scenarioId = `fixture-${other}-${ordinal}`;
      } },
    );
  }
  return Object.freeze(rows.map(Object.freeze));
})();

type PayloadRow = Readonly<{ label: string; ordinal: number; payload(): Buffer }>;
const EXACT_NUMERIC_ROWS: readonly PayloadRow[] = (() => {
  const numericFields = ['controlMetric', 'candidateMetric', 'controlCoverage', 'candidateCoverage',
    'staleLeakRate', 'isolationLeakRate', 'duplicateRate', 'unknownResultRate'] as const;
  const invalidNumericTokens = [
    ['negative', '-1'], ['over-one', '1.000001'], ['negative-zero', '-0'],
    ['string', '"0.5"'], ['null', 'null'], ['nan', 'NaN'],
    ['positive-infinity', 'Infinity'], ['negative-infinity', '-Infinity'],
  ] as const;
  const tokenFields = ['controlTokens', 'candidateTokens'] as const;
  const invalidTokenTokens = [
    ['negative', '-1'], ['over-max', '1000001'], ['fractional', '0.5'],
    ['string', '"1"'], ['null', 'null'], ['unsafe-integer', '9007199254740992'],
    ['negative-zero', '-0'],
  ] as const;
  const rows: Array<Omit<PayloadRow, 'ordinal'>> = [];
  const replaceFirstValue = (field: string, token: string): Buffer => {
    const source = JSON.stringify(fixture());
    const pattern = new RegExp(`"${field}":(?:-?[0-9]+(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|null|true|false|"[^"]*")`);
    const mutated = source.replace(pattern, `"${field}":${token}`);
    if (mutated === source) throw new Error(`missing fixture field ${field}`);
    return Buffer.from(`${mutated}\n`);
  };
  for (const field of numericFields) for (const [kind, token] of invalidNumericTokens) rows.push({
    label: `numeric-${field}-${kind}`, payload: () => replaceFirstValue(field, token),
  });
  for (const field of tokenFields) for (const [kind, token] of invalidTokenTokens) rows.push({
    label: `token-${field}-${kind}`, payload: () => replaceFirstValue(field, token),
  });
  for (const name of ['recall', 'precision'] as const) {
    rows.push({ label: `top-missing-${name}`, payload: () => {
      const source = fixture(); delete (source as unknown as Record<string, unknown>)[name];
      return Buffer.from(`${JSON.stringify(source)}\n`);
    } });
    rows.push({ label: `top-extra-${name}`, payload: () => {
      const source = fixture();
      (source as unknown as Record<string, unknown>)[`${name}Extra`] = [];
      return Buffer.from(`${JSON.stringify(source)}\n`);
    } });
  }
  for (const lane of ['recall', 'precision'] as const) for (const key of FIXTURE_ROW_KEYS) rows.push({
    label: `record-missing-${lane}-${key}`, payload: () => {
      const source = fixture(); delete (source[lane][0] as Record<string, unknown>)[key];
      return Buffer.from(`${JSON.stringify(source)}\n`);
    },
  });
  return Object.freeze(rows.map((row, index) => Object.freeze({ ...row, ordinal: 2_000 + index })));
})();

type EnvironmentRow = Readonly<{
  label: string;
  ordinal: number;
  mutate(environment: NodeJS.ProcessEnv): void;
}>;
function freezeEnvironmentRows(
  rows: ReadonlyArray<readonly [string, (environment: NodeJS.ProcessEnv) => void]>, base: number,
): readonly EnvironmentRow[] {
  return Object.freeze(rows.map(([label, mutate], index) => Object.freeze({
    label, mutate, ordinal: base + index,
  })));
}
const FIXTURE_CROSSING_ROWS = freezeEnvironmentRows([
  ['selector-zero', (environment: NodeJS.ProcessEnv) => { environment.RET010_HOLDOUT_TEST_FIXTURE = '0'; }],
  ['node-env-production', (environment: NodeJS.ProcessEnv) => { environment.NODE_ENV = 'production'; }],
  ['github-actions-empty', (environment: NodeJS.ProcessEnv) => { environment.GITHUB_ACTIONS = ''; }],
  ['github-actions-false', (environment: NodeJS.ProcessEnv) => { environment.GITHUB_ACTIONS = 'false'; }],
  ['github-actions-true', (environment: NodeJS.ProcessEnv) => { environment.GITHUB_ACTIONS = 'true'; }],
  ['github-actions-arbitrary', (environment: NodeJS.ProcessEnv) => { environment.GITHUB_ACTIONS = 'arbitrary'; }],
  ['github-sha', (environment: NodeJS.ProcessEnv) => { environment.GITHUB_SHA = 'c'.repeat(40); }],
  ['github-run-id', (environment: NodeJS.ProcessEnv) => { environment.GITHUB_RUN_ID = '9'; }],
  ['github-actor', (environment: NodeJS.ProcessEnv) => { environment.GITHUB_ACTOR = 'fixture-crossing'; }],
  ['runner-temp', (environment: NodeJS.ProcessEnv) => {
    environment.RUNNER_TEMP = String(environment.RET010_HOLDOUT_TEST_RUNNER_TEMP);
  }],
  ['production-approval', (environment: NodeJS.ProcessEnv) => {
    environment.RET010_HOLDOUT_APPROVAL_DIGEST = 'd'.repeat(64);
  }],
  ['fixture-outcome-in-run', (environment: NodeJS.ProcessEnv) => {
    environment.RET010_HOLDOUT_TEST_GATE_OUTCOME = 'success';
  }],
  ['fixture-oracle-path', (environment: NodeJS.ProcessEnv) => {
    environment.RET010_HOLDOUT_TEST_ORACLE_PATH = 'forbidden';
  }],
  ['missing-run-id', (environment: NodeJS.ProcessEnv) => { delete environment.RET010_HOLDOUT_TEST_RUN_ID; }],
  ['missing-approval', (environment: NodeJS.ProcessEnv) => {
    delete environment.RET010_HOLDOUT_TEST_APPROVAL_SHA256;
  }],
  ['mixed-case-selector', (environment: NodeJS.ProcessEnv) => {
    delete environment.RET010_HOLDOUT_TEST_FIXTURE;
    environment.Ret010_HOLDOUT_TEST_FIXTURE = '1';
  }],
] as const, 40);

const FIXTURE_IDENTITY_ROWS: readonly EnvironmentRow[] = (() => {
  const invalidFixtureValues: Array<[string, readonly string[]]> = [
    ['RET010_HOLDOUT_TEST_RUNNER_TEMP', ['relative-runner',
      resolve(tmpdir(), `ret010-missing-${process.pid}-${Date.now()}`)]],
    ['RET010_HOLDOUT_TEST_GIT_COMMIT', ['a'.repeat(39), 'A'.repeat(40), 'g'.repeat(40)]],
    ['RET010_HOLDOUT_TEST_RUN_ID', ['0', '01', '-1', 'run']],
    ['RET010_HOLDOUT_TEST_RUN_ATTEMPT', ['0', '01', '-1', 'attempt']],
    ['RET010_HOLDOUT_TEST_APPROVAL_SHA256', ['b'.repeat(63), 'B'.repeat(64), 'g'.repeat(64)]],
  ];
  const production: Record<string, string> = {
    RUNNER_TEMP: resolve(tmpdir()), GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_PATH: resolve(tmpdir(), 'event.json'), GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REPOSITORY: 'AP3X-Dev/memberry', GITHUB_REF: 'refs/heads/master',
    GITHUB_SHA: 'c'.repeat(40), GITHUB_RUN_ID: '9', GITHUB_RUN_ATTEMPT: '1',
    RET010_HOLDOUT_QUALIFICATION_SHA: 'c'.repeat(40),
    RET010_HOLDOUT_APPROVAL_DIGEST: 'd'.repeat(64), RET010_HOLDOUT_GATE_OUTCOME: 'success',
  };
  const rows: Array<Omit<EnvironmentRow, 'ordinal'>> = [];
  for (const [key, invalids] of invalidFixtureValues) {
    rows.push({ label: `missing-${key}`, mutate: (environment) => { delete environment[key]; } });
    for (const [index, invalid] of invalids.entries()) rows.push({
      label: `invalid-${key}-${index}`, mutate: (environment) => { environment[key] = invalid; },
    });
  }
  for (const [key, value] of Object.entries(production)) rows.push({
    label: `production-${key}`, mutate: (environment) => { environment[key] = value; },
  });
  rows.push({ label: 'production-combined', mutate: (environment) => { Object.assign(environment, production); } });
  return Object.freeze(rows.map((row, index) => Object.freeze({ ...row, ordinal: 120 + index })));
})();

const FRAMING_ROWS: readonly PayloadRow[] = (() => {
  const canonical = Buffer.from(`${JSON.stringify(fixture())}\n`);
  const duplicate = Buffer.from(`${JSON.stringify(fixture()).replace(
    '{"schemaVersion":"1"', '{"schemaVersion":"1","schemaVersion":"1"')}\n`);
  const nestedDuplicate = Buffer.from(`${JSON.stringify(fixture()).replace(
    '"controlMetric":0.4', '"controlMetric":0.4,"controlMetric":0.4')}\n`);
  const payloads: Array<[string, Buffer]> = [
    ['missing-lf', canonical.subarray(0, -1)],
    ['early-eof', canonical.subarray(0, Math.floor(canonical.length / 2))],
    ['extra-lf', Buffer.concat([canonical, Buffer.from('\n')])],
    ['second-record', Buffer.concat([canonical, Buffer.from('{}\n')])],
    ['trailing-byte', Buffer.concat([canonical, Buffer.from('trailing')])],
    ['crlf', Buffer.concat([canonical.subarray(0, -1), Buffer.from('\r\n')])],
    ['bom', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), canonical])],
    ['invalid-utf8', Buffer.from([0xc3, 0x28, 0x0a])],
    ['whitespace', Buffer.from(`${JSON.stringify(fixture(), null, 2)}\n`)],
    ['duplicate-top', duplicate], ['duplicate-nested', nestedDuplicate],
  ];
  return Object.freeze(payloads.map(([label, bytes], index) => Object.freeze({
    label, ordinal: 70 + index, payload: () => bytes,
  })));
})();

const FD_FAILURE_ROWS = Object.freeze([
  ['fd-acquire-failure', { fstats: 1, readCalls: 0, fixtureCloseAttempts: 1 }],
  ['fd-ebadf', { fstats: 1, readCalls: 0, fixtureCloseAttempts: 0 }],
  ['fd-type-failure', { fstats: 1, readCalls: 0, fixtureCloseAttempts: 1 }],
  ['fd-read-failure', { fstats: 1, readCalls: 1, fixtureCloseAttempts: 1 }],
  ['fd-late-trailing', { fstats: 1, readCalls: 2, fixtureCloseAttempts: 1 }],
  ['fd-post-fstat-failure', { fstats: 2, fixtureCloseAttempts: 1 }],
  ['fd-post-type', { fstats: 2, fixtureCloseAttempts: 1 }],
  ['fd-post-identity', { fstats: 2, fixtureCloseAttempts: 1 }],
  ['fd-close-failure', { fstats: 2, fixtureCloseAttempts: 1 }],
] as const);

const FD_FALSY_ROWS = Object.freeze(['initial', 'read', 'probe', 'post', 'close'].flatMap((phase) =>
  ['undefined', 'null', 'zero', 'false'].map((value) => Object.freeze({
    label: `${phase}-${value}`, action: `fd-${phase}-${value}`, value,
  }))));
const FD_AGGREGATE_ROWS = Object.freeze([
  { action: 'fd-aggregate-read', failureShape: ['undefined', 'false'] },
  { action: 'fd-aggregate-initial', failureShape: ['null', 'false'] },
] as const);
const FD_CODE_ROWS = Object.freeze(['fd-ebadf-accessor', 'fd-ebadf-proxy'] as const);
const RETAINED_FALSY_ROWS = Object.freeze([
  { action: 'retained-falsy-operation', failureShape: ['undefined'] },
  { action: 'retained-falsy-aggregate', failureShape: ['null', 'false'] },
] as const);

const FINALIZE_CROSSING_ROWS = freezeEnvironmentRows([
  ['selector-zero', (environment: NodeJS.ProcessEnv) => { environment.RET010_HOLDOUT_TEST_FIXTURE = '0'; }],
  ['github-actions-empty', (environment: NodeJS.ProcessEnv) => { environment.GITHUB_ACTIONS = ''; }],
  ['github-actions-false', (environment: NodeJS.ProcessEnv) => { environment.GITHUB_ACTIONS = 'false'; }],
  ['github-actions-true', (environment: NodeJS.ProcessEnv) => { environment.GITHUB_ACTIONS = 'true'; }],
  ['github-actions-arbitrary', (environment: NodeJS.ProcessEnv) => { environment.GITHUB_ACTIONS = 'arbitrary'; }],
  ['github-sha', (environment: NodeJS.ProcessEnv) => { environment.GITHUB_SHA = 'c'.repeat(40); }],
  ['production-outcome', (environment: NodeJS.ProcessEnv) => {
    environment.RET010_HOLDOUT_GATE_OUTCOME = 'failure';
  }],
  ['contradictory-success', (environment: NodeJS.ProcessEnv) => {
    environment.RET010_HOLDOUT_TEST_GATE_OUTCOME = 'success';
  }],
  ['oracle-path', (environment: NodeJS.ProcessEnv) => {
    environment.RET010_HOLDOUT_TEST_ORACLE_PATH = 'forbidden';
  }],
  ['missing-outcome', (environment: NodeJS.ProcessEnv) => {
    delete environment.RET010_HOLDOUT_TEST_GATE_OUTCOME;
  }],
  ['missing-output', (environment: NodeJS.ProcessEnv) => { delete environment.GITHUB_OUTPUT; }],
] as const, 210);

type LineageHarnessRow = Readonly<{
  label: string;
  kind: 'lineage' | 'approval' | 'blob' | 'git';
  case: string;
  accepted: boolean;
}>;
const LINEAGE_ROWS: readonly LineageHarnessRow[] = Object.freeze([
  { label: 'positive-exact-lineage', kind: 'lineage', case: 'positive', accepted: true },
  ...['root', 'merge', 'malformed-parent', 'parent-nul', 'parent-trailing', 'parent-truncated',
    'parent-oversized', 'missing', 'modified', 'renamed', 'copied', 'deleted', 'case-variant',
    'symlink', 'submodule', 'wrong-mode', 'second-path', 'child-source-mutation', 'diff-nul',
    'diff-truncated', 'diff-oversized'].map((value) => ({
    label: `lineage-${value}`, kind: 'lineage' as const, case: value, accepted: false,
  })),
]);
const GIT_TRANSPORT_ROWS: readonly LineageHarnessRow[] = Object.freeze([
  { label: 'git-positive-hardened-contract', kind: 'git', case: 'positive', accepted: true },
  ...['stderr', 'nonzero', 'timeout', 'oversized'].map((value) => ({
    label: `git-${value}`, kind: 'git' as const, case: value, accepted: false,
  })),
]);
const GIT_BLOB_ROWS: readonly LineageHarnessRow[] = Object.freeze([
  ...['empty', 'nul', 'high-bit', 'large'].flatMap((value) => [
    { label: `blob-${value}-positive`, kind: 'blob' as const, case: value, accepted: true },
    { label: `blob-${value}-fixed-id-mutation`, kind: 'blob' as const,
      case: `${value}-mutation`, accepted: false },
  ]),
]);
const APPROVAL_AUTHORITY_ROWS: readonly LineageHarnessRow[] = Object.freeze([
  { label: 'positive-parent-authority', kind: 'approval', case: 'positive', accepted: true },
  ...['wrong-parent', 'source-child', 'child-approval-byte-mutation',
    'parent-model-byte-mutation', 'parent-provider-byte-mutation',
    'parent-adapter-byte-mutation', 'parent-statistics-byte-mutation',
    'parent-registry-byte-mutation', 'parent-input-byte-mutation', 'parent-oracle-byte-mutation',
    'parent-dev-policy-byte-mutation', 'approval-bytes-mismatch', 'approval-digest-mismatch',
    'artifact-id-duplicate', 'artifact-id-cross-duplicate', 'service-duplicate',
    'service-cross-duplicate', 'custody-duplicate', 'custody-cross-duplicate',
    'marker-duplicate', 'marker-cross-duplicate', 'custody-marker-cross-substitute',
    'marker-service-cross-substitute', 'service-custody-cross-substitute'].map((value) => ({
    label: `approval-${value}`, kind: 'approval' as const, case: value, accepted: false,
  })),
  ...['artifactId', 'artifactServiceSha256', 'custodyManifestSha256',
    'completionMarkerSha256'].map((field) => ({
    label: `approval-${field}-two-way-swap-accepted-by-committed-byte-authority`,
    kind: 'approval' as const, case: `${field}-two-way-swap`, accepted: true,
  })),
]);

describe('RET-010 holdout fixture boundary', () => {
  it('isolates spawned children from hosted identity and Node bootstrap controls', () => {
    const environment = cleanEnvironment({
      RUNNER_TEMP: '/hosted/runner/temp', GITHUB_SHA: 'a'.repeat(40),
      RET010_HOLDOUT_TEST_FIXTURE: '1', NODE_ENV: 'production', NODE_OPTIONS: '--inspect',
      NODE_PATH: '/hosted/node-path', NODE_DEBUG: '*', NODE_CHANNEL_FD: '3',
      NODE_CHANNEL_SERIALIZATION_MODE: 'advanced', NODE_UNIQUE_ID: 'worker-1',
      SAFE_FIXTURE_VALUE: 'preserved',
    });
    expect(Object.getPrototypeOf(environment)).toBeNull();
    expect(Object.entries(environment)).toEqual([['SAFE_FIXTURE_VALUE', 'preserved']]);
  });

  it('freezes approval-authority lineage, Git blob/transport, and node-distinctness row inventories', () => {
    expect(LINEAGE_ROWS).toHaveLength(22);
    expect(GIT_TRANSPORT_ROWS).toHaveLength(5);
    expect(GIT_BLOB_ROWS).toHaveLength(8);
    expect(APPROVAL_AUTHORITY_ROWS).toHaveLength(29);
    const labels = [...LINEAGE_ROWS, ...GIT_TRANSPORT_ROWS, ...GIT_BLOB_ROWS,
      ...APPROVAL_AUTHORITY_ROWS]
      .map(({ label }) => label);
    expect(new Set(labels).size).toBe(64);
  });

  it.each([...LINEAGE_ROWS, ...GIT_TRANSPORT_ROWS, ...GIT_BLOB_ROWS,
    ...APPROVAL_AUTHORITY_ROWS])(
    'executes approval authority row: $label', async (row) => {
      const harness = await instrumentedLineageHarness();
      const result = spawnBounded(['--import', 'tsx', harness], {
        cwd: ROOT, encoding: 'utf8', env: {
          ...cleanEnvironment(),
          GIT_CONFIG_GLOBAL: 'hostile', GIT_SSH_COMMAND: 'hostile',
          LINEAGE_ROW_BASE64: Buffer.from(JSON.stringify(row)).toString('base64'),
        },
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      const proof = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(proof.accepted, row.label).toBe(row.accepted);
      expect(proof.failure, row.label).toBe(!row.accepted);
      expect(proof.beforeImportCalls, row.label)
        .toBe(row.kind === 'approval' && row.accepted ? 1 : 0);
      expect(proof.forbiddenBefore, row.label).toBe(0);
      expect(proof.networkAttempts, row.label).toBe(0);
      expect(proof.negativeCaught, row.label).toBe(1);
      if (row.label === 'positive-exact-lineage') expect(proof.parent).toBe('a'.repeat(40));
      if (row.label === 'blob-empty-positive') {
        expect(proof.blobId).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
      }
    },
  );

  it('wires the executable approval seam before both production dynamic imports', async () => {
    const source = await readFile(GATE, 'utf8');
    const seam = 'await productionApprovalBeforeImports(dispatch, id, hooks.beforeRealImports);';
    expect(source.split(seam)).toHaveLength(2);
    const seamIndex = source.indexOf(seam);
    const loaderIndex = source.indexOf("await import('../datasets/load-suite.js')");
    const adapterIndex = source.indexOf("await import('../registered-adapters.js')");
    expect(seamIndex).toBeGreaterThan(0);
    expect(loaderIndex).toBeGreaterThan(seamIndex);
    expect(adapterIndex).toBeGreaterThan(loaderIndex);
  });

  it('classifies and disposes a synchronous harness child at its explicit timeout', async () => {
    const harness = await instrumentedLineageHarness();
    const row = { kind: 'child-timeout', case: 'ready' };
    const result = spawnExpectedTimeout(['--import', 'tsx', harness], {
      cwd: ROOT, encoding: 'utf8', env: {
        ...cleanEnvironment(), LINEAGE_ROW_BASE64: Buffer.from(JSON.stringify(row)).toString('base64'),
      },
    });
    expect(result.stdout).toMatch(/^TIMEOUT_READY:[1-9][0-9]*\n$/);
    expect(result.stderr).toBe('');
    const pid = Number(/^TIMEOUT_READY:([1-9][0-9]*)\n$/.exec(result.stdout)![1]);
    expect(() => process.kill(pid, 0)).toThrow();
    await rm(resolve(harness, '..'), { recursive: true, force: false });
  });

  it('accepts only the closed exact 10+10 ordinal record and returns an immutable copy', () => {
    expect(Object.keys(holdoutGate)).toEqual(['validateHoldoutFixtureRecord']);
    const source = fixture();
    const validated = holdoutGate.validateHoldoutFixtureRecord(source);
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.recall)).toBe(true);
    expect((validated.recall as readonly unknown[])).toHaveLength(10);
    expect((validated.precision as readonly unknown[])).toHaveLength(10);
    const derive = (value: Readonly<Record<string, unknown>>) => {
      const recall = value.recall as readonly Record<string, number>[];
      const precision = value.precision as readonly Record<string, number>[];
      const mean = (lane: readonly Record<string, number>[], key: string) =>
        lane.reduce((sum, row) => sum + row[key]!, 0) / lane.length;
      const all = [...recall, ...precision];
      return {
        recall: [mean(recall, 'controlMetric'), mean(recall, 'candidateMetric')],
        precision: [mean(precision, 'controlMetric'), mean(precision, 'candidateMetric')],
        safety: ['staleLeakRate', 'isolationLeakRate', 'duplicateRate', 'unknownResultRate']
          .map((key) => mean(all, key)),
        coverageTokens: all.map((row) => [row.controlCoverage, row.controlTokens,
          row.candidateCoverage, row.candidateTokens]),
      };
    };
    const canonicalBefore = Buffer.from(`${JSON.stringify(validated)}\n`);
    const arithmeticBefore = derive(validated);

    source.schemaVersion = 'hostile';
    source.recall[0]!.scenarioId = 'hostile-scenario';
    source.recall[0]!.candidateMetric = 0;
    source.recall[1] = source.precision[1]!;
    source.recall.reverse();
    source.precision[9]!.candidateCoverage = 0;
    source.precision[9]!.candidateTokens = 1_000_000;
    source.precision.splice(0, 2);

    expect(Buffer.from(`${JSON.stringify(validated)}\n`)).toEqual(canonicalBefore);
    expect(derive(validated)).toEqual(arithmeticBefore);
    expect((validated.recall as readonly Record<string, unknown>[])[0]!.candidateMetric).toBe(0.4);
  });

  it('rejects shared records, accessors, wrong ordinals, extra keys, and negative zero', () => {
    const shared = fixture();
    shared.recall[1] = shared.recall[0]!;
    expect(() => holdoutGate.validateHoldoutFixtureRecord(shared)).toThrow('ret010');

    const accessor = fixture();
    Object.defineProperty(accessor.recall[0]!, 'candidateMetric', { get: () => 0.5, enumerable: true });
    expect(() => holdoutGate.validateHoldoutFixtureRecord(accessor)).toThrow('ret010');

    const wrong = fixture();
    wrong.precision[0]!.probeId = 'fixture-probe-02';
    expect(() => holdoutGate.validateHoldoutFixtureRecord(wrong)).toThrow('ret010');

    const extra = fixture() as ReturnType<typeof fixture> & { path?: string };
    extra.path = 'forbidden';
    expect(() => holdoutGate.validateHoldoutFixtureRecord(extra)).toThrow('ret010');

    const negativeZero = fixture();
    negativeZero.recall[0]!.staleLeakRate = -0;
    expect(() => holdoutGate.validateHoldoutFixtureRecord(negativeZero)).toThrow('ret010');
  });

  it('rejects every nonordinary, sparse, inherited, accessor, iterable, proxy, and reentrant lane form', () => {
    const sparse = fixture(); delete sparse.recall[4];
    expect(() => holdoutGate.validateHoldoutFixtureRecord(sparse)).toThrow('ret010');

    const long = fixture(); long.recall.push({ ...long.recall[9]! });
    expect(() => holdoutGate.validateHoldoutFixtureRecord(long)).toThrow('ret010');
    const short = fixture(); short.precision.pop();
    expect(() => holdoutGate.validateHoldoutFixtureRecord(short)).toThrow('ret010');

    let inheritedReads = 0;
    const inherited = fixture(); delete inherited.recall[0];
    const hostileLanePrototype = Object.create(Array.prototype);
    Object.defineProperty(hostileLanePrototype, '0', {
      get: () => { inheritedReads += 1; return inherited.precision[0]; }, enumerable: true,
    });
    Object.setPrototypeOf(inherited.recall, hostileLanePrototype);
    expect(() => holdoutGate.validateHoldoutFixtureRecord(inherited)).toThrow('ret010');
    expect(inheritedReads).toBe(0);

    let indexReads = 0;
    const accessorIndex = fixture();
    Object.defineProperty(accessorIndex.recall, '3', {
      get: () => { indexReads += 1; return accessorIndex.precision[3]; }, enumerable: true,
    });
    expect(() => holdoutGate.validateHoldoutFixtureRecord(accessorIndex)).toThrow('ret010');
    expect(indexReads).toBe(0);

    let methodCalls = 0;
    const customMethods = fixture();
    Object.defineProperties(customMethods.recall, {
      forEach: { value: () => { methodCalls += 1; }, enumerable: false },
      [Symbol.iterator]: { value: () => { methodCalls += 1; return [][Symbol.iterator](); } },
    });
    expect(() => holdoutGate.validateHoldoutFixtureRecord(customMethods)).toThrow('ret010');
    expect(methodCalls).toBe(0);

    let proxyTraps = 0;
    const proxied = fixture();
    proxied.recall = new Proxy(proxied.recall, {
      getPrototypeOf: () => { proxyTraps += 1; throw new Error('trap'); },
      ownKeys: () => { proxyTraps += 1; throw new Error('trap'); },
      getOwnPropertyDescriptor: () => { proxyTraps += 1; throw new Error('trap'); },
    });
    expect(() => holdoutGate.validateHoldoutFixtureRecord(proxied)).toThrow('ret010');
    expect(proxyTraps).toBe(0);

    const topProxy = new Proxy(fixture(), {
      getPrototypeOf: () => { proxyTraps += 1; throw new Error('top-trap'); },
      ownKeys: () => { proxyTraps += 1; throw new Error('top-trap'); },
    });
    expect(() => holdoutGate.validateHoldoutFixtureRecord(topProxy)).toThrow('ret010');
    expect(proxyTraps).toBe(0);

    const rowProxy = fixture();
    rowProxy.recall[0] = new Proxy(rowProxy.recall[0]!, {
      getPrototypeOf: () => { proxyTraps += 1; throw new Error('row-trap'); },
      getOwnPropertyDescriptor: () => { proxyTraps += 1; throw new Error('row-trap'); },
    });
    expect(() => holdoutGate.validateHoldoutFixtureRecord(rowProxy)).toThrow('ret010');
    expect(proxyTraps).toBe(0);

    const sharedLanes = fixture(); sharedLanes.precision = sharedLanes.recall;
    expect(() => holdoutGate.validateHoldoutFixtureRecord(sharedLanes)).toThrow('ret010');

    let reentrantReads = 0;
    const reentrant = fixture();
    Object.defineProperty(reentrant.precision[0]!, 'candidateMetric', {
      get: () => {
        reentrantReads += 1;
        reentrant.precision.length = 0;
        return 0.5;
      }, enumerable: true,
    });
    expect(() => holdoutGate.validateHoldoutFixtureRecord(reentrant)).toThrow('ret010');
    expect(reentrantReads).toBe(0);

    const customRecordPrototype = fixture();
    Object.setPrototypeOf(customRecordPrototype.recall[0]!, { inherited: true });
    expect(() => holdoutGate.validateHoldoutFixtureRecord(customRecordPrototype)).toThrow('ret010');
  });

  it('enforces all nested orders, identities, bounds, and forbidden fixture fields', () => {
    for (const schemaVersion of ['0', '2', 1, null, false]) {
      const source = fixture();
      (source as unknown as Record<string, unknown>).schemaVersion = schemaVersion;
      expect(() => holdoutGate.validateHoldoutFixtureRecord(source)).toThrow('ret010');
    }
    const topOrder = fixture();
    const reorderedTop = { recall: topOrder.recall, schemaVersion: '1', precision: topOrder.precision };
    expect(() => holdoutGate.validateHoldoutFixtureRecord(reorderedTop)).toThrow('ret010');

    const rowOrder = fixture();
    const row = rowOrder.recall[0]!;
    rowOrder.recall[0] = {
      probeId: row.probeId, scenarioId: row.scenarioId,
      controlMetric: row.controlMetric, candidateMetric: row.candidateMetric,
      controlCoverage: row.controlCoverage, controlTokens: row.controlTokens,
      candidateCoverage: row.candidateCoverage, candidateTokens: row.candidateTokens,
      staleLeakRate: row.staleLeakRate, isolationLeakRate: row.isolationLeakRate,
      duplicateRate: row.duplicateRate, unknownResultRate: row.unknownResultRate,
    };
    expect(() => holdoutGate.validateHoldoutFixtureRecord(rowOrder)).toThrow('ret010');

    const duplicateId = fixture();
    duplicateId.recall[1]!.scenarioId = duplicateId.recall[0]!.scenarioId;
    expect(() => holdoutGate.validateHoldoutFixtureRecord(duplicateId)).toThrow('ret010');
    const reorderedId = fixture();
    [reorderedId.precision[0], reorderedId.precision[1]] = [
      reorderedId.precision[1]!, reorderedId.precision[0]!,
    ];
    expect(() => holdoutGate.validateHoldoutFixtureRecord(reorderedId)).toThrow('ret010');
    const crossLaneId = fixture(); crossLaneId.precision[0]!.scenarioId = 'fixture-recall-01';
    expect(() => holdoutGate.validateHoldoutFixtureRecord(crossLaneId)).toThrow('ret010');
    const crossLaneReference = fixture(); crossLaneReference.precision[0] = crossLaneReference.recall[0]!;
    expect(() => holdoutGate.validateHoldoutFixtureRecord(crossLaneReference)).toThrow('ret010');

    const boundaries = fixture();
    for (const lane of [boundaries.recall, boundaries.precision]) for (const entry of lane) {
      entry.controlMetric = 0; entry.candidateMetric = 1;
      entry.controlCoverage = 0; entry.candidateCoverage = 1;
      entry.controlTokens = 0; entry.candidateTokens = 1_000_000;
      entry.staleLeakRate = 0; entry.isolationLeakRate = 1;
      entry.duplicateRate = 0; entry.unknownResultRate = 1;
    }
    expect(() => holdoutGate.validateHoldoutFixtureRecord(boundaries)).not.toThrow();

    for (const invalid of [-1, 1.0000001, Number.NaN, Number.POSITIVE_INFINITY, -0]) {
      const source = fixture(); source.recall[0]!.controlMetric = invalid;
      expect(() => holdoutGate.validateHoldoutFixtureRecord(source)).toThrow('ret010');
    }
    for (const invalid of [-1, 1_000_001, 0.5, Number.MAX_SAFE_INTEGER]) {
      const source = fixture(); source.precision[0]!.candidateTokens = invalid;
      expect(() => holdoutGate.validateHoldoutFixtureRecord(source)).toThrow('ret010');
    }
    for (const invalid of ['1', null]) {
      const source = fixture();
      (source.recall[0] as Record<string, unknown>).controlTokens = invalid;
      expect(() => holdoutGate.validateHoldoutFixtureRecord(source)).toThrow('ret010');
    }

    for (const name of FORBIDDEN_FIXTURE_FIELDS) {
      const top = fixture() as unknown as ReturnType<typeof fixture> & Record<string, unknown>;
      top[name] = 'forbidden';
      expect(() => holdoutGate.validateHoldoutFixtureRecord(top)).toThrow('ret010');
      const nested = fixture();
      (nested.recall[0] as Record<string, unknown>)[name] = 'forbidden';
      expect(() => holdoutGate.validateHoldoutFixtureRecord(nested)).toThrow('ret010');
    }
  });

  it('maps invalid executable modes to the fixed value-free sentinel', () => {
    const result = spawnBounded(['--import', 'tsx', GATE, 'bad-mode'], {
      cwd: ROOT, encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: undefined, NODE_PATH: undefined },
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('RET010_HOLDOUT_GATE_FAILED\n');
  });

  it('runs the exact fixture CLI through one sealed fd3 and publishes the full receipt', async () => {
    const payload = Buffer.from(`${JSON.stringify(fixture())}\n`);
    const exact = await holdoutRunFixture(1);
    const result = await spawnGate('run', exact.environment, payload);
    expect(result).toEqual({ status: 0, stdout: '', stderr: '' });
    expect(JSON.parse(await readFile(exact.receipt, 'utf8'))).toEqual({
      schemaVersion: '1', decision: 'passed', gitCommit: 'a'.repeat(40),
      nodeMajor: process.versions.node.split('.')[0], nodeVersion: process.version,
      workflowRunId: exact.environment.RET010_HOLDOUT_TEST_RUN_ID,
      workflowRunAttempt: '1', approvalSha256: 'b'.repeat(64),
      datasetId: 'memberry-g2-holdout-holdout', split: 'holdout',
      controlAdapterId: 'memberry-retrieval-core-disabled-v1',
      candidateAdapterId: 'memberry-retrieval-core-served-v1',
      recall: { scenarioCount: 10, probeCount: 10, k: 10, metric: 'recallAtK',
        control: 0.39999999999999997, candidate: 0.39999999999999997, delta: 0 },
      precision: { scenarioCount: 10, probeCount: 10, k: 5, metric: 'precisionAtK',
        control: 0.39999999999999997, candidate: 0.5, delta: 0.10000000000000003 },
      efficiency: { outcome: 'measured', pairedProbes: 20, resamples: 2000, level: 0.95,
        seed: 2465183483, point: 1.9999999999999973, lower: 1.9999999999999973,
        upper: 1.9999999999999973, oneSidedLower: 1.9999999999999973 },
      safety: { staleLeakRate: 0, isolationLeakRate: 0, duplicateRate: 0, unknownResultRate: 0 },
    });
  });

  it('runs the isolated fixture harness without reaching real holdout imports', async () => {
    const payload = Buffer.from(`${JSON.stringify(fixture())}\n`);
    const harness = await instrumentedHoldoutHarness();
    const instrumented = await holdoutRunFixture(2);
    const guarded = spawnBounded(['--import', 'tsx', harness, 'run-fixture'], {
      cwd: ROOT, encoding: 'utf8',
      env: { ...instrumented.environment, HARNESS_PAYLOAD_BASE64: payload.toString('base64') },
    });
    expect(guarded.stderr).toBe('');
    expect(guarded.status).toBe(0);
    const guardedProof = JSON.parse(guarded.stdout) as Record<string, unknown>;
    expect(guardedProof).toMatchObject({
      rejected: false, fstats: 2, fixtureCloseAttempts: 1, realImports: 0,
      fixtureForbiddenFileAttempts: 0, fixtureNetworkAttempts: 0,
      fixtureForbiddenLoaderAttempts: 0, negativeControlsCaught: 12,
      negativeControlsExpected: 12,
      intervalCalls: 1, output: '',
    });
    expect(guardedProof.negativeLoaderBlocks).toBe(guardedProof.negativeLoaderBlocksExpected);
    expect([2, 3]).toContain(guardedProof.negativeLoaderBlocks);
    expect(guardedProof.negativeNetworkAttempts).toBe(guardedProof.negativeNetworkAttemptsExpected);
    expect([8, 9]).toContain(guardedProof.negativeNetworkAttempts);
    const vector = guardedProof.intervalVector as unknown[][];
    const expectedVector = (['recall', 'precision'] as const).flatMap((lane) =>
      Array.from({ length: 10 }, (_, index) => {
        const ordinal = String(index + 1).padStart(2, '0');
        return [`fixture-${lane}-${ordinal}`, `fixture-probe-${ordinal}`, 0.4, 100, 0.6, 100];
      }));
    expect(expectedVector).toHaveLength(20);
    expect(vector).toEqual(expectedVector);
  });

  it('sorts owned recall-then-precision vectors ordinally and calls the interval exactly once', async () => {
    const harness = await instrumentedHoldoutHarness();
    const canonical = fixture();
    const reversed = fixture(); reversed.recall.reverse(); reversed.precision.reverse();
    const rotated = fixture();
    rotated.recall.push(...rotated.recall.splice(0, 3));
    rotated.precision.unshift(...rotated.precision.splice(6));
    const run = (value: ReturnType<typeof fixture>) => {
      const encoded = Buffer.from(JSON.stringify(value)).toString('base64');
      const result = spawnBounded(['--import', 'tsx', harness, 'aggregate-fixture'], {
        cwd: ROOT, encoding: 'utf8', env: {
          ...cleanEnvironment(), HARNESS_PAYLOAD_BASE64: encoded,
        },
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      return JSON.parse(result.stdout) as Record<string, unknown>;
    };
    const proofs = [run(canonical), run(reversed), run(rotated)];
    for (const proof of proofs) {
      expect(proof).toMatchObject({ rejected: false, aggregateInputStable: true,
        aggregateDecision: 'passed', intervalCalls: 1 });
    }
    expect(proofs[1]!.intervalVector).toEqual(proofs[0]!.intervalVector);
    expect(proofs[2]!.intervalVector).toEqual(proofs[0]!.intervalVector);
    expect(proofs[1]!.aggregateResult).toEqual(proofs[0]!.aggregateResult);
    expect(proofs[2]!.aggregateResult).toEqual(proofs[0]!.aggregateResult);
    const aggregate = proofs[0]!.aggregateResult as { efficiency: { seed: number } };
    expect(aggregate.efficiency.seed).toBe(2465183483);
  });

  it.each([
    { label: 'negative recall', ordinal: 410, failureClass: 'model', stage: 'recall-comparison',
      mutate: (value: ReturnType<typeof fixture>) => value.recall.forEach((row) => { row.candidateMetric = 0.3; }) },
    { label: 'negative precision', ordinal: 411, failureClass: 'model', stage: 'precision-comparison',
      mutate: (value: ReturnType<typeof fixture>) => value.precision.forEach((row) => { row.candidateMetric = 0.3; }) },
    { label: 'negative efficiency', ordinal: 412, failureClass: 'metric', stage: 'efficiency',
      mutate: (value: ReturnType<typeof fixture>) => {
        for (const lane of [value.recall, value.precision]) lane.forEach((row) => { row.candidateCoverage = 0.1; });
      } },
    { label: 'nonzero safety', ordinal: 413, failureClass: 'safety', stage: 'safety-policy',
      mutate: (value: ReturnType<typeof fixture>) => { value.precision[0]!.staleLeakRate = 0.1; } },
  ])('writes the exact classified receipt for $label', async ({ ordinal, failureClass, stage, mutate }) => {
    const value = fixture(); mutate(value);
    const input = await holdoutRunFixture(ordinal);
    const result = await spawnGate('run', input.environment, Buffer.from(`${JSON.stringify(value)}\n`));
    expect(result).toMatchObject({ status: 1, stdout: '', stderr: 'RET010_HOLDOUT_GATE_FAILED\n' });
    const receipt = JSON.parse(await readFile(input.receipt, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(receipt)).toEqual(['schemaVersion', 'decision', 'failureClass', 'stage',
      'gitCommit', 'nodeMajor', 'nodeVersion', 'workflowRunId', 'workflowRunAttempt']);
    expect(receipt).toMatchObject({ schemaVersion: '1', decision: 'failed', failureClass, stage });
  });

  it('freezes the content-free holdout failure taxonomy for every protected failure', async () => {
    const harness = await instrumentedHoldoutHarness();
    const stages = ['source-integrity', 'approval', 'load-holdout', 'recall-comparison',
      'precision-comparison', 'efficiency', 'quality-policy', 'safety-policy', 'artifact'];
    const result = spawnBounded(['--import', 'tsx', harness, 'failure-receipt'], {
      cwd: ROOT, encoding: 'utf8', env: {
        ...cleanEnvironment(), HARNESS_STAGES: JSON.stringify(stages),
      },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const proof = JSON.parse(result.stdout) as { failureReceiptResult: Record<string, unknown>[] };
    expect(proof.failureReceiptResult.map(({ failureClass, stage }) => [failureClass, stage])).toEqual([
      ['custody', 'source-integrity'], ['custody', 'approval'], ['harness', 'load-holdout'],
      ['model', 'recall-comparison'], ['model', 'precision-comparison'], ['metric', 'efficiency'],
      ['metric', 'quality-policy'], ['safety', 'safety-policy'], ['custody', 'artifact'],
    ]);
    const source = await readFile(GATE, 'utf8');
    expect(source).not.toContain('error === REJECTION');
    expect(source).toContain('if ((await readdir(root)).length === 0)');
    expect(source).not.toContain("'infrastructure'");
    expect(source).not.toMatch(/error\.(?:message|name|stack).*failureReceipt/);
    const run = source.slice(source.indexOf('async function runGate('),
      source.indexOf('\nfunction checkpointIdentity('));
    expect(run).toContain("if (!test) closeInheritedFd3();");
    expect(run.indexOf("let stage: keyof typeof FAILURE_CLASS_BY_STAGE = 'source-integrity';"))
      .toBeLessThan(run.indexOf("if (!test) closeInheritedFd3();"));
    expect(run.indexOf("if (!test) closeInheritedFd3();"))
      .toBeLessThan(run.indexOf('const dispatch = test ? undefined : await validateHostedDispatch();'));
    for (const [stage, branch] of [
      ["stage = 'recall-comparison';", 'if (recall.delta < 0) reject();'],
      ["stage = 'precision-comparison';", 'if (precision.delta < 0) reject();'],
      ["stage = 'efficiency';", 'const interval = pairedEfficiencyInterval(paired);'],
      ["stage = 'safety-policy';", 'if (Object.values(safety).some((entry) => entry !== 0)) reject();'],
      ["stage = 'artifact';", "await writeExclusive(root, 'holdout-receipt.json', receipt);"],
    ]) expect(run.indexOf(branch)).toBeGreaterThan(run.indexOf(stage));
    expect(run.match(/pairedEfficiencyInterval\(paired\)/g)).toHaveLength(1);
  });

  it('converts a caller exception into a content-free stage receipt', async () => {
    const harness = await instrumentedHoldoutHarness();
    const input = await holdoutRunFixture(414);
    const result = spawnBounded(['--import', 'tsx', harness, 'run-caller-exception'], {
      cwd: ROOT, encoding: 'utf8', env: {
        ...input.environment,
        HARNESS_PAYLOAD_BASE64: Buffer.from(`${JSON.stringify(fixture())}\n`).toString('base64'),
      },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      rejected: true, fixtureCloseAttempts: 1,
      failureShape: ['Error'],
    });
    const receipt = JSON.parse(await readFile(input.receipt, 'utf8')) as Record<string, unknown>;
    expect(receipt).toEqual({
      schemaVersion: '1', decision: 'failed', failureClass: 'harness', stage: 'load-holdout',
      gitCommit: 'a'.repeat(40), nodeMajor: process.versions.node.split('.')[0],
      nodeVersion: process.version, workflowRunId: input.environment.RET010_HOLDOUT_TEST_RUN_ID,
      workflowRunAttempt: '1',
    });
  });

  it.each([
    { label: 'absent', fd3: undefined },
    { label: 'open', fd3: Buffer.alloc(0) },
    { label: 'readable', fd3: Buffer.from(`${JSON.stringify(fixture())}\n`) },
  ])('production run fails before dispatch with fd3 $label', async ({ fd3 }) => {
    const environment = {
      ...cleanEnvironment(),
      GITHUB_EVENT_PATH: resolve(tmpdir(), 'must-not-be-read-ret010-event.json'),
    };
    const result = await spawnGate('run', environment, fd3);
    expect(result.status).not.toBe(0);
    expect(result).toMatchObject({ stdout: '', stderr: 'RET010_HOLDOUT_GATE_FAILED\n' });
  });

  it('rejects an empty sealed fixture fd3', async () => {
    const missing = await holdoutRunFixture(30);
    expect(await spawnGate('run', missing.environment, Buffer.alloc(0))).toMatchObject({
      status: 1, stdout: '', stderr: 'RET010_HOLDOUT_GATE_FAILED\n',
    });
  });

  it('freezes fixture crossing and identity table labels', () => {
    expect(FIXTURE_CROSSING_ROWS).toHaveLength(16);
    expect(new Set(FIXTURE_CROSSING_ROWS.map(({ label }) => label)).size).toBe(16);
    expect(FIXTURE_IDENTITY_ROWS).toHaveLength(34);
    expect(new Set(FIXTURE_IDENTITY_ROWS.map(({ label }) => label)).size).toBe(34);
  });

  it.each(FIXTURE_CROSSING_ROWS)('rejects fixture environment crossing: $label', async ({
    label, ordinal, mutate,
  }) => {
    const payload = Buffer.from(`${JSON.stringify(fixture())}\n`);
    const input = await holdoutRunFixture(ordinal); mutate(input.environment);
    const result = await spawnGate('run', input.environment, payload);
    expect(result.status, label).not.toBe(0);
    expect(result).toMatchObject({ stdout: '', stderr: 'RET010_HOLDOUT_GATE_FAILED\n' });
  });

  it.each(FIXTURE_IDENTITY_ROWS)('rejects fixture/production identity: $label', async ({
    label, ordinal, mutate,
  }) => {
    const payload = Buffer.from(`${JSON.stringify(fixture())}\n`);
    const input = await holdoutRunFixture(ordinal); mutate(input.environment);
    const result = await spawnGate('run', input.environment, payload);
    expect(result.status, label).not.toBe(0);
    expect(result).toMatchObject({ stdout: '', stderr: 'RET010_HOLDOUT_GATE_FAILED\n' });
  });

  it('rejects a stale fixture run root', async () => {
    const payload = Buffer.from(`${JSON.stringify(fixture())}\n`);
    const stale = await holdoutRunFixture(190);
    await mkdir(resolve(stale.runner, 'memberry-ret010-holdout'), { recursive: false });
    const staleResult = await spawnGate('run', stale.environment, payload);
    expect(staleResult.status).not.toBe(0);
    expect(staleResult).toMatchObject({ stdout: '', stderr: 'RET010_HOLDOUT_GATE_FAILED\n' });
  });

  it('rejects a second use of a nonexclusive fixture run root', async () => {
    const payload = Buffer.from(`${JSON.stringify(fixture())}\n`);
    const nonexclusive = await holdoutRunFixture(191);
    expect(await spawnGate('run', nonexclusive.environment, payload)).toEqual({
      status: 0, stdout: '', stderr: '',
    });
    const repeated = await spawnGate('run', nonexclusive.environment, payload);
    expect(repeated.status).not.toBe(0);
    expect(repeated).toMatchObject({ stdout: '', stderr: 'RET010_HOLDOUT_GATE_FAILED\n' });
  });

  it('freezes bounded framing row cardinality and labels', () => {
    expect(FRAMING_ROWS).toHaveLength(11);
    expect(new Set(FRAMING_ROWS.map(({ label }) => label)).size).toBe(11);
  });

  it.each(FRAMING_ROWS)('rejects exact framing payload: $label', async ({
    label, ordinal, payload,
  }) => {
    const input = await holdoutRunFixture(ordinal);
    const result = await spawnGate('run', input.environment, payload());
    expect(result.status, label).not.toBe(0);
    expect(result).toMatchObject({ stdout: '', stderr: 'RET010_HOLDOUT_GATE_FAILED\n' });
  });

  it('freezes complete exact structured and duplicate-key table cardinality and labels', () => {
    expect(EXACT_RECORD_MUTATIONS).toHaveLength(25 + 2 * FORBIDDEN_FIXTURE_FIELDS.length);
    expect(new Set(EXACT_RECORD_MUTATIONS.map(({ label }) => label)).size)
      .toBe(EXACT_RECORD_MUTATIONS.length);
    expect(RAW_DUPLICATE_ROWS).toHaveLength(16);
    expect(new Set(RAW_DUPLICATE_ROWS.map(({ label }) => label)).size)
      .toBe(RAW_DUPLICATE_ROWS.length);
  });

  it.each(EXACT_RECORD_MUTATIONS)('exact structured rejection: $label', async ({
    label, ordinal, mutate,
  }) => {
    const source = fixture();
    const replacement = mutate(source);
    const payload = Buffer.from(`${JSON.stringify(replacement && typeof replacement === 'object'
      ? replacement : source)}\n`);
    const input = await holdoutRunFixture(ordinal);
    const result = await spawnGate('run', input.environment, payload);
    expect(result.status, label).not.toBe(0);
    expect(result).toMatchObject({ stdout: '', stderr: 'RET010_HOLDOUT_GATE_FAILED\n' });
  });

  it.each(RAW_DUPLICATE_ROWS)('exact raw duplicate rejection: $label', async ({
    label, raw, ordinal,
  }) => {
    const input = await holdoutRunFixture(ordinal);
    const result = await spawnGate('run', input.environment, Buffer.from(`${raw}\n`));
    expect(result.status, label).not.toBe(0);
    expect(result).toMatchObject({ stdout: '', stderr: 'RET010_HOLDOUT_GATE_FAILED\n' });
  });

  it('accepts numeric and token inclusive boundaries through the exact run CLI', async () => {
    const source = fixture();
    for (const lane of [source.recall, source.precision]) {
      for (const row of lane) {
        row.controlCoverage = 0.5; row.candidateCoverage = 0.5;
        row.controlTokens = 100; row.candidateTokens = 100;
      }
      lane[0]!.controlMetric = 0; lane[0]!.candidateMetric = 0;
      lane[0]!.controlTokens = 0; lane[0]!.candidateTokens = 0;
      lane[1]!.controlMetric = 1; lane[1]!.candidateMetric = 1;
      lane[1]!.controlTokens = 1_000_000; lane[1]!.candidateTokens = 1_000_000;
    }
    const input = await holdoutRunFixture(390);
    const result = await spawnGate('run', input.environment, Buffer.from(`${JSON.stringify(source)}\n`));
    expect(result).toEqual({ status: 0, stdout: '', stderr: '' });
    expect(JSON.parse(await readFile(input.receipt, 'utf8'))).toMatchObject({
      decision: 'passed', efficiency: { point: 0, lower: 0, upper: 0, oneSidedLower: 0 },
    });
  });

  it('freezes every lane-by-ordinal identity row and label', () => {
    expect(EXACT_IDENTITY_ROWS).toHaveLength(120);
    expect(new Set(EXACT_IDENTITY_ROWS.map(({ label }) => label)).size).toBe(120);
  });

  it.each(EXACT_IDENTITY_ROWS)('exact identity rejection: $label', async ({
    label, ordinal, mutate,
  }) => {
    const source = fixture(); mutate(source);
    const input = await holdoutRunFixture(ordinal);
    const result = await spawnGate('run', input.environment,
      Buffer.from(`${JSON.stringify(source)}\n`));
    expect(result.status, label).not.toBe(0);
    expect(result).toMatchObject({ stdout: '', stderr: 'RET010_HOLDOUT_GATE_FAILED\n' });
  });

  it('freezes the complete exact numeric/token/top/missing-key row table and labels', () => {
    expect(EXACT_NUMERIC_ROWS).toHaveLength(106);
    expect(new Set(EXACT_NUMERIC_ROWS.map(({ label }) => label)).size).toBe(106);
  });

  it.each(EXACT_NUMERIC_ROWS)('exact numeric/schema rejection: $label', async ({
    label, ordinal, payload,
  }) => {
    const input = await holdoutRunFixture(ordinal);
    const result = await spawnGate('run', input.environment, payload());
    expect(result.status, label).not.toBe(0);
    expect(result).toMatchObject({ stdout: '', stderr: 'RET010_HOLDOUT_GATE_FAILED\n' });
  });

  it.each([
    { label: '65,536', overflow: false, ordinal: 100 },
    { label: '65,537', overflow: true, ordinal: 101 },
  ])('rejects non-schema exact cap payload $label without approval', async ({ overflow, ordinal }) => {
    const prefix = Buffer.from('{"x":"'); const suffix = Buffer.from('"}\n');
    const boundary = Buffer.concat([
      prefix, Buffer.alloc(65_536 - prefix.length - suffix.length, 0x61), suffix,
    ]);
    const payload = overflow ? Buffer.concat([boundary, Buffer.from('x')]) : boundary;
    const input = await holdoutRunFixture(ordinal);
    const result = await spawnGate('run', input.environment, payload);
    expect(result.status).not.toBe(0);
    expect(result).toMatchObject({ stdout: '', stderr: 'RET010_HOLDOUT_GATE_FAILED\n' });
  });

  it.each([
    ['fd-chunks', { rejected: false, acceptedLength: 65_536, fstats: 2, fixtureCloseAttempts: 1 }],
    ['fd-boundary', { rejected: false, acceptedLength: 65_536, fstats: 2, fixtureCloseAttempts: 1 }],
    ['fd-overflow', { rejected: true, acceptedLength: null, fstats: 1, fixtureCloseAttempts: 1 }],
  ] as const)('bounds incremental fixture read: %s', async (action, expected) => {
    const harness = await instrumentedHoldoutHarness();
    const result = spawnBounded(['--import', 'tsx', harness, action], {
      cwd: ROOT, encoding: 'utf8', env: cleanEnvironment(),
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject(expected);
  });

  it.each(FD_FAILURE_ROWS)('audits and closes fd3 once: %s', async (action, expected) => {
    const harness = await instrumentedHoldoutHarness();
    const payload = Buffer.from('{"x":1}\n');
    const result = spawnBounded(['--import', 'tsx', harness, action], {
      cwd: ROOT, encoding: 'utf8', env: {
        ...cleanEnvironment(), HARNESS_PAYLOAD_BASE64: payload.toString('base64'),
      },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      rejected: true, acceptedLength: null, ...expected, output: '',
    });
  });

  it('freezes falsy-lifecycle row cardinality and labels', () => {
    expect(FD_FALSY_ROWS).toHaveLength(20);
    expect(new Set(FD_FALSY_ROWS.map(({ label }) => label)).size).toBe(20);
  });

  it.each(FD_FALSY_ROWS)('rejects falsy fd3 lifecycle value: $label', async ({ action, value }) => {
    const harness = await instrumentedHoldoutHarness();
    const payload = Buffer.from('{"x":1}\n').toString('base64');
    const result = spawnBounded(['--import', 'tsx', harness, action], {
      cwd: ROOT, encoding: 'utf8', env: { ...cleanEnvironment(), HARNESS_PAYLOAD_BASE64: payload },
    });
    expect(result.status, action).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      rejected: true, acceptedLength: null, fixtureCloseAttempts: 1,
      failureShape: [value], codeGetterCalls: 0,
    });
  });

  it.each(FD_AGGREGATE_ROWS)('preserves aggregate fd3 failure: $action', async ({ action, failureShape }) => {
    const harness = await instrumentedHoldoutHarness();
    const payload = Buffer.from('{"x":1}\n').toString('base64');
    const result = spawnBounded(['--import', 'tsx', harness, action], {
      cwd: ROOT, encoding: 'utf8', env: { ...cleanEnvironment(), HARNESS_PAYLOAD_BASE64: payload },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ rejected: true, fixtureCloseAttempts: 1, failureShape });
  });

  it.each(FD_CODE_ROWS)('does not invoke hostile fd3 error code: %s', async (action) => {
    const harness = await instrumentedHoldoutHarness();
    const result = spawnBounded(['--import', 'tsx', harness, action], {
      cwd: ROOT, encoding: 'utf8', env: cleanEnvironment(),
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      rejected: true, fixtureCloseAttempts: 1, codeGetterCalls: 0,
    });
  });

  it.each(RETAINED_FALSY_ROWS)('preserves retained falsy failure: $action', async ({
    action, failureShape,
  }) => {
    const harness = await instrumentedHoldoutHarness();
    const result = spawnBounded(['--import', 'tsx', harness, action], {
      cwd: ROOT, encoding: 'utf8', env: cleanEnvironment(),
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ rejected: true, failureShape });
  });

  it('freezes the always-running holdout finalizer and terminal upload binding', async () => {
    const workflow = await readFile(resolve(ROOT, '.github/workflows/ret010-holdout-qualification.yml'), 'utf8');
    expect(workflow.match(/id: ret010_holdout_gate/g)).toHaveLength(1);
    expect(workflow.match(/id: ret010_holdout_finalize/g)).toHaveLength(1);
    expect(workflow).toContain('node --import tsx bench/lab/ret010/holdout-gate.mts run');
    expect(workflow.match(/RET010_HOLDOUT_QUALIFICATION_SHA: \$\{\{ inputs\.qualification_sha \}\}/g)).toHaveLength(2);
    expect(workflow.match(/RET010_HOLDOUT_APPROVAL_DIGEST: \$\{\{ inputs\.approval_digest \}\}/g)).toHaveLength(2);
    expect(workflow).toContain('RET010_HOLDOUT_GATE_OUTCOME: ${{ steps.ret010_holdout_gate.outcome }}');
    expect(workflow).toContain("always() && steps.ret010_holdout_finalize.outcome == 'success' && steps.ret010_holdout_finalize.outputs.upload_path != ''");
    expect(workflow).not.toContain('RET010_HOLDOUT_RECEIPT_PATH');
  });

  it('runs the exact production holdout finalize CLI and emits only its validated upload path', async () => {
    const fixture = await holdoutFailureFixture(1);
    const result = spawnBounded(['--import', 'tsx', GATE, 'finalize'], {
      cwd: ROOT, encoding: 'utf8', env: fixture.environment,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(await readFile(fixture.output, 'utf8'))
      .toMatch(/^upload_path=.*ret010-holdout-upload-[0-9a-f]{64}\n$/);
  });

  it('finalizes the exact passed fixture receipt for the success outcome', async () => {
    const source = await holdoutRunFixture(500);
    const payload = Buffer.from(`${JSON.stringify(fixture())}\n`);
    expect(await spawnGate('run', source.environment, payload)).toEqual({
      status: 0, stdout: '', stderr: '',
    });
    const output = resolve(source.runner, 'success-output');
    await writeFile(output, '');
    const environment = {
      ...source.environment, RET010_HOLDOUT_TEST_GATE_OUTCOME: 'success', GITHUB_OUTPUT: output,
    };
    const result = await spawnGate('finalize', environment);
    expect(result).toEqual({ status: 0, stdout: '', stderr: '' });
    expect(await readFile(output, 'utf8'))
      .toMatch(/^upload_path=.*ret010-holdout-upload-[0-9a-f]{64}\n$/);
  });

  it.each([
    { label: 'cancelled', outcome: 'cancelled', ordinal: 510 },
    { label: 'skipped', outcome: 'skipped', ordinal: 511 },
    { label: 'neutral', outcome: 'neutral', ordinal: 512 },
    { label: 'empty', outcome: '', ordinal: 513 },
    { label: 'missing', outcome: undefined, ordinal: 520 },
  ])('rejects finalize outcome $label with no structured output', async ({ outcome, ordinal }) => {
    const input = await holdoutFailureFixture(ordinal);
    if (outcome === undefined) delete input.environment.RET010_HOLDOUT_TEST_GATE_OUTCOME;
    else input.environment.RET010_HOLDOUT_TEST_GATE_OUTCOME = outcome;
    const result = await spawnGate('finalize', input.environment);
    expect(result.status).not.toBe(0);
    expect(result).toMatchObject({ stdout: '', stderr: 'RET010_HOLDOUT_FINALIZE_FAILED\n' });
    expect(await readFile(input.output, 'utf8')).toBe('');
  });

  it('closes inherited fd3 and finalizes the exact failure receipt', async () => {
    const open = await holdoutFailureFixture(200);
    const openResult = await spawnGate('finalize', open.environment, Buffer.from('readable'));
    expect(openResult).toEqual({ status: 0, stdout: '', stderr: '' });
    expect(await readFile(open.output, 'utf8'))
      .toMatch(/^upload_path=.*ret010-holdout-upload-[0-9a-f]{64}\n$/);
  });

  it.each([
    { action: 'inherited-fd3-open', rejected: false, fstats: 1, closes: 1, failureShape: [] },
    { action: 'inherited-fd3-untyped', rejected: false, fstats: 1, closes: 0, failureShape: [] },
    { action: 'inherited-fd3-ebadf', rejected: false, fstats: 1, closes: 0, failureShape: [] },
    { action: 'inherited-fd3-fstat-failure', rejected: true, fstats: 1, closes: 0, failureShape: ['Error'] },
    { action: 'inherited-fd3-close-failure', rejected: true, fstats: 1, closes: 1, failureShape: ['Error'] },
  ])('settles production fd3 safely: $action', async ({
    action, rejected, fstats, closes, failureShape,
  }) => {
    const harness = await instrumentedHoldoutHarness();
    const result = spawnBounded(['--import', 'tsx', harness, action], {
      cwd: ROOT, encoding: 'utf8', env: cleanEnvironment(),
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      rejected, inheritedFstats: fstats, inheritedCloseAttempts: closes, failureShape,
    });
  });

  it('freezes finalize crossing table cardinality and labels', () => {
    expect(FINALIZE_CROSSING_ROWS).toHaveLength(11);
    expect(new Set(FINALIZE_CROSSING_ROWS.map(({ label }) => label)).size).toBe(11);
  });

  it.each(FINALIZE_CROSSING_ROWS)('rejects finalize crossing: $label', async ({
    label, ordinal, mutate,
  }) => {
    const input = await holdoutFailureFixture(ordinal); mutate(input.environment);
    const result = await spawnGate('finalize', input.environment);
    expect(result.status, label).not.toBe(0);
    expect(result).toMatchObject({ stdout: '', stderr: 'RET010_HOLDOUT_FINALIZE_FAILED\n' });
    expect(await readFile(input.output, 'utf8')).toBe('');
  });

  it.each(['mutation-source', 'mutation-destination', 'mutation-marker'] as const)(
    'executes holdout %s rejection with no output', async (action) => {
    const harness = await instrumentedHoldoutHarness();
    const ordinal = ['mutation-source', 'mutation-destination', 'mutation-marker'].indexOf(action);
    const fixture = await holdoutFailureFixture(10 + ordinal);
    const result = spawnBounded(['--import', 'tsx', harness, action], {
      cwd: ROOT, encoding: 'utf8', env: fixture.environment,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      rejected: true, attempts: 0, uniqueAttempts: 0, acceptedLength: null,
      aggregateResult: null, aggregateInputStable: null, aggregateDecision: null,
      failureReceiptResult: null,
      fstats: 0, readCalls: 0, fixtureCloseAttempts: 0, realImports: 0,
      fixtureForbiddenFileAttempts: 0, fixtureNetworkAttempts: 0,
      fixtureForbiddenLoaderAttempts: 0, negativeControlsCaught: 0, output: '',
      negativeControlsExpected: 0,
      negativeLoaderBlocks: 0, negativeLoaderBlocksExpected: 0,
      negativeNetworkAttempts: 0, negativeNetworkAttemptsExpected: 0,
      intervalCalls: 0, intervalVector: [],
      failureShape: ['Error'], codeGetterCalls: 0,
    });
  });

  it('drains every retained holdout owner once after close failure and emits no output', async () => {
    const harness = await instrumentedHoldoutHarness();
    const fixture = await holdoutFailureFixture(20);
    const result = spawnBounded(['--import', 'tsx', harness, 'close-failure'], {
      cwd: ROOT, encoding: 'utf8', env: fixture.environment,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      rejected: true, attempts: 5, uniqueAttempts: 5, acceptedLength: null,
      aggregateResult: null, aggregateInputStable: null, aggregateDecision: null,
      failureReceiptResult: null,
      fstats: 0, readCalls: 0, fixtureCloseAttempts: 0, realImports: 0,
      fixtureForbiddenFileAttempts: 0, fixtureNetworkAttempts: 0,
      fixtureForbiddenLoaderAttempts: 0, negativeControlsCaught: 0, output: '',
      negativeControlsExpected: 0,
      negativeLoaderBlocks: 0, negativeLoaderBlocksExpected: 0,
      negativeNetworkAttempts: 0, negativeNetworkAttemptsExpected: 0,
      intervalCalls: 0, intervalVector: [],
      failureShape: ['Error'], codeGetterCalls: 0,
    });
  });
});
