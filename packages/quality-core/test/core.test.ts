import { describe, expect, it } from 'vitest';
import {
  QUALITY_CORE_VERSION,
  makeRuleId,
  parseRuleId,
  parseNs,
  secondsBetween,
  meetsDuration,
} from '../src/index.ts';

describe('version', () => {
  it('is semver', () => expect(QUALITY_CORE_VERSION).toMatch(/^\d+\.\d+\.\d+$/));
});

describe('rule ids', () => {
  it('builds and parses', () => {
    const id = makeRuleId('in_safe_zone', '1.2.3');
    expect(id).toBe('in_safe_zone@1.2.3');
    expect(parseRuleId(id)).toEqual({ name: 'in_safe_zone', version: '1.2.3', major: 1 });
  });
  it('rejects bad ids', () => {
    expect(() => makeRuleId('InSafeZone', '1.0.0')).toThrow(/invalid rule id/);
    expect(() => makeRuleId('x', '1.0')).toThrow();
    expect(parseRuleId('nope')).toBeNull();
  });
});

describe('time', () => {
  it('parses 64-bit nanosecond strings without precision loss', () => {
    expect(parseNs('9007199254740993123')).toBe(9007199254740993123n);
    expect(parseNs('-5')).toBe(-5n);
    expect(() => parseNs('1.5')).toThrow(/invalid nanosecond/);
  });
  it('computes seconds between timestamps', () => {
    expect(secondsBetween(1_000_000_000n, 16_000_000_000n)).toBe(15);
  });
  it('checks the fixed duration with tolerance', () => {
    expect(meetsDuration(15.0, 15, 0.1)).toBe(true);
    expect(meetsDuration(14.9, 15, 0.1)).toBe(true);
    expect(meetsDuration(14.8, 15, 0.1)).toBe(false);
    expect(meetsDuration(30.02, 30, 0.1)).toBe(true);
  });
});
