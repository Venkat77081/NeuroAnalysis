import type { PreviewTransform } from '@neurocapture/capture-kit';
import type { LandmarkFrame } from '@neurocapture/quality-core';
import quality from '../../../../config/quality.json' with { type: 'json' };
import { HAND_EDGES, POSE_EDGES, toScreen } from './landmark-geometry.ts';

type Pt = { x: number; y: number };

/** Same limit as the required-landmarks check (config/quality.json). */
const POSE_MIN_VISIBILITY = quality.checks.required_landmarks_visible.poseMinVisibility;

/**
 * Draws one frame's hands (blue = L, orange = R), pose (green) and face (white dots) on a 2D
 * canvas through a transform. Shared by the live overlay and the replay overlay.
 */
export function drawLandmarks(
  g: CanvasRenderingContext2D,
  f: LandmarkFrame,
  t: PreviewTransform,
  rawLabels?: readonly (string | undefined)[],
): void {
  const map = (p: Pt) => toScreen(p.x, p.y, t);
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
      g.font = '700 16px system-ui';
      const raw = rawLabels?.[i];
      g.fillText(raw ? `${hand.side} (raw ${raw})` : hand.side, pts[0].x + 6, pts[0].y + 16);
    }
  }
  if (f.pose) {
    // Only confident body points: a pose model can "find" a body in a close-up hand (low
    // visibility); drawing those looks like extra landmarks on the hand.
    const pts = f.pose.map((p) => ((p.v ?? 1) >= POSE_MIN_VISIBILITY ? map(p) : undefined));
    lines(pts as Pt[], POSE_EDGES, '#81C784');
    dots(
      pts.filter((p): p is Pt => !!p),
      '#81C784',
      3,
    );
  }
  if (f.face) dots(f.face.pts.map(map), 'rgba(255,255,255,0.7)', 1);
}

/** Size a canvas to its CSS box at device pixel ratio; returns the 2D context in CSS pixels. */
export function fitCanvas(
  c: HTMLCanvasElement,
  w: number,
  h: number,
): CanvasRenderingContext2D | null {
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(w * dpr)) c.width = Math.round(w * dpr);
  if (c.height !== Math.round(h * dpr)) c.height = Math.round(h * dpr);
  const g = c.getContext('2d');
  if (!g) return null;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return g;
}
