import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const variants: Record<Variant, string> = {
  primary: 'bg-brand text-white disabled:bg-[#DDE1E7] disabled:text-muted',
  secondary: 'border border-[#C9CFD8] bg-white text-ink disabled:opacity-50',
  ghost: 'bg-transparent text-brand disabled:opacity-50',
  danger: 'bg-[#E5484D] text-white disabled:opacity-50',
};

/** Large touch targets (≥ 48 px, DEV_PLAN §4). */
export function Button({
  variant = 'primary',
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      {...rest}
      className={`flex min-h-12 items-center justify-center rounded-2xl px-4 text-[16px] font-semibold disabled:cursor-not-allowed ${variants[variant]} ${className}`}
    />
  );
}

export function BackButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="-ml-2 flex size-11 items-center justify-center rounded-full"
    >
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M15 5l-7 7 7 7" />
      </svg>
    </button>
  );
}

export function Card({
  children,
  className = '',
  ...rest
}: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLElement>) {
  return (
    <section {...rest} className={`rounded-2xl border border-line bg-white p-4 ${className}`}>
      {children}
    </section>
  );
}

/** Bottom sheet dialog over a dimmed screen. */
export function Sheet({
  title,
  children,
  onClose,
  testId,
}: {
  title: string;
  children: ReactNode;
  onClose?: () => void;
  testId?: string;
}) {
  return (
    <div
      className="fixed inset-0 z-20 flex flex-col justify-end bg-[#14181F]/55 pt-[var(--sat)]"
      data-testid={testId}
    >
      <button
        type="button"
        aria-label="close"
        className="flex-1 cursor-default"
        onClick={onClose}
        tabIndex={-1}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="mx-auto flex max-h-[88vh] w-full max-w-md flex-col gap-3 overflow-y-auto rounded-t-3xl bg-white px-5 pt-3 pb-[calc(1.5rem+var(--sab))]"
      >
        <span className="mx-auto h-1.5 w-10 rounded-full bg-[#C9CFD8]" aria-hidden="true" />
        <h2 className="m-0 text-[22px] font-bold">{title}</h2>
        {children}
      </section>
    </div>
  );
}

export function Radio({
  name,
  checked,
  onChange,
  label,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <label
      className={`flex min-h-12 items-center gap-3 rounded-xl border px-3.5 text-[15px] ${checked ? 'border-brand bg-brand-soft' : 'border-[#C9CFD8] bg-white'}`}
    >
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onChange}
        className="size-5 accent-brand"
      />
      {label}
    </label>
  );
}

export function Check() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12l5 5L20 7" />
    </svg>
  );
}
