/**
 * M13 app gate: which app this phone is (clinic or patient, locked natively), sign-in, screen lock,
 * then the session screens. A clinic phone never opens patient mode; a patient phone never becomes
 * a clinic phone (CaptureKit lockAppMode).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AppMode } from '@neurocapture/capture-kit';
import { useApp } from './AppContext.tsx';
import { useSession } from '../session/useSession.ts';
import { capture } from '../lib/capture.ts';
import { errorCode, inviteToken, operatorSignIn, unlockHospitals } from '../lib/accounts.ts';
import { unlockAccount } from '../lib/appaccount.ts';
import { activeHospitals, hospitalsOf } from '../lib/hospitals.ts';
import { uploadPrefs } from '../lib/uploads.ts';
import { onInviteLink } from '../lib/deeplink.ts';
import { RoleChooser } from '../screens/modes/RoleChooser.tsx';
import {
  ChangePassword,
  ClinicBlocked,
  ClinicSetup,
  LockScreen,
  OperatorSignIn,
} from '../screens/modes/ClinicScreens.tsx';
import { InviteFlow } from '../screens/patient/InviteFlow.tsx';
import { PatientApp } from '../screens/patient/PatientApp.tsx';
import { AccountFlow, type AccountMode } from '../screens/patient/AccountFlow.tsx';

const params = new URLSearchParams(globalThis.location?.search ?? '');
/** Mock only: `?mode=clinic-local` = a clinic phone with a local operator, no server (older e2e). */
const devClinicLocal = capture.implementation !== 'native' && params.get('mode') === 'clinic-local';
/** Mock only: `?lockAfterMs=` shortens the idle lock for e2e. */
const devLockMs = capture.implementation !== 'native' ? Number(params.get('lockAfterMs')) || 0 : 0;

/** Locks after `ms` without a touch or key, and when the app comes back after being away that long. */
function useIdleLock(active: boolean, ms: number, onLock: () => void) {
  const cb = useRef(onLock);
  useEffect(() => {
    cb.current = onLock;
  });
  useEffect(() => {
    if (!active) return;
    let timer = setTimeout(() => cb.current(), ms);
    let hiddenAt = 0;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => cb.current(), ms);
    };
    const vis = () => {
      if (document.hidden) hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt >= ms) cb.current();
      else reset();
    };
    window.addEventListener('pointerdown', reset);
    window.addEventListener('keydown', reset);
    document.addEventListener('visibilitychange', vis);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('pointerdown', reset);
      window.removeEventListener('keydown', reset);
      document.removeEventListener('visibilitychange', vis);
    };
  }, [active, ms]);
}

export function Gate({
  loading,
  sessionScreens,
}: {
  loading: ReactNode;
  sessionScreens: (onLock?: () => void) => ReactNode;
}) {
  const { config, settings, saveSettings } = useApp();
  const { snapshot } = useSession();
  const [mode, setMode] = useState<AppMode | null | undefined>(undefined);
  const [choice, setChoice] = useState<AppMode | null>(null);
  const [invite, setInvite] = useState<string | null>(null);
  /** An invite dismissed on a clinic phone (it stays refused). */
  const [dismissed, setDismissed] = useState<string | null>(null);
  // Signed in → the app opens locked; unlocking signs in again with the server.
  const [locked, setLocked] = useState(!!settings.signedIn && !settings.localDev);
  // Mock/e2e only: patients have no Lock button (the app locks when idle); tests lock it this way.
  useEffect(() => {
    if (capture.implementation === 'native') return;
    const on = () => setLocked(true);
    globalThis.addEventListener('nc:lock', on);
    return () => globalThis.removeEventListener('nc:lock', on);
  }, []);
  /** v11: an account screen opened from the lock screen, Settings or a "signed out" answer. */
  const [accountMode, setAccountMode] = useState<AccountMode | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let m = (await capture.kit.getAppMode()).mode;
      if (!m && devClinicLocal) {
        m = (await capture.kit.lockAppMode({ mode: 'clinic' })).mode;
        await saveSettings({ ...settings, localDev: true });
      }
      if (!cancelled) setMode(m);
    })();
    return () => {
      cancelled = true;
    };
    // Once at start.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Invite links (may arrive before the mode is known; decided at render).
  useEffect(
    () =>
      onInviteLink((url) => {
        const tok = inviteToken(url);
        if (tok) setInvite(tok);
      }),
    [],
  );

  const busyRecording =
    snapshot.matches({ test: 'framing' }) ||
    snapshot.matches({ test: 'countdown' }) ||
    snapshot.matches({ test: 'recording' });
  // A clinic phone never opens patient mode; on an unset phone an invite means the patient app.
  const blocked = mode === 'clinic' && !!invite && invite !== dismissed;
  const effective = mode ?? (invite ? 'patient' : choice);
  const lockMs =
    devLockMs ||
    (effective === 'patient'
      ? config.platform.app.patientAutoLockMin
      : config.platform.app.operatorAutoLockMin) * 60_000;
  useIdleLock(
    !!effective && !!settings.signedIn && !locked && !busyRecording && !settings.localDev,
    lockMs,
    () => setLocked(true),
  );

  if (mode === undefined) return <>{loading}</>;
  if (blocked) return <ClinicBlocked onOk={() => setDismissed(invite)} />;
  const prefs = uploadPrefs(settings, config);
  const unlockOperator = async (password: string) => {
    const who = await operatorSignIn(
      capture.kit,
      settings.server!,
      settings.signedIn!.operatorCode,
      password,
      prefs,
    );
    if (who.mustChangePassword) await saveSettings({ ...settings, mustChangePassword: true });
  };
  const unlockPatient = async (pin: string) => {
    if (!settings.account)
      return unlockHospitals(capture.kit, activeHospitals(settings), pin, prefs);
    // v11: the app PIN is checked by the platform's account; hospitals then sign in with the phone.
    try {
      const { local } = await unlockAccount(capture.kit, settings.account, pin);
      await saveSettings({ ...settings, account: local });
    } catch (e) {
      if (['moved', 'signed_out', 'pin_reset'].includes(errorCode(e))) setAccountMode('signedOut');
      throw e;
    }
    await unlockHospitals(capture.kit, activeHospitals(settings), pin, prefs).catch(
      () => undefined,
    );
  };

  if (effective === null) return <RoleChooser onPick={setChoice} />;

  if (effective === 'clinic') {
    if (settings.localDev) return <>{sessionScreens()}</>;
    if (!settings.server) return <ClinicSetup onDone={() => setMode('clinic')} />;
    if (!settings.signedIn) return <OperatorSignIn />;
    if (settings.mustChangePassword) return <ChangePassword />;
    if (locked)
      return (
        <LockScreen
          kind="operator"
          unlock={unlockOperator}
          onUnlock={() => setLocked(false)}
          onSignOut={() =>
            void (async () => {
              await capture.kit.clearUploadCredentials();
              await saveSettings({ ...settings, signedIn: null });
              setLocked(false);
            })()
          }
        />
      );
    return <>{sessionScreens(() => setLocked(true))}</>;
  }

  // Patient app
  if (accountMode)
    return (
      <AccountFlow
        mode={accountMode}
        onDone={() => {
          setAccountMode(null);
          setLocked(false);
          setMode('patient');
        }}
      />
    );
  // v11: a new install starts with the app account (e-mail, app PIN, recovery code).
  if (!settings.account && hospitalsOf(settings).length === 0)
    return <AccountFlow mode="start" onDone={() => setMode('patient')} />;
  if (hospitalsOf(settings).length === 0)
    return (
      <InviteFlow
        initialToken={invite}
        onDone={() => {
          setMode('patient'); // locked natively by the invite flow
          setInvite(null);
        }}
      />
    );
  // After withdrawing from every hospital only the read-only history is left: nothing to unlock.
  if (locked && activeHospitals(settings).length > 0)
    return (
      <LockScreen
        kind="patient"
        unlock={unlockPatient}
        onUnlock={() => setLocked(false)}
        {...(settings.account ? { onForgot: () => setAccountMode('forgot') } : {})}
      />
    );
  if (snapshot.matches('setup'))
    return (
      <PatientApp
        onAddAccount={() => setAccountMode('migrate')}
        invite={invite}
        onInviteUsed={() => setInvite(null)}
      />
    );
  return <>{sessionScreens()}</>;
}
