/**
 * v29 (decision 052): the bell in the top bar. It lists what needs this person now: the Overview
 * items that have an action (hospitals to look at, appointments without a doctor, recordings to
 * review, set-up to fix), patients' requests waiting at the desk and visits waiting for a doctor's
 * tests. A dot shows when something is new since the bell was last opened on this computer (only
 * item keys are remembered; never names). Refreshes every few minutes.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { call, hospital } from './api.ts';
import { describeItem, TONE, zone, type Item, type OverviewData } from './overview.tsx';
import { Badge } from './ui.tsx';

export interface Note {
  key: string;
  text: string;
  tone: 'ok' | 'warn' | 'bad' | 'neutral';
  label: string;
  page?: string;
  ncid?: string;
}

const REFRESH_MS = 3 * 60_000;
const seenKey = (who: string) => `nc.dash.seen.${who}`;

export function readSeen(who: string): Set<string> {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(seenKey(who)) ?? '[]') as unknown;
    return new Set(Array.isArray(v) ? v.map(String) : []);
  } catch {
    return new Set();
  }
}
function writeSeen(who: string, keys: string[]): void {
  try {
    globalThis.localStorage?.setItem(seenKey(who), JSON.stringify(keys.slice(-300)));
  } catch {
    /* not remembered: the dot shows again next time */
  }
}

/** Keys of notes not seen yet. */
export function unseen(notes: Pick<Note, 'key'>[], seen: ReadonlySet<string>): string[] {
  return notes.map((n) => n.key).filter((k) => !seen.has(k));
}

/** Overview items that need something done become notes (key: kind, id and state). */
export function notesFrom(
  items: Item[],
  describe: (i: Item) => ReturnType<typeof describeItem>,
): Note[] {
  return items.flatMap((i, n) => {
    const d = describe(i);
    if (!d.action) return [];
    return [
      {
        key: `${i.key}:${i.id ?? n}:${i.status}`,
        text: d.text,
        tone: TONE[i.status] ?? 'neutral',
        label: d.action.label,
        page: d.action.page,
        ncid: d.action.ncid,
      },
    ];
  });
}

export function Bell({
  who,
  changes,
  waiting,
  onPage,
  onPatient,
}: {
  /** The signed-in person's ID (whose "seen" list this is). */
  who: string;
  /** Patients' requests waiting at the desk (null: not for this person). */
  changes: number | null;
  /** Appointments waiting for this doctor's tests. */
  waiting: number | null;
  onPage: (page: string) => void;
  onPatient: (ncid: string) => void;
}) {
  const { t } = useTranslation();
  const [notes, setNotes] = useState<Note[]>([]);
  const [open, setOpen] = useState(false);
  /** What was new when the bell was opened (marked in the list). */
  const [newOnOpen, setNewOnOpen] = useState<string[]>([]);
  const [seen, setSeen] = useState<Set<string>>(() => readSeen(who));
  const box = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    call<OverviewData>('GET', `/overview?period=4w&tz=${encodeURIComponent(zone())}`).then(
      async (d) => {
        const ncids = [...new Set(d.items.flatMap((i) => (i.ncid ? [i.ncid] : [])))];
        let names: Record<string, string> = {};
        if (ncids.length)
          names = await hospital<{ ncid: string; name: string | null }[]>(
            'POST',
            '/v1/patients/lookup',
            { ncids },
          ).then(
            (l) => Object.fromEntries(l.flatMap((x) => (x.name ? [[x.ncid, x.name]] : []))),
            () => ({}), // names stay "Patient" when the connector is not answering
          );
        setNotes(notesFrom(d.items, (i) => describeItem(t, i, names)));
      },
      () => undefined,
    );
  }, [t]);
  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const all: Note[] = [
    ...(changes
      ? [
          {
            key: `requests:${changes}`,
            text: t('bell.requests', { count: changes }),
            tone: 'warn' as const,
            label: t('overview.open'),
            page: 'appointments',
          },
        ]
      : []),
    ...(waiting
      ? [
          {
            key: `tests:${waiting}`,
            text: t('bell.tests', { count: waiting }),
            tone: 'warn' as const,
            label: t('overview.open'),
            page: 'chooseTests',
          },
        ]
      : []),
    ...notes,
  ];
  const fresh = unseen(all, seen);
  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    load();
    setNewOnOpen(fresh);
    setOpen(true);
    const next = new Set([...seen, ...all.map((n) => n.key)]);
    setSeen(next);
    writeSeen(who, [...next]);
  };
  return (
    <div ref={box} className="relative shrink-0">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-label={t('bell.label', { count: all.length })}
        className="relative inline-flex size-10 items-center justify-center rounded-full bg-soft text-sub"
        data-testid="bell"
      >
        <svg
          aria-hidden
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
        {fresh.length > 0 && (
          <span
            className="absolute top-2 right-2.5 size-2 rounded-full bg-coral shadow-[0_0_0_2px_var(--color-soft)]"
            data-testid="bell-dot"
          />
        )}
      </button>
      {open && (
        <div
          className="nc-fu absolute top-12 right-0 z-30 flex max-h-[70vh] w-[min(380px,calc(100vw-24px))] flex-col overflow-hidden rounded-3xl bg-card shadow-[0_20px_60px_rgb(0_0_0/0.18)]"
          role="dialog"
          aria-label={t('bell.title')}
          data-testid="bell-panel"
        >
          <b className="border-b border-line px-5 pt-4 pb-3 text-[16px]">{t('bell.title')}</b>
          {all.length === 0 ? (
            <p className="px-5 py-8 text-center text-[14px] text-muted" data-testid="bell-empty">
              {t('bell.empty')}
            </p>
          ) : (
            <ul className="m-0 flex list-none flex-col overflow-y-auto p-2">
              {all.map((n) => (
                <li key={n.key}>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      if (n.ncid) onPatient(n.ncid);
                      else if (n.page) onPage(n.page);
                    }}
                    className="flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left hover:bg-soft"
                    data-testid="bell-item"
                  >
                    <span className="min-w-0 flex-1 text-[14px] leading-5">
                      {newOnOpen.includes(n.key) && (
                        <span className="mr-1.5 inline-block size-2 rounded-full bg-coral align-middle" />
                      )}
                      {n.text}
                    </span>
                    <Badge tone={n.tone}>{n.label}</Badge>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
