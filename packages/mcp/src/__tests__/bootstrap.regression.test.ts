// packages/mcp/src/__tests__/bootstrap.regression.test.ts
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const BOOTSTRAP_SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../bootstrap.ts'),
  'utf-8',
);
const COMPOSE_SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../../../../docker-compose.yml'),
  'utf-8',
);

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

describe('bootstrap.ts regression', () => {
  it('RET-002C2 keeps runtime planning exact-value default-off and injects a driver-backed resolver', () => {
    expect(BOOTSTRAP_SOURCE).toContain("queryPlannerEnabled: process.env['MEMBERRY_QUERY_PLANNER_V1'] === '1'");
    expect(BOOTSTRAP_SOURCE).toContain('new ScopedEntityResolver(driver, authority)');
  });
  it('RET-003B keeps candidate channels exact-value default-off and binds default plus dedicated drivers', () => {
    expect(BOOTSTRAP_SOURCE).toContain("candidateChannelEnabled: process.env['MEMBERRY_CANDIDATE_CHANNEL_V1'] === '1'");
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
