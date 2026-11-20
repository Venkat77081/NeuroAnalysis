/**
 * Dashboard API access (M14). Two servers:
 * - the NeuroCapture platform: accounts, phones, NCIDs, sessions, plans (never patient identity);
 * - the hospital connector, called straight from this browser with a 10-minute connector token:
 *   names, MRNs, live history, decrypted recordings, reviews, invites.
 *
 * The access token lives in memory only; the refresh token in this tab's sessionStorage, so a
 * reload stays signed in and closing the tab signs out.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

let apiUrl = 'http://localhost:8000';
/** v29: a deployment may shorten the undo window (config.json `undoSeconds`; tests use 2). */
let undoOverride: number | null = null;
export function undoSecondsOverride(): number | null {
  return undoOverride;
}
let access: string | null = null;
let connector: { token: string; url: string; until: number } | null = null;
const REFRESH = 'nc.dash.refresh';

export async function loadConfig(): Promise<void> {
  // `pnpm dev:stack` (.env.stack) points at the local test stack; built files use config.json.
  const fromEnv = import.meta.env.VITE_API_URL as string | undefined;
  if (fromEnv) {
    apiUrl = fromEnv.replace(/\/+$/, '');
    return;
  }
  try {
    const r = await fetch('./config.json', { cache: 'no-store' });
    if (r.ok) {
      const c = (await r.json()) as { apiUrl?: string; undoSeconds?: number };
      apiUrl = String(c.apiUrl ?? apiUrl).replace(/\/+$/, '');
      if (typeof c.undoSeconds === 'number' && c.undoSeconds >= 0) undoOverride = c.undoSeconds;
    }
  } catch {
    /* defaults */
  }
}

function storage(): Storage | null {
  try {
    return globalThis.sessionStorage;
  } catch {
    return null;
  }
}

export interface Tokens {
  access_token: string;
  refresh_token: string | null;
  role: string;
  site_id: string | null;
  two_step_setup_required: boolean;
}

export function setTokens(t: Tokens): void {
  access = t.access_token;
  connector = null;
  if (t.refresh_token) storage()?.setItem(REFRESH, t.refresh_token);
}

export function signOut(): void {
  access = null;
  connector = null;
  setReachable(true);
  storage()?.removeItem(REFRESH);
}

async function parse(r: Response): Promise<unknown> {
  if (r.status === 204) return null;
  const text = await r.text();
  return text ? (JSON.parse(text) as unknown) : null;
}

function errorOf(r: Response, body: unknown): ApiError {
  const d = (body as { detail?: unknown } | null)?.detail;
  const code =
    typeof d === 'object' && d && 'code' in d
      ? String((d as { code: unknown }).code)
      : `http_${r.status}`;
  return new ApiError(r.status, code);
}

async function raw(method: string, path: string, body?: unknown, auth = true): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth && access) headers.Authorization = `Bearer ${access}`;
  try {
    return await fetch(`${apiUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiError(0, 'network');
  }
}

/** Uses the stored refresh token (after a reload or an expired access token). */
export async function resume(): Promise<Tokens | null> {
  const rt = storage()?.getItem(REFRESH);
  if (!rt) return null;
  const r = await raw('POST', '/staff/refresh', { refresh_token: rt }, false);
  if (r.status !== 200) {
    signOut();
    return null;
  }
  const t = (await r.json()) as Tokens;
  setTokens(t);
  return t;
}

/** Platform call; refreshes once on 401. */
export async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let r = await raw(method, path, body);
  if (r.status === 401 && (await resume())) r = await raw(method, path, body);
  const out = await parse(r);
  if (!r.ok) throw errorOf(r, out);
  return out as T;
}

export async function publicCall<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await raw(method, path, body, false);
  const out = await parse(r);
  if (!r.ok) throw errorOf(r, out);
  return out as T;
}

async function connectorToken(): Promise<{ token: string; url: string }> {
  if (connector && connector.until > Date.now() + 30_000) return connector;
  const t = await call<{ token: string; expires_in: number; connector_url: string }>(
    'POST',
    '/hospital/connector-token',
  );
  connector = {
    token: t.token,
    url: t.connector_url.replace(/\/+$/, ''),
    until: Date.now() + t.expires_in * 1000,
  };
  return connector;
}

/**
 * v28: whether this browser can reach the hospital connector right now. When it cannot, pages show
 * patient codes (NCIDs) instead of names and the shell says why.
 */
let reachable = true;
const reachListeners = new Set<(ok: boolean) => void>();
function setReachable(ok: boolean): void {
  if (ok === reachable) return;
  reachable = ok;
  for (const l of reachListeners) l(ok);
}
export function connectorReachable(): boolean {
  return reachable;
}
export function onConnectorReach(listener: (ok: boolean) => void): () => void {
  reachListeners.add(listener);
  return () => reachListeners.delete(listener);
}

async function connectorRaw(method: string, path: string, body?: unknown): Promise<Response> {
  const c = await connectorToken();
  try {
    const r = await fetch(`${c.url}${path}`, {
      method,
      headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    setReachable(true);
    return r;
  } catch {
    setReachable(false);
    throw new ApiError(0, 'connector_unreachable');
  }
}

/** Hospital connector call (identity, history, recordings). Never goes through the platform. */
export async function hospital<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await connectorRaw(method, path, body);
  const out = await parse(r);
  if (!r.ok) throw errorOf(r, out);
  return out as T;
}

/** M15: a text document from the connector (the biomarker report's HTML). Never cached. */
export async function hospitalText(path: string): Promise<string> {
  const r = await connectorRaw('GET', path);
  if (!r.ok) throw errorOf(r, await parse(r).catch(() => null));
  return r.text();
}

/** A decrypted recording file as an object URL (revoke it when done). Never cached. */
export async function hospitalFile(path: string): Promise<string> {
  const r = await connectorRaw('GET', path);
  if (!r.ok) throw errorOf(r, await parse(r).catch(() => null));
  return URL.createObjectURL(await r.blob());
}
