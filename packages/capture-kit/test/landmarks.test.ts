import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validate } from '@neurocapture/contracts-ts';
import {
  BLENDSHAPE_NAMES,
  decodeAnalysisFrame,
  decodeLandmarks,
  encodeFloat32,
  encodeLandmarks,
  eventFromRecord,
  recordFromEvent,
  sideFromLabel,
  type AnalysisFrameEvent,
} from '../src/index.ts';
import { goldenLandmarkRecords } from './golden-landmarks.ts';

const root = resolve(import.meta.dirname, '../../..');
const golden = new Uint8Array(
  readFileSync(resolve(root, 'contracts/tests/golden/landmarks-1.0.0.bin')),
);

const full: AnalysisFrameEvent = {
  seq: 7,
  tsNs: '9007199254740993123',
  imageW: 480,
  imageH: 854,
  hands: [
    { handedness: 'Left', score: 0.9, lm: encodeFloat32(new Float32Array(84).fill(0.5)) },
    { handedness: 'Right', score: 0.8, lm: encodeFloat32(new Float32Array(84).fill(0.25)) },
  ],
  pose: { lm: encodeFloat32(new Float32Array(132).fill(0.125)) },
  face: {
    lm: encodeFloat32(new Float32Array(1434).fill(0.375)),
    blendshapes: encodeFloat32(new Float32Array(52).fill(0.5)),
    yawDeg: 3,
    pitchDeg: -4,
    rollDeg: 1,
  },
  stats: { lumaMean: 120, clippedFrac: 0.01, sharpness: 210, faceLumaRatio: 0.95 },
  trackerStatus: { hand: 'ok', pose: 'ok', face: 'ok' },
};

describe('handedness', () => {
  it('flips MediaPipe labels for non-mirrored camera frames (decision 012)', () => {
    expect(sideFromLabel('Left', false)).toBe('R');
    expect(sideFromLabel('Right', false)).toBe('L');
    expect(sideFromLabel('Left', true)).toBe('L');
    expect(sideFromLabel('Right', true)).toBe('R');
  });
});

describe('decodeAnalysisFrame', () => {
  it('decodes hands, pose, face, blendshapes and stats without precision loss on the timestamp', () => {
    const f = decodeAnalysisFrame(full);
    expect(f.tNs).toBe(9007199254740993123n);
    expect(f.hands.map((h) => h.side)).toEqual(['R', 'L']);
    expect(f.hands[0]!.pts).toHaveLength(21);
    expect(f.hands[0]!.pts[0]).toEqual({ x: 0.5, y: 0.5, z: 0.5, v: 0.5 });
    expect(f.pose).toHaveLength(33);
    expect(f.face?.pts).toHaveLength(478);
    expect(f.face?.pts[0]).toEqual({ x: 0.375, y: 0.375, z: 0.375 });
    expect(Object.keys(f.face!.blend!)).toEqual([...BLENDSHAPE_NAMES]);
    expect(f.face).toMatchObject({ yaw: 3, pitch: -4, roll: 1 });
    expect(decodeAnalysisFrame(full, { imageMirrored: true }).hands[0]!.side).toBe('L');
  });

  it('handles frames with nothing tracked', () => {
    const f = decodeAnalysisFrame({
      ...full,
      hands: undefined,
      pose: undefined,
      face: { ...full.face!, blendshapes: undefined },
    });
    expect(f.hands).toEqual([]);
    expect(f.pose).toBeUndefined();
    expect(f.face?.blend).toBeUndefined();
  });

  it('keeps the largest event (2 hands + pose + face + blendshapes) under 20 KB (DEV_PLAN §5.5)', () => {
    expect(JSON.stringify(full).length).toBeLessThanOrEqual(20 * 1024);
  });
});

describe('landmarks.bin', () => {
  it('decodes the golden file and re-encodes it byte for byte', () => {
    const d = decodeLandmarks(golden);
    expect(validate('landmarks-header', d.header).issues).toEqual([]);
    expect(d.records).toHaveLength(2);
    expect(d.records[0]!.stats.faceLumaRatio).toBeNull();
    expect(d.records[1]!.status).toEqual({ hand: 'no_result', pose: 'ok', face: 'ok' });
    expect(Array.from(d.records[1]!.face!.blend!.slice(0, 3))).toEqual([0, 1 / 64, 2 / 64]);
    expect(encodeLandmarks(d.header, d.records)).toEqual(golden);
    expect(encodeLandmarks(d.header, goldenLandmarkRecords)).toEqual(golden);
  });

  it('round-trips events through records', () => {
    const back = eventFromRecord(recordFromEvent(full), full.imageW, full.imageH);
    expect(back).toEqual(full);
    const bare = recordFromEvent({
      ...full,
      hands: undefined,
      pose: undefined,
      face: undefined,
      stats: { lumaMean: 1, clippedFrac: 0, sharpness: 2 },
    });
    expect(eventFromRecord(bare, 1, 1)).not.toHaveProperty('hands');
  });

  it('rejects other magic, truncation and length mismatches', () => {
    expect(() => decodeLandmarks(new Uint8Array(4))).toThrow(/not a NCLM/);
    expect(() => decodeLandmarks(golden.subarray(0, 20))).toThrow(/truncated header/);
    expect(() => decodeLandmarks(golden.subarray(0, golden.length - 10))).toThrow(
      /truncated record/,
    );
    const bad = golden.slice();
    const hLen = new DataView(bad.buffer).getUint32(4, true);
    new DataView(bad.buffer).setUint32(8 + hLen, 1, true); // first record claims 1 byte
    expect(() => decodeLandmarks(bad)).toThrow(/record length mismatch|truncated record/);
    expect(() => decodeLandmarks(golden.subarray(0, 8 + hLen + 2))).toThrow(/truncated record/);
  });
});
