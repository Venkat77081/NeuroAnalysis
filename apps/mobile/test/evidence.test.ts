import { describe, expect, it } from 'vitest';
import type { LandmarksHeader } from '@neurocapture/contracts-ts';
import type { LandmarkFrame } from '@neurocapture/quality-core';
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

describe('buildQuality and the device evaluation (M6, M8)', () => {
  /** landmarks.bin bytes for synthetic frames, as the plugin writes them. */
  async function landmarksFile(frames: LandmarkFrame[], takeId: string) {
    const { encodeAnalysisFrame, encodeLandmarks, recordFromEvent, bytesToBase64 } =
      await import('@neurocapture/capture-kit');
    const header = {
      schemaVersion: '1.0.0',
      layout: 'NCLM-v1',
      takeId,
      coordinateSystem: 'normalized_upright_analysis_frame',
      orientation: 'landscape',
      image: frames[0]!.image,
      mirrored: false,
      imageMirrored: false,
      handednessLabels: 'mediapipe_raw',
      timestampSemantics: 'camera_frame_canonical_elapsed_realtime_ns',
      clockSource: 'SIMULATED',
      record: { endianness: 'little', dtype: 'float32' },
      trackers: [
        { name: 'hand', modelVersion: 'x', pointsPerFrame: 21, valuesPerPoint: 3 },
        { name: 'pose', modelVersion: 'x', pointsPerFrame: 33, valuesPerPoint: 4 },
        { name: 'face', modelVersion: 'x', pointsPerFrame: 478, valuesPerPoint: 3 },
      ],
    } as unknown as LandmarksHeader;
    const records = frames.map((f) => recordFromEvent(encodeAnalysisFrame(f)));
    return bytesToBase64(encodeLandmarks(header, records));
  }

  it('builds a schema-valid quality.json from the recorded files, with readiness and replay inputs', async () => {
    const { syntheticTake } = await import('@neurocapture/quality-core');
    const { evaluateOnDevice } = await import('../src/lib/take-analysis.ts');
    const { buildQuality } = await import('../src/lib/evidence.ts');
    const config = loadConfig();
    for (const code of ['FT', 'SAW'] as const) {
      const cfg = config.tests.get(code)!;
      const tk = syntheticTake(cfg, 'normal', { fps: 30 });
      const data = await landmarksFile(tk.frames, 'tk-q');
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
      const take = await evaluateOnDevice({
        kit: {
          readLandmarks: async () => ({ data }),
          readSensors: async () => ({ data: null }),
        },
        collector: null,
        result,
        test: cfg,
        quality: config.quality,
        registry: config.registry,
        side: null,
        orientation: cfg.camera.orientation as 'portrait' | 'landscape',
        hasSensors: false,
        minEffectiveFps: 59,
        sharpnessBaseline: null,
      });
      expect(take.verdict.verdict, code).toBe('PASS');
      expect(take.replayInputs).toMatchObject({ source: 'recorded', sensorsSha256: null });
      expect(take.replayInputs.landmarksSha256).toMatch(/^[0-9a-f]{64}$/);
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
      expect(q.biomarkerReadinessHint.registryVersion).toBe('REG@0.1.0');
      expect((q.biomarkerReadinessHint as Record<string, unknown>)[`${code}1`]).toEqual({
        status: 'COMPUTABLE',
      });
      if (code === 'SAW')
        expect(q.phasesDetected).toEqual(['seated', 'standing', 'walk_out', 'turn', 'walk_back']);
    }
  });

  it('falls back to the live frames when the files cannot be read; plain RETAKE reasons', async () => {
    const { syntheticTake } = await import('@neurocapture/quality-core');
    const { TakeCollector, evaluateOnDevice } = await import('../src/lib/take-analysis.ts');
    const config = loadConfig();
    const cfg = config.tests.get('FT')!;
    const tk = syntheticTake(cfg, 'interrupted', { fps: 30 });
    const collector = new TakeCollector(config.quality.ruleVersion);
    for (const f of tk.frames) collector.push(f, [], false);
    const result = {
      takeId: 'tk-i',
      durationS: 15,
      requestedDurationS: 15,
      stoppedEarly: false,
      effectiveFps: 60,
      droppedFrac: 0,
      mp4: null,
    } as unknown as RecordingResult;
    const args = {
      collector,
      result,
      test: cfg,
      quality: config.quality,
      registry: config.registry,
      side: null,
      orientation: 'landscape' as const,
      hasSensors: false,
      minEffectiveFps: 59,
      sharpnessBaseline: 100,
    };
    const broken = {
      readLandmarks: async () => Promise.reject(new Error('io')),
      readSensors: async () => ({ data: null }),
    };
    const take = await evaluateOnDevice({ ...args, kit: broken });
    expect(take.replayInputs.source).toBe('live');
    expect(take.verdict.reasons.map((r) => r.code)).toContain('no_motion');
    const none = { readLandmarks: async () => ({ data: null }), readSensors: broken.readSensors };
    const empty = await evaluateOnDevice({ ...args, kit: none });
    expect(empty.replayInputs.source).toBe('recorded');
    expect(empty.verdict.reasons.map((r) => r.code)).toContain('protocol_incomplete');
  });
});
