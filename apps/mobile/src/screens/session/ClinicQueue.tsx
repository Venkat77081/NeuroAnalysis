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
import { canRecord, clinicQueue, notRecorded, type QueueItem } from '../../lib/clinic.ts';
import { newId } from '../../data/repo.ts';
import { stepTitle } from './TestIntro.tsx';
import { Button, Card } from '../../ui/kit.tsx';

const time = (iso: string, lang: string) =>
  new Date(iso).toLocaleTimeString(lang === 'hi' ? 'hi-IN' : 'en-IN', {
    hour: '2-digit',
    minute: '2-digit',
  });

export function ClinicQueue() {
  const { t, i18n } = useTranslation();
  const { config, repo, startClinicRequest } = useApp();
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
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

  const start = async (q: QueueItem) => {
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
    });
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
  return (
    <section className="flex flex-col gap-2" data-testid="clinic-queue">
      <div className="flex items-baseline justify-between">
        <h2 className="m-0 text-[17px] font-bold">{t('clinicQueue.title')}</h2>
        <button
          type="button"
          onClick={reload}
          className="min-h-11 px-2 text-[13px] font-semibold text-brand"
        >
          {t('clinicQueue.refresh')}
        </button>
      </div>
      <span className="text-[12px] font-semibold text-ok">{t('clinicQueue.live')}</span>
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
      {items.map((q) => {
        const steps = config.session.order.filter(([code]) => q.tests.includes(code));
        const open = q.state === 'open';
        return (
          <Card
            key={q.request_id}
            className={`flex flex-col gap-1.5 ${open ? '' : 'opacity-75'}`}
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
                    disabled={!ready}
                    onClick={() => void start(q)}
                    data-testid="queue-start"
                  >
                    {t('clinicQueue.start')}
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
      })}
      {error && (
        <p role="alert" className="text-[13px] text-bad">
          {t(`modes.errors.${error}`, { defaultValue: t('modes.errors.generic') })}
        </p>
      )}
    </section>
  );
}
