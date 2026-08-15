// packages/neo4j/src/tenant-admin.ts
//
// Per-tenant administration: count, export, and delete all of one tenant's
// memory. Used by the `memberry tenant` CLI for operator workflows (offboarding,
// GDPR-style erasure, backup of a single tenant).
//
// Safety: delete refuses the implicit `default` tenant, because the default
// tenant also owns legacy rows with no tenant_id — a strict tenant_id match is
// used so a named tenant's delete can only ever touch that tenant's nodes.

import { type Driver } from 'neo4j-driver';
import { DEFAULT_TENANT } from '@memberry/core';

/** Tenant-scoped node labels (the memory surface that carries tenant_id). */
const TENANT_LABELS = ['Episodic', 'Semantic', 'Fact', 'MemoryBlock'] as const;
type TenantLabel = (typeof TENANT_LABELS)[number];

export type TenantCounts = Record<TenantLabel, number>;
export type TenantExport = Record<TenantLabel, Array<Record<string, unknown>>>;

function assertNamedTenant(tenant: string, op: string): void {
  if (!tenant || tenant.trim() === '' || tenant === DEFAULT_TENANT) {
    throw new Error(
      `Refusing to ${op} the "${DEFAULT_TENANT}" tenant: it also owns legacy data with no tenant_id. ` +
      `Pass an explicit named tenant.`,
    );
  }
}

export class TenantAdmin {
  constructor(private driver: Driver) {}

  /** Count this tenant's nodes per label (strict tenant_id match). */
  async stats(tenant: string): Promise<TenantCounts> {
    const session = this.driver.session();
    try {
      const counts = {} as TenantCounts;
      for (const label of TENANT_LABELS) {
        const res = await session.run(
          `MATCH (n:${label} {tenant_id: $tenant}) RETURN count(n) AS c`,
          { tenant },
        );
        counts[label] = Number(res.records[0]?.get('c') ?? 0);
      }
      return counts;
    } finally {
      await session.close();
    }
  }

  /** Export this tenant's nodes (properties) per label. */
  async export(tenant: string): Promise<TenantExport> {
    const session = this.driver.session();
    try {
      const out = {} as TenantExport;
      for (const label of TENANT_LABELS) {
        const res = await session.run(
          `MATCH (n:${label} {tenant_id: $tenant}) RETURN n`,
          { tenant },
        );
        out[label] = res.records.map((r) => r.get('n').properties as Record<string, unknown>);
      }
      return out;
    } finally {
      await session.close();
    }
  }

  /** Permanently delete all of a NAMED tenant's nodes. Refuses the default tenant. */
  async delete(tenant: string): Promise<TenantCounts> {
    assertNamedTenant(tenant, 'delete');
    const before = await this.stats(tenant);
    const session = this.driver.session();
    try {
      // AdmissionObservation is intentionally absent from TenantCounts/export:
      // it is an internal shadow sidecar, not another memory category. Remove it
      // before Episodic nodes so OBSERVES never keeps tenant-owned sidecars alive.
      await session.run(
        `MATCH (o:AdmissionObservation {tenant_id: $tenant})
         CALL { WITH o DETACH DELETE o } IN TRANSACTIONS OF 1000 ROWS`,
        { tenant },
      );
      for (const label of TENANT_LABELS) {
        // Batch to avoid a huge single transaction on large tenants.
        await session.run(
          `MATCH (n:${label} {tenant_id: $tenant})
           CALL { WITH n DETACH DELETE n } IN TRANSACTIONS OF 1000 ROWS`,
          { tenant },
        );
      }
    } finally {
      await session.close();
    }
    return before; // counts removed
  }
}
