export const LAB_CONTRACT_VERSION = '1.0.0' as const;

export type AdapterCapability =
  | 'namespaces'
  | 'project-scope'
  | 'tenant-scope'
  | 'temporal-filtering'
  | 'feedback'
  | 'stats'
  | 'cleanup';

// Capabilities declare which benchmark inputs an adapter can execute faithfully.
// They are routing metadata, not proof that the adapter passes that dimension.

export interface LabNamespace {
  /** Unique to one benchmark run. Adapters must never read outside this value. */
  runId: string;
  tenant: string;
  project: string;
}

export interface LabMemory {
  id: string;
  content: string;
  kind?: 'fact' | 'decision' | 'instruction' | 'pattern' | 'code' | 'other';
  tenant?: string;
  project?: string;
  /** When the assertion became true in the modeled world. */
  validFrom?: string;
  /** When the assertion stopped being true in the modeled world. */
  validTo?: string;
  /** When the memory system learned the assertion. */
  recordedAt: string;
  invalidatedAt?: string;
  confidence?: number;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface IngestRequest {
  namespace: LabNamespace;
  memories: readonly LabMemory[];
}

export interface IngestResult {
  accepted: number;
  rejected: readonly { id: string; reason: string }[];
  durationMs?: number;
}

export interface QueryRequest {
  namespace: LabNamespace;
  query: string;
  limit: number;
  /** Evaluate the world as it was at this time. Omit for current truth. */
  asOf?: string;
  tokenBudget?: number;
}

export interface LabQueryResult {
  id: string;
  score: number;
  content?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface QueryResponse {
  results: readonly LabQueryResult[];
  durationMs?: number;
  traceId?: string;
}

export interface FeedbackRequest {
  namespace: LabNamespace;
  query: string;
  resultId: string;
  signal: 'helpful' | 'misleading' | 'irrelevant';
}

export interface AdapterHealth {
  status: 'ready' | 'degraded' | 'unavailable';
  details?: Readonly<Record<string, unknown>>;
}

export interface AdapterStats {
  memories: number;
  queries: number;
  feedbackEvents: number;
  details?: Readonly<Record<string, unknown>>;
}

export interface CleanupResult {
  deleted: number;
}

/**
 * Versioned contract shared by fixture, live, and third-party memory adapters.
 * Optional behavior is always declared through capabilities, never inferred.
 */
export interface LabAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly executionMode: 'proxy' | 'fixture' | 'live';
  readonly contractVersion: typeof LAB_CONTRACT_VERSION;
  readonly capabilities: ReadonlySet<AdapterCapability>;
  health(): Promise<AdapterHealth>;
  ingest(request: IngestRequest): Promise<IngestResult>;
  query(request: QueryRequest): Promise<QueryResponse>;
  feedback(request: FeedbackRequest): Promise<void>;
  stats(namespace: LabNamespace): Promise<AdapterStats>;
  cleanup(namespace: LabNamespace): Promise<CleanupResult>;
}

export function missingCapabilities(
  adapter: LabAdapter,
  required: Iterable<AdapterCapability>,
): AdapterCapability[] {
  return [...required].filter((capability) => !adapter.capabilities.has(capability));
}
