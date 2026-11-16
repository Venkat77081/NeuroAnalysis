/** M13: app mode lock (mock mirrors AppMode.kt) and the patient path on the fake server. */
import { describe, expect, it } from 'vitest';
import { FakeServer, MockCaptureKit, sampleFixtures } from '../src/index.ts';

const CC = { effective_fps: 60, ran_at: '2026-11-16T09:00:00Z' }; // camera check (decision 035)

describe('app mode (M13)', () => {
  it('is set once; a clinic phone cannot become a patient phone; reset clears it', async () => {
    const kit = new MockCaptureKit({ fixture: sampleFixtures['ft-r-sample'] });
    expect((await kit.getAppMode()).mode).toBeNull();
    await expect(kit.lockAppMode({ mode: 'clinic' })).resolves.toEqual({ mode: 'clinic' });
    await expect(kit.lockAppMode({ mode: 'clinic' })).resolves.toEqual({ mode: 'clinic' });
    await expect(kit.lockAppMode({ mode: 'patient' })).rejects.toThrow('mode_locked');
    // JS cannot write the reserved key the native store keeps the mode under.
    await expect(
      kit.securePut({ key: 'sys.app_mode', json: '{"mode":"patient"}' }),
    ).rejects.toThrow();
    await expect(kit.secureDelete({ key: 'sys.app_mode' })).rejects.toThrow();
    expect((await kit.getAppMode()).mode).toBe('clinic');
    await kit.securePut({ key: 'settings', json: '{}' });
    await kit.resetDevice();
    expect((await kit.getAppMode()).mode).toBeNull();
    expect((await kit.secureKeys({ prefix: '' })).keys).toEqual([]);
    await expect(kit.lockAppMode({ mode: 'patient' })).resolves.toEqual({ mode: 'patient' });
    await kit.resetDevice();
  });
});

describe('fake server patient path (M13)', () => {
  const post = (srv: FakeServer, path: string, body: unknown, token?: string) =>
    srv.http(`fake://api${path}`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: JSON.stringify(body),
    });

  it('invite → PIN → plan → home session; lockout after 5 wrong PINs; withdraw', async () => {
    const srv = new FakeServer();
    const link = srv.issueInvite();
    const token = link.split('t=')[1]!;
    expect((await post(srv, '/patient/invite/lookup', { token })).status).toBe(200);
    const bad = await post(srv, '/patient/invite/accept', {
      token,
      pin: '12',
      camera_check: CC,
      consent_version: 'home-consent@1',
    });
    expect(bad.status).toBe(422);
    const ok = await post(srv, '/patient/invite/accept', {
      token,
      pin: '2580',
      camera_check: CC,
      consent_version: 'home-consent@1',
    });
    expect(ok.status).toBe(201);
    const acc = (await ok.json()) as {
      device_id: string;
      device_secret: string;
      ncid: string;
      tokens: { access_token: string; refresh_token: string };
    };
    expect(acc.ncid).toMatch(/^nc_[0-9a-f]{32}$/);
    expect((await post(srv, '/patient/invite/lookup', { token })).status).toBe(403); // single use
    const at = acc.tokens.access_token;
    const plan = await srv.http('fake://api/patient/plan', {
      method: 'GET',
      headers: { Authorization: `Bearer ${at}` },
    });
    // v3: appointments only (nothing due) until the doctor asks for periodic recording.
    expect(await plan.json()).toMatchObject({ due_now: false, next_due: null });
    srv.homePlan.periodic = true;
    const plan2 = await srv.http('fake://api/patient/plan', {
      method: 'GET',
      headers: { Authorization: `Bearer ${at}` },
    });
    expect(await plan2.json()).toMatchObject({
      due_now: true,
      tests: ['FT', 'FTF', 'FR', 'SAW', 'FA'],
    });
    // v3: the doctor's record link; recording for it marks it recorded.
    const rq = srv.sendRequest(acc.ncid, { tests: ['FT'] });
    const reqs = async () =>
      (await (
        await srv.http('fake://api/patient/requests', {
          method: 'GET',
          headers: { Authorization: `Bearer ${at}` },
        })
      ).json()) as { id: string; state: string; tests: string[] }[];
    expect(await reqs()).toMatchObject([{ id: rq, state: 'open', tests: ['FT'] }]);
    const s = await post(
      srv,
      '/sessions',
      {
        client_session_id: 'h1',
        med_state: 'OFF',
        started_at: new Date().toISOString(),
        request_id: rq,
      },
      at,
    );
    expect(await s.json()).toMatchObject({ encryption_key: { key_id: 'hk-fake-1' } });
    expect(srv.homeSessions()).toHaveLength(1);
    // Another hospital: its own name and NCID; the first hospital's requests stay there.
    const t3 = srv.issueInvite(undefined, { hospital: 'Lakeview Hospital', siteId: 'site2' });
    const other = (await (
      await post(srv, '/patient/invite/accept', {
        token: t3.split('t=')[1],
        pin: '2580',
        camera_check: CC,
      })
    ).json()) as { hospital: string; site_id: string; ncid: string };
    expect([other.hospital, other.site_id]).toEqual(['Lakeview Hospital', 'site2']);
    expect(other.ncid).not.toBe(acc.ncid);
    // Patients refresh at /patient/refresh only.
    expect(
      (await post(srv, '/auth/refresh', { refresh_token: acc.tokens.refresh_token })).status,
    ).toBe(401);
    expect(
      (await post(srv, '/patient/consent/withdraw', { delete_recordings: true }, at)).status,
    ).toBe(200);
    expect((await post(srv, '/sessions', { client_session_id: 'h2' }, at)).status).toBe(401);
    // Lockout after 5 wrong PINs (a second patient).
    const t2 = srv.issueInvite().split('t=')[1]!;
    const acc2 = (await (
      await post(srv, '/patient/invite/accept', {
        token: t2,
        pin: '1357',
        camera_check: CC,
        consent_version: 'home-consent@1',
      })
    ).json()) as { device_id: string; device_secret: string };
    const creds = { device_id: acc2.device_id, device_secret: acc2.device_secret };
    for (let i = 0; i < 4; i++)
      expect((await post(srv, '/patient/login', { ...creds, pin: '0000' })).status).toBe(401);
    expect((await post(srv, '/patient/login', { ...creds, pin: '0000' })).status).toBe(403);
    expect((await post(srv, '/patient/login', { ...creds, pin: '1357' })).status).toBe(403);
  });

  it('operators: temporary password must be changed; NCID from the connector', async () => {
    const srv = new FakeServer();
    const reg = (await (
      await post(srv, '/auth/device-register', {
        enrollment_code: srv.enrollmentCode,
        camera_check: CC,
      })
    ).json()) as { device_id: string; device_secret: string };
    const login = await post(srv, '/auth/login', {
      ...reg,
      operator_code: 'OP-NEW',
      password: 'temp-pass-1234',
    });
    const t = (await login.json()) as { access_token: string; must_change_password: boolean };
    expect(t.must_change_password).toBe(true);
    expect((await post(srv, '/auth/connector-token', {}, t.access_token)).status).toBe(403);
    expect(
      (
        await post(
          srv,
          '/auth/change-password',
          { current_password: 'temp-pass-1234', new_password: 'short' },
          t.access_token,
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await post(
          srv,
          '/auth/change-password',
          { current_password: 'temp-pass-1234', new_password: 'clinic-phone-77' },
          t.access_token,
        )
      ).status,
    ).toBe(204);
    const ct = (await (await post(srv, '/auth/connector-token', {}, t.access_token)).json()) as {
      token: string;
      connector_url: string;
    };
    const r = await srv.http(`${ct.connector_url}/v1/ncid`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ct.token}` },
      body: JSON.stringify({ mrn: '00012388' }),
    });
    const { ncid } = (await r.json()) as { ncid: string };
    expect(srv.connectorMap.get('00012388')).toBe(ncid);
    const s = await post(
      srv,
      '/sessions',
      { client_session_id: 'c1', patient: { ref_hash: 'a'.repeat(64) } },
      t.access_token,
    );
    expect(s.status).toBe(422); // NCID required
  });
});
