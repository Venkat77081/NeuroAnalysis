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

import { daySlots, monthCells, shiftMonth, splitDay } from '../src/slots.tsx';

describe('v31: time grid and month', () => {
  const day = {
    hours: [
      ['09:00', '10:00'],
      ['14:00', '15:00'],
    ],
    free: ['09:30', '14:00', '14:30'],
    held: ['09:00'],
    slot_minutes: 30,
    on_leave: false,
  };
  it('lists every slot in clinic hours: free, held for an offer, or taken', () => {
    expect(daySlots(day)).toEqual([
      { time: '09:00', state: 'held' },
      { time: '09:30', state: 'free' },
      { time: '14:00', state: 'free' },
      { time: '14:30', state: 'free' },
    ]);
    expect(daySlots({ ...day, free: ['09:30'], held: [] }).map((s) => s.state)).toEqual([
      'taken',
      'free',
      'taken',
      'taken',
    ]);
    expect(daySlots({ ...day, on_leave: true })).toEqual([]);
  });
  it('splits Morning and Afternoon at the configured hour', () => {
    const { morning, afternoon } = splitDay(daySlots(day));
    expect(morning.map((s) => s.time)).toEqual(['09:00', '09:30']);
    expect(afternoon.map((s) => s.time)).toEqual(['14:00', '14:30']);
    expect(splitDay([{ time: '11:59' }, { time: '12:00' }], '12:00').afternoon).toEqual([
      { time: '12:00' },
    ]);
  });
  it('shows a month from the Monday on or before the 1st, six weeks', () => {
    const c = monthCells('2026-11');
    expect(c).toHaveLength(42);
    expect(c[0]).toBe('2026-10-26'); // 1 Nov 2026 is a Sunday
    expect(c[41]).toBe('2026-12-06');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
  });
});

import { chipTime } from '../src/slots.tsx';

describe('v31: chip times', () => {
  it('drops am/pm (the Morning / Afternoon heading says which)', () => {
    expect(chipTime('09:30')).toBe('9:30');
    expect(chipTime('14:00')).toBe('2:00');
    expect(chipTime('12:15')).toBe('12:15');
  });
});
