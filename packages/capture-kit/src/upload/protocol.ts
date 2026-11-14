/**
 * Upload protocol client (M7, decision 019). The native Android worker implements the same steps;
 * this TS version drives the mock/webcam implementations and the browser tests.
 *
 *   POST /sessions (idempotent) → POST /takes (idempotent; returns a multipart plan)
 *   → PUT each missing part → POST /takes/{id}/files/{kind}/complete (server verifies SHA-256)
 *   → POST /takes/{id}/complete → confirmedAt.
 * On 401 the access token is refreshed once; on checksum mismatch the file is re-sent (max 3).
 */

export interface HttpResponse {
  status: number;
  etag: string | null;
  json(): Promise<unknown>;
}

export type Http = (
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string | Uint8Array },
) => Promise<HttpResponse>;

/** The take's encrypted files as the server will receive them. */
export interface TakeFiles {
  kinds: string[];
  size(kind: string): number;
  sha256(kind: string): Promise<string>;
  read(kind: string, offset: number, length: number): Promise<Uint8Array>;
}

export interface UploadJob {
  takeId: string;
  clientSessionId: string;
  /** POST /sessions body (JSON string from the app). */
  session: string;
  /** POST /takes body without session_id, files, wrapped key (JSON string from the app). */
  take: string;
  wrappedDataKey: string;
  keyId: string;
  serverSessionId?: string;
  serverTakeId?: string;
}

export interface Tokens {
  access: string;
  refresh: string;
}

export class UploadError extends Error {
  constructor(
    readonly kind: 'network' | 'auth' | 'permanent',
    message: string,
  ) {
    super(message);
  }
}

interface PartUrl {
  number: number;
  url: string;
}
interface FilePlan {
  kind: string;
  part_size: number;
  parts_total: number;
  parts: PartUrl[];
  uploaded_parts: { number: number; etag: string }[];
  verified: boolean;
}
interface TakePlan {
  take_id: string;
  status: string;
  files: FilePlan[];
}

export class UploadClient {
  constructor(
    private readonly http: Http,
    private readonly endpoint: string,
    private tokens: Tokens,
    private readonly onTokens: (t: Tokens) => void,
  ) {}

  private async call(
    method: string,
    path: string,
    body?: unknown,
    retried = false,
  ): Promise<unknown> {
    let res: HttpResponse;
    try {
      res = await this.http(`${this.endpoint}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.tokens.access}`,
          'Content-Type': 'application/json',
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      throw new UploadError('network', String(e));
    }
    if (res.status === 401 && !retried) {
      await this.refresh();
      return this.call(method, path, body, true);
    }
    if (res.status === 401) throw new UploadError('auth', 'login_required');
    if (res.status >= 500) throw new UploadError('network', `server ${res.status}`);
    const json = await res.json().catch(() => ({}));
    if (res.status >= 400) {
      const detail = (json as { detail?: { code?: string } }).detail;
      const err = new UploadError('permanent', `http ${res.status}`);
      (err as UploadError & { code?: string }).code = detail?.code;
      throw err;
    }
    return json;
  }

  private async refresh(): Promise<void> {
    let res: HttpResponse;
    try {
      res = await this.http(`${this.endpoint}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: this.tokens.refresh }),
      });
    } catch (e) {
      throw new UploadError('network', String(e));
    }
    if (res.status !== 200) throw new UploadError('auth', 'login_required');
    const j = (await res.json()) as { access_token: string; refresh_token: string };
    this.tokens = { access: j.access_token, refresh: j.refresh_token };
    this.onTokens(this.tokens);
  }

  /** Upload one take; resumes from whatever the server already has. Returns the confirmation time. */
  async run(
    job: UploadJob,
    files: TakeFiles,
    onProgress: (sent: number, total: number) => void,
  ): Promise<{ confirmedAt: string; job: UploadJob }> {
    const total = files.kinds.reduce((s, k) => s + files.size(k), 0);
    if (!job.serverSessionId) {
      const s = (await this.call('POST', '/sessions', JSON.parse(job.session))) as { id: string };
      job = { ...job, serverSessionId: s.id };
    }
    const meta = await Promise.all(
      files.kinds.map(async (kind) => ({
        kind,
        size_bytes: files.size(kind),
        sha256: await files.sha256(kind),
      })),
    );
    const body = {
      ...(JSON.parse(job.take) as object),
      session_id: job.serverSessionId,
      wrapped_data_key: job.wrappedDataKey,
      key_id: job.keyId,
      files: meta,
    };
    let plan = (await this.call('POST', '/takes', body)) as TakePlan;
    job = { ...job, serverTakeId: plan.take_id };
    let sent = 0;
    const report = () => onProgress(sent, total);
    for (const kind of files.kinds) {
      for (let attempt = 1; ; attempt++) {
        const f = plan.files.find((x) => x.kind === kind)!;
        if (f.verified) {
          sent += files.size(kind);
          report();
          break;
        }
        const etags = new Map(f.uploaded_parts.map((p) => [p.number, p.etag]));
        sent += f.uploaded_parts.length * f.part_size;
        for (const part of f.parts) {
          const off = (part.number - 1) * f.part_size;
          const chunk = await files.read(kind, off, Math.min(f.part_size, files.size(kind) - off));
          let res: HttpResponse;
          try {
            res = await this.http(part.url, { method: 'PUT', body: chunk });
          } catch (e) {
            throw new UploadError('network', String(e));
          }
          if (res.status !== 200 || !res.etag)
            throw new UploadError('network', `part ${res.status}`);
          etags.set(part.number, res.etag.replace(/"/g, ''));
          sent += chunk.length;
          report();
        }
        try {
          plan = (await this.call('POST', `/takes/${plan.take_id}/files/${kind}/complete`, {
            parts: [...etags].map(([number, etag]) => ({ number, etag })),
          })) as TakePlan;
          break;
        } catch (e) {
          const code = (e as { code?: string }).code;
          if (code !== 'checksum_mismatch' || attempt >= 3) throw e;
          // Damaged in transit: the server started a fresh upload of this file; send it again.
          sent -= f.uploaded_parts.length * f.part_size + f.parts.length * f.part_size;
          plan = (await this.call('GET', `/takes/${plan.take_id}/upload`)) as TakePlan;
        }
      }
    }
    const done = (await this.call('POST', `/takes/${plan.take_id}/complete`)) as {
      confirmed_at: string;
    };
    onProgress(total, total);
    return { confirmedAt: done.confirmed_at, job };
  }

  async closeSession(serverSessionId: string, body: string): Promise<void> {
    await this.call('PATCH', `/sessions/${serverSessionId}`, JSON.parse(body));
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
