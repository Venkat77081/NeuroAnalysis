/**
 * Positioning checks (DEV_PLAN §9.2) as pure functions. Each returns a CheckResult; `UNKNOWN`
 * means the input was unavailable (tracker error, no sensor data), never a failure (§9.1).
 * Thresholds come from config/quality.json and the test config; nothing is hard-coded here.
 */
import type {
  CheckState,
  FrameStats,
  Landmark,
  LandmarkFrame,
  PromptKey,
  SensorReading,
  Side,
  TrackerName,
} from '../types.ts';

export interface CheckResult {
  state: CheckState;
  value: number | null;
  threshold: number | [number, number] | null;
  confidence: number;
  hint?: PromptKey;
}

export type Orientation = 'portrait' | 'landscape';

const unknown = (threshold: CheckResult['threshold'] = null): CheckResult => ({
  state: 'UNKNOWN',
  value: null,
  threshold,
  confidence: 0,
});

function result(
  ok: boolean,
  value: number | null,
  threshold: CheckResult['threshold'],
  hint: PromptKey,
  confidence = 1,
): CheckResult {
  return ok
    ? { state: 'OK', value, threshold, confidence }
    : { state: 'FAIL', value, threshold, confidence, hint };
}

/** Any required tracker that errored makes landmark checks UNKNOWN. */
export function trackersErrored(frame: LandmarkFrame, trackers: readonly TrackerName[]): boolean {
  return trackers.some(
    (t) => frame.trackerStatus[t] === 'error' || frame.trackerStatus[t] === 'off',
  );
}

/** subject_present: every required tracker found something; both hands when the test needs them. */
export function subjectPresent(
  frame: LandmarkFrame,
  trackers: readonly TrackerName[],
  bothHands: boolean,
): CheckResult {
  if (trackersErrored(frame, trackers)) return unknown(trackers.length);
  const found = trackers.filter((t) => frame.trackerStatus[t] === 'ok').length;
  if (found < trackers.length) return result(false, found, trackers.length, 'no_subject');
  if (trackers.includes('hand') && bothHands) {
    const sides = new Set(frame.hands.map((h) => h.side));
    if (sides.size < 2) return result(false, found, trackers.length, 'show_both_hands');
  }
  return result(true, found, trackers.length, 'no_subject');
}

export interface RequiredLandmarks {
  hand?: number[];
  pose?: number[];
  face?: 'ALL' | number[];
}

/** The required points that are present and visible enough, in normalized image coordinates. */
export function requiredPoints(
  frame: LandmarkFrame,
  required: RequiredLandmarks,
  poseMinVisibility: number,
): Landmark[] {
  const pts: Landmark[] = [];
  for (const i of required.pose ?? []) {
    const p = frame.pose?.[i];
    if (p && (p.v ?? 1) >= poseMinVisibility) pts.push(p);
  }
  if (required.hand)
    for (const h of frame.hands) for (const i of required.hand) if (h.pts[i]) pts.push(h.pts[i]);
  if (required.face && frame.face) {
    const idx = required.face === 'ALL' ? frame.face.pts.map((_, i) => i) : required.face;
    for (const i of idx) if (frame.face.pts[i]) pts.push(frame.face.pts[i]);
  }
  return pts;
}

/** required_landmarks_visible: all listed points present (pose visibility, hand score, face mesh). */
export function requiredLandmarksVisible(
  frame: LandmarkFrame,
  required: RequiredLandmarks,
  bothHands: boolean,
  cfg: { poseMinVisibility: number; handMinScore: number },
): CheckResult {
  const trackers = (Object.keys(required) as TrackerName[]).filter(
    (t) => required[t] !== undefined,
  );
  if (trackersErrored(frame, trackers)) return unknown(1);
  let needed = 0;
  let seen = 0;
  let hint: PromptKey | null = null;
  if (required.pose) {
    needed += required.pose.length;
    const ok = required.pose.filter(
      (i) => (frame.pose?.[i]?.v ?? 0) >= cfg.poseMinVisibility,
    ).length;
    seen += ok;
    if (ok < required.pose.length) hint ??= 'show_body';
  }
  if (required.hand) {
    const handsNeeded = bothHands ? 2 : 1;
    const good = frame.hands.filter(
      (h) => h.score >= cfg.handMinScore && required.hand!.every((i) => h.pts[i] !== undefined),
    ).length;
    needed += handsNeeded;
    seen += Math.min(good, handsNeeded);
    if (good < handsNeeded) hint = 'show_both_hands';
  }
  if (required.face) {
    needed += 1;
    const n = required.face === 'ALL' ? 478 : Math.max(...required.face) + 1;
    if (frame.face && frame.face.pts.length >= n) seen += 1;
    else hint ??= 'show_face';
  }
  const frac = needed ? seen / needed : 1;
  return hint ? result(false, frac, 1, hint) : result(true, frac, 1, 'show_body');
}

/** in_safe_zone: every required point inside [m, 1 − m]. Cut off on two opposite edges = too close. */
export function inSafeZone(points: readonly Landmark[], margin: number): CheckResult {
  if (!points.length) return unknown(margin);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const lo = margin;
  const hi = 1 - margin;
  const value = Math.min(minX, minY, 1 - maxX, 1 - maxY);
  const left = minX < lo;
  const right = maxX > hi;
  const top = minY < lo;
  const bottom = maxY > hi;
  if (!left && !right && !top && !bottom) return result(true, value, margin, 'move_back');
  if ((left && right) || (top && bottom)) return result(false, value, margin, 'move_back');
  const hint: PromptKey = left
    ? 'cut_off_left'
    : right
      ? 'cut_off_right'
      : top
        ? 'cut_off_top'
        : 'cut_off_bottom';
  return result(false, value, margin, hint);
}

export type SizeMetric = 'hand_bbox_height' | 'upper_body_height' | 'body_height' | 'face_height';

function spanY(pts: readonly Landmark[]): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of pts) {
    lo = Math.min(lo, p.y);
    hi = Math.max(hi, p.y);
  }
  return pts.length ? hi - lo : NaN;
}

/**
 * Subject size as a fraction of the image's SHORT side, so the same thresholds work in portrait
 * and landscape:
 * - hand_bbox_height: tallest hand box
 * - upper_body_height: 4 × (shoulder midpoint − nose), ≈ head to lap, independent of arm pose
 * - body_height: box of the visible pose points
 * - face_height: face mesh box
 */
export function sizeMetric(
  frame: LandmarkFrame,
  metric: SizeMetric,
  poseMinVisibility: number,
): number | null {
  const w = frame.image?.w ?? 1;
  const h = frame.image?.h ?? 1;
  const toShort = h / Math.min(w, h);
  const vis = (p: Landmark | undefined): p is Landmark => !!p && (p.v ?? 1) >= poseMinVisibility;
  switch (metric) {
    case 'hand_bbox_height': {
      if (!frame.hands.length) return null;
      return Math.max(...frame.hands.map((hd) => spanY(hd.pts))) * toShort;
    }
    case 'upper_body_height': {
      const [nose, ls, rs] = [frame.pose?.[0], frame.pose?.[11], frame.pose?.[12]];
      if (!vis(nose) || !vis(ls) || !vis(rs)) return null;
      return 4 * ((ls.y + rs.y) / 2 - nose.y) * toShort;
    }
    case 'body_height': {
      const pts = (frame.pose ?? []).filter(vis);
      return pts.length ? spanY(pts) * toShort : null;
    }
    case 'face_height':
      return frame.face?.pts.length ? spanY(frame.face.pts) * toShort : null;
  }
}

/** subject_size: size metric within [min, max] from the test config. */
export function subjectSize(
  frame: LandmarkFrame,
  size: { metric: SizeMetric; min: number; max: number },
  poseMinVisibility: number,
): CheckResult {
  const v = sizeMetric(frame, size.metric, poseMinVisibility);
  const threshold: [number, number] = [size.min, size.max];
  if (v === null || Number.isNaN(v)) return unknown(threshold);
  if (v < size.min) return result(false, v, threshold, 'move_closer');
  if (v > size.max) return result(false, v, threshold, 'move_back');
  return result(true, v, threshold, 'move_back');
}

/** handedness_match: a hand on the tested side is in view (side already corrected, decision 012). */
export function handednessMatch(frame: LandmarkFrame, side: Side): CheckResult {
  if (!frame.hands.length) return unknown();
  const best = Math.max(...frame.hands.map((h) => h.score));
  return result(
    frame.hands.some((h) => h.side === side),
    null,
    null,
    'wrong_hand',
    best,
  );
}

/** single_person: at most one body / face (and two hands) found. */
export function singlePerson(frame: LandmarkFrame, trackers: readonly TrackerName[]): CheckResult {
  if (trackersErrored(frame, trackers)) return unknown(1);
  const c = frame.counts ?? {
    hands: frame.hands.length,
    poses: frame.pose ? 1 : 0,
    faces: frame.face ? 1 : 0,
  };
  const people = Math.max(
    trackers.includes('pose') ? c.poses : 0,
    trackers.includes('face') ? c.faces : 0,
    trackers.includes('hand') ? Math.ceil(c.hands / 2) : 0,
  );
  return result(people <= 1, people, 1, 'one_person');
}

/** side_view: |x(L shoulder) − x(R shoulder)| ÷ torso height below the limit (pixels, not normalized). */
export function sideView(
  frame: LandmarkFrame,
  maxRatio: number,
  poseMinVisibility: number,
): CheckResult {
  const p = frame.pose;
  const pts = [p?.[11], p?.[12], p?.[23], p?.[24]];
  if (pts.some((q) => !q || (q.v ?? 1) < poseMinVisibility)) return unknown(maxRatio);
  const [ls, rs, lh, rh] = pts as Landmark[];
  const w = frame.image?.w ?? 1;
  const h = frame.image?.h ?? 1;
  const torso = Math.abs(((lh!.y + rh!.y) / 2 - (ls!.y + rs!.y) / 2) * h);
  if (torso <= 0) return unknown(maxRatio);
  const ratio = (Math.abs(ls!.x - rs!.x) * w) / torso;
  return result(ratio < maxRatio, ratio, maxRatio, 'turn_side_on');
}

/** face_frontal: |yaw| and |pitch| within limits. */
export function faceFrontal(
  frame: LandmarkFrame,
  max: { yaw: number; pitch: number },
): CheckResult {
  if (!frame.face) return unknown([max.yaw, max.pitch]);
  const { yaw, pitch } = frame.face;
  const ok = Math.abs(yaw) <= max.yaw && Math.abs(pitch) <= max.pitch;
  return result(ok, Math.max(Math.abs(yaw), Math.abs(pitch)), [max.yaw, max.pitch], 'face_camera');
}

/** brightness: luma mean in range and clipped fraction below the limit. */
export function brightness(
  stats: FrameStats,
  cfg: { lumaMin: number; lumaMax: number; maxClippedFrac: number },
): CheckResult {
  const threshold: [number, number] = [cfg.lumaMin, cfg.lumaMax];
  if (stats.lumaMean < cfg.lumaMin) return result(false, stats.lumaMean, threshold, 'too_dark');
  if (stats.lumaMean > cfg.lumaMax || stats.clippedFrac >= cfg.maxClippedFrac)
    return result(false, stats.lumaMean, threshold, 'too_bright');
  return result(true, stats.lumaMean, threshold, 'too_dark');
}

/** face_light_balance: face left/right luma ratio in range. */
export function faceLightBalance(
  stats: FrameStats,
  cfg: { min: number; max: number },
): CheckResult {
  const r = stats.faceLumaRatio;
  const threshold: [number, number] = [cfg.min, cfg.max];
  if (r === undefined || !Number.isFinite(r)) return unknown(threshold);
  return result(r >= cfg.min && r <= cfg.max, r, threshold, 'uneven_light');
}

/** sharpness: Laplacian variance at least a fraction of the device baseline (calibrated). */
export function sharpness(stats: FrameStats, baseline: number, minFrac: number): CheckResult {
  const limit = baseline * minFrac;
  return result(stats.sharpness >= limit, stats.sharpness, limit, 'blurry');
}

/**
 * Roll (in the screen plane) and pitch (towards/away from the subject) of the phone, in degrees,
 * relative to upright portrait (gravity on +y) or landscape rotated left (gravity on +x).
 */
export function tiltAngles(
  g: { x: number; y: number; z: number },
  orientation: Orientation,
): { rollDeg: number; pitchDeg: number } {
  const n = Math.hypot(g.x, g.y, g.z);
  const [ex, ey] = orientation === 'portrait' ? [0, 1] : [1, 0];
  const roll = Math.atan2(g.x * ey - g.y * ex, g.x * ex + g.y * ey);
  const pitch = n > 0 ? Math.asin(Math.max(-1, Math.min(1, g.z / n))) : 0;
  return { rollDeg: (roll * 180) / Math.PI, pitchDeg: (pitch * 180) / Math.PI };
}

/** tilt: roll and pitch within the limits. */
export function tilt(
  gravity: { x: number; y: number; z: number } | null,
  orientation: Orientation,
  cfg: { maxRollDeg: number; maxPitchDeg: number },
): CheckResult {
  const threshold: [number, number] = [cfg.maxRollDeg, cfg.maxPitchDeg];
  if (!gravity) return unknown(threshold);
  const { rollDeg, pitchDeg } = tiltAngles(gravity, orientation);
  const ok = Math.abs(rollDeg) <= cfg.maxRollDeg && Math.abs(pitchDeg) <= cfg.maxPitchDeg;
  return result(ok, Math.max(Math.abs(rollDeg), Math.abs(pitchDeg)), threshold, 'level_phone');
}

/** shake: mean angular speed over the gyro samples of the last window below the limit. */
export function shake(gyro: readonly SensorReading[], maxRadPerS: number): CheckResult {
  if (!gyro.length) return unknown(maxRadPerS);
  const mean = gyro.reduce((s, g) => s + Math.hypot(g.x, g.y, g.z), 0) / gyro.length;
  return result(mean < maxRadPerS, mean, maxRadPerS, 'hold_still');
}

/** analysis_health: analysis fast enough and fresh enough to trust the other checks. */
export function analysisHealth(
  fps: number,
  latencyMs: number,
  cfg: { minFps: number; maxLatencyMs: number },
): CheckResult {
  const ok = fps >= cfg.minFps && latencyMs <= cfg.maxLatencyMs;
  return { state: ok ? 'OK' : 'FAIL', value: fps, threshold: cfg.minFps, confidence: 1 };
}
