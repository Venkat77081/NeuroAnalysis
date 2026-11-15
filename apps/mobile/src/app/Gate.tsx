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
import { inviteToken, operatorSignIn, patientSignIn } from '../lib/accounts.ts';
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
import { PatientApp, WithdrawnScreen } from '../screens/patient/PatientApp.tsx';

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
  const [withdrawn, setWithdrawn] = useState(false);
  // Signed in → the app opens locked; unlocking signs in again with the server.
  const [locked, setLocked] = useState(!!settings.signedIn && !settings.localDev);
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
  if (withdrawn)
    return (
      <WithdrawnScreen
        onOk={() => {
          setWithdrawn(false);
          setChoice(null);
          setInvite(null);
          setMode(null);
          setLocked(false);
        }}
      />
    );
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
  const unlockPatient = (pin: string) => patientSignIn(capture.kit, settings.server!, pin, prefs);

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
  if (!settings.patient) return <InviteFlow initialToken={invite} />;
  if (locked)
    return <LockScreen kind="patient" unlock={unlockPatient} onUnlock={() => setLocked(false)} />;
  if (snapshot.matches('setup'))
    return <PatientApp onLock={() => setLocked(true)} onSignedOut={() => setWithdrawn(true)} />;
  return <>{sessionScreens()}</>;
}
