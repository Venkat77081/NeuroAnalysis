/** Core data types shared by checks, the rule engine, detectors and the verdict (DEV_PLAN §5.7, §9.1). */

export type TrackerName = 'hand' | 'pose' | 'face';
export type TrackerStatus = 'ok' | 'no_result' | 'error' | 'off';
export type Side = 'L' | 'R';

/** Normalized 0..1 in the upright analysis frame. */
export interface Landmark {
  x: number;
  y: number;
  z: number;
  v?: number;
}

export interface FrameStats {
  lumaMean: number;
  clippedFrac: number;
  sharpness: number;
  faceLumaRatio?: number;
}

export interface LandmarkFrame {
  seq: number;
  tNs: bigint;
  /** Side already corrected for mirroring. */
  hands: { side: Side; score: number; pts: Landmark[] }[];
  pose?: Landmark[];
  face?: {
    pts: Landmark[];
    yaw: number;
    pitch: number;
    roll: number;
    blend?: Record<string, number>;
  };
  stats: FrameStats;
  trackerStatus: Record<TrackerName, TrackerStatus>;
  /** Analysis image size in pixels (upright). Needed for size and side-view ratios. */
  image?: { w: number; h: number };
  /** People / hands / faces found (before only the first is kept), for single_person. */
  counts?: { hands: number; poses: number; faces: number };
}

export type CheckState = 'OK' | 'WARN' | 'FAIL' | 'UNKNOWN';

export interface CheckSample {
  tNs: bigint;
  /** e.g. "in_safe_zone@1.0.0" */
  ruleId: string;
  state: CheckState;
  value: number | null;
  threshold: number | [number, number] | null;
  /** 0..1, e.g. landmark visibility or tracker score */
  confidence: number;
  configVersion: string;
  /** What the operator should do about a failing sample (i18n key under guidance.prompt). */
  hint?: PromptKey;
}

/** Positioning checks (DEV_PLAN §9.2). */
export type RuleName =
  | 'subject_present'
  | 'required_landmarks_visible'
  | 'in_safe_zone'
  | 'subject_size'
  | 'handedness_match'
  | 'single_person'
  | 'side_view'
  | 'face_frontal'
  | 'brightness'
  | 'face_light_balance'
  | 'sharpness'
  | 'tilt'
  | 'shake'
  | 'analysis_health';

/** One prompt per failure kind; shown and spoken to the operator (i18n session.guidance.prompt.*). */
export type PromptKey =
  | 'no_subject'
  | 'show_both_hands'
  | 'show_body'
  | 'show_face'
  | 'wrong_hand'
  | 'one_person'
  | 'cut_off_left'
  | 'cut_off_right'
  | 'cut_off_top'
  | 'cut_off_bottom'
  | 'move_closer'
  | 'move_back'
  | 'turn_side_on'
  | 'face_camera'
  | 'too_dark'
  | 'too_bright'
  | 'uneven_light'
  | 'level_phone'
  | 'rotate_cw'
  | 'rotate_ccw'
  | 'aim_down'
  | 'aim_up'
  | 'hold_still'
  | 'blurry';

/** Motion sensor sample (canonical clock), as delivered in sensorBatch events. */
export interface SensorReading {
  type: 'gyro' | 'gravity';
  tNs: bigint;
  x: number;
  y: number;
  z: number;
}

export type Severity = 'INFO' | 'WARN' | 'CRITICAL';
export type CaptureVerdict = 'PASS' | 'RETAKE' | 'OVERRIDE';
