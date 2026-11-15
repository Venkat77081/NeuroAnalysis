/** v3 patient app: several hospitals on one phone, each with its own profile, NCID and requests. */
import { describe, expect, it } from 'vitest';
import { MockCaptureKit, sampleFixtures } from '@neurocapture/capture-kit';
import { acceptInvite, inviteToken, unlockHospitals } from '../src/lib/accounts.ts';
import {
  activeHospitals,
  hospitalApi,
  hospitalsOf,
  profileFor,
  withdrawnFrom,
  withHospital,
  type PatientHospital,
  type PatientRequest,
} from '../src/lib/hospitals.ts';
import { defaultSettings, type Settings } from '../src/data/repo.ts';

const prefs = { wifiOnly: false, retentionHours: 24 };

async function join(kit: MockCaptureKit, s: Settings, link: string, pin = '2580') {
  const known = hospitalsOf(s);
  const out = await acceptInvite(
    kit,
    'fake://api',
    inviteToken(link)!,
    pin,
    { model: 'm', osVersion: '1' },
    prefs,
    (site) => profileFor(known, site),
  );
  const h: PatientHospital = {
    profile: out.profile,
    hospital: out.hospital,
    ncid: out.ncid,
    link: out.link,
    joinedAt: '2026-11-15T10:00:00Z',
    withdrawnAt: null,
  };
  return withHospital({ ...s, hospitals: known }, h);
}

describe('hospitals on the phone (v3)', () => {
  it('profiles: first is default, others per site, re-joining keeps the profile', () => {
    const link = { siteId: 'Site-2' } as PatientHospital['link'];
    const first = { profile: 'default', link: { siteId: 'site1' } } as PatientHospital;
    expect(profileFor([], 'site1')).toBe('default');
    expect(profileFor([first], 'site1')).toBe('default');
    expect(profileFor([first], 'Site-2')).toBe('h-site2');
    const second = { profile: 'h-site2', link } as PatientHospital;
    expect(profileFor([first, second], 'site-2!')).toBe('h-site2-2');
    expect(profileFor([first], '')).toBe('h-2');
  });

  it('a pre-v3 install is read as one hospital on the default profile', () => {
    const s: Settings = {
      ...defaultSettings,
      server: { siteId: 'site1' } as Settings['server'],
      patient: { hospital: 'Demo Hospital', ncid: 'nc_x', consentVersion: 'c', consentAt: 't' },
    };
    expect(hospitalsOf(s)).toMatchObject([{ profile: 'default', hospital: 'Demo Hospital' }]);
  });

  it('two hospitals: separate NCIDs and requests; withdrawing one leaves the other', async () => {
    const kit = new MockCaptureKit({ fixture: sampleFixtures['ft-r-sample'] });
    const srv = kit.fakeServer;
    let s = await join(kit, defaultSettings, srv.issueInvite());
    s = await join(
      kit,
      s,
      srv.issueInvite(undefined, { hospital: 'Lakeview Hospital', siteId: 'site2' }),
    );
    const [a, b] = hospitalsOf(s);
    expect([a!.profile, b!.profile]).toEqual(['default', 'h-site2']);
    expect(a!.ncid).not.toBe(b!.ncid);
    expect(s.patient?.hospital).toBe('Demo Hospital');

    const rq = srv.sendRequest(b!.ncid, { tests: ['FT', 'FA'] });
    const reqs = (h: PatientHospital) =>
      hospitalApi<PatientRequest[]>(kit, h, 'GET', '/patient/requests');
    expect(await reqs(a!)).toEqual([]);
    expect(await reqs(b!)).toMatchObject([{ id: rq, state: 'open', tests: ['FT', 'FA'] }]);

    // Unlock checks the PIN with the first active hospital.
    await expect(unlockHospitals(kit, activeHospitals(s), '1111', prefs)).rejects.toThrow();
    await unlockHospitals(kit, activeHospitals(s), '2580', prefs);

    await hospitalApi(kit, a!, 'POST', '/patient/consent/withdraw', { delete_recordings: false });
    await kit.clearUploadCredentials({ profile: a!.profile });
    s = withdrawnFrom(s, a!.profile, '2026-11-16T09:00:00Z');
    expect(activeHospitals(s).map((h) => h.hospital)).toEqual(['Lakeview Hospital']);
    expect(s.patient?.hospital).toBe('Lakeview Hospital'); // first active hospital
    await expect(reqs(a!)).rejects.toThrow('login_required');
    expect(await reqs(b!)).toHaveLength(1);

    // Back in by a new invite from the same hospital: same profile and NCID, not withdrawn.
    s = await join(kit, s, srv.issueInvite(undefined, { ncid: a!.ncid }));
    const again = hospitalsOf(s).find((h) => h.profile === 'default')!;
    expect([again.ncid, again.withdrawnAt]).toEqual([a!.ncid, null]);
    expect(await reqs(again)).toEqual([]);
  });
});
