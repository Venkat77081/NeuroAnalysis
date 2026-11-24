/** Decision 035: camera check before a phone is added (55 fps or more; 55–59 borderline). */
import { describe, expect, it } from 'vitest';
import { MockCaptureKit, sampleFixtures } from '@neurocapture/capture-kit';
import { loadConfig } from '../src/lib/config.ts';
import {
  freeMemoryLow,
  memoryTone,
  nominalGb,
  outcomeOf,
  runDeviceCheck,
  runVisitCheck,
  savedVideoRate,
  storageTone,
  TYPICAL_VISIT_S,
  visitNeedBytes,
} from '../src/lib/devicecheck.ts';
import { acceptInvite, inviteToken, phoneNotSuitable } from '../src/lib/accounts.ts';
import { enroll } from '../src/lib/uploads.ts';

const cfg = loadConfig().platform.deviceCheck;
const kitAt = (fps?: number) => {
  const kit = new MockCaptureKit({ fixture: sampleFixtures['ft-r-sample'] });
  kit.benchmarkFps = fps;
  return kit;
};
const prefs = { wifiOnly: false, retentionHours: 24 };
const device = { model: 'Galaxy A12', osVersion: '13' };

describe('device check', () => {
  it('uses the configured cut-off (55) and borderline (below 59)', () => {
    expect(cfg.minFps).toBe(55);
    expect(cfg.warnBelowFps).toBe(59);
    expect(outcomeOf(54.9, cfg)).toBe('fail');
    expect(outcomeOf(55, cfg)).toBe('borderline');
    expect(outcomeOf(58.9, cfg)).toBe('borderline');
    expect(outcomeOf(59, cfg)).toBe('pass');
  });

  it('runs a short back-camera benchmark and reports progress', async () => {
    const kit = kitAt(60);
    const seen: number[] = [];
    const r = await runDeviceCheck(kit, cfg, 2, (done: number) => seen.push(done));
    expect(r).toMatchObject({ outcome: 'pass', fps: 60, check: { effective_fps: 60 } });
    expect(seen.length).toBeGreaterThan(0);
    expect((await runDeviceCheck(kitAt(48), cfg, 2)).outcome).toBe('fail');
  });

  it('clinic phone: a failed check leaves the code usable', async () => {
    const kit = kitAt(48);
    const bad = await runDeviceCheck(kit, cfg, 2);
    const code = kit.fakeServer.enrollmentCode;
    await expect(enroll(kit, 'fake://api', code, device, bad.check)).rejects.toMatchObject({
      code: 'camera_check_failed',
    });
    kit.benchmarkFps = 59.9;
    const good = await runDeviceCheck(kit, cfg, 2);
    await expect(enroll(kit, 'fake://api', code, device, good.check)).resolves.toMatchObject({
      siteId: 'site1',
    });
  });

  it('patient: "Tell my hospital" keeps the invite; another phone joins with it', async () => {
    const kit = kitAt(41);
    const token = inviteToken(kit.fakeServer.issueInvite())!;
    const bad = await runDeviceCheck(kit, cfg, 2);
    await expect(
      acceptInvite(kit, 'fake://api', token, '2580', device, prefs, () => 'default', bad.check),
    ).rejects.toMatchObject({ code: 'camera_check_failed' });
    await phoneNotSuitable(kit, 'fake://api', token, device.model, bad.check);
    expect(kit.fakeServer.phoneNotSuitable.get(token)).toBe(41);
    kit.benchmarkFps = 60;
    const good = await runDeviceCheck(kit, cfg, 2);
    const out = await acceptInvite(
      kit,
      'fake://api',
      token,
      '2580',
      device,
      prefs,
      () => 'default',
      good.check,
    );
    expect(out.ncid).toMatch(/^nc_/);
    expect(kit.fakeServer.phoneNotSuitable.has(token)).toBe(false);
  });
});

/** Decision 062: memory and storage in the same check, and before each visit. */
describe('phone check: memory and storage', () => {
  const GIB = 2 ** 30;

  it('rounds memory up to the phone’s label and applies the limits', () => {
    expect(cfg.memory).toEqual({ minTotalGb: 3, warnTotalBelowGb: 4, warnFreeBelowGb: 0.5 });
    expect(nominalGb(3.7 * GIB)).toBe(4);
    expect(memoryTone(1.8 * GIB, cfg)).toBe('bad'); // a "2 GB" phone
    expect(memoryTone(2.8 * GIB, cfg)).toBe('warn'); // "3 GB"
    expect(memoryTone(3.7 * GIB, cfg)).toBe('ok'); // "4 GB"
    expect(memoryTone(null, cfg)).toBeNull();
    expect(freeMemoryLow({ totalBytes: 4e9, availBytes: 0.4e9, lowMemory: false }, cfg)).toBe(true);
    expect(freeMemoryLow({ totalBytes: 4e9, availBytes: 0.9e9, lowMemory: false }, cfg)).toBe(
      false,
    );
    expect(freeMemoryLow({ totalBytes: 4e9, availBytes: 2e9, lowMemory: true }, cfg)).toBe(true);
  });

  it('works out what a visit needs from this phone’s video size', () => {
    // 105 s of video + the 45 s take again (its encrypted copy), at 3.6 MB/s, + 0.25 GB.
    expect(visitNeedBytes(TYPICAL_VISIT_S, 3.6e6, cfg)).toBe(Math.round(150 * 3.6e6 + 0.25e9));
    expect(visitNeedBytes([15], null, cfg)).toBe(Math.round(30 * 4.5e6 + 0.25e9));
    expect(storageTone(1.6e9, 0.8e9, 2, cfg)).toBe('bad'); // under the 2 GB start limit
    expect(storageTone(2.5e9, 2.6e9, 2, cfg)).toBe('bad'); // under what this visit needs
    expect(storageTone(2.5e9, 0.8e9, 2, cfg)).toBe('warn');
    expect(storageTone(3e9, 0.8e9, 2, cfg)).toBe('ok');
  });

  it('measures the test video, reads memory and storage, and sends them with the check', async () => {
    const kit = kitAt(59.8);
    kit.videoBytesPerS = 3.6e6;
    kit.memTotalBytes = 5.6 * GIB;
    kit.freeBytes = 18.4e9;
    const r = await runDeviceCheck(kit, cfg, 2);
    expect(r.outcome).toBe('pass');
    expect([r.camera, r.memory?.tone, r.storage?.tone]).toEqual(['ok', 'ok', 'ok']);
    expect(r.video).toEqual({ width: 1920, height: 1080 });
    expect(r.bytesPerS).toBeCloseTo(3.6e6);
    expect(r.check).toMatchObject({
      effective_fps: 59.8,
      video_width: 1920,
      video_height: 1080,
      ram_total_bytes: Math.round(5.6 * GIB),
      storage_free_bytes: 18.4e9,
    });
    expect(r.check.video_bytes_per_s).toBe(3.6e6);
    // Kept on the phone for the visit check (browser storage; absent in this test runner).
    if (globalThis.localStorage) expect(savedVideoRate()).toBe(3.6e6);

    // Too little memory: not suitable, like a slow camera. Low storage only warns at joining.
    kit.memTotalBytes = 1.8 * GIB;
    kit.freeBytes = 1.6e9;
    const small = await runDeviceCheck(kit, cfg, 2);
    expect([small.outcome, small.reason, small.storage?.tone]).toEqual(['fail', 'memory', 'bad']);
  });

  it('the quick check before a visit blocks on storage and only warns on memory', async () => {
    const kit = kitAt(60);
    kit.freeBytes = 1.6e9;
    expect((await runVisitCheck(kit, [15, 15], cfg, 2)).blocked).toBe(true);
    kit.freeBytes = 9e9;
    kit.memLow = true;
    const v = await runVisitCheck(kit, [15, 15], cfg, 2);
    expect([v.blocked, v.storage, v.memoryLow]).toEqual([false, 'ok', true]);
  });

  it('the fake server refuses a phone with too little memory', async () => {
    const kit = kitAt(60);
    kit.memTotalBytes = 1.8 * GIB;
    const bad = await runDeviceCheck(kit, cfg, 2);
    await expect(
      enroll(kit, 'fake://api', kit.fakeServer.enrollmentCode, device, bad.check),
    ).rejects.toMatchObject({ code: 'camera_check_failed' });
  });
});
