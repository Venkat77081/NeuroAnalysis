/* eslint-disable */
/** GENERATED from /contracts by scripts/gen.ts — do not edit. Run `pnpm contracts:gen`. */

/**
 * @minItems 1
 */
export type ReasonList = [string, ...string[]];
/**
 * Reasons for ending a session before all tests are done.
 *
 * @minItems 1
 */
export type ReasonList1 = [string, ...string[]];

/**
 * Test order and session rules (DEV_PLAN §8.3). Schema version 1.0.0.
 */
export interface SessionConfig {
  schemaVersion: '1.0.0';
  configVersion: string;
  /**
   * @minItems 1
   */
  order: [
    ['FT' | 'FTF' | 'FR' | 'SAW' | 'FA', 'R' | 'L' | null],
    ...['FT' | 'FTF' | 'FR' | 'SAW' | 'FA', 'R' | 'L' | null][]
  ];
  maxRetakes: number;
  skipReasons: ReasonList;
  overrideReasons: ReasonList;
  abortReasons: ReasonList1;
  /**
   * @minItems 1
   */
  medStates: ['ON' | 'OFF' | 'NA', ...('ON' | 'OFF' | 'NA')[]];
  /**
   * Countdown before each recording starts (beep at each second).
   */
  countdownS: number;
  /**
   * Version of the consent text shown on Session home; saved with every session.
   */
  consentVersion: string;
  /**
   * Frame-rate limits a doctor may choose in settings instead of each test's minEffectiveFps (decision 015).
   *
   * @minItems 1
   */
  minFpsOptions?: [number, ...number[]];
  /**
   * Upload rules (M7). Local copies are deleted retentionHours after the server confirms all checksums.
   */
  upload?: {
    defaultRetentionHours: number;
    /**
     * @minItems 1
     */
    retentionHoursOptions: [number, ...number[]];
    wifiOnlyDefault: boolean;
    /**
     * Server address prefilled on the setup screen; fake://api is the built-in test server (mock mode).
     */
    defaultEndpoint: string;
  };
  /**
   * Free-space rules (DEV_PLAN §15 StorageLow): no new take below minFreeGbToStart; a take in progress stops gracefully below stopBelowMb.
   */
  storage?: {
    minFreeGbToStart: number;
    stopBelowMb: number;
  };
  /**
   * M9 thermal policy (DEV_PLAN M9): from the Android thermal status, first lower the analysis rate, then hide overlays; never the recording frame rate. Levels apply at that status and above.
   */
  thermal?: {
    moderate: {
      /**
       * Analysis (tracking) rate at this level; the recording frame rate never changes.
       */
      analysisFps: number;
      /**
       * false = hide the landmark overlay (non-essential drawing)
       */
      overlays: boolean;
      warn: boolean;
      /**
       * Ask the operator to let the phone cool before the next take.
       */
      blockNewTakes: boolean;
    };
    severe: {
      /**
       * Analysis (tracking) rate at this level; the recording frame rate never changes.
       */
      analysisFps: number;
      /**
       * false = hide the landmark overlay (non-essential drawing)
       */
      overlays: boolean;
      warn: boolean;
      /**
       * Ask the operator to let the phone cool before the next take.
       */
      blockNewTakes: boolean;
    };
    critical: {
      /**
       * Analysis (tracking) rate at this level; the recording frame rate never changes.
       */
      analysisFps: number;
      /**
       * false = hide the landmark overlay (non-essential drawing)
       */
      overlays: boolean;
      warn: boolean;
      /**
       * Ask the operator to let the phone cool before the next take.
       */
      blockNewTakes: boolean;
    };
  };
  /**
   * v36 (decision 063): patients start a recording with a sign (open palm; raised arm for Stand and Walk), held still for holdS, then the usual countdown. Only on phones whose phone check passed the sign.
   */
  startSign?: {
    enabled: boolean;
    /**
     * Seconds the sign is held still.
     */
    holdS: number;
    /**
     * Tracking gaps up to this long are bridged.
     */
    maxGapS: number;
    /**
     * Moving more than this share of the hand's (or shoulders') size restarts the hold.
     */
    maxDriftFrac: number;
    palmMinFingers: number;
    armMarginFrac: number;
    kinds: {
      [k: string]: 'palm' | 'arm';
    };
    check: {
      /**
       * The phone check needs this many tracking updates a second.
       */
      minTrackingHz: number;
      /**
       * Seconds to show the sign at the phone check.
       */
      tryoutS: number;
    };
  };
}
