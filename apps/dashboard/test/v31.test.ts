import { describe, expect, it } from 'vitest';
import { isEvening } from '../src/shell.tsx';
import { appearance } from '../src/config.ts';

const at = (h: number, m = 0) => new Date(2026, 10, 19, h, m);

describe('v31: automatic appearance', () => {
  it('is dark from the evening hour until the morning hour (config)', () => {
    expect(appearance).toEqual({ darkFromHour: 18, lightFromHour: 6 });
    expect(isEvening(at(17, 59))).toBe(false);
    expect(isEvening(at(18))).toBe(true);
    expect(isEvening(at(23, 30))).toBe(true);
    expect(isEvening(at(2))).toBe(true);
    expect(isEvening(at(5, 59))).toBe(true);
    expect(isEvening(at(6))).toBe(false);
    expect(isEvening(at(12))).toBe(false);
  });
  it('also works when the dark hours do not cross midnight', () => {
    const a = { darkFromHour: 0, lightFromHour: 7 };
    expect(isEvening(at(3), a)).toBe(true);
    expect(isEvening(at(7), a)).toBe(false);
    expect(isEvening(at(20), a)).toBe(false);
  });
});
