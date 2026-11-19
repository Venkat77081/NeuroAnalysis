/**
 * Hospital admin (M14): data connections and health, team, phones, patients (listed live from the
 * connector), invites, deletion requests and the activity log. Patient identity is fetched from the
 * hospital connector by this browser; the platform only ever sees NCIDs.
 */
import { deviceCheck, deviceQrPrefix } from './config.ts';
import { ConnectorStrip } from './health.tsx';
import { ResetSignIn } from './reset.tsx';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import QRCode from 'qrcode';
import { call, hospital } from './api.ts';
import { fromAudit, type AuditRow } from './platform.tsx';
import { ActivityLog, type LogRow, type Who } from './activity.tsx';
import { HospitalPermissions } from './permissions.tsx';
import { MessagingCard } from './messaging.tsx';
import {
  Badge,
  Button,
  Card,
  ErrorNote,
  Field,
  Notice,
  Page,
  fmt,
  fmtDate,
  Avatar,
  Dialog,
} from './ui.tsx';

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
  /** none (not connected: no recording) | s3 | azure | dev (decision 044) */
  kind: string;
  can_record: boolean;
  offered: string[];
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

type FlowState = 'ok' | 'warn' | 'bad' | 'info';
const passed = (c: Record<string, string> | null) =>
  !!c && Object.keys(c).length > 0 && Object.values(c).every((v) => v === 'pass');
const failed = (c: Record<string, string> | null) =>
  !!c && Object.values(c).some((v) => v === 'fail');

/** v28: one coloured node of the data-flow picture. */
function FlowNode({
  title,
  text,
  state,
  status,
  colour,
  testId,
}: {
  title: string;
  text: string;
  state: FlowState;
  status: string;
  colour: string;
  testId: string;
}) {
  return (
    <div
      className="nc-fu flex min-w-[200px] flex-1 flex-col gap-1.5 rounded-[22px] border-t-[5px] bg-card px-4 py-3.5 shadow-[0_8px_28px_rgb(22_21_31/0.1)]"
      style={{ borderTopColor: colour }}
      data-testid={testId}
    >
      <b className="text-[15px]">{title}</b>
      <span className="text-[13px] leading-[19px] text-sub">{text}</span>
      <span>
        <Badge tone={state === 'info' ? 'info' : state}>{status}</Badge>
      </span>
    </div>
  );
}

function FlowArrow({ label }: { label: string }) {
  return (
    <div className="hidden min-w-[70px] flex-[0.6] flex-col items-center gap-1.5 text-[12px] font-semibold text-muted lg:flex">
      <span className="text-center">{label}</span>
      <span aria-hidden className="nc-flow h-1 w-full rounded-full" />
    </div>
  );
}

/**
 * v28 (decision 051): how data moves, with the live state of each part. Names and videos stay in
 * the hospital; the platform passes sealed packages and counts.
 */
function DataFlow({
  conn,
  storage,
  keys,
}: {
  conn: ConnectorInfo | null;
  storage: StorageInfo | null;
  keys: KeyRow[] | null;
}) {
  const { t } = useTranslation();
  const connState: FlowState = !conn?.registered
    ? 'warn'
    : passed(conn.check)
      ? 'ok'
      : failed(conn.check)
        ? 'bad'
        : 'warn';
  const connStatus = !conn?.registered
    ? t('flow.notSetUp')
    : passed(conn.check)
      ? t('flow.working')
      : failed(conn.check)
        ? t('flow.failing')
        : t('flow.notTested');
  const storeState: FlowState = storage?.can_record
    ? 'ok'
    : storage?.kind && storage.kind !== 'none' && failed(storage.check)
      ? 'bad'
      : 'warn';
  const keyReady = (keys ?? []).some((k) => k.status === 'active');
  return (
    <Card title={t('flow.title')} testId="data-flow">
      <span className="-mt-2 text-[14px] text-sub">{t('flow.sub')}</span>
      <div className="flex flex-wrap items-stretch gap-3 lg:flex-nowrap lg:items-center">
        <div className="relative flex flex-1 flex-wrap items-center gap-3 rounded-3xl border-2 border-dashed border-brand-2/60 px-3 pt-6 pb-3 lg:flex-nowrap">
          <span className="absolute -top-3 left-4 bg-card px-2 text-[12px] font-extrabold text-brand-2 uppercase">
            {t('flow.inside')}
          </span>
          <FlowNode
            title={t('flow.records')}
            text={t('flow.recordsText')}
            state={connState}
            status={connStatus}
            colour="var(--color-brand)"
            testId="flow-records"
          />
          <FlowArrow label={t('flow.readLive')} />
          <FlowNode
            title={t('flow.connector')}
            text={conn?.url ?? t('flow.connectorText')}
            state={connState}
            status={connStatus}
            colour="var(--color-brand-2)"
            testId="flow-connector"
          />
        </div>
        <FlowArrow label={t('flow.sealed')} />
        <div className="relative flex flex-[0.55] items-center rounded-3xl border-2 border-dashed border-coral/70 px-3 pt-6 pb-3">
          <span className="absolute -top-3 left-4 bg-card px-2 text-[12px] font-extrabold text-coral uppercase">
            {t('app.name')}
          </span>
          <FlowNode
            title={t('flow.platform')}
            text={t('flow.platformText')}
            state="info"
            status={t('flow.noNames')}
            colour="var(--color-coral)"
            testId="flow-platform"
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 lg:flex-nowrap lg:px-3">
        <FlowNode
          title={t('flow.phones')}
          text={t('flow.phonesText')}
          state={keyReady ? 'ok' : 'warn'}
          status={keyReady ? t('flow.keyReady') : t('flow.noKey')}
          colour="#0891b2"
          testId="flow-phones"
        />
        <FlowArrow label={t('flow.encrypted')} />
        <FlowNode
          title={t('flow.storage')}
          text={
            storage?.kind && storage.kind !== 'none'
              ? t(`flow.storageKind.${storage.kind}`, { defaultValue: storage.kind })
              : t('flow.storageText')
          }
          state={storeState}
          status={
            storage?.can_record
              ? t('flow.working')
              : storeState === 'bad'
                ? t('flow.failing')
                : t('flow.notSetUp')
          }
          colour="#059669"
          testId="flow-storage"
        />
        <span className="hidden flex-1 lg:block" />
      </div>
      {conn?.registered && (
        <div className="rounded-3xl bg-soft p-4">
          <ConnectorStrip url="/hospital/connector/history" />
        </div>
      )}
    </Card>
  );
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
  const saveStorage = (kind: 'dev' | 's3' | 'azure') =>
    attempt(setError, async () => {
      try {
        await call(
          'PUT',
          '/hospital/storage',
          kind === 'dev' ? { kind } : kind === 's3' ? { kind, s3 } : { kind, azure: az },
        );
      } finally {
        reloadStorage(); // a failed test is shown in the check results
      }
    });
  const showing =
    own ?? (storage?.kind === 'azure' ? 'azure' : storage?.kind === 's3' ? 's3' : null);

  return (
    <Page title={t('nav.connections')}>
      {storage && !storage.can_record && (
        <Notice tone="bad" testId="recording-off">
          {t('hospital.recordingOff')}
        </Notice>
      )}
      <ErrorNote error={error ?? connErr} />
      <DataFlow conn={conn} storage={storage} keys={keys} />
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
          <label className="flex flex-col gap-1 text-[13px] font-semibold text-sub">
            {t('hospital.connectorKey')}
            <textarea
              value={pem}
              onChange={(e) => setPem(e.target.value)}
              rows={3}
              className="rounded-2xl border border-edge p-2 font-mono text-[12px]"
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
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={storage?.can_record ? 'ok' : 'bad'}>
            {storage?.can_record ? t('hospital.storageReady') : t('hospital.storageNotReady')}
          </Badge>
        </div>
        <p className="text-[14px]" data-testid="storage-now">
          {storage?.kind === 's3'
            ? t('hospital.storageS3')
            : storage?.kind === 'azure'
              ? t('hospital.storageAzure', {
                  account: storage.azure?.account,
                  container: storage.azure?.container,
                })
              : storage?.kind === 'dev'
                ? t('hospital.storageDev')
                : t('hospital.storageNone')}
        </p>
        <p className="text-[13px] leading-[19px] text-muted">{t('hospital.storageWhy')}</p>
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
          {storage?.offered.includes('dev') && storage.kind !== 'dev' && (
            <Button
              variant="ghost"
              onClick={() => void saveStorage('dev')}
              data-testid="storage-dev"
            >
              {t('hospital.useDev')}
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
                    className="font-semibold text-brand-ink underline"
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
              <pre className="overflow-x-auto rounded-lg bg-soft p-3 text-[12px]">
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
      {conn?.url && <MessagingCard />}
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
  // v30 (canvas v28): people as cards with role chips; adding happens in a pop-up.
  const [adding, setAdding] = useState<'staff' | 'operator' | null>(null);
  const [show, setShow] = useState<
    'all' | 'doctor' | 'receptionist' | 'operator' | 'hospital_admin'
  >('all');
  const showTemp = (o: Operator) =>
    o.temporary_password && setTemp({ code: o.code, pw: o.temporary_password });
  const count = (r: string) =>
    r === 'operator' ? (ops ?? []).length : (staff ?? []).filter((u) => u.role === r).length;
  const card = 'nc-fu flex flex-col gap-3 rounded-3xl bg-card p-4 shadow-card';
  const state = (active: boolean, locked: boolean, extra?: [string, 'warn' | 'info'] | null) =>
    locked ? (
      <Badge tone="bad">{t('hospital.locked')}</Badge>
    ) : !active ? (
      <Badge tone="neutral">{t('team.off')}</Badge>
    ) : extra ? (
      <Badge tone={extra[1]}>{extra[0]}</Badge>
    ) : (
      <Badge tone="ok">{t('team.active')}</Badge>
    );
  return (
    <Page
      title={t('hospital.teamTitle')}
      actions={
        <>
          <Button
            variant="secondary"
            onClick={() => setAdding('operator')}
            data-testid="team-add-operator"
          >
            ＋ {t('team.addOperator')}
          </Button>
          <Button onClick={() => setAdding('staff')} data-testid="team-invite">
            ＋ {t('team.invite')}
          </Button>
        </>
      }
    >
      <div className="-mt-2 flex flex-wrap gap-1.5" role="group" aria-label={t('team.show')}>
        {(['all', 'doctor', 'receptionist', 'operator', 'hospital_admin'] as const).map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={show === k}
            onClick={() => setShow(k)}
            className={`min-h-9 rounded-full px-3.5 text-[13px] font-semibold ${show === k ? 'bg-ink text-ground' : 'bg-card text-sub shadow-[inset_0_0_0_1px_var(--color-edge)]'}`}
          >
            {t(`team.chip.${k}`, {
              count: k === 'all' ? (ops ?? []).length + (staff ?? []).length : count(k),
            })}
          </button>
        ))}
      </div>
      <ErrorNote error={error} />
      {temp && (
        <Notice testId="temp-password">
          {t('hospital.tempPassword', { code: temp.code, pw: temp.pw })}
        </Notice>
      )}
      {show !== 'operator' && (
        <ul
          className="m-0 grid list-none grid-cols-1 gap-3.5 p-0 sm:grid-cols-2 xl:grid-cols-4"
          data-testid="staff"
        >
          {(staff ?? [])
            .filter((u) => show === 'all' || u.role === show)
            .map((u) => (
              <li key={u.id} className={card}>
                <div className="flex items-center gap-3">
                  <Avatar name={u.display_name ?? u.email} size={40} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <b className="truncate text-[14px]">{u.display_name ?? u.email}</b>
                    <span className="truncate text-[12px] text-muted">
                      {t(`roles.${u.role}`)} · {u.email}
                    </span>
                  </span>
                  {state(u.active, u.locked, u.invited ? [t('team.invited'), 'info'] : null)}
                </div>
                <span className="text-[12px] text-muted">
                  {u.last_login_at
                    ? t('hospital.lastActive', { at: fmt(u.last_login_at) })
                    : t('hospital.neverSignedIn')}
                </span>
                <div className="mt-auto flex flex-wrap items-center gap-1">
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
                    className="min-h-9 text-[13px]"
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
                </div>
              </li>
            ))}
        </ul>
      )}
      {(show === 'all' || show === 'operator') && (
        <>
          <h2 className="mt-1 text-[17px] font-bold">{t('hospital.operatorsTitle')}</h2>
          <ul
            className="m-0 grid list-none grid-cols-1 gap-3.5 p-0 sm:grid-cols-2 xl:grid-cols-4"
            data-testid="operators"
          >
            {(ops ?? []).map((o) => (
              <li key={o.id} className={card}>
                <div className="flex items-center gap-3">
                  <Avatar name={o.name ?? o.code} size={40} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <b className="truncate text-[14px]">{o.name ?? o.code}</b>
                    <span className="truncate text-[12px] text-muted">
                      {t('team.operator', { code: o.code })}
                    </span>
                  </span>
                  {state(
                    o.active,
                    o.locked,
                    o.must_change_password ? [t('hospital.mustChange'), 'warn'] : null,
                  )}
                </div>
                <div className="mt-auto flex flex-wrap gap-1">
                  <Button
                    variant="secondary"
                    className="min-h-9 text-[13px]"
                    onClick={() =>
                      void attempt(setError, async () => {
                        showTemp(
                          await call<Operator>(
                            'POST',
                            `/hospital/operators/${o.id}/reset-password`,
                          ),
                        );
                        reloadOps();
                      })
                    }
                  >
                    {t('hospital.reset')}
                  </Button>
                  <Button
                    variant="ghost"
                    className="min-h-9 text-[13px]"
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
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      <HospitalPermissions />
      {adding === 'operator' && (
        <Dialog
          title={t('team.addOperatorTitle')}
          sub={t('team.addOperatorSub')}
          size="sm"
          onClose={() => setAdding(null)}
          testId="operator-dialog"
        >
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
          <ErrorNote error={error} />
          <Button
            className="self-start"
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
                setAdding(null);
                reloadOps();
              })
            }
            data-testid="op-add"
          >
            {t('hospital.addOperator')}
          </Button>
        </Dialog>
      )}
      {adding === 'staff' && (
        <Dialog
          title={t('team.inviteTitle')}
          sub={t('hospital.teamHint')}
          size="sm"
          onClose={() => setAdding(null)}
          testId="staff-dialog"
        >
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
          <label className="flex flex-col gap-1 text-[13px] font-semibold text-sub">
            {t('hospital.role')}
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="h-11 rounded-2xl border border-edge bg-card px-2 text-[14px]"
            >
              <option value="doctor">{t('roles.doctor')}</option>
              <option value="receptionist">{t('roles.receptionist')}</option>
              <option value="hospital_admin">{t('roles.hospital_admin')}</option>
            </select>
          </label>
          <ErrorNote error={error} />
          <Button
            className="self-start"
            disabled={!email.includes('@') || name.trim().length < 2}
            onClick={() =>
              void attempt(setError, async () => {
                try {
                  await call('POST', '/hospital/staff', { email, display_name: name.trim(), role });
                  setEmail('');
                  setName('');
                  setAdding(null);
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
        </Dialog>
      )}
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
      setCode({
        ...c,
        qr: await QRCode.toDataURL(`${deviceQrPrefix}${c.code}`, { margin: 1, width: 200 }),
      });
      setLabel('');
    });
  return (
    <Page
      title={t('hospital.phonesTitle')}
      sub={t('hospital.checkNote', { min: deviceCheck.minFps, take: deviceCheck.warnBelowFps })}
    >
      <ErrorNote error={error} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <ul
          className="m-0 grid list-none grid-cols-1 content-start gap-3.5 p-0 sm:grid-cols-2 2xl:grid-cols-3"
          data-testid="devices"
        >
          {(devices ?? []).length === 0 && (
            <li className="text-[14px] text-muted">{t('hospital.noPhones')}</li>
          )}
          {(devices ?? []).map((d) => {
            const fail = d.check_fps !== null && d.check_fps < deviceCheck.minFps;
            const tone = d.revoked_at
              ? 'neutral'
              : d.check_fps === null
                ? 'warn'
                : fail
                  ? 'bad'
                  : d.check_fps < deviceCheck.warnBelowFps
                    ? 'warn'
                    : 'ok';
            return (
              <li
                key={d.id}
                className="nc-fu flex flex-col gap-3 rounded-3xl bg-card p-4 shadow-card"
              >
                <div className="flex items-center gap-3">
                  <span
                    aria-hidden
                    className="flex h-[54px] w-10 shrink-0 items-end justify-center rounded-[9px] border-[3px] border-ink pb-1"
                  >
                    <span className="h-0.5 w-3 rounded-full bg-ink" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <b className="truncate text-[15px]">{d.label ?? d.model}</b>
                    <span className="truncate text-[12px] text-muted">
                      {d.model} · Android {d.os_version}
                    </span>
                  </span>
                  {d.revoked_at ? (
                    <Badge tone="neutral">{t('hospital.removed')}</Badge>
                  ) : (
                    <span data-testid="device-check">
                      <CheckBadge fps={d.check_fps} />
                    </span>
                  )}
                </div>
                <div className="flex items-baseline justify-between">
                  <span className="text-[12px] text-muted">{t('hospital.checkCol')}</span>
                  <b
                    className={`text-[22px] tabular-nums ${tone === 'ok' ? 'text-ok' : tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : 'text-muted'}`}
                  >
                    {d.check_fps === null ? '—' : `${d.check_fps.toFixed(1)} fps`}
                  </b>
                </div>
                <span className="text-[12px] text-sub">
                  {t('hospital.usageCol', { days: deviceCheck.usageDays })}:{' '}
                  <span data-testid="device-usage">
                    {d.takes_recent === 0 ? (
                      t('hospital.usageNone')
                    ) : (
                      <>
                        {t('hospital.usageTakes', { count: d.takes_recent })}
                        {' · '}
                        <span className={d.takes_below_min > 0 ? 'font-semibold text-warn' : ''}>
                          {t('hospital.usageBelow', {
                            count: d.takes_below_min,
                            fps: deviceCheck.warnBelowFps,
                          })}
                        </span>
                      </>
                    )}
                  </span>
                </span>
                <div className="mt-auto flex items-center justify-between gap-2 text-[12px] text-muted">
                  <span>{t('hospital.addedOn', { date: fmtDate(d.registered_at) })}</span>
                  {!d.revoked_at && (
                    <Button
                      variant="ghost"
                      className="min-h-8 px-2 text-[13px]"
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
                </div>
              </li>
            );
          })}
        </ul>
        <Card title={t('hospital.registerCard')} testId="register-card">
          <span className="text-[13px] leading-[19px] text-sub">{t('hospital.registerIntro')}</span>
          <Field
            id="d-label"
            label={t('hospital.codeLabel')}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <Button onClick={() => void newCode()} data-testid="d-new">
            {t('hospital.newCode')}
          </Button>
          {code && (
            <div className="flex flex-col items-start gap-2" data-testid="d-code">
              <img
                src={code.qr}
                alt={t('hospital.qrAlt')}
                width={200}
                height={200}
                className="self-center rounded-2xl bg-white p-2"
              />
              <ol className="m-0 flex list-decimal flex-col gap-1 pl-5 text-[13px] text-sub">
                <li>{t('hospital.registerStep1')}</li>
                <li>{t('hospital.registerStep2')}</li>
                <li>{t('hospital.registerStep3')}</li>
              </ol>
              <span className="text-[12px] text-muted">{t('hospital.orType')}</span>
              <p
                className="m-0 font-mono text-[22px] font-bold tracking-widest"
                data-testid="d-code-text"
              >
                {code.code}
              </p>
              <span className="text-[12px] text-muted">
                {t('hospital.codeShown', { until: fmt(code.expires_at) })}
              </span>
            </div>
          )}
        </Card>
      </div>
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
export function DeletionRequests() {
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
      <span className="-mt-3 text-[13px] text-sub">{t('log.hospitalHint')}</span>
      <ErrorNote error={error} />
      <ActivityLog rows={rows ?? []} testId="activity-log" />
    </Page>
  );
}
