/**
 * Evaluate a recorded take from its saved evidence (M8): the landmark records and sensor samples
 * written during recording, plus the recording facts. The app calls this when a take ends and
 * tools/replay calls it on the same files, so the verdict is reproducible ("replay parity").
 *
 * Mirrors the live path frame by frame: evaluateFrame → GuidanceEngine → SeverityLog, then the
 * detector, take analysis, readiness hint and capture verdict. Analysis latency is not stored in
 * landmarks.bin, so analysis health uses the frame rate only (latency 0) in both places.
 */
import type { BiomarkerRegistry, QualityConfig, TestConfig } from '@neurocapture/contracts-ts';
import { AnalysisHealth, SensorBuffer, evaluateFrame, gateRules } from '../checks/evaluate.ts';
import type { CheckContext } from '../checks/evaluate.ts';
import { runDetector } from '../detectors/detectors.ts';
import type { DetectorParams, DetectorResult } from '../detectors/detectors.ts';
import type { Window } from '../detectors/signal.ts';
import { GuidanceEngine } from '../engine/guidance.ts';
import type { Orientation } from '../checks/checks.ts';
import type { LandmarkFrame, SensorReading, Side, TrackerName } from '../types.ts';
import { SeverityLog, analyseTake } from './analysis.ts';
import type { TakeAnalysis, TakeEvent } from './analysis.ts';
import { captureVerdict } from './capture.ts';
import type { CaptureVerdict, TakeFacts } from './capture.ts';
import { readinessHint, readinessRetakeReasons } from './readiness.ts';
import type { ReadinessHint } from './readiness.ts';

export interface RecordedTakeInput {
  /** Landmark records of the take, in time order (landmarks.bin). */
  frames: readonly LandmarkFrame[];
  /** Gyro and gravity samples of the take (sensors.bin). */
  sensors: readonly SensorReading[];
  /** Recording facts (RecordingResult); error is ignored here (handled by the caller). */
  facts: TakeFacts;
  /** Canonical time of video sample 0 (mp4.firstSampleNs); null = first frame. */
  firstSampleNs: bigint | null;
  test: TestConfig;
  quality: QualityConfig;
  registry: BiomarkerRegistry | null;
  side: Side | null;
  orientation: Orientation;
  sharpnessBaseline: number | null;
  /** Phone had gyro + gravity (native). */
  hasSensors: boolean;
  /** Frame-rate limit for the verdict (doctor's setting or config). */
  minEffectiveFps: number;
}

export interface RecordedTakeEvaluation {
  verdict: CaptureVerdict;
  detector: DetectorResult;
  analysis: TakeAnalysis;
  events: TakeEvent[];
  unknownWindows: Window[];
  readiness: ReadinessHint | null;
}

export function evaluateRecordedTake(input: RecordedTakeInput): RecordedTakeEvaluation {
  const { test, quality, facts } = input;
  const ctx: CheckContext = {
    test,
    quality,
    side: input.side,
    orientation: input.orientation,
    sharpnessBaseline: input.sharpnessBaseline,
    sensors: input.hasSensors,
  };
  const frames = [...input.frames].sort((a, b) => (a.tNs < b.tNs ? -1 : a.tNs > b.tNs ? 1 : 0));
  const sensorSamples = [...input.sensors].sort((a, b) =>
    a.tNs < b.tNs ? -1 : a.tNs > b.tNs ? 1 : 0,
  );

  // Live path, replayed: severities per frame into the take's event log.
  const engine = new GuidanceEngine(gateRules(ctx), quality);
  const buffer = new SensorBuffer();
  const health = new AnalysisHealth();
  const log = new SeverityLog(quality.ruleVersion);
  const t0 = frames[0]?.tNs ?? null;
  let si = 0;
  for (const f of frames) {
    const batch: SensorReading[] = [];
    while (si < sensorSamples.length && sensorSamples[si]!.tNs <= f.tNs)
      batch.push(sensorSamples[si++]!);
    if (batch.length) buffer.push(batch);
    health.push(f.tNs, 0);
    engine.push(evaluateFrame(f, buffer, ctx, health));
    const st = engine.update(f.tNs);
    log.update(Number(f.tNs - t0!) / 1e9, engine.severities(f.tNs), st.tracking);
  }

  // Video time: sample 0 of the MP4 is t = 0.
  const startNs = input.firstSampleNs ?? t0 ?? 0n;
  const shift = t0 !== null ? Number(t0 - startNs) / 1e9 : 0;
  const logged = t0 !== null ? log.finish(facts.durationS - shift) : null;
  const move = (w: { tStartS: number; tEndS: number }) => ({
    tStartS: Math.max(0, w.tStartS + shift),
    tEndS: Math.max(0, w.tEndS + shift),
  });
  const events = (logged?.events ?? []).map((e) => ({ ...e, ...move(e) }));
  const unknownWindows = (logged?.unknownWindows ?? []).map(move);

  const detector = runDetector(
    test.task.detector,
    frames,
    startNs,
    test.task.detectorParams as unknown as DetectorParams,
    test.task.noMotionTimeoutS,
    facts.durationS,
  );
  const analysis = analyseTake({ frames, test, quality, detector, events, unknownWindows });
  const verdict = captureVerdict(
    { ...facts, error: null },
    {
      durationToleranceS: test.verdict.durationToleranceS,
      minEffectiveFps: input.minEffectiveFps,
      maxDroppedFrac: test.verdict.maxDroppedFrac ?? null,
    },
    {
      analysis,
      minLandmarkVisibleFrac: test.verdict.minLandmarkVisibleFrac,
      maxCriticalEvents: test.verdict.maxCriticalEvents,
      minSharpness:
        input.sharpnessBaseline !== null
          ? input.sharpnessBaseline * quality.checks.sharpness.minFracOfBaseline
          : null,
    },
  );

  const readiness = input.registry
    ? readinessHint(input.registry, test.code, {
        effectiveFps: facts.effectiveFps,
        durationS: facts.durationS,
        trackers: test.trackers as TrackerName[],
        frames,
        startNs,
        movementWindow: analysis.movementWindow,
        phases: [...new Set(detector.events.map((e) => e.kind as string))],
        sensors: input.hasSensors && sensorSamples.length > 0,
        handsNeeded: test.framing.bothHandsRequired ? 2 : 1,
        poseMinVisibility: quality.checks.required_landmarks_visible.poseMinVisibility,
        handMinScore: quality.checks.required_landmarks_visible.handMinScore,
      })
    : null;
  if (readiness) {
    const extra = readinessRetakeReasons(readiness, verdict.reasons);
    if (extra.length) {
      verdict.reasons.push(...extra);
      verdict.verdict = 'RETAKE';
    }
  }
  return { verdict, detector, analysis, events, unknownWindows, readiness };
}
