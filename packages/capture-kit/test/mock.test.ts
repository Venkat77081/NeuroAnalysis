import { validate } from '@neurocapture/contracts-ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decodeAnalysisFrame,
  MockCaptureKit,
  scaledScheduler,
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

  it('reports the mock implementation (assigned tier W downstream)', async () => {
    expect((await kit.getCapabilities()).implementation).toBe('mock');
  });

  it('simulates a qualification benchmark with progress, producing a schema-valid report', async () => {
    const phases: string[] = [];
    await kit.addListener('benchmarkProgress', (p) => phases.push(p.phase));
    const pending = kit.runQualificationBenchmark({
      facing: 'back',
      resolution: '1080p',
      targetFps: 60,
      recordMinutes: 10,
      thermalMinutes: 30,
    });
    await expect(
      kit.runQualificationBenchmark({
        facing: 'back',
        resolution: '1080p',
        targetFps: 60,
        recordMinutes: 1,
        thermalMinutes: 0,
      }),
    ).rejects.toThrow(/already running/);
    await vi.advanceTimersByTimeAsync(41_000);
    const report = await pending;
    expect(report.implementation).toBe('mock');
    expect(report.recording.durationS).toBe(600);
    expect(report.thermal.durationS).toBe(1800);
    expect(validate('benchmark-report', report).issues).toEqual([]);
    expect(phases[0]).toBe('calibrating');
    expect(phases).toContain('recording');
    expect(phases).toContain('thermal');
    expect(phases.at(-1)).toBe('done');
  });

  it('saves qualification reports with safe file names only', async () => {
    await expect(
      kit.saveQualificationReport({ fileName: 'x1-60fps.json', json: '{}' }),
    ).resolves.toEqual({ fileName: 'x1-60fps.json' });
    await expect(
      kit.saveQualificationReport({ fileName: '../evil.json', json: '{}' }),
    ).rejects.toThrow(/fileName/);
    await expect(kit.saveQualificationReport({ fileName: 'a.json', json: '{' })).rejects.toThrow();
  });

  it('can cancel a running benchmark', async () => {
    const phases: string[] = [];
    await kit.addListener('benchmarkProgress', (p) => phases.push(p.phase));
    const pending = kit.runQualificationBenchmark({
      facing: 'back',
      resolution: '720p',
      targetFps: 30,
      recordMinutes: 10,
      thermalMinutes: 0,
    });
    const settled = expect(pending).rejects.toThrow(/cancelled/);
    await vi.advanceTimersByTimeAsync(50); // the whole simulated run takes ~167 ms
    await kit.cancelBenchmark();
    await settled;
    expect(phases.at(-1)).toBe('cancelled');
    await kit.cancelBenchmark(); // no-op when idle
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

  it('reports M2 recording details: duration error, actual fps, MP4 alignment, encryption', async () => {
    await kit.openCamera(openOpts);
    const done = new Promise<RecordingStateEvent>(
      (r) => void kit.addListener('recordingState', (s) => s.state === 'completed' && r(s)),
    );
    await kit.startRecording({ takeId: 'm2', durationS: 15 });
    await vi.advanceTimersByTimeAsync(15_000);
    const res = (await done).result!;
    expect(res).toMatchObject({
      requestedDurationS: 15,
      durationErrorMs: 0,
      actualFps: 60,
      encrypted: true,
      encryptedNotPlayable: true,
    });
    expect(res.mp4?.anchor).toBe('pattern');
    expect(res.files.video).toBe('capturekit://takes/m2/video.mp4.enc');
    await expect(kit.startRecording({ takeId: 'm2', durationS: 15 })).rejects.toThrow(
      /already exists/,
    );
  });

  it('falls back to 30 fps when the camera cannot do 60 and a fallback is allowed', async () => {
    const slow = new MockCaptureKit({ fixture: sampleFixtures['ft-r-sample'], maxFps: 30 });
    expect((await slow.openCamera({ ...openOpts, fallbackFps: 30 })).actualFps).toBe(30);
    await slow.startRecording({ takeId: 's', durationS: 15 });
    vi.advanceTimersByTime(15_000);
    await slow.closeCamera();
    const strict = new MockCaptureKit({ fixture: sampleFixtures['ft-r-sample'], maxFps: 30 });
    expect((await strict.openCamera(openOpts)).actualFps).toBe(60);
    await strict.closeCamera();
  });

  it('plays takes into a temporary copy that closePlayback removes; calibrates sharpness', async () => {
    await kit.openCamera(openOpts);
    await kit.startRecording({ takeId: 'p1', durationS: 15 });
    vi.advanceTimersByTime(15_000);
    await expect(kit.playTake({ takeId: 'nope' })).rejects.toThrow(/unknown take/);
    await kit.playTake({ takeId: 'p1' });
    expect(kit.openPlaybacks()).toEqual(['p1']);
    await kit.closePlayback({ takeId: 'p1' });
    expect(kit.openPlaybacks()).toEqual([]);
    await kit.playTake({ takeId: 'p1' });
    await kit.closePlayback({});
    expect(kit.openPlaybacks()).toEqual([]);
    expect((await kit.calibrateSharpness({ durationS: 3 })).baseline).toBe(230);
    expect(await kit.getRecoveredTakes()).toEqual({ takeIds: [] });
    await kit.closeCamera();
    await expect(kit.calibrateSharpness({ durationS: 3 })).rejects.toThrow(/not open/);
  });

  it('only sends data for the trackers the camera was opened with', async () => {
    const frames: AnalysisFrameEvent[] = [];
    await kit.addListener('analysisFrame', (f) => frames.push(f));
    await kit.openCamera({ ...openOpts, trackers: ['pose'] });
    vi.advanceTimersByTime(100);
    expect(frames[0]!.hands).toBeUndefined();
    expect(frames[0]!.trackerStatus).toEqual({ hand: 'off', pose: 'no_result', face: 'off' });
    expect(frames[0]!.counts).toEqual({ hands: 0, poses: 0, faces: 0 });
    await kit.closeCamera();
    frames.length = 0;
    await kit.openCamera({ ...openOpts, trackers: ['hand'] });
    vi.advanceTimersByTime(100);
    expect(frames[0]!.hands).toHaveLength(1);
    expect(frames[0]!.trackerStatus.hand).toBe('ok');
    expect(BigInt(frames[0]!.emitNs!)).toBeGreaterThan(BigInt(frames[0]!.tsNs));
    expect((await kit.clockNow()).elapsedRealtimeNs).toMatch(/^\d+$/);
    await kit.closeCamera();
  });

  it('stores app data by key with a safe key format', async () => {
    expect(await kit.secureGet({ key: 'patient.p1' })).toEqual({ json: null });
    await kit.securePut({ key: 'patient.p1', json: '{"ref":"A1"}' });
    await kit.securePut({ key: 'session.current', json: '{}' });
    expect(await kit.secureGet({ key: 'patient.p1' })).toEqual({ json: '{"ref":"A1"}' });
    expect(await kit.secureKeys({ prefix: 'patient.' })).toEqual({ keys: ['patient.p1'] });
    await kit.secureDelete({ key: 'patient.p1' });
    expect(await kit.secureKeys({ prefix: '' })).toEqual({ keys: ['session.current'] });
    await expect(kit.securePut({ key: '../x', json: '{}' })).rejects.toThrow(/invalid key/);
    await expect(kit.securePut({ key: 'x', json: '{' })).rejects.toThrow();
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

describe('scaledScheduler', () => {
  it('runs time faster for mock/e2e', async () => {
    vi.useFakeTimers();
    const s = scaledScheduler(10);
    const t0 = s.now();
    let fired = 0;
    s.setTimeout(() => fired++, 1000);
    const h = s.setInterval(() => fired++, 1000);
    vi.advanceTimersByTime(100);
    expect(fired).toBe(2);
    expect(s.now() - t0).toBe(1000);
    s.clearInterval(h);
    s.clearTimeout(s.setTimeout(() => fired++, 10));
    vi.advanceTimersByTime(100);
    expect(fired).toBe(2);
    vi.useRealTimers();
  });
});

describe('createCaptureKit', () => {
  it('uses the mock outside a native platform', () => {
    expect(createCaptureKit().implementation).toBe('mock');
    expect(createCaptureKit('native').implementation).toBe('native');
  });
});

describe('MockCaptureKit synthetic scenarios (M5)', () => {
  it('emits synthetic frames and sensor batches for the chosen test and scenario', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const test = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../../config/tests/FA.json'), 'utf8'),
    );
    vi.useFakeTimers();
    const kit = new MockCaptureKit({ fixture: sampleFixtures['ft-r-sample'] });
    kit.setScenario({ test, name: 'face_turned' });
    const frames: AnalysisFrameEvent[] = [];
    let sensorBatches = 0;
    await kit.addListener('analysisFrame', (e) => frames.push(e));
    await kit.addListener('sensorBatch', () => sensorBatches++);
    await kit.openCamera({
      facing: 'back',
      resolution: '1080p',
      targetFps: 60,
      orientation: 'portrait',
      trackers: ['face'],
      analysisFps: 30,
    });
    vi.advanceTimersByTime(1000);
    expect(frames.length).toBeGreaterThanOrEqual(29);
    expect(sensorBatches).toBe(frames.length);
    const f = decodeAnalysisFrame(frames[0]!);
    expect(f.face?.yaw).toBe(20);
    expect(f.image).toEqual({ w: 480, h: 854 });
    await kit.closeCamera();
    kit.setScenario(null);
    vi.useRealTimers();
  });
});
