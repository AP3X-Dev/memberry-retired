import type { AdapterCapability, LabMemory, QueryRequest, QueryResponse } from '../contracts/adapter.js';
import { InMemoryAdapter, inRequestedScope, isCurrent, namespaceKey, tokenize } from './in-memory.js';

interface RankedMemory { memory: LabMemory; score: number }

export function bm25(query: string, memories: readonly LabMemory[]): RankedMemory[] {
  const k1 = 1.2;
  const b = 0.75;
  const queryTokens = new Set(tokenize(query));
  const documentTokens = memories.map((memory) => tokenize(memory.content));
  const averageLength = documentTokens.reduce((sum, tokens) => sum + tokens.length, 0) / (documentTokens.length || 1);
  const documentFrequency = new Map<string, number>();
  for (const tokens of documentTokens) {
    for (const token of new Set(tokens)) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
  }
  const ranked = memories.map((memory, index) => {
    const frequencies = new Map<string, number>();
    for (const token of documentTokens[index]) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    let score = 0;
    for (const token of queryTokens) {
      const frequency = frequencies.get(token) ?? 0;
      if (!frequency) continue;
      const df = documentFrequency.get(token) ?? 0;
      const idf = Math.log(1 + (memories.length - df + 0.5) / (df + 0.5));
      const normalizedLength = documentTokens[index].length / (averageLength || 1);
      score += idf * ((frequency * (k1 + 1)) / (frequency + k1 * (1 - b + b * normalizedLength)));
    }
    return { memory, score };
  });
  return ranked.filter(({ score }) => score > 0).sort((left, right) => right.score - left.score || right.memory.recordedAt.localeCompare(left.memory.recordedAt));
}

const commonCapabilities: ReadonlySet<AdapterCapability> = new Set(['namespaces', 'feedback', 'stats', 'cleanup']);

/** Lexical baseline, intentionally unaware of tenant, project, or temporal validity. */
export class Bm25BaselineAdapter extends InMemoryAdapter {
  readonly id = 'bm25-baseline-v1';
  readonly displayName = 'BM25 baseline';
  readonly executionMode = 'fixture' as const;
  readonly capabilities = commonCapabilities;

  async query(request: QueryRequest): Promise<QueryResponse> {
    this.queryCount += 1;
    const memories = this.stores.get(namespaceKey(request.namespace)) ?? [];
    return { results: bm25(request.query, memories).slice(0, request.limit).map(({ memory, score }) => ({ id: memory.id, score })) };
  }
}

/** Recency strawman, useful for detecting scenarios that do not require semantic retrieval. */
export class RecencyBaselineAdapter extends InMemoryAdapter {
  readonly id = 'recency-baseline-v1';
  readonly displayName = 'Recency baseline';
  readonly executionMode = 'fixture' as const;
  readonly capabilities = commonCapabilities;

  async query(request: QueryRequest): Promise<QueryResponse> {
    this.queryCount += 1;
    const memories = [...(this.stores.get(namespaceKey(request.namespace)) ?? [])];
    memories.sort((left, right) => right.recordedAt.localeCompare(left.recordedAt));
    return { results: memories.slice(0, request.limit).map((memory, index) => ({ id: memory.id, score: 1 - index / request.limit })) };
  }
}

/** Frozen fair control: BM25 with the same declared scope and temporal inputs as a candidate. */
export class ScopeAwareBm25ControlAdapter extends InMemoryAdapter {
  readonly id: string = 'scope-aware-bm25-control-v1';
  readonly displayName: string = 'Scope-aware BM25 control';
  readonly executionMode = 'fixture' as const;
  readonly capabilities: ReadonlySet<AdapterCapability> = new Set([
    ...commonCapabilities, 'project-scope', 'tenant-scope', 'temporal-filtering',
  ]);

  async query(request: QueryRequest): Promise<QueryResponse> {
    this.queryCount += 1;
    const memories = (this.stores.get(namespaceKey(request.namespace)) ?? [])
      .filter((memory) => inRequestedScope(memory, request.namespace) && isCurrent(memory, request.asOf));
    return { results: bm25(request.query, memories).slice(0, request.limit).map(({ memory, score }) => ({ id: memory.id, score })) };
  }
}

/**
 * Fast, deterministic proxy for MemBerry behavior. It is deliberately named proxy:
 * this adapter is a CI inner loop, not evidence about the live MCP/database stack.
 */
