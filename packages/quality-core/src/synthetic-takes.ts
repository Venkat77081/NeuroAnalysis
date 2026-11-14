/**
 * Synthetic takes with ground truth for the task detectors (M6). Each fixture animates the
 * test's synthetic "good" pose over time: tapping, rolling, finger touches, stand-and-walk,
 * facial expressions. Variants follow DEV_PLAN §16 M6: normal, slow, fast, interrupted
 * (movement stops halfway), wrong (protocol not carried out). Deterministic (seeded noise).
 */
import type { TestConfig } from '@neurocapture/contracts-ts';
import type { Landmark, LandmarkFrame, Side } from './types.ts';
import type { DetectorEventKind } from './detectors/detectors.ts';
import { syntheticFrame } from './synthetic.ts';

export type TakeVariant = 'normal' | 'slow' | 'fast' | 'interrupted' | 'wrong';

export interface TruthEvent {
  tS: number;
  kind: DetectorEventKind;
  side?: Side;
}

export interface SyntheticTake {
  test: string;
  variant: TakeVariant;
  seed: number;
  frames: LandmarkFrame[];
  t0Ns: bigint;
  durationS: number;
  truth: {
    events: TruthEvent[];
    complete: boolean;
    /** Movement stops for longer than the no-motion timeout. */
    stops: boolean;
  };
}

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RATE: Record<TakeVariant, number> = {
  normal: 1,
  slow: 0.5,
  fast: 1.6,
  interrupted: 1,
  wrong: 1,
};

function jitter(p: Landmark, r: () => number, amount: number): Landmark {
  return { ...p, x: p.x + (r() - 0.5) * amount, y: p.y + (r() - 0.5) * amount };
}

/** Times of the minima of cos-based cycles at frequency f starting at tStart, before tEnd. */
function cycleTimes(f: number, tStart: number, tEnd: number): number[] {
  const out: number[] = [];
  for (let t = tStart + 0.5 / f; t < tEnd - 0.05; t += 1 / f) out.push(t);
  return out;
}

export function syntheticTake(
  test: TestConfig,
  variant: TakeVariant,
  opts: { seed?: number; fps?: number; orientation?: 'portrait' | 'landscape' } = {},
): SyntheticTake {
  const seed = opts.seed ?? 1;
  const r = rng(seed * 7919 + variant.length);
  const fps = opts.fps ?? test.analysis.fps;
  const orientation = opts.orientation ?? test.camera.orientation;
  const durationS = test.task.durationS;
  const t0Ns = 1_000_000_000n;
  const start = 0.6 + r() * 0.4; // patient starts after the beep
  const stopAt = variant === 'interrupted' ? durationS / 2 : durationS; // movement stops halfway
  const rate = RATE[variant] * (0.9 + r() * 0.2);
  const frames: LandmarkFrame[] = [];
  const events: TruthEvent[] = [];
  let complete = variant !== 'wrong' && variant !== 'interrupted';
  const code = test.code;

  // Protocol timeline (truth) per test.
  const tapF = 3 * rate; // FT taps per second
  const rollF = 1.5 * rate; // FR rolls per second
  const touchF = 0.6 * rate; // FTF touches per second
  if (code === 'FT') {
    for (const side of ['R', 'L'] as Side[]) {
      if (variant === 'wrong' && side === 'L') continue; // only one hand taps
      for (const t of cycleTimes(tapF, start, stopAt)) events.push({ tS: t, kind: 'tap', side });
    }
  } else if (code === 'FR') {
    for (const side of ['R', 'L'] as Side[])
      if (variant !== 'wrong')
        for (const t of cycleTimes(rollF, start, stopAt)) {
          const ts = t + (side === 'L' ? 0.5 / rollF : 0);
          if (ts < stopAt - 0.05) events.push({ tS: ts, kind: 'roll', side });
        }
  } else if (code === 'FTF') {
    if (variant !== 'wrong')
      for (const t of cycleTimes(touchF, start, stopAt)) events.push({ tS: t, kind: 'touch' });
  } else if (code === 'FA') {
    const seq: [number, DetectorEventKind][] = [
      [2, 'brow'],
      [5, 'smile'],
      [8.5, 'brow'],
      [11.5, 'smile'],
    ];
    for (const [t, kind] of seq) {
      const ts = start + (t - 0.6) / rate;
      if (ts >= stopAt - 0.5 || ts > durationS - 0.8) continue;
      if (variant === 'wrong' && kind === 'brow') continue; // only smiles
      events.push({ tS: ts, kind });
    }
  }

  // SAW: seated, stand up, walk across, turn, walk back, ... (sagittal view).
  const saw = (() => {
    if (code !== 'SAW') return null;
    const standT = start + 0.8; // rise midpoint
    const walk = 4.0 / rate; // seconds per crossing
    const turnT = 1.0;
    const segs: { t: number; x: number }[] = [];
    let t = standT + 0.8;
    let x = 0;
    let dir = 1;
    segs.push({ t, x });
    while (t < durationS) {
      t += walk;
      x += dir * 1.1;
      segs.push({ t, x });
      t += turnT;
      segs.push({ t, x });
      dir = -dir;
    }
    if (variant !== 'wrong') {
      events.push({ tS: standT, kind: 'stand_up' });
      const walkStart = standT + 0.8;
      if (walkStart < stopAt) events.push({ tS: walkStart, kind: 'walk_out' });
      let k = 0;
      for (let i = 1; i + 1 < segs.length; i += 2) {
        const turnMid = (segs[i]!.t + segs[i + 1]!.t) / 2;
        if (turnMid >= stopAt || turnMid >= durationS - 0.5) break;
        events.push({ tS: turnMid, kind: 'turn' });
        if (k++ === 0) events.push({ tS: segs[i + 1]!.t, kind: 'walk_back' });
      }
    }
    if (variant === 'interrupted') complete = events.some((e) => e.kind === 'turn');
    return { standT, segs };
  })();

  const n = Math.floor(durationS * fps);
  for (let i = 0; i < n; i++) {
    const tS = i / fps;
    const tNs = t0Ns + BigInt(Math.round(tS * 1e9));
    const { frame } = syntheticFrame(test, 'good', { seq: i, tNs, orientation });
    const w = frame.image!.w;
    const h = frame.image!.h;
    const short = Math.min(w, h);
    const moving = tS >= start && tS < stopAt;
    const tm = Math.min(tS, stopAt); // after the stop, poses freeze

    if (code === 'FT') {
      for (const hd of frame.hands) {
        if (variant === 'wrong' && hd.side === 'L') continue;
        const size = Math.hypot(
          (hd.pts[0]!.x - hd.pts[9]!.x) * w,
          (hd.pts[0]!.y - hd.pts[9]!.y) * h,
        );
        const phase = tm >= start ? 2 * Math.PI * tapF * (tm - start) : 0;
        const sep = (0.05 + (0.45 * (1 + Math.cos(phase))) / 2) * size; // min at cycle midpoints
        const thumb = hd.pts[4]!;
        hd.pts[8] = { ...thumb, x: thumb.x, y: thumb.y - sep / h };
      }
    } else if (code === 'FR') {
      for (const hd of frame.hands) {
        if (variant === 'wrong') break;
        const off = hd.side === 'L' ? Math.PI : 0;
        const phase = tm >= start ? 2 * Math.PI * rollF * (tm - start) + off : off;
        const dy = (-0.06 * Math.cos(phase - Math.PI) * short) / h; // top (min y) at cycle midpoints
        const dx = (0.04 * Math.sin(phase) * short) / w;
        hd.pts = hd.pts.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy }));
      }
    } else if (code === 'FTF') {
      const phase = variant !== 'wrong' && tm >= start ? 2 * Math.PI * touchF * (tm - start) : 0;
      const pull = (1 - Math.cos(phase)) / 2; // 1 = touching
      const r8 = frame.hands.find((x) => x.side === 'R')!.pts[8]!;
      const l8 = frame.hands.find((x) => x.side === 'L')!.pts[8]!;
      const cx = (r8.x + l8.x) / 2;
      for (const hd of frame.hands) {
        const tip = hd.pts[8]!;
        const dx = (cx - tip.x) * pull;
        hd.pts = hd.pts.map((p) => ({ ...p, x: p.x + dx, y: p.y + 0.12 * pull * (short / h) }));
      }
    } else if (code === 'FA' && frame.face) {
      const bump = (kind: DetectorEventKind) =>
        events
          .filter((e) => e.kind === kind)
          .reduce((s, e) => s + 0.85 * Math.exp(-((tS - e.tS) ** 2) / (2 * 0.35 ** 2)), 0);
      const brow = Math.min(1, 0.05 + bump('brow') + (r() - 0.5) * 0.03);
      const smile = Math.min(1, 0.05 + bump('smile') + (r() - 0.5) * 0.03);
      frame.face.blend = {
        browInnerUp: brow,
        browOuterUpLeft: brow * 0.9,
        browOuterUpRight: brow * 0.9,
        mouthSmileLeft: smile,
        mouthSmileRight: smile,
      };
    } else if (saw && frame.pose) {
      const rise =
        Math.min(1, Math.max(0, (tm - (saw.standT - 0.4)) / 0.8)) * (variant === 'wrong' ? 0 : 1);
      let x = 0;
      if (variant !== 'wrong') {
        for (let k = 0; k + 1 < saw.segs.length; k++) {
          const a = saw.segs[k]!;
          const b = saw.segs[k + 1]!;
          if (tm >= a.t && tm <= b.t) x = a.x + ((b.x - a.x) * (tm - a.t)) / (b.t - a.t || 1);
          else if (tm > b.t) x = b.x;
        }
      }
      const dx = (x * short) / w;
      const dy = (-0.2 * rise * short) / h;
      frame.pose = frame.pose.map((p, idx) => (idx >= 25 ? p : { ...p, x: p.x + dx, y: p.y + dy }));
    }
    // Sensor-like noise on every landmark (≈ 1 px).
    const amt = 1.5 / short;
    frame.hands = frame.hands.map((hd) => ({ ...hd, pts: hd.pts.map((p) => jitter(p, r, amt)) }));
    if (frame.pose) frame.pose = frame.pose.map((p) => jitter(p, r, amt));
    void moving;
    frames.push(frame);
  }
  const stops = variant === 'interrupted';
  if (code === 'FA' && complete) {
    // Slow patients may not finish two brow → smile sequences in 15 s.
    const n = (k: DetectorEventKind) => events.filter((e) => e.kind === k).length;
    complete = n('brow') >= 2 && n('smile') >= 2;
  }
  return {
    test: code,
    variant,
    seed,
    frames,
    t0Ns,
    durationS,
    truth: { events: events.sort((a, b) => a.tS - b.tS), complete, stops },
  };
}
