/**
 * Hospital admin (M14): data connections and health, team, phones, patients (listed live from the
 * connector), invites, deletion requests and the activity log. Patient identity is fetched from the
 * hospital connector by this browser; the platform only ever sees NCIDs.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import QRCode from 'qrcode';
import { call, hospital } from './api.ts';
import { AuditTable, type AuditRow } from './platform.tsx';
import { Badge, Button, Card, ErrorNote, Field, Notice, Page, Table, fmt, fmtDate } from './ui.tsx';

function useLoad<T>(fn: () => Promise<T>): [T | null, unknown, () => void] {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let off = false;
    fn().then(
      (d) => !off && setData(d),
      (e: unknown) => !off && setError(e),
    );
    return () => {
      off = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n]);
  return [data, error, () => setN((x) => x + 1)];
}

async function attempt(setError: (e: unknown) => void, fn: () => Promise<void>) {
  setError(null);
  try {
    await fn();
  } catch (e) {
    setError(e);
  }
}

const checks = (c: Record<string, string> | null) =>
  c && (
    <div className="flex flex-wrap gap-2" data-testid="check-results">
      {Object.entries(c).map(([k, v]) => (
        <Badge
          key={k}
          tone={v === 'pass' ? 'ok' : v === 'fail' ? 'bad' : 'warn'}
        >{`${k}: ${v}`}</Badge>
      ))}
    </div>
  );

// --- Data connections ---

interface ConnectorInfo {
  url: string | null;
  registered: boolean;
  platform_key_sha256: string;
  check: Record<string, string> | null;
  checked_at: string | null;
}
interface KeyRow {
  key_id: string;
  fingerprint: string;
  status: string;
  created_at: string;
}
interface StorageInfo {
  kind: string;
  s3: Record<string, string> | null;
  external_id: string | null;
  trust_policy: unknown;
  permissions_policy: unknown;
  check: Record<string, string> | null;
}

export function Connections() {
  const { t } = useTranslation();
  const [conn, connErr, reloadConn] = useLoad(() =>
    call<ConnectorInfo>('GET', '/hospital/connector'),
  );
  const [keys] = useLoad(() => call<KeyRow[]>('GET', '/hospital/keys'));
  const [storage, , reloadStorage] = useLoad(() => call<StorageInfo>('GET', '/hospital/storage'));
  const [url, setUrl] = useState('');
  const [pem, setPem] = useState('');
  const [sample, setSample] = useState('');
  const [s3, setS3] = useState({
    bucket: '',
    region: 'ap-south-1',
    role_arn: '',
    prefix: 'neurocapture/',
  });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const register = () =>
    attempt(setError, async () => {
      await call('PUT', '/hospital/connector', { url, public_key_pem: pem });
      setPem('');
      reloadConn();
    });
  const test = () =>
    attempt(setError, async () => {
      setBusy(true);
      try {
        await call('POST', '/hospital/connector/check', { sample_mrn: sample || null });
        setSample('');
        reloadConn();
      } finally {
        setBusy(false);
      }
    });
  const saveStorage = (kind: 'managed' | 's3') =>
    attempt(setError, async () => {
      await call('PUT', '/hospital/storage', kind === 'managed' ? { kind } : { kind, s3 });
      reloadStorage();
    });

  return (
    <Page title={t('nav.connections')}>
      <ErrorNote error={error ?? connErr} />
      <Card title={t('hospital.connectorTitle')} testId="connector-card">
        {conn?.registered && (
          <p className="text-[14px]">
            {conn.url} <Badge tone="ok">registered</Badge>
          </p>
        )}
        <p className="text-[13px] text-muted">
          {t('hospital.platformKey')}:{' '}
          <code className="font-mono text-ink" data-testid="platform-key-sha">
            {conn?.platform_key_sha256}
          </code>
        </p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field
            id="c-url"
            label={t('hospital.connectorUrl')}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://connector.hospital.example"
            data-testid="c-url"
          />
          <label className="flex flex-col gap-1 text-[13px] font-semibold text-[#3D4552]">
            {t('hospital.connectorKey')}
            <textarea
              value={pem}
              onChange={(e) => setPem(e.target.value)}
              rows={3}
              className="rounded-xl border border-[#C9CFD8] p-2 font-mono text-[12px]"
              data-testid="c-key"
            />
          </label>
        </div>
        <Button
          className="self-start"
          variant="secondary"
          disabled={!url || pem.length < 40}
          onClick={() => void register()}
          data-testid="c-register"
        >
          {t('hospital.register')}
        </Button>
        <div className="flex flex-wrap items-end gap-3">
          <Field
            id="c-sample"
            label={t('hospital.sampleMrn')}
            value={sample}
            onChange={(e) => setSample(e.target.value)}
            data-testid="c-sample"
          />
          <Button
            disabled={busy || !conn?.registered}
            onClick={() => void test()}
            data-testid="c-check"
          >
            {t('hospital.check')}
          </Button>
        </div>
        {conn?.checked_at && (
          <span className="text-[12px] text-muted">
            {t('hospital.checkedAt', { at: fmt(conn.checked_at) })}
          </span>
        )}
        {checks(conn?.check ?? null)}
      </Card>
      <Card title={t('hospital.keysTitle')}>
        <p className="text-[13px] text-muted">{t('hospital.keysHint')}</p>
        {keys && keys.length === 0 && <Notice tone="warn">{t('hospital.noKey')}</Notice>}
        <ul className="flex flex-col gap-1 text-[13px]" data-testid="keys">
          {(keys ?? []).map((k) => (
            <li key={k.key_id}>
              <Badge tone={k.status === 'active' ? 'ok' : 'neutral'}>{k.status}</Badge>{' '}
              <code>{k.key_id}</code> · {k.fingerprint.slice(0, 16)}… · {fmtDate(k.created_at)}
            </li>
          ))}
        </ul>
      </Card>
      <Card title={t('hospital.storageTitle')}>
        <p className="text-[14px]">
          {storage?.kind === 's3' ? t('hospital.storageS3') : t('hospital.storageManaged')}
        </p>
        {storage?.external_id && (
          <p className="text-[13px] text-muted">
            {t('hospital.externalId')}: <code className="text-ink">{storage.external_id}</code>
          </p>
        )}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
          <Field
            id="s-bucket"
            label={t('hospital.bucket')}
            value={s3.bucket}
            onChange={(e) => setS3({ ...s3, bucket: e.target.value })}
          />
          <Field
            id="s-region"
            label={t('hospital.s3region')}
            value={s3.region}
            onChange={(e) => setS3({ ...s3, region: e.target.value })}
          />
          <Field
            id="s-role"
            label={t('hospital.roleArn')}
            value={s3.role_arn}
            onChange={(e) => setS3({ ...s3, role_arn: e.target.value })}
          />
          <Field
            id="s-prefix"
            label={t('hospital.prefix')}
            value={s3.prefix}
            onChange={(e) => setS3({ ...s3, prefix: e.target.value })}
          />
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            disabled={!s3.bucket || !s3.role_arn}
            onClick={() => void saveStorage('s3')}
          >
            {t('hospital.saveStorage')}
          </Button>
          {storage?.kind === 's3' && (
            <Button variant="ghost" onClick={() => void saveStorage('managed')}>
              {t('hospital.storageManaged')}
            </Button>
          )}
        </div>
        {checks(storage?.check ?? null)}
      </Card>
    </Page>
  );
}

// --- Team ---

interface Operator {
  id: string;
  code: string;
  role: string;
  active: boolean;
  must_change_password: boolean;
  locked: boolean;
  temporary_password: string | null;
}
interface StaffRow {
  id: string;
  email: string;
  display_name: string | null;
  role: string;
  active: boolean;
  invited: boolean;
  locked: boolean;
}

export function Team() {
  const { t } = useTranslation();
  const [ops, , reloadOps] = useLoad(() => call<Operator[]>('GET', '/hospital/operators'));
  const [staff, , reloadStaff] = useLoad(() => call<StaffRow[]>('GET', '/hospital/staff'));
  const [code, setCode] = useState('');
  const [temp, setTemp] = useState<{ code: string; pw: string } | null>(null);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('doctor');
  const [error, setError] = useState<unknown>(null);
  const showTemp = (o: Operator) =>
    o.temporary_password && setTemp({ code: o.code, pw: o.temporary_password });
  return (
    <Page title={t('hospital.teamTitle')}>
      <ErrorNote error={error} />
      <Card title={t('hospital.operatorsTitle')}>
        {temp && (
          <Notice testId="temp-password">
            {t('hospital.tempPassword', { code: temp.code, pw: temp.pw })}
          </Notice>
        )}
        <div className="flex items-end gap-2">
          <Field
            id="op-code"
            label={t('hospital.newOperator')}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            data-testid="op-code"
          />
          <Button
            disabled={code.length < 2}
            onClick={() =>
              void attempt(setError, async () => {
                showTemp(await call<Operator>('POST', '/hospital/operators', { code }));
                setCode('');
                reloadOps();
              })
            }
            data-testid="op-add"
          >
            {t('hospital.addOperator')}
          </Button>
        </div>
        <ul className="flex flex-col divide-y divide-[#EDF0F3]" data-testid="operators">
          {(ops ?? []).map((o) => (
            <li key={o.id} className="flex flex-wrap items-center gap-2 py-2 text-[14px]">
              <span className="w-28 font-semibold">{o.code}</span>
              {!o.active && <Badge tone="bad">{t('hospital.disable')}d</Badge>}
              {o.locked && <Badge tone="bad">{t('hospital.locked')}</Badge>}
              {o.must_change_password && <Badge tone="warn">{t('hospital.mustChange')}</Badge>}
              <span className="flex-1" />
              <Button
                variant="secondary"
                onClick={() =>
                  void attempt(setError, async () => {
                    showTemp(
                      await call<Operator>('POST', `/hospital/operators/${o.id}/reset-password`),
                    );
                    reloadOps();
                  })
                }
              >
                {t('hospital.reset')}
              </Button>
              <Button
                variant={o.active ? 'ghost' : 'secondary'}
                onClick={() =>
                  void attempt(setError, async () => {
                    await call('POST', `/hospital/operators/${o.id}/active`, {
                      active: !o.active || o.locked,
                    });
                    reloadOps();
                  })
                }
              >
                {o.active && !o.locked ? t('hospital.disable') : t('hospital.enable')}
              </Button>
            </li>
          ))}
        </ul>
      </Card>
      <Card title={t('hospital.staffTitle')}>
        <div className="flex flex-wrap items-end gap-2">
          <Field
            id="st-email"
            label={t('hospital.staffEmail')}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            data-testid="st-email"
          />
          <Field
            id="st-name"
            label={t('hospital.staffName')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <label className="flex flex-col gap-1 text-[13px] font-semibold text-[#3D4552]">
            {t('hospital.role')}
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="h-11 rounded-xl border border-[#C9CFD8] bg-white px-2 text-[14px]"
            >
              <option value="doctor">{t('roles.doctor')}</option>
              <option value="receptionist">{t('roles.receptionist')}</option>
              <option value="hospital_admin">{t('roles.hospital_admin')}</option>
            </select>
          </label>
          <Button
            disabled={!email.includes('@')}
            onClick={() =>
              void attempt(setError, async () => {
                await call('POST', '/hospital/staff', { email, display_name: name || null, role });
                setEmail('');
                setName('');
                reloadStaff();
              })
            }
            data-testid="st-invite"
          >
            {t('hospital.inviteStaff')}
          </Button>
        </div>
        <ul className="flex flex-col divide-y divide-[#EDF0F3]" data-testid="staff">
          {(staff ?? []).map((u) => (
            <li key={u.id} className="flex flex-wrap items-center gap-2 py-2 text-[14px]">
              <span className="font-semibold">{u.display_name ?? u.email}</span>
              <span className="text-muted">{u.email}</span>
              <Badge>{t(`roles.${u.role}`)}</Badge>
              {u.invited && <Badge tone="warn">invited</Badge>}
              {u.locked && <Badge tone="bad">{t('hospital.locked')}</Badge>}
              <span className="flex-1" />
              <Button
                variant="ghost"
                onClick={() =>
                  void attempt(setError, async () => {
                    await call('POST', `/hospital/staff/${u.id}/active`, {
                      active: !u.active || u.locked,
                    });
                    reloadStaff();
                  })
                }
              >
                {u.active && !u.locked ? t('hospital.disable') : t('hospital.enable')}
              </Button>
            </li>
          ))}
        </ul>
      </Card>
    </Page>
  );
}

// --- Phones ---

interface DeviceRow {
  id: string;
  label: string | null;
  model: string;
  os_version: string;
  registered_at: string;
  revoked_at: string | null;
}

export function Phones() {
  const { t } = useTranslation();
  const [devices, , reload] = useLoad(() => call<DeviceRow[]>('GET', '/hospital/devices'));
  const [label, setLabel] = useState('');
  const [code, setCode] = useState<{ code: string; expires_at: string; qr: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const newCode = () =>
    attempt(setError, async () => {
      const c = await call<{ code: string; expires_at: string }>('POST', '/hospital/device-codes', {
        label: label || null,
      });
      setCode({ ...c, qr: await QRCode.toDataURL(c.code, { margin: 1, width: 180 }) });
      setLabel('');
    });
  return (
    <Page title={t('hospital.phonesTitle')}>
      <ErrorNote error={error} />
      <Card>
        <div className="flex items-end gap-2">
          <Field
            id="d-label"
            label={t('hospital.codeLabel')}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <Button onClick={() => void newCode()} data-testid="d-new">
            {t('hospital.newCode')}
          </Button>
        </div>
        {code && (
          <div className="flex items-center gap-4" data-testid="d-code">
            <img src={code.qr} alt="" width={180} height={180} />
            <div>
              <span className="text-[13px] text-muted">
                {t('hospital.codeShown', { until: fmt(code.expires_at) })}
              </span>
              <p
                className="font-mono text-[24px] font-bold tracking-widest"
                data-testid="d-code-text"
              >
                {code.code}
              </p>
            </div>
          </div>
        )}
      </Card>
      <Table head={['', '', '', '']} testId="devices">
        {(devices ?? []).map((d) => (
          <tr key={d.id} className="border-t border-[#EDF0F3]">
            <td className="px-4 py-3 font-semibold">{d.label ?? d.model}</td>
            <td className="px-4 py-3 text-[13px] text-muted">
              {d.model} · Android {d.os_version}
            </td>
            <td className="px-4 py-3 text-[13px]">{fmtDate(d.registered_at)}</td>
            <td className="px-4 py-3">
              {d.revoked_at ? (
                <Badge tone="bad">removed</Badge>
              ) : (
                <Button
                  variant="ghost"
                  onClick={() =>
                    void attempt(setError, async () => {
                      await call('POST', `/hospital/devices/${d.id}/revoke`);
                      reload();
                    })
                  }
                >
                  {t('hospital.revoke')}
                </Button>
              )}
            </td>
          </tr>
        ))}
      </Table>
    </Page>
  );
}

// --- Patients ---

interface RecordRow {
  mrn: string;
  name: string;
  birth_date: string | null;
  sex: string | null;
  has_email: boolean;
  has_phone: boolean;
  ncid: string | null;
  app_status: string | null;
}
interface InviteResult {
  mrn: string;
  result: string;
  ncid: string | null;
  qr_png_base64: string | null;
}
interface Deletion {
  id: string;
  ncid: string;
  requested_at: string;
  status: string;
}

export function Patients() {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<RecordRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [via, setVia] = useState<'email' | 'sms' | 'print'>('email');
  const [results, setResults] = useState<InviteResult[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [deletions, , reloadDel] = useLoad(() =>
    call<Deletion[]>('GET', '/hospital/deletion-requests'),
  );
  const search = useCallback(
    () =>
      attempt(setError, async () => {
        setRows(await hospital<RecordRow[]>('GET', `/v1/patients?q=${encodeURIComponent(q)}`));
        setResults([]);
      }),
    [q],
  );
  const toggle = (mrn: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(mrn)) n.delete(mrn);
      else n.add(mrn);
      return n;
    });
  const send = () =>
    attempt(setError, async () => {
      setResults(
        await hospital<InviteResult[]>('POST', '/v1/invites', {
          mrns: [...selected],
          channel: via,
        }),
      );
      setSelected(new Set());
    });
  return (
    <Page title={t('hospital.patientsTitle')}>
      <Notice>{t('app.notStored')}</Notice>
      <ErrorNote error={error} />
      <div className="flex gap-2">
        <input
          aria-label={t('hospital.search')}
          placeholder={t('hospital.search')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void search()}
          className="h-11 w-full max-w-md rounded-xl border border-[#C9CFD8] bg-white px-3 text-[14px]"
          data-testid="p-search"
        />
        <Button
          disabled={q.trim().length < 2}
          onClick={() => void search()}
          data-testid="p-search-btn"
        >
          {t('hospital.searchBtn')}
        </Button>
      </div>
      <Table
        head={[
          '',
          t('hospital.patient'),
          t('hospital.mrn'),
          t('hospital.email'),
          t('hospital.mobile'),
          t('hospital.appStatus'),
        ]}
        testId="p-results"
      >
        {rows.map((r) => (
          <tr key={r.mrn} className="border-t border-[#EDF0F3]">
            <td className="px-4 py-3">
              <input
                type="checkbox"
                aria-label={`Select ${r.mrn}`}
                checked={selected.has(r.mrn)}
                onChange={() => toggle(r.mrn)}
                className="size-5 accent-brand"
                data-testid={`p-sel-${r.mrn}`}
              />
            </td>
            <td className="px-4 py-3 font-semibold">{r.name}</td>
            <td className="px-4 py-3">{r.mrn}</td>
            <td className="px-4 py-3">
              {r.has_email ? (
                'Yes'
              ) : (
                <span className="font-semibold text-bad">{t('hospital.missing')}</span>
              )}
            </td>
            <td className="px-4 py-3">
              {r.has_phone ? (
                'Yes'
              ) : (
                <span className="font-semibold text-bad">{t('hospital.missing')}</span>
              )}
            </td>
            <td className="px-4 py-3">
              {r.app_status ? (
                <Badge tone={r.app_status === 'active' ? 'ok' : 'neutral'}>{r.app_status}</Badge>
              ) : (
                t('hospital.notInvited')
              )}
            </td>
          </tr>
        ))}
      </Table>
      {selected.size > 0 && (
        <Card title={t('hospital.via', { n: selected.size })} testId="p-invite">
          {(['email', 'sms', 'print'] as const).map((v) => (
            <label key={v} className="flex min-h-11 items-center gap-2 text-[14px]">
              <input
                type="radio"
                name="via"
                checked={via === v}
                onChange={() => setVia(v)}
                className="size-5 accent-brand"
                data-testid={`via-${v}`}
              />
              {t(`hospital.via${v[0]!.toUpperCase()}${v.slice(1)}`)}
            </label>
          ))}
          <Button className="self-start" onClick={() => void send()} data-testid="p-send">
            {t('hospital.send')}
          </Button>
        </Card>
      )}
      {results.length > 0 && (
        <ul className="flex flex-col gap-2" data-testid="p-invite-results">
          {results.map((r) => (
            <li key={r.mrn} className="flex items-center gap-3 text-[14px]">
              <span className="font-semibold">{r.mrn}</span>
              <Badge tone={r.result === 'sent' || r.result === 'printed' ? 'ok' : 'warn'}>
                {t(`hospital.result_${r.result}`)}
              </Badge>
              {r.qr_png_base64 && (
                <img
                  src={`data:image/png;base64,${r.qr_png_base64}`}
                  alt=""
                  width={120}
                  height={120}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      <Card title={t('hospital.deletionTitle')}>
        <p className="text-[13px] text-muted">{t('hospital.deletionHint')}</p>
        {(deletions ?? []).length === 0 && (
          <p className="text-[14px] text-muted">{t('app.none')}</p>
        )}
        <ul className="flex flex-col gap-2">
          {(deletions ?? []).map((d) => (
            <li key={d.id} className="flex items-center gap-3 text-[14px]">
              <code>{d.ncid}</code> · {fmt(d.requested_at)}{' '}
              <Badge tone={d.status === 'done' ? 'ok' : 'warn'}>{d.status}</Badge>
              {d.status !== 'done' && (
                <Button
                  variant="secondary"
                  onClick={() =>
                    void attempt(setError, async () => {
                      await call('POST', `/hospital/deletion-requests/${d.id}/done`);
                      reloadDel();
                    })
                  }
                >
                  {t('hospital.markDone')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </Page>
  );
}

// --- Activity ---

export function Activity() {
  const { t } = useTranslation();
  const [platform, platErr] = useLoad(() => call<AuditRow[]>('GET', '/hospital/audit?limit=200'));
  const [clinical, clinErr] = useLoad(() => hospital<AuditRow[]>('GET', '/v1/activity?limit=200'));
  return (
    <Page title={t('hospital.activityTitle')}>
      <Card title={t('hospital.clinicalEvents')}>
        <ErrorNote error={clinErr} />
        <AuditTable rows={clinical ?? []} testId="clinical-log" />
      </Card>
      <Card title={t('hospital.platformEvents')}>
        <ErrorNote error={platErr} />
        <AuditTable rows={platform ?? []} testId="hospital-log" />
      </Card>
    </Page>
  );
}

export function Overview({ siteName }: { siteName: string }) {
  const { t } = useTranslation();
  const [conn] = useLoad(() => call<ConnectorInfo>('GET', '/hospital/connector'));
  const [keys] = useLoad(() => call<KeyRow[]>('GET', '/hospital/keys'));
  const [ops] = useLoad(() => call<Operator[]>('GET', '/hospital/operators'));
  const [devs] = useLoad(() => call<DeviceRow[]>('GET', '/hospital/devices'));
  const okConn = !!conn?.check && Object.values(conn.check).every((v) => v === 'pass');
  return (
    <Page title={siteName}>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <Card title={t('hospital.connectorTitle')}>
          <Badge tone={okConn ? 'ok' : 'warn'}>{okConn ? t('app.pass') : t('app.warn')}</Badge>
        </Card>
        <Card title={t('hospital.keysTitle')}>
          <Badge tone={(keys ?? []).some((k) => k.status === 'active') ? 'ok' : 'warn'}>
            {(keys ?? []).length}
          </Badge>
        </Card>
        <Card title={t('hospital.operatorsTitle')}>
          <span className="text-[22px] font-bold">{(ops ?? []).length}</span>
        </Card>
        <Card title={t('hospital.phonesTitle')}>
          <span className="text-[22px] font-bold">
            {(devs ?? []).filter((d) => !d.revoked_at).length}
          </span>
        </Card>
      </div>
    </Page>
  );
}
