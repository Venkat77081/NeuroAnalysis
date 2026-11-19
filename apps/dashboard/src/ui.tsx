import {
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ApiError } from './api.ts';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
const variants: Record<Variant, string> = {
  primary:
    'nc-gradient text-white shadow-[0_6px_16px_rgb(79_70_229/0.28)] disabled:bg-soft disabled:bg-none disabled:text-muted disabled:shadow-none',
  secondary: 'bg-card text-ink shadow-[inset_0_0_0_1px_var(--color-edge)] disabled:opacity-50',
  ghost: 'bg-transparent text-brand-ink disabled:opacity-50',
  danger: 'bg-alert text-white disabled:opacity-50',
};

/** v28: pill buttons; primary is the indigo-to-violet gradient. */
export function Button({
  variant = 'primary',
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      {...rest}
      className={`inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full px-4 text-[14px] font-semibold whitespace-nowrap transition-[filter] hover:brightness-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${variants[variant]} ${className}`}
    />
  );
}

export function Field({
  label,
  id,
  ...rest
}: { label: string; id: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label htmlFor={id} className="flex flex-col gap-1.5 text-[13px] font-semibold text-sub">
      {label}
      <input
        id={id}
        {...rest}
        className="h-11 rounded-2xl border border-transparent bg-soft px-3.5 text-[14px] font-normal text-ink outline-none focus:border-brand"
      />
    </label>
  );
}

export function Card({
  title,
  children,
  className = '',
  testId,
  action,
}: {
  title?: string;
  children: ReactNode;
  className?: string;
  testId?: string;
  /** v28: a small control at the right of the title. */
  action?: ReactNode;
}) {
  return (
    <section
      className={`nc-fu flex flex-col gap-3 rounded-3xl bg-card p-5 shadow-card ${className}`}
      data-testid={testId}
    >
      {title &&
        (action ? (
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="flex-1 text-[17px] font-bold">{title}</h2>
            {action}
          </div>
        ) : (
          <h2 className="text-[17px] font-bold">{title}</h2>
        ))}
      {children}
    </section>
  );
}

export function Page({
  title,
  sub,
  actions,
  hero,
  children,
}: {
  title: string;
  /** v28: a line under the title. */
  sub?: ReactNode;
  /** v28: buttons at the right of the title. */
  actions?: ReactNode;
  /** v28: the sunrise greeting replaces the title on Today/Overview pages. */
  hero?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="relative z-[1] mx-auto flex w-full max-w-[1440px] min-w-0 flex-1 flex-col gap-5 px-4 pt-5 pb-10 sm:px-7">
      {hero ?? (
        <div className="nc-fu flex flex-wrap items-end justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-[28px] leading-9 font-extrabold tracking-[-0.4px] sm:text-[30px]">
              {title}
            </h1>
            {sub && <span className="text-[14px] text-sub">{sub}</span>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </main>
  );
}

export function Notice({
  tone = 'ok',
  children,
  testId,
}: {
  tone?: 'ok' | 'warn' | 'bad';
  children: ReactNode;
  testId?: string;
}) {
  const c = {
    ok: 'bg-ok-soft text-ok',
    warn: 'bg-warn-soft text-warn',
    bad: 'bg-bad-soft text-bad',
  }[tone];
  return (
    <p
      className={`rounded-2xl px-4 py-3 text-[14px] leading-5 ${c}`}
      data-testid={testId}
      role={tone === 'bad' ? 'alert' : undefined}
    >
      {children}
    </p>
  );
}

/** The words for an API error (errors.<code>), or the generic text. */
export function errorText(t: TFunction, error: unknown): string {
  const code =
    error instanceof ApiError ? error.code : error instanceof Error ? error.message : 'generic';
  const key = `errors.${code}`;
  const text = t(key);
  return text === key ? t('errors.generic') : text;
}

export function ErrorNote({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (!error) return null;
  return <Notice tone="bad">{errorText(t, error)}</Notice>;
}

/**
 * Status chip: soft colour, darker text and an icon (drawn by CSS, so it is not part of the
 * text): never colour alone.
 */
export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'ok' | 'warn' | 'bad' | 'neutral' | 'info';
  children: ReactNode;
}) {
  const c = {
    ok: 'bg-ok-soft text-ok',
    warn: 'bg-warn-soft text-warn',
    bad: 'bg-bad-soft text-bad',
    neutral: 'bg-soft text-sub',
    info: 'bg-brand-soft text-brand-ink',
  }[tone];
  return (
    <span
      className={`nc-badge inline-flex items-center gap-1 rounded-xl px-2.5 py-0.5 text-[12px] font-semibold ${c}`}
      data-tone={tone}
    >
      {children}
    </span>
  );
}

export function Table({
  head,
  children,
  testId,
}: {
  head: string[];
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div className="nc-fu overflow-x-auto rounded-3xl bg-card shadow-card">
      <table className="w-full min-w-[640px] border-collapse text-[14px]" data-testid={testId}>
        <thead>
          <tr className="text-left text-[12px] tracking-[0.4px] text-muted uppercase">
            {head.map((h, i) => (
              <th key={i} className="px-4 pt-4 pb-3 font-bold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** v28: one choice out of a few, as a pill switch. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  testId,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  testId?: (v: T) => string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex rounded-full bg-card p-[3px] shadow-[inset_0_0_0_1px_var(--color-edge)]"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={`min-h-9 rounded-full px-3.5 text-[13px] font-bold ${o.value === value ? 'bg-ink text-ground' : 'text-sub'}`}
          data-testid={testId?.(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const AVATAR = [
  '#4f46e5',
  '#f97360',
  '#0f766e',
  '#7c3aed',
  '#0891b2',
  '#65a30d',
  '#db2777',
  '#b45309',
];
/** Same colour for the same name, every time. */
export function avatarColour(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR[h % AVATAR.length]!;
}

/** v28: a coloured circle with the first letter (or "#" when the name is not known). */
export function Avatar({ name, size = 40 }: { name: string | null; size?: number }) {
  const letter = name
    ?.trim()
    .replace(/^(dr\.?|mrn)\s+/i, '')[0]
    ?.toUpperCase();
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-bold ${letter ? 'text-white' : 'bg-soft text-muted'}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.4),
        ...(letter ? { background: avatarColour(name!) } : {}),
      }}
    >
      {letter ?? '#'}
    </span>
  );
}

/** v28: where "now" is in a list of times (a coral line with a pulsing dot). */
export function NowLine({ label }: { label: string }) {
  return (
    <div
      className="flex items-center gap-2 py-1 text-[12px] font-extrabold text-coral"
      data-testid="now-line"
      role="separator"
      aria-label={label}
    >
      <span className="relative inline-block size-2.5">
        <span className="nc-ping absolute inset-0 rounded-full bg-coral" />
        <span className="absolute inset-0 rounded-full bg-coral" />
      </span>
      {label}
      <span className="h-0.5 flex-1 rounded-full bg-coral" />
    </div>
  );
}

export type DayPart = 'morning' | 'afternoon' | 'evening';
/** Same parts of the day as the phone app (decision 050). */
export const dayPart = (d = new Date()): DayPart =>
  d.getHours() < 12 ? 'morning' : d.getHours() < 17 ? 'afternoon' : 'evening';

/**
 * v28: the sunrise greeting (same idea as the phone app's card): date and time, "Good morning,
 * Priya", a summary line and a few chips. Evening shows a moon.
 */
export function Hero({
  name,
  line,
  chips = [],
  right,
  part = dayPart(),
  now = new Date(),
}: {
  name: string | null;
  line?: ReactNode;
  chips?: ReactNode[];
  right?: ReactNode;
  part?: DayPart;
  now?: Date;
}) {
  const { t } = useTranslation();
  const when = `${now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' }).replace(',', '')} · ${now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
  const first = name?.trim().split(/\s+/)[0];
  const who = first && /^dr\.?$/i.test(first) ? name!.trim() : first;
  return (
    <section
      className="nc-fu nc-hero relative flex min-h-[150px] flex-wrap items-center gap-4 overflow-hidden rounded-[28px] px-6 py-5 sm:px-7"
      data-testid="hero"
      data-part={part}
    >
      <span
        aria-hidden
        className={`nc-rise absolute size-[104px] rounded-full ${part === 'evening' ? 'nc-moon' : 'nc-sun'}`}
        style={{ right: right ? 360 : 120, top: part === 'afternoon' ? 18 : 34 }}
      />
      <span
        aria-hidden
        className="absolute -right-[8%] -bottom-[78px] -left-[8%] h-[130px] rounded-[50%] bg-hill"
      />
      <span
        aria-hidden
        className="absolute -right-[6%] -bottom-[96px] h-[140px] w-[60%] rounded-[50%] bg-hill"
      />
      <div className="relative flex min-w-[260px] flex-1 flex-col gap-1.5">
        <span className="text-[13px] font-semibold text-sub">{when}</span>
        <h1 className="text-[28px] leading-9 font-extrabold tracking-[-0.4px] sm:text-[32px] sm:leading-[38px]">
          {who ? t(`hero.${part}Name`, { name: who }) : t(`hero.${part}`)}
        </h1>
        {line && <span className="text-[15px] text-sub">{line}</span>}
        {chips.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-2">
            {chips.map((c, i) => (
              <span
                key={i}
                className="rounded-2xl bg-glass px-3 py-1.5 text-[13px] font-semibold whitespace-nowrap"
              >
                {c}
              </span>
            ))}
          </div>
        )}
      </div>
      {right && (
        <div className="relative w-full rounded-[20px] bg-glass px-4 py-3.5 text-[13px] backdrop-blur sm:w-[300px]">
          {right}
        </div>
      )}
    </section>
  );
}

export function fmt(iso: string | null | undefined): string {
  return iso
    ? new Date(iso).toLocaleString('en-IN', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';
}

export function fmtDate(iso: string | null | undefined): string {
  return iso
    ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    : '';
}

/**
 * v15: a dialog over the page (the list underneath stays where it was). Closes with ✕, Esc or a
 * click outside; with unsaved choices (`dirty`) it asks first. Focus stays inside while open and
 * returns to the button that opened it. On a narrow window it fills the screen.
 */
export function Dialog({
  title,
  sub,
  size = 'md',
  dirty = false,
  onClose,
  children,
  testId,
}: {
  title: string;
  sub?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'side';
  dirty?: boolean;
  onClose: () => void;
  children: ReactNode;
  testId?: string;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  const leaving = useRef(false);
  useEffect(() => {
    const d = ref.current;
    opener.current = document.activeElement;
    leaving.current = false;
    if (d && !d.open) d.showModal();
    return () => {
      leaving.current = true;
      d?.close();
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
  }, []);
  const close = () => {
    if (dirty && !globalThis.confirm(t('app.discard'))) return;
    onClose();
  };
  const width = {
    sm: 'sm:max-w-[540px]',
    md: 'sm:max-w-[760px]',
    lg: 'sm:max-w-[1040px]',
    // v28: a panel along the right edge (the page stays visible on the left).
    side: 'sm:mr-0 sm:ml-auto sm:h-full sm:max-h-none sm:w-[440px] sm:max-w-[440px] sm:rounded-none sm:rounded-l-[28px]',
  }[size];
  return (
    <dialog
      ref={ref}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClose={() => {
        // The browser may close it on Esc even when asked not to: keep it open until the page
        // closes it (after "Discard?" is answered).
        if (!leaving.current) ref.current?.showModal();
      }}
      onClick={(e) => {
        if (e.target === ref.current) close();
      }}
      className={`m-0 h-full max-h-none w-full max-w-none bg-card p-0 text-ink backdrop:bg-[#0f0e17]/45 backdrop:backdrop-blur-[2px] sm:m-auto sm:h-auto sm:max-h-[90vh] sm:w-[calc(100%-48px)] sm:rounded-[28px] sm:shadow-[0_30px_80px_rgb(0_0_0/0.3)] ${width}`}
      data-testid={testId}
    >
      <div
        className={`flex h-full max-h-full flex-col ${size === 'side' ? '' : 'sm:max-h-[90vh]'}`}
      >
        <div className="flex items-start gap-3 border-b border-line px-6 pt-5 pb-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-[21px] font-extrabold tracking-[-0.2px]">{title}</h2>
            {sub && <span className="text-[13px] text-muted">{sub}</span>}
          </div>
          <button
            type="button"
            onClick={close}
            aria-label={t('app.close')}
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-soft text-[16px] text-muted"
            data-testid="dialog-close"
          >
            ✕
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">
          {children}
        </div>
      </div>
    </dialog>
  );
}

/** The buttons at the bottom of a dialog: stay visible while the content scrolls. */
export function DialogFooter({ children }: { children: ReactNode }) {
  return (
    <div className="sticky bottom-[-20px] -mx-6 -mb-5 mt-auto flex flex-wrap items-end gap-3 border-t border-line bg-card px-6 py-3.5">
      {children}
    </div>
  );
}
