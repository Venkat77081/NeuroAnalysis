import type {
  AnalysisFrameEvent,
  BenchmarkOpts,
  BenchmarkProgressEvent,
  BenchmarkReport,
  CaptureKitEventName,
  CaptureKitEvents,
  CaptureKitPlugin,
  DeviceCapabilities,
  OpenCameraOpts,
  PluginListenerHandle,
  PreviewTransform,
  RecordingResult,
  StoredTake,
  UploadConfig,
  UploadStatus,
} from './definitions.ts';
import type { CaptureFixture } from './fixture.ts';
import { PLUGIN_VERSION } from './version.ts';
import type { TestConfig } from '@neurocapture/contracts-ts';
import {
  syntheticFrame,
  syntheticTake,
  type LandmarkFrame,
  type ScenarioName,
  type Side,
  type TakeVariant,
} from '@neurocapture/quality-core';
import {
  encodeAnalysisFrame,
  encodeLandmarks,
  recordFromEvent,
  type LandmarkRecord,
} from './landmarks.ts';
import { bytesToBase64 } from './codec.ts';
import { FakeServer } from './upload/fake-server.ts';
import { UploadClient, sha256Hex, type UploadError, type UploadJob } from './upload/protocol.ts';
import type { LandmarksHeader } from '@neurocapture/contracts-ts/types';

export interface Scheduler {
  now(): number; // ms
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Real-time scheduler, optionally sped up (mock/e2e only): `speed` 20 runs a 15 s take in 0.75 s. */
export function scaledScheduler(speed = 1): Scheduler {
  const t0 = Date.now();
  return {
    now: () => t0 + (Date.now() - t0) * speed,
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms / speed),
    clearInterval: (h) => globalThis.clearInterval(h as ReturnType<typeof setInterval>),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms / speed),
    clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
  };
}

const realScheduler: Scheduler = {
  now: () => Date.now(),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (h) => globalThis.clearInterval(h as ReturnType<typeof setInterval>),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface MockOptions {
  fixture: CaptureFixture;
  scheduler?: Scheduler;
  /** Simulated recording frame rate quality. */
  effectiveFps?: number;
  droppedFrac?: number;
  /** Simulated benchmark minutes per real second (default 60: a 40-minute run takes 40 s). */
  benchmarkMinutesPerSecond?: number;
  /** Highest fps the simulated camera supports (default 60); 30 exercises the fallback (decision 007). */
  maxFps?: 60 | 30;
}

/**
 * MockCaptureKit replays a recorded/synthetic fixture on a timer (DEV_PLAN §5.3).
 * Never valid for clinical data: capabilities report implementation "mock" and tier "W".
 */
export class MockCaptureKit implements CaptureKitPlugin {
  private readonly fixture: CaptureFixture;
  private readonly sched: Scheduler;
  private readonly effectiveFps: number;
  private readonly droppedFrac: number;
  private listeners = new Map<CaptureKitEventName, Set<(e: never) => void>>();
  private frameTimer: unknown = null;
  private camera: OpenCameraOpts | null = null;
  private actualFps: 60 | 30 = 60;
  private takes = new Set<string>();
  private results = new Map<string, RecordingResult>();
  private playing = new Set<string>();
  private frameIdx = 0;
  private seq = 0;
  private startNs = 0n;
  private recording: {
    takeId: string;
    durationS: number;
    startedMs: number;
    timer: unknown;
    tick: unknown;
  } | null = null;
  private evidence = new Map<string, string>();
  private readonly benchSpeed: number;
  private readonly mockMaxFps: 60 | 30;
  private benchCancel: (() => void) | null = null;
  private benchRunning = false;
  /** Synthetic positioning scenario (M5); null = replay the fixture. */
  private scenario: {
    test: TestConfig;
    name: ScenarioName;
    side: Side | null;
    take: TakeVariant;
  } | null = null;
  /** While recording with a scenario: synthetic take frames (movement) and their start time. */
  private takeFrames: LandmarkFrame[] | null = null;
  private takeStartNs = 0n;
  private lastSyntheticNs = 0n;
  /** landmarks.bin records per take, captured while recording (replay overlay). */
  private landmarkRecords = new Map<string, LandmarkRecord[]>();
  private firstSampleNs = new Map<string, bigint>();

  constructor(opts: MockOptions) {
    this.fixture = opts.fixture;
    this.sched = opts.scheduler ?? realScheduler;
    this.effectiveFps = opts.effectiveFps ?? 59.8;
    this.droppedFrac = opts.droppedFrac ?? 0.004;
    this.benchSpeed = opts.benchmarkMinutesPerSecond ?? 60;
    this.mockMaxFps = opts.maxFps ?? 60;
  }

  async getCapabilities(): Promise<DeviceCapabilities> {
    return {
      implementation: 'mock',
      pluginVersion: PLUGIN_VERSION,
      device: { manufacturer: 'mock', model: 'MockCaptureKit', osName: 'web', osVersion: 'n/a' },
      cameras: [
        {
          facing: 'back',
          maxFps: { '1080p': 60, '720p': 60 },
          timestampSource: 'SIMULATED',
          supportsLock: { ae: true, af: true, awb: true },
        },
        {
          facing: 'front',
          maxFps: { '1080p': 30, '720p': 30 },
          timestampSource: 'SIMULATED',
          supportsLock: { ae: true, af: true, awb: true },
        },
      ],
      gpuDelegate: false,
    };
  }

  async runQualificationBenchmark(opts: BenchmarkOpts): Promise<BenchmarkReport> {
    if (this.benchRunning) throw new Error('benchmark already running');
    this.benchRunning = true;
    try {
      return await this.simulateBenchmark(opts);
    } finally {
      this.benchRunning = false;
    }
  }

  private async simulateBenchmark(opts: BenchmarkOpts): Promise<BenchmarkReport> {
    const caps = await this.getCapabilities();
    const ranAt = new Date(this.sched.now()).toISOString();
    const totalS = (opts.recordMinutes + opts.thermalMinutes) * 60;
    const realMs = (totalS / 60 / this.benchSpeed) * 1000;
    const started = this.sched.now();
    const fps = Math.min(opts.targetFps, this.effectiveFps);
    const progress = (phase: BenchmarkProgressEvent['phase'], elapsedS: number) =>
      this.emit('benchmarkProgress', {
        phase,
        elapsedS,
        totalS,
        liveFps: phase === 'done' ? undefined : fps,
        thermalStatus: 'none',
      });

    await new Promise<void>((resolve, reject) => {
      const tick = this.sched.setInterval(
        () => {
          const elapsedS = Math.min(totalS, ((this.sched.now() - started) / realMs) * totalS || 0);
          progress(elapsedS < opts.recordMinutes * 60 ? 'recording' : 'thermal', elapsedS);
        },
        Math.max(10, Math.min(250, realMs / 40)),
      );
      const done = this.sched.setTimeout(() => {
        cleanup();
        resolve();
      }, realMs);
      const cleanup = () => {
        this.sched.clearInterval(tick);
        this.sched.clearTimeout(done);
        this.benchCancel = null;
      };
      this.benchCancel = () => {
        cleanup();
        progress('cancelled', ((this.sched.now() - started) / Math.max(realMs, 1)) * totalS);
        reject(new Error('benchmark cancelled'));
      };
      progress('calibrating', 0);
    });
    progress('done', totalS);

    const recordS = opts.recordMinutes * 60;
    const frames = Math.round(recordS * fps);
    const dropped = Math.round(frames * this.droppedFrac);
    return {
      schemaVersion: '1.0.0',
      implementation: 'mock',
      pluginVersion: PLUGIN_VERSION,
      ranAt,
      device: { ...caps.device, sdkInt: null },
      settings: { ...opts },
      camera: {
        hardwareLevel: 'UNKNOWN',
        timestampSource: 'SIMULATED',
        aeFpsRanges: [
          [30, 30],
          [60, 60],
        ],
        maxFps1080p: 60,
        maxFps720p: 60,
        lockSupported: { ae: true, af: true, awb: true },
      },
      timestamp: { samples: 60, offsetNsMedian: '0', offsetSpreadMs: 0 },
      recording: {
        durationS: recordS,
        frameCount: frames - dropped,
        effectiveFps: fps,
        droppedFrames: dropped,
        droppedFrac: frames ? dropped / frames : 0,
        windowFpsMin: recordS ? Math.floor(fps) - 1 : null,
      },
      analysis: {
        fps: this.fixture.fps,
        p95ProcessingMs: 3,
        frames: Math.round(recordS * this.fixture.fps),
      },
      thermal: {
        durationS: opts.thermalMinutes * 60,
        statusStart: 'none',
        statusMax: 'none',
        windowFpsMin: opts.thermalMinutes ? Math.floor(fps) - 1 : null,
        windowFpsMedian: opts.thermalMinutes ? Math.round(fps) : null,
      },
      storage: { freeBytesBefore: null },
      errors: [],
    };
  }

  private savedReports = new Map<string, string>();

  async saveQualificationReport(opts: {
    fileName: string;
    json: string;
  }): Promise<{ fileName: string }> {
    if (!/^[A-Za-z0-9._-]{1,120}\.json$/.test(opts.fileName)) throw new Error('invalid fileName');
    JSON.parse(opts.json);
    this.savedReports.set(opts.fileName, opts.json);
    return { fileName: opts.fileName };
  }

  async cancelBenchmark(): Promise<void> {
    this.benchCancel?.();
  }

  async openCamera(
    opts: OpenCameraOpts,
  ): Promise<{ previewTransform: PreviewTransform; actualFps: number }> {
    if (this.camera) throw new Error('camera already open');
    this.camera = opts;
    this.actualFps =
      opts.targetFps > this.mockMaxFps && opts.fallbackFps ? opts.fallbackFps : opts.targetFps;
    this.startNs = BigInt(this.sched.now()) * 1_000_000n;
    this.frameIdx = 0;
    const periodMs =
      1000 / (this.scenario ? opts.analysisFps : Math.min(opts.analysisFps, this.fixture.fps));
    this.frameTimer = this.sched.setInterval(() => this.emitNextFrame(), periodMs);
    return {
      previewTransform: {
        scaleX: 1,
        scaleY: 1,
        offsetX: 0,
        offsetY: 0,
        rotationDeg: 0,
        mirrored: opts.facing === 'front',
      },
      actualFps: this.actualFps,
    };
  }

  /** Emit an analysis event and, while recording, keep it as a landmarks.bin record. */
  private emitAnalysis(e: AnalysisFrameEvent): void {
    this.emit('analysisFrame', e);
    if (this.recording && (this.camera?.trackers.length ?? 0) > 0)
      this.landmarkRecords.get(this.recording.takeId)?.push(recordFromEvent(e));
  }

  async readLandmarks(opts: { takeId: string }): Promise<{ data: string | null }> {
    const records = this.landmarkRecords.get(opts.takeId);
    if (!records?.length) return { data: null };
    const header: LandmarksHeader = {
      schemaVersion: '1.0.0',
      layout: 'NCLM-v1',
      takeId: opts.takeId,
      coordinateSystem: 'normalized_upright_analysis_frame',
      orientation: this.camera?.orientation ?? 'portrait',
      mirrored: false,
      imageMirrored: false,
      handednessLabels: 'mediapipe_raw',
      timestampSemantics: 'camera_frame_canonical_elapsed_realtime_ns',
      clockSource: 'SIMULATED',
      record: { endianness: 'little', dtype: 'float32' },
      trackers: (this.camera?.trackers.length ? this.camera.trackers : ['hand']).map((name) => ({
        name,
        modelVersion: 'mock',
        pointsPerFrame: name === 'hand' ? 21 : name === 'pose' ? 33 : 478,
        valuesPerPoint: name === 'face' ? 3 : 4,
      })) as LandmarksHeader['trackers'],
    };
    return { data: bytesToBase64(encodeLandmarks(header, records)) };
  }

  /**
   * Mock only: generate synthetic frames for a test and positioning scenario (good, too_far,
   * dark, ...) instead of replaying the fixture, so the guidance UI can be exercised in a browser.
   */
  setScenario(
    s: { test: TestConfig; name: ScenarioName; side?: Side | null; take?: TakeVariant } | null,
  ): void {
    this.scenario = s ? { ...s, side: s.side ?? null, take: s.take ?? 'normal' } : null;
  }

  private emitSyntheticFrame(sc: {
    test: TestConfig;
    name: ScenarioName;
    side: Side | null;
  }): void {
    const cam = this.camera!;
    const periodNs = BigInt(Math.round(1e9 / cam.analysisFps));
    // Frame time from the (possibly sped-up) mock clock, so a take covers its full duration even
    // when the browser delivers fewer timer ticks than requested.
    const nowNs = BigInt(Math.round(this.sched.now() * 1e6));
    const tNs = nowNs > this.lastSyntheticNs ? nowNs : this.lastSyntheticNs + 1n;
    this.lastSyntheticNs = tNs;
    this.frameIdx++;
    const seq = this.seq++;
    const { frame: still, sensors } = syntheticFrame(sc.test, sc.name, {
      seq,
      tNs,
      orientation: cam.orientation,
      side: sc.side,
    });
    // While recording, the patient performs the task (synthetic take with movement).
    let frame = still;
    if (this.recording && this.takeFrames) {
      const k = Number((tNs - this.takeStartNs) / periodNs);
      const moving = this.takeFrames[k];
      if (moving) frame = { ...moving, seq, tNs };
    }
    this.emitAnalysis({
      ...encodeAnalysisFrame(frame),
      emitNs: (tNs + 5_000_000n).toString(),
      procMs: 5,
    });
    this.emit('sensorBatch', {
      samples: sensors.map((x) => ({
        type: x.type,
        tsNs: x.tNs.toString(),
        x: x.x,
        y: x.y,
        z: x.z,
      })),
    });
  }

  private emitNextFrame(): void {
    if (this.scenario && this.camera) {
      this.emitSyntheticFrame(this.scenario);
      return;
    }
    const frames = this.fixture.frames;
    if (!frames.length) return;
    const src = frames[this.frameIdx % frames.length]!;
    const loop = BigInt(Math.floor(this.frameIdx / frames.length));
    const loopNs = BigInt(Math.round(this.fixture.durationS * 1e9)) * loop;
    this.frameIdx++;
    // Like native: only trackers the camera was opened with produce data; the rest are 'off'.
    const on = new Set(this.camera?.trackers ?? []);
    const ts = this.startNs + loopNs + BigInt(src.tsNs);
    const hands = on.has('hand') ? src.hands : undefined;
    this.emitAnalysis({
      seq: this.seq++,
      tsNs: ts.toString(),
      imageW: src.imageW,
      imageH: src.imageH,
      ...(hands ? { hands } : {}),
      ...(on.has('pose') && src.pose ? { pose: src.pose } : {}),
      ...(on.has('face') && src.face ? { face: src.face } : {}),
      stats: src.stats,
      trackerStatus: {
        hand: on.has('hand') ? (hands?.length ? 'ok' : 'no_result') : 'off',
        pose: on.has('pose') ? (src.pose ? 'ok' : 'no_result') : 'off',
        face: on.has('face') ? (src.face ? 'ok' : 'no_result') : 'off',
      },
      counts: {
        hands: hands?.length ?? 0,
        poses: on.has('pose') && src.pose ? 1 : 0,
        faces: on.has('face') && src.face ? 1 : 0,
      },
      emitNs: (ts + 5_000_000n).toString(),
      procMs: 5,
    });
    // Emit the sensor batch(es) belonging to this frame's time slot.
    const slot = this.fixture.sensorBatches.filter((b) => b.tsNs === src.tsNs);
    for (const b of slot) {
      this.emit('sensorBatch', {
        samples: b.samples.map((s) => ({
          ...s,
          tsNs: (this.startNs + loopNs + BigInt(s.tsNs)).toString(),
        })),
      });
    }
  }

  async lockCameraSettings(_opts: { ae: boolean; af: boolean; awb: boolean }): Promise<void> {
    if (!this.camera) throw new Error('camera not open');
  }

  async startRecording(opts: {
    takeId: string;
    durationS: number;
  }): Promise<{ startedAtNs: string }> {
    if (!this.camera) throw new Error('camera not open');
    if (this.recording) throw new Error('already recording');
    if (!(opts.durationS > 0)) throw new Error('durationS must be > 0');
    if (this.takes.has(opts.takeId)) throw new Error('take already exists');
    this.takes.add(opts.takeId);
    const startedMs = this.sched.now();
    // Mirrors the native contract: the plugin's own timer ends the take at durationS.
    const timer = this.sched.setTimeout(() => this.finish(false), opts.durationS * 1000);
    const tick = this.sched.setInterval(() => {
      if (this.recording) {
        this.emit('recordingState', {
          takeId: opts.takeId,
          state: 'recording',
          elapsedS: (this.sched.now() - startedMs) / 1000,
        });
      }
    }, 100);
    this.recording = { takeId: opts.takeId, durationS: opts.durationS, startedMs, timer, tick };
    this.landmarkRecords.set(opts.takeId, []);
    this.firstSampleNs.set(opts.takeId, BigInt(Math.round(startedMs)) * 1_000_000n);
    if (this.scenario && this.camera) {
      this.takeStartNs = BigInt(Math.round(this.sched.now() * 1e6));
      this.firstSampleNs.set(opts.takeId, this.takeStartNs);
      this.takeFrames = syntheticTake(this.scenario.test, this.scenario.take, {
        fps: this.camera.analysisFps,
        orientation: this.camera.orientation,
      }).frames;
    }
    this.emit('recordingState', { takeId: opts.takeId, state: 'recording', elapsedS: 0 });
    return { startedAtNs: (BigInt(startedMs) * 1_000_000n).toString() };
  }

  async stopRecording(): Promise<RecordingResult> {
    if (!this.recording) throw new Error('not recording');
    return this.finish(true);
  }

  private finish(early: boolean): RecordingResult {
    const rec = this.recording!;
    this.sched.clearTimeout(rec.timer);
    this.sched.clearInterval(rec.tick);
    this.recording = null;
    this.takeFrames = null;
    const durationS = early
      ? Math.min((this.sched.now() - rec.startedMs) / 1000, rec.durationS)
      : rec.durationS;
    const fps = this.actualFps;
    const expected = Math.round(durationS * fps);
    const dropped = Math.round(expected * this.droppedFrac);
    const result: RecordingResult = {
      takeId: rec.takeId,
      createdAt: new Date(this.sched.now()).toISOString(),
      durationS,
      requestedDurationS: rec.durationS,
      durationErrorMs: (durationS - rec.durationS) * 1000,
      stoppedEarly: early,
      frameCount: expected - dropped,
      effectiveFps: Math.min(this.effectiveFps, fps),
      droppedFrames: dropped,
      droppedFrac: expected ? dropped / expected : 0,
      actualFps: fps,
      framesLogged: expected - dropped + 2,
      framesInVideoSpan: expected - dropped,
      mp4: {
        sampleCount: expected - dropped,
        firstRecordIndex: 2,
        maxAbsDiffMs: 0.1,
        p95AbsDiffMs: 0.05,
        unmatchedSamples: 0,
        anchor: 'pattern',
        firstSampleNs: (this.firstSampleNs.get(rec.takeId) ?? 0n).toString(),
      },
      sensorSamples: Math.round(durationS * 200),
      landmarkFrames:
        (this.camera?.trackers.length ?? 0) > 0
          ? Math.round(durationS * (this.camera?.analysisFps ?? 30))
          : null,
      sensorClockOffsetMs: 0,
      stopLeadMs: 110,
      encrypted: true,
      encryptedNotPlayable: true,
      files: {
        video: `capturekit://takes/${rec.takeId}/video.mp4.enc`,
        frames: `capturekit://takes/${rec.takeId}/frames.bin.enc`,
        landmarks: `capturekit://takes/${rec.takeId}/landmarks.bin.enc`,
        sensors: `capturekit://takes/${rec.takeId}/sensors.bin.enc`,
      },
    };
    this.results.set(rec.takeId, result);
    this.emit('recordingState', {
      takeId: rec.takeId,
      state: 'completed',
      elapsedS: durationS,
      result,
    });
    return result;
  }

  async closeCamera(): Promise<void> {
    if (this.recording) this.finish(true);
    if (this.frameTimer !== null) this.sched.clearInterval(this.frameTimer);
    this.frameTimer = null;
    this.camera = null;
  }

  async writeEvidence(opts: {
    takeId: string;
    name: 'quality.json' | 'meta.json';
    json: string;
  }): Promise<void> {
    JSON.parse(opts.json); // reject malformed evidence early, like the native side will
    this.evidence.set(`${opts.takeId}/${opts.name}`, opts.json);
  }

  /** Test helper: read back evidence written with writeEvidence(). */
  readEvidence(takeId: string, name: 'quality.json' | 'meta.json'): string | undefined {
    return this.evidence.get(`${takeId}/${name}`);
  }

  async playTake(opts: { takeId: string }): Promise<{ playerUrl: string }> {
    if (!this.takes.has(opts.takeId)) throw new Error('unknown take');
    this.playing.add(opts.takeId);
    return { playerUrl: `mock://${opts.takeId}/player` };
  }

  async closePlayback(opts: { takeId?: string }): Promise<void> {
    if (opts.takeId) this.playing.delete(opts.takeId);
    else this.playing.clear();
  }

  /** Test helper: takes with an open (decrypted) playback copy. */
  openPlaybacks(): string[] {
    return [...this.playing];
  }

  async listTakes(): Promise<{ takes: StoredTake[] }> {
    return {
      takes: [...this.takes].reverse().map((takeId) => ({
        takeId,
        recovered: false,
        sizeBytes: 0,
        files: [
          'capture.json.enc',
          'datakey.enc',
          'frames.bin.enc',
          'sensors.bin.enc',
          'video.mp4.enc',
        ],
        result: this.results.get(takeId) ?? null,
      })),
    };
  }

  private secure = new Map<string, string>();

  private checkKey(key: string): void {
    if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(key)) throw new Error('invalid key');
  }

  async secureGet(opts: { key: string }): Promise<{ json: string | null }> {
    this.checkKey(opts.key);
    return { json: this.secure.get(opts.key) ?? null };
  }

  async securePut(opts: { key: string; json: string }): Promise<void> {
    this.checkKey(opts.key);
    JSON.parse(opts.json);
    this.secure.set(opts.key, opts.json);
  }

  async secureDelete(opts: { key: string }): Promise<void> {
    this.checkKey(opts.key);
    this.secure.delete(opts.key);
  }

  async secureKeys(opts: { prefix: string }): Promise<{ keys: string[] }> {
    return { keys: [...this.secure.keys()].filter((k) => k.startsWith(opts.prefix)).sort() };
  }

  async clockNow(): Promise<{ elapsedRealtimeNs: string }> {
    return { elapsedRealtimeNs: (BigInt(Math.round(this.sched.now())) * 1_000_000n).toString() };
  }

  async debugArmCrash(_opts: { afterS: number }): Promise<void> {
    // No process to kill in the browser; accepted so the engineering screen works in mock mode.
  }

  async getRecoveredTakes(): Promise<{ takeIds: string[] }> {
    return { takeIds: [] };
  }

  async calibrateSharpness(opts: {
    durationS: number;
  }): Promise<{ baseline: number; frames: number }> {
    if (!this.camera) throw new Error('camera not open');
    const values = this.fixture.frames.map((f) => f.stats.sharpness).sort((a, b) => a - b);
    return {
      baseline: values[Math.floor(values.length / 2)] ?? 0,
      frames: Math.round(opts.durationS * this.fixture.fps),
    };
  }

  async deleteTake(opts: { takeId: string; reason: string }): Promise<void> {
    this.takes.delete(opts.takeId);
    this.results.delete(opts.takeId);
    this.playing.delete(opts.takeId);
    this.landmarkRecords.delete(opts.takeId);
    this.firstSampleNs.delete(opts.takeId);
    for (const k of [...this.evidence.keys()])
      if (k.startsWith(`${opts.takeId}/`)) this.evidence.delete(k);
    this.jobs.delete(opts.takeId);
  }

  // ── Uploads (M7): the real protocol client against an in-memory fake server ──────────────

  /** Mock only: the fake API the uploads talk to (tests can drop the network or corrupt a part). */
  readonly fakeServer = new FakeServer();
  private uploadCfg: UploadConfig | null = null;
  private jobs = new Map<string, { job: UploadJob; status: UploadStatus; attempts: number }>();
  private closes = new Map<string, string>();
  private uploading = false;
  private retryTimer: unknown = null;

  async configureUploads(opts: UploadConfig): Promise<void> {
    this.uploadCfg = { ...opts };
    for (const j of this.jobs.values())
      if (j.status.reason === 'login_required')
        this.setUpload(j, { state: 'queued', reason: undefined });
    this.kickUploads();
  }

  async clearUploadCredentials(): Promise<void> {
    this.uploadCfg = null;
  }

  async enqueueUpload(opts: {
    takeId: string;
    clientSessionId: string;
    session: string;
    take: string;
  }): Promise<void> {
    if (!this.takes.has(opts.takeId)) throw new Error('unknown take');
    if (this.jobs.has(opts.takeId)) return; // idempotent
    const files = this.mockFiles(opts.takeId);
    this.jobs.set(opts.takeId, {
      job: {
        takeId: opts.takeId,
        clientSessionId: opts.clientSessionId,
        session: opts.session,
        take: opts.take,
        wrappedDataKey: 'bW9jay13cmFwcGVkLWtleQ==',
        keyId: this.uploadCfg?.serverKeyId ?? 'mock',
      },
      status: {
        takeId: opts.takeId,
        state: 'queued',
        bytesSent: 0,
        bytesTotal: files.kinds.reduce((a, k) => a + files.size(k), 0),
      },
      attempts: 0,
    });
    this.emit('uploadProgress', this.jobs.get(opts.takeId)!.status);
    this.kickUploads();
  }

  async enqueueSessionClose(opts: { clientSessionId: string; body: string }): Promise<void> {
    this.closes.set(opts.clientSessionId, opts.body);
    this.kickUploads();
  }

  async getUploadStatus(opts: { takeId: string }): Promise<UploadStatus> {
    return (
      this.jobs.get(opts.takeId)?.status ?? {
        takeId: opts.takeId,
        state: 'failed_permanent',
        bytesSent: 0,
        bytesTotal: 0,
        reason: 'unknown take',
      }
    );
  }

  async listUploads(): Promise<{ uploads: UploadStatus[] }> {
    return { uploads: [...this.jobs.values()].map((j) => j.status) };
  }

  async retryUploads(): Promise<void> {
    for (const j of this.jobs.values())
      if (j.status.state === 'failed_retryable' || j.status.state === 'failed_permanent') {
        j.attempts = 0;
        this.setUpload(j, { state: 'queued', reason: undefined });
      }
    this.kickUploads();
  }

  /** Mock only: simulate losing / regaining the network. */
  setNetwork(online: boolean): void {
    this.fakeServer.online = online;
    if (online) this.kickUploads();
  }

  private setUpload(j: { status: UploadStatus }, patch: Partial<UploadStatus>): void {
    j.status = { ...j.status, ...patch };
    this.emit('uploadProgress', j.status);
  }

  /** Deterministic stand-ins for the encrypted take files (video + evidence). */
  private mockFiles(takeId: string) {
    let h = 0;
    for (const c of takeId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const enc = new TextEncoder();
    const data = new Map<string, Uint8Array>();
    const video = new Uint8Array(200_000);
    for (let i = 0; i < video.length; i++) video[i] = (h + i * 7) & 0xff;
    data.set('video', video);
    for (const kind of ['quality', 'meta'] as const) {
      const json = this.evidence.get(`${takeId}/${kind}.json`);
      if (json) data.set(kind, enc.encode(json));
    }
    return {
      kinds: [...data.keys()],
      size: (k: string) => data.get(k)!.length,
      sha256: (k: string) => sha256Hex(data.get(k)!),
      read: async (k: string, off: number, len: number) => data.get(k)!.slice(off, off + len),
    };
  }

  private kickUploads(): void {
    if (this.uploading) return;
    this.uploading = true;
    this.sched.setTimeout(() => void this.runUploads(), 0);
  }

  private async runUploads(): Promise<void> {
    try {
      const cfg = this.uploadCfg;
      for (const j of this.jobs.values()) {
        if (j.status.state === 'completed' || j.status.state === 'failed_permanent') continue;
        if (!cfg) {
          this.setUpload(j, { state: 'paused', reason: 'login_required' });
          continue;
        }
        const client = new UploadClient(
          this.fakeServer.http,
          cfg.endpoint,
          { access: cfg.accessToken, refresh: cfg.refreshToken },
          (t) => {
            cfg.accessToken = t.access;
            cfg.refreshToken = t.refresh;
          },
        );
        this.setUpload(j, { state: 'uploading', reason: undefined });
        try {
          const { confirmedAt, job } = await client.run(
            j.job,
            this.mockFiles(j.job.takeId),
            (sent, total) => this.setUpload(j, { bytesSent: sent, bytesTotal: total }),
          );
          j.job = job;
          this.setUpload(j, { state: 'completed', confirmedAt });
        } catch (e) {
          const err = e as UploadError;
          if (err.kind === 'auth') this.setUpload(j, { state: 'paused', reason: 'login_required' });
          else if (err.kind === 'permanent')
            this.setUpload(j, { state: 'failed_permanent', reason: err.message });
          else {
            j.attempts++;
            this.setUpload(j, { state: 'failed_retryable', reason: 'network' });
          }
        }
      }
      // Close sessions whose takes are all uploaded.
      if (cfg)
        for (const [clientSessionId, body] of this.closes) {
          const mine = [...this.jobs.values()].filter(
            (j) => j.job.clientSessionId === clientSessionId,
          );
          const sid = mine.find((j) => j.job.serverSessionId)?.job.serverSessionId;
          if (!sid || mine.some((j) => j.status.state !== 'completed')) continue;
          try {
            await new UploadClient(
              this.fakeServer.http,
              cfg.endpoint,
              { access: cfg.accessToken, refresh: cfg.refreshToken },
              () => undefined,
            ).closeSession(sid, body);
            this.closes.delete(clientSessionId);
          } catch {
            /* retried on the next run */
          }
        }
      this.applyRetention();
    } finally {
      this.uploading = false;
    }
    // Exponential backoff for network failures (capped at 24 h, §15).
    const waiting = [...this.jobs.values()].filter((j) => j.status.state === 'failed_retryable');
    if (waiting.length && !this.retryTimer) {
      const attempts = Math.max(...waiting.map((j) => j.attempts));
      const delay = Math.min(24 * 3600_000, 2000 * 2 ** (attempts - 1));
      this.retryTimer = this.sched.setTimeout(() => {
        this.retryTimer = null;
        this.kickUploads();
      }, delay);
    }
  }

  /** Delete local copies retentionHours after server confirmation (§14). */
  private applyRetention(): void {
    const hours = this.uploadCfg?.retentionHours;
    if (hours === undefined) return;
    for (const j of this.jobs.values()) {
      if (j.status.state !== 'completed' || j.status.localDeleted || !j.status.confirmedAt)
        continue;
      if (Date.parse(j.status.confirmedAt) + hours * 3600_000 <= Date.now()) {
        this.takes.delete(j.job.takeId);
        this.results.delete(j.job.takeId);
        this.setUpload(j, { localDeleted: true });
      }
    }
  }

  async addListener<E extends CaptureKitEventName>(
    eventName: E,
    listenerFunc: (event: CaptureKitEvents[E]) => void,
  ): Promise<PluginListenerHandle> {
    let set = this.listeners.get(eventName);
    if (!set) this.listeners.set(eventName, (set = new Set()));
    const fn = listenerFunc as (e: never) => void;
    set.add(fn);
    return { remove: async () => void set.delete(fn) };
  }

  async removeAllListeners(): Promise<void> {
    this.listeners.clear();
  }

  protected emit<E extends CaptureKitEventName>(eventName: E, event: CaptureKitEvents[E]): void {
    for (const fn of this.listeners.get(eventName) ?? [])
      (fn as (e: CaptureKitEvents[E]) => void)(event);
  }
}
