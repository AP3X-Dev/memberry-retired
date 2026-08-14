import type { LabScenario } from '../contracts/scenario.js';
import { TEMPORAL_ISOLATION_INPUTS } from './temporal-isolation-inputs.js';
import { TEMPORAL_ISOLATION_ORACLES } from './temporal-isolation-oracles.js';

const oracles = new Map(TEMPORAL_ISOLATION_ORACLES.map((oracle) => [oracle.scenarioId, oracle]));

export const TEMPORAL_ISOLATION_SCENARIOS: readonly LabScenario[] = TEMPORAL_ISOLATION_INPUTS.map((input) => {
  const oracle = oracles.get(input.id);
  if (!oracle) throw new Error(`missing evaluator oracle for ${input.id}`);
  return { input, oracle };
});

if (oracles.size !== TEMPORAL_ISOLATION_INPUTS.length) {
  throw new Error('temporal/isolation inputs and oracles must have a one-to-one mapping');
}
