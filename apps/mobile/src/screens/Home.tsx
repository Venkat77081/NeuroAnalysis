import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { QUALITY_CORE_VERSION } from '@neurocapture/quality-core';
import { PLUGIN_VERSION } from '@neurocapture/capture-kit';
import { loadConfig } from '../lib/config.ts';
import { capture } from '../lib/capture.ts';
import { logger } from '../lib/logger.ts';

/** M0 placeholder home screen: proves the app runs, configs validate, and capture events flow (mock). */
export function Home() {
  const { t } = useTranslation();
  const config = useMemo(() => loadConfig(), []);
  const [frames, setFrames] = useState(0);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const { kit, implementation } = capture;

  useEffect(() => {
    let cancelled = false;
    let remove: (() => Promise<void>) | undefined;
    (async () => {
      try {
        const h = await kit.addListener('analysisFrame', () => setFrames((n) => n + 1));
        remove = h.remove;
        await kit.openCamera({ facing: 'back', resolution: '1080p', targetFps: 60, orientation: 'portrait', trackers: ['hand'], analysisFps: 30 });
        if (cancelled) await kit.closeCamera();
      } catch (e) {
        logger.warn('capture unavailable', { implementation, error: String(e) });
        if (!cancelled) setCaptureError(implementation === 'native' ? t('home.nativePending') : String(e));
      }
    })();
    return () => {
      cancelled = true;
      void remove?.();
      void kit.closeCamera().catch(() => undefined);
    };
  }, [kit, implementation, t]);

  const modeKey = `home.mode.${implementation}` as const;
  const clinical = implementation === 'native';

  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col gap-4 px-5 pt-5 pb-8">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-lg bg-brand text-white">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="6" width="13" height="12" rx="2" />
              <path d="M16 10l5-3v10l-5-3" />
            </svg>
          </div>
          <span className="text-[17px] font-bold">{t('app.name')}</span>
        </div>
        <span
          data-testid="mode-badge"
          className={`rounded-full px-2.5 py-1.5 text-xs font-semibold ${clinical ? 'bg-ok-soft text-ok' : 'bg-warn-soft text-warn'}`}
        >
          {t(modeKey)}
        </span>
      </header>

      <div>
        <h1 className="m-0 text-[26px] font-bold">{t('home.title')}</h1>
        <p className="m-0 mt-1 text-sm text-muted">{t('home.subtitle')}</p>
      </div>

      <section className="rounded-2xl border border-line bg-white p-4" aria-labelledby="cfg">
        <div className="flex items-baseline justify-between">
          <h2 id="cfg" className="m-0 text-sm font-semibold">{t('home.config')}</h2>
          <span data-testid="config-status" className={`text-xs font-semibold ${config.errors.length ? 'text-bad' : 'text-ok'}`}>
            {config.errors.length ? `${t('home.configInvalid')} (${config.errors.length})` : t('home.configValid')}
          </span>
        </div>
        {config.errors.length > 0 && (
          <ul className="mt-2 mb-0 pl-4 text-xs text-bad">
            {config.errors.map((e) => <li key={e}>{e}</li>)}
          </ul>
        )}
        <p className="mt-2 mb-1 text-xs text-muted">
          {config.session.configVersion} · {t('home.takes', { count: config.session.order.length })}
        </p>
        <ol className="m-0 list-none overflow-hidden rounded-xl border border-line p-0" data-testid="test-plan">
          {config.session.order.map(([code, side], i) => {
            const tc = config.tests.get(code);
            return (
              <li key={`${code}-${side ?? 'na'}`} className="flex h-11 items-center gap-3 border-b border-[#edf0f3] px-3.5 last:border-b-0">
                <span className="w-5 text-xs text-muted tabular-nums">{i + 1}</span>
                <span className="min-w-10 rounded-md bg-brand-soft px-1.5 py-0.5 text-center text-xs font-bold text-brand">{code}</span>
                <span className="flex-1 text-sm">{t(`tests.${code}`)}</span>
                <span className="text-[13px] text-muted">{side ? t(`side.${side}`) : t('side.none')}</span>
                <span className="w-12 text-right text-[13px] text-muted tabular-nums">{tc ? t('home.seconds', { count: tc.task.durationS }) : '—'}</span>
              </li>
            );
          })}
        </ol>
      </section>

      <section className="rounded-2xl border border-line bg-white p-4" aria-labelledby="stream">
        <h2 id="stream" className="m-0 text-sm font-semibold">{t('home.tracking')}</h2>
        <p data-testid="frame-count" className="mt-1 mb-0 text-sm" aria-live="polite">
          {captureError ?? (frames > 0 ? t('home.frames', { count: frames }) : t('home.waiting'))}
        </p>
      </section>

      <footer className="mt-auto text-[11px] text-muted">
        app 0.1.0 · capture-kit {PLUGIN_VERSION} · quality-core {QUALITY_CORE_VERSION}
      </footer>
    </div>
  );
}
