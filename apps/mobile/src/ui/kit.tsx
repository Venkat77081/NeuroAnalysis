import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

// v31 (decision 055): Horizon+ pills: the brand gradient, a lined card colour, plain text.
const variants: Record<Variant, string> = {
  primary: 'nc-gradient text-white shadow-[0_8px_20px_rgb(79_70_229/0.3)]',
  secondary: 'bg-card text-ink shadow-[inset_0_0_0_1.5px_var(--color-edge)] disabled:opacity-50',
  ghost: 'bg-transparent text-brand-ink disabled:opacity-50',
  danger: 'bg-alert text-white disabled:opacity-50',
};

/** Large touch targets (≥ 48 px, DEV_PLAN §4); 52 px pills in the v31 look. */
export function Button({
  variant = 'primary',
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      {...rest}
      className={`flex min-h-[52px] items-center justify-center rounded-full px-5 text-[16px] font-bold disabled:cursor-not-allowed ${variants[variant]} ${className}`}
    />
  );
}

export function BackButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="-ml-2 flex size-12 items-center justify-center rounded-full"
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
    <section {...rest} className={`rounded-3xl bg-card p-4 shadow-card ${className}`}>
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
      className="fixed inset-0 z-20 flex flex-col justify-end bg-[#0f0e17]/55 pt-[var(--sat)]"
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
        className="mx-auto flex max-h-[88vh] w-full max-w-md flex-col gap-3 overflow-y-auto rounded-t-[28px] bg-card px-5 pt-3 pb-[calc(1.5rem+var(--sab))]"
      >
        <span className="mx-auto h-1.5 w-10 rounded-full bg-edge" aria-hidden="true" />
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
      className={`flex min-h-[52px] items-center gap-3 rounded-2xl px-3.5 text-[15px] ${checked ? 'bg-brand-soft font-semibold text-brand-ink shadow-[inset_0_0_0_2px_var(--color-brand)]' : 'bg-soft'}`}
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
