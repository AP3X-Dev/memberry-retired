// packages/neo4j/src/schema.ts
import { EMBEDDING_DIM } from "@memberry/core";
import { type Driver } from 'neo4j-driver';

const CONSTRAINTS: string[] = [
  'CREATE CONSTRAINT episodic_id IF NOT EXISTS FOR (e:Episodic) REQUIRE e.id IS UNIQUE',
  'CREATE CONSTRAINT semantic_id IF NOT EXISTS FOR (s:Semantic) REQUIRE s.id IS UNIQUE',
  'CREATE CONSTRAINT procedural_id IF NOT EXISTS FOR (p:Procedural) REQUIRE p.id IS UNIQUE',
  'CREATE CONSTRAINT entity_id IF NOT EXISTS FOR (e:Entity) REQUIRE e.id IS UNIQUE',
  'CREATE CONSTRAINT agent_id IF NOT EXISTS FOR (a:Agent) REQUIRE a.id IS UNIQUE',
  'CREATE CONSTRAINT model_id IF NOT EXISTS FOR (m:Model) REQUIRE m.id IS UNIQUE',
  // Tenant-aware uniqueness: two tenants may hold a block with the same
  // (scope, name). Migration 0004 drops the legacy (scope, name) constraint on
  // existing graphs; fresh graphs get this one directly.
  'CREATE CONSTRAINT memblock_scope_name_tenant IF NOT EXISTS FOR (b:MemoryBlock) REQUIRE (b.scope, b.name, b.tenant_id) IS UNIQUE',
  'CREATE CONSTRAINT fact_id IF NOT EXISTS FOR (f:Fact) REQUIRE f.id IS UNIQUE',
  // gap-16: bootstrap seed dedupe. A UNIQUE constraint (not a plain index) is
  // required so the idempotent MERGE in BootstrapGraphService.createSemantic is
  // concurrency-safe — without uniqueness, two concurrent MERGEs on the same
  // dedupe_key can both create. Existing semantics have no dedupe_key (null is
  // exempt from uniqueness), so no migration is needed; the constraint also
  // backs the MERGE lookup with an index.
  'CREATE CONSTRAINT semantic_dedupe_unique IF NOT EXISTS FOR (s:Semantic) REQUIRE s.dedupe_key IS UNIQUE',
  'CREATE CONSTRAINT admission_observation_id IF NOT EXISTS FOR (o:AdmissionObservation) REQUIRE o.id IS UNIQUE',
];

const INDEXES: string[] = [
  'CREATE INDEX semantic_confidence_updated IF NOT EXISTS FOR (s:Semantic) ON (s.confidence, s.updated_at)',
  'CREATE INDEX episodic_session IF NOT EXISTS FOR (e:Episodic) ON (e.session_id)',
  'CREATE INDEX episodic_agent IF NOT EXISTS FOR (e:Episodic) ON (e.agent_id)',
  'CREATE INDEX entity_name IF NOT EXISTS FOR (e:Entity) ON (e.name)',
  'CREATE INDEX fact_status_valid IF NOT EXISTS FOR (f:Fact) ON (f.status, f.valid_at)',
  'CREATE INDEX fact_subject IF NOT EXISTS FOR (f:Fact) ON (f.subject)',
  'CREATE INDEX fact_scope IF NOT EXISTS FOR (f:Fact) ON (f.scope)',
  'CREATE INDEX fact_invalid_at IF NOT EXISTS FOR (f:Fact) ON (f.invalid_at)',
  'CREATE INDEX fact_updated_at IF NOT EXISTS FOR (f:Fact) ON (f.updated_at)',
  'CREATE INDEX fact_entity_id IF NOT EXISTS FOR (f:Fact) ON (f.entity_id)',
  'CREATE INDEX fact_inference_type IF NOT EXISTS FOR (f:Fact) ON (f.inference_type)',
  'CREATE INDEX memblock_session IF NOT EXISTS FOR (b:MemoryBlock) ON (b.session_id)',
  'CREATE INDEX admission_observation_tenant_project IF NOT EXISTS FOR (o:AdmissionObservation) ON (o.tenant_id, o.project_scope)',
];

const FULLTEXT_INDEXES: string[] = [
  'CREATE FULLTEXT INDEX semantic_content IF NOT EXISTS FOR (s:Semantic) ON EACH [s.content]',
  'CREATE FULLTEXT INDEX episodic_content IF NOT EXISTS FOR (e:Episodic) ON EACH [e.content]',
  'CREATE FULLTEXT INDEX fact_content IF NOT EXISTS FOR (f:Fact) ON EACH [f.subject, f.predicate, f.object]',
];

const VECTOR_INDEXES = [
  `CREATE VECTOR INDEX semantic_embedding IF NOT EXISTS FOR (s:Semantic) ON (s.embedding) OPTIONS {indexConfig: {\`vector.dimensions\`: ${EMBEDDING_DIM}, \`vector.similarity_function\`: 'cosine'}}`,
  `CREATE VECTOR INDEX episodic_embedding IF NOT EXISTS FOR (e:Episodic) ON (e.embedding) OPTIONS {indexConfig: {\`vector.dimensions\`: ${EMBEDDING_DIM}, \`vector.similarity_function\`: 'cosine'}}`,
  `CREATE VECTOR INDEX fact_embedding IF NOT EXISTS FOR (f:Fact) ON (f.embedding) OPTIONS {indexConfig: {\`vector.dimensions\`: ${EMBEDDING_DIM}, \`vector.similarity_function\`: 'cosine'}}`,
];

export async function initSchema(driver: Driver): Promise<void> {
  const session = driver.session();
  try {
    const allStatements = [
      ...CONSTRAINTS,
      ...INDEXES,
      ...FULLTEXT_INDEXES,
      ...VECTOR_INDEXES,
    ];
    for (const statement of allStatements) {
      await session.run(statement);
    }
  } finally {
    await session.close();
  }
}

export interface SchemaVerification {
  constraintCount: number;
  indexCount: number;
}

export async function verifySchema(driver: Driver): Promise<SchemaVerification> {
  const session = driver.session();
  try {
    // Run sequentially: a single Neo4j session permits only one query/transaction
    // at a time — `Promise.all` on one session throws "open transaction".
    const constraintsResult = await session.run('SHOW CONSTRAINTS');
    const indexesResult = await session.run('SHOW INDEXES');
    return {
      constraintCount: constraintsResult.records.length,
      indexCount: indexesResult.records.length,
    };
  } finally {
    await session.close();
  }
}
