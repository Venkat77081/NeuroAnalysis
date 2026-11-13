/**
 * Capture verdict from recording facts (DEV_PLAN §9.5). M3 covers what the recording itself tells
 * us; landmark, sharpness and event checks join in M5–M7. Pure and deterministic.
 */
export interface TakeFacts {
  durationS: number;
  requestedDurationS: number;
  stoppedEarly: boolean;
  effectiveFps: number;
  droppedFrac: number;
  /** Native recording error, if any. */
  error?: string | null;
}

export interface VerdictConfig {
  durationToleranceS: number;
  minEffectiveFps: number;
  /** null = measured, not enforced (decision 007). */
  maxDroppedFrac: number | null;
}

export type VerdictReasonCode =
  'recording_error' | 'stopped_early' | 'duration_short' | 'fps_low' | 'dropped_high';

export interface VerdictReason {
  code: VerdictReasonCode;
  /** i18n key, e.g. "verdict.fps_low". */
  messageKey: string;
  params?: Record<string, string | number>;
}

export interface CaptureVerdict {
  verdict: 'PASS' | 'RETAKE';
  reasons: VerdictReason[];
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export function captureVerdict(f: TakeFacts, cfg: VerdictConfig): CaptureVerdict {
  const reasons: VerdictReason[] = [];
  const add = (code: VerdictReasonCode, params?: VerdictReason['params']) =>
    reasons.push({ code, messageKey: `verdict.${code}`, ...(params ? { params } : {}) });
  if (f.error) add('recording_error');
  if (f.stoppedEarly) {
    add('stopped_early', { durationS: r1(f.durationS), targetS: f.requestedDurationS });
  } else if (f.durationS < f.requestedDurationS - cfg.durationToleranceS) {
    add('duration_short', { durationS: r1(f.durationS), targetS: f.requestedDurationS });
  }
  if (f.effectiveFps < cfg.minEffectiveFps)
    add('fps_low', { fps: r1(f.effectiveFps), min: cfg.minEffectiveFps });
  if (cfg.maxDroppedFrac !== null && f.droppedFrac > cfg.maxDroppedFrac) {
    add('dropped_high', { pct: r1(f.droppedFrac * 100), maxPct: r1(cfg.maxDroppedFrac * 100) });
  }
  return { verdict: reasons.length ? 'RETAKE' : 'PASS', reasons };
}
