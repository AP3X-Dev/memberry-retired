import { afterEach, describe, expect, it } from 'vitest';
import { createCoreServices } from '../services-factory.js';

const managedEnv = [
  'MEMBERRY_CONSOLIDATION_AUTO_APPLY',
  'MEMBERRY_ADMISSION_SHADOW_ENABLED',
  'MEMBERRY_ADMISSION_SHADOW_TIMEOUT_MS',
  'NEO4J_URI',
  'NEO4J_USER',
  'REDIS_URL',
] as const;
const originalEnv = Object.fromEntries(managedEnv.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of managedEnv) {
    const original = originalEnv[name];
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
});
describe('createCoreServices consolidation policy config', () => {
  it('keeps admission observation default-off with a 50ms bound', async () => {
    delete process.env.MEMBERRY_ADMISSION_SHADOW_ENABLED;
    delete process.env.MEMBERRY_ADMISSION_SHADOW_TIMEOUT_MS;
    const core = createCoreServices();
    try {
      expect(core.config.admissionShadow).toEqual({ enabled: false, timeoutMs: 50 });
      expect(core.admissionShadow.snapshot()).toMatchObject({ enabled: false, maxInFlight: 32 });
    } finally {
      await core.close();
    }
  });

  it('requires strict explicit admission shadow configuration', async () => {
    process.env.MEMBERRY_ADMISSION_SHADOW_ENABLED = 'true';
    process.env.MEMBERRY_ADMISSION_SHADOW_TIMEOUT_MS = '75';
    const core = createCoreServices();
    try {
      expect(core.config.admissionShadow).toEqual({ enabled: true, timeoutMs: 75 });
      expect(core.admissionShadow.snapshot().enabled).toBe(true);
    } finally {
      await core.close();
    }
    expect(core.admissionShadow.snapshot()).toMatchObject({ stopping: true, inFlight: 0 });

    process.env.MEMBERRY_ADMISSION_SHADOW_ENABLED = '1';
    expect(() => createCoreServices()).toThrowError('admission_shadow_config:invalid_enabled');
  });
  it('keeps the library-safe review-first default', async () => {
    const core = createCoreServices();
    try {
      expect(core.config.consolidation.autoApply).toBe(false);
    } finally {
      await core.close();
    }
  });

  it.each(['1', 'true', 'YES', 'on'])('accepts %s as the explicit safe-auto-apply opt-in', async (value) => {
    process.env['MEMBERRY_CONSOLIDATION_AUTO_APPLY'] = value;
    const core = createCoreServices();
    try {
      expect(core.config.consolidation.autoApply).toBe(true);
    } finally {
      await core.close();
    }
  });

  it.each(['', '   '])('treats blank connection environment values as unset (%j)', async (value) => {
    process.env['NEO4J_URI'] = value;
    process.env['NEO4J_USER'] = value;
    process.env['REDIS_URL'] = value;
    const core = createCoreServices();
    try {
      expect(core.config.neo4j.uri).toBe('bolt://localhost:7687');
      expect(core.config.neo4j.user).toBe('neo4j');
      expect(core.config.redis.url).toBe('redis://localhost:6379');
    } finally {
      await core.close();
    }
  });

  it('treats blank explicit connection overrides as unset', async () => {
    const core = createCoreServices({ neo4jUri: ' ', neo4jUser: '\t', redisUrl: '\n' });
    try {
      expect(core.config.neo4j.uri).toBe('bolt://localhost:7687');
      expect(core.config.neo4j.user).toBe('neo4j');
      expect(core.config.redis.url).toBe('redis://localhost:6379');
    } finally {
      await core.close();
    }
  });
});
