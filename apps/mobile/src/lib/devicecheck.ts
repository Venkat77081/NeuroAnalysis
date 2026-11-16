/**
 * Camera check before a phone is added (user, 16 Nov 2026; decision 035): a short CaptureKit
 * qualification benchmark (no thermal phase) on the back camera at 1080p/60. The phone passes at
 * config `deviceCheck.minFps` (55) or more; between that and `warnBelowFps` (59) it is
 * "borderline": it can be added, but some takes may fail the 59 fps take minimum and need
 * repeating. Nothing is recorded to storage or sent, except the measured fps when the phone is
 * added (or, for a patient, when they choose "Tell my hospital").
 */
import type { BenchmarkProgressEvent, CaptureKitPlugin } from '@neurocapture/capture-kit';
import type { PlatformConfig } from '@neurocapture/contracts-ts';

export type DeviceCheckConfig = PlatformConfig['deviceCheck'];

/** What the server receives as `camera_check`. */
export interface CameraCheck {
  effective_fps: number;
  ran_at: string;
}

export type CheckOutcome = 'pass' | 'borderline' | 'fail';

export interface DeviceCheckResult {
  outcome: CheckOutcome;
  fps: number;
  check: CameraCheck;
}

export function outcomeOf(fps: number, cfg: DeviceCheckConfig): CheckOutcome {
  if (fps < cfg.minFps) return 'fail';
  return fps < cfg.warnBelowFps ? 'borderline' : 'pass';
}

/** Runs the check; `onProgress` gets the share done (0–1) and the live fps while recording. */
export async function runDeviceCheck(
  kit: CaptureKitPlugin,
  cfg: DeviceCheckConfig,
  onProgress?: (done: number, liveFps: number | null) => void,
): Promise<DeviceCheckResult> {
  const handle = onProgress
    ? await kit.addListener('benchmarkProgress', (e: BenchmarkProgressEvent) =>
        onProgress(e.totalS > 0 ? Math.min(1, e.elapsedS / e.totalS) : 0, e.liveFps ?? null),
      )
    : null;
  try {
    const report = await kit.runQualificationBenchmark({
      facing: cfg.facing,
      resolution: cfg.resolution,
      targetFps: 60,
      recordMinutes: cfg.durationS / 60,
      thermalMinutes: 0,
    });
    const fps = Math.round(report.recording.effectiveFps * 10) / 10;
    return {
      outcome: outcomeOf(fps, cfg),
      fps,
      check: { effective_fps: fps, ran_at: report.ranAt },
    };
  } finally {
    await handle?.remove();
  }
}
