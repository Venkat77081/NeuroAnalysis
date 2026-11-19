/**
 * v29 (decision 052): "Undo" after a desk change. The change (book, move, offer, decline, cancel,
 * did not come) is held in this browser for config appointmentChanges.undoSeconds with a toast;
 * Undo drops it before anything reaches the platform, so no message goes to the patient. After the
 * window, or at once when the tab is hidden or the person signs out, it is sent. Closing the tab
 * with a change still waiting asks first.
 */
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
import { useTranslation } from 'react-i18next';
import { undoSecondsOverride } from './api.ts';
import { appointmentChanges } from './config.ts';
import { errorText } from './ui.tsx';

export interface Deferred {
  /** What is about to happen ("Booking Asha for Mon 23 Nov, 9:30"). */
  label: string;
  /** The API call; runs once, after the window. */
  run: () => Promise<unknown>;
  /** After it is saved (the page shows its notice and reloads). */
  done: () => void;
}
type State = 'waiting' | 'saving' | 'done' | 'failed' | 'undone';
interface Item {
  id: number;
  label: string;
  until: number;
  state: State;
  error?: unknown;
}

export function undoWindowMs(): number {
  return (undoSecondsOverride() ?? appointmentChanges.undoSeconds) * 1000;
}

interface Api {
  defer: (d: Deferred) => void;
  /** Sends every waiting change now (sign-out, tab hidden). */
  flush: () => Promise<void>;
}
const Ctx = createContext<Api>({
  defer: (d) => void d.run().then(d.done),
  flush: async () => undefined,
});

export function useUndo(): Api {
  return useContext(Ctx);
}

export function UndoProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  const waiting = useRef(new Map<number, { d: Deferred; timer: ReturnType<typeof setTimeout> }>());
  const next = useRef(1);
  const set = (id: number, patch: Partial<Item>) =>
    setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const drop = (id: number, afterMs: number) =>
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), afterMs);

  const send = useCallback(async (id: number, d: Deferred) => {
    set(id, { state: 'saving' });
    try {
      await d.run();
      set(id, { state: 'done' });
      d.done();
      drop(id, 2500);
    } catch (e) {
      set(id, { state: 'failed', error: e });
      drop(id, 10_000);
    }
  }, []);
  const commit = useCallback(
    async (id: number) => {
      const w = waiting.current.get(id);
      if (!w) return;
      waiting.current.delete(id);
      clearTimeout(w.timer);
      await send(id, w.d);
    },
    [send],
  );
  const flush = useCallback(
    async () => void (await Promise.all([...waiting.current.keys()].map(commit))),
    [commit],
  );
  const defer = useCallback(
    (d: Deferred) => {
      const id = next.current++;
      const ms = undoWindowMs();
      setItems((xs) => [...xs, { id, label: d.label, until: Date.now() + ms, state: 'waiting' }]);
      if (ms <= 0) {
        void send(id, d);
        return;
      }
      waiting.current.set(id, { d, timer: setTimeout(() => void commit(id), ms) });
    },
    [commit, send],
  );
  const undo = (id: number) => {
    const w = waiting.current.get(id);
    if (!w) return;
    clearTimeout(w.timer);
    waiting.current.delete(id);
    set(id, { state: 'undone' });
    drop(id, 2500);
  };

  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === 'hidden') void flush();
    };
    const leaving = (e: BeforeUnloadEvent) => {
      if (waiting.current.size) e.preventDefault();
    };
    document.addEventListener('visibilitychange', hidden);
    globalThis.addEventListener('beforeunload', leaving);
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      globalThis.removeEventListener('beforeunload', leaving);
    };
  }, [flush]);

  const api = useMemo(() => ({ defer, flush }), [defer, flush]);
  return (
    <Ctx.Provider value={api}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-5 z-50 flex flex-col items-center gap-2 px-4"
        aria-live="polite"
      >
        {items.map((it) => (
          <Toast key={it.id} item={it} onUndo={() => undo(it.id)} />
        ))}
      </div>
    </Ctx.Provider>
  );
}

function Toast({ item, onUndo }: { item: Item; onUndo: () => void }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (item.state !== 'waiting') return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [item.state]);
  const left = Math.max(0, Math.ceil((item.until - now) / 1000));
  const icon = { waiting: '◷', saving: '…', done: '✓', failed: '!', undone: '↶' }[item.state];
  const dot = {
    waiting: 'bg-brand',
    saving: 'bg-brand',
    done: 'bg-[#10b981]',
    failed: 'bg-alert',
    undone: 'bg-[#6e6d84]',
  }[item.state];
  return (
    <div
      className="nc-fu pointer-events-auto flex w-full max-w-[540px] items-center gap-3 rounded-[20px] bg-[#16151f] px-4 py-3 text-white shadow-[0_20px_50px_rgb(0_0_0/0.3)]"
      role={item.state === 'failed' ? 'alert' : 'status'}
      data-testid="undo-toast"
      data-state={item.state}
    >
      <span
        aria-hidden
        className={`inline-flex size-7 shrink-0 items-center justify-center rounded-full text-[14px] font-extrabold ${dot}`}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1 text-[14px] leading-5">
        <b>{item.label}</b>
        <span className="block text-[12px] text-[#c4c2d6]">
          {item.state === 'waiting'
            ? t('undo.waiting', { s: left })
            : item.state === 'failed'
              ? t('undo.failed', { error: errorText(t, item.error) })
              : t(`undo.${item.state}`)}
        </span>
      </span>
      {item.state === 'waiting' && (
        <button
          type="button"
          onClick={onUndo}
          className="min-h-10 shrink-0 rounded-full px-3 text-[14px] font-bold text-[#c7d2fe] hover:bg-white/10"
          data-testid="undo"
        >
          {t('undo.button')}
        </button>
      )}
    </div>
  );
}
