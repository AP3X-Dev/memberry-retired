import type { AdapterCapability, LabMemory } from './adapter.js';

export const LAB_SCENARIO_VERSION = '1.0.0' as const;

export type ScenarioDimension =
  | 'recall'
  | 'precision'
  | 'ranking'
  | 'temporal'
  | 'stale-safety'
  | 'project-isolation'
  | 'tenant-isolation';

export type LabScenarioSplit = 'dev' | 'holdout';

/** Adapter-visible query input. It intentionally contains no relevance judgments. */
export interface LabQueryInput {
  id: string;
  query: string;
  limit: number;
  asOf?: string;
  tokenBudget?: number;
}

/** Evaluator-only ground truth. Adapters must never receive this structure. */
export interface LabProbeOracle {
  probeId: string;
  relevant: readonly string[];
  required?: readonly string[];
  stale?: readonly string[];
  forbidden?: readonly string[];
}

export interface LabScenarioInput {
  version: typeof LAB_SCENARIO_VERSION;
  id: string;
  split: LabScenarioSplit;
  title: string;
  description: string;
  dimensions: readonly ScenarioDimension[];
  requiredCapabilities?: readonly AdapterCapability[];
  tenant: string;
  project: string;
  memories: readonly LabMemory[];
  queries: readonly LabQueryInput[];
  tags?: readonly string[];
}

export interface LabScenarioOracle {
  version: typeof LAB_SCENARIO_VERSION;
  scenarioId: string;
  probes: readonly LabProbeOracle[];
}

export interface LabScenario {
  input: LabScenarioInput;
  oracle: LabScenarioOracle;
}

export function validateScenario(scenario: LabScenario): string[] {
  const errors: string[] = [];
  const { input, oracle } = scenario;
  const memoryIds = new Set<string>();
  if (input.version !== LAB_SCENARIO_VERSION || oracle.version !== LAB_SCENARIO_VERSION) errors.push('unsupported scenario version');
  if (!input.id.trim()) errors.push('scenario id is required');
  if (oracle.scenarioId !== input.id) errors.push('oracle scenario id does not match input');
  if (!input.queries.length) errors.push('scenario must contain at least one query');
  if (input.queries.length !== oracle.probes.length) errors.push('every query must have exactly one oracle');
  for (const memory of input.memories) {
    if (memoryIds.has(memory.id)) errors.push(`duplicate memory id: ${memory.id}`);
    memoryIds.add(memory.id);
  }
  const oracles = new Map(oracle.probes.map((probe) => [probe.probeId, probe]));
  for (const query of input.queries) {
    if (query.limit < 1 || !Number.isInteger(query.limit)) errors.push(`${query.id}: limit must be a positive integer`);
    const probe = oracles.get(query.id);
    if (!probe) { errors.push(`${query.id}: missing oracle`); continue; }
    if (!probe.relevant.length) errors.push(`${query.id}: relevant must not be empty`);
    for (const id of [...probe.relevant, ...(probe.required ?? []), ...(probe.stale ?? []), ...(probe.forbidden ?? [])]) {
      if (!memoryIds.has(id)) errors.push(`${query.id}: unknown fixture id ${id}`);
    }
  }
  return errors;
}
