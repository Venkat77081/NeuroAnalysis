/**
 * Doctor (v3): "Choose tests". Reception assigned these appointments to this doctor; the doctor
 * picks the tests (from the medical history, last time, or their own choice), the medicine state,
 * the record-by date and, only if wanted, "repeat every N days". Only then does the patient get the
 * record link. The history is read live from the hospital connector and not stored.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { takeOptions, takeSeconds } from './config.ts';
import { useSettings } from './changes.tsx';
import { call, hospital } from './api.ts';
import type { Appointment } from './appointments.tsx';
import { Avatar, Badge, Button, Dialog, ErrorNote, Notice, Page, fmt, fmtDate } from './ui.tsx';

const TESTS = ['FT', 'FTF', 'FR', 'SAW', 'FA'];
const HANDS = ['FT', 'FTF', 'FR'];
const TEST_ICON: Record<string, string> = { FT: '👆', FTF: '🤏', FR: '🔄', SAW: '🚶', FA: '🙂' };

interface Ident {
  ncid: string;
  mrn: string;
  name: string | null;
}
interface HistoryItem {
  text: string;
  date: string | null;
  detail: string | null;
}
interface LiveView {
  records_available: boolean;
  conditions: HistoryItem[];
  medications: HistoryItem[];
  encounters: HistoryItem[];
}
interface PlatformHistory {
  appointments: Appointment[];
  other_requests: Appointment['requests'];
}

/** The appointments waiting for this doctor's tests (for the inbox and the nav count). */
export async function waitingForTests(meId: string): Promise<Appointment[]> {
  const list = await call<Appointment[]>('GET', '/hospital/appointments?days=60');
  return list.filter((a) => a.stage === 'needs_tests' && a.doctor_id === meId);
}

const dayBefore = (iso: string) => {
  const d = new Date(iso);
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
};

/** Whole days from now until the visit (0 = today or past). */
export function daysUntil(at: string, now: number): number {
  const day = (ms: number) => {
    const d = new Date(ms);
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  };
  return Math.max(0, Math.round((day(Date.parse(at)) - day(now)) / 86_400_000));
}

export type ChooseFilter = 'all' | 'week' | 'moved' | 'noApp';
/** v32 (canvas v32): the chips above the cards. */
export function chooseMatch(
  a: Pick<Appointment, 'at' | 'suggested_tests'>,
  k: ChooseFilter,
  now: number,
  joined: boolean | undefined,
): boolean {
  if (k === 'week') return daysUntil(a.at, now) <= 7;
  if (k === 'moved') return !!a.suggested_tests;
  if (k === 'noApp') return joined === false;
  return true;
}

interface PatientRow {
  ncid: string;
  status: string;
  phone_unsuitable_fps: number | null;
}

/** Days left as a ring: red when the visit is a day away, amber within 3 days. */
function DaysRing({ days }: { days: number }) {
  const { t } = useTranslation();
  const c = days <= 1 ? 'var(--color-bad)' : days <= 3 ? 'var(--color-warn)' : 'var(--color-ok)';
  const pct = Math.max(10, Math.min(100, 100 - days * 12));
  return (
    <span
      className="relative inline-flex size-[52px] shrink-0 items-center justify-center rounded-full"
      style={{ background: `conic-gradient(${c} 0 ${pct}%, var(--color-line) 0)` }}
      role="img"
      aria-label={t('choose.daysLeft', { count: days })}
    >
      <span className="flex size-[40px] items-center justify-center rounded-full bg-card text-[13px] font-extrabold">
        {days === 0 ? t('choose.now') : t('choose.daysShort', { n: days })}
      </span>
    </span>
  );
}

export function ChooseTests({ meId, onCount }: { meId: string; onCount: (n: number) => void }) {
  const { t } = useTranslation();
  const [list, setList] = useState<Appointment[] | null>(null);
  const [ident, setIdent] = useState<Record<string, Ident>>({});
  const [pts, setPts] = useState<Record<string, PatientRow>>({});
  const [sel, setSel] = useState<string | null>(null);
  const [filter, setFilter] = useState<ChooseFilter>('all');
  const [late, setLate] = useState(false);
  const [now] = useState(() => Date.now());
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let off = false;
    void (async () => {
      try {
        const l = await waitingForTests(meId);
        const ids = l.length
          ? await hospital<Ident[]>('POST', '/v1/patients/lookup', {
              ncids: [...new Set(l.map((a) => a.ncid))],
            })
          : [];
        const ps = l.length ? await call<PatientRow[]>('GET', '/hospital/patients') : [];
        if (off) return;
        setList(l);
        onCount(l.length);
        setIdent(Object.fromEntries(ids.map((i) => [i.ncid, i])));
        setPts(Object.fromEntries(ps.map((p) => [p.ncid, p])));
      } catch (e) {
        if (!off) setError(e);
      }
    })();
    return () => {
      off = true;
    };
  }, [meId, version, onCount]);

  const joined = (ncid: string) => (pts[ncid] ? pts[ncid]!.status === 'active' : undefined);
  const count = (k: ChooseFilter) =>
    (list ?? []).filter((a) => chooseMatch(a, k, now, joined(a.ncid))).length;
  const shown = (list ?? [])
    .filter((a) => chooseMatch(a, filter, now, joined(a.ncid)))
    .sort((x, y) => (late ? -1 : 1) * x.at.localeCompare(y.at));
  const current = list?.find((a) => a.id === sel) ?? null;
  return (
    <Page title={t('choose.titleShort')}>
      <div className="-mt-2 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('choose.show')}>
          {(['all', 'week', 'moved', 'noApp'] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={filter === k}
              onClick={() => setFilter(k)}
              className={`min-h-9 rounded-full px-3.5 text-[13px] font-semibold ${filter === k ? 'bg-ink text-ground' : 'bg-card text-sub shadow-[inset_0_0_0_1px_var(--color-edge)]'}`}
              data-testid={`choose-filter-${k}`}
            >
              {t(`choose.filter.${k}`, { count: count(k) })}
            </button>
          ))}
        </div>
        <select
          value={late ? 'late' : 'soon'}
          onChange={(e) => setLate(e.target.value === 'late')}
          aria-label={t('choose.sort')}
          className="ml-auto h-10 rounded-xl bg-soft px-3 text-[13px] font-semibold"
          data-testid="choose-sort"
        >
          <option value="soon">{t('choose.soonest')}</option>
          <option value="late">{t('choose.latest')}</option>
        </select>
      </div>
      <p className="m-0 text-[14px] text-muted">{t('choose.hint')}</p>
      <ErrorNote error={error} />
      {notice && <Notice testId="notice">{notice}</Notice>}
      {list?.length === 0 && <Notice testId="choose-empty">{t('choose.empty')}</Notice>}
      {/* v32 (canvas v32): cards like the platform's Hospitals page; a card opens a side panel. */}
      <ul
        className="m-0 grid list-none grid-cols-1 gap-3.5 p-0 md:grid-cols-2 xl:grid-cols-3"
        data-testid="choose-list"
      >
        {shown.map((a) => {
          const i = ident[a.ncid];
          const p = pts[a.ncid];
          const ok = joined(a.ncid);
          return (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => setSel(a.id)}
                className={`nc-fu flex h-full w-full flex-col gap-3 rounded-3xl bg-card p-4 text-left shadow-card ${a.id === sel ? 'shadow-[0_0_0_2px_var(--color-brand),var(--shadow-card)]' : ''}`}
                data-testid={`choose-${i?.mrn ?? a.ncid}`}
              >
                <span className="flex items-center gap-3">
                  <Avatar name={i?.name ?? a.ncid} size={40} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <b className="truncate text-[14px]">{i?.name ?? a.ncid}</b>
                    <span className="truncate text-[12px] text-muted">
                      {i ? `MRN ${i.mrn}` : t('choose.namesHidden')}
                    </span>
                  </span>
                  <DaysRing days={daysUntil(a.at, now)} />
                </span>
                <b className="text-[14px]">{t('choose.visit', { when: fmt(a.at) })}</b>
                <span className="flex flex-wrap gap-1.5">
                  {a.suggested_tests ? (
                    <Badge tone="info">
                      {t('choose.movedChip', { doctor: a.suggested_tests.from_doctor_name ?? '—' })}
                    </Badge>
                  ) : (
                    <Badge tone="warn">{t('choose.notChosen')}</Badge>
                  )}
                  {ok === true && <Badge tone="ok">{t('choose.inApp')}</Badge>}
                  {ok === false &&
                    (p?.phone_unsuitable_fps != null ? (
                      <Badge tone="bad">
                        {t('choose.phoneFps', { fps: p.phone_unsuitable_fps.toFixed(0) })}
                      </Badge>
                    ) : (
                      <Badge tone="neutral">{t('choose.noApp')}</Badge>
                    ))}
                </span>
                <span className="text-[13px] text-sub">
                  {ok === false
                    ? t('choose.clinicOnly')
                    : t('choose.recordByLine', { date: fmtDate(dayBefore(a.at)) })}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {current && (
        <Dialog
          title={ident[current.ncid]?.name ?? current.ncid}
          sub={t('choose.visit', { when: fmt(current.at) })}
          size="side"
          onClose={() => setSel(null)}
          testId="choose-panel"
        >
          <TestsForm
            key={current.id}
            a={current}
            onSent={() => {
              setSel(null);
              setNotice(t('choose.sent'));
              reload();
            }}
          />
        </Dialog>
      )}
    </Page>
  );
}

function TestsForm({ a, onSent }: { a: Appointment; onSent: () => void }) {
  const { t } = useTranslation();
  const [view, setView] = useState<LiveView | null>(null);
  const [last, setLast] = useState<{ tests: string[]; med: string; at: string } | null>(null);
  // v14 (decision 046): moved from another doctor before recording: their choice is filled in
  // for this doctor to confirm.
  const sug = a.suggested_tests ?? null;
  const [tests, setTests] = useState<string[]>(
    sug ? TESTS.filter((c) => sug.tests.includes(c)) : TESTS,
  );
  const [med, setMed] = useState<'OFF' | 'ON' | 'ANY'>(
    sug && ['OFF', 'ON', 'ANY'].includes(sug.med_state)
      ? (sug.med_state as 'OFF' | 'ON' | 'ANY')
      : 'OFF',
  );
  const [due, setDue] = useState(dayBefore(a.at));
  const [repeat, setRepeat] = useState(false);
  // Where to record (user, 16 Nov 2026): at home (record link), in the clinic (operator queue), or both.
  const [home, setHome] = useState(sug ? sug.places.includes('home') : true);
  const [clinic, setClinic] = useState(sug ? sug.places.includes('clinic') : false);
  const [joined, setJoined] = useState<boolean | null>(null);
  const [unsuitableFps, setUnsuitableFps] = useState<number | null>(null);
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // v31 (decision 054): each test's length: the hospital's (Settings) unless changed here.
  const settings = useSettings();
  const [own, setOwn] = useState<Record<string, number>>({});
  const len = (c: string) => own[c] ?? settings?.test_durations?.[c] ?? takeSeconds[c] ?? 15;

  useEffect(() => {
    call<{ ncid: string; status: string; phone_unsuitable_fps: number | null }[]>(
      'GET',
      '/hospital/patients',
    ).then((ps) => {
      const p = ps.find((x) => x.ncid === a.ncid);
      const ok = p?.status === 'active';
      setJoined(ok);
      setUnsuitableFps(ok ? null : (p?.phone_unsuitable_fps ?? null));
      if (!ok) {
        setHome(false); // not in the app: only the clinic can record
        setClinic(true);
      }
    }, setError);
    hospital<LiveView>('GET', `/v1/patients/${a.ncid}`).then(setView, setError);
    call<PlatformHistory>('GET', `/hospital/patients/${a.ncid}/history`).then((h) => {
      const reqs = [...h.appointments.flatMap((x) => x.requests), ...h.other_requests]
        .filter((r) => r.state !== 'cancelled')
        .sort((x, y) => y.created_at.localeCompare(x.created_at));
      const r = reqs[0];
      if (r) setLast({ tests: r.tests, med: r.med_state, at: r.created_at });
    }, setError);
  }, [a.ncid]);

  const toggle = (c: string, on: boolean) =>
    setTests((cur) =>
      on ? TESTS.filter((x) => x === c || cur.includes(x)) : cur.filter((x) => x !== c),
    );
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await call('POST', `/hospital/appointments/${a.id}/request`, {
        tests,
        durations: Object.fromEntries(tests.map((c) => [c, len(c)])),
        med_state: med,
        places: [...(home ? ['home'] : []), ...(clinic ? ['clinic'] : [])],
        // Record by the end of that day (local time); home links only.
        due_at: new Date(`${due}T23:59:00`).toISOString(),
        ...(home && repeat ? { repeat_every_days: days } : {}),
      });
      onSent();
    } catch (e) {
      setError(e);
    }
    setBusy(false);
  };

  const where: 'home' | 'clinic' | 'both' = home && clinic ? 'both' : clinic ? 'clinic' : 'home';
  const setWhere = (w: 'home' | 'clinic' | 'both') => {
    setHome(w !== 'clinic');
    setClinic(w !== 'home');
  };
  const row = 'flex flex-wrap items-center gap-3 border-t border-line py-2.5';
  const label = (title: string, hint?: string) => (
    <span className="flex min-w-0 flex-1 flex-col">
      <b className="text-[14px]">{title}</b>
      {hint && <span className="text-[12px] text-muted">{hint}</span>}
    </span>
  );
  const first = view?.conditions[0]?.text;
  const drug = view?.medications[0]?.text;
  // v32 (canvas v32): the side panel: tests as tick rows with their lengths, then where, medicine,
  // record-by and repeat, and the send bar at the bottom.
  return (
    <div className="flex flex-col gap-3" data-testid="choose-form">
      <div className="flex flex-wrap items-center gap-2">
        {(first || drug) && (
          <Badge tone="neutral">{[first, drug].filter(Boolean).join(' · ')}</Badge>
        )}
        {last && (
          <Button
            variant="secondary"
            className="min-h-9 bg-brand-soft px-3 text-[13px] text-brand-ink shadow-none"
            onClick={() => {
              setTests(TESTS.filter((c) => last.tests.includes(c)));
              if (last.med === 'OFF' || last.med === 'ON' || last.med === 'ANY') setMed(last.med);
            }}
            data-testid="choose-same"
          >
            {t('choose.sameDate', { date: fmtDate(last.at) })}
          </Button>
        )}
        <Button
          variant="secondary"
          className="min-h-9 px-3 text-[13px]"
          onClick={() => setTests(HANDS)}
          data-testid="choose-hands"
        >
          {t('choose.handsShort')}
        </Button>
        <Button
          variant="secondary"
          className="min-h-9 px-3 text-[13px]"
          onClick={() => setTests(TESTS)}
          data-testid="choose-all"
        >
          {t('choose.all')}
        </Button>
      </div>
      {sug && (
        <Notice tone="warn" testId="choose-moved">
          {t('choose.movedFrom', { doctor: sug.from_doctor_name ?? '—' })}
        </Notice>
      )}
      <div className="flex items-baseline justify-between gap-2">
        <b className="text-[14px]">{t('choose.testsHead')}</b>
        <span className="text-[12px] text-muted">{t('choose.lengthsHint')}</span>
      </div>
      <div className="flex flex-col gap-1.5">
        {TESTS.map((c) => {
          const on = tests.includes(c);
          return (
            <label
              key={c}
              className={`flex min-h-12 cursor-pointer items-center gap-2.5 rounded-2xl px-3 py-1.5 ${on ? 'bg-brand-soft shadow-[inset_0_0_0_1.5px_var(--color-brand)]' : 'bg-soft'}`}
            >
              <input
                type="checkbox"
                checked={on}
                onChange={(e) => toggle(c, e.target.checked)}
                className="size-5 accent-brand"
                data-testid={`choose-test-${c}`}
              />
              <span aria-hidden className="text-[18px]">
                {TEST_ICON[c]}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <b className="text-[14px]">{t(`tests.${c}`)}</b>
                {c === 'SAW' && (
                  <span className="text-[11px] text-muted">{t('choose.helper')}</span>
                )}
              </span>
              {on && (takeOptions[c]?.length ?? 0) > 1 ? (
                <select
                  value={len(c)}
                  onClick={(e) => e.preventDefault()}
                  onChange={(e) => setOwn((o) => ({ ...o, [c]: Number(e.target.value) }))}
                  aria-label={t('choose.lengthFor', { test: t(`tests.${c}`) })}
                  className="h-8 rounded-xl bg-card px-2 text-[12px] font-bold"
                  data-testid={`choose-length-${c}`}
                >
                  {takeOptions[c]!.map((o) => (
                    <option key={o} value={o}>
                      {t('choose.lengthOption', { s: o })}
                      {o === (settings?.test_durations?.[c] ?? takeSeconds[c])
                        ? ` · ${t('choose.lengthHospital')}`
                        : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="text-[12px] text-muted">
                  {t('choose.lengthOption', { s: len(c) })}
                </span>
              )}
            </label>
          );
        })}
      </div>
      <div className="flex flex-col" data-testid="choose-where">
        <div className={row}>
          {label(t('choose.whereTitle'), t('choose.whereHint'))}
          <span
            role="group"
            aria-label={t('choose.whereTitle')}
            className="inline-flex rounded-full bg-card p-1 shadow-[inset_0_0_0_1px_var(--color-edge)]"
          >
            {(['home', 'clinic', 'both'] as const).map((w) => (
              <button
                key={w}
                type="button"
                aria-pressed={where === w}
                disabled={w !== 'clinic' && joined === false}
                onClick={() => setWhere(w)}
                className={`min-h-9 rounded-full px-3.5 text-[13px] font-bold disabled:opacity-40 ${where === w ? 'bg-ink text-ground' : 'text-sub'}`}
                data-testid={`choose-where-${w}`}
              >
                {t(`choose.where.${w}`)}
              </button>
            ))}
          </span>
        </div>
        {joined === false && (
          <span className="pb-2 text-[13px] text-warn" data-testid="choose-not-joined">
            {unsuitableFps !== null
              ? t('choose.phoneUnsuitable', { fps: unsuitableFps.toFixed(0) })
              : t('choose.notJoined')}
          </span>
        )}
        {clinic && (
          <span className="pb-2 text-[12px] text-muted">
            {t('choose.clinicWhen', { date: fmtDate(a.at) })}
          </span>
        )}
        <div className={row}>
          {label(t('doctor.medState'), t('choose.medHint'))}
          <select
            value={med}
            onChange={(e) => setMed(e.target.value as typeof med)}
            className="h-10 rounded-xl bg-soft px-2 text-[13px] font-semibold"
            data-testid="choose-med"
          >
            {(['OFF', 'ON', 'ANY'] as const).map((m) => (
              <option key={m} value={m}>
                {t(`choose.med.${m}`)}
              </option>
            ))}
          </select>
        </div>
        {home && (
          <>
            <div className={row}>
              {label(t('choose.recordBy'), t('choose.reminderShort'))}
              <input
                type="date"
                value={due}
                onChange={(e) => setDue(e.target.value)}
                aria-label={t('choose.recordBy')}
                className="h-10 rounded-xl bg-soft px-2 text-[13px] font-semibold"
                data-testid="choose-due"
              />
            </div>
            <div className={row}>
              {label(
                t('choose.repeatTitle'),
                repeat ? t('choose.repeatOn', { n: days }) : t('choose.repeatOff'),
              )}
              <label className="flex items-center gap-1.5 text-[13px] font-semibold text-sub">
                {t('choose.every')}
                <input
                  type="number"
                  min={1}
                  max={90}
                  value={days}
                  aria-label={t('choose.days')}
                  onChange={(e) => setDays(Number(e.target.value))}
                  className="h-10 w-16 rounded-xl bg-soft px-2 text-[13px] font-semibold"
                  data-testid="choose-days"
                />
                {t('choose.days')}
              </label>
              <input
                type="checkbox"
                role="switch"
                checked={repeat}
                onChange={(e) => setRepeat(e.target.checked)}
                aria-label={t('choose.repeatTitle')}
                className="relative h-[26px] w-11 shrink-0 cursor-pointer appearance-none rounded-full bg-edge transition before:absolute before:top-[3px] before:left-[3px] before:size-5 before:rounded-full before:bg-white before:shadow before:transition checked:bg-brand checked:before:translate-x-[18px]"
                data-testid="choose-repeat"
              />
            </div>
          </>
        )}
      </div>
      <details
        className="rounded-2xl bg-soft px-3.5 py-2.5 text-[13px]"
        data-testid="choose-history"
      >
        <summary className="cursor-pointer font-bold">{t('choose.fromHistory')}</summary>
        <div className="mt-2 flex flex-col gap-2">
          <span className="text-[12px] text-muted">{t('doctor.fetchedNow')}</span>
          {view && !view.records_available && (
            <Notice tone="warn">{t('doctor.unavailable')}</Notice>
          )}
          {(['conditions', 'medications', 'encounters'] as const).map((k) =>
            (view?.[k] ?? []).length ? (
              <div key={k} className="flex flex-col gap-0.5">
                <span className="text-[11px] font-semibold text-muted uppercase">
                  {t(`doctor.${k}`)}
                </span>
                {view![k].map((h, i) => (
                  <span key={i}>
                    {[h.text, h.detail, h.date && fmtDate(h.date)].filter(Boolean).join(' · ')}
                  </span>
                ))}
              </div>
            ) : null,
          )}
          <span className="text-sub" data-testid="choose-last">
            {last
              ? t('choose.lastTime', {
                  date: fmtDate(last.at),
                  tests: last.tests.map((c) => t(`tests.${c}`)).join(', '),
                  med: t(`med.${last.med}`),
                })
              : t('choose.firstTime')}
          </span>
        </div>
      </details>
      <ErrorNote error={error} />
      <div className="sticky bottom-0 flex items-center gap-3 rounded-[20px] bg-soft px-4 py-3 shadow-[0_-14px_18px_var(--color-card)]">
        <span className="flex min-w-0 flex-1 flex-col">
          <b className="text-[15px]" data-testid="choose-summary">
            {t('choose.summary', {
              count: tests.length,
              min: Math.max(1, Math.round(tests.reduce((n, c) => n + len(c) * 3, 60) / 60)),
            })}
          </b>
          <span className="text-[12px] text-sub">{t('choose.fps')}</span>
        </span>
        <Button
          disabled={
            busy ||
            tests.length === 0 ||
            (!home && !clinic) ||
            (home && (!due || (repeat && (days < 1 || days > 90))))
          }
          onClick={() => void send()}
          data-testid="choose-send"
        >
          {home && clinic
            ? t('choose.sendBoth')
            : clinic
              ? t('choose.sendClinic')
              : t('choose.send')}
        </Button>
      </div>
    </div>
  );
}
