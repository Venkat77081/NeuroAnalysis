import type { Patient } from '../session/machine.ts';
import type { AppStore } from './store.ts';

const SESSION_KEY = 'session.current';

export interface Settings {
  operatorId: string;
  language: 'en' | 'hi';
  /** Doctor's frame-rate limit (fps) for the verdict; null = each test's config default. */
  minFps: number | null;
}

export const defaultSettings: Settings = { operatorId: 'OP-LOCAL', language: 'en', minFps: null };

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
