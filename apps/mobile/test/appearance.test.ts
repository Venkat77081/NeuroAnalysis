import { describe, expect, it } from 'vitest';
import { isEvening, themeFor } from '../src/lib/appearance.ts';
import { loadConfig } from '../src/lib/config.ts';

/** v31 (decision 055): Automatic is dark in the evening, like the dashboards. */
describe('appearance', () => {
  const hours = loadConfig().platform.appearance!;
  const at = (h: number) => new Date(2026, 10, 19, h, 30);
  it('uses the evening hours from config/platform.json', () => {
    expect(hours).toEqual({ darkFromHour: 18, lightFromHour: 6 });
    expect(isEvening(at(17), hours)).toBe(false);
    expect(isEvening(at(18), hours)).toBe(true);
    expect(isEvening(at(2), hours)).toBe(true);
    expect(isEvening(at(6), hours)).toBe(false);
  });
  it('maps each choice to a look', () => {
    expect(themeFor('auto', hours, at(20))).toBe('dark');
    expect(themeFor('auto', hours, at(9))).toBe('light');
    expect(themeFor('system', hours, at(20))).toBeNull();
    expect(themeFor('light', hours, at(20))).toBe('light');
    expect(themeFor('dark', hours, at(9))).toBe('dark');
  });
});
