/** Pure image/geometry helpers for the browser webcam mode (mirror of Kotlin FrameMath). */

/** Yaw/pitch/roll (degrees) from a column-major 4×4 facial transformation matrix. */
export function faceAngles(m: ArrayLike<number>): {
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
} {
  const r = (row: number, col: number) => m[col * 4 + row]!;
  const deg = (x: number) => (x * 180) / Math.PI;
  return {
    yawDeg: deg(Math.asin(Math.max(-1, Math.min(1, -r(2, 0))))),
    pitchDeg: deg(Math.atan2(r(2, 1), r(2, 2))),
    rollDeg: deg(Math.atan2(r(1, 0), r(0, 0))),
  };
}

const luma = (d: ArrayLike<number>, i: number) =>
  (77 * d[i]! + 150 * d[i + 1]! + 29 * d[i + 2]!) >> 8;

/** Mean luma, clipped fraction and Laplacian variance (central 50 %) of an RGBA image. */
export function frameStats(
  d: ArrayLike<number>,
  w: number,
  h: number,
): { lumaMean: number; clippedFrac: number; sharpness: number } {
  let sum = 0;
  let n = 0;
  let clipped = 0;
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const l = luma(d, (y * w + x) * 4);
      sum += l;
      if (l <= 2 || l >= 253) clipped++;
      n++;
    }
  }
  let s = 0;
  let s2 = 0;
  let m = 0;
  const px = (x: number, y: number) => luma(d, (y * w + x) * 4);
  for (let y = Math.max(Math.floor(h / 4), 1); y < Math.min(Math.floor((h * 3) / 4), h - 1); y++) {
    for (
      let x = Math.max(Math.floor(w / 4), 1);
      x < Math.min(Math.floor((w * 3) / 4), w - 1);
      x++
    ) {
      const lap = px(x - 1, y) + px(x + 1, y) + px(x, y - 1) + px(x, y + 1) - 4 * px(x, y);
      s += lap;
      s2 += lap * lap;
      m++;
    }
  }
  return {
    lumaMean: n ? sum / n : 0,
    clippedFrac: n ? clipped / n : 0,
    sharpness: m ? s2 / m - (s / m) ** 2 : 0,
  };
}

/** Left/right mean luma of the face box (normalized x,y,z triples); null when not measurable. */
export function faceLumaRatio(
  d: ArrayLike<number>,
  w: number,
  h: number,
  pts: ArrayLike<number>,
): number | null {
  let minX = 1;
  let maxX = 0;
  let minY = 1;
  let maxY = 0;
  for (let i = 0; i + 2 < pts.length; i += 3) {
    minX = Math.min(minX, pts[i]!);
    maxX = Math.max(maxX, pts[i]!);
    minY = Math.min(minY, pts[i + 1]!);
    maxY = Math.max(maxY, pts[i + 1]!);
  }
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const [x0, x1, y0, y1] = [
    Math.floor(clamp(minX) * w),
    Math.floor(clamp(maxX) * w),
    Math.floor(clamp(minY) * h),
    Math.floor(clamp(maxY) * h),
  ];
  if (x1 - x0 < 4 || y1 - y0 < 4) return null;
  const mid = Math.floor((x0 + x1) / 2);
  let l = 0;
  let ln = 0;
  let r = 0;
  let rn = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const v = luma(d, (y * w + x) * 4);
      if (x < mid) {
        l += v;
        ln++;
      } else {
        r += v;
        rn++;
      }
    }
  }
  if (!ln || !rn || !r) return null;
  return l / ln / (r / rn);
}
