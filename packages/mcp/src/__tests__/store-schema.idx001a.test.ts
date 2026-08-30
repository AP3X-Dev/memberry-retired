import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AmpStoreSchema } from '../tools.js';

const schema = z.object(AmpStoreSchema);
const base = (extra: Record<string, unknown> = {}) => ({
  session_id: 's', task: 't', content: 'c', scope: 'project:memberry', ...extra,
});

describe('IDX-001A berry_store structured input schema', () => {
  it('accepts bounded facts and closed entity aliases', () => {
    expect(schema.safeParse(base({
      entities: ['entity-1'],
      facts: ['Entity one owns the retrieval engine.'],
      aliases: [{ entity_id: 'entity-1', values: ['retriever'] }],
    })).success).toBe(true);
  });

  it('rejects excess fields and every array bound overflow', () => {
    expect(schema.safeParse(base({ aliases: [{ entity_id: 'e', values: ['a'], extra: true }] })).success).toBe(false);
    expect(schema.safeParse(base({ entities: Array.from({ length: 33 }, (_, i) => `e${i}`) })).success).toBe(false);
    expect(schema.safeParse(base({ facts: Array.from({ length: 33 }, (_, i) => `f${i}`) })).success).toBe(false);
    expect(schema.safeParse(base({ aliases: [{ entity_id: 'e', values: Array.from({ length: 17 }, (_, i) => `a${i}`) }] })).success).toBe(false);
  });
});
