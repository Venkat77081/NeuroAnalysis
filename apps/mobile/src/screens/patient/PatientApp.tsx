/** M13 patient app: home with the doctor's plan, recordings and upload status, settings. */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { UploadStatus } from '@neurocapture/capture-kit';
import { useApp } from '../../app/AppContext.tsx';
import { capture } from '../../lib/capture.ts';
import { api, errorCode, type HomePlan, type HomeSession } from '../../lib/accounts.ts';
import { logger } from '../../lib/logger.ts';
import { stepTitle } from '../session/TestIntro.tsx';
import { BackButton, Button, Card } from '../../ui/kit.tsx';
import { ErrorText, Screen } from '../modes/Common.tsx';

const PLAN_KEY = 'patient.plan';

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
  onSignedOut,
}: {
  onLock: () => void;
  onSignedOut: () => void;
}) {
  const [view, setView] = useState<'home' | 'recordings' | 'settings'>('home');
  if (view === 'recordings') return <Recordings onBack={() => setView('home')} />;
  if (view === 'settings')
    return <SettingsView onBack={() => setView('home')} onSignedOut={onSignedOut} />;
  return (
    <Home
      onRecordings={() => setView('recordings')}
      onSettings={() => setView('settings')}
      onLock={onLock}
    />
  );
}

function Home({
  onRecordings,
  onSettings,
  onLock,
}: {
  onRecordings: () => void;
  onSettings: () => void;
  onLock: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { config, settings, repo, startHomeSession } = useApp();
  const [plan, setPlan] = useState<HomePlan | null>(null);
  const [offline, setOffline] = useState(false);
  const [askMed, setAskMed] = useState(false);
  // Consent for this session: nothing is recorded until it is ticked.
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<HomePlan>(capture.kit, 'GET', '/patient/plan')
      .then(async (p) => {
        if (cancelled) return;
        setPlan(p);
        await repo.store.put(PLAN_KEY, p);
      })
      .catch(async (e: unknown) => {
        logger.warn('plan fetch failed', { code: errorCode(e) });
        const cached = await repo.store.get<HomePlan>(PLAN_KEY);
        if (cancelled) return;
        if (errorCode(e) === 'login_required') setError('login_required');
        setOffline(true);
        const d = config.platform.defaultPlan;
        setPlan(
          cached ?? {
            tests: d.tests,
            every_days: d.everyDays,
            med_state: d.medState,
            default: true,
            last_session_at: null,
            next_due: null,
            due_now: true,
          },
        );
      });
    return () => {
      cancelled = true;
    };
  }, [config, repo]);

  const steps = plan ? config.session.order.filter(([code]) => plan.tests.includes(code)) : [];
  const totalS = steps.reduce((s, [code]) => s + (config.tests.get(code)?.task.durationS ?? 0), 0);
  const minutes = Math.round(totalS / 60 + steps.length * 1.5);
  const start = (med: 'ON' | 'OFF') => {
    if (consent) void startHomeSession(plan!.tests, med);
  };

  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col gap-4 bg-ground px-5 pt-6 pb-6">
      <header className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h1 className="text-[24px] leading-8 font-bold">{t('modes.home.hello')}</h1>
          <span className="text-[14px] text-muted" data-testid="home-hospital">
            {t('modes.home.from', { hospital: settings.patient?.hospital ?? '' })}
          </span>
        </div>
        <Button variant="secondary" className="!h-12 !px-4" onClick={onLock} data-testid="lock-now">
          {t('modes.lock.lockNow')}
        </Button>
      </header>
      {offline && (
        <p className="rounded-xl bg-[#FDF0DD] px-3 py-2 text-[13px] text-[#8A4B00]">
          {t('modes.home.offline')}
        </p>
      )}
      <ErrorText code={error} />
      {plan && (
        <Card className="flex flex-col gap-3" data-testid="home-plan">
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
          <ul className="flex flex-col gap-1 text-[15px]">
            {steps.map(([code, side]) => (
              <li key={`${code}${side ?? ''}`}>{stepTitle(t, code, side)}</li>
            ))}
          </ul>
          <span className="text-[13px] text-muted">
            {t('modes.home.every', { count: plan.every_days })} ·{' '}
            {t('modes.home.minutes', { n: minutes })}
            {plan.default ? ` · ${t('modes.home.defaultPlan')}` : ''}
          </span>
          <p className="text-[14px] leading-5" data-testid="home-med">
            {t(`modes.home.med${plan.med_state}`)}
          </p>
          {plan.last_session_at && (
            <span className="text-[13px] text-muted">
              {t('modes.home.last', { date: fmtDate(plan.last_session_at, i18n.language) })}
            </span>
          )}
        </Card>
      )}
      <label className="flex min-h-12 items-center gap-3 rounded-2xl border border-line bg-white px-4 py-3 text-[14px]">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          className="size-6 accent-brand"
          data-testid="home-consent"
        />
        <span className="font-semibold">{t('modes.home.consent')}</span>
      </label>
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
          disabled={!plan || steps.length === 0 || !consent}
          onClick={() =>
            plan!.med_state === 'ANY' ? setAskMed(true) : start(plan!.med_state as 'ON' | 'OFF')
          }
          data-testid="home-start"
        >
          {t('modes.home.start')}
        </Button>
      )}
      <div className="flex gap-2">
        <Button
          variant="secondary"
          className="flex-1"
          onClick={onRecordings}
          data-testid="home-recordings"
        >
          {t('modes.home.recordings')}
        </Button>
        <Button
          variant="secondary"
          className="flex-1"
          onClick={onSettings}
          data-testid="home-settings"
        >
          {t('modes.home.settings')}
        </Button>
      </div>
    </div>
  );
}

function Recordings({ onBack }: { onBack: () => void }) {
  const { t, i18n } = useTranslation();
  const [uploads, setUploads] = useState<UploadStatus[]>([]);
  const [sessions, setSessions] = useState<HomeSession[] | null>(null);
  useEffect(() => {
    void capture.kit.listUploads().then((r) => setUploads(r.uploads));
    api<HomeSession[]>(capture.kit, 'GET', '/patient/sessions').then(setSessions, () =>
      setSessions([]),
    );
  }, []);
  const pending = uploads.filter((u) => u.state !== 'completed').length;
  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col gap-4 bg-ground px-5 pt-4 pb-6">
      <header className="flex items-center gap-1">
        <BackButton onClick={onBack} label={t('common.back')} />
        <h1 className="text-[22px] font-bold">{t('modes.recordings.title')}</h1>
      </header>
      <Card className="flex flex-col gap-1">
        <h2 className="text-[15px] font-bold">{t('modes.recordings.onPhone')}</h2>
        <span className="text-[14px]" data-testid="rec-pending">
          {pending > 0 ? t('modes.recordings.pending', { n: pending }) : t('uploads.allDone')}
        </span>
      </Card>
      {sessions?.length === 0 && (
        <p className="text-[14px] text-muted">{t('modes.recordings.none')}</p>
      )}
      <ul className="flex flex-col gap-2">
        {(sessions ?? []).map((s) => (
          <li
            key={s.id}
            className="rounded-2xl border border-line bg-white px-4 py-3"
            data-testid="rec-session"
          >
            <span className="block text-[15px] font-semibold">
              {t('modes.recordings.session', {
                date: fmtDate(s.started_at, i18n.language),
                n: s.takes_uploaded,
              })}
            </span>
            <span className="text-[13px] text-muted">
              {t('modes.home.selfRecorded')} · {s.med_state}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SettingsView({ onBack, onSignedOut }: { onBack: () => void; onSignedOut: () => void }) {
  const { t } = useTranslation();
  const { settings, saveSettings, resetApp } = useApp();
  const [deleteAlso, setDeleteAlso] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const withdraw = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(capture.kit, 'POST', '/patient/consent/withdraw', {
        delete_recordings: deleteAlso,
      });
      await resetApp();
      onSignedOut();
    } catch (e) {
      setError(errorCode(e));
      setBusy(false);
    }
  };
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
      <Card className="flex flex-col gap-2">
        <h2 className="text-[15px] font-bold">{t('modes.settings.withdrawTitle')}</h2>
        <p className="text-[13px] leading-[19px] text-[#3D4552]">
          {t('modes.settings.withdrawBody')}
        </p>
        <label className="flex min-h-12 items-center gap-2.5 text-[14px]">
          <input
            type="checkbox"
            checked={deleteAlso}
            onChange={(e) => setDeleteAlso(e.target.checked)}
            className="size-[22px] accent-brand"
            data-testid="withdraw-delete"
          />
          {t('modes.settings.deleteAlso')}
        </label>
        <ErrorText code={error} />
        {confirm ? (
          <div className="flex flex-col gap-2" data-testid="withdraw-confirm">
            <p className="text-[15px] font-semibold">{t('modes.settings.confirm')}</p>
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
            {t('modes.settings.withdraw')}
          </Button>
        )}
      </Card>
    </div>
  );
}

export function WithdrawnScreen({ onOk }: { onOk: () => void }) {
  const { t } = useTranslation();
  return (
    <Screen title={t('modes.settings.title')}>
      <p className="text-[15px]" data-testid="withdrawn">
        {t('modes.settings.done')}
      </p>
      <Button onClick={onOk}>{t('modes.clinicBlocked.ok')}</Button>
    </Screen>
  );
}
