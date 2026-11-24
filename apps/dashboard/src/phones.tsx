/**
 * Decision 062: phones with their last phone check (camera, video size, memory, storage), for the
 * platform admin (every hospital; patients by NCID only) and the hospital admin (MRN read live
 * from the hospital's records through the connector; NeuroCapture keeps only the NCID).
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { call, hospital } from './api.ts';
import { deviceCheck, phoneLimits } from './config.ts';
import { Badge, ErrorNote, Page, fmtDate } from './ui.tsx';

export type PhoneStatus =
  | 'ready'
  | 'camera_slow'
  | 'camera_too_slow'
  | 'memory_low'
  | 'memory_too_small'
  | 'storage_low'
  | 'cannot_record'
  | 'unchecked';

export interface PhoneInfo {
  brand: string | null;
  video_width: number | null;
  video_height: number | null;
  video_bytes_per_s: number | null;
  ram_total_gb: number | null;
  ram_free_bytes: number | null;
  ram_low: boolean | null;
  storage_free_bytes: number | null;
  storage_total_bytes: number | null;
  /** v36: the hand-sign try-out on a patient's phone. */
  start_sign?: 'works' | 'too_slow' | 'not_seen' | 'skipped' | null;
  tracking_hz?: number | null;
  reported_at: string | null;
  status: PhoneStatus;
}

/** One row: who, where, the phone and its numbers. */
export interface PhoneRow {
  id: string;
  kind: 'clinic' | 'patient';
  who: string;
  /** Monospace for NCIDs. */
  code: boolean;
  hospital?: string;
  model: string;
  os_version: string;
  check_fps: number | null;
  checked_at: string | null;
  phone: PhoneInfo | null;
}

type Tone = 'ok' | 'warn' | 'bad' | 'neutral';
const TEXT: Record<Tone, string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  bad: 'text-bad',
  neutral: 'text-muted',
};

export const STATUS_TONE: Record<PhoneStatus, Tone> = {
  ready: 'ok',
  camera_slow: 'warn',
  camera_too_slow: 'bad',
  memory_low: 'warn',
  memory_too_small: 'bad',
  storage_low: 'warn',
  cannot_record: 'bad',
  unchecked: 'neutral',
};

const gb = (b: number | null | undefined) => (b == null ? '—' : `${(b / 1e9).toFixed(1)} GB`);

function fpsTone(fps: number | null): Tone {
  if (fps === null) return 'neutral';
  return fps < deviceCheck.minFps ? 'bad' : fps < deviceCheck.warnBelowFps ? 'warn' : 'ok';
}
function memTone(totalGb: number | null): Tone {
  if (totalGb === null) return 'neutral';
  const m = phoneLimits.memory;
  return totalGb < m.minTotalGb ? 'bad' : totalGb < m.warnTotalBelowGb ? 'warn' : 'ok';
}
function storeTone(free: number | null): Tone {
  if (free === null) return 'neutral';
  return free < phoneLimits.storageStartGb * 1e9
    ? 'bad'
    : free < phoneLimits.storageWarnGb * 1e9
      ? 'warn'
      : 'ok';
}

/** A row of filter buttons (the old UI has no shared segmented control). */
function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  testId,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  testId?: (v: T) => string;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={`min-h-9 rounded-full border px-3.5 text-[13px] font-semibold ${o.value === value ? 'border-ink bg-ink text-white' : 'border-line bg-white text-ink'}`}
          data-testid={testId?.(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Two({ top, sub, tone = 'neutral' }: { top: string; sub?: string; tone?: Tone }) {
  return (
    <span className="flex flex-col">
      <b className={`text-[13px] whitespace-nowrap ${tone === 'neutral' ? '' : TEXT[tone]}`}>
        {top}
      </b>
      {sub && <span className="text-[12px] whitespace-nowrap text-muted">{sub}</span>}
    </span>
  );
}

function StorageBar({ free, total, tone }: { free: number; total: number; tone: Tone }) {
  const used = total > 0 ? Math.min(1, Math.max(0, 1 - free / total)) : 0;
  const bg = tone === 'bad' ? 'bg-bad' : tone === 'warn' ? 'bg-warn' : 'bg-brand';
  return (
    <span className="mt-1 block h-[5px] w-[90px] rounded-full bg-ground" aria-hidden>
      <span className={`block h-[5px] rounded-full ${bg}`} style={{ width: `${used * 100}%` }} />
    </span>
  );
}

export function PhoneStatusBadge({ status }: { status: PhoneStatus }) {
  const { t } = useTranslation();
  return (
    <span data-testid="phone-status" data-status={status}>
      <Badge tone={STATUS_TONE[status] === 'neutral' ? 'neutral' : STATUS_TONE[status]}>
        {t(`phones.status.${status}`)}
      </Badge>
    </span>
  );
}

/** The numbers for one phone as table cells (camera, memory, storage). */
function cells(r: PhoneRow, t: TFunction) {
  const p = r.phone;
  const px =
    p?.video_width && p.video_height ? `${p.video_width} × ${p.video_height}` : t('phones.noVideo');
  const sign = p?.start_sign ?? null;
  const signTone: Record<string, 'ok' | 'warn' | 'bad' | 'neutral'> = {
    works: 'ok',
    too_slow: 'warn',
    not_seen: 'bad',
    skipped: 'neutral',
  };
  return {
    sign:
      r.kind === 'clinic' ? (
        <span className="text-muted">—</span>
      ) : sign ? (
        <span className="flex flex-col items-start gap-1">
          <Badge tone={signTone[sign] ?? 'neutral'}>{t(`phones.sign.${sign}`)}</Badge>
          {p?.tracking_hz ? (
            <span className="text-[12px] text-muted">
              {t('phones.sign.hz', { hz: Math.round(p.tracking_hz) })}
            </span>
          ) : null}
        </span>
      ) : (
        <span className="text-[12px] text-muted">{t('phones.sign.untried')}</span>
      ),
    camera: (
      <Two
        top={r.check_fps === null ? '—' : `${r.check_fps.toFixed(1)} fps`}
        sub={px}
        tone={fpsTone(r.check_fps)}
      />
    ),
    memory: (
      <Two
        top={p?.ram_total_gb ? `${p.ram_total_gb} GB` : '—'}
        sub={
          p?.ram_low
            ? t('phones.memoryLowNow')
            : p?.ram_free_bytes != null
              ? t('phones.free', { v: gb(p.ram_free_bytes) })
              : undefined
        }
        tone={p?.ram_low ? 'warn' : memTone(p?.ram_total_gb ?? null)}
      />
    ),
    storage:
      p?.storage_free_bytes != null ? (
        <span className="flex flex-col">
          <Two
            top={t('phones.free', { v: gb(p.storage_free_bytes) })}
            sub={
              p.storage_total_bytes ? t('phones.of', { v: gb(p.storage_total_bytes) }) : undefined
            }
            tone={storeTone(p.storage_free_bytes)}
          />
          {p.storage_total_bytes ? (
            <StorageBar
              free={p.storage_free_bytes}
              total={p.storage_total_bytes}
              tone={storeTone(p.storage_free_bytes)}
            />
          ) : null}
        </span>
      ) : (
        <span className="text-muted">—</span>
      ),
  };
}

function Tiles({ rows }: { rows: PhoneRow[] }) {
  const { t } = useTranslation();
  const n = (s: PhoneStatus[]) => rows.filter((r) => r.phone && s.includes(r.phone.status)).length;
  const tiles: { key: string; value: number; tone?: Tone }[] = [
    { key: 'ready', value: n(['ready']), tone: 'ok' },
    { key: 'cannotRecord', value: n(['cannot_record']), tone: 'bad' },
    { key: 'storageLow', value: n(['storage_low']), tone: 'warn' },
    { key: 'memoryLow', value: n(['memory_low', 'memory_too_small']), tone: 'warn' },
    { key: 'camera', value: n(['camera_slow', 'camera_too_slow']), tone: 'warn' },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-5" data-testid="phone-tiles">
      {tiles.map((x) => (
        <div
          key={x.key}
          className="flex min-w-0 flex-col gap-0.5 rounded-xl border border-line bg-white px-4 py-3"
          data-testid={`phone-tile-${x.key}`}
        >
          <span className="text-[12px] font-semibold text-muted">{t(`phones.tiles.${x.key}`)}</span>
          <b className={`text-[26px] tabular-nums ${x.value && x.tone ? TEXT[x.tone] : ''}`}>
            {x.value}
          </b>
          <span className="text-[12px] text-muted">
            {t(`phones.tiles.${x.key}Sub`, phoneLimits)}
          </span>
        </div>
      ))}
    </div>
  );
}

const ATTENTION = new Set<PhoneStatus>([
  'camera_slow',
  'camera_too_slow',
  'memory_low',
  'memory_too_small',
  'storage_low',
  'cannot_record',
]);

/** Filters, then the table. `hospitals` adds a Hospital column (platform). */
export function PhoneTable({
  rows,
  hospitals,
  whoLabel,
}: {
  rows: PhoneRow[];
  hospitals?: boolean;
  whoLabel: string;
}) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<'all' | 'patient' | 'clinic' | 'attention'>('all');
  const shown = rows.filter((r) =>
    filter === 'all'
      ? true
      : filter === 'attention'
        ? !!r.phone && ATTENTION.has(r.phone.status)
        : r.kind === filter,
  );
  const count = (f: typeof filter) =>
    f === 'all'
      ? rows.length
      : f === 'attention'
        ? rows.filter((r) => r.phone && ATTENTION.has(r.phone.status)).length
        : rows.filter((r) => r.kind === f).length;
  const heads = [
    whoLabel,
    ...(hospitals ? [t('phones.cols.hospital')] : []),
    t('phones.cols.phone'),
    t('phones.cols.camera'),
    t('phones.cols.memory'),
    t('phones.cols.storage'),
    t('phones.cols.sign'),
    t('phones.cols.checked'),
    t('phones.cols.status'),
  ];
  return (
    <div className="flex flex-col gap-3">
      <Segmented
        label={t('phones.filter')}
        value={filter}
        onChange={setFilter}
        testId={(v) => `phones-filter-${v}`}
        options={(['all', 'patient', 'clinic', 'attention'] as const).map((v) => ({
          value: v,
          label: t(`phones.filters.${v}`, { n: count(v) }),
        }))}
      />
      <div className="overflow-x-auto rounded-xl border border-line bg-white">
        <table
          className="w-full border-collapse text-[13px] tabular-nums"
          data-testid="phones-table"
        >
          <thead>
            <tr>
              {heads.map((h) => (
                <th
                  key={h}
                  className="border-b border-line px-3 py-2.5 text-left text-[12px] font-semibold whitespace-nowrap text-muted"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={heads.length} className="px-3 py-4 text-muted">
                  {t('phones.none')}
                </td>
              </tr>
            )}
            {shown.map((r) => {
              const c = cells(r, t);
              const brand = r.phone?.brand
                ? r.phone.brand.charAt(0).toUpperCase() + r.phone.brand.slice(1)
                : '';
              return (
                <tr key={r.id} data-testid={`phone-${r.id}`} className="align-top">
                  <td className="border-b border-line px-3 py-2">
                    <span className="flex flex-col">
                      <b
                        className={`whitespace-nowrap ${r.code ? 'font-mono text-[12px]' : 'text-[13px]'}`}
                        data-testid="phone-who"
                      >
                        {r.who}
                      </b>
                      <span className="text-[12px] whitespace-nowrap text-muted">
                        {t(`phones.kind.${r.kind}`)}
                      </span>
                    </span>
                  </td>
                  {hospitals && <td className="border-b border-line px-3 py-2">{r.hospital}</td>}
                  <td className="border-b border-line px-3 py-2">
                    <Two top={`${brand} ${r.model}`.trim()} sub={`Android ${r.os_version}`} />
                  </td>
                  <td className="border-b border-line px-3 py-2">{c.camera}</td>
                  <td className="border-b border-line px-3 py-2">{c.memory}</td>
                  <td className="border-b border-line px-3 py-2">{c.storage}</td>
                  <td className="border-b border-line px-3 py-2" data-testid="phone-sign">
                    {c.sign}
                  </td>
                  <td className="border-b border-line px-3 py-2 whitespace-nowrap">
                    {fmtDate(r.phone?.reported_at ?? r.checked_at) || '—'}
                  </td>
                  <td className="border-b border-line px-3 py-2">
                    <PhoneStatusBadge status={r.phone?.status ?? 'unchecked'} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface PlatformPhone {
  id: string;
  kind: 'clinic' | 'patient';
  site_id: string;
  hospital: string;
  ncid: string | null;
  label: string | null;
  model: string;
  os_version: string;
  check_fps: number | null;
  checked_at: string | null;
  phone: PhoneInfo;
}

/** Platform admin: every phone at every hospital; patients by NCID only. */
export function PlatformPhones() {
  const { t } = useTranslation();
  const [list, setList] = useState<PlatformPhone[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [site, setSite] = useState('');
  useEffect(() => {
    call<PlatformPhone[]>('GET', '/platform/phones').then(setList, setError);
  }, []);
  const sites = useMemo(
    () => [...new Map((list ?? []).map((p) => [p.site_id, p.hospital])).entries()],
    [list],
  );
  const rows: PhoneRow[] = (list ?? [])
    .filter((p) => !site || p.site_id === site)
    .map((p) => ({
      id: p.id,
      kind: p.kind,
      who: p.kind === 'patient' ? (p.ncid ?? '—') : (p.label ?? p.model),
      code: p.kind === 'patient',
      hospital: p.hospital,
      model: p.model,
      os_version: p.os_version,
      check_fps: p.check_fps,
      checked_at: p.checked_at,
      phone: p.phone,
    }));
  return (
    <Page title={t('phones.title')}>
      <p className="text-[14px] text-muted">{t('phones.platformSub')}</p>
      <ErrorNote error={error} />
      <div className="flex flex-wrap items-center justify-end gap-2">
        <label className="flex items-center gap-2 text-[13px] font-semibold text-muted">
          {t('phones.cols.hospital')}
          <select
            className="min-h-9 rounded-lg border border-line bg-white px-3 text-[13px]"
            value={site}
            onChange={(e) => setSite(e.target.value)}
            data-testid="phones-site"
          >
            <option value="">{t('phones.allHospitals')}</option>
            {sites.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <Tiles rows={rows} />
      <PhoneTable rows={rows} hospitals whoLabel={t('phones.cols.who')} />
      <p className="text-[12px] text-muted">{t('phones.platformNote')}</p>
    </Page>
  );
}

interface HospitalPhone {
  id: string;
  kind: 'clinic' | 'patient';
  label: string | null;
  model: string;
  os_version: string;
  revoked_at: string | null;
  check_fps: number | null;
  checked_at: string | null;
  ncid: string | null;
  phone: PhoneInfo | null;
}

/** Hospital admin: patients' phones by MRN (looked up through the connector), and clinic phones. */
export function HospitalPhoneTable() {
  const { t } = useTranslation();
  const [list, setList] = useState<HospitalPhone[] | null>(null);
  const [mrns, setMrns] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    void Promise.all([
      call<HospitalPhone[]>('GET', '/hospital/devices?kind=patient'),
      call<HospitalPhone[]>('GET', '/hospital/devices?kind=clinic'),
    ]).then(([pts, clinic]) => {
      setList([...pts, ...clinic].filter((d) => !d.revoked_at));
      const ncids = [...new Set(pts.map((d) => d.ncid).filter((n): n is string => !!n))];
      if (ncids.length)
        hospital<{ ncid: string; mrn: string }[]>('POST', '/v1/patients/lookup', { ncids }).then(
          (ids) => setMrns(Object.fromEntries(ids.map((i) => [i.ncid, i.mrn]))),
          () => undefined, // connector offline: the NCID stays shown
        );
    }, setError);
  }, []);
  const rows: PhoneRow[] = (list ?? []).map((d) => {
    const mrn = d.ncid ? mrns[d.ncid] : undefined;
    return {
      id: d.id,
      kind: d.kind,
      who:
        d.kind === 'patient'
          ? mrn
            ? t('phones.mrn', { mrn })
            : (d.ncid ?? '—')
          : (d.label ?? d.model),
      code: d.kind === 'patient' && !mrn,
      model: d.model,
      os_version: d.os_version,
      check_fps: d.check_fps,
      checked_at: d.checked_at,
      phone: d.phone,
    };
  });
  return (
    <section className="flex flex-col gap-3" data-testid="hospital-phone-table">
      <ErrorNote error={error} />
      <Tiles rows={rows} />
      <PhoneTable rows={rows} whoLabel={t('phones.cols.patient')} />
      <p className="text-[12px] text-muted">{t('phones.hospitalNote')}</p>
    </section>
  );
}
