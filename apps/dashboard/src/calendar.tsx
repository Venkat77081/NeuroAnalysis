/**
 * v28 (decision 051): appointments as a calendar. Day: doctors side by side. Week: Monday to
 * Sunday, coloured by doctor. A coral "Now" line shows the current time. Times are in the
 * hospital's time zone; names come live from the connector (patient codes when it cannot be
 * reached). Clicking an appointment opens its history, where it can be moved or cancelled.
 */
import { useTranslation } from 'react-i18next';
import type { Appointment } from './appointments.tsx';
import { addDays, fmtDay, weekday, zonedDay, zonedTime } from './changes.tsx';
import { avatarColour } from './ui.tsx';

export const HOUR_PX = 96;
/** Appointments have no end time on the platform: shown as this many minutes. */
export const SHOWN_MINUTES = 30;

export interface Placed {
  a: Appointment;
  start: number; // minutes after midnight, hospital time
  lane: number;
  lanes: number;
}

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
};

/** Side by side when they overlap: each appointment gets a lane out of the lanes in its group. */
export function placeDay(list: Appointment[], tz: string): Placed[] {
  const sorted = [...list]
    .map((a) => ({ a, start: minutes(zonedTime(a.at, tz)) }))
    .sort((x, y) => x.start - y.start);
  const out: Placed[] = [];
  let group: Placed[] = [];
  let groupEnd = -1;
  const close = () => {
    const lanes = Math.max(1, ...group.map((p) => p.lane + 1));
    for (const p of group) p.lanes = lanes;
    out.push(...group);
    group = [];
  };
  for (const s of sorted) {
    if (group.length && s.start >= groupEnd) close();
    const busy = new Set(group.filter((p) => p.start + SHOWN_MINUTES > s.start).map((p) => p.lane));
    let lane = 0;
    while (busy.has(lane)) lane++;
    group.push({ ...s, lane, lanes: 1 });
    groupEnd = Math.max(groupEnd, s.start + SHOWN_MINUTES);
  }
  if (group.length) close();
  return out;
}

/** Hours shown: 9 to 17 at least, widened to fit every appointment. */
export function hourRange(starts: number[]): [number, number] {
  let lo = 9;
  let hi = 17;
  for (const s of starts) {
    lo = Math.min(lo, Math.floor(s / 60));
    hi = Math.max(hi, Math.ceil((s + SHOWN_MINUTES) / 60));
  }
  return [lo, Math.min(24, hi)];
}

/** Pixels from the top of the grid for a time in minutes (null outside the shown hours). */
export function offsetFor(mins: number, [lo, hi]: [number, number]): number | null {
  if (mins < lo * 60 || mins > hi * 60) return null;
  return ((mins - lo * 60) / 60) * HOUR_PX;
}

export function weekOf(day: string): string[] {
  const monday = addDays(day, -weekday(day));
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/** The doctors in a day's appointments, in a stable order; "no doctor yet" last. */
export function doctorColumns(list: Appointment[], none: string): { id: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const a of list) seen.set(a.doctor_id ?? '', a.doctor_name ?? none);
  return [...seen.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((x, y) => (x.id === '' ? 1 : y.id === '' ? -1 : x.name.localeCompare(y.name)));
}

const STAGE_ICON: Record<string, string> = {
  recorded: '✓',
  missed: '!',
  not_recorded: '!',
  cancelled: '×',
  needs_doctor: '◷',
  needs_tests: '◷',
  sent: '•',
};

function Event({
  p,
  name,
  tz,
  range,
  colour,
  onOpen,
}: {
  p: Placed;
  name: string;
  tz: string;
  range: [number, number];
  colour: string;
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation();
  const top = offsetFor(p.start, range) ?? 0;
  const off = p.a.status === 'cancelled';
  const width = 100 / p.lanes;
  return (
    <button
      type="button"
      onClick={() => onOpen(p.a.id)}
      className={`absolute flex flex-col overflow-hidden rounded-xl border-l-4 px-2 py-1 text-left text-[12px] leading-4 hover:brightness-95 focus-visible:outline-2 focus-visible:outline-brand ${off ? 'line-through opacity-70' : ''}`}
      style={{
        top: top + 2,
        height: (SHOWN_MINUTES / 60) * HOUR_PX - 4,
        left: `calc(${p.lane * width}% + 2px)`,
        width: `calc(${width}% - 4px)`,
        borderLeftColor: colour,
        background: off
          ? `repeating-linear-gradient(135deg, ${colour}14 0 6px, ${colour}2a 6px 12px)`
          : `${colour}1f`,
      }}
      title={`${zonedTime(p.a.at, tz)} · ${name} · ${p.a.doctor_name ?? ''} · ${t(`appts.stage.${p.a.stage}`)}`}
      data-testid={`cal-event-${p.a.id}`}
    >
      <b className="truncate">
        <span aria-hidden className="mr-1">
          {STAGE_ICON[p.a.stage] ?? '•'}
        </span>
        {name}
      </b>
      <span className="truncate text-muted">
        {zonedTime(p.a.at, tz)} · {t(`appts.stage.${p.a.stage}`)}
      </span>
    </button>
  );
}

function Grid({
  heads,
  cols,
  range,
  nowCol,
  nowTop,
}: {
  heads: React.ReactNode[];
  cols: React.ReactNode[];
  range: [number, number];
  nowCol: number | null;
  nowTop: number | null;
}) {
  const { t } = useTranslation();
  const hours = Array.from({ length: range[1] - range[0] }, (_, i) => range[0] + i);
  const height = hours.length * HOUR_PX;
  return (
    <div className="overflow-x-auto">
      <div
        className="grid min-w-[640px] gap-x-2.5"
        style={{ gridTemplateColumns: `52px repeat(${cols.length}, minmax(110px, 1fr))` }}
      >
        <span />
        {heads.map((h, i) => (
          <div key={i} className="pb-2">
            {h}
          </div>
        ))}
        <div className="relative" style={{ height }}>
          {hours.map((h) => (
            <span
              key={h}
              className="absolute right-1 text-[11px] text-muted"
              style={{ top: (h - range[0]) * HOUR_PX + 2 }}
            >
              {fmtHour(h)}
            </span>
          ))}
        </div>
        {cols.map((c, i) => (
          <div
            key={i}
            className="relative rounded-xl"
            style={{
              height,
              backgroundImage: `repeating-linear-gradient(180deg, var(--color-line) 0 1px, transparent 1px ${HOUR_PX / 2}px)`,
            }}
          >
            {c}
            {nowTop !== null && (nowCol === null || nowCol === i) && (
              <span
                className="pointer-events-none absolute right-0 left-0 z-[2] h-0.5 bg-coral"
                style={{ top: nowTop }}
                data-testid={i === (nowCol ?? 0) ? 'cal-now' : undefined}
                aria-label={i === (nowCol ?? 0) ? t('cal.now') : undefined}
              >
                {i === (nowCol ?? 0) && (
                  <span className="absolute -top-1 -left-1 size-2.5 rounded-full bg-coral" />
                )}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function fmtHour(h: number): string {
  return new Date(Date.UTC(2000, 0, 1, h)).toLocaleTimeString('en-IN', {
    timeZone: 'UTC',
    hour: 'numeric',
  });
}

export function CalendarView({
  mode,
  appts,
  names,
  tz,
  day,
  now,
  onOpen,
}: {
  mode: 'day' | 'week';
  appts: Appointment[];
  names: Record<string, string>;
  tz: string;
  day: string;
  now: number;
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation();
  const none = t('cal.noDoctor');
  const today = zonedDay(now, tz);
  const nowMins = minutes(zonedTime(new Date(now).toISOString(), tz));
  const nameOf = (a: Appointment) => names[a.ncid] ?? a.ncid;
  const colourOf = (a: Appointment) => (a.doctor_name ? avatarColour(a.doctor_name) : '#8a89a0');
  if (mode === 'day') {
    const list = appts.filter((a) => zonedDay(a.at, tz) === day);
    const docs = doctorColumns(list, none);
    const placed = docs.map((d) =>
      placeDay(
        list.filter((a) => (a.doctor_id ?? '') === d.id),
        tz,
      ),
    );
    const range = hourRange(placed.flat().map((p) => p.start));
    if (!docs.length)
      return (
        <p className="py-10 text-center text-[14px] text-muted" data-testid="cal-empty">
          {t('cal.emptyDay', { day: fmtDay(day) })}
        </p>
      );
    return (
      <div data-testid="cal-day">
        <Grid
          range={range}
          nowCol={null}
          nowTop={day === today ? offsetFor(nowMins, range) : null}
          heads={docs.map((d) => (
            <span className="flex items-center gap-2 text-[14px] font-bold">
              <span
                aria-hidden
                className="size-2.5 rounded-full"
                style={{ background: d.id ? avatarColour(d.name) : '#8a89a0' }}
              />
              {d.name}
            </span>
          ))}
          cols={placed.map((col, i) =>
            col.map((p) => (
              <Event
                key={p.a.id}
                p={p}
                name={nameOf(p.a)}
                tz={tz}
                range={range}
                colour={docs[i]!.id ? avatarColour(docs[i]!.name) : '#8a89a0'}
                onOpen={onOpen}
              />
            )),
          )}
        />
      </div>
    );
  }
  const days = weekOf(day);
  const byDay = days.map((d) =>
    placeDay(
      appts.filter((a) => zonedDay(a.at, tz) === d),
      tz,
    ),
  );
  const range = hourRange(byDay.flat().map((p) => p.start));
  const docs = doctorColumns(
    appts.filter((a) => days.includes(zonedDay(a.at, tz))),
    none,
  );
  const ti = days.indexOf(today);
  return (
    <div className="flex flex-col gap-3" data-testid="cal-week">
      {docs.length > 0 && (
        <div className="flex flex-wrap gap-4 text-[13px] text-sub" aria-label={t('cal.legend')}>
          {docs.map((d) => (
            <span key={d.id} className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className="size-2.5 rounded-[3px]"
                style={{ background: d.id ? avatarColour(d.name) : '#8a89a0' }}
              />
              {d.name}
            </span>
          ))}
          <span className="ml-auto text-muted">{t('cal.striped')}</span>
        </div>
      )}
      <Grid
        range={range}
        nowCol={ti >= 0 ? ti : null}
        nowTop={ti >= 0 ? offsetFor(nowMins, range) : null}
        heads={days.map((d) => (
          <span
            className={`text-[14px] font-bold ${d === today ? 'text-brand-ink' : ''}`}
            data-testid={`cal-head-${d}`}
          >
            {fmtDay(d)}
            {d === today ? ` · ${t('cal.today')}` : ''}
          </span>
        ))}
        cols={byDay.map((col) =>
          col.map((p) => (
            <Event
              key={p.a.id}
              p={p}
              name={nameOf(p.a)}
              tz={tz}
              range={range}
              colour={colourOf(p.a)}
              onOpen={onOpen}
            />
          )),
        )}
      />
    </div>
  );
}
