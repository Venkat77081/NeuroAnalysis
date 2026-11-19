/**
 * v30 (decision 053): the front desk's "Today" (canvas v28): the sunrise greeting with the next
 * patient, today's appointments in time order with a Now line, "Did not come" from the
 * appointment time, patients' requests and quick actions. Names come live from the connector;
 * patient codes (NCIDs) are shown when it cannot be reached.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { call, hospital } from './api.ts';
import { AppointmentHistory, type Appointment } from './appointments.tsx';
import { useSettings, zonedDay, zonedTime } from './changes.tsx';
import { NoShowDialog, sinceText, type Inbox } from './desk.tsx';
import {
  Avatar,
  Badge,
  Button,
  Card,
  Dialog,
  ErrorNote,
  Hero,
  Notice,
  NowLine,
  Page,
  avatarColour,
} from './ui.tsx';

interface Ident {
  ncid: string;
  mrn: string;
  name: string | null;
}
interface PatientRow {
  ncid: string;
  status: string;
}
export type TodayTone = 'ok' | 'warn' | 'bad' | 'neutral' | 'info';

/** What a row says, in order of importance. */
export function todayStatus(
  a: Pick<Appointment, 'at' | 'status' | 'stage' | 'cancel_reason' | 'requests'>,
  now: number,
  joined: boolean,
): { key: string; tone: TodayTone; minutes?: number } {
  const late = Math.floor((now - Date.parse(a.at)) / 60_000);
  const clinic = a.requests.some((r) => r.place === 'clinic' && r.state === 'open');
  if (a.status === 'cancelled')
    return a.cancel_reason === 'no_show'
      ? { key: 'noShow', tone: 'bad' }
      : { key: 'cancelled', tone: 'neutral' };
  if (a.stage === 'recorded') return { key: 'recorded', tone: 'ok' };
  if (late >= 0) return { key: 'late', tone: 'bad', minutes: late };
  if (a.stage === 'needs_doctor') return { key: 'needsDoctor', tone: 'warn' };
  if (a.stage === 'needs_tests') return { key: 'needsTests', tone: 'warn' };
  if (clinic) return joined ? { key: 'clinic', tone: 'info' } : { key: 'noApp', tone: 'warn' };
  if (a.stage === 'sent') return { key: 'linkSent', tone: 'info' };
  return { key: 'booked', tone: 'neutral' };
}

/** "Did not come" is offered from the appointment time, while nothing was recorded. */
export const canMarkNoShow = (a: Pick<Appointment, 'at' | 'status' | 'stage'>, now: number) =>
  a.status === 'booked' && a.stage !== 'recorded' && Date.parse(a.at) <= now;

function hello(name: string | null | undefined) {
  return name ?? null;
}

export function DeskToday({
  name,
  onOpen,
}: {
  name: string | null;
  onOpen: (page: string) => void;
}) {
  const { t } = useTranslation();
  const settings = useSettings();
  const tz =
    settings?.time_zone ??
    (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch {
        return 'UTC';
      }
    })();
  const [appts, setAppts] = useState<Appointment[] | null>(null);
  const [ident, setIdent] = useState<Record<string, Ident>>({});
  const [joined, setJoined] = useState<Record<string, boolean>>({});
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [doctor, setDoctor] = useState<string>('');
  const [open, setOpen] = useState<string | null>(null);
  const [noShow, setNoShow] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let off = false;
    void (async () => {
      try {
        const [list, patients, box] = await Promise.all([
          call<Appointment[]>('GET', '/hospital/appointments?days=1'),
          call<PatientRow[]>('GET', '/hospital/patients'),
          call<Inbox>('GET', '/hospital/inbox').catch(() => null),
        ]);
        if (off) return;
        setAppts(list);
        setInbox(box);
        setJoined(Object.fromEntries(patients.map((p) => [p.ncid, p.status === 'active'])));
        const ncids = [
          ...new Set([
            ...list.map((a) => a.ncid),
            ...(box?.requests ?? []).map((r) => r.ncid),
            ...(box?.cancellations ?? []).map((c) => c.ncid),
            ...(box?.offers ?? []).map((o) => o.ncid),
          ]),
        ];
        if (ncids.length)
          hospital<Ident[]>('POST', '/v1/patients/lookup', { ncids }).then(
            (ids) => !off && setIdent(Object.fromEntries(ids.map((i) => [i.ncid, i]))),
            () => undefined, // names stay hidden; patient codes are shown
          );
      } catch (e) {
        if (!off) setError(e);
      }
    })();
    return () => {
      off = true;
    };
  }, [version]);

  const today = zonedDay(now, tz);
  const list = useMemo(
    () =>
      (appts ?? [])
        .filter((a) => zonedDay(a.at, tz) === today)
        .sort((x, y) => Date.parse(x.at) - Date.parse(y.at)),
    [appts, tz, today],
  );
  const doctors = [...new Set(list.flatMap((a) => (a.doctor_name ? [a.doctor_name] : [])))].sort();
  const shown = list.filter((a) => !doctor || a.doctor_name === doctor);
  const nameOf = (ncid: string) => ident[ncid]?.name ?? ncid;
  const nowAt = shown.findIndex((a) => Date.parse(a.at) > now);
  const upcoming = list.filter((a) => a.status === 'booked' && Date.parse(a.at) > now);
  const next = upcoming[0];
  const late = list.filter((a) => canMarkNoShow(a, now)).length;
  const requests = inbox?.count ?? 0;
  const firstLocked = shown.find((a) => a.status === 'booked' && Date.parse(a.at) > now);

  const hero = (
    <Hero
      tz={tz}
      name={hello(name)}
      line={t('today.line', { count: list.length, requests })}
      chips={[
        t('today.chipToday', { count: list.length }),
        t('today.chipRequests', { count: requests }),
        t('today.chipLate', { count: late }),
      ]}
      right={
        next ? (
          <span className="flex flex-col gap-1" data-testid="today-next">
            <span className="text-[12px] font-bold text-sub uppercase">
              {t('today.next', {
                time: zonedTime(next.at, tz),
                doctor: next.doctor_name ?? t('cal.noDoctor'),
              })}
            </span>
            <b className="text-[16px]">{nameOf(next.ncid)}</b>
            <span className="text-sub">
              {t(`today.status.${todayStatus(next, now, !!joined[next.ncid]).key}`, {
                since: sinceText(t, 0),
              })}
            </span>
          </span>
        ) : undefined
      }
    />
  );

  const rows = shown.map((a, i) => {
    const st = todayStatus(a, now, !!joined[a.ncid]);
    const past = Date.parse(a.at) <= now;
    const done = a.status === 'cancelled' || a.stage === 'recorded';
    return (
      <div key={a.id}>
        {i === nowAt && i > 0 && (
          <NowLine label={t('shell.now', { time: zonedTime(new Date(now).toISOString(), tz) })} />
        )}
        <div
          className={`flex flex-wrap items-center gap-3 border-t border-line py-2.5 ${done ? 'opacity-60' : ''}`}
          data-testid={`today-${ident[a.ncid]?.mrn ?? a.ncid}`}
        >
          <b className="w-12 text-[14px] tabular-nums">{zonedTime(a.at, tz)}</b>
          <Avatar name={ident[a.ncid]?.name ?? null} size={40} />
          <span className="flex min-w-[160px] flex-1 flex-col">
            <b className="text-[14px]">{nameOf(a.ncid)}</b>
            <span className="flex items-center gap-1.5 text-[12px] text-muted">
              <span
                aria-hidden
                className="size-2 rounded-full"
                style={{ background: a.doctor_name ? avatarColour(a.doctor_name) : '#8a89a0' }}
              />
              {a.doctor_name ?? t('cal.noDoctor')}
            </span>
          </span>
          <span className="min-w-[180px] flex-1" data-testid="today-status">
            <Badge tone={st.tone}>
              {t(`today.status.${st.key}`, { since: sinceText(t, st.minutes ?? 0) })}
            </Badge>
          </span>
          <span className="ml-auto">
            {canMarkNoShow(a, now) ? (
              <Button
                variant="danger-soft"
                className="min-h-9 text-[13px]"
                onClick={() => setNoShow(a.id)}
                data-testid="today-no-show"
              >
                {t('noShow.badge')}
              </Button>
            ) : a === firstLocked && !past ? (
              <Button
                variant="secondary"
                className="min-h-9 text-[13px]"
                disabled
                title={t('today.unlocks')}
              >
                {t('today.noShowAt', { time: zonedTime(a.at, tz) })}
              </Button>
            ) : a.stage === 'needs_doctor' && a.status === 'booked' ? (
              <Button
                variant="secondary"
                className="min-h-9 text-[13px]"
                onClick={() => onOpen('appointments')}
              >
                {t('overview.chooseDoctor')}
              </Button>
            ) : (
              <Button
                variant="secondary"
                className="min-h-9 text-[13px]"
                onClick={() => setOpen(a.id)}
                data-testid="today-open"
              >
                {t('overview.open')}
              </Button>
            )}
          </span>
        </div>
      </div>
    );
  });

  const reqRows = [
    ...(inbox?.requests ?? []).map((r) => ({
      key: `r${r.id}`,
      ncid: r.ncid,
      text:
        r.kind === 'change'
          ? t('today.reqChange', {
              count: r.choices.filter((c) => c.state === 'free').length,
            })
          : t('today.reqBooking'),
      action: { label: t('today.check'), run: () => onOpen('requests'), strong: true },
    })),
    ...(inbox?.offers ?? [])
      .filter((o) => o.no_answer || o.status === 'call_requested')
      .map((o) => ({
        key: `o${o.id}`,
        ncid: o.ncid,
        text: t(o.no_answer ? 'today.offerNoAnswer' : 'today.offerCall'),
        action: { label: t('today.check'), run: () => onOpen('requests'), strong: false },
      })),
    ...(inbox?.cancellations ?? []).map((c) => ({
      key: `c${c.appointment_id}`,
      ncid: c.ncid,
      text: t('today.reqCancelled', {
        reason: c.reason ? t(`cancel.reason.${c.reason}`, { defaultValue: c.reason }) : '',
      }),
      action: {
        label: t('today.seen'),
        strong: false,
        run: () =>
          void call('POST', `/hospital/appointments/${c.appointment_id}/cancellation-seen`).then(
            reload,
            setError,
          ),
      },
    })),
  ].slice(0, 5);

  const opened = list.find((a) => a.id === open);
  const marking = list.find((a) => a.id === noShow);
  return (
    <Page title={t('nav.today')} hero={hero}>
      <ErrorNote error={error} />
      {notice && <Notice testId="notice">{notice}</Notice>}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.75fr)_minmax(0,1fr)]">
        <Card
          title={t('today.title')}
          testId="desk-today"
          action={
            doctors.length > 1 ? (
              <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('today.filter')}>
                {['', ...doctors].map((d) => (
                  <button
                    key={d || 'all'}
                    type="button"
                    aria-pressed={doctor === d}
                    onClick={() => setDoctor(d)}
                    className={`min-h-9 rounded-full px-3.5 text-[13px] font-semibold ${doctor === d ? 'bg-ink text-ground' : 'bg-card text-sub shadow-[inset_0_0_0_1px_var(--color-edge)]'}`}
                  >
                    {d || t('today.allDoctors')}
                  </button>
                ))}
              </div>
            ) : undefined
          }
        >
          {appts && !shown.length && (
            <p className="py-6 text-center text-[14px] text-muted" data-testid="today-empty">
              {t('today.empty')}
            </p>
          )}
          {!appts && !error && <p className="text-muted">{t('app.loading')}</p>}
          <div className="flex flex-col">{rows}</div>
          {nowAt === -1 && shown.length > 0 && (
            <NowLine label={t('shell.now', { time: zonedTime(new Date(now).toISOString(), tz) })} />
          )}
        </Card>
        <div className="flex flex-col gap-4">
          <Card
            title={t('nav.requests')}
            testId="today-requests"
            action={
              requests ? <Badge tone="bad">{t('today.new', { count: requests })}</Badge> : undefined
            }
          >
            {reqRows.length === 0 ? (
              <p className="text-[14px] text-muted">{t('today.noRequests')}</p>
            ) : (
              reqRows.map((r) => (
                <div key={r.key} className="flex items-center gap-3 border-t border-line py-2.5">
                  <Avatar name={ident[r.ncid]?.name ?? null} size={36} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <b className="truncate text-[14px]">{nameOf(r.ncid)}</b>
                    <span className="truncate text-[12px] text-muted">{r.text}</span>
                  </span>
                  <Button
                    variant={r.action.strong ? 'primary' : 'secondary'}
                    className="min-h-9 text-[13px]"
                    onClick={r.action.run}
                  >
                    {r.action.label}
                  </Button>
                </div>
              ))
            )}
          </Card>
          <Card testId="today-quick">
            <Button onClick={() => onOpen('book')} data-testid="today-book">
              ＋ {t('shell.actions.add')}
            </Button>
            <Button variant="secondary" onClick={() => onOpen('invite')}>
              {t('shell.actions.invite')}
            </Button>
          </Card>
        </div>
      </div>
      {opened && (
        <Dialog
          title={t('appts.historyTitle', { name: nameOf(opened.ncid) })}
          sub={`${zonedTime(opened.at, tz)} · ${opened.doctor_name ?? '—'}`}
          onClose={() => setOpen(null)}
          testId="history-dialog"
        >
          <AppointmentHistory id={opened.id} />
        </Dialog>
      )}
      {marking && (
        <NoShowDialog
          appt={marking}
          patient={nameOf(marking.ncid)}
          time={zonedTime(marking.at, tz)}
          now={now}
          onClose={() => setNoShow(null)}
          onDone={(m) => {
            setNoShow(null);
            setNotice(m);
            reload();
          }}
        />
      )}
    </Page>
  );
}

/** v30: what a doctor's row says and does (canvas v28 "Your clinic today"). */
export function doctorRow(
  a: Pick<Appointment, 'at' | 'status' | 'stage' | 'cancel_reason' | 'requests'>,
  now: number,
): { key: string; tone: TodayTone; action: 'watch' | 'choose' | 'open' } {
  const clinic = a.requests.some((r) => r.place === 'clinic' && r.state === 'open');
  if (a.status === 'cancelled')
    return {
      key: a.cancel_reason === 'no_show' ? 'noShow' : 'cancelled',
      tone: a.cancel_reason === 'no_show' ? 'bad' : 'neutral',
      action: 'open',
    };
  if (a.stage === 'recorded') return { key: 'ready', tone: 'ok', action: 'watch' };
  if (a.stage === 'needs_tests' || a.stage === 'needs_doctor')
    return { key: 'choose', tone: 'warn', action: 'choose' };
  if (clinic) return { key: 'clinic', tone: 'info', action: 'open' };
  if (Date.parse(a.at) <= now) return { key: 'notYet', tone: 'warn', action: 'open' };
  if (a.stage === 'sent') return { key: 'linkSent', tone: 'info', action: 'open' };
  return { key: 'booked', tone: 'neutral', action: 'open' };
}

interface RecItem {
  id: string | null;
  ncid: string | null;
  at: string | null;
  place: string | null;
  flagged: boolean | null;
  key: string;
}

export function DoctorToday({
  name,
  onOpen,
  onPatient,
}: {
  name: string | null;
  onOpen: (page: string) => void;
  onPatient: (ncid: string) => void;
}) {
  const { t } = useTranslation();
  const settings = useSettings();
  const tz =
    settings?.time_zone ??
    (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch {
        return 'UTC';
      }
    })();
  const [appts, setAppts] = useState<Appointment[] | null>(null);
  const [recs, setRecs] = useState<RecItem[]>([]);
  const [ident, setIdent] = useState<Record<string, Ident>>({});
  const [error, setError] = useState<unknown>(null);
  const [which, setWhich] = useState<'today' | 'tomorrow'>('today');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let off = false;
    void (async () => {
      try {
        const [list, ov] = await Promise.all([
          call<Appointment[]>('GET', '/hospital/appointments?days=2'),
          call<{ items: RecItem[] }>(
            'GET',
            `/overview?period=4w&tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`,
          ).catch(() => ({ items: [] })),
        ]);
        if (off) return;
        setAppts(list);
        const items = ov.items.filter((i) => i.key === 'recording');
        setRecs(items);
        const ncids = [
          ...new Set([
            ...list.map((a) => a.ncid),
            ...items.flatMap((i) => (i.ncid ? [i.ncid] : [])),
          ]),
        ];
        if (ncids.length)
          hospital<Ident[]>('POST', '/v1/patients/lookup', { ncids }).then(
            (ids) => !off && setIdent(Object.fromEntries(ids.map((i) => [i.ncid, i]))),
            () => undefined,
          );
      } catch (e) {
        if (!off) setError(e);
      }
    })();
    return () => {
      off = true;
    };
  }, []);
  const today = zonedDay(now, tz);
  const day = which === 'today' ? today : zonedDay(now + 86_400_000, tz);
  const all = (appts ?? []).filter((a) => zonedDay(a.at, tz) === today);
  const list = (appts ?? [])
    .filter((a) => zonedDay(a.at, tz) === day)
    .sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
  const nameOf = (ncid: string) => ident[ncid]?.name ?? ncid;
  const needTests = all.filter((a) => doctorRow(a, now).action === 'choose').length;
  const next = all
    .filter((a) => a.status === 'booked' && Date.parse(a.at) > now)
    .sort((x, y) => Date.parse(x.at) - Date.parse(y.at))[0];
  const nowAt = which === 'today' ? list.findIndex((a) => Date.parse(a.at) > now) : -2;
  const hero = (
    <Hero
      tz={tz}
      name={name}
      line={t('doctorToday.line', { count: all.length, tests: needTests, recs: recs.length })}
      chips={[
        t('today.chipToday', { count: all.length }),
        t('doctorToday.chipTests', { count: needTests }),
        t('doctorToday.chipRecs', { count: recs.length }),
      ]}
      right={
        next ? (
          <span className="flex flex-col gap-1" data-testid="today-next">
            <span className="text-[12px] font-bold text-sub uppercase">
              {t('doctorToday.next', { time: zonedTime(next.at, tz) })}
            </span>
            <b className="text-[16px]">{nameOf(next.ncid)}</b>
            <span className="text-sub">{t(`doctorToday.hint.${doctorRow(next, now).key}`)}</span>
          </span>
        ) : undefined
      }
    />
  );
  return (
    <Page title={t('nav.today')} hero={hero}>
      <ErrorNote error={error} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card
          title={t('doctorToday.title')}
          testId="doctor-today"
          action={
            <div className="inline-flex rounded-full bg-card p-[3px] shadow-[inset_0_0_0_1px_var(--color-edge)]">
              {(['today', 'tomorrow'] as const).map((w) => (
                <button
                  key={w}
                  type="button"
                  aria-pressed={which === w}
                  onClick={() => setWhich(w)}
                  className={`min-h-8 rounded-full px-3.5 text-[13px] font-bold ${which === w ? 'bg-ink text-ground' : 'text-sub'}`}
                >
                  {t(`doctorToday.${w}`)}
                </button>
              ))}
            </div>
          }
        >
          {appts && !list.length && (
            <p className="py-6 text-center text-[14px] text-muted">{t('doctorToday.empty')}</p>
          )}
          {list.map((a, i) => {
            const r = doctorRow(a, now);
            return (
              <div key={a.id}>
                {i === nowAt && i > 0 && (
                  <NowLine
                    label={t('shell.now', { time: zonedTime(new Date(now).toISOString(), tz) })}
                  />
                )}
                <div className="flex flex-wrap items-center gap-3 border-t border-line py-2.5">
                  <b className="w-12 text-[14px] tabular-nums">{zonedTime(a.at, tz)}</b>
                  <Avatar name={ident[a.ncid]?.name ?? null} size={40} />
                  <span className="flex min-w-[160px] flex-1 flex-col">
                    <b className="text-[14px]">{nameOf(a.ncid)}</b>
                    <span className="text-[12px] text-muted">{t(`appts.stage.${a.stage}`)}</span>
                  </span>
                  <span className="ml-auto flex items-center gap-2">
                    <Badge tone={r.tone}>{t(`doctorToday.status.${r.key}`)}</Badge>
                    <Button
                      variant={r.action === 'watch' ? 'primary' : 'secondary'}
                      className="min-h-9 text-[13px]"
                      onClick={() =>
                        r.action === 'choose' ? onOpen('chooseTests') : onPatient(a.ncid)
                      }
                      data-testid={`doctor-${r.action}`}
                    >
                      {t(`doctorToday.action.${r.action}`)}
                    </Button>
                  </span>
                </div>
              </div>
            );
          })}
        </Card>
        <Card
          title={t('doctorToday.newRecs')}
          testId="new-recordings"
          action={recs.length ? <Badge tone="info">{recs.length}</Badge> : undefined}
        >
          {recs.length === 0 && <p className="text-[14px] text-muted">{t('overview.empty')}</p>}
          {recs.slice(0, 5).map((r) => (
            <button
              key={r.id ?? r.at}
              type="button"
              onClick={() => r.ncid && onPatient(r.ncid)}
              className="flex items-center gap-3 border-t border-line py-2.5 text-left"
            >
              <span className="flex h-[42px] w-16 shrink-0 items-center justify-center rounded-xl bg-[linear-gradient(135deg,#1d1b2e,#3b3760)] text-[12px] text-white">
                ▶
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <b className="truncate text-[13px]">{r.ncid ? nameOf(r.ncid) : ''}</b>
                <span className="text-[12px] text-muted">
                  {t(`overview.place.${r.place}`)} · {r.at ? fmtShort(r.at) : ''}
                </span>
              </span>
              <Badge tone={r.flagged ? 'warn' : 'ok'}>
                {t(r.flagged ? 'verdict.OVERRIDE' : 'patient.passed')}
              </Badge>
            </button>
          ))}
          {recs.length > 0 && (
            <Button
              variant="ghost"
              className="min-h-8 self-start px-0"
              onClick={() => onOpen('myPatients')}
            >
              {t('doctorToday.allRecs')}
            </Button>
          )}
        </Card>
      </div>
    </Page>
  );
}

const fmtShort = (iso: string) =>
  new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
