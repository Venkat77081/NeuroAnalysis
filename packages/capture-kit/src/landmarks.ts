/**
 * Landmarks: live AnalysisFrame events → LandmarkFrame (DEV_PLAN §5.7), and the landmarks.bin file
 * (layout NCLM-v1, contracts/landmarks-header.schema.json). Pure TypeScript over DataView.
 *
 * Handedness: MediaPipe labels hands as if the image were mirrored (selfie). Camera frames given
 * to the trackers are not mirrored, so the anatomical side is the opposite of the label
 * (decision 012). Records keep the raw label; readers correct it.
 */
import type { LandmarksHeader } from '@neurocapture/contracts-ts/types';
import type { Landmark, LandmarkFrame, Side, TrackerStatus } from '@neurocapture/quality-core';
import type { AnalysisFrameEvent } from './definitions.ts';
import { decodeFloat32, encodeFloat32 } from './codec.ts';

export const HAND_POINTS = 21;
export const POSE_POINTS = 33;
export const FACE_POINTS = 478;

/** MediaPipe face blendshape order (52). */
export const BLENDSHAPE_NAMES = [
  '_neutral',
  'browDownLeft',
  'browDownRight',
  'browInnerUp',
  'browOuterUpLeft',
  'browOuterUpRight',
  'cheekPuff',
  'cheekSquintLeft',
  'cheekSquintRight',
  'eyeBlinkLeft',
  'eyeBlinkRight',
  'eyeLookDownLeft',
  'eyeLookDownRight',
  'eyeLookInLeft',
  'eyeLookInRight',
  'eyeLookOutLeft',
  'eyeLookOutRight',
  'eyeLookUpLeft',
  'eyeLookUpRight',
  'eyeSquintLeft',
  'eyeSquintRight',
  'eyeWideLeft',
  'eyeWideRight',
  'jawForward',
  'jawLeft',
  'jawOpen',
  'jawRight',
  'mouthClose',
  'mouthDimpleLeft',
  'mouthDimpleRight',
  'mouthFrownLeft',
  'mouthFrownRight',
  'mouthFunnel',
  'mouthLeft',
  'mouthLowerDownLeft',
  'mouthLowerDownRight',
  'mouthPressLeft',
  'mouthPressRight',
  'mouthPucker',
  'mouthRight',
  'mouthRollLower',
  'mouthRollUpper',
  'mouthShrugLower',
  'mouthShrugUpper',
  'mouthSmileLeft',
  'mouthSmileRight',
  'mouthStretchLeft',
  'mouthStretchRight',
  'mouthUpperUpLeft',
  'mouthUpperUpRight',
  'noseSneerLeft',
  'noseSneerRight',
] as const;

/**
 * Subject's side from MediaPipe's raw handedness label (decision 012, revised after the first
 * device check): on an un-mirrored camera frame the label already names the subject's hand
 * (raw "Right" = right hand); on a mirrored frame it is the opposite.
 */
export function sideFromLabel(label: 'Left' | 'Right', imageMirrored: boolean): Side {
  const right = label === 'Right';
  return (imageMirrored ? !right : right) ? 'R' : 'L';
}

function points(f: Float32Array, stride: 3 | 4): Landmark[] {
  const out: Landmark[] = [];
  for (let i = 0; i + stride <= f.length; i += stride) {
    out.push(
      stride === 4
        ? { x: f[i]!, y: f[i + 1]!, z: f[i + 2]!, v: f[i + 3]! }
        : { x: f[i]!, y: f[i + 1]!, z: f[i + 2]! },
    );
  }
  return out;
}

function blend(f: Float32Array | null): Record<string, number> | undefined {
  if (!f) return undefined;
  const out: Record<string, number> = {};
  BLENDSHAPE_NAMES.forEach((n, i) => {
    if (i < f.length) out[n] = f[i]!;
  });
  return out;
}

/** Decode a live event (base64 Float32 payloads) into a LandmarkFrame. */
export function decodeAnalysisFrame(
  e: AnalysisFrameEvent,
  opts: { imageMirrored?: boolean } = {},
): LandmarkFrame {
  const mirrored = opts.imageMirrored ?? false;
  return {
    seq: e.seq,
    tNs: BigInt(e.tsNs),
    hands: (e.hands ?? []).map((h) => ({
      side: sideFromLabel(h.handedness, mirrored),
      score: h.score,
      pts: points(decodeFloat32(h.lm), 4),
    })),
    ...(e.pose ? { pose: points(decodeFloat32(e.pose.lm), 4) } : {}),
    ...(e.face
      ? {
          face: {
            pts: points(decodeFloat32(e.face.lm), 3),
            yaw: e.face.yawDeg,
            pitch: e.face.pitchDeg,
            roll: e.face.rollDeg,
            ...(e.face.blendshapes ? { blend: blend(decodeFloat32(e.face.blendshapes)) } : {}),
          },
        }
      : {}),
    stats: { ...e.stats },
    trackerStatus: { ...e.trackerStatus },
  };
}

// ---------------------------------------------------------------- landmarks.bin (NCLM-v1)

export interface LandmarkRecord {
  tsNs: bigint;
  seq: number;
  status: Record<'hand' | 'pose' | 'face', TrackerStatus>;
  stats: { lumaMean: number; clippedFrac: number; sharpness: number; faceLumaRatio: number | null };
  hands: { label: 'Left' | 'Right'; score: number; pts: Float32Array }[];
  pose: Float32Array | null;
  face: {
    yaw: number;
    pitch: number;
    roll: number;
    pts: Float32Array;
    blend: Float32Array | null;
  } | null;
}

const STATUS: TrackerStatus[] = ['off', 'ok', 'no_result', 'error'];
const statusBits = (s: LandmarkRecord['status']) =>
  STATUS.indexOf(s.hand) | (STATUS.indexOf(s.pose) << 2) | (STATUS.indexOf(s.face) << 4);
const statusFrom = (b: number): LandmarkRecord['status'] => ({
  hand: STATUS[b & 3]!,
  pose: STATUS[(b >> 2) & 3]!,
  face: STATUS[(b >> 4) & 3]!,
});

export function recordBodySize(r: LandmarkRecord): number {
  let n = 8 + 4 + 4 + 16;
  n += r.hands.length * (4 + 4 + HAND_POINTS * 4 * 4);
  if (r.pose) n += POSE_POINTS * 4 * 4;
  if (r.face) n += 12 + FACE_POINTS * 3 * 4 + (r.face.blend ? BLENDSHAPE_NAMES.length * 4 : 0);
  return n;
}

function writeRecord(v: DataView, o: number, r: LandmarkRecord): number {
  const floats = (f: Float32Array) => {
    for (const x of f) {
      v.setFloat32(o, x, true);
      o += 4;
    }
  };
  v.setUint32(o, recordBodySize(r), true);
  o += 4;
  v.setBigInt64(o, r.tsNs, true);
  v.setInt32(o + 8, r.seq, true);
  v.setUint8(o + 12, statusBits(r.status));
  v.setUint8(o + 13, r.hands.length);
  v.setUint8(o + 14, (r.pose ? 1 : 0) | (r.face ? 2 : 0) | (r.face?.blend ? 4 : 0));
  o += 16;
  for (const x of [
    r.stats.lumaMean,
    r.stats.clippedFrac,
    r.stats.sharpness,
    r.stats.faceLumaRatio ?? NaN,
  ]) {
    v.setFloat32(o, x, true);
    o += 4;
  }
  for (const h of r.hands) {
    v.setUint8(o, h.label === 'Right' ? 1 : 0);
    v.setFloat32(o + 4, h.score, true);
    o += 8;
    floats(h.pts);
  }
  if (r.pose) floats(r.pose);
  if (r.face) {
    v.setFloat32(o, r.face.yaw, true);
    v.setFloat32(o + 4, r.face.pitch, true);
    v.setFloat32(o + 8, r.face.roll, true);
    o += 12;
    floats(r.face.pts);
    if (r.face.blend) floats(r.face.blend);
  }
  return o;
}

export function encodeLandmarks(header: LandmarksHeader, records: LandmarkRecord[]): Uint8Array {
  const h = new TextEncoder().encode(JSON.stringify(header));
  const total = 8 + h.length + records.reduce((s, r) => s + 4 + recordBodySize(r), 0);
  const out = new Uint8Array(total);
  out.set(new TextEncoder().encode('NCLM'), 0);
  const v = new DataView(out.buffer);
  v.setUint32(4, h.length, true);
  out.set(h, 8);
  let o = 8 + h.length;
  for (const r of records) o = writeRecord(v, o, r);
  return out;
}

export function decodeLandmarks(buf: ArrayBuffer | Uint8Array): {
  header: LandmarksHeader;
  records: LandmarkRecord[];
} {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8 || new TextDecoder().decode(bytes.subarray(0, 4)) !== 'NCLM')
    throw new Error('not a NCLM stream');
  const hLen = v.getUint32(4, true);
  if (8 + hLen > bytes.length) throw new Error('truncated header');
  const header = JSON.parse(
    new TextDecoder().decode(bytes.subarray(8, 8 + hLen)),
  ) as LandmarksHeader;
  const records: LandmarkRecord[] = [];
  let o = 8 + hLen;
  const floats = (n: number) => {
    const f = new Float32Array(n);
    for (let i = 0; i < n; i++, o += 4) f[i] = v.getFloat32(o, true);
    return f;
  };
  while (o < bytes.length) {
    if (o + 4 > bytes.length) throw new Error('truncated record');
    const len = v.getUint32(o, true);
    const end = o + 4 + len;
    if (end > bytes.length) throw new Error('truncated record');
    o += 4;
    const tsNs = v.getBigInt64(o, true);
    const seq = v.getInt32(o + 8, true);
    const status = statusFrom(v.getUint8(o + 12));
    const handCount = v.getUint8(o + 13);
    const flags = v.getUint8(o + 14);
    o += 16;
    const [lumaMean, clippedFrac, sharpness, ratio] = floats(4);
    const hands: LandmarkRecord['hands'] = [];
    for (let i = 0; i < handCount; i++) {
      const label = v.getUint8(o) === 1 ? 'Right' : 'Left';
      const score = v.getFloat32(o + 4, true);
      o += 8;
      hands.push({ label, score, pts: floats(HAND_POINTS * 4) });
    }
    const pose = flags & 1 ? floats(POSE_POINTS * 4) : null;
    let face: LandmarkRecord['face'] = null;
    if (flags & 2) {
      const [yaw, pitch, roll] = floats(3);
      const pts = floats(FACE_POINTS * 3);
      face = {
        yaw: yaw!,
        pitch: pitch!,
        roll: roll!,
        pts,
        blend: flags & 4 ? floats(BLENDSHAPE_NAMES.length) : null,
      };
    }
    if (o !== end) throw new Error(`record length mismatch at seq ${seq}`);
    records.push({
      tsNs,
      seq,
      status,
      stats: {
        lumaMean: lumaMean!,
        clippedFrac: clippedFrac!,
        sharpness: sharpness!,
        faceLumaRatio: Number.isNaN(ratio!) ? null : ratio!,
      },
      hands,
      pose,
      face,
    });
  }
  return { header, records };
}

/** Build a record from a live event (webcam mode and tests write landmarks.bin from events). */
export function recordFromEvent(e: AnalysisFrameEvent): LandmarkRecord {
  return {
    tsNs: BigInt(e.tsNs),
    seq: e.seq,
    status: { ...e.trackerStatus },
    stats: {
      lumaMean: e.stats.lumaMean,
      clippedFrac: e.stats.clippedFrac,
      sharpness: e.stats.sharpness,
      faceLumaRatio: e.stats.faceLumaRatio ?? null,
    },
    hands: (e.hands ?? []).map((h) => ({
      label: h.handedness,
      score: h.score,
      pts: decodeFloat32(h.lm),
    })),
    pose: e.pose ? decodeFloat32(e.pose.lm) : null,
    face: e.face
      ? {
          yaw: e.face.yawDeg,
          pitch: e.face.pitchDeg,
          roll: e.face.rollDeg,
          pts: decodeFloat32(e.face.lm),
          blend: e.face.blendshapes ? decodeFloat32(e.face.blendshapes) : null,
        }
      : null,
  };
}

/** Build a live event from a record (mock fixtures). */
export function eventFromRecord(
  r: LandmarkRecord,
  imageW: number,
  imageH: number,
): AnalysisFrameEvent {
  return {
    seq: r.seq,
    tsNs: r.tsNs.toString(),
    imageW,
    imageH,
    ...(r.hands.length
      ? {
          hands: r.hands.map((h) => ({
            handedness: h.label,
            score: h.score,
            lm: encodeFloat32(h.pts),
          })),
        }
      : {}),
    ...(r.pose ? { pose: { lm: encodeFloat32(r.pose) } } : {}),
    ...(r.face
      ? {
          face: {
            lm: encodeFloat32(r.face.pts),
            yawDeg: r.face.yaw,
            pitchDeg: r.face.pitch,
            rollDeg: r.face.roll,
            ...(r.face.blend ? { blendshapes: encodeFloat32(r.face.blend) } : {}),
          },
        }
      : {}),
    stats: {
      lumaMean: r.stats.lumaMean,
      clippedFrac: r.stats.clippedFrac,
      sharpness: r.stats.sharpness,
      ...(r.stats.faceLumaRatio !== null ? { faceLumaRatio: r.stats.faceLumaRatio } : {}),
    },
    trackerStatus: { ...r.status },
  };
}
