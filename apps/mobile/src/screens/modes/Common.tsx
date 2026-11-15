/** Shared pieces of the M13 sign-in and set-up screens. */
import type { InputHTMLAttributes, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { errorCode } from '../../lib/accounts.ts';

export function Screen({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col gap-4 bg-ground px-5 pt-6 pb-6">
      <h1 className="text-[24px] leading-8 font-bold">{title}</h1>
      {children}
    </div>
  );
}

export function Field({
  label,
  id,
  ...rest
}: { label: string; id: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label htmlFor={id} className="flex flex-col gap-1.5 text-[14px] font-semibold">
      {label}
      <input
        id={id}
        {...rest}
        className="h-12 rounded-xl border border-[#C9CFD8] bg-white px-3 text-[16px] font-normal"
      />
    </label>
  );
}

export function ErrorText({ code }: { code: string | null }) {
  const { t } = useTranslation();
  if (!code) return null;
  const key = `modes.errors.${code}`;
  const text = t(key);
  return (
    <p role="alert" className="rounded-xl bg-[#FDECEA] px-3 py-2 text-[14px] text-bad">
      {text === key ? t('modes.errors.generic') : text}
    </p>
  );
}

/** Runs an async action with a busy flag and an error code for <ErrorText>. */
export async function attempt(
  setBusy: (b: boolean) => void,
  setError: (c: string | null) => void,
  fn: () => Promise<void>,
): Promise<void> {
  setBusy(true);
  setError(null);
  try {
    await fn();
  } catch (e) {
    setError(errorCode(e));
  } finally {
    setBusy(false);
  }
}
