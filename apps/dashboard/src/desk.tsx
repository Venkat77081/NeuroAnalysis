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
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { call, hospital } from './api.ts';
import { appointmentChanges } from './config.ts';
import { useUndo } from './undo.tsx';
import { fmtDay, fmtTime, useSettings, zonedDay, zonedIso, zonedTime } from './changes.tsx';
import {
  Avatar,
  Badge,
  Button,
  Card,
  Dialog,
  DialogFooter,
  ErrorNote,
  Notice,
  fmt,
} from './ui.tsx';
import type { RequestOut as LinkOut } from './appointments.tsx';
import {
  MonthPicker,
  TimeGrid,
  daySlots,
  dayState,
  monthCells,
  useFreeDays,
  type DoctorDay,
} from './slots.tsx';

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
  `min-h-9 rounded-full border px-3 text-[13px] font-semibold ${on ? 'border-brand bg-brand text-white' : 'border-edge bg-card'}`;

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
  const { defer } = useUndo();
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
  const [busy] = useState(false); // v29: sent after the undo window
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

  // v31 (canvas v28): a month calendar with green dots on days with free times (the chosen
  // doctor's, or everyone's), then one doctor's day as Morning / Afternoon chips.
  const [monthPick, setMonth] = useState<string | null>(null);
  const month = monthPick ?? (shownDay ?? '0000-00').slice(0, 7);
  const cells = useMemo(() => monthCells(month), [month]);

  const pickDay = (d: string) => {
    setDay(d);
    setTime('');
    setDoctors(null);
  };
  const shown = (doctors ?? []).filter((d) => canAssign || d.doctor_id === appt?.doctor_id);
  const chosen = doctor ?? appt?.doctor_id ?? shown[0]?.doctor_id ?? null;
  const freeDays = useFreeDays(cells, chosen, appt?.id ?? null);
  const chosenDay = shown.find((d) => d.doctor_id === chosen) ?? null;
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

  // v29 (decision 052): the change waits a few seconds with an Undo toast, then is sent.
  const move = () => {
    const at = zonedIso(shownDay!, time, tz);
    const when = `${fmtDay(shownDay!)}, ${fmtTime(time)}`;
    const msg = t('moves.done', { name: patient, when, doctor: chosenName });
    const req = request && appt ? request.id : null;
    const id = appt!.id;
    const body = { at, doctor_id: chosen, notify };
    defer({
      label: t(req ? 'undo.book' : 'undo.move', { name: patient, when }),
      run: () =>
        req
          ? call('POST', `/hospital/change-requests/${req}/book`, body)
          : call('POST', `/hospital/appointments/${id}/move`, { ...body, reason }),
      done: () => onDone(msg),
    });
    onClose();
  };
  const offer = () => {
    const body = {
      ...(request ? { request_id: request.id } : { appointment_id: appt!.id }),
      options: picks.map((p) => ({ at: zonedIso(p.day, p.time, tz), doctor_id: p.doctor_id })),
      current_possible: !!appt && currentPossible,
      reason,
      notify,
    };
    const msg = t('offers.sent', { name: patient, count: picks.length });
    defer({
      label: t('undo.offer', { name: patient, count: picks.length }),
      run: () => call('POST', '/hospital/offers', body),
      done: () => onDone(msg),
    });
    onClose();
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
      <div className="flex flex-wrap items-start gap-6">
        <div className="flex min-w-[300px] flex-1 flex-col gap-2">
          <MonthPicker
            month={month}
            onMonth={setMonth}
            day={shownDay}
            onDay={pickDay}
            today={today}
            free={freeDays}
            booked={booked}
            marked={new Set([...wanted, ...picks.map((p) => p.day)])}
          />
          <span className="flex flex-wrap gap-3 text-[12px] text-muted">
            <span>
              <span className="text-ok">●</span> {t('slots.legendFree')}
            </span>
            <span className="text-brand-ink">
              ■ {t(offering ? 'offers.legendPicked' : 'moves.legendWanted')}
            </span>
            {appt && <span className="text-warn">■ {t('moves.legendBooked')}</span>}
          </span>
        </div>
        <div className="flex min-w-[320px] flex-1 flex-col gap-3" data-testid="move-doctors">
          <span className="text-[13px] font-semibold text-sub">
            {t('moves.step2', { day: fmtDay(shownDay!) })}
          </span>
          {!doctors && <span className="text-muted">{t('app.loading')}</span>}
          {doctors && shown.length > 0 && (
            <select
              value={chosen ?? ''}
              onChange={(e) => {
                setDoctor(e.target.value);
                setTime('');
              }}
              disabled={shown.length < 2}
              aria-label={t('slots.doctor')}
              className="h-11 rounded-2xl bg-soft px-3 text-[14px] font-semibold"
              data-testid="move-doctor-select"
            >
              {shown.map((d) => (
                <option key={d.doctor_id} value={d.doctor_id}>
                  {d.doctor_name}
                  {d.doctor_id === appt?.doctor_id ? ` (${t('slots.sameDoctor')})` : ''} ·{' '}
                  {dayState(d, t)[1]}
                </option>
              ))}
            </select>
          )}
          {chosenDay && (
            <div
              className="flex flex-col gap-2"
              data-testid={`move-doctor-${chosenDay.doctor_name}`}
            >
              {(chosenDay.on_leave || !chosenDay.has_hours || chosenDay.free.length === 0) && (
                <Badge tone={dayState(chosenDay, t)[0]}>{dayState(chosenDay, t)[1]}</Badge>
              )}
              <TimeGrid
                slots={daySlots(chosenDay)}
                isOn={(f) => (offering ? picked(chosenDay.doctor_id, f) : time === f)}
                onPick={(f) => (offering ? togglePick(chosenDay, f) : setTime(f))}
              />
              <span className="text-[12px] text-muted">
                {t(offering ? 'offers.pickHint' : 'moves.freeHint', { max })}
              </span>
            </div>
          )}
          <label className="flex flex-wrap items-center gap-2 text-[13px] text-sub">
            {t('moves.otherTime')}
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="h-10 rounded-lg border border-edge px-2"
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
          <span className="text-[13px] text-sub">
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
        {appt && (
          <div
            role="group"
            className="flex rounded-full bg-card p-1 shadow-[inset_0_0_0_1px_var(--color-edge)]"
            title={canOffer ? t('offers.modeHint') : t('offers.notJoined')}
          >
            {(['now', 'offer'] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                disabled={m === 'offer' && !canOffer}
                onClick={() => setMode(m)}
                className={`min-h-9 rounded-full px-3.5 text-[13px] font-bold disabled:opacity-40 ${mode === m ? 'bg-ink text-ground' : 'text-sub'}`}
                data-testid={`move-mode-${m}`}
              >
                {t(`offers.mode.${m}`, { name: patient, max })}
              </button>
            ))}
          </div>
        )}
        {!request && (
          <label className="flex flex-col gap-1 text-[13px] font-semibold text-sub">
            {t('moves.why')}
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="h-11 rounded-2xl border border-edge bg-card px-2 font-normal"
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
        <label className="flex min-h-11 max-w-[280px] items-center gap-2 text-[13px] leading-[18px]">
          <input
            type="checkbox"
            checked={notify}
            onChange={(e) => setNotify(e.target.checked)}
            className="h-4 w-4 shrink-0"
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
  inline = false,
}: {
  req: PatientRequest;
  patient: string;
  appt: Movable | null;
  canAssign: boolean;
  onDone: (message: string) => void;
  onClose: () => void;
  /** v30 (canvas v28): shown next to the inbox instead of as a dialog. */
  inline?: boolean;
}) {
  const { t } = useTranslation();
  const { defer } = useUndo();
  const [notify, setNotify] = useState(true);
  const [busy] = useState(false); // v29: sent after the undo window
  const [error] = useState<unknown>(null);
  const [view, setView] = useState<'choices' | 'offer' | 'decline'>('choices');
  const answers =
    req.kind === 'change'
      ? appointmentChanges.declineAnswers
      : appointmentChanges.bookingDeclineAnswers;

  // v29 (decision 052): held a few seconds with Undo before it is sent.
  const book = (c: Choice) => {
    const msg = t('moves.done', { name: patient, when: fmt(c.at), doctor: c.doctor_name ?? '' });
    const body = { at: c.at, doctor_id: c.doctor_id, notify };
    defer({
      label: t('undo.book', { name: patient, when: fmt(c.at) }),
      run: () => call('POST', `/hospital/change-requests/${req.id}/book`, body),
      done: () => onDone(msg),
    });
    onClose();
  };
  const decline = (answer: string) => {
    const msg = t('moves.declined', { name: patient });
    defer({
      label: t('undo.decline', { name: patient }),
      run: () => call('POST', `/hospital/change-requests/${req.id}/decline`, { answer, notify }),
      done: () => onDone(msg),
    });
    onClose();
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
  const title = t(`requests.title.${req.kind}`, { name: patient });
  const sub = `${
    req.kind === 'change'
      ? t('moves.booked', { when: fmt(req.appointment_at), doctor: req.doctor_name ?? '—' })
      : t('requests.wantsDoctor', { doctor: req.doctor_name ?? t('requests.anyDoctor') })
  }${req.purpose ? ` · ${t(`requests.purpose.${req.purpose}`)}` : ''}${
    req.reason ? ` · ${t(`moves.patientReason.${req.reason}`)}` : ''
  }`;
  const content = (
    <>
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
    </>
  );
  if (inline)
    return (
      <section
        className="nc-fu flex min-w-0 flex-1 flex-col gap-3 rounded-3xl bg-card p-5 shadow-card"
        data-testid="request-panel"
      >
        <div className="flex flex-wrap items-center gap-3">
          <Avatar name={patient} size={52} />
          <span className="flex min-w-0 flex-1 flex-col">
            <b className="text-[18px]">{title}</b>
            <span className="text-[13px] text-muted">{sub}</span>
          </span>
          <Badge tone="neutral">{t('shell.liveRecords')}</Badge>
        </div>
        {content}
      </section>
    );
  return (
    <Dialog title={title} sub={sub} size="md" onClose={onClose} testId="request-panel">
      {content}
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
  const [pick, setPick] = useState<string | null>(null);
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
        <Button
          variant="secondary"
          className="min-h-8 text-[13px]"
          onClick={() => setOpen(r.id)}
          data-testid="inbox-check"
        >
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
  const selected = shown.find((r) => r.key === (open ?? pick)) ?? shown[0];
  const openReq = box.requests.find((r) => r.id === (open ?? selected?.key));
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
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
          <section
            className="nc-fu flex w-full shrink-0 flex-col gap-1 rounded-3xl bg-card p-2.5 shadow-card lg:w-[380px]"
            data-testid="inbox-table"
          >
            {shown.map((r) => {
              const sel = r.key === (selected?.key ?? '');
              return (
                <div
                  key={r.key}
                  className={`flex flex-col gap-1.5 rounded-[18px] p-3 ${sel ? 'bg-brand-soft' : ''}`}
                  data-testid={`inbox-${ident[r.ncid]?.mrn ?? r.ncid}`}
                >
                  <button
                    type="button"
                    onClick={() => setPick(r.key)}
                    className="flex items-center gap-3 text-left"
                  >
                    <Avatar name={ident[r.ncid]?.name ?? null} size={40} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <b className="truncate text-[14px]">{name(r.ncid)}</b>
                      <span className="truncate text-[12px] text-muted">
                        {r.what} · {r.when}
                      </span>
                    </span>
                    <Badge tone={r.pill[1]}>{r.pill[0]}</Badge>
                  </button>
                  <span className="pl-[52px] text-[12px] text-sub">{r.details}</span>
                  <span className="flex justify-end">{r.action}</span>
                </div>
              );
            })}
          </section>
          {openReq ? (
            <RequestPanel
              key={openReq.id}
              inline
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
          ) : (
            <section className="nc-fu flex min-w-0 flex-1 flex-col items-center justify-center gap-2 rounded-3xl bg-card p-10 text-center shadow-card">
              <b className="text-[16px]">{t('requests.pickTitle')}</b>
              <span className="text-[14px] text-muted">{t('requests.pickHint')}</span>
            </section>
          )}
        </div>
      )}
      <span className="text-[13px] text-muted">{t('requests.countHint')}</span>
    </div>
  );
}

// --- Cancel ---

/** v18 (decision 049): from the appointment's time on, the desk marks that the patient did not
 * come. The appointment is cancelled; the patient (optional) and the doctor are told. */
/**
 * v18 (decision 049), v30 look (canvas v28): "X did not come?" with what will happen. Offered from
 * the appointment time; the change waits for Undo (decision 052) before it is sent.
 */
/** "227 min" reads as "3 h 47 min" from an hour on. */
export const sinceText = (t: TFunction, minutes: number) =>
  minutes >= 60
    ? t('today.sinceHM', { h: Math.floor(minutes / 60), m: minutes % 60 })
    : t('today.sinceM', { m: minutes });

export function NoShowDialog({
  appt,
  patient,
  time,
  now: nowGiven,
  onDone,
  onClose,
}: {
  appt: Movable;
  patient: string;
  /** The appointment time as shown on the page (hospital time). */
  time?: string;
  now?: number;
  onDone: (message: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { defer } = useUndo();
  const [notify, setNotify] = useState(true);
  const [opened] = useState(() => Date.now());
  const now = nowGiven ?? opened;
  const when = time ?? fmt(appt.at);
  const late = Math.max(0, Math.floor((now - Date.parse(appt.at)) / 60_000));
  const mark = () => {
    const msg = t('noShow.done', { name: patient, when: fmt(appt.at) });
    const id = appt.id;
    defer({
      label: t('undo.noShow', { name: patient }),
      run: () => call('POST', `/hospital/appointments/${id}/no-show`, { notify }),
      done: () => onDone(msg),
    });
    onClose();
  };
  return (
    <Dialog
      title={t('noShow.title', { name: patient })}
      size="sm"
      bare
      onClose={onClose}
      testId="no-show-dialog"
    >
      <span
        aria-hidden
        className="inline-flex size-[52px] items-center justify-center rounded-[18px] bg-bad-soft text-[24px] font-extrabold text-bad"
      >
        !
      </span>
      <div className="flex flex-col gap-1">
        <h2 className="text-[22px] leading-7 font-extrabold">
          {t('noShow.title', { name: patient })}
        </h2>
        <span className="text-[15px] text-sub">
          {t('noShow.when', {
            time: when,
            doctor: appt.doctor_name ?? t('cal.noDoctor'),
            since: sinceText(t, late),
          })}
        </span>
      </div>
      <div className="flex flex-col gap-1.5 rounded-[18px] bg-soft px-4 py-3.5 text-[14px] leading-6">
        <b>{t('noShow.willTitle')}</b>
        <span>✓ {t('noShow.willCancel', { time: when })}</span>
        <span>
          ✓{' '}
          {appt.doctor_name
            ? t('noShow.willTell', { doctor: appt.doctor_name })
            : t('noShow.willTellNone')}
        </span>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={notify}
            onChange={(e) => setNotify(e.target.checked)}
            className="mt-1 size-4 accent-brand"
            data-testid="no-show-notify"
          />
          <span>{t('noShow.willMessage', { name: patient })}</span>
        </label>
      </div>
      <div className="flex gap-2.5">
        <Button
          variant="danger"
          className="flex-1"
          onClick={() => void mark()}
          data-testid="no-show-confirm"
        >
          {t('noShow.confirm')}
        </Button>
        <Button variant="secondary" className="flex-1" onClick={onClose}>
          {t('noShow.keep')}
        </Button>
      </div>
      <span className="text-center text-[12px] text-muted">{t('today.unlocks')}</span>
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
  const { defer } = useUndo();
  const [reason, setReason] = useState('');
  const [notify, setNotify] = useState(true);
  const [busy] = useState(false); // v29: sent after the undo window
  const [error] = useState<unknown>(null);
  const cancel = () => {
    const msg = t('cancel.done', { name: patient, when: fmt(appt.at) });
    const id = appt.id;
    defer({
      label: t('undo.cancel', { name: patient }),
      run: () => call('POST', `/hospital/appointments/${id}/cancel`, { reason, notify }),
      done: () => onDone(msg),
    });
    onClose();
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
