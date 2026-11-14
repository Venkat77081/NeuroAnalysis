import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RecordingResult, RecordingStateEvent, StoredTake } from '@neurocapture/capture-kit';
import { camera, capture } from '../lib/capture.ts';
import { loadConfig } from '../lib/config.ts';
import { allPass, checkTake, summarize, M2_LIMITS } from '../lib/m2-acceptance.ts';
import { logger } from '../lib/logger.ts';
import { setSharpnessBaseline } from '../lib/debug-flags.ts';

/** Busy-waits on the JS thread: simulates a frozen WebView while native keeps recording (M2). */
function freezeJs(ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* spin */
  }
}

/** Unique, filesystem-safe take ID for engineering takes. */
function newTakeId(code: string, i: number): string {
  return `m2-${code}-${Date.now()}-${i}`;
}

function waitForTake(takeId: string, timeoutMs: number): Promise<RecordingResult> {
  return new Promise((resolve, reject) => {
    let handle: { remove: () => Promise<void> } | undefined;
    const timer = setTimeout(() => {
      void handle?.remove();
      reject(new Error('take did not finish in time'));
    }, timeoutMs);
    void capture.kit
      .addListener('recordingState', (s: RecordingStateEvent) => {
        if (s.takeId !== takeId || (s.state !== 'completed' && s.state !== 'error')) return;
        clearTimeout(timer);
        void handle?.remove();
        if (s.result && s.state === 'completed') resolve(s.result);
        else reject(new Error(s.reason ?? 'recording failed'));
      })
      .then((h) => (handle = h));
  });
}

/** Engineering screen for M2: real takes with each test's settings, checked against the acceptance criteria. */
export function CaptureTest({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const config = useMemo(() => loadConfig(), []);
  const codes = useMemo(() => [...new Set(config.session.order.map(([c]) => c))], [config]);
  const [code, setCode] = useState(codes[0] ?? 'FT');
  const [repeats, setRepeats] = useState(1);
  const [delay, setDelay] = useState(false);
  const [freeze, setFreeze] = useState(false);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('');
  const [stored, setStored] = useState<StoredTake[]>([]);
  const [crash, setCrash] = useState(false);
  const engineering = stored.filter((s) => s.takeId.startsWith('m2-'));
  const results = engineering.flatMap((s) => (s.result ? [s.result] : []));
  const interrupted = engineering.filter((s) => !s.result);
  const [player, setPlayer] = useState<{ takeId: string; url: string } | null>(null);
  const [recovered, setRecovered] = useState<string[]>([]);
  const [baseline, setBaseline] = useState<number | null>(null);
  /** Live view while the camera is open: native preview behind a transparent page + HUD. */
  const [live, setLive] = useState<{
    mode: 'record' | 'calibrate';
    take: number;
    of: number;
    elapsedS: number;
    durationS: number;
  } | null>(null);
  const cfg = config.tests.get(code);
  const minFps = cfg?.camera.minEffectiveFps ?? 59;

  // Make the page transparent while the camera is live so the native preview shows through.
  useEffect(() => {
    if (!live) return;
    document.documentElement.classList.add('camera-active');
    return () => document.documentElement.classList.remove('camera-active');
  }, [live]);

  // Native emits recordingState every 500 ms while recording; use it for the timer.
  useEffect(() => {
    let handle: { remove: () => Promise<void> } | undefined;
    let cancelled = false;
    void capture.kit
      .addListener('recordingState', (s: RecordingStateEvent) => {
        if (s.state === 'recording')
          setLive((l) => (l && l.mode === 'record' ? { ...l, elapsedS: s.elapsedS } : l));
      })
      .then((h) => (cancelled ? void h.remove() : (handle = h)));
    return () => {
      cancelled = true;
      void handle?.remove();
    };
  }, []);

  async function refresh() {
    try {
      setStored((await capture.kit.listTakes()).takes);
    } catch (e) {
      logger.warn('listTakes failed', { error: String(e) });
    }
  }

  useEffect(() => {
    capture.kit.getRecoveredTakes().then(
      (r) => setRecovered(r.takeIds),
      () => undefined,
    );
    capture.kit.listTakes().then(
      (r) => setStored(r.takes),
      (e: unknown) => logger.warn('listTakes failed', { error: String(e) }),
    );
  }, []);

  async function openFor() {
    if (!cfg) throw new Error(`no config for ${code}`);
    return camera.open({
      facing: cfg.camera.facing,
      resolution: cfg.camera.resolution,
      targetFps: cfg.camera.targetFps,
      fallbackFps: cfg.camera.fallbackFps,
      orientation: cfg.camera.orientation,
      trackers: [],
      analysisFps: cfg.analysis.fps,
      debugAnalysisDelayMs: delay ? 40 : 0,
    });
  }

  async function run() {
    if (!cfg) return;
    setRunning(true);
    setStatus('');
    const batch: RecordingResult[] = [];
    try {
      await openFor();
      await capture.kit.lockCameraSettings(cfg.camera.lock);
      for (let i = 0; i < repeats; i++) {
        const takeId = newTakeId(code, i);
        setStatus(t('captureTest.recording', { n: i + 1, of: repeats }));
        setLive({
          mode: 'record',
          take: i + 1,
          of: repeats,
          elapsedS: 0,
          durationS: cfg.task.durationS,
        });
        const done = waitForTake(takeId, (cfg.task.durationS + 30) * 1000);
        if (crash && i === 0) await capture.kit.debugArmCrash({ afterS: 5 });
        await capture.kit.startRecording({ takeId, durationS: cfg.task.durationS });
        if (freeze) freezeJs(cfg.task.durationS * 1000 + 500);
        const r = await done;
        batch.push(r);
        await refresh();
      }
      const s = summarize(batch, minFps);
      setStatus(t('captureTest.done', { passed: s.passed, takes: s.takes }));
      logger.info('m2 capture test', { ...s, code, delay, freeze });
    } catch (e) {
      setStatus(String(e));
    } finally {
      await camera.close().catch(() => undefined);
      setLive(null);
      setRunning(false);
    }
  }

  async function calibrate() {
    setRunning(true);
    try {
      await openFor();
      setStatus(t('captureTest.calibrating'));
      setLive({ mode: 'calibrate', take: 1, of: 1, elapsedS: 0, durationS: 3 });
      const r = await capture.kit.calibrateSharpness({ durationS: 3 });
      setBaseline(r.baseline);
      setSharpnessBaseline(r.baseline); // used by the sharpness check (M5)
      setStatus(t('captureTest.calibrated', { baseline: r.baseline.toFixed(1), frames: r.frames }));
    } catch (e) {
      setStatus(String(e));
    } finally {
      await camera.close().catch(() => undefined);
      setLive(null);
      setRunning(false);
    }
  }

  async function play(takeId: string) {
    try {
      const { playerUrl } = await capture.kit.playTake({ takeId });
      setPlayer({ takeId, url: playerUrl });
    } catch (e) {
      setStatus(String(e));
    }
  }

  async function closePlayer() {
    if (player) await capture.kit.closePlayback({ takeId: player.takeId });
    setPlayer(null);
  }

  async function deleteAll() {
    for (const s of engineering)
      await capture.kit.deleteTake({ takeId: s.takeId, reason: 'engineering_test' });
    setRecovered([]);
    await refresh();
  }

  const summary = summarize(results, minFps);
  const mark = (ok: boolean) => (ok ? '✓' : '✗');

  if (live) {
    const pct = Math.min(100, (live.elapsedS / live.durationS) * 100);
    return (
      <div className="fixed inset-0" data-testid="live-view">
        <div className="absolute inset-x-4 top-[calc(1rem+var(--sat))] flex items-center justify-between gap-2">
          {live.mode === 'record' ? (
            <span className="flex items-center gap-2 rounded-full bg-[#E5484D] px-3 py-2 text-sm font-bold text-white tabular-nums">
              <span className="size-2.5 rounded-full bg-white" aria-hidden="true" />
              REC {live.elapsedS.toFixed(1)} / {live.durationS} s
            </span>
          ) : (
            <span className="rounded-full bg-[#0E1116] px-3 py-2 text-sm font-semibold text-white">
              {t('captureTest.calibrateTitle')}
            </span>
          )}
          {live.mode === 'record' && (
            <span
              className="rounded-xl bg-[#0E1116] px-3 py-2 text-sm font-semibold text-white"
              data-testid="live-take"
            >
              {t('captureTest.take', { n: live.take, of: live.of })}
            </span>
          )}
        </div>
        <div className="absolute inset-x-0 bottom-0 flex flex-col gap-2 rounded-t-3xl bg-[#0E1116] p-5 pb-[calc(1.25rem+var(--sab))] text-white">
          <span className="text-sm">
            {live.mode === 'record'
              ? freeze
                ? t('captureTest.frozenHint')
                : t('captureTest.liveHint')
              : t('captureTest.calibrating')}
          </span>
          {live.mode === 'record' && (
            <div
              className="h-2 rounded bg-[#2E3540]"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={live.durationS}
              aria-valuenow={Math.round(live.elapsedS)}
            >
              <div className="h-2 rounded bg-[#5BE3A0]" style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
      </div>
    );
  }

  if (player) {
    return (
      <div
        className="fixed inset-0 flex flex-col bg-black pt-[var(--sat)] pb-[var(--sab)]"
        data-testid="player"
      >
        <video src={player.url} controls autoPlay playsInline className="min-h-0 flex-1" />
        <button
          type="button"
          onClick={() => void closePlayer()}
          className="m-4 h-12 rounded-xl bg-white font-semibold"
        >
          {t('common.close')}
        </button>
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
          disabled={running}
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
        <h1 className="m-0 text-[24px] font-bold">{t('captureTest.title')}</h1>
      </header>

      {recovered.length > 0 && (
        <p className="m-0 rounded-xl bg-warn-soft p-3 text-sm text-warn" data-testid="recovered">
          {t('captureTest.recovered', { ids: recovered.join(', ') })}
        </p>
      )}

      <section className="flex flex-col gap-3 rounded-2xl border border-line bg-white p-4">
        <label className="flex flex-col gap-1 text-sm font-semibold">
          {t('captureTest.test')}
          <select
            value={code}
            onChange={(e) => setCode(e.target.value as typeof code)}
            disabled={running}
            className="h-12 rounded-xl border border-[#C9CFD8] bg-white px-3 text-[15px] font-normal"
            data-testid="test-select"
          >
            {codes.map((c) => {
              const tc = config.tests.get(c);
              return (
                <option key={c} value={c}>
                  {t(`tests.${c}`)} · {tc?.task.durationS} s · {tc?.camera.targetFps} fps
                </option>
              );
            })}
          </select>
        </label>
        <fieldset className="m-0 flex gap-2 border-0 p-0" disabled={running}>
          <legend className="mb-1 text-sm font-semibold">{t('captureTest.repeats')}</legend>
          {[1, 5, 20].map((n) => (
            <button
              key={n}
              type="button"
              aria-pressed={repeats === n}
              onClick={() => setRepeats(n)}
              className={`h-11 flex-1 rounded-xl border text-sm font-semibold ${repeats === n ? 'border-brand bg-brand text-white' : 'border-[#C9CFD8] bg-white'}`}
            >
              {n}
            </button>
          ))}
        </fieldset>
        <label className="flex min-h-11 items-center gap-3 text-sm">
          <input
            type="checkbox"
            checked={delay}
            onChange={(e) => setDelay(e.target.checked)}
            disabled={running}
            className="size-5 accent-brand"
          />
          {t('captureTest.delay')}
        </label>
        <label className="flex min-h-11 items-center gap-3 text-sm">
          <input
            type="checkbox"
            checked={crash}
            onChange={(e) => setCrash(e.target.checked)}
            disabled={running}
            className="size-5 accent-brand"
            data-testid="crash-toggle"
          />
          {t('captureTest.crash')}
        </label>
        <label className="flex min-h-11 items-center gap-3 text-sm">
          <input
            type="checkbox"
            checked={freeze}
            onChange={(e) => setFreeze(e.target.checked)}
            disabled={running}
            className="size-5 accent-brand"
          />
          {t('captureTest.freeze')}
        </label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void run()}
            disabled={running}
            className="h-12 flex-1 rounded-xl bg-brand font-semibold text-white disabled:opacity-50"
            data-testid="run-capture-test"
          >
            {t('captureTest.run')}
          </button>
          <button
            type="button"
            onClick={() => void calibrate()}
            disabled={running}
            className="h-12 rounded-xl border border-[#C9CFD8] bg-white px-3 text-sm font-semibold disabled:opacity-50"
          >
            {t('captureTest.calibrate')}
          </button>
        </div>
        {status && (
          <p className="m-0 text-sm" role="status" data-testid="capture-status">
            {status}
          </p>
        )}
        {baseline !== null && (
          <p className="m-0 text-xs text-muted">
            {t('captureTest.baseline', { baseline: baseline.toFixed(1) })}
          </p>
        )}
      </section>

      {interrupted.length > 0 && (
        <section
          className="rounded-2xl border border-line bg-white p-4"
          data-testid="interrupted-takes"
        >
          <h2 className="m-0 text-sm font-semibold">{t('captureTest.interrupted')}</h2>
          <ul className="mt-2 mb-0 flex list-none flex-col gap-1 p-0 text-xs text-muted">
            {interrupted.map((s) => (
              <li key={s.takeId}>
                {s.takeId} ·{' '}
                {s.recovered ? t('captureTest.recoveredTag') : t('captureTest.noResult')} ·{' '}
                {s.files.join(', ')}
              </li>
            ))}
          </ul>
        </section>
      )}

      {(results.length > 0 || interrupted.length > 0) && (
        <section
          className="rounded-2xl border border-line bg-white p-4"
          data-testid="capture-results"
        >
          <h2 className="m-0 text-sm font-semibold">
            {t('captureTest.summary', { passed: summary.passed, takes: summary.takes })}
          </h2>
          <p className="mt-1 mb-2 text-xs text-muted tabular-nums">
            {t('captureTest.summaryLine', {
              dur: summary.maxAbsDurationErrorMs.toFixed(0),
              durLimit: M2_LIMITS.durationErrorMs,
              fps: summary.minEffectiveFps.toFixed(1),
              minFps,
              ts: summary.maxTimestampDiffMs.toFixed(2),
              tsLimit: M2_LIMITS.timestampMs,
              drop: (summary.maxDroppedFrac * 100).toFixed(2),
            })}
          </p>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {results.map((r) => {
              const c = checkTake(r, minFps);
              return (
                <li
                  key={r.takeId}
                  className="rounded-xl border border-line p-3 text-xs tabular-nums"
                >
                  <div className="flex items-center justify-between">
                    <span className={`font-bold ${allPass(c) ? 'text-ok' : 'text-bad'}`}>
                      {allPass(c) ? t('captureTest.pass') : t('captureTest.fail')}
                    </span>
                    <button
                      type="button"
                      onClick={() => void play(r.takeId)}
                      className="h-9 rounded-lg border border-[#C9CFD8] px-3 font-semibold"
                    >
                      {t('captureTest.play')}
                    </button>
                  </div>
                  <div className="mt-1 text-muted">
                    {mark(c.duration)} {t('captureTest.duration')} {r.durationS.toFixed(3)} s (
                    {r.durationErrorMs >= 0 ? '+' : ''}
                    {r.durationErrorMs.toFixed(0)} ms) · {mark(c.fps)} {r.effectiveFps.toFixed(2)}{' '}
                    fps @ {r.actualFps} · {(r.droppedFrac * 100).toFixed(2)}%{' '}
                    {t('deviceCheck.dropped')}
                  </div>
                  <div className="text-muted">
                    {mark(c.frameCount)} MP4 {r.mp4?.sampleCount ?? '—'} / frames.bin{' '}
                    {r.framesInVideoSpan ?? '—'} · {mark(c.timestamps)} Δt{' '}
                    {r.mp4 ? r.mp4.maxAbsDiffMs.toFixed(2) : '—'} ms ({r.mp4?.anchor ?? '—'}) ·{' '}
                    {mark(c.encrypted)} {t('captureTest.encrypted')}
                  </div>
                  <div className="text-muted">
                    {r.mp4 ? `${t('captureTest.unmatched', { n: r.mp4.unmatchedSamples })} · ` : ''}
                    {t('captureTest.sensors', {
                      n: r.sensorSamples,
                      offset: r.sensorClockOffsetMs?.toFixed(2) ?? '—',
                    })}
                    {r.stopLeadMs != null
                      ? ` · ${t('captureTest.stopLead', { ms: r.stopLeadMs.toFixed(0) })}`
                      : ''}
                  </div>
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            onClick={() => void deleteAll()}
            disabled={running}
            className="mt-3 h-11 w-full rounded-xl border border-[#C9CFD8] bg-white text-sm font-semibold"
          >
            {t('captureTest.deleteAll')}
          </button>
        </section>
      )}
    </div>
  );
}
