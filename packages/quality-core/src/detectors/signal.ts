/** Signal helpers for the task detectors (DEV_PLAN §9.4). Pure functions, no clock access. */

/** One-Euro filter (Casiez et al. 2012): low lag when moving, smooth when still. */
export class OneEuroFilter {
  private x: number | null = null;
  private dx = 0;
  private t: number | null = null;

  constructor(
    private readonly minCutoff = 1.0,
    private readonly beta = 0.007,
    private readonly dCutoff = 1.0,
  ) {}

  private static alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  /** Filter value v sampled at time tS (seconds, increasing). */
  filter(v: number, tS: number): number {
    if (this.x === null || this.t === null || tS <= this.t) {
      this.x = v;
      this.t = tS;
      return v;
    }
    const dt = tS - this.t;
    this.t = tS;
    const rawDx = (v - this.x) / dt;
    const ad = OneEuroFilter.alpha(this.dCutoff, dt);
    this.dx = ad * rawDx + (1 - ad) * this.dx;
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    const a = OneEuroFilter.alpha(cutoff, dt);
    this.x = a * v + (1 - a) * this.x;
    return this.x;
  }
}

/** Run a One-Euro filter over a whole series. */
export function oneEuro(
  values: readonly number[],
  timesS: readonly number[],
  minCutoff: number,
  beta: number,
): number[] {
  const f = new OneEuroFilter(minCutoff, beta);
  return values.map((v, i) => f.filter(v, timesS[i]!));
}

/**
 * Savitzky–Golay smoothing (quadratic, window 2m+1) for offline recompute. Edges keep the raw
 * value. Coefficients c_i = 3(3m² + 3m − 1 − 5i²) / ((2m − 1)(2m + 1)(2m + 3)).
 */
export function savitzkyGolay(values: readonly number[], halfWindow = 2): number[] {
  const m = halfWindow;
  const norm = (2 * m - 1) * (2 * m + 1) * (2 * m + 3);
  const c = Array.from({ length: 2 * m + 1 }, (_, k) => {
    const i = k - m;
    return (3 * (3 * m * m + 3 * m - 1 - 5 * i * i)) / norm;
  });
  return values.map((v, n) => {
    if (n < m || n >= values.length - m) return v;
    let s = 0;
    for (let k = -m; k <= m; k++) s += c[k + m]! * values[n + k]!;
    return s;
  });
}

export interface Peak {
  index: number;
  tS: number;
  value: number;
  prominence: number;
}

/**
 * Local maxima with at least `minProminence` (height above the higher of the two surrounding
 * minima) and at least `minDistanceS` apart (the more prominent peak wins).
 */
export function findPeaks(
  values: readonly number[],
  timesS: readonly number[],
  opts: { minProminence: number; minDistanceS: number },
): Peak[] {
  const n = values.length;
  const cands: Peak[] = [];
  for (let i = 1; i < n - 1; i++) {
    const v = values[i]!;
    if (!(v > values[i - 1]! && v >= values[i + 1]!)) continue;
    let leftMin = v;
    for (let j = i - 1; j >= 0 && values[j]! <= v; j--) leftMin = Math.min(leftMin, values[j]!);
    let rightMin = v;
    for (let j = i + 1; j < n && values[j]! <= v; j++) rightMin = Math.min(rightMin, values[j]!);
    const prominence = v - Math.max(leftMin, rightMin);
    if (prominence >= opts.minProminence)
      cands.push({ index: i, tS: timesS[i]!, value: v, prominence });
  }
  // Enforce the minimum distance: keep the most prominent peaks first.
  const kept: Peak[] = [];
  for (const p of [...cands].sort((a, b) => b.prominence - a.prominence)) {
    if (kept.every((k) => Math.abs(k.tS - p.tS) >= opts.minDistanceS)) kept.push(p);
  }
  return kept.sort((a, b) => a.tS - b.tS);
}

export interface Window {
  tStartS: number;
  tEndS: number;
}

/**
 * Movement window (first to last sample faster than `threshold`) and no-motion windows (runs of
 * slower samples, inside the take, at least `minNoMotionS` long). `speeds[i]` belongs to
 * `timesS[i]`. NaN speeds (input unavailable) count as neither.
 */
export function motionWindows(
  timesS: readonly number[],
  speeds: readonly number[],
  threshold: number,
  minNoMotionS: number,
  takeEndS: number,
): { movementWindow: Window | null; noMotion: Window[] } {
  let first = -1;
  let last = -1;
  for (let i = 0; i < speeds.length; i++) {
    if (speeds[i]! > threshold) {
      if (first < 0) first = i;
      last = i;
    }
  }
  const movementWindow = first < 0 ? null : { tStartS: timesS[first]!, tEndS: timesS[last]! };
  const noMotion: Window[] = [];
  let runStart: number | null = null;
  const close = (endS: number) => {
    if (runStart !== null && endS - runStart >= minNoMotionS)
      noMotion.push({ tStartS: runStart, tEndS: endS });
    runStart = null;
  };
  for (let i = 0; i < speeds.length; i++) {
    const s = speeds[i]!;
    if (Number.isNaN(s)) continue;
    if (s <= threshold) runStart ??= timesS[i]!;
    else close(timesS[i]!);
  }
  close(Math.max(takeEndS, timesS.at(-1) ?? 0));
  return { movementWindow, noMotion };
}

/** |Δv| / Δt per sample (first sample NaN); NaN where either value is NaN. */
export function speed(values: readonly number[], timesS: readonly number[]): number[] {
  return values.map((v, i) => {
    if (i === 0) return NaN;
    const dt = timesS[i]! - timesS[i - 1]!;
    return dt > 0 ? Math.abs(v - values[i - 1]!) / dt : NaN;
  });
}

/**
 * Activity: range (max − min) of the signal over the trailing `windowS` seconds at each sample.
 * Robust to frame-to-frame landmark noise, unlike a raw derivative.
 */
export function rollingRange(
  values: readonly number[],
  timesS: readonly number[],
  windowS: number,
): number[] {
  const out: number[] = [];
  let lo = 0;
  for (let i = 0; i < values.length; i++) {
    while (timesS[i]! - timesS[lo]! > windowS) lo++;
    let mn = Infinity;
    let mx = -Infinity;
    for (let j = lo; j <= i; j++) {
      mn = Math.min(mn, values[j]!);
      mx = Math.max(mx, values[j]!);
    }
    out.push(mx - mn);
  }
  return out;
}
