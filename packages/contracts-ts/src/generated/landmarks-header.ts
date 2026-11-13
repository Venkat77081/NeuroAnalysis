/* eslint-disable */
/** GENERATED from /contracts by scripts/gen.ts — do not edit. Run `pnpm contracts:gen`. */

/**
 * JSON header at the start of landmarks.bin (DEV_PLAN §12.2). Schema version 1.0.0.
 */
export interface LandmarksHeader {
  schemaVersion: '1.0.0';
  coordinateSystem: 'normalized_upright_analysis_frame';
  orientation: 'portrait' | 'landscape';
  mirrored: boolean;
  timestampSemantics: 'camera_frame_canonical_elapsed_realtime_ns';
  clockSource: 'REALTIME' | 'UNKNOWN' | 'SIMULATED';
  record: {
    endianness: 'little';
    dtype: 'float32';
  };
  /**
   * @minItems 1
   */
  trackers: [
    {
      name: 'hand' | 'pose' | 'face';
      modelVersion: string;
      pointsPerFrame: 21 | 33 | 478;
      valuesPerPoint: 3 | 4;
    },
    ...{
      name: 'hand' | 'pose' | 'face';
      modelVersion: string;
      pointsPerFrame: 21 | 33 | 478;
      valuesPerPoint: 3 | 4;
    }[]
  ];
}
