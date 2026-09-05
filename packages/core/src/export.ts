// packages/core/src/export.ts
import fs from 'fs/promises';
import { mkdirSync } from 'fs';
import path from 'path';
import neo4j, { type Driver } from 'neo4j-driver';
import { renderToMarkdown } from './markdown.js';
import { DEFAULT_TENANT, type SemanticNode, type EpisodicNode } from './types.js';

// ─── Result Types ─────────────────────────────────────────────────────────────

export interface ExportResult {
  exported: number;
  skipped: number;
  errors: string[];
}

export interface ExportFilter {
  entities?: string[];
  tags?: string[];
}

export interface ExportOptions {
  /** Tenant to export (default tenant also matches legacy nodes with no tenant_id). */
  tenantId?: string;
  /** Pull embeddings over the wire. Markdown never carries them, so default off. */
  includeEmbeddings?: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mapSemanticProps(props: Record<string, unknown>): SemanticNode {
  return {
    id: props.id as string,
    content: props.content as string,
    confidence: props.confidence as number,
    signal_count: props.signal_count as number,
    created_at: props.created_at as string,
    updated_at: props.updated_at as string,
    decay_class: props.decay_class as SemanticNode['decay_class'],
    tags: (props.tags as string[]) ?? [],
    // MEM-006: the archived flag must survive canonical export/import.
    ...(props.archived === true ? { archived: true } : {}),
  };
}

function mapEpisodicProps(props: Record<string, unknown>): EpisodicNode {
  return {
    id: props.id as string,
    session_id: props.session_id as string,
    agent_id: props.agent_id as string,
    task: props.task as string,
    content: props.content as string,
    outcome: props.outcome as EpisodicNode['outcome'] ?? undefined,
    created_at: props.created_at as string,
    ttl: props.ttl != null ? (props.ttl as number) : undefined,
    ...(props.archived === true ? { archived: true } : {}),
  };
}

async function writeNodeFile(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

// ─── Tenant bound + paging (audit C1) ─────────────────────────────────────────

const PAGE_SIZE = 500;

/** Same predicate shape as @memberry/neo4j episodic/lifecycle reads (params: $tenantId, $defaultTenant). */
function tenantWhere(alias: string): string {
  return `(${alias}.tenant_id = $tenantId OR (${alias}.tenant_id IS NULL AND $tenantId = $defaultTenant))`;
}

function tenantParams(opts: ExportOptions): Record<string, unknown> {
  return { tenantId: opts.tenantId?.trim() || DEFAULT_TENANT, defaultTenant: DEFAULT_TENANT };
}

/**
 * Run `match` (a MATCH ... WHERE ... fragment binding `alias`) page by page and
 * return every node's property map. Embeddings are nulled at the wire unless
 * `includeEmbeddings` is set — the markdown export never writes them.
 */
async function fetchPaged(
  driver: Driver,
  match: string,
  alias: string,
  params: Record<string, unknown>,
  opts: ExportOptions,
): Promise<Record<string, unknown>[]> {
  const ret = opts.includeEmbeddings ? alias : `${alias}{.*, embedding: null}`;
  const cypher = `${match}
      WITH DISTINCT ${alias} ORDER BY ${alias}.id SKIP $skip LIMIT $limit
      RETURN ${ret} AS ${alias}`;
  const out: Record<string, unknown>[] = [];
  const session = driver.session();
  try {
    for (let skip = 0; ; skip += PAGE_SIZE) {
      const result = await session.run(cypher, {
        ...params, ...tenantParams(opts), skip: neo4j.int(skip), limit: neo4j.int(PAGE_SIZE),
      });
      for (const record of result.records) {
        const raw = record.get(alias) as { properties?: Record<string, unknown> } | Record<string, unknown>;
        out.push(('properties' in raw && raw.properties ? raw.properties : raw) as Record<string, unknown>);
      }
      if (result.records.length < PAGE_SIZE) break;
    }
  } finally {
    await session.close();
  }
  return out;
}

const EPISODIC_MATCH = `MATCH (e:Episodic) WHERE ${tenantWhere('e')}`;

// ─── exportAll ────────────────────────────────────────────────────────────────

/**
 * Export all Semantic and Episodic nodes from Neo4j to markdown files.
 * Semantic nodes → {exportPath}/semantic/{id}.md
 * Episodic nodes → {exportPath}/episodic/{YYYY-MM-DD}/{id}.md
 */
export async function exportAll(
  driver: Driver,
  exportPath: string,
  opts: ExportOptions = {},
): Promise<ExportResult> {
  let exported = 0;
  let skipped = 0;
  const errors: string[] = [];

  // ── Semantic nodes ──────────────────────────────────────────────────────────
  {
    try {
      const rows = await fetchPaged(driver, `MATCH (s:Semantic) WHERE ${tenantWhere('s')}`, 's', {}, opts);
      for (const props of rows) {
        const node = mapSemanticProps(props);
        const filePath = path.join(exportPath, 'semantic', `${node.id}.md`);
        try {
          const md = renderToMarkdown(node);
          await writeNodeFile(filePath, md);
          exported++;
        } catch (err) {
          errors.push(`semantic/${node.id}: ${err instanceof Error ? err.message : String(err)}`);
          skipped++;
        }
      }
    } catch (err) {
      errors.push(`Failed to query Semantic nodes: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Episodic nodes ──────────────────────────────────────────────────────────
  {
    try {
      const rows = await fetchPaged(driver, EPISODIC_MATCH, 'e', {}, opts);
      for (const props of rows) {
        const node = mapEpisodicProps(props);
        // Group by date from created_at (YYYY-MM-DD)
        const date = node.created_at.slice(0, 10);
        const filePath = path.join(exportPath, 'episodic', date, `${node.id}.md`);
        try {
          const md = renderToMarkdown(node);
          await writeNodeFile(filePath, md);
          exported++;
        } catch (err) {
          errors.push(`episodic/${node.id}: ${err instanceof Error ? err.message : String(err)}`);
          skipped++;
        }
      }
    } catch (err) {
      errors.push(`Failed to query Episodic nodes: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { exported, skipped, errors };
}

// ─── exportFiltered ───────────────────────────────────────────────────────────

/**
 * Export Semantic nodes filtered by entity names and/or tags.
 * Episodic export is always unfiltered in v1.
 */
export async function exportFiltered(
  driver: Driver,
  exportPath: string,
  filter: ExportFilter,
  opts: ExportOptions = {},
): Promise<ExportResult> {
  let exported = 0;
  let skipped = 0;
  const errors: string[] = [];

  const { entities = [], tags = [] } = filter;

  // Build filtered Cypher query for Semantic nodes
  let cypher: string;
  const params: Record<string, unknown> = {};

  if (entities.length > 0 && tags.length > 0) {
    params.entities = entities;
    params.tags = tags;
    cypher = `
      MATCH (s:Semantic)-[:ABOUT]->(e:Entity)
      WHERE e.name IN $entities AND ANY(t IN $tags WHERE t IN s.tags) AND ${tenantWhere('s')}`;
  } else if (entities.length > 0) {
    params.entities = entities;
    cypher = `
      MATCH (s:Semantic)-[:ABOUT]->(e:Entity)
      WHERE e.name IN $entities AND ${tenantWhere('s')}`;
  } else if (tags.length > 0) {
    params.tags = tags;
    cypher = `
      MATCH (s:Semantic)
      WHERE ANY(t IN $tags WHERE t IN s.tags) AND ${tenantWhere('s')}`;
  } else {
    // No filters — fall back to full export
    return exportAll(driver, exportPath, opts);
  }

  // ── Filtered Semantic nodes ─────────────────────────────────────────────────
  {
    try {
      const rows = await fetchPaged(driver, cypher, 's', params, opts);
      for (const props of rows) {
        const node = mapSemanticProps(props);
        const filePath = path.join(exportPath, 'semantic', `${node.id}.md`);
        try {
          const md = renderToMarkdown(node);
          await writeNodeFile(filePath, md);
          exported++;
        } catch (err) {
          errors.push(`semantic/${node.id}: ${err instanceof Error ? err.message : String(err)}`);
          skipped++;
        }
      }
    } catch (err) {
      errors.push(`Failed to query filtered Semantic nodes: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Episodic nodes (unfiltered in v1) ───────────────────────────────────────
  {
    try {
      const rows = await fetchPaged(driver, EPISODIC_MATCH, 'e', {}, opts);
      for (const props of rows) {
        const node = mapEpisodicProps(props);
        const date = node.created_at.slice(0, 10);
        const filePath = path.join(exportPath, 'episodic', date, `${node.id}.md`);
        try {
          const md = renderToMarkdown(node);
          await writeNodeFile(filePath, md);
          exported++;
        } catch (err) {
          errors.push(`episodic/${node.id}: ${err instanceof Error ? err.message : String(err)}`);
          skipped++;
        }
      }
    } catch (err) {
      errors.push(`Failed to query Episodic nodes: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { exported, skipped, errors };
}
