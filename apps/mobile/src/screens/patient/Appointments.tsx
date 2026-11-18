/**
 * The patient's appointments at one hospital (v13 decision 045, v14 decision 046).
 *
 * - Each upcoming appointment: ask to change it (exact free times on preferred and alternative
 *   dates), cancel it (any time, reason from a list), or answer the hospital's offer of new times
 *   (choose one, keep the current date when still possible, ask to be called, or cancel).
 * - Book an appointment: a doctor (or any), preferred and alternative dates with free times, and
 *   a purpose from a list. The hospital confirms one of the times, or offers others.
 * No free text: no health details reach the platform.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useApp } from '../../app/AppContext.tsx';
import { capture } from '../../lib/capture.ts';
import { errorCode } from '../../lib/accounts.ts';
import { cacheKey, hospitalApi, type PatientHospital } from '../../lib/hospitals.ts';
import { logger } from '../../lib/logger.ts';
import { Button, Card } from '../../ui/kit.tsx';
import { ErrorText } from '../modes/Common.tsx';

interface ChoiceOut {
  at: string;
  rank: 'preferred' | 'alternative';
}
interface Change {
  id: string;
  kind: 'change' | 'booking';
  choices: ChoiceOut[];
  days?: string[] | null;
  part_of_day?: string | null;
  reason: string | null;
  status: 'open' | 'offered' | 'accepted' | 'declined' | 'closed' | 'withdrawn';
  answer: string | null;
}
interface Offer {
  id: string;
  options: { index: number; at: string; doctor_name: string | null; other_doctor: boolean }[];
  reply_by: string;
  current_possible: boolean;
  reason: string;
  status: 'open' | 'call_requested';
  late: boolean;
}
export interface PatientAppointment {
  id: string;
  at: string;
  doctor_name: string | null;
  status: 'booked' | 'cancelled';
  can_ask: boolean;
  ask_until: string | null;
  can_cancel: boolean;
  change: Change | null;
  offer: Offer | null;
  moved_from: string | null;
  moved_from_doctor_name: string | null;
  moved_by_hospital: boolean;
  cancelled_by: string | null;
  cancel_reason: string | null;
  waiting_for_tests: boolean;
}
interface Booking {
  id: string;
  status: 'open' | 'offered' | 'declined';
  doctor_name: string | null;
  any_doctor: boolean;
  choices: ChoiceOut[];
  purpose: string | null;
  answer: string | null;
  offer: Offer | null;
}
interface Rules {
  enabled: boolean;
  preferred: number;
  alternatives: number;
  times_per_date: number;
  days_ahead: number;
  min_days: number;
}
interface AppointmentsOut {
  appointments: PatientAppointment[];
  bookings: Booking[];
  time_zone: string;
  max_days_ahead: number;
  cutoff_hours: number;
  changes_enabled: boolean;
  booking: Rules;
}
interface Doctor {
  id: string;
  name: string;
  department: string | null;
}

/** "2026-11-24" in the hospital's time zone, `n` days from now. */
function dayIn(n: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Date.now() + n * 86_400_000));
}
/** A day and "HH:MM" in the hospital's zone as an ISO time. */
function zonedIso(day: string, hhmm: string, tz: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y!, m! - 1, d!, h!, mi!);
  const off = (ms: number) => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
        .formatToParts(new Date(ms))
        .filter((x) => x.type !== 'literal')
        .map((x) => [x.type, Number(x.value)]),
    );
    return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!) - ms;
  };
  let t = guess - off(guess);
  t = guess - off(t);
  return new Date(t).toISOString();
}
const locale = (lang: string) => (lang === 'hi' ? 'hi-IN' : 'en-IN');
function when(iso: string, tz: string, lang: string): string {
  return new Date(iso).toLocaleString(locale(lang), {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}
function dayLabel(day: string, lang: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString(locale(lang), {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}
function timeLabel(hhmm: string, lang: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2000, 0, 1, h, m)).toLocaleTimeString(locale(lang), {
    timeZone: 'UTC',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function Chip({
  on,
  onClick,
  children,
  testId,
  disabled,
}: {
  on: boolean;
  onClick: () => void;
  children: ReactNode;
  testId?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
      className={`min-h-11 rounded-full border px-3.5 text-[14px] font-semibold disabled:opacity-40 ${on ? 'border-brand bg-brand text-white' : 'border-[#C9CFD8] bg-white text-ink'}`}
      data-testid={testId}
    >
      {children}
    </button>
  );
}

function Badge({ tone, children }: { tone: 'ok' | 'warn' | 'bad' | 'grey'; children: ReactNode }) {
  const c = {
    ok: 'bg-[#E3F4EA] text-[#145F38]',
    warn: 'bg-[#FDF0DD] text-[#8A4B00]',
    bad: 'bg-[#FDECEA] text-[#B42318]',
    grey: 'bg-[#EDF0F3] text-[#3D4552]',
  }[tone];
  return (
    <span
      className={`shrink-0 rounded-xl px-2.5 py-0.5 text-[12px] font-semibold ${c}`}
      data-testid="appointment-badge"
    >
      {children}
    </span>
  );
}

export function useAppointments(h: PatientHospital) {
  const { repo } = useApp();
  const [data, setData] = useState<AppointmentsOut | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    if (h.withdrawnAt) return;
    let off = false;
    hospitalApi<AppointmentsOut>(capture.kit, h, 'GET', '/patient/appointments').then(
      async (r) => {
        await repo.store.put(cacheKey(h, 'appointments'), r);
        if (!off) setData(r);
      },
      async (e: unknown) => {
        logger.warn('appointments fetch failed', { code: errorCode(e) });
        const cached = await repo.store.get<AppointmentsOut>(cacheKey(h, 'appointments'));
        // Offline: what the phone last saw, read only (answers need the hospital).
        if (!off && cached)
          setData({
            ...cached,
            booking: { ...cached.booking, enabled: false },
            appointments: cached.appointments.map((a) => ({
              ...a,
              can_ask: false,
              can_cancel: false,
              offer: null,
            })),
          });
      },
    );
    return () => {
      off = true;
    };
    // A hospital is identified by its profile; the object itself may be rebuilt on each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [h.profile, h.withdrawnAt, repo, version]);
  return { data, reload };
}

type View =
  | { kind: 'list' }
  | { kind: 'ask'; appt: PatientAppointment }
  | { kind: 'offer'; offer: Offer; appt: PatientAppointment | null }
  | { kind: 'cancel'; appt: PatientAppointment }
  | { kind: 'book' };

export function AppointmentsSection({
  h,
  start = 'list',
  onLeaveBook,
  extra,
}: {
  h: PatientHospital;
  /** v17: the menu's "Book an appointment" opens the booking form directly. */
  start?: 'list' | 'book';
  /** Leaving the booking form opened from the menu (sent: show the appointments). */
  onLeaveBook?: (sent: boolean) => void;
  /** v17: more for one appointment (a clinic recording's consent at that visit). */
  extra?: (a: PatientAppointment) => ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const { data, reload } = useAppointments(h);
  const [view, setView] = useState<View>(start === 'book' ? { kind: 'book' } : { kind: 'list' });
  const [error, setError] = useState<string | null>(null);
  if (!data) return null;
  const tz = data.time_zone;
  const lang = i18n.language;
  const back = () => {
    setView({ kind: 'list' });
    reload();
  };
  const post = async (path: string, body?: unknown) => {
    setError(null);
    try {
      await hospitalApi(capture.kit, h, 'POST', path, body);
      reload();
    } catch (e) {
      setError(errorCode(e));
    }
  };

  if (view.kind === 'ask')
    return (
      <TimesForm
        h={h}
        data={data}
        title={t('appts.askTitle')}
        appt={view.appt}
        onCancel={() => setView({ kind: 'list' })}
        onSent={back}
      />
    );
  if (view.kind === 'book')
    return (
      <BookForm
        h={h}
        data={data}
        onCancel={() => (onLeaveBook ? onLeaveBook(false) : setView({ kind: 'list' }))}
        onSent={() => (onLeaveBook ? onLeaveBook(true) : back())}
      />
    );
  if (view.kind === 'offer')
    return (
      <OfferView
        h={h}
        tz={tz}
        offer={view.offer}
        appt={view.appt}
        onDone={back}
        onBack={() => setView({ kind: 'list' })}
      />
    );
  if (view.kind === 'cancel')
    return (
      <CancelView
        h={h}
        tz={tz}
        appt={view.appt}
        onDone={back}
        onBack={() => setView({ kind: 'list' })}
      />
    );

  const nothing = data.appointments.length === 0 && data.bookings.length === 0;
  return (
    <section className="flex flex-col gap-3" data-testid="appointments">
      <ErrorText code={error} />
      {nothing && (
        <p className="text-[14px] text-muted" data-testid="appts-none">
          {t('appts.none')}
        </p>
      )}
      {data.booking.enabled && nothing && (
        <Button
          variant="secondary"
          onClick={() => setView({ kind: 'book' })}
          data-testid="book-open"
        >
          {t('appts.book')}
        </Button>
      )}
      {data.bookings.map((b) => (
        <Card key={b.id} className="flex flex-col gap-2" data-testid="booking-card">
          <div className="flex items-start justify-between gap-2">
            <b className="text-[16px]">{t('appts.bookingTitle')}</b>
            <Badge tone={b.status === 'declined' ? 'bad' : b.offer ? 'warn' : 'warn'}>
              {t(`appts.bookingState.${b.offer ? 'offer' : b.status}`)}
            </Badge>
          </div>
          <span className="text-[14px] text-[#3D4552]">
            {t('appts.bookingLine', {
              doctor: b.doctor_name ?? t('appts.anyDoctor'),
              count: b.choices.length,
              first: b.choices[0] ? when(b.choices[0].at, tz, lang) : '',
            })}
          </span>
          {b.status === 'declined' && (
            <span className="text-[14px] text-[#3D4552]" data-testid="booking-declined">
              {t(`appts.bookingAnswer.${b.answer ?? 'call_us'}`, { hospital: h.hospital })}
            </span>
          )}
          {b.offer && (
            <Button
              onClick={() => setView({ kind: 'offer', offer: b.offer!, appt: null })}
              data-testid="booking-offer-open"
            >
              {t('appts.chooseTime')}
            </Button>
          )}
          {b.status !== 'declined' && (
            <Button
              variant="ghost"
              onClick={() => void post(`/patient/change-requests/${b.id}/withdraw`)}
              data-testid="booking-withdraw"
            >
              {t('appts.withdraw')}
            </Button>
          )}
        </Card>
      ))}
      {data.appointments.map((a) => {
        const c = a.change;
        const badge: [string, 'ok' | 'warn' | 'bad' | 'grey'] =
          a.status === 'cancelled'
            ? [t('appts.badge.cancelled'), a.cancelled_by === 'patient' ? 'grey' : 'bad']
            : a.offer
              ? [t('appts.badge.chooseTime'), 'warn']
              : c?.status === 'open'
                ? [t('appts.badge.asked'), 'warn']
                : c?.status === 'accepted' || a.moved_from
                  ? [t('appts.badge.changed'), 'ok']
                  : c?.status === 'declined'
                    ? [t('appts.badge.notChanged'), 'bad']
                    : [t('appts.badge.booked'), 'ok'];
        return (
          <Card key={a.id} className="flex flex-col gap-2" data-testid="appointment-card">
            <div className="flex items-start justify-between gap-2">
              <span className="text-[17px] font-bold" data-testid="appointment-when">
                {when(a.at, tz, lang)}
              </span>
              <Badge tone={badge[1]}>{badge[0]}</Badge>
            </div>
            {a.doctor_name && <span className="text-[14px] text-[#3D4552]">{a.doctor_name}</span>}
            {a.status === 'booked' && extra?.(a)}
            {a.status === 'cancelled' && (
              <p className="text-[14px] text-[#3D4552]" data-testid="appointment-cancelled">
                {a.cancelled_by === 'patient'
                  ? t('appts.youCancelled')
                  : t('appts.hospitalCancelled', {
                      hospital: h.hospital,
                      reason: t(`appts.cancelReason.${a.cancel_reason ?? 'other'}`),
                    })}
              </p>
            )}
            {a.offer && (
              <>
                <p className="text-[14px] leading-5 text-[#8A4B00]" data-testid="appointment-offer">
                  {t('appts.offerLine', {
                    hospital: h.hospital,
                    by: when(a.offer.reply_by, tz, lang),
                  })}
                </p>
                <Button
                  onClick={() => setView({ kind: 'offer', offer: a.offer!, appt: a })}
                  data-testid="appointment-offer-open"
                >
                  {t('appts.chooseTime')}
                </Button>
              </>
            )}
            {c?.status === 'open' && (
              <p className="text-[14px] leading-5 text-[#3D4552]" data-testid="appointment-asked">
                {t('appts.youAskedTimes', { count: c.choices.length, hospital: h.hospital })}
              </p>
            )}
            {a.moved_from && a.status === 'booked' && (
              <p className="text-[14px] leading-5 text-[#3D4552]" data-testid="appointment-moved">
                {a.moved_by_hospital
                  ? t('appts.movedByHospital', { hospital: h.hospital })
                  : t('appts.movedAsAsked')}
                {a.moved_from_doctor_name
                  ? ` ${t('appts.newDoctor', { from: a.moved_from_doctor_name })}`
                  : ''}
                <span className="block text-[12px] text-muted">
                  {t('appts.before', { when: when(a.moved_from, tz, lang) })}
                </span>
              </p>
            )}
            {a.waiting_for_tests && (
              <p className="text-[13px] text-muted" data-testid="appointment-waiting-tests">
                {t('appts.waitingForTests')}
              </p>
            )}
            {c?.status === 'declined' && (
              <p
                className="text-[14px] leading-5 text-[#3D4552]"
                data-testid="appointment-declined"
              >
                {t(`appts.answer.${c.answer ?? 'keep'}`, { hospital: h.hospital })}
              </p>
            )}
            {a.can_ask && (
              <Button
                variant="secondary"
                onClick={() => setView({ kind: 'ask', appt: a })}
                data-testid="appointment-ask"
              >
                {t('appts.ask')}
              </Button>
            )}
            {c?.status === 'open' && (
              <Button
                variant="ghost"
                onClick={() => void post(`/patient/change-requests/${c.id}/withdraw`)}
                data-testid="appointment-withdraw"
              >
                {t('appts.withdraw')}
              </Button>
            )}
            {a.status === 'booked' && !a.can_ask && !c && !a.offer && a.ask_until && (
              <span className="text-[12px] text-muted" data-testid="appointment-too-late">
                {t('appts.tooLate', { hospital: h.hospital, hours: data.cutoff_hours })}
              </span>
            )}
            {a.can_cancel && (
              <Button
                variant="ghost"
                onClick={() => setView({ kind: 'cancel', appt: a })}
                data-testid="appointment-cancel"
              >
                {t('appts.cancel')}
              </Button>
            )}
          </Card>
        );
      })}
    </section>
  );
}

// --- Picking exact free times (change or booking) ---

interface Block {
  day: string;
  rank: 'preferred' | 'alternative';
  times: string[];
}

const ymd = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
/** "2026-11" → [first day, last day] of that month. */
function monthBounds(month: string): [string, string] {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return [ymd(y, m, 1), ymd(y, m, new Date(Date.UTC(y, m, 0)).getUTCDate())];
}
const shiftDay = (day: string) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * v17: a month calendar instead of a row of date bubbles. Days with free times have a dot; full,
 * closed or out-of-range days are grey. Tapping a day adds it as a preferred or alternative date
 * (up to the hospital's numbers) and shows its free times, in morning and afternoon.
 */
function TimesPicker({
  h,
  data,
  doctorId,
  appointmentId,
  blocks,
  onBlocks,
}: {
  h: PatientHospital;
  data: AppointmentsOut;
  doctorId: string | null;
  appointmentId: string | null;
  blocks: Block[];
  onBlocks: (b: Block[]) => void;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const tz = data.time_zone;
  const r = data.booking;
  const first = dayIn(appointmentId ? 1 : Math.max(1, r.min_days), tz);
  const last = dayIn(
    (appointmentId ? 1 : Math.max(1, r.min_days)) +
      (appointmentId ? data.max_days_ahead : r.days_ahead) -
      1,
    tz,
  );
  const [month, setMonth] = useState(first.slice(0, 7));
  const [rank, setRank] = useState<'preferred' | 'alternative'>('preferred');
  const [focus, setFocus] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const [counts, setCounts] = useState<Record<string, number | 'error'>>({});
  const asked = useRef(new Set<string>());
  const [free, setFree] = useState<Record<string, string[] | 'error'>>({});
  const limit = { preferred: r.preferred, alternative: r.alternatives };
  const ofRank = (k: 'preferred' | 'alternative') => blocks.filter((b) => b.rank === k);
  const ordered = [...ofRank('preferred'), ...ofRank('alternative')];
  const key = `${doctorId ?? ''}|${appointmentId ?? ''}`;

  // Free-time counts for the month shown (one request a month).
  useEffect(() => {
    const [a, b] = monthBounds(month);
    const from = a < first ? first : a;
    const to = b > last ? last : b;
    if (from > to || asked.current.has(`${key}|${from}`)) return;
    asked.current.add(`${key}|${from}`);
    const q = new URLSearchParams({ from, to });
    if (doctorId) q.set('doctor_id', doctorId);
    if (appointmentId) q.set('appointment_id', appointmentId);
    hospitalApi<{ days: { date: string; free: number }[] }>(
      capture.kit,
      h,
      'GET',
      `/patient/free-days?${q.toString()}`,
    ).then(
      (x) =>
        setCounts((c) => ({
          ...c,
          ...Object.fromEntries(x.days.map((d) => [`${key}|${d.date}`, d.free])),
        })),
      // Offline or failed: every day in range stays tappable (its times say what is free).
      () =>
        setCounts((c) => {
          const n = { ...c };
          for (let d = from; d <= to; d = shiftDay(d)) n[`${key}|${d}`] = 'error';
          return n;
        }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, key]);

  // The free times of the day being looked at.
  useEffect(() => {
    if (!focus || free[focus]) return;
    const q = new URLSearchParams({ date: focus });
    if (doctorId) q.set('doctor_id', doctorId);
    if (appointmentId) q.set('appointment_id', appointmentId);
    hospitalApi<{ times: { time: string }[] }>(
      capture.kit,
      h,
      'GET',
      `/patient/free-times?${q.toString()}`,
    ).then(
      (x) => setFree((f) => ({ ...f, [focus]: x.times.map((y) => y.time) })),
      () => setFree((f) => ({ ...f, [focus]: 'error' })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, doctorId, appointmentId]);

  const tapDay = (d: string) => {
    setFull(false);
    if (blocks.some((b) => b.day === d)) return setFocus(d);
    if (ofRank(rank).length >= limit[rank]) return setFull(true);
    onBlocks([...blocks, { day: d, rank, times: [] }]);
    setFocus(d);
  };
  const removeDay = (d: string) => {
    onBlocks(blocks.filter((b) => b.day !== d));
    setFocus(null);
  };
  const toggleTime = (d: string, time: string) =>
    onBlocks(
      blocks.map((b) =>
        b.day !== d
          ? b
          : b.times.includes(time)
            ? { ...b, times: b.times.filter((x) => x !== time) }
            : b.times.length >= r.times_per_date
              ? b
              : { ...b, times: [...b.times, time].sort() },
      ),
    );

  // The month grid, Monday first.
  const [y, m] = month.split('-').map(Number) as [number, number];
  const [mStart, mEnd] = monthBounds(month);
  const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
  const daysIn = Number(mEnd.slice(8));
  const weekdays = Array.from({ length: 7 }, (_, i) =>
    new Intl.DateTimeFormat(locale(lang), { weekday: 'narrow', timeZone: 'UTC' }).format(
      new Date(Date.UTC(2026, 10, 16 + i)),
    ),
  );
  const monthName = new Intl.DateTimeFormat(locale(lang), {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, 1)));
  const canPrev = mStart > first;
  const canNext = mEnd < last;
  const fb = focus ? blocks.find((b) => b.day === focus) : undefined;
  const fi = fb ? ordered.indexOf(fb) : -1;
  const ft = focus ? free[focus] : undefined;
  const slot = (time: string) => (
    <button
      key={time}
      type="button"
      onClick={() => toggleTime(focus!, time)}
      aria-pressed={!!fb?.times.includes(time)}
      className={`h-11 rounded-lg border text-[14px] font-semibold ${
        fb?.times.includes(time)
          ? 'border-brand bg-brand text-white'
          : 'border-[#C9CFD8] bg-white text-ink'
      }`}
      data-testid={`picker-time-${fi}-${time}`}
    >
      {timeLabel(time, lang)}
    </button>
  );

  return (
    <div className="flex flex-col gap-3" data-testid="times-picker">
      {r.alternatives > 0 && (
        <div
          className="grid grid-cols-2 overflow-hidden rounded-xl border border-[#C9CFD8]"
          role="group"
        >
          {(['preferred', 'alternative'] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={rank === k}
              onClick={() => {
                setRank(k);
                setFull(false);
              }}
              className={`min-h-11 text-[14px] font-semibold ${rank === k ? 'bg-brand text-white' : 'bg-white text-ink'}`}
              data-testid={`picker-rank-${k}`}
            >
              {t(`appts.rank.${k}`, { n: ofRank(k).length, max: limit[k] })}
            </button>
          ))}
        </div>
      )}
      <Card className="flex flex-col gap-2 !p-3" data-testid="picker-calendar">
        <div className="flex items-center justify-between">
          <button
            type="button"
            disabled={!canPrev}
            onClick={() => setMonth(shiftMonth(month, -1))}
            aria-label={t('appts.cal.prev')}
            className="flex size-11 items-center justify-center rounded-lg text-[22px] text-brand disabled:text-[#C3C8D0]"
            data-testid="picker-prev-month"
          >
            ‹
          </button>
          <b className="text-[16px]" data-testid="picker-month">
            {monthName}
          </b>
          <button
            type="button"
            disabled={!canNext}
            onClick={() => setMonth(shiftMonth(month, 1))}
            aria-label={t('appts.cal.next')}
            className="flex size-11 items-center justify-center rounded-lg text-[22px] text-brand disabled:text-[#C3C8D0]"
            data-testid="picker-next-month"
          >
            ›
          </button>
        </div>
        <div className="grid grid-cols-7 gap-1" role="grid" aria-label={t('appts.whichDays')}>
          {weekdays.map((w, i) => (
            <span key={i} className="text-center text-[11px] font-bold text-muted">
              {w}
            </span>
          ))}
          {Array.from({ length: lead }, (_, i) => (
            <span key={`b${i}`} />
          ))}
          {Array.from({ length: daysIn }, (_, i) => {
            const d = ymd(y, m, i + 1);
            const c = counts[`${key}|${d}`];
            const inRange = d >= first && d <= last;
            const b = blocks.find((x) => x.day === d);
            const open = inRange && (b || (typeof c === 'number' && c > 0) || c === 'error');
            const base =
              'relative flex h-10 flex-col items-center justify-center rounded-lg text-[14px]';
            if (!open)
              return (
                <span key={d} className={`${base} text-[#B4BAC3]`} aria-disabled="true">
                  {i + 1}
                </span>
              );
            const cls = b
              ? b.rank === 'preferred'
                ? 'bg-brand font-bold text-white'
                : 'border-2 border-brand font-bold text-brand'
              : 'font-semibold text-ink';
            return (
              <button
                key={d}
                type="button"
                onClick={() => tapDay(d)}
                aria-pressed={!!b}
                aria-label={dayLabel(d, lang)}
                className={`${base} ${cls} ${focus === d ? 'ring-2 ring-[#0B5FAA]/40' : ''}`}
                data-testid={`change-day-${d}`}
              >
                {i + 1}
                {b ? (
                  <span className="text-[8px] leading-[9px] font-bold">
                    {t(`appts.cal.tag.${b.rank}`)}
                  </span>
                ) : (
                  <span className="mt-0.5 size-1.5 rounded-full bg-[#1F8A4C]" />
                )}
              </button>
            );
          })}
        </div>
        <span className="text-[11px] text-muted">{t('appts.cal.legend')}</span>
      </Card>
      {full && (
        <p className="rounded-xl bg-[#FDF0DD] px-3 py-2 text-[13px] text-[#8A4B00]" role="status">
          {t('appts.cal.full', { count: limit[rank], rank: t(`appts.rankShort.${rank}`) })}
        </p>
      )}
      {!focus && (
        <span className="text-[13px] text-muted">
          {t('appts.pickHint', { times: r.times_per_date })}
        </span>
      )}
      {focus && fb && (
        <Card className="flex flex-col gap-2" data-testid="picker-day">
          <div className="flex items-center justify-between gap-2">
            <b className="text-[15px]">
              {dayLabel(focus, lang)} · {t(`appts.rankShort.${fb.rank}`)}
            </b>
            <button
              type="button"
              onClick={() => removeDay(focus)}
              className="min-h-11 px-1 text-[13px] font-semibold text-bad"
              data-testid="picker-remove"
            >
              {t('appts.cal.remove')}
            </button>
          </div>
          <span className="text-[13px] text-muted">
            {t('appts.cal.upTo', { count: r.times_per_date })}
          </span>
          {ft === undefined && <span className="text-muted">…</span>}
          {ft === 'error' && <ErrorText code="network" />}
          {Array.isArray(ft) && ft.length === 0 && (
            <span className="text-[14px] text-muted" data-testid="picker-none">
              {t('appts.noFreeTimes')}
            </span>
          )}
          {Array.isArray(ft) &&
            (['am', 'pm'] as const).map((part) => {
              const list = ft.filter((x) => (part === 'am' ? x < '12:00' : x >= '12:00'));
              return list.length === 0 ? null : (
                <div key={part} className="flex flex-col gap-1.5">
                  <span className="text-[11px] font-bold text-muted uppercase">
                    {t(`appts.cal.${part}`)}
                  </span>
                  <div className="grid grid-cols-4 gap-1.5">{list.map(slot)}</div>
                </div>
              );
            })}
        </Card>
      )}
      {ordered.length > 0 && (
        <ol className="flex flex-col overflow-hidden rounded-2xl border border-line bg-white">
          {ordered.map((b) => (
            <li key={b.day} data-testid="picker-block">
              <button
                type="button"
                onClick={() => {
                  setFocus(b.day);
                  setMonth(b.day.slice(0, 7));
                }}
                className="flex min-h-11 w-full items-center justify-between gap-2 border-b border-[#EDF0F3] px-4 py-2 text-left text-[14px]"
              >
                <span>
                  <b>{t(`appts.rankLabel.${b.rank}`, { n: ofRank(b.rank).indexOf(b) + 1 })}</b> ·{' '}
                  {dayLabel(b.day, lang)}
                </span>
                <span className={b.times.length ? 'text-ink' : 'text-[#8A4B00]'}>
                  {b.times.length
                    ? b.times.map((x) => timeLabel(x, lang)).join(', ')
                    : t('appts.cal.noTimeYet')}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

const toChoices = (blocks: Block[], tz: string) =>
  blocks.flatMap((b) => b.times.map((x) => ({ at: zonedIso(b.day, x, tz), rank: b.rank })));

function TimesForm({
  h,
  data,
  title,
  appt,
  onCancel,
  onSent,
}: {
  h: PatientHospital;
  data: AppointmentsOut;
  title: string;
  appt: PatientAppointment;
  onCancel: () => void;
  onSent: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { config } = useApp();
  const tz = data.time_zone;
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [anyDoctor, setAnyDoctor] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choices = toChoices(blocks, tz);
  const ready = choices.some((c) => c.rank === 'preferred');
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await hospitalApi(capture.kit, h, 'POST', `/patient/appointments/${appt.id}/change-request`, {
        choices,
        any_doctor: anyDoctor,
        reason,
      });
      onSent();
    } catch (e) {
      setError(errorCode(e));
    }
    setBusy(false);
  };
  return (
    <section className="flex flex-col gap-3" data-testid="change-form">
      <h2 className="text-[18px] font-bold">{title}</h2>
      <Card className="flex flex-col gap-1">
        <span className="text-[12px] font-bold text-muted">
          {t('appts.nowBooked').toUpperCase()}
        </span>
        <b className="text-[15px]">
          {when(appt.at, tz, i18n.language)}
          {appt.doctor_name ? ` · ${appt.doctor_name}` : ''}
        </b>
      </Card>
      <TimesPicker
        h={h}
        data={data}
        doctorId={null}
        appointmentId={appt.id}
        blocks={blocks}
        onBlocks={setBlocks}
      />
      <label className="flex min-h-11 items-center gap-2 text-[14px]">
        <input
          type="checkbox"
          checked={anyDoctor}
          onChange={(e) => setAnyDoctor(e.target.checked)}
          className="h-4 w-4"
          data-testid="change-any-doctor"
        />
        {t('appts.anyDoctorOk')}
      </label>
      <b className="text-[15px]">{t('appts.why')}</b>
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('appts.why')}>
        {config.platform.appointmentChanges.patientReasons.map((r) => (
          <Chip
            key={r}
            on={reason === r}
            onClick={() => setReason(reason === r ? null : r)}
            testId={`change-reason-${r}`}
          >
            {t(`appts.reason.${r}`)}
          </Chip>
        ))}
      </div>
      <p className="rounded-xl bg-[#FDF0DD] px-3 py-2 text-[14px] leading-5 text-[#8A4B00]">
        {t('appts.staysBooked', { date: when(appt.at, tz, i18n.language) })}
      </p>
      <ErrorText code={error} />
      <Button disabled={busy || !ready} onClick={() => void send()} data-testid="change-send">
        {t('appts.send', { count: choices.length })}
      </Button>
      <Button variant="secondary" onClick={onCancel} data-testid="change-cancel">
        {t('common.cancel')}
      </Button>
    </section>
  );
}

function BookForm({
  h,
  data,
  onCancel,
  onSent,
}: {
  h: PatientHospital;
  data: AppointmentsOut;
  onCancel: () => void;
  onSent: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { config } = useApp();
  const tz = data.time_zone;
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [doctors, setDoctors] = useState<Doctor[] | null>(null);
  const [doctor, setDoctor] = useState<Doctor | 'any' | null>(null);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [purpose, setPurpose] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    hospitalApi<Doctor[]>(capture.kit, h, 'GET', '/patient/doctors').then(setDoctors, (e) =>
      setError(errorCode(e)),
    );
  }, [h]);
  const choices = toChoices(blocks, tz);
  const docId = doctor && doctor !== 'any' ? doctor.id : null;
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await hospitalApi(capture.kit, h, 'POST', '/patient/bookings', {
        doctor_id: docId,
        choices,
        purpose,
      });
      onSent();
    } catch (e) {
      setError(errorCode(e));
    }
    setBusy(false);
  };
  const stepLabel = (
    <span className="text-[12px] font-bold text-muted uppercase">
      {t('appts.bookStep', { n: step })} · {t(`appts.bookStepName.${step}`)}
    </span>
  );
  return (
    <section className="flex flex-col gap-3" data-testid="book-form">
      <h2 className="text-[18px] font-bold">{t('appts.book')}</h2>
      {stepLabel}
      {step === 1 && (
        <>
          {(doctors ?? []).map((d) => (
            <Choice
              key={d.id}
              on={doctor !== 'any' && doctor?.id === d.id}
              onClick={() => setDoctor(d)}
              title={d.name}
              sub={d.department}
              testId={`book-doctor-${d.id}`}
            />
          ))}
          <Choice
            on={doctor === 'any'}
            onClick={() => setDoctor('any')}
            title={t('appts.anyDoctor')}
            sub={t('appts.anyDoctorSub', { hospital: h.hospital })}
            testId="book-doctor-any"
          />
          <Button disabled={!doctor} onClick={() => setStep(2)} data-testid="book-next">
            {t('common.continue')}
          </Button>
        </>
      )}
      {step === 2 && (
        <>
          <TimesPicker
            h={h}
            data={data}
            doctorId={docId}
            appointmentId={null}
            blocks={blocks}
            onBlocks={setBlocks}
          />
          <Button
            disabled={!choices.some((c) => c.rank === 'preferred')}
            onClick={() => setStep(3)}
            data-testid="book-next"
          >
            {t('common.continue')}
          </Button>
        </>
      )}
      {step === 3 && (
        <>
          <Card className="flex flex-col gap-1" data-testid="book-review">
            <b>{doctor === 'any' ? t('appts.anyDoctor') : doctor?.name}</b>
            {choices.map((c) => (
              <span key={c.at} className="text-[14px]">
                {t(`appts.rankShort.${c.rank}`)}: {when(c.at, tz, i18n.language)}
              </span>
            ))}
          </Card>
          <b className="text-[15px]">{t('appts.purposeTitle')}</b>
          <div className="flex flex-wrap gap-2" role="group">
            {config.platform.appointmentChanges.bookingPurposes.map((p) => (
              <Chip
                key={p}
                on={purpose === p}
                onClick={() => setPurpose(purpose === p ? null : p)}
                testId={`book-purpose-${p}`}
              >
                {t(`appts.purpose.${p}`)}
              </Chip>
            ))}
          </div>
          <p className="rounded-xl bg-[#FDF0DD] px-3 py-2 text-[14px] leading-5 text-[#8A4B00]">
            {t('appts.bookConfirmNote', { hospital: h.hospital })}
          </p>
          <ErrorText code={error} />
          <Button disabled={busy} onClick={() => void send()} data-testid="book-send">
            {t('appts.bookSend')}
          </Button>
        </>
      )}
      <ErrorText code={step === 3 ? null : error} />
      <Button
        variant="secondary"
        onClick={() => (step === 1 ? onCancel() : setStep((s) => (s - 1) as 1 | 2))}
        data-testid="book-back"
      >
        {step === 1 ? t('common.cancel') : t('common.back')}
      </Button>
    </section>
  );
}

function Choice({
  on,
  onClick,
  title,
  sub,
  testId,
}: {
  on: boolean;
  onClick: () => void;
  title: string;
  sub: string | null;
  testId: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`flex items-center gap-3 rounded-2xl bg-white px-4 py-3 text-left ${on ? 'border-2 border-brand' : 'border border-line'}`}
      data-testid={testId}
    >
      <span
        className={`inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-2 ${on ? 'border-brand' : 'border-[#C9CFD8]'}`}
      >
        {on && <span className="h-2 w-2 rounded-full bg-brand" />}
      </span>
      <span className="text-[14px] leading-5">
        <b className="text-[15px]">{title}</b>
        {sub && <span className="block text-[#3D4552]">{sub}</span>}
      </span>
    </button>
  );
}

// --- The hospital's offer ---

function OfferView({
  h,
  tz,
  offer,
  appt,
  onDone,
  onBack,
}: {
  h: PatientHospital;
  tz: string;
  offer: Offer;
  appt: PatientAppointment | null;
  onDone: () => void;
  onBack: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { config } = useApp();
  const [pick, setPick] = useState<number | null>(null);
  const [none, setNone] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lang = i18n.language;
  const act = async (path: string, body?: unknown) => {
    setBusy(true);
    setError(null);
    try {
      await hospitalApi(capture.kit, h, 'POST', `/patient/offers/${offer.id}/${path}`, body);
      onDone();
    } catch (e) {
      setError(errorCode(e));
    }
    setBusy(false);
  };
  if (none)
    return (
      <section className="flex flex-col gap-3" data-testid="offer-none">
        <h2 className="text-[18px] font-bold">{t('appts.noneWork')}</h2>
        {offer.status !== 'call_requested' && (
          <Card className="flex flex-col gap-2">
            <b>{t('appts.callMe', { hospital: h.hospital })}</b>
            <span className="text-[14px] text-[#3D4552]">
              {t('appts.callMeBody', { hospital: h.hospital })}
            </span>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void act('call')}
              data-testid="offer-call"
            >
              {t('appts.callMe', { hospital: h.hospital })}
            </Button>
          </Card>
        )}
        {offer.current_possible && appt && (
          <Card className="flex flex-col gap-2">
            <b>{t('appts.keepCurrent', { when: when(appt.at, tz, lang) })}</b>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void act('keep')}
              data-testid="offer-keep"
            >
              {t('appts.keepCurrentButton')}
            </Button>
          </Card>
        )}
        <Card className="flex flex-col gap-2">
          <b>{t(appt ? 'appts.cancelThis' : 'appts.cancelBooking')}</b>
          <span className="text-[14px] text-[#3D4552]">{t('appts.why')}</span>
          <div className="flex flex-wrap gap-2" role="group">
            {config.platform.appointmentChanges.patientCancelReasons.map((r) => (
              <Chip
                key={r}
                on={reason === r}
                onClick={() => setReason(reason === r ? null : r)}
                testId={`offer-cancel-reason-${r}`}
              >
                {t(`appts.cancelReason.${r}`)}
              </Chip>
            ))}
          </div>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => void act('decline', { reason })}
            data-testid="offer-decline"
          >
            {t(appt ? 'appts.cancelMine' : 'appts.cancelBooking')}
          </Button>
        </Card>
        <ErrorText code={error} />
        <Button variant="secondary" onClick={() => setNone(false)}>
          {t('common.back')}
        </Button>
      </section>
    );
  return (
    <section className="flex flex-col gap-3" data-testid="offer-view">
      <h2 className="text-[18px] font-bold">{t('appts.chooseTitle')}</h2>
      <p className="rounded-xl bg-[#FDF0DD] px-3 py-2 text-[14px] leading-5 text-[#8A4B00]">
        {appt
          ? t('appts.offerIntro', {
              hospital: h.hospital,
              when: when(appt.at, tz, lang),
              by: when(offer.reply_by, tz, lang),
            })
          : t('appts.offerIntroBooking', {
              hospital: h.hospital,
              by: when(offer.reply_by, tz, lang),
            })}
      </p>
      {offer.late && <p className="text-[13px] text-muted">{t('appts.offerLate')}</p>}
      {offer.options.map((o) => (
        <Choice
          key={o.index}
          on={pick === o.index}
          onClick={() => setPick(o.index)}
          title={when(o.at, tz, lang)}
          sub={`${o.doctor_name ?? ''}${o.other_doctor ? ` · ${t('appts.otherDoctor')}` : ''}`}
          testId={`offer-option-${o.index}`}
        />
      ))}
      <ErrorText code={error} />
      <Button
        disabled={busy || pick === null}
        onClick={() => void act('choose', { index: pick })}
        data-testid="offer-choose"
      >
        {pick === null
          ? t('appts.chooseOne')
          : t('appts.bookThis', { when: when(offer.options[pick]!.at, tz, lang) })}
      </Button>
      <Button variant="ghost" onClick={() => setNone(true)} data-testid="offer-none-open">
        {t('appts.noneWork')}
      </Button>
      <Button variant="secondary" onClick={onBack}>
        {t('common.back')}
      </Button>
    </section>
  );
}

// --- Cancelling ---

function CancelView({
  h,
  tz,
  appt,
  onDone,
  onBack,
}: {
  h: PatientHospital;
  tz: string;
  appt: PatientAppointment;
  onDone: () => void;
  onBack: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { config } = useApp();
  const [reason, setReason] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      await hospitalApi(capture.kit, h, 'POST', `/patient/appointments/${appt.id}/cancel`, {
        reason,
      });
      onDone();
    } catch (e) {
      setError(errorCode(e));
    }
    setBusy(false);
  };
  return (
    <section className="flex flex-col gap-3" data-testid="cancel-view">
      <h2 className="text-[18px] font-bold">{t('appts.cancelTitle')}</h2>
      <Card>
        <b>
          {when(appt.at, tz, i18n.language)}
          {appt.doctor_name ? ` · ${appt.doctor_name}` : ''}
        </b>
      </Card>
      <b className="text-[15px]">{t('appts.why')}</b>
      <div className="flex flex-wrap gap-2" role="group">
        {config.platform.appointmentChanges.patientCancelReasons.map((r) => (
          <Chip
            key={r}
            on={reason === r}
            onClick={() => setReason(reason === r ? null : r)}
            testId={`cancel-reason-${r}`}
          >
            {t(`appts.cancelReason.${r}`)}
          </Chip>
        ))}
      </div>
      <p className="rounded-xl bg-[#E6EFF8] px-3 py-2 text-[14px] leading-5 text-[#0B4A85]">
        {t('appts.cancelNote', { hospital: h.hospital })}
      </p>
      <ErrorText code={error} />
      <Button
        variant="danger"
        disabled={busy}
        onClick={() => void cancel()}
        data-testid="cancel-confirm"
      >
        {t('appts.cancelMine')}
      </Button>
      <Button variant="secondary" onClick={onBack}>
        {t('appts.keepIt')}
      </Button>
    </section>
  );
}
