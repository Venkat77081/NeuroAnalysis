/**
 * M13 accounts on the phone: operator password sign-in and change, the clinic NCID lookup through
 * the hospital connector, patient invites and PIN. The screen lock unlocks by signing in again
 * with the server, so every wrong attempt counts towards the server's lockout.
 *
 * Tokens never reach JavaScript: CaptureKit keeps them and makes signed-in calls itself
 * (`apiRequest`). The MRN typed on a clinic phone goes to the hospital connector only.
 */
import type { CaptureKitPlugin } from '@neurocapture/capture-kit';
import {
  httpFor,
  ServerError,
  throwIfCameraCheck,
  uploadConfig,
  type ServerLink,
  type SignedIn,
} from './uploads.ts';
import type { CameraCheck } from './devicecheck.ts';

const trimSlash = (s: string) => s.trim().replace(/\/+$/, '');

async function postJson(kit: CaptureKitPlugin, base: string, path: string, body: unknown) {
  try {
    return await httpFor(kit, base)(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ServerError('network');
  }
}

/** A signed-in call through CaptureKit. Errors carry the server's code (e.g. weak_password). */
export async function api<T>(
  kit: CaptureKitPlugin,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const { json } = await kit.apiRequest({
    method,
    path,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return JSON.parse(json) as T;
}

export function errorCode(e: unknown): string {
  return e instanceof ServerError ? e.code : e instanceof Error ? e.message : 'network';
}

// --- Operators ---

export interface OperatorSignIn extends SignedIn {
  mustChangePassword: boolean;
}

/** Operator ID + password → tokens straight into CaptureKit. */
export async function operatorSignIn(
  kit: CaptureKitPlugin,
  link: ServerLink,
  operatorCode: string,
  password: string,
  prefs: { wifiOnly: boolean; retentionHours: number },
): Promise<OperatorSignIn> {
  const code = operatorCode.trim().toUpperCase();
  const r = await postJson(kit, link.endpoint, '/auth/login', {
    device_id: link.deviceId,
    device_secret: link.deviceSecret,
    operator_code: code,
    password,
  });
  if (r.status === 403) {
    const code = ((await r.json().catch(() => null)) as { detail?: { code?: string } } | null)
      ?.detail?.code;
    if (code === 'account_locked' || code === 'not_permitted') throw new Error(code);
    throw new ServerError('bad_login');
  }
  if (r.status === 401 || r.status === 422) throw new ServerError('bad_login');
  if (r.status >= 300) throw new ServerError('server', `HTTP ${r.status}`);
  const b = (await r.json()) as {
    access_token: string;
    refresh_token: string;
    operator_id: string;
    role: string;
    must_change_password?: boolean;
    name?: string | null;
  };
  await kit.configureUploads({
    ...uploadConfig(link, prefs),
    accessToken: b.access_token,
    refreshToken: b.refresh_token,
    refreshPath: '/auth/refresh',
  });
  return {
    operatorId: b.operator_id,
    operatorCode: code,
    role: b.role,
    mustChangePassword: !!b.must_change_password,
    name: b.name ?? null,
  };
}

export async function changePassword(kit: CaptureKitPlugin, current: string, next: string) {
  await api(kit, 'POST', '/auth/change-password', {
    current_password: current,
    new_password: next,
  });
}

/** Clinic phone: the NCID of a hospital patient, by MRN, from the hospital connector. */
export async function ncidForMrn(kit: CaptureKitPlugin, mrn: string): Promise<string> {
  const ct = await api<{ token: string; connector_url: string }>(
    kit,
    'POST',
    '/auth/connector-token',
  );
  const base = trimSlash(ct.connector_url);
  let r;
  try {
    r = await httpFor(kit, base)(`${base}/v1/ncid`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${ct.token}` },
      body: JSON.stringify({ mrn: mrn.trim() }),
    });
  } catch {
    throw new Error('connector_unreachable');
  }
  if (r.status === 404) throw new Error('mrn_not_found');
  if (r.status !== 200) throw new Error('connector_unreachable');
  return ((await r.json()) as { ncid: string }).ncid;
}

// --- Patients ---

/** The token from an invite link (e-mail, SMS, QR), a pasted link, or the bare code. */
export function inviteToken(text: string): string | null {
  const s = text.trim();
  const m = /[?&]t=([A-Za-z0-9_-]{10,200})/.exec(s);
  if (m) return m[1]!;
  return /^[A-Za-z0-9_-]{10,200}$/.test(s) ? s : null;
}

export interface InviteInfo {
  hospital: string;
  consentVersion: string;
  pinMin: number;
  pinMax: number;
}

export async function lookupInvite(
  kit: CaptureKitPlugin,
  endpoint: string,
  token: string,
): Promise<InviteInfo> {
  const base = trimSlash(endpoint);
  const r = await postJson(kit, base, '/patient/invite/lookup', { token });
  if (r.status === 403 || r.status === 404 || r.status === 422) throw new ServerError('bad_code');
  if (r.status >= 300) throw new ServerError('server', `HTTP ${r.status}`);
  const b = (await r.json()) as {
    hospital: string;
    consent_version: string;
    pin_min_digits: number;
    pin_max_digits: number;
  };
  return {
    hospital: b.hospital,
    consentVersion: b.consent_version,
    pinMin: b.pin_min_digits,
    pinMax: b.pin_max_digits,
  };
}

/**
 * "Tell my hospital" (decision 035): this phone failed the camera check. Sends only the phone
 * model and the measured fps; the invite stays valid (another phone can still use it).
 */
export async function phoneNotSuitable(
  kit: CaptureKitPlugin,
  endpoint: string,
  token: string,
  model: string,
  cameraCheck: CameraCheck,
): Promise<void> {
  const base = trimSlash(endpoint);
  const r = await postJson(kit, base, '/patient/invite/phone-not-suitable', {
    token,
    model: model.slice(0, 100),
    camera_check: cameraCheck,
  });
  if (r.status === 403) throw new ServerError('bad_code');
  if (r.status >= 300) throw new ServerError('server', `HTTP ${r.status}`);
}

/**
 * Joins a hospital (v3: no consent here; it is asked before each recording). `profile` picks the
 * CaptureKit upload profile from the site ID the server returns (see lib/hospitals.ts).
 */
export async function acceptInvite(
  kit: CaptureKitPlugin,
  endpoint: string,
  token: string,
  /** v11: null with `accountToken` (the app account's PIN covers every hospital). */
  pin: string | null,
  device: { model: string; osVersion: string },
  prefs: { wifiOnly: boolean; retentionHours: number },
  profile: (siteId: string) => string,
  cameraCheck: CameraCheck,
  accountToken?: string,
): Promise<{ link: ServerLink; hospital: string; ncid: string; profile: string }> {
  const base = trimSlash(endpoint);
  const r = await postJson(kit, base, '/patient/invite/accept', {
    token,
    ...(pin !== null ? { pin } : { account_token: accountToken }),
    model: device.model.slice(0, 100),
    os_version: device.osVersion.slice(0, 50),
    camera_check: cameraCheck,
  });
  if (r.status === 403) throw new ServerError('bad_code');
  if (r.status === 422) {
    await throwIfCameraCheck(r);
    throw new Error('pin_format');
  }
  if (r.status >= 300) throw new ServerError('server', `HTTP ${r.status}`);
  const b = (await r.json()) as {
    device_id: string;
    device_secret: string;
    site_id: string;
    hospital: string;
    ncid: string;
    server_key: { key_id: string; public_key_pem: string };
    tokens: { access_token: string; refresh_token: string };
  };
  const link: ServerLink = {
    endpoint: base,
    deviceId: b.device_id,
    deviceSecret: b.device_secret,
    siteId: b.site_id,
    patientRefSalt: '',
    serverKeyId: b.server_key.key_id,
    serverPublicKeyPem: b.server_key.public_key_pem,
  };
  const p = profile(b.site_id);
  await kit.configureUploads({
    ...uploadConfig(link, prefs),
    accessToken: b.tokens.access_token,
    refreshToken: b.tokens.refresh_token,
    refreshPath: '/patient/refresh',
    profile: p,
  });
  return { link, hospital: b.hospital, ncid: b.ncid, profile: p };
}

/**
 * v11 (decision 043): this phone takes over a hospital from the phone the backup came from. The old
 * phone stops working there; the new sign-in secret is returned (the caller saves the backup).
 */
export async function moveHospital(
  kit: CaptureKitPlugin,
  old: ServerLink,
  device: { model: string; osVersion: string },
  prefs: { wifiOnly: boolean; retentionHours: number },
  profile: string,
  cameraCheck: CameraCheck,
): Promise<ServerLink> {
  const r = await postJson(kit, old.endpoint, '/patient/device/rotate', {
    device_id: old.deviceId,
    device_secret: old.deviceSecret,
    model: device.model.slice(0, 100),
    os_version: device.osVersion.slice(0, 50),
    camera_check: cameraCheck,
  });
  if (r.status === 401) throw new Error('hospital_signed_out');
  if (r.status === 422) {
    await throwIfCameraCheck(r);
    throw new ServerError('server', 'HTTP 422');
  }
  if (r.status >= 300) throw new ServerError('server', `HTTP ${r.status}`);
  const b = (await r.json()) as {
    device_id: string;
    device_secret: string;
    server_key: { key_id: string; public_key_pem: string };
    tokens: { access_token: string; refresh_token: string };
  };
  const link: ServerLink = {
    ...old,
    deviceId: b.device_id,
    deviceSecret: b.device_secret,
    serverKeyId: b.server_key.key_id,
    serverPublicKeyPem: b.server_key.public_key_pem,
  };
  await kit.configureUploads({
    ...uploadConfig(link, prefs),
    accessToken: b.tokens.access_token,
    refreshToken: b.tokens.refresh_token,
    refreshPath: '/patient/refresh',
    profile,
  });
  return link;
}

/** When the stored tokens no longer work: sign in again with the PIN (server-checked). */
export async function patientSignIn(
  kit: CaptureKitPlugin,
  link: ServerLink,
  pin: string,
  prefs: { wifiOnly: boolean; retentionHours: number },
  profile?: string,
): Promise<void> {
  const r = await postJson(kit, link.endpoint, '/patient/login', {
    device_id: link.deviceId,
    device_secret: link.deviceSecret,
    pin,
  });
  if (r.status === 403) throw new Error('pin_locked');
  if (r.status === 401) throw new ServerError('bad_login');
  if (r.status >= 300) throw new ServerError('server', `HTTP ${r.status}`);
  const b = (await r.json()) as { access_token: string; refresh_token: string };
  await kit.configureUploads({
    ...uploadConfig(link, prefs),
    accessToken: b.access_token,
    refreshToken: b.refresh_token,
    refreshPath: '/patient/refresh',
    ...(profile ? { profile } : {}),
  });
}

/**
 * v3 unlock: the PIN is checked by the first hospital still joined (its wrong attempts count
 * towards its lockout); the other hospitals are signed in with it too, best effort (the patient
 * uses one PIN for every hospital on this phone).
 */
export async function unlockHospitals(
  kit: CaptureKitPlugin,
  hospitals: { link: ServerLink; profile: string }[],
  pin: string,
  prefs: { wifiOnly: boolean; retentionHours: number },
): Promise<void> {
  const [first, ...rest] = hospitals;
  if (!first) return;
  await patientSignIn(kit, first.link, pin, prefs, first.profile);
  await Promise.all(
    rest.map((h) => patientSignIn(kit, h.link, pin, prefs, h.profile).catch(() => undefined)),
  );
}

export interface HomePlan {
  tests: string[];
  every_days: number;
  med_state: 'OFF' | 'ON' | 'ANY';
  default: boolean;
  /** v3: true while the doctor's "every N days" runs; it stops at the next appointment. */
  periodic?: boolean;
  periodic_until?: string | null;
  last_session_at: string | null;
  next_due: string | null;
  due_now: boolean;
}

export interface HomeSession {
  id: string;
  client_session_id: string;
  started_at: string;
  med_state: string;
  recorded_by: string;
  takes_uploaded: number;
}
