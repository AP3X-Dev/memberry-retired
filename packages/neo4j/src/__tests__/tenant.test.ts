// packages/neo4j/src/__tests__/tenant.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { tenantWhere, resolveTenant, isDefaultTenant, TENANT_PARAM } from '../tenant.js';
import { DEFAULT_TENANT } from '@memberry/core';

describe('tenantWhere', () => {
  it('default tenant also matches legacy nodes with no tenant_id', () => {
    const clause = tenantWhere('s', DEFAULT_TENANT);
    expect(clause).toBe(`(s.tenant_id IS NULL OR s.tenant_id = $${TENANT_PARAM})`);
  });

  it('a non-default tenant matches STRICTLY (never legacy/default data)', () => {
    const clause = tenantWhere('s', 'acme');
    expect(clause).toBe(`s.tenant_id = $${TENANT_PARAM}`);
    // The strict clause must NOT include the IS NULL escape hatch.
    expect(clause).not.toContain('IS NULL');
  });

  it('binds via a parameter, never interpolates the tenant id (injection-safe)', () => {
    const clause = tenantWhere('s', "acme' OR '1'='1");
    // The raw value never appears in the clause — only the parameter reference.
    expect(clause).toBe(`s.tenant_id = $${TENANT_PARAM}`);
    expect(clause).not.toContain("OR '1'='1");
  });

  it('uses the given alias', () => {
    expect(tenantWhere('node', 'acme')).toBe(`node.tenant_id = $${TENANT_PARAM}`);
  });
});

describe('resolveTenant', () => {
  it('defaults empty/undefined/whitespace to DEFAULT_TENANT', () => {
    expect(resolveTenant(undefined)).toBe(DEFAULT_TENANT);
    expect(resolveTenant(null)).toBe(DEFAULT_TENANT);
    expect(resolveTenant('')).toBe(DEFAULT_TENANT);
    expect(resolveTenant('   ')).toBe(DEFAULT_TENANT);
  });
  it('trims and preserves a real tenant id', () => {
    expect(resolveTenant('  acme ')).toBe('acme');
  });
});

describe('isDefaultTenant', () => {
  it('treats empty/undefined as default, a named tenant as non-default', () => {
    expect(isDefaultTenant(undefined)).toBe(true);
    expect(isDefaultTenant(DEFAULT_TENANT)).toBe(true);
    expect(isDefaultTenant('acme')).toBe(false);
  });
});

describe('MEMBERRY_STRICT_TENANT — omission discovery mode', () => {
  const prior = process.env.MEMBERRY_STRICT_TENANT;
  afterEach(() => {
    if (prior === undefined) delete process.env.MEMBERRY_STRICT_TENANT;
    else process.env.MEMBERRY_STRICT_TENANT = prior;
  });

  it('is OFF by default — an omitted tenant still resolves to the default', () => {
    delete process.env.MEMBERRY_STRICT_TENANT;
    expect(resolveTenant(undefined)).toBe(DEFAULT_TENANT);
    expect(resolveTenant(null)).toBe(DEFAULT_TENANT);
    expect(resolveTenant('   ')).toBe(DEFAULT_TENANT);
  });

  it('only arms on the exact value "1", so a stray truthy string cannot change production', () => {
    for (const v of ['0', 'true', 'yes', '']) {
      process.env.MEMBERRY_STRICT_TENANT = v;
      expect(resolveTenant(undefined)).toBe(DEFAULT_TENANT);
    }
  });

  it('throws on an OMITTED tenant when armed', () => {
    process.env.MEMBERRY_STRICT_TENANT = '1';
    expect(() => resolveTenant(undefined)).toThrow(/MEMBERRY_STRICT_TENANT/);
    expect(() => resolveTenant(null)).toThrow(/MEMBERRY_STRICT_TENANT/);
    expect(() => resolveTenant('  ')).toThrow(/MEMBERRY_STRICT_TENANT/);
  });

  it('does NOT throw on an explicit tenant, including an explicit default', () => {
    process.env.MEMBERRY_STRICT_TENANT = '1';
    expect(resolveTenant(DEFAULT_TENANT)).toBe(DEFAULT_TENANT);
    expect(resolveTenant('acme')).toBe('acme');
  });

  it('catches omission, NOT incorrectness — a wrong tenant passes silently either way', () => {
    // Stated as a test so the limit is not rediscovered as a surprise: strict mode is about a
    // MISSING tenant. Handing it the wrong one is indistinguishable from handing it the right one.
    process.env.MEMBERRY_STRICT_TENANT = '1';
    expect(resolveTenant('globex')).toBe('globex');
  });
});
