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

import {
  hourRows,
  hoursSummary,
  leaveOn,
  openDays,
  openFrom,
  overlaps,
  shortSpan,
  toggleCell,
  toggleRow,
  weekFrom,
} from '../src/hours.tsx';

describe('v31: clinic hours grid', () => {
  const week = { mon: [['09:00', '13:00']], wed: [['09:30', '12:00']], sat: [] };
  it('rows are the default blocks plus the doctor’s own spans, by start time', () => {
    expect(hourRows(week)).toEqual(['09:00-13:00', '09:30-12:00', '14:00-17:00']);
    expect(hourRows({}, [])).toEqual([]);
  });
  it('opening a cell closes overlapping blocks that day', () => {
    expect(overlaps('09:00-13:00', '12:30-14:00')).toBe(true);
    expect(overlaps('09:00-13:00', '13:00-17:00')).toBe(false);
    let o = openFrom(week);
    o = toggleCell(o, 'wed', '09:00-13:00');
    expect(o.wed).toEqual(['09:00-13:00']);
    o = toggleCell(o, 'wed', '09:00-13:00');
    expect(o.wed).toEqual([]);
  });
  it('a row opens on every day, then closes on every day', () => {
    let o = toggleRow(openFrom(week), '14:00-17:00');
    expect(Object.values(o).every((d) => d.includes('14:00-17:00'))).toBe(true);
    o = toggleRow(o, '14:00-17:00');
    expect(Object.values(o).some((d) => d.includes('14:00-17:00'))).toBe(false);
  });
  it('saves spans sorted by start, in the old shape', () => {
    const o = toggleCell(toggleCell(openFrom({}), 'fri', '14:00-17:00'), 'fri', '09:00-13:00');
    expect(weekFrom(o).fri).toEqual([
      ['09:00', '13:00'],
      ['14:00', '17:00'],
    ]);
    expect(weekFrom(o).mon).toEqual([]);
  });
  it('writes short times and summaries for the Team cards', () => {
    expect(shortSpan('09:00-13:00')).toBe('9–1');
    expect(shortSpan('09:30-12:00')).toBe('9:30–12');
    expect(
      hoursSummary({
        mon: [
          ['09:00', '13:00'],
          ['14:00', '17:00'],
        ],
        tue: [['09:00', '13:00']],
      }),
    ).toBe('9–1, 2–5');
    expect(openDays(week)).toEqual([true, false, true, false, false, false, false]);
  });
  it('finds leave that covers a day', () => {
    const leave = [{ from: '2026-11-18', to: '2026-11-24' }];
    expect(leaveOn(leave, '2026-11-19')).toEqual(leave[0]);
    expect(leaveOn(leave, '2026-11-25')).toBeNull();
    expect(leaveOn([{ from: '', to: '' }], '2026-11-19')).toBeNull();
  });
});
