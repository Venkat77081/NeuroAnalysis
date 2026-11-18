/**
 * Patient app (v3): every hospital the patient joined, each with its record links (recording
 * requests from the doctor), the doctor's optional "every N days" plan and the history. Consent is
 * asked on its own screen just before the camera opens, for each session; no consent, no
 * recording. Withdrawing from a hospital keeps its history readable here (read only); only the
 * hospital can invite the patient back.
 */
import { useEffect, useState } from 'react';
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
import { AppointmentsSection } from './Appointments.tsx';

type View =
  | { kind: 'list' }
  | { kind: 'hospital'; profile: string }
  | { kind: 'consent'; profile: string; request: PatientRequest | null }
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
        onBack={home}
        onRecord={(request) => setView({ kind: 'consent', profile: view.profile, request })}
      />
    );
  if (view.kind === 'consent' && byProfile(view.profile))
    return (
      <ConsentView
        h={byProfile(view.profile)!}
        request={view.request}
        onCancel={() => setView({ kind: 'hospital', profile: view.profile })}
      />
    );
  return (
    <HospitalList
      hospitals={hospitals}
      onOpen={(profile) => setView({ kind: 'hospital', profile })}
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
function useHospitalData(h: PatientHospital): HospitalData | null {
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
  }, [h.profile, h.withdrawnAt, repo]);
  return data;
}

const openRequests = (d: HospitalData | null) =>
  (d?.requests ?? [])
    .filter((r) => r.state === 'open' && r.place !== 'clinic')
    .sort((a, b) => a.due_at.localeCompare(b.due_at));

/** Clinic requests: recorded by the hospital at the visit (information only). */
const clinicVisits = (d: HospitalData | null) =>
  (d?.requests ?? []).filter((r) => r.state === 'open' && r.place === 'clinic');

function HospitalList({
  hospitals,
  onOpen,
  onJoin,
  onSettings,
  onLock,
}: {
  hospitals: PatientHospital[];
  onOpen: (profile: string) => void;
  onJoin: () => void;
  onSettings: () => void;
  onLock: () => void;
}) {
  const { t } = useTranslation();
  const [uploads, setUploads] = useState<UploadStatus[]>([]);
  useEffect(() => {
    void capture.kit.listUploads().then((r) => setUploads(r.uploads));
  }, []);
  const pending = uploads.filter((u) => u.state !== 'completed').length;
  const anyActive = hospitals.some((h) => !h.withdrawnAt);
  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col gap-4 bg-ground px-5 pt-6 pb-6">
      <header className="flex items-start justify-between gap-2">
        <h1 className="text-[24px] leading-8 font-bold">{t('modes.hospitals.title')}</h1>
        {anyActive && (
          <Button
            variant="secondary"
            className="!h-12 !px-4"
            onClick={onLock}
            data-testid="lock-now"
          >
            {t('modes.lock.lockNow')}
          </Button>
        )}
      </header>
      <ul className="flex flex-col gap-3">
        {hospitals.map((h) => (
          <HospitalCard key={h.profile} h={h} onOpen={() => onOpen(h.profile)} />
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

function HospitalCard({ h, onOpen }: { h: PatientHospital; onOpen: () => void }) {
  const { t, i18n } = useTranslation();
  const data = useHospitalData(h);
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
    <li>
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

function HospitalView({
  h,
  onBack,
  onRecord,
}: {
  h: PatientHospital;
  onBack: () => void;
  onRecord: (request: PatientRequest | null) => void;
}) {
  const { t, i18n } = useTranslation();
  const { config, settings, saveSettings } = useApp();
  const data = useHospitalData(h);
  const open = openRequests(data);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const plan = data?.plan;

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

  const past = (data?.requests ?? []).filter((r) => r.state !== 'open');
  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col gap-4 bg-ground px-5 pt-4 pb-6">
      <header className="flex items-center gap-1">
        <BackButton onClick={onBack} label={t('common.back')} />
        <h1 className="text-[20px] font-bold" data-testid="hospital-name">
          {h.hospital}
        </h1>
      </header>
      {h.withdrawnAt && (
        <section
          className="flex flex-col gap-2 rounded-2xl border border-[#C9CFD8] bg-[#EDF0F3] p-4"
          data-testid="hospital-withdrawn"
        >
          <span className="self-start rounded-xl bg-white px-2.5 py-0.5 text-[12px] font-bold text-[#3D4552]">
            {t('modes.hospitals.withdrawnOn', {
              date: fmtDate(h.withdrawnAt, i18n.language),
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
      {data?.offline && (
        <p className="rounded-xl bg-[#FDF0DD] px-3 py-2 text-[13px] text-[#8A4B00]">
          {t('modes.home.offline')}
        </p>
      )}
      <ErrorText code={data?.error ?? null} />
      {!h.withdrawnAt && data?.canRecord === false && (
        <p
          className="rounded-xl bg-[#FDF0DD] px-3 py-2 text-[14px] text-[#8A4B00]"
          data-testid="hospital-not-ready"
        >
          {t('modes.hospitals.notReadyBody', { hospital: h.hospital })}
        </p>
      )}
      {!h.withdrawnAt &&
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
      {!h.withdrawnAt &&
        clinicVisits(data).map((r) => (
          <Card key={r.id} className="flex flex-col gap-1" data-testid="request-clinic">
            <span className="text-[12px] font-bold text-[#0B5FAA]">
              {t('modes.hospitals.clinicTitle').toUpperCase()}
            </span>
            <span className="text-[15px] leading-[22px]">
              {t('modes.hospitals.clinicBody', {
                date: fmtDate(r.appointment_at ?? r.due_at, i18n.language),
                doctor: r.doctor_name ?? t('modes.hospitals.yourDoctor'),
              })}
            </span>
          </Card>
        ))}
      {!h.withdrawnAt && plan && !plan.default && plan.next_due && (
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
      {!h.withdrawnAt && <AppointmentsSection h={h} />}
      {!h.withdrawnAt && data && open.length === 0 && !plan?.due_now && (
        <p className="text-[14px] text-muted" data-testid="no-requests">
          {t('modes.hospitals.nothingToRecord')}
        </p>
      )}

      <h2 className="mt-1 text-[16px] font-bold">{t('modes.hospitals.history')}</h2>
      {past.length === 0 && (data?.sessions.length ?? 0) === 0 && (
        <p className="text-[14px] text-muted">{t('modes.recordings.none')}</p>
      )}
      <ol className="flex flex-col overflow-hidden rounded-2xl border border-line bg-white">
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
      </ol>

      {!h.withdrawnAt && (
        <Card className="mt-2 flex flex-col gap-2">
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
    </div>
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
