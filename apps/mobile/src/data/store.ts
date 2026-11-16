import type { CaptureKitPlugin } from '@neurocapture/capture-kit';

/** Key–value app data (JSON). Encrypted on a device (decision 011). */
export interface AppStore {
  readonly encrypted: boolean;
  get<T>(key: string): Promise<T | null>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix: string): Promise<string[]>;
}

/** Device store: CaptureKit's Keystore-encrypted secure store. */
export function kitStore(kit: CaptureKitPlugin): AppStore {
  return {
    encrypted: true,
    async get<T>(key: string) {
      const { json } = await kit.secureGet({ key });
      return json === null ? null : (JSON.parse(json) as T);
    },
    put: (key, value) => kit.securePut({ key, json: JSON.stringify(value) }),
    delete: (key) => kit.secureDelete({ key }),
    keys: async (prefix) => (await kit.secureKeys({ prefix })).keys,
  };
}

/** Development only (browser / mock mode): NOT encrypted. Never used with native capture. */
export function browserStore(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>,
  ns = 'nc.',
): AppStore {
  return {
    encrypted: false,
    async get<T>(key: string) {
      const raw = storage.getItem(ns + key);
      return raw === null ? null : (JSON.parse(raw) as T);
    },
    async put(key, value) {
      storage.setItem(ns + key, JSON.stringify(value));
    },
    async delete(key) {
      storage.removeItem(ns + key);
    },
    async keys(prefix) {
      const out: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k?.startsWith(ns + prefix)) out.push(k.slice(ns.length));
      }
      return out.sort();
    },
  };
}

/** In-memory Storage (tests, and a fallback when localStorage is unavailable). */
export function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}
