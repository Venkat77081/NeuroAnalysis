import { useEffect, useRef } from 'react';
import {
  decodeAnalysisFrame,
  type AnalysisFrameEvent,
  type PreviewTransform,
} from '@neurocapture/capture-kit';
import { capture } from '../lib/capture.ts';
import { coverTransform } from './landmark-geometry.ts';
import { drawLandmarks, fitCanvas } from './draw.ts';

/**
 * Live landmark overlay: draws the latest analysisFrame's hands, pose and face on a full-screen
 * canvas over the camera preview (cover mapping from the frame size and the current window).
 * Drawing happens in requestAnimationFrame so a fast event stream never blocks the UI.
 */
export function LandmarkOverlay({ transform }: { transform: PreviewTransform | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const latest = useRef<AnalysisFrameEvent | null>(null);
  const tr = useRef(transform);
  useEffect(() => {
    tr.current = transform;
  });

  useEffect(() => {
    let handle: { remove: () => Promise<void> } | undefined;
    let cancelled = false;
    void capture.kit
      .addListener('analysisFrame', (e) => (latest.current = e))
      .then((h) => (cancelled ? void h.remove() : (handle = h)));
    let raf = 0;
    let drawnSeq = -1;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const c = ref.current;
      const e = latest.current;
      if (!c || !e || e.seq === drawnSeq || !e.imageW || !e.imageH) return;
      drawnSeq = e.seq;
      const w = window.innerWidth;
      const h = window.innerHeight;
      const g = fitCanvas(c, w, h);
      if (!g) return;
      const t = coverTransform(e.imageW, e.imageH, w, h, tr.current?.mirrored ?? false);
      drawLandmarks(
        g,
        decodeAnalysisFrame(e, { imageMirrored: false }),
        t,
        (e.hands ?? []).map((x) => x.handedness),
      );
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      void handle?.remove();
    };
  }, []);

  return (
    <canvas
      ref={ref}
      className="pointer-events-none absolute inset-0 h-full w-full"
      data-testid="landmark-overlay"
      aria-hidden="true"
    />
  );
}
