/**
 * Generate fixtures/ft-r-sample.json: a SYNTHETIC right hand tapping index finger to thumb
 * at 3 Hz for 3 s at 30 analysis fps, plus steady gyro/gravity samples. Deterministic.
 * Real recorded fixtures replace this in M6 (assumption A6).
 */
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeFloat32 } from '../src/codec.ts';
import type { CaptureFixture } from '../src/fixture.ts';

const fps = 30;
const durationS = 3;
const tapHz = 3;
// Upright hand, palm to camera, normalized coordinates (x, y) for the 21 MediaPipe hand points.
const base: [number, number][] = [
  [0.5, 0.78],
  [0.42, 0.72],
  [0.37, 0.66],
  [0.33, 0.6],
  [0.3, 0.55],
  [0.44, 0.56],
  [0.43, 0.46],
  [0.43, 0.4],
  [0.43, 0.35],
  [0.5, 0.55],
  [0.5, 0.44],
  [0.5, 0.37],
  [0.5, 0.32],
  [0.56, 0.56],
  [0.56, 0.46],
  [0.56, 0.4],
  [0.56, 0.36],
  [0.62, 0.58],
  [0.62, 0.5],
  [0.62, 0.46],
  [0.62, 0.42],
];

const frames: CaptureFixture['frames'] = [];
const sensorBatches: CaptureFixture['sensorBatches'] = [];
for (let i = 0; i < fps * durationS; i++) {
  const t = i / fps;
  const close = (1 - Math.cos(2 * Math.PI * tapHz * t)) / 2; // 0 open → 1 closed
  const pts = base.map(([x, y], k) => {
    // Thumb tip (4) and index tip (8) move toward their midpoint when tapping.
    if (k === 4) return [x + 0.06 * close, y - 0.08 * close];
    if (k === 8) return [x - 0.06 * close, y + 0.1 * close];
    if (k === 7) return [x - 0.03 * close, y + 0.05 * close];
    return [x, y];
  });
  const flat: number[] = [];
  for (const [x, y] of pts) flat.push(x!, y!, 0, 0.99);
  const tsNs = String(Math.round(t * 1e9));
  frames.push({
    seq: i,
    tsNs,
    imageW: 480,
    imageH: 854,
    hands: [{ handedness: 'Right', score: 0.97, lm: encodeFloat32(flat) }],
    stats: { lumaMean: 128 + 3 * Math.sin(t), clippedFrac: 0.01, sharpness: 230 },
    trackerStatus: { hand: 'ok', pose: 'off', face: 'off' },
  });
  if (i % 3 === 0) {
    sensorBatches.push({
      tsNs,
      samples: [0, 1, 2, 3, 4].map((k) => ({
        type: k % 2 ? ('gravity' as const) : ('gyro' as const),
        tsNs: String(Math.round((t + k * 0.02) * 1e9)),
        x: k % 2 ? 0.05 : 0.002,
        y: k % 2 ? 9.79 : -0.001,
        z: k % 2 ? 0.3 : 0.001,
      })),
    });
  }
}

const fixture: CaptureFixture = {
  format: 'neurocapture-fixture@1',
  name: 'ft-r-sample',
  testCode: 'FT',
  side: 'R',
  synthetic: true,
  fps,
  durationS,
  frames,
  sensorBatches,
};
const out = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/ft-r-sample.json');
writeFileSync(out, JSON.stringify(fixture) + '\n');
console.log(`wrote ${out} (${frames.length} frames)`);
