/**
 * v28 "Horizon+" shell (decision 051): a floating top bar with pill tabs, one search for pages,
 * actions and patients (⌘K), a light/dark switch and a note when the hospital connector cannot be
 * reached (names are then hidden; patient codes still work).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { connectorReachable, hospital, onConnectorReach } from './api.ts';
import { Avatar } from './ui.tsx';

export function Logo({ size = 36 }: { size?: number }) {
  return (
    <span
      aria-hidden
      className="nc-gradient inline-flex shrink-0 items-center justify-center rounded-xl"
      style={{ width: size, height: size }}
    >
      <svg
        width={size / 2}
        height={size / 2}
        viewBox="0 0 24 24"
        fill="none"
        stroke="#fff"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="3" y="6" width="13" height="12" rx="2" />
        <path d="M16 10l5-3v10l-5-3z" />
      </svg>
    </span>
  );
}

function Icon({ d, size = 18 }: { d: string; size?: number }) {
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  );
}
const ICONS = {
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  light:
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  dark: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z',
  system: 'M3 5h18v11H3zM8 20h8M12 16v4',
};

export type Theme = 'system' | 'light' | 'dark';
const THEME_KEY = 'nc.dash.theme';
const THEMES: Theme[] = ['system', 'light', 'dark'];

export function savedTheme(): Theme {
  try {
    const v = globalThis.localStorage?.getItem(THEME_KEY) as Theme | null;
    return v && THEMES.includes(v) ? v : 'system';
  } catch {
    return 'system';
  }
}

/** Puts the choice on <html> (CSS swaps the colour tokens) and remembers it on this computer. */
export function applyTheme(theme: Theme): void {
  const root = globalThis.document?.documentElement;
  if (root) {
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
  }
  try {
    globalThis.localStorage?.setItem(THEME_KEY, theme);
  } catch {
    /* private window: not remembered */
  }
}

export const nextTheme = (t: Theme): Theme => THEMES[(THEMES.indexOf(t) + 1) % THEMES.length]!;

function ThemeButton() {
  const { t } = useTranslation();
  const [theme, setTheme] = useState<Theme>(savedTheme);
  useEffect(() => applyTheme(theme), [theme]);

  return (
    <button
      type="button"
      onClick={() => setTheme(nextTheme(theme))}
      className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-soft text-[16px] text-sub"
      aria-label={t('shell.theme', { theme: t(`shell.themes.${theme}`) })}
      title={t('shell.theme', { theme: t(`shell.themes.${theme}`) })}
      data-testid="theme"
      data-theme-choice={theme}
    >
      <Icon d={ICONS[theme]} />
    </button>
  );
}

export interface Tab {
  page: string;
  label: string;
  count?: number | null;
  countTestId?: string;
  countLabel?: string;
}

export function TopBar({
  tabs,
  active,
  onTab,
  org,
  name,
  role,
  onSearch,
  onSignOut,
  bell,
}: {
  tabs: Tab[];
  active: string;
  onTab: (page: string) => void;
  org: string;
  name: string;
  role: string;
  onSearch: () => void;
  onSignOut: () => void;
  /** v29: the notification bell. */
  bell?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <header className="sticky top-0 z-20 px-3 pt-3 sm:px-7 sm:pt-4">
      <div className="mx-auto flex h-[62px] max-w-[1440px] items-center gap-2 rounded-[31px] bg-bar pr-2.5 pl-3 shadow-float backdrop-blur sm:gap-3 sm:pl-3.5">
        <Logo />
        <span className="hidden min-w-0 flex-col leading-tight lg:flex">
          <b className="text-[14px]">{t('app.name')}</b>
          <span className="max-w-[170px] truncate text-[11px] text-muted">{org}</span>
        </span>
        <nav
          aria-label="Main"
          className="flex min-w-0 flex-1 gap-0.5 overflow-x-auto [scrollbar-width:none]"
        >
          {tabs.map((tab) => (
            <button
              key={tab.page}
              type="button"
              onClick={() => onTab(tab.page)}
              aria-current={active === tab.page ? 'page' : undefined}
              className={`inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[14px] font-semibold whitespace-nowrap ${active === tab.page ? 'nc-gradient text-white' : 'text-sub hover:bg-soft'}`}
              data-testid={`nav-${tab.page}`}
            >
              {tab.label}
              {!!tab.count && (
                <span
                  className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-alert px-1.5 text-[11px] font-bold text-white"
                  data-testid={tab.countTestId}
                  aria-label={tab.countLabel}
                >
                  {tab.count}
                </span>
              )}
            </button>
          ))}
        </nav>
        <button
          type="button"
          onClick={onSearch}
          className="inline-flex h-10 shrink-0 items-center gap-2 rounded-full bg-soft px-3 text-[13px] text-muted 2xl:w-[210px]"
          aria-label={t('shell.search')}
          aria-keyshortcuts="Control+K Meta+K"
          data-testid="search-open"
        >
          <Icon d={ICONS.search} size={16} />
          <span className="hidden 2xl:inline">{t('shell.searchShort')}</span>
          <kbd className="ml-auto hidden rounded-md bg-card px-1.5 py-0.5 font-sans text-[11px] 2xl:inline">
            ⌘K
          </kbd>
        </button>
        {bell}
        <ThemeButton />
        <span
          className="flex shrink-0 items-center gap-2"
          data-testid="who"
          title={`${name} · ${role}`}
        >
          <span className="hidden flex-col text-right text-[12px] leading-[15px] whitespace-nowrap xl:flex">
            <b className="max-w-[150px] truncate">{name}</b>
            <span className="text-muted">{role}</span>
          </span>
          <Avatar name={name} size={40} />
        </span>
        <button
          type="button"
          onClick={onSignOut}
          className="inline-flex h-10 shrink-0 items-center rounded-full px-3 text-[13px] font-semibold text-muted hover:bg-soft"
          data-testid="sign-out"
        >
          {t('app.signOut')}
        </button>
      </div>
    </header>
  );
}

/** "Can't reach your hospital records": names are hidden until the connector answers again. */
export function OfflineBanner() {
  const { t } = useTranslation();
  const [ok, setOk] = useState(connectorReachable);
  useEffect(() => onConnectorReach(setOk), []);
  if (ok) return null;
  return (
    <div className="relative z-[1] mx-auto w-full max-w-[1440px] px-4 pt-4 sm:px-7">
      <div
        className="nc-fu flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl bg-warn-soft px-4 py-3 text-[14px] text-warn"
        role="status"
        data-testid="connector-offline"
      >
        <b>◷ {t('shell.offlineTitle')}</b>
        <span>{t('shell.offlineText')}</span>
      </div>
    </div>
  );
}

interface Hit {
  id: string;
  group: 'patients' | 'actions' | 'pages';
  label: string;
  detail?: string;
  avatar?: string | null;
  run: () => void;
}
interface Found {
  mrn: string;
  name: string;
  ncid: string | null;
}

/**
 * ⌘K: pages and actions from the menu this person has, plus patients found live in the hospital's
 * records (only for people allowed to search them). Nothing typed here is stored.
 */
export function CommandPalette({
  pages,
  actions,
  canSearchPatients,
  onPage,
  onPatient,
  onClose,
}: {
  pages: { page: string; label: string }[];
  actions: { id: string; label: string; detail?: string; run: () => void }[];
  canSearchPatients: boolean;
  onPage: (page: string) => void;
  onPatient: (p: Found) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Found[]>([]);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState(0);
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    input.current?.focus();
    return () => d?.close();
  }, []);
  const searchable = canSearchPatients && q.trim().length >= 2;
  useEffect(() => {
    const text = q.trim();
    if (!canSearchPatients || text.length < 2) return;
    let off = false;
    const timer = setTimeout(() => {
      setBusy(true);
      hospital<Found[]>('GET', `/v1/patients?q=${encodeURIComponent(text)}&limit=5`)
        .then(
          (l) => !off && setFound(l),
          () => !off && setFound([]),
        )
        .finally(() => !off && setBusy(false));
    }, 250);
    return () => {
      off = true;
      clearTimeout(timer);
    };
  }, [q, canSearchPatients]);
  const hits = useMemo<Hit[]>(() => {
    const text = q.trim().toLowerCase();
    const match = (s: string) => !text || s.toLowerCase().includes(text);
    return [
      ...(searchable ? found : []).map<Hit>((p) => ({
        id: `p-${p.mrn}`,
        group: 'patients',
        label: p.name,
        detail: `MRN ${p.mrn}`,
        avatar: p.name,
        run: () => onPatient(p),
      })),
      ...actions
        .filter((a) => match(a.label))
        .map<Hit>((a) => ({ ...a, id: `a-${a.id}`, group: 'actions' })),
      ...pages
        .filter((p) => match(p.label))
        .map<Hit>((p) => ({
          id: `g-${p.page}`,
          group: 'pages',
          label: p.label,
          run: () => onPage(p.page),
        })),
    ];
  }, [found, searchable, actions, pages, q, onPage, onPatient]);
  const go = (h: Hit | undefined) => {
    if (!h) return;
    onClose();
    h.run();
  };
  let last = '';
  return (
    <dialog
      ref={ref}
      aria-label={t('shell.search')}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => e.target === ref.current && onClose()}
      className="m-auto mt-[12vh] w-[calc(100%-32px)] max-w-[640px] rounded-[28px] bg-card p-0 text-ink shadow-[0_30px_80px_rgb(0_0_0/0.3)] backdrop:bg-[#0f0e17]/45 backdrop:backdrop-blur-[2px]"
      data-testid="palette"
    >
      <div className="flex items-center gap-3 border-b border-line px-5 py-4">
        <span className="text-muted">
          <Icon d={ICONS.search} size={20} />
        </span>
        <input
          ref={input}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSel((s) => Math.min(hits.length - 1, s + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSel((s) => Math.max(0, s - 1));
            } else if (e.key === 'Enter') go(hits[Math.min(sel, hits.length - 1)]);
          }}
          placeholder={t(canSearchPatients ? 'shell.placeholderPatients' : 'shell.placeholder')}
          aria-label={t('shell.search')}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          className="h-10 flex-1 bg-transparent text-[18px] font-semibold outline-none"
          data-testid="palette-input"
        />
        <kbd className="rounded-md bg-soft px-1.5 py-0.5 font-sans text-[11px] text-muted">esc</kbd>
      </div>
      <ul
        id="palette-list"
        role="listbox"
        className="m-0 flex max-h-[60vh] list-none flex-col gap-0.5 overflow-y-auto p-3"
      >
        {hits.length === 0 && (
          <li className="px-3 py-6 text-center text-[14px] text-muted">
            {busy ? t('app.loading') : t('shell.noHits')}
          </li>
        )}
        {hits.map((h, i) => {
          const head = h.group !== last;
          last = h.group;
          return (
            <li key={h.id} className="contents">
              {head && (
                <span className="px-3 pt-2 pb-1 text-[11px] font-extrabold tracking-[0.5px] text-muted uppercase">
                  {t(`shell.group.${h.group}`)}
                </span>
              )}
              <button
                type="button"
                role="option"
                aria-selected={i === sel}
                onMouseEnter={() => setSel(i)}
                onClick={() => go(h)}
                className={`flex min-h-12 items-center gap-3 rounded-2xl px-3 text-left ${i === sel ? 'bg-brand-soft' : ''}`}
                data-testid={`palette-${h.id}`}
              >
                {h.group === 'patients' ? (
                  <Avatar name={h.avatar ?? null} size={34} />
                ) : (
                  <span
                    aria-hidden
                    className="inline-flex size-[34px] items-center justify-center rounded-xl bg-soft text-[15px]"
                  >
                    {h.group === 'actions' ? '＋' : '↗'}
                  </span>
                )}
                <span className="flex min-w-0 flex-1 flex-col">
                  <b className="truncate text-[14px]">{h.label}</b>
                  {h.detail && <span className="text-[12px] text-muted">{h.detail}</span>}
                </span>
                {i === sel && (
                  <span aria-hidden className="text-[12px] text-muted">
                    ↵
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </dialog>
  );
}

/** ⌘K / Ctrl+K opens the search from anywhere. */
export function useSearchKey(open: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        open();
      }
    };
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [open]);
}

export function Backdrop({ children }: { children: ReactNode }) {
  return <div className="nc-backdrop relative flex min-h-screen flex-col">{children}</div>;
}
