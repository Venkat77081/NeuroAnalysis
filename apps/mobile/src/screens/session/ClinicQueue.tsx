/**
 * Clinic phones: today's clinic queue (user, 16 Nov 2026). Each entry is a doctor's request to
 * record a patient at the visit: name and MRN (live from the hospital), time, doctor, tests and
 * medicine state. Tapping one fills in the session; the operator still confirms consent. "Not
 * recorded" asks for a reason.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApp } from '../../app/AppContext.tsx';
import { capture } from '../../lib/capture.ts';
import { errorCode } from '../../lib/accounts.ts';
import {
  canRecord,
  clinicQueue,
  notRecorded,
  type ConfirmedConsent,
  type QueueItem,
} from '../../lib/clinic.ts';
import { ConsentScan, PhoneConsent } from './ClinicConsent.tsx';
import { newId } from '../../data/repo.ts';
import { stepTitle } from './TestIntro.tsx';
import { Button, Card } from '../../ui/kit.tsx';

const time = (iso: string, lang: string) =>
  new Date(iso).toLocaleTimeString(lang === 'hi' ? 'hi-IN' : 'en-IN', {
    hour: '2-digit',
    minute: '2-digit',
  });

export function ClinicQueue({
  onFocus,
}: {
  /** New UI: consent takes the whole screen; the home screen hides everything else. */
  onFocus?: (focused: boolean) => void;
} = {}) {
  const { t, i18n } = useTranslation();
  const { config, repo, startClinicRequest } = useApp();
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  /** v16: the request whose consent is being confirmed (QR scan, or on this phone). */
  const [consenting, setConsenting] = useState<{ id: string; how: 'scan' | 'phone' } | null>(null);
  useEffect(() => {
    onFocus?.(!!consenting);
    return () => onFocus?.(false);
  }, [consenting, onFocus]);
  const [version, setVersion] = useState(0);
  /** Decision 044: the hospital's own storage must be connected before anyone records. */
  const [ready, setReady] = useState(true);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let off = false;
    clinicQueue(capture.kit).then(
      (q) => !off && setItems(q),
      (e: unknown) => !off && setError(errorCode(e)),
    );
    void canRecord(capture.kit).then((r) => !off && setReady(r.canRecord));
    return () => {
      off = true;
    };
  }, [version]);

  const start = async (q: QueueItem, consent?: ConfirmedConsent) => {
    // The MRN stays on this phone (as for any clinic patient); the server gets the NCID only.
    const patient = {
      localId: newId('p'),
      ref: q.mrn ?? q.ncid,
      yearOfBirth: null,
      sex: null,
      ncid: q.ncid,
    };
    await repo.savePatient(patient);
    await startClinicRequest({
      tests: q.tests,
      requestId: q.request_id,
      patient,
      medState: q.med_state === 'ANY' ? null : q.med_state,
      consent: consent
        ? {
            id: consent.consent_id,
            at: consent.agreed_at,
            version: consent.consent_version,
            source: consent.source,
          }
        : null,
    });
  };
  /** v16 (decision 047): the first step for each patient: scan their QR, or consent here. */
  const begin = (q: QueueItem) => {
    if (!q.consent) return void start(q); // an older server: the operator ticks consent
    setConsenting({ id: q.request_id, how: q.consent.state === 'no_app' ? 'phone' : 'scan' });
  };
  const skip = async (q: QueueItem, reason: string) => {
    setError(null);
    try {
      await notRecorded(capture.kit, q.request_id, reason);
      setAsking(null);
      reload();
    } catch (e) {
      setError(errorCode(e));
    }
  };

  if (error && !items)
    return (
      <p role="alert" className="text-[13px] text-bad">
        {t(`modes.errors.${error}`, { defaultValue: t('modes.errors.generic') })}
      </p>
    );
  if (!items) return null;
  /** Done today (recorded or not): a short row with its state. */
  const row = (q: QueueItem) => (
    <div
      key={q.request_id}
      className="flex items-center justify-between gap-2 rounded-xl border border-line bg-white px-3.5 py-2.5 text-[14px]"
      data-testid="queue-item"
    >
      <span className="min-w-0">
        <b className="tabular-nums">{time(q.at, i18n.language)}</b> ·{' '}
        <span data-testid="queue-name">{q.name ?? q.mrn ?? '—'}</span>
      </span>
      <span
        className={`text-[12px] font-bold whitespace-nowrap ${q.state === 'recorded' ? 'text-ok' : 'text-bad'}`}
        data-testid="queue-state"
      >
        {t(`clinicQueue.state.${q.state}`, {
          reason: q.not_done_reason ? t(`clinicQueue.reason.${q.not_done_reason}`) : '',
        })}
      </span>
    </div>
  );
  const card = (q: QueueItem, wide: boolean) => {
    const steps = config.session.order.filter(([code]) => q.tests.includes(code));
    const open = q.state === 'open';
    return (
      <Card
        key={q.request_id}
        className={`nc-fade-up flex flex-col gap-1.5 ${open ? '' : 'opacity-75'} ${wide ? 'w-[86%] max-w-[340px] flex-none snap-start' : ''}`}
        data-testid="queue-item"
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[16px] font-bold" data-testid="queue-name">
            {q.name ?? t('clinicQueue.noName')}
          </span>
          <span className="text-[13px] font-semibold">{time(q.at, i18n.language)}</span>
        </div>
        <span className="text-[13px] text-muted">
          {[q.mrn ? `MRN ${q.mrn}` : null, q.doctor_name].filter(Boolean).join(' · ')}
        </span>
        <span className="text-[13px] text-muted">
          {steps.map(([code, side]) => stepTitle(t, code, side)).join(', ')} ·{' '}
          {t(`clinicQueue.med.${q.med_state}`)}
        </span>
        {open && q.consent && (
          <span
            className={`self-start rounded-xl px-2.5 py-0.5 text-[12px] font-semibold ${
              q.consent.state === 'app_given'
                ? 'bg-[#E3F4EA] text-[#145F38]'
                : q.consent.state === 'waiting'
                  ? 'bg-[#FDF0DD] text-[#8A4B00]'
                  : 'bg-[#EDF0F3] text-[#3D4552]'
            }`}
            data-testid="queue-consent"
          >
            {t(`clinicConsent.state.${q.consent.state}`)}
          </span>
        )}
        {open ? (
          asking === q.request_id ? (
            <div className="flex flex-col gap-1.5" data-testid="queue-reasons">
              <span className="text-[13px] font-semibold">{t('clinicQueue.why')}</span>
              <div className="flex flex-wrap gap-1.5">
                {config.platform.requests.clinicNotDoneReasons.map((r) => (
                  <Button
                    key={r}
                    variant="secondary"
                    className="!h-11 !px-3 !text-[13px]"
                    onClick={() => void skip(q, r)}
                    data-testid={`reason-${r}`}
                  >
                    {t(`clinicQueue.reason.${r}`)}
                  </Button>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button
                className="flex-1"
                disabled={!ready || (q.consent?.state === 'no_app' && !q.consent.phone_allowed)}
                onClick={() => begin(q)}
                data-testid="queue-start"
              >
                {!q.consent
                  ? t('clinicQueue.start')
                  : q.consent.state === 'no_app'
                    ? t('clinicConsent.onPhone')
                    : t('clinicConsent.scan')}
              </Button>
              <Button
                variant="secondary"
                onClick={() => setAsking(q.request_id)}
                data-testid="queue-skip"
              >
                {t('clinicQueue.notRecorded')}
              </Button>
            </div>
          )
        ) : (
          <span
            className={`text-[13px] font-semibold ${q.state === 'recorded' ? 'text-ok' : 'text-bad'}`}
            data-testid="queue-state"
          >
            {t(`clinicQueue.state.${q.state}`, {
              reason: q.not_done_reason ? t(`clinicQueue.reason.${q.not_done_reason}`) : '',
            })}
          </span>
        )}
      </Card>
    );
  };
  const openItems = items.filter((q) => q.state === 'open');
  const doneItems = items.filter((q) => q.state !== 'open');
  const cq = consenting && items.find((q) => q.request_id === consenting.id);
  if (cq && consenting)
    // New UI (decision 050): consent on its own screen, with the way back to the queue.
    return (
      <section className="nc-fade-up flex flex-col gap-3" data-testid="clinic-queue">
        <button
          type="button"
          onClick={() => setConsenting(null)}
          className="min-h-11 self-start text-[14px] font-semibold text-brand"
        >
          ‹ {t('clinicQueue.backToQueue')}
        </button>
        {consenting.how === 'scan' ? (
          <ConsentScan
            q={cq}
            onConfirmed={(c) => {
              setConsenting(null);
              void start(cq, c);
            }}
            onPhone={
              cq.consent?.phone_allowed
                ? () => setConsenting({ id: cq.request_id, how: 'phone' })
                : null
            }
            onCancel={() => setConsenting(null)}
          />
        ) : (
          <PhoneConsent
            q={cq}
            onConfirmed={(c) => {
              setConsenting(null);
              void start(cq, c);
            }}
            onCancel={() => setConsenting(null)}
          />
        )}
      </section>
    );
  return (
    <section className="flex flex-col gap-2" data-testid="clinic-queue">
      <div className="flex items-baseline justify-between">
        <h2 className="m-0 text-[15px] font-semibold text-muted">
          {t('clinicQueue.toRecord', { count: openItems.length })}
        </h2>
        <button
          type="button"
          onClick={reload}
          className="min-h-11 px-2 text-[13px] font-semibold text-brand"
        >
          {t('clinicQueue.refresh')}
        </button>
      </div>
      {!ready && (
        <p
          role="alert"
          className="rounded-xl bg-[#FDECEA] px-3 py-2.5 text-[14px] leading-5 text-bad"
          data-testid="queue-not-ready"
        >
          {t('clinicQueue.notReady')}
        </p>
      )}
      {items.length === 0 && (
        <span className="text-[14px] text-muted" data-testid="queue-empty">
          {t('clinicQueue.empty')}
        </span>
      )}
      {/* New UI: open patients as swipe cards; recorded or not-recorded ones as a list. */}
      {openItems.length > 0 && (
        <div className="-mx-5 flex snap-x snap-mandatory scroll-px-5 gap-3 overflow-x-auto px-5 pb-1">
          {openItems.map((q) => card(q, openItems.length > 1))}
        </div>
      )}
      {doneItems.length > 0 && (
        <>
          <h3 className="m-0 mt-2 text-[15px] font-bold">{t('clinicQueue.today')}</h3>
          {doneItems.map(row)}
        </>
      )}
      <span className="mt-1 text-[12px] font-semibold text-ok">{t('clinicQueue.live')}</span>
      {error && (
        <p role="alert" className="text-[13px] text-bad">
          {t(`modes.errors.${error}`, { defaultValue: t('modes.errors.generic') })}
        </p>
      )}
    </section>
  );
}
