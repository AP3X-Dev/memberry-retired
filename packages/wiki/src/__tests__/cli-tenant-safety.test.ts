import { describe, expect, it } from 'vitest';
import { assertWikiTenantSafe } from '../tenant-safety.js';

describe('wiki logical multi-tenant fail-closed guard', () => {
  it.each(['compile', 'serve', 'build', 'lint'])('rejects %s against a shared tenant graph', (command) => {
    expect(() => assertWikiTenantSafe(command, 'acme:secret')).toThrow(/disabled.*multi-tenant/i);
  });

  it('keeps single-tenant and non-publishing commands available', () => {
    expect(() => assertWikiTenantSafe('build', '')).not.toThrow();
    expect(() => assertWikiTenantSafe('lint', '')).not.toThrow();
    expect(() => assertWikiTenantSafe('sync', 'acme:secret')).not.toThrow();
    expect(() => assertWikiTenantSafe('help', 'acme:secret')).not.toThrow();
  });
});
