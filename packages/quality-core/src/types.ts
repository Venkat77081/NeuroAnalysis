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
}

export type Severity = 'INFO' | 'WARN' | 'CRITICAL';
export type CaptureVerdict = 'PASS' | 'RETAKE' | 'OVERRIDE';
