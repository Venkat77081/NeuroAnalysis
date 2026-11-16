/**
 * Activity logs with the person who did each step (user, 16 Nov 2026): their name, e-mail and
 * role, so any step can be traced back. Used by the platform admin's log, the hospital admin's
 * log and each appointment's history. Patient names, where shown, come live from the hospital
 * connector and are never stored by NeuroCapture.
 */
import { useMemo, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Button, Table, fmt, fmtDate } from './ui.tsx';

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
  recordings: /take_|session|recording_viewed|history_viewed|reviewed|readiness|checksum/,
  setup: /staff_|operator_|device_|connector_|two_step|hospital_|login|key|storage|plan/,
};

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
  const fallback = action.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  return t(`log.action.${action}`, { ...params, defaultValue: fallback });
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
  const sel = 'h-11 rounded-xl border border-[#C9CFD8] bg-white px-2 text-[14px] font-normal';
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-[13px] font-semibold text-[#3D4552]">
          {t('log.person')}
          <select
            className={`${sel} min-w-64`}
            value={person}
            onChange={(e) => setPerson(e.target.value)}
            data-testid="log-person"
          >
            <option value="">{t('log.everyone')}</option>
            {people.map(([k, w]) => (
              <option key={k} value={k}>
                {w.email ? `${w.name} · ${w.email}` : w.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[13px] font-semibold text-[#3D4552]">
          {t('log.what')}
          <select className={sel} value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">{t('log.kind.all')}</option>
            {Object.keys(KINDS).map((k) => (
              <option key={k} value={k}>
                {t(`log.kind.${k}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[13px] font-semibold text-[#3D4552]">
          {t('log.from')}
          <input
            type="date"
            className={sel}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <Button variant="secondary" onClick={download} data-testid="log-csv">
          {t('log.csv')}
        </Button>
      </div>
      {shown.length === 0 ? (
        <p className="text-[14px] text-muted">{t('app.none')}</p>
      ) : (
        <Table
          head={[
            t('log.when'),
            t('log.who'),
            ...(showHospital ? [t('log.hospital')] : []),
            t('log.what'),
            ...(showPatient ? [t('log.patient')] : []),
          ]}
          testId={testId}
        >
          {shown.map((r, i) => (
            <tr key={i} className="border-t border-[#EDF0F3] align-top">
              <td className="px-4 py-3 whitespace-nowrap text-muted">{fmt(r.at)}</td>
              <td className="px-4 py-3" data-testid="log-who">
                <span className="font-semibold">{r.who.name}</span>
                <span className="block text-[12px] text-muted">
                  {[r.who.email, roleText(t, r.who.role)]
                    // Staff always show their role; "Patient (app)" etc. are not repeated.
                    .filter((v) => v && (STAFF.has(r.who.role) || v !== r.who.name))
                    .join(' · ')}
                </span>
              </td>
              {showHospital && <td className="px-4 py-3">{r.hospital ?? '—'}</td>}
              <td className="px-4 py-3">{describe(t, r.action, r.details)}</td>
              {showPatient && <td className="px-4 py-3">{r.patient ?? '—'}</td>}
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
