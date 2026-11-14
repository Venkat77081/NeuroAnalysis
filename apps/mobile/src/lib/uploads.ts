/**
 * M7 upload glue on the app side: device enrollment, operator sign-in, request bodies for the
 * server (§13.2) and queueing a finished session. The transfer itself runs inside CaptureKit
 * (WorkManager on Android, the in-memory queue in mock mode) and keeps going without the WebView.
 *
 * Privacy (§14): the patient reference never leaves the phone; only SHA-256(site salt + ref) is
 * sent. Names, PINs and tokens are never logged.
 */
import {
  MockCaptureKit,
  sha256Hex,
  type CaptureKitPlugin,
  type Http,
  type UploadConfig,
} from '@neurocapture/capture-kit';
import type { LoadedConfig } from './config.ts';
import { APP_VERSION } from './evidence.ts';
import type { SessionContext, StepOutcome, TakeRecord } from '../session/machine.ts';

/** What device enrollment returns; saved in the encrypted app store. */
export interface ServerLink {
  endpoint: string;
  deviceId: string;
  deviceSecret: string;
  siteId: string;
  patientRefSalt: string;
  serverKeyId: string;
  serverPublicKeyPem: string;
}

export interface SignedIn {
  operatorId: string;
  operatorCode: string;
  role: string;
}

export class ServerError extends Error {
  constructor(
    readonly code: 'network' | 'bad_code' | 'bad_login' | 'server',
    message: string = code,
  ) {
    super(message);
  }
}

/** fake:// uses the built-in test server (mock/webcam mode); anything else uses fetch. */
export function httpFor(kit: CaptureKitPlugin, endpoint: string): Http {
  if (endpoint.startsWith('fake://')) {
    if (!(kit instanceof MockCaptureKit))
      throw new ServerError('network', 'fake server: mock only');
    return kit.fakeServer.http;
  }
  return async (url, init) => {
    const r = await fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body as BodyInit | undefined,
    });
    return { status: r.status, etag: r.headers.get('etag'), json: () => r.json() };
  };
}

async function post(http: Http, url: string, body: unknown) {
  try {
    return await http(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ServerError('network');
  }
}

const trimSlash = (s: string) => s.trim().replace(/\/+$/, '');

/** Register this phone with a site (one-time enrollment code from the site admin). */
export async function enroll(
  kit: CaptureKitPlugin,
  endpoint: string,
  enrollmentCode: string,
  device: { model: string; osVersion: string },
): Promise<ServerLink> {
  const base = trimSlash(endpoint);
  const r = await post(httpFor(kit, base), `${base}/auth/device-register`, {
    enrollment_code: enrollmentCode.trim(),
    model: device.model.slice(0, 100),
    os_version: device.osVersion.slice(0, 50),
  });
  if (r.status === 401 || r.status === 403 || r.status === 404 || r.status === 422)
    throw new ServerError('bad_code');
  if (r.status >= 300) throw new ServerError('server', `HTTP ${r.status}`);
  const b = (await r.json()) as {
    device_id: string;
    device_secret: string;
    site_id: string;
    patient_ref_salt: string;
    server_key: { key_id: string; public_key_pem: string };
  };
  return {
    endpoint: base,
    deviceId: b.device_id,
    deviceSecret: b.device_secret,
    siteId: b.site_id,
    patientRefSalt: b.patient_ref_salt,
    serverKeyId: b.server_key.key_id,
    serverPublicKeyPem: b.server_key.public_key_pem,
  };
}

/** Operator code + PIN → tokens, handed straight to CaptureKit (the app does not keep them). */
export async function signIn(
  kit: CaptureKitPlugin,
  link: ServerLink,
  operatorCode: string,
  pin: string,
  prefs: { wifiOnly: boolean; retentionHours: number },
): Promise<SignedIn> {
  const code = operatorCode.trim().toUpperCase(); // operator codes are upper case (e.g. OP-07)
  const r = await post(httpFor(kit, link.endpoint), `${link.endpoint}/auth/login`, {
    device_id: link.deviceId,
    device_secret: link.deviceSecret,
    operator_code: code,
    pin,
  });
  if (r.status === 401 || r.status === 403 || r.status === 422) throw new ServerError('bad_login');
  if (r.status >= 300) throw new ServerError('server', `HTTP ${r.status}`);
  const b = (await r.json()) as {
    access_token: string;
    refresh_token: string;
    operator_id: string;
    role: string;
  };
  await kit.configureUploads({
    ...uploadConfig(link, prefs),
    accessToken: b.access_token,
    refreshToken: b.refresh_token,
  });
  return { operatorId: b.operator_id, operatorCode: code, role: b.role };
}

/** Wi-Fi rule and retention: the operator's choice, else session.json `upload`. */
export function uploadPrefs(
  s: { wifiOnly: boolean | null; retentionHours: number | null },
  config: LoadedConfig,
): { wifiOnly: boolean; retentionHours: number } {
  const u = config.session.upload;
  return {
    wifiOnly: s.wifiOnly ?? u?.wifiOnlyDefault ?? true,
    retentionHours: s.retentionHours ?? u?.defaultRetentionHours ?? 24,
  };
}

/** Upload settings without tokens (the plugin keeps the tokens it holds). */
export function uploadConfig(
  link: ServerLink,
  prefs: { wifiOnly: boolean; retentionHours: number },
): UploadConfig {
  return {
    endpoint: link.endpoint,
    serverKeyId: link.serverKeyId,
    serverPublicKeyPem: link.serverPublicKeyPem,
    wifiOnly: prefs.wifiOnly,
    retentionHours: prefs.retentionHours,
  };
}

/** SHA-256(site salt + patient reference), hex. The only patient key the server sees. */
export function refHash(salt: string, ref: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(salt + ref.trim()));
}

/** Config versions saved with the session (session, quality, each test). */
export function configVersions(config: LoadedConfig): Record<string, string> {
  const v: Record<string, string> = {
    session: config.session.configVersion,
    quality: config.quality.configVersion,
  };
  for (const [code, t] of config.tests) v[code] = t.configVersion;
  return v;
}

/** POST /sessions body. */
export async function sessionBody(
  ctx: SessionContext,
  link: ServerLink,
  config: LoadedConfig,
): Promise<Record<string, unknown>> {
  if (!ctx.patient || !ctx.medState || !ctx.consent || !ctx.startedAt)
    throw new Error('session not started');
  return {
    client_session_id: ctx.sessionId,
    patient: {
      ref_hash: await refHash(link.patientRefSalt, ctx.patient.ref),
      year_of_birth: ctx.patient.yearOfBirth,
      sex: ctx.patient.sex,
    },
    med_state: ctx.medState,
    started_at: ctx.startedAt,
    consent_version: ctx.consent.version,
    consent_at: ctx.consent.at,
    app_version: APP_VERSION,
    config_versions: configVersions(config),
  };
}

/** POST /takes body (without session_id, files and key; quality/meta come from the evidence). */
export function takeBody(
  ctx: SessionContext,
  index: number,
  take: TakeRecord,
  outcome: StepOutcome,
): Record<string, unknown> {
  const step = ctx.plan[index]!;
  const kept = outcome.status === 'kept';
  return {
    client_take_id: take.takeId,
    test_code: step.code,
    side: step.side,
    take_no: take.takeNo,
    capture_verdict: kept ? 'OVERRIDE' : take.verdict,
    override_reason: kept ? outcome.reason : null,
    flagged_for_review: kept,
  };
}

/** The take each step contributes: the accepted or kept one. Retaken and skipped takes stay local. */
export function takesToUpload(
  ctx: SessionContext,
): { index: number; take: TakeRecord; outcome: StepOutcome }[] {
  const out: { index: number; take: TakeRecord; outcome: StepOutcome }[] = [];
  ctx.outcomes.forEach((o, index) => {
    if (o.status !== 'accepted' && o.status !== 'kept') return;
    const take = (ctx.takes[index] ?? []).find((t) => t.takeId === o.takeId);
    if (take?.result) out.push({ index, take, outcome: o });
  });
  return out;
}

/** PATCH /sessions/{id} body. */
export function closeBody(ctx: SessionContext, endedAt: string): Record<string, unknown> {
  return {
    ended_at: ctx.endedAt ?? endedAt,
    aborted: ctx.aborted ? { reason: ctx.aborted.reason, note: ctx.aborted.note } : null,
  };
}

/** Queue every accepted/kept take of a finished session, then the session close. Idempotent. */
export async function queueSession(
  kit: CaptureKitPlugin,
  ctx: SessionContext,
  link: ServerLink,
  config: LoadedConfig,
  now: string,
): Promise<string[]> {
  const takes = takesToUpload(ctx);
  if (takes.length === 0) return [];
  const session = JSON.stringify(await sessionBody(ctx, link, config));
  for (const { index, take, outcome } of takes)
    await kit.enqueueUpload({
      takeId: take.takeId,
      clientSessionId: ctx.sessionId,
      session,
      take: JSON.stringify(takeBody(ctx, index, take, outcome)),
    });
  await kit.enqueueSessionClose({
    clientSessionId: ctx.sessionId,
    body: JSON.stringify(closeBody(ctx, now)),
  });
  return takes.map((t) => t.take.takeId);
}
