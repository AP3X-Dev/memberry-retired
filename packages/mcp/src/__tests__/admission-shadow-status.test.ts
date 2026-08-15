import { describe, expect, it } from 'vitest';

import {
  getAdmissionShadowProcessStatus,
  registerAdmissionShadowStatusSource,
  registerAdmissionShadowStatusSources,
} from '../admission-shadow-status.js';

function source(overrides: Record<string, unknown> = {}) {
  return {
    snapshot: () => ({
      schemaVersion: 1,
      enabled: true,
      mode: 'shadow',
      health: 'healthy',
      delivery: 'best-effort-bounded-terminal',
      recovery: 'none',
      completeness: 'not-provable',
      durableRetry: false,
      selfHealing: false,
      historyComplete: false,
      historyScope: 'process-lifetime',
      crashGapPossible: true,
      stopping: false,
      timeoutMs: 50,
      maxInFlight: 32,
      reserved: 0,
      inFlight: 0,
      prepared: 1,
      preparationFailures: 0,
      appendAttempts: 1,
      appended: 1,
      appendFailures: 0,
      timedOut: 0,
      capacityRejected: 0,
      shutdownSkipped: 0,
      lateAppended: 0,
      lateFailures: 0,
      lastFailureCode: null,
      ...overrides,
    }),
  };
}

describe('admission shadow process readiness status', () => {
  it('is disabled with no registered runtime', () => {
    expect(getAdmissionShadowProcessStatus()).toMatchObject({
      enabled: false,
      health: 'disabled',
      affects_readiness: false,
      registered_runtimes: 0,
    });
  });

  it('aggregates only coarse process-lifetime counters and unregisters cleanly', () => {
    const secret = 'tenant/project/episode-secret-canary';
    const unregisterA = registerAdmissionShadowStatusSource(source({ lastFailureCode: secret }));
    const unregisterB = registerAdmissionShadowStatusSource(source({
      health: 'degraded',
      timedOut: 2,
      appendFailures: 1,
      inFlight: 3,
      lastFailureCode: 'append_failed',
      ignored: secret,
    }));
    try {
      const status = getAdmissionShadowProcessStatus();
      expect(status).toMatchObject({
        enabled: true,
        health: 'degraded',
        affects_readiness: false,
        completeness: 'not-provable',
        durable_retry: false,
        self_healing: false,
        history_complete: false,
        history_scope: 'process-lifetime',
        crash_gap_possible: true,
        stopping: false,
        last_failure_code: 'append_failed',
        registered_runtimes: 2,
        timeout_ms: [50],
        max_in_flight: 64,
        counters: { appended: 2, append_failures: 1, timed_out: 2, in_flight: 3 },
      });
      expect(JSON.stringify(status)).not.toContain(secret);
    } finally {
      unregisterB();
      unregisterA();
    }
    expect(getAdmissionShadowProcessStatus().registered_runtimes).toBe(0);
  });

  it('reports deterministic aggregate limits for differently configured runtimes', () => {
    const unregister = registerAdmissionShadowStatusSources([
      source({ timeoutMs: 75, maxInFlight: 16 }),
      source({ timeoutMs: 25, maxInFlight: 8 }),
      source({ timeoutMs: 75, maxInFlight: 4 }),
    ]);
    try {
      expect(getAdmissionShadowProcessStatus()).toMatchObject({
        registered_runtimes: 3,
        timeout_ms: [25, 75],
        max_in_flight: 28,
      });
    } finally {
      unregister();
    }
  });

  it('rolls back a failed default/dedicated batch and permits a clean retry', () => {
    const retained = registerAdmissionShadowStatusSource(source({ appended: 9 }));
    const defaultRuntime = source({ timeoutMs: 25 });
    const dedicatedRuntime = source({ timeoutMs: 75 });
    try {
      expect(() => registerAdmissionShadowStatusSources([
        defaultRuntime,
        null as never,
        dedicatedRuntime,
      ])).toThrow('admission_shadow_status:invalid_source');
      expect(getAdmissionShadowProcessStatus()).toMatchObject({
        registered_runtimes: 1,
        counters: { appended: 9 },
      });

      const unregisterRetry = registerAdmissionShadowStatusSources([defaultRuntime, dedicatedRuntime]);
      try {
        expect(getAdmissionShadowProcessStatus()).toMatchObject({
          registered_runtimes: 3,
          timeout_ms: [25, 50, 75],
        });
      } finally {
        unregisterRetry();
      }
      expect(getAdmissionShadowProcessStatus().registered_runtimes).toBe(1);
    } finally {
      retained();
    }
  });

  it('contains hostile status proxies and never reflects their canary', () => {
    const canary = 'status-proxy-secret-canary';
    const unregister = registerAdmissionShadowStatusSource({
      snapshot: () => new Proxy({} as never, {
        get() { throw new Error(canary); },
      }),
    });
    try {
      const status = getAdmissionShadowProcessStatus();
      expect(status).toMatchObject({ registered_runtimes: 0, enabled: false });
      expect(JSON.stringify(status)).not.toContain(canary);
    } finally {
      unregister();
    }
  });
});
