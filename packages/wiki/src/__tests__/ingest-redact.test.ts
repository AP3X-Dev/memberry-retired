// packages/wiki/src/__tests__/ingest-redact.test.ts
// OPT-12: berry_ingest / berry_braindump must honor MEMBERRY_REDACT_ON_INGEST,
// mirroring AmpService.store. Untrusted content persisted on the ingest path
// (pre-extracted claim content, brain-dump verbatim claims) must be redacted
// when the flag is on, and left verbatim when it is off (no behavior change).

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Driver, Session, Result } from 'neo4j-driver';
import { IngestionService } from '../ingest.js';

function mockRecord(data: Record<string, unknown>) {
  return { get: (k: string) => data[k], keys: Object.keys(data) };
}
function mockResult(records: ReturnType<typeof mockRecord>[] = []): Result {
  return { records } as unknown as Result;
}

interface RunCall { query: string; params: Record<string, unknown>; }

function createMockDriver(): { driver: Driver; calls: () => RunCall[] } {
  const calls: RunCall[] = [];
  const session = {
    run: vi.fn(async (query: string, params: Record<string, unknown> = {}) => {
      calls.push({ query, params });
      if (query.includes('MERGE (e:Entity')) return mockResult([mockRecord({ id: 'ent-x', created: true })]);
      if (query.includes('RETURN e.id AS id')) return mockResult([mockRecord({ id: 'ent-x' })]);
      if (query.includes('MERGE (s:Semantic')) return mockResult([mockRecord({ id: 'sem-x', isNew: true })]);
      return mockResult([]);
    }),
    close: vi.fn(async () => {}),
  } as unknown as Session;
  const driver = { session: vi.fn(() => session) } as unknown as Driver;
  return { driver, calls: () => calls };
}

/** All content strings persisted onto Semantic nodes. */
function semanticContents(calls: RunCall[]): string[] {
  return calls
    .filter((c) => c.query.includes('MERGE (s:Semantic'))
    .map((c) => String(c.params.content));
}

const SECRET_BODY =
  'My OpenAI key is sk-abcdEFGH1234567890 and password: hunter2trustno1 ' +
  'and config is {"api_key":"sk-anotherkeyvalue123","b":"keep"}';

afterEach(() => {
  delete process.env.MEMBERRY_REDACT_ON_INGEST;
});

describe('IngestionService — redactOnIngest (OPT-12)', () => {
  // ─── Flag ON: secrets masked everywhere untrusted content is persisted ──────

  it('redacts secrets in brain-dump verbatim claims when the flag is enabled', async () => {
    const { driver, calls } = createMockDriver();
    // Enabled via explicit constructor flag (mirrors AmpService config.redactOnIngest).
    const service = new IngestionService(driver, undefined, undefined, true);

    await service.ingest({
      content: SECRET_BODY,
      source_type: 'note',
      project_tag: 'project:user-personal',
      author: 'human', // triggers the verbatim-claim fallback
    });

    const contents = semanticContents(calls());
    expect(contents.length).toBeGreaterThan(0);
    const joined = contents.join('\n');
    // No raw secret survives into persisted content.
    expect(joined).not.toContain('sk-abcdEFGH1234567890');
    expect(joined).not.toContain('sk-anotherkeyvalue123');
    expect(joined).not.toContain('hunter2trustno1');
    expect(joined).toContain('[REDACTED]');
    // Non-secret sibling content is preserved (no over-redaction).
    expect(joined).toContain('keep');
  });

  it('redacts secrets in pre-extracted claim content when the flag is enabled', async () => {
    const { driver, calls } = createMockDriver();
    const service = new IngestionService(driver, undefined, undefined, true);

    await service.ingest({
      content: 'doc body',
      source_type: 'article',
      project_tag: 'project:test',
      claims: [
        { content: 'The token is sk-abcdEFGH1234567890 do not share', about: ['auth'] },
        { content: 'JSON dump {"password":"hunter2trustno1","ok":"1"}', about: ['auth'] },
      ],
    });

    const joined = semanticContents(calls()).join('\n');
    expect(joined).not.toContain('sk-abcdEFGH1234567890');
    expect(joined).not.toContain('hunter2trustno1');
    expect(joined).toContain('[REDACTED]');
    // Surrounding prose / sibling keys intact.
    expect(joined).toContain('do not share');
    expect(joined).toContain('"ok"');
  });

  it('respects MEMBERRY_REDACT_ON_INGEST=true read from env (same mechanism as service.ts)', async () => {
    process.env.MEMBERRY_REDACT_ON_INGEST = 'true';
    const { driver, calls } = createMockDriver();
    // No explicit flag -> falls back to the env, exactly like services-factory.ts.
    const service = new IngestionService(driver);

    await service.ingest({
      content: 'creds password: hunter2trustno1 here',
      source_type: 'note',
      project_tag: 'project:user-personal',
      author: 'human',
    });

    const joined = semanticContents(calls()).join('\n');
    expect(joined).not.toContain('hunter2trustno1');
    expect(joined).toContain('[REDACTED]');
  });

  it('respects MEMBERRY_REDACT_ON_INGEST=1 read from env (A7: protections parse loose)', async () => {
    process.env.MEMBERRY_REDACT_ON_INGEST = '1';
    const { driver, calls } = createMockDriver();
    const service = new IngestionService(driver);

    await service.ingest({
      content: 'creds password: hunter2trustno1 here',
      source_type: 'note',
      project_tag: 'project:user-personal',
      author: 'human',
    });

    const joined = semanticContents(calls()).join('\n');
    expect(joined).not.toContain('hunter2trustno1');
    expect(joined).toContain('[REDACTED]');
  });

  // ─── Flag OFF (default): verbatim, no behavior change ────────────────────────

  it('persists content verbatim when the flag is off (default) — no over-redaction', async () => {
    const { driver, calls } = createMockDriver();
    const service = new IngestionService(driver); // env unset -> default off

    await service.ingest({
      content: SECRET_BODY,
      source_type: 'note',
      project_tag: 'project:user-personal',
      author: 'human',
    });

    const joined = semanticContents(calls()).join('\n');
    // Secrets survive verbatim (existing behavior preserved when flag off).
    expect(joined).toContain('sk-abcdEFGH1234567890');
    expect(joined).toContain('hunter2trustno1');
    expect(joined).not.toContain('[REDACTED]');
  });

  it('persists pre-extracted claim content verbatim when the flag is off', async () => {
    const { driver, calls } = createMockDriver();
    const service = new IngestionService(driver, undefined, undefined, false);

    await service.ingest({
      content: 'doc body',
      source_type: 'article',
      project_tag: 'project:test',
      claims: [{ content: 'token sk-abcdEFGH1234567890', about: ['auth'] }],
    });

    const joined = semanticContents(calls()).join('\n');
    expect(joined).toContain('sk-abcdEFGH1234567890');
    expect(joined).not.toContain('[REDACTED]');
  });
});
