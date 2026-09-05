// packages/core/src/lifecycle-pass.ts
//
// The ONE MEM-006/006H/007 pass implementation, shared by the CLI `lifecycle`
// verb and the in-process MCP scheduler (item 13a). Extracted verbatim from
// cli.ts `runLifecycle`; the caller owns the flag gate, the CoreServices
// lifetime and any printing. Construction order is load-bearing: hebbian
// drains the feedback ring BEFORE the lifecycle pass so tonight's usage
// protects tonight's plan; anti-entropy rides AFTER it.

import { LifecycleStore } from '@memberry/neo4j';
import { ProposalStore, EpisodicBuffer } from '@memberry/redis';
import type { CoreServices } from './services-factory.js';
import { defaultExportPath } from './config/settings.js';
import { LifecycleEngine, type LifecycleRunResult } from './lifecycle.js';
import { AntiEntropyEngine, type AntiEntropyRunResult } from './anti-entropy.js';
import { HebbianEngine, type HebbianRunResult } from './hebbian.js';
import {
  resolveAntiEntropyConfig,
  resolveHebbianConfig,
  resolveLifecycleConfig,
  type LifecycleConfig,
} from './config/lifecycle.js';

export interface LifecyclePassOptions {
  /** Resolved MEM-006 config; defaults to `resolveLifecycleConfig(defaultExportPath())`. */
  config?: LifecycleConfig;
  scope?: string;
  dryRun?: boolean;
}

/** Exactly the object the CLI prints: the lifecycle result plus optional sub-pass sections. */
export type LifecyclePassResult = LifecycleRunResult & {
  hebbian?: HebbianRunResult;
  anti_entropy?: AntiEntropyRunResult;
};

export async function runLifecyclePass(
  core: CoreServices,
  options: LifecyclePassOptions = {},
): Promise<LifecyclePassResult> {
  const config = options.config ?? resolveLifecycleConfig(defaultExportPath());
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
      ...(options.dryRun === true ? { dryRun: true } : {}),
    });
  }

  const engine = new LifecycleEngine({
    store,
    proposals: new ProposalStore(core.redis),
    config,
    ...(hebbianConfig.mode === 'live' ? { hebbian: hebbianConfig } : {}),
  });
  const result = await engine.run({
    ...(typeof options.scope === 'string' ? { scope: options.scope } : {}),
    ...(options.dryRun === true ? { dryRun: true } : {}),
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
      ...(options.dryRun === true ? { dryRun: true } : {}),
    });
  }

  return {
    ...result,
    ...(hebbianResult ? { hebbian: hebbianResult } : {}),
    ...(antiEntropyResult ? { anti_entropy: antiEntropyResult } : {}),
  };
}
