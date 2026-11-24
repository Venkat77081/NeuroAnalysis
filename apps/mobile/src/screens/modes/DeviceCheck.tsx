/**
 * Phone check card (decision 035; memory and storage since decision 062), shown before a clinic
 * phone is registered and before a patient joins, and from the menu. Starts on its own; on a pass the parent shows the next step. On a fail it shows
 * `failExtra` (the patient's choices) and "Run the check again". The registration code or invite
 * is not used by the check.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useApp } from '../../app/AppContext.tsx';
import { capture } from '../../lib/capture.ts';
import { reportPhone } from '../../lib/accounts.ts';
import { gb, runDeviceCheck, type DeviceCheckResult, type Tone } from '../../lib/devicecheck.ts';
import { logger } from '../../lib/logger.ts';
import { saveSignCheck, type SignCheck } from '../../lib/startsign.ts';
import { SignTryout } from './SignTryout.tsx';
import { Button, Card } from '../../ui/kit.tsx';

const TONE: Record<Tone, string> = { ok: 'text-ok', warn: 'text-warn', bad: 'text-bad' };
const MARK: Record<Tone, string> = { ok: '✓', warn: '!', bad: '✕' };

/** One row of the check: what, the number, and a line of detail. */
export function CheckRow({
  id,
  label,
  value,
  detail,
  tone,
}: {
  id: string;
  label: string;
  value: string;
  detail?: string;
  tone: Tone;
}) {
  return (
    <div
      className="flex flex-col gap-0.5 border-t border-line py-2 first:border-t-0"
      data-testid={`check-row-${id}`}
      data-tone={tone}
    >
      <span className="flex items-baseline justify-between gap-2">
        <b className="text-[14px]">{label}</b>
        <b className={`text-[13px] whitespace-nowrap ${TONE[tone]}`}>
          <span aria-hidden="true">{MARK[tone]} </span>
          {value}
        </b>
      </span>
      {detail && <span className="text-[12px] leading-4 text-muted">{detail}</span>}
    </div>
  );
}

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
  const { config, caps, settings } = useApp();
  const cfg = config.platform.deviceCheck;
  const startGb = config.session.storage?.minFreeGbToStart ?? 0;
  const [result, setResult] = useState<DeviceCheckResult | null>(null);
  const [progress, setProgress] = useState<{ done: number; fps: number | null }>({
    done: 0,
    fps: null,
  });
  const [failed, setFailed] = useState(false);
  // v36 (decision 063): the optional hand-sign try-out, on patients' phones only.
  const [sign, setSign] = useState<{ status: SignCheck; hz: number } | null>(null);
  const [trying, setTrying] = useState(false);
  const signEligible =
    !!config.session.startSign?.enabled &&
    (who === 'patient' || (who === 'check' && settings.hospitals.length > 0));
  const running = useRef(false);
  const report = useRef(onResult);
  useEffect(() => {
    report.current = onResult;
  });

  // The check itself; state is set only in its .then (never synchronously in an effect).
  const check = useCallback(() => {
    running.current = true;
    runDeviceCheck(capture.kit, cfg, startGb, (done, fps) => setProgress({ done, fps }))
      .then(
        (r) => {
          setResult(r);
          report.current(r);
          // From the menu: the hospital(s) see the new numbers (decision 062). Never blocks.
          if (who === 'check') {
            const profiles = settings.hospitals.filter((h) => !h.withdrawnAt).map((h) => h.profile);
            const targets = profiles.length ? profiles : settings.signedIn ? [undefined] : [];
            for (const p of targets)
              void reportPhone(capture.kit, { ...r.check, kind: 'check' }, p).catch(
                () => undefined,
              );
          }
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
  }, [cfg, startGb, who, settings]);

  useEffect(() => {
    if (!running.current) check();
  }, [check]);

  const run = () => {
    if (running.current) return;
    setResult(null);
    setFailed(false);
    setSign(null);
    setProgress({ done: 0, fps: null });
    report.current(null);
    check();
  };

  const signDone = (status: SignCheck, hz: number) => {
    if (!result) return;
    setSign({ status, hz });
    saveSignCheck(status);
    const check = {
      ...result.check,
      start_sign: status,
      ...(hz > 0 ? { tracking_hz: Math.round(hz * 10) / 10 } : {}),
    };
    // The parent sends the updated check when the patient joins.
    report.current({ ...result, check });
    if (who === 'check')
      for (const h of settings.hospitals.filter((x) => !x.withdrawnAt))
        void reportPhone(capture.kit, { ...check, kind: 'check' }, h.profile).catch(
          () => undefined,
        );
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
        {t(
          passed
            ? 'modes.deviceCheck.passTitle'
            : result.reason === 'memory'
              ? 'modes.deviceCheck.failMemoryTitle'
              : 'modes.deviceCheck.failTitle',
        )}
      </h2>
      <span className="sr-only" data-testid="device-check-fps">
        {t(passed ? 'modes.deviceCheck.passFps' : 'modes.deviceCheck.failFps', {
          fps: result.fps.toFixed(1),
          min: cfg.minFps,
        })}
      </span>
      {device && <span className="text-[13px] text-muted">{device}</span>}
      <div className="flex flex-col" data-testid="device-check-rows">
        <CheckRow
          id="camera"
          label={t('modes.deviceCheck.rows.camera')}
          value={t('modes.deviceCheck.rows.fps', { fps: result.fps.toFixed(1) })}
          detail={
            result.video
              ? t('modes.deviceCheck.rows.video', { w: result.video.width, h: result.video.height })
              : undefined
          }
          tone={result.camera}
        />
        {result.memory && (
          <CheckRow
            id="memory"
            label={t('modes.deviceCheck.rows.memory')}
            value={t('modes.deviceCheck.rows.gb', { gb: result.memory.totalGb })}
            detail={
              result.memory.tone === 'bad'
                ? t('modes.deviceCheck.rows.memoryTooSmall', { min: cfg.memory.minTotalGb })
                : result.memory.freeBytes !== null
                  ? t('modes.deviceCheck.rows.memoryFree', { free: gb(result.memory.freeBytes) })
                  : undefined
            }
            tone={result.memory.tone}
          />
        )}
        {result.storage && (
          <CheckRow
            id="storage"
            label={t('modes.deviceCheck.rows.storage')}
            value={t('modes.deviceCheck.rows.free', { free: gb(result.storage.freeBytes) })}
            detail={t('modes.deviceCheck.rows.visitNeeds', { need: gb(result.storage.needBytes) })}
            tone={result.storage.tone}
          />
        )}
      </div>
      {result.bytesPerS !== null && (
        <span className="text-[12px] text-muted">
          {t('modes.deviceCheck.rows.measured', { mb: (result.bytesPerS / 1e6).toFixed(1) })}
        </span>
      )}
      {result.storage && result.storage.tone !== 'ok' && (
        <p
          className={`rounded-xl px-3 py-2 text-[13px] ${result.storage.tone === 'bad' ? 'bg-bad-soft text-bad' : 'bg-warn-soft text-warn'}`}
          data-testid="device-check-storage-hint"
        >
          {t(
            result.storage.tone === 'bad'
              ? 'modes.deviceCheck.storageBad'
              : 'modes.deviceCheck.storageWarn',
            {
              free: gb(
                Math.max(startGb * 1e9, result.storage.needBytes) - result.storage.freeBytes,
              ),
              start: startGb,
            },
          )}
        </p>
      )}
      {result.memory?.tone === 'warn' && (
        <p className="rounded-xl bg-warn-soft px-3 py-2 text-[13px] text-warn">
          {t('modes.deviceCheck.memoryWarn', { gb: result.memory.totalGb })}
        </p>
      )}
      {result.outcome === 'borderline' && (
        <p className="rounded-xl bg-[#FFF4E0] px-3 py-2 text-[13px] text-[#7A4B00]">
          {t('modes.deviceCheck.borderline', { take: cfg.warnBelowFps })}
        </p>
      )}
      {passed && signEligible && (
        <SignCard sign={sign} onTry={() => setTrying(true)} onSkip={() => signDone('skipped', 0)} />
      )}
      {trying && (
        <SignTryout
          onDone={(status, hz) => {
            setTrying(false);
            signDone(status, hz);
          }}
        />
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

/** v36: the hand-sign row of the check: offer the try-out, then show how it went. */
function SignCard({
  sign,
  onTry,
  onSkip,
}: {
  sign: { status: SignCheck; hz: number } | null;
  onTry: () => void;
  onSkip: () => void;
}) {
  const { t } = useTranslation();
  if (!sign)
    return (
      <div
        className="flex flex-col gap-2 rounded-xl bg-brand-soft px-3 py-3"
        data-testid="sign-offer"
      >
        <b className="text-[14px]">{t('modes.deviceCheck.sign.offerTitle')}</b>
        <span className="text-[13px] leading-[19px] text-muted">
          {t('modes.deviceCheck.sign.offer')}
        </span>
        <div className="flex gap-2">
          <Button className="flex-1" onClick={onTry} data-testid="sign-try">
            {t('modes.deviceCheck.sign.try')}
          </Button>
          <Button className="flex-1" variant="secondary" onClick={onSkip} data-testid="sign-skip">
            {t('modes.deviceCheck.sign.notNow')}
          </Button>
        </div>
      </div>
    );
  const tone: Tone = sign.status === 'works' ? 'ok' : sign.status === 'skipped' ? 'warn' : 'warn';
  return (
    <div className="flex flex-col gap-1" data-testid="sign-result" data-status={sign.status}>
      <CheckRow
        id="sign"
        label={t('modes.deviceCheck.sign.row')}
        value={t(`modes.deviceCheck.sign.status.${sign.status}`)}
        detail={
          sign.hz > 0
            ? t('modes.deviceCheck.sign.hz', { hz: sign.hz.toFixed(0) })
            : t('modes.deviceCheck.sign.buttonOnly')
        }
        tone={tone}
      />
      {sign.status !== 'works' && (
        <button
          type="button"
          className="self-start text-[13px] font-semibold text-brand"
          onClick={onTry}
          data-testid="sign-again"
        >
          {t('modes.deviceCheck.sign.again')}
        </button>
      )}
    </div>
  );
}
