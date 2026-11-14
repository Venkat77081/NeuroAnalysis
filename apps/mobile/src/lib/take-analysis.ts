/**
 * M6: collects a take's landmark frames and alert history while it records, and turns them into
 * the detector result, take analysis and capture verdict when it ends. All logic is in
 * quality-core; this only wires the pieces and fixes the time origin (video sample 0).
 */
import type { QualityConfig, TestConfig } from '@neurocapture/contracts-ts';
import type { RecordingResult } from '@neurocapture/capture-kit';
import {
  SeverityLog,
  analyseTake,
  captureVerdict,
  runDetector,
  type CaptureVerdict,
  type DetectorParams,
  type DetectorResult,
  type LandmarkFrame,
  type RuleName,
  type Severity,
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
}

export function finishTake(args: {
  collector: TakeCollector | null;
  result: RecordingResult;
  test: TestConfig;
  quality: QualityConfig;
  /** Frame-rate limit (doctor's setting or config). */
  minEffectiveFps: number;
  sharpnessBaseline: number | null;
}): FinishedTake {
  const { result, test, quality } = args;
  const frames = args.collector?.frames ?? [];
  const startNs = result.mp4?.firstSampleNs
    ? BigInt(result.mp4.firstSampleNs)
    : (args.collector?.t0Ns ?? 0n);
  // The log counted from the first collected frame; shift it to video time.
  const shift = args.collector?.t0Ns != null ? Number(args.collector.t0Ns - startNs) / 1e9 : 0;
  const logged = args.collector?.log.finish(result.durationS - shift) ?? {
    events: [],
    unknownWindows: [],
  };
  const move = (w: { tStartS: number; tEndS: number }) => ({
    tStartS: Math.max(0, w.tStartS + shift),
    tEndS: Math.max(0, w.tEndS + shift),
  });
  const events = logged.events.map((e) => ({ ...e, ...move(e) }));
  const unknownWindows = logged.unknownWindows.map(move);
  const detector = runDetector(
    test.task.detector,
    frames,
    startNs,
    test.task.detectorParams as unknown as DetectorParams,
    test.task.noMotionTimeoutS,
    result.durationS,
  );
  const analysis = analyseTake({ frames, test, quality, detector, events, unknownWindows });
  const verdict = captureVerdict(
    { ...result, error: null },
    {
      durationToleranceS: test.verdict.durationToleranceS,
      minEffectiveFps: args.minEffectiveFps,
      maxDroppedFrac: test.verdict.maxDroppedFrac ?? null,
    },
    {
      analysis,
      minLandmarkVisibleFrac: test.verdict.minLandmarkVisibleFrac,
      maxCriticalEvents: test.verdict.maxCriticalEvents,
      minSharpness:
        args.sharpnessBaseline !== null
          ? args.sharpnessBaseline * quality.checks.sharpness.minFracOfBaseline
          : null,
    },
  );
  return { verdict, detector, analysis, events, unknownWindows };
}
