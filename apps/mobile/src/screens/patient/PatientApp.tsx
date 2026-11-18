/**
 * Patient app (v3): every hospital the patient joined, each with its record links (recording
 * requests from the doctor), the doctor's optional "every N days" plan and the history. Consent is
 * asked on its own screen just before the camera opens, for each session; no consent, no
 * recording. Withdrawing from a hospital keeps its history readable here (read only); only the
 * hospital can invite the patient back.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { UploadStatus } from '@neurocapture/capture-kit';
import { useApp } from '../../app/AppContext.tsx';
import { capture } from '../../lib/capture.ts';
import { errorCode, type HomePlan, type HomeSession } from '../../lib/accounts.ts';
import {
  cacheKey,
  hospitalApi,
  hospitalsOf,
  withdrawnFrom,
  type PatientHospital,
  type PatientRequest,
} from '../../lib/hospitals.ts';
import { logger } from '../../lib/logger.ts';
import { stepTitle } from '../session/TestIntro.tsx';
import { BackButton, Button, Card } from '../../ui/kit.tsx';
import { ErrorText } from '../modes/Common.tsx';
import { InviteFlow } from './InviteFlow.tsx';
import { canRecord } from '../../lib/clinic.ts';
import { saveBackup } from '../../lib/appaccount.ts';
import { AppointmentsSection, useAppointments } from './Appointments.tsx';
import { ClinicConsentCard } from './ClinicConsentCard.tsx';
import { Greeting, dayPart } from '../../ui/Greeting.tsx';

type View =
  | { kind: 'list' }
  | { kind: 'hospital'; profile: string; section?: Section }
  | { kind: 'consent'; profile: string; request: PatientRequest | null; from: 'list' | 'hospital' }
  | { kind: 'join'; token: string | null }
  | { kind: 'settings' };

function fmtDate(iso: string | null, lang: string): string {
  return iso
    ? new Date(iso).toLocaleDateString(lang === 'hi' ? 'hi-IN' : 'en-IN', {
        day: 'numeric',
        month: 'short',
      })
    : '';
}

export function PatientApp({
  onLock,
  onAddAccount,
  invite,
  onInviteUsed,
}: {
  onLock: () => void;
  /** v11: a pre-v11 install moves onto an app account (e-mail, same PIN, recovery code). */
  onAddAccount: () => void;
  /** An invite link opened while the app is set up: join that hospital. */
  invite: string | null;
  onInviteUsed: () => void;
}) {
  const { settings } = useApp();
  const [view, setView] = useState<View>({ kind: 'list' });
  const [lastInvite, setLastInvite] = useState<string | null>(null);
  if (invite && invite !== lastInvite) {
    // A new link from outside the app (adjusting state while rendering, React's documented way).
    setLastInvite(invite);
    setView({ kind: 'join', token: invite });
  }
  const hospitals = hospitalsOf(settings);
  const home = () => setView({ kind: 'list' });
  const byProfile = (p: string) => hospitals.find((h) => h.profile === p);

  if (view.kind === 'join')
    return (
      <InviteFlow
        initialToken={view.token}
        adding
        onDone={() => {
          onInviteUsed();
          home();
        }}
        onCancel={() => {
          onInviteUsed();
          home();
        }}
      />
    );
  if (view.kind === 'settings') return <SettingsView onBack={home} onAddAccount={onAddAccount} />;
  if (view.kind === 'hospital' && byProfile(view.profile))
    return (
      <HospitalView
        h={byProfile(view.profile)!}
        start={view.section}
        onBack={home}
        onRecord={(request) =>
          setView({ kind: 'consent', profile: view.profile, request, from: 'hospital' })
        }
      />
    );
  if (view.kind === 'consent' && byProfile(view.profile))
    return (
      <ConsentView
        h={byProfile(view.profile)!}
        request={view.request}
        onCancel={() =>
          view.from === 'list' ? home() : setView({ kind: 'hospital', profile: view.profile })
        }
      />
    );
  return (
    <HospitalList
      hospitals={hospitals}
      onOpen={(profile, section) => setView({ kind: 'hospital', profile, section })}
      onRecord={(profile, request) => setView({ kind: 'consent', profile, request, from: 'list' })}
      onJoin={() => setView({ kind: 'join', token: null })}
      onSettings={() => setView({ kind: 'settings' })}
      onLock={onLock}
    />
  );
}

interface HospitalData {
  requests: PatientRequest[];
  sessions: HomeSession[];
  plan: HomePlan | null;
  offline: boolean;
  error: string | null;
  /** Decision 044: the hospital's own video storage is connected (true when unknown/offline). */
  canRecord: boolean;
}

/** Live data for one hospital; what the phone last saw when offline or after withdrawing. */
function useHospitalData(h: PatientHospital, version = 0): HospitalData | null {
  const { repo } = useApp();
  const [data, setData] = useState<HospitalData | null>(null);
  useEffect(() => {
    let cancelled = false;
    const cached = async (): Promise<Omit<HospitalData, 'offline' | 'error' | 'canRecord'>> => ({
      requests: (await repo.store.get<PatientRequest[]>(cacheKey(h, 'requests'))) ?? [],
      sessions: (await repo.store.get<HomeSession[]>(cacheKey(h, 'sessions'))) ?? [],
      plan: await repo.store.get<HomePlan>(cacheKey(h, 'plan')),
    });
    void (async () => {
      if (h.withdrawnAt) {
        const c = await cached();
        if (!cancelled) setData({ ...c, offline: false, error: null, canRecord: true });
        return;
      }
      try {
        const [requests, sessions, plan] = await Promise.all([
          hospitalApi<PatientRequest[]>(capture.kit, h, 'GET', '/patient/requests'),
          hospitalApi<HomeSession[]>(capture.kit, h, 'GET', '/patient/sessions'),
          hospitalApi<HomePlan>(capture.kit, h, 'GET', '/patient/plan'),
        ]);
        await repo.store.put(cacheKey(h, 'requests'), requests);
        await repo.store.put(cacheKey(h, 'sessions'), sessions);
        await repo.store.put(cacheKey(h, 'plan'), plan);
        const ready = await canRecord(capture.kit, h.profile);
        if (!cancelled)
          setData({
            requests,
            sessions,
            plan,
            offline: false,
            error: null,
            canRecord: ready.canRecord,
          });
      } catch (e) {
        const code = errorCode(e);
        logger.warn('hospital data fetch failed', { code });
        const c = await cached();
        if (!cancelled)
          setData({
            ...c,
            offline: true,
            error: code === 'login_required' ? code : null,
            canRecord: true,
          });
      }
    })();
    return () => {
      cancelled = true;
    };
    // A hospital is identified by its profile; the object itself may be rebuilt on each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [h.profile, h.withdrawnAt, repo, version]);
  return data;
}

const openRequests = (d: HospitalData | null) =>
  (d?.requests ?? [])
    .filter((r) => r.state === 'open' && r.place !== 'clinic')
    .sort((a, b) => a.due_at.localeCompare(b.due_at));

/** Clinic requests: recorded by the hospital at the visit (information only). */
const clinicVisits = (d: HospitalData | null) =>
  (d?.requests ?? []).filter((r) => r.state === 'open' && r.place === 'clinic');

/** Everything the home screen shows for one hospital (fetched once, shared by its card and to-dos). */
interface HomeData {
  data: HospitalData | null;
  appts: ReturnType<typeof useAppointments>['data'];
}

/** Loads one hospital's data and reports it to the home screen. Renders nothing. */
function HospitalLoader({
  h,
  version,
  onData,
}: {
  h: PatientHospital;
  version: number;
  onData: (profile: string, d: HomeData) => void;
}) {
  const data = useHospitalData(h, version);
  const { data: appts, reload } = useAppointments(h);
  useEffect(() => {
    if (version) reload();
  }, [version, reload]);
  useEffect(() => onData(h.profile, { data, appts }), [h.profile, data, appts, onData]);
  return null;
}

interface Todo {
  key: string;
  kind: 'record' | 'plan' | 'offer' | 'consent';
  h: PatientHospital;
  tag: string;
  title: string;
  sub: string;
  action: string;
  disabled?: boolean;
  go: () => void;
}

/** New UI (decision 050): greeting, then every to-do across hospitals as swipe cards, then the
 * hospitals. Hospital screens show only their menu. */
function HospitalList({
  hospitals,
  onOpen,
  onRecord,
  onJoin,
  onSettings,
  onLock,
}: {
  hospitals: PatientHospital[];
  onOpen: (profile: string, section?: Section) => void;
  onRecord: (profile: string, request: PatientRequest | null) => void;
  onJoin: () => void;
  onSettings: () => void;
  onLock: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { settings, config } = useApp();
  const lang = i18n.language;
  const [uploads, setUploads] = useState<UploadStatus[]>([]);
  const [homes, setHomes] = useState<Record<string, HomeData>>({});
  const onData = useCallback(
    (profile: string, d: HomeData) => setHomes((m) => ({ ...m, [profile]: d })),
    [],
  );
  const [version, setVersion] = useState(0);
  useEffect(() => {
    void capture.kit.listUploads().then((r) => setUploads(r.uploads));
  }, []);
  // Back in the foreground: fetch again so the to-do cards are fresh.
  useEffect(() => {
    const on = () => {
      if (globalThis.document?.visibilityState === 'visible') setVersion((v) => v + 1);
    };
    globalThis.document?.addEventListener('visibilitychange', on);
    return () => globalThis.document?.removeEventListener('visibilitychange', on);
  }, []);
  const pending = uploads.filter((u) => u.state !== 'completed').length;
  const anyActive = hospitals.some((h) => !h.withdrawnAt);

  const todos: Todo[] = [];
  for (const h of hospitals) {
    if (h.withdrawnAt) continue;
    const { data, appts } = homes[h.profile] ?? { data: null, appts: null };
    const blocked = data?.canRecord === false;
    for (const r of openRequests(data))
      todos.push({
        key: r.id,
        kind: 'record',
        h,
        tag: t('todo.record', { hospital: h.hospital }),
        title: t('todo.recordTitle', { count: r.tests.length }),
        sub: t('todo.recordSub', {
          date: fmtDate(r.due_at, lang),
          minutes: testsMinutes(config, r.tests).minutes,
        }),
        action: t('todo.start'),
        disabled: blocked,
        go: () => onRecord(h.profile, r),
      });
    if (data?.plan?.due_now && !data.plan.default)
      todos.push({
        key: `${h.profile}-plan`,
        kind: 'plan',
        h,
        tag: t('todo.record', { hospital: h.hospital }),
        title: t('todo.plan'),
        sub: t('modes.home.minutes', { n: testsMinutes(config, data.plan.tests).minutes }),
        action: t('todo.start'),
        disabled: blocked,
        go: () => onRecord(h.profile, null),
      });
    for (const a of appts?.appointments ?? [])
      if (a.offer)
        todos.push({
          key: `${a.id}-offer`,
          kind: 'offer',
          h,
          tag: t('todo.offer', { hospital: h.hospital }),
          title: t('todo.offerTitle', { date: fmtDate(a.at, lang) }),
          sub: t('todo.offerSub', { by: fmtDateTime(a.offer.reply_by, lang) }),
          action: t('todo.choose'),
          go: () => onOpen(h.profile, 'appointments'),
        });
    for (const b of appts?.bookings ?? [])
      if (b.offer)
        todos.push({
          key: `${b.id}-offer`,
          kind: 'offer',
          h,
          tag: t('todo.offer', { hospital: h.hospital }),
          title: t('todo.offerBooking'),
          sub: t('todo.offerSub', { by: fmtDateTime(b.offer.reply_by, lang) }),
          action: t('todo.choose'),
          go: () => onOpen(h.profile, 'appointments'),
        });
    for (const r of clinicVisits(data))
      if (!['active', 'used'].includes(r.clinic_consent?.status ?? ''))
        todos.push({
          key: `${r.id}-consent`,
          kind: 'consent',
          h,
          tag: t('todo.consent', { hospital: h.hospital }),
          title: t('todo.consentTitle', { date: fmtDate(r.appointment_at ?? r.due_at, lang) }),
          sub: t('todo.consentSub'),
          action: t('todo.open'),
          go: () => onOpen(h.profile, 'appointments'),
        });
  }
  const loaded = hospitals.every((h) => h.withdrawnAt || homes[h.profile]?.data);
  const part = dayPart();

  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col gap-4 bg-ground px-5 pt-6 pb-6">
      {hospitals.map((h) => (
        <HospitalLoader key={h.profile} h={h} version={version} onData={onData} />
      ))}
      <Greeting
        name={settings.firstName}
        part={part}
        line={
          !anyActive || !loaded
            ? null
            : todos.length
              ? t('greeting.todo', { count: todos.length })
              : part === 'evening'
                ? t('greeting.eveningTip')
                : t('greeting.nothing')
        }
        right={
          anyActive && (
            <button
              type="button"
              onClick={onLock}
              className="min-h-9 rounded-full bg-white/70 px-3 text-[13px] font-semibold text-brand"
              data-testid="lock-now"
            >
              {t('modes.lock.lockNow')}
            </button>
          )
        }
      />
      {todos.length > 0 && (
        <section className="flex flex-col gap-2" data-testid="todos">
          <h2 className="m-0 text-[15px] font-bold">{t('greeting.upNext')}</h2>
          <div className="-mx-5 flex snap-x snap-mandatory gap-3 overflow-x-auto px-5 pb-1">
            {todos.map((x, i) => (
              <article
                key={x.key}
                className="nc-fade-up flex w-[78%] max-w-[300px] flex-none snap-start flex-col gap-1.5 rounded-2xl border border-line bg-white p-4"
                style={{ animationDelay: `${i * 0.08}s` }}
                data-testid="todo-card"
                data-kind={x.kind}
              >
                <span
                  className={`text-[11px] font-bold ${x.kind === 'consent' ? 'text-brand' : 'text-[#8A4B00]'}`}
                >
                  {x.tag.toUpperCase()}
                </span>
                <b className="text-[16px]">{x.title}</b>
                <span className="text-[13px] text-muted">{x.sub}</span>
                <Button
                  className="mt-1.5 !h-11"
                  disabled={x.disabled}
                  onClick={x.go}
                  data-testid={`todo-${x.kind}`}
                >
                  {x.action}
                </Button>
              </article>
            ))}
          </div>
          {todos.length > 1 && (
            <span className="text-[12px] text-muted">{t('greeting.swipe')} →</span>
          )}
        </section>
      )}
      {anyActive && loaded && todos.length === 0 && (
        <Card
          className="nc-fade-up flex items-center gap-3 !border-[#CDEBD8] !bg-[#F0FAF4]"
          data-testid="caught-up"
        >
          <span aria-hidden className="text-[26px]">
            🌿
          </span>
          <span className="flex flex-col">
            <b>{t('greeting.caughtUp')}</b>
            <span className="text-[13px] text-muted">{t('greeting.caughtUpBody')}</span>
          </span>
        </Card>
      )}
      <h2 className="m-0 text-[15px] font-bold">{t('modes.hospitals.title')}</h2>
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {hospitals.map((h, i) => (
          <HospitalCard
            key={h.profile}
            h={h}
            index={i}
            home={homes[h.profile]}
            onOpen={() => onOpen(h.profile)}
          />
        ))}
      </ul>
      <Card className="flex flex-col gap-1">
        <h2 className="text-[15px] font-bold">{t('modes.recordings.onPhone')}</h2>
        <span className="text-[14px]" data-testid="rec-pending">
          {pending > 0 ? t('modes.recordings.pending', { n: pending }) : t('uploads.allDone')}
        </span>
      </Card>
      <Button variant="secondary" onClick={onJoin} data-testid="join-hospital">
        {t('modes.hospitals.join')}
      </Button>
      <p className="text-[13px] leading-[19px] text-muted">{t('modes.hospitals.separate')}</p>
      <Button variant="secondary" onClick={onSettings} data-testid="home-settings">
        {t('modes.home.settings')}
      </Button>
    </div>
  );
}

function HospitalCard({
  h,
  index,
  home,
  onOpen,
}: {
  h: PatientHospital;
  index: number;
  home: HomeData | undefined;
  onOpen: () => void;
}) {
  const { t, i18n } = useTranslation();
  const data = home?.data ?? null;
  const open = openRequests(data);
  const next = open[0];
  const notReady = !h.withdrawnAt && data !== null && !data.canRecord;
  const badge = h.withdrawnAt
    ? t('modes.hospitals.withdrawn')
    : notReady
      ? t('modes.hospitals.gettingReady')
      : open.length > 0
        ? t('modes.hospitals.requests', { count: open.length })
        : t('modes.hospitals.joined');
  return (
    <li className="nc-fade-up" style={{ animationDelay: `${0.1 + index * 0.1}s` }}>
      <button
        type="button"
        onClick={onOpen}
        className={`flex w-full flex-col gap-1 rounded-2xl border px-4 py-3.5 text-left ${
          open.length > 0 ? 'border-2 border-brand bg-white' : 'border-line bg-white'
        }`}
        data-testid="hospital-card"
      >
        <span className="flex items-center justify-between gap-2">
          <span className="text-[17px] font-bold">{h.hospital}</span>
          <span
            className={`rounded-xl px-2.5 py-0.5 text-[12px] font-bold ${
              h.withdrawnAt
                ? 'bg-[#EDF0F3] text-[#3D4552]'
                : open.length > 0
                  ? 'bg-[#FDF0DD] text-[#8A4B00]'
                  : 'bg-[#E3F4EA] text-[#145F38]'
            }`}
            data-testid="hospital-badge"
          >
            {badge}
          </span>
        </span>
        <span className="text-[14px] text-[#3D4552]">
          {notReady
            ? t('modes.hospitals.notReadyBody', { hospital: h.hospital })
            : next
              ? next.appointment_at
                ? t('modes.hospitals.recordBefore', {
                    visit: fmtDate(next.appointment_at, i18n.language),
                    due: fmtDate(next.due_at, i18n.language),
                  })
                : t('modes.hospitals.recordBy', { due: fmtDate(next.due_at, i18n.language) })
              : h.withdrawnAt
                ? t('modes.hospitals.readOnly')
                : data?.plan?.due_now
                  ? t('modes.home.due')
                  : t('modes.hospitals.noRequests')}
        </span>
      </button>
    </li>
  );
}

function testsMinutes(config: ReturnType<typeof useApp>['config'], tests: string[]) {
  const steps = config.session.order.filter(([code]) => tests.includes(code));
  const totalS = steps.reduce((s, [code]) => s + (config.tests.get(code)?.task.durationS ?? 0), 0);
  return { steps, minutes: Math.max(1, Math.round(totalS / 60 + steps.length * 1.5)) };
}

type Section = 'menu' | 'appointments' | 'book' | 'history' | 'recordings' | 'details';
const ROW_ORDER: Section[] = ['appointments', 'book', 'history', 'recordings', 'details'];

/**
 * v17: one hospital as a menu (what needs doing now, then Your appointments, Book an appointment,
 * Appointment history, Recordings and Hospital details) instead of one long page.
 */
function HospitalView({
  h,
  start = 'menu',
  onBack,
  onRecord,
}: {
  h: PatientHospital;
  /** Opened from a to-do card on the home screen: straight to that section. */
  start?: Section;
  onBack: () => void;
  onRecord: (request: PatientRequest | null) => void;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const [version, setVersion] = useState(0);
  const data = useHospitalData(h, version);
  const { data: appts, reload: reloadAppts } = useAppointments(h);
  const [section, setSection] = useState<Section>(start);
  const open = openRequests(data);
  const plan = data?.plan;
  const clinic = clinicVisits(data);
  const live = !h.withdrawnAt;

  const offers = live
    ? [
        ...(appts?.appointments ?? []).filter((a) => a.offer),
        ...(appts?.bookings ?? []).filter((b) => b.offer),
      ].length
    : 0;
  const noConsent = live
    ? clinic.filter((r) => !['active', 'used'].includes(r.clinic_consent?.status ?? ''))
    : [];
  const toRecord = live ? open.length + (plan?.due_now ? 1 : 0) : 0;
  const upcoming = (appts?.appointments ?? []).filter((a) => a.status === 'booked');

  const header = (title: string, back: () => void, testId?: string) => (
    <header className="flex items-center gap-1">
      <BackButton onClick={back} label={t('common.back')} />
      <h1 className="text-[20px] font-bold" data-testid={testId}>
        {title}
      </h1>
    </header>
  );
  // Back to the menu: fetch the appointments again (a section may have changed them).
  const toMenu = () => {
    reloadAppts();
    setVersion((v) => v + 1);
    setSection('menu');
  };
  const wrap = (children: ReactNode) => (
    <div className="mx-auto flex min-h-full max-w-md flex-col gap-4 bg-ground px-5 pt-4 pb-6">
      {children}
    </div>
  );
  const notes = (
    <>
      {data?.offline && (
        <p className="rounded-xl bg-[#FDF0DD] px-3 py-2 text-[13px] text-[#8A4B00]">
          {t('modes.home.offline')}
        </p>
      )}
      <ErrorText code={data?.error ?? null} />
    </>
  );

  if (section === 'appointments')
    return wrap(
      <>
        {header(t('modes.hospitals.menu.appointments'), toMenu, 'section-title')}
        {notes}
        {live &&
          clinic
            .filter((r) => !upcoming.some((a) => sameTime(a.at, r.appointment_at)))
            .map((r) => <ClinicVisit key={r.id} h={h} r={r} />)}
        {live && (
          <AppointmentsSection
            h={h}
            extra={(a) =>
              clinic
                .filter((r) => sameTime(a.at, r.appointment_at))
                .map((r) => (
                  <div
                    key={r.id}
                    className="flex flex-col gap-1 border-t border-[#EDF0F3] pt-2"
                    data-testid="request-clinic"
                  >
                    <span className="text-[12px] font-bold text-[#0B5FAA]">
                      {t('modes.hospitals.menu.clinicAtVisit').toUpperCase()}
                    </span>
                    <ClinicConsentCard h={h} request={r} />
                  </div>
                ))
            }
          />
        )}
      </>,
    );
  if (section === 'book')
    return wrap(
      <>
        {header(t('modes.hospitals.menu.book'), toMenu, 'section-title')}
        <AppointmentsSection
          h={h}
          start="book"
          onLeaveBook={(sent) => (sent ? setSection('appointments') : toMenu())}
        />
      </>,
    );
  if (section === 'history')
    return wrap(
      <>
        {header(t('modes.hospitals.menu.history'), toMenu, 'section-title')}
        <AppointmentHistory h={h} />
      </>,
    );
  if (section === 'recordings')
    return wrap(
      <>
        {header(t('modes.hospitals.menu.recordings'), toMenu, 'section-title')}
        {notes}
        <RecordingsSection h={h} data={data} onRecord={onRecord} />
      </>,
    );
  if (section === 'details')
    return wrap(
      <>
        {header(t('modes.hospitals.menu.details'), toMenu, 'section-title')}
        <HospitalDetails h={h} />
      </>,
    );

  // The menu.
  const nextAppt = upcoming[0];
  const row = (id: Section, icon: string, title: string, sub: string, badge = 0, muted = false) => (
    <button
      key={id}
      type="button"
      onClick={() => setSection(id)}
      className="nc-fade-up flex min-h-16 w-full items-center gap-3 rounded-2xl border border-line bg-white px-4 py-3 text-left"
      style={{ animationDelay: `${ROW_ORDER.indexOf(id) * 0.08}s` }}
      data-testid={`menu-${id}`}
    >
      <span
        aria-hidden
        className={`flex size-10 flex-none items-center justify-center rounded-xl text-[18px] ${muted ? 'bg-[#EDF0F3]' : 'bg-[#E6EFF8]'}`}
      >
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <b className={`text-[15px] ${muted ? 'text-muted' : ''}`}>{title}</b>
        <span className="text-[13px] text-muted">{sub}</span>
      </span>
      {badge > 0 && (
        <span
          className="nc-pulse flex h-[22px] min-w-[22px] items-center justify-center rounded-full bg-bad px-1.5 text-[12px] font-bold text-white"
          data-testid={`menu-${id}-count`}
        >
          {badge}
        </span>
      )}
      <span aria-hidden className="text-[20px] text-muted">
        ›
      </span>
    </button>
  );

  return wrap(
    <>
      {header(h.hospital, onBack, 'hospital-name')}
      {h.withdrawnAt && (
        <section
          className="flex flex-col gap-2 rounded-2xl border border-[#C9CFD8] bg-[#EDF0F3] p-4"
          data-testid="hospital-withdrawn"
        >
          <span className="self-start rounded-xl bg-white px-2.5 py-0.5 text-[12px] font-bold text-[#3D4552]">
            {t('modes.hospitals.withdrawnOn', {
              date: fmtDate(h.withdrawnAt, lang),
            }).toUpperCase()}
          </span>
          <span className="text-[15px] leading-[22px]">
            {t('modes.hospitals.withdrawnBody', { hospital: h.hospital })}
          </span>
          <span className="text-[14px] leading-5 text-[#3D4552]">
            {t('modes.hospitals.withdrawnBack', { hospital: h.hospital })}
          </span>
        </section>
      )}
      {notes}
      {live && data?.canRecord === false && (
        <p
          className="rounded-xl bg-[#FDF0DD] px-3 py-2 text-[14px] text-[#8A4B00]"
          data-testid="hospital-not-ready"
        >
          {t('modes.hospitals.notReadyBody', { hospital: h.hospital })}
        </p>
      )}
      <nav className="flex flex-col gap-2.5" aria-label={h.hospital}>
        {live &&
          row(
            'appointments',
            '📅',
            t('modes.hospitals.menu.appointments'),
            nextAppt
              ? t('modes.hospitals.menu.next', {
                  date: fmtDateTime(nextAppt.at, lang),
                  doctor: nextAppt.doctor_name ?? '',
                })
              : t('modes.hospitals.menu.noneBooked'),
            offers + noConsent.length,
          )}
        {live &&
          appts?.booking.enabled &&
          row('book', '＋', t('modes.hospitals.menu.book'), t('modes.hospitals.menu.bookSub'))}
        {row(
          'history',
          '🗂',
          t('modes.hospitals.menu.history'),
          t('modes.hospitals.menu.historySub'),
        )}
        {row(
          'recordings',
          '🎥',
          t('modes.hospitals.menu.recordings'),
          t('modes.hospitals.menu.recordingsSub', {
            todo: toRecord,
            sent: data?.sessions.length ?? 0,
          }),
          toRecord,
        )}
        {row(
          'details',
          'ⓘ',
          t('modes.hospitals.menu.details'),
          live ? t('modes.hospitals.menu.detailsSub') : t('modes.hospitals.menu.detailsSubOff'),
          0,
          true,
        )}
      </nav>
    </>,
  );
}

const sameTime = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && Date.parse(a) === Date.parse(b);

function fmtDateTime(iso: string, lang: string): string {
  return new Date(iso).toLocaleString(lang === 'hi' ? 'hi-IN' : 'en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** A clinic recording not tied to a listed appointment: the visit and its consent. */
function ClinicVisit({ h, r }: { h: PatientHospital; r: PatientRequest }) {
  const { t, i18n } = useTranslation();
  return (
    <Card className="flex flex-col gap-1" data-testid="request-clinic">
      <span className="text-[12px] font-bold text-[#0B5FAA]">
        {t('modes.hospitals.clinicTitle').toUpperCase()}
      </span>
      <span className="text-[15px] leading-[22px]">
        {t('modes.hospitals.clinicBody', {
          date: fmtDate(r.appointment_at ?? r.due_at, i18n.language),
          doctor: r.doctor_name ?? t('modes.hospitals.yourDoctor'),
        })}
      </span>
      <ClinicConsentCard h={h} request={r} />
    </Card>
  );
}

/** v17: what to record for this hospital, then what was sent and earlier requests. */
function RecordingsSection({
  h,
  data,
  onRecord,
}: {
  h: PatientHospital;
  data: HospitalData | null;
  onRecord: (request: PatientRequest | null) => void;
}) {
  const { t, i18n } = useTranslation();
  const { config } = useApp();
  const open = openRequests(data);
  const plan = data?.plan;
  const past = (data?.requests ?? []).filter((r) => r.state !== 'open');
  const live = !h.withdrawnAt;
  return (
    <>
      {live && (
        <span className="text-[12px] font-bold text-muted">
          {t('modes.hospitals.menu.toRecord').toUpperCase()}
        </span>
      )}
      {live &&
        open.map((r) => {
          const { steps, minutes } = testsMinutes(config, r.tests);
          return (
            <Card key={r.id} className="flex flex-col gap-2" data-testid="request-card">
              <span className="text-[12px] font-bold text-[#8A4B00]">
                {t('modes.hospitals.requestDue', {
                  date: fmtDate(r.due_at, i18n.language),
                }).toUpperCase()}
              </span>
              <span className="text-[16px] font-bold">
                {r.appointment_at
                  ? t('modes.hospitals.beforeVisit', {
                      date: fmtDate(r.appointment_at, i18n.language),
                    })
                  : t('modes.hospitals.again')}
              </span>
              <span className="text-[14px] text-[#3D4552]">
                {t('modes.hospitals.asks', {
                  doctor: r.doctor_name ?? t('modes.hospitals.yourDoctor'),
                  count: steps.length,
                  minutes,
                })}
              </span>
              <ul className="flex flex-wrap gap-1.5 text-[13px]">
                {steps.map(([code, side]) => (
                  <li key={`${code}${side ?? ''}`} className="rounded-lg bg-[#EDF0F3] px-2 py-0.5">
                    {stepTitle(t, code, side)}
                  </li>
                ))}
              </ul>
              <p className="text-[14px] leading-5">{t(`modes.home.med${r.med_state}`)}</p>
              <Button
                disabled={data?.canRecord === false}
                onClick={() => onRecord(r)}
                data-testid="request-start"
              >
                {t('modes.home.start')}
              </Button>
            </Card>
          );
        })}
      {live && plan && !plan.default && plan.next_due && (
        <Card className="flex flex-col gap-2" data-testid="home-plan">
          <div className="flex items-center justify-between">
            <h2 className="text-[16px] font-bold">{t('modes.home.plan')}</h2>
            {plan.due_now ? (
              <span
                className="rounded-xl bg-[#E3F4EA] px-2.5 py-0.5 text-[13px] font-semibold text-[#145F38]"
                data-testid="home-due"
              >
                {t('modes.home.due')}
              </span>
            ) : (
              <span className="text-[13px] text-muted" data-testid="home-next">
                {t('modes.home.next', { date: fmtDate(plan.next_due, i18n.language) })}
              </span>
            )}
          </div>
          <span className="text-[13px] text-muted">
            {t('modes.home.every', { count: plan.every_days })} ·{' '}
            {t('modes.home.minutes', { n: testsMinutes(config, plan.tests).minutes })}
            {plan.periodic_until
              ? ` · ${t('modes.home.until', { date: fmtDate(plan.periodic_until, i18n.language) })}`
              : ''}
          </span>
          <p className="text-[14px] leading-5" data-testid="home-med">
            {t(`modes.home.med${plan.med_state}`)}
          </p>
          {plan.due_now && (
            <Button
              disabled={data?.canRecord === false}
              onClick={() => onRecord(null)}
              data-testid="plan-start"
            >
              {t('modes.home.start')}
            </Button>
          )}
        </Card>
      )}
      {live && data && open.length === 0 && !plan?.due_now && (
        <p className="text-[14px] text-muted" data-testid="no-requests">
          {t('modes.hospitals.nothingToRecord')}
        </p>
      )}
      <span className="mt-1 text-[12px] font-bold text-muted">
        {t('modes.hospitals.menu.sent', { hospital: h.hospital }).toUpperCase()}
      </span>
      {past.length === 0 && (data?.sessions.length ?? 0) === 0 && (
        <p className="text-[14px] text-muted">{t('modes.recordings.none')}</p>
      )}
      <ol className="flex flex-col overflow-hidden rounded-2xl border border-line bg-white empty:hidden">
        {(data?.sessions ?? []).map((s) => (
          <li
            key={s.id}
            className="flex flex-col gap-0.5 border-b border-[#EDF0F3] px-4 py-3 last:border-b-0"
            data-testid="rec-session"
          >
            <span className="text-[15px] font-semibold">
              {t('modes.recordings.session', {
                date: fmtDate(s.started_at, i18n.language),
                n: s.takes_uploaded,
              })}
            </span>
            <span className="text-[13px] text-muted">
              {s.recorded_by === 'patient'
                ? t('modes.home.selfRecorded')
                : t('modes.hospitals.atClinic')}{' '}
              · {s.med_state}
            </span>
          </li>
        ))}
        {past.map((r) => (
          <li
            key={r.id}
            className="flex flex-col gap-0.5 border-b border-[#EDF0F3] px-4 py-3 last:border-b-0"
            data-testid="history-request"
          >
            <span className="text-[15px] font-semibold">
              {fmtDate(r.appointment_at ?? r.due_at, i18n.language)}
              {r.doctor_name ? ` · ${r.doctor_name}` : ''}
            </span>
            <span
              className={`text-[13px] ${r.state === 'recorded' ? 'text-[#145F38]' : 'text-muted'}`}
            >
              {t(`modes.hospitals.state.${r.state}`)}
            </span>
          </li>
        ))}
      </ol>
    </>
  );
}

interface PastAppointment {
  id: string;
  at: string;
  doctor_name: string | null;
  status: 'past' | 'cancelled' | 'no_show';
  cancelled_by: string | null;
  cancel_reason: string | null;
  moved_from: string | null;
  moved_by_hospital: boolean;
}

/** v17: past and cancelled appointments, newest first (dates, doctors, what happened). */
function AppointmentHistory({ h }: { h: PatientHospital }) {
  const { t, i18n } = useTranslation();
  const { repo } = useApp();
  const [rows, setRows] = useState<PastAppointment[] | null>(null);
  const [filter, setFilter] = useState<'all' | 'past' | 'cancelled'>('all');
  useEffect(() => {
    let off = false;
    const key = cacheKey(h, 'appointment-history');
    const load = h.withdrawnAt
      ? Promise.reject(new Error('withdrawn'))
      : hospitalApi<PastAppointment[]>(capture.kit, h, 'GET', '/patient/appointments/history');
    load.then(
      async (r) => {
        await repo.store.put(key, r);
        if (!off) setRows(r);
      },
      async () => {
        const cached = await repo.store.get<PastAppointment[]>(key);
        if (!off) setRows(cached ?? []);
      },
    );
    return () => {
      off = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [h.profile, h.withdrawnAt, repo]);
  const shown = (rows ?? []).filter(
    (r) =>
      filter === 'all' || r.status === filter || (filter === 'cancelled' && r.status === 'no_show'),
  );
  return (
    <>
      <div className="flex gap-2" role="group">
        {(['all', 'past', 'cancelled'] as const).map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
            className={`min-h-11 rounded-full border px-4 text-[14px] font-semibold ${filter === f ? 'border-brand bg-brand text-white' : 'border-[#C9CFD8] bg-white text-ink'}`}
            data-testid={`history-filter-${f}`}
          >
            {t(`modes.hospitals.menu.filter.${f}`)}
          </button>
        ))}
      </div>
      {rows && shown.length === 0 && (
        <p className="text-[14px] text-muted" data-testid="history-none">
          {t('modes.hospitals.menu.historyNone')}
        </p>
      )}
      {shown.map((r) => {
        const cancelled = r.status !== 'past';
        const what =
          r.status === 'no_show'
            ? t('modes.hospitals.menu.noShow')
            : cancelled
              ? r.cancelled_by === 'patient'
                ? t('modes.hospitals.menu.cancelledByYou')
                : t('modes.hospitals.menu.cancelledByHospital', { hospital: h.hospital })
              : t('modes.hospitals.menu.pastVisit');
        return (
          <Card key={r.id} className="flex flex-col gap-1" data-testid="history-appt">
            <div className="flex items-start justify-between gap-2">
              <b className="text-[15px]">{fmtDateTime(r.at, i18n.language)}</b>
              <span
                className={`rounded-xl px-2.5 py-0.5 text-[12px] font-semibold whitespace-nowrap ${cancelled ? 'bg-[#EDF0F3] text-[#3D4552]' : 'bg-[#E3F4EA] text-[#145F38]'}`}
                data-testid="history-appt-state"
              >
                {what}
              </span>
            </div>
            <span className="text-[13px] text-muted">
              {[
                r.doctor_name,
                r.status === 'cancelled' && r.cancel_reason
                  ? t(`appts.cancelReason.${r.cancel_reason}`, { defaultValue: '' })
                  : '',
                r.moved_from
                  ? t('modes.hospitals.menu.movedFrom', {
                      date: fmtDate(r.moved_from, i18n.language),
                    })
                  : '',
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </Card>
        );
      })}
      <span className="text-[12px] leading-[17px] text-muted">
        {t('modes.hospitals.menu.historyNote')}
      </span>
    </>
  );
}

/** v17: the hospital's details and leaving it (withdraw), moved off the main screen. */
function HospitalDetails({ h }: { h: PatientHospital }) {
  const { t } = useTranslation();
  const { settings, saveSettings } = useApp();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const withdraw = async () => {
    setBusy(true);
    setError(null);
    try {
      // v3: the hospital keeps everything already recorded; no deletion is offered here.
      await hospitalApi(capture.kit, h, 'POST', '/patient/consent/withdraw', {
        delete_recordings: false,
      });
      await capture.kit.clearUploadCredentials({ profile: h.profile });
      const next = withdrawnFrom(settings, h.profile, new Date().toISOString());
      await saveSettings(next);
      if (next.account)
        await saveBackup(capture.kit, next.account, next.hospitals)
          .then((account) => saveSettings({ ...next, account }))
          .catch(() => undefined);
      setConfirm(false);
    } catch (e) {
      setError(errorCode(e));
    }
    setBusy(false);
  };
  return (
    <>
      <Card className="flex flex-col gap-1">
        <b className="text-[16px]">{h.hospital}</b>
        <span className="text-[14px] leading-5 text-[#3D4552]">
          {t('modes.hospitals.menu.detailsBody', { hospital: h.hospital })}
        </span>
      </Card>
      {!h.withdrawnAt && (
        <Card className="flex flex-col gap-2">
          <h2 className="text-[15px] font-bold">{t('modes.settings.withdrawTitle')}</h2>
          <p className="text-[13px] leading-[19px] text-[#3D4552]">
            {t('modes.hospitals.withdrawBody', { hospital: h.hospital })}
          </p>
          <ErrorText code={error} />
          {confirm ? (
            <div className="flex flex-col gap-2" data-testid="withdraw-confirm">
              <p className="text-[15px] font-semibold">
                {t('modes.hospitals.withdrawConfirm', { hospital: h.hospital })}
              </p>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => void withdraw()}
                data-testid="withdraw-yes"
              >
                {t('modes.settings.confirmYes')}
              </Button>
              <Button variant="secondary" onClick={() => setConfirm(false)}>
                {t('modes.settings.cancel')}
              </Button>
            </div>
          ) : (
            <Button variant="danger" onClick={() => setConfirm(true)} data-testid="withdraw">
              {t('modes.hospitals.withdraw')}
            </Button>
          )}
        </Card>
      )}
      {h.withdrawnAt && (
        <p className="text-center text-[12px] leading-[17px] text-muted">
          {t('modes.hospitals.othersUnaffected')}
        </p>
      )}
    </>
  );
}

/** Consent for this session, just before the camera opens (v3). Untick → nothing is recorded. */
function ConsentView({
  h,
  request,
  onCancel,
}: {
  h: PatientHospital;
  request: PatientRequest | null;
  onCancel: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { config, repo, startHomeSession } = useApp();
  const [plan, setPlan] = useState<HomePlan | null>(null);
  const [consent, setConsent] = useState(false);
  const [askMed, setAskMed] = useState(false);
  useEffect(() => {
    if (!request) void repo.store.get<HomePlan>(cacheKey(h, 'plan')).then(setPlan);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [h.profile, repo, request]);
  const tests = request?.tests ?? plan?.tests ?? [];
  const med = request?.med_state ?? plan?.med_state ?? 'ANY';
  const { steps, minutes } = testsMinutes(config, tests);
  const doctor = request?.doctor_name ?? t('modes.hospitals.yourDoctor');
  const start = (m: 'ON' | 'OFF') => {
    if (!consent || steps.length === 0) return;
    void startHomeSession(tests, m, {
      profile: h.profile,
      requestId: request?.id ?? null,
      consentVersion: config.platform.consentVersion,
      consentAt: new Date().toISOString(),
    });
  };
  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col gap-4 bg-ground px-5 pt-6 pb-6">
      <span className="text-[13px] font-semibold text-muted" data-testid="consent-for">
        {request?.appointment_at
          ? t('modes.consent.forVisit', {
              hospital: h.hospital,
              date: fmtDate(request.appointment_at, i18n.language),
            })
          : h.hospital}
      </span>
      <h1 className="text-[26px] leading-8 font-bold">{t('modes.consent.title')}</h1>
      <Card className="flex flex-col gap-2">
        <h2 className="text-[15px] font-bold">{t('modes.consent.whatTitle')}</h2>
        <p className="text-[14px] leading-[21px] text-[#3D4552]">
          {t('modes.consent.what', {
            count: steps.length,
            minutes,
            hospital: h.hospital,
            doctor,
          })}
        </p>
      </Card>
      <label className="flex min-h-12 items-center gap-3 rounded-2xl border-2 border-brand bg-white px-4 py-3 text-[15px]">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          className="size-6 accent-brand"
          data-testid="consent-check"
        />
        <span className="font-semibold">{t('modes.consent.agree', { hospital: h.hospital })}</span>
      </label>
      <p className="text-[13px] leading-[19px] text-muted">{t('modes.consent.without')}</p>
      {askMed ? (
        <Card className="flex flex-col gap-3" data-testid="home-med-ask">
          <p className="text-[15px] font-semibold">{t('modes.home.medAsk')}</p>
          <div className="flex gap-2">
            <Button className="flex-1" onClick={() => start('ON')} data-testid="med-ask-yes">
              {t('modes.home.medYes')}
            </Button>
            <Button
              className="flex-1"
              variant="secondary"
              onClick={() => start('OFF')}
              data-testid="med-ask-no"
            >
              {t('modes.home.medNo')}
            </Button>
          </div>
        </Card>
      ) : (
        <Button
          disabled={!consent || steps.length === 0}
          onClick={() => (med === 'ANY' ? setAskMed(true) : start(med))}
          data-testid="consent-start"
        >
          {t('modes.consent.open')}
        </Button>
      )}
      <Button variant="secondary" onClick={onCancel} data-testid="consent-cancel">
        {t('modes.consent.notNow')}
      </Button>
      <p className="text-center text-[12px] leading-[17px] text-muted">
        {t('modes.consent.every')}
      </p>
    </div>
  );
}

function SettingsView({ onBack, onAddAccount }: { onBack: () => void; onAddAccount: () => void }) {
  const { t } = useTranslation();
  const { settings, saveSettings } = useApp();
  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col gap-4 bg-ground px-5 pt-4 pb-6">
      <header className="flex items-center gap-1">
        <BackButton onClick={onBack} label={t('common.back')} />
        <h1 className="text-[22px] font-bold">{t('modes.settings.title')}</h1>
      </header>
      <Card className="flex flex-col gap-2">
        <h2 className="text-[15px] font-bold">{t('modes.settings.language')}</h2>
        <div className="flex gap-2">
          {(['en', 'hi'] as const).map((l) => (
            <Button
              key={l}
              variant={settings.language === l ? 'primary' : 'secondary'}
              className="flex-1"
              onClick={() => void saveSettings({ ...settings, language: l })}
              data-testid={`lang-${l}`}
            >
              {l === 'en' ? 'English' : 'हिन्दी'}
            </Button>
          ))}
        </div>
      </Card>
      <Card className="flex flex-col gap-2" data-testid="account-card">
        <h2 className="text-[15px] font-bold">{t('modes.account.settingsTitle')}</h2>
        {settings.account ? (
          <p className="text-[14px] leading-5 text-[#3D4552]" data-testid="account-email">
            {t('modes.account.settingsOn', { email: settings.account.email })}
          </p>
        ) : (
          <>
            <p className="text-[14px] leading-5 text-[#3D4552]">{t('modes.account.settingsOff')}</p>
            <Button onClick={onAddAccount} data-testid="account-add">
              {t('modes.account.settingsAdd')}
            </Button>
          </>
        )}
      </Card>
      <p className="text-[13px] leading-[19px] text-muted">{t('modes.hospitals.withdrawWhere')}</p>
    </div>
  );
}
