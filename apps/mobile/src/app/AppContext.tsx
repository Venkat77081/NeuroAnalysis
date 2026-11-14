import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
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
import { summarizeOutcomes, type PlanStep, type SessionInput } from '../session/machine.ts';
import { persist, startSession, type SessionActor } from '../session/persist.ts';

export interface AppServices {
  config: LoadedConfig;
  repo: Repo;
  settings: Settings;
  saveSettings(s: Settings): Promise<void>;
  actor: SessionActor;
  caps: DeviceCapabilities | null;
  /** Archive the finished session and start a new one. */
  newSession(): Promise<void>;
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

function inputFor(config: LoadedConfig, operatorId: string): SessionInput {
  return {
    sessionId: newId('s'),
    operatorId,
    plan: config.session.order.map(([code, side]) => ({ code, side }) as PlanStep),
    maxRetakes: config.session.maxRetakes,
    skipReasons: config.session.skipReasons,
    overrideReasons: config.session.overrideReasons,
    consentVersion: config.session.consentVersion,
  };
}

export function AppProvider({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const config = useMemo(() => loadConfig(), []);
  const r = useMemo(() => repo(makeStore()), []);
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [actor, setActor] = useState<SessionActor | null>(null);
  const [caps, setCaps] = useState<DeviceCapabilities | null>(null);
  const saving = useRef<Promise<void>>(Promise.resolve());

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
    [r],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = await r.settings();
      void i18n.changeLanguage(s.language);
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
      capture.kit.getCapabilities().then(
        (c) => !cancelled && setCaps(c),
        () => undefined,
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [config, r, watch]);

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
    };
  }, [actor, caps, config, r, settings, watch]);

  if (!services) return <>{fallback}</>;
  return <Ctx.Provider value={services}>{children}</Ctx.Provider>;
}
