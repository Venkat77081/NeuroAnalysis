import type { Patient } from '../session/machine.ts';
import type { ServerLink, SignedIn } from '../lib/uploads.ts';
import type { AppStore } from './store.ts';
import type { PatientHospital } from '../lib/hospitals.ts';
import type { AccountLocal } from '../lib/appaccount.ts';

const SESSION_KEY = 'session.current';

export interface Settings {
  operatorId: string;
  language: 'en' | 'hi';
  /** Doctor's frame-rate limit (fps) for the verdict; null = each test's config default. */
  minFps: number | null;
  /** Site enrollment (M7); null until this phone is registered with a server. */
  server: ServerLink | null;
  /** Operator signed in for uploads (tokens live inside CaptureKit, not here). */
  signedIn: SignedIn | null;
  /** null = config default (session.json `upload`). */
  wifiOnly: boolean | null;
  retentionHours: number | null;
  /** M13 (mock/dev only): clinic phone with a local operator and no server. */
  localDev: boolean;
  /** M13 patient app: which hospital invited this phone (no tokens; the patient is only an NCID). */
  patient: { hospital: string; ncid: string; consentVersion: string; consentAt: string } | null;
  /** M13: the operator must choose a new password before recording. */
  mustChangePassword: boolean;
  /** v3 patient app: every hospital joined (the first active one is also `server`/`patient`). */
  hospitals: PatientHospital[];
  /** v11 patient app account (decision 043); null on clinic phones and pre-v11 installs. */
  account: AccountLocal | null;
  /** New UI (decision 050): the patient's first name for the greeting. Kept on this phone only. */
  firstName: string | null;
}

export const defaultSettings: Settings = {
  operatorId: 'OP-LOCAL',
  language: 'en',
  minFps: null,
  server: null,
  signedIn: null,
  wifiOnly: null,
  retentionHours: null,
  localDev: false,
  patient: null,
  mustChangePassword: false,
  hospitals: [],
  account: null,
  firstName: null,
};

/** Patients, session snapshot and settings on top of an AppStore. */
export function repo(store: AppStore) {
  return {
    store,
    async listPatients(): Promise<Patient[]> {
      const keys = await store.keys('patient.');
      const all = await Promise.all(keys.map((k) => store.get<Patient>(k)));
      return all.filter((p): p is Patient => p !== null).sort((a, b) => a.ref.localeCompare(b.ref));
    },
    savePatient: (p: Patient) => store.put(`patient.${p.localId}`, p),
    async loadSession(): Promise<unknown | null> {
      return store.get(SESSION_KEY);
    },
    saveSession: (snapshot: unknown) => store.put(SESSION_KEY, snapshot),
    clearSession: () => store.delete(SESSION_KEY),
    async archiveSession(sessionId: string, summary: unknown) {
      await store.put(`sessiondone.${sessionId.toLowerCase()}`, summary);
    },
    async settings(): Promise<Settings> {
      return { ...defaultSettings, ...((await store.get<Partial<Settings>>('settings')) ?? {}) };
    },
    saveSettings: (s: Settings) => store.put('settings', s),
  };
}

export type Repo = ReturnType<typeof repo>;

/** Short display form of a patient reference, e.g. "••••0142" (§14: minimal identifiers on screen). */
export function maskRef(ref: string): string {
  return ref.length <= 4 ? ref : `••••${ref.slice(-4)}`;
}

/** Random local ID (not derived from patient data). */
export function newId(prefix: string): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return `${prefix}-${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}
