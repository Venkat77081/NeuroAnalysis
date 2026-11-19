/**
 * Reset a staff member's sign-in (decision 039): pick a reason, the person is signed out
 * everywhere and gets an e-mail with a link to choose a new password and set up the authenticator
 * again. If the e-mail could not be sent, the link is shown once to hand over in person.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { call } from './api.ts';
import { staffReset } from './config.ts';
import { Button, ErrorNote, Notice } from './ui.tsx';

interface ResetOut {
  sent: boolean;
  link: string | null;
  expires_at: string;
}

export function ResetSignIn({
  url,
  name,
  email,
  testId,
}: {
  /** POST endpoint, e.g. /hospital/staff/{id}/reset-sign-in */
  url: string;
  name: string;
  email: string;
  testId?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState(staffReset.resetReasons[0]!);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<ResetOut | null>(null);
  const [copied, setCopied] = useState(false);

  const reset = async () => {
    setBusy(true);
    setError(null);
    try {
      setDone(await call<ResetOut>('POST', url, { reason }));
      setOpen(false);
    } catch (e) {
      setError(e);
    }
    setBusy(false);
  };

  if (done)
    return done.sent ? (
      <Notice testId="reset-sent">
        {t('reset.sent', { email, hours: staffReset.resetTtlHours })}
      </Notice>
    ) : (
      <div className="flex w-full flex-col gap-2" data-testid="reset-link">
        <Notice tone="warn">{t('reset.notSent', { name })}</Notice>
        <div className="flex flex-wrap items-center gap-2">
          <code className="max-w-full overflow-x-auto rounded-lg bg-ground px-2 py-1 text-[12px]">
            {done.link}
          </code>
          <Button
            variant="secondary"
            onClick={() =>
              void navigator.clipboard?.writeText(done.link ?? '').then(() => setCopied(true))
            }
          >
            {copied ? t('reset.copied') : t('reset.copy')}
          </Button>
        </div>
      </div>
    );

  if (!open)
    return (
      <Button variant="ghost" onClick={() => setOpen(true)} data-testid={testId}>
        {t('reset.button')}
      </Button>
    );

  return (
    <div
      className="flex w-full flex-col gap-2 rounded-xl border border-line bg-card p-3"
      role="group"
      aria-label={t('reset.title', { name })}
      data-testid="reset-panel"
    >
      <b className="text-[15px]">{t('reset.title', { name })}</b>
      <span className="text-[13px] leading-[19px] text-sub">
        {t('reset.explain', { email, hours: staffReset.resetTtlHours })}
      </span>
      <label className="flex flex-col gap-1 text-[13px] font-semibold">
        {t('reset.reason')}
        <select
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="h-10 rounded-2xl border border-edge bg-card px-2 text-[14px] font-normal"
          data-testid="reset-reason"
        >
          {staffReset.resetReasons.map((r) => (
            <option key={r} value={r}>
              {t(`reset.reasons.${r}`)}
            </option>
          ))}
        </select>
      </label>
      <ErrorNote error={error} />
      <div className="flex gap-2">
        <Button variant="ghost" onClick={() => setOpen(false)}>
          {t('reset.cancel')}
        </Button>
        <Button disabled={busy} onClick={() => void reset()} data-testid="reset-confirm">
          {t('reset.confirm')}
        </Button>
      </div>
    </div>
  );
}
