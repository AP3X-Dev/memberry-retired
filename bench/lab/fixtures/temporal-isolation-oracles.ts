import type { LabScenarioOracle } from '../contracts/scenario.js';
import { LAB_SCENARIO_VERSION } from '../contracts/scenario.js';

/** Evaluator-only labels. Never import this module from an adapter. */
export const TEMPORAL_ISOLATION_ORACLES: readonly LabScenarioOracle[] = [
  {
    version: LAB_SCENARIO_VERSION,
    scenarioId: 'late-arriving-temporal-update-v1',
    probes: [
      { probeId: 'rate-history', relevant: ['rate-old'], required: ['rate-old'], forbidden: ['rate-current'] },
      { probeId: 'rate-current', relevant: ['rate-current'], required: ['rate-current'], stale: ['rate-old'] },
    ],
  },
  {
    version: LAB_SCENARIO_VERSION,
    scenarioId: 'explicit-stale-suppression-v1',
    probes: [{ probeId: 'current-test-command', relevant: ['test-vitest-current'], required: ['test-vitest-current'], stale: ['test-jest-old'] }],
  },
  {
    version: LAB_SCENARIO_VERSION,
    scenarioId: 'project-isolation-v1',
    probes: [{ probeId: 'api-deployment', relevant: ['api-deploy'], required: ['api-deploy'], forbidden: ['web-deploy'] }],
  },
  {
    version: LAB_SCENARIO_VERSION,
    scenarioId: 'tenant-isolation-v1',
    probes: [{ probeId: 'alpha-database-location', relevant: ['alpha-database'], required: ['alpha-database'], forbidden: ['beta-database'] }],
  },
] as const;
