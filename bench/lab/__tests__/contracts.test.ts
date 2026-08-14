import { describe, expect, it } from 'vitest';
import { MemBerryProxyAdapter } from '../adapters/memberry-proxy.js';
import { LAB_CONTRACT_VERSION, missingCapabilities } from '../contracts/adapter.js';
import { LAB_SCENARIO_VERSION, validateScenario, type LabScenario } from '../contracts/scenario.js';

describe('evaluation lab contracts', () => {
  it('makes adapter capability gaps explicit', () => {
    const adapter = new MemBerryProxyAdapter();
    expect(adapter.contractVersion).toBe(LAB_CONTRACT_VERSION);
    expect(missingCapabilities(adapter, ['tenant-scope', 'temporal-filtering', 'cleanup'])).toEqual([]);
    expect(missingCapabilities(adapter, ['feedback'])).toEqual([]);
  });

  it('rejects malformed scenarios before an adapter sees them', () => {
    const scenario: LabScenario = {
      input: {
        version: LAB_SCENARIO_VERSION,
        id: 'malformed',
        split: 'dev',
        title: 'Malformed fixture',
        description: 'Exercises validation.',
        dimensions: ['recall'],
        tenant: 'tenant',
        project: 'project',
        memories: [
          { id: 'duplicate', content: 'one', recordedAt: '2026-01-01T00:00:00.000Z' },
          { id: 'duplicate', content: 'two', recordedAt: '2026-01-02T00:00:00.000Z' },
        ],
        queries: [{ id: 'probe', query: 'query', limit: 0 }],
      },
      oracle: {
        version: LAB_SCENARIO_VERSION,
        scenarioId: 'malformed',
        probes: [{ probeId: 'probe', relevant: ['missing'] }],
      },
    };
    expect(validateScenario(scenario)).toEqual(expect.arrayContaining([
      'duplicate memory id: duplicate',
      'probe: limit must be a positive integer',
      'probe: unknown fixture id missing',
    ]));
  });
});
