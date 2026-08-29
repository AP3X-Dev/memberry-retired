// packages/neo4j/src/tenant.ts
//
// Tenant isolation primitive for logical (shared-graph) multi-tenancy.
//
// Every tenant-scoped read ANDs `tenantWhere(alias, tenantId)` into its WHERE
// clause; every write stamps `tenant_id`. The tenant id is bound as the Cypher
// parameter `$tenantId` (never string-interpolated), so it is injection-safe
// even though it originates from a trusted token→tenant mapping.
//
// Back-compat: the DEFAULT tenant also matches legacy nodes that have no
// `tenant_id` property, so enabling multi-tenancy needs no data migration. A
// NON-default tenant matches strictly — it can never see legacy/default data.

import { DEFAULT_TENANT } from '@memberry/core';

export const TENANT_PARAM = 'tenantId';

/**
 * Cypher WHERE-fragment scoping node `alias` to `tenantId` (bound as $tenantId).
 *
 *   default tenant     → (a.tenant_id IS NULL OR a.tenant_id = $tenantId)
 *   non-default tenant →  a.tenant_id = $tenantId
 */
export function tenantWhere(alias: string, tenantId: string): string {
  if (tenantId === DEFAULT_TENANT) {
    return `(${alias}.tenant_id IS NULL OR ${alias}.tenant_id = $${TENANT_PARAM})`;
  }
  return `${alias}.tenant_id = $${TENANT_PARAM}`;
}

/**
 * Strict mode — a DISCOVERY tool, default OFF, production behaviour unchanged.
 *
 * `resolveTenant` cannot tell "this call site legitimately has no tenant" from "this call site
 * had one and dropped it". Both arrive as `undefined` and both silently become DEFAULT_TENANT,
 * which is why an omission is invisible on a single-tenant graph — every row is `default`, so
 * the wrong answer and the right answer are the same bytes.
 *
 * Set `MEMBERRY_STRICT_TENANT=1` and run the suite: every path reaching `resolveTenant` without a
 * tenant throws with a stack trace. Measured 2026-08-28 on `packages/neo4j` — 39 failures across
 * 5 files, against 551 passing with it off.
 *
 * Read that as a STARTING INVENTORY, not a work list. It cannot distinguish a production omission
 * from a test double that simply never bothered with a tenant, and most of those 39 are the
 * latter. Triage is the point; the tool only makes the omissions visible, which on a single-tenant
 * graph they otherwise are not.
 *
 * What this does NOT do, so nobody mistakes it for isolation: it catches an OMITTED tenant, never
 * an INCORRECT one, and it says nothing about queries that never reference the tenant at all —
 * see RESEARCH-LEDGER.md RL-019, which is the larger finding (`entity-resolver.ts` alone has 8
 * query call sites and no tenant predicate).
 */
const STRICT_TENANT = (): boolean => process.env.MEMBERRY_STRICT_TENANT === '1';

/** Normalize an optional tenant id to a concrete one (defaults to DEFAULT_TENANT). */
export function resolveTenant(tenantId?: string | null): string {
  const t = (tenantId ?? '').trim();
  if (t.length === 0 && STRICT_TENANT()) {
    throw new Error(
      'MEMBERRY_STRICT_TENANT: resolveTenant() called with no tenant. This is a discovery mode — '
      + 'the omitted tenant would silently become the default tenant. See RESEARCH-LEDGER.md RL-019.',
    );
  }
  return t.length > 0 ? t : DEFAULT_TENANT;
}

/** True when the given tenant is the default (single-tenant / legacy) tenant. */
export function isDefaultTenant(tenantId?: string | null): boolean {
  return resolveTenant(tenantId) === DEFAULT_TENANT;
}
