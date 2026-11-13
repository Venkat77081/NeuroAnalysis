/**
 * frames.bin / sensors.bin codec (contracts/stream-header.schema.json).
 * Layout: 4-byte magic, uint32 LE header length, UTF-8 JSON header, then 24-byte LE records.
 * Pure TypeScript over ArrayBuffer/DataView (browser, Node and the replay tool).
 */
import type { StreamHeader } from '@neurocapture/contracts-ts/types';

export const FRAMES_MAGIC = 'NCFR';
export const SENSORS_MAGIC = 'NCSE';
export const RECORD_SIZE = 24;

export interface FrameRecord {
  frameNumber: bigint;
  sensorTsNs: bigint;
  canonicalTsNs: bigint;
}

export interface SensorRecord {
  type: number; // 1 = gyro, 2 = gravity
  tsNs: bigint;
  x: number;
  y: number;
  z: number;
}

export interface DecodedStream<R> {
  header: StreamHeader;
  records: R[];
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function writeEnvelope(
  magic: string,
  header: StreamHeader,
  count: number,
  fill: (v: DataView, off: number, i: number) => void,
): Uint8Array {
  const h = enc.encode(JSON.stringify(header));
  const out = new Uint8Array(8 + h.length + count * RECORD_SIZE);
  out.set(enc.encode(magic), 0);
  const v = new DataView(out.buffer);
  v.setUint32(4, h.length, true);
  out.set(h, 8);
  const base = 8 + h.length;
  for (let i = 0; i < count; i++) fill(v, base + i * RECORD_SIZE, i);
  return out;
}

function readEnvelope(
  buf: ArrayBuffer | Uint8Array,
  magic: string,
): { header: StreamHeader; view: DataView; base: number; count: number } {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8 || dec.decode(bytes.subarray(0, 4)) !== magic)
    throw new Error(`not a ${magic} stream`);
  const hLen = view.getUint32(4, true);
  if (8 + hLen > bytes.length) throw new Error('truncated header');
  const header = JSON.parse(dec.decode(bytes.subarray(8, 8 + hLen))) as StreamHeader;
  const base = 8 + hLen;
  const body = bytes.length - base;
  if (body % RECORD_SIZE !== 0)
    throw new Error(`record area of ${body} bytes is not a multiple of ${RECORD_SIZE}`);
  return { header, view, base, count: body / RECORD_SIZE };
}

export function encodeFrames(header: StreamHeader, records: FrameRecord[]): Uint8Array {
  return writeEnvelope(FRAMES_MAGIC, header, records.length, (v, o, i) => {
    const r = records[i]!;
    v.setBigInt64(o, r.frameNumber, true);
    v.setBigInt64(o + 8, r.sensorTsNs, true);
    v.setBigInt64(o + 16, r.canonicalTsNs, true);
  });
}

export function decodeFrames(buf: ArrayBuffer | Uint8Array): DecodedStream<FrameRecord> {
  const { header, view, base, count } = readEnvelope(buf, FRAMES_MAGIC);
  const records: FrameRecord[] = [];
  for (let i = 0; i < count; i++) {
    const o = base + i * RECORD_SIZE;
    records.push({
      frameNumber: view.getBigInt64(o, true),
      sensorTsNs: view.getBigInt64(o + 8, true),
      canonicalTsNs: view.getBigInt64(o + 16, true),
    });
  }
  return { header, records };
}

export function encodeSensors(header: StreamHeader, records: SensorRecord[]): Uint8Array {
  return writeEnvelope(SENSORS_MAGIC, header, records.length, (v, o, i) => {
    const r = records[i]!;
    v.setUint8(o, r.type);
    v.setBigInt64(o + 4, r.tsNs, true);
    v.setFloat32(o + 12, r.x, true);
    v.setFloat32(o + 16, r.y, true);
    v.setFloat32(o + 20, r.z, true);
  });
}

export function decodeSensors(buf: ArrayBuffer | Uint8Array): DecodedStream<SensorRecord> {
  const { header, view, base, count } = readEnvelope(buf, SENSORS_MAGIC);
  const records: SensorRecord[] = [];
  for (let i = 0; i < count; i++) {
    const o = base + i * RECORD_SIZE;
    records.push({
      type: view.getUint8(o),
      tsNs: view.getBigInt64(o + 4, true),
      x: view.getFloat32(o + 12, true),
      y: view.getFloat32(o + 16, true),
      z: view.getFloat32(o + 20, true),
    });
  }
  return { header, records };
}

/**
 * Canonical time of MP4 sample j (DEV_PLAN §5.6): record j + mp4.firstRecordIndex. Returns null
 * when the take has no MP4 mapping or the index falls outside the recorded frames.
 */
export function canonicalTimeOfSample(
  frames: DecodedStream<FrameRecord>,
  sampleIndex: number,
): bigint | null {
  const k = frames.header.mp4?.firstRecordIndex;
  if (k === undefined || k === null) return null;
  return frames.records[sampleIndex + k]?.canonicalTsNs ?? null;
}
