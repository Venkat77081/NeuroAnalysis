/**
 * In-memory stand-in for the NeuroCapture API (backend/app/api) used by the mock camera and the
 * browser tests. Same paths, bodies and status codes as the real server for the upload protocol
 * and auth. Not for clinical use. `online = false` makes every request fail like a dropped network.
 */
import type { Http, HttpResponse } from './protocol.ts';
import { sha256Hex } from './protocol.ts';

const DEV_PEM = '-----BEGIN PUBLIC KEY-----\nFAKE-SERVER-KEY\n-----END PUBLIC KEY-----\n';

interface FFile {
  kind: string;
  size: number;
  sha256: string;
  parts: Map<number, Uint8Array>;
  verified: boolean;
  upload: number;
}

export class FakeServer {
  online = true;
  partSize = 64 * 1024;
  /** Corrupt the next part received (checksum-mismatch test). */
  corruptNextPart = false;
  readonly enrollmentCode = 'DEMO-SITE-1';
  private seq = 0;
  private devices = new Map<string, string>();
  private refresh = new Map<string, string>();
  private sessions = new Map<string, { id: string; closed: boolean }>();
  private takes = new Map<
    string,
    { id: string; status: string; files: Map<string, FFile>; confirmedAt?: string }
  >();
  readonly log: string[] = [];

  private id(p: string) {
    return `${p}${++this.seq}`;
  }

  private tokens(op: string) {
    const refresh = this.id('rt');
    this.refresh.set(refresh, op);
    return {
      access_token: `at-${op}-${this.seq}`,
      refresh_token: refresh,
      expires_in: 900,
      operator_id: op,
      role: 'operator',
    };
  }

  private plan(takeId: string) {
    const t = this.takes.get(takeId)!;
    return {
      take_id: t.id,
      status: t.status,
      files: [...t.files.values()].map((f) => {
        const total = Math.max(1, Math.ceil(f.size / this.partSize));
        const missing = Array.from({ length: total }, (_, i) => i + 1).filter(
          (n) => !f.parts.has(n),
        );
        return {
          kind: f.kind,
          part_size: this.partSize,
          parts_total: total,
          parts: f.verified
            ? []
            : missing.map((n) => ({
                number: n,
                url: `fake://part/${t.id}/${f.kind}/${f.upload}/${n}`,
              })),
          uploaded_parts: f.verified
            ? []
            : [...f.parts.keys()]
                .sort((a, b) => a - b)
                .map((n) => ({ number: n, etag: `e${f.upload}-${n}` })),
          verified: f.verified,
        };
      }),
    };
  }

  takeStatus(takeId: string) {
    return [...this.takes.values()].find((t) => t.id === takeId)?.status;
  }

  /** Closed (PATCH received) — looked up by the phone's session ID. */
  sessionClosed(clientSessionId: string) {
    return this.sessions.get(clientSessionId)?.closed ?? false;
  }

  /** fetch-like entry point. */
  readonly http: Http = async (url, init) => {
    if (!this.online) throw new TypeError('network error (fake server offline)');
    const res = (status: number, body: unknown = {}, etag: string | null = null): HttpResponse => ({
      status,
      etag,
      json: async () => body,
    });
    const path = url.replace(/^[a-z]+:\/\/[^/]+/, '');
    const body =
      typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const authed = init.headers?.Authorization?.startsWith('Bearer at-') ?? false;
    this.log.push(`${init.method} ${path.split('?')[0]}`);

    if (url.startsWith('fake://part/')) {
      const [takeId, kind, upload, n] = url.slice('fake://part/'.length).split('/');
      const f = this.takes.get(takeId!)?.files.get(kind!);
      if (!f || String(f.upload) !== upload) return res(403);
      let data = init.body as Uint8Array;
      if (this.corruptNextPart) {
        this.corruptNextPart = false;
        data = new Uint8Array(data.length).fill(7);
      }
      f.parts.set(Number(n), data);
      return res(200, {}, `"e${f.upload}-${n}"`);
    }
    if (path === '/auth/device-register' && init.method === 'POST') {
      if (body.enrollment_code !== this.enrollmentCode)
        return res(403, { detail: 'unknown enrollment code' });
      const id = this.id('dev');
      const secret = this.id('secret');
      this.devices.set(id, secret);
      return res(201, {
        device_id: id,
        device_secret: secret,
        site_id: 'site1',
        patient_ref_salt: 'fake-salt',
        server_key: { key_id: 'fake-key-1', public_key_pem: DEV_PEM },
      });
    }
    if (path === '/auth/login' && init.method === 'POST') {
      if (this.devices.get(String(body.device_id)) !== body.device_secret) return res(401);
      if (!/^[A-Z0-9-]{2,20}$/.test(String(body.operator_code)) || String(body.pin) !== '2468')
        return res(401);
      return res(200, this.tokens(String(body.operator_code)));
    }
    if (path === '/auth/refresh' && init.method === 'POST') {
      const op = this.refresh.get(String(body.refresh_token));
      if (!op) return res(401);
      this.refresh.delete(String(body.refresh_token));
      return res(200, this.tokens(op));
    }
    if (!authed) return res(401);
    if (path === '/sessions' && init.method === 'POST') {
      const key = String(body.client_session_id);
      if (!this.sessions.has(key)) this.sessions.set(key, { id: this.id('S'), closed: false });
      const s = this.sessions.get(key)!;
      return res(201, { id: s.id, client_session_id: key });
    }
    const sm = /^\/sessions\/([^/]+)$/.exec(path);
    if (sm && init.method === 'PATCH') {
      const s = [...this.sessions.values()].find((x) => x.id === sm[1]);
      if (!s) return res(404);
      s.closed = true;
      return res(200, { id: s.id });
    }
    if (path === '/takes' && init.method === 'POST') {
      const key = `${String(body.session_id)}/${String(body.client_take_id)}`;
      if (!this.takes.has(key)) {
        const files = new Map<string, FFile>();
        for (const f of body.files as { kind: string; size_bytes: number; sha256: string }[])
          files.set(f.kind, {
            kind: f.kind,
            size: f.size_bytes,
            sha256: f.sha256,
            parts: new Map(),
            verified: false,
            upload: 1,
          });
        const id = this.id('T');
        this.takes.set(id, { id, status: 'uploading', files });
        this.takes.set(key, this.takes.get(id)!);
      }
      return res(201, this.plan(this.takes.get(key)!.id));
    }
    const up = /^\/takes\/([^/]+)\/upload$/.exec(path);
    if (up) return this.takes.has(up[1]!) ? res(200, this.plan(up[1]!)) : res(404);
    const fc = /^\/takes\/([^/]+)\/files\/([^/]+)\/complete$/.exec(path);
    if (fc) {
      const t = this.takes.get(fc[1]!);
      const f = t?.files.get(fc[2]!);
      if (!t || !f) return res(404);
      if (!f.verified) {
        const total = Math.max(1, Math.ceil(f.size / this.partSize));
        if (f.parts.size < total) return res(409, { detail: { code: 'parts_incomplete' } });
        const all = new Uint8Array(f.size);
        let off = 0;
        for (let n = 1; n <= total; n++) {
          all.set(f.parts.get(n)!, off);
          off += f.parts.get(n)!.length;
        }
        if ((await sha256Hex(all)) !== f.sha256) {
          f.parts.clear();
          f.upload++;
          return res(409, { detail: { code: 'checksum_mismatch', kind: f.kind } });
        }
        f.verified = true;
        f.parts.clear();
      }
      return res(200, this.plan(t.id));
    }
    const tc = /^\/takes\/([^/]+)\/complete$/.exec(path);
    if (tc) {
      const t = this.takes.get(tc[1]!);
      if (!t) return res(404);
      if ([...t.files.values()].some((f) => !f.verified))
        return res(409, { detail: { code: 'files_pending' } });
      t.status = 'complete';
      t.confirmedAt ??= new Date().toISOString();
      return res(200, { take_id: t.id, status: t.status, confirmed_at: t.confirmedAt });
    }
    return res(404);
  };
}
