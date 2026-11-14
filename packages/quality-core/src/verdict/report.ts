/**
 * The quality.json fields that come from evaluating a take (DEV_PLAN §12.3). Shared by the app
 * (buildQuality) and tools/replay, so both write the same values for the same evidence.
 */
import type { QualityReport } from '@neurocapture/contracts-ts';
import type { RecordedTakeEvaluation } from './recorded.ts';

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const win = (w: { tStartS: number; tEndS: number }) => ({
  tStartS: r3(w.tStartS),
  tEndS: r3(w.tEndS),
});

/** SAW detector events → quality.json phase names. */
const PHASES: Record<string, NonNullable<QualityReport['phasesDetected']>[number]> = {
  stand_up: 'standing',
  walk_out: 'walk_out',
  turn: 'turn',
  walk_back: 'walk_back',
  sit_down: 'seated_end',
};

export type EvaluationFields = Pick<
  QualityReport,
  | 'eventsDetected'
  | 'phasesDetected'
  | 'landmarkVisibleFrac'
  | 'sharpnessMedian'
  | 'brightnessMedian'
  | 'movementWindow'
  | 'events'
  | 'unknownWindows'
  | 'captureVerdict'
  | 'captureReasons'
  | 'biomarkerReadinessHint'
>;

export function evaluationFields(take: RecordedTakeEvaluation): EvaluationFields {
  const a = take.analysis;
  const phases =
    take.detector.detector === 'saw_phases'
      ? [
          'seated' as const,
          ...new Set(
            take.detector.events
              .map((e) => PHASES[e.kind])
              .filter((p): p is NonNullable<typeof p> => p !== undefined),
          ),
        ]
      : undefined;
  return {
    eventsDetected: take.detector.events.length,
    ...(phases ? { phasesDetected: phases } : {}),
    landmarkVisibleFrac: r3(a.landmarkVisibleFrac),
    sharpnessMedian: a.sharpnessMedian === null ? null : r3(a.sharpnessMedian),
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
    biomarkerReadinessHint: take.readiness
      ? { registryVersion: take.readiness.registryVersion, ...take.readiness.items }
      : { registryVersion: 'REG@0.0.0' },
  } as EvaluationFields;
}
