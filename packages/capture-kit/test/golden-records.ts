import type { FrameRecord, SensorRecord } from '../src/streams.ts';

/** Same values are hard-coded in the Kotlin StreamFormatTest. */
export const goldenFrames: FrameRecord[] = [
  { frameNumber: 0n, sensorTsNs: 1_000_000_000n, canonicalTsNs: 1_000_000_000n },
  { frameNumber: 1n, sensorTsNs: 1_016_666_667n, canonicalTsNs: 1_016_666_667n },
  { frameNumber: 2n, sensorTsNs: 1_033_333_333n, canonicalTsNs: 1_033_333_333n },
  { frameNumber: 3n, sensorTsNs: 1_050_000_000n, canonicalTsNs: 1_050_000_000n },
];

export const goldenSensors: SensorRecord[] = [
  { type: 1, tsNs: 1_000_000_000n, x: 0.001, y: -0.002, z: 0.003 },
  { type: 2, tsNs: 1_005_000_000n, x: 0.05, y: 9.79, z: 0.3 },
];
