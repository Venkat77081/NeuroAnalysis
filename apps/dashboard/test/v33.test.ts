import { describe, expect, it } from 'vitest';
import { daysSince, recency, sortPatients } from '../src/doctor.tsx';
import { myPatientsRing } from '../src/config.ts';

const now = Date.parse('2026-11-20T10:00:00Z');

describe('v33: My patients cards', () => {
  it('counts whole days since the last recording', () => {
    expect(daysSince(null, now)).toBeNull();
    expect(daysSince('2026-11-20T08:00:00Z', now)).toBe(0);
    expect(daysSince('2026-11-19T09:00:00Z', now)).toBe(1);
    expect(daysSince('2026-10-14T10:00:00Z', now)).toBe(37);
    expect(daysSince('2026-11-21T10:00:00Z', now)).toBe(0);
  });

  it('fills the ring by recency and colours it by the config limits', () => {
    expect(myPatientsRing).toEqual({ ringDays: 42, okWithinDays: 7, warnWithinDays: 28 });
    expect(recency(null)).toEqual({ pct: 0, tone: 'none' });
    expect(recency(0)).toEqual({ pct: 100, tone: 'ok' });
    expect(recency(7).tone).toBe('ok');
    expect(recency(8).tone).toBe('warn');
    expect(recency(28).tone).toBe('warn');
    expect(recency(29).tone).toBe('bad');
    expect(recency(21).pct).toBe(50);
    expect(recency(400).pct).toBe(5);
    const cfg = { ringDays: 10, okWithinDays: 2, warnWithinDays: 5 };
    expect(recency(5, cfg)).toEqual({ pct: 50, tone: 'warn' });
  });

  it('sorts by next visit, latest recording or name, with blanks last', () => {
    const list = [
      { name: 'Meena', next: '2026-11-21T09:00:00Z', last: '2026-10-14T10:00:00Z' },
      { name: null, next: null, last: null },
      { name: 'Asha', next: '2026-11-20T12:00:00Z', last: '2026-11-18T10:00:00Z' },
      { name: 'Ravi', next: null, last: '2026-11-19T10:00:00Z' },
    ];
    expect(sortPatients(list, 'next').map((x) => x.name)).toEqual(['Asha', 'Meena', 'Ravi', null]);
    expect(sortPatients(list, 'recent').map((x) => x.name)).toEqual([
      'Ravi',
      'Asha',
      'Meena',
      null,
    ]);
    expect(sortPatients(list, 'name').map((x) => x.name)).toEqual(['Asha', 'Meena', 'Ravi', null]);
    expect(list[0]!.name).toBe('Meena');
  });
});
