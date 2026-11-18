/**
 * v3 patient app: every hospital this patient joined. Each one knows the patient under its own
 * NCID and has its own sign-in, take key and upload profile inside CaptureKit; NeuroCapture never
 * links them. Only this phone lists them together.
 *
 * The first hospital uses CaptureKit's default upload profile (so installs from before v3 keep
 * their sign-in); later ones get a profile named after the hospital's site.
 */
import { DEFAULT_UPLOAD_PROFILE, type CaptureKitPlugin } from '@neurocapture/capture-kit';
import type { Settings } from '../data/repo.ts';
import type { ServerLink } from './uploads.ts';

export interface PatientHospital {
  /** CaptureKit upload profile ([a-z0-9][a-z0-9_-]{0,39}). */
  profile: string;
  hospital: string;
  ncid: string;
  link: ServerLink;
  joinedAt: string;
  /** Set when the patient withdrew from this hospital; history stays readable on the phone. */
  withdrawnAt: string | null;
}

/** A patient's open or past recording request (GET /patient/requests). */
export interface PatientRequest {
  id: string;
  kind: 'appointment' | 'rerecord';
  /** clinic = recorded at the visit by the hospital: shown as information, no record button. */
  place?: 'home' | 'clinic';
  appointment_at: string | null;
  doctor_name: string | null;
  tests: string[];
  med_state: 'OFF' | 'ON' | 'ANY';
  due_at: string;
  state: 'open' | 'recorded' | 'missed' | 'cancelled';
  /** v16: clinic requests: the patient's consent given in the app (active) or confirmed (used). */
  clinic_consent?: { status: 'active' | 'used'; source: string; valid_until: string } | null;
}

/** The hospitals in the settings, including a pre-v3 single hospital. */
export function hospitalsOf(s: Settings): PatientHospital[] {
  if (s.hospitals.length > 0) return s.hospitals;
  if (s.patient && s.server)
    return [
      {
        profile: DEFAULT_UPLOAD_PROFILE,
        hospital: s.patient.hospital,
        ncid: s.patient.ncid,
        link: s.server,
        joinedAt: s.patient.consentAt,
        withdrawnAt: null,
      },
    ];
  return [];
}

export const activeHospitals = (s: Settings) => hospitalsOf(s).filter((h) => !h.withdrawnAt);

/** The profile for a newly joined hospital: re-joining the same site keeps its profile. */
export function profileFor(existing: PatientHospital[], siteId: string): string {
  const same = existing.find((h) => h.link.siteId === siteId);
  if (same) return same.profile;
  if (existing.length === 0) return DEFAULT_UPLOAD_PROFILE;
  const base = `h-${siteId.toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 40);
  let p = base.length > 2 ? base : `h-${existing.length + 1}`;
  for (let i = 2; existing.some((h) => h.profile === p); i++) p = `${base.slice(0, 36)}-${i}`;
  return p;
}

/** Adds (or, on re-joining, replaces) a hospital; the first active one is also `server`/`patient`. */
export function withHospital(s: Settings, h: PatientHospital): Settings {
  const rest = hospitalsOf(s).filter((x) => x.profile !== h.profile);
  return syncPrimary({ ...s, hospitals: [...rest, h] });
}

export function withdrawnFrom(s: Settings, profile: string, at: string): Settings {
  return syncPrimary({
    ...s,
    hospitals: hospitalsOf(s).map((h) => (h.profile === profile ? { ...h, withdrawnAt: at } : h)),
  });
}

function syncPrimary(s: Settings): Settings {
  const first = s.hospitals.find((h) => !h.withdrawnAt) ?? s.hospitals[0];
  if (!first) return s;
  return {
    ...s,
    server: first.link,
    patient: {
      hospital: first.hospital,
      ncid: first.ncid,
      consentVersion: s.patient?.consentVersion ?? '',
      consentAt: s.patient?.consentAt ?? first.joinedAt,
    },
  };
}

/** A signed-in call for one hospital (its profile's tokens, inside CaptureKit). */
export async function hospitalApi<T>(
  kit: CaptureKitPlugin,
  h: PatientHospital,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const { json } = await kit.apiRequest({
    method,
    path,
    profile: h.profile,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return JSON.parse(json) as T;
}

/** Store keys for what the phone last saw of a hospital (shown offline and after withdrawing). */
export const cacheKey = (
  h: PatientHospital,
  what: 'requests' | 'sessions' | 'plan' | 'appointments' | 'appointment-history',
) => `patient.h.${h.profile}.${what}`;
