import { describe, expect, it } from 'vitest';
import {
  buildEpisodeIndexKeysV1,
  validateEpisodeStructuredIndexV1,
} from '../structured-index.js';

describe('IDX-001A structured episode index contract', () => {
  it('normalizes and snapshots bounded facts and entity-bound aliases', () => {
    const facts = ['  Sensor Gale   is maintained by Team Nimbus.  '];
    const aliases = [{ entity_id: 'entity-gale', values: [' Gale ', 'sensor   Gale'] }];
    const result = validateEpisodeStructuredIndexV1({
      facts, aliases, entities: ['entity-gale'], scope: 'project:memberry',
    });
    facts[0] = 'mutated';
    aliases[0]!.values[0] = 'mutated';
    expect(result).toEqual({
      schema_version: 1,
      facts: ['Sensor Gale is maintained by Team Nimbus.'],
      aliases: [{ entity_id: 'entity-gale', values: ['Gale', 'sensor Gale'] }],
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('requires canonical project scope and aliases already authorized by entities', () => {
    expect(() => validateEpisodeStructuredIndexV1({ facts: ['A uses B'], scope: 'Memberry' }))
      .toThrow('canonical_project_scope_required');
    expect(() => validateEpisodeStructuredIndexV1({
      aliases: [{ entity_id: 'foreign', values: ['Gale'] }],
      entities: ['local'], scope: 'project:memberry',
    })).toThrow('aliases:unauthorized_entity');
  });

  it('rejects duplicates, control characters, unknown alias fields, and over 64 total keys', () => {
    expect(() => validateEpisodeStructuredIndexV1({
      facts: ['A uses B', 'a uses b'], scope: 'project:memberry',
    })).toThrow('facts:duplicate');
    expect(() => validateEpisodeStructuredIndexV1({
      facts: ['A\nuses B'], scope: 'project:memberry',
    })).toThrow('control_character');
    expect(() => validateEpisodeStructuredIndexV1({
      aliases: [{ entity_id: 'e1', values: ['A'], extra: true }],
      entities: ['e1'], scope: 'project:memberry',
    })).toThrow('aliases:invalid_object');
    expect(() => validateEpisodeStructuredIndexV1({
      facts: Array.from({ length: 32 }, (_, i) => `fact ${i}`),
      aliases: [{ entity_id: 'e1', values: Array.from({ length: 16 }, (_, i) => `a${i}`) }],
      entities: ['e1'], scope: 'project:memberry',
    })).not.toThrow();
    expect(() => validateEpisodeStructuredIndexV1({
      facts: Array.from({ length: 32 }, (_, i) => `fact ${i}`),
      aliases: [
        { entity_id: 'e1', values: Array.from({ length: 16 }, (_, i) => `a${i}`) },
        { entity_id: 'e2', values: Array.from({ length: 16 }, (_, i) => `b${i}`) },
        { entity_id: 'e3', values: ['overflow'] },
      ],
      entities: ['e1', 'e2', 'e3'], scope: 'project:memberry',
    })).toThrow('too_many_keys');
  });

  it('rejects sparse arrays at every structured input level', () => {
    const sparseFacts = new Array<string>(1);
    const sparseEntities = new Array<string>(1);
    const sparseAliases = new Array<{ entity_id: string; values: string[] }>(1);
    const sparseValues = new Array<string>(1);
    expect(() => validateEpisodeStructuredIndexV1({ facts: sparseFacts, scope: 'project:memberry' }))
      .toThrow('facts:invalid_array');
    expect(() => validateEpisodeStructuredIndexV1({ facts: ['fact'], entities: sparseEntities, scope: 'project:memberry' }))
      .toThrow('entities:invalid_array');
    expect(() => validateEpisodeStructuredIndexV1({ aliases: sparseAliases, scope: 'project:memberry' }))
      .toThrow('aliases:invalid_array');
    expect(() => validateEpisodeStructuredIndexV1({
      aliases: [{ entity_id: 'e1', values: sparseValues }], entities: ['e1'], scope: 'project:memberry',
    })).toThrow('alias_values:invalid_array');
  });

  it('builds deterministic provenance-bound key identities', () => {
    const structured = validateEpisodeStructuredIndexV1({
      facts: ['A uses B'], scope: 'project:memberry',
    })!;
    const keys = buildEpisodeIndexKeysV1({
      episodeId: 'ep1', structured, embeddings: [[0.1, 0.2]], source: 'agent',
      tenantId: 'tenant1', projectScope: 'project:memberry', createdAt: '2026-08-30T00:00:00.000Z',
    });
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({
      episode_id: 'ep1', kind: 'fact', value: 'A uses B', source: 'agent',
      tenant_id: 'tenant1', project_scope: 'project:memberry', schema_version: 1,
    });
    expect(keys[0]!.id).toMatch(/^eik1:ep1:[0-9a-f]{64}$/);
  });
});
