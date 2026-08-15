import { describe, expect, it, vi } from 'vitest';

import {
  ADMISSION_SHADOW_DEFAULT_TIMEOUT_MS,
  ADMISSION_SHADOW_MAX_IN_FLIGHT,
  AdmissionShadowConfigError,
  AdmissionShadowRuntime,
  resolveAdmissionShadowConfig,
  type AdmissionObservationSink,
} from '../admission-shadow.js';

const scope = {
  tenantId: 'tenant-test',
  projectScope: 'project:test',
  episodeId: 'episode-test',
} as const;

const trustedInput = (content = 'ordinary durable decision') => ({
  captureState: 'accepted-nonduplicate' as const,
  task: 'remember the decision',
  content,
  tags: ['project:test'],
  scope: 'project:test',
  tenantId: 'tenant-test',
  redactionConfigured: true,
  memoryType: 'decision' as const,
  outcome: 'approved' as const,
  hasSignals: false,
  hasEntities: false,
  hasModel: false,
});

function runtime(
  sink: AdmissionObservationSink,
  timeoutMs = ADMISSION_SHADOW_DEFAULT_TIMEOUT_MS,
): AdmissionShadowRuntime {
  return new AdmissionShadowRuntime({
    enabled: true,
    timeoutMs,
    sink,
    clock: { now: () => new Date('2026-08-14T18:00:00.000Z') },
  });
}

describe('AdmissionShadowRuntime', () => {
  it('is inert by default and rejects malformed explicit configuration', () => {
    expect(resolveAdmissionShadowConfig({})).toEqual({ enabled: false, timeoutMs: 50 });
    expect(resolveAdmissionShadowConfig({ MEMBERRY_ADMISSION_SHADOW_ENABLED: 'true' }))
      .toEqual({ enabled: true, timeoutMs: 50 });
    expect(resolveAdmissionShadowConfig({
      MEMBERRY_ADMISSION_SHADOW_ENABLED: 'false',
      MEMBERRY_ADMISSION_SHADOW_TIMEOUT_MS: '25',
    })).toEqual({ enabled: false, timeoutMs: 25 });

    for (const env of [
      { MEMBERRY_ADMISSION_SHADOW_ENABLED: 'yes' },
      { MEMBERRY_ADMISSION_SHADOW_TIMEOUT_MS: '0' },
      { MEMBERRY_ADMISSION_SHADOW_TIMEOUT_MS: '1001' },
      { MEMBERRY_ADMISSION_SHADOW_TIMEOUT_MS: '2.5' },
    ]) {
      expect(() => resolveAdmissionShadowConfig(env)).toThrowError(AdmissionShadowConfigError);
    }
  });

  it('passes only content-free baseline observations to the structural sink', async () => {
    const secret = ['sk', 'abcdEFGH1234567890'].join('-');
    const sink = { persist: vi.fn(async (_scope, observation) => observation) };
    const shadow = runtime(sink);
    const attempt = shadow.begin()!;
    const observation = attempt.prepare(trustedInput(`deploy token ${secret}`));

    expect(observation?.safeFacts.sensitivity).toBe('detected');
    expect(observation?.recommendation).toMatchObject({
      recommendedTier: 'episodic',
      wouldChangeBaseline: false,
    });
    expect(JSON.stringify(observation)).not.toContain(secret);

    await attempt.append(scope, observation!);
    expect(sink.persist).toHaveBeenCalledOnce();
    expect(JSON.stringify(sink.persist.mock.calls[0])).not.toContain(secret);
    expect(JSON.stringify(shadow.snapshot())).not.toContain(secret);
    expect(shadow.snapshot()).toMatchObject({ appended: 1, appendFailures: 0, health: 'healthy' });
  });

  it('contains hostile preparation and sink proxies without exposing values', async () => {
    const canary = 'proxy-secret-canary';
    const throwingInput = new Proxy(trustedInput(canary), {
      ownKeys() { throw new Error(canary); },
    });
    const sink = new Proxy({} as AdmissionObservationSink, {
      get() { throw new Error(canary); },
    });
    const shadow = runtime(sink);

    expect(shadow.begin()!.prepare(throwingInput)).toBeNull();
    const hostileAttempt = shadow.begin()!;
    const observation = hostileAttempt.prepare(trustedInput());
    await expect(hostileAttempt.append(scope, observation!)).resolves.toBe('failed');
    expect(JSON.stringify(shadow.snapshot())).not.toContain(canary);
    expect(shadow.snapshot()).toMatchObject({ preparationFailures: 1, appendFailures: 1 });
  });

  it('bounds the caller wait, handles late settlement, and never retries', async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise((done) => { resolve = done; });
    const sink = { persist: vi.fn(() => pending as Promise<never>) };
    const shadow = runtime(sink, 1);
    const attempt = shadow.begin()!;
    const observation = attempt.prepare(trustedInput())!;

    await expect(attempt.append(scope, observation)).resolves.toBe('timed-out');
    expect(sink.persist).toHaveBeenCalledOnce();
    expect(shadow.snapshot()).toMatchObject({ timedOut: 1, inFlight: 1, appended: 0 });

    resolve(observation);
    await pending;
    await new Promise((done) => setTimeout(done, 0));
    expect(shadow.snapshot()).toMatchObject({ inFlight: 0, lateAppended: 1, timedOut: 1 });
    expect(sink.persist).toHaveBeenCalledOnce();
  });

  it('caps unresolved writes at exactly 32 and drains for no more than the requested bound', async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise((done) => { resolve = done; });
    const sink = { persist: vi.fn(() => pending as Promise<never>) };
    const shadow = runtime(sink, 1_000);
    const attempts = Array.from({ length: ADMISSION_SHADOW_MAX_IN_FLIGHT }, () => shadow.begin()!);
    const observations = attempts.map((attempt) => attempt.prepare(trustedInput())!);
    const writes = attempts.map((attempt, index) => attempt.append(scope, observations[index]!));

    const hostile = new Proxy({} as never, { get() { throw new Error('capacity-must-not-inspect'); } });
    expect(shadow.begin()).toBeNull();
    expect(() => void hostile).not.toThrow();
    await Promise.resolve();
    expect(sink.persist).toHaveBeenCalledTimes(ADMISSION_SHADOW_MAX_IN_FLIGHT);
    expect(shadow.snapshot()).toMatchObject({
      inFlight: ADMISSION_SHADOW_MAX_IN_FLIGHT,
      capacityRejected: 1,
    });

    const started = Date.now();
    await shadow.stopAndDrain(5);
    expect(Date.now() - started).toBeLessThan(250);

    expect(shadow.begin()).toBeNull();

    resolve(observations[0]);
    await Promise.all(writes);
    expect(shadow.snapshot().inFlight).toBe(0);
  });

  it('disabled runtime never inspects input or calls the sink', async () => {
    const sink = { persist: vi.fn() } as unknown as AdmissionObservationSink;
    const shadow = new AdmissionShadowRuntime({ enabled: false, timeoutMs: 50, sink });
    expect(shadow.begin()).toBeNull();
    expect(sink.persist).not.toHaveBeenCalled();
    expect(shadow.snapshot()).toMatchObject({
      enabled: false,
      health: 'disabled',
      prepared: 0,
      durableRetry: false,
      selfHealing: false,
      historyComplete: false,
      historyScope: 'process-lifetime',
      stopping: false,
      shutdownSkipped: 0,
      lastFailureCode: null,
    });
  });

  it('stops accepting before drain and reports a closed shutdown skip', async () => {
    const sink = { persist: vi.fn(async (_scope, observation) => observation) };
    const shadow = runtime(sink);
    const reserved = shadow.begin()!;
    const observation = reserved.prepare(trustedInput())!;

    await shadow.stopAndDrain(0);
    await expect(reserved.append(scope, observation)).resolves.toBe('shutdown-skipped');
    expect(shadow.begin()).toBeNull();
    expect(sink.persist).not.toHaveBeenCalled();
    expect(shadow.snapshot()).toMatchObject({
      stopping: true,
      shutdownSkipped: 2,
      lastFailureCode: 'shutdown_skipped',
      durableRetry: false,
      selfHealing: false,
      historyComplete: false,
      crashGapPossible: true,
    });
  });

  it('unrefs deadline timers where the runtime provides unref', async () => {
    const unref = vi.fn();
    const timer = { unref } as unknown as ReturnType<typeof setTimeout>;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((() => timer) as typeof setTimeout);
    try {
      const shadow = runtime({ persist: async (_scope, observation) => observation });
      const attempt = shadow.begin()!;
      const observation = attempt.prepare(trustedInput())!;
      await expect(attempt.append(scope, observation)).resolves.toBe('stored');
      expect(unref).toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });
});
