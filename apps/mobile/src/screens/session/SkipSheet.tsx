import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cleanNote } from '../../session/machine.ts';
import { Button, Radio, Sheet } from '../../ui/kit.tsx';

/**
 * Skip a test, or end the session early, with a reason from config (free text required for
 * "other").
 */
export function SkipSheet({
  reasons,
  onCancel,
  onSkip,
  kind = 'skip',
}: {
  reasons: string[];
  onCancel: () => void;
  onSkip: (reason: string, note: string) => void;
  kind?: 'skip' | 'abort';
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const ok = !!reason && (reason !== 'other' || cleanNote(note) !== null);
  return (
    <Sheet title={t(`session.${kind}.title`)} onClose={onCancel} testId={`${kind}-sheet`}>
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-1 text-sm font-semibold">{t('session.keep.reason')}</legend>
        {reasons.map((r) => (
          <Radio
            key={r}
            name={kind}
            checked={reason === r}
            onChange={() => setReason(r)}
            label={t(`session.reasons.${kind}.${r}`)}
          />
        ))}
      </fieldset>
      {reason === 'other' && (
        <label className="flex flex-col gap-1 text-sm text-muted">
          {t('session.keep.note')}
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            className="resize-none rounded-xl border border-[#C9CFD8] p-3 text-[15px] text-ink"
          />
        </label>
      )}
      <div className="mt-2 flex gap-2">
        <Button variant="secondary" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button
          className="flex-1"
          disabled={!ok}
          onClick={() => reason && onSkip(reason, note)}
          data-testid={`confirm-${kind}`}
        >
          {t(`session.${kind}.confirm`)}
        </Button>
      </div>
    </Sheet>
  );
}
