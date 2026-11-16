/**
 * Camera check card (decision 035), shown before a clinic phone is registered and before a
 * patient joins. Starts on its own; on a pass the parent shows the next step. On a fail it shows
 * `failExtra` (the patient's choices) and "Run the check again". The registration code or invite
 * is not used by the check.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useApp } from '../../app/AppContext.tsx';
import { capture } from '../../lib/capture.ts';
import { runDeviceCheck, type DeviceCheckResult } from '../../lib/devicecheck.ts';
import { logger } from '../../lib/logger.ts';
import { Button, Card } from '../../ui/kit.tsx';

export function DeviceCheck({
  who,
  onResult,
  failExtra,
}: {
  /** check = the frame-rate check from the long-press menu (decision 041). */
  who: 'clinic' | 'patient' | 'check';
  /** The latest result (null while a check runs). */
  onResult: (r: DeviceCheckResult | null) => void;
  failExtra?: (r: DeviceCheckResult) => ReactNode;
}) {
  const { t } = useTranslation();
  const { config, caps } = useApp();
  const cfg = config.platform.deviceCheck;
  const [result, setResult] = useState<DeviceCheckResult | null>(null);
  const [progress, setProgress] = useState<{ done: number; fps: number | null }>({
    done: 0,
    fps: null,
  });
  const [failed, setFailed] = useState(false);
  const running = useRef(false);
  const report = useRef(onResult);
  useEffect(() => {
    report.current = onResult;
  });

  // The check itself; state is set only in its .then (never synchronously in an effect).
  const check = useCallback(() => {
    running.current = true;
    runDeviceCheck(capture.kit, cfg, (done, fps) => setProgress({ done, fps }))
      .then(
        (r) => {
          setResult(r);
          report.current(r);
        },
        (e: unknown) => {
          logger.warn('camera check could not run', {
            error: e instanceof Error ? e.message : '',
          });
          setFailed(true);
        },
      )
      .finally(() => {
        running.current = false;
      });
  }, [cfg]);

  useEffect(() => {
    if (!running.current) check();
  }, [check]);

  const run = () => {
    if (running.current) return;
    setResult(null);
    setFailed(false);
    setProgress({ done: 0, fps: null });
    report.current(null);
    check();
  };

  const device = caps ? `${caps.device.model} · Android ${caps.device.osVersion}` : null;
  const step = who === 'clinic' && (
    <span className="text-[12px] font-bold tracking-wide text-muted uppercase">
      {t('modes.deviceCheck.step')}
    </span>
  );

  if (failed)
    return (
      <Card className="flex flex-col gap-2" data-testid="device-check">
        {step}
        <p role="alert" className="text-[14px] text-bad">
          {t('modes.deviceCheck.error')}
        </p>
        <Button variant="secondary" onClick={run} data-testid="device-check-again">
          {t('modes.deviceCheck.again')}
        </Button>
      </Card>
    );

  if (!result)
    return (
      <Card className="flex flex-col gap-2" data-testid="device-check" aria-busy="true">
        {step}
        <h2 className="text-[18px] font-bold">
          {t(who === 'clinic' ? 'modes.deviceCheck.checking' : 'modes.deviceCheck.patientTitle')}
        </h2>
        <p className="text-[14px] leading-[20px] text-[#3D4552]">
          {t(`modes.deviceCheck.hint.${who}`, { s: cfg.durationS })}
        </p>
        <div
          className="h-2 overflow-hidden rounded-full bg-[#E4E8EE]"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress.done * 100)}
        >
          <div className="h-full bg-brand" style={{ width: `${progress.done * 100}%` }} />
        </div>
        {progress.fps !== null && (
          <span className="text-[13px] text-muted">
            {t('modes.deviceCheck.live', { fps: progress.fps.toFixed(1) })}
          </span>
        )}
        <span className="text-[13px] text-muted">{t(`modes.deviceCheck.notUsed.${who}`)}</span>
      </Card>
    );

  const passed = result.outcome !== 'fail';
  return (
    <Card
      className={`flex flex-col gap-2 ${passed ? '' : 'border-[#F2B8B5]'}`}
      data-testid="device-check"
      data-outcome={result.outcome}
    >
      {step}
      <h2 className={`text-[18px] font-bold ${passed ? 'text-ok' : 'text-bad'}`}>
        {t(passed ? 'modes.deviceCheck.passTitle' : 'modes.deviceCheck.failTitle')}
      </h2>
      <span className="text-[14px]" data-testid="device-check-fps">
        {t(passed ? 'modes.deviceCheck.passFps' : 'modes.deviceCheck.failFps', {
          fps: result.fps.toFixed(1),
          min: cfg.minFps,
        })}
      </span>
      {device && <span className="text-[13px] text-muted">{device}</span>}
      {result.outcome === 'borderline' && (
        <p className="rounded-xl bg-[#FFF4E0] px-3 py-2 text-[13px] text-[#7A4B00]">
          {t('modes.deviceCheck.borderline', { take: cfg.warnBelowFps })}
        </p>
      )}
      {!passed && (
        <>
          {who === 'clinic' && (
            <p className="text-[14px] leading-[20px]">{t('modes.deviceCheck.failClinic')}</p>
          )}
          {failExtra?.(result)}
          <Button variant="secondary" onClick={run} data-testid="device-check-again">
            {t('modes.deviceCheck.again')}
          </Button>
        </>
      )}
    </Card>
  );
}
