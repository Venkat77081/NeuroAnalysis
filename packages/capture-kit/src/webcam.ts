/**
 * WebcamCaptureKit — browser demo mode (Tier W, never clinical; DEV_PLAN §5.3). Laptop/phone webcam
 * via getUserMedia, shown behind the page like the native preview; MediaPipe Tasks for Web for
 * hand/pose/face; MediaRecorder for takes (WebM, not encrypted). Everything else (store, takes list,
 * benchmark) comes from MockCaptureKit. Timestamps use performance.now() as the "canonical" clock.
 */
import type {
  FaceLandmarker,
  FaceLandmarkerResult,
  HandLandmarker,
  HandLandmarkerResult,
  PoseLandmarker,
  PoseLandmarkerResult,
} from '@mediapipe/tasks-vision';
import type {
  AnalysisFrameEvent,
  DeviceCapabilities,
  OpenCameraOpts,
  PreviewTransform,
  RecordingResult,
  StoredTake,
} from './definitions.ts';
import { encodeFloat32 } from './codec.ts';
import { faceAngles, faceLumaRatio, frameStats } from './frame-math.ts';
import { MockCaptureKit, type MockOptions } from './mock.ts';
import { PLUGIN_VERSION } from './version.ts';

interface Trackers {
  hand?: HandLandmarker;
  pose?: PoseLandmarker;
  face?: FaceLandmarker;
}

const nowNs = () => BigInt(Math.round(performance.now() * 1e6));

export class WebcamCaptureKit extends MockCaptureKit {
  private readonly base: string;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private trackers: Trackers = {};
  private loop: ReturnType<typeof setInterval> | null = null;
  private opened: OpenCameraOpts | null = null;
  private wseq = 0;
  private lastMs = 0;
  private recorder: MediaRecorder | null = null;
  private rec: {
    takeId: string;
    durationS: number;
    started: number;
    timer: ReturnType<typeof setTimeout>;
    tick: ReturnType<typeof setInterval>;
    early: boolean;
  } | null = null;
  private stored = new Map<string, { url: string; result: RecordingResult }>();

  constructor(opts: MockOptions & { assetBase?: string }) {
    super(opts);
    this.base = opts.assetBase ?? './mediapipe';
  }

  override async getCapabilities(): Promise<DeviceCapabilities> {
    return {
      implementation: 'webcam',
      pluginVersion: PLUGIN_VERSION,
      device: { manufacturer: 'browser', model: 'webcam', osName: 'web', osVersion: 'n/a' },
      cameras: [
        {
          facing: 'front',
          maxFps: { '720p': 30 },
          timestampSource: 'SIMULATED',
          supportsLock: { ae: false, af: false, awb: false },
        },
      ],
      gpuDelegate: false,
    };
  }

  override async clockNow(): Promise<{ elapsedRealtimeNs: string }> {
    return { elapsedRealtimeNs: nowNs().toString() };
  }

  private async loadTrackers(names: string[]): Promise<void> {
    if (!names.length) return;
    const mp = await import('@mediapipe/tasks-vision');
    const fileset = await mp.FilesetResolver.forVisionTasks(`${this.base}/wasm`);
    const forced = this.opened?.trackerDelegate;
    const make = async <T>(create: (delegate: 'GPU' | 'CPU') => Promise<T>): Promise<T> => {
      if (forced === 'cpu') return create('CPU');
      if (forced === 'gpu' || forced === 'mixed') return create('GPU');
      try {
        return await create('GPU');
      } catch {
        return create('CPU');
      }
    };
    if (names.includes('hand')) {
      this.trackers.hand = await make((delegate) =>
        mp.HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: `${this.base}/hand_landmarker.task`, delegate },
          runningMode: 'VIDEO',
          numHands: 2,
        }),
      );
    }
    if (names.includes('pose')) {
      this.trackers.pose = await make((delegate) =>
        mp.PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: `${this.base}/pose_landmarker_lite.task`, delegate },
          runningMode: 'VIDEO',
          numPoses: 2,
        }),
      );
    }
    if (names.includes('face')) {
      this.trackers.face = await make((delegate) =>
        mp.FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: `${this.base}/face_landmarker.task`, delegate },
          runningMode: 'VIDEO',
          numFaces: 2,
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: true,
        }),
      );
    }
  }

  override async openCamera(
    opts: OpenCameraOpts,
  ): Promise<{ previewTransform: PreviewTransform; actualFps: number }> {
    if (this.stream) throw new Error('camera already open');
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: opts.facing === 'front' ? 'user' : 'environment',
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: opts.targetFps },
      },
      audio: false,
    });
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.srcObject = this.stream;
    v.setAttribute('data-capturekit-preview', '');
    Object.assign(v.style, {
      position: 'fixed',
      inset: '0',
      width: '100%',
      height: '100%',
      objectFit: 'cover',
      zIndex: '-1',
      transform: opts.facing === 'front' ? 'scaleX(-1)' : '',
    });
    document.body.prepend(v);
    await v.play();
    this.video = v;
    this.opened = opts;
    this.canvas = document.createElement('canvas');
    await this.loadTrackers(opts.trackers);
    this.loop = setInterval(() => this.analyze(), 1000 / Math.max(1, opts.analysisFps));
    const settings = this.stream.getVideoTracks()[0]?.getSettings() ?? {};
    const actualFps = (settings.frameRate ?? 30) >= 50 ? 60 : 30;
    return { previewTransform: this.transform(), actualFps };
  }

  private transform(): PreviewTransform {
    const v = this.video!;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const s = Math.max(vw / (v.videoWidth || vw), vh / (v.videoHeight || vh));
    const dw = (v.videoWidth || vw) * s;
    const dh = (v.videoHeight || vh) * s;
    return {
      scaleX: dw,
      scaleY: dh,
      offsetX: (vw - dw) / 2,
      offsetY: (vh - dh) / 2,
      rotationDeg: 0,
      mirrored: this.opened?.facing === 'front',
    };
  }

  private analyze(): void {
    const v = this.video;
    const c = this.canvas;
    if (!v || !c || v.readyState < 2 || !v.videoWidth) return;
    const t0 = performance.now();
    const ms = Math.max(Math.round(t0), this.lastMs + 1);
    this.lastMs = ms;
    const tsNs = nowNs();
    const w = 160;
    const h = Math.max(1, Math.round((v.videoHeight / v.videoWidth) * w));
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(v, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    const on = new Set(this.opened?.trackers ?? []);
    let hand: HandLandmarkerResult | null = null;
    let pose: PoseLandmarkerResult | null = null;
    let face: FaceLandmarkerResult | null = null;
    const status = {
      hand: on.has('hand') ? 'error' : 'off',
      pose: on.has('pose') ? 'error' : 'off',
      face: on.has('face') ? 'error' : 'off',
    } as AnalysisFrameEvent['trackerStatus'];
    try {
      if (this.trackers.hand) {
        hand = this.trackers.hand.detectForVideo(v, ms);
        status.hand = hand.landmarks.length ? 'ok' : 'no_result';
      }
    } catch {
      /* stays 'error' */
    }
    try {
      if (this.trackers.pose) {
        pose = this.trackers.pose.detectForVideo(v, ms);
        status.pose = pose.landmarks.length ? 'ok' : 'no_result';
      }
    } catch {
      /* stays 'error' */
    }
    try {
      if (this.trackers.face) {
        face = this.trackers.face.detectForVideo(v, ms);
        status.face = face.faceLandmarks.length ? 'ok' : 'no_result';
      }
    } catch {
      /* stays 'error' */
    }
    const facePts = face?.faceLandmarks[0]
      ? Float32Array.from(face.faceLandmarks[0].flatMap((p) => [p.x, p.y, p.z]))
      : null;
    const angles = face?.facialTransformationMatrixes?.[0]
      ? faceAngles(face.facialTransformationMatrixes[0].data)
      : { yawDeg: 0, pitchDeg: 0, rollDeg: 0 };
    const ratio = facePts ? faceLumaRatio(px, w, h, facePts) : null;
    const event: AnalysisFrameEvent = {
      seq: this.wseq++,
      tsNs: tsNs.toString(),
      imageW: v.videoWidth,
      imageH: v.videoHeight,
      ...(hand?.landmarks.length
        ? {
            hands: hand.landmarks.map((lms, i) => ({
              handedness: (hand!.handedness[i]?.[0]?.categoryName === 'Right'
                ? 'Right'
                : 'Left') as 'Left' | 'Right',
              score: hand!.handedness[i]?.[0]?.score ?? 0,
              lm: encodeFloat32(lms.flatMap((p) => [p.x, p.y, p.z, p.visibility ?? 1])),
            })),
          }
        : {}),
      ...(pose?.landmarks[0]
        ? {
            pose: {
              lm: encodeFloat32(
                pose.landmarks[0].flatMap((p) => [p.x, p.y, p.z, p.visibility ?? 0]),
              ),
            },
          }
        : {}),
      ...(facePts
        ? {
            face: {
              lm: encodeFloat32(facePts),
              ...(face?.faceBlendshapes?.[0]
                ? {
                    blendshapes: encodeFloat32(
                      face.faceBlendshapes[0].categories.map((cat) => cat.score),
                    ),
                  }
                : {}),
              ...angles,
            },
          }
        : {}),
      stats: { ...frameStats(px, w, h), ...(ratio !== null ? { faceLumaRatio: ratio } : {}) },
      trackerStatus: status,
      counts: {
        hands: hand?.landmarks.length ?? 0,
        poses: pose?.landmarks.length ?? 0,
        faces: face?.faceLandmarks.length ?? 0,
      },
      emitNs: nowNs().toString(),
      procMs: performance.now() - t0,
    };
    this.emit('analysisFrame', event);
  }

  override async startRecording(opts: {
    takeId: string;
    durationS: number;
  }): Promise<{ startedAtNs: string }> {
    if (!this.stream) throw new Error('camera not open');
    if (this.rec) throw new Error('already recording');
    const recorder = new MediaRecorder(this.stream);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = () =>
      this.finalize(new Blob(chunks, { type: recorder.mimeType || 'video/webm' }));
    recorder.start(250);
    this.recorder = recorder;
    const started = performance.now();
    const tick = setInterval(
      () =>
        this.emit('recordingState', {
          takeId: opts.takeId,
          state: 'recording',
          elapsedS: (performance.now() - started) / 1000,
        }),
      200,
    );
    const timer = setTimeout(() => this.stop(false), opts.durationS * 1000);
    this.rec = {
      takeId: opts.takeId,
      durationS: opts.durationS,
      started,
      timer,
      tick,
      early: false,
    };
    this.emit('recordingState', { takeId: opts.takeId, state: 'recording', elapsedS: 0 });
    return { startedAtNs: nowNs().toString() };
  }

  private stop(early: boolean): void {
    if (!this.rec || !this.recorder) return;
    clearTimeout(this.rec.timer);
    clearInterval(this.rec.tick);
    this.rec.early = early;
    this.recorder.stop();
  }

  private pendingStop: ((r: RecordingResult) => void) | null = null;

  override stopRecording(): Promise<RecordingResult> {
    if (!this.rec) return Promise.reject(new Error('not recording'));
    return new Promise((resolve) => {
      this.pendingStop = resolve;
      this.stop(true);
    });
  }

  private finalize(blob: Blob): void {
    const rec = this.rec!;
    this.rec = null;
    this.recorder = null;
    const durationS = rec.early
      ? Math.min((performance.now() - rec.started) / 1000, rec.durationS)
      : rec.durationS;
    const fps = 30;
    const result: RecordingResult = {
      takeId: rec.takeId,
      createdAt: new Date().toISOString(),
      durationS,
      requestedDurationS: rec.durationS,
      durationErrorMs: (durationS - rec.durationS) * 1000,
      stoppedEarly: rec.early,
      frameCount: Math.round(durationS * fps),
      effectiveFps: fps,
      droppedFrames: 0,
      droppedFrac: 0,
      actualFps: fps,
      framesLogged: 0,
      framesInVideoSpan: null,
      mp4: null,
      sensorSamples: 0,
      sensorClockOffsetMs: null,
      landmarkFrames: null,
      encrypted: false,
      encryptedNotPlayable: null,
      files: { video: `webcam://${rec.takeId}/video.webm`, frames: '', landmarks: '', sensors: '' },
    };
    this.stored.set(rec.takeId, { url: URL.createObjectURL(blob), result });
    this.emit('recordingState', {
      takeId: rec.takeId,
      state: 'completed',
      elapsedS: durationS,
      result,
    });
    this.pendingStop?.(result);
    this.pendingStop = null;
  }

  override async playTake(opts: { takeId: string }): Promise<{ playerUrl: string }> {
    const s = this.stored.get(opts.takeId);
    if (!s) throw new Error('unknown take');
    return { playerUrl: s.url };
  }

  override async readLandmarks(): Promise<{ data: string | null }> {
    return { data: null }; // webcam takes keep no landmarks.bin
  }

  override async closePlayback(): Promise<void> {
    /* object URLs live until deleteTake */
  }

  override async listTakes(): Promise<{ takes: StoredTake[] }> {
    return {
      takes: [...this.stored.entries()].reverse().map(([takeId, s]) => ({
        takeId,
        recovered: false,
        sizeBytes: 0,
        files: ['video.webm'],
        result: s.result,
      })),
    };
  }

  override async deleteTake(opts: { takeId: string; reason: string }): Promise<void> {
    const s = this.stored.get(opts.takeId);
    if (s) URL.revokeObjectURL(s.url);
    this.stored.delete(opts.takeId);
  }

  override async lockCameraSettings(): Promise<void> {
    if (!this.stream) throw new Error('camera not open');
  }

  override async calibrateSharpness(opts: {
    durationS: number;
  }): Promise<{ baseline: number; frames: number }> {
    if (!this.video) throw new Error('camera not open');
    const values: number[] = [];
    const h = await this.addListener('analysisFrame', (e) => values.push(e.stats.sharpness));
    await new Promise((r) => setTimeout(r, opts.durationS * 1000));
    await h.remove();
    values.sort((a, b) => a - b);
    return { baseline: values[Math.floor(values.length / 2)] ?? 0, frames: values.length };
  }

  override async closeCamera(): Promise<void> {
    if (this.rec) this.stop(true);
    if (this.loop) clearInterval(this.loop);
    this.loop = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video?.remove();
    this.video = null;
    for (const t of Object.values(this.trackers)) t?.close();
    this.trackers = {};
    this.opened = null;
  }
}
