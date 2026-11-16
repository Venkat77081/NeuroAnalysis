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

describe('M6: severity log, take analysis and the extended verdict', () => {
  it('logs WARN/CRITICAL intervals per rule and tracking windows', async () => {
    const { SeverityLog } = await import('../src/index.ts');
    const log = new SeverityLog('1.0.0');
    log.update(0, [], false);
    log.update(
      1,
      [
        { rule: 'shake', severity: 'WARN' },
        { rule: 'tilt', severity: 'INFO' },
      ],
      true,
    );
    log.update(2, [{ rule: 'shake', severity: 'CRITICAL' }], false);
    log.update(3, [], true);
    const out = log.finish(5);
    expect(out.events).toEqual([
      { tStartS: 1, tEndS: 3, ruleId: 'shake@1.0.0', severity: 'CRITICAL' },
    ]);
    expect(out.unknownWindows).toEqual([
      { tStartS: 1, tEndS: 2 },
      { tStartS: 3, tEndS: 5 },
    ]);
    const open = new SeverityLog('1.0.0');
    open.update(1, [{ rule: 'tilt', severity: 'WARN' }], false);
    expect(open.finish(4).events[0]).toMatchObject({ tStartS: 1, tEndS: 4 });
  });

  it('turns analysis facts into plain RETAKE reasons', async () => {
    const { captureVerdict } = await import('../src/index.ts');
    const facts = {
      durationS: 15,
      requestedDurationS: 15,
      stoppedEarly: false,
      effectiveFps: 60,
      droppedFrac: 0,
    };
    const cfg = { durationToleranceS: 0.1, minEffectiveFps: 59, maxDroppedFrac: null };
    const good = {
      landmarkVisibleFrac: 0.99,
      sharpnessMedian: 100,
      brightnessMedian: 120,
      complete: true,
      noMotion: [],
      movementWindow: { tStartS: 1, tEndS: 15 },
      criticalEvents: 0,
      longUnknown: [],
    };
    const lim = { minLandmarkVisibleFrac: 0.95, maxCriticalEvents: 0, minSharpness: 60 };
    expect(captureVerdict(facts, cfg, { analysis: good, ...lim }).verdict).toBe('PASS');
    const bad = {
      ...good,
      landmarkVisibleFrac: 0.5,
      sharpnessMedian: 10,
      complete: false,
      noMotion: [{ tStartS: 8, tEndS: 15 }],
      criticalEvents: 1,
      longUnknown: [{ tStartS: 3, tEndS: 6 }],
    };
    const v = captureVerdict(facts, cfg, { analysis: bad, ...lim });
    expect(v.verdict).toBe('RETAKE');
    expect(v.reasons.map((r) => r.code)).toEqual([
      'no_motion',
      'protocol_incomplete',
      'landmarks_low',
      'critical_events',
      'tracking_lost',
      'sharpness_low',
    ]);
    expect(v.reasons[0]!.params).toEqual({ s: 7, from: 8, to: 15 });
    expect(
      captureVerdict(facts, cfg, { analysis: bad, ...lim, minSharpness: null }).reasons.map(
        (r) => r.code,
      ),
    ).not.toContain('sharpness_low');
  });

  it('analyses a synthetic take end to end', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const { analyseTake, runDetector, syntheticTake } = await import('../src/index.ts');
    const root = resolve(import.meta.dirname, '../../..');
    const test = JSON.parse(readFileSync(resolve(root, 'config/tests/FT.json'), 'utf8'));
    const quality = JSON.parse(readFileSync(resolve(root, 'config/quality.json'), 'utf8'));
    const take = syntheticTake(test, 'interrupted');
    const det = runDetector(
      test.task.detector,
      take.frames,
      take.t0Ns,
      test.task.detectorParams,
      test.task.noMotionTimeoutS,
      take.durationS,
    );
    const a = analyseTake({
      frames: take.frames,
      test,
      quality,
      detector: det,
      events: [],
      unknownWindows: [
        { tStartS: 2, tEndS: 5 },
        { tStartS: 0, tEndS: 1 },
      ],
    });
    expect(a.landmarkVisibleFrac).toBe(1);
    expect(a.noMotion.length).toBe(1);
    expect(a.longUnknown).toEqual([{ tStartS: 2, tEndS: 5 }]);
    expect(a.sharpnessMedian).toBe(100);
    expect(
      analyseTake({ frames: [], test, quality, detector: det, events: [], unknownWindows: [] })
        .landmarkVisibleFrac,
    ).toBe(0);
  });
});
