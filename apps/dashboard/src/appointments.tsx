/**
 * Reception: appointments that need a recording, added by hand (user, 16 Nov 2026: nothing is read
 * from the hospital's appointment system, which also holds ortho, cardio and other visits). The
 * platform keeps a time, a patient NCID and a doctor only. The doctor then chooses the tests and
 * where to record: at home (record link) and/or in the clinic (clinic phones' queue). Names and
 * MRNs come live from the connector and are never stored here.
 */
import { Fragment, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { call, hospital } from './api.ts';
import {
  Badge,
  Button,
  Card,
  Dialog,
  DialogFooter,
  ErrorNote,
  Field,
  Notice,
  NowLine,
  Page,
  Segmented,
  Table,
  fmt,
  fmtDate,
} from './ui.tsx';
import { CalendarView, weekOf } from './calendar.tsx';
import { addDays, fmtDay, fmtTime, useSettings, weekday, zonedDay, zonedTime } from './changes.tsx';
import { InviteBox } from './invites.tsx';
import { describe, roleText } from './activity.tsx';
import { usePerms } from './perms.ts';
import { CancelDialog, MovePanel, NoShowDialog, RequestsTab, type Inbox } from './desk.tsx';
import { appointmentChanges } from './config.ts';

export type Stage =
  'needs_doctor' | 'needs_tests' | 'sent' | 'recorded' | 'missed' | 'not_recorded' | 'cancelled';

export interface RequestOut {
  id: string;
  kind: 'appointment' | 'rerecord';
  place: 'home' | 'clinic';
  not_done_reason: string | null;
  tests: string[];
  med_state: string;
  due_at: string;
  state: 'open' | 'recorded' | 'missed' | 'cancelled' | 'not_recorded';
  created_at: string;
}
export interface Appointment {
  id: string;
  ncid: string;
  at: string;
  doctor_id: string | null;
  doctor_name: string | null;
  source: 'manual' | 'fhir' | 'app';
  status: 'booked' | 'cancelled';
  stage: Stage;
  requests: RequestOut[];
  /** Who added it by hand (null: from the hospital system). */
  booked_by_name: string | null;
  last_event: HistoryEvent | null;
  /** v13: the last move and an open patient change request. */
  moved_at?: string | null;
  moved_from?: string | null;
  moved_from_doctor_name?: string | null;
  moved_reason?: string | null;
  change_request_id?: string | null;
  /** v14: cancelled by staff | patient (reason code); an offer with the patient; earlier tests. */
  cancelled_by?: string | null;
  cancel_reason?: string | null;
  offer_state?: 'open' | 'no_answer' | 'call_requested' | null;
  suggested_tests?: {
    tests: string[];
    med_state: string;
    places: string[];
    from_doctor_name: string | null;
  } | null;
}
export interface HistoryEvent {
  at: string;
  action: string;
  actor_name: string;
  actor_email: string | null;
  actor_role: string;
  details: Record<string, unknown>;
}
interface PatientRow {
  ncid: string;
  status: string;
  /** Decision 035: the patient said their phone failed the camera check (fps measured). */
  phone_unsuitable_fps: number | null;
}
export interface Doctor {
  id: string;
  display_name: string | null;
  email: string;
  active: boolean;
}
interface Ident {
  ncid: string;
  mrn: string;
  name: string | null;
}
export interface Found {
  mrn: string;
  name: string;
  ncid: string | null;
  /** invited | active | locked | closed | no_app; null if not linked yet (connector search). */
  app_status?: string | null;
}

const STAGE_TONE: Record<Stage, 'ok' | 'warn' | 'bad' | 'neutral'> = {
  needs_doctor: 'warn',
  needs_tests: 'neutral',
  sent: 'warn',
  recorded: 'ok',
  missed: 'bad',
  not_recorded: 'bad',
  cancelled: 'neutral',
};

export function StageBadge({ a }: { a: Appointment }) {
  const { t } = useTranslation();
  const live = a.requests.filter((r) => r.state !== 'cancelled');
  if (a.stage === 'cancelled' && a.cancel_reason === 'no_show')
    // v18 (decision 049): the desk marked that the patient did not come.
    return (
      <span data-testid="appt-stage">
        <Badge tone="bad">{t('noShow.badge')}</Badge>
      </span>
    );
  if (
    a.stage === 'needs_doctor' ||
    a.stage === 'needs_tests' ||
    a.stage === 'cancelled' ||
    !live.length
  )
    return (
      <span data-testid="appt-stage">
        <Badge tone={STAGE_TONE[a.stage]}>{t(`appts.stage.${a.stage}`)}</Badge>
      </span>
    );
  // One badge per place (home link, clinic queue): both may be asked for.
  return (
    <span className="flex flex-col items-start gap-1" data-testid="appt-stage">
      {live.map((r) => (
        <Badge
          key={r.id}
          tone={r.state === 'recorded' ? 'ok' : r.state === 'open' ? 'warn' : 'bad'}
        >
          {t(`appts.req.${r.place}.${r.state}`, {
            date: fmtDate(r.place === 'clinic' ? a.at : r.due_at),
            reason: r.not_done_reason
              ? t(`appts.notDone.${r.not_done_reason}`, { defaultValue: r.not_done_reason })
              : '',
          })}
        </Badge>
      ))}
    </span>
  );
}

/** Where the doctor asked to record: home link, clinic queue, or both. */
export function WhereBadges({ a }: { a: Appointment }) {
  const { t } = useTranslation();
  const places = [
    ...new Set(a.requests.filter((r) => r.state !== 'cancelled').map((r) => r.place)),
  ];
  if (!places.length) return <span className="text-muted">—</span>;
  return (
    <span className="flex flex-col items-start gap-1" data-testid="appt-where">
      {places.map((p) => (
        <Badge key={p} tone="neutral">
          {t(`appts.where.${p}`)}
        </Badge>
      ))}
    </span>
  );
}

type Range = '7' | '30' | '60' | 'past30';
const RANGES: Range[] = ['7', '30', '60', 'past30'];
const RANGE_QUERY: Record<Range, string> = {
  '7': 'days=7',
  '30': 'days=30',
  '60': 'days=60',
  past30: 'past_days=30',
};
const RANGE_KEY = 'nc.appointments.range';
/** v28: list, day (doctors side by side) or week (remembered on this computer). */
type View = 'list' | 'day' | 'week';
const VIEWS: View[] = ['list', 'day', 'week'];
const VIEW_KEY = 'nc.appointments.view';
function savedView(): View {
  try {
    const v = localStorage.getItem(VIEW_KEY) as View | null;
    return v && VIEWS.includes(v) ? v : 'list';
  } catch {
    return 'list';
  }
}
function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}
/** v28: where the "Now" line goes in a list sorted by time (null: all past or all to come). */
export function nowIndex(times: string[], now: number): number | null {
  const i = times.findIndex((at) => Date.parse(at) > now);
  return i > 0 ? i : null;
}
function savedRange(): Range {
  try {
    const v = localStorage.getItem(RANGE_KEY) as Range | null;
    return v && RANGES.includes(v) ? v : '7';
  } catch {
    return '7';
  }
}

/** v13: "Change asked" and "Moved · was …" (for a few days) next to the time. */
function MoveBadges({ a, now }: { a: Appointment; now: number }) {
  const { t } = useTranslation();
  const recent =
    a.moved_at &&
    a.moved_from &&
    now - Date.parse(a.moved_at) < appointmentChanges.movedShownDays * 86_400_000;
  if (
    !a.change_request_id &&
    !recent &&
    !a.offer_state &&
    (!a.cancelled_by || a.cancel_reason === 'no_show')
  )
    return null;
  return (
    <span className="mt-1 flex flex-col items-start gap-1" data-testid="appt-move-badges">
      {a.change_request_id && <Badge tone="warn">{t('moves.changeAsked')}</Badge>}
      {a.offer_state && (
        <Badge tone={a.offer_state === 'open' ? 'neutral' : 'bad'}>
          {t(`offers.state.${a.offer_state}`)}
        </Badge>
      )}
      {a.status === 'cancelled' && a.cancelled_by && a.cancel_reason !== 'no_show' && (
        <Badge tone="neutral">
          {t(`cancel.by.${a.cancelled_by}`, {
            reason: t(
              a.cancelled_by === 'patient'
                ? `cancel.patientReason.${a.cancel_reason ?? 'other'}`
                : `cancel.reasons.${a.cancel_reason ?? 'other'}`,
            ),
          })}
        </Badge>
      )}
      {recent && <Badge tone="neutral">{t('moves.movedWas', { when: fmt(a.moved_from) })}</Badge>}
    </span>
  );
}

export function Appointments({
  onChangeCount,
  initialTab = 'list',
  onBook,
}: {
  onChangeCount?: (n: number) => void;
  /** v30: "+ Add" opens the Book appointment page. */
  onBook?: () => void;
  /** v30: the Requests page opens this view on its Requests tab. */
  initialTab?: 'list' | 'requests';
} = {}) {
  const { t } = useTranslation();
  // Decision 033: what this person may do here (set per hospital).
  const perms = usePerms();
  const canAdd = perms.has('appointments.add');
  const canAssign = perms.has('appointments.assign');
  const canInvite = perms.has('invites.send');
  const [appts, setAppts] = useState<Appointment[] | null>(null);
  const [app, setApp] = useState<Record<string, string>>({});
  const [unsuitable, setUnsuitable] = useState<Record<string, number>>({});
  const [docs, setDocs] = useState<Doctor[]>([]);
  const [ident, setIdent] = useState<Record<string, Ident>>({});
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  // v13: the appointments list, or patients' change requests; the appointment being moved.
  const tab = initialTab;
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [noShow, setNoShow] = useState<string | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const canMove = canAdd;
  // The time the list was loaded (what "upcoming" and "recently moved" are measured from).
  const [now, setNow] = useState(() => Date.now());
  // Decision 038: the date range (remembered on this computer).
  const [range, setRange] = useState<Range>(savedRange);
  const [view, setView] = useState<View>(savedView);
  const [calDoctor, setCalDoctor] = useState('');
  const calendar = view !== 'list';
  const settings = useSettings();
  const tz = settings?.time_zone ?? browserZone();
  // null: today in the hospital's zone.
  const [dayPick, setDay] = useState<string | null>(null);
  const day = dayPick ?? zonedDay(now, tz);
  const pickView = (v: View) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* not remembered */
    }
  };
  const pickRange = (r: Range) => {
    setRange(r);
    try {
      localStorage.setItem(RANGE_KEY, r);
    } catch {
      /* private window: not remembered */
    }
  };

  useEffect(() => {
    let off = false;
    void (async () => {
      try {
        const [list, doctors, patients, open] = await Promise.all([
          // v28: the calendar shows the last 30 and the next 60 days.
          calendar
            ? Promise.all([
                call<Appointment[]>('GET', '/hospital/appointments?past_days=30'),
                call<Appointment[]>('GET', '/hospital/appointments?days=60'),
              ]).then(([a, b]) =>
                [...new Map([...a, ...b].map((x) => [x.id, x])).values()].sort(
                  (x, y) => Date.parse(x.at) - Date.parse(y.at),
                ),
              )
            : call<Appointment[]>('GET', `/hospital/appointments?${RANGE_QUERY[range]}`),
          call<Doctor[]>('GET', '/hospital/doctors'),
          call<PatientRow[]>('GET', '/hospital/patients'),
          call<Inbox>('GET', '/hospital/inbox').catch(() => null),
        ]);
        setNow(Date.now());

        onChangeCount?.(open?.count ?? 0);
        const ncids = [...new Set(list.map((a) => a.ncid))];
        const ids = ncids.length
          ? await hospital<Ident[]>('POST', '/v1/patients/lookup', { ncids })
          : [];
        if (off) return;
        setAppts(list);
        setDocs(doctors.filter((d) => d.active));
        setApp(Object.fromEntries(patients.map((p) => [p.ncid, p.status])));
        setUnsuitable(
          Object.fromEntries(
            patients.flatMap((p) =>
              p.phone_unsuitable_fps !== null ? [[p.ncid, p.phone_unsuitable_fps]] : [],
            ),
          ),
        );
        setIdent(Object.fromEntries(ids.map((i) => [i.ncid, i])));
      } catch (e) {
        if (!off) setError(e);
      }
    })();
    return () => {
      off = true;
    };
  }, [version, range, calendar, onChangeCount]);

  const assign = async (a: Appointment) => {
    setError(null);
    try {
      await call('PUT', `/hospital/appointments/${a.id}`, { doctor_id: choice[a.id] });
      setNotice(t('appts.assigned'));
      reload();
    } catch (e) {
      setError(e);
    }
  };
  /** The patient reception is inviting (the three ways show below the table). */
  /** The appointment whose history is open. */
  const [open, setOpen] = useState<string | null>(null);
  const [inviting, setInviting] = useState<{ mrn: string; name: string } | null>(null);
  const invite = (mrn: string, name: string | null) => {
    setNotice(null);
    setInviting({ mrn, name: name ?? `MRN ${mrn}` });
  };
  const docName = (d: Doctor) => d.display_name ?? d.email;
  const nowAt = nowIndex(
    (appts ?? []).map((a) => a.at),
    now,
  );
  const joined = (ncid: string) => app[ncid] === 'active';

  if (tab === 'requests')
    return (
      <Page title={t('nav.requests')} sub={t('requests.pageSub')}>
        {notice && <Notice testId="notice">{notice}</Notice>}
        <RequestsTab
          canAssign={canAssign}
          appointments={appts ?? []}
          onChanged={(m) => {
            setNotice(m);
            reload();
          }}
        />
      </Page>
    );

  const week = weekOf(day);
  const pageTitle =
    view === 'week'
      ? `${fmtDay(week[0]!, false)} – ${fmtDay(week[6]!, false)}`
      : view === 'day'
        ? longDay(day)
        : t('appts.title');
  const shownAppts = (appts ?? []).filter(
    (a) => !calendar || !calDoctor || (a.doctor_id ?? '') === calDoctor,
  );
  return (
    <Page
      title={pageTitle}
      actions={
        onBook ? (
          <Button onClick={onBook} data-testid="appts-add">
            ＋ {t('cal.add')}
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-wrap items-center gap-3">
        {calendar ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              className="size-9 min-h-9 px-0"
              aria-label={t('cal.prev')}
              onClick={() => setDay(addDays(day, view === 'week' ? -7 : -1))}
              data-testid="cal-prev"
            >
              ‹
            </Button>
            <Button
              variant="secondary"
              className="min-h-9"
              onClick={() => setDay(null)}
              data-testid="cal-today"
            >
              {t('cal.today')}
            </Button>
            <Button
              variant="secondary"
              className="size-9 min-h-9 px-0"
              aria-label={t('cal.next')}
              onClick={() => setDay(addDays(day, view === 'week' ? 7 : 1))}
              data-testid="cal-next"
            >
              ›
            </Button>
            <select
              value={calDoctor}
              onChange={(e) => setCalDoctor(e.target.value)}
              aria-label={t('appts.doctor')}
              className="h-9 rounded-full border-0 bg-card px-3 text-[13px] font-semibold shadow-[inset_0_0_0_1px_var(--color-edge)]"
              data-testid="cal-doctor"
            >
              <option value="">{t('today.allDoctors')}</option>
              {docs.map((d) => (
                <option key={d.id} value={d.id}>
                  {docName(d)}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <span className="text-[13px] text-muted" data-testid="appts-window">
            {t(`appts.range.${range}`)}
            {appts ? ` · ${t('appts.count', { count: appts.length })}` : ''}
          </span>
        )}
        <span className="flex-1" />
        <Segmented
          options={VIEWS.map((v) => ({ value: v, label: t(`cal.view.${v}`) }))}
          value={view}
          onChange={pickView}
          label={t('cal.viewLabel')}
          testId={(v) => `view-${v}`}
        />
        {!calendar && (
          <Segmented
            options={RANGES.map((r) => ({ value: r, label: t(`appts.rangeButton.${r}`) }))}
            value={range}
            onChange={pickRange}
            label={t('appts.rangeLabel')}
            testId={(r) => `range-${r}`}
          />
        )}
      </div>
      <span className="-mt-2 text-[12px] text-muted">{t('app.notStored')}</span>
      <ErrorNote error={error} />
      {notice && <Notice testId="notice">{notice}</Notice>}
      {calendar && (
        <div
          className={`grid grid-cols-1 gap-4 ${view === 'day' ? 'xl:grid-cols-[minmax(0,1fr)_300px]' : ''}`}
        >
          <Card testId="calendar">
            <CalendarView
              mode={view === 'week' ? 'week' : 'day'}
              appts={shownAppts}
              names={Object.fromEntries(
                Object.values(ident).flatMap((i) => (i.name ? [[i.ncid, i.name]] : [])),
              )}
              tz={tz}
              day={day}
              now={now}
              onOpen={setOpen}
            />
          </Card>
          {view === 'day' && (
            <div className="flex flex-col gap-4">
              <Card title={fmtMonth(day)} testId="cal-month">
                <MiniMonth
                  day={day}
                  today={zonedDay(now, tz)}
                  marked={new Set((appts ?? []).map((a) => zonedDay(a.at, tz)))}
                  onPick={setDay}
                />
              </Card>
              <FreeToday day={day} onBook={onBook && (() => onBook())} />
            </div>
          )}
        </div>
      )}
      {!calendar && (
        <Table
          head={[
            t('appts.when'),
            t('appts.patient'),
            t('appts.app'),
            t('appts.doctor'),
            t('appts.whereTitle'),
            t('appts.status'),
            t('appts.lastChange'),
            '',
          ]}
          testId="appointments"
        >
          {(appts ?? []).map((a, n) => {
            const i = ident[a.ncid];
            return (
              <Fragment key={a.id}>
                {range !== 'past30' && n === nowAt && (
                  <tr>
                    <td colSpan={8} className="px-4">
                      <NowLine
                        label={t('shell.now', {
                          time: zonedTime(new Date(now).toISOString(), tz),
                        })}
                      />
                    </td>
                  </tr>
                )}
                <tr className="border-t border-line" data-testid={`appt-${i?.mrn ?? a.ncid}`}>
                  <td className="px-4 py-3 font-semibold">
                    {fmt(a.at)}
                    <span className="block text-[12px] font-normal text-muted">
                      {a.source === 'manual' && a.booked_by_name
                        ? t('appts.addedBy', { name: a.booked_by_name })
                        : t(`appts.source.${a.source}`)}
                    </span>
                    <MoveBadges a={a} now={now} />
                  </td>
                  <td className="px-4 py-3">
                    {i?.name ?? <code className="text-[12px] text-muted">{a.ncid}</code>}
                    {i && <span className="block text-[12px] text-muted">MRN {i.mrn}</span>}
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={joined(a.ncid) ? 'ok' : 'neutral'}>
                      {t(joined(a.ncid) ? 'appts.joined' : 'appts.notJoined')}
                    </Badge>
                    {!joined(a.ncid) && unsuitable[a.ncid] !== undefined && (
                      <span className="mt-1 block" data-testid="appt-phone-unsuitable">
                        <Badge tone="warn">
                          {t('appts.phoneUnsuitable', { fps: unsuitable[a.ncid]!.toFixed(0) })}
                        </Badge>
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {canAssign && (a.stage === 'needs_doctor' || a.stage === 'needs_tests') ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <select
                          aria-label={t('appts.doctor')}
                          value={choice[a.id] ?? a.doctor_id ?? ''}
                          onChange={(e) => setChoice((c) => ({ ...c, [a.id]: e.target.value }))}
                          className="h-11 rounded-2xl border border-edge bg-card px-2"
                          data-testid="appt-doctor"
                        >
                          <option value="">{t('assign.choose')}</option>
                          {docs.map((d) => (
                            <option key={d.id} value={d.id}>
                              {docName(d)}
                            </option>
                          ))}
                        </select>
                        {choice[a.id] && choice[a.id] !== a.doctor_id && (
                          <Button onClick={() => void assign(a)} data-testid="appt-assign">
                            {t(a.doctor_id ? 'appts.changeDoctor' : 'appts.assign')}
                          </Button>
                        )}
                      </div>
                    ) : (
                      a.doctor_name
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <WhereBadges a={a} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col items-start gap-1.5">
                      <StageBadge a={a} />
                      {canInvite && !joined(a.ncid) && i && a.stage !== 'cancelled' && (
                        <Button
                          variant="secondary"
                          onClick={() => invite(i.mrn, i.name)}
                          data-testid="appt-invite"
                        >
                          {t('appts.sendInvite')}
                        </Button>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-[13px]" data-testid="appt-last">
                    {a.last_event && (
                      <>
                        {describe(t, a.last_event.action, a.last_event.details)}
                        <span className="block text-muted">
                          {a.last_event.actor_name} · {fmt(a.last_event.at)}
                        </span>
                      </>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col items-stretch gap-1.5">
                      {canMove && a.status === 'booked' && Date.parse(a.at) > now && (
                        <Button
                          variant="secondary"
                          className="min-h-9 text-[13px]"
                          aria-expanded={moving === a.id}
                          onClick={() => {
                            setMoving(moving === a.id ? null : a.id);
                            setNotice(null);
                          }}
                          data-testid="appt-move"
                        >
                          {t('moves.open')}
                        </Button>
                      )}
                      {canMove && a.status === 'booked' && (
                        <Button
                          variant="secondary"
                          className="min-h-9 text-[13px]"
                          aria-expanded={cancelling === a.id}
                          onClick={() => {
                            setCancelling(cancelling === a.id ? null : a.id);
                            setNotice(null);
                          }}
                          data-testid="appt-cancel"
                        >
                          {t('cancel.open')}
                        </Button>
                      )}
                      {canMove && a.status === 'booked' && Date.parse(a.at) <= now && (
                        <Button
                          variant="secondary"
                          className="min-h-9 text-[13px]"
                          aria-expanded={noShow === a.id}
                          onClick={() => {
                            setNoShow(noShow === a.id ? null : a.id);
                            setNotice(null);
                          }}
                          data-testid="appt-no-show"
                        >
                          {t('noShow.open')}
                        </Button>
                      )}
                      <Button
                        variant="secondary"
                        className="min-h-9 text-[13px]"
                        aria-expanded={open === a.id}
                        onClick={() => setOpen(open === a.id ? null : a.id)}
                        data-testid="appt-history-btn"
                      >
                        {t('appts.history')}
                      </Button>
                    </div>
                  </td>
                </tr>
              </Fragment>
            );
          })}
        </Table>
      )}
      {(appts ?? [])
        .filter((a) => a.id === moving || a.id === cancelling || a.id === noShow || a.id === open)
        .map((a) => {
          const name = ident[a.ncid]?.name ?? a.ncid;
          const done = (m: string) => {
            setMoving(null);
            setCancelling(null);
            setNoShow(null);
            setOpen(null);
            setNotice(m);
            reload();
          };
          if (a.id === moving)
            return (
              <MovePanel
                key={`m${a.id}`}
                appt={a}
                patient={name}
                canAssign={canAssign}
                canOffer={joined(a.ncid)}
                onClose={() => setMoving(null)}
                onDone={done}
              />
            );
          if (a.id === noShow)
            return (
              <NoShowDialog
                key={`n${a.id}`}
                appt={a}
                patient={name}
                onClose={() => setNoShow(null)}
                onDone={done}
              />
            );
          if (a.id === cancelling)
            return (
              <CancelDialog
                key={`c${a.id}`}
                appt={a}
                patient={name}
                onClose={() => setCancelling(null)}
                onDone={done}
              />
            );
          return (
            <Dialog
              key={`h${a.id}`}
              title={t('appts.historyTitle', { name })}
              sub={`${fmt(a.at)} · ${a.doctor_name ?? '—'}${
                ident[a.ncid] ? ` · MRN ${ident[a.ncid]!.mrn}` : ''
              }`}
              onClose={() => setOpen(null)}
              testId="history-dialog"
            >
              <AppointmentHistory id={a.id} />
              {canMove && a.status === 'booked' && Date.parse(a.at) > now && (
                <DialogFooter>
                  <span className="flex-1" />
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setOpen(null);
                      setMoving(a.id);
                    }}
                    data-testid="history-move"
                  >
                    {t('moves.open')}
                  </Button>
                  <Button onClick={() => setOpen(null)}>{t('moves.close')}</Button>
                </DialogFooter>
              )}
            </Dialog>
          );
        })}
      {appts?.length === 0 && (
        <Notice tone="warn" testId="no-appointments">
          {t('appts.none')}
        </Notice>
      )}
      {inviting && (
        <InviteBox
          key={inviting.mrn}
          mrns={[inviting.mrn]}
          title={t('appts.inviteFor', { name: inviting.name })}
          onSent={() => reload()}
        />
      )}
    </Page>
  );
}

/** v30: "Book appointment" is its own page for the desk (and anyone allowed to add). */
export function BookAppointment({ initial }: { initial?: Found }) {
  const { t } = useTranslation();
  const perms = usePerms();
  const [docs, setDocs] = useState<Doctor[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const settings = useSettings();
  const tz = settings?.time_zone ?? browserZone();
  const [now] = useState(() => Date.now());
  const [day, setDay] = useState(() => zonedDay(now, tz));
  const [at, setAt] = useState('');
  const [doctor, setDoctor] = useState('');
  const canAssign = perms.has('appointments.assign');
  useEffect(() => {
    call<Doctor[]>('GET', '/hospital/doctors').then(
      (d) => setDocs(d.filter((x) => x.active)),
      setError,
    );
  }, []);
  return (
    <Page title={t('book.title')} sub={t('book.sub')}>
      <ErrorNote error={error} />
      {notice && <Notice testId="notice">{notice}</Notice>}
      {/* v30: the month and that day's free times beside the form; a free time fills it in. */}
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
        <ManualAppointment
          docs={docs}
          canAssign={canAssign}
          initial={initial}
          at={at}
          setAt={setAt}
          doctor={doctor}
          setDoctor={setDoctor}
          onAdded={() => setNotice(t('appts.added'))}
        />
        <div className="flex flex-col gap-4">
          <Card title={fmtMonth(day)} testId="book-month">
            <MiniMonth day={day} today={zonedDay(now, tz)} marked={new Set()} onPick={setDay} />
          </Card>
          <FreeToday
            day={day}
            onBook={(slot) => {
              setAt(`${day}T${slot.time}`);
              if (canAssign) setDoctor(slot.doctorId);
            }}
          />
        </div>
      </div>
    </Page>
  );
}

function ManualAppointment({
  docs,
  canAssign,
  onAdded,
  initial,
  at,
  setAt,
  doctor,
  setDoctor,
}: {
  docs: Doctor[];
  canAssign: boolean;
  onAdded: () => void;
  /** v30: the patient chosen in the ⌘K search. */
  initial?: Found;
  /** Held by the page, so a free time beside the form can fill them in. */
  at: string;
  setAt: (v: string) => void;
  doctor: string;
  setDoctor: (v: string) => void;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState(initial?.name ?? '');
  const [found, setFound] = useState<Found[]>(initial ? [initial] : []);
  const [who, setWho] = useState<Found | null>(initial ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const search = async () => {
    setError(null);
    try {
      setFound(await hospital<Found[]>('GET', `/v1/patients?q=${encodeURIComponent(q.trim())}`));
    } catch (e) {
      setError(e);
    }
  };
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const { ncid } = await hospital<{ ncid: string }>('POST', '/v1/ncid', { mrn: who!.mrn });
      await call('POST', '/hospital/appointments', {
        ncid,
        at: new Date(at).toISOString(),
        doctor_id: doctor || null,
        source: 'manual',
      });
      setWho(null);
      setFound([]);
      setQ('');
      setAt('');
      setDoctor('');
      onAdded();
    } catch (e) {
      setError(e);
    }
    setBusy(false);
  };
  return (
    <Card title={t('appts.manualTitle')} testId="manual">
      <span className="text-[14px] text-sub">{t('appts.manualHint')}</span>
      <div className="flex flex-wrap items-end gap-3">
        <Field
          id="appt-q"
          label={t('appts.findPatient')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          data-testid="manual-q"
        />
        <Button
          variant="secondary"
          disabled={q.trim().length < 2}
          onClick={() => void search()}
          data-testid="manual-search"
        >
          {t('appts.search')}
        </Button>
      </div>
      {found.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {found.map((f) => (
            <li key={f.mrn}>
              <Button
                variant={who?.mrn === f.mrn ? 'primary' : 'secondary'}
                onClick={() => setWho(f)}
                data-testid={`manual-pick-${f.mrn}`}
              >
                {f.name} · MRN {f.mrn}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <Field
          id="appt-at"
          type="datetime-local"
          label={t('appts.dateTime')}
          value={at}
          onChange={(e) => setAt(e.target.value)}
          data-testid="manual-at"
        />
        {canAssign && (
          <label className="flex flex-col gap-1 text-[13px] font-semibold text-sub">
            {t('appts.doctor')}
            <select
              value={doctor}
              onChange={(e) => setDoctor(e.target.value)}
              className="h-11 rounded-2xl border border-edge bg-card px-2 font-normal"
              data-testid="manual-doctor"
            >
              <option value="">{t('assign.choose')}</option>
              {docs.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.display_name ?? d.email}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <p className="text-[13px] leading-[19px] text-muted">{t('appts.afterAssign')}</p>
      <ErrorNote error={error} />
      <Button
        className="self-start"
        disabled={busy || !who || !at}
        onClick={() => void add()}
        data-testid="manual-add"
      >
        {t('appts.addAndAssign')}
      </Button>
    </Card>
  );
}

/** Who did what for one appointment, oldest first (user, 16 Nov 2026). */
export function AppointmentHistory({ id }: { id: string }) {
  const { t } = useTranslation();
  const [events, setEvents] = useState<HistoryEvent[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    call<HistoryEvent[]>('GET', `/hospital/appointments/${id}/history`).then(setEvents, setError);
  }, [id]);
  return (
    <div className="flex flex-col gap-2">
      <ErrorNote error={error} />
      <ol
        aria-label={t('appts.historyLabel')}
        className="flex flex-col gap-2.5 rounded-xl border border-line bg-card px-4 py-3.5 text-[13px]"
        data-testid="appt-history"
      >
        {(events ?? []).map((e, n) => (
          <li key={n} className="grid grid-cols-[120px_1fr] gap-3">
            <span className="text-muted">{fmt(e.at)}</span>
            <span>
              <b>{describe(t, e.action, e.details)}</b> · {t('appts.by')} {e.actor_name}{' '}
              <span className="text-muted">
                ({[e.actor_email, roleText(t, e.actor_role)].filter(Boolean).join(' · ')})
              </span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function fmtMonth(day: string): string {
  const [y, m] = day.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1, 12)).toLocaleDateString('en-IN', {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  });
}

/** v30 (canvas v28): the month next to the Day view; days with appointments have a dot. */
export function MiniMonth({
  day,
  today,
  marked,
  onPick,
}: {
  day: string;
  today: string;
  marked: ReadonlySet<string>;
  onPick: (d: string) => void;
}) {
  const first = `${day.slice(0, 8)}01`;
  const start = addDays(first, -weekday(first));
  const cells = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  return (
    <div className="grid grid-cols-7 gap-1 text-center" role="grid">
      {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
        <span key={i} className="text-[11px] font-bold text-muted">
          {d}
        </span>
      ))}
      {cells.map((c) => {
        const inMonth = c.slice(0, 7) === day.slice(0, 7);
        const sel = c === day;
        return (
          <button
            key={c}
            type="button"
            onClick={() => onPick(c)}
            className={`relative flex h-8 items-center justify-center rounded-full text-[13px] ${sel ? 'nc-gradient font-extrabold text-white' : c === today ? 'font-bold text-brand-ink shadow-[inset_0_0_0_1.5px_var(--color-brand)]' : inMonth ? '' : 'text-muted opacity-50'}`}
            aria-pressed={sel}
            data-testid={`mini-${c}`}
          >
            {Number(c.slice(8))}
            {marked.has(c) && (
              <span
                className={`absolute bottom-1 left-1/2 size-1 -translate-x-1/2 rounded-full ${sel ? 'bg-white' : 'bg-[#10b981]'}`}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

/** v30 (canvas v28): free times on the chosen day (doctors' clinic hours minus bookings). */
function FreeToday({
  day,
  onBook,
}: {
  day: string;
  onBook?: (slot: { time: string; doctorId: string }) => void;
}) {
  const { t } = useTranslation();
  const [free, setFree] = useState<{ time: string; doctor: string; doctorId: string }[] | null>(
    null,
  );
  useEffect(() => {
    let off = false;
    call<{ doctors: { doctor_id: string; doctor_name: string; free: string[] }[] }>(
      'GET',
      `/hospital/availability?date=${day}`,
    ).then(
      (r) =>
        !off &&
        setFree(
          r.doctors
            .flatMap((d) =>
              d.free.map((time) => ({ time, doctor: d.doctor_name, doctorId: d.doctor_id })),
            )
            .sort((a, b) => a.time.localeCompare(b.time)),
        ),
      () => !off && setFree([]),
    );
    return () => {
      off = true;
    };
  }, [day]);
  return (
    <Card title={t('cal.freeTitle')} testId="cal-free">
      {free && free.length === 0 && <p className="text-[14px] text-muted">{t('cal.noFree')}</p>}
      {(free ?? []).slice(0, 8).map((f) => (
        <div
          key={`${f.time}-${f.doctor}`}
          className="flex items-center gap-3 border-t border-line py-2"
        >
          <b className="text-[14px] tabular-nums">{fmtTime(f.time)}</b>
          <span className="flex-1 text-[12px] text-muted">{f.doctor}</span>
          {onBook && (
            <Button
              variant="secondary"
              className="min-h-8 bg-brand-soft text-[13px] text-brand-ink shadow-none"
              onClick={() => onBook({ time: f.time, doctorId: f.doctorId })}
              data-testid={`free-${f.time}`}
            >
              {t('cal.book')}
            </Button>
          )}
        </div>
      ))}
    </Card>
  );
}

/** "Thursday 19 November" for the Day view's title. */
function longDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!, 12)).toLocaleDateString('en-IN', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}
