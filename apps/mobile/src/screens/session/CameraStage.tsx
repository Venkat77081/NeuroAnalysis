import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { captureVerdict } from '@neurocapture/quality-core';
import type { RecordingStateEvent } from '@neurocapture/capture-kit';
import { useApp } from '../../app/AppContext.tsx';
import { beep, speak } from '../../guidance/audio.ts';
import { useGuidance } from '../../guidance/useGuidance.ts';
import { applyMockScenario, camera, capture, clockSpeed } from '../../lib/capture.ts';
import { buildMeta } from '../../lib/evidence.ts';
import { loadQualification } from '../../lib/device-tier.ts';
import { logger } from '../../lib/logger.ts';
import { newId } from '../../data/repo.ts';
import { stepTakes } from '../../session/machine.ts';
import { useSession } from '../../session/useSession.ts';
import { Outline, type OverlayKind } from '../../overlays/Outline.tsx';
import { LandmarkOverlay } from '../../overlays/LandmarkOverlay.tsx';
import { gateAdvisory, landmarkOverlayEnabled, sharpnessBaseline } from '../../lib/debug-flags.ts';
import type { RuleName } from '@neurocapture/quality-core';
import type { GuidanceView } from '../../guidance/useGuidance.ts';
import { ENGINEERING_TOOLS } from '../EngineeringMenu.tsx';
import { preferredOrientation, rememberOrientation } from '../../lib/orientation-pref.ts';
import type { PreviewTransform } from '@neurocapture/capture-kit';
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
  const { t, i18n } = useTranslation();
  const app = useApp();
  const { config } = app;
  const { ctx, send, snapshot } = useSession();
  const step = ctx.plan[ctx.index]!;
  const cfg = config.tests.get(step.code)!;
  const phase = snapshot.matches({ test: 'recording' })
    ? 'recording'
    : snapshot.matches({ test: 'countdown' })
      ? 'countdown'
      : 'framing';
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [fps, setFps] = useState<number>(cfg.camera.targetFps);
  const [transform, setTransform] = useState<PreviewTransform | null>(null);
  const [debugLandmarks] = useState(landmarkOverlayEnabled);
  // Operator may switch portrait/landscape where the test allows it (config allowedOrientations).
  const allowed = cfg.camera.allowedOrientations ?? [cfg.camera.orientation];
  const [orientation, setOrientation] = useState(() =>
    preferredOrientation(step.code, allowed, cfg.camera.orientation),
  );

  const [advisory] = useState(gateAdvisory);
  const [baseline] = useState(sharpnessBaseline);
  const [locked, setLocked] = useState(false);
  const phaseRef = useRef(phase);
  useEffect(() => {
    phaseRef.current = phase;
  });
  // Positioning checks + rule engine on every analysis frame (DEV_PLAN §9.2–9.3).
  const guidance = useGuidance({
    test: cfg,
    quality: config.quality,
    side: step.side,
    orientation,
    sharpnessBaseline: baseline,
    sensors: capture.implementation !== 'webcam',
    onSpeak: (key) => {
      if (phaseRef.current === 'framing')
        void speak(t(`session.guidance.prompt.${key}`), i18n.language);
    },
    onGateOpen: () => {
      // AE/AF/AWB are locked when the gate passes (DEV_PLAN §16 M5).
      void capture.kit.lockCameraSettings(cfg.camera.lock).then(
        () => setLocked(true),
        () => undefined,
      );
      if (config.quality.guidance.hapticOnGateOpen) globalThis.navigator?.vibrate?.(40);
    },
  });
  const gateOpen = !!guidance?.gateOpen;

  // Latest values for native event callbacks (updated after each render).
  const live = useRef({ ctx, cfg, app, send, orientation });
  useEffect(() => {
    live.current = { ctx, cfg, app, send, orientation };
  });

  // Camera lifetime = this screen.
  useEffect(() => {
    document.documentElement.classList.add('camera-active');
    applyMockScenario(cfg, step.side);
    camera
      .open({
        facing: cfg.camera.facing,
        resolution: cfg.camera.resolution,
        targetFps: cfg.camera.targetFps,
        fallbackFps: cfg.camera.fallbackFps,
        orientation,
        trackers: cfg.trackers,
        analysisFps: cfg.analysis.fps,
      })
      .then(
        (r) => {
          setFps(r.actualFps);
          setTransform(r.previewTransform);
        },
        (e: unknown) => setCameraError(String(e)),
      );
    return () => {
      document.documentElement.classList.remove('camera-active');
      void camera.close().catch(() => undefined);
    };
  }, [cfg, orientation, step.side]);

  // Completion of the current take → verdict, meta.json, TAKE_FINISHED (registered once).
  useEffect(() => {
    async function finish(result: NonNullable<RecordingStateEvent['result']>) {
      const { ctx: c, cfg: tc, app: a, send: s, orientation: o } = live.current;
      // Doctor's frame-rate limit from settings overrides the test default (decision 015).
      const minFps = a.settings.minFps ?? tc.camera.minEffectiveFps;
      const v = captureVerdict(
        { ...result, error: null },
        {
          durationToleranceS: tc.verdict.durationToleranceS,
          minEffectiveFps: minFps,
          maxDroppedFrac: tc.verdict.maxDroppedFrac ?? null,
        },
      );
      try {
        const meta = buildMeta({
          ctx: c,
          cfg: tc,
          sessionConfigVersion: a.config.session.configVersion,
          result,
          takeNo: stepTakes(c).length + 1,
          caps: a.caps,
          implementation: capture.implementation,
          tier: loadQualification()?.assessment.tier ?? null,
          createdAt: new Date().toISOString(),
          orientation: o,
          minEffectiveFps: minFps,
        });
        await capture.kit.writeEvidence({
          takeId: result.takeId,
          name: 'meta.json',
          json: JSON.stringify(meta),
        });
      } catch (e) {
        logger.error('meta.json write failed', { error: String(e) });
      }
      s({ type: 'TAKE_FINISHED', result, verdict: v.verdict, reasons: v.reasons });
    }
    let handle: { remove: () => Promise<void> } | undefined;
    let cancelled = false;
    void capture.kit
      .addListener('recordingState', (e: RecordingStateEvent) => {
        if (e.takeId !== live.current.ctx.currentTakeId) return;
        if (e.state === 'completed' && e.result) void finish(e.result);
        else if (e.state === 'error' || e.state === 'interrupted')
          live.current.send({ type: 'TAKE_FAILED' });
      })
      .then((h) => (cancelled ? void h.remove() : (handle = h)));
    return () => {
      cancelled = true;
      void handle?.remove();
    };
  }, []);

  // Start the take once per takeId; native stops it at durationS.
  useEffect(() => {
    const id = ctx.currentTakeId;
    if (phase !== 'recording' || !id || started.has(id)) return;
    started.add(id);
    capture.kit
      .startRecording({ takeId: id, durationS: cfg.task.durationS })
      .catch((e: unknown) => {
        logger.error('startRecording failed', { error: String(e) });
        send({ type: 'TAKE_FAILED' });
      });
  }, [phase, ctx.currentTakeId, cfg, send]);

  const overlay = cfg.framing.overlay as OverlayKind;
  const landscape = orientation === 'landscape';
  const L = landscape ? LANDSCAPE : PORTRAIT;

  return (
    <div className="fixed inset-0 text-white" data-testid={`stage-${phase}`}>
      {/* Mock/browser: no native preview behind the page, so draw a dark stand-in for the camera image. */}
      {capture.implementation !== 'native' && (
        <div className="absolute inset-0 bg-[#20262F]" aria-hidden="true" />
      )}
      {/* Green = gate open; amber = something to fix; white = checking / tracking (M5). */}
      <div className={L.guide}>
        <Outline
          kind={overlay}
          color={outlineColour(guidance)}
          dashed={phase === 'framing' && !gateOpen}
          side={step.side}
          orientation={orientation}
        />
      </div>
      {debugLandmarks && <LandmarkOverlay transform={transform} />}

      <header className={L.header}>
        {phase === 'recording' ? (
          <span />
        ) : (
          <span className="rounded-full bg-[#0E1116]">
            <BackButton
              onClick={() => send(phase === 'countdown' ? { type: 'CANCEL' } : { type: 'BACK' })}
              label={t('common.back')}
            />
          </span>
        )}
        {phase === 'framing' && allowed.length > 1 && (
          <button
            type="button"
            onClick={() => {
              const next = orientation === 'portrait' ? 'landscape' : 'portrait';
              rememberOrientation(step.code, next);
              setOrientation(next);
            }}
            className="ml-auto rounded-full bg-[#0E1116] px-3 py-2 text-[13px] font-semibold"
            aria-label={t('session.framing.switchOrientation')}
            data-testid="orientation-toggle"
          >
            {t(
              `session.framing.orientation.${orientation === 'portrait' ? 'landscape' : 'portrait'}`,
            )}
          </button>
        )}
        <div className={L.title}>
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
        <div className={L.hints}>
          {ctx.notice === 'take_interrupted' && (
            <p
              className="m-0 rounded-2xl bg-[#F2A23A] px-4 py-3 text-[15px] font-semibold text-[#1A1206]"
              role="alert"
              data-testid="interrupted-notice"
            >
              {t('session.framing.interrupted')}
            </p>
          )}
          <GuidancePrompt
            state={guidance}
            hint={t(`session.framing.hint.${overlay}`)}
            className={L.hint}
          />
          <Chips state={guidance} />
          {cameraError && (
            <p className="m-0 rounded-2xl bg-[#E5484D] px-4 py-3 text-sm" role="alert">
              {cameraError}
            </p>
          )}
        </div>
      )}

      {phase === 'countdown' && ctx.currentTakeId && (
        <Countdown
          key={ctx.currentTakeId}
          seconds={config.session.countdownS}
          lock={locked ? null : cfg.camera.lock}
          onDone={() => send({ type: 'COUNTDOWN_DONE' })}
        />
      )}

      {phase === 'recording' && ctx.currentTakeId ? (
        <RecordingPanel
          key={ctx.currentTakeId}
          takeId={ctx.currentTakeId}
          durationS={cfg.task.durationS}
          landscape={landscape}
        />
      ) : (
        <section className={L.panel} data-testid="controls">
          <span className="text-center text-xs text-[#8C96A5]" data-testid="gate-status">
            {advisory && !gateOpen
              ? t('session.guidance.advisory')
              : gateOpen
                ? t('session.guidance.ready')
                : t('session.guidance.checking')}
          </span>
          <div className="flex justify-center">
            <button
              type="button"
              aria-label={t('session.framing.record')}
              disabled={phase === 'countdown' || !!cameraError || !(gateOpen || advisory)}
              onClick={() => send({ type: 'RECORD', takeId: newId('tk') })}
              className="relative flex size-[76px] items-center justify-center rounded-full border-4 border-white disabled:opacity-40"
              data-testid="record"
              data-gate={gateOpen ? 'open' : 'closed'}
            >
              <GateRing progress={guidance?.gateProgress ?? 0} />
              <span className="size-14 rounded-full bg-[#E5484D]" />
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

/** 3-2-1 with beeps after locking AE/AF/AWB (§8.1 camera.lock); one instance per take. */
function Countdown({
  seconds,
  lock,
  onDone,
}: {
  seconds: number;
  /** null = already locked when the gate opened. */
  lock: { ae: boolean; af: boolean; awb: boolean } | null;
  onDone: () => void;
}) {
  const [count, setCount] = useState(seconds);
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });
  useEffect(() => {
    if (lock) void capture.kit.lockCameraSettings(lock).catch(() => undefined);
    let n = seconds;
    beep();
    const h = setInterval(() => {
      n -= 1;
      setCount(n);
      if (n > 0) beep();
      else {
        clearInterval(h);
        beep(true);
        done.current();
      }
    }, 1000 / clockSpeed);
    return () => clearInterval(h);
  }, [seconds, lock]);
  return (
    <div className="absolute inset-0 flex items-center justify-center" aria-live="assertive">
      <span className="text-[120px] font-bold drop-shadow-lg" data-testid="countdown">
        {count > 0 ? count : ''}
      </span>
    </div>
  );
}

/** REC badge, time left and Stop early for one take (elapsed comes from native events). */
function RecordingPanel({
  takeId,
  durationS,
  landscape,
}: {
  takeId: string;
  durationS: number;
  landscape: boolean;
}) {
  const L = landscape ? LANDSCAPE : PORTRAIT;
  const { t } = useTranslation();
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    let handle: { remove: () => Promise<void> } | undefined;
    let cancelled = false;
    void capture.kit
      .addListener('recordingState', (e: RecordingStateEvent) => {
        if (e.takeId === takeId && e.state === 'recording') setElapsed(e.elapsedS);
      })
      .then((h) => (cancelled ? void h.remove() : (handle = h)));
    return () => {
      cancelled = true;
      void handle?.remove();
    };
  }, [takeId]);
  const left = Math.max(0, durationS - elapsed);
  const pct = Math.min(100, (elapsed / durationS) * 100);
  return (
    <>
      <span
        className={`${L.rec} flex items-center gap-2 rounded-full bg-[#E5484D] px-3 py-2 text-sm font-bold tabular-nums`}
        data-testid="rec-badge"
      >
        <span className="size-2.5 rounded-full bg-white" aria-hidden="true" />
        REC {elapsed.toFixed(1)} s
      </span>
      <section className={L.panel}>
        <div className={L.timeRow}>
          <span className={L.timeLeft}>{left.toFixed(1)}</span>
          <span className={L.auto}>{t('session.recording.auto', { total: durationS })}</span>
        </div>
        <div
          className="h-2 w-full rounded bg-[#2E3540]"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={durationS}
          aria-valuenow={Math.round(elapsed)}
        >
          <div className="h-2 rounded bg-[#5BE3A0]" style={{ width: `${pct}%` }} />
        </div>
        <button
          type="button"
          onClick={() => void capture.kit.stopRecording().catch(() => undefined)}
          className="h-12 w-full rounded-2xl border border-[#4A525E] px-2 text-[15px] font-semibold"
          data-testid="stop-early"
        >
          {t('session.recording.stopEarly')}
        </button>
      </section>
    </>
  );
}

/**
 * Layout per test orientation. Landscape phones are short (~400 px), so controls move to a right
 * rail and the hint becomes a compact pill; the guide fills the area left of the rail.
 */
const PORTRAIT = {
  guide: 'pointer-events-none absolute inset-0',
  header: 'absolute inset-x-0 top-[var(--sat)] flex items-center justify-between gap-2 p-3',
  title: 'flex flex-col items-end rounded-xl bg-[#0E1116] px-3 py-1.5',
  hints: 'absolute inset-x-4 top-[calc(5rem+var(--sat))] flex flex-col gap-2',
  hint: 'm-0 rounded-2xl bg-[#0E1116] px-4 py-3 text-[15px]',
  panel:
    'absolute inset-x-0 bottom-0 flex flex-col gap-3 rounded-t-3xl bg-[#0E1116] px-5 pt-4 pb-[calc(1.5rem+var(--sab))]',
  rec: 'absolute top-[calc(0.75rem+var(--sat))] left-3',
  timeRow: 'flex items-end justify-between',
  timeLeft: 'text-[44px] leading-none font-bold tabular-nums',
  auto: 'text-right text-[13px] text-[#B8C0CC]',
};

const RAIL = 'w-[calc(8.5rem+var(--sar))]';
const LEFT = 'left-[calc(0.75rem+var(--sal))]';
const RIGHT_OF_RAIL = 'right-[calc(9.25rem+var(--sar))]';

const LANDSCAPE = {
  guide: `pointer-events-none absolute top-[var(--sat)] bottom-[var(--sab)] left-[var(--sal)] right-[calc(8.5rem+var(--sar))]`,
  header: `absolute top-[calc(0.5rem+var(--sat))] ${LEFT} ${RIGHT_OF_RAIL} flex items-center justify-between gap-2`,
  title: 'flex flex-col items-end rounded-xl bg-[#0E1116]/85 px-3 py-1',
  hints: `absolute bottom-[calc(0.75rem+var(--sab))] ${LEFT} ${RIGHT_OF_RAIL} flex flex-col items-start gap-2`,
  hint: 'm-0 max-w-[32rem] rounded-xl bg-[#0E1116]/85 px-3 py-2 text-sm',
  panel: `absolute inset-y-0 right-0 ${RAIL} flex flex-col items-center justify-center gap-3 bg-[#0E1116] pt-[var(--sat)] pr-[calc(0.75rem+var(--sar))] pb-[var(--sab)] pl-3 text-center`,
  rec: `absolute top-[calc(0.5rem+var(--sat))] ${LEFT}`,
  timeRow: 'flex w-full flex-col items-center gap-1',
  timeLeft: 'text-[36px] leading-none font-bold tabular-nums',
  auto: 'text-[11px] text-[#B8C0CC]',
};

const GREEN = '#3DDC84';
const AMBER = '#F2A23A';

function outlineColour(g: GuidanceView | null): string {
  if (g?.gateOpen) return GREEN;
  if (g?.prompt) return AMBER;
  return '#FFFFFF';
}

/** The single prompt (or "tracking…" / the static hint) shown during framing. */
function GuidancePrompt({
  state,
  hint,
  className,
}: {
  state: GuidanceView | null;
  hint: string;
  className: string;
}) {
  const { t } = useTranslation();
  if (state?.prompt)
    return (
      <p
        className={`${className} !bg-[#F2A23A] font-semibold !text-[#1A1206]`}
        role="status"
        data-testid="guidance-prompt"
        data-key={state.prompt.key}
      >
        {t(`session.guidance.prompt.${state.prompt.key}`)}
      </p>
    );
  if (state?.tracking)
    return (
      <p className={`${className} text-[#B8C0CC]`} role="status" data-testid="guidance-tracking">
        {t('session.guidance.tracking')}
        {ENGINEERING_TOOLS && (
          <span className="ml-2 text-xs text-[#8C96A5]" data-testid="analysis-diag">
            {t('session.guidance.diag', {
              fps: state.analysisFps.toFixed(0),
              ms: state.analysisLatencyMs.toFixed(0),
            })}
          </span>
        )}
      </p>
    );
  return <p className={className}>{hint}</p>;
}

/** Check chips (mockup screen 3): one per group, worst state wins. */
const CHIP_GROUPS: [string, RuleName[]][] = [
  [
    'in_frame',
    [
      'subject_present',
      'required_landmarks_visible',
      'in_safe_zone',
      'single_person',
      'handedness_match',
    ],
  ],
  ['distance', ['subject_size']],
  ['view', ['side_view', 'face_frontal']],
  ['light', ['brightness', 'face_light_balance']],
  ['level', ['tilt']],
  ['steady', ['shake']],
  ['sharp', ['sharpness']],
];

function Chips({ state }: { state: GuidanceView | null }) {
  const { t } = useTranslation();
  if (!state) return null;
  const chips = CHIP_GROUPS.flatMap(([name, rules]) => {
    const views = state.rules.filter((r) => rules.includes(r.rule));
    if (!views.length) return [];
    const s = views.some((v) => v.state === 'WARN')
      ? 'WARN'
      : views.some((v) => v.state === 'UNKNOWN')
        ? 'UNKNOWN'
        : 'OK';
    return [{ name, s }];
  });
  const style = {
    OK: 'bg-[#123824] text-[#5BE3A0]',
    WARN: 'bg-[#3A2A10] text-[#F2A23A]',
    UNKNOWN: 'bg-[#0E1116] text-[#8C96A5]',
  };
  const mark = { OK: '✓', WARN: '!', UNKNOWN: '…' };
  return (
    <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" data-testid="chips">
      {chips.map((c) => (
        <li
          key={c.name}
          className={`rounded-full px-2.5 py-1 text-xs font-semibold ${style[c.s as keyof typeof style]}`}
          data-testid={`chip-${c.name}`}
          data-state={c.s}
        >
          {mark[c.s as keyof typeof mark]} {t(`session.guidance.chip.${c.name}`)}
        </li>
      ))}
    </ul>
  );
}

/** Ring around Record that fills while every check stays OK (gate hold). */
function GateRing({ progress }: { progress: number }) {
  const r = 36;
  const c = 2 * Math.PI * r;
  return (
    <svg className="pointer-events-none absolute -inset-1" viewBox="0 0 80 80" aria-hidden="true">
      <circle
        cx={40}
        cy={40}
        r={r}
        fill="none"
        stroke={GREEN}
        strokeWidth={4}
        strokeDasharray={`${c * progress} ${c}`}
        transform="rotate(-90 40 40)"
      />
    </svg>
  );
}
