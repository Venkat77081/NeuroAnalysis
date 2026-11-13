import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BenchmarkReport, DeviceTiersConfig } from '@neurocapture/contracts-ts/types';
import { assignTier, allowedTests, formatTierReason } from '../src/index.ts';

const root = resolve(import.meta.dirname, '../../..');
const cfg = JSON.parse(
  readFileSync(resolve(root, 'config/device-tiers.json'), 'utf8'),
) as DeviceTiersConfig;
const base = JSON.parse(
  readFileSync(
    resolve(root, 'contracts/tests/valid/benchmark-report/native-tier-a-1.0.0.json'),
    'utf8',
  ),
) as BenchmarkReport;

function rep(mut: (r: BenchmarkReport) => void = () => {}): BenchmarkReport {
  const r = structuredClone(base);
  delete r.assessment;
  mut(r);
  return r;
}
const at30 = (mut: (r: BenchmarkReport) => void = () => {}) =>
  rep((r) => {
    r.settings.targetFps = 30;
    r.recording.effectiveFps = 29.9;
    r.thermal.durationS = 0;
    r.thermal.windowFpsMin = null;
    mut(r);
  });
const codes = (rs: { tier: string; code: string }[]) => rs.map((x) => `${x.tier}.${x.code}`);

describe('assignTier', () => {
  it('gives A for a full passing 60 fps run', () => {
    expect(assignTier([rep()], cfg)).toEqual({
      tier: 'A',
      provisional: false,
      reasons: [],
      tiersConfigVersion: 'TIERS@1.0.0',
    });
  });

  it('marks A provisional when the record and thermal runs were shorter than required', () => {
    const res = assignTier(
      [rep((r) => ((r.recording.durationS = 60), (r.thermal.durationS = 120)))],
      cfg,
    );
    expect(res.tier).toBe('A');
    expect(res.provisional).toBe(true);
    expect(codes(res.reasons)).toEqual(['A.record_too_short', 'A.thermal_too_short']);
  });

  it.each([
    ['effective_fps_low', (r: BenchmarkReport) => (r.recording.effectiveFps = 41.2)],
    ['dropped_frames_high', (r: BenchmarkReport) => (r.recording.droppedFrac = 0.012)],
    ['analysis_fps_low', (r: BenchmarkReport) => (r.analysis.fps = 12)],
    ['thermal_fps_drop', (r: BenchmarkReport) => (r.thermal.windowFpsMin = 40)],
    ['lock_unsupported', (r: BenchmarkReport) => (r.camera.lockSupported.awb = false)],
    ['benchmark_errors', (r: BenchmarkReport) => r.errors.push('camera error 3')],
    ['resolution_not_allowed', (r: BenchmarkReport) => (r.settings.resolution = '720p')],
  ])('fails A on %s and falls to C without a 30 fps run', (code, mut) => {
    const res = assignTier([rep(mut)], cfg);
    expect(res.tier).toBe('C');
    expect(codes(res.reasons)).toEqual([`A.${code}`, 'B.no_run_at_target_fps']);
  });

  it('checks timestamp offset spread only when the source is not REALTIME', () => {
    const unknownOk = rep(
      (r) => ((r.camera.timestampSource = 'UNKNOWN'), (r.timestamp.offsetSpreadMs = 3)),
    );
    expect(assignTier([unknownOk], cfg).tier).toBe('A');
    const unknownBad = rep(
      (r) => ((r.camera.timestampSource = 'UNKNOWN'), (r.timestamp.offsetSpreadMs = 8)),
    );
    expect(codes(assignTier([unknownBad], cfg).reasons)).toContain('A.timestamp_spread_high');
    const unknownMissing = rep(
      (r) => ((r.camera.timestampSource = 'UNKNOWN'), (r.timestamp.offsetSpreadMs = null)),
    );
    expect(assignTier([unknownMissing], cfg).reasons[0]).toMatchObject({
      code: 'timestamp_spread_high',
      value: 'unknown',
    });
  });

  it('gives B when the 60 fps run fails but a 30 fps run passes, keeping the A reasons', () => {
    const res = assignTier([rep((r) => (r.recording.effectiveFps = 30)), at30()], cfg);
    expect(res.tier).toBe('B');
    expect(res.provisional).toBe(false);
    expect(codes(res.reasons)).toEqual(['A.effective_fps_low']);
  });

  it('gives B from a 30 fps run alone, provisional when short', () => {
    const res = assignTier([at30((r) => (r.recording.durationS = 30))], cfg);
    expect(res).toMatchObject({ tier: 'B', provisional: true });
    expect(codes(res.reasons)).toEqual(['A.no_run_at_target_fps', 'B.record_too_short']);
  });

  it.each([
    ['effective_fps_low', (r: BenchmarkReport) => (r.recording.effectiveFps = 24)],
    ['dropped_frames_high', (r: BenchmarkReport) => (r.recording.droppedFrac = 0.05)],
    ['analysis_fps_low', (r: BenchmarkReport) => (r.analysis.fps = 10)],
    ['benchmark_errors', (r: BenchmarkReport) => r.errors.push('x')],
  ])('gives C when the 30 fps run fails on %s', (code, mut) => {
    expect(codes(assignTier([at30(mut)], cfg).reasons)).toEqual([
      'A.no_run_at_target_fps',
      `B.${code}`,
    ]);
  });

  it('accepts 720p for B only', () => {
    expect(assignTier([at30((r) => (r.settings.resolution = '720p'))], cfg).tier).toBe('B');
    const bad = structuredClone(cfg);
    bad.B.resolutions = ['1080p'];
    expect(
      codes(assignTier([at30((r) => (r.settings.resolution = '720p'))], bad).reasons),
    ).toContain('B.resolution_not_allowed');
  });

  it('prefers a full passing run over a short one, and the closest failing run for reasons', () => {
    const short = rep((r) => (r.recording.durationS = 10));
    expect(assignTier([short, rep()], cfg).provisional).toBe(false);
    expect(assignTier([rep(), short], cfg).provisional).toBe(false);
    const twoFails = rep((r) => ((r.recording.effectiveFps = 40), (r.analysis.fps = 5)));
    const oneFail = rep((r) => (r.analysis.fps = 5));
    expect(codes(assignTier([twoFails, oneFail], cfg).reasons)).toEqual([
      'A.analysis_fps_low',
      'B.no_run_at_target_fps',
    ]);
  });

  it('gives W for any mock or webcam report, and C with no reports', () => {
    expect(assignTier([rep((r) => (r.implementation = 'mock'))], cfg).tier).toBe('W');
    expect(assignTier([], cfg).tier).toBe('C');
  });
});

describe('formatTierReason / allowedTests', () => {
  it('formats reasons compactly', () => {
    expect(formatTierReason({ tier: 'A', code: 'effective_fps_low', value: 41.2, limit: 58 })).toBe(
      'A.effective_fps_low (41.2 vs 58)',
    );
    expect(formatTierReason({ tier: 'A', code: 'lock_unsupported', value: 'awb' })).toBe(
      'A.lock_unsupported (awb)',
    );
    expect(formatTierReason({ tier: 'W', code: 'not_native' })).toBe('W.not_native');
  });

  it('lists the clinical tests per tier', () => {
    const tests = [
      { code: 'FT', minTier: 'A' as const },
      { code: 'SAW', minTier: 'B' as const },
      { code: 'FA', minTier: 'B' as const },
    ];
    expect(allowedTests('A', tests)).toEqual(['FT', 'SAW', 'FA']);
    expect(allowedTests('B', tests)).toEqual(['SAW', 'FA']);
    expect(allowedTests('C', tests)).toEqual([]);
    expect(allowedTests('W', tests)).toEqual([]);
  });
});
