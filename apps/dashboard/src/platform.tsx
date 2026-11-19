/** Platform admin (M14): onboard hospitals, follow their set-up, suspend; platform activity log. */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, call } from './api.ts';
import { ResetSignIn } from './reset.tsx';
import { ActivityLog, type LogRow } from './activity.tsx';
import { ConnectorStrip } from './health.tsx';
import { platformPolicy } from './config.ts';
import {
  Avatar,
  Badge,
  Button,
  Card,
  Dialog,
  ErrorNote,
  Field,
  Notice,
  Page,
  SettingRow,
  SettingsLayout,
} from './ui.tsx';

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
  /** Decision 044: the hospital's own storage passed its test. */
  can_record: boolean;
  /** v29 (decision 052): null when no connector is registered. */
  connector_online?: boolean | null;
  connector_last_seen_at?: string | null;
  /** v30 (decision 053): for the card and panel. */
  connector_registered?: boolean;
  setup_done?: number;
  setup_total?: number;
  storage_kind?: string | null;
  messaging?: { email?: string; sms?: string } | null;
  admin_email?: string | null;
}
interface Setup {
  admin_accepted: boolean;
  connector_registered: boolean;
  connector_check: Record<string, string> | null;
  storage_kind: string;
  storage_check: Record<string, string> | null;
  can_record: boolean;
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

/** v30: what a hospital card and panel need to say (canvas v28). */
export function hospitalView(h: Hospital): {
  score: number;
  live: boolean;
  onboarding: boolean;
  attention: boolean;
  connector: 'ok' | 'offline' | 'none';
  messages: 'ok' | 'failing' | 'none';
} {
  const score = Math.round((100 * (h.setup_done ?? 0)) / Math.max(1, h.setup_total ?? 6));
  const connector = !h.connector_registered
    ? 'none'
    : h.connector_online === false
      ? 'offline'
      : 'ok';
  const m = Object.values(h.messaging ?? {});
  const messages = m.includes('failing') ? 'failing' : m.includes('working') ? 'ok' : 'none';
  const live = h.status === 'active' && h.can_record && connector === 'ok' && score === 100;
  const onboarding = h.status !== 'suspended' && score < 100;
  const attention = h.status === 'suspended' || connector === 'offline' || messages === 'failing';
  return { score, live, onboarding, attention, connector, messages };
}

function Ring({ pct }: { pct: number }) {
  const c = pct === 100 ? 'var(--color-ok)' : pct >= 50 ? 'var(--color-warn)' : 'var(--color-bad)';
  return (
    <span
      className="relative inline-flex size-[52px] shrink-0 items-center justify-center rounded-full"
      style={{ background: `conic-gradient(${c} 0 ${pct}%, var(--color-line) 0)` }}
      role="img"
      aria-label={`${pct}%`}
    >
      <span className="flex size-[40px] items-center justify-center rounded-full bg-card text-[13px] font-extrabold">
        {pct}
      </span>
    </span>
  );
}

const hm = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    : '';

export function Hospitals({
  onPermissions,
  onActivity,
}: {
  onPermissions: (siteId: string) => void;
  /** v30: "Open their activity" in the side panel. */
  onActivity?: () => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Hospital[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [onboarding, setOnboarding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'attention' | 'onboarding' | 'live'>('all');
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
  const views = Object.fromEntries(rows.map((h) => [h.id, hospitalView(h)]));
  const count = (k: 'attention' | 'onboarding' | 'live') =>
    rows.filter((h) => views[h.id]![k]).length;
  const shown = rows.filter((h) => filter === 'all' || views[h.id]![filter]);
  const openRow = rows.find((h) => h.id === open);
  const chip = (k: typeof filter, label: string) => (
    <button
      key={k}
      type="button"
      aria-pressed={filter === k}
      onClick={() => setFilter(k)}
      className={`min-h-9 rounded-full px-3.5 text-[13px] font-semibold ${filter === k ? 'bg-ink text-ground' : 'bg-card text-sub shadow-[inset_0_0_0_1px_var(--color-edge)]'}`}
      data-testid={`hosp-filter-${k}`}
    >
      {label}
    </button>
  );
  const where = (h: Hospital) =>
    [t(`platform.${h.kind}`), h.city, h.region].filter(Boolean).join(' · ');
  return (
    <Page title={t('platform.hospitalsTitle')}>
      <div className="-mt-2 flex flex-wrap items-center gap-2">
        <div
          className="flex flex-wrap gap-1.5"
          role="group"
          aria-label={t('platform.filter.label')}
        >
          {chip('all', t('platform.filter.all', { count: rows.length }))}
          {chip('attention', t('platform.filter.attention', { count: count('attention') }))}
          {chip('onboarding', t('platform.filter.onboarding', { count: count('onboarding') }))}
          {chip('live', t('platform.filter.live', { count: count('live') }))}
        </div>
        <span className="flex-1" />
        <Button onClick={() => setOnboarding(true)} data-testid="onboard-open">
          ＋ {t('platform.onboard')}
        </Button>
      </div>
      <ErrorNote error={error} />
      {notice && <Notice testId="notice">{notice}</Notice>}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3" data-testid="hospitals">
        {shown.map((h) => {
          const v = views[h.id]!;
          return (
            <button
              key={h.id}
              type="button"
              onClick={() => setOpen(h.id)}
              className={`nc-fu flex flex-col gap-3 rounded-3xl bg-card p-4 text-left shadow-card transition-shadow hover:shadow-[0_0_0_2px_var(--color-edge)] ${open === h.id ? 'shadow-[0_0_0_2px_var(--color-brand)]' : ''}`}
              data-testid={`setup-${h.name}`}
            >
              <span className="flex items-center gap-3" data-testid={`hospital-${h.name}`}>
                <Avatar name={h.name} size={44} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <b className="truncate text-[15px]">{h.name}</b>
                  <span className="truncate text-[12px] text-muted">{where(h)}</span>
                </span>
                <Ring pct={v.score} />
              </span>
              <span className="flex flex-wrap gap-1.5">
                <span data-testid={`connector-${h.name}`}>
                  <Badge
                    tone={v.connector === 'ok' ? 'ok' : v.connector === 'offline' ? 'bad' : 'warn'}
                  >
                    {t(`platform.chip.connector.${v.connector}`)}
                  </Badge>
                </span>
                <span data-testid={`can-record-${h.name}`} data-state={h.can_record ? 'ok' : 'no'}>
                  <Badge tone={h.can_record ? 'ok' : 'warn'}>
                    {t(h.can_record ? 'platform.chip.storage' : 'platform.noStorage')}
                  </Badge>
                </span>
                <Badge
                  tone={v.messages === 'ok' ? 'ok' : v.messages === 'failing' ? 'bad' : 'neutral'}
                >
                  {t(`platform.chip.messages.${v.messages}`)}
                </Badge>
                {h.status === 'suspended' && (
                  <Badge tone="bad">{t('platform.statusName.suspended')}</Badge>
                )}
              </span>
              <span className="text-[13px] text-sub">
                {v.connector === 'offline'
                  ? t('platform.footOffline', {
                      devices: h.devices,
                      at: hm(h.connector_last_seen_at),
                    })
                  : v.score < 100
                    ? t('platform.footOnboarding', {
                        done: h.setup_done ?? 0,
                        total: h.setup_total ?? 6,
                      })
                    : t('platform.footLive', { devices: h.devices, patients: h.patients })}
              </span>
            </button>
          );
        })}
      </div>
      {onboarding && (
        <Dialog
          title={t('platform.onboard')}
          sub={t('platform.onboardSub')}
          onClose={() => setOnboarding(false)}
          testId="onboard-dialog"
        >
          <Onboard
            onDone={(name, email) => {
              void load();
              if (name) {
                setOnboarding(false);
                setNotice(t('platform.onboarded', { name, email }));
              }
            }}
          />
        </Dialog>
      )}
      {openRow && (
        <HospitalPanel
          h={openRow}
          onClose={() => setOpen(null)}
          onPermissions={() => onPermissions(openRow.id)}
          onActivity={onActivity}
          onStatus={(st) => void setStatus(openRow, st)}
        />
      )}
    </Page>
  );
}

function PanelRow({
  title,
  sub,
  tone,
  chip,
  testId,
}: {
  title: string;
  sub: string;
  tone: 'ok' | 'warn' | 'bad' | 'neutral';
  chip: string;
  testId?: string;
}) {
  return (
    <div className="flex items-center gap-3 border-t border-line py-3" data-testid={testId}>
      <span className="flex min-w-0 flex-1 flex-col">
        <b className="text-[14px]">{title}</b>
        <span className="truncate text-[12px] text-muted">{sub}</span>
      </span>
      <Badge tone={tone}>{chip}</Badge>
    </div>
  );
}

/** v30 (canvas v28): one hospital, along the right edge. */
function HospitalPanel({
  h,
  onClose,
  onPermissions,
  onActivity,
  onStatus,
}: {
  h: Hospital;
  onClose: () => void;
  onPermissions: () => void;
  onActivity?: () => void;
  onStatus: (s: 'active' | 'suspended') => void;
}) {
  const { t } = useTranslation();
  const v = hospitalView(h);
  const since = h.onboarded_at
    ? new Date(h.onboarded_at).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })
    : null;
  const [now] = useState(() => Date.now());
  const offFor =
    v.connector === 'offline' && h.connector_last_seen_at
      ? Math.max(0, Math.round((now - Date.parse(h.connector_last_seen_at)) / 60_000))
      : null;
  const msg = h.messaging ?? {};
  return (
    <Dialog title={h.name} size="side" bare onClose={onClose} testId="hospital-panel">
      <div className="flex items-start gap-3">
        <Avatar name={h.name} size={48} />
        <span className="flex min-w-0 flex-1 flex-col">
          <b className="text-[18px]">{h.name}</b>
          <span className="text-[13px] text-muted">
            {[t(`platform.${h.kind}`), h.city, h.region].filter(Boolean).join(' · ')}
            {since ? ` · ${t('platform.liveSince', { since })}` : ''}
          </span>
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('app.close')}
          className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-soft text-muted"
          data-testid="dialog-close"
        >
          ✕
        </button>
      </div>
      {offFor !== null && (
        <span className="self-start" data-testid="panel-offline">
          <Badge tone="bad">
            {t('platform.offlineFor', { h: Math.floor(offFor / 60), m: offFor % 60 })}
          </Badge>
        </span>
      )}
      {h.connector_registered && (
        <ConnectorStrip url={`/platform/hospitals/${h.id}/connector-history`} />
      )}
      <div className="flex flex-col">
        <PanelRow
          title={t('flow.connector')}
          sub={
            h.connector_last_seen_at
              ? t('platform.lastSeen', { at: hm(h.connector_last_seen_at) })
              : t('health.notSeen')
          }
          tone={v.connector === 'ok' ? 'ok' : v.connector === 'offline' ? 'bad' : 'warn'}
          chip={t(`platform.state.connector.${v.connector}`)}
          testId="panel-connector"
        />
        <PanelRow
          title={t('flow.storage')}
          sub={t(`platform.storageKind.${h.storage_kind ?? 'none'}`, {
            defaultValue: h.storage_kind ?? '',
          })}
          tone={h.can_record ? 'ok' : 'warn'}
          chip={t(h.can_record ? 'flow.working' : 'flow.notSetUp')}
          testId="panel-storage"
        />
        <PanelRow
          title={t('platform.messages')}
          sub={t('platform.messagesSub', {
            email: t(`platform.msgState.${msg.email ?? 'off'}`),
            sms: t(`platform.msgState.${msg.sms ?? 'off'}`),
          })}
          tone={v.messages === 'ok' ? 'ok' : v.messages === 'failing' ? 'bad' : 'neutral'}
          chip={t(`platform.state.messages.${v.messages}`)}
          testId="panel-messages"
        />
        <PanelRow
          title={t('platform.phones')}
          sub={t('platform.phonesSub', { devices: h.devices, operators: h.operators })}
          tone={h.devices ? 'ok' : 'neutral'}
          chip={t(h.devices ? 'platform.phonesReady' : 'platform.phonesNone')}
          testId="panel-phones"
        />
      </div>
      <div className="flex flex-col gap-2">
        {h.admin_email && (
          <a
            href={`mailto:${h.admin_email}`}
            className="nc-gradient inline-flex min-h-11 items-center justify-center rounded-full px-4 text-[14px] font-semibold text-white"
            data-testid="panel-email"
          >
            {t('platform.emailAdmin')}
          </a>
        )}
        {onActivity && (
          <Button variant="secondary" onClick={onActivity} data-testid="panel-activity">
            {t('platform.openActivity')}
          </Button>
        )}
        {v.connector === 'offline' && (
          <span className="text-center text-[12px] text-muted">{t('platform.waitSafely')}</span>
        )}
      </div>
      <details className="rounded-3xl bg-soft p-4" open>
        <summary className="cursor-pointer text-[14px] font-bold">
          {t('platform.setupSteps')}
        </summary>
        <div className="mt-3">
          <SetupSteps id={h.id} />
        </div>
      </details>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={onPermissions} data-testid={`perms-${h.name}`}>
          {t('perm.button')}
        </Button>
        <span className="flex-1" />
        {h.status === 'suspended' ? (
          <Button variant="secondary" onClick={() => onStatus('active')}>
            {t('platform.resume')}
          </Button>
        ) : (
          <Button variant="danger" onClick={() => onStatus('suspended')}>
            {t('platform.suspend')}
          </Button>
        )}
      </div>
    </Dialog>
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
  const storageOk = s.can_record;
  const steps: [string, boolean][] = [
    [t('platform.stepAdmin'), s.admin_accepted],
    [t('platform.stepConnector'), s.connector_registered],
    [t('platform.stepConnectorCheck'), checkOk],
    [t('platform.stepKey'), s.take_key],
    [`${t('platform.stepStorage')}: ${t(`platform.storageKind.${s.storage_kind}`)}`, storageOk],
    [t('platform.stepTeam'), s.doctors > 0 && (s.operators > 0 || s.devices >= 0)],
  ];
  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col gap-1.5 text-[14px]" data-testid="setup-steps">
        {steps.map(([label, ok]) => (
          <li key={label} className="flex items-center gap-2">
            <Badge tone={ok ? 'ok' : 'warn'}>{ok ? t('app.pass') : t('app.warn')}</Badge>
            {label}
          </li>
        ))}
      </ol>
      <HospitalAdmins id={id} />
    </div>
  );
}

interface AdminRow {
  id: string;
  email: string;
  display_name: string | null;
  signed_up: boolean;
  last_login_at: string | null;
}

/** Decision 039: the platform admin resets a hospital admin's sign-in. */
function HospitalAdmins({ id }: { id: string }) {
  const { t } = useTranslation();
  const [admins, setAdmins] = useState<AdminRow[] | null>(null);
  useEffect(
    () =>
      void call<AdminRow[]>('GET', `/platform/hospitals/${id}/admins`).then(setAdmins, () => {}),
    [id],
  );
  if (!admins?.length) return null;
  return (
    <div className="flex flex-col gap-1.5" data-testid="hospital-admins">
      <span className="text-[13px] font-semibold text-muted">{t('platform.admins')}</span>
      {admins.map((a) => (
        <div key={a.id} className="flex flex-wrap items-center gap-2 text-[14px]">
          <span className="font-semibold">{a.display_name ?? a.email}</span>
          <span className="text-muted">{a.email}</span>
          {!a.signed_up && <Badge tone="warn">{t('platform.notSignedUp')}</Badge>}
          <span className="flex-1" />
          {a.signed_up && (
            <ResetSignIn
              url={`/platform/staff/${a.id}/reset-sign-in`}
              name={a.display_name ?? a.email}
              email={a.email}
              testId="admin-reset"
            />
          )}
        </div>
      ))}
    </div>
  );
}

function Onboard({ onDone }: { onDone: (name?: string, email?: string) => void }) {
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
      onDone(f.name, f.email);
    } catch (e) {
      setError(e);
      // The hospital was added; only the admin's invite e-mail failed ("Resend invite" later).
      if (e instanceof ApiError && e.code === 'email_not_sent') onDone();
    } finally {
      setBusy(false);
    }
  };
  const sel = 'h-11 rounded-2xl border border-edge bg-card px-2 text-[14px]';
  return (
    <div className="flex flex-col gap-4" data-testid="onboard">
      {/* v30 (canvas v28): the steps; the last three are done by the hospital's admin. */}
      <div className="flex flex-wrap gap-2" aria-hidden>
        {(['hospital', 'admin', 'connector', 'storage', 'messages'] as const).map((k, i) => (
          <span
            key={k}
            className={`flex min-w-[120px] flex-1 items-center gap-2 rounded-2xl px-3 py-2 text-[12px] font-bold ${i < 2 ? 'nc-gradient text-white' : 'bg-soft text-muted'}`}
          >
            <span
              className={`inline-flex size-[20px] items-center justify-center rounded-full text-[11px] ${i < 2 ? 'bg-white text-brand' : 'shadow-[inset_0_0_0_1.5px_currentColor]'}`}
            >
              {i + 1}
            </span>
            {t(`platform.step.${k}`)}
          </span>
        ))}
      </div>
      <span className="text-[13px] text-muted">{t('platform.stepNote')}</span>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field
          id="h-name"
          label={t('platform.name')}
          value={f.name}
          onChange={(e) => setF({ ...f, name: e.target.value })}
          data-testid="h-name"
        />
        <label className="flex flex-col gap-1 text-[13px] font-semibold text-sub">
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
    </div>
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

interface PlatformSettings {
  storage_offered: string[];
  azure_app_registered: boolean;
  azure_app_client_id: string | null;
  dev_storage: boolean;
}

/** Decision 044: NeuroCapture stores no videos; which storage kinds hospitals can connect. */
export function PlatformSettingsPage() {
  const { t } = useTranslation();
  const [s, setS] = useState<PlatformSettings | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(
    () => void call<PlatformSettings>('GET', '/platform/settings').then(setS, setError),
    [],
  );
  const kinds: [string, boolean, string][] = s
    ? [
        ['s3', s.storage_offered.includes('s3'), t('platform.kindS3')],
        ['azure', s.azure_app_registered, t('platform.kindAzure')],
      ]
    : [];
  const pp = platformPolicy;
  const fixed = (v: string) => (
    <span className="rounded-xl bg-soft px-3 py-1.5 text-[13px] font-semibold">{v}</span>
  );
  return (
    <Page title={t('nav.platformSettings')} sub={t('platform.settingsSub')}>
      {error instanceof ApiError && error.status === 404 ? (
        <Notice tone="warn" testId="server-outdated">
          {t('platform.serverOutdated')}
        </Notice>
      ) : (
        <ErrorNote error={error} />
      )}
      <SettingsLayout
        sections={[
          { id: 'ps-recording', label: t('platform.set.recording') },
          { id: 'ps-security', label: t('platform.set.security') },
          { id: 'ps-storage', label: t('platform.storageTitle') },
        ]}
      >
        <Card title={t('platform.set.recording')} id="ps-recording">
          <SettingRow
            title={t('platform.set.passLevel')}
            hint={t('platform.set.passLevelHint', { warn: pp.warnBelowFps })}
          >
            {fixed(`${Math.min(...pp.fpsOptions)}–${Math.max(...pp.fpsOptions)} fps`)}
          </SettingRow>
          <SettingRow title={t('platform.set.speed')} hint={t('platform.set.speedHint')}>
            {fixed('60 fps')}
          </SettingRow>
          <SettingRow title={t('platform.set.consent')} hint={t('platform.set.consentHint')}>
            {fixed(pp.consentVersion)}
          </SettingRow>
        </Card>
        <Card title={t('platform.set.security')} id="ps-security">
          <SettingRow title={t('platform.set.twoStep')} hint={t('platform.set.twoStepHint')}>
            <Badge tone={pp.twoStepRequired ? 'ok' : 'warn'}>
              {pp.twoStepRequired ? t('platform.set.required') : t('platform.set.optional')}
            </Badge>
          </SettingRow>
          <SettingRow title={t('platform.set.invites')} hint={t('platform.set.invitesHint')}>
            {fixed(
              t('platform.set.days', { staff: pp.staffInviteDays, patients: pp.patientInviteDays }),
            )}
          </SettingRow>
          <SettingRow title={t('platform.set.pin')} hint={t('platform.set.pinHint')}>
            {fixed(t('platform.set.tries', { count: pp.pinTries }))}
          </SettingRow>
          <SettingRow title={t('platform.set.phoneCode')} hint={t('platform.set.phoneCodeHint')}>
            {fixed(t('platform.set.hours', { count: pp.deviceCodeHours }))}
          </SettingRow>
          <span className="text-[12px] text-muted">{t('platform.set.where')}</span>
        </Card>
        <Card title={t('platform.storageTitle')} testId="platform-storage" id="ps-storage">
          <p className="text-[14px] leading-5 text-sub">{t('platform.storageIntro')}</p>
          <ul className="m-0 flex list-none flex-col p-0">
            {kinds.map(([k, ok, label]) => (
              <li
                key={k}
                className="flex items-center gap-3 border-t border-line py-2.5 text-[14px]"
                data-testid={`kind-${k}`}
              >
                <span className="flex-1">{label}</span>
                <Badge tone={ok ? 'ok' : 'warn'}>
                  {ok ? t('platform.available') : t('platform.azureMissing')}
                </Badge>
              </li>
            ))}
          </ul>
          {s && !s.azure_app_registered && (
            <p className="rounded-xl bg-ground px-3 py-2.5 text-[13px] leading-[19px]">
              {t('platform.azureHowTo')}
            </p>
          )}
          {s?.azure_app_client_id && (
            <p className="text-[13px] text-muted">
              {t('platform.azureAppId')}: <code className="text-ink">{s.azure_app_client_id}</code>
            </p>
          )}
          {s?.dev_storage && (
            <p
              className="rounded-xl bg-warn-soft px-3 py-2.5 text-[13px] text-warn"
              data-testid="dev-storage-on"
            >
              {t('platform.devStorageOn')}
            </p>
          )}
        </Card>
      </SettingsLayout>
    </Page>
  );
}
