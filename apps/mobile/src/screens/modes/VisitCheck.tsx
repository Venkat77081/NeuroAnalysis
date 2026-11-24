/**
 * The quick check before a visit (decision 062): no camera, just free storage for this visit's
 * takes (on this phone's measured video size) and free memory. Too little storage stops the visit
 * from starting; low memory only asks to close other apps. The numbers go to the hospital(s) so
 * their Phones page stays current; that never blocks anything.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApp } from '../../app/AppContext.tsx';
import { reportPhone } from '../../lib/accounts.ts';
import { capture } from '../../lib/capture.ts';
import { gb, runVisitCheck, type VisitCheck as Result } from '../../lib/devicecheck.ts';
import { Button, Card } from '../../ui/kit.tsx';
import { CheckRow } from './DeviceCheck.tsx';

export function VisitCheck({
  seconds,
  onBlocked,
  profile,
}: {
  /** Each take's length in this visit. */
  seconds: readonly number[];
  /** True while the visit must not start (too little storage), and while checking. */
  onBlocked: (blocked: boolean) => void;
  /** Patient phones: the hospital this visit is for (its upload profile). */
  profile?: string;
}) {
  const { t } = useTranslation();
  const { config, settings } = useApp();
  const cfg = config.platform.deviceCheck;
  const startGb = config.session.storage?.minFreeGbToStart ?? 0;
  const [r, setR] = useState<Result | null>(null);
  const report = useRef(onBlocked);
  useEffect(() => {
    report.current = onBlocked;
  });
  const key = seconds.join(',');
  const online = !!(profile || (settings.signedIn && !settings.localDev));

  const run = useCallback(() => {
    report.current(true);
    void runVisitCheck(capture.kit, key ? key.split(',').map(Number) : [], cfg, startGb).then(
      (v) => {
        setR(v);
        report.current(v.blocked);
        if (online)
          void reportPhone(
            capture.kit,
            {
              kind: 'visit',
              ...(v.freeBytes !== null ? { storage_free_bytes: Math.round(v.freeBytes) } : {}),
              ...(v.memory?.availBytes != null
                ? { ram_free_bytes: Math.round(v.memory.availBytes) }
                : {}),
              ...(v.memory?.lowMemory != null ? { ram_low: v.memory.lowMemory } : {}),
            },
            profile,
          ).catch(() => undefined);
      },
      () => {
        // The phone could not tell: never stop a visit for that.
        setR(null);
        report.current(false);
      },
    );
  }, [key, cfg, startGb, online, profile]);

  useEffect(() => {
    run();
  }, [run]);

  if (!r)
    return (
      <Card className="flex flex-col gap-1" data-testid="visit-check" aria-busy="true">
        <span className="text-[14px] text-muted">{t('modes.deviceCheck.visit.checking')}</span>
      </Card>
    );
  const short = Math.max(startGb * 1e9, r.needBytes) - (r.freeBytes ?? 0);
  return (
    <Card
      className="flex flex-col gap-2"
      data-testid="visit-check"
      data-blocked={r.blocked ? 'true' : 'false'}
    >
      <h2 className="text-[15px] font-bold">{t('modes.deviceCheck.visit.title')}</h2>
      <div className="flex flex-col">
        {r.storage && r.freeBytes !== null && (
          <CheckRow
            id="visit-storage"
            label={t('modes.deviceCheck.visit.storage')}
            value={t('modes.deviceCheck.visit.storageOk', { free: gb(r.freeBytes) })}
            detail={t('modes.deviceCheck.visit.need', { need: gb(r.needBytes) })}
            tone={r.storage}
          />
        )}
        {r.memory && (
          <CheckRow
            id="visit-memory"
            label={t('modes.deviceCheck.visit.memory')}
            value={
              r.memory.availBytes !== null
                ? t('modes.deviceCheck.visit.memoryFree', { free: gb(r.memory.availBytes) })
                : t(
                    r.memoryLow
                      ? 'modes.deviceCheck.visit.memoryLow'
                      : 'modes.deviceCheck.visit.memoryOk',
                  )
            }
            tone={r.memoryLow ? 'warn' : 'ok'}
          />
        )}
      </div>
      {r.blocked && (
        <p className="rounded-xl bg-bad-soft px-3 py-2 text-[13px] text-bad" role="alert">
          {t('modes.deviceCheck.visit.blocked', { free: gb(short) })}
        </p>
      )}
      {r.memoryLow && (
        <p className="rounded-xl bg-warn-soft px-3 py-2 text-[13px] text-warn">
          {t('modes.deviceCheck.visit.memoryLowHint')}
        </p>
      )}
      {(r.blocked || r.memoryLow) && (
        <Button variant="secondary" onClick={run} data-testid="visit-check-again">
          {t('modes.deviceCheck.visit.again')}
        </Button>
      )}
    </Card>
  );
}
