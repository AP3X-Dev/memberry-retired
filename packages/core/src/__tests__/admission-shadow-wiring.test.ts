import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');

describe('MEM-001C composition and shutdown wiring', () => {
  it('injects shadow work only when enabled and stops it before shared clients close', () => {
    const source = readFileSync(resolve(REPO_ROOT, 'packages/core/src/services-factory.ts'), 'utf8');
    expect(source).toContain('admissionShadowConfig.enabled ? admissionShadow : undefined');

    const stop = source.indexOf('await admissionShadow.stopAndDrain()');
    const redis = source.indexOf('await redis.quit()');
    const driver = source.indexOf('await driver.close()');
    expect(stop).toBeGreaterThan(-1);
    expect(stop).toBeLessThan(redis);
    expect(redis).toBeLessThan(driver);
  });

  it('keeps readiness additive and leaves healthz byte-shape untouched', () => {
    const source = readFileSync(resolve(REPO_ROOT, 'packages/mcp/src/server.ts'), 'utf8');
    const healthStart = source.indexOf("pathname === '/healthz'");
    const readyStart = source.indexOf("pathname === '/readyz'");
    const healthBody = source.slice(healthStart, readyStart);
    expect(healthBody).toContain("statusPayload('ok')");
    expect(healthBody).not.toContain('admission_shadow');
    expect(source.slice(readyStart)).toContain('admission_shadow: getAdmissionShadowProcessStatus()');
  });

  it('keeps admission shadow out of the unauthenticated wiki settings surface', () => {
    const source = readFileSync(resolve(REPO_ROOT, 'packages/core/src/config/status.ts'), 'utf8');
    expect(source).not.toContain('resolveAdmissionShadowConfig');
    expect(source).not.toContain('admissionShadow');
  });

  it('registers default and dedicated readiness sources as one rollback-safe batch', () => {
    const source = readFileSync(resolve(REPO_ROOT, 'packages/mcp/src/bootstrap.ts'), 'utf8');
    expect(source).toContain('registerAdmissionShadowStatusSources([');
    expect(source).not.toContain('registerAdmissionShadowStatusSource(core.admissionShadow)');
  });
});
