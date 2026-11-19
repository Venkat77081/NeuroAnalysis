/**
 * v31 (canvas v28): the desk's time picking, shared by the move/offer dialog, the "Free on this
 * day" card and its pop-up.
 *
 * - MonthPicker: one month, days with free times bold with a green dot (GET /hospital/free-days).
 * - TimeGrid: one doctor's day as Morning and Afternoon chips; taken times struck through, times
 *   held for another patient dashed; only free ones can be picked.
 */
import { useEffect, useMemo, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { call } from './api.ts';
import { appointmentChanges } from './config.ts';
import { addDays, fmtDay, weekday } from './changes.tsx';

export interface DoctorDay {
  doctor_id: string;
  doctor_name: string;
  department: string | null;
  has_hours: boolean;
  on_leave: boolean;
  bookable?: boolean;
  hours: string[][];
  free: string[];
  held: string[];
  booked: number;
  slot_minutes: number;
}

export type SlotState = 'free' | 'held' | 'taken';
export interface Slot {
  time: string;
  state: SlotState;
}

const mins = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
};
const hhmm = (n: number) =>
  `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;

/** Every slot in the doctor's clinic hours that day: free, held for an offer, or taken. */
export function daySlots(
  d: Pick<DoctorDay, 'hours' | 'free' | 'held' | 'slot_minutes' | 'on_leave'>,
): Slot[] {
  if (d.on_leave) return [];
  const free = new Set(d.free);
  const held = new Set(d.held);
  const step = d.slot_minutes > 0 ? d.slot_minutes : 15;
  const out = new Map<string, SlotState>();
  for (const [a, b] of d.hours) {
    for (let s = mins(a!); s + step <= mins(b!); s += step) {
      const t = hhmm(s);
      out.set(t, free.has(t) ? 'free' : held.has(t) ? 'held' : 'taken');
    }
  }
  // A free time outside the listed hours (should not happen) still shows.
  for (const t of d.free) if (!out.has(t)) out.set(t, 'free');
  return [...out.entries()]
    .sort((x, y) => mins(x[0]) - mins(y[0]))
    .map(([time, state]) => ({ time, state }));
}

/** "9:30", "2:00": the chips' short form (the Morning / Afternoon heading says which). */
export function chipTime(t: string): string {
  const [h, m] = t.split(':').map(Number);
  return `${h! % 12 || 12}:${String(m).padStart(2, '0')}`;
}

/** Morning: before `afternoonFrom` (config); Afternoon: from then on. */
export function splitDay<T extends { time: string }>(
  slots: T[],
  from: string = appointmentChanges.afternoonFrom,
): { morning: T[]; afternoon: T[] } {
  const cut = mins(from);
  return {
    morning: slots.filter((s) => mins(s.time) < cut),
    afternoon: slots.filter((s) => mins(s.time) >= cut),
  };
}

/** The 42 days shown for a month: from the Monday on or before the 1st. */
export function monthCells(month: string): string[] {
  const first = `${month.slice(0, 7)}-01`;
  const start = addDays(first, -weekday(first));
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

/** "2026-11" → "2026-12" (n = 1) or "2026-10" (n = -1). */
export function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y!, m! - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Free times per day for the shown month (one doctor, or all). */
export function useFreeDays(
  cells: string[],
  doctorId: string | null,
  appointmentId: string | null,
  enabled = true,
): Record<string, number> {
  const [free, setFree] = useState<Record<string, number>>({});
  const from = cells[0]!;
  const to = cells[cells.length - 1]!;
  useEffect(() => {
    if (!enabled) return;
    let off = false;
    const q = new URLSearchParams({ from, to });
    if (doctorId) q.set('doctor_id', doctorId);
    if (appointmentId) q.set('appointment_id', appointmentId);
    call<{ days: { date: string; free: number }[] }>('GET', `/hospital/free-days?${q}`).then(
      (r) => !off && setFree(Object.fromEntries(r.days.map((d) => [d.date, d.free]))),
      () => !off && setFree({}),
    );
    return () => {
      off = true;
    };
  }, [from, to, doctorId, appointmentId, enabled]);
  return free;
}

export function MonthPicker({
  month,
  onMonth,
  day,
  onDay,
  today,
  free,
  marked = new Set(),
  booked = null,
  testPrefix = 'move-day-',
}: {
  /** "YYYY-MM". */
  month: string;
  onMonth: (m: string) => void;
  day: string | null;
  onDay: (d: string) => void;
  today: string;
  free: Record<string, number>;
  /** Days with the patient's wishes or picked times. */
  marked?: ReadonlySet<string>;
  /** The appointment's current day. */
  booked?: string | null;
  testPrefix?: string;
}) {
  const { t } = useTranslation();
  const cells = useMemo(() => monthCells(month), [month]);
  const title = new Date(`${month}-15T12:00:00Z`).toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <b className="text-[15px]">{title}</b>
        <span className="flex gap-1">
          <button
            type="button"
            className="size-8 rounded-full text-[16px] text-sub hover:bg-soft disabled:opacity-30"
            disabled={month <= today.slice(0, 7)}
            onClick={() => onMonth(shiftMonth(month, -1))}
            aria-label={t('slots.prevMonth')}
            data-testid="month-prev"
          >
            ‹
          </button>
          <button
            type="button"
            className="size-8 rounded-full text-[16px] text-sub hover:bg-soft"
            onClick={() => onMonth(shiftMonth(month, 1))}
            aria-label={t('slots.nextMonth')}
            data-testid="month-next"
          >
            ›
          </button>
        </span>
      </div>
      <div className="grid grid-cols-7 gap-1" role="grid" aria-label={title}>
        {(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const).map((w) => (
          <span key={w} className="text-center text-[11px] font-bold text-muted">
            {t(`hours.letter.${w}`)}
          </span>
        ))}
        {cells.map((d) => {
          const inMonth = d.slice(0, 7) === month;
          const before = d < `${month}-01`;
          if (before) return <span key={d} />;
          const sel = d === day;
          const n = free[d] ?? 0;
          const cls = sel
            ? 'nc-gradient font-extrabold text-white'
            : d === booked
              ? 'bg-warn-soft text-warn shadow-[inset_0_0_0_1.5px_var(--color-warn)]'
              : marked.has(d)
                ? 'bg-brand-soft text-brand-ink'
                : d === today
                  ? 'shadow-[inset_0_0_0_1.5px_var(--color-brand)]'
                  : 'hover:bg-soft';
          return (
            <button
              key={d}
              type="button"
              disabled={d < today}
              aria-pressed={sel}
              aria-label={`${fmtDay(d)}${n ? `, ${t('slots.freeCount', { count: n })}` : ''}`}
              onClick={() => onDay(d)}
              className={`relative mx-auto flex size-10 flex-col items-center justify-center rounded-full text-[14px] disabled:opacity-35 ${n > 0 && !sel ? 'font-extrabold' : 'font-medium'} ${inMonth ? '' : 'text-muted'} ${cls}`}
              data-testid={`${testPrefix}${d}`}
              data-free={n}
            >
              {Number(d.slice(8))}
              {n > 0 && d >= today && (
                <span
                  aria-hidden
                  className={`absolute bottom-1 size-1.5 rounded-full ${sel ? 'bg-white' : 'bg-ok'}`}
                />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function TimeGrid({
  slots,
  isOn,
  onPick,
  testPrefix = 'move-slot-',
}: {
  slots: Slot[];
  isOn: (time: string) => boolean;
  onPick: (time: string) => void;
  testPrefix?: string;
}) {
  const { t } = useTranslation();
  const { morning, afternoon } = splitDay(slots);
  const part = (label: string, list: Slot[]) =>
    list.length > 0 && (
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] font-bold tracking-[.5px] text-muted uppercase">{label}</span>
        <div className="grid grid-cols-4 gap-1.5">
          {list.map((s) => {
            const on = isOn(s.time);
            return (
              <button
                key={s.time}
                type="button"
                disabled={s.state !== 'free'}
                aria-pressed={on}
                title={
                  s.state === 'held'
                    ? t('offers.heldTitle')
                    : s.state === 'taken'
                      ? t('slots.taken')
                      : undefined
                }
                onClick={() => onPick(s.time)}
                className={`h-9 rounded-xl text-[13px] font-bold tabular-nums ${
                  on
                    ? 'nc-gradient text-white shadow-[0_6px_16px_rgb(79_70_229/0.28)]'
                    : s.state === 'free'
                      ? 'bg-card shadow-[inset_0_0_0_1px_var(--color-edge)] hover:shadow-[inset_0_0_0_1.5px_var(--color-brand)]'
                      : s.state === 'held'
                        ? 'bg-brand-soft text-brand-ink shadow-[inset_0_0_0_1px_var(--color-brand)] [border-style:dashed]'
                        : 'bg-soft text-muted line-through'
                }`}
                data-testid={`${testPrefix}${s.time}`}
                data-state={s.state}
              >
                {chipTime(s.time)}
              </button>
            );
          })}
        </div>
      </div>
    );
  return (
    <div className="flex flex-col gap-3" data-testid="time-grid">
      {part(t('slots.morning'), morning)}
      {part(t('slots.afternoon'), afternoon)}
    </div>
  );
}

/** The doctor's state for that day, as a short line ("6 free", "On leave", "No clinic hours"). */
export function dayState(d: DoctorDay, t: TFunction) {
  return d.on_leave
    ? (['bad', t('moves.onLeave')] as const)
    : !d.has_hours
      ? (['neutral', t('moves.noHours')] as const)
      : d.free.length
        ? (['ok', t('moves.free', { count: d.free.length })] as const)
        : (['bad', t('moves.notFree')] as const);
}
