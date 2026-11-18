/**
 * v11 patient app account screens (decision 043; mockups "v11 · Patient account"): sign up with an
 * e-mail and one app PIN, save the recovery code, sign in on a new phone (moving the account and
 * every hospital), forgot PIN (recovery code, or start the hospital list again), and moving a
 * pre-v11 install onto an account.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApp } from '../../app/AppContext.tsx';
import { capture } from '../../lib/capture.ts';
import {
  phoneIdFor,
  recoveryLooksRight,
  resetForgettingBackup,
  resetWithRecovery,
  saveBackup,
  sendCode,
  signIn,
  signUp,
  type AccountLocal,
} from '../../lib/appaccount.ts';
import { errorCode, moveHospital, patientSignIn, unlockHospitals } from '../../lib/accounts.ts';
import type { DeviceCheckResult } from '../../lib/devicecheck.ts';
import {
  activeHospitals,
  hospitalApi,
  hospitalsOf,
  type PatientHospital,
} from '../../lib/hospitals.ts';
import { builtInServer, SERVER_FIELD_SHOWN } from '../../lib/server.ts';
import { pretendServer } from '../../lib/testmode.ts';
import { uploadPrefs } from '../../lib/uploads.ts';
import { Button, Card } from '../../ui/kit.tsx';
import { dayPart } from '../../ui/Greeting.tsx';
import { attempt, ErrorText, Field, Screen } from '../modes/Common.tsx';
import { DeviceCheck } from '../modes/DeviceCheck.tsx';

export type AccountMode = 'start' | 'signin' | 'forgot' | 'migrate' | 'signedOut';

type Step =
  | { s: 'email'; path: 'signup' | 'signin' | 'forgot' | 'migrate' }
  | { s: 'code'; path: 'signup' | 'signin' | 'forgot' | 'migrate' }
  | { s: 'pin'; path: 'signup' | 'forgot' | 'forgotFresh' }
  | { s: 'currentPin' }
  | { s: 'recovery'; code: string; next: () => Promise<void> }
  /** New UI (decision 050): the first name for the greeting, kept on this phone only. */
  | { s: 'name'; next: (firstName: string) => Promise<void> }
  | { s: 'enterRecovery' }
  | { s: 'noRecovery' }
  | { s: 'move'; label: string; lastUsed: string }
  | { s: 'check'; restored: PatientHospital[]; local: AccountLocal }
  | { s: 'welcome'; names: string[]; save: () => Promise<void> }
  | { s: 'signedOut' }
  | { s: 'paused'; until: string | null };

const CODE_LEN = 6;

export function AccountFlow({ mode, onDone }: { mode: AccountMode; onDone: () => void }) {
  const { t, i18n } = useTranslation();
  const { config, settings, saveSettings, caps } = useApp();
  const [endpoint, setEndpoint] = useState(settings.account?.endpoint ?? builtInServer(config));
  const [email, setEmail] = useState(settings.account?.email ?? '');
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [recovery, setRecovery] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [left, setLeft] = useState<number | null>(null);
  const first: Step =
    mode === 'signedOut'
      ? { s: 'signedOut' }
      : { s: 'email', path: mode === 'start' ? 'signup' : mode === 'signin' ? 'signin' : mode };
  const [step, setStep] = useState<Step>(first);
  const pinRule = config.platform.patientPin;
  const pinOk =
    /^\d+$/.test(pin) && pin.length >= pinRule.minDigits && pin.length <= pinRule.maxDigits;
  const deviceLabel = caps ? `${caps.device.model} · Android ${caps.device.osVersion}` : 'Phone';
  /** This phone: its stable ID survives a reinstall, so the same phone is not "another phone". */
  const getPhone = async () => ({
    installId: settings.account?.installId ?? (await phoneIdFor(capture.kit)),
    deviceLabel,
  });
  const device = {
    model: caps?.device.model ?? 'unknown',
    osVersion: caps?.device.osVersion ?? 'unknown',
  };
  const prefs = uploadPrefs(settings, config);
  const fake = pretendServer(capture.kit, endpoint);
  const go = (s: Step) => {
    setError(null);
    setStep(s);
  };
  const fail = (e: unknown) => {
    const c = errorCode(e);
    const d = (e as { detail?: Record<string, unknown> }).detail ?? {};
    if (c === 'paused') return go({ s: 'paused', until: (d.until as string) ?? null });
    if (c === 'wrong_pin') setLeft(Number(d.left ?? 0));
    throw e;
  };

  const sendTheCode = (path: 'signup' | 'signin' | 'forgot' | 'migrate') =>
    attempt(setBusy, setError, async () => {
      await sendCode(
        capture.kit,
        endpoint,
        email.trim(),
        path === 'forgot' ? 'recover' : path === 'signin' ? 'signin' : 'signup',
      );
      setCode('');
      go({ s: 'code', path });
    });

  /** Saves the account and hospitals on this phone; `fresh` replaces the hospital list. */
  const finish = async (local: AccountLocal, hospitals?: PatientHospital[], firstName?: string) => {
    await saveSettings({
      ...settings,
      ...(firstName !== undefined ? { firstName: firstName.trim().slice(0, 40) } : {}),
      account: local,
      ...(hospitals ? { hospitals } : {}),
      signedIn: { operatorId: 'patient', operatorCode: 'patient', role: 'patient' },
      operatorId: 'patient',
    });
    await capture.kit.lockAppMode({ mode: 'patient' });
  };

  // ---------- sign up (also used to move a pre-v11 install: same PIN, existing hospitals)
  const doSignUp = (thePin: string, hospitals: PatientHospital[]) =>
    attempt(setBusy, setError, async () => {
      const out = await signUp(
        capture.kit,
        endpoint,
        email.trim(),
        code,
        thePin,
        await getPhone(),
        hospitals,
      );
      setRecovery('');
      setSaved(false);
      const done = async (firstName?: string) => {
        if (mode === 'migrate')
          for (const h of activeHospitals(settings))
            await hospitalApi(capture.kit, h, 'POST', '/patient/pin/clear').catch(() => undefined);
        await finish(out.local, undefined, firstName);
        onDone();
      };
      go({
        s: 'recovery',
        code: out.recoveryCode,
        // New accounts are asked for a first name (optional) after the recovery code.
        next: async () => (mode === 'migrate' ? done() : go({ s: 'name', next: done })),
      });
    });

  // ---------- sign in on a reinstalled or new phone
  const doSignIn = (move: boolean) =>
    attempt(setBusy, setError, async () => {
      try {
        const out = await signIn(
          capture.kit,
          endpoint,
          email.trim(),
          code,
          pin,
          await getPhone(),
          move,
        );
        if (out.hospitals.filter((h) => !h.withdrawnAt).length === 0) {
          go({ s: 'welcome', names: [], save: () => finish(out.local, out.hospitals) });
        } else if (out.samePhone) await signInHere(out.hospitals, out.local);
        else go({ s: 'check', restored: out.hospitals, local: out.local });
      } catch (e) {
        if (errorCode(e) === 'other_phone') {
          const d = (e as { detail?: Record<string, unknown> }).detail ?? {};
          return go({
            s: 'move',
            label: String(d.device_label ?? ''),
            lastUsed: String(d.last_used_at ?? ''),
          });
        }
        fail(e);
      }
    });

  /**
   * Same phone (reinstalled): the hospitals' sign-ins in the backup are this phone's own, so they
   * still work. No camera check, nothing to move, no other phone to sign out.
   */
  const signInHere = async (restored: PatientHospital[], local: AccountLocal) => {
    for (const h of restored.filter((x) => !x.withdrawnAt))
      await patientSignIn(capture.kit, h.link, pin, prefs, h.profile).catch(() => undefined);
    go({
      s: 'welcome',
      names: restored.filter((h) => !h.withdrawnAt).map((h) => h.hospital),
      save: () => finish(local, restored),
    });
  };

  /** After the camera check: each hospital moves to this phone (the old phone stops there). */
  const restore = (check: DeviceCheckResult, restored: PatientHospital[], local: AccountLocal) =>
    attempt(setBusy, setError, async () => {
      const moved: PatientHospital[] = [];
      for (const h of restored) {
        if (h.withdrawnAt) {
          moved.push(h);
          continue;
        }
        try {
          const link = await moveHospital(
            capture.kit,
            h.link,
            device,
            prefs,
            h.profile,
            check.check,
          );
          moved.push({ ...h, link });
        } catch {
          moved.push({ ...h, withdrawnAt: h.withdrawnAt }); // kept; the hospital can re-invite
        }
      }
      const next = await saveBackup(capture.kit, local, moved);
      go({
        s: 'welcome',
        names: moved.filter((h) => !h.withdrawnAt).map((h) => h.hospital),
        save: () => finish(next, moved),
      });
    });

  // ---------- forgot PIN
  const doReset = (fresh: boolean) =>
    attempt(setBusy, setError, async () => {
      const onPhone = hospitalsOf(settings);
      const out = fresh
        ? await resetForgettingBackup(
            capture.kit,
            endpoint,
            email.trim(),
            code,
            pin,
            await getPhone(),
            onPhone,
          )
        : await resetWithRecovery(
            capture.kit,
            endpoint,
            email.trim(),
            code,
            recovery,
            pin,
            await getPhone(),
          );
      setSaved(false);
      go({
        s: 'recovery',
        code: out.recoveryCode,
        next: async () => {
          const restoring = onPhone.length === 0 && out.hospitals.some((h) => !h.withdrawnAt);
          if (restoring && out.samePhone) return signInHere(out.hospitals, out.local);
          if (restoring) return go({ s: 'check', restored: out.hospitals, local: out.local });
          await finish(out.local, onPhone.length > 0 ? onPhone : out.hospitals);
          onDone();
        },
      });
    });

  const codeHint = fake && step.s === 'code' ? fake.lastAccountCode(email) : null;
  const pinFields = (
    <>
      <Field
        id="acct-pin1"
        label={t('modes.account.pinLabel', { min: pinRule.minDigits, max: pinRule.maxDigits })}
        type="password"
        inputMode="numeric"
        value={pin}
        onChange={(e) => setPin(e.target.value)}
        data-testid="acct-pin1"
      />
      <Field
        id="acct-pin2"
        label={t('modes.account.pinRepeat')}
        type="password"
        inputMode="numeric"
        value={pin2}
        onChange={(e) => setPin2(e.target.value)}
        data-testid="acct-pin2"
      />
      {pin.length > 0 && !pinOk && (
        <p className="text-[13px] text-muted">
          {t('modes.invite.pinFormat', { min: pinRule.minDigits, max: pinRule.maxDigits })}
        </p>
      )}
    </>
  );

  switch (step.s) {
    case 'signedOut':
      return (
        <Screen title={t('modes.account.signedOutTitle')}>
          <p className="text-[15px] leading-[22px] text-[#3D4552]" data-testid="acct-signed-out">
            {t('modes.account.signedOutBody')}
          </p>
          <Card className="text-[14px] leading-5 text-[#8A4B00]">
            {t('modes.account.signedOutUploads')}
          </Card>
          <Button
            onClick={() => go({ s: 'email', path: 'signin' })}
            data-testid="acct-signin-again"
          >
            {t('modes.account.signIn')}
          </Button>
        </Screen>
      );
    case 'paused':
      return (
        <Screen title={t('modes.account.pausedTitle')}>
          <p className="text-[15px] leading-[22px] text-[#3D4552]" data-testid="acct-paused">
            {t('modes.account.pausedBody')}
          </p>
          <Button
            onClick={() => go({ s: 'email', path: 'forgot' })}
            data-testid="acct-paused-recover"
          >
            {t('modes.account.useRecovery')}
          </Button>
          <Button variant="secondary" onClick={() => go({ s: 'email', path: 'signin' })}>
            {t('modes.account.tryLater')}
          </Button>
        </Screen>
      );
    case 'email': {
      const titles = {
        signup: 'modes.account.startTitle',
        signin: 'modes.account.signInTitle',
        forgot: 'modes.account.forgotTitle',
        migrate: 'modes.account.migrateTitle',
      } as const;
      const hints = {
        signup: 'modes.account.startHint',
        signin: 'modes.account.signInHint',
        forgot: 'modes.account.forgotHint',
        migrate: 'modes.account.migrateHint',
      } as const;
      return (
        <Screen title={t(titles[step.path])}>
          <p className="text-[15px] leading-[22px] text-[#3D4552]">{t(hints[step.path])}</p>
          <Field
            id="acct-email"
            label={t('modes.account.email')}
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            data-testid="acct-email"
          />
          <p className="text-[13px] leading-[19px] text-muted">{t('modes.account.emailNote')}</p>
          {SERVER_FIELD_SHOWN && (
            <Field
              id="acct-server"
              label={t('modes.invite.server')}
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              inputMode="url"
              data-testid="acct-server"
            />
          )}
          <ErrorText code={error} />
          <Button
            disabled={busy || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()) || !endpoint}
            onClick={() => void sendTheCode(step.path)}
            data-testid="acct-email-next"
          >
            {t('modes.account.continue')}
          </Button>
          {step.path === 'signup' && (
            <Button
              variant="ghost"
              onClick={() => go({ s: 'email', path: 'signin' })}
              data-testid="acct-have-account"
            >
              {t('modes.account.haveAccount')}
            </Button>
          )}
          {step.path === 'signin' && mode !== 'signedOut' && (
            <Button
              variant="ghost"
              onClick={() => go({ s: 'email', path: 'signup' })}
              data-testid="acct-new-account"
            >
              {t('modes.account.newAccount')}
            </Button>
          )}
        </Screen>
      );
    }
    case 'code':
      return (
        <Screen title={t('modes.account.codeTitle')}>
          <p className="text-[15px] leading-[22px] text-[#3D4552]">
            {t('modes.account.codeHint', { email: email.trim() })}
          </p>
          <Field
            id="acct-code"
            label={t('modes.account.code')}
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, CODE_LEN))}
            data-testid="acct-code"
          />
          {codeHint && (
            <p
              className="rounded-xl border-2 border-[#6B2FB3] bg-[#F5EFFC] px-3 py-2 text-[13px] text-[#6B2FB3]"
              data-testid="acct-code-hint"
            >
              {t('modes.account.testCode', { code: codeHint })}
            </p>
          )}
          {step.path === 'signin' && (
            <>
              <Field
                id="acct-pin"
                label={t('modes.account.appPin')}
                type="password"
                inputMode="numeric"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                data-testid="acct-pin"
              />
              {left !== null && (
                <p className="text-[13px] text-[#8A4B00]">
                  {t('modes.account.triesLeft', { count: left })}
                </p>
              )}
            </>
          )}
          <ErrorText code={error} />
          <Button
            disabled={busy || code.length !== CODE_LEN || (step.path === 'signin' && !pin)}
            onClick={() => {
              if (step.path === 'signin') void doSignIn(false);
              else if (step.path === 'signup') go({ s: 'pin', path: 'signup' });
              else if (step.path === 'migrate') go({ s: 'currentPin' });
              else go({ s: 'enterRecovery' });
            }}
            data-testid="acct-code-next"
          >
            {t('modes.account.continue')}
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => void sendTheCode(step.path)}
            data-testid="acct-code-resend"
          >
            {t('modes.account.resend')}
          </Button>
          {step.path === 'signin' && (
            <Button
              variant="ghost"
              onClick={() => go({ s: 'email', path: 'forgot' })}
              data-testid="acct-forgot"
            >
              {t('modes.account.forgot')}
            </Button>
          )}
        </Screen>
      );
    case 'pin':
      return (
        <Screen
          title={t(step.path === 'signup' ? 'modes.account.pinTitle' : 'modes.account.newPinTitle')}
        >
          <p className="text-[15px] leading-[22px] text-[#3D4552]">{t('modes.account.pinHint')}</p>
          {pinFields}
          <ErrorText code={error} />
          <Button
            disabled={busy || !pinOk || pin !== pin2}
            onClick={() => {
              if (step.path === 'signup') void doSignUp(pin, []);
              else void doReset(step.path === 'forgotFresh');
            }}
            data-testid="acct-pin-save"
          >
            {t('modes.account.savePin')}
          </Button>
        </Screen>
      );
    case 'currentPin':
      return (
        <Screen title={t('modes.account.currentPinTitle')}>
          <p className="text-[15px] leading-[22px] text-[#3D4552]">
            {t('modes.account.currentPinHint')}
          </p>
          <Field
            id="acct-current-pin"
            label={t('modes.account.appPin')}
            type="password"
            inputMode="numeric"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            data-testid="acct-current-pin"
          />
          <ErrorText code={error} />
          <Button
            disabled={busy || !pin}
            onClick={() =>
              void attempt(setBusy, setError, async () => {
                // The PIN must be the one the hospitals know: it becomes the app PIN.
                await unlockHospitals(capture.kit, activeHospitals(settings), pin, prefs);
                await doSignUp(pin, hospitalsOf(settings));
              })
            }
            data-testid="acct-current-pin-next"
          >
            {t('modes.account.continue')}
          </Button>
        </Screen>
      );
    case 'recovery':
      return (
        <Screen title={t('modes.account.recoveryTitle')}>
          <p className="text-[15px] leading-[22px] text-[#3D4552]">
            {t('modes.account.recoveryHint')}
          </p>
          <div
            className="rounded-2xl bg-ink px-4 py-4 text-center font-mono text-[19px] leading-8 font-semibold tracking-wide text-white"
            data-testid="acct-recovery-code"
          >
            {step.code}
          </div>
          <Button
            variant="secondary"
            onClick={() =>
              void globalThis.navigator?.clipboard?.writeText(step.code).catch(() => undefined)
            }
            data-testid="acct-recovery-copy"
          >
            {t('modes.account.copy')}
          </Button>
          <p className="rounded-xl bg-[#FDF0DD] px-3 py-2 text-[13px] leading-[19px] text-[#8A4B00]">
            {t('modes.account.recoveryWarn')}
          </p>
          <label className="flex min-h-12 items-center gap-3 text-[15px]">
            <input
              type="checkbox"
              checked={saved}
              onChange={(e) => setSaved(e.target.checked)}
              className="size-6 accent-brand"
              data-testid="acct-recovery-saved"
            />
            {t('modes.account.recoverySaved')}
          </label>
          <ErrorText code={error} />
          <Button
            disabled={!saved || busy}
            onClick={() => void attempt(setBusy, setError, step.next)}
            data-testid="acct-recovery-next"
          >
            {t('modes.account.continue')}
          </Button>
        </Screen>
      );
    case 'name':
      return (
        <NameStep busy={busy} onNext={(n) => void attempt(setBusy, setError, () => step.next(n))} />
      );
    case 'enterRecovery':
      return (
        <Screen title={t('modes.account.enterRecoveryTitle')}>
          <p className="text-[15px] leading-[22px] text-[#3D4552]">
            {t('modes.account.enterRecoveryHint')}
          </p>
          <Field
            id="acct-recovery"
            label={t('modes.account.recoveryCode')}
            autoCapitalize="characters"
            value={recovery}
            onChange={(e) => setRecovery(e.target.value)}
            data-testid="acct-recovery"
          />
          <ErrorText code={error} />
          <Button
            disabled={!recoveryLooksRight(recovery)}
            onClick={() => go({ s: 'pin', path: 'forgot' })}
            data-testid="acct-recovery-ok"
          >
            {t('modes.account.continue')}
          </Button>
          <Button
            variant="ghost"
            onClick={() => go({ s: 'noRecovery' })}
            data-testid="acct-no-recovery"
          >
            {t('modes.account.noRecovery')}
          </Button>
        </Screen>
      );
    case 'noRecovery':
      return (
        <Screen title={t('modes.account.noRecoveryTitle')}>
          <p className="text-[15px] leading-[22px] text-[#3D4552]">
            {t('modes.account.noRecoveryBody')}
          </p>
          <Card className="flex flex-col gap-1 text-[14px] leading-5">
            <b>{t('modes.account.noRecoveryWhat')}</b>
            <span>{t('modes.account.noRecoverySteps')}</span>
          </Card>
          {hospitalsOf(settings).length > 0 && (
            <p
              className="rounded-xl bg-[#E3F4EA] px-3 py-2 text-[13px] text-[#145F38]"
              data-testid="acct-keeps-hospitals"
            >
              {t('modes.account.noRecoveryKeeps')}
            </p>
          )}
          <Button
            variant="danger"
            onClick={() => go({ s: 'pin', path: 'forgotFresh' })}
            data-testid="acct-fresh"
          >
            {t('modes.account.noRecoveryGo')}
          </Button>
          <Button variant="secondary" onClick={() => go({ s: 'enterRecovery' })}>
            {t('modes.settings.cancel')}
          </Button>
        </Screen>
      );
    case 'move':
      return (
        <Screen title={t('modes.account.moveTitle')}>
          <p className="text-[15px] leading-[22px] text-[#3D4552]">
            {t('modes.account.moveActive')}
          </p>
          <Card className="flex flex-col gap-0.5" data-testid="acct-other-phone">
            <b className="text-[16px]">{step.label}</b>
            <span className="text-[13px] text-muted">
              {t('modes.account.lastUsed', {
                date: step.lastUsed
                  ? new Date(step.lastUsed).toLocaleDateString(
                      i18n.language === 'hi' ? 'hi-IN' : 'en-IN',
                      { day: 'numeric', month: 'short' },
                    )
                  : '',
              })}
            </span>
          </Card>
          <p className="text-[14px] leading-5 text-[#3D4552]">{t('modes.account.moveBody')}</p>
          <p className="rounded-xl bg-[#E3F4EA] px-3 py-2 text-[13px] text-[#145F38]">
            {t('modes.account.moveLost')}
          </p>
          <ErrorText code={error} />
          <Button disabled={busy} onClick={() => void doSignIn(true)} data-testid="acct-move">
            {t('modes.account.moveYes')}
          </Button>
          <Button variant="secondary" onClick={() => go({ s: 'email', path: 'signin' })}>
            {t('modes.settings.cancel')}
          </Button>
        </Screen>
      );
    case 'check':
      return (
        <Screen title={t('modes.account.checkTitle')}>
          <p className="text-[15px] leading-[22px] text-[#3D4552]">
            {t('modes.account.checkHint')}
          </p>
          <DeviceCheck
            who="patient"
            onResult={(r) => {
              if (r && r.outcome !== 'fail') void restore(r, step.restored, step.local);
            }}
          />
          <ErrorText code={error} />
          {busy && <p className="text-[14px] text-muted">{t('modes.account.restoring')}</p>}
        </Screen>
      );
    case 'welcome':
      return (
        <Screen title={t('modes.account.welcomeTitle')}>
          <ul className="flex flex-col gap-2" data-testid="acct-restored">
            {step.names.map((n) => (
              <li
                key={n}
                className="flex items-center justify-between rounded-2xl border border-line bg-white px-4 py-3 text-[15px] font-semibold"
              >
                {n}
                <span className="rounded-xl bg-[#E3F4EA] px-2.5 py-0.5 text-[12px] text-[#145F38]">
                  {t('modes.account.ready')}
                </span>
              </li>
            ))}
          </ul>
          {step.names.length === 0 && (
            <p className="text-[15px] text-[#3D4552]">{t('modes.account.welcomeEmpty')}</p>
          )}
          <p className="text-[14px] text-muted">{t('modes.account.welcomeOther')}</p>
          <Button
            disabled={busy}
            onClick={() =>
              void attempt(setBusy, setError, async () => {
                await step.save();
                onDone();
              })
            }
            data-testid="acct-welcome-next"
          >
            {t('modes.account.continue')}
          </Button>
        </Screen>
      );
  }
}

/** New UI (decision 050): "What should we call you?" with a live preview of the greeting. */
export function NameStep({
  busy,
  onNext,
  initial = '',
}: {
  busy: boolean;
  onNext: (firstName: string) => void;
  initial?: string;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial);
  return (
    <Screen title={t('greeting.nameTitle')}>
      <p className="text-[15px] leading-[22px] text-[#3D4552]">{t('greeting.nameHint')}</p>
      <Field
        id="acct-first-name"
        label={t('greeting.nameLabel')}
        value={name}
        maxLength={40}
        autoComplete="given-name"
        onChange={(e) => setName(e.target.value)}
        data-testid="acct-first-name"
      />
      <div
        className="nc-fade-up rounded-2xl px-4 py-3 text-[#3B2417]"
        style={{ background: 'linear-gradient(160deg, #fff1e0, #fde3cf)' }}
        data-testid="acct-name-preview"
      >
        <span className="text-[12px] opacity-80">{t('greeting.namePreview').toUpperCase()}</span>
        <b className="block text-[20px]">
          {name.trim()
            ? t(`greeting.${dayPart()}Name`, { name: name.trim().split(/\s+/)[0] })
            : t(`greeting.${dayPart()}`)}
        </b>
      </div>
      <Button disabled={busy} onClick={() => onNext(name)} data-testid="acct-name-next">
        {t('modes.account.continue')}
      </Button>
      <Button
        variant="secondary"
        disabled={busy}
        onClick={() => onNext('')}
        data-testid="acct-name-skip"
      >
        {t('greeting.skip')}
      </Button>
    </Screen>
  );
}
