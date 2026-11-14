/**
 * M5 acceptance (DEV_PLAN §16 M5), run on synthetic frames for every test, orientation and QA
 * scenario: each failure gives the correct single prompt within 1.0 s and Record stays disabled;
 * a correct setup enables Record within 2.0 s; a tracker error shows "tracking…", not a prompt.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { QualityConfig, TestConfig } from '@neurocapture/contracts-ts';
import {
  AnalysisHealth,
  GuidanceEngine,
  SYNTHETIC_SHARPNESS_BASELINE,
  SensorBuffer,
  evaluateFrame,
  gateRules,
  scenariosFor,
  syntheticFrame,
  type CheckContext,
  type ScenarioName,
} from '../src/index.ts';

const root = resolve(import.meta.dirname, '../../..');
const read = <T>(p: string): T => JSON.parse(readFileSync(resolve(root, p), 'utf8')) as T;
const quality = read<QualityConfig>('config/quality.json');
const codes = ['FT', 'FTF', 'FR', 'SAW', 'FA'] as const;

export function simulate(ctx: CheckContext, scenario: ScenarioName, seconds: number, fps = 30) {
  const engine = new GuidanceEngine(gateRules(ctx), ctx.quality);
  const sensors = new SensorBuffer();
  const health = new AnalysisHealth();
  const timeline = [];
  for (let i = 0; i < seconds * fps; i++) {
    const tNs = BigInt(Math.round((i * 1e9) / fps));
    const { frame, sensors: s } = syntheticFrame(ctx.test, scenario, {
      seq: i,
      tNs,
      orientation: ctx.orientation,
      side: ctx.side,
    });
    sensors.push(s);
    health.push(tNs, 20);
    engine.push(evaluateFrame(frame, sensors, ctx, health));
    timeline.push({ tS: i / fps, state: engine.update(tNs) });
  }
  return timeline;
}

for (const code of codes) {
  const test = read<TestConfig>(`config/tests/${code}.json`);
  const orientations = test.camera.allowedOrientations ?? [test.camera.orientation];
  for (const orientation of orientations) {
    const ctx: CheckContext = {
      test,
      quality,
      side: null,
      orientation,
      sharpnessBaseline: SYNTHETIC_SHARPNESS_BASELINE,
      sensors: true,
    };
    describe(`${code} (${orientation})`, () => {
      for (const sc of scenariosFor(test, { sharpness: true, sensors: true })) {
        it(`${sc.name} → ${sc.expect ?? 'Record enabled'}`, () => {
          const tl = simulate(ctx, sc.name, 3);
          if (sc.expect === null) {
            const opened = tl.find((x) => x.state.gateOpen);
            expect(opened, 'gate opened').toBeDefined();
            expect(opened!.tS).toBeLessThanOrEqual(2.0);
            expect(tl.filter((x) => x.tS > opened!.tS).every((x) => x.state.gateOpen)).toBe(true);
            expect(tl.every((x) => x.state.prompt === null)).toBe(true);
            return;
          }
          expect(
            tl.some((x) => x.state.gateOpen),
            'Record stays disabled',
          ).toBe(false);
          if (sc.expect === 'tracking') {
            expect(tl.every((x) => x.state.prompt === null)).toBe(true);
            expect(tl.filter((x) => x.tS >= 0.2).every((x) => x.state.tracking)).toBe(true);
            return;
          }
          const first = tl.find((x) => x.state.prompt !== null);
          expect(first, 'a prompt appears').toBeDefined();
          expect(first!.tS).toBeLessThanOrEqual(1.0);
          // Single, correct prompt from then on.
          const keys = new Set(tl.filter((x) => x.tS >= first!.tS).map((x) => x.state.prompt?.key));
          expect([...keys]).toEqual([sc.expect]);
        });
      }
    });
  }
}

describe('variant protocol (sided FT): wrong hand', () => {
  it('prompts "wrong_hand" within 1.0 s', () => {
    const test = read<TestConfig>('config/tests/FT.json');
    test.sides = ['R', 'L'];
    test.framing.handednessMustMatchSide = true;
    test.framing.bothHandsRequired = false;
    const ctx: CheckContext = {
      test,
      quality,
      side: 'R',
      orientation: 'landscape',
      sharpnessBaseline: null,
      sensors: false,
    };
    const good = simulate(ctx, 'good', 3);
    expect(good.find((x) => x.state.gateOpen)!.tS).toBeLessThanOrEqual(2);
    const tl = simulate(ctx, 'wrong_hand', 3);
    const first = tl.find((x) => x.state.prompt)!;
    expect(first.tS).toBeLessThanOrEqual(1);
    expect(first.state.prompt!.key).toBe('wrong_hand');
    expect(tl.some((x) => x.state.gateOpen)).toBe(false);
  });
});

describe('performance', () => {
  it('evaluates a frame and updates the engine in ≤ 5 ms p95 (Node; WebView measured on device)', () => {
    const test = read<TestConfig>('config/tests/FA.json'); // heaviest: 478 face points
    const ctx: CheckContext = {
      test,
      quality,
      side: null,
      orientation: 'portrait',
      sharpnessBaseline: 100,
      sensors: true,
    };
    const engine = new GuidanceEngine(gateRules(ctx), quality);
    const sensors = new SensorBuffer();
    const times: number[] = [];
    for (let i = 0; i < 600; i++) {
      const tNs = BigInt(i) * 33_333_333n;
      const { frame, sensors: s } = syntheticFrame(test, 'good', {
        seq: i,
        tNs,
        orientation: 'portrait',
      });
      const t0 = performance.now();
      sensors.push(s);
      engine.push(evaluateFrame(frame, sensors, ctx));
      engine.update(tNs);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.ceil(0.95 * times.length) - 1]).toBeLessThanOrEqual(5);
  });
});
