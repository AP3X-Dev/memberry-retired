import { TrustedAdmissionPreprocessorV1, createAdmissionObservationV1 } from '@memberry/core';
import { expect, it, vi } from 'vitest';
import type { Driver } from 'neo4j-driver';

const cryptoMock = vi.hoisted(() => ({
  randomUUID: vi.fn<() => `${string}-${string}-${string}-${string}-${string}`>(),
}));

vi.mock('node:crypto', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:crypto')>(),
  randomUUID: cryptoMock.randomUUID,
}));

import { AdmissionObservationStore, AdmissionObservationStoreError } from '../admission-observation.js';

it('normalizes randomUUID failure without opening storage or leaking the thrown value', async () => {
  const canary = 'random-source-canary';
  cryptoMock.randomUUID.mockImplementationOnce(() => { throw new Error(canary); });
  const safeFacts = new TrustedAdmissionPreprocessorV1().preprocess({
    captureState: 'accepted-nonduplicate',
    task: 'fixture',
    content: 'fixture',
    tags: ['project:memberry'],
    scope: 'project:memberry',
    tenantId: 'tenant-acme',
    redactionConfigured: true,
    memoryType: 'general',
    hasSignals: false,
    hasEntities: false,
    hasModel: false,
  });
  const observation = createAdmissionObservationV1(
    { safeFacts },
    { now: () => new Date('2026-08-14T12:00:00.000Z') },
  );
  const session = vi.fn();
  let error: unknown;
  try {
    await new AdmissionObservationStore({ session } as unknown as Driver).persist({
      tenantId: 'tenant-acme', projectScope: 'project:memberry', episodeId: 'ep-1',
    }, observation);
  } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(AdmissionObservationStoreError);
  expect(error).toMatchObject({ code: 'storage_unavailable' });
  expect(String(error)).not.toContain(canary);
  expect(session).not.toHaveBeenCalled();
});
