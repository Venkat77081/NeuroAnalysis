/** v36 (decision 063): the start sign: open palm, raised arm, and the 1-second still hold. */
import { describe, expect, it } from 'vitest';
import {
  extendedFingers,
  findSign,
  isOpenPalm,
  raisedWrist,
  StartSignTracker,
  type Landmark,
  type LandmarkFrame,
  type StartSignConfig,
} from '../src/index.ts';

const cfg: StartSignConfig = {
  holdS: 1,
  maxGapS: 0.3,
  maxDriftFrac: 0.6,
  palmMinFingers: 4,
  armMarginFrac: 0.2,
};

/** A right hand at (cx, wristY): fingers straight up (open) or curled back (fist). */
function hand(open: boolean, cx = 0.5, wristY = 0.8, upsideDown = false): Landmark[] {
  const s = upsideDown ? -1 : 1;
  const pts: Landmark[] = Array.from({ length: 21 }, () => ({ x: cx, y: wristY, z: 0 }));
  pts[0] = { x: cx, y: wristY, z: 0 };
  [-0.06, -0.02, 0.02, 0.06].forEach((dx, i) => {
    const base = 5 + i * 4; // MCP, PIP, DIP, tip
    pts[base] = { x: cx + dx, y: wristY - s * 0.15, z: 0 };
    pts[base + 1] = { x: cx + dx, y: wristY - s * 0.22, z: 0 };
    pts[base + 2] = { x: cx + dx, y: wristY - s * (open ? 0.27 : 0.2), z: 0 };
    pts[base + 3] = { x: cx + dx, y: wristY - s * (open ? 0.32 : 0.14), z: 0 };
  });
  return pts;
}

function pose(wristY: number, v = 0.9): Landmark[] {
  const p: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.6, z: 0, v: 0.9 }));
  p[0] = { x: 0.5, y: 0.3, z: 0, v: 0.9 }; // nose
  p[11] = { x: 0.4, y: 0.4, z: 0, v: 0.9 };
  p[12] = { x: 0.6, y: 0.4, z: 0, v: 0.9 };
  p[15] = { x: 0.35, y: 0.6, z: 0, v: 0.9 };
  p[16] = { x: 0.65, y: wristY, z: 0, v };
  return p;
}

function frame(parts: Partial<LandmarkFrame>): LandmarkFrame {
  return {
    seq: 0,
    tNs: 0n,
    hands: [],
    stats: {} as LandmarkFrame['stats'],
    trackerStatus: {} as LandmarkFrame['trackerStatus'],
    ...parts,
  };
}

describe('start sign: what counts as the sign', () => {
  it('counts straight fingers and needs fingers pointing up', () => {
    expect(extendedFingers(hand(true))).toBe(4);
    expect(extendedFingers(hand(false))).toBe(0);
    expect(extendedFingers([])).toBe(0);
    expect(isOpenPalm(hand(true), 4)).toBe(true);
    expect(isOpenPalm(hand(false), 4)).toBe(false); // a fist (or tapping)
    expect(isOpenPalm(hand(true, 0.5, 0.3, true), 4)).toBe(false); // fingers pointing down
    expect(isOpenPalm(hand(true).slice(0, 10), 4)).toBe(false); // hand not fully found
  });

  it('a raised arm is a visible wrist above the nose by a margin', () => {
    expect(raisedWrist(pose(0.2), 0.2)).not.toBeNull(); // 0.1 above the nose; margin 0.04
    expect(raisedWrist(pose(0.28), 0.2)).toBeNull(); // only just above: within the margin
    expect(raisedWrist(pose(0.6), 0.2)).toBeNull(); // arm down
    expect(raisedWrist(pose(0.2, 0.2), 0.2)).toBeNull(); // wrist not visible
    expect(raisedWrist([], 0.2)).toBeNull();
  });

  it('finds the sign in a frame, with its size', () => {
    const palm = findSign(
      frame({ hands: [{ side: 'right', score: 0.9, pts: hand(true) }] }),
      'palm',
      cfg,
    );
    expect(palm).toMatchObject({ x: 0.5, y: 0.8 });
    expect(palm!.size).toBeCloseTo(Math.hypot(0.02, 0.15), 6); // wrist to the middle knuckle
    expect(
      findSign(frame({ hands: [{ side: 'left', score: 0.9, pts: hand(false) }] }), 'palm', cfg),
    ).toBeNull();
    const arm = findSign(frame({ pose: pose(0.2) }), 'arm', cfg);
    expect(arm).toMatchObject({ x: 0.65, y: 0.2 });
    expect(arm!.size).toBeCloseTo(0.2, 6);
    expect(findSign(frame({ pose: pose(0.6) }), 'arm', cfg)).toBeNull();
    expect(findSign(frame({}), 'arm', cfg)).toBeNull();
  });
});

describe('start sign: hold still for a second, once per raise', () => {
  const p = { x: 0.5, y: 0.5, size: 0.1 };

  it('fires after holdS, once, and again only after the sign was put down', () => {
    const tr = new StartSignTracker(cfg);
    expect(tr.update(0, p)).toEqual({ progress: 0, fired: false });
    expect(tr.update(0.5, p).progress).toBeCloseTo(0.5);
    expect(tr.update(1.0, p)).toEqual({ progress: 1, fired: true });
    expect(tr.update(1.2, p)).toEqual({ progress: 1, fired: false }); // still raised: no repeat
    tr.update(1.7, null); // put down (longer than maxGapS)
    expect(tr.update(2.0, p).fired).toBe(false);
    expect(tr.update(3.0, p).fired).toBe(true);
  });

  it('bridges short tracking gaps; a longer gap or a move restarts the hold', () => {
    const tr = new StartSignTracker(cfg);
    tr.update(0, p);
    expect(tr.update(0.2, null).progress).toBeCloseTo(0.2); // a dropped frame
    expect(tr.update(0.6, p).progress).toBeCloseTo(0.6);
    tr.update(1.0, null); // gap 0.4 s > 0.3 s
    expect(tr.update(1.0, p).progress).toBe(0);
    // Moving more than 0.6 × the hand's size restarts; a small wobble does not.
    expect(tr.update(1.5, { ...p, x: 0.53 }).progress).toBeCloseTo(0.5);
    expect(tr.update(1.6, { ...p, x: 0.6 }).progress).toBe(0);
  });

  it('reset clears everything', () => {
    const tr = new StartSignTracker(cfg);
    tr.update(0, p);
    tr.update(1, p);
    tr.reset();
    expect(tr.update(5, p)).toEqual({ progress: 0, fired: false });
  });
});
