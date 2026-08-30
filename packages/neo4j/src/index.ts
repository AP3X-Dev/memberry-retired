// packages/neo4j/src/index.ts
export { createNeo4jDriver, healthCheck } from './driver.js';
export type { Neo4jHealthResult } from './driver.js';
export { initSchema, verifySchema } from './schema.js';
export type { SchemaVerification } from './schema.js';
export {
  runMigrations,
  checkVectorIndexDimensions,
  checkVectorIndexCoverage,
  MIGRATIONS,
  SCHEMA_VERSION_ID,
} from './migrations.js';
export type { Migration, MigrationResult, VectorIndexDimension } from './migrations.js';
export {
  EVIDENCE_AUTHORITY_LEDGER_VERSION,
  EvidenceAuthorityLedgerError,
} from './evidence-authority-ledger.js';
export type {
  EvidenceAuthorityScopeV1,
  EvidenceAuthorityOperationV1,
  EvidenceAuthorityOpenCaseOperationV1,
  EvidenceAuthorityCoverageStateV1,
  EvidenceAuthorityCaseStateV1,
  EvidenceAuthorityEventKindV1,
  EvidenceAuthorityEventActionV1,
  EvidenceAuthorityEventReceiptV1,
  EvidenceAuthorityCoverageFacetV1,
  EvidenceAuthorityCaseFacetV1,
  EvidenceAuthorityCoverageOpenResultV1,
  EvidenceAuthorityCaseOpenResultV1,
  EvidenceAuthorityLedgerErrorCode,
  EvidenceAuthorityLedgerPersistenceV1,
} from './evidence-authority-ledger.js';
export { EpisodicStore } from './episodic.js';
export { EpisodicIndexStore } from './episodic-index.js';
export type { EpisodicIndexCursorV1, EpisodicIndexBackfillEpisodeV1 } from './episodic-index.js';
export { AdmissionObservationStore, AdmissionObservationStoreError } from './admission-observation.js';
export type {
  AdmissionObservationScopeV1,
  AdmissionObservationStoreErrorCode,
} from './admission-observation.js';
export {
  AdmissionRoutingRecommendationStore,
  AdmissionRoutingRecommendationStoreError,
} from './admission-routing-recommendation.js';
export type {
  AdmissionRoutingRecommendationScopeV1,
  AdmissionRoutingRecommendationStoreErrorCode,
} from './admission-routing-recommendation.js';
export { SemanticStore } from './semantic.js';
export { ProvenanceTraversal } from './provenance.js';
export type { ProvenanceNode } from './provenance.js';
export { ScopedQuery, validateReadOnlyCypher, archivedWhere } from './query.js';
export type { QueryScope } from './query.js';
export { tenantWhere, resolveTenant, isDefaultTenant, TENANT_PARAM } from './tenant.js';
export { TenantAdmin } from './tenant-admin.js';
export { LifecycleStore, SIDECAR_LABELS } from './lifecycle.js';
export type {
  LifecycleScope,
  SidecarLabel,
  SidecarLabelPlan,
  SidecarPlan,
  ArchivePlan,
  DecayCandidate,
} from './lifecycle.js';
export type { TenantCounts, TenantExport } from './tenant-admin.js';
export { GDSAlgorithms } from './gds.js';
export { BlockStore } from './blocks.js';
export { FactStore } from './fact.js';
export { EntityResolver } from './entity-resolver.js';
export type { ResolvedEntity } from './entity-resolver.js';
export { EntityStore } from './entity.js';
export { AuditLogStore } from './audit.js';
export type { AuditRecord } from './audit.js';
export { InjectionLogStore } from './injection-log.js';
export type { SimilarPair, RankedNode, CommunityNode } from './gds.js';
export {
  temporalSetClause,
  activeRelationshipFilter,
  invalidateRelationship,
} from './temporal-edges.js';
export type { TemporalEdgeProperties } from './temporal-edges.js';
