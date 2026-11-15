/** M13 clinic phone: registration, operator sign-in, password change, clinic-only notice. */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApp } from '../../app/AppContext.tsx';
import { capture } from '../../lib/capture.ts';
import { changePassword, errorCode, operatorSignIn } from '../../lib/accounts.ts';
import { enroll, uploadPrefs } from '../../lib/uploads.ts';
import { Button } from '../../ui/kit.tsx';
import { attempt, ErrorText, Field, Screen } from './Common.tsx';

export function ClinicSetup({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const { config, settings, saveSettings, caps } = useApp();
  const [endpoint, setEndpoint] = useState(
    settings.server?.endpoint ?? config.session.upload?.defaultEndpoint ?? '',
  );
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = () =>
    attempt(setBusy, setError, async () => {
      const link = await enroll(capture.kit, endpoint, code, {
        model: caps?.device.model ?? 'unknown',
        osVersion: caps?.device.osVersion ?? 'unknown',
      });
      await capture.kit.lockAppMode({ mode: 'clinic' }); // from now on: operator mode only
      await saveSettings({ ...settings, server: link, signedIn: null, localDev: false });
      onDone();
    });
  return (
    <Screen title={t('modes.clinicSetup.title')}>
      <p className="text-[15px] leading-[22px] text-[#3D4552]">{t('modes.clinicSetup.hint')}</p>
      <Field
        id="clinic-server"
        label={t('modes.clinicSetup.server')}
        value={endpoint}
        onChange={(e) => setEndpoint(e.target.value)}
        inputMode="url"
        data-testid="clinic-server"
      />
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
    </Screen>
  );
}

export function OperatorSignIn() {
  const { t } = useTranslation();
  const { config, settings, saveSettings } = useApp();
  const [operator, setOperator] = useState(settings.signedIn?.operatorCode ?? '');
  const [password, setPassword] = useState('');
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
        signedIn: { operatorId: who.operatorId, operatorCode: who.operatorCode, role: who.role },
        operatorId: who.operatorCode,
        mustChangePassword: who.mustChangePassword,
      });
    });
  return (
    <Screen title={t('modes.signIn.title')}>
      <span className="text-[13px] font-semibold text-muted">{t('modes.signIn.hospital')}</span>
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
    </Screen>
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
  unlock,
}: {
  kind: 'operator' | 'patient';
  onUnlock: () => void;
  onSignOut?: () => void;
  /** Rejects with an error code: bad_login, account_locked, pin_locked, network… */
  unlock: (secret: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = () =>
    attempt(setBusy, setError, async () => {
      try {
        await unlock(secret);
      } catch (e) {
        setSecret('');
        const code = errorCode(e);
        throw new Error(code === 'bad_login' ? 'wrong' : code, { cause: e });
      }
      onUnlock();
    });
  return (
    <Screen title={t('modes.lock.title')}>
      <p className="text-[15px] text-[#3D4552]">{t(`modes.lock.${kind}Hint`)}</p>
      <p className="text-[13px] text-muted">{t('modes.lock.online')}</p>
      <Field
        id="unlock-secret"
        label={kind === 'operator' ? t('modes.signIn.password') : 'PIN'}
        type="password"
        inputMode={kind === 'patient' ? 'numeric' : undefined}
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
        data-testid="unlock-secret"
      />
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
      {onSignOut && (
        <Button variant="ghost" onClick={onSignOut} data-testid="lock-sign-out">
          {t('modes.lock.signOut')}
        </Button>
      )}
    </Screen>
  );
}
