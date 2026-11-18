/**
 * v13 (decision 045): the patient's upcoming appointments at one hospital, and asking for another
 * date: up to 3 days and a time of day, with a reason from a fixed list (no free text, so no health
 * details reach the platform). The appointment stays as booked until the hospital answers; the
 * answer shows here (and, if the desk chose, by SMS or e-mail from the hospital).
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApp } from '../../app/AppContext.tsx';
import { capture } from '../../lib/capture.ts';
import { errorCode } from '../../lib/accounts.ts';
import { cacheKey, hospitalApi, type PatientHospital } from '../../lib/hospitals.ts';
import { logger } from '../../lib/logger.ts';
import { Button, Card } from '../../ui/kit.tsx';
import { ErrorText } from '../modes/Common.tsx';

interface Change {
  id: string;
  days: string[];
  part_of_day: 'morning' | 'afternoon' | 'any';
  reason: string | null;
  status: 'open' | 'accepted' | 'declined' | 'closed' | 'withdrawn';
  answer: string | null;
}
export interface PatientAppointment {
  id: string;
  at: string;
  doctor_name: string | null;
  can_ask: boolean;
  ask_until: string | null;
  change: Change | null;
  moved_from: string | null;
  moved_from_doctor_name: string | null;
  moved_by_hospital: boolean;
}
interface AppointmentsOut {
  appointments: PatientAppointment[];
  time_zone: string;
  max_days: number;
  max_days_ahead: number;
  cutoff_hours: number;
}

const PARTS = ['morning', 'afternoon', 'any'] as const;
const DAYS_SHOWN = 14;
const DAYS_MORE = 42;

/** "2026-11-24" in the hospital's time zone, `n` days from now. */
function dayIn(n: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Date.now() + n * 86_400_000));
}
function locale(lang: string) {
  return lang === 'hi' ? 'hi-IN' : 'en-IN';
}
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
  children: React.ReactNode;
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
        // Offline: what the phone last saw, without asking (it needs the hospital to answer).
        if (!off && cached)
          setData({
            ...cached,
            appointments: cached.appointments.map((a) => ({ ...a, can_ask: false })),
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

export function AppointmentsSection({ h }: { h: PatientHospital }) {
  const { t, i18n } = useTranslation();
  const { data, reload } = useAppointments(h);
  const [asking, setAsking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!data || data.appointments.length === 0) return null;
  const tz = data.time_zone;
  const lang = i18n.language;

  const withdraw = async (c: Change) => {
    setError(null);
    try {
      await hospitalApi(capture.kit, h, 'POST', `/patient/change-requests/${c.id}/withdraw`);
      reload();
    } catch (e) {
      setError(errorCode(e));
    }
  };

  const asked = data.appointments.find((a) => a.id === asking);
  if (asked)
    return (
      <ChangeForm
        h={h}
        appt={asked}
        data={data}
        onCancel={() => setAsking(null)}
        onSent={() => {
          setAsking(null);
          reload();
        }}
      />
    );

  return (
    <section className="flex flex-col gap-3" data-testid="appointments">
      <h2 className="text-[16px] font-bold">{t('appts.title')}</h2>
      <ErrorText code={error} />
      {data.appointments.map((a) => {
        const c = a.change;
        const badge =
          c?.status === 'open'
            ? ['warn', t('appts.badge.asked')]
            : c?.status === 'accepted' || a.moved_from
              ? ['ok', t('appts.badge.changed')]
              : c?.status === 'declined'
                ? ['bad', t('appts.badge.notChanged')]
                : ['ok', t('appts.badge.booked')];
        return (
          <Card key={a.id} className="flex flex-col gap-2" data-testid="appointment-card">
            <div className="flex items-start justify-between gap-2">
              <span className="text-[17px] font-bold" data-testid="appointment-when">
                {when(a.at, tz, lang)}
              </span>
              <span
                className={`shrink-0 rounded-xl px-2.5 py-0.5 text-[12px] font-semibold ${
                  {
                    ok: 'bg-[#E3F4EA] text-[#145F38]',
                    warn: 'bg-[#FDF0DD] text-[#8A4B00]',
                    bad: 'bg-[#FDECEA] text-[#B42318]',
                  }[badge[0] as 'ok' | 'warn' | 'bad']
                }`}
                data-testid="appointment-badge"
              >
                {badge[1]}
              </span>
            </div>
            {a.doctor_name && <span className="text-[14px] text-[#3D4552]">{a.doctor_name}</span>}
            {c?.status === 'open' && (
              <p className="text-[14px] leading-5 text-[#3D4552]" data-testid="appointment-asked">
                {t('appts.youAsked', {
                  days: c.days.map((d) => dayLabel(d, lang)).join(', '),
                  part: t(`appts.part.${c.part_of_day}`),
                  hospital: h.hospital,
                })}
              </p>
            )}
            {a.moved_from && (
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
                onClick={() => setAsking(a.id)}
                data-testid="appointment-ask"
              >
                {t('appts.ask')}
              </Button>
            )}
            {c?.status === 'open' && (
              <Button
                variant="ghost"
                onClick={() => void withdraw(c)}
                data-testid="appointment-withdraw"
              >
                {t('appts.withdraw')}
              </Button>
            )}
            {!a.can_ask && c?.status !== 'open' && a.ask_until && (
              <span className="text-[12px] text-muted" data-testid="appointment-too-late">
                {t('appts.tooLate', { hospital: h.hospital, hours: data.cutoff_hours })}
              </span>
            )}
          </Card>
        );
      })}
    </section>
  );
}

function ChangeForm({
  h,
  appt,
  data,
  onCancel,
  onSent,
}: {
  h: PatientHospital;
  appt: PatientAppointment;
  data: AppointmentsOut;
  onCancel: () => void;
  onSent: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { config } = useApp();
  const tz = data.time_zone;
  const [more, setMore] = useState(false);
  const [days, setDays] = useState<string[]>([]);
  const [part, setPart] = useState<(typeof PARTS)[number] | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const offered = Array.from(
    { length: Math.min(more ? DAYS_MORE : DAYS_SHOWN, data.max_days_ahead) },
    (_, i) => dayIn(i + 1, tz),
  );
  const toggle = (d: string) =>
    setDays((x) => (x.includes(d) ? x.filter((y) => y !== d) : [...x, d].slice(-data.max_days)));

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await hospitalApi(capture.kit, h, 'POST', `/patient/appointments/${appt.id}/change-request`, {
        days,
        part_of_day: part,
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
      <h2 className="text-[18px] font-bold">{t('appts.askTitle')}</h2>
      <Card className="flex flex-col gap-1">
        <span className="text-[12px] font-bold text-muted">
          {t('appts.nowBooked').toUpperCase()}
        </span>
        <b className="text-[15px]">
          {when(appt.at, tz, i18n.language)}
          {appt.doctor_name ? ` · ${appt.doctor_name}` : ''}
        </b>
      </Card>
      <b className="text-[15px]">{t('appts.whichDays', { n: data.max_days })}</b>
      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label={t('appts.whichDays', { n: data.max_days })}
      >
        {offered.map((d) => (
          <Chip key={d} on={days.includes(d)} onClick={() => toggle(d)} testId={`change-day-${d}`}>
            {dayLabel(d, i18n.language)}
          </Chip>
        ))}
        {!more && (
          <Chip on={false} onClick={() => setMore(true)} testId="change-more">
            {t('appts.moreDates')}
          </Chip>
        )}
      </div>
      <b className="text-[15px]">{t('appts.whatTime')}</b>
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('appts.whatTime')}>
        {PARTS.map((p) => (
          <Chip key={p} on={part === p} onClick={() => setPart(p)} testId={`change-part-${p}`}>
            {t(`appts.partChip.${p}`)}
          </Chip>
        ))}
      </div>
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
      <Button
        disabled={busy || days.length === 0 || !part}
        onClick={() => void send()}
        data-testid="change-send"
      >
        {t('appts.send')}
      </Button>
      <Button variant="secondary" onClick={onCancel} data-testid="change-cancel">
        {t('common.cancel')}
      </Button>
    </section>
  );
}
