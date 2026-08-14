import type { LabScenario } from '../contracts/scenario.js';
import { RETRIEVAL_INPUTS } from './retrieval-inputs.js';
import { RETRIEVAL_ORACLES } from './retrieval-oracles.js';

const oracles = new Map(RETRIEVAL_ORACLES.map((oracle) => [oracle.scenarioId, oracle]));

export const RETRIEVAL_SCENARIOS: readonly LabScenario[] = RETRIEVAL_INPUTS.map((input) => {
  const oracle = oracles.get(input.id);
  if (!oracle) throw new Error(`missing evaluator oracle for ${input.id}`);
  return { input, oracle };
});

if (oracles.size !== RETRIEVAL_INPUTS.length) {
  throw new Error('retrieval inputs and oracles must have a one-to-one mapping');
}
