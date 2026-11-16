/* eslint-disable */
/** GENERATED from /contracts by scripts/gen.ts — do not edit. Run `pnpm contracts:gen`. */

/**
 * JSON header of landmarks.bin (DEV_PLAN §12.2). File layout: 4-byte magic 'NCLM', uint32 LE header length, UTF-8 JSON header, then records, each: uint32 LE byte length of the rest, then the record body (layout 'NCLM-v1', see packages/capture-kit/src/landmarks.ts). Schema version 1.0.0.
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
  layout?: 'NCLM-v1';
  takeId?: string;
  /**
   * Records store MediaPipe's raw label. On an un-mirrored image it names the subject's hand; when imageMirrored is true readers flip it (decision 012).
   */
  handednessLabels?: 'mediapipe_raw';
  /**
   * Whether the analysis image given to the trackers was mirrored.
   */
  imageMirrored?: boolean;
  blendshapeNames?: string[];
  /**
   * Analysis image size in pixels (upright), so readers can restore aspect-dependent geometry (M8 replay). Optional for files written before plugin 0.9.0.
   */
  image?: {
    w: number;
    h: number;
  };
}
