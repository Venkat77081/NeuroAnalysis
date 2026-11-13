import { describe, expect, it } from 'vitest';
import { captureVerdict, type TakeFacts } from '../src/index.ts';

const cfg = { durationToleranceS: 0.1, minEffectiveFps: 29.5, maxDroppedFrac: null };
const ok: TakeFacts = {
  durationS: 15.01,
  requestedDurationS: 15,
  stoppedEarly: false,
  effectiveFps: 59.26,
  droppedFrac: 0.001,
};

describe('captureVerdict', () => {
  it('passes a complete take', () => {
    expect(captureVerdict(ok, cfg)).toEqual({ verdict: 'PASS', reasons: [] });
  });

  it('retakes a take stopped early, with its length', () => {
    const v = captureVerdict({ ...ok, stoppedEarly: true, durationS: 6.43 }, cfg);
    expect(v.verdict).toBe('RETAKE');
    expect(v.reasons).toEqual([
      {
        code: 'stopped_early',
        messageKey: 'verdict.stopped_early',
        params: { durationS: 6.4, targetS: 15 },
      },
    ]);
  });

  it('retakes a short take, low fps, errors, and drops only when enforced', () => {
    const v = captureVerdict(
      { ...ok, durationS: 14.8, effectiveFps: 24.04, error: 'camera error', droppedFrac: 0.2 },
      cfg,
    );
    expect(v.reasons.map((r) => r.code)).toEqual(['recording_error', 'duration_short', 'fps_low']);
    expect(v.reasons[2]!.params).toEqual({ fps: 24, min: 29.5 });
    const strict = captureVerdict({ ...ok, droppedFrac: 0.012 }, { ...cfg, maxDroppedFrac: 0.01 });
    expect(strict.reasons).toEqual([
      { code: 'dropped_high', messageKey: 'verdict.dropped_high', params: { pct: 1.2, maxPct: 1 } },
    ]);
  });

  it('accepts a duration within tolerance', () => {
    expect(captureVerdict({ ...ok, durationS: 14.91 }, cfg).verdict).toBe('PASS');
  });
});
