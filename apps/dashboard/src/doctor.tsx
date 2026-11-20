/**
 * Doctor (M14): my patients (NCIDs from the platform + names live from the connector), a patient's
 * live history, recordings decrypted by the connector, review (note kept at the hospital),
 * re-record request and the home recording plan. Nothing about identity is stored by this page.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { call, hospital, hospitalFile } from './api.ts';
import {
  Avatar,
  Badge,
  Button,
  Card,
  Dialog,
  DialogFooter,
  ErrorNote,
  Notice,
  Page,
  fmt,
  fmtDate,
} from './ui.tsx';
import { StageBadge, type Appointment } from './appointments.tsx';
import { myPatientsRing, takeSeconds } from './config.ts';

interface PlatformPatient {
  ncid: string;
  status: string;
  sessions: number;
  last_session_at: string | null;
}
interface Ident {
  ncid: string;
  mrn: string;
  name: string | null;
  birth_date: string | null;
  sex: string | null;
  records_available: boolean;
}

/** v30 (canvas v28): what the doctor's patient list says about each patient. */
export function patientState(p: {
  sessions: number;
  nextStage: string | null;
  newRecording: boolean;
  flagged: boolean;
  nextToday: boolean;
}): {
  key: 'needsTests' | 'newRecording' | 'flagged' | 'today' | 'newPatient' | 'upToDate';
  tone: 'ok' | 'warn' | 'info' | 'neutral';
} {
  if (p.nextStage === 'needs_tests') return { key: 'needsTests', tone: 'warn' };
  if (p.flagged) return { key: 'flagged', tone: 'warn' };
  if (p.newRecording) return { key: 'newRecording', tone: 'info' };
  if (p.nextToday) return { key: 'today', tone: 'info' };
  if (!p.sessions) return { key: 'newPatient', tone: 'neutral' };
  return { key: 'upToDate', tone: 'ok' };
}

/** v33: whole days from `at` until `now` (null when there is no recording yet). */
export function daysSince(at: string | null, now: number): number | null {
  if (!at) return null;
  return Math.max(0, Math.floor((now - Date.parse(at)) / 86_400_000));
}

/** v33: the card's ring: full right after a recording, empty at `ringDays` (config/platform.json). */
export function recency(
  days: number | null,
  cfg: { ringDays: number; okWithinDays: number; warnWithinDays: number } = myPatientsRing,
): { pct: number; tone: 'ok' | 'warn' | 'bad' | 'none' } {
  if (days === null) return { pct: 0, tone: 'none' };
  const pct = Math.round(Math.max(5, Math.min(100, 100 * (1 - days / cfg.ringDays))));
  const tone = days <= cfg.okWithinDays ? 'ok' : days <= cfg.warnWithinDays ? 'warn' : 'bad';
  return { pct, tone };
}

export type PatientSort = 'next' | 'recent' | 'name';

/** v33: next visit first, latest recording first, or by name; patients without one go last. */
export function sortPatients<
  T extends { name: string | null; next: string | null; last: string | null },
>(list: T[], by: PatientSort): T[] {
  const time = (v: string | null, dir: 1 | -1) => (v ? dir * Date.parse(v) : null);
  const byName = (x: T, y: T) =>
    !x.name || !y.name ? (x.name ? -1 : y.name ? 1 : 0) : x.name.localeCompare(y.name);
  return [...list].sort((x, y) => {
    if (by === 'name') return byName(x, y);
    const [k, dir] = by === 'next' ? (['next', 1] as const) : (['last', -1] as const);
    const a = time(x[k], dir);
    const b = time(y[k], dir);
    if (a === null || b === null) return a !== null ? -1 : b !== null ? 1 : byName(x, y);
    return a - b || byName(x, y);
  });
}

const RING_COLOUR = {
  ok: 'var(--color-ok)',
  warn: 'var(--color-warn)',
  bad: 'var(--color-bad)',
  none: 'var(--color-line)',
};

function RecencyRing({ days }: { days: number | null }) {
  const { t } = useTranslation();
  const r = recency(days);
  return (
    <span
      className="relative inline-flex size-[52px] shrink-0 items-center justify-center rounded-full"
      style={{
        background: `conic-gradient(${RING_COLOUR[r.tone]} 0 ${r.pct}%, var(--color-line) 0)`,
      }}
      role="img"
      aria-label={
        days === null ? t('patients.noRecording') : t('patients.ringLabel', { count: days })
      }
      data-testid="recency-ring"
    >
      <span className="flex size-[40px] items-center justify-center rounded-full bg-card text-[13px] font-extrabold">
        {days === null ? '—' : t('patients.daysShort', { n: days })}
      </span>
    </span>
  );
}

type PatientFilter = 'all' | 'newRecording' | 'needsTests' | 'flagged' | 'today';

export function MyPatients({
  onOpen,
  onChooseTests,
}: {
  onOpen: (ncid: string, focus?: 'remark') => void;
  onChooseTests?: () => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<PlatformPatient[] | null>(null);
  const [ident, setIdent] = useState<Record<string, Ident>>({});
  const [appts, setAppts] = useState<Appointment[]>([]);
  const [recent, setRecent] = useState<{ ncid: string | null; flagged: boolean | null }[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [filter, setFilter] = useState<PatientFilter>('all');
  const [sort, setSort] = useState<PatientSort>('next');
  const [sel, setSel] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  useEffect(() => {
    void (async () => {
      try {
        const list = await call<PlatformPatient[]>('GET', '/hospital/patients');
        setRows(list);
        call<Appointment[]>('GET', '/hospital/appointments?days=60').then(
          setAppts,
          () => undefined,
        );
        call<{ items: { key: string; ncid: string | null; flagged: boolean | null }[] }>(
          'GET',
          '/overview?period=4w',
        ).then(
          (d) => setRecent(d.items.filter((i) => i.key === 'recording')),
          () => undefined,
        );
        if (list.length) {
          const ids = await hospital<Ident[]>('POST', '/v1/patients/lookup', {
            ncids: list.map((p) => p.ncid),
          });
          setIdent(Object.fromEntries(ids.map((i) => [i.ncid, i])));
        }
      } catch (e) {
        setError(e);
      }
    })();
  }, []);
  const today = new Date(now).toDateString();
  const info = (rows ?? []).map((p) => {
    const next = appts
      .filter(
        (a) => a.ncid === p.ncid && a.status === 'booked' && Date.parse(a.at) > now - 3_600_000,
      )
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
    const mine = recent.filter((r) => r.ncid === p.ncid);
    const nextToday = !!next && new Date(next.at).toDateString() === today;
    const st = patientState({
      sessions: p.sessions,
      nextStage: next?.stage ?? null,
      newRecording: mine.length > 0,
      flagged: mine.some((r) => r.flagged),
      nextToday,
    });
    return {
      p,
      next,
      st,
      nextToday,
      name: ident[p.ncid]?.name ?? null,
      last: p.last_session_at,
      nextAt: next?.at ?? null,
    };
  });
  const hit = (x: (typeof info)[number], k: PatientFilter) =>
    k === 'all' || x.st.key === k || (k === 'today' && x.nextToday);
  const shown = sortPatients(
    info.filter((x) => hit(x, filter)).map((x) => ({ ...x, next: x.nextAt, appt: x.next })),
    sort,
  );
  const current = info.find((x) => x.p.ncid === sel);
  return (
    <Page title={t('doctor.patientsTitle')} sub={t('patients.sub', { count: rows?.length ?? 0 })}>
      <ErrorNote error={error} />
      <div className="nc-fu flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('patients.filter')}>
          {(['all', 'newRecording', 'needsTests', 'flagged', 'today'] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={filter === k}
              onClick={() => setFilter(k)}
              className={`min-h-9 rounded-full px-3.5 text-[13px] font-semibold ${filter === k ? 'bg-ink text-ground' : 'bg-card text-sub shadow-[inset_0_0_0_1px_var(--color-edge)]'}`}
              data-testid={`patients-filter-${k}`}
            >
              {t(`patients.chip.${k}`, { count: info.filter((x) => hit(x, k)).length })}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-[13px] text-sub">
          <span className="sr-only">{t('patients.sortLabel')}</span>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as PatientSort)}
            className="h-9 rounded-full bg-card px-3.5 text-[13px] font-semibold text-ink shadow-[inset_0_0_0_1px_var(--color-edge)]"
            data-testid="patients-sort"
          >
            {(['next', 'recent', 'name'] as const).map((k) => (
              <option key={k} value={k}>
                {t(`patients.sort.${k}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {rows?.length === 0 && (
        <Notice tone="warn" testId="no-patients">
          {t('doctor.noPatients')}
        </Notice>
      )}
      {rows && rows.length > 0 && shown.length === 0 && (
        <p className="text-[14px] text-muted" data-testid="patients-none">
          {t('patients.noneShown')}
        </p>
      )}
      <div
        className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-3"
        data-testid="my-patients"
      >
        {shown.map(({ p, appt, st, last }) => {
          const i = ident[p.ncid];
          const on = sel === p.ncid;
          return (
            <button
              key={p.ncid}
              type="button"
              onClick={() => setSel(p.ncid)}
              aria-pressed={on}
              className={`nc-fu flex flex-col gap-3 rounded-[24px] bg-card p-4 text-left shadow-card transition hover:-translate-y-0.5 ${on ? 'ring-2 ring-brand' : ''}`}
              data-testid={`patient-card-${i?.mrn ?? p.ncid}`}
            >
              <span className="flex items-center justify-between gap-2.5">
                <span className="flex min-w-0 items-center gap-2.5">
                  <Avatar name={i?.name ?? null} size={42} />
                  <span className="flex min-w-0 flex-col">
                    <b className="truncate text-[15px]">
                      {i?.name ?? <code className="text-[12px] text-muted">{p.ncid}</code>}
                    </b>
                    <span className="text-[12px] text-muted">{i ? `MRN ${i.mrn}` : ''}</span>
                  </span>
                </span>
                <RecencyRing days={daysSince(last, now)} />
              </span>
              <span className="flex flex-wrap gap-1.5">
                <Badge tone={st.tone}>{t(`patients.state.${st.key}`)}</Badge>
              </span>
              <span className="grid grid-cols-2 gap-2 text-[12px] text-muted">
                <span>
                  {t('patients.next')}
                  <b className="block text-[13px] text-ink">{appt ? fmt(appt.at) : '—'}</b>
                </span>
                <span>
                  {t('patients.last')}
                  <b className="block text-[13px] text-ink">
                    {last
                      ? `${fmtDate(last)} · ${t('doctor.sessions', { count: p.sessions })}`
                      : t('patients.noneYet')}
                  </b>
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {current && (
        <PatientPanel
          key={current.p.ncid}
          ncid={current.p.ncid}
          ident={ident[current.p.ncid] ?? null}
          state={current.st}
          onClose={() => setSel(null)}
          onOpen={(focus) => onOpen(current.p.ncid, focus)}
          onChooseTests={onChooseTests}
        />
      )}
    </Page>
  );
}

/** v33 (canvas V33PatientsPanel): a card opened at the side, with the patient page's first part. */
function PatientPanel({
  ncid,
  ident,
  state,
  onClose,
  onOpen,
  onChooseTests,
}: {
  ncid: string;
  ident: Ident | null;
  state: ReturnType<typeof patientState>;
  onClose: () => void;
  onOpen: (focus?: 'remark') => void;
  onChooseTests?: () => void;
}) {
  const { t } = useTranslation();
  const [recs, setRecs] = useState<Recording[]>([]);
  const [reviews, setReviews] = useState<Record<string, Review>>({});
  const [watching, setWatching] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    hospital<Recording[]>('GET', `/v1/patients/${ncid}/recordings`).then(setRecs, setError);
    hospital<Review[]>('GET', `/v1/patients/${ncid}/reviews`).then(
      (rs) => setReviews(Object.fromEntries([...rs].reverse().map((r) => [r.take_id, r]))),
      () => undefined,
    );
  }, [ncid]);
  const { points, latest, session, last, next, nextTests } = useSummary(ncid, recs);
  const name = ident?.name ?? ncid;
  const watchable = session.find((r) => r.status === 'complete');
  return (
    <Dialog
      title={name}
      sub={ident ? `MRN ${ident.mrn}` : `NCID ${ncid}`}
      size="side"
      onClose={onClose}
      testId="patient-panel"
    >
      <ErrorNote error={error} />
      <div className="flex flex-wrap gap-1.5">
        <Badge tone={state.tone}>{t(`patients.state.${state.key}`)}</Badge>
        <Badge tone="neutral">{t('shell.liveRecords')}</Badge>
      </div>
      <section className="flex flex-col gap-2" data-testid="panel-journey">
        <b className="text-[14px]">{t('patient.journey')}</b>
        {points.length === 0 ? (
          <span className="text-[13px] text-muted">{t('patient.noJourney')}</span>
        ) : (
          <div className="relative flex items-start pt-1">
            <span className="absolute top-[11px] right-2 left-2 h-[2px] bg-line" />
            {points.map((p, i) => (
              <span
                key={`${p.at}-${i}`}
                className="relative flex flex-1 flex-col items-center gap-1 text-[11px] text-muted"
                title={t(`patient.point.${p.kind}`, { count: p.tests ?? 0 })}
              >
                <span
                  className="size-[14px] rounded-full shadow-[0_0_0_3px_var(--color-card)]"
                  style={{ background: JOURNEY_COLOUR[p.kind] }}
                />
                {dayMonth(p.at)}
              </span>
            ))}
          </div>
        )}
      </section>
      <section className="flex flex-col gap-2" data-testid="panel-latest">
        <span className="flex items-center justify-between gap-2">
          <b className="text-[14px]">
            {latest
              ? t('patient.latestTitle', {
                  date: dayMonth(latest.started_at),
                  where: latest.recorded_by === 'patient' ? t('doctor.home') : t('doctor.clinic'),
                  med: t(`med.${latest.med_state}`),
                })
              : t('patient.latestNone')}
          </b>
          {watchable && (
            <button
              type="button"
              className="text-[12px] font-bold text-brand"
              onClick={() => setWatching(watchable.take_id)}
            >
              {t('patients.watchShort')}
            </button>
          )}
        </span>
        {session.length > 0 && (
          <div className="grid grid-cols-5 gap-1.5">
            {session.map((r) => (
              <button
                key={r.take_id}
                type="button"
                disabled={r.status !== 'complete'}
                onClick={() => setWatching(r.take_id)}
                className="overflow-hidden rounded-xl bg-soft text-left disabled:opacity-60"
                data-testid={`panel-tile-${r.test_code}`}
              >
                <span className="flex h-12 items-center justify-center bg-[linear-gradient(135deg,#1d1b2e,#3b3760)] text-[12px] text-white">
                  ▶
                </span>
                <span className="flex flex-col px-1.5 py-1 text-[10px] font-bold">
                  {r.test_code}
                  <span className={r.capture_verdict === 'PASS' ? 'text-ok' : 'text-warn'}>
                    {r.capture_verdict === 'PASS'
                      ? `✓ ${t('patient.passed')}`
                      : t(`verdict.${r.capture_verdict}`)}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
      <section
        className="rounded-2xl bg-soft px-3 py-2.5 text-[13px] leading-[19px]"
        data-testid="panel-remark"
      >
        <b>{t('patient.lastRemark')}</b>
        {last && <span className="text-muted"> · {fmtDate(last.updated_at)}</span>}
        <span className="block text-sub">{last ? `“${last.text}”` : t('patient.noRemark')}</span>
      </section>
      <section className="flex items-center justify-between gap-2" data-testid="panel-next">
        <span className="flex flex-col">
          <b className="text-[14px]">{t('patient.nextVisit')}</b>
          <span className="text-[12px] text-muted">
            {next
              ? `${fmt(next.at)} · ${
                  nextTests.length
                    ? t('patient.nextTests', {
                        tests: nextTests.map((c) => t(`tests.${c}`)).join(', '),
                      })
                    : t('today.status.needsTests')
                }`
              : t('patient.noNext')}
          </span>
        </span>
        {next?.change_request_id && (
          <Badge tone="warn">
            {t('patient.askedToChange', { name: ident?.name?.split(/\s+/)[0] ?? '' })}
          </Badge>
        )}
      </section>
      <DialogFooter>
        <div className="grid w-full grid-cols-2 gap-2">
          {watchable ? (
            <Button onClick={() => setWatching(watchable.take_id)} data-testid="panel-watch">
              ▶ {t('patient.watch', { date: dayMonth(watchable.started_at) })}
            </Button>
          ) : (
            <Button disabled>{t('patients.nothingToWatch')}</Button>
          )}
          <Button
            variant="secondary"
            onClick={() => onOpen('remark')}
            data-testid="panel-remark-add"
          >
            {t('patient.addRemark')}
          </Button>
          {onChooseTests && (
            <Button variant="secondary" onClick={onChooseTests} data-testid="panel-choose">
              {t('patient.chooseTests')}
            </Button>
          )}
          <Button
            variant="secondary"
            onClick={() => onOpen()}
            data-testid={`open-${ident?.mrn ?? ncid}`}
          >
            {t('patients.openFull')}
          </Button>
        </div>
      </DialogFooter>
      {watching && (
        <Theatre
          takes={(() => {
            const sid = recs.find((r) => r.take_id === watching)?.session_id;
            return recs.filter((r) => r.session_id === sid);
          })()}
          start={watching}
          name={name}
          reviews={reviews}
          onReviewed={(take, rv) => setReviews((m) => ({ ...m, [take]: rv }))}
          onClose={() => setWatching(null)}
        />
      )}
    </Dialog>
  );
}

interface HistoryItem {
  text: string;
  date: string | null;
  detail: string | null;
}
interface View {
  ncid: string;
  records_available: boolean;
  mrn: string;
  name: string | null;
  birth_date: string | null;
  sex: string | null;
  conditions: HistoryItem[];
  medications: HistoryItem[];
  encounters: HistoryItem[];
}
interface Recording {
  take_id: string;
  session_id: string;
  started_at: string;
  recorded_by: string;
  med_state: string;
  test_code: string;
  capture_verdict: string;
  flagged_for_review: boolean;
  status: string;
}
interface Review {
  take_id: string;
  usable: boolean;
  note: string | null;
  at: string;
}
interface Plan {
  tests: string[];
  every_days: number;
  med_state: 'OFF' | 'ON' | 'ANY';
  default: boolean;
  /** v3: also record every `every_days` days between appointments (only when asked). */
  periodic: boolean;
  /** v3: the next appointment, where the repeats stop (null while none is booked). */
  periodic_until: string | null;
  rerecord_requested_at: string | null;
}
interface PlatformHistory {
  app_status: string;
  withdrawn_at: string | null;
  appointments: Appointment[];
  other_requests: Appointment['requests'];
  sessions: {
    id: string;
    started_at: string;
    recorded_by: string;
    med_state: string;
    request_id: string | null;
    takes_uploaded: number;
    // v16 (decision 047): clinic recordings only.
    consent_source?: 'patient_app' | 'clinic_phone' | null;
    consent_reason?: string | null;
  }[];
}

const TESTS = ['FT', 'FTF', 'FR', 'SAW', 'FA'];

/** v30 (canvas v28): one point on the patient's journey. */
export interface JourneyPoint {
  at: string;
  kind: 'noShow' | 'cancelled' | 'visit' | 'next' | 'home' | 'clinic';
  tests?: number;
  flagged?: number;
  remark?: boolean;
}

/** The last few things that happened plus the next visit, oldest first (at most `max`). */
export function journey(
  h: Pick<PlatformHistory, 'appointments' | 'sessions'>,
  recs: Pick<Recording, 'session_id' | 'flagged_for_review'>[],
  remarks: Record<string, unknown>,
  now: number,
  max = 5,
): JourneyPoint[] {
  const past: JourneyPoint[] = [];
  let next: JourneyPoint | null = null;
  for (const a of h.appointments) {
    const t = Date.parse(a.at);
    if (a.status === 'cancelled') {
      if (t <= now)
        past.push({ at: a.at, kind: a.cancel_reason === 'no_show' ? 'noShow' : 'cancelled' });
    } else if (t > now) {
      if (!next || t < Date.parse(next.at)) next = { at: a.at, kind: 'next' };
    } else past.push({ at: a.at, kind: 'visit', remark: !!remarks[a.id] });
  }
  for (const se of h.sessions)
    past.push({
      at: se.started_at,
      kind: se.recorded_by === 'patient' ? 'home' : 'clinic',
      tests: se.takes_uploaded,
      flagged: recs.filter((r) => r.session_id === se.id && r.flagged_for_review).length,
    });
  past.sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
  const keep = past.slice(-(next ? max - 1 : max));
  return next ? [...keep, next] : keep;
}

const JOURNEY_COLOUR: Record<JourneyPoint['kind'], string> = {
  noShow: 'var(--color-alert)',
  cancelled: 'var(--color-edge)',
  visit: '#059669',
  next: 'var(--color-edge)',
  home: 'var(--color-brand)',
  clinic: '#d97706',
};

const dayMonth = (iso: string) =>
  new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

/**
 * v30 (canvas v28): watch a session's takes full screen on dark, the takes listed on the right with
 * their capture result, slow motion and frame steps, and the review form. Videos are decrypted by
 * the connector into memory only. No scores.
 */
const DARK_TOKENS = {
  '--color-card': '#1a1926',
  '--color-ink': '#f3f2fa',
  '--color-sub': '#c4c2d6',
  '--color-muted': '#a3a1bb',
  '--color-edge': '#3a3852',
  '--color-soft': '#2e2c45',
  '--color-line': '#2a2838',
} as React.CSSProperties;

function Theatre({
  takes,
  start,
  name,
  reviews,
  onReviewed,
  onClose,
}: {
  takes: Recording[];
  start: string;
  name: string;
  reviews: Record<string, Review>;
  onReviewed: (take: string, r: Review) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [take, setTake] = useState(start);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [speed, setSpeed] = useState(1);
  const video = useRef<HTMLVideoElement>(null);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);
  useEffect(() => {
    let off = false;
    let made: string | null = null;
    hospitalFile(`/v1/takes/${take}/files/video`).then(
      (u) => {
        made = u;
        if (off) URL.revokeObjectURL(u);
        else setUrl(u);
      },
      (e: unknown) => !off && setError(e),
    );
    return () => {
      off = true;
      if (made) URL.revokeObjectURL(made); // decrypted video lives in memory only
      setUrl(null);
    };
  }, [take]);
  useEffect(() => {
    if (video.current) video.current.playbackRate = speed;
  }, [speed, url]);
  const cur = takes.find((r) => r.take_id === take)!;
  const step = (n: number) => {
    const v = video.current;
    if (!v) return;
    v.pause();
    v.currentTime = Math.max(0, v.currentTime + n / 60);
  };
  const chip = (r: Recording) =>
    r.capture_verdict === 'PASS'
      ? ['✓ ' + t('patient.passed'), 'bg-[rgb(16_185_129/0.16)] text-[#6ee7b7]']
      : ['◷ ' + t(`verdict.${r.capture_verdict}`), 'bg-[rgb(245_158_11/0.16)] text-[#fcd34d]'];
  return (
    <dialog
      ref={ref}
      aria-label={t('theatre.title', { test: t(`tests.${cur.test_code}`) })}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="m-0 h-full max-h-none w-full max-w-none bg-[#0e0d16] p-0 text-white"
      data-testid="theatre"
    >
      <div className="flex h-full flex-col gap-4 p-4 lg:flex-row lg:p-6">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="text-[#a5a3c0]"
              data-testid="theatre-close"
            >
              ‹ {name}
            </button>
            <b className="text-[18px]">
              {t(`tests.${cur.test_code}`)}
              {['FT', 'FTF', 'FR'].includes(cur.test_code) ? ` · ${t('theatre.bothHands')}` : ''}
            </b>
            <span className="text-[#a5a3c0]">
              {fmt(cur.started_at)} ·{' '}
              {cur.recorded_by === 'patient' ? t('doctor.home') : t('doctor.clinic')} ·{' '}
              {t(`med.${cur.med_state}`)}
            </span>
            <span className="ml-auto flex gap-2">
              <span className={`rounded-xl px-2.5 py-0.5 text-[12px] font-bold ${chip(cur)[1]}`}>
                {chip(cur)[0]}
              </span>
              <span className="rounded-xl bg-[rgb(79_70_229/0.3)] px-2.5 py-0.5 text-[12px] font-bold text-[#c7d2fe]">
                60 fps
              </span>
            </span>
          </div>
          <div className="relative flex min-h-[320px] flex-1 items-center justify-center overflow-hidden rounded-[26px] bg-[radial-gradient(circle_at_50%_40%,#2a2740,#14131f)]">
            {url ? (
              <video
                ref={video}
                key={url}
                src={url}
                controls
                autoPlay
                className="h-full max-h-full w-full object-contain"
                data-testid="theatre-player"
              />
            ) : (
              <span className="text-[#a5a3c0]">
                {error ? t('errors.generic') : t('app.loading')}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {[0.25, 0.5, 1].map((x) => (
              <button
                key={x}
                type="button"
                aria-pressed={speed === x}
                onClick={() => setSpeed(x)}
                className={`rounded-2xl px-3 py-2 text-[12px] font-bold ${speed === x ? 'bg-white text-[#16151f]' : 'bg-[#22212f]'}`}
              >
                {x}×
              </button>
            ))}
            <button
              type="button"
              onClick={() => step(-1)}
              className="rounded-2xl bg-[#22212f] px-3 py-2 text-[12px] font-bold"
            >
              ‹ {t('theatre.frame')}
            </button>
            <button
              type="button"
              onClick={() => step(1)}
              className="rounded-2xl bg-[#22212f] px-3 py-2 text-[12px] font-bold"
            >
              {t('theatre.frame')} ›
            </button>
          </div>
        </div>
        <aside className="flex w-full flex-col gap-1.5 overflow-y-auto rounded-[26px] bg-[#1a1926] p-4 lg:w-[330px]">
          <b className="px-1 pb-1.5 text-[15px]">
            {t('theatre.takes', { date: fmtDate(cur.started_at) })}
          </b>
          {takes.map((r) => (
            <button
              key={r.take_id}
              type="button"
              onClick={() => setTake(r.take_id)}
              disabled={r.status !== 'complete'}
              className={`flex items-center gap-2.5 rounded-2xl px-3 py-2.5 text-left disabled:opacity-50 ${r.take_id === take ? 'bg-[#2a2840]' : ''}`}
              data-testid={`theatre-take-${r.test_code}`}
            >
              <span className="h-[34px] w-[52px] shrink-0 rounded-lg bg-[linear-gradient(135deg,#2a2740,#4a4570)]" />
              <span className="min-w-0 flex-1">
                <b className="block truncate text-[13px]">{t(`tests.${r.test_code}`)}</b>
                <span className="block truncate text-[11px] text-[#a5a3c0]">
                  {reviews[r.take_id]
                    ? t('doctor.reviewed', {
                        v: reviews[r.take_id]!.usable ? t('doctor.usable') : t('doctor.notUsable'),
                      })
                    : r.flagged_for_review
                      ? t('theatre.flagged')
                      : `${takeSeconds[r.test_code] ?? ''} s`}
                </span>
              </span>
              <span
                className={`shrink-0 rounded-[10px] px-2 py-0.5 text-[11px] font-bold ${chip(r)[1]}`}
              >
                {chip(r)[0]}
              </span>
            </button>
          ))}
          <b className="px-1 pt-3 pb-1 text-[15px]">{t('theatre.review')}</b>
          {/* The review form in dark colours (scoped tokens), whatever the page theme. */}
          <div className="rounded-2xl bg-[#24223a] p-3 text-ink" style={DARK_TOKENS}>
            <ReviewForm key={take} take={take} onSaved={(rv) => onReviewed(take, rv)} />
          </div>
          <span className="mt-auto pt-3 text-center text-[11px] text-[#8a89a0]">
            {t('theatre.noScores')}
          </span>
        </aside>
      </div>
    </dialog>
  );
}

/** v33: what the patient page and the My patients panel show first (journey, latest, remark, next). */
function useSummary(ncid: string, recs: Recording[]) {
  const [h, setH] = useState<PlatformHistory | null>(null);
  const [remarks, setRemarks] = useState<Remark[]>([]);
  const [now] = useState(() => Date.now());
  useEffect(() => {
    call<PlatformHistory>('GET', `/hospital/patients/${ncid}/history`).then(setH, () => undefined);
    hospital<Remark[]>('GET', `/v1/patients/${ncid}/remarks`).then(setRemarks, () => undefined);
  }, [ncid]);
  const byAppt = Object.fromEntries(remarks.map((r) => [r.appointment_id, r]));
  const points = h ? journey(h, recs, byAppt, now) : [];
  const latest = [...recs].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))[0];
  const session = latest ? recs.filter((r) => r.session_id === latest.session_id) : [];
  const last = [...remarks].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0];
  const next = h?.appointments
    .filter((a) => a.status === 'booked' && Date.parse(a.at) > now)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
  const nextTests = next ? [...new Set(next.requests.flatMap((r) => r.tests))] : [];
  return { points, latest, session, last, next, nextTests };
}

function PatientSummary({
  ncid,
  name,
  recs,
  playing,
  onPlay,
  onWatch,
}: {
  ncid: string;
  name: string | null;
  recs: Recording[];
  playing: { take: string; url: string } | null;
  onPlay: (take: string) => void;
  /** v30: open the take in theatre mode. */
  onWatch?: (take: string) => void;
}) {
  const { t } = useTranslation();
  const { points, latest, session, last, next, nextTests } = useSummary(ncid, recs);
  const playingRec = recs.find((r) => r.take_id === playing?.take);
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.9fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-4">
        <Card title={t('patient.journey')} testId="journey">
          {points.length === 0 ? (
            <p className="text-[14px] text-muted">{t('patient.noJourney')}</p>
          ) : (
            <div className="relative flex items-start pt-1.5">
              <span className="absolute top-[14px] right-0 left-0 h-[3px] rounded-full bg-line" />
              {points.map((p, i) => (
                <div
                  key={`${p.at}-${i}`}
                  className="relative flex flex-1 flex-col items-center gap-1.5 text-center"
                  data-testid="journey-point"
                >
                  <span
                    className="size-[18px] rounded-full shadow-[0_0_0_4px_var(--color-card)]"
                    style={{ background: JOURNEY_COLOUR[p.kind] }}
                  />
                  <b className="text-[13px]">{dayMonth(p.at)}</b>
                  <span className="max-w-[150px] text-[12px] text-muted">
                    {t(`patient.point.${p.kind}`, { count: p.tests ?? 0 })}
                    {p.flagged ? ` · ${t('patient.flagged', { count: p.flagged })}` : ''}
                    {p.remark ? ` · ${t('patient.remarkAdded')}` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card
          title={
            latest
              ? t('patient.latestTitle', {
                  date: dayMonth(latest.started_at),
                  where: latest.recorded_by === 'patient' ? t('doctor.home') : t('doctor.clinic'),
                  med: t(`med.${latest.med_state}`),
                })
              : t('patient.latestNone')
          }
          testId="latest-recordings"
        >
          {playing && (
            <div className="flex flex-col gap-2">
              <span className="text-[13px] font-semibold text-sub">
                {t('patient.playing', {
                  test: playingRec ? t(`tests.${playingRec.test_code}`) : '',
                  date: playingRec ? dayMonth(playingRec.started_at) : '',
                })}
              </span>
              <video
                src={playing.url}
                controls
                autoPlay
                className="w-full rounded-2xl bg-black"
                data-testid="player"
              />
            </div>
          )}
          {session.length > 0 && (
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-5">
              {session.map((r) => (
                <button
                  key={r.take_id}
                  type="button"
                  disabled={r.status !== 'complete'}
                  onClick={() => (onWatch ?? onPlay)(r.take_id)}
                  className="overflow-hidden rounded-2xl bg-soft text-left disabled:opacity-60"
                  data-testid={`rec-tile-${r.test_code}`}
                >
                  <span className="relative flex h-[78px] items-center justify-center bg-[linear-gradient(135deg,#1d1b2e,#3b3760)] text-[18px] text-white">
                    ▶
                    {takeSeconds[r.test_code] && (
                      <span className="absolute right-1.5 bottom-1.5 rounded-md bg-black/50 px-1.5 text-[10px]">
                        0:{String(takeSeconds[r.test_code]).padStart(2, '0')}
                      </span>
                    )}
                  </span>
                  <span className="flex flex-col gap-1 px-2.5 py-2">
                    <b className="truncate text-[12px]">{t(`tests.${r.test_code}`)}</b>
                    <span>
                      <Badge tone={r.capture_verdict === 'PASS' ? 'ok' : 'warn'}>
                        {r.capture_verdict === 'PASS'
                          ? t('patient.passed')
                          : t(`verdict.${r.capture_verdict}`)}
                      </Badge>
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </Card>
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <Card title={t('patient.lastRemark')} testId="last-remark">
          {last ? (
            <>
              <span className="text-[14px] leading-[21px]">“{last.text}”</span>
              <span className="text-[12px] text-muted">{fmtDate(last.updated_at)}</span>
            </>
          ) : (
            <span className="text-[14px] text-muted">{t('patient.noRemark')}</span>
          )}
        </Card>
        <Card title={t('patient.nextVisit')} testId="next-visit">
          {next ? (
            <>
              <b className="text-[16px]">{fmt(next.at)}</b>
              <span className="text-[13px] text-sub">
                {nextTests.length
                  ? t('patient.nextTests', {
                      tests: nextTests.map((c) => t(`tests.${c}`)).join(', '),
                    })
                  : t('today.status.needsTests')}
              </span>
              {next.change_request_id && (
                <span className="self-start">
                  <Badge tone="warn">
                    {t('patient.askedToChange', { name: name?.split(/\s+/)[0] ?? '' })}
                  </Badge>
                </span>
              )}
            </>
          ) : (
            <span className="text-[14px] text-muted">{t('patient.noNext')}</span>
          )}
        </Card>
      </div>
    </div>
  );
}

export function PatientView({
  ncid,
  onBack,
  onChooseTests,
  focus,
}: {
  ncid: string;
  onBack: () => void;
  /** v33: "Add remark" in the My patients panel opens the page at the timeline. */
  focus?: 'remark';
  /** v30: "Choose tests" in the header. */
  onChooseTests?: () => void;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<View | null>(null);
  const [recs, setRecs] = useState<Recording[]>([]);
  const [reviews, setReviews] = useState<Record<string, Review>>({});
  const [error, setError] = useState<unknown>(null);
  const [playing, setPlaying] = useState<{ take: string; url: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // v30: the take open in theatre mode.
  const [watching, setWatching] = useState<string | null>(null);

  useEffect(() => {
    hospital<View>('GET', `/v1/patients/${ncid}`).then(setView, setError);
    hospital<Recording[]>('GET', `/v1/patients/${ncid}/recordings`).then(setRecs, setError);
    hospital<Review[]>('GET', `/v1/patients/${ncid}/reviews`).then(
      (rs) => setReviews(Object.fromEntries([...rs].reverse().map((r) => [r.take_id, r]))),
      () => undefined,
    );
  }, [ncid]);
  useEffect(() => {
    if (focus !== 'remark') return;
    const id = setTimeout(
      () => document.getElementById('patient-timeline')?.scrollIntoView({ behavior: 'smooth' }),
      400,
    );
    return () => clearTimeout(id);
  }, [focus]);
  useEffect(
    () => () => {
      if (playing) URL.revokeObjectURL(playing.url); // decrypted video lives in memory only
    },
    [playing],
  );

  const play = async (take: string) => {
    setError(null);
    try {
      const url = await hospitalFile(`/v1/takes/${take}/files/video`);
      setPlaying({ take, url });
      requestAnimationFrame(() =>
        document
          .querySelector('[data-testid="latest-recordings"]')
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      );
    } catch (e) {
      setError(e);
    }
  };
  const rerecord = async () => {
    try {
      await call('POST', `/hospital/patients/${ncid}/rerecord`, { tests: [] });
      setNotice(t('doctor.rerecordDone'));
    } catch (e) {
      setError(e);
    }
  };

  const watchable = [...recs]
    .filter((r) => r.status === 'complete')
    .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))[0];
  // v28: a profile header (avatar, name, MRN line, "live from your records").
  const header = (
    <div className="nc-fu flex flex-col gap-3" data-testid="patient-header">
      <Button variant="ghost" className="min-h-9 self-start px-2" onClick={onBack}>
        ← {t('app.back')}
      </Button>
      <div className="flex flex-wrap items-center gap-4">
        <Avatar name={view?.name ?? null} size={68} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h1 className="text-[28px] leading-9 font-extrabold tracking-[-0.4px]">
            {view?.name ?? ncid}
          </h1>
          <span className="flex flex-wrap items-center gap-2 text-[14px] text-sub">
            <span data-testid="patient-mrn">
              {view
                ? [`MRN ${view.mrn}`, view.birth_date && fmtDate(view.birth_date), view.sex]
                    .filter(Boolean)
                    .join(' · ')
                : ''}
            </span>
            <Badge tone="neutral">{t('shell.liveRecords')}</Badge>
          </span>
          <span className="text-[12px] text-muted">NCID {ncid}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {onChooseTests && (
            <Button variant="secondary" onClick={onChooseTests} data-testid="header-choose">
              {t('patient.chooseTests')}
            </Button>
          )}
          <Button
            variant="secondary"
            onClick={() =>
              document.getElementById('patient-timeline')?.scrollIntoView({ behavior: 'smooth' })
            }
            data-testid="header-remark"
          >
            {t('patient.addRemark')}
          </Button>
          {watchable && (
            <Button onClick={() => setWatching(watchable.take_id)} data-testid="header-watch">
              ▶{' '}
              {t('patient.watch', {
                date: new Date(watchable.started_at).toLocaleDateString('en-IN', {
                  day: 'numeric',
                  month: 'short',
                }),
              })}
            </Button>
          )}
        </div>
      </div>
      <span className="text-[12px] text-muted">{t('app.notStored')}</span>
    </div>
  );

  return (
    <Page title={view?.name ?? ncid} hero={header}>
      <ErrorNote error={error} />
      {notice && <Notice testId="notice">{notice}</Notice>}
      <PatientSummary
        ncid={ncid}
        name={view?.name ?? null}
        recs={recs}
        playing={playing}
        onPlay={(take) => void play(take)}
        onWatch={setWatching}
      />
      {watching && (
        <Theatre
          takes={(() => {
            const sid = recs.find((r) => r.take_id === watching)?.session_id;
            return recs.filter((r) => r.session_id === sid);
          })()}
          start={watching}
          name={view?.name ?? ncid}
          reviews={reviews}
          onReviewed={(take, rv) => setReviews((m) => ({ ...m, [take]: rv }))}
          onClose={() => setWatching(null)}
        />
      )}
      <h2 className="mt-2 text-[17px] font-bold">{t('patient.details')}</h2>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card title={t('doctor.history')} testId="history">
          {view && !view.records_available && (
            <Notice tone="warn">{t('doctor.unavailable')}</Notice>
          )}
          {view?.records_available && (
            <span className="text-[12px] text-muted">{t('doctor.fetchedNow')}</span>
          )}
          {(['conditions', 'medications', 'encounters'] as const).map((k) => (
            <div key={k} className="flex flex-col gap-1 text-[14px]">
              <span className="text-[12px] font-semibold text-muted uppercase">
                {t(`doctor.${k}`)}
              </span>
              {(view?.[k] ?? []).map((h, i) => (
                <span key={i}>
                  {[h.text, h.detail, h.date && fmtDate(h.date)].filter(Boolean).join(' · ')}
                </span>
              ))}
            </div>
          ))}
        </Card>
        <div className="flex flex-col gap-5">
          <Card title={t('doctor.recordings')} testId="recordings">
            <span className="text-[12px] text-muted">{t('doctor.decrypted')}</span>
            <ul className="flex flex-col divide-y divide-line">
              {recs.map((r) => (
                <li key={r.take_id} className="flex flex-col gap-2 py-3">
                  <div className="flex flex-wrap items-center gap-2 text-[14px]">
                    <span className="font-semibold">{t(`tests.${r.test_code}`)}</span>
                    <span className="text-muted">
                      {fmt(r.started_at)} ·{' '}
                      {r.recorded_by === 'patient' ? t('doctor.home') : t('doctor.clinic')} ·{' '}
                      {t(`med.${r.med_state}`)}
                    </span>
                    <Badge tone={r.capture_verdict === 'PASS' ? 'ok' : 'warn'}>
                      {t(`verdict.${r.capture_verdict}`)}
                    </Badge>
                    {reviews[r.take_id] && (
                      <Badge tone={reviews[r.take_id]!.usable ? 'ok' : 'bad'}>
                        {t('doctor.reviewed', {
                          v: reviews[r.take_id]!.usable
                            ? t('doctor.usable')
                            : t('doctor.notUsable'),
                        })}
                      </Badge>
                    )}
                    <span className="flex-1" />
                    {r.status === 'complete' && (
                      <Button
                        variant="secondary"
                        onClick={() => void play(r.take_id)}
                        data-testid={`play-${r.test_code}`}
                      >
                        {t('doctor.play')}
                      </Button>
                    )}
                  </div>
                  <ReviewForm
                    take={r.take_id}
                    onSaved={(rv) => setReviews((m) => ({ ...m, [r.take_id]: rv }))}
                  />
                </li>
              ))}
            </ul>
            <Button
              variant="secondary"
              className="self-start"
              onClick={() => void rerecord()}
              data-testid="rerecord"
            >
              {t('doctor.rerecord')}
            </Button>
          </Card>
          <div id="patient-timeline">
            <Timeline ncid={ncid} />
          </div>
          <PlanEditor ncid={ncid} />
          <Card title={t('doctor.biomarkerTitle')} className="border-dashed">
            <Badge>{t('doctor.planned')}</Badge>
            <p className="text-[13px] text-muted">{t('doctor.biomarkerHint')}</p>
          </Card>
        </div>
      </div>
    </Page>
  );
}

function ReviewForm({ take, onSaved }: { take: string; onSaved: (r: Review) => void }) {
  const { t } = useTranslation();
  const [usable, setUsable] = useState<boolean | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<unknown>(null);
  const save = async () => {
    setError(null);
    try {
      onSaved(
        await hospital<Review>('POST', `/v1/takes/${take}/review`, { usable, note: note || null }),
      );
      setNote('');
      setUsable(null);
    } catch (e) {
      setError(e);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-[13px]" data-testid={`review-${take}`}>
      <Button
        variant={usable === true ? 'primary' : 'secondary'}
        onClick={() => setUsable(true)}
        data-testid="review-usable"
      >
        {t('doctor.usable')}
      </Button>
      <Button
        variant={usable === false ? 'danger' : 'secondary'}
        onClick={() => setUsable(false)}
        data-testid="review-not-usable"
      >
        {t('doctor.notUsable')}
      </Button>
      <input
        aria-label={t('doctor.note')}
        placeholder={t('doctor.note')}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        className="h-11 min-w-48 flex-1 rounded-2xl border border-edge px-3"
        data-testid="review-note"
      />
      <Button disabled={usable === null} onClick={() => void save()} data-testid="review-save">
        {t('doctor.saveReview')}
      </Button>
      <ErrorNote error={error} />
    </div>
  );
}

function PlanEditor({ ncid }: { ncid: string }) {
  const { t } = useTranslation();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(
    () => void call<Plan>('GET', `/hospital/patients/${ncid}/plan`).then(setPlan, setError),
    [ncid],
  );
  if (!plan) return <ErrorNote error={error} />;
  const save = async () => {
    setError(null);
    try {
      setPlan(
        await call<Plan>('PUT', `/hospital/patients/${ncid}/plan`, {
          tests: plan.tests,
          every_days: plan.every_days,
          med_state: plan.med_state,
          periodic: plan.periodic,
        }),
      );
      setSaved(true);
    } catch (e) {
      setError(e);
    }
  };
  return (
    <Card title={t('doctor.planTitle')} testId="plan">
      <div className="flex flex-wrap gap-3">
        {TESTS.map((c) => (
          <label key={c} className="flex min-h-11 items-center gap-2 text-[14px]">
            <input
              type="checkbox"
              checked={plan.tests.includes(c)}
              onChange={(e) => {
                setSaved(false);
                setPlan({
                  ...plan,
                  tests: e.target.checked
                    ? TESTS.filter((x) => x === c || plan.tests.includes(x))
                    : plan.tests.filter((x) => x !== c),
                });
              }}
              className="size-5 accent-brand"
              data-testid={`plan-${c}`}
            />
            {t(`tests.${c}`)}
          </label>
        ))}
      </div>
      <label className="flex min-h-11 items-center gap-2 text-[14px]">
        <input
          type="checkbox"
          checked={plan.periodic}
          onChange={(e) => {
            setSaved(false);
            setPlan({ ...plan, periodic: e.target.checked });
          }}
          className="size-5 accent-brand"
          data-testid="plan-periodic"
        />
        {t('doctor.periodic')}
      </label>
      {plan.periodic && (
        <span className="text-[13px] text-muted" data-testid="plan-until">
          {plan.periodic_until
            ? t('doctor.periodicUntil', { date: fmtDate(plan.periodic_until) })
            : t('doctor.periodicNoAppt')}
        </span>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-[13px] font-semibold text-sub">
          {t('doctor.everyDays')}
          <input
            type="number"
            min={1}
            max={90}
            value={plan.every_days}
            disabled={!plan.periodic}
            onChange={(e) => {
              setSaved(false);
              setPlan({ ...plan, every_days: Number(e.target.value) });
            }}
            className="h-11 w-24 rounded-2xl border border-edge px-3"
            data-testid="plan-days"
          />
        </label>
        <label className="flex flex-col gap-1 text-[13px] font-semibold text-sub">
          {t('doctor.medState')}
          <select
            value={plan.med_state}
            onChange={(e) => {
              setSaved(false);
              setPlan({ ...plan, med_state: e.target.value as Plan['med_state'] });
            }}
            className="h-11 rounded-2xl border border-edge bg-card px-2"
            data-testid="plan-med"
          >
            {(['OFF', 'ON', 'ANY'] as const).map((m) => (
              <option key={m} value={m}>
                {t(`med.${m}`)}
              </option>
            ))}
          </select>
        </label>
        <Button
          disabled={plan.tests.length === 0 || plan.every_days < 1}
          onClick={() => void save()}
          data-testid="plan-save"
        >
          {t('app.save')}
        </Button>
      </div>
      {saved && <Notice testId="plan-saved">{t('doctor.planSaved')}</Notice>}
      <ErrorNote error={error} />
    </Card>
  );
}

type Period = '30' | '90' | '180' | '365' | 'all';
const PERIODS: Period[] = ['30', '90', '180', '365', 'all'];
const PERIOD_KEY = 'nc.patient.period';
function savedPeriod(): Period {
  try {
    const v = localStorage.getItem(PERIOD_KEY) as Period | null;
    return v && PERIODS.includes(v) ? v : '90';
  } catch {
    return '90';
  }
}
interface Remark {
  appointment_id: string;
  text: string;
  author_id: string;
  updated_at: string;
}

/** Decision 040: one note per appointment by its own doctor, kept at the hospital (connector). */
function VisitRemark({
  appointmentId,
  remark,
  mine,
  doctorName,
  onSaved,
}: {
  appointmentId: string;
  remark: Remark | undefined;
  mine: boolean;
  doctorName: string | null;
  onSaved: (r: Remark | null) => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(remark?.text ?? '');
  const [error, setError] = useState<unknown>(null);
  const save = async () => {
    setError(null);
    try {
      onSaved(
        await hospital<Remark | null>('PUT', `/v1/appointments/${appointmentId}/remark`, { text }),
      );
      setEditing(false);
    } catch (e) {
      setError(e);
    }
  };
  if (editing)
    return (
      <div className="flex flex-col gap-1.5 pl-3" data-testid="remark-editor">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={4000}
          rows={3}
          aria-label={t('remarks.label')}
          className="rounded-2xl border border-edge p-2 text-[14px]"
          data-testid="remark-text"
        />
        <ErrorNote error={error} />
        <div className="flex gap-2">
          <Button onClick={() => void save()} data-testid="remark-save">
            {t('remarks.save')}
          </Button>
          <Button variant="ghost" onClick={() => setEditing(false)}>
            {t('remarks.cancel')}
          </Button>
        </div>
      </div>
    );
  if (!remark && !mine) return null;
  return (
    <div
      className="ml-3 flex flex-col gap-1 rounded-xl bg-ground px-3 py-2 text-[13px]"
      data-testid="remark"
    >
      <span className="font-semibold">
        {t('remarks.label')}
        {remark && doctorName ? ` · ${doctorName} · ${fmtDate(remark.updated_at)}` : ''}
      </span>
      {remark ? (
        <span className="whitespace-pre-wrap">{remark.text}</span>
      ) : (
        <span className="text-muted">{t('remarks.none')}</span>
      )}
      {mine && (
        <Button
          variant="ghost"
          className="self-start"
          onClick={() => {
            setText(remark?.text ?? '');
            setEditing(true);
          }}
          data-testid="remark-edit"
        >
          {remark ? t('remarks.edit') : t('remarks.add')}
        </Button>
      )}
    </div>
  );
}

/** v3: the patient's appointments with the record links sent for them and what was recorded. */
function Timeline({ ncid }: { ncid: string }) {
  const { t } = useTranslation();
  const [h, setH] = useState<PlatformHistory | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [remarks, setRemarks] = useState<Record<string, Remark>>({});
  const [meId, setMeId] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>(savedPeriod);
  const pickPeriod = (v: Period) => {
    setPeriod(v);
    try {
      localStorage.setItem(PERIOD_KEY, v);
    } catch {
      /* not remembered */
    }
  };
  useEffect(() => {
    void call<PlatformHistory>('GET', `/hospital/patients/${ncid}/history`).then(setH, setError);
    void hospital<Remark[]>('GET', `/v1/patients/${ncid}/remarks`).then(
      (rs) => setRemarks(Object.fromEntries(rs.map((r) => [r.appointment_id, r]))),
      () => {},
    );
    void call<{ id: string }>('GET', '/staff/me').then(
      (m) => setMeId(m.id),
      () => {},
    );
  }, [ncid]);
  // Decision 040: upcoming appointments always; past ones within the chosen period.
  const [now] = useState(() => Date.now());
  const since = period === 'all' ? -Infinity : now - Number(period) * 86_400_000;
  const all = h?.appointments ?? [];
  const shown = all.filter((a) => {
    const at = new Date(a.at).getTime();
    return at >= now || at >= since;
  });
  const hidden = all.length - shown.length;
  const recorded = (requestId: string) =>
    (h?.sessions ?? []).filter((s) => s.request_id === requestId);
  const req = (r: Appointment['requests'][number]) => (
    <li key={r.id} className="flex flex-col gap-0.5 text-[13px]" data-testid="timeline-request">
      <span>
        {r.kind === 'rerecord' ? t('timeline.rerecord') : t('timeline.link')} ·{' '}
        {t(`timeline.place.${r.place ?? 'home'}`)} ·{' '}
        {r.tests.map((c) => t(`tests.${c}`)).join(', ')} · {t(`med.${r.med_state}`)}
      </span>
      <span className="text-muted">
        {t(`timeline.state.${r.state}`, {
          date: fmtDate(r.due_at),
          reason: r.not_done_reason
            ? t(`appts.notDone.${r.not_done_reason}`, { defaultValue: r.not_done_reason })
            : '',
        })}
        {recorded(r.id).map(
          (s) =>
            ` · ${t('timeline.uploaded', { n: s.takes_uploaded, date: fmtDate(s.started_at) })}` +
            (s.consent_source
              ? ` · ${t(`timeline.consent.${s.consent_source}`, {
                  reason: t(`clinicConsent.reason.${s.consent_reason ?? ''}`, {
                    defaultValue: s.consent_reason ?? '',
                  }),
                })}`
              : ''),
        )}
      </span>
    </li>
  );
  return (
    <Card title={t('timeline.title')} testId="timeline">
      <ErrorNote error={error} />
      {h?.withdrawn_at && (
        <Notice tone="warn" testId="timeline-withdrawn">
          {t('timeline.withdrawn', { date: fmtDate(h.withdrawn_at) })}
        </Notice>
      )}
      {h && h.appointments.length === 0 && h.other_requests.length === 0 && (
        <span className="text-[14px] text-muted">{t('timeline.none')}</span>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[13px] text-muted">{t('remarks.periodHint')}</span>
        <div
          role="group"
          aria-label={t('remarks.periodLabel')}
          className="flex overflow-hidden rounded-2xl border border-edge bg-card"
        >
          {PERIODS.map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={period === v}
              onClick={() => pickPeriod(v)}
              className={`min-h-11 px-3 text-[13px] font-semibold ${period === v ? 'bg-brand text-white' : 'text-ink'}`}
              data-testid={`period-${v}`}
            >
              {t(`remarks.period.${v}`)}
            </button>
          ))}
        </div>
      </div>
      <ol className="flex flex-col divide-y divide-line">
        {shown.map((a) => (
          <li key={a.id} className="flex flex-col gap-1.5 py-3" data-testid="timeline-appt">
            <div className="flex flex-wrap items-center gap-2 text-[14px]">
              <span className="font-semibold">{fmt(a.at)}</span>
              {a.doctor_name && <span className="text-muted">{a.doctor_name}</span>}
              <StageBadge a={a} />
            </div>
            <ul className="flex flex-col gap-1 pl-3">{a.requests.map(req)}</ul>
            <VisitRemark
              appointmentId={a.id}
              remark={remarks[a.id]}
              mine={!!meId && a.doctor_id === meId}
              doctorName={a.doctor_name}
              onSaved={(r) =>
                setRemarks((cur) => {
                  const next = { ...cur };
                  if (r) next[a.id] = r;
                  else delete next[a.id];
                  return next;
                })
              }
            />
          </li>
        ))}
        {hidden > 0 && (
          <li className="py-3 text-[13px] text-muted" data-testid="older-hidden">
            {t('remarks.hidden', { count: hidden })}
          </li>
        )}
        {(h?.other_requests ?? []).length > 0 && (
          <li className="py-3">
            <ul className="flex flex-col gap-1">{h!.other_requests.map(req)}</ul>
          </li>
        )}
      </ol>
    </Card>
  );
}
