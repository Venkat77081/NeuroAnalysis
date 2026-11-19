/**
 * v10 Overview (decision 042): stat cards, one timeline chart and a short list for every role.
 * Counts come from the platform (no names). Desk and doctor lists show patient names, fetched by
 * this browser from the hospital connector, as on every other page.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { call, hospital } from './api.ts';
import { Badge, Button, Card, ErrorNote, Hero, Page, Segmented, Table, fmt } from './ui.tsx';
import { describe, toneOf, type LogRow } from './activity.tsx';
import { fromAudit, type AuditRow } from './platform.tsx';

type Period = '4w' | '12w' | '1y';
const PERIODS: Period[] = ['4w', '12w', '1y'];
const PERIOD_KEY = 'nc.overview.period';

interface Tile {
  key: string;
  value: number | null;
  detail: Record<string, number | string | null>;
  tone: 'ok' | 'warn' | 'bad' | 'todo' | null;
  link: string | null;
}
interface Point {
  start: string;
  count: number;
}
export interface Item {
  key: string;
  status: string;
  id: string | null;
  name: string | null;
  ncid: string | null;
  at: string | null;
  doctor: string | null;
  place: string | null;
  flagged: boolean | null;
}
export interface OverviewData {
  role: 'platform_admin' | 'hospital_admin' | 'receptionist' | 'doctor';
  tiles: Tile[];
  unit: 'week' | 'day';
  chart: string;
  series: Point[];
  items: Item[];
}

function savedPeriod(): Period {
  try {
    const v = globalThis.localStorage?.getItem(PERIOD_KEY);
    return PERIODS.includes(v as Period) ? (v as Period) : '12w';
  } catch {
    return '12w';
  }
}

export function zone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

const day = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

/** Badges always carry words; tone only adds colour. */
export const TONE: Record<string, 'ok' | 'warn' | 'bad' | 'neutral'> = {
  ok: 'ok',
  pass: 'ok',
  active: 'ok',
  working: 'ok',
  recorded: 'ok',
  homeLink: 'ok',
  warn: 'warn',
  todo: 'warn',
  needDoctor: 'warn',
  waitingTests: 'warn',
  notJoined: 'warn',
  missing: 'warn',
  unknown: 'neutral',
  off: 'neutral',
  new: 'neutral',
  clinicQueue: 'neutral',
  admin_not_signed_up: 'warn',
  connector_not_tested: 'warn',
  storage_not_tested: 'warn',
  connector_failing: 'bad',
  storage_failing: 'bad',
  fail: 'bad',
  failing: 'bad',
  suspended: 'neutral',
};

/** v28: "312 patients in the app" in the greeting (value, then the tile's title in lower case). */
export function heroChip(title: string, tile: Pick<Tile, 'key' | 'value'>): string {
  const v = tile.key === 'onTime' ? `${tile.value}%` : (tile.value ?? 0).toLocaleString('en-IN');
  return `${v} ${title.charAt(0).toLowerCase()}${title.slice(1)}`;
}

/** v28: the next appointment still to come (for the greeting's "Next" card). */
export function nextAppointment(items: Item[], now = Date.now()): Item | null {
  return (
    items
      .filter((i) => i.key === 'appointment' && i.at && Date.parse(i.at) >= now)
      .sort((a, b) => Date.parse(a.at!) - Date.parse(b.at!))[0] ?? null
  );
}

function StatTile({ tile, onOpen }: { tile: Tile; onOpen: (page: string) => void }) {
  const { t } = useTranslation();
  const k = `overview.tiles.${tile.key}`;
  const body = (
    <>
      <span className="text-[13px] font-semibold text-muted">{t(`${k}.title`, tile.detail)}</span>
      <span
        className="text-[38px] leading-[42px] font-extrabold tracking-[-0.5px]"
        data-testid={`tile-${tile.key}-value`}
      >
        {tile.value === null
          ? '–'
          : tile.key === 'onTime'
            ? `${tile.value}%`
            : tile.value.toLocaleString('en-IN')}
      </span>
      <span className="text-[13px] leading-5 text-muted">{t(`${k}.detail`, tile.detail)}</span>
      {tile.tone === 'todo' && <Badge tone="warn">{t('overview.todo')}</Badge>}
      {tile.tone === 'warn' && <Badge tone="warn">{t('overview.check')}</Badge>}
    </>
  );
  const cls =
    'nc-fu flex min-h-[132px] flex-col items-start gap-1 rounded-3xl bg-card p-[18px] text-left shadow-card';
  return tile.link ? (
    <button
      type="button"
      className={`${cls} transition-shadow hover:shadow-[0_0_0_2px_var(--color-brand)] focus-visible:outline-2 focus-visible:outline-brand`}
      onClick={() => onOpen(tile.link!)}
      data-testid={`tile-${tile.key}`}
    >
      {body}
    </button>
  ) : (
    <div className={cls} data-testid={`tile-${tile.key}`}>
      {body}
    </div>
  );
}

/** One series of bars (one hue, no legend: the title names it), hover tooltip, table view. */
export function BarChart({
  series,
  unit,
  label,
}: {
  series: Point[];
  unit: 'week' | 'day';
  label: string;
}) {
  const { t } = useTranslation();
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  const H = 220;
  const pad = { l: 36, r: 8, t: 12, b: 26 };
  const max = Math.max(1, ...series.map((p) => p.count));
  const step = max <= 5 ? 1 : Math.ceil(max / 4 / 5) * 5;
  const top = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: top / step + 1 }, (_, i) => i * step);
  const n = Math.max(1, series.length);
  const slot = (W - pad.l - pad.r) / n;
  const bw = Math.max(2, Math.min(36, slot - 2));
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / top);
  const every = Math.ceil(n / 8);
  const tip = (p: Point) =>
    t(unit === 'week' ? 'overview.tipWeek' : 'overview.tipDay', {
      date: day(p.start),
      count: p.count,
    });
  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={label}
        data-testid="overview-chart"
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((v) => (
          <g key={v}>
            <line
              x1={pad.l}
              x2={W - pad.r}
              y1={y(v)}
              y2={y(v)}
              stroke="var(--color-line)"
              strokeWidth={1}
            />
            <text
              x={pad.l - 6}
              y={y(v) + 4}
              textAnchor="end"
              fontSize={11}
              fill="var(--color-muted)"
            >
              {v}
            </text>
          </g>
        ))}
        {series.map((p, i) => {
          const x = pad.l + i * slot + (slot - bw) / 2;
          const h = Math.max(0, y(0) - y(p.count));
          const r = Math.min(4, bw / 2, h);
          return (
            <g key={p.start}>
              {p.count > 0 && (
                <path
                  d={`M${x},${y(0)} V${y(p.count) + r} q0,-${r} ${r},-${r} H${x + bw - r} q${r},0 ${r},${r} V${y(0)} Z`}
                  fill={hover === i ? 'var(--color-brand-2)' : 'var(--color-brand)'}
                />
              )}
              {/* Hit target: the whole column, bigger than the bar. */}
              <rect
                x={pad.l + i * slot}
                y={pad.t}
                width={slot}
                height={H - pad.t - pad.b}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                tabIndex={0}
                aria-label={tip(p)}
                data-testid="chart-bar"
              />
              {i % every === 0 && (
                <text
                  x={x + bw / 2}
                  y={H - 8}
                  textAnchor="middle"
                  fontSize={11}
                  fill="var(--color-muted)"
                >
                  {day(p.start)}
                </text>
              )}
            </g>
          );
        })}
        <line
          x1={pad.l}
          x2={W - pad.r}
          y1={y(0)}
          y2={y(0)}
          stroke="var(--color-edge)"
          strokeWidth={1}
        />
      </svg>
      {hover !== null && series[hover] && (
        <div
          className="pointer-events-none absolute top-1 rounded-lg bg-ink px-2.5 py-1.5 text-[12px] text-ground shadow"
          style={{ left: `${Math.min(80, ((pad.l + (hover + 0.5) * slot) / W) * 100)}%` }}
          data-testid="chart-tooltip"
        >
          {tip(series[hover])}
        </div>
      )}
    </div>
  );
}

function ChartCard({
  data,
  period,
  setPeriod,
}: {
  data: OverviewData;
  period: Period;
  setPeriod: (p: Period) => void;
}) {
  const { t } = useTranslation();
  const [table, setTable] = useState(false);
  const title = t(`overview.chart.${data.chart}`);
  return (
    <Card className="min-w-0 flex-[2_1_480px]" testId="overview-chart-card">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex-1 text-[17px] font-bold">{title}</h2>
        {data.unit === 'week' && (
          <Segmented
            options={PERIODS.map((p) => ({ value: p, label: t(`overview.periods.${p}`) }))}
            value={period}
            onChange={setPeriod}
            label={t('overview.periodLabel')}
            testId={(p) => `overview-period-${p}`}
          />
        )}
        <Button
          variant="ghost"
          aria-pressed={table}
          onClick={() => setTable(!table)}
          className="min-h-9 px-3 text-[13px]"
          data-testid="overview-table-toggle"
        >
          {table ? t('overview.showChart') : t('overview.showTable')}
        </Button>
      </div>
      {table ? (
        <Table
          head={[t(data.unit === 'week' ? 'overview.weekOf' : 'overview.day'), t('overview.count')]}
          testId="overview-table"
        >
          {data.series.map((p) => (
            <tr key={p.start} className="border-t border-line">
              <td className="px-4 py-2">{day(p.start)}</td>
              <td className="px-4 py-2 tabular-nums">{p.count}</td>
            </tr>
          ))}
        </Table>
      ) : (
        <BarChart series={data.series} unit={data.unit} label={title} />
      )}
    </Card>
  );
}

/** v29: the words for a list item and what to open (also used by the bell). */
export function describeItem(
  t: TFunction,
  item: Item,
  names: Record<string, string>,
): { text: string; action: { label: string; page?: string; ncid?: string } | null } {
  const who = item.ncid ? (names[item.ncid] ?? t('overview.patient')) : '';
  if (item.key === 'hospital')
    return {
      text: item.name ?? '',
      action:
        item.status !== 'ok' && item.status !== 'suspended'
          ? { label: t('overview.open'), page: 'hospitals' }
          : null,
    };
  if (item.key === 'appointment')
    return {
      text: `${fmt(item.at)} · ${who} · ${item.doctor ?? t('overview.noDoctor')}`,
      action:
        item.status === 'needDoctor'
          ? { label: t('overview.chooseDoctor'), page: 'appointments' }
          : null,
    };
  if (item.key === 'recording')
    return {
      text: `${who} · ${fmt(item.at)} · ${t(`overview.place.${item.place}`)}${item.flagged ? ` · ${t('overview.flagged')}` : ''}`,
      action: item.ncid ? { label: t('overview.review'), ncid: item.ncid } : null,
    };
  return {
    text: t(`overview.health.${item.key}`, {
      at: item.at ? fmt(item.at) : '',
      place: item.place ? t(`overview.storage.${item.place}`, { defaultValue: item.place }) : '',
    }),
    action: ['missing', 'unknown', 'fail', 'failing', 'off'].includes(item.status)
      ? { label: t('overview.setUp'), page: 'connections' }
      : null,
  };
}

function ItemRow({
  item,
  names,
  onOpen,
  onPatient,
}: {
  item: Item;
  names: Record<string, string>;
  onOpen: (page: string) => void;
  onPatient: (ncid: string) => void;
}) {
  const { t } = useTranslation();
  const { text, action: a } = describeItem(t, item, names);
  const action = a
    ? {
        label: a.label,
        go: () => (a.ncid ? onPatient(a.ncid) : a.page ? onOpen(a.page) : undefined),
      }
    : null;
  return (
    <li
      className="flex min-h-11 items-center gap-2 border-t border-line py-2 text-[14px]"
      data-testid={`overview-item-${item.key}`}
    >
      <span className="min-w-0 flex-1">{text}</span>
      <Badge tone={TONE[item.status] ?? 'neutral'}>{t(`overview.status.${item.status}`)}</Badge>
      {action && (
        <Button variant="ghost" className="min-h-9 px-2 text-[13px]" onClick={action.go}>
          {action.label}
        </Button>
      )}
    </li>
  );
}

function ItemsCard({
  data,
  names,
  onOpen,
  onPatient,
  title,
  className = 'min-w-0 flex-[1_1_320px]',
}: {
  data: OverviewData;
  names: Record<string, string>;
  onOpen: (page: string) => void;
  onPatient: (ncid: string) => void;
  title: string;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <Card title={title} className={className} testId="overview-list">
      {data.items.length === 0 ? (
        <p className="text-[14px] text-muted">{t('overview.empty')}</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {data.items.map((i, n) => (
            <ItemRow
              key={`${i.key}-${i.id ?? n}`}
              item={i}
              names={names}
              onOpen={onOpen}
              onPatient={onPatient}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

/** v30 (canvas v28): the last few things that happened (staff and set-up, never patient names). */
function Feed({ url, title }: { url: string; title: string }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<LogRow[] | null>(null);
  useEffect(() => {
    call<AuditRow[]>('GET', url).then(
      (l) => setRows(l.map(fromAudit)),
      () => setRows([]),
    );
  }, [url]);
  return (
    <Card title={title} testId="overview-feed">
      {rows && rows.length === 0 && <p className="text-[14px] text-muted">{t('overview.empty')}</p>}
      {(rows ?? []).map((r, i) => (
        <div key={i} className="flex gap-3 border-t border-line py-2.5">
          <span
            aria-hidden
            className="mt-1.5 size-2.5 shrink-0 rounded-full"
            style={{ background: FEED_DOT[toneOf(r.action)] }}
          />
          <span className="text-[13px] leading-[19px]">
            <b>{r.hospital && !r.who.email ? r.hospital : r.who.name}</b> ·{' '}
            {describe(t, r.action, r.details)}
            <span className="block text-[12px] text-muted">{fmt(r.at)}</span>
          </span>
        </div>
      ))}
    </Card>
  );
}
const FEED_DOT: Record<string, string> = {
  ok: 'var(--color-ok)',
  warn: 'var(--color-warn)',
  bad: 'var(--color-alert)',
  info: 'var(--color-brand)',
};

/** v30 (canvas v28): platform and hospital-admin overviews. */
function RoleLayout({
  data,
  period,
  setPeriod,
  names,
  onOpen,
  onPatient,
  listTitle,
}: {
  data: OverviewData;
  period: Period;
  setPeriod: (p: Period) => void;
  names: Record<string, string>;
  onOpen: (page: string) => void;
  onPatient: (ncid: string) => void;
  listTitle: string;
}) {
  const { t } = useTranslation();
  const tiles = (
    <div
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:[grid-template-columns:repeat(auto-fit,minmax(170px,1fr))]"
      data-testid="overview-tiles"
    >
      {data.tiles.map((tile) => (
        <StatTile key={tile.key} tile={tile} onOpen={onOpen} />
      ))}
    </div>
  );
  if (data.role === 'platform_admin')
    return (
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <ChartCard data={data} period={period} setPeriod={setPeriod} />
          {tiles}
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <ItemsCard
            data={data}
            names={names}
            onOpen={onOpen}
            onPatient={onPatient}
            title={t('overview.needsYou')}
            className="min-w-0"
          />
          <Feed url="/platform/audit?limit=5" title={t('overview.happening')} />
        </div>
      </div>
    );
  const ok = data.items.filter((i) => TONE[i.status] === 'ok').length;
  const pct = data.items.length ? Math.round((100 * ok) / data.items.length) : 0;
  return (
    <>
      {tiles}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card
            title={listTitle}
            testId="overview-list"
            action={
              <Badge tone={pct === 100 ? 'ok' : 'warn'}>
                {t('overview.setupDone', { ok, total: data.items.length })}
              </Badge>
            }
          >
            <div className="flex items-center gap-4">
              <span
                className="relative inline-flex size-[96px] shrink-0 items-center justify-center rounded-full"
                style={{
                  background: `conic-gradient(var(--color-brand) 0 ${pct}%, var(--color-line) 0)`,
                }}
                role="img"
                aria-label={`${pct}%`}
              >
                <span className="flex size-[80px] items-center justify-center rounded-full bg-card text-[16px] font-extrabold">
                  {pct}%
                </span>
              </span>
              <ul className="m-0 min-w-0 flex-1 list-none p-0">
                {data.items.map((i, n) => (
                  <ItemRow
                    key={`${i.key}-${i.id ?? n}`}
                    item={i}
                    names={names}
                    onOpen={onOpen}
                    onPatient={onPatient}
                  />
                ))}
              </ul>
            </div>
          </Card>
        </div>
        <Feed url="/hospital/audit?limit=6" title={t('overview.todayAtHospital')} />
      </div>
    </>
  );
}

export function OverviewPage({
  title,
  name,
  onOpen,
  onPatient,
  children,
}: {
  title: string;
  /** v28: the signed-in person's name for the greeting. */
  name?: string | null;
  onOpen: (page: string) => void;
  onPatient: (ncid: string) => void;
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [period, setPeriodState] = useState<Period>(savedPeriod);
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const setPeriod = (p: Period) => {
    setPeriodState(p);
    try {
      globalThis.localStorage?.setItem(PERIOD_KEY, p);
    } catch {
      /* the choice is not remembered */
    }
  };
  useEffect(() => {
    let off = false;
    call<OverviewData>('GET', `/overview?period=${period}&tz=${encodeURIComponent(zone())}`).then(
      (d) => {
        if (off) return;
        setData(d);
        const ncids = [...new Set(d.items.flatMap((i) => (i.ncid ? [i.ncid] : [])))];
        if (ncids.length)
          hospital<{ ncid: string; name: string | null }[]>('POST', '/v1/patients/lookup', {
            ncids,
          }).then(
            (l) =>
              !off &&
              setNames(Object.fromEntries(l.flatMap((x) => (x.name ? [[x.ncid, x.name]] : [])))),
            () => undefined, // names stay "Patient" if the connector is not answering
          );
      },
      (e: unknown) => !off && setError(e),
    );
    return () => {
      off = true;
    };
  }, [period]);
  const listTitle = useMemo(() => (data ? t(`overview.list.${data.role}`) : ''), [data, t]);
  const next = data ? nextAppointment(data.items) : null;
  const hero = (
    <Hero
      name={name ?? null}
      line={data ? t(`hero.line.${data.role}`) : t('app.loading')}
      chips={(data?.tiles ?? [])
        .slice(0, 3)
        .flatMap((tile) =>
          tile.value === null
            ? []
            : [heroChip(t(`overview.tiles.${tile.key}.title`, tile.detail), tile)],
        )}
      right={
        next ? (
          <span className="flex flex-col gap-1" data-testid="hero-next">
            <span className="text-[12px] font-bold text-sub uppercase">
              {t('hero.next', { time: fmt(next.at) })}
            </span>
            <b className="text-[16px]">
              {next.ncid ? (names[next.ncid] ?? next.ncid) : t('overview.patient')}
            </b>
            <span className="text-sub">{next.doctor ?? t('overview.noDoctor')}</span>
          </span>
        ) : undefined
      }
    />
  );
  return (
    <Page title={title} hero={hero}>
      {data?.role === 'platform_admin' && (
        <p className="-mt-3 text-[13px] text-muted" data-testid="counts-only">
          {t('overview.countsOnly')}
        </p>
      )}
      <ErrorNote error={error} />
      {!data && !error && <p className="text-muted">{t('app.loading')}</p>}
      {data && (data.role === 'platform_admin' || data.role === 'hospital_admin') && (
        <RoleLayout
          data={data}
          period={period}
          setPeriod={setPeriod}
          names={names}
          onOpen={onOpen}
          onPatient={onPatient}
          listTitle={listTitle}
        />
      )}
      {data && data.role !== 'platform_admin' && data.role !== 'hospital_admin' && (
        <>
          <div
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5"
            data-testid="overview-tiles"
          >
            {data.tiles.map((tile) => (
              <StatTile key={tile.key} tile={tile} onOpen={onOpen} />
            ))}
          </div>
          <div className="flex flex-wrap gap-4">
            <ChartCard data={data} period={period} setPeriod={setPeriod} />
            <ItemsCard
              data={data}
              names={names}
              onOpen={onOpen}
              onPatient={onPatient}
              title={listTitle}
            />
          </div>
        </>
      )}
      {children}
    </Page>
  );
}
