/* eslint-disable */
/** GENERATED from /contracts by scripts/gen.ts — do not edit. Run `pnpm contracts:gen`. */

/**
 * @minItems 1
 */
export type ReasonList = [string, ...string[]];

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
  /**
   * @minItems 1
   */
  medStates: ['ON' | 'OFF' | 'NA', ...('ON' | 'OFF' | 'NA')[]];
}
