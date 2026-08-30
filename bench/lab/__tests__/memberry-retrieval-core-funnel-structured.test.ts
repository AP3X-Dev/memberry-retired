import { describe, expect, it } from 'vitest';
import {
  MemBerryRetrievalCoreFunnelStructuredAdapter,
  plannerTargetStandIn,
} from '../adapters/memberry-retrieval-core-funnel-structured.js';
import type { LabMemory, LabNamespace } from '../contracts/adapter.js';

const namespace: LabNamespace = { runId: 'idx001a-structured-test', tenant: 'alpha', project: 'api' };

describe('IDX-001A structured funnel lab arm', () => {
  it('uses one planner-target stand-in instead of every title-cased query token', () => {
    expect(plannerTargetStandIn('Report the cold aisle behind accession packet Alderbasalt.'))
      .toBe('Alderbasalt');
  });

  it('cannot insert a bridge that is ineligible at the requested historical time', async () => {
    const memories: LabMemory[] = [
      {
        id: 'seed', content: 'Asset Target Asset Target is linked to Bridge.',
        recordedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'expired-bridge', content: 'Bridge leads to Answer.',
        recordedAt: '2026-01-01T00:00:00.000Z', invalidatedAt: '2026-02-01T00:00:00.000Z',
      },
      ...Array.from({ length: 12 }, (_, index): LabMemory => ({
        id: `distractor-${index}`, content: `Asset Target unrelated filler ${index}.`,
        recordedAt: '2026-01-01T00:00:00.000Z',
      })),
    ];
    const adapter = new MemBerryRetrievalCoreFunnelStructuredAdapter();
    await adapter.ingest({ namespace, memories });
    const result = await adapter.query({
      namespace, query: 'Find Asset Target', limit: 10, asOf: '2026-03-01T00:00:00.000Z',
    });
    expect(result.results.map(({ id }) => id)).not.toContain('expired-bridge');
  });
});
