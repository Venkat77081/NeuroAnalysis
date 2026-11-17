/** v11 (decision 043): the app account's backup is opened only with the PIN + server share, or the recovery code. */
import { describe, expect, it } from 'vitest';
import { FakeServer } from '@neurocapture/capture-kit';
import {
  newRecoveryCode,
  open,
  openBackup,
  pinKey,
  randomBytes,
  recoveryKeys,
  recoveryLooksRight,
  resetWithRecovery,
  saveBackup,
  seal,
  sealBackup,
  signIn,
  signUp,
  b64,
} from '../src/lib/appaccount.ts';
import type { PatientHospital } from '../src/lib/hospitals.ts';

const H: PatientHospital = {
  profile: 'default',
  hospital: 'Sunrise Neuro Clinic',
  ncid: 'nc_1',
  link: {
    endpoint: 'fake://api',
    deviceId: 'pdev1',
    deviceSecret: 'psecret1',
    siteId: 'site1',
    patientRefSalt: '',
    serverKeyId: 'k',
    serverPublicKeyPem: 'pem',
  },
  joinedAt: '2026-11-17T00:00:00Z',
  withdrawnAt: null,
};

describe('backup crypto', () => {
  it('recovery codes are 24 characters in groups of 4 and check their alphabet', () => {
    const c = newRecoveryCode();
    expect(c).toMatch(/^([A-Z2-9]{4}-){5}[A-Z2-9]{4}$/);
    expect(recoveryLooksRight(c.toLowerCase().replace(/-/g, ' '))).toBe(true);
    expect(recoveryLooksRight('K7QM-4XRP')).toBe(false);
  });

  it('opens only with the same PIN, salt and server share', async () => {
    const bk = randomBytes(32);
    const salt = b64(randomBytes(16));
    const share = b64(randomBytes(32));
    const wrapped = await seal(await pinKey('2580', salt, share), bk);
    expect(await open(await pinKey('2580', salt, share), wrapped)).toEqual(bk);
    await expect(open(await pinKey('2581', salt, share), wrapped)).rejects.toThrow(
      'backup_unreadable',
    );
    await expect(open(await pinKey('2580', salt, b64(randomBytes(32))), wrapped)).rejects.toThrow();
  });

  it('the recovery code opens the backup key; the check value cannot', async () => {
    const code = newRecoveryCode();
    const { key, check } = await recoveryKeys(code);
    const bk = randomBytes(32);
    const backup = await sealBackup(b64(bk), [H]);
    const wrapped = await seal(key, bk);
    expect(await openBackup(await open(key, wrapped), backup)).toEqual([H]);
    expect(check).not.toBe(b64(key));
    expect((await recoveryKeys(code.toLowerCase())).check).toBe(check);
  });
});

describe('account against the fake server', () => {
  it('signs up, restores on a new phone after "move", and resets the PIN with the recovery code', async () => {
    const fake = new FakeServer();
    const { MockCaptureKit, sampleFixtures } = await import('@neurocapture/capture-kit');
    const kit = new MockCaptureKit({ fixture: sampleFixtures['ft-r-sample'] });
    Object.assign(kit, { fakeServer: fake });
    const send = (email: string) =>
      fake.http('fake://api/account/code', {
        method: 'POST',
        body: JSON.stringify({ email, purpose: 'signup' }),
      });
    await send('asha@example.com');
    const a = await signUp(
      kit,
      'fake://api',
      'asha@example.com',
      fake.lastAccountCode('asha@example.com')!,
      '2580',
      { installId: 'install-a', deviceLabel: 'Pixel 7' },
      [],
    );
    const local = await saveBackup(kit, a.local, [H]);
    expect(local.refreshToken).not.toBe(a.local.refreshToken);

    await send('asha@example.com');
    const code = fake.lastAccountCode('asha@example.com')!;
    const phoneB = { installId: 'install-b', deviceLabel: 'Galaxy' };
    await expect(
      signIn(kit, 'fake://api', 'asha@example.com', code, '2580', phoneB, false),
    ).rejects.toThrow('other_phone');
    await expect(
      signIn(kit, 'fake://api', 'asha@example.com', code, '1111', phoneB, true),
    ).rejects.toThrow('wrong_pin');
    const b = await signIn(kit, 'fake://api', 'asha@example.com', code, '2580', phoneB, true);
    expect(b.hospitals).toEqual([H]);

    await send('asha@example.com');
    const r = await resetWithRecovery(
      kit,
      'fake://api',
      'asha@example.com',
      fake.lastAccountCode('asha@example.com')!,
      a.recoveryCode,
      '135790',
      phoneB,
    );
    expect(r.hospitals).toEqual([H]);
    expect(r.recoveryCode).not.toBe(a.recoveryCode);
    await send('asha@example.com');
    await expect(
      resetWithRecovery(
        kit,
        'fake://api',
        'asha@example.com',
        fake.lastAccountCode('asha@example.com')!,
        a.recoveryCode,
        '246810',
        phoneB,
      ),
    ).rejects.toThrow('recovery_invalid');
  });
});
