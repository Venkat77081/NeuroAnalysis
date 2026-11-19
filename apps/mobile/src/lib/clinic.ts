/**
 * Clinic phones (user, 16 Nov 2026): the day's clinic queue. The platform sends NCIDs and the
 * doctor's tests; the patient's name and MRN are read live from the hospital connector (only for
 * patients in the queue) and are never sent to NeuroCapture.
 */
import type { CaptureKitPlugin } from '@neurocapture/capture-kit';
import { api } from './accounts.ts';
import { httpFor } from './uploads.ts';

export interface QueueItem {
  request_id: string;
  ncid: string;
  at: string;
  doctor_name: string | null;
  tests: string[];
  /** v31 (decision 054): seconds per test for this patient's takes. */
  durations?: Record<string, number>;
  med_state: 'OFF' | 'ON' | 'ANY';
  state: 'open' | 'recorded' | 'not_recorded' | 'missed';
  recorded_by: string | null;
  not_done_reason: string | null;
  /** v16 (decision 047): the patient's consent: given in the app, waiting, or no app. */
  consent?: { state: 'app_given' | 'waiting' | 'no_app'; phone_allowed: boolean } | null;
  /** From the hospital's records, live (null when the records cannot be reached). */
  name?: string | null;
  mrn?: string | null;
}

/** Midnight to midnight on this phone, in its own time zone. */
export function today(now = new Date()): { from: string; to: string } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start.getTime() + 86_400_000);
  return { from: start.toISOString(), to: end.toISOString() };
}

export async function clinicQueue(kit: CaptureKitPlugin, now = new Date()): Promise<QueueItem[]> {
  const { from, to } = today(now);
  const q = new URLSearchParams({ from, to }).toString();
  const items = await api<QueueItem[]>(kit, 'GET', `/clinic/queue?${q}`);
  if (items.length === 0) return items;
  try {
    const ct = await api<{ token: string; connector_url: string }>(
      kit,
      'POST',
      '/auth/connector-token',
    );
    const base = ct.connector_url.replace(/\/+$/, '');
    const r = await httpFor(kit, base)(`${base}/v1/patients/lookup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${ct.token}` },
      body: JSON.stringify({ ncids: items.map((i) => i.ncid) }),
    });
    if (r.status === 200) {
      const rows = (await r.json()) as { ncid: string; mrn: string; name: string | null }[];
      const by = new Map(rows.map((x) => [x.ncid, x]));
      return items.map((i) => ({
        ...i,
        name: by.get(i.ncid)?.name ?? null,
        mrn: by.get(i.ncid)?.mrn ?? null,
      }));
    }
  } catch {
    /* names unavailable: the queue still works by MRN look-up */
  }
  return items;
}

export async function notRecorded(kit: CaptureKitPlugin, requestId: string, reason: string) {
  await api(kit, 'POST', `/clinic/requests/${requestId}/not-done`, { reason });
}

/**
 * Decision 044: may this hospital record now? (Its own video storage is connected and passing.)
 * Offline or an older server: assume yes; the upload waits on the phone as usual.
 */
export async function canRecord(
  kit: CaptureKitPlugin,
  profile?: string,
): Promise<{ canRecord: boolean; reason: string | null }> {
  try {
    const { json } = await kit.apiRequest({
      method: 'GET',
      path: '/sessions/can-record',
      ...(profile ? { profile } : {}),
    });
    const b = JSON.parse(json) as { can_record: boolean; reason: string | null };
    return { canRecord: b.can_record, reason: b.reason };
  } catch {
    return { canRecord: true, reason: null };
  }
}

/** v16: a consent confirmed for a clinic recording (scanned from the patient's app, or on this phone). */
export interface ConfirmedConsent {
  consent_id: string;
  source: 'patient_app' | 'clinic_phone';
  agreed_at: string;
  consent_version: string;
  reason?: string | null;
}

/** Checks the code the patient shows (QR text, or typed) for this clinic request. */
export function scanConsent(
  kit: CaptureKitPlugin,
  requestId: string,
  code: string,
): Promise<ConfirmedConsent> {
  return api<ConfirmedConsent>(kit, 'POST', `/clinic/requests/${requestId}/consent-scan`, { code });
}

/** The patient read and agreed on this clinic phone (no app, or cannot show the code). */
export function phoneConsent(
  kit: CaptureKitPlugin,
  requestId: string,
  reason: string,
  consentVersion: string,
): Promise<ConfirmedConsent> {
  return api<ConfirmedConsent>(kit, 'POST', `/clinic/requests/${requestId}/consent-on-phone`, {
    reason,
    consent_version: consentVersion,
  });
}
