/**
 * Runs the §9.2 checks that apply to a test on one analysis frame and returns CheckSamples for
 * the rule engine. Which rules apply comes from the test config (trackers, framing flags) and the
 * device (sensors, sharpness baseline).
 */
import type { QualityConfig, TestConfig } from '@neurocapture/contracts-ts';
import { makeRuleId } from '../rule-id.ts';
import type {
  CheckSample,
  LandmarkFrame,
  RuleName,
  SensorReading,
  Side,
  TrackerName,
} from '../types.ts';
import {
  analysisHealth,
  brightness,
  faceFrontal,
  faceLightBalance,
  handednessMatch,
  inSafeZone,
  requiredLandmarksVisible,
  requiredPoints,
  sharpness,
  shake,
  sideView,
  singlePerson,
  subjectPresent,
  subjectSize,
  tilt,
  type CheckResult,
  type Orientation,
} from './checks.ts';

export interface CheckContext {
  test: TestConfig;
  quality: QualityConfig;
  /** Tested side for sided tests (variant protocol), else null. */
  side: Side | null;
  orientation: Orientation;
  /** Device sharpness baseline from calibration; null = sharpness not checked. */
  sharpnessBaseline: number | null;
  /** Gyro + gravity available (native); false for webcam/mock without sensors. */
  sensors: boolean;
}

/** Gate rules for this test and device, in no particular order. */
export function gateRules(ctx: CheckContext): RuleName[] {
  const f = ctx.test.framing;
  const rules: RuleName[] = [
    'subject_present',
    'required_landmarks_visible',
    'in_safe_zone',
    'subject_size',
  ];
  if (f.handednessMustMatchSide && ctx.side) rules.push('handedness_match');
  if (f.singlePerson) rules.push('single_person');
  if (f.sideViewMaxShoulderRatio !== undefined) rules.push('side_view');
  if (f.maxFaceAngleDeg) rules.push('face_frontal');
  rules.push('brightness');
  if (ctx.test.trackers.includes('face')) rules.push('face_light_balance');
  if (ctx.sharpnessBaseline !== null) rules.push('sharpness');
  if (ctx.sensors) rules.push('tilt', 'shake');
  return rules;
}

/** Keeps the latest gravity reading and a short gyro history (pure; fed from sensorBatch). */
export class SensorBuffer {
  private gravity: SensorReading | null = null;
  private gyro: SensorReading[] = [];

  constructor(private readonly keepMs = 2000) {}

  push(samples: readonly SensorReading[]): void {
    for (const s of samples) {
      if (s.type === 'gravity') {
        if (!this.gravity || s.tNs >= this.gravity.tNs) this.gravity = s;
      } else this.gyro.push(s);
    }
    const last = this.gyro.at(-1);
    if (last) {
      const cutoff = last.tNs - BigInt(this.keepMs) * 1_000_000n;
      if (this.gyro[0]!.tNs < cutoff) this.gyro = this.gyro.filter((g) => g.tNs >= cutoff);
    }
  }

  /** Latest gravity reading if it is not older than maxAgeMs before atNs. */
  latestGravity(atNs: bigint, maxAgeMs = 500): SensorReading | null {
    const g = this.gravity;
    return g && atNs - g.tNs <= BigInt(maxAgeMs) * 1_000_000n ? g : null;
  }

  /** Gyro readings in (atNs − windowMs, atNs]. */
  gyroWindow(atNs: bigint, windowMs: number): SensorReading[] {
    const from = atNs - BigInt(Math.round(windowMs * 1e6));
    return this.gyro.filter((g) => g.tNs > from && g.tNs <= atNs);
  }
}

/** Analysis fps and latency over the last frames (UNKNOWN source for all checks, §9.2). */
export class AnalysisHealth {
  private times: bigint[] = [];
  private latencies: number[] = [];

  constructor(private readonly keep = 30) {}

  /** latencyMs: delivery delay of the frame (emit or receive time − frame time). */
  push(tNs: bigint, latencyMs: number): void {
    this.times.push(tNs);
    this.latencies.push(latencyMs);
    if (this.times.length > this.keep) {
      this.times.shift();
      this.latencies.shift();
    }
  }

  fps(): number {
    const n = this.times.length;
    if (n < 2) return Infinity; // not enough history yet: do not block on it
    const span = Number(this.times[n - 1]! - this.times[0]!) / 1e9;
    return span > 0 ? (n - 1) / span : 0;
  }

  latencyP95(): number {
    if (!this.latencies.length) return 0;
    const s = [...this.latencies].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]!;
  }
}

/** Evaluate the gate rules on one frame. If analysis is unhealthy, landmark-based samples are UNKNOWN. */
export function evaluateFrame(
  frame: LandmarkFrame,
  sensors: SensorBuffer,
  ctx: CheckContext,
  health?: AnalysisHealth,
): CheckSample[] {
  const { test, quality } = ctx;
  const q = quality.checks;
  const f = test.framing;
  const trackers = test.trackers as TrackerName[];
  const both = f.bothHandsRequired ?? false;
  const healthy =
    !health || analysisHealth(health.fps(), health.latencyP95(), q.analysis_health).state === 'OK';
  const minVis = q.required_landmarks_visible.poseMinVisibility;
  const out: CheckSample[] = [];
  // Too big also pushes points off an edge; then "move back" is the single useful prompt.
  const tooBig = subjectSize(frame, f.subjectSize, minVis).hint === 'move_back';
  for (const rule of gateRules(ctx)) {
    let r: CheckResult;
    switch (rule) {
      case 'subject_present':
        r = subjectPresent(frame, trackers, both);
        break;
      case 'required_landmarks_visible':
        r = requiredLandmarksVisible(
          frame,
          f.requiredLandmarks,
          both,
          q.required_landmarks_visible,
        );
        break;
      case 'in_safe_zone':
        r = inSafeZone(requiredPoints(frame, f.requiredLandmarks, minVis), f.safeZoneMargin);
        if (r.state === 'FAIL' && tooBig) r = { ...r, hint: 'move_back' };
        break;
      case 'subject_size':
        r = subjectSize(frame, f.subjectSize, minVis);
        break;
      case 'handedness_match':
        r = handednessMatch(frame, ctx.side!);
        break;
      case 'single_person':
        r = singlePerson(frame, trackers);
        break;
      case 'side_view':
        r = sideView(frame, f.sideViewMaxShoulderRatio!, minVis);
        break;
      case 'face_frontal':
        r = faceFrontal(frame, f.maxFaceAngleDeg!);
        break;
      case 'brightness':
        r = brightness(frame.stats, q.brightness);
        break;
      case 'face_light_balance':
        r = faceLightBalance(frame.stats, q.face_light_balance);
        break;
      case 'sharpness':
        r = sharpness(frame.stats, ctx.sharpnessBaseline!, q.sharpness.minFracOfBaseline);
        break;
      case 'tilt':
        r = tilt(sensors.latestGravity(frame.tNs), ctx.orientation, q.tilt);
        break;
      case 'shake':
        r = shake(sensors.gyroWindow(frame.tNs, q.shake.windowMs), q.shake.maxRadPerS);
        break;
      default:
        continue;
    }
    // Sensors and image statistics do not depend on the trackers; landmark checks do.
    const landmarkRule = !['brightness', 'sharpness', 'tilt', 'shake'].includes(rule);
    if (!healthy && landmarkRule)
      r = { state: 'UNKNOWN', value: null, threshold: r.threshold, confidence: 0 };
    out.push({
      tNs: frame.tNs,
      ruleId: makeRuleId(rule, quality.ruleVersion),
      state: r.state,
      value: r.value,
      threshold: r.threshold,
      confidence: r.confidence,
      configVersion: test.configVersion,
      ...(r.hint ? { hint: r.hint } : {}),
    });
  }
  return out;
}
