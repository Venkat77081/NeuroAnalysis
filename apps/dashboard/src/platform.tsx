/** Platform admin (M14): onboard hospitals, follow their set-up, suspend; platform activity log. */
import { Fragment, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { call } from './api.ts';
import { ActivityLog, type LogRow } from './activity.tsx';
import { Badge, Button, Card, ErrorNote, Field, Page, Table } from './ui.tsx';

interface Hospital {
  id: string;
  name: string;
  kind: string;
  region: string;
  city: string | null;
  status: string;
  sms_enabled: boolean;
  onboarded_at: string | null;
  devices: number;
  operators: number;
  staff: number;
  patients: number;
}
interface Setup {
  admin_accepted: boolean;
  connector_registered: boolean;
  connector_check: Record<string, string> | null;
  storage_kind: string;
  storage_check: Record<string, string> | null;
  take_key: boolean;
  devices: number;
  operators: number;
  doctors: number;
}
export interface AuditRow {
  at: string;
  site_id: string | null;
  actor_type: string;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  details: Record<string, unknown> | null;
  actor_name?: string | null;
  actor_email?: string | null;
  actor_role?: string | null;
  site_name?: string | null;
  target_ncid?: string | null;
}

/** A platform audit row as a log row (the person comes with it). */
export function fromAudit(r: AuditRow): LogRow {
  return {
    at: r.at,
    who: {
      name: r.actor_name ?? r.actor_type,
      email: r.actor_email ?? null,
      role: r.actor_role ?? r.actor_type,
    },
    action: r.action,
    details: r.details,
    patient: r.target_ncid ?? null,
    hospital: r.site_name ?? null,
  };
}

export function Hospitals() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Hospital[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(
    () => call<Hospital[]>('GET', '/platform/hospitals').then(setRows, setError),
    [],
  );
  useEffect(() => void load(), [load]);
  const setStatus = async (h: Hospital, status: 'active' | 'suspended') => {
    try {
      await call('POST', `/platform/hospitals/${h.id}/status`, { status });
      await load();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <Page title={t('platform.hospitalsTitle')}>
      <ErrorNote error={error} />
      <Onboard onDone={() => void load()} />
      <Table
        head={[
          t('platform.name'),
          t('platform.status'),
          t('platform.devices'),
          t('platform.operators'),
          t('platform.patients'),
          '',
        ]}
        testId="hospitals"
      >
        {rows.map((h) => (
          <Fragment key={h.id}>
            <tr className="border-t border-[#EDF0F3]">
              <td className="px-4 py-3">
                <span className="font-semibold">{h.name}</span>
                <span className="block text-[12px] text-muted">
                  {[t(`platform.${h.kind}`), h.city, h.region].filter(Boolean).join(' · ')}
                </span>
              </td>
              <td className="px-4 py-3">
                <Badge
                  tone={h.status === 'active' ? 'ok' : h.status === 'suspended' ? 'bad' : 'warn'}
                >
                  {h.status}
                </Badge>
              </td>
              <td className="px-4 py-3">{h.devices}</td>
              <td className="px-4 py-3">{h.operators}</td>
              <td className="px-4 py-3">{h.patients}</td>
              <td className="flex gap-2 px-4 py-3">
                <Button
                  variant="secondary"
                  onClick={() => setOpen(open === h.id ? null : h.id)}
                  data-testid={`setup-${h.name}`}
                >
                  {t('platform.setup')}
                </Button>
                {h.status === 'suspended' ? (
                  <Button variant="secondary" onClick={() => void setStatus(h, 'active')}>
                    {t('platform.resume')}
                  </Button>
                ) : (
                  <Button variant="danger" onClick={() => void setStatus(h, 'suspended')}>
                    {t('platform.suspend')}
                  </Button>
                )}
              </td>
            </tr>
            {open === h.id && (
              <tr>
                <td colSpan={7} className="px-4 pb-4">
                  <SetupSteps id={h.id} />
                </td>
              </tr>
            )}
          </Fragment>
        ))}
      </Table>
    </Page>
  );
}

function SetupSteps({ id }: { id: string }) {
  const { t } = useTranslation();
  const [s, setS] = useState<Setup | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(
    () => void call<Setup>('GET', `/platform/hospitals/${id}/setup`).then(setS, setError),
    [id],
  );
  if (!s) return <ErrorNote error={error} />;
  const checkOk =
    !!s.connector_check && Object.values(s.connector_check).every((v) => v === 'pass');
  const storageOk = s.storage_kind === 'managed' || s.storage_check?.upload === 'pass';
  const steps: [string, boolean][] = [
    [t('platform.stepAdmin'), s.admin_accepted],
    [t('platform.stepConnector'), s.connector_registered],
    [t('platform.stepConnectorCheck'), checkOk],
    [t('platform.stepKey'), s.take_key],
    [`${t('platform.stepStorage')}: ${s.storage_kind}`, storageOk],
    [t('platform.stepTeam'), s.doctors > 0 && (s.operators > 0 || s.devices >= 0)],
  ];
  return (
    <ol
      className="flex flex-col gap-1.5 rounded-xl bg-ground p-3 text-[14px]"
      data-testid="setup-steps"
    >
      {steps.map(([label, ok]) => (
        <li key={label} className="flex items-center gap-2">
          <Badge tone={ok ? 'ok' : 'warn'}>{ok ? t('app.pass') : t('app.warn')}</Badge>
          {label}
        </li>
      ))}
    </ol>
  );
}

function Onboard({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const [f, setF] = useState({
    name: '',
    kind: 'hospital',
    region: 'IN',
    city: '',
    sms: false,
    home: true,
    email: '',
    adminName: '',
  });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await call('POST', '/platform/hospitals', {
        name: f.name,
        kind: f.kind,
        region: f.region,
        city: f.city || null,
        sms_enabled: f.sms,
        modules: { clinic: true, home: f.home },
        admin_email: f.email,
        admin_name: f.adminName || null,
      });
      setF({ ...f, name: '', city: '', email: '', adminName: '' });
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const sel = 'h-11 rounded-xl border border-[#C9CFD8] bg-white px-2 text-[14px]';
  return (
    <Card title={t('platform.onboard')} testId="onboard">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Field
          id="h-name"
          label={t('platform.name')}
          value={f.name}
          onChange={(e) => setF({ ...f, name: e.target.value })}
          data-testid="h-name"
        />
        <label className="flex flex-col gap-1 text-[13px] font-semibold text-[#3D4552]">
          {t('platform.kind')}
          <select
            className={sel}
            value={f.kind}
            onChange={(e) => setF({ ...f, kind: e.target.value })}
          >
            <option value="hospital">{t('platform.hospital')}</option>
            <option value="clinic">{t('platform.clinic')}</option>
          </select>
        </label>
        <Field
          id="h-city"
          label={t('platform.city')}
          value={f.city}
          onChange={(e) => setF({ ...f, city: e.target.value })}
        />
        <Field
          id="h-email"
          label={t('platform.adminEmail')}
          type="email"
          value={f.email}
          onChange={(e) => setF({ ...f, email: e.target.value })}
          data-testid="h-email"
        />
        <Field
          id="h-admin"
          label={t('platform.adminName')}
          value={f.adminName}
          onChange={(e) => setF({ ...f, adminName: e.target.value })}
        />
      </div>
      <div className="flex flex-wrap gap-5 text-[14px]">
        <label className="flex min-h-11 items-center gap-2">
          <input
            type="checkbox"
            checked={f.home}
            onChange={(e) => setF({ ...f, home: e.target.checked })}
            className="size-5 accent-brand"
          />
          {t('platform.home')}
        </label>
        <label className="flex min-h-11 items-center gap-2">
          <input
            type="checkbox"
            checked={f.sms}
            onChange={(e) => setF({ ...f, sms: e.target.checked })}
            className="size-5 accent-brand"
          />
          {t('platform.sms')}
        </label>
      </div>
      <ErrorNote error={error} />
      <Button
        className="self-start"
        disabled={busy || f.name.length < 2 || !f.email.includes('@')}
        onClick={() => void submit()}
        data-testid="h-create"
      >
        {t('platform.create')}
      </Button>
    </Card>
  );
}

export function PlatformLog() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [error, setError] = useState<unknown>(null);
  useEffect(
    () => void call<AuditRow[]>('GET', '/platform/audit?limit=300').then(setRows, setError),
    [],
  );
  return (
    <Page title={t('platform.logTitle')}>
      <ErrorNote error={error} />
      <ActivityLog
        rows={rows.map(fromAudit)}
        showHospital
        showPatient={false}
        testId="platform-log"
      />
    </Page>
  );
}
