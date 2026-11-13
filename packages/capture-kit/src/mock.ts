import type {
  BenchmarkOpts,
  BenchmarkReport,
  CaptureKitEventName,
  CaptureKitEvents,
  CaptureKitPlugin,
  DeviceCapabilities,
  OpenCameraOpts,
  PluginListenerHandle,
  PreviewTransform,
  RecordingResult,
  UploadStatus,
} from './definitions.ts';
import type { CaptureFixture } from './fixture.ts';
import { PLUGIN_VERSION } from './version.ts';

export interface Scheduler {
  now(): number; // ms
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
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
  private uploads = new Map<string, UploadStatus>();

  constructor(opts: MockOptions) {
    this.fixture = opts.fixture;
    this.sched = opts.scheduler ?? realScheduler;
    this.effectiveFps = opts.effectiveFps ?? 59.8;
    this.droppedFrac = opts.droppedFrac ?? 0.004;
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

  async runQualificationBenchmark(_opts: BenchmarkOpts): Promise<BenchmarkReport> {
    const caps = await this.getCapabilities();
    return {
      device: caps.device,
      ranAt: new Date(this.sched.now()).toISOString(),
      effectiveFps: this.effectiveFps,
      droppedFrac: this.droppedFrac,
      analysisFps: this.fixture.fps,
      timestampSource: 'SIMULATED',
      offsetSpreadMs: null,
      thermalFpsDrop: false,
      lockSupported: true,
      tier: 'W',
    };
  }

  async openCamera(
    opts: OpenCameraOpts,
  ): Promise<{ previewTransform: PreviewTransform; actualFps: number }> {
    if (this.camera) throw new Error('camera already open');
    this.camera = opts;
    this.startNs = BigInt(this.sched.now()) * 1_000_000n;
    this.frameIdx = 0;
    const periodMs = 1000 / Math.min(opts.analysisFps, this.fixture.fps);
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
      actualFps: opts.targetFps,
    };
  }

  private emitNextFrame(): void {
    const frames = this.fixture.frames;
    if (!frames.length) return;
    const src = frames[this.frameIdx % frames.length]!;
    const loop = BigInt(Math.floor(this.frameIdx / frames.length));
    const loopNs = BigInt(Math.round(this.fixture.durationS * 1e9)) * loop;
    this.frameIdx++;
    this.emit('analysisFrame', {
      ...src,
      seq: this.seq++,
      tsNs: (this.startNs + loopNs + BigInt(src.tsNs)).toString(),
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
    const durationS = early
      ? Math.min((this.sched.now() - rec.startedMs) / 1000, rec.durationS)
      : rec.durationS;
    const expected = Math.round(durationS * 60);
    const dropped = Math.round(expected * this.droppedFrac);
    const result: RecordingResult = {
      takeId: rec.takeId,
      durationS,
      stoppedEarly: early,
      frameCount: expected - dropped,
      effectiveFps: this.effectiveFps,
      droppedFrames: dropped,
      droppedFrac: expected ? dropped / expected : 0,
      files: {
        video: `mock://${rec.takeId}/video.mp4.enc`,
        frames: `mock://${rec.takeId}/frames.bin.enc`,
        landmarks: `mock://${rec.takeId}/landmarks.bin.enc`,
        sensors: `mock://${rec.takeId}/sensors.bin.enc`,
      },
    };
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
    return { playerUrl: `mock://${opts.takeId}/player` };
  }

  async deleteTake(opts: { takeId: string; reason: string }): Promise<void> {
    for (const k of [...this.evidence.keys()])
      if (k.startsWith(`${opts.takeId}/`)) this.evidence.delete(k);
    this.uploads.delete(opts.takeId);
  }

  async enqueueUpload(opts: {
    takeId: string;
    sessionId: string;
    endpoint: string;
    token: string;
  }): Promise<void> {
    const status: UploadStatus = {
      takeId: opts.takeId,
      state: 'queued',
      bytesSent: 0,
      bytesTotal: 1,
    };
    this.uploads.set(opts.takeId, status);
    this.emit('uploadProgress', status);
  }

  async getUploadStatus(opts: { takeId: string }): Promise<UploadStatus> {
    return (
      this.uploads.get(opts.takeId) ?? {
        takeId: opts.takeId,
        state: 'failed_permanent',
        bytesSent: 0,
        bytesTotal: 0,
        reason: 'unknown take',
      }
    );
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

  private emit<E extends CaptureKitEventName>(eventName: E, event: CaptureKitEvents[E]): void {
    for (const fn of this.listeners.get(eventName) ?? [])
      (fn as (e: CaptureKitEvents[E]) => void)(event);
  }
}
