import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PreviewTransform } from '@neurocapture/capture-kit';
import { camera, capture } from '../lib/capture.ts';

/**
 * M1 overlay check: native preview behind a transparent WebView, with a canvas overlay
 * (safe-zone brackets, centre cross, 3×3 grid) drawn on top.
 */
export function CameraTest({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [transform, setTransform] = useState<PreviewTransform | null>(null);
  const [stats, setStats] = useState({ fps: 0, luma: 0 });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.classList.add('camera-active');
    let cancelled = false;
    let handle: { remove: () => Promise<void> } | undefined;
    let count = 0;
    let lastLuma = 0;
    const timer = setInterval(() => {
      setStats({ fps: count, luma: Math.round(lastLuma) });
      count = 0;
    }, 1000);
    void capture.kit
      .addListener('analysisFrame', (f) => {
        count++;
        lastLuma = f.stats.lumaMean;
      })
      .then((h) => (cancelled ? void h.remove() : (handle = h)));
    camera
      .open({
        facing: 'back',
        resolution: '1080p',
        targetFps: 60,
        orientation: 'portrait',
        trackers: [],
        analysisFps: 30,
      })
      .then((r) => !cancelled && setTransform(r.previewTransform))
      .catch((e: unknown) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
      clearInterval(timer);
      void handle?.remove();
      void camera.close().catch(() => undefined);
      document.documentElement.classList.remove('camera-active');
    };
  }, []);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    c.width = w * dpr;
    c.height = h * dpr;
    const g = c.getContext('2d');
    if (!g) return;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    // Frame of the analysis image on screen (falls back to the full view).
    const fx = transform?.offsetX ?? 0;
    const fy = transform?.offsetY ?? 0;
    const fw = transform?.scaleX ?? w;
    const fh = transform?.scaleY ?? h;
    const m = 0.05;
    const x0 = fx + fw * m;
    const y0 = fy + fh * m;
    const x1 = fx + fw * (1 - m);
    const y1 = fy + fh * (1 - m);
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.lineWidth = 1;
    for (const k of [1, 2]) {
      g.beginPath();
      g.moveTo(fx + (fw * k) / 3, fy);
      g.lineTo(fx + (fw * k) / 3, fy + fh);
      g.moveTo(fx, fy + (fh * k) / 3);
      g.lineTo(fx + fw, fy + (fh * k) / 3);
      g.stroke();
    }
    g.strokeStyle = '#5BE3A0';
    g.lineWidth = 3;
    const L = 28;
    g.beginPath();
    g.moveTo(x0, y0 + L);
    g.lineTo(x0, y0);
    g.lineTo(x0 + L, y0);
    g.moveTo(x1 - L, y0);
    g.lineTo(x1, y0);
    g.lineTo(x1, y0 + L);
    g.moveTo(x1, y1 - L);
    g.lineTo(x1, y1);
    g.lineTo(x1 - L, y1);
    g.moveTo(x0 + L, y1);
    g.lineTo(x0, y1);
    g.lineTo(x0, y1 - L);
    g.stroke();
    const cx = fx + fw / 2;
    const cy = fy + fh / 2;
    g.beginPath();
    g.moveTo(cx - 14, cy);
    g.lineTo(cx + 14, cy);
    g.moveTo(cx, cy - 14);
    g.lineTo(cx, cy + 14);
    g.stroke();
  }, [transform]);

  return (
    <div className="fixed inset-0" data-testid="camera-test">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" aria-hidden="true" />
      <div className="absolute inset-x-4 top-4 flex items-center justify-between gap-2">
        <span
          className="rounded-xl bg-[#0E1116] px-3 py-2 text-sm font-semibold text-white"
          data-testid="camera-test-stats"
        >
          {error ?? t('deviceCheck.cameraStats', { fps: stats.fps, luma: stats.luma })}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="h-11 rounded-xl bg-white px-4 text-sm font-semibold text-ink"
        >
          {t('common.close')}
        </button>
      </div>
      <p className="absolute inset-x-4 bottom-6 m-0 rounded-xl bg-[#0E1116] px-3 py-2 text-xs text-[#B8C0CC]">
        {t('deviceCheck.cameraHint')}
      </p>
    </div>
  );
}
