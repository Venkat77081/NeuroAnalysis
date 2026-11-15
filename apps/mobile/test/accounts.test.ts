/** M13: invite parsing, the offline screen lock, and the patient path against the fake server. */
import { describe, expect, it } from 'vitest';
import { MockCaptureKit, sampleFixtures } from '@neurocapture/capture-kit';
import {
  acceptInvite,
  api,
  changePassword,
  inviteToken,
  lookupInvite,
  ncidForMrn,
  operatorSignIn,
  type HomePlan,
} from '../src/lib/accounts.ts';
import { enroll } from '../src/lib/uploads.ts';

const prefs = { wifiOnly: false, retentionHours: 24 };

describe('accounts (M13)', () => {
  it('reads the token from links, pasted text and bare codes', () => {
    expect(inviteToken('neurocapture://invite?t=abcDEF123_-xyz')).toBe('abcDEF123_-xyz');
    expect(inviteToken('  https://x.example/invite?a=1&t=abcdefghijk ')).toBe('abcdefghijk');
    expect(inviteToken('abcdefghijk')).toBe('abcdefghijk');
    expect(inviteToken('short')).toBeNull();
    expect(inviteToken('has spaces in it')).toBeNull();
  });

  it('patient: invite → PIN → plan via CaptureKit (tokens never in JS)', async () => {
    const kit = new MockCaptureKit({ fixture: sampleFixtures['ft-r-sample'] });
    const link = kit.fakeServer.issueInvite();
    const token = inviteToken(link)!;
    const info = await lookupInvite(kit, 'fake://api', token);
    expect(info).toMatchObject({ hospital: 'Demo Hospital', pinMin: 4, pinMax: 6 });
    const out = await acceptInvite(
      kit,
      'fake://api',
      token,
      '2580',
      info.consentVersion,
      { model: 'm', osVersion: '1' },
      prefs,
    );
    expect(out.ncid).toMatch(/^nc_/);
    expect(JSON.stringify(out)).not.toContain('at-'); // no access token handed to the app
    const plan = await api<HomePlan>(kit, 'GET', '/patient/plan');
    expect(plan.due_now).toBe(true);
    await expect(api(kit, 'POST', '/takes', {})).rejects.toThrow('not_allowed');
    await expect(lookupInvite(kit, 'fake://api', token)).rejects.toMatchObject({
      code: 'bad_code',
    });
  });

  it('operator: password sign-in, forced change, NCID from the connector', async () => {
    const kit = new MockCaptureKit({ fixture: sampleFixtures['ft-r-sample'] });
    const link = await enroll(kit, 'fake://api', kit.fakeServer.enrollmentCode, {
      model: 'm',
      osVersion: '1',
    });
    await expect(operatorSignIn(kit, link, 'OP-NEW', 'wrong', prefs)).rejects.toMatchObject({
      code: 'bad_login',
    });
    const who = await operatorSignIn(kit, link, 'op-new', 'temp-pass-1234', prefs);
    expect(who.mustChangePassword).toBe(true);
    await expect(ncidForMrn(kit, '00012388')).rejects.toThrow('password_change_required');
    await expect(changePassword(kit, 'temp-pass-1234', 'short')).rejects.toThrow('weak_password');
    await changePassword(kit, 'temp-pass-1234', 'clinic-phone-77');
    const ncid = await ncidForMrn(kit, ' 00012388 ');
    expect(await ncidForMrn(kit, '00012388')).toBe(ncid);
    expect(kit.fakeServer.connectorMap.get('00012388')).toBe(ncid);
  });
});
