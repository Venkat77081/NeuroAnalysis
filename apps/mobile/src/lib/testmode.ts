/**
 * Test mode for the debug APK (decision 041, user 17 Nov 2026: "bypass the server, add a fake
 * queue, record links and clinic recordings, so I can install it on a phone and check"). A pretend
 * hospital lives in the app: sign-in, the clinic queue, invites, record links and the clinic notice
 * are answered by the same fake server the browser version uses. The camera, the camera check and
 * every quality check are the real ones. Nothing is uploaded and nothing leaves the phone.
 *
 * Off in release builds (VITE_PRODUCTION=1). The switch is kept in the WebView's localStorage and
 * read once at start-up; turning it on or off wipes the app's data first (resetApp).
 */
import {
  DEFAULT_UPLOAD_PROFILE,
  FakeServer,
  type CaptureKitPlugin,
  type UploadConfig,
} from '@neurocapture/capture-kit';

const KEY = 'nc.testMode';
export const TEST_MODE_AVAILABLE = import.meta.env.VITE_PRODUCTION !== '1';
export const TEST_ENDPOINT = 'fake://api';

export function testModeOn(): boolean {
  if (!TEST_MODE_AVAILABLE) return false;
  try {
    return globalThis.localStorage?.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function setTestMode(on: boolean): void {
  try {
    if (on) globalThis.localStorage?.setItem(KEY, '1');
    else globalThis.localStorage?.removeItem(KEY);
  } catch {
    /* no storage: test mode stays off */
  }
}

let server: FakeServer | null = null;

/** The pretend hospital (one per app start; it forgets on restart, so it is lenient). */
export function testServer(): FakeServer {
  if (!server) {
    server = new FakeServer();
    server.lenient = true;
    server.hospital = 'Test Hospital';
  }
  return server;
}

/**
 * An invite from the pretend hospital. The first one joins the test hospital; later ones join a
 * new one ("Test Hospital 2", …) with its own site, so the patient app lists them separately.
 * (Every invite used to name the same site, so the app took a second one as re-joining the first.)
 */
export function testHospitalInvite(fake: FakeServer, joined: number): string {
  const n = joined + 1;
  return n === 1
    ? fake.issueInvite()
    : fake.issueInvite(undefined, { siteId: `site${n}`, hospital: `${fake.hospital} ${n}` });
}

type Cfg = UploadConfig & { accessToken: string; refreshToken: string };

/**
 * The native kit with its server calls answered by the pretend hospital. Camera, recording,
 * tracking, the benchmark and the secure store stay native; uploads are switched off.
 */
export function withTestHospital(kit: CaptureKitPlugin): CaptureKitPlugin {
  const cfgs = new Map<string, Cfg>();
  const fake = testServer();
  const own: Partial<CaptureKitPlugin> = {
    async configureUploads(opts: UploadConfig) {
      const profile = opts.profile ?? DEFAULT_UPLOAD_PROFILE;
      const old = cfgs.get(profile);
      const accessToken = opts.accessToken ?? old?.accessToken;
      const refreshToken = opts.refreshToken ?? old?.refreshToken;
      if (accessToken && refreshToken) cfgs.set(profile, { ...opts, accessToken, refreshToken });
    },
    async clearUploadCredentials(opts?: { profile?: string }) {
      cfgs.delete(opts?.profile ?? DEFAULT_UPLOAD_PROFILE);
    },
    async enqueueUpload() {
      /* test mode: recordings stay on this phone */
    },
    async retryUploads() {},
    async listUploads() {
      return { uploads: [] };
    },
    async apiRequest(opts: {
      method: 'GET' | 'POST';
      path: string;
      body?: string;
      profile?: string;
    }) {
      const cfg = cfgs.get(opts.profile ?? DEFAULT_UPLOAD_PROFILE);
      if (!cfg) throw new Error('login_required');
      const send = () =>
        fake.http(`${TEST_ENDPOINT}${opts.path}`, {
          method: opts.method,
          headers: {
            Authorization: `Bearer ${cfg.accessToken}`,
            'Content-Type': 'application/json',
          },
          ...(opts.body !== undefined ? { body: opts.body } : {}),
        });
      let res = await send();
      if (res.status === 401) {
        const r = await fake.http(`${TEST_ENDPOINT}${cfg.refreshPath ?? '/auth/refresh'}`, {
          method: 'POST',
          body: JSON.stringify({ refresh_token: cfg.refreshToken }),
        });
        if (r.status !== 200) throw new Error('login_required');
        const tk = (await r.json()) as { access_token: string; refresh_token: string };
        cfg.accessToken = tk.access_token;
        cfg.refreshToken = tk.refresh_token;
        res = await send();
        if (res.status === 401) throw new Error('login_required');
      }
      const json = (await res.json().catch(() => null)) as unknown;
      if (res.status >= 400)
        throw new Error(
          (json as { detail?: { code?: string } } | null)?.detail?.code ?? `http_${res.status}`,
        );
      return { json: JSON.stringify(json ?? null) };
    },
  };
  return new Proxy(kit, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && prop in own) return own[prop as keyof CaptureKitPlugin];
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}
