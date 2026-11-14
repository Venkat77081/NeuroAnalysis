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
}
