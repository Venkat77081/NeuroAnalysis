import type { PreviewTransform } from '@neurocapture/capture-kit';

/**
 * Normalized landmark (upright analysis image, not mirrored) → CSS pixels over the preview.
 * The analysis image is already upright, so only mirroring (front camera preview) and the
 * FILL_CENTER scale/offset apply. rotationDeg is kept for streams that are not upright.
 */
export function toScreen(x: number, y: number, t: PreviewTransform): { x: number; y: number } {
  let u = x;
  let v = y;
  switch (t.rotationDeg) {
    case 90:
      [u, v] = [1 - y, x];
      break;
    case 180:
      [u, v] = [1 - x, 1 - y];
      break;
    case 270:
      [u, v] = [y, 1 - x];
      break;
    default:
      break;
  }
  if (t.mirrored) u = 1 - u;
  return { x: t.offsetX + u * t.scaleX, y: t.offsetY + v * t.scaleY };
}

/**
 * Transform for an image shown full-screen with "cover" scaling (the native preview uses
 * FILL_CENTER over the whole window). Computed from the current window size on every frame,
 * because a transform captured when the camera opened can predate a portrait→landscape turn.
 */
export function coverTransform(
  imageW: number,
  imageH: number,
  viewW: number,
  viewH: number,
  mirrored: boolean,
): PreviewTransform {
  const s = Math.max(viewW / imageW, viewH / imageH);
  const dw = imageW * s;
  const dh = imageH * s;
  return {
    scaleX: dw,
    scaleY: dh,
    offsetX: (viewW - dw) / 2,
    offsetY: (viewH - dh) / 2,
    rotationDeg: 0,
    mirrored,
  };
}

/** Transform for a video shown with "contain" scaling inside a viewW×viewH box (replay). */
export function containTransform(
  imageW: number,
  imageH: number,
  viewW: number,
  viewH: number,
): PreviewTransform {
  const s = Math.min(viewW / imageW, viewH / imageH);
  const dw = imageW * s;
  const dh = imageH * s;
  return {
    scaleX: dw,
    scaleY: dh,
    offsetX: (viewW - dw) / 2,
    offsetY: (viewH - dh) / 2,
    rotationDeg: 0,
    mirrored: false,
  };
}

/** Index of the record whose time is nearest to tNs (times sorted ascending); -1 if empty. */
export function nearestIndex(times: readonly bigint[], tNs: bigint): number {
  if (!times.length) return -1;
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! < tNs) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && tNs - times[lo - 1]! < times[lo]! - tNs) return lo - 1;
  return lo;
}

/** MediaPipe hand connections (21 points). */
export const HAND_EDGES: [number, number][] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [0, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [5, 9],
  [9, 10],
  [10, 11],
  [11, 12],
  [9, 13],
  [13, 14],
  [14, 15],
  [15, 16],
  [13, 17],
  [17, 18],
  [18, 19],
  [19, 20],
  [0, 17],
];

/** Upper-body + legs subset of the 33 pose points. */
export const POSE_EDGES: [number, number][] = [
  [11, 12],
  [11, 13],
  [13, 15],
  [12, 14],
  [14, 16],
  [11, 23],
  [12, 24],
  [23, 24],
  [23, 25],
  [25, 27],
  [24, 26],
  [26, 28],
  [27, 31],
  [28, 32],
];
