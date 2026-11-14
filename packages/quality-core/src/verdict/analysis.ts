/**
 * In-recording evidence and take analysis (DEV_PLAN §9.3 severities, §9.5 PASS conditions).
 * SeverityLog turns the rule engine's per-frame severities into timestamped events; analyseTake
 * combines them with the detector result and the frames into facts for the verdict.
 */
import type { QualityConfig, TestConfig } from '@neurocapture/contracts-ts';
import type { DetectorResult } from '../detectors/detectors.ts';
import type { Window } from '../detectors/signal.ts';
import { requiredLandmarksVisible } from '../checks/checks.ts';
import { makeRuleId } from '../rule-id.ts';
import type { LandmarkFrame, RuleName, Severity } from '../types.ts';

export interface TakeEvent {
  tStartS: number;
  tEndS: number;
  ruleId: string;
  severity: Severity;
}

const RANK: Record<Severity, number> = { INFO: 0, WARN: 1, CRITICAL: 2 };

/** Collects WARN/CRITICAL intervals per rule and "tracking…" (UNKNOWN) intervals during a take. */
export class SeverityLog {
  private open = new Map<RuleName, { start: number; severity: Severity }>();
  private done: TakeEvent[] = [];
  private unknownStart: number | null = null;
  private unknown: Window[] = [];

  constructor(private readonly ruleVersion: string) {}

  /** tS: seconds from the take start. Only WARN and CRITICAL open events; INFO is ignored. */
  update(
    tS: number,
    severities: readonly { rule: RuleName; severity: Severity }[],
    tracking: boolean,
  ): void {
    const now = new Map(
      severities.filter((s) => s.severity !== 'INFO').map((s) => [s.rule, s.severity]),
    );
    for (const [rule, ev] of this.open) {
      if (!now.has(rule)) this.close(rule, tS);
      else if (RANK[now.get(rule)!] > RANK[ev.severity]) ev.severity = now.get(rule)!;
    }
    for (const [rule, severity] of now)
      if (!this.open.has(rule)) this.open.set(rule, { start: tS, severity });
    if (tracking && this.unknownStart === null) this.unknownStart = tS;
    if (!tracking && this.unknownStart !== null) {
      this.unknown.push({ tStartS: this.unknownStart, tEndS: tS });
      this.unknownStart = null;
    }
  }

  private close(rule: RuleName, tS: number) {
    const ev = this.open.get(rule)!;
    this.done.push({
      tStartS: ev.start,
      tEndS: tS,
      ruleId: makeRuleId(rule, this.ruleVersion),
      severity: ev.severity,
    });
    this.open.delete(rule);
  }

  /** Close everything at endS and return events (by start time) and unknown windows. */
  finish(endS: number): { events: TakeEvent[]; unknownWindows: Window[] } {
    for (const rule of [...this.open.keys()]) this.close(rule, endS);
    if (this.unknownStart !== null) this.unknown.push({ tStartS: this.unknownStart, tEndS: endS });
    this.unknownStart = null;
    return {
      events: this.done.sort((a, b) => a.tStartS - b.tStartS),
      unknownWindows: this.unknown,
    };
  }
}

export interface TakeAnalysis {
  landmarkVisibleFrac: number;
  sharpnessMedian: number | null;
  brightnessMedian: number | null;
  /** Detector found the protocol carried out. */
  complete: boolean;
  noMotion: Window[];
  movementWindow: Window | null;
  criticalEvents: number;
  /** UNKNOWN windows longer than maxUnknownS overlapping the movement window. */
  longUnknown: Window[];
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

const overlaps = (a: Window, b: Window) => a.tStartS < b.tEndS && b.tStartS < a.tEndS;

export function analyseTake(args: {
  frames: readonly LandmarkFrame[];
  test: TestConfig;
  quality: QualityConfig;
  detector: DetectorResult;
  events: readonly TakeEvent[];
  unknownWindows: readonly Window[];
}): TakeAnalysis {
  const { frames, test, quality, detector } = args;
  const req = test.framing.requiredLandmarks;
  const both = test.framing.bothHandsRequired ?? false;
  const visible = frames.filter(
    (f) =>
      requiredLandmarksVisible(f, req, both, quality.checks.required_landmarks_visible).state ===
      'OK',
  ).length;
  const mw = detector.movementWindow;
  const maxUnknown = quality.verdict.maxUnknownS;
  return {
    landmarkVisibleFrac: frames.length ? visible / frames.length : 0,
    sharpnessMedian: median(frames.map((f) => f.stats.sharpness)),
    brightnessMedian: median(frames.map((f) => f.stats.lumaMean)),
    complete: detector.complete,
    noMotion: detector.noMotion,
    movementWindow: mw,
    criticalEvents: args.events.filter((e) => e.severity === 'CRITICAL').length,
    longUnknown: args.unknownWindows.filter(
      (w) => w.tEndS - w.tStartS > maxUnknown && (!mw || overlaps(w, mw)),
    ),
  };
}
