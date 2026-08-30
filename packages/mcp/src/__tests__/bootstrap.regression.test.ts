// packages/mcp/src/__tests__/bootstrap.regression.test.ts
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { resolveBootstrapRerankerModeV1 } from '../bootstrap.js';

const BOOTSTRAP_SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../bootstrap.ts'),
  'utf-8',
);
const COMPOSE_SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../../../../docker-compose.yml'),
  'utf-8',
);
const EXPERIMENTS = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '../../../../bench/lab/registry/experiments.json'),
  'utf-8',
)) as { experiments: Array<Record<string, unknown>> };

function parseComposePlannerValue(value: string | undefined): unknown {
  const template = COMPOSE_SOURCE.split(/\r?\n/)
    .find((line) => line.includes('MEMBERRY_QUERY_PLANNER_V1:'))
    ?.split('MEMBERRY_QUERY_PLANNER_V1: ')[1];
  if (template === undefined) return undefined;
  const interpolated = template.replace(
    '${MEMBERRY_QUERY_PLANNER_V1:-}',
    value === undefined || value.length === 0 ? '' : value,
  );
  if (interpolated.startsWith('"') && interpolated.endsWith('"')) {
    return JSON.parse(interpolated) as unknown;
  }
  const scalar = interpolated.trim();
  if (scalar.length === 0 || scalar === 'null' || scalar === '~') return null;
  if (scalar === 'true') return true;
  if (scalar === 'false') return false;
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(scalar)) return Number(scalar);
  return scalar;
}

function parseComposeCandidateValue(value: string | undefined): unknown {
  const template = COMPOSE_SOURCE.split(/\r?\n/)
    .find((line) => line.includes('MEMBERRY_CANDIDATE_CHANNEL_V1:'))
    ?.split('MEMBERRY_CANDIDATE_CHANNEL_V1: ')[1];
  if (template === undefined) return undefined;
  const interpolated = template.replace(
    '${MEMBERRY_CANDIDATE_CHANNEL_V1:-}',
    value === undefined || value.length === 0 ? '' : value,
  );
  if (interpolated.startsWith('"') && interpolated.endsWith('"')) return JSON.parse(interpolated) as unknown;
  return interpolated.trim();
}

function parseComposeRerankerMode(value: string | undefined): unknown {
  const template = COMPOSE_SOURCE.split(/\r?\n/)
    .find((line) => line.includes('MEMBERRY_RERANKER_V1:'))
    ?.split('MEMBERRY_RERANKER_V1: ')[1];
  if (template === undefined) return undefined;
  const interpolated = template.replace(
    '${MEMBERRY_RERANKER_V1:-}',
    value === undefined || value.length === 0 ? '' : value,
  );
  if (interpolated.startsWith('"') && interpolated.endsWith('"')) return JSON.parse(interpolated) as unknown;
  return interpolated.trim();
}

describe('bootstrap.ts regression', () => {
  it('RET-002C2 keeps runtime planning exact-value default-off and injects a driver-backed resolver', () => {
    expect(BOOTSTRAP_SOURCE).toContain("const queryPlannerEnabled = process.env['MEMBERRY_QUERY_PLANNER_V1'] === '1'");
    expect(BOOTSTRAP_SOURCE).toContain('new ScopedEntityResolver(driver, authority)');
  });
  it('RET-003B keeps candidate channels exact-value default-off and binds default plus dedicated drivers', () => {
    expect(BOOTSTRAP_SOURCE).toContain("const candidateChannelEnabled = process.env['MEMBERRY_CANDIDATE_CHANNEL_V1'] === '1'");
    expect(BOOTSTRAP_SOURCE).toContain('candidateDriver: driver');
    expect(BOOTSTRAP_SOURCE).toContain('dedicatedTenantCandidateDrivers.set(tenant, tcore.driver)');
    expect(BOOTSTRAP_SOURCE).toContain('tenantCandidateDrivers: dedicatedTenantCandidateDrivers');
    const mcpService = COMPOSE_SOURCE.split('\n  mcp:')[1]?.split('\n  wiki:')[0];
    const wikiService = COMPOSE_SOURCE.split('\n  wiki:')[1]?.split('\nvolumes:')[0];
    const exactEntry = 'MEMBERRY_CANDIDATE_CHANNEL_V1: "${MEMBERRY_CANDIDATE_CHANNEL_V1:-}"';
    expect(mcpService).toContain(exactEntry);
    expect(COMPOSE_SOURCE.split(exactEntry)).toHaveLength(2);
    expect(wikiService).not.toContain('MEMBERRY_CANDIDATE_CHANNEL_V1');
  });
  it.each([
    ['unset', undefined, ''], ['empty', '', ''], ['one', '1', '1'], ['leading zero', '01', '01'],
    ['decimal', '1.0', '1.0'], ['boolean-like', 'true', 'true'], ['trailing space', '1 ', '1 '],
  ] as const)('RET-003B preserves %s candidate input as a string', (_label, value, expected) => {
    expect(parseComposeCandidateValue(value)).toBe(expected);
  });
  it('RET-010D preserves the exact shadow coordinator and adds one served provider composition', () => {
    expect(BOOTSTRAP_SOURCE).toContain("resolveBootstrapRerankerModeV1(process.env['MEMBERRY_RERANKER_V1'])");
    expect(BOOTSTRAP_SOURCE).toContain('RERANKER_SHADOW_PROVIDER_IDENTITY');
    expect(BOOTSTRAP_SOURCE).toContain('baselineIdentityRerankerScoreV1');
    expect(BOOTSTRAP_SOURCE).toContain('await rerankerShadowCoordinator.shutdown()');
    expect(BOOTSTRAP_SOURCE).toContain('rerankerShadowSnapshot: () => rerankerShadowCoordinator.snapshot()');
    expect(BOOTSTRAP_SOURCE).not.toContain('rerankerShadowRedis');
    expect(BOOTSTRAP_SOURCE).not.toContain('rerankerShadowDriver');
    expect(BOOTSTRAP_SOURCE).not.toContain('[memberry-reranker-shadow]');
    expect(BOOTSTRAP_SOURCE.match(/createServedRerankerProviderV1\(\)/g)).toHaveLength(1);
    expect(BOOTSTRAP_SOURCE).toMatch(/new UnifiedAssembler\([\s\S]*?embedding,\s*llm,\s*servedReranker,\s*\)/);
  });
  it('RET-Q-004 keeps the episodic recall guard exact-value default-off and MCP-only', () => {
    expect(BOOTSTRAP_SOURCE).toContain("const episodicRecallEnabled = process.env['MEMBERRY_EPISODIC_RECALL_V1'] === '1'");
    expect(BOOTSTRAP_SOURCE).toContain('if (episodicRecallEnabled) unifiedAssembler.enableEpisodicRecallV1()');
    const mcpService = COMPOSE_SOURCE.split('\n  mcp:')[1]?.split('\n  wiki:')[0];
    const wikiService = COMPOSE_SOURCE.split('\n  wiki:')[1]?.split('\nvolumes:')[0];
    const exactEntry = 'MEMBERRY_EPISODIC_RECALL_V1: "${MEMBERRY_EPISODIC_RECALL_V1:-}"';
    expect(mcpService).toContain(exactEntry);
    expect(COMPOSE_SOURCE.split(exactEntry)).toHaveLength(2);
    expect(wikiService).not.toContain('MEMBERRY_EPISODIC_RECALL_V1');
  });
  it('RET-010D requires both authority switches for shadow and served before core effects', () => {
    expect(BOOTSTRAP_SOURCE).toContain("const queryPlannerEnabled = process.env['MEMBERRY_QUERY_PLANNER_V1'] === '1'");
    expect(BOOTSTRAP_SOURCE).toContain("const candidateChannelEnabled = process.env['MEMBERRY_CANDIDATE_CHANNEL_V1'] === '1'");
    expect(BOOTSTRAP_SOURCE).toContain("if (rerankerMode === 'shadow' && (!queryPlannerEnabled || !candidateChannelEnabled))");
    expect(BOOTSTRAP_SOURCE).toContain("throw new Error('reranker_shadow:prerequisite_unavailable')");
    expect(BOOTSTRAP_SOURCE).toContain("throw new Error('reranker_served:prerequisite_unavailable')");
    expect(BOOTSTRAP_SOURCE.indexOf('const rerankerMode = resolveBootstrapRerankerModeV1')).toBeLessThan(
      BOOTSTRAP_SOURCE.indexOf('const core = createCoreServices'),
    );
    expect(BOOTSTRAP_SOURCE.indexOf("if (rerankerMode === 'served'")).toBeLessThan(
      BOOTSTRAP_SOURCE.indexOf('const core = createCoreServices'),
    );
  });
  it.each([
    ['unset', undefined, 'disabled'], ['empty', '', 'disabled'], ['disabled', 'disabled', 'disabled'],
    ['shadow', 'shadow', 'shadow'], ['served', 'served', 'served'],
  ] as const)('RET-010D directly resolves accepted %s mode', (_label, raw, expected) => {
    expect(resolveBootstrapRerankerModeV1(raw)).toBe(expected);
  });
  it.each([
    ' ', ' disabled', 'disabled ', 'Disabled', 'SHADOW', 'Served', '1', 'true', 'enabled',
    'serve', 'shadow\0', '\tserved', 'served\r\n', 'undefined', 'null',
  ])('RET-010D rejects raw mode %j with one value-free error', (raw) => {
    let message = '';
    try { resolveBootstrapRerankerModeV1(raw); } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe('reranker_mode:invalid');
    expect(message).not.toContain(raw);
  });
  it.each([
    ['unset', undefined, ''], ['empty', '', ''], ['shadow', 'shadow', 'shadow'],
    ['numeric alias', '1', '1'], ['boolean alias', 'true', 'true'],
    ['leading space', ' shadow', ' shadow'], ['trailing space', 'shadow ', 'shadow '],
  ] as const)('RET-004B preserves %s reranker input exactly for fail-closed parsing', (_label, value, expected) => {
    expect(parseComposeRerankerMode(value)).toBe(expected);
  });
  it('RET-010D atomically supersedes the rollback-safe default-off experiment truth', () => {
    expect(EXPERIMENTS.experiments).toContainEqual({
      id: 'retrieval-reranker-v1',
      owner: 'retrieval-engine',
      flag: 'MEMBERRY_RERANKER_V1',
      defaultEnabled: false,
      control: 'memberry-live-mcp',
      rollback: 'Set MEMBERRY_RERANKER_V1=disabled or unset it, then restart. Local reranking is non-persistent; shadow observations remain content-free.',
    });
    expect(JSON.stringify(EXPERIMENTS)).not.toContain('retrieval-reranker-shadow-v1');
    expect(JSON.stringify(EXPERIMENTS)).not.toContain('shadow-only');
    expect(JSON.stringify(EXPERIMENTS)).not.toContain('returned context is always baseline-controlled');
    expect(BOOTSTRAP_SOURCE).not.toContain('MEMBERRY_RERANKER_MODE');
    expect(BOOTSTRAP_SOURCE).not.toContain('MEMBERRY_RERANKER_SHADOW_V1');
  });
  it('RET-002C2 passes the default-off planner flag only into the production MCP service', () => {
    const mcpService = COMPOSE_SOURCE.split('\n  mcp:')[1]?.split('\n  wiki:')[0];
    const wikiService = COMPOSE_SOURCE.split('\n  wiki:')[1]?.split('\nvolumes:')[0];
    const exactEntry = 'MEMBERRY_QUERY_PLANNER_V1: "${MEMBERRY_QUERY_PLANNER_V1:-}"';
    expect(mcpService).toContain(exactEntry);
    expect(COMPOSE_SOURCE.split(exactEntry)).toHaveLength(2);
    expect(wikiService).not.toContain('MEMBERRY_QUERY_PLANNER_V1');
  });
  it.each([
    ['unset', undefined, ''],
    ['empty', '', ''],
    ['one', '1', '1'],
    ['leading zero', '01', '01'],
    ['decimal', '1.0', '1.0'],
    ['boolean-like', 'true', 'true'],
    ['trailing space', '1 ', '1 '],
  ] as const)('RET-002C2 preserves %s planner input as a string', (_label, value, expected) => {
    expect(parseComposePlannerValue(value)).toBe(expected);
  });
  it('BUG-0007: apply adapter wraps reviewProposal in try/catch and returns failure on error', () => {
    // Before the fix, the apply adapter always returned { applied: true }
    // even when reviewProposal threw. The fix wraps it in try/catch
    // and returns { applied: false, error } on failure.

    // Verify the apply adapter contains a try/catch pattern
    const applyBlock = BOOTSTRAP_SOURCE.match(
      /apply:\s*async\s*\([^)]*\)\s*=>\s*\{([\s\S]*?)\n\s{4}\},/,
    );
    expect(applyBlock).not.toBeNull();

    const applyBody = applyBlock![1];

    // Must contain try/catch
    expect(applyBody).toContain('try');
    expect(applyBody).toContain('catch');

    // Must return applied: false on error path
    expect(applyBody).toContain('applied: false');
  });

  it('OPT-102: wires the episodic accessor into the ConsolidationEngine neo4j layer', () => {
    // Before the fix, bootstrap built `new ConsolidationEngine(redisLayer,
    // { semantic, fact }, config)` with NO episodic accessor, so in production
    // _deriveTenantFromEpisodes' episode-fetch path was dead — a promote/supersede
    // whose after.tenant_id is unset mis-attributed the consolidated semantic to
    // DEFAULT_TENANT in multi-tenant mode. The fix passes core.episodic (an
    // EpisodicStore exposing getById + getTenantsByIds, OPT-45) as the 2nd arg's
    // episodic accessor. (Engine-level derivation behaviour is covered by
    // consolidation.test.ts; this pins the prod wiring that activates it.)
    const ctorMatch = BOOTSTRAP_SOURCE.match(
      /new ConsolidationEngine\(([\s\S]*?)\n\s{2}\);/,
    );
    expect(ctorMatch).not.toBeNull();
    const ctorArgs = ctorMatch![1];

    // The neo4j-layer (2nd) arg must include the episodic accessor alongside
    // semantic + fact so the engine can read source episodes' tenant_id.
    expect(ctorArgs).toMatch(/\{\s*semantic,\s*episodic:\s*\{[\s\S]*?fact:\s*factStoreInstance/);

    // And episodic must be destructured from the core service kit (between
    // scopedQuery and factStore) — not a stray identifier.
    expect(BOOTSTRAP_SOURCE).toMatch(/scopedQuery,\s*episodic,\s*factStore:/);
  });
});
