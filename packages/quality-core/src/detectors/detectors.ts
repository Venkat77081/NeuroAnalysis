/**
 * Task detectors (DEV_PLAN §9.4) for capture quality: they find the protocol's movement events,
 * the movement window and no-motion gaps. They never stop recording and are not biomarkers
 * (decision 017). Input: the take's LandmarkFrames; all thresholds from the test config.
 */
import type { Landmark, LandmarkFrame, Side } from '../types.ts';
import { findPeaks, motionWindows, oneEuro, rollingRange, type Window } from './signal.ts';

export type DetectorName =
  'tap_counter' | 'ftf_cycle_counter' | 'rotation_counter' | 'saw_phases' | 'expression_sequence';

export type DetectorEventKind =
  | 'tap'
  | 'touch'
  | 'roll'
  | 'stand_up'
  | 'walk_out'
  | 'turn'
  | 'walk_back'
  | 'sit_down'
  | 'brow'
  | 'smile';

export interface DetectorEvent {
  tS: number;
  kind: DetectorEventKind;
  side?: Side;
}

export interface DetectorResult {
  detector: DetectorName;
  events: DetectorEvent[];
  /** Event counts by side ("R", "L") or "all". */
  counts: Record<string, number>;
  /** The protocol was carried out (enough events / all SAW phases / full FA sequence). */
  complete: boolean;
  movementWindow: Window | null;
  /** No-motion windows at least noMotionTimeoutS long. */
  noMotion: Window[];
}

interface Common {
  /** One-Euro smoothing of the detector signal. */
  minCutoff: number;
  beta: number;
  /** Signal range (reference lengths) over motionWindowS above which the subject is "moving". */
  motionThreshold: number;
  motionWindowS: number;
}

export interface PeakParams extends Common {
  minProminence: number;
  minDistanceS: number;
  /** Events needed per side (FT, FR) or in total (FTF) for "complete". */
  minEvents: number;
}

export interface SawParams extends Common {
  /** Hip rise, in trunk lengths, that counts as standing up. */
  standRiseFrac: number;
  /** Horizontal hip speed, in trunk lengths per second, that counts as walking. */
  walkMinSpeed: number;
  minTurns: number;
}

export interface FaceParams extends Common {
  browKeys: string[];
  smileKeys: string[];
  minPeak: number;
  minProminence: number;
  minDistanceS: number;
  /** Peaks of each expression needed (the protocol does the sequence twice). */
  minEach: number;
  /** Once the sequence is complete the patient may rest: later no-motion is not a stop. */
  restAfterComplete?: boolean;
}

export type DetectorParams = PeakParams | SawParams | FaceParams;

interface Px {
  x: number;
  y: number;
}

const toPx = (p: Landmark, f: LandmarkFrame): Px => ({
  x: p.x * (f.image?.w ?? 1),
  y: p.y * (f.image?.h ?? 1),
});
const dist = (a: Px, b: Px) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a: Px, b: Px): Px => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const visible = (p: Landmark | undefined, min = 0.5): p is Landmark => !!p && (p.v ?? 1) >= min;

function series(
  frames: readonly LandmarkFrame[],
  t0Ns: bigint,
  fn: (f: LandmarkFrame) => number | null,
) {
  const t: number[] = [];
  const v: number[] = [];
  for (const f of frames) {
    const x = fn(f);
    if (x === null || !Number.isFinite(x)) continue;
    t.push(Number(f.tNs - t0Ns) / 1e9);
    v.push(x);
  }
  return { t, v };
}

const median = (xs: readonly number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

/**
 * A signal in reference lengths: per frame a raw distance (px) and a reference length (px);
 * raw values are divided by the MEDIAN reference of the take, so noise in the reference (e.g.
 * elbow–wrist jitter) does not leak into the signal.
 */
function normSeries(
  frames: readonly LandmarkFrame[],
  t0Ns: bigint,
  fn: (f: LandmarkFrame) => { raw: number; ref: number } | null,
) {
  const t: number[] = [];
  const raw: number[] = [];
  const refs: number[] = [];
  for (const f of frames) {
    const x = fn(f);
    if (!x || !Number.isFinite(x.raw) || !(x.ref > 0)) continue;
    t.push(Number(f.tNs - t0Ns) / 1e9);
    raw.push(x.raw);
    refs.push(x.ref);
  }
  const ref = median(refs);
  return { t, v: raw.map((r) => r / ref) };
}

/** Activity trace for motion windows: range of the smoothed signal over motionWindowS. */
function activity(sm: number[], t: number[], p: Common) {
  return { t, s: rollingRange(sm, t, p.motionWindowS) };
}

function hand(f: LandmarkFrame, side: Side) {
  return f.hands.find((h) => h.side === side);
}

function handSize(f: LandmarkFrame, pts: Landmark[]): number {
  return dist(toPx(pts[0]!, f), toPx(pts[9]!, f));
}

/** Merge per-signal speeds into one motion trace per frame time (max over signals). */
function mergeSpeeds(parts: { t: number[]; s: number[] }[]): { t: number[]; s: number[] } {
  const m = new Map<number, number>();
  for (const p of parts)
    p.t.forEach((t, i) => {
      const s = p.s[i]!;
      if (!Number.isNaN(s)) m.set(t, Math.max(m.get(t) ?? 0, s));
    });
  const t = [...m.keys()].sort((a, b) => a - b);
  return { t, s: t.map((x) => m.get(x)!) };
}

function finish(
  detector: DetectorName,
  events: DetectorEvent[],
  counts: Record<string, number>,
  complete: boolean,
  motion: { t: number[]; s: number[] },
  p: Common,
  noMotionTimeoutS: number,
  takeEndS: number,
): DetectorResult {
  const w = motionWindows(motion.t, motion.s, p.motionThreshold, noMotionTimeoutS, takeEndS);
  return {
    detector,
    events: events.sort((a, b) => a.tS - b.tS),
    counts,
    complete,
    movementWindow: w.movementWindow,
    noMotion: w.noMotion,
  };
}

/** FT: thumb-tip (4) ↔ index-tip (8) distance ÷ hand size; each closing (minimum) is a tap. */
function tapCounter(
  frames: readonly LandmarkFrame[],
  t0: bigint,
  p: PeakParams,
  timeout: number,
  end: number,
) {
  const events: DetectorEvent[] = [];
  const counts: Record<string, number> = {};
  const motion = [];
  for (const side of ['R', 'L'] as Side[]) {
    const s = normSeries(frames, t0, (f) => {
      const h = hand(f, side);
      if (!h || h.pts.length < 21) return null;
      return { raw: dist(toPx(h.pts[4]!, f), toPx(h.pts[8]!, f)), ref: handSize(f, h.pts) };
    });
    const sm = oneEuro(s.v, s.t, p.minCutoff, p.beta);
    const peaks = findPeaks(
      sm.map((x) => -x),
      s.t,
      p,
    );
    counts[side] = peaks.length;
    events.push(...peaks.map((k) => ({ tS: k.tS, kind: 'tap' as const, side })));
    motion.push(activity(sm, s.t, p));
  }
  const complete = counts.R! >= p.minEvents && counts.L! >= p.minEvents;
  return finish('tap_counter', events, counts, complete, mergeSpeeds(motion), p, timeout, end);
}

/** FR: each wrist circles (hands roll around each other); a roll is a top of the wrist path. */
function rotationCounter(
  frames: readonly LandmarkFrame[],
  t0: bigint,
  p: PeakParams,
  timeout: number,
  end: number,
) {
  const events: DetectorEvent[] = [];
  const counts: Record<string, number> = {};
  const motion = [];
  for (const side of ['R', 'L'] as Side[]) {
    const s = normSeries(frames, t0, (f) => {
      const h = hand(f, side);
      if (!h || h.pts.length < 21) return null;
      // Reference: forearm (pose elbow–wrist) when visible, else 2.5 hand sizes.
      const [e, w] = side === 'R' ? [f.pose?.[14], f.pose?.[16]] : [f.pose?.[13], f.pose?.[15]];
      const ref =
        visible(e) && visible(w) ? dist(toPx(e, f), toPx(w, f)) : 2.5 * handSize(f, h.pts);
      return { raw: toPx(h.pts[0]!, f).y, ref };
    });
    const sm = oneEuro(s.v, s.t, p.minCutoff, p.beta);
    const peaks = findPeaks(
      sm.map((y) => -y),
      s.t,
      p,
    ); // image y grows downwards: top = minimum
    counts[side] = peaks.length;
    events.push(...peaks.map((k) => ({ tS: k.tS, kind: 'roll' as const, side })));
    motion.push(activity(sm, s.t, p));
  }
  const complete = counts.R! >= p.minEvents && counts.L! >= p.minEvents;
  return finish('rotation_counter', events, counts, complete, mergeSpeeds(motion), p, timeout, end);
}

/** FTF: distance between the two index tips ÷ shoulder width; each touch is a minimum. */
function ftfCycleCounter(
  frames: readonly LandmarkFrame[],
  t0: bigint,
  p: PeakParams,
  timeout: number,
  end: number,
) {
  const s = normSeries(frames, t0, (f) => {
    const r = hand(f, 'R');
    const l = hand(f, 'L');
    if (!r || !l || r.pts.length < 21 || l.pts.length < 21) return null;
    const [ls, rs] = [f.pose?.[11], f.pose?.[12]];
    const ref =
      visible(ls) && visible(rs) ? dist(toPx(ls, f), toPx(rs, f)) : 4 * handSize(f, r.pts);
    return { raw: dist(toPx(r.pts[8]!, f), toPx(l.pts[8]!, f)), ref };
  });
  const sm = oneEuro(s.v, s.t, p.minCutoff, p.beta);
  const peaks = findPeaks(
    sm.map((x) => -x),
    s.t,
    p,
  );
  const events = peaks.map((k) => ({ tS: k.tS, kind: 'touch' as const }));
  return finish(
    'ftf_cycle_counter',
    events,
    { all: peaks.length },
    peaks.length >= p.minEvents,
    activity(sm, s.t, p),
    p,
    timeout,
    end,
  );
}

/** SAW: stand up (hip rises), walk (horizontal hip speed), turns (walking direction flips). */
function sawPhases(
  frames: readonly LandmarkFrame[],
  t0: bigint,
  p: SawParams,
  timeout: number,
  end: number,
) {
  const pts = series(frames, t0, (f) => {
    const q = f.pose;
    if (!q || ![11, 12, 23, 24].every((i) => visible(q[i]))) return null;
    return 0; // placeholder value; geometry read below
  });
  const hipX: number[] = [];
  const hipY: number[] = [];
  const trunk: number[] = [];
  for (const f of frames) {
    const q = f.pose;
    if (!q || ![11, 12, 23, 24].every((i) => visible(q[i]))) continue;
    const hip = mid(toPx(q[23]!, f), toPx(q[24]!, f));
    const sh = mid(toPx(q[11]!, f), toPx(q[12]!, f));
    hipX.push(hip.x);
    hipY.push(hip.y);
    trunk.push(dist(hip, sh));
  }
  const t = pts.t;
  const events: DetectorEvent[] = [];
  if (t.length < 3) return finish('saw_phases', events, {}, false, { t, s: [] }, p, timeout, end);
  const T = median(trunk);
  const y = oneEuro(
    hipY.map((v) => v / T),
    t,
    p.minCutoff,
    p.beta,
  );
  const x = oneEuro(
    hipX.map((v) => v / T),
    t,
    p.minCutoff,
    p.beta,
  );
  const base = [...y.filter((_, i) => t[i]! - t[0]! <= 0.5)].sort((a, b) => a - b);
  const seatedY = base[Math.floor(base.length / 2)]!;
  let standing = false;
  let stoodAt = -1;
  for (let i = 0; i < t.length; i++) {
    const rise = seatedY - y[i]!;
    if (!standing && rise > p.standRiseFrac) {
      standing = true;
      stoodAt = t[i]!;
      events.push({ tS: t[i]!, kind: 'stand_up' });
    } else if (standing && rise < p.standRiseFrac / 2 && t[i]! - stoodAt > 2) {
      standing = false;
      events.push({ tS: t[i]!, kind: 'sit_down' });
    }
  }
  // Walking segments from horizontal speed; a turn is a flip of the walking direction.
  const vx = x.map((v, i) => (i === 0 ? 0 : (v - x[i - 1]!) / (t[i]! - t[i - 1]! || 1)));
  const vxs = oneEuro(vx, t, p.minCutoff, p.beta);
  let dir = 0;
  let lastWalkEnd = -1;
  let turns = 0;
  for (let i = 0; i < t.length; i++) {
    const v = vxs[i]!;
    if (Math.abs(v) < p.walkMinSpeed) continue;
    const d = Math.sign(v);
    if (dir === 0) events.push({ tS: t[i]!, kind: 'walk_out' });
    else if (d !== dir) {
      turns++;
      events.push({ tS: (lastWalkEnd + t[i]!) / 2, kind: 'turn' });
      if (turns === 1) events.push({ tS: t[i]!, kind: 'walk_back' });
    }
    dir = d;
    lastWalkEnd = t[i]!;
  }
  const kinds = new Set(events.map((e) => e.kind));
  const complete =
    kinds.has('stand_up') && kinds.has('walk_out') && turns >= p.minTurns && kinds.has('walk_back');
  const rx = rollingRange(x, t, p.motionWindowS);
  const ry = rollingRange(y, t, p.motionWindowS);
  const motion = rx.map((v, i) => Math.max(v, ry[i]!));
  const counts = { turns, stand_up: kinds.has('stand_up') ? 1 : 0 };
  return finish('saw_phases', events, counts, complete, { t, s: motion }, p, timeout, end);
}

/** FA: eyebrow raises and smiles from blendshapes; the protocol does brows → smile twice. */
function expressionSequence(
  frames: readonly LandmarkFrame[],
  t0: bigint,
  p: FaceParams,
  timeout: number,
  end: number,
) {
  const pick = (f: LandmarkFrame, keys: string[], agg: 'max' | 'mean') => {
    const b = f.face?.blend;
    if (!b) return null;
    const vals = keys.map((k) => b[k]).filter((v): v is number => v !== undefined);
    if (!vals.length) return null;
    return agg === 'max' ? Math.max(...vals) : vals.reduce((a, c) => a + c, 0) / vals.length;
  };
  const brow = series(frames, t0, (f) => pick(f, p.browKeys, 'max'));
  const smile = series(frames, t0, (f) => pick(f, p.smileKeys, 'mean'));
  const bs = oneEuro(brow.v, brow.t, p.minCutoff, p.beta);
  const ss = oneEuro(smile.v, smile.t, p.minCutoff, p.beta);
  const opts = { minProminence: p.minProminence, minDistanceS: p.minDistanceS };
  const bp = findPeaks(bs, brow.t, opts).filter((k) => k.value >= p.minPeak);
  const sp = findPeaks(ss, smile.t, opts).filter((k) => k.value >= p.minPeak);
  const events: DetectorEvent[] = [
    ...bp.map((k) => ({ tS: k.tS, kind: 'brow' as const })),
    ...sp.map((k) => ({ tS: k.tS, kind: 'smile' as const })),
  ];
  const ordered = bp.length > 0 && sp.length > 0 && bp[0]!.tS < sp[0]!.tS;
  const complete = bp.length >= p.minEach && sp.length >= p.minEach && ordered;
  const motion = mergeSpeeds([activity(bs, brow.t, p), activity(ss, smile.t, p)]);
  const r = finish(
    'expression_sequence',
    events,
    { brow: bp.length, smile: sp.length },
    complete,
    motion,
    p,
    timeout,
    end,
  );
  if (complete && p.restAfterComplete) {
    const lastEvent = Math.max(...events.map((e) => e.tS));
    r.noMotion = r.noMotion.filter((w) => w.tStartS < lastEvent);
  }
  return r;
}

/**
 * Run a test's detector over a take. `t0Ns` is the canonical time of the take start (video
 * sample 0); event times are seconds from it. `takeEndS` is the recorded duration.
 */
export function runDetector(
  name: DetectorName,
  frames: readonly LandmarkFrame[],
  t0Ns: bigint,
  params: DetectorParams,
  noMotionTimeoutS: number,
  takeEndS: number,
): DetectorResult {
  switch (name) {
    case 'tap_counter':
      return tapCounter(frames, t0Ns, params as PeakParams, noMotionTimeoutS, takeEndS);
    case 'rotation_counter':
      return rotationCounter(frames, t0Ns, params as PeakParams, noMotionTimeoutS, takeEndS);
    case 'ftf_cycle_counter':
      return ftfCycleCounter(frames, t0Ns, params as PeakParams, noMotionTimeoutS, takeEndS);
    case 'saw_phases':
      return sawPhases(frames, t0Ns, params as SawParams, noMotionTimeoutS, takeEndS);
    case 'expression_sequence':
      return expressionSequence(frames, t0Ns, params as FaceParams, noMotionTimeoutS, takeEndS);
  }
}
