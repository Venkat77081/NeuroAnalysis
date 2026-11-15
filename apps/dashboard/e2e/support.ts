import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';

export const WORK = resolve('test-results/stack');

export interface Stack {
  site_id: string;
  password: string;
  root_email: string;
  root_totp: string;
  admin_email: string;
  admin_totp: string;
  doctor_email: string;
  doctor_totp: string;
  new_doctor_email: string;
  desk_email: string;
  desk_totp: string;
  doctor2_email: string;
  doctor2_totp: string;
  platform_url: string;
  patient_ncid: string;
  patient_mrn: string;
  take_id: string;
}

export function stack(): Stack {
  return JSON.parse(readFileSync(`${WORK}/stack.json`, 'utf8')) as Stack;
}

export function python(): string {
  const venv = resolve('../../connector/.venv/bin/python');
  return process.env.NC_E2E_PYTHON ?? (existsSync(venv) ? venv : 'python3');
}

/** RFC 6238 code (30 s, 6 digits, SHA-1) — what an authenticator app shows. */
export function totp(secret: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.replace(/=+$/, ''))
    bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const h = createHmac('sha1', key).update(msg).digest();
  const off = h[h.length - 1]! & 0x0f;
  return String((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

export async function signIn(page: Page, email: string, secret: string): Promise<void> {
  const s = stack();
  await page.goto('/');
  await page.getByTestId('email').fill(email);
  await page.getByTestId('password').fill(s.password);
  await page.getByTestId('sign-in').click();
  await page.getByTestId('two-step-code').fill(totp(secret));
  await page.getByTestId('two-step-verify').click();
  await expect(page.getByTestId('who')).toBeVisible();
}

/** The M14 acceptance scan of NeuroCapture's database, log file and stored objects. */
export function scanPlatform(needles: string[]): { found: string[]; audit_rows: number } {
  try {
    const out = execFileSync(
      python(),
      ['e2e/stack/scan_platform.py', `${WORK}/stack.json`, ...needles],
      {
        encoding: 'utf8',
      },
    );
    return JSON.parse(out) as { found: string[]; audit_rows: number };
  } catch (e) {
    return JSON.parse((e as { stdout: string }).stdout) as { found: string[]; audit_rows: number };
  }
}

/** Signs in to the platform API directly (no browser) and returns an access token. */
export async function apiToken(email: string, secret: string): Promise<string> {
  const s = stack();
  const post = async (path: string, body: unknown) =>
    (await fetch(`${s.platform_url}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json())) as Record<string, string>;
  const { challenge_token } = await post('/staff/login', { email, password: s.password });
  return (await post('/staff/login/two-step', { challenge_token, code: totp(secret) }))
    .access_token!;
}

/** The receptionist assigns the seeded patient to a doctor (API, for tests that need it). */
export async function assignPatient(doctorEmail: string): Promise<void> {
  const s = stack();
  const tok = await apiToken(s.desk_email, s.desk_totp);
  const h = { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' };
  const docs = (await fetch(`${s.platform_url}/hospital/doctors`, { headers: h }).then((r) =>
    r.json(),
  )) as {
    id: string;
    email: string;
  }[];
  const id = docs.find((d) => d.email === doctorEmail)!.id;
  const r = await fetch(`${s.platform_url}/hospital/patients/${s.patient_ncid}/doctor`, {
    method: 'PUT',
    headers: h,
    body: JSON.stringify({ doctor_id: id }),
  });
  if (!r.ok) throw new Error(`assign failed: ${r.status}`);
}
