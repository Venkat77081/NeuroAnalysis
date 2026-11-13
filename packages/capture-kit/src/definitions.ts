/**
 * CaptureKit plugin contract (DEV_PLAN §5.3). Shared by NativeCaptureKit (Android/iOS),
 * MockCaptureKit (browser/Node) and WebcamCaptureKit (browser demo, M4).
 */
import type { PluginListenerHandle } from '@capacitor/core';
import type { BenchmarkReport } from '@neurocapture/contracts-ts/types';

export type { PluginListenerHandle, BenchmarkReport };

export type Facing = 'back' | 'front';
export type Resolution = '1080p' | '720p';
export type Orientation = 'portrait' | 'landscape';
export type TrackerName = 'hand' | 'pose' | 'face';
export type Tier = 'A' | 'B' | 'C' | 'W';
export type Implementation = 'native' | 'mock' | 'webcam';
export type TimestampSource = 'REALTIME' | 'UNKNOWN' | 'SIMULATED';

export interface DeviceCapabilities {
  implementation: Implementation;
  pluginVersion: string;
  device: {
    manufacturer: string;
    model: string;
    osName: 'android' | 'ios' | 'web';
    osVersion: string;
  };
  cameras: {
    facing: Facing;
    maxFps: Partial<Record<Resolution, number>>;
    timestampSource: TimestampSource;
    supportsLock: { ae: boolean; af: boolean; awb: boolean };
  }[];
  gpuDelegate: boolean;
}

export interface BenchmarkOpts {
  facing: Facing;
  resolution: Resolution;
  targetFps: 60 | 30;
  /** Continuous recording phase (10 min for a real qualification). */
  recordMinutes: number;
  /** Thermal phase: keep recording in segments while watching fps and thermal status (30 min). */
  thermalMinutes: number;
}

export interface BenchmarkProgressEvent {
  phase: 'calibrating' | 'recording' | 'thermal' | 'done' | 'cancelled' | 'error';
  elapsedS: number;
  totalS: number;
  /** Frames per second over the last second of recording, when recording. */
  liveFps?: number;
  thermalStatus?: string;
  message?: string;
}

export interface OpenCameraOpts {
  facing: Facing;
  resolution: Resolution;
  targetFps: 60 | 30;
  orientation: Orientation;
  trackers: TrackerName[];
  analysisFps: number;
  /** Record at this rate when targetFps is unsupported (interim policy, decision 007). */
  fallbackFps?: 30;
  /** Engineering only: sleep this long in every analysis frame (M2 isolation test). */
  debugAnalysisDelayMs?: number;
}

/** Maps normalized analysis coordinates to on-screen CSS pixels for overlay drawing. */
export interface PreviewTransform {
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
  rotationDeg: 0 | 90 | 180 | 270;
  mirrored: boolean;
}

export interface Mp4Alignment {
  sampleCount: number;
  /** MP4 sample j ↔ frames.bin record j + firstRecordIndex. */
  firstRecordIndex: number;
  maxAbsDiffMs: number;
  p95AbsDiffMs: number;
  /** MP4 samples with no logged frame within half a frame period (decision 009). */
  unmatchedSamples: number;
  anchor: 'pattern' | 'earliest_candidate';
}

export interface RecordingResult {
  takeId: string;
  /** ISO date-time when the take was finalized. */
  createdAt: string;
  durationS: number;
  requestedDurationS: number;
  /** durationS − requestedDurationS, in ms (M2: within ±50 ms). */
  durationErrorMs: number;
  /** True when stopRecording() ended the take before durationS (decision 002). */
  stoppedEarly: boolean;
  frameCount: number;
  effectiveFps: number;
  droppedFrames: number;
  droppedFrac: number;
  /** Frame rate the camera ran at (60, or 30 after fallback). */
  actualFps: 60 | 30;
  /** Capture-session frames written to frames.bin. */
  framesLogged: number;
  /** Logged frames inside the MP4's time span; M2 requires |framesInVideoSpan − mp4.sampleCount| ≤ 1. */
  framesInVideoSpan: number | null;
  mp4: Mp4Alignment | null;
  sensorSamples: number;
  sensorClockOffsetMs: number | null;
  /** How early stop() was called before durationS for this take (learned per device, decision 010). */
  stopLeadMs?: number | null;
  /** Video, frames and sensors are stored encrypted; plaintext deleted. */
  encrypted: boolean;
  /** The encrypted video file was checked and does not open as a video. */
  encryptedNotPlayable: boolean | null;
  files: { video: string; frames: string; landmarks: string; sensors: string };
}

export interface StoredTake {
  takeId: string;
  /** Found as plaintext after a crash and encrypted at the next start (RetainedForRecovery). */
  recovered: boolean;
  sizeBytes: number;
  files: string[];
  /** Saved capture result; null for takes interrupted before finalize. */
  result: RecordingResult | null;
}

export type UploadState =
  'queued' | 'uploading' | 'paused' | 'failed_retryable' | 'failed_permanent' | 'completed';

export interface UploadStatus {
  takeId: string;
  state: UploadState;
  bytesSent: number;
  bytesTotal: number;
  reason?: string;
}

export interface AnalysisFrameEvent {
  seq: number;
  /** Canonical clock (§5.6), as a string to keep 64-bit precision. */
  tsNs: string;
  imageW: number;
  imageH: number;
  /** lm = base64 Float32[21*4] (x, y, z, visibility) */
  hands?: { handedness: 'Left' | 'Right'; score: number; lm: string }[];
  /** lm = base64 Float32[33*4] */
  pose?: { lm: string };
  /** lm = base64 Float32[478*3] */
  face?: { lm: string; blendshapes?: string; yawDeg: number; pitchDeg: number; rollDeg: number };
  stats: { lumaMean: number; clippedFrac: number; sharpness: number; faceLumaRatio?: number };
  trackerStatus: Record<TrackerName, 'ok' | 'no_result' | 'error' | 'off'>;
}

export interface SensorSample {
  type: 'gyro' | 'gravity';
  tsNs: string;
  x: number;
  y: number;
  z: number;
}

export interface SensorBatchEvent {
  samples: SensorSample[];
}

export interface RecordingStateEvent {
  takeId: string;
  state: 'recording' | 'completed' | 'interrupted' | 'error';
  elapsedS: number;
  /** Present when state is 'completed' (timer reached durationS, or stopped early). */
  result?: RecordingResult;
  reason?: string;
}

export interface ThermalEvent {
  status: 'none' | 'light' | 'moderate' | 'severe' | 'critical' | 'emergency' | 'shutdown';
}

export type UploadProgressEvent = UploadStatus;

export interface CaptureKitEvents {
  analysisFrame: AnalysisFrameEvent;
  sensorBatch: SensorBatchEvent;
  recordingState: RecordingStateEvent;
  thermal: ThermalEvent;
  uploadProgress: UploadProgressEvent;
  benchmarkProgress: BenchmarkProgressEvent;
}

export type CaptureKitEventName = keyof CaptureKitEvents;

export interface CaptureKitPlugin {
  getCapabilities(): Promise<DeviceCapabilities>;
  /** Raw measurements; the tier is assigned in TypeScript (quality-core assignTier). */
  runQualificationBenchmark(opts: BenchmarkOpts): Promise<BenchmarkReport>;
  cancelBenchmark(): Promise<void>;
  /** Writes a report to app-specific external storage (adb pull …/files/qualification/). Returns the file name. */
  saveQualificationReport(opts: { fileName: string; json: string }): Promise<{ fileName: string }>;

  openCamera(
    opts: OpenCameraOpts,
  ): Promise<{ previewTransform: PreviewTransform; actualFps: number }>;
  lockCameraSettings(opts: { ae: boolean; af: boolean; awb: boolean }): Promise<void>;
  /** The native side stops recording at durationS on its own timer, independent of JS (decision 002). */
  startRecording(opts: { takeId: string; durationS: number }): Promise<{ startedAtNs: string }>;
  /** Early stop by the operator. */
  stopRecording(): Promise<RecordingResult>;
  closeCamera(): Promise<void>;

  writeEvidence(opts: {
    takeId: string;
    name: 'quality.json' | 'meta.json';
    json: string;
  }): Promise<void>;
  /** Decrypts into a temporary in-app file; always call closePlayback when the player closes. */
  playTake(opts: { takeId: string }): Promise<{ playerUrl: string }>;
  closePlayback(opts: { takeId?: string }): Promise<void>;
  /** Takes found as plaintext after a crash at the last start, now encrypted and marked RetainedForRecovery. */
  getRecoveredTakes(): Promise<{ takeIds: string[] }>;
  /** Median Laplacian-variance sharpness over durationS of a static target (device baseline, §9.2). */
  calibrateSharpness(opts: { durationS: number }): Promise<{ baseline: number; frames: number }>;
  /** Stored takes on this device, newest first (survives app restarts). */
  listTakes(): Promise<{ takes: StoredTake[] }>;
  /** Encrypted key–value store for app data (keys: [a-z0-9][a-z0-9._-]*, values: JSON text). Decision 011. */
  secureGet(opts: { key: string }): Promise<{ json: string | null }>;
  securePut(opts: { key: string; json: string }): Promise<void>;
  secureDelete(opts: { key: string }): Promise<void>;
  secureKeys(opts: { prefix: string }): Promise<{ keys: string[] }>;
  /** Engineering only (M2 crash test): the next take kills the app after afterS seconds. */
  debugArmCrash(opts: { afterS: number }): Promise<void>;
  deleteTake(opts: { takeId: string; reason: string }): Promise<void>;

  enqueueUpload(opts: {
    takeId: string;
    sessionId: string;
    endpoint: string;
    token: string;
  }): Promise<void>;
  getUploadStatus(opts: { takeId: string }): Promise<UploadStatus>;

  addListener<E extends CaptureKitEventName>(
    eventName: E,
    listenerFunc: (event: CaptureKitEvents[E]) => void,
  ): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}
