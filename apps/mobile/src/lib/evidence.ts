import type {
  DeviceCapabilities,
  Implementation,
  RecordingResult,
} from '@neurocapture/capture-kit';
import type { QualityReport, TakeMeta, TestConfig } from '@neurocapture/contracts-ts';
import { QUALITY_CORE_VERSION } from '@neurocapture/quality-core';
import type { SessionContext } from '../session/machine.ts';
import type { FinishedTake } from './take-analysis.ts';

export const APP_VERSION = '0.3.0';

/** meta.json for a take (contracts/meta.schema.json). No patient identifiers. */
export function buildMeta(args: {
  ctx: SessionContext;
  cfg: TestConfig;
  sessionConfigVersion: string;
  result: RecordingResult;
  takeNo: number;
  caps: DeviceCapabilities | null;
  implementation: Implementation;
  tier: TakeMeta['tier'];
  createdAt: string;
  /** Orientation the operator chose (camera.allowedOrientations); defaults to the config's. */
  orientation?: 'portrait' | 'landscape';
  /** Frame-rate limit used for the verdict (doctor's setting or config). */
  minEffectiveFps?: number;
}): TakeMeta {
  const { ctx, cfg, result, caps } = args;
  const step = ctx.plan[ctx.index]!;
  const cam = caps?.cameras.find((c) => c.facing === cfg.camera.facing);
  return {
    schemaVersion: '1.0.0',
    takeId: result.takeId,
    sessionId: ctx.sessionId,
    testCode: step.code,
    side: step.side,
    take: args.takeNo,
    configVersion: cfg.configVersion,
    sessionConfigVersion: args.sessionConfigVersion,
    appVersion: APP_VERSION,
    pluginVersion: caps?.pluginVersion ?? '0.0.0',
    qualityCoreVersion: QUALITY_CORE_VERSION,
    implementation: args.implementation,
    device: caps
      ? {
          manufacturer: caps.device.manufacturer,
          model: caps.device.model,
          osName: caps.device.osName,
          osVersion: caps.device.osVersion,
        }
      : { manufacturer: 'unknown', model: 'unknown', osName: 'web', osVersion: 'unknown' },
    tier: args.implementation === 'native' ? args.tier : 'W',
    capabilities: (caps ?? {}) as Record<string, unknown>,
    timestamp: {
      source: cam?.timestampSource ?? 'SIMULATED',
      offsetNs: null,
      offsetSpreadMs: null,
    },
    camera: {
      facing: cfg.camera.facing,
      resolution: cfg.camera.resolution,
      targetFps: result.actualFps,
      orientation: args.orientation ?? cfg.camera.orientation,
      minEffectiveFps: args.minEffectiveFps ?? cfg.camera.minEffectiveFps,
    },
    medState: ctx.medState ?? 'NA',
    operatorId: ctx.operatorId,
    createdAt: args.createdAt,
  };
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const win = (w: { tStartS: number; tEndS: number }) => ({
  tStartS: r3(w.tStartS),
  tEndS: r3(w.tEndS),
});

/** SAW detector events → quality.json phase names (contracts/quality.schema.json). */
const PHASES: Record<string, NonNullable<QualityReport['phasesDetected']>[number]> = {
  stand_up: 'standing',
  walk_out: 'walk_out',
  turn: 'turn',
  walk_back: 'walk_back',
  sit_down: 'seated_end',
};

/**
 * quality.json for a take (DEV_PLAN §12.3): capture facts, the detector's movement evidence,
 * in-recording events and the verdict. No patient identifiers; no biomarker values.
 */
export function buildQuality(args: {
  ctx: SessionContext;
  cfg: TestConfig;
  result: RecordingResult;
  takeNo: number;
  implementation: Implementation;
  tier: TakeMeta['tier'];
  take: FinishedTake;
  sharpnessBaseline: number | null;
}): QualityReport {
  const { ctx, cfg, result, take } = args;
  const step = ctx.plan[ctx.index]!;
  const a = take.analysis;
  const phases =
    take.detector.detector === 'saw_phases'
      ? [
          'seated' as const,
          ...[
            ...new Set(
              take.detector.events.map((e) => PHASES[e.kind]).filter((p) => p !== undefined),
            ),
          ],
        ]
      : undefined;
  return {
    schemaVersion: '1.0.0',
    configVersion: cfg.configVersion,
    qualityCoreVersion: QUALITY_CORE_VERSION,
    testCode: step.code,
    side: step.side,
    take: args.takeNo,
    tier: args.implementation === 'native' ? (args.tier ?? 'C') : 'W',
    durationTargetS: cfg.task.durationS,
    durationS: r3(result.durationS),
    stoppedEarly: result.stoppedEarly,
    fpsTarget: cfg.camera.targetFps as 60 | 30,
    fpsEffective: r3(result.effectiveFps),
    droppedFrames: result.droppedFrames,
    droppedFrac: r3(result.droppedFrac),
    eventsDetected: take.detector.events.length,
    ...(phases ? { phasesDetected: phases } : {}),
    landmarkVisibleFrac: r3(a.landmarkVisibleFrac),
    sharpnessMedian: a.sharpnessMedian === null ? null : r3(a.sharpnessMedian),
    sharpnessBaseline: args.sharpnessBaseline,
    brightnessMedian: a.brightnessMedian === null ? null : r3(a.brightnessMedian),
    movementWindow: a.movementWindow ? win(a.movementWindow) : null,
    events: take.events.map((e) => ({ ...win(e), ruleId: e.ruleId, severity: e.severity })),
    unknownWindows: take.unknownWindows.map(win),
    captureVerdict: take.verdict.verdict,
    captureReasons: take.verdict.reasons.map((r) => ({
      code: r.code,
      messageKey: r.messageKey,
      ...(r.params ? { params: r.params } : {}),
    })),
    override: null,
    flaggedForReview: false,
    biomarkerReadinessHint: { registryVersion: 'REG@0.1.0' },
  } as QualityReport;
}
