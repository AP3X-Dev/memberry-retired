import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ADMISSION_CONTRACT_VERSION,
  ADMISSION_TIERS,
  BASELINE_PARITY_POLICY_ID,
  BASELINE_PARITY_POLICY_VERSION,
  AdmissionContractError,
  BaselineParityAdmissionPolicyV1,
  TrustedAdmissionPreprocessorV1,
  createAdmissionObservationV1,
  parseAdmissionObservationV1,
  type AdmissionClock,
  type AdmissionPolicyV1,
  type AdmissionSafeFactsV1,
  type TrustedAdmissionInputV1,
} from '../admission.js';

const SECRET_CANARY = `sk-${'CanarySecret'.repeat(3)}`;
const TAG_CANARY = `project:${'PrivateProjectCanary'.repeat(3)}`;

function acceptedInput(overrides: Partial<TrustedAdmissionInputV1> = {}): TrustedAdmissionInputV1 {
  return {
    captureState: 'accepted-nonduplicate',
    task: 'Record the verified repository decision.',
    content: 'The repository uses deterministic admission contracts.',
    tags: ['project:memberry', 'backend'],
    scope: 'project:memberry',
    tenantId: 'default',
    redactionConfigured: false,
    memoryType: 'decision',
    outcome: 'approved',
    hasSignals: false,
    hasEntities: true,
    hasModel: false,
    ...overrides,
  };
}

const fixedClock: AdmissionClock = {
  now: () => new Date('2026-08-14T12:34:56.789Z'),
};

describe('TrustedAdmissionPreprocessorV1', () => {
  it('derives only closed safe facts for the baseline policy boundary', () => {
    const preprocessor = new TrustedAdmissionPreprocessorV1();
    const received = preprocessor.preprocess(acceptedInput({
      task: `Never expose ${SECRET_CANARY}`,
      content: `Authorization: Bearer ${'x'.repeat(24)}`,
      tags: [TAG_CANARY, 'security'],
      scope: TAG_CANARY,
      redactionConfigured: true,
    }));

    expect(received).toEqual({
      contractVersion: ADMISSION_CONTRACT_VERSION,
      captureState: 'accepted-nonduplicate',
      memoryClass: 'decision',
      outcome: 'approved',
      tenantScope: 'resolved',
      projectScope: 'resolved',
      sensitivity: 'detected',
      redactionConfigured: true,
      hasSignals: false,
      hasEntities: true,
      hasModel: false,
    });
    expect(Object.keys(received ?? {})).not.toEqual(expect.arrayContaining(['task', 'content', 'tags', 'scope', 'tenantId']));
    expect(JSON.stringify(received)).not.toContain(SECRET_CANARY);
    expect(JSON.stringify(received)).not.toContain(TAG_CANARY);
  });

  it('derives missing and conflicting scope facts without forwarding scope values', () => {
    const preprocessor = new TrustedAdmissionPreprocessorV1();
    expect(preprocessor.preprocess(acceptedInput({ tags: [], scope: undefined })).projectScope).toBe('missing');
    const conflicting = preprocessor.preprocess(acceptedInput({
      tags: ['project:alpha', 'project:beta'],
      scope: 'project:alpha',
    }));
    expect(conflicting.projectScope).toBe('conflicting');
    expect(JSON.stringify(conflicting)).not.toContain('alpha');
    expect(JSON.stringify(conflicting)).not.toContain('beta');
  });

  it('rejects unknown raw keys without echoing their values', () => {
    const preprocessor = new TrustedAdmissionPreprocessorV1();
    const input = { ...acceptedInput(), rawSecret: SECRET_CANARY };
    let error: unknown;
    try {
      preprocessor.preprocess(input as TrustedAdmissionInputV1);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AdmissionContractError);
    expect(String(error)).toContain('unknown_key');
    expect(String(error)).not.toContain(SECRET_CANARY);
  });

  it.each([
    ['sparse tags', () => {
      const tags = new Array<string>(2);
      tags[1] = 'backend';
      return tags;
    }],
    ['custom string property', () => Object.assign(['backend'], { unsafe: SECRET_CANARY })],
    ['custom symbol property', () => {
      const tags = ['backend'];
      Object.defineProperty(tags, Symbol('unsafe'), { value: SECRET_CANARY });
      return tags;
    }],
  ])('rejects %s as non-dense tag data without leaking values', (_label, tags) => {
    let error: unknown;
    try {
      new TrustedAdmissionPreprocessorV1().preprocess(acceptedInput({ tags: tags() }));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AdmissionContractError);
    expect(String(error)).not.toContain(SECRET_CANARY);
  });

  it('rejects inherited and exotic inputs', () => {
    const inherited = Object.assign(Object.create({ inherited: SECRET_CANARY }), acceptedInput());
    class ExoticInput {}
    const exotic = Object.assign(new ExoticInput(), acceptedInput());
    for (const unsafe of [inherited, exotic]) {
      let error: unknown;
      try {
        new TrustedAdmissionPreprocessorV1().preprocess(unsafe as TrustedAdmissionInputV1);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(AdmissionContractError);
      expect(String(error)).not.toContain(SECRET_CANARY);
    }
  });

  it('rejects accessors on inputs and tags without invoking their getters', () => {
    let inputGetterCalled = false;
    const unsafeInput = acceptedInput() as unknown as Record<string, unknown>;
    Object.defineProperty(unsafeInput, 'content', {
      enumerable: true,
      get() {
        inputGetterCalled = true;
        return SECRET_CANARY;
      },
    });
    expect(() => new TrustedAdmissionPreprocessorV1().preprocess(unsafeInput as unknown as TrustedAdmissionInputV1))
      .toThrowError(AdmissionContractError);
    expect(inputGetterCalled).toBe(false);

    let tagGetterCalled = false;
    const tags = ['backend'];
    Object.defineProperty(tags, '0', {
      enumerable: true,
      get() {
        tagGetterCalled = true;
        return SECRET_CANARY;
      },
    });
    expect(() => new TrustedAdmissionPreprocessorV1().preprocess(acceptedInput({ tags })))
      .toThrowError(AdmissionContractError);
    expect(tagGetterCalled).toBe(false);
  });

  it('accepts null-prototype data records at the trusted boundary', () => {
    const input = Object.assign(Object.create(null), acceptedInput()) as TrustedAdmissionInputV1;
    expect(new TrustedAdmissionPreprocessorV1().preprocess(input).captureState).toBe('accepted-nonduplicate');
  });

  it('detects secret shapes in trusted metadata without forwarding metadata values', () => {
    const facts = new TrustedAdmissionPreprocessorV1().preprocess(acceptedInput({
      task: 'safe task',
      content: 'safe content',
      tags: [`note:${SECRET_CANARY}`],
      scope: 'project:memberry',
    }));
    expect(facts.sensitivity).toBe('detected');
    expect(JSON.stringify(facts)).not.toContain(SECRET_CANARY);
  });

  it('does not expose a generic execution path for future-tier policies', () => {
    const futurePolicy: AdmissionPolicyV1 = {
      id: 'future-working-policy',
      version: '2.0.0',
      supportedTier: 'working',
    };
    const preprocessor = new TrustedAdmissionPreprocessorV1();
    expect((preprocessor as unknown as { evaluate?: unknown }).evaluate).toBeUndefined();
    const facts = preprocessor.preprocess(acceptedInput());
    expect(() => createAdmissionObservationV1({
      safeFacts: facts,
      recommendation: {
        contractVersion: ADMISSION_CONTRACT_VERSION,
        policyId: futurePolicy.id,
        policyVersion: futurePolicy.version,
        recommendedTier: futurePolicy.supportedTier,
        wouldChangeBaseline: true,
        reasonCode: 'baseline-parity-accepted-nonduplicate',
      },
    } as never, fixedClock))
      .toThrowError(AdmissionContractError);
  });
});

describe('BaselineParityAdmissionPolicyV1', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('recommends the existing episodic route without changing baseline behavior', () => {
    const facts = new TrustedAdmissionPreprocessorV1().preprocess(acceptedInput());
    expect(new BaselineParityAdmissionPolicyV1().evaluate(facts)).toEqual({
      contractVersion: ADMISSION_CONTRACT_VERSION,
      policyId: BASELINE_PARITY_POLICY_ID,
      policyVersion: BASELINE_PARITY_POLICY_VERSION,
      recommendedTier: 'episodic',
      wouldChangeBaseline: false,
      reasonCode: 'baseline-parity-accepted-nonduplicate',
    });
  });

  it('is deterministic and independent of provider credentials', () => {
    const facts = new TrustedAdmissionPreprocessorV1().preprocess(acceptedInput());
    const policy = new BaselineParityAdmissionPolicyV1();
    vi.stubEnv('OPENAI_API_KEY', SECRET_CANARY);
    const withProvider = policy.evaluate(facts);
    vi.stubEnv('OPENAI_API_KEY', '');
    const withoutProvider = policy.evaluate(facts);
    expect(withProvider).toEqual(withoutProvider);
    expect(Object.isFrozen(withProvider)).toBe(true);
  });

  it.each(['duplicate', 'rejected'] as const)('refuses to recommend a route for %s captures', (captureState) => {
    const facts = new TrustedAdmissionPreprocessorV1().preprocess(acceptedInput({ captureState }));
    expect(() => new BaselineParityAdmissionPolicyV1().evaluate(facts)).toThrowError(AdmissionContractError);
  });

  it('rejects extra policy-input keys, including raw content canaries', () => {
    const facts = new TrustedAdmissionPreprocessorV1().preprocess(acceptedInput());
    const unsafe = { ...facts, content: SECRET_CANARY };
    let error: unknown;
    try {
      new BaselineParityAdmissionPolicyV1().evaluate(unsafe as AdmissionSafeFactsV1);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AdmissionContractError);
    expect(String(error)).toContain('unknown_key');
    expect(String(error)).not.toContain(SECRET_CANARY);
  });
});

describe('AdmissionObservationV1', () => {
  function observation() {
    const preprocessor = new TrustedAdmissionPreprocessorV1();
    const facts = preprocessor.preprocess(acceptedInput({
      task: SECRET_CANARY,
      content: `password=${SECRET_CANARY}`,
      tags: [TAG_CANARY],
      scope: TAG_CANARY,
    }));
    return createAdmissionObservationV1({
      safeFacts: facts,
    }, fixedClock);
  }

  it('builds a deterministic, bounded, content-free observation with an injected clock', () => {
    const first = observation();
    const second = observation();
    const later = createAdmissionObservationV1({ safeFacts: first.safeFacts }, {
      now: () => new Date('2026-08-15T12:34:56.789Z'),
    });
    expect(first).toEqual(second);
    expect(first.observedAt).toBe('2026-08-14T12:34:56.789Z');
    expect(later.observedAt).not.toBe(first.observedAt);
    expect(later.recommendation).toEqual(first.recommendation);
    expect(first.recommendation.wouldChangeBaseline).toBe(false);
    expect(ADMISSION_TIERS).toContain(first.recommendation.recommendedTier);
    const serialized = JSON.stringify(first);
    expect(serialized.length).toBeLessThan(2_048);
    expect(serialized).not.toContain(SECRET_CANARY);
    expect(serialized).not.toContain(TAG_CANARY);
    expect(Object.keys(first)).toEqual([
      'contractVersion',
      'safeFacts',
      'recommendation',
      'observedAt',
    ]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.safeFacts)).toBe(true);
    expect(Object.isFrozen(first.recommendation)).toBe(true);
  });

  it('strictly validates round-tripped observations', () => {
    const roundTripped = JSON.parse(JSON.stringify(observation())) as unknown;
    expect(parseAdmissionObservationV1(roundTripped)).toEqual(observation());
  });

  it.each([
    ['top-level', (value: Record<string, unknown>) => ({ ...value, task: SECRET_CANARY })],
    ['safe facts', (value: Record<string, unknown>) => ({ ...value, safeFacts: { ...(value.safeFacts as object), tags: [TAG_CANARY] } })],
    ['recommendation', (value: Record<string, unknown>) => ({ ...value, recommendation: { ...(value.recommendation as object), explanation: SECRET_CANARY } })],
  ])('rejects unknown %s keys without leaking their values', (_label, mutate) => {
    const unsafe = mutate(JSON.parse(JSON.stringify(observation())) as Record<string, unknown>);
    let error: unknown;
    try {
      parseAdmissionObservationV1(unsafe);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AdmissionContractError);
    expect(String(error)).toContain('unknown_key');
    expect(String(error)).not.toContain(SECRET_CANARY);
    expect(String(error)).not.toContain(TAG_CANARY);
  });

  it('rejects non-baseline capture states and invalid clocks', () => {
    const facts = new TrustedAdmissionPreprocessorV1().preprocess(acceptedInput());
    expect(() => createAdmissionObservationV1({
      safeFacts: new TrustedAdmissionPreprocessorV1().preprocess(acceptedInput({ captureState: 'duplicate' })),
    }, fixedClock)).toThrowError(AdmissionContractError);
    expect(() => createAdmissionObservationV1({
      safeFacts: facts,
    }, { now: () => new Date(Number.NaN) })).toThrowError(AdmissionContractError);
  });

  it.each([
    ['policy id', { policyId: 'future-policy' }],
    ['policy version', { policyVersion: '2.0.0' }],
    ['future tier', { recommendedTier: 'protected' }],
    ['baseline change', { wouldChangeBaseline: true }],
    ['reason code', { reasonCode: 'future-policy-reason' }],
  ])('rejects a mismatched or future %s recommendation', (_label, change) => {
    const baseline = observation();
    const changed = JSON.parse(JSON.stringify(baseline)) as Record<string, unknown>;
    changed.recommendation = {
      ...(changed.recommendation as object),
      ...change,
    };
    expect(() => parseAdmissionObservationV1(changed)).toThrowError(AdmissionContractError);
  });
});
