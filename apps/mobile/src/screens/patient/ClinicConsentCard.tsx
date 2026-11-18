/**
 * v16 (decision 047): consent for a clinic recording, given in the app. Agreeing returns a
 * one-time code, shown as a QR (and in letters) for the clinic phone to scan; valid until the end
 * of the visit day. The code is kept on this phone only to show it again; withdrawing cancels it.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import QRCode from 'qrcode';
import { useApp } from '../../app/AppContext.tsx';
import { capture } from '../../lib/capture.ts';
import { errorCode } from '../../lib/accounts.ts';
import { hospitalApi, type PatientHospital, type PatientRequest } from '../../lib/hospitals.ts';
import { Button } from '../../ui/kit.tsx';
import { ErrorText } from '../modes/Common.tsx';

interface Saved {
  code: string;
  qr: string;
  valid_until: string;
}
const key = (h: PatientHospital, r: PatientRequest) => `clinic-consent.${h.profile}.${r.id}`;
const grouped = (code: string) => code.replace(/(.{4})(?=.)/g, '$1-');

export function ClinicConsentCard({ h, request }: { h: PatientHospital; request: PatientRequest }) {
  const { t, i18n } = useTranslation();
  const { repo, config } = useApp();
  const [saved, setSaved] = useState<Saved | null>(null);
  const [status, setStatus] = useState(request.clinic_consent?.status ?? null);
  const [view, setView] = useState<'card' | 'consent' | 'qr'>('card');
  const [agree, setAgree] = useState(false);
  const [img, setImg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void repo.store.get<Saved>(key(h, request)).then((s) => {
      if (s && Date.parse(s.valid_until) > Date.now()) setSaved(s);
    });
  }, [repo, h, request]);
  useEffect(() => {
    if (view === 'qr' && saved)
      void QRCode.toDataURL(saved.qr, { margin: 2, width: 512 }).then(setImg, () => setImg(null));
  }, [view, saved]);

  if (request.state !== 'open') return null;
  const until = saved
    ? new Date(saved.valid_until).toLocaleString(i18n.language === 'hi' ? 'hi-IN' : 'en-IN', {
        day: 'numeric',
        month: 'short',
        hour: 'numeric',
        minute: '2-digit',
      })
    : '';

  const give = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await hospitalApi<Saved>(
        capture.kit,
        h,
        'POST',
        `/patient/requests/${request.id}/clinic-consent`,
        { consent_version: config.session.consentVersion },
      );
      const s = { code: r.code, qr: r.qr, valid_until: r.valid_until };
      await repo.store.put(key(h, request), s);
      setSaved(s);
      setStatus('active');
      setView('qr');
    } catch (e) {
      setError(errorCode(e));
    }
    setBusy(false);
  };
  const withdraw = async () => {
    setBusy(true);
    setError(null);
    try {
      await hospitalApi(
        capture.kit,
        h,
        'POST',
        `/patient/requests/${request.id}/clinic-consent/withdraw`,
      );
      await repo.store.delete(key(h, request));
      setSaved(null);
      setStatus(null);
      setView('card');
    } catch (e) {
      setError(errorCode(e));
    }
    setBusy(false);
  };

  if (status === 'used')
    return (
      <span className="text-[14px] font-semibold text-[#145F38]" data-testid="clinic-consent-used">
        {t('clinicConsent.patient.used')}
      </span>
    );
  if (view === 'consent')
    return (
      <div className="mt-2 flex flex-col gap-2.5" data-testid="clinic-consent-form">
        <b className="text-[16px]">{t('clinicConsent.patient.title')}</b>
        <p className="text-[14px] leading-[21px] text-[#3D4552]">
          {t('clinicConsent.patient.text', { hospital: h.hospital, count: request.tests.length })}
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
            data-testid="clinic-consent-agree"
          />
          {t('clinicConsent.patient.agree')}
        </label>
        <ErrorText code={error} />
        <Button
          disabled={!agree || busy}
          onClick={() => void give()}
          data-testid="clinic-consent-give"
        >
          {t('clinicConsent.patient.give')}
        </Button>
        <Button variant="secondary" onClick={() => setView('card')}>
          {t('clinicConsent.patient.notNow')}
        </Button>
      </div>
    );
  if (view === 'qr' && saved)
    return (
      <div className="mt-2 flex flex-col items-center gap-2.5" data-testid="clinic-consent-qr">
        <b className="self-start text-[16px]">{t('clinicConsent.patient.showTitle')}</b>
        {img && (
          <img
            src={img}
            alt={t('clinicConsent.patient.qrAlt')}
            className="w-64 max-w-full rounded-xl bg-white"
          />
        )}
        <code className="text-[20px] font-bold tracking-widest" data-testid="clinic-consent-code">
          {grouped(saved.code)}
        </code>
        <span className="text-center text-[13px] text-muted">
          {t('clinicConsent.patient.validUntil', { until })}
        </span>
        <p className="rounded-xl bg-[#E6EFF8] px-3 py-2 text-[13px] text-[#0B4A85]">
          {t('clinicConsent.patient.noIdentity')}
        </p>
        <ErrorText code={error} />
        <Button
          variant="danger"
          disabled={busy}
          onClick={() => void withdraw()}
          data-testid="clinic-consent-withdraw"
        >
          {t('clinicConsent.patient.withdraw')}
        </Button>
        <Button variant="secondary" onClick={() => setView('card')}>
          {t('common.close')}
        </Button>
      </div>
    );
  return (
    <div className="mt-2 flex flex-col gap-2">
      {status === 'active' && saved ? (
        <>
          <span className="text-[14px] font-semibold text-[#145F38]">
            {t('clinicConsent.patient.given', { until })}
          </span>
          <Button onClick={() => setView('qr')} data-testid="clinic-consent-show">
            {t('clinicConsent.patient.show')}
          </Button>
        </>
      ) : (
        <>
          <span className="text-[14px] text-[#3D4552]">{t('clinicConsent.patient.ask')}</span>
          <Button onClick={() => setView('consent')} data-testid="clinic-consent-open">
            {t('clinicConsent.patient.open')}
          </Button>
        </>
      )}
    </div>
  );
}
