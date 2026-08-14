import type {
  AdapterCapability,
  AdapterHealth,
  AdapterStats,
  CleanupResult,
  FeedbackRequest,
  IngestRequest,
  IngestResult,
  LabAdapter,
  LabMemory,
  LabNamespace,
  QueryRequest,
  QueryResponse,
} from '../contracts/adapter.js';
import { LAB_CONTRACT_VERSION } from '../contracts/adapter.js';

export function namespaceKey(namespace: LabNamespace): string {
  return `${namespace.runId}\u0000${namespace.tenant}\u0000${namespace.project}`;
}

export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

export function inRequestedScope(memory: LabMemory, namespace: LabNamespace): boolean {
  return (memory.tenant === undefined || memory.tenant === namespace.tenant)
    && (memory.project === undefined || memory.project === namespace.project);
}

export function isCurrent(memory: LabMemory, asOf?: string): boolean {
  if (!asOf) return memory.validTo === undefined && memory.invalidatedAt === undefined;
  const point = asOf ? Date.parse(asOf) : Number.POSITIVE_INFINITY;
  const validFrom = memory.validFrom ? Date.parse(memory.validFrom) : Number.NEGATIVE_INFINITY;
  const validTo = memory.validTo ? Date.parse(memory.validTo) : Number.POSITIVE_INFINITY;
  const invalidated = memory.invalidatedAt ? Date.parse(memory.invalidatedAt) : Number.POSITIVE_INFINITY;
  return validFrom <= point && point < validTo && point < invalidated;
}

export abstract class InMemoryAdapter implements LabAdapter {
  abstract readonly id: string;
  abstract readonly displayName: string;
  abstract readonly executionMode: 'proxy' | 'fixture';
  readonly contractVersion = LAB_CONTRACT_VERSION;
  abstract readonly capabilities: ReadonlySet<AdapterCapability>;
  protected readonly stores = new Map<string, LabMemory[]>();
  protected queryCount = 0;
  protected feedbackCount = 0;

  async health(): Promise<AdapterHealth> { return { status: 'ready' }; }

  async ingest(request: IngestRequest): Promise<IngestResult> {
    const seen = new Set<string>();
    const accepted: LabMemory[] = [];
    const rejected: { id: string; reason: string }[] = [];
    for (const memory of request.memories) {
      if (!memory.id.trim() || !memory.content.trim()) rejected.push({ id: memory.id, reason: 'id and content are required' });
      else if (seen.has(memory.id)) rejected.push({ id: memory.id, reason: 'duplicate id in request' });
      else { seen.add(memory.id); accepted.push({ ...memory }); }
    }
    this.stores.set(namespaceKey(request.namespace), accepted);
    return { accepted: accepted.length, rejected };
  }

  abstract query(request: QueryRequest): Promise<QueryResponse>;

  async feedback(_request: FeedbackRequest): Promise<void> { this.feedbackCount += 1; }

  async stats(namespace: LabNamespace): Promise<AdapterStats> {
    return {
      memories: this.stores.get(namespaceKey(namespace))?.length ?? 0,
      queries: this.queryCount,
      feedbackEvents: this.feedbackCount,
    };
  }

  async cleanup(namespace: LabNamespace): Promise<CleanupResult> {
    const key = namespaceKey(namespace);
    const deleted = this.stores.get(key)?.length ?? 0;
    this.stores.delete(key);
    return { deleted };
  }
}
