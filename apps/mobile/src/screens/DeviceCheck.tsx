import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { allowedTests, type TierReason } from '@neurocapture/quality-core';
import type {
  BenchmarkProgressEvent,
  BenchmarkReport,
  DeviceCapabilities,
} from '@neurocapture/capture-kit';
import { capture } from '../lib/capture.ts';
import { loadConfig } from '../lib/config.ts';
import {
  assess,
  loadQualification,
  reportFileName,
  saveQualification,
  withAssessment,
  type StoredQualification,
} from '../lib/device-tier.ts';
import { logger } from '../lib/logger.ts';
import { CameraTest } from './CameraTest.tsx';

type Preset = 'full' | 'quick';
const PRESETS: Record<Preset, { recordMinutes: number; thermalMinutes: number }> = {
  full: { recordMinutes: 10, thermalMinutes: 30 },
  quick: { recordMinutes: 1, thermalMinutes: 2 },
};

const tierStyle: Record<string, string> = {
  A: 'bg-ok-soft text-ok',
  B: 'bg-brand-soft text-brand',
  C: 'bg-[#FDECEA] text-bad',
  W: 'bg-warn-soft text-warn',
};

export function DeviceCheck({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const config = useMemo(() => loadConfig(), []);
  const { kit } = capture;
  const [caps, setCaps] = useState<DeviceCapabilities | null>(null);
  const [preset, setPreset] = useState<Preset>('quick');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<BenchmarkProgressEvent | null>(null);
  const [result, setResult] = useState<StoredQualification | null>(() => loadQualification());
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string[]>([]);
  const [cameraTest, setCameraTest] = useState(false);

  useEffect(() => {
    kit.getCapabilities().then(setCaps, (e: unknown) => setError(String(e)));
    let handle: { remove: () => Promise<void> } | undefined;
    let cancelled = false;
    void kit
      .addListener('benchmarkProgress', setProgress)
      .then((h) => (cancelled ? void h.remove() : (handle = h)));
    return () => {
      cancelled = true;
      void handle?.remove();
    };
  }, [kit]);

  async function run() {
    setRunning(true);
    setError(null);
    setSaved([]);
    const p = PRESETS[preset];
    const reports: BenchmarkReport[] = [];
    try {
      // 60 fps run decides Tier A; if it fails, a 30 fps run decides Tier B (DEV_PLAN §7).
      reports.push(
        await kit.runQualificationBenchmark({
          facing: 'back',
          resolution: '1080p',
          targetFps: 60,
          ...p,
        }),
      );
      let a = assess(reports, config.tiers);
      if (a.tier === 'C') {
        reports.push(
          await kit.runQualificationBenchmark({
            facing: 'back',
            resolution: '1080p',
            targetFps: 30,
            recordMinutes: p.recordMinutes,
            thermalMinutes: 0,
          }),
        );
        a = assess(reports, config.tiers);
      }
      const stored = { assessment: a, reports: reports.map((r) => withAssessment(r, a)) };
      setResult(stored);
      saveQualification(stored);
      const names: string[] = [];
      for (const r of stored.reports) {
        const { fileName } = await kit.saveQualificationReport({
          fileName: reportFileName(r),
          json: JSON.stringify(r, null, 2),
        });
        names.push(fileName);
      }
      setSaved(names);
      logger.info('qualification finished', {
        tier: a.tier,
        provisional: a.provisional,
        runs: reports.length,
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  }

  const reasonText = (r: TierReason) => {
    // Fractions (dropped frames) read as percentages; other numbers keep up to 3 decimals.
    const pct = r.code === 'dropped_frames_high';
    const fmt = (v: number | string | undefined) =>
      typeof v === 'number' ? (pct ? `${+(v * 100).toFixed(2)}%` : +v.toFixed(3)) : v;
    return `${r.tier}: ${t(`deviceCheck.reason.${r.code}`, { value: fmt(r.value), limit: fmt(r.limit) })}`;
  };

  if (cameraTest) return <CameraTest onClose={() => setCameraTest(false)} />;

  const a = result?.assessment;
  const allowed = a ? allowedTests(a.tier, [...config.tests.values()]) : [];
  const back = caps?.cameras.find((c) => c.facing === 'back');
  const pct =
    progress && progress.totalS > 0
      ? Math.min(100, (progress.elapsedS / progress.totalS) * 100)
      : 0;

  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col gap-4 px-5 pt-4 pb-8">
      <header className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
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
        <h1 className="m-0 text-[24px] font-bold">{t('deviceCheck.title')}</h1>
      </header>

      <section className="rounded-2xl border border-line bg-white p-4" aria-labelledby="dev">
        <h2 id="dev" className="m-0 text-sm font-semibold">
          {t('deviceCheck.device')}
        </h2>
        {caps ? (
          <dl
            className="mt-2 mb-0 grid grid-cols-2 gap-x-3 gap-y-1 text-sm"
            data-testid="capabilities"
          >
            <dt className="text-muted">{t('deviceCheck.model')}</dt>
            <dd className="m-0">
              {caps.device.manufacturer} {caps.device.model}
            </dd>
            <dt className="text-muted">{t('deviceCheck.os')}</dt>
            <dd className="m-0">
              {caps.device.osName} {caps.device.osVersion}
            </dd>
            <dt className="text-muted">{t('deviceCheck.maxFps')}</dt>
            <dd className="m-0">
              1080p {back?.maxFps['1080p'] ?? '—'} · 720p {back?.maxFps['720p'] ?? '—'}
            </dd>
            <dt className="text-muted">{t('deviceCheck.timestamps')}</dt>
            <dd className="m-0">{back?.timestampSource ?? '—'}</dd>
            <dt className="text-muted">{t('deviceCheck.lock')}</dt>
            <dd className="m-0">
              {back
                ? (['ae', 'af', 'awb'] as const)
                    .filter((k) => back.supportsLock[k])
                    .join(' · ')
                    .toUpperCase() || '—'
                : '—'}
            </dd>
            <dt className="text-muted">{t('deviceCheck.implementation')}</dt>
            <dd className="m-0">
              {caps.implementation} · plugin {caps.pluginVersion}
            </dd>
          </dl>
        ) : (
          <p className="mt-2 mb-0 text-sm text-muted">{error ?? t('deviceCheck.loading')}</p>
        )}
        <button
          type="button"
          onClick={() => setCameraTest(true)}
          disabled={running}
          className="mt-3 h-12 w-full rounded-xl border border-[#C9CFD8] bg-white text-[15px] font-semibold disabled:opacity-50"
        >
          {t('deviceCheck.cameraTest')}
        </button>
      </section>

      <section className="rounded-2xl border border-line bg-white p-4" aria-labelledby="bench">
        <h2 id="bench" className="m-0 text-sm font-semibold">
          {t('deviceCheck.benchmark')}
        </h2>
        <fieldset className="m-0 mt-2 flex flex-col gap-2 border-0 p-0" disabled={running}>
          <legend className="sr-only">{t('deviceCheck.preset')}</legend>
          {(['quick', 'full'] as const).map((k) => (
            <label
              key={k}
              className={`flex min-h-12 items-center gap-3 rounded-xl border px-3 text-sm ${preset === k ? 'border-brand bg-brand-soft' : 'border-[#C9CFD8]'}`}
            >
              <input
                type="radio"
                name="preset"
                checked={preset === k}
                onChange={() => setPreset(k)}
                className="size-5 accent-brand"
              />
              <span className="flex flex-col">
                <span className="font-semibold">{t(`deviceCheck.presets.${k}.title`)}</span>
                <span className="text-xs text-muted">{t(`deviceCheck.presets.${k}.detail`)}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {running && progress && (
          <div className="mt-3" data-testid="benchmark-progress">
            <div className="flex justify-between text-xs text-muted">
              <span>{t(`deviceCheck.phase.${progress.phase}`)}</span>
              <span className="tabular-nums">
                {Math.round(progress.elapsedS)} / {Math.round(progress.totalS)} s
                {progress.liveFps !== undefined ? ` · ${progress.liveFps} fps` : ''}
              </span>
            </div>
            <div
              className="mt-1 h-2 rounded bg-line"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(pct)}
            >
              <div className="h-2 rounded bg-brand" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}

        <div className="mt-3 flex gap-2">
          {running ? (
            <button
              type="button"
              onClick={() => void kit.cancelBenchmark()}
              className="h-12 flex-1 rounded-xl border border-[#C9CFD8] bg-white font-semibold"
            >
              {t('common.cancel')}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void run()}
              className="h-12 flex-1 rounded-xl bg-brand font-semibold text-white"
              data-testid="run-benchmark"
            >
              {t('deviceCheck.run')}
            </button>
          )}
        </div>
        {error && (
          <p className="mt-2 mb-0 text-sm text-bad" role="alert">
            {error}
          </p>
        )}
      </section>

      {a && (
        <section
          className="rounded-2xl border border-line bg-white p-4"
          aria-labelledby="tier"
          data-testid="tier-result"
        >
          <div className="flex items-center justify-between">
            <h2 id="tier" className="m-0 text-sm font-semibold">
              {t('deviceCheck.result')}
            </h2>
            <span
              className={`rounded-full px-3 py-1 text-sm font-bold ${tierStyle[a.tier]}`}
              data-testid="tier-badge"
            >
              {t(`deviceCheck.tier.${a.tier}`)}
            </span>
          </div>
          {a.provisional && (
            <p className="mt-2 mb-0 text-xs text-warn">{t('deviceCheck.provisional')}</p>
          )}
          {a.reasons.length > 0 && (
            <ul className="mt-2 mb-0 pl-4 text-sm text-ink">
              {a.reasons.map((r, i) => (
                <li key={i}>{reasonText(r)}</li>
              ))}
            </ul>
          )}
          <p className="mt-2 mb-0 text-sm">
            <span className="text-muted">{t('deviceCheck.allowed')}: </span>
            {allowed.length ? allowed.join(', ') : t('deviceCheck.noneAllowed')}
          </p>
          {result.reports.map((r, i) => (
            <p key={i} className="mt-1 mb-0 text-xs text-muted tabular-nums">
              {r.settings.targetFps} fps: {r.recording.effectiveFps.toFixed(1)} fps,{' '}
              {(r.recording.droppedFrac * 100).toFixed(2)}% {t('deviceCheck.dropped')},{' '}
              {t('deviceCheck.analysis')} {r.analysis.fps.toFixed(1)} fps
            </p>
          ))}
          {saved.length > 0 && (
            <p className="mt-2 mb-0 text-xs text-muted">
              {t('deviceCheck.saved', { files: saved.join(', ') })}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
