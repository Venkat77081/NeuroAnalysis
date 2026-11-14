/* eslint-disable */
/** GENERATED from /contracts by scripts/gen.ts — do not edit. Run `pnpm contracts:gen`. */

export type TestCode = 'FT' | 'FTF' | 'FR' | 'SAW' | 'FA';
export type Tracker = 'hand' | 'pose' | 'face';
/**
 * @minItems 2
 * @maxItems 2
 */
export type Range = [number, number];
/**
 * @minItems 1
 */
export type LandmarkList = [number, ...number[]];

/**
 * Protocol, thresholds and UI references for one examination (DEV_PLAN §8). Schema version 1.0.0.
 */
export interface TestConfig {
  schemaVersion: '1.0.0';
  configVersion: string;
  code: TestCode;
  name: string;
  /**
   * Biomarker IDs computed from this test, or "TBD" until defined.
   */
  biomarkers: 'TBD' | [string, ...string[]];
  /**
   * Sides recorded as separate takes. Empty = not sided.
   */
  sides: ('R' | 'L')[];
  minTier: 'A' | 'B';
  /**
   * @minItems 1
   */
  trackers: [Tracker, ...Tracker[]];
  camera: {
    facing: 'back' | 'front';
    resolution: '1080p' | '720p';
    targetFps: 60 | 30;
    minEffectiveFps: number;
    orientation: 'portrait' | 'landscape';
    lock: {
      ae: boolean;
      af: boolean;
      awb: boolean;
    };
    /**
     * If the device cannot record at targetFps, record at this rate instead (interim policy, decision 007). Omit to fail instead of falling back.
     */
    fallbackFps?: 30;
  };
  analysis: {
    fps: number;
  };
  setup: {
    view: 'front_offset_30deg' | 'front_centred' | 'side_90deg' | 'frontal_face';
    distanceM: Range;
    heightRef: 'hand' | 'chest' | 'hip' | 'eye';
    checklist: string[];
    /**
     * SAW only: walkway length between floor marks.
     */
    walkwayM?: number;
  };
  framing: {
    overlay:
      | 'hand_outline'
      | 'upper_body'
      | 'one_arm'
      | 'upper_body_hands_up'
      | 'upper_body_forearms'
      | 'side_reach'
      | 'full_body'
      | 'face_oval';
    requiredLandmarks: {
      hand?: LandmarkList;
      pose?: LandmarkList;
      face?: 'ALL' | LandmarkList;
    };
    safeZoneMargin: number;
    subjectSize: {
      metric: 'hand_bbox_height' | 'upper_body_height' | 'body_height' | 'face_height';
      min: number;
      max: number;
    };
    handednessMustMatchSide?: boolean;
    bothHandsRequired?: boolean;
    singlePerson?: boolean;
    sideViewMaxShoulderRatio?: number;
    maxFaceAngleDeg?: {
      yaw: number;
      pitch: number;
    };
  };
  task: {
    detector:
      | 'tap_counter'
      | 'ftf_cycle_counter'
      | 'rotation_counter'
      | 'saw_phases'
      | 'expression_sequence';
    /**
     * Fixed take length; the native timer stops recording here (decision 002).
     */
    durationS: number;
    noMotionTimeoutS: number;
    /**
     * Detector-specific parameters, or "TBD" until the protocol is defined.
     */
    detectorParams?: 'TBD' | {};
  };
  verdict: {
    minLandmarkVisibleFrac: number;
    /**
     * Landmarks the visible fraction is measured on, if not all required landmarks.
     */
    visibilityLandmarks?: {
      hand?: LandmarkList;
      pose?: LandmarkList;
    };
    durationToleranceS: number;
    maxCriticalEvents: number;
    sharpness: 'DEVICE_CALIBRATED' | number;
    requireAllPhases?: boolean;
    /**
     * RETAKE when dropped frames exceed this fraction. null = measured and logged but not enforced (interim policy, decision 007).
     */
    maxDroppedFrac?: number | null;
  };
  instructions: {
    /**
     * Asset path, or "TBD".
     */
    demoVideo: string;
    /**
     * @minItems 1
     */
    stepKeys: [string, ...string[]];
  };
}
