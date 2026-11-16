/**
 * Roles and permissions per hospital (decision 033). The platform admin ticks what each role may
 * do at one hospital; the defaults come from config/platform.json. Changes need a short reason and
 * are logged by name. Fixed rules (clinical data, patient identity, consent, logging) are shown
 * but cannot be changed. The hospital admin sees the same table read only.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { call } from './api.ts';
import { Badge, Button, Card, ErrorNote, Field, Notice, Page, fmt } from './ui.tsx';

const ROLES = ['hospital_admin', 'receptionist', 'doctor', 'operator'] as const;
const GROUPS = ['patients', 'appointments', 'requests', 'clinic', 'setup'] as const;

interface Row {
  key: string;
  group: string;
  default: string[];
  eligible: string[];
  roles: string[];
  changed: boolean;
}
export interface Permissions {
  site_id: string;
  rows: Row[];
  changed_at: string | null;
  changed_by_name: string | null;
  changed_by_email: string | null;
  reason: string | null;
}
interface Hospital {
  id: string;
  name: string;
}

export function PermissionsPage({ siteId, onBack }: { siteId: string; onBack: () => void }) {
  const { t } = useTranslation();
  const [perms, setPerms] = useState<Permissions | null>(null);
  const [name, setName] = useState('');
  const [draft, setDraft] = useState<Record<string, string[]>>({});
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    call<Permissions>('GET', `/platform/hospitals/${siteId}/permissions`).then((p) => {
      setPerms(p);
      setDraft(Object.fromEntries(p.rows.map((r) => [r.key, r.roles])));
    }, setError);
    call<Hospital[]>('GET', '/platform/hospitals').then(
      (hs) => setName(hs.find((h) => h.id === siteId)?.name ?? ''),
      () => undefined,
    );
  }, [siteId]);
  const save = async (roles: Record<string, string[]>) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const p = await call<Permissions>('PUT', `/platform/hospitals/${siteId}/permissions`, {
        roles,
        reason: reason.trim(),
      });
      setPerms(p);
      setDraft(Object.fromEntries(p.rows.map((r) => [r.key, r.roles])));
      setReason('');
      setSaved(true);
    } catch (e) {
      setError(e);
    }
    setBusy(false);
  };
  const toggle = (key: string, role: string, on: boolean) => {
    setSaved(false);
    setDraft((d) => ({
      ...d,
      [key]: on
        ? ROLES.filter((r) => r === role || d[key]!.includes(r))
        : d[key]!.filter((r) => r !== role),
    }));
  };
  const nChanged = perms?.rows.filter((r) => r.changed).length ?? 0;
  return (
    <Page title={t('perm.title', { hospital: name })}>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" onClick={onBack}>
          ← {t('nav.hospitals')}
        </Button>
        {nChanged > 0 && (
          <span data-testid="perm-changed-count">
            <Badge tone="warn">{t('perm.changedCount', { count: nChanged })}</Badge>
          </span>
        )}
      </div>
      <p className="max-w-3xl text-[14px] leading-[21px] text-[#3D4552]">{t('perm.hint')}</p>
      <ErrorNote error={error} />
      {perms && (
        <PermissionsTable rows={perms.rows} draft={draft} onToggle={toggle} testId="perm-table" />
      )}
      <Card>
        <Field
          id="perm-reason"
          label={t('perm.reason')}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          data-testid="perm-reason"
        />
        <div className="flex flex-wrap gap-3">
          <Button
            disabled={busy || reason.trim().length < 3}
            onClick={() => void save(draft)}
            data-testid="perm-save"
          >
            {t('perm.save')}
          </Button>
          <Button
            variant="secondary"
            disabled={busy || reason.trim().length < 3}
            onClick={() => void save({})}
            data-testid="perm-reset"
          >
            {t('perm.reset')}
          </Button>
        </div>
        {saved && <Notice testId="perm-saved">{t('perm.saved')}</Notice>}
        {perms && <LastChange p={perms} />}
      </Card>
    </Page>
  );
}

function LastChange({ p }: { p: Permissions }) {
  const { t } = useTranslation();
  if (!p.changed_at)
    return <span className="text-[13px] text-muted">{t('perm.neverChanged')}</span>;
  return (
    <span className="text-[13px] text-muted" data-testid="perm-last">
      {t('perm.lastChanged', {
        at: fmt(p.changed_at),
        who: [p.changed_by_name, p.changed_by_email && `(${p.changed_by_email})`]
          .filter(Boolean)
          .join(' '),
        reason: p.reason ?? '',
      })}
    </span>
  );
}

/** The table; editable when `onToggle` is given, read only otherwise. */
export function PermissionsTable({
  rows,
  draft,
  onToggle,
  testId,
}: {
  rows: Row[];
  draft?: Record<string, string[]>;
  onToggle?: (key: string, role: string, on: boolean) => void;
  testId?: string;
}) {
  const { t } = useTranslation();
  const cell = 'px-2 py-2.5 text-center';
  return (
    <div className="overflow-x-auto rounded-2xl border border-line bg-white">
      <table className="w-full min-w-[860px] border-collapse text-[14px]" data-testid={testId}>
        <thead>
          <tr className="text-left text-[13px] text-muted">
            <th className="px-4 py-3 font-semibold">{t('perm.what')}</th>
            {ROLES.map((r) => (
              <th key={r} className={`${cell} font-semibold`}>
                {t(`perm.role.${r}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {GROUPS.map((g) => (
            <GroupRows
              key={g}
              group={g}
              rows={rows.filter((r) => r.group === g)}
              draft={draft}
              onToggle={onToggle}
            />
          ))}
          <tr className="bg-[#EDF0F3]">
            <td colSpan={5} className="px-4 py-2.5 text-[12px] font-bold text-[#3D4552]">
              {t('perm.fixedTitle').toUpperCase()}
            </td>
          </tr>
          <tr className="border-t border-[#EDF0F3]" data-testid="perm-fixed">
            <td className="px-4 py-2.5">🔒 {t('perm.fixed.clinical')}</td>
            <td className={`${cell} text-muted`}>{t('perm.no')}</td>
            <td className={`${cell} text-muted`}>{t('perm.no')}</td>
            <td className={`${cell} font-semibold`}>{t('perm.assignedOnly')}</td>
            <td className={`${cell} text-muted`}>{t('perm.no')}</td>
          </tr>
          {(['identity', 'consent', 'logged'] as const).map((k) => (
            <tr key={k} className="border-t border-[#EDF0F3]">
              <td className="px-4 py-2.5">🔒 {t(`perm.fixed.${k}`)}</td>
              <td colSpan={4} className={`${cell} text-muted`}>
                {t(`perm.fixedValue.${k}`)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GroupRows({
  group,
  rows,
  draft,
  onToggle,
}: {
  group: string;
  rows: Row[];
  draft?: Record<string, string[]>;
  onToggle?: (key: string, role: string, on: boolean) => void;
}) {
  const { t } = useTranslation();
  if (rows.length === 0) return null;
  return (
    <>
      <tr className="bg-[#F6F7F9]">
        <td colSpan={5} className="px-4 py-2.5 text-[12px] font-bold text-muted">
          {t(`perm.group.${group}`).toUpperCase()}
        </td>
      </tr>
      {rows.map((r) => {
        const roles = draft?.[r.key] ?? r.roles;
        return (
          <tr
            key={r.key}
            className={`border-t border-[#EDF0F3] ${r.changed ? 'bg-[#FFFAF2]' : ''}`}
            data-testid={`perm-${r.key}`}
          >
            <td className="px-4 py-2.5">
              {t(`perm.key.${r.key}`)}
              {r.changed && (
                <>
                  {' '}
                  <Badge tone="warn">{t('perm.changed')}</Badge>
                  <span className="block text-[12px] text-muted">
                    {t('perm.default', {
                      roles:
                        r.default.map((x) => t(`perm.role.${x}`)).join(', ') || t('perm.nobody'),
                    })}
                  </span>
                </>
              )}
            </td>
            {ROLES.map((role) => (
              <td key={role} className="px-2 py-2.5 text-center">
                {r.eligible.includes(role) ? (
                  <input
                    type="checkbox"
                    aria-label={`${t(`perm.key.${r.key}`)}: ${t(`perm.role.${role}`)}`}
                    checked={roles.includes(role)}
                    disabled={!onToggle}
                    onChange={(e) => onToggle?.(r.key, role, e.target.checked)}
                    className="size-5 accent-brand"
                    data-testid={`perm-${r.key}-${role}`}
                  />
                ) : (
                  <span className="text-muted">—</span>
                )}
              </td>
            ))}
          </tr>
        );
      })}
    </>
  );
}

/** Hospital admin: who can do what here (read only; the platform admin sets it). */
export function HospitalPermissions() {
  const { t } = useTranslation();
  const [p, setP] = useState<Permissions | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    call<Permissions>('GET', '/hospital/permissions').then(setP, setError);
  }, []);
  return (
    <Card title={t('perm.readOnlyTitle')} testId="perm-readonly">
      <p className="text-[13px] text-muted">{t('perm.readOnlyHint')}</p>
      <ErrorNote error={error} />
      {p && <PermissionsTable rows={p.rows} />}
      {p && <LastChange p={p} />}
    </Card>
  );
}
