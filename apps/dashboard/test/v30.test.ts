import { describe, expect, it } from 'vitest';
import { canMarkNoShow, todayStatus } from '../src/today.tsx';
import { hospitalView } from '../src/platform.tsx';
import { journey } from '../src/doctor.tsx';
import { nextVisits, notInApp } from '../src/shell.tsx';
import { takeSeconds } from '../src/config.ts';

const NOW = Date.parse('2026-11-19T05:38:00Z'); // 11:08 in Kolkata
const appt = (over: Record<string, unknown> = {}) =>
  ({
    at: '2026-11-19T05:45:00Z',
    status: 'booked',
    stage: 'needs_tests',
    cancel_reason: null,
    requests: [],
    ...over,
  }) as Parameters<typeof todayStatus>[0];

describe('v30 front desk Today', () => {
  it('says what each appointment needs, most important first', () => {
    expect(
      todayStatus(appt({ status: 'cancelled', cancel_reason: 'no_show' }), NOW, true).key,
    ).toBe('noShow');
    expect(
      todayStatus(appt({ stage: 'recorded', at: '2026-11-19T04:00:00Z' }), NOW, true).key,
    ).toBe('recorded');
    const late = todayStatus(appt({ at: '2026-11-19T05:30:00Z', stage: 'sent' }), NOW, true);
    expect([late.key, late.minutes, late.tone]).toEqual(['late', 8, 'bad']);
    expect(todayStatus(appt(), NOW, true).key).toBe('needsTests');
    const clinic = [{ place: 'clinic', state: 'open' }];
    expect(todayStatus(appt({ stage: 'sent', requests: clinic }), NOW, false).key).toBe('noApp');
    expect(todayStatus(appt({ stage: 'sent', requests: clinic }), NOW, true).key).toBe('clinic');
  });
  it('offers "Did not come" from the appointment time only', () => {
    expect(canMarkNoShow(appt({ at: '2026-11-19T05:30:00Z' }), NOW)).toBe(true);
    expect(canMarkNoShow(appt(), NOW)).toBe(false);
    expect(canMarkNoShow(appt({ at: '2026-11-19T05:30:00Z', stage: 'recorded' }), NOW)).toBe(false);
  });
});

describe('v30 search', () => {
  it("keeps each patient's next booked visit", () => {
    const n = nextVisits(
      [
        { ncid: 'a', at: '2026-11-25T03:30:00Z', status: 'booked', doctor_name: 'Dr. Rao' },
        { ncid: 'a', at: '2026-11-21T03:30:00Z', status: 'booked', doctor_name: 'Dr. Iyer' },
        { ncid: 'a', at: '2026-11-20T03:30:00Z', status: 'cancelled', doctor_name: null },
        { ncid: 'b', at: '2026-11-18T03:30:00Z', status: 'booked', doctor_name: null },
      ],
      NOW,
    );
    expect(n.a?.doctor_name).toBe('Dr. Iyer');
    expect(n.b).toBeUndefined();
  });
  it('offers an invite to patients not using the app', () => {
    expect(notInApp({ app_status: null })).toBe(true);
    expect(notInApp({ app_status: 'no_app' })).toBe(true);
    expect(notInApp({ app_status: 'active' })).toBe(false);
  });
});

describe('v30 hospitals', () => {
  const h = (over: Record<string, unknown>) =>
    ({
      status: 'active',
      can_record: true,
      connector_registered: true,
      connector_online: true,
      setup_done: 6,
      setup_total: 6,
      messaging: { email: 'working', sms: 'off' },
      ...over,
    }) as Parameters<typeof hospitalView>[0];
  it('scores set-up and sorts hospitals into live, onboarding and needs-you', () => {
    expect(hospitalView(h({}))).toMatchObject({ score: 100, live: true, attention: false });
    expect(hospitalView(h({ setup_done: 3 }))).toMatchObject({ score: 50, onboarding: true });
    const off = hospitalView(h({ connector_online: false }));
    expect([off.connector, off.attention, off.live]).toEqual(['offline', true, false]);
    expect(hospitalView(h({ messaging: { email: 'failing' } })).messages).toBe('failing');
    expect(hospitalView(h({ connector_registered: false })).connector).toBe('none');
  });
});

describe('v30 patient journey', () => {
  it('shows the last points and the next visit, oldest first', () => {
    const appointments = [
      { id: 'a1', at: '2026-09-07T04:00:00Z', status: 'cancelled', cancel_reason: 'no_show' },
      { id: 'a2', at: '2026-10-14T04:00:00Z', status: 'booked' },
      { id: 'a3', at: '2026-11-21T03:30:00Z', status: 'booked' },
    ] as never;
    const sessions = [
      { id: 's1', started_at: '2026-11-18T10:00:00Z', recorded_by: 'patient', takes_uploaded: 5 },
    ] as never;
    const pts = journey(
      { appointments, sessions },
      [{ session_id: 's1', flagged_for_review: true }],
      { a2: {} },
      NOW,
    );
    expect(pts.map((p) => p.kind)).toEqual(['noShow', 'visit', 'home', 'next']);
    expect(pts[1]!.remark).toBe(true);
    expect([pts[2]!.tests, pts[2]!.flagged]).toEqual([5, 1]);
  });
  it('take lengths come from config/tests', () => {
    expect(takeSeconds.FT).toBe(15);
    expect(takeSeconds.SAW).toBe(45);
  });
});
