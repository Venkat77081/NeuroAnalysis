import { describe, expect, it } from 'vitest';
import {
  analysisHealth,
  brightness,
  faceFrontal,
  faceLightBalance,
  handednessMatch,
  inSafeZone,
  requiredLandmarksVisible,
  requiredPoints,
  sharpness,
  shake,
  sideView,
  singlePerson,
  sizeMetric,
  subjectPresent,
  subjectSize,
  tilt,
  tiltAngles,
  trackersErrored,
  type LandmarkFrame,
  type Landmark,
} from '../src/index.ts';

const pt = (x: number, y: number, v = 0.9): Landmark => ({ x, y, z: 0, v });

function frame(over: Partial<LandmarkFrame> = {}): LandmarkFrame {
  return {
    seq: 0,
    tNs: 0n,
    hands: [],
    stats: { lumaMean: 120, clippedFrac: 0, sharpness: 100 },
    trackerStatus: { hand: 'ok', pose: 'ok', face: 'off' },
    image: { w: 1000, h: 500 },
    ...over,
  };
}

const handPts = (x: number) => Array.from({ length: 21 }, (_, i) => pt(x, 0.3 + i * 0.01));

describe('subject_present', () => {
  it('UNKNOWN on tracker error, FAIL on no_result or a missing hand, OK otherwise', () => {
    expect(
      subjectPresent(
        frame({ trackerStatus: { hand: 'error', pose: 'ok', face: 'off' } }),
        ['hand'],
        false,
      ).state,
    ).toBe('UNKNOWN');
    expect(
      subjectPresent(
        frame({ trackerStatus: { hand: 'no_result', pose: 'ok', face: 'off' } }),
        ['hand', 'pose'],
        false,
      ),
    ).toMatchObject({ state: 'FAIL', hint: 'no_subject' });
    const one = frame({ hands: [{ side: 'R', score: 0.9, pts: handPts(0.3) }] });
    expect(subjectPresent(one, ['hand'], true)).toMatchObject({
      state: 'FAIL',
      hint: 'show_both_hands',
    });
    expect(subjectPresent(one, ['hand'], false).state).toBe('OK');
    expect(
      trackersErrored(frame({ trackerStatus: { hand: 'off', pose: 'ok', face: 'off' } }), ['hand']),
    ).toBe(true);
  });
});

describe('required_landmarks_visible', () => {
  const cfg = { poseMinVisibility: 0.5, handMinScore: 0.6 };
  it('checks pose visibility, hand score and count, and face mesh size', () => {
    const pose = [pt(0.5, 0.2), pt(0.5, 0.3, 0.1)];
    expect(requiredLandmarksVisible(frame({ pose }), { pose: [0, 1] }, false, cfg)).toMatchObject({
      state: 'FAIL',
      hint: 'show_body',
      value: 0.5,
    });
    expect(requiredLandmarksVisible(frame({ pose }), { pose: [0] }, false, cfg).state).toBe('OK');
    const hands = [{ side: 'R' as const, score: 0.5, pts: handPts(0.3) }];
    expect(requiredLandmarksVisible(frame({ hands }), { hand: [0, 20] }, false, cfg).hint).toBe(
      'show_both_hands',
    );
    const face = {
      pts: Array.from({ length: 478 }, () => pt(0.5, 0.5)),
      yaw: 0,
      pitch: 0,
      roll: 0,
    };
    const fs = { hand: 'off' as const, pose: 'off' as const, face: 'ok' as const };
    expect(
      requiredLandmarksVisible(frame({ face, trackerStatus: fs }), { face: 'ALL' }, false, cfg)
        .state,
    ).toBe('OK');
    expect(
      requiredLandmarksVisible(frame({ trackerStatus: fs }), { face: [10] }, false, cfg).hint,
    ).toBe('show_face');
    expect(
      requiredLandmarksVisible(
        frame({ trackerStatus: { ...fs, face: 'error' } }),
        { face: 'ALL' },
        false,
        cfg,
      ).state,
    ).toBe('UNKNOWN');
  });
  it('collects only visible required points', () => {
    const f = frame({
      pose: [pt(0.1, 0.1), pt(0.2, 0.2, 0.1)],
      hands: [{ side: 'L', score: 0.9, pts: handPts(0.6) }],
      face: { pts: [pt(0.5, 0.5), pt(0.6, 0.6)], yaw: 0, pitch: 0, roll: 0 },
    });
    expect(requiredPoints(f, { pose: [0, 1], hand: [0], face: [1] }, 0.5)).toHaveLength(3);
    expect(requiredPoints(f, { face: 'ALL' }, 0.5)).toHaveLength(2);
  });
});

describe('in_safe_zone', () => {
  it('names the cut-off edge, or asks to move back when cut on opposite edges', () => {
    expect(inSafeZone([], 0.05).state).toBe('UNKNOWN');
    expect(inSafeZone([pt(0.2, 0.2), pt(0.8, 0.8)], 0.05).state).toBe('OK');
    expect(inSafeZone([pt(0.01, 0.5)], 0.05).hint).toBe('cut_off_left');
    expect(inSafeZone([pt(0.99, 0.5)], 0.05).hint).toBe('cut_off_right');
    expect(inSafeZone([pt(0.5, 0.01)], 0.05).hint).toBe('cut_off_top');
    expect(inSafeZone([pt(0.5, 0.99)], 0.05).hint).toBe('cut_off_bottom');
    expect(inSafeZone([pt(0.01, 0.5), pt(0.99, 0.5)], 0.05).hint).toBe('move_back');
  });
});

describe('subject_size', () => {
  it('measures each metric against the short image side', () => {
    const pose = Array.from({ length: 25 }, () => pt(0.5, 0.5, 0));
    pose[0] = pt(0.5, 0.2);
    pose[11] = pt(0.45, 0.3);
    pose[12] = pt(0.55, 0.3);
    pose[23] = pt(0.47, 0.8);
    const f = frame({ pose, image: { w: 1000, h: 500 } });
    expect(sizeMetric(f, 'upper_body_height', 0.5)).toBeCloseTo(0.4);
    expect(sizeMetric(f, 'body_height', 0.5)).toBeCloseTo(0.6);
    expect(
      sizeMetric(
        frame({
          image: { w: 500, h: 1000 },
          hands: [{ side: 'L', score: 1, pts: [pt(0, 0.1), pt(0, 0.3)] }],
        }),
        'hand_bbox_height',
        0.5,
      ),
    ).toBeCloseTo(0.4);
    expect(
      sizeMetric(
        frame({ face: { pts: [pt(0, 0.4), pt(0, 0.6)], yaw: 0, pitch: 0, roll: 0 } }),
        'face_height',
        0.5,
      ),
    ).toBeCloseTo(0.2);
    expect(sizeMetric(frame(), 'hand_bbox_height', 0.5)).toBeNull();
    expect(sizeMetric(frame(), 'upper_body_height', 0.5)).toBeNull();
    expect(sizeMetric(frame(), 'body_height', 0.5)).toBeNull();
    expect(sizeMetric(frame(), 'face_height', 0.5)).toBeNull();
    const size = { metric: 'upper_body_height' as const, min: 0.45, max: 0.85 };
    expect(subjectSize(f, size, 0.5)).toMatchObject({ state: 'FAIL', hint: 'move_closer' });
    expect(subjectSize(f, { ...size, max: 0.3, min: 0.1 }, 0.5).hint).toBe('move_back');
    expect(subjectSize(f, { ...size, min: 0.3 }, 0.5).state).toBe('OK');
    expect(subjectSize(frame(), size, 0.5).state).toBe('UNKNOWN');
  });
});

describe('handedness_match / single_person / side_view / face_frontal', () => {
  it('handedness', () => {
    expect(handednessMatch(frame(), 'R').state).toBe('UNKNOWN');
    const f = frame({ hands: [{ side: 'L', score: 0.8, pts: [] }] });
    expect(handednessMatch(f, 'R')).toMatchObject({ state: 'FAIL', hint: 'wrong_hand' });
    expect(handednessMatch(f, 'L').state).toBe('OK');
  });
  it('single person from counts, or from what was kept', () => {
    expect(singlePerson(frame({ counts: { hands: 2, poses: 2, faces: 0 } }), ['pose']).hint).toBe(
      'one_person',
    );
    expect(singlePerson(frame({ counts: { hands: 4, poses: 0, faces: 0 } }), ['hand']).state).toBe(
      'FAIL',
    );
    expect(singlePerson(frame({ pose: [pt(0, 0)] }), ['pose']).state).toBe('OK');
    expect(
      singlePerson(frame({ trackerStatus: { hand: 'error', pose: 'ok', face: 'off' } }), ['hand'])
        .state,
    ).toBe('UNKNOWN');
  });
  it('side view ratio in pixels', () => {
    const pose = Array.from({ length: 25 }, () => pt(0.5, 0.5));
    pose[11] = pt(0.3, 0.3);
    pose[12] = pt(0.302, 0.3);
    pose[23] = pt(0.3, 0.6);
    pose[24] = pt(0.302, 0.6);
    expect(sideView(frame({ pose }), 0.25, 0.5).state).toBe('OK');
    pose[12] = pt(0.4, 0.3);
    expect(sideView(frame({ pose }), 0.25, 0.5)).toMatchObject({
      state: 'FAIL',
      hint: 'turn_side_on',
    });
    pose[24] = pt(0.4, 0.3);
    pose[23] = pt(0.3, 0.3);
    expect(sideView(frame({ pose }), 0.25, 0.5).state).toBe('UNKNOWN');
    expect(sideView(frame(), 0.25, 0.5).state).toBe('UNKNOWN');
  });
  it('face angles', () => {
    expect(faceFrontal(frame(), { yaw: 10, pitch: 10 }).state).toBe('UNKNOWN');
    const face = (yaw: number, pitch: number) => frame({ face: { pts: [], yaw, pitch, roll: 0 } });
    expect(faceFrontal(face(5, -5), { yaw: 10, pitch: 10 }).state).toBe('OK');
    expect(faceFrontal(face(5, -15), { yaw: 10, pitch: 10 }).hint).toBe('face_camera');
  });
});

describe('image and sensor checks', () => {
  it('brightness, face light balance, sharpness', () => {
    const cfg = { lumaMin: 60, lumaMax: 200, maxClippedFrac: 0.05 };
    expect(brightness({ lumaMean: 30, clippedFrac: 0, sharpness: 0 }, cfg).hint).toBe('too_dark');
    expect(brightness({ lumaMean: 220, clippedFrac: 0, sharpness: 0 }, cfg).hint).toBe(
      'too_bright',
    );
    expect(brightness({ lumaMean: 120, clippedFrac: 0.2, sharpness: 0 }, cfg).hint).toBe(
      'too_bright',
    );
    expect(brightness({ lumaMean: 120, clippedFrac: 0.01, sharpness: 0 }, cfg).state).toBe('OK');
    const fl = { min: 0.7, max: 1.3 };
    expect(faceLightBalance({ lumaMean: 0, clippedFrac: 0, sharpness: 0 }, fl).state).toBe(
      'UNKNOWN',
    );
    expect(
      faceLightBalance({ lumaMean: 0, clippedFrac: 0, sharpness: 0, faceLumaRatio: 0.5 }, fl).hint,
    ).toBe('uneven_light');
    expect(
      faceLightBalance({ lumaMean: 0, clippedFrac: 0, sharpness: 0, faceLumaRatio: 1 }, fl).state,
    ).toBe('OK');
    expect(sharpness({ lumaMean: 0, clippedFrac: 0, sharpness: 50 }, 100, 0.6).hint).toBe('blurry');
    expect(sharpness({ lumaMean: 0, clippedFrac: 0, sharpness: 70 }, 100, 0.6).state).toBe('OK');
  });
  it('tilt relative to the chosen orientation', () => {
    expect(tiltAngles({ x: 0, y: 9.81, z: 0 }, 'portrait')).toEqual({ rollDeg: 0, pitchDeg: 0 });
    expect(tiltAngles({ x: 9.81, y: 0, z: 0 }, 'landscape').rollDeg).toBeCloseTo(0);
    expect(tiltAngles({ x: 0, y: 0, z: 0 }, 'portrait').pitchDeg).toBe(0);
    const s = Math.sin(Math.PI / 18);
    const c = Math.cos(Math.PI / 18);
    expect(
      Math.abs(tiltAngles({ x: 9.81 * s, y: 9.81 * c, z: 0 }, 'portrait').rollDeg),
    ).toBeCloseTo(10);
    expect(
      Math.abs(tiltAngles({ x: 0, y: 9.81 * c, z: 9.81 * s }, 'portrait').pitchDeg),
    ).toBeCloseTo(10);
    const cfg = { maxRollDeg: 5, maxPitchDeg: 5 };
    expect(tilt(null, 'portrait', cfg).state).toBe('UNKNOWN');
    expect(tilt({ x: 0, y: 9.81, z: 0 }, 'portrait', cfg).state).toBe('OK');
    expect(tilt({ x: 0, y: 9.81, z: 0 }, 'landscape', cfg).hint).toBe('rotate_ccw');
    expect(tilt({ x: 9.81 * s, y: 9.81 * c, z: 0 }, 'portrait', cfg).hint).toBe('rotate_cw');
    expect(
      tilt({ x: 0, y: 9.81 * Math.cos(0.3), z: 9.81 * Math.sin(0.3) }, 'portrait', cfg).hint,
    ).toBe('aim_down');
    expect(
      tilt({ x: 0, y: 9.81 * Math.cos(0.3), z: -9.81 * Math.sin(0.3) }, 'portrait', cfg).hint,
    ).toBe('aim_up');
  });
  it('shake and analysis health', () => {
    expect(shake([], 0.15).state).toBe('UNKNOWN');
    const g = (v: number) => ({ type: 'gyro' as const, tNs: 0n, x: v, y: 0, z: 0 });
    expect(shake([g(0.01), g(-0.02)], 0.15).state).toBe('OK');
    expect(shake([g(0.5), g(-0.5)], 0.15).hint).toBe('hold_still');
    const hc = { minFps: 15, maxLatencyMs: 150 };
    expect(analysisHealth(30, 40, hc).state).toBe('OK');
    expect(analysisHealth(10, 40, hc).state).toBe('FAIL');
    expect(analysisHealth(30, 400, hc).state).toBe('FAIL');
  });
});
