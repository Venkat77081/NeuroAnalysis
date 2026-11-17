/**
 * v11 patient app account (decision 043): one e-mail and app PIN for every hospital on this phone.
 *
 * The phone keeps the list of hospitals it joined (with each hospital's sign-in secret). A copy is
 * sealed here with a random backup key (AES-256-GCM) and stored on the platform, which cannot open
 * it. The backup key is locked twice, on the phone:
 *  - with the PIN key: PBKDF2(PIN, salt) combined (HKDF) with a server share the platform releases
 *    only after a correct PIN, so a copied database alone cannot be used to guess PINs;
 *  - with the recovery code (24 random characters, about 120 bits) that only the patient keeps. The
 *    platform stores a check value derived from it, never the code.
 */
import type { CaptureKitPlugin } from '@neurocapture/capture-kit';
import type { PatientHospital } from './hospitals.ts';
import { httpFor, ServerError } from './uploads.ts';

export interface AccountLocal {
  endpoint: string;
  /** Kept on this phone for "forgot PIN" and sign-in (the platform keeps only a fingerprint). */
  email: string;
  installId: string;
  refreshToken: string;
  /** The backup key and its PIN-locked copy (this phone's encrypted store only). */
  backupKey: string;
  wrapPin: string;
  deviceLabel: string;
}

const te = new TextEncoder();
const td = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;

export function b64(u: Uint8Array): string {
  let s = '';
  for (const c of u) s += String.fromCharCode(c);
  return btoa(s);
}
export function unb64(s: string): Uint8Array {
  const t = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(t, (c) => c.charCodeAt(0));
}
export const randomBytes = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));
export const newSalt = () => b64(randomBytes(16));
export const newInstallId = () =>
  `i${Array.from(randomBytes(12), (b) => b.toString(16).padStart(2, '0')).join('')}`;

async function hkdf(ikm: Uint8Array, info: string): Promise<Uint8Array> {
  const k = await subtle().importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits']);
  const bits = await subtle().deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: te.encode(info) },
    k,
    256,
  );
  return new Uint8Array(bits);
}

/** The PIN key: the phone's half (slow PBKDF2 of the PIN) joined with the server's share. */
export async function pinKey(pin: string, saltB64: string, shareB64: string): Promise<Uint8Array> {
  const k = await subtle().importKey('raw', te.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const slow = new Uint8Array(
    await subtle().deriveBits(
      {
        name: 'PBKDF2',
        hash: 'SHA-256',
        salt: unb64(saltB64) as BufferSource,
        iterations: 200_000,
      },
      k,
      256,
    ),
  );
  const share = unb64(shareB64);
  const ikm = new Uint8Array(slow.length + share.length);
  ikm.set(slow);
  ikm.set(share, slow.length);
  return hkdf(ikm, 'nc-backup-pin-v1');
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I

/** 24 random characters (about 120 bits), shown as 6 groups of 4. */
export function newRecoveryCode(): string {
  const chars = Array.from(randomBytes(24), (b) => ALPHABET[b & 31]!).join('');
  return chars.match(/.{4}/g)!.join('-');
}
export const normaliseRecovery = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');
export const recoveryLooksRight = (code: string) =>
  normaliseRecovery(code).length === 24 &&
  [...normaliseRecovery(code)].every((c) => ALPHABET.includes(c));

export async function recoveryKeys(code: string): Promise<{ key: Uint8Array; check: string }> {
  const ikm = te.encode(normaliseRecovery(code));
  return {
    key: await hkdf(ikm, 'nc-backup-recovery-v1'),
    check: b64(await hkdf(ikm, 'nc-recovery-check-v1')),
  };
}

async function aes(keyBytes: Uint8Array, use: 'encrypt' | 'decrypt') {
  return subtle().importKey('raw', keyBytes as BufferSource, 'AES-GCM', false, [use]);
}
export async function seal(keyBytes: Uint8Array, data: Uint8Array): Promise<string> {
  const iv = randomBytes(12);
  const ct = new Uint8Array(
    await subtle().encrypt(
      { name: 'AES-GCM', iv },
      await aes(keyBytes, 'encrypt'),
      data as BufferSource,
    ),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64(out);
}
export async function open(keyBytes: Uint8Array, sealed: string): Promise<Uint8Array> {
  const raw = unb64(sealed);
  try {
    return new Uint8Array(
      await subtle().decrypt(
        { name: 'AES-GCM', iv: raw.slice(0, 12) },
        await aes(keyBytes, 'decrypt'),
        raw.slice(12) as BufferSource,
      ),
    );
  } catch {
    throw new Error('backup_unreadable');
  }
}

export interface BackupContent {
  v: 1;
  hospitals: PatientHospital[];
}
export const sealBackup = (backupKey: string, hospitals: PatientHospital[]) =>
  seal(unb64(backupKey), te.encode(JSON.stringify({ v: 1, hospitals } satisfies BackupContent)));
export async function openBackup(
  backupKey: Uint8Array,
  sealed: string,
): Promise<PatientHospital[]> {
  return (JSON.parse(td.decode(await open(backupKey, sealed))) as BackupContent).hospitals;
}

// ---------------------------------------------------------------- server calls

async function call<T>(
  kit: CaptureKitPlugin,
  endpoint: string,
  method: 'POST' | 'PUT',
  path: string,
  body: unknown,
  token?: string,
): Promise<T> {
  let r;
  try {
    r = await httpFor(kit, endpoint)(`${endpoint.replace(/\/+$/, '')}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ServerError('network');
  }
  const json = (await r.json().catch(() => null)) as {
    detail?: { code?: string } & Record<string, unknown>;
  } | null;
  if (r.status >= 400) {
    const err = new Error(
      json?.detail?.code ?? (r.status >= 500 ? 'server' : 'network'),
    ) as Error & {
      detail?: Record<string, unknown>;
    };
    err.detail = json?.detail ?? {};
    throw err;
  }
  return json as T;
}

export interface Tokens {
  access_token: string;
  refresh_token: string;
}
export interface Unlocked {
  tokens: Tokens;
  share: string;
  kdf_salt: string;
  backup: string | null;
  wrap_pin: string | null;
}

export const sendCode = (
  kit: CaptureKitPlugin,
  endpoint: string,
  email: string,
  purpose: 'signup' | 'signin' | 'recover',
) => call<{ sent: boolean }>(kit, endpoint, 'POST', '/account/code', { email, purpose });

export interface Phone {
  installId: string;
  deviceLabel: string;
}
const phone = (p: Phone) => ({
  install_id: p.installId,
  device_label: p.deviceLabel.slice(0, 120),
});

/**
 * Sign-up: creates the account, then a fresh backup key locked with the PIN key and the recovery
 * code. Returns what the phone keeps; the caller shows the recovery code once.
 */
export async function signUp(
  kit: CaptureKitPlugin,
  endpoint: string,
  email: string,
  code: string,
  pin: string,
  p: Phone,
  hospitals: PatientHospital[],
): Promise<{ local: AccountLocal; recoveryCode: string; access: string }> {
  const recoveryCode = newRecoveryCode();
  const rec = await recoveryKeys(recoveryCode);
  const salt = newSalt();
  const u = await call<Unlocked>(kit, endpoint, 'POST', '/account/signup', {
    email,
    code,
    pin,
    kdf_salt: salt,
    recovery_check: rec.check,
    ...phone(p),
  });
  const bk = randomBytes(32);
  const wrapPin = await seal(await pinKey(pin, salt, u.share), bk);
  const backupKey = b64(bk);
  await call(
    kit,
    endpoint,
    'PUT',
    '/account/backup',
    {
      backup: await sealBackup(backupKey, hospitals),
      wrap_pin: wrapPin,
      wrap_recovery: await seal(rec.key, bk),
      recovery_check: rec.check,
    },
    u.tokens.access_token,
  );
  return {
    recoveryCode,
    access: u.tokens.access_token,
    local: {
      endpoint,
      email,
      installId: p.installId,
      refreshToken: u.tokens.refresh_token,
      backupKey,
      wrapPin,
      deviceLabel: p.deviceLabel,
    },
  };
}

/** Reinstall / new phone. Throws Error('other_phone') with `detail` until `move` is true. */
export async function signIn(
  kit: CaptureKitPlugin,
  endpoint: string,
  email: string,
  code: string,
  pin: string,
  p: Phone,
  move: boolean,
): Promise<{ local: AccountLocal; hospitals: PatientHospital[]; access: string }> {
  const u = await call<Unlocked>(kit, endpoint, 'POST', '/account/signin', {
    email,
    code,
    pin,
    move,
    ...phone(p),
  });
  if (!u.wrap_pin) throw new Error('backup_missing');
  const bk = await open(await pinKey(pin, u.kdf_salt, u.share), u.wrap_pin);
  const hospitals = u.backup ? await openBackup(bk, u.backup) : [];
  return {
    hospitals,
    access: u.tokens.access_token,
    local: {
      endpoint,
      email,
      installId: p.installId,
      refreshToken: u.tokens.refresh_token,
      backupKey: b64(bk),
      wrapPin: u.wrap_pin,
      deviceLabel: p.deviceLabel,
    },
  };
}

/** Opening the app: the PIN is checked by the platform (every wrong try counts). */
export async function unlockAccount(
  kit: CaptureKitPlugin,
  a: AccountLocal,
  pin: string,
): Promise<{ local: AccountLocal; access: string }> {
  const u = await call<Unlocked>(kit, a.endpoint, 'POST', '/account/unlock', {
    refresh_token: a.refreshToken,
    pin,
  });
  return { access: u.tokens.access_token, local: { ...a, refreshToken: u.tokens.refresh_token } };
}

/** A fresh access token (joining a hospital, saving the backup) without asking the PIN again. */
export async function accountAccess(
  kit: CaptureKitPlugin,
  a: AccountLocal,
): Promise<{ local: AccountLocal; access: string }> {
  const t = await call<Tokens>(kit, a.endpoint, 'POST', '/account/refresh', {
    refresh_token: a.refreshToken,
  });
  return { access: t.access_token, local: { ...a, refreshToken: t.refresh_token } };
}

/** Saves the sealed hospital list (after joining, leaving or moving hospitals). */
export async function saveBackup(
  kit: CaptureKitPlugin,
  a: AccountLocal,
  hospitals: PatientHospital[],
): Promise<AccountLocal> {
  const { local, access } = await accountAccess(kit, a);
  await call(
    kit,
    a.endpoint,
    'PUT',
    '/account/backup',
    {
      backup: await sealBackup(a.backupKey, hospitals),
      wrap_pin: a.wrapPin,
    },
    access,
  );
  return local;
}

/**
 * Forgot PIN with the recovery code: opens the backup on this phone, sets the new PIN, then locks
 * the backup again with the new PIN and a new recovery code (the old one stops working).
 */
export async function resetWithRecovery(
  kit: CaptureKitPlugin,
  endpoint: string,
  email: string,
  code: string,
  recoveryCode: string,
  newPin: string,
  p: Phone,
): Promise<{ local: AccountLocal; hospitals: PatientHospital[]; recoveryCode: string }> {
  const r = await call<{ kdf_salt: string; backup: string | null; wrap_recovery: string | null }>(
    kit,
    endpoint,
    'POST',
    '/account/recover',
    { email, code },
  );
  if (!r.wrap_recovery) throw new Error('recovery_invalid');
  const rec = await recoveryKeys(recoveryCode);
  let bk: Uint8Array;
  try {
    bk = await open(rec.key, r.wrap_recovery);
  } catch {
    throw new Error('recovery_invalid');
  }
  const hospitals = r.backup ? await openBackup(bk, r.backup) : [];
  const salt = newSalt();
  const u = await call<Unlocked>(kit, endpoint, 'POST', '/account/reset-pin', {
    email,
    code,
    new_pin: newPin,
    recovery_check: rec.check,
    kdf_salt: salt,
    ...phone(p),
  });
  return finishReset(kit, endpoint, email, newPin, salt, u, bk, hospitals, p);
}

/** Last resort: no recovery code. The account stays; the backup starts again from this phone. */
export async function resetForgettingBackup(
  kit: CaptureKitPlugin,
  endpoint: string,
  email: string,
  code: string,
  newPin: string,
  p: Phone,
  hospitalsOnPhone: PatientHospital[],
): Promise<{ local: AccountLocal; hospitals: PatientHospital[]; recoveryCode: string }> {
  const salt = newSalt();
  const u = await call<Unlocked>(kit, endpoint, 'POST', '/account/reset-pin', {
    email,
    code,
    new_pin: newPin,
    forget_backup: true,
    kdf_salt: salt,
    ...phone(p),
  });
  return finishReset(kit, endpoint, email, newPin, salt, u, randomBytes(32), hospitalsOnPhone, p);
}

async function finishReset(
  kit: CaptureKitPlugin,
  endpoint: string,
  email: string,
  pin: string,
  salt: string,
  u: Unlocked,
  bk: Uint8Array,
  hospitals: PatientHospital[],
  p: Phone,
) {
  const recoveryCode = newRecoveryCode();
  const rec = await recoveryKeys(recoveryCode);
  const wrapPin = await seal(await pinKey(pin, salt, u.share), bk);
  const backupKey = b64(bk);
  await call(
    kit,
    endpoint,
    'PUT',
    '/account/backup',
    {
      backup: await sealBackup(backupKey, hospitals),
      wrap_pin: wrapPin,
      wrap_recovery: await seal(rec.key, bk),
      recovery_check: rec.check,
    },
    u.tokens.access_token,
  );
  return {
    hospitals,
    recoveryCode,
    local: {
      endpoint,
      email,
      installId: p.installId,
      refreshToken: u.tokens.refresh_token,
      backupKey,
      wrapPin,
      deviceLabel: p.deviceLabel,
    },
  };
}
