import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MockCaptureKit,
  sampleFixtures,
  decodeFloat32,
  encodeFloat32,
  createCaptureKit,
} from '../src/index.ts';
import type {
  AnalysisFrameEvent,
  OpenCameraOpts,
  RecordingStateEvent,
  SensorBatchEvent,
} from '../src/index.ts';

const openOpts: OpenCameraOpts = {
  facing: 'back',
  resolution: '1080p',
  targetFps: 60,
  orientation: 'portrait',
  trackers: ['hand'],
  analysisFps: 30,
};

describe('codec', () => {
  it('round-trips Float32 landmarks through base64', () => {
    const vals = [0.5, 0.25, -1, 0.75]; // exactly representable in Float32
    expect(Array.from(decodeFloat32(encodeFloat32(vals)))).toEqual(vals);
  });
  it('keeps Float32 precision for arbitrary values', () => {
    expect(decodeFloat32(encodeFloat32([0.99]))[0]).toBeCloseTo(0.99, 6);
  });
  it('rejects payloads that are not whole floats', () => {
    expect(() => decodeFloat32(btoa('abc'))).toThrow(/multiple of 4/);
  });
});

describe('sample fixture', () => {
  const fx = sampleFixtures['ft-r-sample'];
  it('has 90 frames of a 21-point right hand, each event ≤ 20 KB', () => {
    expect(fx.frames).toHaveLength(90);
    for (const f of fx.frames) {
      expect(decodeFloat32(f.hands![0]!.lm)).toHaveLength(21 * 4);
      expect(JSON.stringify(f).length).toBeLessThanOrEqual(20 * 1024);
    }
  });
});

describe('MockCaptureKit', () => {
  let kit: MockCaptureKit;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-13T10:00:00Z'));
    kit = new MockCaptureKit({ fixture: sampleFixtures['ft-r-sample'] });
  });
  afterEach(() => vi.useRealTimers());

  it('reports mock implementation and tier W (never clinical)', async () => {
    expect((await kit.getCapabilities()).implementation).toBe('mock');
    expect(
      (
        await kit.runQualificationBenchmark({
          resolution: '1080p',
          targetFps: 60,
          recordMinutes: 10,
          thermalMinutes: 30,
        })
      ).tier,
    ).toBe('W');
  });

  it('replays analysis frames with increasing canonical timestamps and loops the fixture', async () => {
    const frames: AnalysisFrameEvent[] = [];
    const sensors: SensorBatchEvent[] = [];
    await kit.addListener('analysisFrame', (f) => frames.push(f));
    await kit.addListener('sensorBatch', (b) => sensors.push(b));
    const opened = await kit.openCamera(openOpts);
    expect(opened.actualFps).toBe(60);
    expect(opened.previewTransform.mirrored).toBe(false);
    vi.advanceTimersByTime(4000); // > 3 s fixture → loops
    expect(frames.length).toBeGreaterThanOrEqual(119);
    expect(sensors.length).toBeGreaterThan(30);
    const ts = frames.map((f) => BigInt(f.tsNs));
    for (let i = 1; i < ts.length; i++) expect(ts[i]! > ts[i - 1]!).toBe(true);
    expect(frames.map((f) => f.seq)).toEqual(frames.map((_, i) => i));
    await kit.closeCamera();
    const n = frames.length;
    vi.advanceTimersByTime(1000);
    expect(frames.length).toBe(n);
  });

  it('stops recording on its own timer at durationS (decision 002)', async () => {
    const states: RecordingStateEvent[] = [];
    await kit.addListener('recordingState', (s) => states.push(s));
    await kit.openCamera(openOpts);
    await kit.lockCameraSettings({ ae: true, af: true, awb: true });
    await kit.startRecording({ takeId: 't1', durationS: 15 });
    vi.advanceTimersByTime(14_900);
    expect(states.at(-1)?.state).toBe('recording');
    vi.advanceTimersByTime(200);
    const done = states.at(-1)!;
    expect(done.state).toBe('completed');
    expect(done.result).toMatchObject({ takeId: 't1', durationS: 15, stoppedEarly: false });
    expect(done.result!.droppedFrac).toBeLessThan(0.01);
    await expect(kit.stopRecording()).rejects.toThrow(/not recording/);
  });

  it('marks an operator stop as stoppedEarly', async () => {
    await kit.openCamera(openOpts);
    await kit.startRecording({ takeId: 't2', durationS: 30 });
    vi.advanceTimersByTime(6400);
    const res = await kit.stopRecording();
    expect(res.stoppedEarly).toBe(true);
    expect(res.durationS).toBeCloseTo(6.4, 1);
  });

  it('enforces call order', async () => {
    await expect(kit.startRecording({ takeId: 'x', durationS: 15 })).rejects.toThrow(
      /camera not open/,
    );
    await expect(kit.lockCameraSettings({ ae: true, af: true, awb: true })).rejects.toThrow(
      /camera not open/,
    );
    await kit.openCamera(openOpts);
    await expect(kit.openCamera(openOpts)).rejects.toThrow(/already open/);
    await expect(kit.startRecording({ takeId: 'x', durationS: 0 })).rejects.toThrow(/durationS/);
    await kit.startRecording({ takeId: 'x', durationS: 15 });
    await expect(kit.startRecording({ takeId: 'y', durationS: 15 })).rejects.toThrow(
      /already recording/,
    );
    await kit.closeCamera(); // closing mid-take ends it early
  });

  it('stores evidence, rejects malformed JSON, and deletes takes', async () => {
    await kit.writeEvidence({ takeId: 't', name: 'quality.json', json: '{"a":1}' });
    expect(kit.readEvidence('t', 'quality.json')).toBe('{"a":1}');
    await expect(
      kit.writeEvidence({ takeId: 't', name: 'meta.json', json: '{' }),
    ).rejects.toThrow();
    expect((await kit.playTake({ takeId: 't' })).playerUrl).toContain('t');
    await kit.deleteTake({ takeId: 't', reason: 'test' });
    expect(kit.readEvidence('t', 'quality.json')).toBeUndefined();
  });

  it('queues uploads and reports status; listeners can be removed', async () => {
    const seen: string[] = [];
    const h = await kit.addListener('uploadProgress', (u) => seen.push(u.state));
    await kit.enqueueUpload({ takeId: 't', sessionId: 's', endpoint: 'https://x', token: 'tok' });
    expect((await kit.getUploadStatus({ takeId: 't' })).state).toBe('queued');
    expect((await kit.getUploadStatus({ takeId: 'nope' })).state).toBe('failed_permanent');
    await h.remove();
    await kit.enqueueUpload({ takeId: 't2', sessionId: 's', endpoint: 'https://x', token: 'tok' });
    expect(seen).toEqual(['queued']);
    await kit.removeAllListeners();
  });
});

describe('createCaptureKit', () => {
  it('uses the mock outside a native platform', () => {
    expect(createCaptureKit().implementation).toBe('mock');
    expect(createCaptureKit('native').implementation).toBe('native');
  });
});
