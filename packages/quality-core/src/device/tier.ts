/**
 * Device tier assignment from benchmark reports (DEV_PLAN §7). Pure logic: native measures,
 * TypeScript decides, using thresholds from config/device-tiers.json.
 */
import type { BenchmarkReport, DeviceTiersConfig } from '@neurocapture/contracts-ts/types';

export type Tier = 'A' | 'B' | 'C' | 'W';

export type TierReasonCode =
  | 'not_native'
  | 'resolution_not_allowed'
  | 'effective_fps_low'
  | 'dropped_frames_high'
  | 'analysis_fps_low'
  | 'timestamp_spread_high'
  | 'thermal_fps_drop'
  | 'lock_unsupported'
  | 'benchmark_errors'
  | 'no_run_at_target_fps'
  | 'record_too_short'
  | 'thermal_too_short';

export interface TierReason {
  /** Which tier's requirement this is about. */
  tier: 'A' | 'B' | 'W';
  code: TierReasonCode;
  value?: number | string;
  limit?: number | string;
}

export interface TierAssessment {
  tier: Tier;
  /** True when the tier passed on a shorter run than the config requires (dev/quick runs). */
  provisional: boolean;
  /** Why higher tiers were not reached, plus provisional notes. Empty for a full Tier A pass. */
  reasons: TierReason[];
  tiersConfigVersion: string;
}

interface Check {
  failures: TierReason[];
  shortRun: TierReason[];
}

function checkA(r: BenchmarkReport, c: DeviceTiersConfig['A']): Check {
  const f: TierReason[] = [];
  const s: TierReason[] = [];
  if (!c.resolutions.includes(r.settings.resolution)) {
    f.push({
      tier: 'A',
      code: 'resolution_not_allowed',
      value: r.settings.resolution,
      limit: c.resolutions.join('/'),
    });
  }
  if (r.recording.effectiveFps < c.minEffectiveFps) {
    f.push({
      tier: 'A',
      code: 'effective_fps_low',
      value: r.recording.effectiveFps,
      limit: c.minEffectiveFps,
    });
  }
  if (r.recording.droppedFrac >= c.maxDroppedFrac) {
    f.push({
      tier: 'A',
      code: 'dropped_frames_high',
      value: r.recording.droppedFrac,
      limit: c.maxDroppedFrac,
    });
  }
  if (r.analysis.fps < c.minAnalysisFps) {
    f.push({ tier: 'A', code: 'analysis_fps_low', value: r.analysis.fps, limit: c.minAnalysisFps });
  }
  if (r.camera.timestampSource !== 'REALTIME') {
    const spread = r.timestamp.offsetSpreadMs;
    if (spread === null || spread > c.maxOffsetSpreadMsIfUnknownSource) {
      f.push({
        tier: 'A',
        code: 'timestamp_spread_high',
        value: spread ?? 'unknown',
        limit: c.maxOffsetSpreadMsIfUnknownSource,
      });
    }
  }
  if (r.thermal.windowFpsMin !== null && r.thermal.windowFpsMin < c.minThermalWindowFps) {
    f.push({
      tier: 'A',
      code: 'thermal_fps_drop',
      value: r.thermal.windowFpsMin,
      limit: c.minThermalWindowFps,
    });
  }
  const lock = r.camera.lockSupported;
  if (c.requireLock && !(lock.ae && lock.af && lock.awb)) {
    const missing = (['ae', 'af', 'awb'] as const).filter((k) => !lock[k]).join('/');
    f.push({ tier: 'A', code: 'lock_unsupported', value: missing });
  }
  if (r.errors.length) f.push({ tier: 'A', code: 'benchmark_errors', value: r.errors.length });
  if (r.recording.durationS < c.minRecordMinutes * 60) {
    s.push({
      tier: 'A',
      code: 'record_too_short',
      value: r.recording.durationS,
      limit: c.minRecordMinutes * 60,
    });
  }
  if (r.thermal.durationS < c.minThermalMinutes * 60) {
    s.push({
      tier: 'A',
      code: 'thermal_too_short',
      value: r.thermal.durationS,
      limit: c.minThermalMinutes * 60,
    });
  }
  return { failures: f, shortRun: s };
}

function checkB(r: BenchmarkReport, c: DeviceTiersConfig['B']): Check {
  const f: TierReason[] = [];
  const s: TierReason[] = [];
  if (!c.resolutions.includes(r.settings.resolution)) {
    f.push({
      tier: 'B',
      code: 'resolution_not_allowed',
      value: r.settings.resolution,
      limit: c.resolutions.join('/'),
    });
  }
  if (r.recording.effectiveFps < c.minEffectiveFps) {
    f.push({
      tier: 'B',
      code: 'effective_fps_low',
      value: r.recording.effectiveFps,
      limit: c.minEffectiveFps,
    });
  }
  if (r.recording.droppedFrac >= c.maxDroppedFrac) {
    f.push({
      tier: 'B',
      code: 'dropped_frames_high',
      value: r.recording.droppedFrac,
      limit: c.maxDroppedFrac,
    });
  }
  if (r.analysis.fps < c.minAnalysisFps) {
    f.push({ tier: 'B', code: 'analysis_fps_low', value: r.analysis.fps, limit: c.minAnalysisFps });
  }
  if (r.errors.length) f.push({ tier: 'B', code: 'benchmark_errors', value: r.errors.length });
  if (r.recording.durationS < c.minRecordMinutes * 60) {
    s.push({
      tier: 'B',
      code: 'record_too_short',
      value: r.recording.durationS,
      limit: c.minRecordMinutes * 60,
    });
  }
  return { failures: f, shortRun: s };
}

/** Best result over candidate reports: a passing full run beats a passing short run beats failures. */
function best(
  reports: BenchmarkReport[],
  check: (r: BenchmarkReport) => Check,
): { pass: Check | null; failures: TierReason[] } {
  let pass: Check | null = null;
  let failures: TierReason[] = [];
  for (const r of reports) {
    const res = check(r);
    if (res.failures.length === 0) {
      if (!pass || pass.shortRun.length > res.shortRun.length) pass = res;
    } else if (failures.length === 0 || res.failures.length < failures.length) {
      failures = res.failures;
    }
  }
  return { pass, failures };
}

/**
 * Assign a tier. A needs a passing 60 fps run; B a passing 30 fps run. Any mock/webcam report
 * makes the device W (never clinical). No reports → C.
 */
export function assignTier(reports: BenchmarkReport[], cfg: DeviceTiersConfig): TierAssessment {
  const version = cfg.configVersion;
  if (reports.some((r) => r.implementation !== 'native')) {
    return {
      tier: 'W',
      provisional: false,
      reasons: [{ tier: 'W', code: 'not_native' }],
      tiersConfigVersion: version,
    };
  }
  const a = best(
    reports.filter((r) => r.settings.targetFps === cfg.A.targetFps),
    (r) => checkA(r, cfg.A),
  );
  if (a.pass) {
    return {
      tier: 'A',
      provisional: a.pass.shortRun.length > 0,
      reasons: a.pass.shortRun,
      tiersConfigVersion: version,
    };
  }
  const aReasons: TierReason[] = a.failures.length
    ? a.failures
    : [{ tier: 'A', code: 'no_run_at_target_fps', limit: cfg.A.targetFps }];
  const b = best(
    reports.filter((r) => r.settings.targetFps === cfg.B.targetFps),
    (r) => checkB(r, cfg.B),
  );
  if (b.pass) {
    return {
      tier: 'B',
      provisional: b.pass.shortRun.length > 0,
      reasons: [...aReasons, ...b.pass.shortRun],
      tiersConfigVersion: version,
    };
  }
  const bReasons: TierReason[] = b.failures.length
    ? b.failures
    : [{ tier: 'B', code: 'no_run_at_target_fps', limit: cfg.B.targetFps }];
  return {
    tier: 'C',
    provisional: false,
    reasons: [...aReasons, ...bReasons],
    tiersConfigVersion: version,
  };
}

/** Compact, language-neutral form stored in the saved report, e.g. "A.effective_fps_low (41.2 < 58)". */
export function formatTierReason(r: TierReason): string {
  if (r.value === undefined) return `${r.tier}.${r.code}`;
  return r.limit === undefined
    ? `${r.tier}.${r.code} (${r.value})`
    : `${r.tier}.${r.code} (${r.value} vs ${r.limit})`;
}

/** Tests a device may run for clinical capture: A → all; B → tests with minTier B; C/W → none. */
export function allowedTests<T extends { code: string; minTier: 'A' | 'B' }>(
  tier: Tier,
  tests: T[],
): string[] {
  if (tier === 'A') return tests.map((t) => t.code);
  if (tier === 'B') return tests.filter((t) => t.minTier === 'B').map((t) => t.code);
  return [];
}
