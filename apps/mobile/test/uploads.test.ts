/** M7 app-side upload glue: enrollment, sign-in, request bodies, queueing a finished session. */
import { describe, expect, it } from 'vitest';
import {
  MockCaptureKit,
  sampleFixtures,
  scaledScheduler,
  type RecordingResult,
} from '@neurocapture/capture-kit';
import { loadConfig } from '../src/lib/config.ts';
import {
  closeBody,
  configVersions,
  enroll,
  queueSession,
  refHash,
  ServerError,
  sessionBody,
  signIn,
  takeBody,
  takesToUpload,
  uploadConfig,
  uploadPrefs,
} from '../src/lib/uploads.ts';
import type { SessionContext, SessionInput } from '../src/session/machine.ts';
import { startSession } from '../src/session/persist.ts';

const config = loadConfig();
const at = '2026-11-14T10:00:00Z';
const input: SessionInput = {
  sessionId: 's-up1',
  operatorId: 'OP-07',
  plan: [
    { code: 'FT', side: null },
    { code: 'FR', side: null },
    { code: 'FA', side: null },
  ],
  maxRetakes: 3,
  skipReasons: ['patient_unable', 'other'],
  overrideReasons: ['patient_fatigue', 'other'],
  abortReasons: ['patient_unwell', 'other'],
  consentVersion: 'CONSENT@1.0',
};

const until = async (cond: () => boolean | Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
};

/** FT: RETAKE then PASS (accepted). FR: skipped. FA: RETAKE kept with a reason. */
function finishedSession(): SessionContext {
  const a = startSession(input);
  a.send({
    type: 'SET_PATIENT',
    patient: { localId: 'p1', ref: 'A0142', yearOfBirth: 1958, sex: 'M' },
  });
  a.send({ type: 'SET_MED_STATE', medState: 'ON' });
  a.send({ type: 'SET_CONSENT', given: true, at });
  a.send({ type: 'START', at });
  const take = (id: string, verdict: 'PASS' | 'RETAKE') => {
    a.send({ type: 'CONTINUE' });
    a.send({ type: 'RECORD', takeId: id });
    a.send({ type: 'COUNTDOWN_DONE' });
    a.send({
      type: 'TAKE_FINISHED',
      result: { takeId: id } as RecordingResult,
      verdict,
      reasons: [],
    });
  };
  take('tk-ft1', 'RETAKE');
  a.send({ type: 'RETAKE' });
  take('tk-ft2', 'PASS');
  a.send({ type: 'ACCEPT' });
  a.send({ type: 'SKIP', reason: 'patient_unable', at });
  take('tk-fa1', 'RETAKE');
  a.send({ type: 'KEEP' });
  a.send({ type: 'CONFIRM_KEEP', reason: 'patient_fatigue', at });
  return a.getSnapshot().context;
}

async function kitWithTakes(ids: string[]) {
  const kit = new MockCaptureKit({
    fixture: sampleFixtures['ft-r-sample'],
    scheduler: scaledScheduler(1000),
  });
  await kit.openCamera({
    facing: 'back',
    resolution: '1080p',
    targetFps: 60,
    orientation: 'portrait',
    trackers: [],
    analysisFps: 30,
  });
  for (const id of ids) {
    await kit.startRecording({ takeId: id, durationS: 1 });
    await until(async () => (await kit.listTakes()).takes.some((t) => t.takeId === id && t.result));
    await kit.writeEvidence({
      takeId: id,
      name: 'quality.json',
      json: '{"captureVerdict":"PASS"}',
    });
    await kit.writeEvidence({ takeId: id, name: 'meta.json', json: `{"takeId":"${id}"}` });
  }
  return kit;
}

describe('upload glue (M7)', () => {
  it('builds bodies: only accepted/kept takes, hashed patient ref, override flag', async () => {
    const ctx = finishedSession();
    expect(ctx.outcomes.map((o) => o.status)).toEqual(['accepted', 'skipped', 'kept']);
    const list = takesToUpload(ctx);
    expect(list.map((x) => x.take.takeId)).toEqual(['tk-ft2', 'tk-fa1']);
    expect(takeBody(ctx, list[0]!.index, list[0]!.take, list[0]!.outcome)).toEqual({
      client_take_id: 'tk-ft2',
      test_code: 'FT',
      side: null,
      take_no: 2,
      capture_verdict: 'PASS',
      override_reason: null,
      flagged_for_review: false,
    });
    expect(takeBody(ctx, list[1]!.index, list[1]!.take, list[1]!.outcome)).toMatchObject({
      capture_verdict: 'OVERRIDE',
      override_reason: 'patient_fatigue',
      flagged_for_review: true,
    });
    const link = {
      endpoint: 'fake://api',
      deviceId: 'd',
      deviceSecret: 's',
      siteId: 'site',
      patientRefSalt: 'salt-1',
      serverKeyId: 'k',
      serverPublicKeyPem: 'pem',
    };
    const body = await sessionBody(ctx, link, config);
    const hash = await refHash('salt-1', 'A0142');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(await refHash('salt-2', 'A0142')); // site salt changes the hash
    expect(body).toMatchObject({
      client_session_id: 's-up1',
      patient: { ref_hash: hash, year_of_birth: 1958, sex: 'M' },
      med_state: 'ON',
      started_at: at,
      consent_version: 'CONSENT@1.0',
    });
    expect(JSON.stringify(body)).not.toContain('A0142'); // the reference never leaves the phone
    expect(configVersions(config)).toMatchObject({
      session: config.session.configVersion,
      FT: expect.any(String),
    });
    expect(closeBody(ctx, at)).toEqual({ ended_at: at, aborted: null });
    expect(uploadPrefs({ wifiOnly: null, retentionHours: null }, config)).toEqual({
      wifiOnly: true,
      retentionHours: 24,
    });
    expect(uploadConfig(link, { wifiOnly: false, retentionHours: 72 })).not.toHaveProperty(
      'accessToken',
    );
  });

  it('enrolls, signs in and uploads a finished session to the built-in server', async () => {
    const ctx = finishedSession();
    const kit = await kitWithTakes(['tk-ft2', 'tk-fa1']);
    const srv = kit.fakeServer;
    await expect(
      enroll(kit, 'fake://api', 'WRONG-CODE', { model: 'x', osVersion: '1' }),
    ).rejects.toMatchObject({ code: 'bad_code' });
    const link = await enroll(kit, 'fake://api/', srv.enrollmentCode, {
      model: 'x',
      osVersion: '1',
    });
    expect(link.endpoint).toBe('fake://api');
    const prefs = { wifiOnly: false, retentionHours: 24 };
    await expect(signIn(kit, link, 'OP-07', '0000', prefs)).rejects.toBeInstanceOf(ServerError);
    const who = await signIn(kit, link, 'op-07 ', '2468', prefs);
    expect(who.operatorCode).toBe('OP-07');

    const ids = await queueSession(kit, ctx, link, config, at);
    expect(ids).toEqual(['tk-ft2', 'tk-fa1']);
    await queueSession(kit, ctx, link, config, at); // idempotent (Summary re-mounts)
    await until(async () =>
      (await kit.listUploads()).uploads.every((u) => u.state === 'completed'),
    );
    expect((await kit.listUploads()).uploads).toHaveLength(2);
    await until(() => srv.sessionClosed('s-up1'));
    // Changing settings without tokens keeps the plugin's sign-in.
    await kit.configureUploads(uploadConfig(link, { wifiOnly: true, retentionHours: 0 }));
    await until(
      async () => (await kit.getUploadStatus({ takeId: 'tk-ft2' })).localDeleted === true,
    );
  });

  it('a session with nothing accepted or kept queues nothing', async () => {
    const a = startSession(input);
    const kit = await kitWithTakes([]);
    const link = await enroll(kit, 'fake://api', kit.fakeServer.enrollmentCode, {
      model: 'x',
      osVersion: '1',
    });
    expect(await queueSession(kit, a.getSnapshot().context, link, config, at)).toEqual([]);
  });
});
