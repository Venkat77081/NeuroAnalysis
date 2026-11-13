import type { RecordingResult } from '@neurocapture/capture-kit';

/** M2 acceptance criteria per take (DEV_PLAN §16 M2, interim fps policy decision 007). */
export interface TakeChecks {
  duration: boolean; // |error| ≤ 50 ms
  fps: boolean; // effective fps ≥ config minEffectiveFps
  frameCount: boolean; // |frames in video span − MP4 samples| ≤ 1
  timestamps: boolean; // mapped MP4 times within 2 ms of canonical
  encrypted: boolean; // stored encrypted, plaintext gone, encrypted file does not play
}

export const M2_LIMITS = { durationErrorMs: 50, frameCountDiff: 1, timestampMs: 2 } as const;

export function checkTake(r: RecordingResult, minEffectiveFps: number): TakeChecks {
  return {
    duration: !r.stoppedEarly && Math.abs(r.durationErrorMs) <= M2_LIMITS.durationErrorMs,
    fps: r.effectiveFps >= minEffectiveFps,
    frameCount:
      r.mp4 !== null &&
      r.framesInVideoSpan !== null &&
      Math.abs(r.framesInVideoSpan - r.mp4.sampleCount) <= M2_LIMITS.frameCountDiff,
    timestamps: r.mp4 !== null && r.mp4.maxAbsDiffMs <= M2_LIMITS.timestampMs,
    encrypted: r.encrypted && r.encryptedNotPlayable === true,
  };
}

export function allPass(c: TakeChecks): boolean {
  return c.duration && c.fps && c.frameCount && c.timestamps && c.encrypted;
}

export interface M2Summary {
  takes: number;
  passed: number;
  maxAbsDurationErrorMs: number;
  minEffectiveFps: number;
  maxTimestampDiffMs: number;
  maxDroppedFrac: number;
  ambiguousAnchors: number;
}

export function summarize(results: RecordingResult[], minEffectiveFps: number): M2Summary {
  return {
    takes: results.length,
    passed: results.filter((r) => allPass(checkTake(r, minEffectiveFps))).length,
    maxAbsDurationErrorMs: Math.max(0, ...results.map((r) => Math.abs(r.durationErrorMs))),
    minEffectiveFps: results.length ? Math.min(...results.map((r) => r.effectiveFps)) : 0,
    maxTimestampDiffMs: Math.max(0, ...results.map((r) => r.mp4?.maxAbsDiffMs ?? Infinity)),
    maxDroppedFrac: Math.max(0, ...results.map((r) => r.droppedFrac)),
    ambiguousAnchors: results.filter((r) => r.mp4?.anchor === 'earliest_candidate').length,
  };
}
