/**
 * v36 (decision 063): the phone check's hand-sign try-out. The front camera opens with hand
 * and face tracking; the patient raises an open palm above the head for a second. Measures how often tracking updates
 * (it needs `startSign.check.minTrackingHz`) and whether the sign was seen within `tryoutS`.
 * Optional: the patient can skip, and joining never waits for it.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useApp } from '../../app/AppContext.tsx';
import { camera, capture } from '../../lib/capture.ts';
import { tryOutSign, type SignCheck } from '../../lib/startsign.ts';
import { Button } from '../../ui/kit.tsx';

export function SignTryout({ onDone }: { onDone: (status: SignCheck, hz: number) => void }) {
  const { t } = useTranslation();
  const { config } = useApp();
  const cfg = config.session.startSign!;
  const [progress, setProgress] = useState(0);
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });
  const finished = useRef(false);
  const finish = (status: SignCheck, hz: number) => {
    if (finished.current) return;
    finished.current = true;
    done.current(status, hz);
  };

  useEffect(() => {
    let alive = true;
    document.documentElement.classList.add('camera-active', 'sign-tryout');
    void camera
      .open({
        facing: 'front',
        resolution: '720p',
        targetFps: 30,
        orientation: 'portrait',
        // The face tells where the head is: the palm counts only above it.
        trackers: ['hand', 'face'],
        analysisFps: 15,
      })
      .then(
        () =>
          tryOutSign('palm', cfg, cfg.check.tryoutS, (p) => alive && setProgress(p)).then(
            ({ seen, hz }) =>
              finish(hz < cfg.check.minTrackingHz ? 'too_slow' : seen ? 'works' : 'not_seen', hz),
          ),
        () => finish('not_seen', 0),
      );
    return () => {
      alive = false;
      document.documentElement.classList.remove('camera-active', 'sign-tryout');
      void camera.close().catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per try-out
  }, []);

  // Outside #root: the page underneath is hidden so the camera preview shows through (native).
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-between px-5 pt-[calc(2rem+var(--sat))] pb-[calc(1.5rem+var(--sab))] text-white"
      data-testid="sign-tryout"
    >
      {capture.implementation !== 'native' && (
        <div className="absolute inset-0 -z-10 bg-cam-panel" aria-hidden="true" />
      )}
      <span className="rounded-full bg-cam px-4 py-2 text-[13px] font-semibold">
        {t('modes.deviceCheck.sign.step')}
      </span>
      <div className="flex flex-col items-center gap-3 text-center">
        <div
          className="flex size-32 items-center justify-center rounded-full border-[6px] border-white/25"
          style={{
            background: `conic-gradient(#f97360 ${progress * 360}deg, transparent 0)`,
          }}
          aria-hidden="true"
        >
          <span className="flex size-[100px] items-center justify-center rounded-full bg-cam">
            <svg
              width="48"
              height="48"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12" />
              <path d="M11 11.5V4a1.5 1.5 0 0 1 3 0v7.5" />
              <path d="M14 11.5V5.5a1.5 1.5 0 0 1 3 0V13" />
              <path d="M17 9.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1.5a6 6 0 0 1-5-2.7L4.6 14.4a1.6 1.6 0 0 1 2.6-1.8L8 13.5" />
            </svg>
          </span>
        </div>
        <b className="text-[22px]">{t('modes.deviceCheck.sign.title')}</b>
        <span className="max-w-[280px] text-[14px] leading-5 text-white/80">
          {t('modes.deviceCheck.sign.hint')}
        </span>
      </div>
      <Button
        variant="secondary"
        className="w-full"
        onClick={() => finish('skipped', 0)}
        data-testid="sign-tryout-skip"
      >
        {t('modes.deviceCheck.sign.skip')}
      </Button>
    </div>,
    document.body,
  );
}
