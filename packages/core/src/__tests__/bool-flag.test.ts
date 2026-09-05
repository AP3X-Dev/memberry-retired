// packages/core/src/__tests__/bool-flag.test.ts
// Audit A7 / PRP §8.4: one boolean-env parser. Protections parse loose so `=1`
// cannot silently disable them; relaxations parse strict so a typo cannot open
// the server.
import { describe, expect, it } from 'vitest';
import { parseBoolFlag } from '../config/bool-flag.js';

describe('parseBoolFlag', () => {
  it.each(['1', 'true', 'TRUE ', ' yes', 'on', 'On'])('loose: %j → true', (raw) => {
    expect(parseBoolFlag(raw, false)).toBe(true);
  });

  it.each(['false', '0', 'no', 'off', 'enabled'])('loose: %j → false regardless of fallback', (raw) => {
    expect(parseBoolFlag(raw, false)).toBe(false);
    expect(parseBoolFlag(raw, true)).toBe(false);
  });

  it.each(['', '   ', undefined])('loose: %j → fallback', (raw) => {
    expect(parseBoolFlag(raw, false)).toBe(false);
    expect(parseBoolFlag(raw, true)).toBe(true);
  });

  it('strict: only the exact string "true" opens the flag', () => {
    expect(parseBoolFlag('true', false, { strict: true })).toBe(true);
    for (const raw of ['1', 'yes', 'on', 'TRUE', 'True', ' true']) {
      expect(parseBoolFlag(raw, false, { strict: true })).toBe(false);
    }
    expect(parseBoolFlag(undefined, false, { strict: true })).toBe(false);
    expect(parseBoolFlag('', false, { strict: true })).toBe(false);
  });
});
