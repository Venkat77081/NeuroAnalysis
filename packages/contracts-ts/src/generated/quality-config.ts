/* eslint-disable */
/** GENERATED from /contracts by scripts/gen.ts — do not edit. Run `pnpm contracts:gen`. */

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
export type Fraction = number;

/**
 * Thresholds for the positioning checks (DEV_PLAN §9.2) and the rule engine (§9.3). Per-test values (safe-zone margin, subject size, side view, face angle) stay in the test configs.
 */
export interface QualityConfig {
  schemaVersion: '1.0.0';
  configVersion: string;
  /**
   * Version stamped on every rule ID (<name>@<ruleVersion>).
   */
  ruleVersion: string;
  engine: {
    /**
     * Sliding window per rule.
     */
    windowMs: number;
    /**
     * Samples needed in a window before it has a state.
     */
    minSamples: number;
    /**
     * Window is UNKNOWN when more than this fraction is UNKNOWN.
     */
    unknownFrac: number;
    /**
     * OK → WARN when the bad fraction is above this.
     */
    warnEnterFrac: number;
    /**
     * WARN → OK when the bad fraction is below this.
     */
    warnExitFrac: number;
    /**
     * Every gate rule OK continuously for this long enables Record.
     */
    gateHoldS: number;
  };
  guidance: {
    /**
     * Minimum time before the same prompt is spoken again.
     */
    promptCooldownS: number;
    /**
     * Rule names, most important first. Only the first failing rule is prompted.
     *
     * @minItems 1
     */
    promptPriority: [RuleName, ...RuleName[]];
    hapticOnGateOpen: boolean;
  };
  /**
   * During recording (used from M6): conditions that make a take invalid.
   */
  critical: {
    subjectMissingS: number;
    wrongSideS: number;
    secondPersonS: number;
    shakeS: number;
    minRecordingFps: number;
    lowFpsS: number;
  };
  checks: {
    required_landmarks_visible: {
      poseMinVisibility: Fraction;
      handMinScore: Fraction;
    };
    brightness: {
      lumaMin: number;
      lumaMax: number;
      maxClippedFrac: Fraction;
    };
    face_light_balance: {
      min: number;
      max: number;
    };
    sharpness: {
      minFracOfBaseline: Fraction;
    };
    tilt: {
      maxRollDeg: number;
      maxPitchDeg: number;
    };
    shake: {
      windowMs: number;
      maxRadPerS: number;
    };
    analysis_health: {
      minFps: number;
      maxLatencyMs: number;
    };
  };
  verdict: {
    /**
     * An UNKNOWN (tracking…) window longer than this inside the movement window fails the take (§9.5).
     */
    maxUnknownS: number;
  };
}
