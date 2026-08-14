import type { AdapterCapability, QueryRequest, QueryResponse } from '../contracts/adapter.js';
import { InMemoryAdapter, inRequestedScope, isCurrent, namespaceKey } from './in-memory.js';
import { rankProxyCandidates } from './proxy-ranking.js';

/** Fast candidate proxy. Never use its results as evidence about the live stack. */
export class MemBerryProxyAdapter extends InMemoryAdapter {
  readonly id: string = 'memberry-proxy-v1';
  readonly displayName: string = 'MemBerry proxy candidate';
  readonly executionMode = 'proxy' as const;
  readonly capabilities: ReadonlySet<AdapterCapability> = new Set([
    'namespaces', 'feedback', 'stats', 'cleanup', 'project-scope', 'tenant-scope', 'temporal-filtering',
  ]);

  async query(request: QueryRequest): Promise<QueryResponse> {
    this.queryCount += 1;
    const memories = (this.stores.get(namespaceKey(request.namespace)) ?? [])
      .filter((memory) => inRequestedScope(memory, request.namespace) && isCurrent(memory, request.asOf));
    return {
      results: rankProxyCandidates(request.query, memories).slice(0, request.limit).map(({ memory, score }) => ({ id: memory.id, score })),
    };
  }
}
