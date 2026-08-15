import { describe, expect, it } from 'vitest';

import {
  validateAdmissionStructuralInput,
  type AdmissionStructuralScenarioInput,
} from '../../contracts/admission.js';

describe('admission structural contract boundary', () => {
  it('rejects scorer fields before a production system can execute', () => {
    const hostile = {
      version: '1.0.0',
      id: 'hostile',
      split: 'dev',
      title: 'hostile',
      requiredCapabilities: [],
      config: { shadowEnabled: true, redactOnIngest: false, timeoutMs: 50 },
      operations: [{
        id: 'one',
        input: { session_id: 's', agent_id: 'a', task: 't', content: 'c', tenantId: 'tenant', tags: ['project:test'] },
        expected: { recommendedTier: 'protected' },
      }],
    } as unknown as AdmissionStructuralScenarioInput;
    expect(validateAdmissionStructuralInput(hostile)).toEqual(expect.arrayContaining([
      expect.stringContaining('scorer-only key'),
    ]));
  });
});
