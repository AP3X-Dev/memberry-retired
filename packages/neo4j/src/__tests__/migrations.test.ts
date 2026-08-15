// packages/neo4j/src/__tests__/migrations.test.ts
//
// Unit tests for the forward-only migration runner. These use a mock driver so
// they run without a live Neo4j (the integration behaviour is covered by the
// infra-gated schema.test.ts).

import { describe, it, expect, vi } from 'vitest';
import { MIGRATIONS, runMigrations, SCHEMA_VERSION_ID, type Migration } from '../migrations.js';

/**
 * Mock driver that simulates the :SchemaVersion node. Reads return the current
 * applied list; MERGE writes update it. Records every up() that ran.
 */
function makeMockDriver(initialApplied: string[] = []) {
  let applied = [...initialApplied];
  const session = {
    run: vi.fn(async (cypher: string, params?: Record<string, unknown>) => {
      if (cypher.includes('RETURN v.applied')) {
        return {
          records: applied.length === 0 && initialApplied.length === 0
            ? []
            : [{ get: (k: string) => (k === 'applied' ? applied : undefined) }],
        };
      }
      if (cypher.includes('MERGE (v:SchemaVersion')) {
        applied = (params?.['applied'] as string[]) ?? applied;
        return { records: [] };
      }
      return { records: [] };
    }),
    close: vi.fn(),
  };
  return {
    driver: { session: vi.fn(() => session) } as any,
    getApplied: () => applied,
    session,
  };
}

function migration(id: string, ran: string[]): Migration {
  return { id, description: id, up: async () => { ran.push(id); } };
}

describe('runMigrations', () => {
  it('applies all migrations on a fresh graph, in order, and records them', async () => {
    const ran: string[] = [];
    const migrations = [migration('0001-a', ran), migration('0002-b', ran), migration('0003-c', ran)];
    const { driver, getApplied } = makeMockDriver();

    const result = await runMigrations(driver, migrations);

    expect(ran).toEqual(['0001-a', '0002-b', '0003-c']);
    expect(result.applied).toEqual(['0001-a', '0002-b', '0003-c']);
    expect(result.skipped).toEqual([]);
    expect(result.version).toBe(3);
    expect(getApplied()).toEqual(['0001-a', '0002-b', '0003-c']);
  });

  it('skips already-applied migrations (idempotent) and only runs the new one', async () => {
    const ran: string[] = [];
    const migrations = [migration('0001-a', ran), migration('0002-b', ran), migration('0003-c', ran)];
    const { driver } = makeMockDriver(['0001-a', '0002-b']);

    const result = await runMigrations(driver, migrations);

    // Only the genuinely-new migration runs its up().
    expect(ran).toEqual(['0003-c']);
    expect(result.applied).toEqual(['0003-c']);
    expect(result.skipped).toEqual(['0001-a', '0002-b']);
    expect(result.version).toBe(3);
  });

  it('is a no-op when everything is already applied', async () => {
    const ran: string[] = [];
    const migrations = [migration('0001-a', ran)];
    const { driver } = makeMockDriver(['0001-a']);

    const result = await runMigrations(driver, migrations);

    expect(ran).toEqual([]);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(['0001-a']);
  });

  it('records progress after each migration so a crash does not replay completed ones', async () => {
    const ran: string[] = [];
    const boom = new Error('migration 2 failed');
    const migrations: Migration[] = [
      migration('0001-a', ran),
      { id: '0002-b', description: 'b', up: async () => { throw boom; } },
      migration('0003-c', ran),
    ];
    const { driver, getApplied } = makeMockDriver();

    await expect(runMigrations(driver, migrations)).rejects.toThrow('migration 2 failed');

    // 0001 ran and was persisted before 0002 threw; 0003 never ran.
    expect(ran).toEqual(['0001-a']);
    expect(getApplied()).toEqual(['0001-a']);
  });

  it('uses the canonical SchemaVersion id', () => {
    expect(SCHEMA_VERSION_ID).toBe('memberry-schema');
  });

  it('0007 is directly repeatable and every schema statement is fail-safe', async () => {
    const target = MIGRATIONS.find((item) => item.id === '0007-admission-observation-sidecar');
    expect(target).toBeDefined();
    const run = vi.fn(async () => ({ records: [] }));
    const close = vi.fn(async () => undefined);
    const driver = { session: vi.fn(() => ({ run, close })) } as any;

    await target!.up(driver);
    await target!.up(driver);

    expect(run).toHaveBeenCalledTimes(4);
    for (const [statement] of run.mock.calls) expect(statement).toContain('IF NOT EXISTS');
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('safely replays 0007 after schema success but migration-record ambiguity', async () => {
    const prior = MIGRATIONS.slice(0, 6).map((item) => item.id);
    let applied = [...prior];
    let failRecordOnce = true;
    const schemaStatements: string[] = [];
    const run = vi.fn(async (cypher: string, params?: Record<string, unknown>) => {
      if (cypher.includes('RETURN v.applied')) {
        return { records: [resultRecord({ applied })] };
      }
      if (cypher.includes('MERGE (v:SchemaVersion')) {
        if (failRecordOnce) { failRecordOnce = false; throw new Error('ambiguous migration record'); }
        applied = params?.applied as string[];
        return { records: [] };
      }
      schemaStatements.push(cypher);
      return { records: [] };
    });
    const driver = { session: vi.fn(() => ({ run, close: vi.fn(async () => undefined) })) } as any;

    await expect(runMigrations(driver)).rejects.toThrow('ambiguous migration record');
    await expect(runMigrations(driver)).resolves.toMatchObject({
      applied: ['0007-admission-observation-sidecar'],
    });
    expect(schemaStatements).toHaveLength(4);
    expect(schemaStatements.every((statement) => statement.includes('IF NOT EXISTS'))).toBe(true);
  });
});

function resultRecord(values: Record<string, unknown>) {
  return { get: (key: string) => values[key] };
}
