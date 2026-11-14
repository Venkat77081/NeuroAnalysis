import { useEffect, useRef } from 'react';
import {
  decodeAnalysisFrame,
  type AnalysisFrameEvent,
  type PreviewTransform,
} from '@neurocapture/capture-kit';
import { capture } from '../lib/capture.ts';
import { HAND_EDGES, POSE_EDGES, toScreen } from './landmark-geometry.ts';

type Pt = { x: number; y: number };

/**
 * Debug overlay (M4): draws the latest analysisFrame's hands, pose and face on a full-screen
 * canvas mapped through previewTransform. Engineering only; operators never see it.
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
      const t = tr.current;
      if (!c || !e || !t || e.seq === drawnSeq) return;
      drawnSeq = e.seq;
      const dpr = window.devicePixelRatio || 1;
      const w = window.innerWidth;
      const h = window.innerHeight;
      if (c.width !== Math.round(w * dpr)) c.width = Math.round(w * dpr);
      if (c.height !== Math.round(h * dpr)) c.height = Math.round(h * dpr);
      const g = c.getContext('2d');
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const f = decodeAnalysisFrame(e, { imageMirrored: false });
      const map = (p: { x: number; y: number }) => toScreen(p.x, p.y, t);
      const lines = (pts: Pt[], edges: [number, number][], color: string) => {
        g.strokeStyle = color;
        g.lineWidth = 2;
        g.beginPath();
        for (const [a, b] of edges) {
          if (!pts[a] || !pts[b]) continue;
          g.moveTo(pts[a].x, pts[a].y);
          g.lineTo(pts[b].x, pts[b].y);
        }
        g.stroke();
      };
      const dots = (pts: Pt[], color: string, r: number) => {
        g.fillStyle = color;
        for (const p of pts) {
          g.beginPath();
          g.arc(p.x, p.y, r, 0, Math.PI * 2);
          g.fill();
        }
      };
      for (const [i, hand] of f.hands.entries()) {
        const pts = hand.pts.map(map);
        const color = hand.side === 'L' ? '#4FC3F7' : '#FFB74D';
        lines(pts, HAND_EDGES, color);
        dots(pts, color, 3);
        if (pts[0]) {
          g.font = '700 18px system-ui';
          // Debug: our side + MediaPipe's raw label, to verify the handedness rule (decision 012).
          g.fillText(
            `${hand.side} (raw ${e.hands?.[i]?.handedness ?? '?'})`,
            pts[0].x + 6,
            pts[0].y + 16,
          );
        }
      }
      if (f.pose) {
        const pts = f.pose.map(map);
        lines(pts, POSE_EDGES, '#81C784');
        dots(pts, '#81C784', 3);
      }
      if (f.face) dots(f.face.pts.map(map), 'rgba(255,255,255,0.7)', 1);
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
