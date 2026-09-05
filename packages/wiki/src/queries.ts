// packages/wiki/src/queries.ts
// All Neo4j graph queries for the wiki compiler.

import type { Driver } from 'neo4j-driver';
import neo4j from 'neo4j-driver';
import type { EntityInfo, EpisodicEntry, SourceInfo, ResolvedClaim } from './types.js';
import { DEFAULT_TENANT } from '@memberry/core';
import { slugify } from './compile.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Same predicate shape as core/export.ts and @memberry/neo4j reads (params: $tenantId, $defaultTenant).
 *  Entity nodes carry no tenant_id, so only Semantic/Episodic aliases are guarded. */
export function tenantWhere(alias: string): string {
  return `(${alias}.tenant_id = $tenantId OR (${alias}.tenant_id IS NULL AND $tenantId = $defaultTenant))`;
}

export function tenantParams(tenantId: string): { tenantId: string; defaultTenant: string } {
  return { tenantId: tenantId.trim() || DEFAULT_TENANT, defaultTenant: DEFAULT_TENANT };
}

function toNumber(val: unknown): number {
  if (typeof val === 'number') return val;
  if (val && typeof val === 'object' && 'toNumber' in val) return (val as { toNumber(): number }).toNumber();
  return Number(val);
}

/** Extract project scope from a task string like "[project:agent-assist] Fix bug" */
export function extractProjectScope(task: string): string | null {
  const match = task.match(/^\[project:([^\]]+)\]/);
  return match ? match[1] : null;
}

// ─── Project discovery ──────────────────────────────────────────────────────

export async function fetchAllProjects(driver: Driver): Promise<EntityInfo[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (e:Entity {type: 'project'})
       RETURN e.id AS id, e.name AS name, e.type AS type, e.description AS description,
              e.aliases AS aliases, e.created_at AS created_at
       ORDER BY e.name`,
    );
    return result.records.map((r) => ({
      id: r.get('id') as string,
      name: r.get('name') as string,
      type: r.get('type') as string,
      slug: slugify(r.get('name') as string),
      description: r.get('description') as string | undefined,
      aliases: r.get('aliases') as string[] | undefined,
      created_at: r.get('created_at') as string,
    }));
  } finally {
    await session.close();
  }
}

/** Discover project scopes carried by memory but missing a project Entity.
 * The historical name is retained for API compatibility, but both Episodic and
 * Semantic nodes participate so a semantic-only scope can get a virtual wiki. */
export async function fetchEpisodicProjectScopes(driver: Driver, tenantId: string = DEFAULT_TENANT): Promise<string[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `CALL {
         MATCH (ep:Episodic)
         WHERE coalesce(ep.archived, false) = false
           AND ${tenantWhere('ep')}
         WITH ep,
              CASE WHEN ep.scope IS NOT NULL AND ep.scope STARTS WITH 'project:'
                   THEN [substring(ep.scope, 8)] ELSE [] END AS scopeNames,
              [t IN coalesce(ep.tags, []) WHERE t STARTS WITH 'project:' | substring(t, 8)] AS tagNames,
              CASE WHEN ep.task STARTS WITH '[project:'
                   THEN [split(split(ep.task, ']')[0], ':')[1]] ELSE [] END AS taskNames
         UNWIND (scopeNames + tagNames + taskNames) AS proj
         RETURN proj
         UNION
         MATCH (s:Semantic)
         WHERE NOT EXISTS { MATCH (:Semantic)-[:SUPERSEDES]->(s) }
           AND coalesce(s.archived, false) = false
           AND ${tenantWhere('s')}
         WITH s,
              CASE WHEN s.scope IS NOT NULL AND s.scope STARTS WITH 'project:'
                   THEN [substring(s.scope, 8)] ELSE [] END AS scopeNames,
              [t IN coalesce(s.tags, []) WHERE t STARTS WITH 'project:' | substring(t, 8)] AS tagNames
         UNWIND (scopeNames + tagNames) AS proj
         RETURN proj
       }
       WITH DISTINCT proj WHERE proj IS NOT NULL AND proj <> ''
       OPTIONAL MATCH (e:Entity {type: 'project'})
       WHERE toLower(e.name) = toLower(proj)
       WITH proj WHERE e IS NULL
       RETURN proj ORDER BY proj`,
      tenantParams(tenantId),
    );
    return result.records.map((r) => r.get('proj') as string).filter(Boolean);
  } finally {
    await session.close();
  }
}

// ─── Entity queries ─────────────────────────────────────────────────────────

export async function fetchProjectEntities(driver: Driver, projectName: string): Promise<EntityInfo[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (project:Entity {type: 'project'})-[:CONTAINS*1..]->(e:Entity)
       WHERE project.name = $projectName
       RETURN e.id AS id, e.name AS name, e.type AS type, e.description AS description,
              e.aliases AS aliases, e.created_at AS created_at, e.path AS path
       ORDER BY e.name`,
      { projectName },
    );
    return result.records.map((r) => ({
      id: r.get('id') as string,
      name: r.get('name') as string,
      type: r.get('type') as string,
      slug: slugify(r.get('name') as string),
      description: r.get('description') as string | undefined,
      aliases: r.get('aliases') as string[] | undefined,
      created_at: r.get('created_at') as string,
      path: (r.get('path') as string | null) ?? undefined,
    }));
  } finally {
    await session.close();
  }
}

/** Entities linked via MODIFIED from episodics scoped to a project */
export async function fetchEntitiesModifiedByProject(driver: Driver, projectScope: string, tenantId: string = DEFAULT_TENANT): Promise<EntityInfo[]> {
  const session = driver.session();
  try {
    // gap-13: structured `ep.scope`/`ep.tags` (the canonical project association
    // set by berry_store) is the primary match; the `[project:…]` task prefix is
    // kept only as a back-compat FALLBACK for episodes stored before structured
    // scoping. `canonTag` must match berry_store EXACTLY, which persists
    // `ep.scope`/`ep.tags` as `rawTag.toLowerCase()` (lowercase only — NOT
    // slugified), so we lowercase here too. (slugify would turn `my_project`
    // into `my-project` and silently never match.)
    const canonTag = `project:${projectScope.replace(/^project:/i, '').toLowerCase()}`;
    const taskTag = `[project:${projectScope}]`;
    const result = await session.run(
      `MATCH (ep:Episodic)-[:MODIFIED]->(e:Entity)
       WHERE (ep.scope = $canonTag OR $canonTag IN ep.tags OR ep.task CONTAINS $taskTag)
         AND coalesce(ep.archived, false) = false
         AND ${tenantWhere('ep')}
       RETURN DISTINCT e.id AS id, e.name AS name, e.type AS type, e.description AS description,
              e.aliases AS aliases, e.created_at AS created_at, e.path AS path
       ORDER BY e.name`,
      { canonTag, taskTag, ...tenantParams(tenantId) },
    );
    return result.records.map((r) => ({
      id: r.get('id') as string,
      name: r.get('name') as string,
      type: r.get('type') as string,
      slug: slugify(r.get('name') as string),
      description: r.get('description') as string | undefined,
      aliases: r.get('aliases') as string[] | undefined,
      created_at: r.get('created_at') as string,
      path: (r.get('path') as string | null) ?? undefined,
    }));
  } finally {
    await session.close();
  }
}

// ─── Semantic queries ───────────────────────────────────────────────────────

export async function fetchSemanticsForEntity(driver: Driver, entityName: string, tenantId: string = DEFAULT_TENANT): Promise<Array<{
  id: string; content: string; confidence: number; memory_type?: string; tags: string[]; scope?: string; updated_at: string; entity_refs: string[];
}>> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (s:Semantic)-[about:ABOUT]->(e:Entity {name: $name})
       WHERE about.invalid_at IS NULL
         AND NOT EXISTS { MATCH (:Semantic)-[:SUPERSEDES]->(s) }
         AND coalesce(s.archived, false) = false
         AND ${tenantWhere('s')}
       OPTIONAL MATCH (s)-[otherAbout:ABOUT]->(other:Entity)
       WHERE other.name <> $name AND otherAbout.invalid_at IS NULL
       RETURN s.id AS id, s.content AS content, s.confidence AS confidence,
              s.memory_type AS memory_type,
              s.tags AS tags, s.scope AS scope, s.updated_at AS updated_at,
              collect(DISTINCT other.name) AS entity_refs
       ORDER BY s.confidence DESC, s.updated_at DESC`,
      { name: entityName, ...tenantParams(tenantId) },
    );
    return result.records.map((r) => ({
      id: r.get('id') as string,
      content: r.get('content') as string,
      confidence: r.get('confidence') as number,
      memory_type: (r.get('memory_type') as string | null) ?? undefined,
      tags: (r.get('tags') as string[]) ?? [],
      scope: (r.get('scope') as string | null) ?? undefined,
      updated_at: r.get('updated_at') as string,
      entity_refs: (r.get('entity_refs') as string[]) ?? [],
    }));
  } finally {
    await session.close();
  }
}

export async function fetchSemanticCountForEntity(driver: Driver, entityName: string, tenantId: string = DEFAULT_TENANT): Promise<number> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (s:Semantic)-[about:ABOUT]->(e:Entity {name: $name})
       WHERE about.invalid_at IS NULL
         AND NOT EXISTS { MATCH (:Semantic)-[:SUPERSEDES]->(s) }
         AND coalesce(s.archived, false) = false
         AND ${tenantWhere('s')}
       RETURN count(s) AS cnt`,
      { name: entityName, ...tenantParams(tenantId) },
    );
    return toNumber(result.records[0]?.get('cnt') ?? 0);
  } finally {
    await session.close();
  }
}

export async function fetchAllSemantics(driver: Driver, tenantId: string = DEFAULT_TENANT): Promise<Array<{
  id: string; content: string; confidence: number; memory_type?: string; tags: string[]; scope?: string; entities: string[];
}>> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (s:Semantic)
       WHERE NOT EXISTS { MATCH (:Semantic)-[:SUPERSEDES]->(s) }
         AND coalesce(s.archived, false) = false
         AND ${tenantWhere('s')}
       OPTIONAL MATCH (s)-[about:ABOUT]->(e:Entity)
       WHERE about.invalid_at IS NULL
       RETURN s.id AS id, s.content AS content, s.confidence AS confidence,
              s.memory_type AS memory_type,
              s.tags AS tags, s.scope AS scope, collect(DISTINCT e.name) AS entities
       ORDER BY s.confidence DESC`,
      tenantParams(tenantId),
    );
    return result.records.map((r) => ({
      id: r.get('id') as string,
      content: r.get('content') as string,
      confidence: r.get('confidence') as number,
      memory_type: (r.get('memory_type') as string | null) ?? undefined,
      tags: (r.get('tags') as string[]) ?? [],
      scope: (r.get('scope') as string | null) ?? undefined,
      entities: (r.get('entities') as string[]).filter(Boolean),
    }));
  } finally {
    await session.close();
  }
}

// ─── Episodic queries ───────────────────────────────────────────────────────

export async function fetchEpisodicsForProject(driver: Driver, projectScope: string, tenantId: string = DEFAULT_TENANT): Promise<EpisodicEntry[]> {
  const session = driver.session();
  try {
    // gap-13: an episode belongs to this project when ANY of these hold —
    //   1. `ep.scope` equals the canonical project tag (structured, primary),
    //   2. the canonical tag is in `ep.tags` (structured, primary),
    //   3. the legacy `[project:…]` task prefix is present (FALLBACK).
    // berry_store sets scope/tags but does NOT prepend the task prefix, so an
    // episode stored with scope='project:x'/tags=['project:x'] and no prefix was
    // previously invisible here. `canonTag` must match berry_store EXACTLY, which
    // persists scope/tags as `rawTag.toLowerCase()` (lowercase only — NOT slugified),
    // so we lowercase here too. (slugify would turn `my_project` → `my-project`.)
    const canonTag = `project:${projectScope.replace(/^project:/i, '').toLowerCase()}`;
    const taskTag = `[project:${projectScope}]`;
    const result = await session.run(
      `MATCH (ep:Episodic)
       WHERE (ep.scope = $canonTag OR $canonTag IN ep.tags OR ep.task CONTAINS $taskTag)
         AND coalesce(ep.archived, false) = false
         AND ${tenantWhere('ep')}
       RETURN ep.id AS id, ep.task AS task, ep.content AS content,
              ep.outcome AS outcome, ep.session_id AS session_id, ep.created_at AS created_at,
              ep.scope AS scope, ep.tags AS tags
       ORDER BY ep.created_at DESC`,
      { canonTag, taskTag, ...tenantParams(tenantId) },
    );
    return result.records.map((r) => ({
      id: r.get('id') as string,
      task: r.get('task') as string,
      content: r.get('content') as string,
      outcome: r.get('outcome') as string | null,
      session_id: r.get('session_id') as string,
      created_at: r.get('created_at') as string,
      project_scope: projectScope,
      scope: (r.get('scope') as string | null) ?? undefined,
      tags: (r.get('tags') as string[] | null) ?? undefined,
    }));
  } finally {
    await session.close();
  }
}

export async function fetchEpisodicsForEntity(
  driver: Driver,
  entityName: string,
  projectScope: string,
  entityId?: string,
  tenantId: string = DEFAULT_TENANT,
): Promise<EpisodicEntry[]> {
  const session = driver.session();
  try {
    const canonTag = `project:${projectScope.replace(/^project:/i, '').toLowerCase()}`;
    const taskTag = `[project:${projectScope.replace(/^project:/i, '')}]`;
    const result = await session.run(
      `MATCH (ep:Episodic)
       WHERE (ep.scope = $canonTag OR $canonTag IN coalesce(ep.tags, []) OR ep.task CONTAINS $taskTag)
         AND coalesce(ep.archived, false) = false
         AND ${tenantWhere('ep')}
         AND ((ep.task CONTAINS $name OR ep.content CONTAINS $name)
              OR ($entityId IS NOT NULL AND EXISTS { MATCH (ep)-[:MODIFIED]->(e:Entity {id: $entityId}) }))
       RETURN DISTINCT ep.id AS id, ep.task AS task, ep.content AS content,
              ep.outcome AS outcome, ep.session_id AS session_id, ep.created_at AS created_at,
              ep.scope AS scope, ep.tags AS tags
       ORDER BY ep.created_at DESC
       LIMIT 20`,
      { name: entityName, entityId: entityId ?? null, canonTag, taskTag, ...tenantParams(tenantId) },
    );
    return result.records.map((r) => ({
      id: r.get('id') as string,
      task: r.get('task') as string,
      content: r.get('content') as string,
      outcome: r.get('outcome') as string | null,
      session_id: r.get('session_id') as string,
      created_at: r.get('created_at') as string,
      project_scope: extractProjectScope(r.get('task') as string),
      scope: (r.get('scope') as string | null) ?? undefined,
      tags: (r.get('tags') as string[] | null) ?? undefined,
    }));
  } finally {
    await session.close();
  }
}

/**
 * Batched form of {@link fetchEpisodicsForEntity}. Scans `:Episodic` ONCE for an
 * array of project entities instead of once per entity, then regroups rows per ID
 * in JS. Text mentions are admitted only from the requested project scope; an
 * exact `:MODIFIED` edge uses entity ID so same-named entities in another project
 * cannot leak history. The per-entity `ORDER BY ... LIMIT 20` remains inside a
 * `CALL {}` subquery (the OPT-16 pattern), so each entity still gets its own
 *     top-20, identical to calling fetchEpisodicsForEntity(name) individually.
 *
 * Returns a Map keyed by the input entity ID. Entities with no matches are absent
 * from the map (callers should treat a miss as an empty list).
 */
export async function fetchEpisodicsForEntities(
  driver: Driver,
  entities: Array<Pick<EntityInfo, 'id' | 'name'>>,
  projectScope: string,
  tenantId: string = DEFAULT_TENANT,
): Promise<Map<string, EpisodicEntry[]>> {
  const grouped = new Map<string, EpisodicEntry[]>();
  if (entities.length === 0) return grouped;
  // Deduplicate stable IDs before UNWIND: otherwise the per-entity subquery runs
  // more than once and appends duplicate wiki "History" rows.
  const uniqueEntities = [...new Map(entities.map((entity) => [entity.id, entity])).values()];
  const canonTag = `project:${projectScope.replace(/^project:/i, '').toLowerCase()}`;
  const taskTag = `[project:${projectScope.replace(/^project:/i, '')}]`;
  const session = driver.session();
  try {
    const result = await session.run(
      `UNWIND $entities AS entity
       CALL {
         WITH entity
         MATCH (ep:Episodic)
         WHERE (ep.scope = $canonTag OR $canonTag IN coalesce(ep.tags, []) OR ep.task CONTAINS $taskTag)
           AND coalesce(ep.archived, false) = false
           AND ${tenantWhere('ep')}
           AND ((ep.task CONTAINS entity.name OR ep.content CONTAINS entity.name)
                OR EXISTS { MATCH (ep)-[:MODIFIED]->(e:Entity) WHERE e.id = entity.id })
         RETURN DISTINCT ep.id AS id, ep.task AS task, ep.content AS content,
                ep.outcome AS outcome, ep.session_id AS session_id, ep.created_at AS created_at,
                ep.scope AS scope, ep.tags AS tags
         ORDER BY ep.created_at DESC
         LIMIT 20
       }
       RETURN entity.id AS entity_id, entity.name AS name,
              id, task, content, outcome, session_id, created_at, scope, tags`,
      { entities: uniqueEntities, canonTag, taskTag, ...tenantParams(tenantId) },
    );
    for (const r of result.records) {
      const entityId = r.get('entity_id') as string;
      const entry: EpisodicEntry = {
        id: r.get('id') as string,
        task: r.get('task') as string,
        content: r.get('content') as string,
        outcome: r.get('outcome') as string | null,
        session_id: r.get('session_id') as string,
        created_at: r.get('created_at') as string,
        project_scope: extractProjectScope(r.get('task') as string),
        scope: (r.get('scope') as string | null) ?? undefined,
        tags: (r.get('tags') as string[] | null) ?? undefined,
      };
      const existing = grouped.get(entityId);
      if (existing) {
        // Defense-in-depth: never store the same episodic twice for one name.
        if (!existing.some((e) => e.id === entry.id)) existing.push(entry);
      } else {
        grouped.set(entityId, [entry]);
      }
    }
    return grouped;
  } finally {
    await session.close();
  }
}

export async function fetchRecentEpisodics(driver: Driver, limit: number, tenantId: string = DEFAULT_TENANT): Promise<EpisodicEntry[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (ep:Episodic)
       WHERE coalesce(ep.archived, false) = false
         AND ${tenantWhere('ep')}
       RETURN ep.id AS id, ep.task AS task, ep.content AS content,
              ep.outcome AS outcome, ep.session_id AS session_id, ep.created_at AS created_at,
              ep.scope AS scope, ep.tags AS tags
       ORDER BY ep.created_at DESC
       LIMIT $limit`,
      { limit: neo4j.int(limit), ...tenantParams(tenantId) },
    );
    return result.records.map((r) => ({
      id: r.get('id') as string,
      task: r.get('task') as string,
      content: r.get('content') as string,
      outcome: r.get('outcome') as string | null,
      session_id: r.get('session_id') as string,
      created_at: r.get('created_at') as string,
      project_scope: extractProjectScope(r.get('task') as string),
      scope: (r.get('scope') as string | null) ?? undefined,
      tags: (r.get('tags') as string[] | null) ?? undefined,
    }));
  } finally {
    await session.close();
  }
}

// ─── Hierarchy ──────────────────────────────────────────────────────────────

export interface HierarchyRef {
  id: string;
  name: string;
  path?: string;
}

// Matched by the current entity's ID (not its name) so a basename shared by many
// nodes — e.g. 65 `__init__.py` — doesn't pull in every same-named node's
// relatives. Returns each relative's id+name+path so the caller can resolve it to
// a path-disambiguated link (or plain text when it has no page).
export async function fetchHierarchy(driver: Driver, entityId: string): Promise<{ parent?: HierarchyRef; children: HierarchyRef[] }> {
  const sessionA = driver.session();
  const sessionB = driver.session();
  try {
    const [parentResult, childrenResult] = await Promise.all([
      sessionA.run(
        `MATCH (parent:Entity)-[:CONTAINS]->(e:Entity {id: $id})
         RETURN parent.id AS id, parent.name AS name, parent.path AS path LIMIT 1`,
        { id: entityId },
      ),
      sessionB.run(
        `MATCH (e:Entity {id: $id})-[:CONTAINS]->(child:Entity)
         RETURN child.id AS id, child.name AS name, child.path AS path ORDER BY child.name`,
        { id: entityId },
      ),
    ]);
    const parentRec = parentResult.records[0];
    return {
      parent: parentRec
        ? {
            id: parentRec.get('id') as string,
            name: parentRec.get('name') as string,
            path: (parentRec.get('path') as string | null) ?? undefined,
          }
        : undefined,
      children: childrenResult.records.map((r) => ({
        id: r.get('id') as string,
        name: r.get('name') as string,
        path: (r.get('path') as string | null) ?? undefined,
      })),
    };
  } finally {
    await Promise.all([sessionA.close(), sessionB.close()]);
  }
}

// ─── Backlinks ──────────────────────────────────────────────────────────────

export async function fetchBacklinks(driver: Driver, entityName: string, tenantId: string = DEFAULT_TENANT): Promise<Array<{ entity_name: string; entity_slug: string; context: string }>> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (s:Semantic)-[:ABOUT]->(target:Entity {name: $name})
       MATCH (s)-[:ABOUT]->(other:Entity)
       WHERE other.name <> $name
         AND coalesce(s.archived, false) = false
         AND ${tenantWhere('s')}
       RETURN DISTINCT other.name AS name, substring(s.content, 0, 120) AS context
       ORDER BY name
       LIMIT 50`,
      { name: entityName, ...tenantParams(tenantId) },
    );
    return result.records.map((r) => ({
      entity_name: r.get('name') as string,
      entity_slug: slugify(r.get('name') as string),
      context: (r.get('context') as string) ?? '',
    }));
  } finally {
    await session.close();
  }
}

// ─── Related entities ───────────────────────────────────────────────────────

export async function fetchRelatedEntities(driver: Driver, entityName: string): Promise<Array<{ entity_name: string; entity_slug: string; context: string; weight: number }>> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (e:Entity {name: $name})
       OPTIONAL MATCH (e)-[r]->(related:Entity)
       WHERE type(r) <> 'CONTAINS'
       WITH collect({name: related.name, rel: type(r)}) AS outgoing
       OPTIONAL MATCH (other:Entity)-[r2]->(e2:Entity {name: $name})
       WHERE type(r2) <> 'CONTAINS'
       WITH outgoing, collect({name: other.name, rel: type(r2)}) AS incoming
       UNWIND (outgoing + incoming) AS rel
       WITH rel WHERE rel.name IS NOT NULL
       RETURN DISTINCT rel.name AS name, rel.rel AS rel_type
       ORDER BY name
       LIMIT 20`,
      { name: entityName },
    );
    return result.records.map((r) => ({
      entity_name: r.get('name') as string,
      entity_slug: slugify(r.get('name') as string),
      context: `via ${(r.get('rel_type') as string).toLowerCase()}`,
      weight: 1.0,
    }));
  } finally {
    await session.close();
  }
}

// ─── Sources ────────────────────────────────────────────────────────────────

export async function fetchAllSources(driver: Driver): Promise<SourceInfo[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (s:Source)
       RETURN s.id AS id, s.title AS title, s.source_type AS source_type,
              s.path AS path, s.project_tag AS project_tag, s.created_at AS created_at
       ORDER BY s.title`,
    );
    return result.records.map((r) => ({
      id: r.get('id') as string,
      title: (r.get('title') as string) ?? 'Untitled',
      source_type: (r.get('source_type') as string) ?? 'unknown',
      path: (r.get('path') as string) ?? '',
      project_tag: (r.get('project_tag') as string) ?? '',
      created_at: (r.get('created_at') as string) ?? '',
    }));
  } finally {
    await session.close();
  }
}

export async function fetchClaimsForSource(driver: Driver, sourceId: string, tenantId: string = DEFAULT_TENANT): Promise<ResolvedClaim[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (s:Semantic)-[:CITES]->(src:Source {id: $sourceId})
       WHERE coalesce(s.archived, false) = false
         AND ${tenantWhere('s')}
       OPTIONAL MATCH (s)-[:ABOUT]->(e:Entity)
       RETURN s.id AS id, s.content AS content, s.confidence AS confidence,
              collect(DISTINCT e.name) AS entity_refs
       ORDER BY s.confidence DESC`,
      { sourceId, ...tenantParams(tenantId) },
    );
    return result.records.map((r) => ({
      content: r.get('content') as string,
      confidence: r.get('confidence') as number,
      memberry_id: r.get('id') as string,
      source_refs: [sourceId],
      entity_refs: (r.get('entity_refs') as string[]).filter(Boolean),
    }));
  } finally {
    await session.close();
  }
}

// ─── Tags / Topics ──────────────────────────────────────────────────────────

export async function fetchAllTags(driver: Driver, tenantId: string = DEFAULT_TENANT): Promise<Array<{ tag: string; count: number; projects: string[] }>> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (s:Semantic)
       WHERE coalesce(s.archived, false) = false
         AND ${tenantWhere('s')}
       UNWIND s.tags AS tag
       WITH tag WHERE NOT tag STARTS WITH 'project:'
       WITH tag, count(*) AS cnt
       RETURN tag, cnt AS count, [] AS projects
       ORDER BY cnt DESC`,
      tenantParams(tenantId),
    );
    return result.records.map((r) => ({
      tag: r.get('tag') as string,
      count: toNumber(r.get('count')),
      projects: (r.get('projects') as string[]).filter(Boolean),
    }));
  } finally {
    await session.close();
  }
}

export async function fetchSemanticsForTag(driver: Driver, tag: string, tenantId: string = DEFAULT_TENANT): Promise<Array<{
  content: string; confidence: number; entities: string[];
}>> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (s:Semantic)
       WHERE $tag IN s.tags
         AND coalesce(s.archived, false) = false
         AND ${tenantWhere('s')}
       OPTIONAL MATCH (s)-[:ABOUT]->(e:Entity)
       RETURN s.content AS content, s.confidence AS confidence,
              collect(DISTINCT e.name) AS entities
       ORDER BY s.confidence DESC`,
      { tag, ...tenantParams(tenantId) },
    );
    return result.records.map((r) => ({
      content: r.get('content') as string,
      confidence: r.get('confidence') as number,
      entities: (r.get('entities') as string[]).filter(Boolean),
    }));
  } finally {
    await session.close();
  }
}

// ─── Stats ──────────────────────────────────────────────────────────────────

export async function fetchGraphStats(driver: Driver): Promise<{
  total_entities: number; total_facts: number; total_semantics: number; total_episodics: number; total_sources: number;
}> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (n)
       RETURN labels(n)[0] AS label, count(n) AS cnt`,
    );
    const counts: Record<string, number> = {};
    for (const r of result.records) {
      counts[r.get('label') as string] = toNumber(r.get('cnt'));
    }
    return {
      total_entities: counts['Entity'] ?? 0,
      total_facts: counts['Fact'] ?? 0,
      total_semantics: counts['Semantic'] ?? 0,
      total_episodics: counts['Episodic'] ?? 0,
      total_sources: counts['Source'] ?? 0,
    };
  } finally {
    await session.close();
  }
}

// ─── Inbound link count ─────────────────────────────────────────────────────

export async function fetchInboundLinkCount(driver: Driver, entityName: string, tenantId: string = DEFAULT_TENANT): Promise<number> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (s:Semantic)-[:ABOUT]->(e:Entity {name: $name})
       MATCH (s)-[:ABOUT]->(other:Entity)
       WHERE other.name <> $name
         AND coalesce(s.archived, false) = false
         AND ${tenantWhere('s')}
       RETURN count(DISTINCT other) AS cnt`,
      { name: entityName, ...tenantParams(tenantId) },
    );
    return toNumber(result.records[0]?.get('cnt') ?? 0);
  } finally {
    await session.close();
  }
}

// ─── Sources for an entity ──────────────────────────────────────────────────

export async function fetchSourcesForEntity(driver: Driver, entityName: string, tenantId: string = DEFAULT_TENANT): Promise<Array<{
  id: string; title: string; source_type: string; slug: string;
}>> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (s:Semantic)-[:ABOUT]->(e:Entity {name: $name})
       MATCH (s)-[:CITES]->(src:Source)
       WHERE coalesce(s.archived, false) = false
         AND ${tenantWhere('s')}
       RETURN DISTINCT src.id AS id, src.title AS title, src.source_type AS source_type
       ORDER BY title`,
      { name: entityName, ...tenantParams(tenantId) },
    );
    return result.records.map((r) => ({
      id: r.get('id') as string,
      title: (r.get('title') as string) ?? 'Untitled',
      source_type: (r.get('source_type') as string) ?? 'unknown',
      slug: slugify((r.get('title') as string) ?? r.get('id') as string),
    }));
  } finally {
    await session.close();
  }
}
