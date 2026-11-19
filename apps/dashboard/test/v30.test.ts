import { describe, expect, it } from 'vitest';
import { canMarkNoShow, todayStatus } from '../src/today.tsx';
import { sinceText } from '../src/desk.tsx';
import { dayPart } from '../src/ui.tsx';
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

describe('v30 activity, doctor Today and patients', () => {
  it('groups log rows by day, newest first', async () => {
    const { groupByDay, toneOf } = await import('../src/activity.tsx');
    const who = { name: 'A', email: null, role: 'staff' };
    const now = new Date(2026, 10, 19, 12);
    const g = groupByDay(
      [
        { at: new Date(2026, 10, 18, 9).toISOString(), who, action: 'staff_login', details: null },
        {
          at: new Date(2026, 10, 19, 8).toISOString(),
          who,
          action: 'device_revoked',
          details: null,
        },
        { at: new Date(2026, 10, 12, 8).toISOString(), who, action: 'plan_set', details: null },
      ],
      now,
    );
    expect(g.map((x) => x.label)).toEqual(['today', 'yesterday', 'date']);
    expect([toneOf('device_revoked'), toneOf('staff_login'), toneOf('change_requested')]).toEqual([
      'bad',
      'ok',
      'warn',
    ]);
  });
  it("tells a doctor what each of today's appointments needs", async () => {
    const { doctorRow } = await import('../src/today.tsx');
    expect(doctorRow(appt({ stage: 'recorded' }), NOW).action).toBe('watch');
    expect(doctorRow(appt({ stage: 'needs_tests' }), NOW).action).toBe('choose');
    expect(doctorRow(appt({ stage: 'sent', at: '2026-11-19T05:00:00Z' }), NOW).key).toBe('notYet');
  });
  it('picks the most useful state for each patient', async () => {
    const { patientState } = await import('../src/doctor.tsx');
    const base = {
      sessions: 2,
      nextStage: null,
      newRecording: false,
      flagged: false,
      nextToday: false,
    };
    expect(patientState({ ...base, nextStage: 'needs_tests', flagged: true }).key).toBe(
      'needsTests',
    );
    expect(patientState({ ...base, flagged: true, newRecording: true }).key).toBe('flagged');
    expect(patientState({ ...base, newRecording: true }).key).toBe('newRecording');
    expect(patientState({ ...base, sessions: 0 }).key).toBe('newPatient');
    expect(patientState(base).key).toBe('upToDate');
  });

  it('writes long waits as hours and minutes', () => {
    const t = ((k: string, o: Record<string, number>) => `${k}:${JSON.stringify(o)}`) as never;
    expect(sinceText(t, 17)).toBe('today.sinceM:{"m":17}');
    expect(sinceText(t, 227)).toBe('today.sinceHM:{"h":3,"m":47}');
  });
  it("greets by the hospital's time of day, not the computer's", () => {
    const at = new Date('2026-11-19T11:47:00Z'); // 17:17 in Kolkata
    expect(dayPart(at, 'Asia/Kolkata')).toBe('evening');
    expect(dayPart(at, 'UTC')).toBe('morning');
    expect(dayPart(new Date('2026-11-19T18:40:00Z'), 'Asia/Kolkata')).toBe('morning'); // 00:10
  });
});
