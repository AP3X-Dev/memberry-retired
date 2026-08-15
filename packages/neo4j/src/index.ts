// packages/neo4j/src/index.ts
export { createNeo4jDriver, healthCheck } from './driver.js';
export type { Neo4jHealthResult } from './driver.js';
export { initSchema, verifySchema } from './schema.js';
export type { SchemaVerification } from './schema.js';
export {
  runMigrations,
  checkVectorIndexDimensions,
  MIGRATIONS,
  SCHEMA_VERSION_ID,
} from './migrations.js';
export type { Migration, MigrationResult, VectorIndexDimension } from './migrations.js';
export { EpisodicStore } from './episodic.js';
export { AdmissionObservationStore, AdmissionObservationStoreError } from './admission-observation.js';
export type {
  AdmissionObservationScopeV1,
  AdmissionObservationStoreErrorCode,
} from './admission-observation.js';
export { SemanticStore } from './semantic.js';
export { ProvenanceTraversal } from './provenance.js';
export type { ProvenanceNode } from './provenance.js';
export { ScopedQuery, validateReadOnlyCypher } from './query.js';
export type { QueryScope } from './query.js';
export { tenantWhere, resolveTenant, isDefaultTenant, TENANT_PARAM } from './tenant.js';
export { TenantAdmin } from './tenant-admin.js';
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
