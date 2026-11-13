/* eslint-disable */
/** GENERATED from /contracts by scripts/gen.ts — do not edit. Run `pnpm contracts:gen`. */

/**
 * @minItems 1
 */
export type Resolutions = ['1080p' | '720p', ...('1080p' | '720p')[]];

/**
 * Thresholds for assigning device tiers from benchmark reports (DEV_PLAN §7). Schema version 1.0.0.
 */
export interface DeviceTiersConfig {
  schemaVersion: '1.0.0';
  configVersion: string;
  A: {
    resolutions: Resolutions;
    targetFps: 60;
    minEffectiveFps: number;
    maxDroppedFrac: number;
    minAnalysisFps: number;
    maxOffsetSpreadMsIfUnknownSource: number;
    minThermalWindowFps: number;
    requireLock: boolean;
    minRecordMinutes: number;
    minThermalMinutes: number;
  };
  B: {
    resolutions: Resolutions;
    targetFps: 30;
    minEffectiveFps: number;
    maxDroppedFrac: number;
    minAnalysisFps: number;
    minRecordMinutes: number;
  };
}
