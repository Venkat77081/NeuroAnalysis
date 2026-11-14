/* eslint-disable */
/** GENERATED from /contracts by scripts/gen.ts — do not edit. Run `pnpm contracts:gen`. */

export type RuleId = string;

/**
 * Per-take capture verdict, events, metrics and readiness hint (DEV_PLAN §12.3). Schema version 1.0.0.
 */
export interface QualityReport {
  schemaVersion: '1.0.0';
  configVersion: string;
  qualityCoreVersion: string;
  testCode: 'FT' | 'FTF' | 'FR' | 'SAW' | 'FA';
  side: 'R' | 'L' | null;
  take: number;
  tier: 'A' | 'B' | 'C' | 'W';
  durationTargetS: number;
  durationS: number;
  stoppedEarly: boolean;
  fpsTarget: 60 | 30;
  fpsEffective: number;
  droppedFrames: number;
  droppedFrac: number;
  eventsDetected: number;
  phasesDetected?: ('seated' | 'standing' | 'walk_out' | 'turn' | 'walk_back' | 'seated_end')[];
  landmarkVisibleFrac: number;
  sharpnessMedian: number | null;
  sharpnessBaseline: number | null;
  brightnessMedian: number | null;
  movementWindow: null | Window;
  events: {
    tStartS: number;
    tEndS: number;
    ruleId: RuleId;
    severity: 'INFO' | 'WARN' | 'CRITICAL';
  }[];
  unknownWindows: Window[];
  captureVerdict: 'PASS' | 'RETAKE' | 'OVERRIDE';
  captureReasons: {
    code: string;
    messageKey: string;
    params?: {
      [k: string]: string | number;
    };
    ruleId?: RuleId;
  }[];
  override: null | {
    reason: string;
    note?: string;
    operatorId: string;
    at: string;
  };
  flaggedForReview: boolean;
  biomarkerReadinessHint: {
    registryVersion: string;
    /**
     * This interface was referenced by `undefined`'s JSON-Schema definition
     * via the `patternProperty` "^(FT|FTF|FR|SAW|FA)[0-9]+$".
     */
    [k: string]:
      | {
          status: 'COMPUTABLE' | 'PARTIAL' | 'NOT_COMPUTABLE';
          reason?: string;
          retakeFixable?: boolean;
          missing?: ('fps' | 'duration' | 'tracker' | 'landmarks' | 'phases' | 'sensors')[];
        }
      | string;
  };
  /**
   * What tools/replay needs to recompute this verdict from the take's own files (M8). Optional for takes recorded before quality-core 0.5.0.
   */
  replayInputs?: {
    /**
     * recorded = landmarks.bin/sensors.bin; live = analysis events (file unreadable)
     */
    source: 'recorded' | 'live';
    landmarksSha256: string | null;
    sensorsSha256: string | null;
    minEffectiveFps: number;
    hasSensors: boolean;
    orientation: 'portrait' | 'landscape';
    firstSampleNs: string | null;
  };
}
export interface Window {
  tStartS: number;
  tEndS: number;
}
