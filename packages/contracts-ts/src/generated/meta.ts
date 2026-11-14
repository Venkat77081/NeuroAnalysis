/* eslint-disable */
/** GENERATED from /contracts by scripts/gen.ts — do not edit. Run `pnpm contracts:gen`. */

export type SemVer = string;

/**
 * Device, versions and context saved with every take (DEV_PLAN §12.2). Schema version 1.0.0. No patient names or external refs.
 */
export interface TakeMeta {
  schemaVersion: '1.0.0';
  takeId: string;
  sessionId: string;
  testCode: 'FT' | 'FTF' | 'FR' | 'SAW' | 'FA';
  side: 'R' | 'L' | null;
  take: number;
  configVersion: string;
  sessionConfigVersion?: string;
  appVersion: SemVer;
  pluginVersion: SemVer;
  qualityCoreVersion: SemVer;
  implementation: 'native' | 'mock' | 'webcam';
  device: {
    manufacturer: string;
    model: string;
    osName: 'android' | 'ios' | 'web';
    osVersion: string;
  };
  /**
   * Device tier from a qualification report, or null when the device was not qualified (model approval deferred, decision 006).
   */
  tier: 'A' | 'B' | 'C' | 'W' | null;
  /**
   * Snapshot of getCapabilities() at capture time.
   */
  capabilities: {};
  timestamp: {
    source: 'REALTIME' | 'UNKNOWN' | 'SIMULATED';
    offsetNs: string | null;
    offsetSpreadMs: number | null;
  };
  camera: {
    facing: 'back' | 'front';
    resolution: '1080p' | '720p';
    targetFps: 60 | 30;
    orientation: 'portrait' | 'landscape';
    /**
     * Frame-rate limit used for this take's verdict (config default or the doctor's setting).
     */
    minEffectiveFps?: number;
  };
  medState: 'ON' | 'OFF' | 'NA';
  operatorId: string;
  createdAt: string;
}
