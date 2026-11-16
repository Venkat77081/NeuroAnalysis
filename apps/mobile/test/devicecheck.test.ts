/** Decision 035: camera check before a phone is added (55 fps or more; 55–59 borderline). */
import { describe, expect, it } from 'vitest';
import { MockCaptureKit, sampleFixtures } from '@neurocapture/capture-kit';
import { loadConfig } from '../src/lib/config.ts';
import { outcomeOf, runDeviceCheck } from '../src/lib/devicecheck.ts';
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
    const r = await runDeviceCheck(kit, cfg, (done) => seen.push(done));
    expect(r).toMatchObject({ outcome: 'pass', fps: 60, check: { effective_fps: 60 } });
    expect(seen.length).toBeGreaterThan(0);
    expect((await runDeviceCheck(kitAt(48), cfg)).outcome).toBe('fail');
  });

  it('clinic phone: a failed check leaves the code usable', async () => {
    const kit = kitAt(48);
    const bad = await runDeviceCheck(kit, cfg);
    const code = kit.fakeServer.enrollmentCode;
    await expect(enroll(kit, 'fake://api', code, device, bad.check)).rejects.toMatchObject({
      code: 'camera_check_failed',
    });
    kit.benchmarkFps = 59.9;
    const good = await runDeviceCheck(kit, cfg);
    await expect(enroll(kit, 'fake://api', code, device, good.check)).resolves.toMatchObject({
      siteId: 'site1',
    });
  });

  it('patient: "Tell my hospital" keeps the invite; another phone joins with it', async () => {
    const kit = kitAt(41);
    const token = inviteToken(kit.fakeServer.issueInvite())!;
    const bad = await runDeviceCheck(kit, cfg);
    await expect(
      acceptInvite(kit, 'fake://api', token, '2580', device, prefs, () => 'default', bad.check),
    ).rejects.toMatchObject({ code: 'camera_check_failed' });
    await phoneNotSuitable(kit, 'fake://api', token, device.model, bad.check);
    expect(kit.fakeServer.phoneNotSuitable.get(token)).toBe(41);
    kit.benchmarkFps = 60;
    const good = await runDeviceCheck(kit, cfg);
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
