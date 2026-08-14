import type { LabScenarioOracle } from '../contracts/scenario.js';
import { LAB_SCENARIO_VERSION } from '../contracts/scenario.js';

/** Evaluator-only labels for retrieval-inputs.ts. */
export const RETRIEVAL_ORACLES: readonly LabScenarioOracle[] = [
  {
    version: LAB_SCENARIO_VERSION,
    scenarioId: 'project-fact-recall-v2',
    probes: [
      { probeId: 'r-package-manager', relevant: ['r-pnpm'] },
      { probeId: 'r-api-routes', relevant: ['r-routes'] },
      { probeId: 'r-integration', relevant: ['r-docker'] },
    ],
  },
  {
    version: LAB_SCENARIO_VERSION,
    scenarioId: 'precision-under-distractors-v2',
    probes: [{ probeId: 'p-auth-query', relevant: ['p-auth', 'p-login'], required: ['p-auth', 'p-login'] }],
  },
  {
    version: LAB_SCENARIO_VERSION,
    scenarioId: 'conflict-resolution-v2',
    probes: [
      { probeId: 'c-test-runner', relevant: ['c-vitest'], required: ['c-vitest'], stale: ['c-jest-old'] },
      { probeId: 'c-deploy', relevant: ['c-pnpm'], required: ['c-pnpm'], stale: ['c-npm-old'] },
    ],
  },
  {
    version: LAB_SCENARIO_VERSION,
    scenarioId: 'stale-resistance-v2',
    probes: [
      { probeId: 's-database', relevant: ['s-cur-db'], required: ['s-cur-db'], stale: ['s-old-db', 's-old-db2'] },
      { probeId: 's-queue', relevant: ['s-cur-queue'], required: ['s-cur-queue'], stale: ['s-old-queue'] },
    ],
  },
  {
    version: LAB_SCENARIO_VERSION,
    scenarioId: 'knowledge-update-v2',
    probes: [
      { probeId: 'i-rate', relevant: ['i-rl-new'], required: ['i-rl-new'], stale: ['i-rl-old'] },
      { probeId: 'i-node', relevant: ['i-node-new'], required: ['i-node-new'], stale: ['i-node-old'] },
    ],
  },
  {
    version: LAB_SCENARIO_VERSION,
    scenarioId: 'multi-hop-recall-v2',
    probes: [{ probeId: 'm-session', relevant: ['m-token', 'm-expiry'], required: ['m-token', 'm-expiry'] }],
  },
  {
    version: LAB_SCENARIO_VERSION,
    scenarioId: 'cross-project-isolation-v2',
    probes: [
      { probeId: 'x-api-auth-query', relevant: ['x-api-auth'], required: ['x-api-auth'], forbidden: ['x-web-auth'] },
      { probeId: 'x-api-deploy-query', relevant: ['x-api-deploy'], required: ['x-api-deploy'], forbidden: ['x-web-deploy'] },
    ],
  },
] as const;
