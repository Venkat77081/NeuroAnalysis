import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { DeviceCapabilities } from '@neurocapture/capture-kit';
import i18n from '../i18n/index.ts';
import { capture } from '../lib/capture.ts';
import { loadConfig, type LoadedConfig } from '../lib/config.ts';
import { logger } from '../lib/logger.ts';
import { browserStore, kitStore, memoryStorage } from '../data/store.ts';
import { defaultSettings, newId, repo, type Repo, type Settings } from '../data/repo.ts';
import {
  SELF_REF,
  summarizeOutcomes,
  type PlanStep,
  type SessionInput,
} from '../session/machine.ts';
import { persist, startSession, type SessionActor } from '../session/persist.ts';
import { uploadConfig, uploadPrefs } from '../lib/uploads.ts';
import { crashScreen } from '../lib/crash.ts';

export interface AppServices {
  config: LoadedConfig;
  repo: Repo;
  settings: Settings;
  saveSettings(s: Settings): Promise<void>;
  actor: SessionActor;
  caps: DeviceCapabilities | null;
  /** Archive the finished session and start a new one. */
  newSession(): Promise<void>;
  /** M13 patient app: a home session with the doctor's plan (tests in protocol order). */
  startHomeSession(tests: string[], medState: 'ON' | 'OFF'): Promise<void>;
  /** M13: wipe this phone (after withdrawing consent): CaptureKit data, app data, app mode. */
  resetApp(): Promise<void>;
}

const Ctx = createContext<AppServices | null>(null);

export function useApp(): AppServices {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside AppProvider');
  return v;
}

function makeStore() {
  if (capture.implementation === 'native') return kitStore(capture.kit);
  try {
    return browserStore(globalThis.localStorage);
  } catch {
    return browserStore(memoryStorage());
  }
}

function inputFor(config: LoadedConfig, operatorId: string, tests?: string[]): SessionInput {
  const order = tests
    ? config.session.order.filter(([code]) => tests.includes(code))
    : config.session.order;
  return {
    sessionId: newId('s'),
    operatorId,
    plan: order.map(([code, side]) => ({ code, side }) as PlanStep),
    maxRetakes: config.session.maxRetakes,
    skipReasons: config.session.skipReasons,
    overrideReasons: config.session.overrideReasons,
    abortReasons: config.session.abortReasons,
    consentVersion: config.session.consentVersion,
  };
}

export function AppProvider({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const config = useMemo(() => loadConfig(), []);
  const r = useMemo(() => repo(makeStore()), []);
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [actor, setActor] = useState<SessionActor | null>(null);
  const [caps, setCaps] = useState<DeviceCapabilities | null>(null);
  // Serial save queue (a plain holder, not a ref: it is only touched in callbacks).
  const [saving] = useState(() => ({ current: Promise.resolve() as Promise<void> }));

  const watch = useCallback(
    (a: SessionActor) => {
      // Persist after every transition, in order (DEV_PLAN §5.4).
      a.subscribe(() => {
        const snap = persist(a);
        saving.current = saving.current
          .then(() => r.saveSession(snap))
          .catch((e: unknown) => logger.error('session save failed', { error: String(e) }));
      });
      return a;
    },
    [r, saving],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = await r.settings();
      void i18n.changeLanguage(s.language);
      // Settings first: the app gate decides on the lock from them in its first render.
      if (!cancelled) setSettings(s);
      const saved = await r.loadSession().catch(() => null);
      const a = watch(startSession(inputFor(config, s.operatorId), saved ?? undefined));
      if (a.getSnapshot().status === 'done') {
        a.stop();
        await r.clearSession();
        if (!cancelled) setActor(watch(startSession(inputFor(config, s.operatorId))));
      } else if (!cancelled) {
        setActor(a);
      }
      if (!cancelled) setSettings(s);
      // Re-apply upload settings; CaptureKit keeps the operator's tokens across restarts.
      if (s.server && s.signedIn)
        capture.kit
          .configureUploads(uploadConfig(s.server, uploadPrefs(s, config)))
          .catch((e: unknown) => logger.warn('upload config failed', { error: String(e) }));
      capture.kit.getCapabilities().then(
        (c) => !cancelled && setCaps(c),
        () => undefined,
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [config, r, watch]);

  useEffect(() => {
    if (actor) crashScreen.get = () => JSON.stringify(actor.getSnapshot().value);
  }, [actor]);

  const services = useMemo<AppServices | null>(() => {
    if (!actor) return null;
    return {
      config,
      repo: r,
      settings,
      caps,
      actor,
      async saveSettings(s: Settings) {
        await r.saveSettings(s);
        setSettings(s);
        void i18n.changeLanguage(s.language);
      },
      async newSession() {
        const ctx = actor.getSnapshot().context;
        await saving.current;
        if (ctx.training) {
          // Practice: every take is deleted (with its key); nothing is archived or uploaded.
          for (const tk of ctx.takes.flat())
            await capture.kit
              .deleteTake({ takeId: tk.takeId, reason: 'practice' })
              .catch(() => undefined);
        } else
          await r.archiveSession(ctx.sessionId, {
            sessionId: ctx.sessionId,
            startedAt: ctx.startedAt,
            endedAt: ctx.endedAt,
            counts: summarizeOutcomes(ctx),
            outcomes: ctx.outcomes,
          });
        actor.stop();
        await r.clearSession();
        setActor(watch(startSession(inputFor(config, settings.operatorId))));
      },
      async startHomeSession(tests: string[], medState: 'ON' | 'OFF') {
        await saving.current;
        actor.stop();
        await r.clearSession();
        const input = {
          ...inputFor(config, 'patient', tests),
          consentVersion: settings.patient?.consentVersion ?? config.platform.consentVersion,
        };
        const a = watch(startSession(input));
        a.send({
          type: 'SET_PATIENT',
          patient: { localId: 'self', ref: SELF_REF, yearOfBirth: null, sex: null },
        });
        a.send({ type: 'SET_MED_STATE', medState });
        a.send({
          type: 'SET_CONSENT',
          given: true,
          at: new Date().toISOString(), // ticked on the home screen for this session
        });
        a.send({ type: 'START', at: new Date().toISOString() });
        setActor(a);
      },
      async resetApp() {
        await saving.current;
        actor.stop();
        await capture.kit.resetDevice();
        for (const k of await r.store.keys('')) await r.store.delete(k);
        setSettings(defaultSettings);
        setActor(watch(startSession(inputFor(config, defaultSettings.operatorId))));
      },
    };
  }, [actor, caps, config, r, settings, watch, saving]);

  if (!services) return <>{fallback}</>;
  return <Ctx.Provider value={services}>{children}</Ctx.Provider>;
}
