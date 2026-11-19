/** M13 clinic phone: registration, operator sign-in, password change, clinic-only notice. */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApp } from '../../app/AppContext.tsx';
import { builtInServer, SERVER_FIELD_SHOWN } from '../../lib/server.ts';
import { TEST_ENDPOINT, testModeOn } from '../../lib/testmode.ts';
import { capture } from '../../lib/capture.ts';
import { changePassword, errorCode, operatorSignIn } from '../../lib/accounts.ts';
import { enroll, uploadPrefs } from '../../lib/uploads.ts';
import type { DeviceCheckResult } from '../../lib/devicecheck.ts';
import { Button } from '../../ui/kit.tsx';
import { attempt, ErrorText, Field, Screen } from './Common.tsx';
import { DeviceCheck } from './DeviceCheck.tsx';
import { Greeting } from '../../ui/Greeting.tsx';
import { QrScanner } from '../patient/QrScanner.tsx';
import { deviceCodeFrom } from '../../lib/qr.ts';
import { EngineeringMenu } from '../EngineeringMenu.tsx';

export function ClinicSetup({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const { config, settings, saveSettings, caps } = useApp();
  const [endpoint, setEndpoint] = useState(settings.server?.endpoint ?? builtInServer(config));
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Decision 035: the code is asked for (and used) only after the camera check passes.
  const [check, setCheck] = useState<DeviceCheckResult | null>(null);
  const passed = !!check && check.outcome !== 'fail';
  // v29 (decision 052): scan the registration QR shown on the dashboard's Phones page.
  const [scanning, setScanning] = useState(false);
  const submit = (ep = endpoint, cd = code) =>
    attempt(setBusy, setError, async () => {
      const link = await enroll(
        capture.kit,
        ep,
        cd,
        {
          model: caps?.device.model ?? 'unknown',
          osVersion: caps?.device.osVersion ?? 'unknown',
        },
        check!.check,
      );
      await capture.kit.lockAppMode({ mode: 'clinic' }); // from now on: operator mode only
      await saveSettings({ ...settings, server: link, signedIn: null, localDev: false });
      onDone();
    });
  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col gap-4 bg-ground px-5 pt-8 pb-6">
      {/* New UI (decision 050): a centred heading for setting up the phone. */}
      <div className="nc-fade-up flex flex-col items-center gap-2 text-center">
        <span className="flex size-16 items-center justify-center rounded-2xl bg-brand text-white">
          <svg
            width="30"
            height="30"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="3" y="6" width="13" height="12" rx="2" />
            <path d="M16 10l5-3v10l-5-3z" />
          </svg>
        </span>
        <h1 className="m-0 text-[24px] leading-8 font-bold">{t('modes.clinicSetup.title')}</h1>
        <p className="m-0 text-[15px] leading-[22px] text-[#3D4552]">
          {t('modes.clinicSetup.hint')}
        </p>
      </div>
      <DeviceCheck who="clinic" onResult={setCheck} />
      {passed && (
        <>
          <h2 className="text-[17px] font-bold">{t('modes.deviceCheck.step2')}</h2>
          {testModeOn() && (
            <div className="flex flex-col gap-1.5 rounded-2xl border-2 border-[#6B2FB3] bg-[#F5EFFC] p-3">
              <Button
                onClick={() => void submit(TEST_ENDPOINT, 'DEMO-SITE-1')}
                disabled={busy}
                data-testid="clinic-use-test"
              >
                {t('testMode.useClinic')}
              </Button>
              <span className="text-[13px] text-[#6B2FB3]">{t('testMode.useClinicHint')}</span>
            </div>
          )}
          {SERVER_FIELD_SHOWN && (
            <Field
              id="clinic-server"
              label={t('modes.clinicSetup.server')}
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              inputMode="url"
              data-testid="clinic-server"
            />
          )}
          {scanning && (
            <QrScanner
              hint={t('modes.clinicSetup.scanHint')}
              onResult={(text) => {
                setScanning(false);
                const found = deviceCodeFrom(text, config.platform.invites.deviceQrPrefix);
                if (!found) return setError('not_device_qr');
                setCode(found);
                void submit(endpoint, found);
              }}
              onClose={() => setScanning(false)}
            />
          )}
          <Button disabled={busy} onClick={() => setScanning(true)} data-testid="clinic-scan">
            {t('modes.clinicSetup.scan')}
          </Button>
          <Field
            id="clinic-code"
            label={t('modes.clinicSetup.code')}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoCapitalize="characters"
            data-testid="clinic-code"
          />
          <ErrorText code={error} />
          <Button
            disabled={busy || !endpoint || code.trim().length < 6}
            onClick={() => void submit()}
            data-testid="clinic-register"
          >
            {t('modes.clinicSetup.register')}
          </Button>
        </>
      )}
    </div>
  );
}

export function OperatorSignIn() {
  const { t } = useTranslation();
  const { config, settings, saveSettings } = useApp();
  const [operator, setOperator] = useState(settings.signedIn?.operatorCode ?? '');
  const [password, setPassword] = useState('');
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = () =>
    attempt(setBusy, setError, async () => {
      const who = await operatorSignIn(
        capture.kit,
        settings.server!,
        operator,
        password,
        uploadPrefs(settings, config),
      );
      setPassword('');
      await saveSettings({
        ...settings,
        signedIn: {
          operatorId: who.operatorId,
          operatorCode: who.operatorCode,
          role: who.role,
          name: who.name,
        },
        operatorId: who.operatorCode,
        mustChangePassword: who.mustChangePassword,
      });
    });
  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col gap-4 bg-ground px-5 pt-6 pb-6">
      {/* New UI (decision 050): the greeting before sign-in (no name yet). */}
      <Greeting line={t('greeting.signInLine')} onLogo={() => setMenu(true)} />
      {menu && <EngineeringMenu onClose={() => setMenu(false)} />}
      <h1 className="m-0 text-[24px] leading-8 font-bold">{t('modes.signIn.title')}</h1>
      <Field
        id="op-id"
        label={t('modes.signIn.operator')}
        value={operator}
        onChange={(e) => setOperator(e.target.value)}
        autoCapitalize="characters"
        data-testid="op-id"
      />
      <Field
        id="op-password"
        label={t('modes.signIn.password')}
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        data-testid="op-password"
      />
      <ErrorText code={error} />
      <Button
        disabled={busy || operator.trim().length < 2 || !password}
        onClick={() => void submit()}
        data-testid="op-sign-in"
      >
        {t('modes.signIn.submit')}
      </Button>
    </div>
  );
}

export function ChangePassword() {
  const { t } = useTranslation();
  const { config, settings, saveSettings } = useApp();
  const min = config.platform.passwords.minLength;
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = () =>
    attempt(setBusy, setError, async () => {
      if (next !== repeat) throw new Error('mismatch');
      await changePassword(capture.kit, current, next);
      await saveSettings({ ...settings, mustChangePassword: false });
    });
  return (
    <Screen title={t('modes.changePassword.title')}>
      <p className="text-[15px] leading-[22px] text-[#3D4552]">
        {t('modes.changePassword.hint', { min })}
      </p>
      <Field
        id="pw-current"
        label={t('modes.changePassword.current')}
        type="password"
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
        data-testid="pw-current"
      />
      <Field
        id="pw-next"
        label={t('modes.changePassword.next')}
        type="password"
        value={next}
        onChange={(e) => setNext(e.target.value)}
        data-testid="pw-next"
      />
      <Field
        id="pw-repeat"
        label={t('modes.changePassword.repeat')}
        type="password"
        value={repeat}
        onChange={(e) => setRepeat(e.target.value)}
        data-testid="pw-repeat"
      />
      {error === 'mismatch' ? (
        <p role="alert" className="rounded-xl bg-[#FDECEA] px-3 py-2 text-[14px] text-bad">
          {t('modes.changePassword.mismatch')}
        </p>
      ) : (
        <ErrorText code={error} />
      )}
      <Button
        disabled={busy || !current || next.length < min}
        onClick={() => void submit()}
        data-testid="pw-save"
      >
        {t('modes.changePassword.submit')}
      </Button>
    </Screen>
  );
}

/** An invite link opened on a clinic phone: patient mode can never open here. */
export function ClinicBlocked({ onOk }: { onOk: () => void }) {
  const { t } = useTranslation();
  return (
    <Screen title={t('modes.clinicBlocked.title')}>
      <p className="text-[15px] leading-[22px] text-[#3D4552]" data-testid="clinic-blocked">
        {t('modes.clinicBlocked.body')}
      </p>
      <Button onClick={onOk} data-testid="clinic-blocked-ok">
        {t('modes.clinicBlocked.ok')}
      </Button>
    </Screen>
  );
}

/**
 * Screen lock (both modes): unlocking signs in again with the server (operator password or patient
 * PIN), so wrong attempts count towards the server's lockout. Needs a connection.
 */
export function LockScreen({
  kind,
  onUnlock,
  onSignOut,
  onForgot,
  unlock,
}: {
  kind: 'operator' | 'patient';
  onUnlock: () => void;
  onSignOut?: () => void;
  /** v11 patient app account: "Forgot your PIN?" (recovery code). */
  onForgot?: () => void;
  /** Rejects with an error code: bad_login, account_locked, pin_locked, network… */
  unlock: (secret: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { settings } = useApp();
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  // New UI: "Welcome back, Asha" (patient's name on this phone, or the operator's name).
  const who = (kind === 'patient' ? settings.firstName : settings.signedIn?.name)
    ?.trim()
    .split(/\s+/)[0];
  const submit = () =>
    attempt(setBusy, setError, async () => {
      try {
        await unlock(secret);
      } catch (e) {
        setSecret('');
        setTries((n) => n + 1);
        const code = errorCode(e);
        throw new Error(code === 'bad_login' || code === 'wrong_pin' ? 'wrong' : code, {
          cause: e,
        });
      }
      onUnlock();
    });
  return (
    <Screen title={who ? t('greeting.welcomeBack', { name: who }) : t('modes.lock.title')}>
      <p className="text-[15px] text-[#3D4552]">{t(`modes.lock.${kind}Hint`)}</p>
      <p className="text-[13px] text-muted">{t('modes.lock.online')}</p>
      <div key={tries} className={tries ? 'nc-shake' : undefined}>
        <Field
          id="unlock-secret"
          label={kind === 'operator' ? t('modes.signIn.password') : 'PIN'}
          type="password"
          inputMode={kind === 'patient' ? 'numeric' : undefined}
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          data-testid="unlock-secret"
        />
      </div>
      {error === 'wrong' ? (
        <p role="alert" className="rounded-xl bg-[#FDECEA] px-3 py-2 text-[14px] text-bad">
          {t('modes.lock.wrong')}
        </p>
      ) : (
        <ErrorText code={error} />
      )}
      <Button disabled={busy || !secret} onClick={() => void submit()} data-testid="unlock">
        {t('modes.lock.unlock')}
      </Button>
      {onForgot && (
        <Button variant="ghost" onClick={onForgot} data-testid="lock-forgot">
          {t('modes.account.forgot')}
        </Button>
      )}
      {onSignOut && (
        <Button variant="ghost" onClick={onSignOut} data-testid="lock-sign-out">
          {t('modes.lock.signOut')}
        </Button>
      )}
    </Screen>
  );
}
