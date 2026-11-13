/* eslint-disable */
/** GENERATED from /contracts by scripts/gen.ts — do not edit. Run `pnpm contracts:gen`. */

/**
 * JSON header of frames.bin and sensors.bin (DEV_PLAN §5.6, §12.2). File layout: 4-byte magic ('NCFR' frames, 'NCSE' sensors), uint32 LE header length, UTF-8 JSON header, then fixed-size little-endian records. Schema version 1.0.0.
 */
export interface StreamHeader {
  schemaVersion: '1.0.0';
  stream: 'frames' | 'sensors';
  takeId: string;
  clockSource: 'REALTIME' | 'UNKNOWN' | 'SIMULATED';
  timestampSemantics:
    | 'capture_session_frame_sensor_and_canonical_elapsed_realtime_ns'
    | 'sensor_event_elapsed_realtime_ns';
  /**
   * canonical − sensor clock offset (frames, UNKNOWN source).
   */
  offsetNs?: string | null;
  recordSize: 24;
  fields: {
    name: string;
    type: 'int64' | 'uint8' | 'pad3' | 'float32';
  }[];
  targetFps?: 60 | 30;
  actualFps?: 60 | 30;
  /**
   * frames only: how MP4 samples map to records. MP4 sample j ↔ record j + firstRecordIndex.
   */
  mp4?: null | {
    sampleCount: number;
    firstRecordIndex: number;
    maxAbsDiffMs: number;
    p95AbsDiffMs: number;
    /**
     * 'pattern': the interval pattern fixes the first encoded frame uniquely. 'earliest_candidate': several offsets fit equally (evenly spaced frames); the earliest was chosen, so absolute alignment is ±1–2 frames while relative timing is exact (decision 008).
     */
    anchor: 'pattern' | 'earliest_candidate';
  };
  /**
   * sensors only: type code → name.
   */
  sensorTypes?: {
    [k: string]: 'gyro' | 'gravity';
  };
}
