/**
 * The front desk's appointment work (v13 decision 045, v14 decision 046).
 *
 * - MovePanel: a calendar, then each doctor's free times (clinic hours minus booked appointments
 *   and times held for other patients). "Move it now" moves the appointment; "Offer choices" sends
 *   the patient up to N held times to choose from (patients in the app only).
 * - RequestPanel: a patient's change or booking request, each time checked now; book one, offer
 *   other times, or decline with a reason.
 * - RequestsTab: one inbox for new bookings, change requests, offers waiting or without an answer,
 *   and appointments the patient cancelled.
 * - CancelDialog: cancel with a reason, at any time.
 * Times are the hospital's own time zone (Settings), whatever the browser's zone is.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { call, hospital } from './api.ts';
import { appointmentChanges } from './config.ts';
import {
  addDays,
  fmtDay,
  fmtTime,
  useSettings,
  weekday,
  zonedDay,
  zonedIso,
  zonedTime,
} from './changes.tsx';
import { Badge, Button, Card, Dialog, DialogFooter, ErrorNote, Notice, Table, fmt } from './ui.tsx';
import type { RequestOut as LinkOut } from './appointments.tsx';

// --- Types ---

export interface Choice {
  at: string;
  rank: 'preferred' | 'alternative';
  state: 'free' | 'taken' | 'leave' | 'off' | 'past' | null;
  doctor_id: string | null;
  doctor_name: string | null;
}
export interface PatientRequest {
  id: string;
  kind: 'change' | 'booking';
  ncid: string;
  appointment_id: string | null;
  appointment_at: string | null;
  source: 'manual' | 'fhir' | 'app' | null;
  doctor_id: string | null;
  doctor_name: string | null;
  any_doctor: boolean;
  places: string[];
  choices: Choice[];
  days: string[] | null;
  part_of_day: string | null;
  reason: string | null;
  purpose: string | null;
  status: string;
  created_at: string;
  joined: boolean;
}
interface Option {
  index: number;
  at: string;
  doctor_id: string;
  doctor_name: string | null;
  other_doctor: boolean;
}
export interface OfferRow {
  id: string;
  kind: 'change' | 'booking';
  ncid: string;
  appointment_id: string | null;
  appointment_at: string | null;
  doctor_name: string | null;
  options: Option[];
  reply_by: string;
  status: 'open' | 'call_requested';
  no_answer: boolean;
  current_possible: boolean;
  reason: string;
  created_at: string;
}
interface CancelRow {
  appointment_id: string;
  ncid: string;
  at: string;
  doctor_name: string | null;
  reason: string | null;
  cancelled_at: string | null;
}
export interface Inbox {
  requests: PatientRequest[];
  offers: OfferRow[];
  cancellations: CancelRow[];
  count: number;
}
interface DoctorDay {
  doctor_id: string;
  doctor_name: string;
  department: string | null;
  has_hours: boolean;
  on_leave: boolean;
  hours: string[][];
  free: string[];
  held: string[];
  booked: number;
}
/** What MovePanel needs of an appointment. */
export interface Movable {
  id: string;
  at: string;
  source: 'manual' | 'fhir' | 'app' | null;
  doctor_id: string | null;
  doctor_name: string | null;
  requests?: LinkOut[];
}
interface Ident {
  ncid: string;
  mrn: string;
  name: string | null;
}
interface Pick {
  day: string;
  time: string;
  doctor_id: string;
  doctor_name: string;
}

const chipCls = (on: boolean) =>
  `min-h-9 rounded-full border px-3 text-[13px] font-semibold ${on ? 'border-brand bg-brand text-white' : 'border-[#C9CFD8] bg-white'}`;

// --- Move panel ---

export function MovePanel({
  appt,
  patient,
  request,
  canAssign,
  canOffer,
  startMode = 'now',
  onDone,
  onClose,
}: {
  /** Null: a booking request (nothing booked yet). */
  appt: Movable | null;
  patient: string;
  /** The patient's request this answers (its times highlighted; offers answer it). */
  request?: PatientRequest;
  canAssign: boolean;
  /** The patient uses the app, so they can choose from offered times. */
  canOffer: boolean;
  startMode?: 'now' | 'offer';
  onDone: (message: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const settings = useSettings();
  const tz = settings?.time_zone ?? 'UTC';
  const [now] = useState(() => Date.now());
  const today = settings ? zonedDay(now, tz) : null;
  const booked = settings && appt ? zonedDay(appt.at, tz) : null;
  const wanted = useMemo(
    () => new Set((request?.choices ?? []).map((c) => zonedDay(c.at, tz))),
    [request, tz],
  );
  const [mode, setMode] = useState<'now' | 'offer'>(appt ? startMode : 'offer');
  const [day, setDay] = useState<string | null>(null);
  const [doctor, setDoctor] = useState<string | null>(appt?.doctor_id ?? null);
  const [time, setTime] = useState('');
  const [picks, setPicks] = useState<Pick[]>([]);
  const [currentPossible, setCurrentPossible] = useState(false);
  const [reason, setReason] = useState(request ? 'patient_request' : '');
  const [notify, setNotify] = useState(true);
  const [doctors, setDoctors] = useState<DoctorDay[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const offering = mode === 'offer';
  const max = settings?.offer_max ?? 3;

  // First day shown: the patient's first choice, else the booked day, else today.
  const firstWanted = request?.choices[0] ? zonedDay(request.choices[0].at, tz) : null;
  const shownDay = day ?? (settings ? (firstWanted ?? booked ?? today) : null);
  useEffect(() => {
    if (!shownDay) return;
    let off = false;
    call<{ doctors: DoctorDay[] }>(
      'GET',
      `/hospital/availability?date=${shownDay}${appt ? `&appointment_id=${appt.id}` : ''}`,
    ).then(
      (r) => !off && setDoctors(r.doctors),
      (e) => !off && setError(e),
    );
    return () => {
      off = true;
    };
  }, [shownDay, appt]);

  const weeks = useMemo(() => {
    if (!today) return [];
    const start = addDays(today, -weekday(today));
    return Array.from({ length: 6 }, (_, w) =>
      Array.from({ length: 7 }, (_, d) => addDays(start, w * 7 + d)),
    );
  }, [today]);

  const pickDay = (d: string) => {
    setDay(d);
    setTime('');
    setDoctors(null);
  };
  const shown = (doctors ?? []).filter((d) => canAssign || d.doctor_id === appt?.doctor_id);
  const chosen = doctor ?? appt?.doctor_id ?? null;
  const chosenName =
    shown.find((d) => d.doctor_id === chosen)?.doctor_name ?? appt?.doctor_name ?? '';
  const picked = (d: string, f: string) =>
    picks.some((p) => p.day === shownDay && p.time === f && p.doctor_id === d);
  const togglePick = (d: DoctorDay, f: string) =>
    setPicks((x) =>
      picked(d.doctor_id, f)
        ? x.filter((p) => !(p.day === shownDay && p.time === f && p.doctor_id === d.doctor_id))
        : x.length >= max
          ? x
          : [...x, { day: shownDay!, time: f, doctor_id: d.doctor_id, doctor_name: d.doctor_name }],
    );
  const typedPick = () => {
    if (!/^\d\d:\d\d$/.test(time) || !chosen || picks.length >= max) return;
    setPicks((x) => [...x, { day: shownDay!, time, doctor_id: chosen, doctor_name: chosenName }]);
    setTime('');
  };
  const readyNow = !!appt && !!shownDay && /^\d\d:\d\d$/.test(time) && !!reason;
  const readyOffer = picks.length > 0 && !!reason;

  const move = async () => {
    setBusy(true);
    setError(null);
    try {
      if (request && appt) {
        await call('POST', `/hospital/change-requests/${request.id}/book`, {
          at: zonedIso(shownDay!, time, tz),
          doctor_id: chosen,
          notify,
        });
      } else {
        await call('POST', `/hospital/appointments/${appt!.id}/move`, {
          at: zonedIso(shownDay!, time, tz),
          doctor_id: chosen,
          reason,
          notify,
        });
      }
      onDone(
        t('moves.done', {
          name: patient,
          when: `${fmtDay(shownDay!)}, ${fmtTime(time)}`,
          doctor: chosenName,
        }),
      );
    } catch (e) {
      setError(e);
    }
    setBusy(false);
  };
  const offer = async () => {
    setBusy(true);
    setError(null);
    try {
      await call('POST', '/hospital/offers', {
        ...(request ? { request_id: request.id } : { appointment_id: appt!.id }),
        options: picks.map((p) => ({ at: zonedIso(p.day, p.time, tz), doctor_id: p.doctor_id })),
        current_possible: !!appt && currentPossible,
        reason,
        notify,
      });
      onDone(t('offers.sent', { name: patient, count: picks.length }));
    } catch (e) {
      setError(e);
    }
    setBusy(false);
  };

  const dialogTitle = appt
    ? t('moves.title', { name: patient })
    : t('offers.bookTitle', { name: patient });
  if (!settings || !today)
    return (
      <Dialog title={dialogTitle} size="lg" onClose={onClose} testId="move-panel">
        <p className="text-muted">{t('app.loading')}</p>
      </Dialog>
    );
  return (
    <Dialog
      title={dialogTitle}
      sub={`${
        appt
          ? `${t('moves.booked', { when: fmt(appt.at), doctor: appt.doctor_name ?? '—' })} · `
          : ''
      }${t('moves.zone', { tz })}`}
      size="lg"
      dirty={picks.length > 0 || !!time}
      onClose={onClose}
      testId="move-panel"
    >
      {appt && (
        <div className="flex flex-wrap items-center gap-3">
          <div
            role="group"
            className="flex overflow-hidden rounded-xl border border-[#C9CFD8] bg-white"
          >
            {(['now', 'offer'] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                disabled={m === 'offer' && !canOffer}
                onClick={() => setMode(m)}
                className={`min-h-11 px-4 text-[14px] font-semibold disabled:opacity-40 ${mode === m ? 'bg-brand text-white' : ''}`}
                data-testid={`move-mode-${m}`}
              >
                {t(`offers.mode.${m}`, { name: patient })}
              </button>
            ))}
          </div>
          <span className="text-[13px] text-muted">
            {canOffer ? t('offers.modeHint') : t('offers.notJoined')}
          </span>
        </div>
      )}
      {appt?.source === 'fhir' && (
        <Notice tone="warn" testId="move-fhir">
          {t('moves.fhir')}
        </Notice>
      )}
      {request && (
        <Notice testId="move-request">
          {t('offers.wantedHint', { count: request.choices.length })}
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
              const sel = d === shownDay;
              const has = picks.some((p) => p.day === d) || wanted.has(d);
              const cls = sel
                ? 'border-brand bg-brand text-white'
                : d === booked
                  ? 'border-[#E8B96B] bg-warn-soft text-warn'
                  : has
                    ? 'border-brand bg-brand-soft text-brand'
                    : 'border-[#C9CFD8] bg-white text-ink';
              return (
                <button
                  key={d}
                  type="button"
                  disabled={d < today}
                  aria-pressed={sel}
                  aria-label={fmtDay(d)}
                  onClick={() => pickDay(d)}
                  className={`h-10 rounded-lg border text-[14px] font-semibold disabled:opacity-35 ${cls}`}
                  data-testid={`move-day-${d}`}
                >
                  {Number(d.slice(8))}
                </button>
              );
            })}
          </div>
          <span className="flex flex-wrap gap-3 text-[12px] text-muted">
            <span className="text-brand">
              ■ {t(offering ? 'offers.legendPicked' : 'moves.legendWanted')}
            </span>
            {appt && <span className="text-warn">■ {t('moves.legendBooked')}</span>}
          </span>
        </div>
        <div className="flex min-w-[320px] flex-1 flex-col gap-2" data-testid="move-doctors">
          <b className="text-[15px]">{t('moves.step2', { day: fmtDay(shownDay!) })}</b>
          <span className="text-[13px] text-muted">
            {t(offering ? 'offers.pickHint' : 'moves.freeHint', { max })}
          </span>
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
                className={`flex flex-col gap-2 rounded-xl border bg-white p-3 ${sel && !offering ? 'border-2 border-brand' : 'border-line'}`}
                data-testid={`move-doctor-${d.doctor_name}`}
              >
                <label className="flex items-center gap-2.5">
                  <input
                    type="radio"
                    name={`doctor-${appt?.id ?? request?.id}`}
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
                      {d.doctor_id === appt?.doctor_id ? ` · ${t('moves.bookedDoctor')}` : ''}
                    </span>
                  </b>
                  <Badge tone={state[0] as 'ok' | 'bad' | 'neutral'}>{state[1]}</Badge>
                </label>
                {(d.free.length > 0 || d.held.length > 0) && (
                  <div className="flex flex-wrap gap-1.5 pl-6">
                    {d.free.map((f) => {
                      const on = offering ? picked(d.doctor_id, f) : sel && time === f;
                      return (
                        <button
                          key={f}
                          type="button"
                          aria-pressed={on}
                          onClick={() => {
                            if (offering) togglePick(d, f);
                            else {
                              setDoctor(d.doctor_id);
                              setTime(f);
                            }
                          }}
                          className={chipCls(on)}
                          data-testid={`move-slot-${f}`}
                        >
                          {fmtTime(f)}
                        </button>
                      );
                    })}
                    {d.held.map((f) => (
                      <span
                        key={`h${f}`}
                        title={t('offers.heldTitle')}
                        className="inline-flex min-h-9 items-center rounded-full border border-dashed border-[#7A5FD0] bg-[#EFEAFD] px-3 text-[13px] font-semibold text-[#5A3FB0]"
                      >
                        {fmtTime(f)} · {t('offers.held')}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          <label className="flex flex-wrap items-center gap-2 text-[13px] text-[#3D4552]">
            {t('moves.otherTime')}
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="h-10 rounded-lg border border-[#C9CFD8] px-2"
              data-testid="move-time"
            />
            {offering && (
              <Button
                variant="secondary"
                disabled={!/^\d\d:\d\d$/.test(time) || picks.length >= max}
                onClick={typedPick}
                data-testid="offer-add-typed"
              >
                {t('offers.addTyped')}
              </Button>
            )}
          </label>
        </div>
      </div>
      {offering && (
        <Card title={t('offers.choicesTitle', { name: patient, max })} testId="offer-picks">
          {picks.length === 0 && (
            <span className="text-[13px] text-muted">{t('offers.noneYet')}</span>
          )}
          {picks.map((p, i) => (
            <div
              key={`${p.day}${p.time}${p.doctor_id}`}
              className="flex items-center gap-2.5 rounded-xl border border-line px-3 py-2 text-[14px]"
              data-testid="offer-pick"
            >
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-brand text-[12px] font-bold text-white">
                {i + 1}
              </span>
              <span className="flex-1">
                <b>
                  {fmtDay(p.day)}, {fmtTime(p.time)}
                </b>{' '}
                · {p.doctor_name}{' '}
                {appt && p.doctor_id !== appt.doctor_id && (
                  <Badge tone="warn">{t('offers.otherDoctor')}</Badge>
                )}
              </span>
              <button
                type="button"
                className="text-[13px] text-muted"
                onClick={() => setPicks((x) => x.filter((_, j) => j !== i))}
              >
                {t('offers.remove')}
              </button>
            </div>
          ))}
          <span className="text-[13px] text-[#3D4552]">
            {t('offers.heldFor', { name: patient, hours: settings.offer_reply_hours })}
          </span>
          {appt && (
            <fieldset className="flex flex-col gap-1.5 text-[14px]">
              <legend className="mb-1 font-semibold">
                {t('offers.current', { when: fmt(appt.at) })}
              </legend>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={!currentPossible}
                  onChange={() => setCurrentPossible(false)}
                />
                {t('offers.currentGone', { name: patient })}
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={currentPossible}
                  onChange={() => setCurrentPossible(true)}
                  data-testid="offer-current-possible"
                />
                {t('offers.currentKeep', { name: patient })}
              </label>
            </fieldset>
          )}
        </Card>
      )}
      {appt && <RecordingNote appt={appt} validDays={settings.recording_valid_days} />}
      {chosen && appt && !offering && chosen !== appt.doctor_id && (
        <Notice tone="warn" testId="move-doctor-change">
          {t('moves.doctorChange', { to: chosenName, from: appt.doctor_name ?? '—' })}
        </Notice>
      )}
      <DialogFooter>
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
                .filter((r) => r !== 'patient_request' && r !== 'patient_choice')
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
        <span className="flex-1" />
        <ErrorNote error={error} />
        {offering ? (
          <Button
            disabled={busy || !readyOffer}
            onClick={() => void offer()}
            data-testid="offer-send"
          >
            {readyOffer
              ? t('offers.send', { count: picks.length, name: patient })
              : t('offers.sendIncomplete')}
          </Button>
        ) : (
          <Button disabled={busy || !readyNow} onClick={() => void move()} data-testid="move-save">
            {readyNow
              ? t('moves.save', {
                  when: `${fmtDay(shownDay!)}, ${fmtTime(time)}`,
                  doctor: chosenName,
                })
              : t('moves.saveIncomplete')}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}

/** What happens to the appointment's recordings when it moves (decision 046). */
function RecordingNote({ appt, validDays }: { appt: Movable; validDays: number }) {
  const { t } = useTranslation();
  const live = (appt.requests ?? []).filter((r) => r.state !== 'cancelled' && r.place === 'home');
  if (!live.length) return null;
  const recorded = live.find((r) => r.state === 'recorded');
  return (
    <Notice tone={recorded ? 'ok' : 'warn'} testId="move-recording">
      {recorded ? t('offers.recRecorded', { days: validDays }) : t('offers.recNotYet')}
    </Notice>
  );
}

// --- A patient's request ---

const STATE_TONE: Record<string, 'ok' | 'bad' | 'neutral'> = {
  free: 'ok',
  taken: 'bad',
  leave: 'bad',
  off: 'neutral',
  past: 'neutral',
};

export function RequestPanel({
  req,
  patient,
  appt,
  canAssign,
  onDone,
  onClose,
}: {
  req: PatientRequest;
  patient: string;
  appt: Movable | null;
  canAssign: boolean;
  onDone: (message: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [view, setView] = useState<'choices' | 'offer' | 'decline'>('choices');
  const answers =
    req.kind === 'change'
      ? appointmentChanges.declineAnswers
      : appointmentChanges.bookingDeclineAnswers;

  const book = async (c: Choice) => {
    setBusy(true);
    setError(null);
    try {
      await call('POST', `/hospital/change-requests/${req.id}/book`, {
        at: c.at,
        doctor_id: c.doctor_id,
        notify,
      });
      onDone(t('moves.done', { name: patient, when: fmt(c.at), doctor: c.doctor_name ?? '' }));
    } catch (e) {
      setError(e);
    }
    setBusy(false);
  };
  const decline = async (answer: string) => {
    setBusy(true);
    setError(null);
    try {
      await call('POST', `/hospital/change-requests/${req.id}/decline`, { answer, notify });
      onDone(t('moves.declined', { name: patient }));
    } catch (e) {
      setError(e);
    }
    setBusy(false);
  };

  if (view === 'offer')
    return (
      <MovePanel
        appt={appt}
        patient={patient}
        request={req}
        canAssign={canAssign}
        canOffer={req.joined}
        startMode="offer"
        onDone={onDone}
        onClose={() => setView('choices')}
      />
    );
  return (
    <Dialog
      title={t(`requests.title.${req.kind}`, { name: patient })}
      sub={`${
        req.kind === 'change'
          ? t('moves.booked', { when: fmt(req.appointment_at), doctor: req.doctor_name ?? '—' })
          : t('requests.wantsDoctor', { doctor: req.doctor_name ?? t('requests.anyDoctor') })
      }${req.purpose ? ` · ${t(`requests.purpose.${req.purpose}`)}` : ''}${
        req.reason ? ` · ${t(`moves.patientReason.${req.reason}`)}` : ''
      }`}
      size="md"
      onClose={onClose}
      testId="request-panel"
    >
      <Notice>{t('requests.checkedNow')}</Notice>
      {req.days && (
        <span className="text-[14px]">
          {t('requests.legacy', {
            days: req.days.map((d) => fmtDay(d)).join(', '),
            part: t(`moves.part.${req.part_of_day ?? 'any'}`),
          })}
        </span>
      )}
      <div className="flex flex-col gap-2" data-testid="request-choices">
        {req.choices.map((c) => (
          <div
            key={c.at}
            className="flex flex-wrap items-center gap-3 rounded-xl border border-line px-3 py-2.5"
            data-testid="request-choice"
          >
            <span className="w-28 text-[12px] font-bold text-muted uppercase">
              {t(`requests.rank.${c.rank}`)}
            </span>
            <span className="flex-1 text-[14px]">
              <b>{fmt(c.at)}</b>
              {c.doctor_name || req.doctor_name ? ` · ${c.doctor_name ?? req.doctor_name}` : ''}
            </span>
            <Badge tone={STATE_TONE[c.state ?? 'off']}>{t(`requests.state.${c.state}`)}</Badge>
            {c.state === 'free' && (
              <Button disabled={busy} onClick={() => void book(c)} data-testid="request-book">
                {t('requests.book')}
              </Button>
            )}
          </div>
        ))}
      </div>
      <label className="flex min-h-11 items-center gap-2 text-[14px]">
        <input
          type="checkbox"
          checked={notify}
          onChange={(e) => setNotify(e.target.checked)}
          className="h-4 w-4"
        />
        {t('moves.notify')}
      </label>
      <ErrorNote error={error} />
      <div className="flex flex-wrap gap-2.5">
        <Button
          variant="secondary"
          disabled={!req.joined}
          onClick={() => setView('offer')}
          data-testid="request-offer"
        >
          {t('requests.offerOthers')}
        </Button>
        <Button
          variant="secondary"
          onClick={() => setView(view === 'decline' ? 'choices' : 'decline')}
          data-testid="request-decline-open"
        >
          {t('requests.decline')}
        </Button>
      </div>
      {view === 'decline' && (
        <Card title={t('moves.declineTitle')} testId="request-decline">
          <div className="flex flex-wrap gap-2">
            {answers.map((a) => (
              <Button
                key={a}
                variant="secondary"
                disabled={busy}
                onClick={() => void decline(a)}
                data-testid={`request-decline-${a}`}
              >
                {t(`requests.answer.${a}`)}
              </Button>
            ))}
          </div>
        </Card>
      )}
    </Dialog>
  );
}

// --- The Requests tab ---

type Filter = 'all' | 'booking' | 'change' | 'waiting' | 'no_answer' | 'cancelled';

export function RequestsTab({
  canAssign,
  appointments,
  onChanged,
}: {
  canAssign: boolean;
  /** Appointments already loaded (for the move panel's recordings note). */
  appointments: Movable[];
  onChanged: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [box, setBox] = useState<Inbox | null>(null);
  const [ident, setIdent] = useState<Record<string, Ident>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [error, setError] = useState<unknown>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let off = false;
    void (async () => {
      try {
        const b = await call<Inbox>('GET', '/hospital/inbox');
        const ncids = [
          ...new Set([
            ...b.requests.map((r) => r.ncid),
            ...b.offers.map((o) => o.ncid),
            ...b.cancellations.map((c) => c.ncid),
          ]),
        ];
        const ids = ncids.length
          ? await hospital<Ident[]>('POST', '/v1/patients/lookup', { ncids })
          : [];
        if (off) return;
        setBox(b);
        setIdent(Object.fromEntries(ids.map((i) => [i.ncid, i])));
      } catch (e) {
        if (!off) setError(e);
      }
    })();
    return () => {
      off = true;
    };
  }, [version]);
  const name = (ncid: string) => ident[ncid]?.name ?? ncid;
  const done = (m: string) => {
    setOpen(null);
    setVersion((v) => v + 1);
    onChanged(m);
  };
  const act = async (fn: () => Promise<unknown>, m: string) => {
    setError(null);
    try {
      await fn();
      done(m);
    } catch (e) {
      setError(e);
    }
  };
  if (!box) return <ErrorNote error={error} />;

  type Row = {
    key: string;
    kind: Filter;
    pill: [string, 'ok' | 'warn' | 'bad' | 'neutral'];
    ncid: string;
    what: string;
    details: string;
    when: string;
    action: React.ReactNode;
  };
  const rows: Row[] = [
    ...box.requests.map((r): Row => ({
      key: r.id,
      kind: r.kind,
      pill: [t(`requests.pill.${r.kind}`), r.kind === 'booking' ? 'neutral' : 'warn'],
      ncid: r.ncid,
      what:
        r.kind === 'change'
          ? `${fmt(r.appointment_at)} · ${r.doctor_name ?? '—'}`
          : (r.doctor_name ?? t('requests.anyDoctor')),
      details: r.days
        ? t('requests.legacy', {
            days: r.days.map((d) => fmtDay(d)).join(', '),
            part: t(`moves.part.${r.part_of_day ?? 'any'}`),
          })
        : t('requests.choicesLine', {
            count: r.choices.length,
            first: fmt(r.choices[0]?.at),
            free: r.choices.filter((c) => c.state === 'free').length,
          }),
      when: t('requests.asked', { when: fmt(r.created_at) }),
      action: (
        <Button onClick={() => setOpen(open === r.id ? null : r.id)} data-testid="inbox-check">
          {t('requests.check')}
        </Button>
      ),
    })),
    ...box.offers.map((o): Row => ({
      key: o.id,
      kind: o.no_answer || o.status === 'call_requested' ? 'no_answer' : 'waiting',
      pill:
        o.status === 'call_requested'
          ? [t('requests.pill.call'), 'bad']
          : o.no_answer
            ? [t('requests.pill.noAnswer'), 'bad']
            : [t('requests.pill.waiting'), 'neutral'],
      ncid: o.ncid,
      what: o.appointment_at
        ? `${fmt(o.appointment_at)} · ${o.doctor_name ?? '—'}`
        : t('requests.newBooking'),
      details: t('requests.offerLine', {
        count: o.options.length,
        by: fmt(o.reply_by),
      }),
      when: t('requests.sent', { when: fmt(o.created_at) }),
      action: (
        <Button
          variant="secondary"
          onClick={() =>
            void act(
              () => call('POST', `/hospital/offers/${o.id}/withdraw`),
              t('requests.withdrawn'),
            )
          }
          data-testid="inbox-withdraw"
        >
          {t('requests.withdrawOffer')}
        </Button>
      ),
    })),
    ...box.cancellations.map((c): Row => ({
      key: c.appointment_id,
      kind: 'cancelled',
      pill: [t('requests.pill.cancelled'), 'neutral'],
      ncid: c.ncid,
      what: `${fmt(c.at)} · ${c.doctor_name ?? '—'}`,
      details: t('requests.reasonLine', {
        reason: t(`cancel.patientReason.${c.reason ?? 'other'}`),
      }),
      when: fmt(c.cancelled_at),
      action: (
        <Button
          variant="secondary"
          onClick={() =>
            void act(
              () => call('POST', `/hospital/appointments/${c.appointment_id}/cancellation-seen`),
              t('requests.seen'),
            )
          }
          data-testid="inbox-seen"
        >
          {t('requests.markSeen')}
        </Button>
      ),
    })),
  ];
  const counts: Record<Filter, number> = {
    all: rows.length,
    booking: rows.filter((r) => r.kind === 'booking').length,
    change: rows.filter((r) => r.kind === 'change').length,
    waiting: rows.filter((r) => r.kind === 'waiting').length,
    no_answer: rows.filter((r) => r.kind === 'no_answer').length,
    cancelled: rows.filter((r) => r.kind === 'cancelled').length,
  };
  const shown = rows.filter((r) => filter === 'all' || r.kind === filter);
  const openReq = box.requests.find((r) => r.id === open);
  const apptOf = (id: string | null): Movable | null =>
    id ? (appointments.find((a) => a.id === id) ?? null) : null;

  return (
    <div className="flex flex-col gap-3" data-testid="requests-tab">
      <ErrorNote error={error} />
      <div className="flex flex-wrap gap-2" role="group">
        {(Object.keys(counts) as Filter[]).map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
            className={chipCls(filter === f)}
            data-testid={`inbox-filter-${f}`}
          >
            {t(`requests.filter.${f}`)} · {counts[f]}
          </button>
        ))}
      </div>
      {shown.length === 0 && <Notice testId="inbox-empty">{t('requests.empty')}</Notice>}
      {shown.length > 0 && (
        <Table
          head={[
            t('requests.what'),
            t('appts.patient'),
            t('requests.apptCol'),
            t('requests.detailsCol'),
            t('requests.whenCol'),
            '',
          ]}
          testId="inbox-table"
        >
          {shown.map((r) => (
            <tr
              key={r.key}
              className="border-t border-[#EDF0F3]"
              data-testid={`inbox-${ident[r.ncid]?.mrn ?? r.ncid}`}
            >
              <td className="px-4 py-3">
                <Badge tone={r.pill[1]}>{r.pill[0]}</Badge>
              </td>
              <td className="px-4 py-3">
                <b>{name(r.ncid)}</b>
                {ident[r.ncid] && (
                  <span className="block text-[12px] text-muted">MRN {ident[r.ncid]!.mrn}</span>
                )}
              </td>
              <td className="px-4 py-3 text-[13px]">{r.what}</td>
              <td className="px-4 py-3 text-[13px]">{r.details}</td>
              <td className="px-4 py-3 text-[13px] text-muted">{r.when}</td>
              <td className="px-4 py-3 text-right">{r.action}</td>
            </tr>
          ))}
        </Table>
      )}
      <span className="text-[13px] text-muted">{t('requests.countHint')}</span>
      {openReq && (
        <RequestPanel
          key={openReq.id}
          req={openReq}
          patient={name(openReq.ncid)}
          appt={
            openReq.appointment_id
              ? (apptOf(openReq.appointment_id) ?? {
                  id: openReq.appointment_id,
                  at: openReq.appointment_at!,
                  source: openReq.source,
                  doctor_id: openReq.doctor_id,
                  doctor_name: openReq.doctor_name,
                })
              : null
          }
          canAssign={canAssign}
          onClose={() => setOpen(null)}
          onDone={done}
        />
      )}
    </div>
  );
}

// --- Cancel ---

/** v18 (decision 049): from the appointment's time on, the desk marks that the patient did not
 * come. The appointment is cancelled; the patient (optional) and the doctor are told. */
export function NoShowDialog({
  appt,
  patient,
  onDone,
  onClose,
}: {
  appt: Movable;
  patient: string;
  onDone: (message: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const mark = async () => {
    setBusy(true);
    setError(null);
    try {
      await call('POST', `/hospital/appointments/${appt.id}/no-show`, { notify });
      onDone(t('noShow.done', { name: patient, when: fmt(appt.at) }));
    } catch (e) {
      setError(e);
    }
    setBusy(false);
  };
  return (
    <Dialog
      title={t('noShow.title', { name: patient })}
      sub={`${fmt(appt.at)} · ${appt.doctor_name ?? '—'}`}
      size="sm"
      onClose={onClose}
      testId="no-show-dialog"
    >
      <label className="flex min-h-11 items-center gap-2 text-[14px]">
        <input
          type="checkbox"
          checked={notify}
          onChange={(e) => setNotify(e.target.checked)}
          className="h-4 w-4"
          data-testid="no-show-notify"
        />
        {t('noShow.notify', { name: patient })}
      </label>
      <Notice tone="warn">
        {appt.doctor_name
          ? t('noShow.what', { doctor: appt.doctor_name })
          : t('noShow.whatNoDoctor')}
      </Notice>
      <ErrorNote error={error} />
      <div className="flex flex-wrap gap-2.5">
        <Button
          variant="danger"
          disabled={busy}
          onClick={() => void mark()}
          data-testid="no-show-confirm"
        >
          {t('noShow.confirm')}
        </Button>
        <Button variant="secondary" onClick={onClose}>
          {t('noShow.keep')}
        </Button>
      </div>
    </Dialog>
  );
}

export function CancelDialog({
  appt,
  patient,
  onDone,
  onClose,
}: {
  appt: Movable;
  patient: string;
  onDone: (message: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      await call('POST', `/hospital/appointments/${appt.id}/cancel`, { reason, notify });
      onDone(t('cancel.done', { name: patient, when: fmt(appt.at) }));
    } catch (e) {
      setError(e);
    }
    setBusy(false);
  };
  return (
    <Dialog
      title={t('cancel.title', { name: patient })}
      sub={t('cancel.sub')}
      size="sm"
      dirty={!!reason}
      onClose={onClose}
      testId="cancel-dialog"
    >
      <span className="text-[14px]">
        {fmt(appt.at)} · {appt.doctor_name ?? '—'}
      </span>
      <b className="text-[14px]">{t('cancel.reason')}</b>
      <div className="flex flex-wrap gap-2" role="group">
        {appointmentChanges.cancelReasons.map((r) => (
          <button
            key={r}
            type="button"
            aria-pressed={reason === r}
            onClick={() => setReason(r)}
            className={chipCls(reason === r)}
            data-testid={`cancel-reason-${r}`}
          >
            {t(`cancel.reasons.${r}`)}
          </button>
        ))}
      </div>
      <label className="flex min-h-11 items-center gap-2 text-[14px]">
        <input
          type="checkbox"
          checked={notify}
          onChange={(e) => setNotify(e.target.checked)}
          className="h-4 w-4"
          data-testid="cancel-notify"
        />
        {t('cancel.notify', { name: patient })}
      </label>
      <Notice tone="warn">{t('cancel.what')}</Notice>
      <ErrorNote error={error} />
      <div className="flex flex-wrap gap-2.5">
        <Button
          variant="danger"
          disabled={busy || !reason}
          onClick={() => void cancel()}
          data-testid="cancel-confirm"
        >
          {t('cancel.confirm')}
        </Button>
        <Button variant="secondary" onClick={onClose}>
          {t('cancel.keep')}
        </Button>
      </div>
    </Dialog>
  );
}

/** "HH:MM" of an ISO time in the hospital's zone (tests and badges). */
export const localTime = zonedTime;
