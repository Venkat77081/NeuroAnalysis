import type { LandmarkRecord } from '../src/landmarks.ts';

/** Exactly representable values; the Kotlin LandmarkFormatTest builds the same records. */
const fill = (n: number, f: (k: number) => number) =>
  Float32Array.from({ length: n }, (_, k) => f(k));

export const goldenLandmarkRecords: LandmarkRecord[] = [
  {
    tsNs: 2_000_000_000n,
    seq: 0,
    status: { hand: 'ok', pose: 'off', face: 'off' },
    stats: { lumaMean: 128, clippedFrac: 0.25, sharpness: 230.5, faceLumaRatio: null },
    hands: [{ label: 'Left', score: 0.75, pts: fill(84, (k) => (k % 7) * 0.125) }],
    pose: null,
    face: null,
  },
  {
    tsNs: 2_033_333_333n,
    seq: 1,
    status: { hand: 'no_result', pose: 'ok', face: 'ok' },
    stats: { lumaMean: 100.5, clippedFrac: 0, sharpness: 12, faceLumaRatio: 0.875 },
    hands: [],
    pose: fill(132, (k) => (k % 5) * 0.25),
    face: {
      yaw: 1.5,
      pitch: -2.25,
      roll: 0.5,
      pts: fill(1434, (k) => (k % 9) * 0.0625),
      blend: fill(52, (k) => k / 64),
    },
  },
];
