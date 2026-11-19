/**
 * v31 (canvas v28): doctors' clinic hours as a grid, and the week chips on the Team page.
 *
 * - Rows are time blocks (the hospital's default blocks from config plus any span a doctor
 *   already has); columns are the weekdays; each cell is Open or Closed.
 * - Opening a cell closes any overlapping block on the same day, so a day never has two
 *   spans that overlap.
 * - The saved data is unchanged: per weekday, a list of [from, to] spans in hospital time.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { call } from './api.ts';
import { appointmentChanges } from './config.ts';
import { Badge, Button, Card, ErrorNote, Field, Notice } from './ui.tsx';

export interface Hours {
  doctor_id: string;
  doctor_name: string;
  department: string | null;
  week: Record<string, string[][]>;
  slot_minutes: number;
  leave: { from: string; to: string }[];
  has_hours: boolean;
  bookable: boolean;
}

export const WEEK = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Day = (typeof WEEK)[number];

/** "09:00-13:00" for one span. */
export const spanKey = (s: readonly string[]) => `${s[0]}-${s[1]}`;
const fromKey = (k: string) => k.split('-') as [string, string];
const mins = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
};

/** Two spans overlap when one starts before the other ends. */
export function overlaps(a: string, b: string): boolean {
  const [a0, a1] = fromKey(a).map(mins) as [number, number];
  const [b0, b1] = fromKey(b).map(mins) as [number, number];
  return a0 < b1 && b0 < a1;
}

/** The grid's rows: the default blocks plus every span the doctor has, by start time. */
export function hourRows(
  week: Record<string, string[][]>,
  defaults: readonly (readonly string[])[] = appointmentChanges.clinicBlocks,
): string[] {
  const keys = new Set<string>(defaults.map(spanKey));
  for (const d of WEEK) for (const s of week[d] ?? []) keys.add(spanKey(s));
  return [...keys].sort((x, y) => mins(fromKey(x)[0]) - mins(fromKey(y)[0]) || x.localeCompare(y));
}

/** Which blocks are open on each day. */
export type OpenMap = Record<Day, string[]>;
export const openFrom = (week: Record<string, string[][]>): OpenMap =>
  Object.fromEntries(WEEK.map((d) => [d, (week[d] ?? []).map(spanKey)])) as OpenMap;

/** Open or close one cell; opening closes any overlapping block on that day. */
export function toggleCell(open: OpenMap, day: Day, key: string): OpenMap {
  const had = open[day].includes(key);
  const next = had
    ? open[day].filter((k) => k !== key)
    : [...open[day].filter((k) => !overlaps(k, key)), key];
  return { ...open, [day]: next };
}

/** Open or close a whole row: closed anywhere → open everywhere; open everywhere → closed. */
export function toggleRow(open: OpenMap, key: string): OpenMap {
  const allOpen = WEEK.every((d) => open[d].includes(key));
  let out = open;
  for (const d of WEEK) if (open[d].includes(key) === allOpen) out = toggleCell(out, d, key);
  return out;
}

/** Back to the saved shape: per day, spans sorted by start. */
export const weekFrom = (open: OpenMap): Record<string, string[][]> =>
  Object.fromEntries(
    WEEK.map((d) => [
      d,
      [...open[d]].sort((x, y) => mins(fromKey(x)[0]) - mins(fromKey(y)[0])).map((k) => fromKey(k)),
    ]),
  );

/** "9–1" for 09:00-13:00, "9:30–1" for 09:30-13:00 (the grid's and Team cards' short form). */
export function shortSpan(key: string): string {
  const one = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    const h12 = h! % 12 || 12;
    return m ? `${h12}:${String(m).padStart(2, '0')}` : String(h12);
  };
  const [a, b] = fromKey(key);
  return `${one(a)}–${one(b)}`;
}

/** The days a doctor sees patients (Mon first). */
export const openDays = (week: Record<string, string[][]>): boolean[] =>
  WEEK.map((d) => (week[d] ?? []).length > 0);

/** "9–1, 2–5": the blocks a doctor uses, most-used first. */
export function hoursSummary(week: Record<string, string[][]>): string {
  const n = new Map<string, number>();
  for (const d of WEEK)
    for (const s of week[d] ?? []) n.set(spanKey(s), (n.get(spanKey(s)) ?? 0) + 1);
  return [...n.entries()]
    .sort((a, b) => mins(fromKey(a[0])[0]) - mins(fromKey(b[0])[0]))
    .map(([k]) => shortSpan(k))
    .join(', ');
}

/** The leave that covers `day` (YYYY-MM-DD), if any. */
export const leaveOn = (leave: Hours['leave'], day: string) =>
  leave.find((l) => l.from && l.to && l.from <= day && day <= l.to) ?? null;

// --- Settings: one doctor at a time ---

export function ClinicHours() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Hours[] | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const reload = useCallback(() => {
    call<Hours[]>('GET', '/hospital/doctor-hours').then(setRows, setError);
  }, []);
  useEffect(reload, [reload]);
  const doc = (rows ?? []).find((r) => r.doctor_id === pick) ?? rows?.[0] ?? null;
  return (
    <Card
      title={t('hours.title')}
      testId="clinic-hours"
      action={
        rows && rows.length > 0 ? (
          <select
            value={doc?.doctor_id ?? ''}
            onChange={(e) => setPick(e.target.value)}
            aria-label={t('hours.doctor')}
            className="h-10 rounded-xl bg-soft px-3 text-[13px] font-semibold"
            data-testid="hours-doctor"
          >
            {rows.map((r) => (
              <option key={r.doctor_id} value={r.doctor_id}>
                {r.doctor_name}
                {r.has_hours ? '' : ` · ${t('hours.notSet')}`}
              </option>
            ))}
          </select>
        ) : undefined
      }
    >
      <ErrorNote error={error} />
      {rows?.length === 0 && <span className="text-muted">{t('hours.noDoctors')}</span>}
      {doc && <DoctorHours key={doc.doctor_id} row={doc} onSaved={reload} />}
    </Card>
  );
}

function DoctorHours({ row, onSaved }: { row: Hours; onSaved: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<OpenMap>(() => openFrom(row.week));
  const [blocks, setBlocks] = useState<string[]>(() => hourRows(row.week));
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [dept, setDept] = useState(row.department ?? '');
  const [slot, setSlot] = useState(row.slot_minutes);
  const [leave, setLeave] = useState(row.leave);
  const [bookable, setBookable] = useState(row.bookable);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const newKey = from && to ? `${from}-${to}` : '';
  const canAdd = !!newKey && from < to && !blocks.includes(newKey);
  const id = row.doctor_name.replace(/\W+/g, '-');
  const change = (fn: () => void) => {
    setDone(false);
    fn();
  };
  const save = async () => {
    setError(null);
    setDone(false);
    try {
      await call('PUT', `/hospital/doctor-hours/${row.doctor_id}`, {
        department: dept || null,
        slot_minutes: slot,
        week: weekFrom(open),
        leave: leave.filter((l) => l.from && l.to),
        bookable,
      });
      setDone(true);
      onSaved();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <div className="flex flex-col gap-4" data-testid={`hours-${row.doctor_name}`}>
      <div className="flex flex-wrap items-end gap-3">
        <b className="min-w-[140px] text-[15px]">
          {row.doctor_name} {!row.has_hours && <Badge tone="warn">{t('hours.notSet')}</Badge>}
        </b>
        <Field
          id={`dept-${id}`}
          label={t('hours.department')}
          value={dept}
          onChange={(e) => change(() => setDept(e.target.value))}
          data-testid="hours-dept"
        />
        <label className="flex flex-col gap-1 text-[13px] font-semibold text-sub">
          {t('hours.slot')}
          <select
            value={slot}
            onChange={(e) => change(() => setSlot(Number(e.target.value)))}
            className="h-11 rounded-2xl border border-edge bg-card px-2 font-normal"
            data-testid="hours-slot"
          >
            {appointmentChanges.slotMinuteOptions.map((m) => (
              <option key={m} value={m}>
                {t('hours.minutes', { count: m })}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-h-11 items-center gap-2 text-[14px]">
          <input
            type="checkbox"
            checked={bookable}
            onChange={(e) => change(() => setBookable(e.target.checked))}
            className="h-4 w-4"
            data-testid="hours-bookable"
          />
          {t('hours.bookable')}
        </label>
      </div>
      <div className="overflow-x-auto">
        <div
          role="grid"
          aria-label={t('hours.gridLabel', { name: row.doctor_name })}
          className="grid min-w-[560px] items-center gap-1.5"
          style={{ gridTemplateColumns: '84px repeat(7, minmax(0, 1fr))' }}
          data-testid="hours-grid"
        >
          <span />
          {WEEK.map((d) => (
            <b key={d} className="text-center text-[12px] text-muted">
              {t(`hours.short.${d}`)}
            </b>
          ))}
          {blocks.map((k) => (
            <Row
              key={k}
              k={k}
              open={open}
              onRow={() => change(() => setOpen((o) => toggleRow(o, k)))}
              onCell={(d) => change(() => setOpen((o) => toggleCell(o, d, k)))}
            />
          ))}
        </div>
      </div>
      <span className="text-[12px] text-muted">{t('hours.gridHint')}</span>
      <div className="flex flex-wrap items-end gap-2">
        <Field
          id={`${id}-new-from`}
          type="time"
          label={t('hours.newFrom')}
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          data-testid="hours-new-from"
        />
        <Field
          id={`${id}-new-to`}
          type="time"
          label={t('hours.newTo')}
          value={to}
          onChange={(e) => setTo(e.target.value)}
          data-testid="hours-new-to"
        />
        <Button
          variant="secondary"
          disabled={!canAdd}
          onClick={() =>
            change(() => {
              setBlocks((b) => hourRows({ x: [...b.map(fromKey), [from, to]] }, []));
              setFrom('');
              setTo('');
            })
          }
          data-testid="hours-add-row"
        >
          ＋ {t('hours.addRow')}
        </Button>
        {newKey && from >= to && (
          <span className="pb-3 text-[12px] text-bad">{t('hours.badSpan')}</span>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-[13px] font-semibold text-sub">{t('hours.leave')}</span>
        {leave.map((l, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2">
            <Field
              id={`${id}-from-${i}`}
              type="date"
              label={t('hours.from')}
              value={l.from}
              onChange={(e) =>
                change(() =>
                  setLeave((x) => x.map((y, j) => (j === i ? { ...y, from: e.target.value } : y))),
                )
              }
            />
            <Field
              id={`${id}-to-${i}`}
              type="date"
              label={t('hours.to')}
              value={l.to}
              onChange={(e) =>
                change(() =>
                  setLeave((x) => x.map((y, j) => (j === i ? { ...y, to: e.target.value } : y))),
                )
              }
            />
            <Button
              variant="secondary"
              onClick={() => change(() => setLeave((x) => x.filter((_, j) => j !== i)))}
            >
              {t('hours.removeLeave')}
            </Button>
          </div>
        ))}
        <Button
          variant="secondary"
          className="self-start"
          onClick={() => change(() => setLeave((x) => [...x, { from: '', to: '' }]))}
          data-testid="hours-add-leave"
        >
          {t('hours.addLeave')}
        </Button>
      </div>
      <ErrorNote error={error} />
      {done && <Notice testId="hours-saved">{t('hours.saved')}</Notice>}
      <Button className="self-start" onClick={() => void save()} data-testid="hours-save">
        {t('hours.save')}
      </Button>
    </div>
  );
}

function Row({
  k,
  open,
  onRow,
  onCell,
}: {
  k: string;
  open: OpenMap;
  onRow: () => void;
  onCell: (d: Day) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <button
        type="button"
        onClick={onRow}
        title={t('hours.rowHint')}
        className="h-10 rounded-xl text-left text-[13px] font-bold hover:bg-soft"
        data-testid={`hours-row-${k}`}
      >
        {shortSpan(k)}
      </button>
      {WEEK.map((d) => {
        const on = open[d].includes(k);
        return (
          <button
            key={d}
            type="button"
            role="gridcell"
            aria-pressed={on}
            aria-label={`${t(`hours.day.${d}`)} ${shortSpan(k)}: ${on ? t('hours.open') : t('hours.closed')}`}
            onClick={() => onCell(d)}
            className={`h-10 rounded-xl text-[12px] font-bold ${on ? 'bg-brand-soft text-brand-ink' : 'bg-soft text-muted'}`}
            data-testid={`hours-${d}-${k}`}
          >
            {on ? t('hours.open') : t('hours.closed')}
          </button>
        );
      })}
    </>
  );
}

/** Team page: Mon–Sun chips with the open days highlighted. */
export function WeekChips({ week }: { week: Record<string, string[][]> }) {
  const { t } = useTranslation();
  const on = openDays(week);
  return (
    <span className="flex gap-1" aria-label={t('hours.weekLabel')} data-testid="week-chips">
      {WEEK.map((d, i) => (
        <span
          key={d}
          title={t(`hours.day.${d}`)}
          className={`inline-flex size-[26px] items-center justify-center rounded-lg text-[11px] font-bold ${on[i] ? 'bg-brand-soft text-brand-ink' : 'bg-soft text-muted'}`}
          data-on={on[i]}
        >
          {t(`hours.letter.${d}`)}
        </span>
      ))}
    </span>
  );
}
