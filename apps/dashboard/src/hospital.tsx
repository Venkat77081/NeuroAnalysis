/**
 * Hospital admin (M14): data connections and health, team, phones, patients (listed live from the
 * connector), invites, deletion requests and the activity log. Patient identity is fetched from the
 * hospital connector by this browser; the platform only ever sees NCIDs.
 */
import { deviceCheck } from './config.ts';
import { ResetSignIn } from './reset.tsx';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import QRCode from 'qrcode';
import { call, hospital } from './api.ts';
import { fromAudit, type AuditRow } from './platform.tsx';
import { ActivityLog, type LogRow, type Who } from './activity.tsx';
import { HospitalPermissions } from './permissions.tsx';
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
  /** Decision 037: the hospital's own Azure Blob container. */
  azure: Record<string, string> | null;
  azure_app_client_id: string | null;
  azure_consent_url: string | null;
  azure_role_definition: unknown;
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
  const [az, setAz] = useState({
    account: '',
    container: '',
    tenant_id: '',
    prefix: 'neurocapture/',
  });
  const [own, setOwn] = useState<'s3' | 'azure' | null>(null);
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
  const saveStorage = (kind: 'managed' | 's3' | 'azure') =>
    attempt(setError, async () => {
      try {
        await call(
          'PUT',
          '/hospital/storage',
          kind === 'managed' ? { kind } : kind === 's3' ? { kind, s3 } : { kind, azure: az },
        );
      } finally {
        reloadStorage(); // a failed test is shown in the check results
      }
    });
  const showing =
    own ?? (storage?.kind === 'azure' ? 'azure' : storage?.kind === 's3' ? 's3' : null);

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
      <Card title={t('hospital.storageTitle')} testId="storage-card">
        <p className="text-[14px]" data-testid="storage-now">
          {storage?.kind === 's3'
            ? t('hospital.storageS3')
            : storage?.kind === 'azure'
              ? t('hospital.storageAzure', {
                  account: storage.azure?.account,
                  container: storage.azure?.container,
                })
              : t('hospital.storageManaged')}
        </p>
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('hospital.storageOwn')}>
          <Button
            variant={showing === 's3' ? 'secondary' : 'ghost'}
            onClick={() => setOwn('s3')}
            data-testid="storage-show-s3"
          >
            {t('hospital.ownS3')}
          </Button>
          <Button
            variant={showing === 'azure' ? 'secondary' : 'ghost'}
            onClick={() => setOwn('azure')}
            data-testid="storage-show-azure"
          >
            {t('hospital.ownAzure')}
          </Button>
          {storage?.kind !== 'managed' && (
            <Button variant="ghost" onClick={() => void saveStorage('managed')}>
              {t('hospital.useManaged')}
            </Button>
          )}
        </div>
        {showing === 's3' && (
          <>
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
            <div>
              <Button
                variant="secondary"
                disabled={!s3.bucket || !s3.role_arn}
                onClick={() => void saveStorage('s3')}
              >
                {t('hospital.saveStorage')}
              </Button>
            </div>
          </>
        )}
        {showing === 'azure' && storage && !storage.azure_app_client_id && (
          <Notice tone="warn">{t('hospital.azureNotOffered')}</Notice>
        )}
        {showing === 'azure' && storage?.azure_app_client_id && (
          <div className="flex flex-col gap-3" data-testid="storage-azure">
            <ol className="m-0 flex list-decimal flex-col gap-1.5 pl-5 text-[13px] leading-[19px]">
              <li>
                {t('hospital.azureStep1')}{' '}
                {storage.azure_consent_url && (
                  <a
                    href={storage.azure_consent_url}
                    target="_blank"
                    rel="noreferrer"
                    className="font-semibold text-brand underline"
                  >
                    {t('hospital.azureConsent')}
                  </a>
                )}
              </li>
              <li>{t('hospital.azureStep2')}</li>
              <li>{t('hospital.azureStep3')}</li>
              <li>{t('hospital.azureStep4')}</li>
            </ol>
            <details>
              <summary className="cursor-pointer text-[13px] font-semibold">
                {t('hospital.azureRole')}
              </summary>
              <pre className="overflow-x-auto rounded-lg bg-[#F4F6F8] p-3 text-[12px]">
                {JSON.stringify(storage.azure_role_definition, null, 2)}
              </pre>
            </details>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
              <Field
                id="az-account"
                label={t('hospital.azAccount')}
                value={az.account}
                onChange={(e) => setAz({ ...az, account: e.target.value.trim().toLowerCase() })}
              />
              <Field
                id="az-container"
                label={t('hospital.azContainer')}
                value={az.container}
                onChange={(e) => setAz({ ...az, container: e.target.value.trim().toLowerCase() })}
              />
              <Field
                id="az-tenant"
                label={t('hospital.azTenant')}
                value={az.tenant_id}
                onChange={(e) => setAz({ ...az, tenant_id: e.target.value.trim() })}
              />
              <Field
                id="az-prefix"
                label={t('hospital.prefix')}
                value={az.prefix}
                onChange={(e) => setAz({ ...az, prefix: e.target.value })}
              />
            </div>
            <div>
              <Button
                variant="secondary"
                disabled={!az.account || !az.container || az.tenant_id.length < 36}
                onClick={() => void saveStorage('azure')}
                data-testid="az-save"
              >
                {t('hospital.saveStorage')}
              </Button>
            </div>
          </div>
        )}
        {checks(storage?.check ?? null)}
      </Card>
    </Page>
  );
}

// --- Team ---

interface Operator {
  id: string;
  code: string;
  name: string | null;
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
  last_login_at: string | null;
}

export function Team() {
  const { t } = useTranslation();
  const [ops, , reloadOps] = useLoad(() => call<Operator[]>('GET', '/hospital/operators'));
  const [staff, , reloadStaff] = useLoad(() => call<StaffRow[]>('GET', '/hospital/staff'));
  const [code, setCode] = useState('');
  const [opName, setOpName] = useState('');
  const [temp, setTemp] = useState<{ code: string; pw: string } | null>(null);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('doctor');
  const [error, setError] = useState<unknown>(null);
  const showTemp = (o: Operator) =>
    o.temporary_password && setTemp({ code: o.code, pw: o.temporary_password });
  return (
    <Page title={t('hospital.teamTitle')}>
      <p className="max-w-3xl text-[14px] leading-[21px] text-[#3D4552]">
        {t('hospital.teamHint')}
      </p>
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
          <Field
            id="op-name"
            label={t('hospital.personName')}
            value={opName}
            onChange={(e) => setOpName(e.target.value)}
            data-testid="op-name"
          />
          <Button
            disabled={code.length < 2 || opName.trim().length < 2}
            onClick={() =>
              void attempt(setError, async () => {
                showTemp(
                  await call<Operator>('POST', '/hospital/operators', {
                    code,
                    name: opName.trim(),
                  }),
                );
                setCode('');
                setOpName('');
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
              <span>{o.name ?? ''}</span>
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
            label={t('hospital.personName')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-testid="st-name"
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
            disabled={!email.includes('@') || name.trim().length < 2}
            onClick={() =>
              void attempt(setError, async () => {
                try {
                  await call('POST', '/hospital/staff', { email, display_name: name.trim(), role });
                  setEmail('');
                  setName('');
                } finally {
                  // Also when only the e-mail failed (502 email_not_sent): the person was added.
                  reloadStaff();
                }
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
              <span className="text-[13px] text-muted">
                {u.last_login_at
                  ? t('hospital.lastActive', { at: fmt(u.last_login_at) })
                  : t('hospital.neverSignedIn')}
              </span>
              <span className="flex-1" />
              {!u.invited && (
                <ResetSignIn
                  url={`/hospital/staff/${u.id}/reset-sign-in`}
                  name={u.display_name ?? u.email}
                  email={u.email}
                  testId="st-reset"
                />
              )}
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
      <HospitalPermissions />
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
  /** Camera check when the phone was added (decision 035); null for phones added before it. */
  check_fps: number | null;
  /** Takes recorded in the last `deviceCheck.usageDays` days, retakes included. */
  takes_recent: number;
  takes_below_min: number;
}

function CheckBadge({ fps }: { fps: number | null }) {
  const { t } = useTranslation();
  if (fps === null) return <Badge>{t('hospital.checkNone')}</Badge>;
  const borderline = fps < deviceCheck.warnBelowFps;
  return (
    <Badge tone={borderline ? 'warn' : 'ok'}>
      {t(borderline ? 'hospital.checkBorderline' : 'hospital.checkPassed', {
        fps: fps.toFixed(1),
      })}
    </Badge>
  );
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
      <Notice>
        {t('hospital.checkNote', { min: deviceCheck.minFps, take: deviceCheck.warnBelowFps })}
      </Notice>
      <Table
        head={[
          t('hospital.phoneCol'),
          '',
          t('hospital.checkCol'),
          t('hospital.usageCol', { days: deviceCheck.usageDays }),
          t('hospital.addedCol'),
          '',
        ]}
        testId="devices"
      >
        {(devices ?? []).map((d) => (
          <tr key={d.id} className="border-t border-[#EDF0F3]">
            <td className="px-4 py-3 font-semibold">{d.label ?? d.model}</td>
            <td className="px-4 py-3 text-[13px] text-muted">
              {d.model} · Android {d.os_version}
            </td>
            <td className="px-4 py-3" data-testid="device-check">
              <CheckBadge fps={d.check_fps} />
            </td>
            <td className="px-4 py-3 text-[13px]" data-testid="device-usage">
              {d.takes_recent === 0 ? (
                <span className="text-muted">{t('hospital.usageNone')}</span>
              ) : (
                <>
                  {t('hospital.usageTakes', { count: d.takes_recent })}
                  {' · '}
                  <span
                    className={d.takes_below_min > 0 ? 'font-semibold text-warn' : 'text-muted'}
                  >
                    {t('hospital.usageBelow', {
                      count: d.takes_below_min,
                      fps: deviceCheck.warnBelowFps,
                    })}
                  </span>
                </>
              )}
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

interface Deletion {
  id: string;
  ncid: string;
  requested_at: string;
  status: string;
}

/** Deletion requests from phones before v3 (the app no longer offers deletion; decision 030). */
function DeletionRequests() {
  const { t } = useTranslation();
  const [error, setError] = useState<unknown>(null);
  const [deletions, , reloadDel] = useLoad(() =>
    call<Deletion[]>('GET', '/hospital/deletion-requests'),
  );
  if ((deletions ?? []).length === 0) return null;
  return (
    <Card title={t('hospital.deletionTitle')}>
      <p className="text-[13px] text-muted">{t('hospital.deletionHint')}</p>
      <ErrorNote error={error} />
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
  );
}

// --- Activity ---

interface ClinicalRow {
  at: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  ncid: string | null;
  details: Record<string, unknown> | null;
}

/** One log for everyone: platform events and the connector's clinical events, by person. */
export function Activity() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<LogRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let off = false;
    void (async () => {
      try {
        const [platform, staff, ops] = await Promise.all([
          call<AuditRow[]>('GET', '/hospital/audit?limit=500'),
          call<StaffRow[]>('GET', '/hospital/staff'),
          call<Operator[]>('GET', '/hospital/operators'),
        ]);
        // The connector logs platform user IDs only; names come from the team list.
        const people = new Map<string, Who>();
        for (const u of staff)
          people.set(u.id, { name: u.display_name ?? u.email, email: u.email, role: u.role });
        for (const o of ops)
          people.set(o.id, {
            name: o.name ? `${o.name} (${o.code})` : o.code,
            email: null,
            role: 'operator',
          });
        let clinical: ClinicalRow[] = [];
        try {
          clinical = await hospital<ClinicalRow[]>('GET', '/v1/activity?limit=500');
        } catch (e) {
          setError(e); // the hospital system is down: show the platform events anyway
        }
        const all: LogRow[] = [
          ...platform.map(fromAudit),
          ...clinical.map((c) => ({
            at: c.at,
            who: people.get(c.actor_id ?? '') ?? {
              name: t(`log.actor.${c.actor_type}`, { defaultValue: c.actor_type }),
              email: null,
              role: c.actor_type,
            },
            action: c.action,
            details: c.details,
            patient: c.ncid,
          })),
        ].sort((x, y) => y.at.localeCompare(x.at));
        // Patient names, live from the hospital (not stored).
        const ncids = [...new Set(all.map((r) => r.patient).filter((n): n is string => !!n))];
        if (ncids.length) {
          try {
            const ids = await hospital<{ ncid: string; mrn: string; name: string | null }[]>(
              'POST',
              '/v1/patients/lookup',
              { ncids },
            );
            const name = new Map(ids.map((i) => [i.ncid, `${i.name ?? ''} · MRN ${i.mrn}`]));
            for (const r of all)
              if (r.patient && name.has(r.patient)) r.patient = name.get(r.patient)!;
          } catch {
            /* names stay NCIDs */
          }
        }
        if (!off) setRows(all);
      } catch (e) {
        if (!off) setError(e);
      }
    })();
    return () => {
      off = true;
    };
  }, [t]);
  return (
    <Page title={t('hospital.activityTitle')}>
      <Notice>{t('log.hospitalHint')}</Notice>
      <ErrorNote error={error} />
      <ActivityLog rows={rows ?? []} testId="activity-log" />
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
      <Notice>{t('hospital.deskDoes')}</Notice>
      <DeletionRequests />
    </Page>
  );
}
