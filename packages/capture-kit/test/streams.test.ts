import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validate } from '@neurocapture/contracts-ts';
import {
  canonicalTimeOfSample,
  decodeFrames,
  decodeSensors,
  encodeFrames,
  encodeSensors,
} from '../src/streams.ts';
import { goldenFrames, goldenSensors } from './golden-records.ts';

const root = resolve(import.meta.dirname, '../../..');
const golden = (n: string) =>
  new Uint8Array(readFileSync(resolve(root, `contracts/tests/golden/${n}-1.0.0.bin`)));

describe('stream codec', () => {
  it('decodes the golden frames file and re-encodes it byte for byte', () => {
    const bytes = golden('frames');
    const d = decodeFrames(bytes);
    expect(validate('stream-header', d.header).issues).toEqual([]);
    expect(d.records).toEqual(goldenFrames);
    expect(encodeFrames(d.header, d.records)).toEqual(bytes);
  });

  it('decodes the golden sensors file and re-encodes it byte for byte', () => {
    const bytes = golden('sensors');
    const d = decodeSensors(bytes);
    expect(validate('stream-header', d.header).issues).toEqual([]);
    expect(d.records.map((r) => r.type)).toEqual([1, 2]);
    expect(d.records[1]!.y).toBeCloseTo(9.79, 5);
    expect(d.records[0]!.tsNs).toBe(goldenSensors[0]!.tsNs);
    expect(encodeSensors(d.header, d.records)).toEqual(bytes);
  });

  it('maps MP4 samples to canonical times through firstRecordIndex', () => {
    const d = decodeFrames(golden('frames'));
    expect(canonicalTimeOfSample(d, 0)).toBe(1_016_666_667n); // firstRecordIndex = 1
    expect(canonicalTimeOfSample(d, 2)).toBe(1_050_000_000n);
    expect(canonicalTimeOfSample(d, 3)).toBeNull();
    expect(canonicalTimeOfSample({ ...d, header: { ...d.header, mp4: null } }, 0)).toBeNull();
  });

  it('rejects wrong magic, truncated headers and partial records', () => {
    const bytes = golden('frames');
    expect(() => decodeSensors(bytes)).toThrow(/not a NCSE stream/);
    expect(() => decodeFrames(bytes.subarray(0, 12))).toThrow(/truncated header/);
    expect(() => decodeFrames(bytes.subarray(0, bytes.length - 5))).toThrow(/not a multiple of 24/);
    expect(() => decodeFrames(new Uint8Array(2))).toThrow(/not a NCFR stream/);
  });
});
