import { createHash, randomUUID } from 'node:crypto';
import { types as nodeUtilTypes } from 'node:util';

import {
  ADMISSION_CONTRACT_VERSION,
  BASELINE_PARITY_POLICY_ID,
  BASELINE_PARITY_POLICY_VERSION,
  parseAdmissionObservationV1,
  type AdmissionObservationV1,
} from '@memberry/core';
import type { Driver, ManagedTransaction, Session } from 'neo4j-driver';

const OBSERVATION_ID_DOMAIN = 'memberry-admission-observation-v1';
const MAX_IDENTIFIER_LENGTH = 500;
const PROJECT_SCOPE = /^project:[a-z0-9][a-z0-9._-]*$/;

const PROPERTY_KEYS = [
  'id',
  'tenant_id',
  'project_scope',
  'contract_version',
  'capture_state',
  'memory_class',
  'outcome',
  'tenant_scope',
  'safe_project_scope',
  'sensitivity',
  'redaction_configured',
  'has_signals',
  'has_entities',
  'has_model',
  'policy_id',
  'policy_version',
  'recommended_tier',
  'would_change_baseline',
  'reason_code',
  'observed_at',
] as const;

const SUBSTANTIVE_PROPERTY_KEYS = PROPERTY_KEYS.filter((key) => key !== 'observed_at');

export interface AdmissionObservationScopeV1 {
  readonly tenantId: string;
  readonly projectScope: string;
  readonly episodeId: string;
}

export type AdmissionObservationStoreErrorCode =
  | 'invalid_scope'
  | 'invalid_observation'
  | 'observation_scope_unresolved'
  | 'episode_not_found'
  | 'existing_state_mismatch'
  | 'write_incomplete'
  | 'storage_unavailable';

const STORE_ERROR_CODES = new Set<AdmissionObservationStoreErrorCode>([
  'invalid_scope',
  'invalid_observation',
  'observation_scope_unresolved',
  'episode_not_found',
  'existing_state_mismatch',
  'write_incomplete',
  'storage_unavailable',
]);

/** Value-free persistence failures; tenant, project, and episode values never enter messages. */
export class AdmissionObservationStoreError extends Error {
  constructor(readonly code: AdmissionObservationStoreErrorCode) {
    super(`admission_observation_store:${code}`);
    this.name = 'AdmissionObservationStoreError';
  }
}

function isStoreError(value: unknown): value is AdmissionObservationStoreError {
  try {
    return value instanceof AdmissionObservationStoreError;
  } catch {
    return false;
  }
}

function normalizedStoreError(
  value: unknown,
  fallback: AdmissionObservationStoreErrorCode,
): AdmissionObservationStoreError {
  if (isStoreError(value)) {
    try {
      const code = value.code;
      if (STORE_ERROR_CODES.has(code)) {
        // Rebuild instead of returning a potentially message-mutated instance.
        return new AdmissionObservationStoreError(code);
      }
    } catch {
      // Treat a hostile error instance as an ordinary storage/input failure.
    }
  }
  return new AdmissionObservationStoreError(fallback);
}

function strictRecord(value: unknown): Record<PropertyKey, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
      throw new AdmissionObservationStoreError('invalid_scope');
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new AdmissionObservationStoreError('invalid_scope');
    }
    const clone = Object.create(null) as Record<PropertyKey, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
        throw new AdmissionObservationStoreError('invalid_scope');
      }
      clone[key] = descriptor.value;
    }
    return clone;
  } catch (error) {
    throw normalizedStoreError(error, 'invalid_scope');
  }
}

function parseScope(value: AdmissionObservationScopeV1): AdmissionObservationScopeV1 {
  const input = strictRecord(value);
  const keys = Reflect.ownKeys(input);
  if (keys.length !== 3 || !['tenantId', 'projectScope', 'episodeId'].every((key) => Object.hasOwn(input, key))) {
    throw new AdmissionObservationStoreError('invalid_scope');
  }
  if (keys.some((key) => typeof key !== 'string' || !['tenantId', 'projectScope', 'episodeId'].includes(key))) {
    throw new AdmissionObservationStoreError('invalid_scope');
  }
  const tenantId = input.tenantId;
  const projectScope = input.projectScope;
  const episodeId = input.episodeId;
  if (typeof tenantId !== 'string' || tenantId.trim().length === 0 || tenantId.length > MAX_IDENTIFIER_LENGTH
    || typeof projectScope !== 'string' || projectScope.length > MAX_IDENTIFIER_LENGTH || !PROJECT_SCOPE.test(projectScope)
    || typeof episodeId !== 'string' || episodeId.trim().length === 0 || episodeId.length > MAX_IDENTIFIER_LENGTH) {
    throw new AdmissionObservationStoreError('invalid_scope');
  }
  return Object.freeze({ tenantId, projectScope, episodeId });
}

/** Internal only: the full digest is deliberately never returned by the public store API. */
function observationId(scope: AdmissionObservationScopeV1): string {
  const tuple = JSON.stringify([
    OBSERVATION_ID_DOMAIN,
    ADMISSION_CONTRACT_VERSION,
    BASELINE_PARITY_POLICY_ID,
    BASELINE_PARITY_POLICY_VERSION,
    scope.tenantId,
    scope.projectScope,
    scope.episodeId,
  ]);
  return `admission-observation:sha256:${createHash('sha256').update(tuple).digest('hex')}`;
}

function safeObservationId(scope: AdmissionObservationScopeV1): string {
  try {
    return observationId(scope);
  } catch {
    throw new AdmissionObservationStoreError('storage_unavailable');
  }
}

function observationProperties(
  id: string,
  scope: AdmissionObservationScopeV1,
  observation: AdmissionObservationV1,
): Record<string, unknown> {
  const facts = observation.safeFacts;
  const recommendation = observation.recommendation;
  return {
    id,
    tenant_id: scope.tenantId,
    project_scope: scope.projectScope,
    contract_version: observation.contractVersion,
    capture_state: facts.captureState,
    memory_class: facts.memoryClass,
    outcome: facts.outcome,
    tenant_scope: facts.tenantScope,
    safe_project_scope: facts.projectScope,
    sensitivity: facts.sensitivity,
    redaction_configured: facts.redactionConfigured,
    has_signals: facts.hasSignals,
    has_entities: facts.hasEntities,
    has_model: facts.hasModel,
    policy_id: recommendation.policyId,
    policy_version: recommendation.policyVersion,
    recommended_tier: recommendation.recommendedTier,
    would_change_baseline: recommendation.wouldChangeBaseline,
    reason_code: recommendation.reasonCode,
    observed_at: observation.observedAt,
  };
}

function persistedRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AdmissionObservationStoreError('existing_state_mismatch');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== PROPERTY_KEYS.length
    || keys.some((key) => typeof key !== 'string' || !PROPERTY_KEYS.includes(key as (typeof PROPERTY_KEYS)[number]))) {
    throw new AdmissionObservationStoreError('existing_state_mismatch');
  }
  const result: Record<string, unknown> = {};
  for (const key of PROPERTY_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
      throw new AdmissionObservationStoreError('existing_state_mismatch');
    }
    result[key] = descriptor.value;
  }
  return result;
}

function parsePersistedObservation(properties: unknown): AdmissionObservationV1 {
  const value = persistedRecord(properties);
  try {
    return parseAdmissionObservationV1({
      contractVersion: value.contract_version,
      safeFacts: {
        contractVersion: value.contract_version,
        captureState: value.capture_state,
        memoryClass: value.memory_class,
        outcome: value.outcome,
        tenantScope: value.tenant_scope,
        projectScope: value.safe_project_scope,
        sensitivity: value.sensitivity,
        redactionConfigured: value.redaction_configured,
        hasSignals: value.has_signals,
        hasEntities: value.has_entities,
        hasModel: value.has_model,
      },
      recommendation: {
        contractVersion: value.contract_version,
        policyId: value.policy_id,
        policyVersion: value.policy_version,
        recommendedTier: value.recommended_tier,
        wouldChangeBaseline: value.would_change_baseline,
        reasonCode: value.reason_code,
      },
      observedAt: value.observed_at,
    });
  } catch {
    throw new AdmissionObservationStoreError('existing_state_mismatch');
  }
}

function substantivePropertiesMatch(actual: unknown, expected: Record<string, unknown>): boolean {
  let parsed: Record<string, unknown>;
  try {
    parsed = persistedRecord(actual);
    parsePersistedObservation(parsed);
  } catch {
    return false;
  }
  return SUBSTANTIVE_PROPERTY_KEYS.every((key) => Object.is(parsed[key], expected[key]));
}

function integerValue(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'object' && value !== null && 'toNumber' in value
    && typeof (value as { toNumber?: unknown }).toNumber === 'function') {
    return (value as { toNumber(): number }).toNumber();
  }
  return Number.NaN;
}

function closedStorageError(error: unknown): AdmissionObservationStoreError {
  return normalizedStoreError(error, 'storage_unavailable');
}

/**
 * Shadow-only MEM-001B sidecar store. `AdmissionObservation` and `OBSERVES` are
 * intentionally absent from retrieval, consolidation, wiki, graph analytics,
 * provenance, service composition, and MCP registration. The generic scoped
 * read-only `berry_query` operator surface remains the documented raw-graph
 * exception; this class itself is not wired into it or any runtime service.
 */
export class AdmissionObservationStore {
  constructor(private readonly driver: Driver) {}

  private async managed<T>(
    mode: 'read' | 'write',
    work: (tx: ManagedTransaction) => Promise<T>,
  ): Promise<T> {
    let session: Session;
    try {
      session = this.driver.session();
    } catch {
      throw new AdmissionObservationStoreError('storage_unavailable');
    }

    let result: T | undefined;
    let failure: AdmissionObservationStoreError | undefined;
    try {
      result = mode === 'read'
        ? await session.executeRead(work)
        : await session.executeWrite(work);
    } catch (error) {
      failure = closedStorageError(error);
    }
    try {
      await session.close();
    } catch (error) {
      // Cleanup must never replace a more specific safe domain failure.
      failure ??= closedStorageError(error);
    }
    if (failure) throw failure;
    return result as T;
  }

  async persist(
    rawScope: AdmissionObservationScopeV1,
    rawObservation: AdmissionObservationV1,
  ): Promise<AdmissionObservationV1> {
    const scope = parseScope(rawScope);
    let observation: AdmissionObservationV1;
    try {
      observation = parseAdmissionObservationV1(rawObservation);
    } catch {
      throw new AdmissionObservationStoreError('invalid_observation');
    }
    if (observation.safeFacts.tenantScope !== 'resolved' || observation.safeFacts.projectScope !== 'resolved') {
      throw new AdmissionObservationStoreError('observation_scope_unresolved');
    }
    const id = safeObservationId(scope);
    const properties = observationProperties(id, scope, observation);
    // Generated exactly once outside the managed callback: Neo4j may replay the
    // callback, and every attempt must identify the same logical creation.
    let attemptToken: string;
    try {
      attemptToken = randomUUID();
    } catch {
      throw new AdmissionObservationStoreError('storage_unavailable');
    }
    return this.managed('write', async (tx) => {
        const result = await tx.run(
          `/* admission-observation:merge */
           MATCH (e:Episodic {id: $episodeId})
           WHERE e.tenant_id = $tenantId AND e.scope = $projectScope
           MERGE (o:AdmissionObservation {id: $id})
           ON CREATE SET o = $properties, o._admission_attempt = $attemptToken
           WITH e, o, o._admission_attempt = $attemptToken AS created
           FOREACH (_ IN CASE WHEN created THEN [1] ELSE [] END |
             CREATE (o)-[:OBSERVES]->(e))
           FOREACH (_ IN CASE WHEN created THEN [1] ELSE [] END |
             REMOVE o._admission_attempt)
           WITH e, o, created
           OPTIONAL MATCH (o)-[r]-(n)
           RETURN properties(o) AS properties,
                  count(r) AS relationshipCount,
                  sum(CASE WHEN type(r) = 'OBSERVES'
                            AND startNode(r) = o
                            AND 'Episodic' IN labels(n)
                            AND n.id = $episodeId
                            AND n.tenant_id = $tenantId
                            AND n.scope = $projectScope
                           THEN 1 ELSE 0 END) AS exactLinkCount,
                  created`,
          { ...scope, id, properties, attemptToken },
        );
        if (result.records.length === 0) {
          throw new AdmissionObservationStoreError('episode_not_found');
        }
        if (result.records.length !== 1) throw new AdmissionObservationStoreError('write_incomplete');
        const record = result.records[0]!;
        if (integerValue(record.get('relationshipCount')) !== 1
          || integerValue(record.get('exactLinkCount')) !== 1
          || !substantivePropertiesMatch(record.get('properties'), properties)) {
          throw new AdmissionObservationStoreError('existing_state_mismatch');
        }
        return parsePersistedObservation(record.get('properties'));
    });
  }

  async get(rawScope: AdmissionObservationScopeV1): Promise<AdmissionObservationV1 | null> {
    const scope = parseScope(rawScope);
    const id = safeObservationId(scope);
    return this.managed('read', async (tx) => {
        const result = await tx.run(
          `/* admission-observation:read-scoped */
           MATCH (e:Episodic {id: $episodeId})
           WHERE e.tenant_id = $tenantId AND e.scope = $projectScope
           MATCH (o:AdmissionObservation {id: $id, tenant_id: $tenantId, project_scope: $projectScope})-[:OBSERVES]->(e)
           OPTIONAL MATCH (o)-[r]-(n)
           RETURN properties(o) AS properties,
                  count(r) AS relationshipCount,
                  sum(CASE WHEN type(r) = 'OBSERVES'
                            AND startNode(r) = o
                            AND 'Episodic' IN labels(n)
                            AND n.id = $episodeId
                            AND n.tenant_id = $tenantId
                            AND n.scope = $projectScope
                           THEN 1 ELSE 0 END) AS exactLinkCount`,
          { ...scope, id },
        );
        if (result.records.length === 0) return null;
        const record = result.records[0]!;
        if (integerValue(record.get('relationshipCount')) !== 1
          || integerValue(record.get('exactLinkCount')) !== 1) {
          throw new AdmissionObservationStoreError('existing_state_mismatch');
        }
        const properties = persistedRecord(record.get('properties'));
        if (properties.id !== id || properties.tenant_id !== scope.tenantId || properties.project_scope !== scope.projectScope) {
          throw new AdmissionObservationStoreError('existing_state_mismatch');
        }
        return parsePersistedObservation(properties);
    });
  }
}
