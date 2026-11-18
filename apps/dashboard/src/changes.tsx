/**
 * v13 (decision 045): appointment changes.
 *
 * - MovePanel: the front desk picks a new date, then a doctor and a free time (doctors' clinic
 *   hours minus their booked appointments), and moves the appointment; or answers a patient's
 *   request with "please call us" / "keep the booked date".
 * - ChangeRequests: patients' open requests, oldest first.
 * - HospitalSettingsPage: phones' camera-check pass level, change cut-off, time zone.
 * - ClinicHours: each doctor's weekly hours and leave (Team page).
 * Times are the hospital's own time zone (the settings), whatever the browser's zone is.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { call, hospital } from './api.ts';
import { appointmentChanges } from './config.ts';
import { Badge, Button, Card, ErrorNote, Field, Notice, Page, Table, fmt } from './ui.tsx';

// --- Time in the hospital's zone ---

function parts(utcMs: number, tz: string): Record<string, number> {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  return Object.fromEntries(
    p.filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]),
  );
}
function offsetMs(utcMs: number, tz: string): number {
  const x = parts(utcMs, tz);
  return Date.UTC(x.year!, x.month! - 1, x.day!, x.hour!, x.minute!, x.second!) - utcMs;
}
const pad = (n: number) => String(n).padStart(2, '0');
/** "2026-11-26" in the hospital's zone. */
export function zonedDay(iso: string | number, tz: string): string {
  const x = parts(typeof iso === 'number' ? iso : Date.parse(iso), tz);
  return `${x.year}-${pad(x.month!)}-${pad(x.day!)}`;
}
export function zonedTime(iso: string, tz: string): string {
  const x = parts(Date.parse(iso), tz);
  return `${pad(x.hour!)}:${pad(x.minute!)}`;
}
/** A local day and "HH:MM" in `tz` as an ISO time (UTC). */
export function zonedIso(day: string, hhmm: string, tz: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y!, m! - 1, d!, h!, mi!);
  let t = guess - offsetMs(guess, tz);
  const again = guess - offsetMs(t, tz);
  if (again !== t) t = again;
  return new Date(t).toISOString();
}
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
}
/** Monday = 0. */
function weekday(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return (new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay() + 6) % 7;
}
export function fmtDay(day: string, withWeekday = true): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!, 12)).toLocaleDateString('en-IN', {
    timeZone: 'UTC',
    ...(withWeekday ? { weekday: 'short' } : {}),
    day: 'numeric',
    month: 'short',
  });
}
export function fmtTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2000, 0, 1, h, m)).toLocaleTimeString('en-IN', {
    timeZone: 'UTC',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// --- Types ---

export interface Settings {
  device_min_fps: number;
  change_cutoff_hours: number;
  patient_changes: boolean;
  time_zone: string;
  device_min_fps_options: number[];
  change_cutoff_hour_options: number[];
  warn_below_fps: number;
}
export interface ChangeReq {
  id: string;
  appointment_id: string;
  ncid: string;
  appointment_at: string;
  source: 'manual' | 'fhir';
  doctor_id: string | null;
  doctor_name: string | null;
  places: string[];
  days: string[];
  part_of_day: 'morning' | 'afternoon' | 'any';
  reason: string | null;
  status: string;
  created_at: string;
}
interface DoctorDay {
  doctor_id: string;
  doctor_name: string;
  department: string | null;
  has_hours: boolean;
  on_leave: boolean;
  hours: string[][];
  free: string[];
  booked: number;
}
/** What MovePanel needs of an appointment. */
export interface Movable {
  id: string;
  at: string;
  source: 'manual' | 'fhir';
  doctor_id: string | null;
  doctor_name: string | null;
}

export function useSettings(): Settings | null {
  const [s, setS] = useState<Settings | null>(null);
  useEffect(() => {
    call<Settings>('GET', '/hospital/settings').then(setS, () => undefined);
  }, []);
  return s;
}

// --- Move panel ---

export function MovePanel({
  appt,
  patient,
  request,
  canAssign,
  onDone,
  onClose,
}: {
  appt: Movable;
  patient: string;
  request?: ChangeReq;
  canAssign: boolean;
  onDone: (message: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const settings = useSettings();
  const tz = settings?.time_zone ?? 'UTC';
  const [now] = useState(() => Date.now());
  const today = settings ? zonedDay(now, tz) : null;
  const booked = settings ? zonedDay(appt.at, tz) : null;
  const [day, setDay] = useState<string | null>(null);
  const [doctor, setDoctor] = useState<string | null>(appt.doctor_id);
  const [time, setTime] = useState('');
  const [reason, setReason] = useState(request ? 'patient_request' : '');
  const [notify, setNotify] = useState(true);
  const [doctors, setDoctors] = useState<DoctorDay[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [declining, setDeclining] = useState(false);

  // First day shown: the patient's first choice, else the booked day.
  const shownDay = day ?? (settings ? (request?.days[0] ?? booked) : null);
  useEffect(() => {
    if (!shownDay) return;
    let off = false;
    call<{ doctors: DoctorDay[] }>(
      'GET',
      `/hospital/availability?date=${shownDay}&appointment_id=${appt.id}`,
    ).then(
      (r) => !off && setDoctors(r.doctors),
      (e) => !off && setError(e),
    );
    return () => {
      off = true;
    };
  }, [shownDay, appt.id]);

  const weeks = useMemo(() => {
    if (!today) return [];
    const start = addDays(today, -weekday(today));
    return Array.from({ length: 5 }, (_, w) =>
      Array.from({ length: 7 }, (_, d) => addDays(start, w * 7 + d)),
    );
  }, [today]);

  const pick = (d: string) => {
    setDay(d);
    setTime('');
    setDoctors(null);
  };
  const shown = (doctors ?? []).filter((d) => canAssign || d.doctor_id === appt.doctor_id);
  const chosen = doctor ?? appt.doctor_id;
  const chosenName = shown.find((d) => d.doctor_id === chosen)?.doctor_name ?? appt.doctor_name;
  const ready = !!shownDay && /^\d\d:\d\d$/.test(time) && !!reason;

  const move = async () => {
    setBusy(true);
    setError(null);
    try {
      await call('POST', `/hospital/appointments/${appt.id}/move`, {
        at: zonedIso(shownDay!, time, tz),
        doctor_id: chosen,
        reason,
        notify,
        change_request_id: request?.id ?? null,
      });
      onDone(
        t('moves.done', {
          name: patient,
          when: `${fmtDay(shownDay!)}, ${fmtTime(time)}`,
          doctor: chosenName ?? '',
        }),
      );
    } catch (e) {
      setError(e);
    }
    setBusy(false);
  };
  const decline = async (answer: string) => {
    setBusy(true);
    setError(null);
    try {
      await call('POST', `/hospital/change-requests/${request!.id}/decline`, { answer, notify });
      onDone(t('moves.declined', { name: patient }));
    } catch (e) {
      setError(e);
    }
    setBusy(false);
  };

  if (!settings || !today) return <p className="text-muted">{t('app.loading')}</p>;
  return (
    <section
      className="flex flex-col gap-4 rounded-2xl border border-brand bg-white p-5"
      data-testid="move-panel"
      aria-label={t('moves.title', { name: patient })}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[18px] font-bold">{t('moves.title', { name: patient })}</h2>
          <span className="text-[13px] text-muted">
            {t('moves.booked', { when: fmt(appt.at), doctor: appt.doctor_name ?? '—' })} ·{' '}
            {t('moves.zone', { tz })}
          </span>
        </div>
        <Button variant="secondary" onClick={onClose} data-testid="move-close">
          {t('moves.close')}
        </Button>
      </div>
      {appt.source === 'fhir' && (
        <Notice tone="warn" testId="move-fhir">
          {t('moves.fhir')}
        </Notice>
      )}
      {request && (
        <Notice testId="move-request">
          {t('moves.wants', {
            days: request.days.map((d) => fmtDay(d)).join(', '),
            part: t(`moves.part.${request.part_of_day}`),
            reason: request.reason ? t(`moves.patientReason.${request.reason}`) : '—',
          })}
        </Notice>
      )}
      <div className="flex flex-wrap items-start gap-5">
        <div className="flex min-w-[300px] flex-1 flex-col gap-2">
          <b className="text-[15px]">{t('moves.step1')}</b>
          <div className="grid grid-cols-7 gap-1.5" role="grid" aria-label={t('moves.step1')}>
            {['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((w) => (
              <span key={w} className="text-center text-[12px] text-muted">
                {t(`moves.wd.${w}`)}
              </span>
            ))}
            {weeks.flat().map((d) => {
              const past = d < today;
              const sel = d === shownDay;
              const wanted = request?.days.includes(d);
              const cls = sel
                ? 'border-brand bg-brand text-white'
                : d === booked
                  ? 'border-[#E8B96B] bg-warn-soft text-warn'
                  : wanted
                    ? 'border-brand bg-brand-soft text-brand'
                    : 'border-[#C9CFD8] bg-white text-ink';
              return (
                <button
                  key={d}
                  type="button"
                  disabled={past}
                  aria-pressed={sel}
                  aria-label={fmtDay(d)}
                  onClick={() => pick(d)}
                  className={`h-10 rounded-lg border text-[14px] font-semibold disabled:opacity-35 ${cls}`}
                  data-testid={`move-day-${d}`}
                >
                  {Number(d.slice(8))}
                </button>
              );
            })}
          </div>
          <span className="flex flex-wrap gap-3 text-[12px] text-muted">
            {request && <span className="text-brand">■ {t('moves.legendWanted')}</span>}
            <span className="text-warn">■ {t('moves.legendBooked')}</span>
          </span>
        </div>
        <div className="flex min-w-[320px] flex-1 flex-col gap-2" data-testid="move-doctors">
          <b className="text-[15px]">{t('moves.step2', { day: fmtDay(shownDay!) })}</b>
          <span className="text-[13px] text-muted">{t('moves.freeHint')}</span>
          {!doctors && <span className="text-muted">{t('app.loading')}</span>}
          {shown.map((d) => {
            const sel = d.doctor_id === chosen;
            const state = d.on_leave
              ? ['bad', t('moves.onLeave')]
              : !d.has_hours
                ? ['neutral', t('moves.noHours')]
                : d.free.length
                  ? ['ok', t('moves.free', { count: d.free.length })]
                  : ['bad', t('moves.notFree')];
            return (
              <div
                key={d.doctor_id}
                className={`flex flex-col gap-2 rounded-xl border bg-white p-3 ${sel ? 'border-2 border-brand' : 'border-line'}`}
                data-testid={`move-doctor-${d.doctor_name}`}
              >
                <label className="flex items-center gap-2.5">
                  <input
                    type="radio"
                    name={`doctor-${appt.id}`}
                    checked={sel}
                    onChange={() => {
                      setDoctor(d.doctor_id);
                      setTime('');
                    }}
                    className="h-4 w-4"
                  />
                  <b className="flex-1">
                    {d.doctor_name}
                    <span className="font-normal text-muted">
                      {d.department ? ` · ${d.department}` : ''}
                      {d.doctor_id === appt.doctor_id ? ` · ${t('moves.bookedDoctor')}` : ''}
                    </span>
                  </b>
                  <Badge tone={state[0] as 'ok' | 'bad' | 'neutral'}>{state[1]}</Badge>
                </label>
                {d.free.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pl-6">
                    {d.free.map((f) => (
                      <button
                        key={f}
                        type="button"
                        aria-pressed={sel && time === f}
                        onClick={() => {
                          setDoctor(d.doctor_id);
                          setTime(f);
                        }}
                        className={`min-h-9 rounded-full border px-3 text-[13px] font-semibold ${sel && time === f ? 'border-brand bg-brand text-white' : 'border-[#C9CFD8] bg-white'}`}
                        data-testid={`move-slot-${f}`}
                      >
                        {fmtTime(f)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          <label className="flex items-center gap-2 text-[13px] text-[#3D4552]">
            {t('moves.otherTime')}
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="h-10 rounded-lg border border-[#C9CFD8] px-2"
              data-testid="move-time"
            />
          </label>
        </div>
      </div>
      {chosen && chosen !== appt.doctor_id && (
        <Notice tone="warn" testId="move-doctor-change">
          {t('moves.doctorChange', { to: chosenName ?? '', from: appt.doctor_name ?? '—' })}
        </Notice>
      )}
      <div className="flex flex-wrap items-end gap-4">
        {!request && (
          <label className="flex flex-col gap-1 text-[13px] font-semibold text-[#3D4552]">
            {t('moves.why')}
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="h-11 rounded-xl border border-[#C9CFD8] bg-white px-2 font-normal"
              data-testid="move-reason"
            >
              <option value="">{t('moves.chooseWhy')}</option>
              {appointmentChanges.deskReasons
                .filter((r) => r !== 'patient_request')
                .map((r) => (
                  <option key={r} value={r}>
                    {t(`moves.reason.${r}`)}
                  </option>
                ))}
            </select>
          </label>
        )}
        <label className="flex min-h-11 items-center gap-2 text-[14px]">
          <input
            type="checkbox"
            checked={notify}
            onChange={(e) => setNotify(e.target.checked)}
            className="h-4 w-4"
            data-testid="move-notify"
          />
          {t('moves.notify')}
        </label>
      </div>
      <ErrorNote error={error} />
      <div className="flex flex-wrap gap-2.5">
        <Button disabled={busy || !ready} onClick={() => void move()} data-testid="move-save">
          {ready
            ? t('moves.save', {
                when: `${fmtDay(shownDay!)}, ${fmtTime(time)}`,
                doctor: chosenName ?? '',
              })
            : t('moves.saveIncomplete')}
        </Button>
        {request && (
          <Button
            variant="secondary"
            onClick={() => setDeclining((v) => !v)}
            data-testid="move-decline-open"
          >
            {t('moves.noneWork')}
          </Button>
        )}
      </div>
      {request && declining && (
        <Card title={t('moves.declineTitle')} testId="move-decline">
          <span className="text-[13px] text-muted">{t('moves.declineHint')}</span>
          <div className="flex flex-wrap gap-2">
            {appointmentChanges.declineAnswers.map((a) => (
              <Button
                key={a}
                variant="secondary"
                disabled={busy}
                onClick={() => void decline(a)}
                data-testid={`move-decline-${a}`}
              >
                {t(`moves.answer.${a}`)}
              </Button>
            ))}
          </div>
        </Card>
      )}
    </section>
  );
}

// --- Patients' requests ---

interface Ident {
  ncid: string;
  mrn: string;
  name: string | null;
}

export function ChangeRequests({
  canAssign,
  onChanged,
}: {
  canAssign: boolean;
  onChanged: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<ChangeReq[] | null>(null);
  const [ident, setIdent] = useState<Record<string, Ident>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let off = false;
    void (async () => {
      try {
        const list = await call<ChangeReq[]>('GET', '/hospital/change-requests');
        const ncids = [...new Set(list.map((r) => r.ncid))];
        const ids = ncids.length
          ? await hospital<Ident[]>('POST', '/v1/patients/lookup', { ncids })
          : [];
        if (off) return;
        setRows(list);
        setIdent(Object.fromEntries(ids.map((i) => [i.ncid, i])));
      } catch (e) {
        if (!off) setError(e);
      }
    })();
    return () => {
      off = true;
    };
  }, [version]);
  const name = (r: ChangeReq) => ident[r.ncid]?.name ?? r.ncid;

  return (
    <div className="flex flex-col gap-3" data-testid="change-requests">
      <ErrorNote error={error} />
      {rows && rows.length > 0 && (
        <Notice tone="warn">{t('moves.inboxHint', { count: rows.length })}</Notice>
      )}
      {rows?.length === 0 && <Notice testId="no-change-requests">{t('moves.inboxEmpty')}</Notice>}
      {rows && rows.length > 0 && (
        <Table
          head={[
            t('appts.patient'),
            t('moves.bookedCol'),
            t('moves.wantsCol'),
            t('appts.whereTitle'),
            t('moves.askedCol'),
            '',
          ]}
          testId="change-table"
        >
          {rows.map((r) => (
            <tr
              key={r.id}
              className="border-t border-[#EDF0F3]"
              data-testid={`change-${ident[r.ncid]?.mrn ?? r.ncid}`}
            >
              <td className="px-4 py-3">
                <b>{name(r)}</b>
                {ident[r.ncid] && (
                  <span className="block text-[12px] text-muted">MRN {ident[r.ncid]!.mrn}</span>
                )}
              </td>
              <td className="px-4 py-3">
                <b>{fmt(r.appointment_at)}</b>
                <span className="block text-[12px] text-muted">{r.doctor_name ?? '—'}</span>
              </td>
              <td className="px-4 py-3">
                {r.days.map((d) => fmtDay(d)).join(', ')} · {t(`moves.part.${r.part_of_day}`)}
                <span className="block text-[12px] text-muted">
                  {t('moves.reasonLine', {
                    reason: r.reason ? t(`moves.patientReason.${r.reason}`) : '—',
                  })}
                </span>
              </td>
              <td className="px-4 py-3">
                {r.places.length
                  ? r.places.map((p) => (
                      <Badge key={p} tone="neutral">
                        {t(`appts.where.${p}`)}
                      </Badge>
                    ))
                  : '—'}
              </td>
              <td className="px-4 py-3 text-[13px]">{fmt(r.created_at)}</td>
              <td className="px-4 py-3 text-right">
                <Button
                  onClick={() => setOpen(open === r.id ? null : r.id)}
                  data-testid="change-choose"
                >
                  {t('moves.choose')}
                </Button>
              </td>
            </tr>
          ))}
        </Table>
      )}
      {rows
        ?.filter((r) => r.id === open)
        .map((r) => (
          <MovePanel
            key={r.id}
            appt={{
              id: r.appointment_id,
              at: r.appointment_at,
              source: r.source,
              doctor_id: r.doctor_id,
              doctor_name: r.doctor_name,
            }}
            patient={name(r)}
            request={r}
            canAssign={canAssign}
            onClose={() => setOpen(null)}
            onDone={(m) => {
              setOpen(null);
              setVersion((v) => v + 1);
              onChanged(m);
            }}
          />
        ))}
    </div>
  );
}

// --- Hospital settings (hospital admin) ---

function timeZones(current: string): string[] {
  const all = (
    Intl as unknown as { supportedValuesOf?: (k: string) => string[] }
  ).supportedValuesOf?.('timeZone') ?? ['UTC'];
  return all.includes(current) ? all : [current, ...all];
}

export function HospitalSettingsPage() {
  const { t } = useTranslation();
  const [s, setS] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Partial<Settings>>({});
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    call<Settings>('GET', '/hospital/settings').then(setS, setError);
  }, []);
  const v = { ...s, ...draft } as Settings;
  const save = async () => {
    setError(null);
    setSaved(false);
    try {
      setS(await call<Settings>('PUT', '/hospital/settings', draft));
      setDraft({});
      setSaved(true);
    } catch (e) {
      setError(e);
    }
  };
  const select = 'h-11 rounded-xl border border-[#C9CFD8] bg-white px-2 font-normal';
  return (
    <Page title={t('settings.title')}>
      <ErrorNote error={error} />
      {saved && <Notice testId="settings-saved">{t('settings.saved')}</Notice>}
      {s && (
        <>
          <Card title={t('settings.phonesTitle')} testId="settings-phones">
            <span className="text-[14px] text-[#3D4552]">{t('settings.phonesHint')}</span>
            <label className="flex max-w-md flex-col gap-1 text-[13px] font-semibold text-[#3D4552]">
              {t('settings.minFps')}
              <select
                value={v.device_min_fps}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, device_min_fps: Number(e.target.value) }))
                }
                className={select}
                data-testid="settings-fps"
              >
                {s.device_min_fps_options.map((o) => (
                  <option key={o} value={o}>
                    {t('settings.fpsOption', { fps: o })}
                  </option>
                ))}
              </select>
            </label>
            <span className="text-[13px] text-muted">
              {t('settings.fpsNote', { warn: s.warn_below_fps })}
            </span>
          </Card>
          <Card title={t('settings.changesTitle')} testId="settings-changes">
            <label className="flex min-h-11 items-center gap-2 text-[14px]">
              <input
                type="checkbox"
                checked={v.patient_changes}
                onChange={(e) => setDraft((d) => ({ ...d, patient_changes: e.target.checked }))}
                className="h-4 w-4"
                data-testid="settings-patient-changes"
              />
              {t('settings.patientChanges')}
            </label>
            <label className="flex max-w-md flex-col gap-1 text-[13px] font-semibold text-[#3D4552]">
              {t('settings.cutoff')}
              <select
                value={v.change_cutoff_hours}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, change_cutoff_hours: Number(e.target.value) }))
                }
                className={select}
                data-testid="settings-cutoff"
              >
                {s.change_cutoff_hour_options.map((o) => (
                  <option key={o} value={o}>
                    {t('settings.hours', { count: o })}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex max-w-md flex-col gap-1 text-[13px] font-semibold text-[#3D4552]">
              {t('settings.timeZone')}
              <select
                value={v.time_zone}
                onChange={(e) => setDraft((d) => ({ ...d, time_zone: e.target.value }))}
                className={select}
                data-testid="settings-tz"
              >
                {timeZones(v.time_zone).map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            </label>
            <span className="text-[13px] text-muted">{t('settings.timeZoneHint')}</span>
          </Card>
          <Button
            className="self-start"
            disabled={!Object.keys(draft).length}
            onClick={() => void save()}
            data-testid="settings-save"
          >
            {t('settings.save')}
          </Button>
        </>
      )}
    </Page>
  );
}

// --- Clinic hours (Team page) ---

interface Hours {
  doctor_id: string;
  doctor_name: string;
  department: string | null;
  week: Record<string, string[][]>;
  slot_minutes: number;
  leave: { from: string; to: string }[];
  has_hours: boolean;
}
const WEEK = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const showSpans = (spans: string[][] | undefined) =>
  (spans ?? []).map(([a, b]) => `${a}-${b}`).join(', ');
/** "09:00-13:00, 14:00-17:00" → [["09:00","13:00"],["14:00","17:00"]]; null when not valid. */
export function parseSpans(text: string): string[][] | null {
  const out: string[][] = [];
  for (const part of text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const m = /^(\d{1,2}):(\d\d)\s*[-–]\s*(\d{1,2}):(\d\d)$/.exec(part);
    if (!m) return null;
    out.push([`${pad(Number(m[1]))}:${m[2]}`, `${pad(Number(m[3]))}:${m[4]}`]);
  }
  return out;
}

export function ClinicHours() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Hours[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const reload = useCallback(() => {
    call<Hours[]>('GET', '/hospital/doctor-hours').then(setRows, setError);
  }, []);
  useEffect(reload, [reload]);
  return (
    <Card title={t('hours.title')} testId="clinic-hours">
      <span className="max-w-3xl text-[14px] text-[#3D4552]">{t('hours.hint')}</span>
      <ErrorNote error={error} />
      {rows?.length === 0 && <span className="text-muted">{t('hours.noDoctors')}</span>}
      {(rows ?? []).map((r) => (
        <DoctorHoursRow key={r.doctor_id} row={r} onSaved={reload} />
      ))}
    </Card>
  );
}

function DoctorHoursRow({ row, onSaved }: { row: Hours; onSaved: () => void }) {
  const { t } = useTranslation();
  const [days, setDays] = useState<Record<string, string>>(
    Object.fromEntries(WEEK.map((d) => [d, showSpans(row.week[d])])),
  );
  const [dept, setDept] = useState(row.department ?? '');
  const [slot, setSlot] = useState(row.slot_minutes);
  const [leave, setLeave] = useState(row.leave);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const bad = WEEK.filter((d) => parseSpans(days[d] ?? '') === null);
  const save = async () => {
    setError(null);
    setDone(false);
    try {
      await call('PUT', `/hospital/doctor-hours/${row.doctor_id}`, {
        department: dept || null,
        slot_minutes: slot,
        week: Object.fromEntries(WEEK.map((d) => [d, parseSpans(days[d] ?? '') ?? []])),
        leave: leave.filter((l) => l.from && l.to),
      });
      setDone(true);
      onSaved();
    } catch (e) {
      setError(e);
    }
  };
  const id = row.doctor_name.replace(/\W+/g, '-');
  return (
    <div
      className="flex flex-col gap-3 border-t border-[#EDF0F3] pt-3"
      data-testid={`hours-${row.doctor_name}`}
    >
      <div className="flex flex-wrap items-end gap-3">
        <b className="min-w-[160px] text-[15px]">
          {row.doctor_name} {!row.has_hours && <Badge tone="warn">{t('hours.notSet')}</Badge>}
        </b>
        <Field
          id={`dept-${id}`}
          label={t('hours.department')}
          value={dept}
          onChange={(e) => setDept(e.target.value)}
          data-testid="hours-dept"
        />
        <label className="flex flex-col gap-1 text-[13px] font-semibold text-[#3D4552]">
          {t('hours.slot')}
          <select
            value={slot}
            onChange={(e) => setSlot(Number(e.target.value))}
            className="h-11 rounded-xl border border-[#C9CFD8] bg-white px-2 font-normal"
            data-testid="hours-slot"
          >
            {appointmentChanges.slotMinuteOptions.map((m) => (
              <option key={m} value={m}>
                {t('hours.minutes', { count: m })}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
        {WEEK.map((d) => (
          <Field
            key={d}
            id={`${id}-${d}`}
            label={t(`hours.day.${d}`)}
            placeholder="09:00-13:00, 14:00-17:00"
            value={days[d] ?? ''}
            aria-invalid={bad.includes(d)}
            onChange={(e) => setDays((x) => ({ ...x, [d]: e.target.value }))}
            data-testid={`hours-${d}`}
          />
        ))}
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-[13px] font-semibold text-[#3D4552]">{t('hours.leave')}</span>
        {leave.map((l, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2">
            <Field
              id={`${id}-from-${i}`}
              type="date"
              label={t('hours.from')}
              value={l.from}
              onChange={(e) =>
                setLeave((x) => x.map((y, j) => (j === i ? { ...y, from: e.target.value } : y)))
              }
            />
            <Field
              id={`${id}-to-${i}`}
              type="date"
              label={t('hours.to')}
              value={l.to}
              onChange={(e) =>
                setLeave((x) => x.map((y, j) => (j === i ? { ...y, to: e.target.value } : y)))
              }
            />
            <Button
              variant="secondary"
              onClick={() => setLeave((x) => x.filter((_, j) => j !== i))}
            >
              {t('hours.removeLeave')}
            </Button>
          </div>
        ))}
        <Button
          variant="secondary"
          className="self-start"
          onClick={() => setLeave((x) => [...x, { from: '', to: '' }])}
          data-testid="hours-add-leave"
        >
          {t('hours.addLeave')}
        </Button>
      </div>
      {bad.length > 0 && <Notice tone="bad">{t('hours.badFormat')}</Notice>}
      <ErrorNote error={error} />
      {done && <Notice testId="hours-saved">{t('hours.saved')}</Notice>}
      <Button
        className="self-start"
        disabled={bad.length > 0}
        onClick={() => void save()}
        data-testid="hours-save"
      >
        {t('hours.save')}
      </Button>
    </div>
  );
}
