import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AnalysisFrameEvent,
  PreviewTransform,
  RecordingResult,
  RecordingStateEvent,
} from '@neurocapture/capture-kit';
import { camera, capture } from '../lib/capture.ts';
import { loadConfig } from '../lib/config.ts';
import { allPass, checkTake } from '../lib/m2-acceptance.ts';
import {
  checkTracking,
  clockOffsetNs,
  M4_LIMITS,
  summarizeTracking,
  type TrackingSample,
  type TrackingSummary,
} from '../lib/m4-acceptance.ts';
import { logger } from '../lib/logger.ts';
import { LandmarkOverlay } from '../overlays/LandmarkOverlay.tsx';
import { newId } from '../data/repo.ts';
import { setTrackerDelegate, trackerDelegate, type TrackerDelegate } from '../lib/debug-flags.ts';
import { decodeAnalysisFrame } from '@neurocapture/capture-kit';
import {
  GuidanceEngine,
  SensorBuffer,
  evaluateFrame,
  gateRules,
  type CheckContext,
} from '@neurocapture/quality-core';
import { percentile } from '../lib/m4-acceptance.ts';

/** M5 acceptance: quality evaluation ≤ 5 ms p95 in the WebView (DEV_PLAN §16 M5). */
const M5_EVAL_P95_MS = 5;

function waitForTake(takeId: string): Promise<RecordingResult> {
  return new Promise((resolve, reject) => {
    let handle: { remove: () => Promise<void> } | undefined;
    let settled = false;
    void capture.kit
      .addListener('recordingState', (s: RecordingStateEvent) => {
        if (s.takeId !== takeId || settled) return;
        if (s.state === 'completed' && s.result) resolve(s.result);
        else if (s.state === 'error' || s.state === 'interrupted')
          reject(new Error(s.reason ?? s.state));
        else return;
        settled = true;
        void handle?.remove();
      })
      .then((h) => (settled ? void h.remove() : (handle = h)));
  });
}

/** Measures the native↔JS clock offset with a few clockNow() round trips. */
async function syncClock(): Promise<bigint> {
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const beforeMs = performance.now();
    const { elapsedRealtimeNs } = await capture.kit.clockNow();
    samples.push({ beforeMs, afterMs: performance.now(), nativeNs: BigInt(elapsedRealtimeNs) });
  }
  return clockOffsetNs(samples).offsetNs;
}

interface RunResult {
  code: string;
  trackers: string[];
  summary: TrackingSummary;
  take: RecordingResult | null;
  gpu: boolean | null;
  /** M5: positioning checks + rule engine time per frame in this WebView, p95 (ms). */
  evalP95Ms: number;
}

/**
 * Engineering screen for M4: opens the camera with a test's trackers, records one take (fixed
 * duration) while measuring analysis fps, event latency and size, and draws the landmark overlay
 * so placement can be checked against a printed target.
 */
export function TrackingTest({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const config = useMemo(() => loadConfig(), []);
  const codes = useMemo(() => [...new Set(config.session.order.map(([c]) => c))], [config]);
  const [code, setCode] = useState(codes[0] ?? 'FT');
  const [record, setRecord] = useState(true);
  const [delegate, setDelegate] = useState<TrackerDelegate>(trackerDelegate);
  const [running, setRunning] = useState(false);
  const [transform, setTransform] = useState<PreviewTransform | null>(null);
  const [live, setLive] = useState<{
    fps: number;
    p95: number;
    bytes: number;
    hands: number;
    poses: number;
    faces: number;
  } | null>(null);
  const [results, setResults] = useState<RunResult[]>([]);
  const [status, setStatus] = useState('');
  const [stopReq, setStopReq] = useState(false);
  const stop = useRef<() => void>(() => undefined);
  const cfg = config.tests.get(code);

  useEffect(() => {
    if (!running) return;
    document.documentElement.classList.add('camera-active');
    return () => document.documentElement.classList.remove('camera-active');
  }, [running]);

  async function run() {
    if (!cfg) return;
    setRunning(true);
    setStatus('');
    setStopReq(false);
    const samples: TrackingSample[] = [];
    let handle: { remove: () => Promise<void> } | undefined;
    let tick: ReturnType<typeof setInterval> | undefined;
    const durationS = cfg.task.durationS;
    try {
      const opened = await camera.open({
        facing: cfg.camera.facing,
        resolution: cfg.camera.resolution,
        targetFps: cfg.camera.targetFps,
        fallbackFps: cfg.camera.fallbackFps,
        orientation: cfg.camera.orientation,
        trackers: cfg.trackers,
        analysisFps: cfg.analysis.fps,
        trackerDelegate: delegate,
      });
      setTransform(opened.previewTransform);
      const offsetNs = await syncClock();
      const last = { hands: 0, poses: 0, faces: 0 };
      const qctx: CheckContext = {
        test: cfg,
        quality: config.quality,
        side: null,
        orientation: cfg.camera.orientation,
        sharpnessBaseline: 100,
        sensors: true,
      };
      const engine = new GuidanceEngine(gateRules(qctx), config.quality);
      const sensorBuf = new SensorBuffer();
      const evalMs: number[] = [];
      handle = await capture.kit.addListener('analysisFrame', (e: AnalysisFrameEvent) => {
        const t0 = performance.now();
        const frame = decodeAnalysisFrame(e);
        engine.push(evaluateFrame(frame, sensorBuf, qctx));
        engine.update(frame.tNs);
        evalMs.push(performance.now() - t0);
        const nowNs = BigInt(Math.round(performance.now() * 1e6)) + offsetNs;
        const tsNs = BigInt(e.tsNs);
        samples.push({
          tsNs,
          latencyMs: Number(nowNs - tsNs) / 1e6,
          bytes: JSON.stringify(e).length,
          procMs: e.procMs ?? 0,
          error: Object.values(e.trackerStatus).includes('error'),
        });
        last.hands = e.counts?.hands ?? 0;
        last.poses = e.counts?.poses ?? 0;
        last.faces = e.counts?.faces ?? 0;
      });
      tick = setInterval(() => {
        const s = summarizeTracking(samples.slice(-60));
        setLive({ fps: s.analysisFps, p95: s.latencyP95Ms, bytes: s.maxEventBytes, ...last });
      }, 500);
      let take: RecordingResult | null = null;
      if (record) {
        const takeId = newId('m4');
        const done = waitForTake(takeId);
        await capture.kit.lockCameraSettings(cfg.camera.lock);
        samples.length = 0; // measure only while recording
        await capture.kit.startRecording({ takeId, durationS });
        take = await done;
      } else {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, durationS * 1000);
          stop.current = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
      const caps = await capture.kit.getCapabilities().catch(() => null);
      const r: RunResult = {
        code,
        trackers: cfg.trackers,
        summary: summarizeTracking(samples),
        take,
        gpu: caps?.gpuDelegate ?? null,
        evalP95Ms: percentile(evalMs, 95),
      };
      setResults((rs) => [r, ...rs]);
      logger.info('m4 tracking test', { code, record, ...r.summary });
    } catch (e) {
      setStatus(String(e));
    } finally {
      if (tick) clearInterval(tick);
      await handle?.remove();
      await camera.close().catch(() => undefined);
      setLive(null);
      setTransform(null);
      setRunning(false);
    }
  }

  const mark = (ok: boolean) => (ok ? '✓' : '✗');

  if (running) {
    return (
      <div className="fixed inset-0 text-white" data-testid="tracking-live">
        {capture.implementation === 'mock' && (
          <div className="absolute inset-0 bg-[#20262F]" aria-hidden="true" />
        )}
        <LandmarkOverlay transform={transform} />
        <div className="absolute inset-x-4 top-[calc(1rem+var(--sat))] flex flex-wrap gap-2 text-sm font-semibold tabular-nums">
          <span className="rounded-xl bg-[#0E1116] px-3 py-2" data-testid="tracking-hud">
            {live
              ? t('trackingTest.hud', {
                  fps: live.fps.toFixed(1),
                  p95: Number.isFinite(live.p95) ? live.p95.toFixed(0) : '–',
                  kb: (live.bytes / 1024).toFixed(1),
                })
              : t('trackingTest.starting')}
          </span>
          {live && (
            <span className="rounded-xl bg-[#0E1116] px-3 py-2">
              {t('trackingTest.counts', live)}
            </span>
          )}
        </div>
        {!record && (
          <button
            type="button"
            className="absolute inset-x-4 bottom-[calc(1.5rem+var(--sab))] h-12 rounded-2xl bg-[#0E1116] font-semibold"
            disabled={stopReq}
            onClick={() => {
              setStopReq(true);
              stop.current();
            }}
          >
            {t('trackingTest.stop')}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col gap-4 px-5 pt-4 pb-8">
      <header className="flex items-center gap-2">
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.back')}
          className="-ml-2 flex size-11 items-center justify-center rounded-full"
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </button>
        <h1 className="m-0 text-[24px] font-bold">{t('trackingTest.title')}</h1>
      </header>

      <section className="flex flex-col gap-3 rounded-2xl border border-line bg-white p-4">
        <label className="flex flex-col gap-1 text-sm font-semibold">
          {t('captureTest.test')}
          <select
            value={code}
            onChange={(e) => setCode(e.target.value as typeof code)}
            className="h-12 rounded-xl border border-[#C9CFD8] bg-white px-3 text-[15px] font-normal"
            data-testid="tracking-test-select"
          >
            {codes.map((c) => {
              const tc = config.tests.get(c);
              return (
                <option key={c} value={c}>
                  {t(`tests.${c}`)} · {tc?.trackers.join('+')} · {tc?.camera.targetFps} fps
                </option>
              );
            })}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-semibold">
          {t('trackingTest.delegate')}
          <select
            value={delegate}
            onChange={(e) => {
              const v = e.target.value as TrackerDelegate;
              setDelegate(v);
              setTrackerDelegate(v); // also used by the session camera on this device
            }}
            className="h-12 rounded-xl border border-[#C9CFD8] bg-white px-3 text-[15px] font-normal"
            data-testid="delegate-select"
          >
            <option value="auto">{t('trackingTest.delegateAuto')}</option>
            <option value="gpu">GPU</option>
            <option value="cpu">CPU</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={record} onChange={(e) => setRecord(e.target.checked)} />
          {t('trackingTest.record', { s: cfg?.task.durationS })}
        </label>
        <p className="m-0 text-xs text-muted">
          {t('trackingTest.limits', {
            fps: M4_LIMITS.analysisFps,
            p95: M4_LIMITS.latencyP95Ms,
            kb: M4_LIMITS.eventBytes / 1024,
          })}
        </p>
        <button
          type="button"
          onClick={() => void run()}
          className="h-12 rounded-xl bg-ink text-[15px] font-semibold text-white"
          data-testid="tracking-run"
        >
          {t('trackingTest.run')}
        </button>
        {status && (
          <p className="m-0 text-sm text-bad" role="alert">
            {status}
          </p>
        )}
      </section>

      {results.map((r, i) => {
        const c = checkTracking(r.summary);
        const m2 = r.take
          ? allPass(
              checkTake(
                r.take,
                config.tests.get(r.code as typeof code)?.camera.minEffectiveFps ?? 59,
              ),
            )
          : null;
        const pass = c.fps && c.latency && c.size && m2 !== false;
        return (
          <section
            key={i}
            className="flex flex-col gap-1 rounded-2xl border border-line bg-white p-4 text-sm tabular-nums"
            data-testid="tracking-result"
          >
            <span className="font-semibold">
              {t(`tests.${r.code}`)} · {r.trackers.join('+')} ·{' '}
              <span className={pass ? 'text-ok' : 'text-bad'} data-testid="tracking-verdict">
                {pass ? t('captureTest.pass') : t('captureTest.fail')}
              </span>
            </span>
            <span>
              {mark(c.fps)}{' '}
              {t('trackingTest.fps', {
                v: r.summary.analysisFps.toFixed(1),
                limit: M4_LIMITS.analysisFps,
              })}
            </span>
            <span>
              {mark(c.latency)}{' '}
              {t('trackingTest.latency', {
                p50: r.summary.latencyP50Ms.toFixed(0),
                p95: r.summary.latencyP95Ms.toFixed(0),
                limit: M4_LIMITS.latencyP95Ms,
              })}
            </span>
            <span>
              {mark(c.size)}{' '}
              {t('trackingTest.size', {
                kb: (r.summary.maxEventBytes / 1024).toFixed(1),
                limit: M4_LIMITS.eventBytes / 1024,
              })}
            </span>
            {m2 !== null && (
              <span>
                {mark(m2)}{' '}
                {t('trackingTest.m2', {
                  dur: r.take!.durationErrorMs.toFixed(0),
                  fps: r.take!.effectiveFps.toFixed(2),
                  lm: r.take!.landmarkFrames ?? 0,
                })}
              </span>
            )}
            <span className="text-muted">
              {t('trackingTest.detail', {
                n: r.summary.events,
                proc: r.summary.procP95Ms.toFixed(0),
                err: r.summary.errorFrames,
                gpu: r.gpu === null ? '?' : r.gpu ? 'GPU' : 'CPU',
              })}
            </span>
            <span data-testid="eval-p95">
              {mark(r.evalP95Ms <= M5_EVAL_P95_MS)}{' '}
              {t('trackingTest.eval', { ms: r.evalP95Ms.toFixed(2), limit: M5_EVAL_P95_MS })}
            </span>
          </section>
        );
      })}
    </div>
  );
}
