/** Fail closed rather than publish a cross-tenant wiki from global graph queries. */
export function assertWikiTenantSafe(
  command: string,
  tenantTokens = process.env['MEMBERRY_TENANT_TOKENS'],
): void {
  if (tenantTokens?.trim() && ['compile', 'serve', 'build', 'lint'].includes(command)) {
    throw new Error(
      'Wiki compile/viewer is disabled in shared logical multi-tenant mode because generation is not tenant-qualified.',
    );
  }
}
