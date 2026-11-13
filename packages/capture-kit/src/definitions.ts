/**
 * CaptureKit plugin contract (DEV_PLAN §5.3). Shared by NativeCaptureKit (Android/iOS),
 * MockCaptureKit (browser/Node) and WebcamCaptureKit (browser demo, M4).
 */
import type { PluginListenerHandle } from '@capacitor/core';

export type { PluginListenerHandle };

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
  device: { manufacturer: string; model: string; osName: 'android' | 'ios' | 'web'; osVersion: string };
  cameras: {
    facing: Facing;
    maxFps: Partial<Record<Resolution, number>>;
    timestampSource: TimestampSource;
    supportsLock: { ae: boolean; af: boolean; awb: boolean };
  }[];
  gpuDelegate: boolean;
}

export interface BenchmarkOpts {
  resolution: Resolution;
  targetFps: 60 | 30;
  recordMinutes: number; // 10 in M1
  thermalMinutes: number; // 30 in M1
}

export interface BenchmarkReport {
  device: DeviceCapabilities['device'];
  ranAt: string; // ISO date-time
  effectiveFps: number;
  droppedFrac: number;
  analysisFps: number;
  timestampSource: TimestampSource;
  offsetSpreadMs: number | null;
  thermalFpsDrop: boolean;
  lockSupported: boolean;
  tier: Tier;
}

export interface OpenCameraOpts {
  facing: Facing;
  resolution: Resolution;
  targetFps: 60 | 30;
  orientation: Orientation;
  trackers: TrackerName[];
  analysisFps: number;
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

export interface RecordingResult {
  takeId: string;
  durationS: number;
  /** True when stopRecording() ended the take before durationS (decision 002). */
  stoppedEarly: boolean;
  frameCount: number;
  effectiveFps: number;
  droppedFrames: number;
  droppedFrac: number;
  files: { video: string; frames: string; landmarks: string; sensors: string };
}

export type UploadState = 'queued' | 'uploading' | 'paused' | 'failed_retryable' | 'failed_permanent' | 'completed';

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
}

export type CaptureKitEventName = keyof CaptureKitEvents;

export interface CaptureKitPlugin {
  getCapabilities(): Promise<DeviceCapabilities>;
  runQualificationBenchmark(opts: BenchmarkOpts): Promise<BenchmarkReport>;

  openCamera(opts: OpenCameraOpts): Promise<{ previewTransform: PreviewTransform; actualFps: number }>;
  lockCameraSettings(opts: { ae: boolean; af: boolean; awb: boolean }): Promise<void>;
  /** The native side stops recording at durationS on its own timer, independent of JS (decision 002). */
  startRecording(opts: { takeId: string; durationS: number }): Promise<{ startedAtNs: string }>;
  /** Early stop by the operator. */
  stopRecording(): Promise<RecordingResult>;
  closeCamera(): Promise<void>;

  writeEvidence(opts: { takeId: string; name: 'quality.json' | 'meta.json'; json: string }): Promise<void>;
  playTake(opts: { takeId: string }): Promise<{ playerUrl: string }>;
  deleteTake(opts: { takeId: string; reason: string }): Promise<void>;

  enqueueUpload(opts: { takeId: string; sessionId: string; endpoint: string; token: string }): Promise<void>;
  getUploadStatus(opts: { takeId: string }): Promise<UploadStatus>;

  addListener<E extends CaptureKitEventName>(
    eventName: E,
    listenerFunc: (event: CaptureKitEvents[E]) => void,
  ): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}
