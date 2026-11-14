import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { captureVerdict } from '@neurocapture/quality-core';
import type { RecordingStateEvent } from '@neurocapture/capture-kit';
import { useApp } from '../../app/AppContext.tsx';
import { beep } from '../../guidance/audio.ts';
import { camera, capture, clockSpeed } from '../../lib/capture.ts';
import { buildMeta } from '../../lib/evidence.ts';
import { loadQualification } from '../../lib/device-tier.ts';
import { logger } from '../../lib/logger.ts';
import { newId } from '../../data/repo.ts';
import { stepTakes } from '../../session/machine.ts';
import { useSession } from '../../session/useSession.ts';
import { Outline, type OverlayKind } from '../../overlays/Outline.tsx';
import { BackButton } from '../../ui/kit.tsx';
import { stepTitle } from './TestIntro.tsx';

/** Takes already started (guards against double effects, e.g. React StrictMode in dev). */
const started = new Set<string>();

/**
 * Framing → countdown → recording on one live camera (DEV_PLAN §5.4). The camera stays open across
 * the three states. Recording is started and stopped by native code (fixed duration); this screen
 * only shows progress and turns the result into a verdict + meta.json.
 */
export function CameraStage() {
  const { t } = useTranslation();
  const { config, caps } = useApp();
  const { ctx, send, snapshot } = useSession();
  const step = ctx.plan[ctx.index]!;
  const cfg = config.tests.get(step.code)!;
  const phase = snapshot.matches({ test: 'recording' })
    ? 'recording'
    : snapshot.matches({ test: 'countdown' })
      ? 'countdown'
      : 'framing';
  const [count, setCount] = useState(config.session.countdownS);
  const [elapsed, setElapsed] = useState(0);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [fps, setFps] = useState<number>(cfg.camera.targetFps);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  // Camera lifetime = this screen.
  useEffect(() => {
    document.documentElement.classList.add('camera-active');
    camera
      .open({
        facing: cfg.camera.facing,
        resolution: cfg.camera.resolution,
        targetFps: cfg.camera.targetFps,
        fallbackFps: cfg.camera.fallbackFps,
        orientation: cfg.camera.orientation,
        trackers: [],
        analysisFps: cfg.analysis.fps,
      })
      .then(
        (r) => setFps(r.actualFps),
        (e: unknown) => setCameraError(String(e)),
      );
    return () => {
      document.documentElement.classList.remove('camera-active');
      void camera.close().catch(() => undefined);
    };
  }, [cfg]);

  // Recording events → progress and completion (registered once for this screen).
  useEffect(() => {
    let handle: { remove: () => Promise<void> } | undefined;
    let cancelled = false;
    void capture.kit
      .addListener('recordingState', (e: RecordingStateEvent) => {
        const c = ctxRef.current;
        if (e.takeId !== c.currentTakeId) return;
        if (e.state === 'recording') setElapsed(e.elapsedS);
        else if (e.state === 'completed' && e.result) void finish(e.result);
        else if (e.state === 'error' || e.state === 'interrupted') send({ type: 'TAKE_FAILED' });
      })
      .then((h) => (cancelled ? void h.remove() : (handle = h)));
    return () => {
      cancelled = true;
      void handle?.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function finish(result: NonNullable<RecordingStateEvent['result']>) {
    const c = ctxRef.current;
    const v = captureVerdict(
      { ...result, error: null },
      {
        durationToleranceS: cfg.verdict.durationToleranceS,
        minEffectiveFps: cfg.camera.minEffectiveFps,
        maxDroppedFrac: cfg.verdict.maxDroppedFrac ?? null,
      },
    );
    try {
      const meta = buildMeta({
        ctx: c,
        cfg,
        sessionConfigVersion: config.session.configVersion,
        result,
        takeNo: stepTakes(c).length + 1,
        caps,
        implementation: capture.implementation,
        tier: loadQualification()?.assessment.tier ?? null,
        createdAt: new Date().toISOString(),
      });
      await capture.kit.writeEvidence({
        takeId: result.takeId,
        name: 'meta.json',
        json: JSON.stringify(meta),
      });
    } catch (e) {
      logger.error('meta.json write failed', { error: String(e) });
    }
    send({ type: 'TAKE_FINISHED', result, verdict: v.verdict, reasons: v.reasons });
  }

  // Countdown with beeps, then COUNTDOWN_DONE. AE/AF/AWB lock first (§8.1 camera.lock).
  useEffect(() => {
    if (phase !== 'countdown') return;
    let n = config.session.countdownS;
    setCount(n);
    void capture.kit.lockCameraSettings(cfg.camera.lock).catch(() => undefined);
    beep();
    const h = setInterval(() => {
      n -= 1;
      setCount(n);
      if (n > 0) beep();
      else {
        clearInterval(h);
        beep(true);
        send({ type: 'COUNTDOWN_DONE' });
      }
    }, 1000 / clockSpeed);
    return () => clearInterval(h);
  }, [phase, cfg, config.session.countdownS, send]);

  // Start the take once per takeId; native stops it at durationS.
  useEffect(() => {
    const id = ctx.currentTakeId;
    if (phase !== 'recording' || !id || started.has(id)) return;
    started.add(id);
    setElapsed(0);
    capture.kit
      .startRecording({ takeId: id, durationS: cfg.task.durationS })
      .catch((e: unknown) => {
        logger.error('startRecording failed', { error: String(e) });
        send({ type: 'TAKE_FAILED' });
      });
  }, [phase, ctx.currentTakeId, cfg, send]);

  const overlay = cfg.framing.overlay as OverlayKind;
  const left = Math.max(0, cfg.task.durationS - elapsed);
  const pct = Math.min(100, (elapsed / cfg.task.durationS) * 100);

  return (
    <div className="fixed inset-0 text-white" data-testid={`stage-${phase}`}>
      {/* Mock/browser: no native preview behind the page, so draw a dark stand-in for the camera image. */}
      {capture.implementation !== 'native' && (
        <div className="absolute inset-0 bg-[#20262F]" aria-hidden="true" />
      )}
      <Outline
        kind={overlay}
        color={phase === 'recording' ? '#5BE3A0' : '#FFFFFF'}
        dashed={phase === 'framing'}
      />

      <header className="absolute inset-x-0 top-0 flex items-center justify-between gap-2 p-3">
        {phase === 'recording' ? (
          <span
            className="flex items-center gap-2 rounded-full bg-[#E5484D] px-3 py-2 text-sm font-bold tabular-nums"
            data-testid="rec-badge"
          >
            <span className="size-2.5 rounded-full bg-white" aria-hidden="true" />
            REC {elapsed.toFixed(1)} s
          </span>
        ) : (
          <span className="rounded-full bg-[#0E1116]">
            <BackButton
              onClick={() => send(phase === 'countdown' ? { type: 'CANCEL' } : { type: 'BACK' })}
              label={t('common.back')}
            />
          </span>
        )}
        <div className="flex flex-col items-end rounded-xl bg-[#0E1116] px-3 py-1.5">
          <span className="text-sm font-semibold">{stepTitle(t, step.code, step.side)}</span>
          <span className="text-[11px] text-[#B8C0CC]">
            {t('session.framing.mode', {
              res: cfg.camera.resolution,
              fps,
              dur: cfg.task.durationS,
            })}
          </span>
        </div>
      </header>

      {phase === 'framing' && (
        <div className="absolute inset-x-4 top-20 flex flex-col gap-2">
          {ctx.notice === 'take_interrupted' && (
            <p
              className="m-0 rounded-2xl bg-[#F2A23A] px-4 py-3 text-[15px] font-semibold text-[#1A1206]"
              role="alert"
              data-testid="interrupted-notice"
            >
              {t('session.framing.interrupted')}
            </p>
          )}
          <p className="m-0 rounded-2xl bg-[#0E1116] px-4 py-3 text-[15px]">
            {t(`session.framing.hint.${overlay}`)}
          </p>
          {cameraError && (
            <p className="m-0 rounded-2xl bg-[#E5484D] px-4 py-3 text-sm" role="alert">
              {cameraError}
            </p>
          )}
        </div>
      )}

      {phase === 'countdown' && (
        <div className="absolute inset-0 flex items-center justify-center" aria-live="assertive">
          <span className="text-[120px] font-bold drop-shadow-lg" data-testid="countdown">
            {count > 0 ? count : ''}
          </span>
        </div>
      )}

      <section className="absolute inset-x-0 bottom-0 flex flex-col gap-3 rounded-t-3xl bg-[#0E1116] px-5 pt-4 pb-6">
        {phase === 'recording' ? (
          <>
            <div className="flex items-end justify-between">
              <span className="text-[44px] leading-none font-bold tabular-nums">
                {left.toFixed(1)}
              </span>
              <span className="text-right text-[13px] text-[#B8C0CC]">
                {t('session.recording.auto', { total: cfg.task.durationS })}
              </span>
            </div>
            <div
              className="h-2 rounded bg-[#2E3540]"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={cfg.task.durationS}
              aria-valuenow={Math.round(elapsed)}
            >
              <div className="h-2 rounded bg-[#5BE3A0]" style={{ width: `${pct}%` }} />
            </div>
            <button
              type="button"
              onClick={() => void capture.kit.stopRecording().catch(() => undefined)}
              className="h-12 rounded-2xl border border-[#4A525E] text-[15px] font-semibold"
              data-testid="stop-early"
            >
              {t('session.recording.stopEarly')}
            </button>
          </>
        ) : (
          <>
            <span className="text-center text-xs text-[#8C96A5]">{t('session.framing.later')}</span>
            <div className="flex justify-center">
              <button
                type="button"
                aria-label={t('session.framing.record')}
                disabled={phase === 'countdown' || !!cameraError}
                onClick={() => send({ type: 'RECORD', takeId: newId('tk') })}
                className="flex size-[76px] items-center justify-center rounded-full border-4 border-white disabled:opacity-40"
                data-testid="record"
              >
                <span className="size-14 rounded-full bg-[#E5484D]" />
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
