import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { QualityConfig, TestConfig } from '@neurocapture/contracts-ts';
import {
  AnalysisHealth,
  GuidanceEngine,
  SensorBuffer,
  evaluateFrame,
  fallbackKey,
  gateRules,
  lowFpsCritical,
  makeRuleId,
  syntheticFrame,
  type CheckSample,
  type CheckState,
  type RuleName,
} from '../src/index.ts';

const root = resolve(import.meta.dirname, '../../..');
const read = <T>(p: string): T => JSON.parse(readFileSync(resolve(root, p), 'utf8')) as T;
const quality = read<QualityConfig>('config/quality.json');
const ms = (n: number) => BigInt(Math.round(n * 1e6));

function sample(
  rule: RuleName,
  tMs: number,
  state: CheckState,
  hint?: CheckSample['hint'],
): CheckSample {
  return {
    tNs: ms(tMs),
    ruleId: makeRuleId(rule, '1.0.0'),
    state,
    value: null,
    threshold: null,
    confidence: 1,
    configVersion: 'T@1.0.0',
    ...(hint ? { hint } : {}),
  };
}

/** Feed one sample per 33 ms from `from` to `to` (ms), return the last state. */
function feed(
  e: GuidanceEngine,
  rules: RuleName[],
  from: number,
  to: number,
  state: (r: RuleName) => CheckState,
  hint?: CheckSample['hint'],
) {
  let st = e.update(ms(from));
  for (let t = from; t <= to; t += 33) {
    e.push(rules.map((r) => sample(r, t, state(r), hint)));
    st = e.update(ms(t));
  }
  return st;
}

describe('GuidanceEngine', () => {
  const rules: RuleName[] = ['subject_present', 'brightness'];

  it('is UNKNOWN until it has samples, opens the gate after gateHoldS of OK', () => {
    const e = new GuidanceEngine(rules, quality);
    expect(e.update(0n)).toMatchObject({ gateOpen: false, tracking: true, prompt: null });
    const st = feed(e, rules, 0, 900, () => 'OK');
    expect(st.gateOpen).toBe(false);
    expect(st.gateProgress).toBeGreaterThan(0.8);
    const open = feed(e, rules, 933, 1200, () => 'OK');
    expect(open.gateOpen).toBe(true);
    expect(open.gateProgress).toBe(1);
  });

  it('reports gateJustOpened once and applies hysteresis', () => {
    const e = new GuidanceEngine(rules, quality);
    let opened = 0;
    for (let t = 0; t <= 2000; t += 33) {
      e.push(rules.map((r) => sample(r, t, 'OK')));
      if (e.update(ms(t)).gateJustOpened) opened++;
    }
    expect(opened).toBe(1);
    // 40 % bad: stays OK (enter WARN only above 60 %).
    let st = e.update(ms(2000));
    for (let t = 2033; t <= 3000; t += 33) {
      e.push([
        sample('brightness', t, t % 5 < 2 ? 'FAIL' : 'OK', 'too_dark'),
        sample('subject_present', t, 'OK'),
      ]);
      st = e.update(ms(t));
    }
    expect(st.rules.find((r) => r.rule === 'brightness')!.state).toBe('OK');
    // All bad → WARN with the sample's hint; then 40 % bad keeps WARN (exit only below 20 %).
    st = feed(e, ['brightness'], 3033, 3800, () => 'FAIL', 'too_dark');
    expect(st.prompt).toEqual({ rule: 'brightness', key: 'too_dark' });
    expect(st.gateOpen).toBe(false);
    for (let t = 3833; t <= 4600; t += 33) {
      e.push([
        sample('brightness', t, t % 5 < 2 ? 'FAIL' : 'OK', 'too_dark'),
        sample('subject_present', t, 'OK'),
      ]);
      st = e.update(ms(t));
    }
    expect(st.rules.find((r) => r.rule === 'brightness')!.state).toBe('WARN');
  });

  it('shows "tracking" for mostly-UNKNOWN windows and never prompts for them', () => {
    const e = new GuidanceEngine(rules, quality);
    const st = feed(e, rules, 0, 1000, (r) => (r === 'subject_present' ? 'UNKNOWN' : 'OK'));
    expect(st.tracking).toBe(true);
    expect(st.prompt).toBeNull();
    expect(e.severities(ms(1000))).toContainEqual({ rule: 'subject_present', severity: 'INFO' });
  });

  it('prompts only the highest-priority failing rule, with a fallback key when no hint', () => {
    const e = new GuidanceEngine(['brightness', 'subject_present', 'analysis_health'], quality);
    const st = feed(e, ['brightness', 'subject_present'], 0, 800, () => 'FAIL');
    expect(st.prompt).toEqual({ rule: 'subject_present', key: 'no_subject' });
    expect(fallbackKey('in_safe_zone')).toBe('move_back');
    for (const r of [
      'subject_present',
      'required_landmarks_visible',
      'subject_size',
      'handedness_match',
      'single_person',
      'side_view',
      'face_frontal',
      'brightness',
      'face_light_balance',
      'sharpness',
      'tilt',
      'shake',
      'analysis_health',
    ] as RuleName[])
      expect(typeof fallbackKey(r)).toBe('string');
  });

  it('speaks a prompt once per cooldown, per key', () => {
    const e = new GuidanceEngine(rules, quality);
    const st = feed(e, ['brightness'], 0, 800, () => 'FAIL', 'too_dark');
    expect(e.speech(st, ms(800))).toBe('too_dark');
    expect(e.speech(st, ms(2000))).toBeNull();
    expect(e.speech(st, ms(3900))).toBe('too_dark');
    expect(e.speech({ ...st, prompt: null }, ms(9000))).toBeNull();
  });

  it('escalates critical rules after their limit; reset clears everything', () => {
    const e = new GuidanceEngine(['subject_present', 'brightness', 'shake'], quality);
    feed(e, ['subject_present', 'brightness', 'shake'], 0, 2800, () => 'FAIL');
    const sev = e.severities(ms(2800));
    expect(sev).toContainEqual({ rule: 'subject_present', severity: 'CRITICAL' });
    expect(sev).toContainEqual({ rule: 'shake', severity: 'CRITICAL' });
    expect(sev).toContainEqual({ rule: 'brightness', severity: 'WARN' });
    e.reset();
    expect(e.update(ms(2800)).tracking).toBe(true);
    e.push([sample('not_a_rule' as RuleName, 1, 'OK')]);
  });

  it('flags recording fps below the floor for longer than lowFpsS', () => {
    const c = quality.critical;
    const s = (t: number, fps: number) => ({ tNs: ms(t), fps });
    expect(lowFpsCritical([s(0, 20), s(500, 20), s(1100, 20)], c)).toBe(true);
    expect(lowFpsCritical([s(0, 20), s(500, 60), s(1100, 20)], c)).toBe(false);
  });
});

describe('evaluateFrame helpers', () => {
  const test = read<TestConfig>('config/tests/SAW.json');
  it('chooses rules from the test and device', () => {
    const base = { test, quality, side: null, orientation: 'landscape' as const };
    expect(gateRules({ ...base, sharpnessBaseline: null, sensors: false })).toEqual([
      'subject_present',
      'required_landmarks_visible',
      'in_safe_zone',
      'subject_size',
      'single_person',
      'side_view',
      'brightness',
    ]);
    expect(gateRules({ ...base, sharpnessBaseline: 100, sensors: true })).toContain('shake');
  });
  it('turns landmark checks UNKNOWN when analysis is unhealthy', () => {
    const ctx = {
      test,
      quality,
      side: null,
      orientation: 'landscape' as const,
      sharpnessBaseline: 100,
      sensors: true,
    };
    const { frame, sensors: s } = syntheticFrame(test, 'good', {
      seq: 0,
      tNs: ms(1000),
      orientation: 'landscape',
    });
    const sensors = new SensorBuffer();
    sensors.push(s);
    const slow = new AnalysisHealth();
    slow.push(0n, 10);
    slow.push(ms(1000), 10); // 1 fps
    const out = evaluateFrame(frame, sensors, ctx, slow);
    expect(out.find((x) => x.ruleId.startsWith('subject_present'))!.state).toBe('UNKNOWN');
    expect(out.find((x) => x.ruleId.startsWith('brightness'))!.state).toBe('OK');
  });
  it('SensorBuffer keeps recent gyro and the newest gravity; AnalysisHealth stats', () => {
    const b = new SensorBuffer(100);
    b.push([
      { type: 'gravity', tNs: ms(10), x: 0, y: 9.8, z: 0 },
      { type: 'gravity', tNs: ms(5), x: 1, y: 9.8, z: 0 },
      { type: 'gyro', tNs: ms(0), x: 1, y: 0, z: 0 },
      { type: 'gyro', tNs: ms(300), x: 1, y: 0, z: 0 },
    ]);
    expect(b.latestGravity(ms(20))!.x).toBe(0);
    expect(b.latestGravity(ms(5000))).toBeNull();
    expect(b.gyroWindow(ms(300), 50)).toHaveLength(1);
    const h = new AnalysisHealth(3);
    expect(h.fps()).toBe(Infinity);
    expect(h.latencyP95()).toBe(0);
    for (let i = 0; i < 5; i++) h.push(ms(i * 100), i * 10);
    expect(h.fps()).toBeCloseTo(10);
    expect(h.latencyP95()).toBe(40);
    const z = new AnalysisHealth();
    z.push(0n, 1);
    z.push(0n, 1);
    expect(z.fps()).toBe(0);
  });
});
