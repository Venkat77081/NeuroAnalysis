import { describe, expect, it } from 'vitest';
import { avatarColour, dayPart } from '../src/ui.tsx';
import { nowIndex } from '../src/appointments.tsx';
import {
  doctorColumns,
  HOUR_PX,
  hourRange,
  offsetFor,
  placeDay,
  SHOWN_MINUTES,
  weekOf,
} from '../src/calendar.tsx';
import { heroChip, nextAppointment, type Item } from '../src/overview.tsx';
import { nextTheme } from '../src/shell.tsx';
import type { Appointment } from '../src/appointments.tsx';

const appt = (id: string, at: string, doctor: string | null = 'Dr. Rao'): Appointment => ({
  id,
  ncid: `nc_${id}`,
  at,
  doctor_id: doctor ? doctor.toLowerCase() : null,
  doctor_name: doctor,
  source: 'manual',
  status: 'booked',
  stage: 'needs_tests',
  requests: [],
  booked_by_name: null,
  last_event: null,
});

describe('v28 greeting and shell', () => {
  it('splits the day like the phone app', () => {
    expect(dayPart(new Date(2026, 10, 19, 6))).toBe('morning');
    expect(dayPart(new Date(2026, 10, 19, 12))).toBe('afternoon');
    expect(dayPart(new Date(2026, 10, 19, 17))).toBe('evening');
  });
  it('gives the same avatar colour to the same name', () => {
    expect(avatarColour('Asha Testpatient')).toBe(avatarColour('Asha Testpatient'));
    expect(avatarColour('Asha Testpatient')).toMatch(/^#[0-9a-f]{6}$/);
  });
  it('cycles the theme system → light → dark', () => {
    expect(nextTheme('system')).toBe('light');
    expect(nextTheme('light')).toBe('dark');
    expect(nextTheme('dark')).toBe('auto'); // v31: Automatic comes first
    expect(nextTheme('auto')).toBe('system');
  });
  it('writes greeting chips as "value title"', () => {
    expect(heroChip('Appointments today', { key: 'today', value: 18 })).toBe(
      '18 appointments today',
    );
    expect(heroChip('On time', { key: 'onTime', value: 92 })).toBe('92% on time');
  });
  it('finds the next appointment still to come', () => {
    const item = (at: string): Item => ({
      key: 'appointment',
      status: 'ok',
      id: at,
      name: null,
      ncid: null,
      at,
      doctor: null,
      place: null,
      flagged: null,
    });
    const now = Date.parse('2026-11-19T05:00:00Z');
    const items = [
      item('2026-11-19T04:00:00Z'),
      item('2026-11-19T07:00:00Z'),
      item('2026-11-19T06:00:00Z'),
    ];
    expect(nextAppointment(items, now)?.at).toBe('2026-11-19T06:00:00Z');
    expect(nextAppointment([items[0]!], now)).toBeNull();
  });
});

describe('v28 appointments: Now line and calendar', () => {
  it('puts the Now line between past and coming appointments only', () => {
    const now = Date.parse('2026-11-19T05:38:00Z');
    expect(nowIndex(['2026-11-19T04:00:00Z', '2026-11-19T06:00:00Z'], now)).toBe(1);
    expect(nowIndex(['2026-11-19T06:00:00Z'], now)).toBeNull();
    expect(nowIndex(['2026-11-19T04:00:00Z'], now)).toBeNull();
  });
  it('places overlapping appointments side by side', () => {
    const tz = 'Asia/Kolkata';
    const placed = placeDay(
      [
        appt('a', '2026-11-19T05:30:00Z'), // 11:00
        appt('b', '2026-11-19T05:45:00Z'), // 11:15, overlaps a
        appt('c', '2026-11-19T07:30:00Z'), // 13:00, alone
      ],
      tz,
    );
    const by = Object.fromEntries(placed.map((p) => [p.a.id, p]));
    expect([by.a!.lane, by.b!.lane, by.a!.lanes, by.b!.lanes]).toEqual([0, 1, 2, 2]);
    expect([by.c!.lane, by.c!.lanes, by.c!.start]).toEqual([0, 1, 13 * 60]);
  });
  it('shows 9 to 17 at least and widens to fit', () => {
    expect(hourRange([])).toEqual([9, 17]);
    expect(hourRange([7 * 60 + 30, 18 * 60])).toEqual([7, 19]);
    expect(hourRange([23 * 60 + 45])).toEqual([9, 24]);
    expect(SHOWN_MINUTES).toBe(30);
  });
  it('turns a time into pixels from the top of the grid', () => {
    expect(offsetFor(9 * 60, [9, 17])).toBe(0);
    expect(offsetFor(11 * 60 + 8, [9, 17])).toBeCloseTo((2 + 8 / 60) * HOUR_PX);
    expect(offsetFor(8 * 60, [9, 17])).toBeNull();
  });
  it('weeks run Monday to Sunday', () => {
    expect(weekOf('2026-11-19')).toEqual([
      '2026-11-16',
      '2026-11-17',
      '2026-11-18',
      '2026-11-19',
      '2026-11-20',
      '2026-11-21',
      '2026-11-22',
    ]);
  });
  it('lists doctors by name with "no doctor yet" last', () => {
    const cols = doctorColumns(
      [
        appt('a', '2026-11-19T05:30:00Z', null),
        appt('b', '2026-11-19T05:30:00Z', 'Dr. Rao'),
        appt('c', '2026-11-19T05:30:00Z', 'Dr. Iyer'),
      ],
      'No doctor yet',
    );
    expect(cols.map((c) => c.name)).toEqual(['Dr. Iyer', 'Dr. Rao', 'No doctor yet']);
  });
});
