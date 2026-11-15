/**
 * In-memory stand-in for the NeuroCapture API (backend/app/api) used by the mock camera and the
 * browser tests. Same paths, bodies and status codes as the real server for the upload protocol
 * and auth. Not for clinical use. `online = false` makes every request fail like a dropped network.
 */
import type { Http, HttpResponse } from './protocol.ts';
import { sha256Hex } from './protocol.ts';

const DEV_PEM = '-----BEGIN PUBLIC KEY-----\nFAKE-SERVER-KEY\n-----END PUBLIC KEY-----\n';
/** M12: the (fake) hospital take key every session gets. */
const HOSPITAL_KEY = {
  key_id: 'hk-fake-1',
  public_key_pem: '-----BEGIN PUBLIC KEY-----\nFAKE-HOSPITAL-KEY\n-----END PUBLIC KEY-----\n',
  owner: 'hospital',
};

interface FakePatient {
  ncid: string;
  pin: string;
  deviceId: string;
  deviceSecret: string;
  status: 'active' | 'locked' | 'closed';
  failed: number;
}

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
  private sessions = new Map<
    string,
    { id: string; closed: boolean; patient: string | null; startedAt: string; medState: string }
  >();
  /** Operators: ID → password (M13). OP-07 keeps the pre-M13 PIN; OP-NEW must change its temporary one. */
  readonly operators = new Map<string, { password: string; mustChange: boolean }>([
    ['OP-07', { password: '2468', mustChange: false }],
    ['OP-NEW', { password: 'temp-pass-1234', mustChange: true }],
  ]);
  readonly hospital = 'Demo Hospital';
  /** Home recording plan the (fake) doctor set. */
  homePlan = {
    tests: ['FT', 'FTF', 'FR', 'SAW', 'FA'],
    every_days: 7,
    med_state: 'OFF',
    default: true,
  };
  private principals = new Map<string, { kind: 'operator' | 'patient'; id: string }>();
  private invites = new Map<string, { used: boolean; ncid: string }>();
  readonly patients = new Map<string, FakePatient>();
  /** The hospital connector's NCID map (fake://connector): MRN → NCID. */
  readonly connectorMap = new Map<string, string>();
  /** Take key IDs received (tests check none is the platform key). */
  readonly takeKeyIds: string[] = [];
  /** Crash reports received (M9). */
  readonly diagnostics: unknown[] = [];
  private takes = new Map<
    string,
    {
      id: string;
      status: string;
      files: Map<string, FFile>;
      confirmedAt?: string;
      sessionId?: string;
    }
  >();
  readonly log: string[] = [];

  private id(p: string) {
    return `${p}${++this.seq}`;
  }

  private tokens(op: string, kind: 'operator' | 'patient' = 'operator') {
    const refresh = this.id('rt');
    this.refresh.set(refresh, `${kind}:${op}`);
    const access = `at-${op}-${this.seq}`;
    this.principals.set(access, { kind, id: op });
    return {
      access_token: access,
      refresh_token: refresh,
      expires_in: 900,
      operator_id: op,
      role: kind,
      must_change_password: kind === 'operator' && (this.operators.get(op)?.mustChange ?? false),
    };
  }

  private ncid(): string {
    const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join(
      '',
    );
    return `nc_${hex}`;
  }

  /** Test hook: a hospital admin sends a home-recording invite; returns the link in the e-mail. */
  issueInvite(): string {
    const token = `inv${++this.seq}${Math.random().toString(36).slice(2, 10)}`;
    this.invites.set(token, { used: false, ncid: this.ncid() });
    return `neurocapture://invite?t=${token}`;
  }

  /** Sessions recorded by a patient (home) — for tests. */
  homeSessions() {
    return [...this.sessions.values()].filter((s) => s.patient !== null);
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
    if (url.startsWith('fake://connector/')) return this.connector(path, init, body, res);
    if (path === '/auth/login' && init.method === 'POST') {
      if (this.devices.get(String(body.device_id)) !== body.device_secret) return res(401);
      const op = this.operators.get(String(body.operator_code));
      const secret = String(body.password ?? body.pin ?? '');
      if (!op || op.password !== secret) return res(401);
      return res(200, this.tokens(String(body.operator_code)));
    }
    if ((path === '/auth/refresh' || path === '/patient/refresh') && init.method === 'POST') {
      const who = this.refresh.get(String(body.refresh_token));
      if (!who) return res(401);
      const [kind, id] = who.split(':') as ['operator' | 'patient', string];
      if ((kind === 'patient') !== (path === '/patient/refresh')) return res(401);
      if (kind === 'patient' && this.patients.get(id)?.status !== 'active') return res(401);
      this.refresh.delete(String(body.refresh_token));
      return res(200, this.tokens(id, kind));
    }
    const pr = this.patientPublic(path, init, body, res);
    if (pr) return pr;
    if (!authed) return res(401);
    const me = this.principals.get(String(init.headers?.Authorization).slice('Bearer '.length));
    if (!me) return res(401);
    if (me.kind === 'patient' && this.patients.get(me.id)?.status !== 'active') return res(401);
    const mine = this.authed(path, init, body, res, me);
    if (mine) return mine;
    if (path === '/sessions' && init.method === 'POST') {
      const key = String(body.client_session_id);
      const who = me.kind === 'patient' ? me.id : null;
      if (me.kind === 'operator' && body.patient && !(body.patient as { ncid?: string }).ncid)
        return res(422, { detail: { code: 'ncid_required' } });
      if (!this.sessions.has(key))
        this.sessions.set(key, {
          id: this.id('S'),
          closed: false,
          patient: who,
          startedAt: String(body.started_at),
          medState: String(body.med_state),
        });
      const s = this.sessions.get(key)!;
      return res(201, { id: s.id, client_session_id: key, encryption_key: HOSPITAL_KEY });
    }
    const sm = /^\/sessions\/([^/]+)$/.exec(path);
    if (sm && init.method === 'PATCH') {
      const s = [...this.sessions.values()].find((x) => x.id === sm[1]);
      if (!s) return res(404);
      s.closed = true;
      return res(200, { id: s.id });
    }
    if (path === '/diagnostics' && init.method === 'POST') {
      this.diagnostics.push(body);
      return res(201, { status: 'stored' });
    }
    if (path === '/takes' && init.method === 'POST') {
      if (body.key_id !== HOSPITAL_KEY.key_id)
        return res(422, { detail: { code: 'wrong_key', expected: HOSPITAL_KEY.key_id } });
      this.takeKeyIds.push(String(body.key_id));
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
        this.takes.set(id, { id, status: 'uploading', files, sessionId: String(body.session_id) });
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

  /** Patient endpoints that need no access token (invite, PIN sign-in). */
  private patientPublic(
    path: string,
    init: { method: string },
    body: Record<string, unknown>,
    res: (s: number, b?: unknown) => HttpResponse,
  ): HttpResponse | null {
    if (init.method !== 'POST') return null;
    if (path === '/patient/invite/lookup' || path === '/patient/invite/accept') {
      const inv = this.invites.get(String(body.token));
      if (!inv || inv.used) return res(403, { detail: { code: 'invite_invalid' } });
      if (path === '/patient/invite/lookup')
        return res(200, {
          hospital: this.hospital,
          kind: 'hospital',
          consent_version: 'home-consent@1',
          pin_min_digits: 4,
          pin_max_digits: 6,
        });
      const pin = String(body.pin);
      if (!/^\d{4,6}$/.test(pin)) return res(422, { detail: { code: 'pin_format' } });
      if (body.consent_version !== 'home-consent@1')
        return res(422, { detail: { code: 'consent_version' } });
      inv.used = true;
      const acc = this.id('pa');
      const deviceId = this.id('pdev');
      const deviceSecret = this.id('psecret');
      this.patients.set(acc, {
        ncid: inv.ncid,
        pin,
        deviceId,
        deviceSecret,
        status: 'active',
        failed: 0,
      });
      return res(201, {
        device_id: deviceId,
        device_secret: deviceSecret,
        site_id: 'site1',
        hospital: this.hospital,
        ncid: inv.ncid,
        server_key: { key_id: 'fake-key-1', public_key_pem: DEV_PEM },
        tokens: this.tokens(acc, 'patient'),
      });
    }
    if (path === '/patient/login') {
      const entry = [...this.patients.entries()].find(
        ([, p]) => p.deviceId === body.device_id && p.deviceSecret === body.device_secret,
      );
      if (!entry || entry[1].status === 'closed') return res(401);
      const [acc, p] = entry;
      if (p.status === 'locked') return res(403, { detail: { code: 'pin_locked' } });
      if (String(body.pin) !== p.pin) {
        p.failed++;
        if (p.failed >= 5) {
          p.status = 'locked';
          return res(403, { detail: { code: 'pin_locked' } });
        }
        return res(401);
      }
      p.failed = 0;
      return res(200, this.tokens(acc, 'patient'));
    }
    return null;
  }

  /** Signed-in endpoints added in M13 (patients, operators). */
  private authed(
    path: string,
    init: { method: string },
    body: Record<string, unknown>,
    res: (s: number, b?: unknown) => HttpResponse,
    me: { kind: 'operator' | 'patient'; id: string },
  ): HttpResponse | null {
    const patient = me.kind === 'patient' ? this.patients.get(me.id) : undefined;
    if (path.startsWith('/patient/') && !patient) return res(403);
    if (path === '/patient/me' && init.method === 'GET')
      return res(200, { ncid: patient!.ncid, hospital: this.hospital, status: patient!.status });
    if (path === '/patient/plan' && init.method === 'GET') {
      const mine = this.homeSessions().filter((s) => s.patient === me.id);
      const last =
        mine
          .map((s) => s.startedAt)
          .sort()
          .pop() ?? null;
      const next = last ? new Date(Date.parse(last) + this.homePlan.every_days * 86_400_000) : null;
      return res(200, {
        ...this.homePlan,
        last_session_at: last,
        next_due: next?.toISOString() ?? null,
        due_now: !next || next.getTime() <= Date.now(),
      });
    }
    if (path === '/patient/sessions' && init.method === 'GET') {
      const mine = [...this.sessions.entries()].filter(([, s]) => s.patient === me.id);
      return res(
        200,
        mine.map(([client, s]) => ({
          id: s.id,
          client_session_id: client,
          started_at: s.startedAt,
          ended_at: null,
          med_state: s.medState,
          recorded_by: 'patient',
          takes_uploaded: [...this.takes.values()].filter(
            (t, i, all) => all.indexOf(t) === i && t.status === 'complete' && t.sessionId === s.id,
          ).length,
        })),
      );
    }
    if (path === '/patient/consent/withdraw' && init.method === 'POST') {
      patient!.status = 'closed';
      return res(200, {
        status: 'closed',
        deletion_request_id: body.delete_recordings ? this.id('del') : null,
      });
    }
    if (me.kind !== 'operator') return null;
    const op = this.operators.get(me.id);
    if (path === '/auth/change-password' && init.method === 'POST') {
      if (!op || op.password !== body.current_password) return res(401);
      const pw = String(body.new_password);
      if (pw.length < 10 || !/[a-z]/i.test(pw) || !/\d/.test(pw) || pw === op.password)
        return res(422, { detail: { code: 'weak_password' } });
      op.password = pw;
      op.mustChange = false;
      return res(204);
    }
    if (op?.mustChange && (path === '/sessions' || path === '/auth/connector-token'))
      return res(403, { detail: { code: 'password_change_required' } });
    if (path === '/auth/connector-token' && init.method === 'POST')
      return res(200, { token: `ct-${me.id}`, expires_in: 600, connector_url: 'fake://connector' });
    return null;
  }

  /** The hospital connector (fake://connector): NCID by MRN for clinic phones. */
  private connector(
    path: string,
    init: { method: string; headers?: Record<string, string> },
    body: Record<string, unknown>,
    res: (s: number, b?: unknown) => HttpResponse,
  ): HttpResponse {
    if (!init.headers?.Authorization?.startsWith('Bearer ct-')) return res(401);
    if (path !== '/v1/ncid' || init.method !== 'POST') return res(403);
    const mrn = String(body.mrn ?? '').trim();
    if (!mrn) return res(422);
    const known = this.connectorMap.get(mrn);
    if (known) return res(200, { ncid: known, created: false });
    const ncid = this.ncid();
    this.connectorMap.set(mrn, ncid);
    return res(200, { ncid, created: true });
  }
}
