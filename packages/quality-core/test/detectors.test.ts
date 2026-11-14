/**
 * M6 acceptance on the synthetic fixture library (15 takes per test: 5 variants × 3 seeds):
 * DEV_PLAN §9.4 targets, no-motion detection on "movement stops halfway", protocol completion.
 * The real recorded library (≥ 15 labelled takes per test) replaces these when available.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TestConfig } from '@neurocapture/contracts-ts';
import {
  OneEuroFilter,
  findPeaks,
  motionWindows,
  oneEuro,
  rollingRange,
  runDetector,
  savitzkyGolay,
  speed,
  syntheticTake,
  type DetectorEvent,
  type DetectorParams,
  type TakeVariant,
  type TruthEvent,
} from '../src/index.ts';

const root = resolve(import.meta.dirname, '../../..');
const read = (c: string) =>
  JSON.parse(readFileSync(resolve(root, `config/tests/${c}.json`), 'utf8')) as TestConfig;
const VARIANTS: TakeVariant[] = ['normal', 'slow', 'fast', 'interrupted', 'wrong'];
const SEEDS = [1, 2, 3];
const TOL_S = 0.25;
/** Events that count for each test (SAW: stand-up and turns are the phase boundaries). */
const COUNTED: Record<string, string[]> = {
  FT: ['tap'],
  FR: ['roll'],
  FTF: ['touch'],
  SAW: ['stand_up', 'turn'],
  FA: ['brow', 'smile'],
};

function match(det: DetectorEvent[], truth: TruthEvent[]) {
  const used = new Set<number>();
  let tp = 0;
  const errors: number[] = [];
  for (const g of truth) {
    let best = -1;
    let bestDt = Infinity;
    det.forEach((d, i) => {
      if (used.has(i) || d.kind !== g.kind || d.side !== g.side) return;
      const dt = Math.abs(d.tS - g.tS);
      if (dt <= TOL_S && dt < bestDt) {
        best = i;
        bestDt = dt;
      }
    });
    if (best >= 0) {
      used.add(best);
      tp++;
      errors.push(bestDt);
    }
  }
  return { tp, fp: det.length - tp, fn: truth.length - tp, errors };
}

for (const code of ['FT', 'FTF', 'FR', 'SAW', 'FA']) {
  const test = read(code);
  const params = test.task.detectorParams as unknown as DetectorParams;
  describe(`${code} detector (${test.task.detector})`, () => {
    const runs = VARIANTS.flatMap((variant) =>
      SEEDS.map((seed) => {
        const take = syntheticTake(test, variant, { seed });
        const res = runDetector(
          test.task.detector,
          take.frames,
          take.t0Ns,
          params,
          test.task.noMotionTimeoutS,
          take.durationS,
        );
        const kinds = COUNTED[code]!;
        const det = res.events.filter((e) => kinds.includes(e.kind));
        const truth = take.truth.events.filter((e) => kinds.includes(e.kind));
        return { variant, seed, take, res, det, truth, m: match(det, truth) };
      }),
    );

    it('has at least 15 fixtures', () => expect(runs.length).toBeGreaterThanOrEqual(15));

    it('counts exactly or ±1 on ≥ 90 % of fixtures; mean absolute count error ≤ 0.5', () => {
      const errs = runs.map((r) => Math.abs(r.det.length - r.truth.length));
      expect(errs.filter((e) => e <= 1).length / runs.length).toBeGreaterThanOrEqual(0.9);
      expect(errs.reduce((a, b) => a + b, 0) / runs.length).toBeLessThanOrEqual(0.5);
    });

    it('event precision and recall ≥ 0.90', () => {
      const tp = runs.reduce((a, r) => a + r.m.tp, 0);
      const fp = runs.reduce((a, r) => a + r.m.fp, 0);
      const fn = runs.reduce((a, r) => a + r.m.fn, 0);
      expect(tp / Math.max(1, tp + fp)).toBeGreaterThanOrEqual(0.9);
      expect(tp / Math.max(1, tp + fn)).toBeGreaterThanOrEqual(0.9);
    });

    it('detects "movement stops halfway" in ≥ 95 % and no stop in normal takes', () => {
      const stops = runs.filter((r) => r.take.truth.stops);
      expect(
        stops.filter((r) => r.res.noMotion.length > 0).length / stops.length,
      ).toBeGreaterThanOrEqual(0.95);
      for (const r of runs.filter((x) => ['normal', 'slow', 'fast'].includes(x.variant)))
        expect(r.res.noMotion, `${r.variant} seed ${r.seed}`).toEqual([]);
    });

    it('tells a complete protocol from a wrong one', () => {
      for (const r of runs.filter((x) => x.variant !== 'interrupted'))
        expect(r.res.complete, `${r.variant} seed ${r.seed}`).toBe(r.take.truth.complete);
    });

    if (code === 'SAW')
      it('phase-boundary error ≤ 0.3 s (median)', () => {
        const errs = runs.flatMap((r) => r.m.errors).sort((a, b) => a - b);
        expect(errs[Math.floor(errs.length / 2)]!).toBeLessThanOrEqual(0.3);
      });
  });
}

describe('signal helpers', () => {
  it('One-Euro smooths noise and follows steps', () => {
    const f = new OneEuroFilter(1, 0.5);
    expect(f.filter(1, 0)).toBe(1);
    expect(f.filter(5, 0)).toBe(5); // non-increasing time resets
    const t = Array.from({ length: 60 }, (_, i) => i / 30);
    const out = oneEuro(
      t.map((x) => (x > 1 ? 1 : 0)),
      t,
      1,
      0.5,
    );
    expect(out.at(-1)!).toBeGreaterThan(0.8);
  });
  it('Savitzky–Golay keeps a parabola and the edges', () => {
    const v = Array.from({ length: 9 }, (_, i) => i * i);
    expect(savitzkyGolay(v, 2).map((x) => Math.round(x * 1000) / 1000)).toEqual(v);
  });
  it('finds prominent peaks with a minimum distance', () => {
    const t = [0, 1, 2, 3, 4, 5, 6];
    const v = [0, 5, 0, 4.5, 0, 1, 0];
    expect(findPeaks(v, t, { minProminence: 2, minDistanceS: 0 }).map((p) => p.tS)).toEqual([1, 3]);
    expect(findPeaks(v, t, { minProminence: 2, minDistanceS: 2.5 }).map((p) => p.tS)).toEqual([1]);
  });
  it('motion windows, speed and rolling range', () => {
    const t = [0, 1, 2, 3, 4, 5, 6, 7];
    const s = [1, 1, 0, 0, 0, NaN, 0, 1];
    const w = motionWindows(t, s, 0.5, 3, 7);
    expect(w.movementWindow).toEqual({ tStartS: 0, tEndS: 7 });
    expect(w.noMotion).toEqual([{ tStartS: 2, tEndS: 7 }]);
    expect(motionWindows([0, 1], [0, 0], 0.5, 1, 3).movementWindow).toBeNull();
    expect(speed([0, 2, 2], [0, 1, 1])).toEqual([NaN, 2, NaN]);
    expect(rollingRange([0, 3, 1, 1], [0, 1, 2, 3], 1.5)).toEqual([0, 3, 2, 0]);
  });
});
