/**
 * In-memory stand-in for the NeuroCapture API (backend/app/api) used by the mock camera and the
 * browser tests. Same paths, bodies and status codes as the real server for the upload protocol
 * and auth. Not for clinical use. `online = false` makes every request fail like a dropped network.
 */
import { FakeAppointments } from './fake-appointments.ts';
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
  hospital: string;
  siteId: string;
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
    {
      id: string;
      closed: boolean;
      patient: string | null;
      startedAt: string;
      medState: string;
      requestId: string | null;
    }
  >();
  /** v3: recording requests the (fake) doctor sent, by NCID. */
  readonly requests: {
    id: string;
    ncid: string;
    kind: 'appointment' | 'rerecord';
    appointment_at: string | null;
    doctor_name: string | null;
    tests: string[];
    med_state: string;
    due_at: string;
    cancelled?: boolean;
    /** home = record link in the app; clinic = the clinic phones' queue (user, 16 Nov 2026). */
    place: 'home' | 'clinic';
    notDone?: { reason: string; by: string };
  }[] = [];
  /** v13/v14: appointments, patients' requests, the desk's offers (decisions 045, 046). */
  readonly appts = new FakeAppointments();
  /** The fake connector's records: NCID → name (for the clinic queue's live names). */
  readonly connectorNames = new Map<string, string>();
  /** Operators: ID → password (M13). OP-07 keeps the pre-M13 PIN; OP-NEW must change its temporary one. */
  readonly operators = new Map<string, { password: string; mustChange: boolean; failed?: number }>([
    ['OP-07', { password: '2468', mustChange: false }],
    ['OP-NEW', { password: 'temp-pass-1234', mustChange: true }],
  ]);
  hospital = 'Demo Hospital';
  /** Decision 044 test hook: the hospital's own video storage is connected and passing. */
  canRecord = true;
  /**
   * Test mode on a real phone (debug APK): the server lives in the app's memory and is gone after
   * the app restarts, so sign-ins from before are accepted again (a phone or patient it does not
   * know is taken as new). Never used against real data.
   */
  lenient = false;
  /** Home recording plan the (fake) doctor set. */
  homePlan = {
    tests: ['FT', 'FTF', 'FR', 'SAW', 'FA'],
    every_days: 7,
    med_state: 'OFF',
    default: true,
    /** v3: recording between appointments only when the doctor asked for it. */
    periodic: false,
  };
  private principals = new Map<string, { kind: 'operator' | 'patient'; id: string }>();
  private invites = new Map<
    string,
    { used: boolean; ncid: string; hospital: string; siteId: string }
  >();
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
  /**
   * v11 (decision 043): patient app accounts, by e-mail (the real platform keeps only a keyed
   * fingerprint). The backup and its locked keys are opaque here, as on the platform.
   */
  readonly accounts = new Map<
    string,
    {
      id: string;
      pin: string;
      kdfSalt: string;
      recoveryCheck: string | null;
      backup: string | null;
      wrapPin: string | null;
      wrapRecovery: string | null;
      failed: number;
      paused: boolean;
    }
  >();
  private accountCodes = new Map<string, string>();
  private accountTokens = new Map<
    string,
    { email: string; install: string; label: string; revoked: string | null; at: number }
  >();
  private accountAccess = new Map<string, string>();

  /** Test hook (and the test-mode hint on the code screen): the last code "e-mailed". */
  lastAccountCode(email: string): string | null {
    return this.accountCodes.get(email.trim().toLowerCase()) ?? null;
  }

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

  /**
   * Test hook: a hospital's reception sends a join invite; returns the link in the e-mail.
   * v3: `hospital`/`siteId` for a second hospital; `ncid` to invite a patient back after withdrawing.
   */
  issueInvite(
    fixedToken?: string,
    opts: { hospital?: string; siteId?: string; ncid?: string } = {},
  ): string {
    const token = fixedToken ?? `inv${++this.seq}${Math.random().toString(36).slice(2, 10)}`;
    this.invites.set(token, {
      used: false,
      ncid: opts.ncid ?? this.ncid(),
      hospital: opts.hospital ?? this.hospital,
      siteId: opts.siteId ?? 'site1',
    });
    return `neurocapture://invite?t=${token}`;
  }

  /** v3 test hook: the doctor sends a record link (due in `dueDays`) to the patient with this NCID. */
  sendRequest(
    ncid: string,
    opts: {
      tests?: string[];
      dueDays?: number;
      appointmentDays?: number | null;
      doctor?: string;
      place?: 'home' | 'clinic';
    } = {},
  ): string {
    const id = this.id('rq');
    const day = 86_400_000;
    this.requests.push({
      id,
      ncid,
      kind: opts.appointmentDays === null ? 'rerecord' : 'appointment',
      appointment_at:
        opts.appointmentDays === null
          ? null
          : new Date(Date.now() + (opts.appointmentDays ?? 3) * day).toISOString(),
      doctor_name: opts.doctor ?? 'Dr. Rao',
      tests: opts.tests ?? ['FT', 'FTF', 'FR', 'SAW', 'FA'],
      med_state: 'OFF',
      due_at: new Date(Date.now() + (opts.dueDays ?? 2) * day).toISOString(),
      place: opts.place ?? 'home',
    });
    return id;
  }

  /**
   * Test hook: the doctor asks for a clinic recording today for a patient in the hospital records
   * (MRN, name); returns the request ID. The patient need not have joined the app.
   */
  addClinicRequest(
    mrn: string,
    name: string,
    opts: { tests?: string[]; inHours?: number; doctor?: string; medState?: string } = {},
  ): string {
    let ncid = this.connectorMap.get(mrn);
    if (!ncid) {
      ncid = this.ncid();
      this.connectorMap.set(mrn, ncid);
    }
    this.connectorNames.set(ncid, name);
    const at = new Date(Date.now() + (opts.inHours ?? 1) * 3_600_000).toISOString();
    const id = this.id('rq');
    this.requests.push({
      id,
      ncid,
      kind: 'appointment',
      appointment_at: at,
      doctor_name: opts.doctor ?? 'Dr. Rao',
      tests: opts.tests ?? ['FT', 'FA'],
      med_state: opts.medState ?? 'OFF',
      due_at: new Date(Date.parse(at) + 12 * 3_600_000).toISOString(),
      place: 'clinic',
    });
    return id;
  }

  /** Test hook: a booked appointment in `days` days for this patient; returns its ID. */
  addAppointment(ncid: string, opts: { days?: number; doctor?: string } = {}): string {
    return this.appts.add(ncid, opts);
  }

  /** Test hook: what the server knows of a request (state, not-done reason). */
  requestInfo(id: string) {
    const r = this.requests.find((x) => x.id === id);
    return r ? { state: this.requestState(r), notDone: r.notDone ?? null } : null;
  }

  private requestState(r: FakeServer['requests'][number]): string {
    const done = [...this.sessions.values()].some(
      (s) =>
        s.requestId === r.id &&
        [...this.takes.values()].some((t) => t.sessionId === s.id && t.status === 'complete'),
    );
    if (r.cancelled) return 'cancelled';
    if (done) return 'recorded';
    if (r.notDone) return 'not_recorded';
    return Date.parse(r.due_at) < Date.now() ? 'missed' : 'open';
  }

  /** v3 test hook: the NCIDs of the patients who joined, newest last. */
  joinedNcids(): string[] {
    return [...this.patients.values()].map((p) => p.ncid);
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
      const failed = this.cameraCheck(body, res);
      if (failed) return failed;
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
      if (this.lenient && !this.devices.has(String(body.device_id)))
        this.devices.set(String(body.device_id), String(body.device_secret));
      if (this.devices.get(String(body.device_id)) !== body.device_secret) return res(401);
      const op = this.operators.get(String(body.operator_code));
      const secret = String(body.password ?? body.pin ?? '');
      if (op && (op.failed ?? 0) >= 10) return res(403, { detail: { code: 'account_locked' } });
      if (!op || op.password !== secret) {
        if (op) op.failed = (op.failed ?? 0) + 1;
        return res(401);
      }
      op.failed = 0;
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
    if (path.startsWith('/account/')) return this.account(path, init, body, res);
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
          requestId: typeof body.request_id === 'string' ? body.request_id : null,
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

  /** Device check minimum (config/platform.json deviceCheck.minFps; the real server reads it). */
  minCheckFps = 55;
  /** Invite tokens whose patient said "my phone is not suitable" (fps measured). */
  readonly phoneNotSuitable = new Map<string, number>();
  private cameraCheck(
    body: Record<string, unknown>,
    res: (s: number, b?: unknown) => HttpResponse,
  ): HttpResponse | null {
    const c = body.camera_check as { effective_fps?: unknown } | undefined;
    if (!c || typeof c.effective_fps !== 'number')
      return res(422, { detail: { code: 'camera_check_required', min_fps: this.minCheckFps } });
    if (c.effective_fps < this.minCheckFps)
      return res(422, {
        detail: { code: 'camera_check_failed', min_fps: this.minCheckFps, fps: c.effective_fps },
      });
    return null;
  }

  /** Patient endpoints that need no access token (invite, PIN sign-in). */
  private patientPublic(
    path: string,
    init: { method: string },
    body: Record<string, unknown>,
    res: (s: number, b?: unknown) => HttpResponse,
  ): HttpResponse | null {
    if (init.method !== 'POST') return null;
    if (path === '/patient/invite/phone-not-suitable') {
      const inv = this.invites.get(String(body.token));
      if (!inv || inv.used) return res(403, { detail: { code: 'invite_invalid' } });
      const c = body.camera_check as { effective_fps?: number } | undefined;
      this.phoneNotSuitable.set(String(body.token), Number(c?.effective_fps ?? 0));
      return res(204);
    }
    if (path === '/patient/invite/lookup' || path === '/patient/invite/accept') {
      const inv = this.invites.get(String(body.token));
      if (!inv || inv.used) return res(403, { detail: { code: 'invite_invalid' } });
      if (path === '/patient/invite/lookup')
        return res(200, {
          hospital: inv.hospital,
          kind: 'hospital',
          consent_version: 'home-consent@1',
          pin_min_digits: 4,
          pin_max_digits: 6,
        });
      // v11: no hospital PIN when the phone has an app account (its token proves it).
      const viaAccount = body.pin == null && this.accountAccess.has(String(body.account_token));
      const pin = viaAccount ? '' : String(body.pin);
      if (!viaAccount && !/^\d{4,6}$/.test(pin))
        return res(422, { detail: { code: 'pin_format' } });
      const failed = this.cameraCheck(body, res);
      if (failed) return failed;
      this.phoneNotSuitable.delete(String(body.token));
      // v3: no consent at joining (consent is asked for each recording session).
      inv.used = true;
      const acc = this.id('pa');
      const deviceId = this.id('pdev');
      const deviceSecret = this.id('psecret');
      this.patients.set(acc, {
        ncid: inv.ncid,
        hospital: inv.hospital,
        siteId: inv.siteId,
        pin,
        deviceId,
        deviceSecret,
        status: 'active',
        failed: 0,
      });
      return res(201, {
        device_id: deviceId,
        device_secret: deviceSecret,
        site_id: inv.siteId,
        hospital: inv.hospital,
        ncid: inv.ncid,
        server_key: { key_id: 'fake-key-1', public_key_pem: DEV_PEM },
        tokens: this.tokens(acc, 'patient'),
      });
    }
    if (path === '/patient/device/rotate') {
      const entry = [...this.patients.entries()].find(
        ([, p]) => p.deviceId === body.device_id && p.deviceSecret === body.device_secret,
      );
      if (!entry || entry[1].status !== 'active') return res(401);
      const failed = this.cameraCheck(body, res);
      if (failed) return failed;
      const [acc, p] = entry;
      p.deviceId = this.id('pdev');
      p.deviceSecret = this.id('psecret');
      p.pin = '';
      for (const [rt, who] of this.refresh) if (who === `patient:${acc}`) this.refresh.delete(rt);
      for (const [at, who] of this.principals) if (who.id === acc) this.principals.delete(at);
      return res(200, {
        device_id: p.deviceId,
        device_secret: p.deviceSecret,
        site_id: p.siteId,
        hospital: p.hospital,
        ncid: p.ncid,
        server_key: { key_id: 'fake-key-1', public_key_pem: DEV_PEM },
        tokens: this.tokens(acc, 'patient'),
      });
    }
    if (path === '/patient/login') {
      let entry = [...this.patients.entries()].find(
        ([, p]) => p.deviceId === body.device_id && p.deviceSecret === body.device_secret,
      );
      if (!entry && this.lenient) {
        const acc = this.id('pa');
        this.patients.set(acc, {
          ncid: this.ncid(),
          hospital: this.hospital,
          siteId: 'site1',
          pin: String(body.pin),
          deviceId: String(body.device_id),
          deviceSecret: String(body.device_secret),
          status: 'active',
          failed: 0,
        });
        entry = [acc, this.patients.get(acc)!];
      }
      if (!entry || entry[1].status === 'closed') return res(401);
      const [acc, p] = entry;
      if (p.status === 'locked') return res(403, { detail: { code: 'pin_locked' } });
      if (p.pin !== '' && String(body.pin) !== p.pin) {
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

  /** v11 patient app account (same API as backend/app/api/app_account.py). */
  private account(
    path: string,
    init: { method: string; headers?: Record<string, string> },
    body: Record<string, unknown>,
    res: (s: number, b?: unknown) => HttpResponse,
  ): HttpResponse {
    const email = String(body.email ?? '')
      .trim()
      .toLowerCase();
    const err = (status: number, code: string, extra: Record<string, unknown> = {}) =>
      res(status, { detail: { code, ...extra } });
    const share = (e: string) => btoa(`fake-share:${e}`.padEnd(32, '.'));
    const issue = (e: string, install: string, label: string) => {
      const refresh = this.id('art');
      const access = `acct-${this.id('aat')}`;
      this.accountTokens.set(refresh, { email: e, install, label, revoked: null, at: Date.now() });
      this.accountAccess.set(access, `${e}|${install}`);
      return { access_token: access, refresh_token: refresh, expires_in: 900 };
    };
    const unlocked = (e: string, tokens: unknown, withBackup: boolean) => {
      const a = this.accounts.get(e)!;
      return {
        tokens,
        share: share(e),
        kdf_salt: a.kdfSalt,
        backup: withBackup ? a.backup : null,
        wrap_pin: withBackup ? a.wrapPin : null,
      };
    };
    const codeOk = () => {
      const c = this.accountCodes.get(email);
      return !!c && c === String(body.code);
    };
    const pinOk = (e: string, pin: string): HttpResponse | null => {
      const a = this.accounts.get(e)!;
      if (a.paused)
        return err(403, 'paused', { until: new Date(Date.now() + 864e5).toISOString() });
      if (a.pin === pin) {
        a.failed = 0;
        return null;
      }
      a.failed++;
      if (a.failed >= 5) {
        a.paused = true;
        a.failed = 0;
        return err(403, 'paused', { until: new Date(Date.now() + 864e5).toISOString() });
      }
      return err(401, 'wrong_pin', { left: 5 - a.failed });
    };
    const revokeAll = (e: string, reason: string, keep?: string) => {
      for (const t of this.accountTokens.values())
        if (t.email === e && !t.revoked && t.install !== keep) t.revoked = reason;
    };
    const bearer = String(init.headers?.Authorization ?? '').slice('Bearer '.length);
    const who = this.accountAccess.get(bearer);
    const signedIn = () => {
      if (!who) return null;
      const [e, install] = who.split('|') as [string, string];
      const live = [...this.accountTokens.values()].some(
        (t) => t.email === e && t.install === install && !t.revoked,
      );
      return live ? e : null;
    };
    if (path === '/account/code') {
      this.accountCodes.set(email, String(100000 + Math.floor(Math.random() * 900000)));
      return res(202, { sent: true, minutes: 10 });
    }
    if (path === '/account/signup') {
      if (!codeOk()) return err(401, 'code_invalid');
      if (this.accounts.has(email)) return err(409, 'account_exists');
      if (!/^\d{4,6}$/.test(String(body.pin))) return err(422, 'pin_format');
      this.accounts.set(email, {
        id: this.id('acct'),
        pin: String(body.pin),
        kdfSalt: String(body.kdf_salt),
        recoveryCheck: String(body.recovery_check),
        backup: null,
        wrapPin: null,
        wrapRecovery: null,
        failed: 0,
        paused: false,
      });
      this.accountCodes.delete(email);
      return res(
        201,
        unlocked(email, issue(email, String(body.install_id), String(body.device_label)), false),
      );
    }
    if (path === '/account/signin') {
      if (!codeOk()) return err(401, 'code_invalid');
      if (!this.accounts.has(email)) return err(404, 'no_account');
      const bad = pinOk(email, String(body.pin));
      if (bad) return bad;
      const other = [...this.accountTokens.values()]
        .filter((t) => t.email === email && !t.revoked && t.install !== body.install_id)
        .sort((a, b) => b.at - a.at)[0];
      if (other && !body.move)
        return err(409, 'other_phone', {
          device_label: other.label,
          last_used_at: new Date(other.at).toISOString(),
        });
      revokeAll(email, other ? 'moved' : 'signed_out');
      this.accountCodes.delete(email);
      return res(
        200,
        unlocked(email, issue(email, String(body.install_id), String(body.device_label)), true),
      );
    }
    if (path === '/account/unlock' || path === '/account/refresh') {
      let t = this.accountTokens.get(String(body.refresh_token));
      if (!t && this.lenient) {
        // Test mode: the pretend server forgot everything when the app restarted.
        const e = 'test-mode@local';
        if (!this.accounts.has(e))
          this.accounts.set(e, {
            id: this.id('acct'),
            pin: String(body.pin ?? ''),
            kdfSalt: 'dGVzdC1tb2RlLXNhbHQ',
            recoveryCheck: null,
            backup: null,
            wrapPin: null,
            wrapRecovery: null,
            failed: 0,
            paused: false,
          });
        t = { email: e, install: 'test-mode', label: 'Test phone', revoked: null, at: Date.now() };
        this.accountTokens.set(String(body.refresh_token), t);
      }
      if (!t) return err(401, 'signed_out');
      if (t.revoked) return err(401, t.revoked === 'rotated' ? 'signed_out' : t.revoked);
      if (path === '/account/unlock') {
        const bad = pinOk(t.email, String(body.pin));
        if (bad) return bad;
      }
      t.revoked = 'rotated';
      const tokens = issue(t.email, t.install, t.label);
      return res(200, path === '/account/refresh' ? tokens : unlocked(t.email, tokens, false));
    }
    if (path === '/account/backup') {
      const e = signedIn();
      if (!e) return err(401, 'signed_out');
      const a = this.accounts.get(e)!;
      a.backup = String(body.backup);
      a.wrapPin = String(body.wrap_pin);
      if (body.wrap_recovery != null) a.wrapRecovery = String(body.wrap_recovery);
      if (body.recovery_check != null) a.recoveryCheck = String(body.recovery_check);
      return res(204);
    }
    if (path === '/account/recover') {
      if (!codeOk()) return err(401, 'code_invalid');
      const a = this.accounts.get(email);
      if (!a) return err(404, 'no_account');
      return res(200, { kdf_salt: a.kdfSalt, backup: a.backup, wrap_recovery: a.wrapRecovery });
    }
    if (path === '/account/reset-pin') {
      if (!codeOk()) return err(401, 'code_invalid');
      const a = this.accounts.get(email);
      if (!a) return err(404, 'no_account');
      if (body.forget_backup) {
        a.backup = a.wrapPin = a.wrapRecovery = a.recoveryCheck = null;
      } else if (!a.recoveryCheck || a.recoveryCheck !== body.recovery_check) {
        return err(403, 'recovery_invalid');
      }
      a.pin = String(body.new_pin);
      a.kdfSalt = String(body.kdf_salt);
      a.failed = 0;
      a.paused = false;
      revokeAll(email, 'pin_reset');
      this.accountCodes.delete(email);
      return res(
        200,
        unlocked(email, issue(email, String(body.install_id), String(body.device_label)), false),
      );
    }
    if (path === '/account/sign-out') {
      const t = this.accountTokens.get(String(body.refresh_token));
      if (t && !t.revoked) t.revoked = 'signed_out';
      return res(204);
    }
    return res(404);
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
    if (path === '/sessions/can-record' && init.method === 'GET')
      return res(200, {
        can_record: this.canRecord,
        reason: this.canRecord ? null : 'storage_not_connected',
      });
    if (path === '/patient/pin/clear' && init.method === 'POST') {
      patient!.pin = '';
      return res(204);
    }
    if (path === '/patient/me' && init.method === 'GET')
      return res(200, {
        ncid: patient!.ncid,
        hospital: patient!.hospital,
        status: patient!.status,
      });
    if (path.startsWith('/patient/')) {
      const r = this.appts.handle(path, init.method, body, patient!.ncid, res);
      if (r) return r;
    }
    if (path === '/patient/requests' && init.method === 'GET') {
      return res(
        200,
        this.requests
          .filter((r) => r.ncid === patient!.ncid)
          .reverse()
          .map((full) => {
            const { ncid: _n, cancelled: _c, notDone: _d, ...r } = full;
            return { ...r, state: this.requestState(full) };
          }),
      );
    }
    if (path === '/patient/plan' && init.method === 'GET') {
      const mine = this.homeSessions().filter((s) => s.patient === me.id);
      const last =
        mine
          .map((s) => s.startedAt)
          .sort()
          .pop() ?? null;
      const next = last ? new Date(Date.parse(last) + this.homePlan.every_days * 86_400_000) : null;
      const due = this.homePlan.periodic ? (next ?? new Date()) : null;
      return res(200, {
        ...this.homePlan,
        last_session_at: last,
        periodic_until: null,
        next_due: due?.toISOString() ?? null,
        due_now: !!due && due.getTime() <= Date.now(),
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
    // The clinic queue (user, 16 Nov 2026): clinic requests in the phone's day.
    const queue = /^\/clinic\/queue\?(.*)$/.exec(path);
    if (queue && init.method === 'GET') {
      const q = new URLSearchParams(queue[1]);
      const from = Date.parse(q.get('from') ?? '');
      const to = Date.parse(q.get('to') ?? '');
      if (!(to > from) || to - from > 48 * 3_600_000)
        return res(422, { detail: { code: 'bad_window' } });
      return res(
        200,
        this.requests
          .filter((r) => r.place === 'clinic' && !r.cancelled)
          .filter((r) => {
            const at = Date.parse(r.appointment_at ?? r.due_at);
            return at >= from && at < to;
          })
          .map((r) => ({
            request_id: r.id,
            ncid: r.ncid,
            at: r.appointment_at ?? r.due_at,
            doctor_name: r.doctor_name,
            tests: r.tests,
            med_state: r.med_state,
            state: this.requestState(r),
            recorded_by: r.notDone?.by ?? null,
            not_done_reason: r.notDone?.reason ?? null,
          })),
      );
    }
    const nd = /^\/clinic\/requests\/([^/]+)\/not-done$/.exec(path);
    if (nd && init.method === 'POST') {
      const r = this.requests.find((x) => x.id === nd[1] && x.place === 'clinic');
      if (!r) return res(404);
      r.notDone = { reason: String(body.reason), by: me.id };
      return res(200, {
        request_id: r.id,
        state: 'not_recorded',
        not_done_reason: r.notDone.reason,
      });
    }
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
    if (path === '/v1/patients/lookup' && init.method === 'POST') {
      const want = new Set((body.ncids as string[] | undefined) ?? []);
      return res(
        200,
        [...this.connectorMap.entries()]
          .filter(([, n]) => want.has(n) && this.connectorNames.has(n))
          .map(([mrn, n]) => ({ ncid: n, mrn, name: this.connectorNames.get(n) })),
      );
    }
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
