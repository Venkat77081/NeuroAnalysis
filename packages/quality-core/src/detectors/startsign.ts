/**
 * v36 (decision 063): the patient starts a recording with a sign instead of tapping Record.
 *
 * - `palm`: an open hand facing the camera, fingers up (FT, FTF, FR, FA).
 * - `arm`: one wrist above the head (Stand and Walk: at 3–4 m hands are too small to read).
 *
 * The sign must be held still for `holdS`; short tracking gaps (`maxGapS`) are bridged; moving
 * the hand more than `maxDriftFrac` of its own size restarts the hold. After it fires, it fires
 * again only once the sign has been put down. Coordinates are the analysis frame's normalised x, y.
 */
import type { Landmark, LandmarkFrame } from '../types.ts';

export type StartSignKind = 'palm' | 'arm';

export interface StartSignConfig {
  holdS: number;
  maxGapS: number;
  maxDriftFrac: number;
  /** Fingers (index, middle, ring, little) that must be straight. */
  palmMinFingers: number;
  /** How far above the nose the wrist must be, as a share of the shoulder width. */
  armMarginFrac: number;
}

/** Where the sign is, and its size (for the stillness test). */
export interface SignPoint {
  x: number;
  y: number;
  size: number;
}

const dist = (a: Landmark, b: Landmark) => Math.hypot(a.x - b.x, a.y - b.y);

/** [knuckle (MCP), middle joint (PIP), tip] of the four fingers (MediaPipe hand points). */
const FINGERS: [number, number, number][] = [
  [5, 6, 8],
  [9, 10, 12],
  [13, 14, 16],
  [17, 18, 20],
];

/** Straight fingers: the tip is further from the wrist than the middle joint, by 10 %. */
export function extendedFingers(pts: readonly Landmark[]): number {
  const wrist = pts[0];
  if (!wrist) return 0;
  return FINGERS.filter(([, pip, tip]) => {
    const p = pts[pip];
    const t = pts[tip];
    return !!p && !!t && dist(wrist, t) > dist(wrist, p) * 1.1;
  }).length;
}

/** An open palm with the fingers pointing up (the middle fingertip above the wrist). */
export function isOpenPalm(pts: readonly Landmark[], minFingers: number): boolean {
  const wrist = pts[0];
  const middleTip = pts[12];
  if (!wrist || !middleTip || pts.length < 21) return false;
  return middleTip.y < wrist.y && extendedFingers(pts) >= minFingers;
}

/** One wrist (pose 15 or 16) above the nose (pose 0) by `marginFrac` of the shoulder width. */
export function raisedWrist(pose: readonly Landmark[], marginFrac: number): Landmark | null {
  const nose = pose[0];
  const ls = pose[11];
  const rs = pose[12];
  if (!nose || !ls || !rs) return null;
  const visible = (p: Landmark) => p.v === undefined || p.v >= 0.5;
  const margin = marginFrac * dist(ls, rs);
  for (const i of [15, 16]) {
    const w = pose[i];
    if (w && visible(w) && w.y < nose.y - margin) return w;
  }
  return null;
}

/** The sign in this frame, or null. */
export function findSign(
  frame: LandmarkFrame,
  kind: StartSignKind,
  cfg: StartSignConfig,
): SignPoint | null {
  if (kind === 'palm') {
    for (const h of frame.hands) {
      if (isOpenPalm(h.pts, cfg.palmMinFingers)) {
        const w = h.pts[0]!;
        return { x: w.x, y: w.y, size: dist(w, h.pts[9]!) };
      }
    }
    return null;
  }
  const pose = frame.pose;
  if (!pose) return null;
  const w = raisedWrist(pose, cfg.armMarginFrac);
  return w ? { x: w.x, y: w.y, size: dist(pose[11]!, pose[12]!) } : null;
}

export interface SignState {
  /** 0–1 of the hold. */
  progress: number;
  /** True on the one update where the hold completed. */
  fired: boolean;
}

/** Turns per-frame sightings into "held still for holdS" (one fire per raise). */
export class StartSignTracker {
  private start: number | null = null;
  private anchor: SignPoint | null = null;
  private lastSeen = -Infinity;
  private done = false;

  constructor(private readonly cfg: StartSignConfig) {}

  update(tS: number, p: SignPoint | null): SignState {
    if (!p) {
      if (tS - this.lastSeen > this.cfg.maxGapS) {
        this.start = null;
        this.anchor = null;
        this.done = false; // put down: may fire again
      }
      return { progress: this.progressAt(tS), fired: false };
    }
    this.lastSeen = tS;
    if (this.done) return { progress: 1, fired: false };
    const moved =
      this.anchor !== null &&
      Math.hypot(p.x - this.anchor.x, p.y - this.anchor.y) >
        this.cfg.maxDriftFrac * Math.max(p.size, 1e-6);
    if (this.start === null || moved) {
      this.start = tS;
      this.anchor = p;
    }
    const progress = this.progressAt(tS);
    if (progress >= 1) {
      this.done = true;
      return { progress: 1, fired: true };
    }
    return { progress, fired: false };
  }

  reset(): void {
    this.start = null;
    this.anchor = null;
    this.lastSeen = -Infinity;
    this.done = false;
  }

  private progressAt(tS: number): number {
    if (this.start === null) return 0;
    return Math.max(0, Math.min(1, (tS - this.start) / this.cfg.holdS));
  }
}
