/**
 * Activity logs with the person who did each step (user, 16 Nov 2026): their name, e-mail and
 * role, so any step can be traced back. Used by the platform admin's log, the hospital admin's
 * log and each appointment's history. Patient names, where shown, come live from the hospital
 * connector and are never stored by NeuroCapture.
 */
import { fmtDay } from './changes.tsx';
import { useMemo, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Button, fmt, fmtDate } from './ui.tsx';

export interface Who {
  name: string;
  email: string | null;
  role: string;
}
export interface LogRow {
  at: string;
  who: Who;
  action: string;
  details: Record<string, unknown> | null;
  /** Patient (live name if known, else the NCID). */
  patient?: string | null;
  hospital?: string | null;
}

const STAFF = new Set(['platform_admin', 'hospital_admin', 'receptionist', 'doctor']);

const KINDS: Record<string, RegExp> = {
  invites: /invite|patient_created|ncid_created|patient_closed|patient_locked/,
  appointments: /appointment|assigned|unassigned|recording_requested|request_cancelled|reminder/,
  recordings:
    /take_|session|clinic_consent|recording_viewed|history_viewed|reviewed|readiness|checksum/,
  setup: /staff_|operator_|device_|connector_|two_step|hospital_|login|key|storage|plan/,
};

type Tone = 'ok' | 'warn' | 'bad' | 'info';
const TONE_CLASS: Record<Tone, string> = {
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  bad: 'bg-bad-soft text-bad',
  info: 'bg-brand-soft text-brand-ink',
};
const TONE_ICON: Record<Tone, string> = { ok: '✓', warn: '◷', bad: '!', info: '•' };

/** v30: a colour and icon for a log row (never the only signal: the words say it). */
export function toneOf(action: string): Tone {
  if (/fail|not_delivered|withdrawn|cancelled|no_show|revoked|closed|locked/.test(action))
    return 'bad';
  if (/requested|change_|reset|offer|call_/.test(action)) return 'warn';
  if (/login|registered|accepted|enabled|uploaded|chosen|added|created|onboarded/.test(action))
    return 'ok';
  return 'info';
}

/** v30: rows grouped by day, newest day first ("today", "yesterday" or the date). */
export function groupByDay(
  rows: LogRow[],
  now: Date,
): { day: string; label: 'today' | 'yesterday' | 'date'; rows: LogRow[] }[] {
  const key = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = key(now);
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  const yesterday = key(y);
  const out = new Map<string, LogRow[]>();
  for (const r of [...rows].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))) {
    const k = key(new Date(r.at));
    out.set(k, [...(out.get(k) ?? []), r]);
  }
  return [...out.entries()].map(([day, rs]) => ({
    day,
    label: day === today ? 'today' : day === yesterday ? 'yesterday' : 'date',
    rows: rs,
  }));
}

/** The role in words; staff roles come from `roles.*`. */
export function roleText(t: TFunction, role: string): string {
  return t(`roles.${role}`, { defaultValue: t(`log.actor.${role}`, { defaultValue: role }) });
}

/** A plain sentence for a logged action ("Reassigned the patient: Dr. Rao → Dr. Iyer"). */
export function describe(t: TFunction, action: string, d: Record<string, unknown> | null): string {
  const x = d ?? {};
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(x))
    if (typeof v === 'string' || typeof v === 'number') params[k] = String(v);
  if (typeof x.channel === 'string')
    params.channel = t(`log.channel.${x.channel}`, { defaultValue: x.channel });
  if (typeof x.source === 'string')
    params.source = t(`log.source.${x.source}`, { defaultValue: x.source });
  if (typeof x.place === 'string')
    params.place = t(`log.place.${x.place}`, { defaultValue: x.place });
  else params.place = t('log.place.home');
  if (typeof x.reason === 'string')
    params.reason = t(`appts.notDone.${x.reason}`, { defaultValue: x.reason });
  if (Array.isArray(x.tests)) params.tests = x.tests.map((c) => t(`tests.${c}`)).join(', ');
  if (typeof x.due === 'string') params.due = fmtDate(x.due);
  if (typeof x.at === 'string') params.when = fmt(x.at);
  // v13 (decision 045): moves and patients' change requests.
  if (typeof x.from === 'string') params.from = fmt(x.from);
  if (action === 'appointment_moved' && typeof x.reason === 'string')
    params.reason = t(`moves.reason.${x.reason}`, { defaultValue: x.reason });
  if (action === 'change_requested') {
    if (Array.isArray(x.days)) params.days = x.days.map((d) => fmtDay(String(d))).join(', ');
    if (typeof x.part_of_day === 'string') params.part = t(`moves.part.${x.part_of_day}`);
    params.reason =
      typeof x.reason === 'string' ? t(`moves.patientReason.${x.reason}`) : t('moves.noReason');
  }
  // v14 (decision 046): offers, cancellations, bookings.
  if (action === 'change_requested' && typeof x.options === 'number')
    return t('log.action.change_requested_times', { ...params, count: x.options });
  if (action === 'appointment_cancelled' && typeof x.reason === 'string')
    params.reason = t(
      x.by === 'patient' ? `cancel.patientReason.${x.reason}` : `cancel.reasons.${x.reason}`,
      { defaultValue: x.reason },
    );
  if (action === 'appointment_cancelled' && typeof x.by === 'string')
    return t(`log.action.appointment_cancelled_${x.by}`, params);
  if (typeof x.purpose === 'string')
    params.purpose = t(`requests.purpose.${x.purpose}`, { defaultValue: x.purpose });
  if (typeof x.answer === 'string')
    params.answer = t(`moves.answer.${x.answer}`, { defaultValue: x.answer });
  if (typeof x.role === 'string') params.role = t(`roles.${x.role}`, { defaultValue: x.role });
  // v16 (decision 047): consent for clinic recordings.
  if (action === 'clinic_consent_given' && typeof x.via === 'string')
    return t(`log.action.clinic_consent_given_${x.via}`, {
      ...params,
      reason: t(`clinicConsent.reason.${String(x.reason ?? '')}`, {
        defaultValue: String(x.reason ?? ''),
      }),
    });
  if (action === 'staff_sign_in_reset' && typeof x.reason === 'string')
    params.reason = t(`reset.reasons.${x.reason}`, { defaultValue: x.reason });
  const fallback = action.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  // Decision 038: a booking names its doctor.
  const key =
    action === 'appointment_added' && params.doctor_name ? 'appointment_added_doctor' : action;
  return t(`log.action.${key}`, { ...params, defaultValue: fallback });
}

function csv(rows: LogRow[], t: TFunction): string {
  const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const head = ['When', 'Name', 'E-mail', 'Role', 'Hospital', 'What', 'Patient'];
  const lines = rows.map((r) =>
    [
      r.at,
      r.who.name,
      r.who.email ?? '',
      roleText(t, r.who.role),
      r.hospital ?? '',
      describe(t, r.action, r.details),
      r.patient ?? '',
    ]
      .map(q)
      .join(','),
  );
  return [head.map(q).join(','), ...lines].join('\n');
}

export function ActivityLog({
  rows,
  showHospital = false,
  showPatient = true,
  testId,
}: {
  rows: LogRow[];
  showHospital?: boolean;
  showPatient?: boolean;
  testId?: string;
}) {
  const { t } = useTranslation();
  const [person, setPerson] = useState('');
  const [kind, setKind] = useState('');
  const [from, setFrom] = useState('');
  const people = useMemo(() => {
    const m = new Map<string, Who>();
    for (const r of rows) m.set(`${r.who.name}|${r.who.email ?? ''}`, r.who);
    return [...m.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
  }, [rows]);
  const shown = rows.filter(
    (r) =>
      (!person || `${r.who.name}|${r.who.email ?? ''}` === person) &&
      (!kind || KINDS[kind]!.test(r.action)) &&
      (!from || r.at.slice(0, 10) >= from),
  );
  const download = () => {
    const url = URL.createObjectURL(new Blob([csv(shown, t)], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'activity-log.csv';
    a.click();
    URL.revokeObjectURL(url);
  };
  const sel =
    'h-9 rounded-full border-0 bg-card px-3 text-[13px] font-semibold shadow-[inset_0_0_0_1px_var(--color-edge)]';
  // v30 (canvas v28): kind chips and Export CSV in one row; the rows grouped by day in cards.
  const groups = groupByDay(shown, new Date());
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('log.what')}>
          {['', ...Object.keys(KINDS)].map((k) => (
            <button
              key={k || 'all'}
              type="button"
              aria-pressed={kind === k}
              onClick={() => setKind(k)}
              className={`min-h-9 rounded-full px-3.5 text-[13px] font-semibold ${kind === k ? 'bg-ink text-ground' : 'bg-card text-sub shadow-[inset_0_0_0_1px_var(--color-edge)]'}`}
              data-testid={`log-kind-${k || 'all'}`}
            >
              {t(`log.kind.${k || 'all'}`)}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <select
          className={`${sel} max-w-64`}
          value={person}
          onChange={(e) => setPerson(e.target.value)}
          aria-label={t('log.person')}
          data-testid="log-person"
        >
          <option value="">{t('log.everyone')}</option>
          {people.map(([k, w]) => (
            <option key={k} value={k}>
              {w.email ? `${w.name} · ${w.email}` : w.name}
            </option>
          ))}
        </select>
        <input
          type="date"
          className={sel}
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          aria-label={t('log.from')}
        />
        <Button variant="secondary" onClick={download} data-testid="log-csv">
          {t('log.csv')}
        </Button>
      </div>
      <div className="flex flex-col gap-4" data-testid={testId}>
        {shown.length === 0 && <p className="text-[14px] text-muted">{t('app.none')}</p>}
        {groups.map((g) => (
          <section
            key={g.day}
            className="nc-fu flex flex-col rounded-3xl bg-card px-5 py-4 shadow-card"
          >
            <h2 className="pb-1 text-[16px] font-bold">
              {g.label === 'today'
                ? t('log.today')
                : g.label === 'yesterday'
                  ? t('log.yesterday')
                  : fmtDate(g.day)}
            </h2>
            {g.rows.map((r, i) => {
              const tone = toneOf(r.action);
              return (
                <div key={i} className="flex items-center gap-3 border-t border-line py-3">
                  <span
                    aria-hidden
                    className={`inline-flex size-9 shrink-0 items-center justify-center rounded-xl text-[13px] font-extrabold ${TONE_CLASS[tone]}`}
                  >
                    {TONE_ICON[tone]}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-[14px]">
                      <b>{r.who.name}</b> · {describe(t, r.action, r.details)}
                    </span>
                    <span className="text-[12px] text-muted" data-testid="log-who">
                      {[
                        ...[r.who.email, roleText(t, r.who.role)].filter(
                          // Staff always show their role; "Patient (app)" etc. are not repeated.
                          (v) => v && (STAFF.has(r.who.role) || v !== r.who.name),
                        ),
                        ...(showHospital && r.hospital ? [r.hospital] : []),
                        ...(showPatient && r.patient ? [r.patient] : []),
                      ].join(' · ')}
                    </span>
                  </span>
                  <span className="shrink-0 text-[13px] text-muted tabular-nums">
                    {new Date(r.at).toLocaleTimeString('en-IN', {
                      hour: '2-digit',
                      minute: '2-digit',
                      hour12: false,
                    })}
                  </span>
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}
