import { useEffect, useState } from 'react';
import { Greeting } from '../../ui/Greeting.tsx';
import { useTranslation } from 'react-i18next';
import { ClinicQueue } from './ClinicQueue.tsx';
import { useApp } from '../../app/AppContext.tsx';
import { errorCode, ncidForMrn } from '../../lib/accounts.ts';
import { ErrorText } from '../modes/Common.tsx';
import { capture } from '../../lib/capture.ts';
import { maskRef, newId } from '../../data/repo.ts';
import { useSession } from '../../session/useSession.ts';
import { stepLength, type MedState, type Patient } from '../../session/machine.ts';
import { Button, Card, Sheet } from '../../ui/kit.tsx';
import { UploadSetup } from '../UploadSetup.tsx';
import { VisitCheck } from '../modes/VisitCheck.tsx';

export { Logo } from '../../ui/Logo.tsx';
import { Logo } from '../../ui/Logo.tsx';

export function SessionHome({
  onEngineering,
  onLock,
}: {
  onEngineering: () => void;
  /** M13 clinic phones: lock the screen now (the operator steps away). */
  onLock?: () => void;
}) {
  const { t } = useTranslation();
  const { config, repo, settings, newSession } = useApp();
  // v8 (user, 16 Nov 2026): a clinic phone connected to its hospital records only queue patients.
  const queueOnly = !!(settings.server && settings.signedIn && !settings.localDev);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const { ctx, send } = useSession();
  const [patients, setPatients] = useState<Patient[]>([]);
  const [picker, setPicker] = useState(false);
  const [queueFocus, setQueueFocus] = useState(false);
  const [uploads, setUploads] = useState(false);
  const [draft, setDraft] = useState({ ref: '', yob: '', sex: '' as '' | 'M' | 'F' | 'O' });
  const native = capture.implementation === 'native';

  useEffect(() => {
    repo.listPatients().then(setPatients, () => undefined);
  }, [repo]);

  const totalS = ctx.plan.reduce((s, p) => {
    const c = config.tests.get(p.code);
    return s + (c ? stepLength(p, c) : 0);
  }, 0);
  const minutes = Math.round(totalS / 60 + ctx.plan.length * 1.5);
  const training = ctx.training;
  /** Queue-only phone with no queue patient started: only the queue (and practice) show. */
  const waitingForQueue = queueOnly && !training && !ctx.patient;
  // Decision 062: a visit does not start without the space it needs (practice records nothing kept).
  const [noSpace, setNoSpace] = useState(false);
  const ready =
    !!ctx.consent && (training || (!!ctx.patient && !!ctx.medState)) && (training || !noSpace);
  const seconds = ctx.plan.map((p) => {
    const c = config.tests.get(p.code);
    return c ? stepLength(p, c) : 0;
  });
  const yob = Number(draft.yob);
  const draftOk = draft.ref.trim().length >= 3 && (!draft.yob || (yob >= 1900 && yob <= 2030));

  async function savePatient() {
    let ncid: string | undefined;
    if (settings.server && settings.signedIn && !settings.localDev) {
      // M13: the hospital connector gives the NCID; the MRN never goes to the platform.
      setLookingUp(true);
      setLookupError(null);
      try {
        ncid = await ncidForMrn(capture.kit, draft.ref);
      } catch (e) {
        setLookupError(errorCode(e));
        return;
      } finally {
        setLookingUp(false);
      }
    }
    const p: Patient = {
      localId: newId('p'),
      ref: draft.ref.trim(),
      yearOfBirth: draft.yob ? yob : null,
      sex: draft.sex || null,
      ...(ncid ? { ncid } : {}),
    };
    await repo.savePatient(p);
    setPatients(await repo.listPatients());
    send({ type: 'SET_PATIENT', patient: p });
    setDraft({ ref: '', yob: '', sex: '' });
    setPicker(false);
  }

  const greetingShown = queueOnly && !ctx.patient && !training && !queueFocus;
  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col bg-ground">
      {/* New UI (decision 050): a clinic phone greets the signed-in operator, full width. */}
      {greetingShown && (
        <div className="px-5 pt-6">
          <Greeting
            name={settings.signedIn?.name}
            line={t('greeting.clinicPhone')}
            onLogo={onEngineering}
            chip={
              !native && (
                <span
                  className="min-w-0 truncate rounded-full bg-warn-soft px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap text-warn"
                  data-testid="mode-badge"
                >
                  {t(`home.mode.${capture.implementation}`)}
                </span>
              )
            }
          />
        </div>
      )}
      {!greetingShown && (
        <header className="flex items-center justify-between px-5 pt-4 pb-2">
          <div className="flex items-center gap-2.5">
            <Logo onLongPress={onEngineering} />
            {!(queueOnly && !ctx.patient && !training) && (
              <span className="text-[17px] font-bold">{t('app.name')}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`rounded-full px-2.5 py-1.5 text-xs font-semibold ${native ? 'bg-ok-soft text-ok' : 'bg-warn-soft text-warn'}`}
              data-testid="mode-badge"
            >
              {t(`home.mode.${capture.implementation}`)}
            </span>
            {onLock && !greetingShown && (
              <button
                type="button"
                onClick={onLock}
                className="min-h-12 rounded-full px-3 text-[13px] font-semibold text-brand"
                data-testid="lock-now"
              >
                {t('modes.lock.lockNow')}
              </button>
            )}
          </div>
        </header>
      )}

      <main className="flex flex-1 flex-col gap-3.5 px-5 pt-1">
        <div className={`flex items-baseline justify-between ${queueFocus ? 'hidden' : ''}`}>
          <h1 className="m-0 text-[26px] font-bold">
            {queueOnly && ctx.patient && !training
              ? t('session.home.readyTitle')
              : waitingForQueue
                ? t('greeting.upNext')
                : t('session.home.title')}
          </h1>
          <button
            type="button"
            className="flex min-h-12 items-center gap-1.5 rounded-full px-2 text-[13px] text-muted"
            onClick={() => setUploads(true)}
            data-testid="open-upload-setup"
          >
            <span
              className={`size-2 rounded-full ${settings.signedIn ? 'bg-ok' : 'bg-edge'}`}
              aria-hidden="true"
            />
            {t('session.home.operator', { id: settings.operatorId })}
          </button>
        </div>

        {!queueOnly && (
          <label className="flex min-h-12 items-center gap-3 rounded-3xl bg-card shadow-card px-4 py-3 text-sm">
            <input
              type="checkbox"
              checked={training}
              onChange={(e) => send({ type: 'SET_TRAINING', on: e.target.checked })}
              className="size-6 accent-brand"
              data-testid="practice-toggle"
            />
            <span className="flex flex-col">
              <span className="font-semibold">{t('session.practice.toggle')}</span>
              <span className="text-xs text-muted">{t('session.practice.detail')}</span>
            </span>
          </label>
        )}

        {!training &&
          settings.server &&
          settings.signedIn &&
          !settings.localDev &&
          !ctx.patient && <ClinicQueue onFocus={setQueueFocus} />}

        {queueOnly && !ctx.patient && !queueFocus && (
          <label className="flex min-h-12 items-center gap-3 rounded-3xl bg-card shadow-card px-4 py-3 text-sm">
            <input
              type="checkbox"
              checked={training}
              onChange={(e) => send({ type: 'SET_TRAINING', on: e.target.checked })}
              className="size-6 accent-brand"
              data-testid="practice-toggle"
            />
            <span className="flex flex-col">
              <span className="font-semibold">{t('session.practice.toggle')}</span>
              <span className="text-xs text-muted">{t('session.practice.detail')}</span>
            </span>
          </label>
        )}

        {!training && queueOnly && !ctx.patient && !queueFocus && (
          <p
            className="m-0 rounded-2xl bg-soft px-4 py-3 text-[14px] leading-[20px] text-sub"
            data-testid="queue-only-hint"
          >
            {t('session.home.queueOnly')}
          </p>
        )}

        {!training && (!queueOnly || ctx.patient) && (
          <>
            <Card className="flex items-center justify-between">
              <div className="flex flex-col gap-0.5">
                <span className="text-xs font-semibold tracking-wide text-muted uppercase">
                  {t('session.home.patient')}
                </span>
                {ctx.patient ? (
                  <>
                    <span className="text-[17px] font-semibold" data-testid="patient-ref">
                      {t('session.home.ref')} {maskRef(ctx.patient.ref)}
                    </span>
                    <span className="text-[13px] text-muted">
                      {[
                        ctx.patient.yearOfBirth
                          ? t('session.home.born', { year: ctx.patient.yearOfBirth })
                          : null,
                        ctx.patient.sex ? t(`session.home.sexes.${ctx.patient.sex}`) : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </>
                ) : (
                  <span className="text-[15px] text-muted">{t('session.home.choosePatient')}</span>
                )}
              </div>
              {queueOnly ? (
                <Button
                  variant="ghost"
                  onClick={() => void newSession()}
                  data-testid="back-to-queue"
                >
                  {t('session.home.backToQueue')}
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  onClick={() => setPicker(true)}
                  data-testid="choose-patient"
                >
                  {ctx.patient ? t('session.home.change') : t('session.home.newPatient')}
                </Button>
              )}
            </Card>

            <section className="flex flex-col gap-2">
              <span id="medlabel" className="text-sm font-semibold">
                {t('session.home.medState')}
              </span>
              <div role="group" aria-labelledby="medlabel" className="grid grid-cols-3 gap-2">
                {(config.session.medStates as MedState[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={ctx.medState === m}
                    onClick={() => send({ type: 'SET_MED_STATE', medState: m })}
                    className={`h-12 rounded-xl border text-[15px] font-semibold ${ctx.medState === m ? 'border-transparent nc-gradient text-white' : 'border-edge bg-card'}`}
                    data-testid={`med-${m}`}
                  >
                    {t(`session.home.med.${m}`)}
                  </button>
                ))}
              </div>
            </section>
          </>
        )}

        {waitingForQueue ? null : (
          <>
            {ctx.consentId ? (
              <p
                className="rounded-2xl border border-ok-soft bg-ok-soft px-4 py-3 text-sm text-ok"
                data-testid="consent-confirmed"
              >
                {t(
                  ctx.consentSource === 'clinic_phone'
                    ? 'session.home.consentOnPhone'
                    : 'session.home.consentFromApp',
                )}
              </p>
            ) : (
              <label className="flex items-center gap-3 rounded-3xl bg-card shadow-card px-4 py-3 text-sm">
                <input
                  type="checkbox"
                  checked={!!ctx.consent}
                  onChange={(e) =>
                    send({
                      type: 'SET_CONSENT',
                      given: e.target.checked,
                      at: new Date().toISOString(),
                    })
                  }
                  className="size-6 accent-brand"
                  data-testid="consent"
                />
                <span className="flex flex-col">
                  <span className="font-semibold">{t('session.home.consent')}</span>
                  <span className="text-xs text-muted">
                    {t('session.home.consentDetail', { version: config.session.consentVersion })}
                  </span>
                </span>
              </label>
            )}

            <section className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between">
                <span className="text-sm font-semibold">{t('session.home.plan')}</span>
                <span className="text-xs text-muted">
                  {t('session.home.planMeta', { count: ctx.plan.length, min: minutes })}
                </span>
              </div>
              <ol
                className="m-0 list-none overflow-hidden rounded-3xl bg-card shadow-card p-0"
                data-testid="test-plan"
              >
                {ctx.plan.map((p, i) => (
                  <li
                    key={`${p.code}-${p.side ?? 'na'}`}
                    className="flex h-11 items-center gap-3 border-b border-line px-3.5 last:border-b-0"
                  >
                    <span className="w-5 text-xs text-muted tabular-nums">{i + 1}</span>
                    <span className="min-w-10 rounded-md bg-brand-soft px-1.5 py-0.5 text-center text-xs font-bold text-brand">
                      {p.code}
                    </span>
                    <span className="flex-1 text-sm">{t(`tests.${p.code}`)}</span>
                    <span className="text-[13px] text-muted">
                      {p.side ? t(`session.sides.${p.side}`) : '—'}
                    </span>
                    <span className="w-10 text-right text-[13px] text-muted tabular-nums">
                      {p.durationS ?? config.tests.get(p.code)?.task.durationS} s
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          </>
        )}
      </main>

      {/* New UI round 3: on the clinic queue, Lock is a pill fixed at the bottom right. */}
      {greetingShown && onLock && (
        <button
          type="button"
          onClick={onLock}
          className="fixed right-4 bottom-[calc(1rem+var(--sab))] z-30 flex h-14 items-center gap-2 rounded-full bg-ink px-5 text-[15px] font-bold text-ground shadow-float"
          data-testid="lock-now"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="4" y="11" width="16" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
          {t('modes.lock.lockNow')}
        </button>
      )}
      {greetingShown && <div aria-hidden className="h-20" />}
      {!waitingForQueue && !training && ctx.plan.length > 0 && (
        <div className="px-5 pt-3">
          <VisitCheck seconds={seconds} onBlocked={setNoSpace} />
        </div>
      )}
      {!waitingForQueue && (
        <footer className="px-5 pt-3 pb-6">
          <Button
            className="h-14 w-full text-[17px]"
            disabled={!ready}
            onClick={() => send({ type: 'START', at: new Date().toISOString() })}
            data-testid="start-session"
          >
            {training
              ? t('session.practice.start')
              : queueOnly && ctx.plan[0]
                ? t('session.home.startFirst', { test: t(`tests.${ctx.plan[0].code}`) })
                : t('session.home.start')}
          </Button>
        </footer>
      )}

      {picker && !queueOnly && (
        <Sheet
          title={t('session.home.patient')}
          onClose={() => setPicker(false)}
          testId="patient-sheet"
        >
          {patients.length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {patients.map((p) => (
                <li key={p.localId}>
                  <button
                    type="button"
                    onClick={() => {
                      send({ type: 'SET_PATIENT', patient: p });
                      setPicker(false);
                    }}
                    className={`flex min-h-12 w-full items-center justify-between rounded-xl border px-3.5 text-left text-[15px] ${ctx.patient?.localId === p.localId ? 'border-brand bg-brand-soft' : 'border-edge bg-card'}`}
                  >
                    <span className="font-semibold">{maskRef(p.ref)}</span>
                    <span className="text-xs text-muted">{p.yearOfBirth ?? ''}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <span className="mt-1 text-sm font-semibold">{t('session.home.newPatient')}</span>
          <label className="flex flex-col gap-1 text-sm">
            {t('session.home.ref')}
            <input
              value={draft.ref}
              onChange={(e) => setDraft({ ...draft, ref: e.target.value })}
              autoComplete="off"
              className="h-12 rounded-xl border border-edge px-3 text-[15px]"
              data-testid="patient-ref-input"
            />
            <span className="text-xs text-muted">{t('session.home.refHint')}</span>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-sm">
              {t('session.home.yob')}
              <input
                inputMode="numeric"
                value={draft.yob}
                onChange={(e) =>
                  setDraft({ ...draft, yob: e.target.value.replace(/\D/g, '').slice(0, 4) })
                }
                className="h-12 rounded-xl border border-edge px-3 text-[15px]"
                data-testid="patient-yob-input"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {t('session.home.sex')}
              <select
                value={draft.sex}
                onChange={(e) => setDraft({ ...draft, sex: e.target.value as typeof draft.sex })}
                className="h-12 rounded-xl border border-edge bg-card px-3 text-[15px]"
              >
                <option value="">—</option>
                {(['M', 'F', 'O'] as const).map((s) => (
                  <option key={s} value={s}>
                    {t(`session.home.sexes.${s}`)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <ErrorText code={lookupError} />
          <Button
            disabled={!draftOk || lookingUp}
            onClick={() => void savePatient()}
            data-testid="save-patient"
          >
            {t('session.home.savePatient')}
          </Button>
        </Sheet>
      )}
      {uploads && <UploadSetup onClose={() => setUploads(false)} />}
    </div>
  );
}
