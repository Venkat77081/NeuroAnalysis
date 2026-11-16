/**
 * Take evaluation on the device. M6 collected the live frames; since M8 the verdict is computed
 * from the take's recorded files by quality-core's evaluateRecordedTake, the same function
 * tools/replay runs. All logic is in quality-core; this only reads the files and wires the pieces.
 */
import type { QualityConfig, TestConfig } from '@neurocapture/contracts-ts';
import type { BiomarkerRegistry } from '@neurocapture/contracts-ts';
import {
  base64ToBytes,
  framesFromLandmarksFile,
  readingsFromSensorsFile,
  sha256Hex,
  type CaptureKitPlugin,
  type RecordingResult,
} from '@neurocapture/capture-kit';
import {
  SeverityLog,
  evaluateRecordedTake,
  type CaptureVerdict,
  type DetectorResult,
  type LandmarkFrame,
  type ReadinessHint,
  type RuleName,
  type SensorReading,
  type Severity,
  type Side,
  type TakeAnalysis,
  type TakeEvent,
  type Window,
} from '@neurocapture/quality-core';

export class TakeCollector {
  readonly frames: LandmarkFrame[] = [];
  readonly log: SeverityLog;
  t0Ns: bigint | null = null;

  constructor(ruleVersion: string) {
    this.log = new SeverityLog(ruleVersion);
  }

  push(
    frame: LandmarkFrame,
    severities: readonly { rule: RuleName; severity: Severity }[],
    tracking: boolean,
  ): void {
    this.t0Ns ??= frame.tNs;
    this.frames.push(frame);
    this.log.update(Number(frame.tNs - this.t0Ns) / 1e9, severities, tracking);
  }
}

export interface FinishedTake {
  verdict: CaptureVerdict;
  detector: DetectorResult;
  analysis: TakeAnalysis;
  events: TakeEvent[];
  unknownWindows: Window[];
  readiness: ReadinessHint | null;
  /** What tools/replay needs to recompute this verdict (quality.json `replayInputs`). */
  replayInputs: ReplayInputs;
}

export interface ReplayInputs {
  source: 'recorded' | 'live';
  landmarksSha256: string | null;
  sensorsSha256: string | null;
  minEffectiveFps: number;
  hasSensors: boolean;
  orientation: 'portrait' | 'landscape';
  firstSampleNs: string | null;
}

/**
 * M8: the verdict comes from the take's own recorded files (landmarks.bin, sensors.bin), through
 * the same quality-core function tools/replay uses, so a replay reproduces it exactly. If the
 * files cannot be read, the frames collected live are used instead (source "live").
 */
export async function evaluateOnDevice(args: {
  kit: Pick<CaptureKitPlugin, 'readLandmarks' | 'readSensors'>;
  collector: TakeCollector | null;
  result: RecordingResult;
  test: TestConfig;
  quality: QualityConfig;
  registry: BiomarkerRegistry | null;
  side: Side | null;
  orientation: 'portrait' | 'landscape';
  hasSensors: boolean;
  /** Frame-rate limit (doctor's setting or config). */
  minEffectiveFps: number;
  sharpnessBaseline: number | null;
}): Promise<FinishedTake> {
  const { kit, result } = args;
  let frames: LandmarkFrame[] = args.collector?.frames ?? [];
  let sensors: SensorReading[] = [];
  let source: ReplayInputs['source'] = 'live';
  let landmarksSha256: string | null = null;
  let sensorsSha256: string | null = null;
  try {
    const [lm, se] = await Promise.all([
      kit.readLandmarks({ takeId: result.takeId }),
      kit.readSensors({ takeId: result.takeId }),
    ]);
    if (lm.data) {
      const bytes = base64ToBytes(lm.data);
      frames = framesFromLandmarksFile(bytes).frames;
      landmarksSha256 = await sha256Hex(bytes);
    } else frames = [];
    if (se.data) {
      const bytes = base64ToBytes(se.data);
      sensors = readingsFromSensorsFile(bytes);
      sensorsSha256 = await sha256Hex(bytes);
    }
    source = 'recorded';
  } catch {
    // Unreadable evidence: fall back to what the live path collected.
  }
  const firstSampleNs = result.mp4?.firstSampleNs ?? null;
  const evaluation = evaluateRecordedTake({
    frames,
    sensors,
    facts: result,
    firstSampleNs: firstSampleNs ? BigInt(firstSampleNs) : null,
    test: args.test,
    quality: args.quality,
    registry: args.registry,
    side: args.side,
    orientation: args.orientation,
    sharpnessBaseline: args.sharpnessBaseline,
    hasSensors: args.hasSensors,
    minEffectiveFps: args.minEffectiveFps,
  });
  return {
    ...evaluation,
    replayInputs: {
      source,
      landmarksSha256,
      sensorsSha256,
      minEffectiveFps: args.minEffectiveFps,
      hasSensors: args.hasSensors,
      orientation: args.orientation,
      firstSampleNs,
    },
  };
}
