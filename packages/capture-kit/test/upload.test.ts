/** M7 upload protocol against the fake server: resume, checksum mismatch, refresh, retention. */
import { describe, expect, it } from 'vitest';
import {
  FakeServer,
  MockCaptureKit,
  UploadClient,
  sampleFixtures,
  scaledScheduler,
  sha256Hex,
} from '../src/index.ts';
import type { UploadConfig, UploadStatus } from '../src/index.ts';

const until = async (cond: () => boolean | Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
};

async function setup() {
  const kit = new MockCaptureKit({
    fixture: sampleFixtures['ft-r-sample'],
    scheduler: scaledScheduler(1000),
  });
  const srv = kit.fakeServer;
  const reg = (await (
    await srv.http('fake://api/auth/device-register', {
      method: 'POST',
      body: JSON.stringify({ enrollment_code: srv.enrollmentCode, model: 'x', os_version: '1' }),
    })
  ).json()) as {
    device_id: string;
    device_secret: string;
    server_key: { key_id: string; public_key_pem: string };
  };
  const tok = (await (
    await srv.http('fake://api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        device_id: reg.device_id,
        device_secret: reg.device_secret,
        operator_code: 'OP-07',
        pin: '2468',
      }),
    })
  ).json()) as { access_token: string; refresh_token: string };
  const cfg: UploadConfig = {
    endpoint: 'fake://api',
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    serverKeyId: reg.server_key.key_id,
    serverPublicKeyPem: reg.server_key.public_key_pem,
    wifiOnly: false,
    retentionHours: 24,
  };
  await kit.openCamera({
    facing: 'back',
    resolution: '1080p',
    targetFps: 60,
    orientation: 'portrait',
    trackers: [],
    analysisFps: 30,
  });
  for (const id of ['tk-a', 'tk-b']) {
    await kit.startRecording({ takeId: id, durationS: 1 });
    await until(async () => (await kit.listTakes()).takes.some((t) => t.takeId === id && t.result));
    await kit.writeEvidence({
      takeId: id,
      name: 'quality.json',
      json: '{"captureVerdict":"PASS"}',
    });
  }
  return { kit, srv, cfg };
}

const session = JSON.stringify({
  client_session_id: 's-1',
  patient: { ref_hash: 'a'.repeat(64) },
  med_state: 'ON',
});
const take = (id: string) =>
  JSON.stringify({ client_take_id: id, test_code: 'FT', take_no: 1, capture_verdict: 'PASS' });

describe('uploads (M7)', () => {
  it('uploads a session, resumes after network loss, re-sends a corrupted part, closes the session', async () => {
    const { kit, srv, cfg } = await setup();
    const states: string[] = [];
    await kit.addListener('uploadProgress', (u: UploadStatus) =>
      states.push(`${u.takeId}:${u.state}`),
    );
    // No credentials yet: queued uploads wait for a login.
    await kit.enqueueUpload({
      takeId: 'tk-a',
      clientSessionId: 's-1',
      session,
      take: take('tk-a'),
    });
    await until(
      async () => (await kit.getUploadStatus({ takeId: 'tk-a' })).reason === 'login_required',
    );
    // Network drops mid-upload (after a few parts), comes back → resume.
    let parts = 0;
    const http = srv.http;
    (srv as unknown as { http: typeof http }).http = async (url, init) => {
      if (url.startsWith('fake://part/') && ++parts === 2) srv.online = false;
      return http(url, init);
    };
    srv.corruptNextPart = false;
    await kit.configureUploads(cfg);
    await until(
      async () => (await kit.getUploadStatus({ takeId: 'tk-a' })).state === 'failed_retryable',
    );
    const mid = await kit.getUploadStatus({ takeId: 'tk-a' });
    expect(mid.bytesSent).toBeGreaterThan(0);
    kit.setNetwork(true);
    await until(async () => (await kit.getUploadStatus({ takeId: 'tk-a' })).state === 'completed');
    expect(srv.log.filter((l) => l === 'POST /takes').length).toBe(2); // resume re-uses the take
    // Second take: one part arrives corrupted → checksum mismatch → file re-sent.
    srv.corruptNextPart = true;
    await kit.enqueueUpload({
      takeId: 'tk-b',
      clientSessionId: 's-1',
      session,
      take: take('tk-b'),
    });
    await kit.enqueueSessionClose({
      clientSessionId: 's-1',
      body: JSON.stringify({ ended_at: '2026-11-14T10:00:00Z' }),
    });
    await until(async () => (await kit.getUploadStatus({ takeId: 'tk-b' })).state === 'completed');
    const b = await kit.getUploadStatus({ takeId: 'tk-b' });
    expect(b.bytesSent).toBe(b.bytesTotal);
    expect(b.confirmedAt).toBeTruthy();
    await until(() => srv.sessionClosed('s-1'));
    expect(states).toContain('tk-a:failed_retryable');
    expect((await kit.listUploads()).uploads.map((u) => u.state)).toEqual([
      'completed',
      'completed',
    ]);
    // Retention: local copies stay until the retention time has passed.
    expect((await kit.listTakes()).takes.some((t) => t.takeId === 'tk-a')).toBe(true);
    await kit.configureUploads({ ...cfg, retentionHours: 0 });
    await until(async () => (await kit.getUploadStatus({ takeId: 'tk-a' })).localDeleted === true);
    expect((await kit.listTakes()).takes.some((t) => t.takeId === 'tk-a')).toBe(false);
  });

  it('refreshes an expired access token once; a revoked login pauses the queue', async () => {
    const { kit, cfg } = await setup();
    await kit.configureUploads({ ...cfg, accessToken: 'expired' });
    await kit.enqueueUpload({
      takeId: 'tk-a',
      clientSessionId: 's-1',
      session,
      take: take('tk-a'),
    });
    await until(async () => (await kit.getUploadStatus({ takeId: 'tk-a' })).state === 'completed');
    await kit.configureUploads({ ...cfg, accessToken: 'expired', refreshToken: 'revoked' });
    await kit.enqueueUpload({
      takeId: 'tk-b',
      clientSessionId: 's-1',
      session,
      take: take('tk-b'),
    });
    await until(
      async () => (await kit.getUploadStatus({ takeId: 'tk-b' })).reason === 'login_required',
    );
    await kit.clearUploadCredentials();
    await kit.retryUploads();
  });

  it('protocol client: permanent errors and sha256', async () => {
    const srv = new FakeServer();
    const c = new UploadClient(
      srv.http,
      'fake://api',
      { access: 'at-x', refresh: 'none' },
      () => undefined,
    );
    const files = {
      kinds: ['video'],
      size: () => 3,
      sha256: () => sha256Hex(new Uint8Array([1, 2, 3])),
      read: async () => new Uint8Array([1, 2, 3]),
    };
    await expect(
      c.run(
        {
          takeId: 't',
          clientSessionId: 's',
          session: '{"client_session_id":"s"}',
          take: '{}',
          wrappedDataKey: 'k',
          keyId: 'k',
          serverSessionId: 'nope',
        },
        files,
        () => undefined,
      ),
    ).resolves.toBeTruthy(); // fake server accepts any session id; real server would 404
    srv.online = false;
    await expect(c.closeSession('S1', '{}')).rejects.toMatchObject({ kind: 'network' });
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
