import {
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from './api.ts';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
const variants: Record<Variant, string> = {
  primary: 'bg-brand text-white disabled:bg-[#DDE1E7] disabled:text-muted',
  secondary: 'border border-[#C9CFD8] bg-white text-ink disabled:opacity-50',
  ghost: 'bg-transparent text-brand disabled:opacity-50',
  danger: 'bg-[#E5484D] text-white disabled:opacity-50',
};

export function Button({
  variant = 'primary',
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      {...rest}
      className={`min-h-11 rounded-xl px-4 text-[14px] font-semibold ${variants[variant]} ${className}`}
    />
  );
}

export function Field({
  label,
  id,
  ...rest
}: { label: string; id: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label htmlFor={id} className="flex flex-col gap-1 text-[13px] font-semibold text-[#3D4552]">
      {label}
      <input
        id={id}
        {...rest}
        className="h-11 rounded-xl border border-[#C9CFD8] bg-white px-3 text-[14px] font-normal text-ink"
      />
    </label>
  );
}

export function Card({
  title,
  children,
  className = '',
  testId,
}: {
  title?: string;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <section
      className={`flex flex-col gap-3 rounded-2xl border border-line bg-white p-5 ${className}`}
      data-testid={testId}
    >
      {title && <h2 className="text-[17px] font-bold">{title}</h2>}
      {children}
    </section>
  );
}

export function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-w-0 flex-1 flex-col gap-5 px-8 py-7">
      <h1 className="text-[26px] font-bold">{title}</h1>
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
    ok: 'bg-ok-soft text-[#145F38]',
    warn: 'bg-warn-soft text-warn',
    bad: 'bg-[#FDECEA] text-bad',
  }[tone];
  return (
    <p
      className={`rounded-xl px-3.5 py-2.5 text-[14px] leading-5 ${c}`}
      data-testid={testId}
      role={tone === 'bad' ? 'alert' : undefined}
    >
      {children}
    </p>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (!error) return null;
  const code =
    error instanceof ApiError ? error.code : error instanceof Error ? error.message : 'generic';
  const key = `errors.${code}`;
  const text = t(key);
  return <Notice tone="bad">{text === key ? t('errors.generic') : text}</Notice>;
}

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'ok' | 'warn' | 'bad' | 'neutral';
  children: ReactNode;
}) {
  const c = {
    ok: 'bg-ok-soft text-[#145F38]',
    warn: 'bg-warn-soft text-warn',
    bad: 'bg-[#FDECEA] text-bad',
    neutral: 'bg-[#EDF0F3] text-[#3D4552]',
  }[tone];
  return (
    <span className={`inline-block rounded-xl px-2.5 py-0.5 text-[12px] font-semibold ${c}`}>
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
    <div className="overflow-x-auto rounded-2xl border border-line bg-white">
      <table className="w-full min-w-[640px] border-collapse text-[14px]" data-testid={testId}>
        <thead>
          <tr className="text-left text-[13px] text-muted">
            {head.map((h, i) => (
              <th key={i} className="px-4 py-3 font-semibold">
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
  size?: 'sm' | 'md' | 'lg';
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
  const width = { sm: 'sm:max-w-[540px]', md: 'sm:max-w-[760px]', lg: 'sm:max-w-[1040px]' }[size];
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
      className={`m-0 h-full max-h-none w-full max-w-none bg-white p-0 text-ink backdrop:bg-[#14181F]/45 sm:m-auto sm:h-auto sm:max-h-[90vh] sm:w-[calc(100%-48px)] sm:rounded-2xl sm:shadow-2xl ${width}`}
      data-testid={testId}
    >
      <div className="flex h-full max-h-full flex-col sm:max-h-[90vh]">
        <div className="flex items-start gap-3 border-b border-line px-6 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-[19px] font-bold">{title}</h2>
            {sub && <span className="text-[13px] text-muted">{sub}</span>}
          </div>
          <button
            type="button"
            onClick={close}
            aria-label={t('app.close')}
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-line text-[18px] text-muted"
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
    <div className="sticky bottom-[-20px] -mx-6 -mb-5 mt-auto flex flex-wrap items-end gap-3 border-t border-line bg-[#FBFCFD] px-6 py-3.5">
      {children}
    </div>
  );
}
