/**
 * Synthetic analysis frames for each test and positioning scenario (DEV_PLAN §17 scenario QA).
 * Used by the unit tests of the checks and rule engine, and by the mock camera so the web app
 * can be exercised without a phone. Bodies follow the on-screen guides (decision 013).
 */
import type { TestConfig } from '@neurocapture/contracts-ts';
import type { Landmark, LandmarkFrame, PromptKey, SensorReading, Side } from './types.ts';
import type { Orientation } from './checks/checks.ts';

export type ScenarioName =
  | 'good'
  | 'too_far'
  | 'too_close'
  | 'cut_off_left'
  | 'cut_off_right'
  | 'no_subject'
  | 'one_hand'
  | 'second_person'
  | 'dark'
  | 'backlit'
  | 'blurry'
  | 'tilted'
  | 'shaken'
  | 'tracker_error'
  | 'front_view'
  | 'face_turned'
  | 'looking_down'
  | 'face_shadow'
  | 'wrong_hand';

/** Expected guidance for a scenario: a prompt, "tracking" (UNKNOWN), or null (gate opens). */
export type Expectation = PromptKey | 'tracking' | null;

export const SYNTHETIC_SHARPNESS_BASELINE = 100;

type P = [number, number]; // short-side units relative to the image centre (x right, y down)

/** Seated patient facing the camera: subject's right side is on the image left. */
function seatedFront(arms: 'up' | 'forearms'): Record<number, P> {
  const up = arms === 'up';
  const pose: Record<number, P> = {
    0: [0, -0.3],
    1: [0.02, -0.32],
    2: [0.03, -0.32],
    3: [0.04, -0.32],
    4: [-0.02, -0.32],
    5: [-0.03, -0.32],
    6: [-0.04, -0.32],
    7: [0.07, -0.3],
    8: [-0.07, -0.3],
    9: [0.02, -0.26],
    10: [-0.02, -0.26],
    11: [0.18, -0.14],
    12: [-0.18, -0.14],
    13: up ? [0.36, 0.14] : [0.27, 0.18],
    14: up ? [-0.36, 0.14] : [-0.27, 0.18],
    15: up ? [0.32, -0.17] : [0.06, 0.11],
    16: up ? [-0.32, -0.17] : [-0.06, 0.11],
    23: [0.12, 0.35],
    24: [-0.12, 0.35],
  };
  for (const [i, j] of [
    [17, 15],
    [19, 15],
    [21, 15],
    [18, 16],
    [20, 16],
    [22, 16],
  ] as const)
    pose[i] = pose[j]!;
  return pose;
}

/** Seated side-on at the start mark (SAW), facing image right. */
function seatedSide(front: boolean): Record<number, P> {
  const dx = front ? 0.15 : 0.005;
  const hx = front ? 0.1 : 0.005;
  const pose: Record<number, P> = {
    0: [-0.58, -0.3],
    11: [-0.62 + dx, -0.15],
    12: [-0.62 - dx, -0.15],
    13: [-0.6, 0.0],
    14: [-0.6, 0.0],
    15: [-0.55, 0.08],
    16: [-0.55, 0.08],
    23: [-0.6 + hx, 0.12],
    24: [-0.6 - hx, 0.12],
    25: [-0.45, 0.12],
    26: [-0.45, 0.12],
    27: [-0.45, 0.42],
    28: [-0.45, 0.42],
    29: [-0.49, 0.43],
    30: [-0.49, 0.43],
    31: [-0.4, 0.44],
    32: [-0.4, 0.44],
  };
  for (let i = 1; i <= 10; i++)
    pose[i] = [-0.58 + (i % 2 ? 0.01 : -0.01), -0.32 + (i > 8 ? 0.05 : 0)];
  for (const i of [17, 19, 21]) pose[i] = pose[15]!;
  for (const i of [18, 20, 22]) pose[i] = pose[16]!;
  return pose;
}

/** 21 hand points around a wrist: fingers raised (FT/FTF) or a loose fist (FR). */
function hand(wrist: P, mode: 'up' | 'fist'): P[] {
  const pts: P[] = [wrist];
  for (let f = 0; f < 5; f++) {
    const fx = (f - 2) * 0.025;
    for (let k = 1; k <= 4; k++)
      pts.push(
        mode === 'up'
          ? [wrist[0] + fx, wrist[1] - 0.03 * k]
          : [wrist[0] + fx * 0.6, wrist[1] - 0.008 * k],
      );
  }
  return pts;
}

/** 478 face points on an ellipse grid (FA, portrait). */
function face(): P[] {
  const pts: P[] = [];
  for (let i = 0; i < 478; i++) {
    const r = Math.sqrt((i + 0.5) / 478);
    const a = i * 2.399963;
    pts.push([0.19 * r * Math.cos(a), -0.05 + 0.25 * r * Math.sin(a)]);
  }
  return pts;
}

function scale(p: P, s: number, c: P = [0, 0]): P {
  return [c[0] + (p[0] - c[0]) * s, c[1] + (p[1] - c[1]) * s];
}

export interface SyntheticOptions {
  seq: number;
  tNs: bigint;
  orientation: Orientation;
  /** Tested side (variant protocol); null for both-hands tests. */
  side?: Side | null;
}

export interface SyntheticSample {
  frame: LandmarkFrame;
  sensors: SensorReading[];
}

/** One frame (plus the motion sensor readings of its 33 ms) for a test and scenario. */
export function syntheticFrame(
  test: TestConfig,
  scenario: ScenarioName,
  o: SyntheticOptions,
): SyntheticSample {
  const [w, h] = o.orientation === 'landscape' ? [854, 480] : [480, 854];
  const short = Math.min(w, h);
  const kind = test.framing.overlay;
  const isSaw = kind === 'full_body' || test.code === 'SAW';
  const isFace = test.trackers.includes('face');
  const sizeFactor =
    scenario === 'too_far'
      ? isSaw
        ? 0.35
        : 0.5
      : scenario === 'too_close'
        ? isSaw
          ? 1.3
          : isFace
            ? 1.5
            : 1.6
        : 1;
  const centre: P = isSaw ? [-0.55, 0.05] : [0, 0];
  // Cut-off scenarios put the subject's centre on the left or right image edge.
  const halfW = w / (2 * short);
  const shift =
    scenario === 'cut_off_left'
      ? -halfW - centre[0]
      : scenario === 'cut_off_right'
        ? halfW - centre[0]
        : 0;
  const place = (p: P): Landmark => {
    const q = scale(p, sizeFactor, isSaw ? centre : [0, 0]);
    return { x: 0.5 + ((q[0] + shift) * short) / w, y: 0.5 + (q[1] * short) / h, z: 0, v: 0.95 };
  };

  const status = { hand: 'off', pose: 'off', face: 'off' } as LandmarkFrame['trackerStatus'];
  for (const t of test.trackers)
    status[t] =
      scenario === 'tracker_error' ? 'error' : scenario === 'no_subject' ? 'no_result' : 'ok';
  const present = scenario !== 'tracker_error' && scenario !== 'no_subject';

  let pose: Landmark[] | undefined;
  const hands: LandmarkFrame['hands'] = [];
  let faceOut: LandmarkFrame['face'];
  if (present && test.trackers.includes('pose')) {
    const tmpl = isSaw
      ? seatedSide(scenario === 'front_view')
      : seatedFront(kind === 'upper_body_forearms' ? 'forearms' : 'up');
    pose = Array.from({ length: 33 }, (_, i) => {
      const p = tmpl[i];
      return p ? place(p) : { x: 0.5, y: 0.99, z: 0, v: 0.05 };
    });
  }
  if (present && test.trackers.includes('hand')) {
    const arms = kind === 'upper_body_forearms' ? 'forearms' : 'up';
    const body = seatedFront(arms);
    const mode = arms === 'up' ? 'up' : 'fist';
    // Subject's right hand is on the image left (back camera, not mirrored).
    const all: { side: Side; wrist: P }[] = [
      { side: 'R', wrist: body[16]! },
      { side: 'L', wrist: body[15]! },
    ];
    let chosen = all;
    if (o.side)
      chosen = all.filter(
        (x) => x.side === (scenario === 'wrong_hand' ? (o.side === 'R' ? 'L' : 'R') : o.side),
      );
    else if (scenario === 'one_hand') chosen = all.slice(0, 1);
    for (const c of chosen)
      hands.push({ side: c.side, score: 0.95, pts: hand(c.wrist, mode).map(place) });
  }
  if (present && isFace) {
    const yaw = scenario === 'face_turned' ? 20 : 0;
    const pitch = scenario === 'looking_down' ? -20 : 0;
    faceOut = {
      pts: face()
        .map(place)
        .map(({ x, y, z }) => ({ x, y, z })),
      yaw,
      pitch,
      roll: 0,
    };
  }

  const stats: LandmarkFrame['stats'] = {
    lumaMean: scenario === 'dark' ? 30 : scenario === 'backlit' ? 150 : 120,
    clippedFrac: scenario === 'backlit' ? 0.2 : 0.01,
    sharpness:
      scenario === 'blurry' ? 0.3 * SYNTHETIC_SHARPNESS_BASELINE : SYNTHETIC_SHARPNESS_BASELINE,
    ...(isFace && present ? { faceLumaRatio: scenario === 'face_shadow' ? 0.5 : 1 } : {}),
  };
  const people = scenario === 'second_person' ? 2 : present ? 1 : 0;
  const frame: LandmarkFrame = {
    seq: o.seq,
    tNs: o.tNs,
    hands,
    ...(pose ? { pose } : {}),
    ...(faceOut ? { face: faceOut } : {}),
    stats,
    trackerStatus: status,
    image: { w, h },
    counts: {
      hands:
        hands.length + (scenario === 'second_person' && test.trackers.includes('hand') ? 2 : 0),
      poses: test.trackers.includes('pose') ? people : 0,
      faces: isFace ? people : 0,
    },
  };

  // Gravity 9.81 m/s² along +y (portrait) or +x (landscape); tilted = 10° roll.
  const g = 9.81;
  const roll = scenario === 'tilted' ? (10 * Math.PI) / 180 : 0;
  const [gx, gy] =
    o.orientation === 'portrait'
      ? [g * Math.sin(roll), g * Math.cos(roll)]
      : [g * Math.cos(roll), -g * Math.sin(roll)];
  const sensors: SensorReading[] = [{ type: 'gravity', tNs: o.tNs, x: gx, y: gy, z: 0 }];
  for (let k = 0; k < 3; k++) {
    const amp = scenario === 'shaken' ? (k % 2 ? 0.5 : -0.5) : 0.01;
    sensors.push({
      type: 'gyro',
      tNs: o.tNs - BigInt(k * 10) * 1_000_000n,
      x: amp,
      y: amp * 0.5,
      z: 0,
    });
  }
  return { frame, sensors };
}

/** Scenarios that apply to a test (QA checklist §17) and the guidance each must produce. */
export function scenariosFor(
  test: TestConfig,
  opts: { side?: Side | null; sharpness: boolean; sensors: boolean },
): { name: ScenarioName; expect: Expectation }[] {
  const f = test.framing;
  const out: { name: ScenarioName; expect: Expectation }[] = [
    { name: 'good', expect: null },
    { name: 'too_far', expect: 'move_closer' },
    { name: 'too_close', expect: 'move_back' },
    { name: 'cut_off_left', expect: 'cut_off_left' },
    { name: 'cut_off_right', expect: 'cut_off_right' },
    { name: 'no_subject', expect: 'no_subject' },
    { name: 'dark', expect: 'too_dark' },
    { name: 'backlit', expect: 'too_bright' },
    { name: 'tracker_error', expect: 'tracking' },
  ];
  if (f.singlePerson) out.push({ name: 'second_person', expect: 'one_person' });
  if (f.bothHandsRequired) out.push({ name: 'one_hand', expect: 'show_both_hands' });
  if (f.handednessMustMatchSide && opts.side)
    out.push({ name: 'wrong_hand', expect: 'wrong_hand' });
  if (f.sideViewMaxShoulderRatio !== undefined)
    out.push({ name: 'front_view', expect: 'turn_side_on' });
  if (f.maxFaceAngleDeg) {
    out.push(
      { name: 'face_turned', expect: 'face_camera' },
      { name: 'looking_down', expect: 'face_camera' },
    );
  }
  if (test.trackers.includes('face')) out.push({ name: 'face_shadow', expect: 'uneven_light' });
  if (opts.sharpness) out.push({ name: 'blurry', expect: 'blurry' });
  if (opts.sensors)
    out.push({ name: 'tilted', expect: 'level_phone' }, { name: 'shaken', expect: 'hold_still' });
  return out;
}
