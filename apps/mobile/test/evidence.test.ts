import { describe, expect, it } from 'vitest';
import { validate } from '@neurocapture/contracts-ts';
import { MockCaptureKit, sampleFixtures, type RecordingResult } from '@neurocapture/capture-kit';
import { buildMeta } from '../src/lib/evidence.ts';
import { loadConfig } from '../src/lib/config.ts';
import type { SessionContext } from '../src/session/machine.ts';

describe('buildMeta', () => {
  it('produces schema-valid meta.json without patient identifiers', async () => {
    const config = loadConfig();
    const caps = await new MockCaptureKit({
      fixture: sampleFixtures['ft-r-sample'],
    }).getCapabilities();
    const ctx = {
      sessionId: 's-1',
      operatorId: 'OP-07',
      plan: [{ code: 'FT', side: 'R' }],
      index: 0,
      medState: 'ON',
      patient: { localId: 'p', ref: 'SECRET-REF', yearOfBirth: 1950, sex: 'F' },
    } as unknown as SessionContext;
    const meta = buildMeta({
      ctx,
      cfg: config.tests.get('FT')!,
      sessionConfigVersion: config.session.configVersion,
      result: { takeId: 'tk-1', actualFps: 60 } as RecordingResult,
      takeNo: 2,
      caps,
      implementation: 'mock',
      tier: null,
      createdAt: '2026-11-13T10:00:00.000Z',
    });
    expect(validate('meta', meta).issues).toEqual([]);
    expect(meta).toMatchObject({ testCode: 'FT', side: 'R', take: 2, tier: 'W', medState: 'ON' });
    expect(JSON.stringify(meta)).not.toContain('SECRET-REF');
    const noCaps = buildMeta({
      ctx,
      cfg: config.tests.get('FT')!,
      sessionConfigVersion: 'SESSION@1.1.0',
      result: { takeId: 'tk-2', actualFps: 30 } as RecordingResult,
      takeNo: 1,
      caps: null,
      implementation: 'native',
      tier: null,
      createdAt: '2026-11-13T10:00:00.000Z',
    });
    expect(validate('meta', noCaps).issues).toEqual([]);
    expect(noCaps.tier).toBeNull();
  });

  it('records the orientation the operator chose', () => {
    const config = loadConfig();
    const ctx = {
      sessionId: 's-1',
      operatorId: 'OP-07',
      plan: [{ code: 'FT', side: null }],
      index: 0,
      medState: 'ON',
    } as unknown as SessionContext;
    const base = {
      ctx,
      cfg: config.tests.get('FT')!,
      sessionConfigVersion: config.session.configVersion,
      result: { takeId: 'tk-3', actualFps: 60 } as RecordingResult,
      takeNo: 1,
      caps: null,
      implementation: 'mock' as const,
      tier: null,
      createdAt: '2026-11-14T10:00:00.000Z',
    };
    expect(buildMeta(base).camera.orientation).toBe('landscape');
    const meta = buildMeta({ ...base, orientation: 'portrait' });
    expect(meta.camera.orientation).toBe('portrait');
    expect(validate('meta', meta).issues).toEqual([]);
  });
});

describe('buildQuality (M6)', () => {
  it('builds a schema-valid quality.json from a synthetic take', async () => {
    const { syntheticTake } = await import('@neurocapture/quality-core');
    const { TakeCollector, finishTake } = await import('../src/lib/take-analysis.ts');
    const { buildQuality } = await import('../src/lib/evidence.ts');
    const config = loadConfig();
    for (const code of ['FT', 'SAW'] as const) {
      const cfg = config.tests.get(code)!;
      const tk = syntheticTake(cfg, 'normal');
      const collector = new TakeCollector(config.quality.ruleVersion);
      for (const f of tk.frames) collector.push(f, [], false);
      const result = {
        takeId: 'tk-q',
        durationS: tk.durationS,
        requestedDurationS: tk.durationS,
        stoppedEarly: false,
        effectiveFps: 59.9,
        droppedFrames: 2,
        droppedFrac: 0.002,
        actualFps: 60,
        mp4: { firstSampleNs: tk.t0Ns.toString() },
      } as unknown as RecordingResult;
      const take = finishTake({
        collector,
        result,
        test: cfg,
        quality: config.quality,
        minEffectiveFps: 59,
        sharpnessBaseline: null,
      });
      expect(take.verdict.verdict, code).toBe('PASS');
      const ctx = { plan: [{ code, side: null }], index: 0 } as unknown as SessionContext;
      const q = buildQuality({
        ctx,
        cfg,
        result,
        takeNo: 1,
        implementation: 'mock',
        tier: null,
        take,
        sharpnessBaseline: null,
      });
      expect(validate('quality', q).issues).toEqual([]);
      expect(q.eventsDetected).toBeGreaterThan(5);
      if (code === 'SAW')
        expect(q.phasesDetected).toEqual(['seated', 'standing', 'walk_out', 'turn', 'walk_back']);
    }
  });

  it('gives plain RETAKE reasons for an interrupted take', async () => {
    const { syntheticTake } = await import('@neurocapture/quality-core');
    const { TakeCollector, finishTake } = await import('../src/lib/take-analysis.ts');
    const config = loadConfig();
    const cfg = config.tests.get('FT')!;
    const tk = syntheticTake(cfg, 'interrupted');
    const collector = new TakeCollector(config.quality.ruleVersion);
    for (const f of tk.frames) collector.push(f, [{ rule: 'shake', severity: 'CRITICAL' }], false);
    const result = {
      durationS: 15,
      requestedDurationS: 15,
      stoppedEarly: false,
      effectiveFps: 60,
      droppedFrac: 0,
      mp4: null,
    } as unknown as RecordingResult;
    const take = finishTake({
      collector,
      result,
      test: cfg,
      quality: config.quality,
      minEffectiveFps: 59,
      sharpnessBaseline: 100,
    });
    expect(take.verdict.reasons.map((r) => r.code)).toEqual(['no_motion', 'critical_events']);
    expect(take.events[0]).toMatchObject({ ruleId: 'shake@1.0.0', severity: 'CRITICAL' });
    const empty = finishTake({
      collector: null,
      result,
      test: cfg,
      quality: config.quality,
      minEffectiveFps: 59,
      sharpnessBaseline: null,
    });
    expect(empty.verdict.reasons.map((r) => r.code)).toContain('protocol_incomplete');
  });
});
