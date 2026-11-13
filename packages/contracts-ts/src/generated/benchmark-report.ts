/* eslint-disable */
/** GENERATED from /contracts by scripts/gen.ts — do not edit. Run `pnpm contracts:gen`. */

/**
 * @minItems 2
 * @maxItems 2
 */
export type IntRange = [number, number];
export type ThermalStatus =
  'none' | 'light' | 'moderate' | 'severe' | 'critical' | 'emergency' | 'shutdown' | 'unsupported';

/**
 * Raw device-qualification measurements from runQualificationBenchmark (DEV_PLAN §7, M1). The tier is assigned in TypeScript from config/device-tiers.json and stored in `assessment`. Schema version 1.0.0.
 */
export interface BenchmarkReport {
  schemaVersion: '1.0.0';
  implementation: 'native' | 'mock' | 'webcam';
  pluginVersion: string;
  ranAt: string;
  device: {
    manufacturer: string;
    model: string;
    osName: 'android' | 'ios' | 'web';
    osVersion: string;
    sdkInt: number | null;
  };
  settings: {
    facing: 'back' | 'front';
    resolution: '1080p' | '720p';
    targetFps: 60 | 30;
    recordMinutes: number;
    thermalMinutes: number;
  };
  camera: {
    hardwareLevel: 'LEGACY' | 'LIMITED' | 'FULL' | 'LEVEL_3' | 'EXTERNAL' | 'UNKNOWN';
    timestampSource: 'REALTIME' | 'UNKNOWN' | 'SIMULATED';
    aeFpsRanges: IntRange[];
    maxFps1080p: number | null;
    maxFps720p: number | null;
    lockSupported: {
      ae: boolean;
      af: boolean;
      awb: boolean;
    };
  };
  timestamp: {
    samples: number;
    offsetNsMedian: string | null;
    offsetSpreadMs: number | null;
  };
  recording: RecordingStats;
  analysis: {
    fps: number;
    p95ProcessingMs: number | null;
    frames: number;
  };
  thermal: {
    durationS: number;
    statusStart: ThermalStatus;
    statusMax: ThermalStatus;
    windowFpsMin: number | null;
    windowFpsMedian: number | null;
  };
  storage: {
    freeBytesBefore: number | null;
  };
  errors: string[];
  assessment?: {
    tier: 'A' | 'B' | 'C' | 'W';
    provisional: boolean;
    reasons: string[];
    tiersConfigVersion: string;
  };
}
export interface RecordingStats {
  durationS: number;
  frameCount: number;
  effectiveFps: number;
  droppedFrames: number;
  droppedFrac: number;
  windowFpsMin: number | null;
}
