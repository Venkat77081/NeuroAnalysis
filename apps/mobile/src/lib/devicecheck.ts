/**
 * Phone check before a phone is added (decision 035), widened to memory and storage (decision 062).
 *
 * - Camera: a short CaptureKit qualification benchmark (no thermal phase) on the back camera at
 *   1080p/60. Pass at config `deviceCheck.minFps` (55) or more; between that and `warnBelowFps` (59)
 *   it is "borderline": some takes may fail the 59 fps take minimum.
 * - Memory (RAM): below `memory.minTotalGb` the phone is not suitable; below `warnTotalBelowGb` it
 *   warns. Android reports a little less than the label, so bytes are rounded up to whole GiB.
 * - Storage: a visit cannot start below session.json `storage.minFreeGbToStart`, or below what the
 *   visit needs on this phone; below `storage.warnFreeBelowGb` it warns. Storage never stops a phone
 *   from joining: the patient can free space later.
 *
 * The test video is measured (bytes per second) and deleted by CaptureKit; the rate is kept on
 * this phone so the space a visit needs is known before each visit. Nothing but these numbers and
 * the phone model is sent, and only when the phone is added or reports a check.
 */
import type {
  BenchmarkProgressEvent,
  CaptureKitPlugin,
  MemoryStatus,
} from '@neurocapture/capture-kit';
import type { PlatformConfig } from '@neurocapture/contracts-ts';

export type DeviceCheckConfig = PlatformConfig['deviceCheck'];

/** What the server receives as `camera_check` (fps, plus the phone's numbers since decision 062). */
export interface CameraCheck {
  effective_fps: number;
  ran_at: string;
  brand?: string;
  manufacturer?: string;
  video_width?: number;
  video_height?: number;
  video_bytes_per_s?: number;
  ram_total_bytes?: number;
  ram_free_bytes?: number;
  ram_low?: boolean;
  storage_free_bytes?: number;
  storage_total_bytes?: number;
}

export type CheckOutcome = 'pass' | 'borderline' | 'fail';
export type Tone = 'ok' | 'warn' | 'bad';

export interface DeviceCheckResult {
  outcome: CheckOutcome;
  /** Why the phone is not suitable (outcome 'fail'). */
  reason: 'camera' | 'memory' | null;
  fps: number;
  check: CameraCheck;
  camera: Tone;
  memory: { tone: Tone; totalGb: number | null; freeBytes: number | null } | null;
  storage: { tone: Tone; freeBytes: number; totalBytes: number; needBytes: number } | null;
  video: { width: number; height: number } | null;
  /** This phone's video size per second, when measured. */
  bytesPerS: number | null;
}

const GIB = 2 ** 30;

/** The phone's memory as sold ("4 GB"): Android reports a little less, so round up to whole GiB. */
export function nominalGb(totalBytes: number | null | undefined): number | null {
  return totalBytes ? Math.ceil(totalBytes / GIB) : null;
}

export function outcomeOf(fps: number, cfg: DeviceCheckConfig): CheckOutcome {
  if (fps < cfg.minFps) return 'fail';
  return fps < cfg.warnBelowFps ? 'borderline' : 'pass';
}

export function memoryTone(
  totalBytes: number | null | undefined,
  cfg: DeviceCheckConfig,
): Tone | null {
  const gb = nominalGb(totalBytes);
  if (gb === null) return null;
  if (gb < cfg.memory.minTotalGb) return 'bad';
  return gb < cfg.memory.warnTotalBelowGb ? 'warn' : 'ok';
}

/** Before a visit: free memory is only ever a warning (Android's own low flag, or under the limit). */
export function freeMemoryLow(m: MemoryStatus | null, cfg: DeviceCheckConfig): boolean {
  if (!m) return false;
  return (
    m.lowMemory === true ||
    (m.availBytes !== null && m.availBytes < cfg.memory.warnFreeBelowGb * 1e9)
  );
}

/**
 * Bytes a visit needs here: its seconds of video at this phone's rate, the largest take again for
 * its encrypted copy while it is saved, and a margin. Uploading needs nothing extra.
 */
export function visitNeedBytes(
  seconds: readonly number[],
  bytesPerS: number | null,
  cfg: DeviceCheckConfig,
): number {
  const rate = bytesPerS ?? cfg.storage.fallbackMbPerS * 1e6;
  const total = seconds.reduce((a, b) => a + b, 0);
  const largest = seconds.length ? Math.max(...seconds) : 0;
  return Math.round((total + largest) * rate + cfg.storage.visitMarginGb * 1e9);
}

export function storageTone(
  freeBytes: number,
  needBytes: number,
  startGb: number,
  cfg: DeviceCheckConfig,
): Tone {
  if (freeBytes < Math.max(startGb * 1e9, needBytes)) return 'bad';
  return freeBytes < cfg.storage.warnFreeBelowGb * 1e9 ? 'warn' : 'ok';
}

// --- This phone's measured video rate (a UI-free number, kept on the phone only). ---

const RATE_KEY = 'nc.videoBytesPerS';

export function savedVideoRate(): number | null {
  try {
    const v = Number(globalThis.localStorage?.getItem(RATE_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

function saveVideoRate(v: number): void {
  try {
    globalThis.localStorage?.setItem(RATE_KEY, String(Math.round(v)));
  } catch {
    /* storage unavailable: the fallback rate is used */
  }
}

/** A full visit on the default plan: every test once at its length (for the join-time storage row). */
export const TYPICAL_VISIT_S = [15, 15, 15, 15, 45];

/** Runs the check; `onProgress` gets the share done (0–1) and the live fps while recording. */
export async function runDeviceCheck(
  kit: CaptureKitPlugin,
  cfg: DeviceCheckConfig,
  startGb: number,
  onProgress?: (done: number, liveFps: number | null) => void,
): Promise<DeviceCheckResult> {
  const handle = onProgress
    ? await kit.addListener('benchmarkProgress', (e: BenchmarkProgressEvent) =>
        onProgress(e.totalS > 0 ? Math.min(1, e.elapsedS / e.totalS) : 0, e.liveFps ?? null),
      )
    : null;
  try {
    const report = await kit.runQualificationBenchmark({
      facing: cfg.facing,
      resolution: cfg.resolution,
      targetFps: 60,
      recordMinutes: cfg.durationS / 60,
      thermalMinutes: 0,
    });
    const rec = report.recording;
    const fps = Math.round(rec.effectiveFps * 10) / 10;
    const bytesPerS =
      rec.videoBytes && rec.durationS > 0 ? rec.videoBytes / rec.durationS : savedVideoRate();
    if (rec.videoBytes && rec.durationS > 0) saveVideoRate(rec.videoBytes / rec.durationS);
    const mem = report.memory ?? (await kit.getMemoryStatus().catch(() => null));
    const disk = await kit.getStorageStatus().catch(() => null);
    return resultOf(cfg, startGb, {
      fps,
      ranAt: report.ranAt,
      brand: report.device.brand,
      manufacturer: report.device.manufacturer,
      video:
        rec.videoWidth && rec.videoHeight
          ? { width: rec.videoWidth, height: rec.videoHeight }
          : null,
      bytesPerS,
      mem,
      disk,
    });
  } finally {
    await handle?.remove();
  }
}

/** The rows and the outcome from the measured numbers (pure; exported for tests). */
export function resultOf(
  cfg: DeviceCheckConfig,
  startGb: number,
  m: {
    fps: number;
    ranAt: string;
    brand?: string;
    manufacturer?: string;
    video: { width: number; height: number } | null;
    bytesPerS: number | null;
    mem: MemoryStatus | null;
    disk: { freeBytes: number; totalBytes: number } | null;
  },
): DeviceCheckResult {
  const camera = outcomeOf(m.fps, cfg);
  const memTone = memoryTone(m.mem?.totalBytes, cfg);
  const need = visitNeedBytes(TYPICAL_VISIT_S, m.bytesPerS, cfg);
  const reason = camera === 'fail' ? 'camera' : memTone === 'bad' ? 'memory' : null;
  const check: CameraCheck = {
    effective_fps: m.fps,
    ran_at: m.ranAt,
    ...(m.brand ? { brand: m.brand.slice(0, 60) } : {}),
    ...(m.manufacturer ? { manufacturer: m.manufacturer.slice(0, 60) } : {}),
    ...(m.video ? { video_width: m.video.width, video_height: m.video.height } : {}),
    ...(m.bytesPerS ? { video_bytes_per_s: Math.round(m.bytesPerS) } : {}),
    ...(m.mem?.totalBytes ? { ram_total_bytes: Math.round(m.mem.totalBytes) } : {}),
    ...(m.mem?.availBytes != null ? { ram_free_bytes: Math.round(m.mem.availBytes) } : {}),
    ...(m.mem?.lowMemory != null ? { ram_low: m.mem.lowMemory } : {}),
    ...(m.disk
      ? {
          storage_free_bytes: Math.round(m.disk.freeBytes),
          storage_total_bytes: Math.round(m.disk.totalBytes),
        }
      : {}),
  };
  return {
    outcome: reason ? 'fail' : camera,
    reason,
    fps: m.fps,
    check,
    camera: camera === 'fail' ? 'bad' : camera === 'borderline' ? 'warn' : 'ok',
    memory: memTone
      ? {
          tone: memTone,
          totalGb: nominalGb(m.mem?.totalBytes),
          freeBytes: m.mem?.availBytes ?? null,
        }
      : null,
    storage: m.disk
      ? {
          tone: storageTone(m.disk.freeBytes, need, startGb, cfg),
          freeBytes: m.disk.freeBytes,
          totalBytes: m.disk.totalBytes,
          needBytes: need,
        }
      : null,
    video: m.video,
    bytesPerS: m.bytesPerS,
  };
}

export interface VisitCheck {
  needBytes: number;
  freeBytes: number | null;
  /** A visit cannot start: less free space than the start limit or than the visit needs. */
  blocked: boolean;
  storage: Tone | null;
  memoryLow: boolean;
  memory: MemoryStatus | null;
}

/** The quick check before a visit (no camera): storage for this visit's takes, and free memory. */
export async function runVisitCheck(
  kit: CaptureKitPlugin,
  seconds: readonly number[],
  cfg: DeviceCheckConfig,
  startGb: number,
): Promise<VisitCheck> {
  const need = visitNeedBytes(seconds, savedVideoRate(), cfg);
  const [disk, mem] = await Promise.all([
    kit.getStorageStatus().catch(() => null),
    kit.getMemoryStatus().catch(() => null),
  ]);
  const storage = disk ? storageTone(disk.freeBytes, need, startGb, cfg) : null;
  return {
    needBytes: need,
    freeBytes: disk?.freeBytes ?? null,
    blocked: storage === 'bad',
    storage,
    memoryLow: freeMemoryLow(mem, cfg),
    memory: mem,
  };
}

/** GB with one decimal for the screens. */
export const gb = (bytes: number) => (bytes / 1e9).toFixed(1);
