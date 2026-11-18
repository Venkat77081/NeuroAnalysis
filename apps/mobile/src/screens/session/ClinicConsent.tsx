/**
 * v16 (decision 047): consent before a clinic recording.
 *
 * - The patient shows the QR code from their app; this phone scans it (or the operator types the
 *   code printed below it). The platform checks: this request, today, not used, not withdrawn.
 * - Without the app (when the hospital allows it): the patient reads and agrees on this phone,
 *   and the operator picks why it was not done in the app.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApp } from '../../app/AppContext.tsx';
import { capture } from '../../lib/capture.ts';
import { errorCode } from '../../lib/accounts.ts';
import {
  phoneConsent,
  scanConsent,
  type ConfirmedConsent,
  type QueueItem,
} from '../../lib/clinic.ts';
import { QrScanner } from '../patient/QrScanner.tsx';
import { Button, Card } from '../../ui/kit.tsx';

export function ConsentScan({
  q,
  onConfirmed,
  onPhone,
  onCancel,
}: {
  q: QueueItem;
  onConfirmed: (c: ConfirmedConsent) => void;
  /** The patient cannot show the code: consent on this phone (when allowed). */
  onPhone: (() => void) | null;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [scanning, setScanning] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = async (text: string) => {
    setScanning(false);
    setBusy(true);
    setError(null);
    try {
      onConfirmed(await scanConsent(capture.kit, q.request_id, text));
    } catch (e) {
      setError(errorCode(e));
    }
    setBusy(false);
  };
  if (scanning)
    return (
      <QrScanner
        hint={t('clinicConsent.scanHint')}
        onResult={(text) => void check(text)}
        onClose={() => setScanning(false)}
      />
    );
  return (
    <div className="flex flex-col gap-3" data-testid="consent-scan">
      <h1 className="m-0 text-[24px] leading-8 font-bold">{t('clinicConsent.scan')}</h1>
      <span className="text-[14px] text-[#3D4552]">
        {q.name ?? q.mrn ?? ''} ·{' '}
        {q.consent?.state === 'app_given' ? t('clinicConsent.given') : t('clinicConsent.waiting')}
      </span>
      {/* New UI (decision 050): a viewfinder to tap; the camera opens full screen to scan. */}
      <button
        type="button"
        disabled={busy}
        onClick={() => setScanning(true)}
        className="relative flex h-64 items-center justify-center overflow-hidden rounded-2xl bg-[#1D232C]"
        data-testid="consent-scan-camera"
      >
        <span className="size-44 rounded-2xl border-[3px] border-white shadow-[0_0_0_999px_rgba(0,0,0,0.35)]" />
        <span className="nc-scanline absolute inset-x-[30%] h-[3px] bg-[#6EE7A0]" />
        <span className="absolute bottom-3 text-[13px] text-white">
          {t('clinicConsent.scanHint')}
        </span>
      </button>
      <label className="flex flex-col gap-1 text-[13px] font-semibold text-[#3D4552]">
        {t('clinicConsent.typeCode')}
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoCapitalize="characters"
          className="h-11 rounded-xl border border-[#C9CFD8] bg-white px-3 font-mono text-[15px] tracking-wider"
          data-testid="consent-code"
        />
      </label>
      <Button
        variant="secondary"
        disabled={busy || code.replace(/[^A-Za-z0-9]/g, '').length < 6}
        onClick={() => void check(code)}
        data-testid="consent-code-check"
      >
        {t('clinicConsent.checkCode')}
      </Button>
      {error && (
        <p
          role="alert"
          className="rounded-xl bg-[#FDECEA] px-3 py-2 text-[14px] text-bad"
          data-testid="consent-error"
        >
          {t(`clinicConsent.error.${error}`, { defaultValue: t('modes.errors.generic') })}
        </p>
      )}
      {onPhone && (
        <Button variant="ghost" onClick={onPhone} data-testid="consent-phone-open">
          {t('clinicConsent.cannotShow')}
        </Button>
      )}
      <Button variant="secondary" onClick={onCancel}>
        {t('common.cancel')}
      </Button>
    </div>
  );
}

export function PhoneConsent({
  q,
  onConfirmed,
  onCancel,
}: {
  q: QueueItem;
  onConfirmed: (c: ConfirmedConsent) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const { config } = useApp();
  const [reason, setReason] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      onConfirmed(
        await phoneConsent(capture.kit, q.request_id, reason!, config.session.consentVersion),
      );
    } catch (e) {
      setError(errorCode(e));
    }
    setBusy(false);
  };
  return (
    <Card className="flex flex-col gap-2.5" data-testid="consent-phone">
      <b className="text-[16px]">
        {t('clinicConsent.phoneTitle', { name: q.name ?? q.mrn ?? '' })}
      </b>
      {!shown ? (
        <>
          <span className="text-[14px] font-semibold">{t('clinicConsent.whyNotApp')}</span>
          <div className="flex flex-wrap gap-1.5" role="group">
            {config.platform.clinicConsent.fallbackReasons.map((r) => (
              <Button
                key={r}
                variant={reason === r ? 'primary' : 'secondary'}
                className="!h-11 !px-3 !text-[13px]"
                onClick={() => setReason(r)}
                data-testid={`consent-reason-${r}`}
              >
                {t(`clinicConsent.reason.${r}`)}
              </Button>
            ))}
          </div>
          <Button
            disabled={!reason}
            onClick={() => setShown(true)}
            data-testid="consent-phone-show"
          >
            {t('clinicConsent.showToPatient')}
          </Button>
        </>
      ) : (
        <>
          <p className="text-[15px] leading-[22px]" data-testid="consent-phone-text">
            {t('clinicConsent.text', { count: q.tests.length })}
          </p>
          <span className="text-[12px] text-muted">
            {t('clinicConsent.version', { version: config.session.consentVersion })}
          </span>
          <label className="flex items-center gap-3 text-[15px]">
            <input
              type="checkbox"
              checked={agree}
              onChange={(e) => setAgree(e.target.checked)}
              className="size-6 accent-brand"
              data-testid="consent-phone-agree"
            />
            {t('clinicConsent.agree')}
          </label>
          <Button
            disabled={!agree || busy}
            onClick={() => void confirm()}
            data-testid="consent-phone-confirm"
          >
            {t('clinicConsent.agreeButton')}
          </Button>
        </>
      )}
      {error && (
        <p role="alert" className="rounded-xl bg-[#FDECEA] px-3 py-2 text-[14px] text-bad">
          {t(`clinicConsent.error.${error}`, { defaultValue: t('modes.errors.generic') })}
        </p>
      )}
      <Button variant="secondary" onClick={onCancel}>
        {t('common.cancel')}
      </Button>
    </Card>
  );
}
