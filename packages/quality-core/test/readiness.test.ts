/**
 * M8: biomarker readiness and the recorded-take evaluation shared by the app and tools/replay.
 * Synthetic takes stand in for the recorded library until it exists.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BiomarkerRegistry, QualityConfig, TestConfig } from '@neurocapture/contracts-ts';
import {
  QUALITY_RULES_FOR,
  RETAKE_FIXABLE,
  evaluateRecordedTake,
  landmarkVisibleFrac,
  readinessHint,
  readinessRetakeReasons,
  syntheticTake,
  type LandmarkFrame,
  type ReadinessEvidence,
  type TakeVariant,
} from '../src/index.ts';

const root = resolve(import.meta.dirname, '../../..');
const read = <T>(p: string): T => JSON.parse(readFileSync(resolve(root, p), 'utf8')) as T;
const registry = read<BiomarkerRegistry>('config/biomarker-registry.json');
const quality = read<QualityConfig>('config/quality.json');
const test = (c: string) => read<TestConfig>(`config/tests/${c}.json`);
const CODES = ['FT', 'FTF', 'FR', 'SAW', 'FA'];

function evaluate(code: string, variant: TakeVariant, seed = 1, edit?: (f: LandmarkFrame) => void) {
  const cfg = test(code);
  const take = syntheticTake(cfg, variant, { seed, fps: 30 });
  if (edit) take.frames.forEach(edit);
  return evaluateRecordedTake({
    frames: take.frames,
    sensors: [],
    facts: {
      durationS: take.durationS,
      requestedDurationS: cfg.task.durationS,
      stoppedEarly: false,
      effectiveFps: 60,
      droppedFrac: 0,
    },
    firstSampleNs: take.t0Ns,
    test: cfg,
    quality,
    registry,
    side: null,
    orientation: cfg.camera.orientation as 'portrait' | 'landscape',
    sharpnessBaseline: null,
    hasSensors: false,
    minEffectiveFps: cfg.camera.minEffectiveFps ?? 59,
  });
}

describe('evaluateRecordedTake (M8)', () => {
  it.each(CODES)('%s normal take: PASS and every registered biomarker COMPUTABLE', (code) => {
    const r = evaluate(code, 'normal');
    expect(r.verdict.reasons).toEqual([]);
    expect(r.verdict.verdict).toBe('PASS');
    const ids = registry.biomarkers.filter((b) => b.testCode === code).map((b) => b.id);
    expect(Object.keys(r.readiness!.items).sort()).toEqual([...ids].sort());
    expect(Object.values(r.readiness!.items).every((i) => i.status === 'COMPUTABLE')).toBe(true);
  });

  it('is deterministic: the same evidence gives the same result', () => {
    expect(JSON.stringify(evaluate('FT', 'slow', 2))).toBe(
      JSON.stringify(evaluate('FT', 'slow', 2)),
    );
  });

  it('movement stopping halfway is a RETAKE', () => {
    const r = evaluate('FR', 'interrupted');
    expect(r.verdict.verdict).toBe('RETAKE');
    expect(r.verdict.reasons.map((x) => x.code)).toContain('no_motion');
  });

  it('SAW without the walk: phases missing → NOT_COMPUTABLE, retake-fixable, plain reason', () => {
    const r = evaluate('SAW', 'wrong');
    const item = r.readiness!.items.SAW1!;
    expect(item.status).toBe('NOT_COMPUTABLE');
    expect(item.missing).toContain('phases');
    expect(item.retakeFixable).toBe(true);
    expect(r.verdict.reasons.map((x) => x.code)).toContain('protocol_incomplete');
    // Readiness never names a biomarker in the operator's reasons.
    expect(JSON.stringify(r.verdict.reasons)).not.toMatch(/SAW[0-9]/);
  });

  it('FA with the mouth corners hidden: key points hidden → RETAKE', () => {
    const r = evaluate('FA', 'normal', 1, (f) => {
      if (f.face) f.face.pts[61] = { x: -0.2, y: 0.5, z: 0 };
    });
    expect(r.readiness!.items.FA1!.status).toBe('NOT_COMPUTABLE');
    expect(r.readiness!.items.FA1!.missing).toEqual(['landmarks']);
    expect(r.verdict.verdict).toBe('RETAKE');
    expect(r.verdict.reasons.map((x) => x.code)).toContain('key_points_hidden');
  });

  it('without a registry there is no hint', () => {
    const cfg = test('FT');
    const r = evaluateRecordedTake({
      frames: [],
      sensors: [],
      facts: {
        durationS: 15,
        requestedDurationS: 15,
        stoppedEarly: false,
        effectiveFps: 60,
        droppedFrac: 0,
      },
      firstSampleNs: null,
      test: cfg,
      quality,
      registry: null,
      side: null,
      orientation: 'landscape',
      sharpnessBaseline: null,
      hasSensors: false,
      minEffectiveFps: 59,
    });
    expect(r.readiness).toBeNull();
    expect(r.verdict.verdict).toBe('RETAKE'); // no frames: nothing moved, nothing visible
  });
});

describe('readinessHint (M8)', () => {
  const frames = syntheticTake(test('FT'), 'normal', { fps: 30 }).frames;
  const base: ReadinessEvidence = {
    effectiveFps: 60,
    durationS: 15,
    trackers: ['hand', 'pose'],
    frames,
    startNs: frames[0]!.tNs,
    movementWindow: null,
    phases: [],
    sensors: false,
    handsNeeded: 2,
    poseMinVisibility: 0.5,
    handMinScore: 0.5,
  };

  it('reports fps, duration and missing trackers with reasons; tracker gaps are not retake-fixable', () => {
    const h = readinessHint(registry, 'FT', { ...base, effectiveFps: 41.24, durationS: 9 });
    expect(h.registryVersion).toBe(registry.registryVersion);
    expect(h.items.FT1).toEqual({
      status: 'NOT_COMPUTABLE',
      reason: 'requires >= 58 fps; effective 41.2 fps; requires >= 14.9 s; recorded 9 s',
      retakeFixable: true,
      missing: ['fps', 'duration'],
    });
    const noPose = readinessHint(registry, 'FT', { ...base, trackers: ['hand'] });
    expect(noPose.items.FT1).toMatchObject({ status: 'NOT_COMPUTABLE', retakeFixable: false });
    expect(noPose.items.FT1!.missing).toEqual(['tracker']);
  });

  it('PARTIAL when key points are visible in at least half of the needed frames', () => {
    const half = frames.map((f, i) => (i % 3 === 0 ? { ...f, hands: [] } : f));
    expect(landmarkVisibleFrac(half, { hand: [0, 4, 8] }, base)).toBeCloseTo(2 / 3, 2);
    expect(readinessHint(registry, 'FT', { ...base, frames: half }).items.FT1!.status).toBe(
      'PARTIAL',
    );
    // Only frames inside the movement window count.
    const t = (i: number) => Number(frames[i]!.tNs - base.startNs) / 1e9;
    expect(
      landmarkVisibleFrac(
        half,
        { hand: [0] },
        { ...base, movementWindow: { tStartS: t(1), tEndS: t(2) } },
      ),
    ).toBe(1);
    expect(landmarkVisibleFrac([], { pose: [11] }, base)).toBe(0);
  });

  it('sensors requirement and the retake-reason mapping', () => {
    const reg: BiomarkerRegistry = {
      ...registry,
      biomarkers: [
        {
          id: 'FT99',
          testCode: 'FT',
          family: 'x',
          formula: null,
          formulaVersion: null,
          inputs: { requiresSensors: true },
        },
      ],
    };
    expect(readinessHint(reg, 'FT', base).items.FT99).toMatchObject({
      status: 'NOT_COMPUTABLE',
      retakeFixable: false,
      missing: ['sensors'],
    });
    const hint = {
      registryVersion: 'REG@0.1.0',
      items: {
        FT1: {
          status: 'NOT_COMPUTABLE' as const,
          retakeFixable: true,
          missing: ['duration' as const, 'fps' as const],
        },
        FT2: { status: 'PARTIAL' as const, retakeFixable: true, missing: ['landmarks' as const] },
      },
    };
    expect(readinessRetakeReasons(hint, []).map((r) => r.code)).toEqual(['duration_short']);
    expect(readinessRetakeReasons(hint, [{ code: 'stopped_early', messageKey: 'x' }])).toEqual([]);
    expect(RETAKE_FIXABLE).not.toContain('tracker');
    expect(QUALITY_RULES_FOR.landmarks).toContain('required_landmarks_visible');
  });
});
