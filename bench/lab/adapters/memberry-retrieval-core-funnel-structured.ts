import type { AdapterCapability, IngestRequest, IngestResult, LabMemory, QueryRequest, QueryResponse } from '../contracts/adapter.js';
import { InMemoryAdapter, isCurrent, namespaceKey } from './in-memory.js';
import { funnelSelect, MemBerryRetrievalCoreFunnelAdapter } from './memberry-retrieval-core-funnel.js';

const NAME = /\b[A-Z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)*\b/g;
const NON_ENTITY = new Set(['A', 'After', 'Give', 'Identify', 'The', 'Then', 'Who', 'Which']);

/** Deterministic stand-in for canonical Entity IDs supplied at write time. */
function mentions(text: string): readonly string[] {
  return [...new Set((text.match(NAME) ?? []).filter((value) => !NON_ENTITY.has(value)))];
}

/** Frozen-dataset stand-in for the query planner's single resolved target. */
export function plannerTargetStandIn(text: string): string | undefined {
  return mentions(text).at(-1);
}

/**
 * IDX-001A lab arm: run the exact frozen control, then use persisted write-time
 * links to insert at most one best lexical neighbour after each top-five seed.
 * The query side never extracts facts or invokes a model; it only follows the
 * static entity incidence index built during ingest.
 */
export class MemBerryRetrievalCoreFunnelStructuredAdapter extends InMemoryAdapter {
  readonly id = 'memberry-retrieval-core-funnel-structured-v1';
  readonly displayName = 'MemBerry production retrieval core (write-time structured links)';
  readonly executionMode = 'fixture' as const;
  readonly capabilities: ReadonlySet<AdapterCapability> = new Set([
    'namespaces', 'feedback', 'stats', 'cleanup', 'project-scope', 'tenant-scope', 'temporal-filtering',
  ]);
  private readonly control = new MemBerryRetrievalCoreFunnelAdapter();

  override async ingest(request: IngestRequest): Promise<IngestResult> {
    const [result] = await Promise.all([super.ingest(request), this.control.ingest(request)]);
    return result;
  }

  override async query(request: QueryRequest): Promise<QueryResponse> {
    this.queryCount += 1;
    const baseline = await this.control.query(request);
    const memories = (this.stores.get(namespaceKey(request.namespace)) ?? [])
      .filter((memory) => memory.kind !== 'code' && isCurrent(memory, request.asOf));
    const byId = new Map(memories.map((memory) => [memory.id, memory]));
    const entityToMemories = new Map<string, LabMemory[]>();
    for (const memory of memories) {
      for (const entity of mentions(memory.content)) {
        const rows = entityToMemories.get(entity) ?? [];
        rows.push(memory);
        entityToMemories.set(entity, rows);
      }
    }
    const queryTarget = plannerTargetStandIn(request.query);
    const lexical = funnelSelect(memories, request.query, memories.length).scores;
    const baselineIds = new Set(baseline.results.map(({ id }) => id));
    const inserted = new Set<string>();
    const output = [] as Array<(typeof baseline.results)[number]>;

    for (let rank = 0; rank < baseline.results.length; rank += 1) {
      const result = baseline.results[rank]!;
      output.push(result);
      if (rank >= 5 || output.length >= request.limit) continue;
      const seed = byId.get(result.id);
      if (!seed) continue;
      const seedEntities = mentions(seed.content);
      if (queryTarget === undefined || !seedEntities.includes(queryTarget)) continue;
      const bridges = seedEntities.filter((entity) => entity !== queryTarget);
      const candidates = bridges.flatMap((bridge) => entityToMemories.get(bridge) ?? [])
        .filter((memory) => memory.id !== seed.id && !baselineIds.has(memory.id) && !inserted.has(memory.id))
        .sort((left, right) => (lexical.get(right.id)! - lexical.get(left.id)!)
          || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
      const best = candidates[0];
      if (!best) continue;
      inserted.add(best.id);
      output.push({ id: best.id, score: lexical.get(best.id) ?? 0, content: best.content });
    }
    return { ...baseline, results: output.slice(0, request.limit) };
  }
}
