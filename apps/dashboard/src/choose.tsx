/**
 * Doctor (v3): "Choose tests". Reception assigned these appointments to this doctor; the doctor
 * picks the tests (from the medical history, last time, or their own choice), the medicine state,
 * the record-by date and, only if wanted, "repeat every N days". Only then does the patient get the
 * record link. The history is read live from the hospital connector and not stored.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { call, hospital } from './api.ts';
import type { Appointment } from './appointments.tsx';
import { Button, Card, ErrorNote, Notice, Page, fmt, fmtDate } from './ui.tsx';

const TESTS = ['FT', 'FTF', 'FR', 'SAW', 'FA'];
const HANDS = ['FT', 'FTF', 'FR'];

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

export function ChooseTests({ meId, onCount }: { meId: string; onCount: (n: number) => void }) {
  const { t } = useTranslation();
  const [list, setList] = useState<Appointment[] | null>(null);
  const [ident, setIdent] = useState<Record<string, Ident>>({});
  const [sel, setSel] = useState<string | null>(null);
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
        if (off) return;
        setList(l);
        onCount(l.length);
        setIdent(Object.fromEntries(ids.map((i) => [i.ncid, i])));
        setSel((s) => (s && l.some((a) => a.id === s) ? s : (l[0]?.id ?? null)));
      } catch (e) {
        if (!off) setError(e);
      }
    })();
    return () => {
      off = true;
    };
  }, [meId, version, onCount]);

  const current = list?.find((a) => a.id === sel) ?? null;
  return (
    <Page title={t('choose.title')}>
      <p className="text-[14px] text-muted">{t('choose.hint')}</p>
      <ErrorNote error={error} />
      {notice && <Notice testId="notice">{notice}</Notice>}
      {list?.length === 0 && <Notice testId="choose-empty">{t('choose.empty')}</Notice>}
      <ul className="flex flex-col gap-2" data-testid="choose-list">
        {(list ?? []).map((a) => {
          const i = ident[a.ncid];
          return (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => setSel(a.id)}
                className={`flex w-full flex-wrap items-center justify-between gap-2 rounded-2xl bg-white px-4 py-3.5 text-left text-[14px] ${
                  a.id === sel ? 'border-2 border-brand' : 'border border-line'
                }`}
                data-testid={`choose-${i?.mrn ?? a.ncid}`}
              >
                <span>
                  <b>{fmt(a.at)}</b> · {i?.name ?? a.ncid}
                  {i ? ` · MRN ${i.mrn}` : ''}
                </span>
                <span className="rounded-xl bg-warn-soft px-2.5 py-0.5 text-[12px] font-bold text-warn">
                  {t('choose.waiting')}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {current && (
        <TestsForm
          key={current.id}
          a={current}
          onSent={() => {
            setNotice(t('choose.sent'));
            reload();
          }}
        />
      )}
    </Page>
  );
}

function TestsForm({ a, onSent }: { a: Appointment; onSent: () => void }) {
  const { t } = useTranslation();
  const [view, setView] = useState<LiveView | null>(null);
  const [last, setLast] = useState<{ tests: string[]; med: string; at: string } | null>(null);
  const [tests, setTests] = useState<string[]>(TESTS);
  const [med, setMed] = useState<'OFF' | 'ON' | 'ANY'>('OFF');
  const [due, setDue] = useState(dayBefore(a.at));
  const [repeat, setRepeat] = useState(false);
  // Where to record (user, 16 Nov 2026): at home (record link), in the clinic (operator queue), or both.
  const [home, setHome] = useState(true);
  const [clinic, setClinic] = useState(false);
  const [joined, setJoined] = useState<boolean | null>(null);
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    call<{ ncid: string; status: string }[]>('GET', '/hospital/patients').then((ps) => {
      const ok = ps.find((x) => x.ncid === a.ncid)?.status === 'active';
      setJoined(ok);
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

  return (
    <div className="flex flex-wrap items-start gap-5">
      <Card title={t('choose.fromHistory')} className="min-w-72 flex-1" testId="choose-history">
        <span className="text-[12px] text-muted">{t('doctor.fetchedNow')}</span>
        {view && !view.records_available && <Notice tone="warn">{t('doctor.unavailable')}</Notice>}
        {(['conditions', 'medications', 'encounters'] as const).map((k) =>
          (view?.[k] ?? []).length ? (
            <div key={k} className="flex flex-col gap-1 text-[14px]">
              <span className="text-[12px] font-semibold text-muted uppercase">
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
        <span className="text-[14px] text-[#3D4552]" data-testid="choose-last">
          {last
            ? t('choose.lastTime', {
                date: fmtDate(last.at),
                tests: last.tests.map((c) => t(`tests.${c}`)).join(', '),
                med: t(`med.${last.med}`),
              })
            : t('choose.firstTime')}
        </span>
      </Card>
      <Card
        title={t('choose.testsFor', { date: fmtDate(a.at) })}
        className="min-w-96 flex-[2]"
        testId="choose-form"
      >
        <div className="flex flex-wrap gap-2">
          {last && (
            <Button
              variant="secondary"
              onClick={() => {
                setTests(TESTS.filter((c) => last.tests.includes(c)));
                if (last.med === 'OFF' || last.med === 'ON' || last.med === 'ANY') setMed(last.med);
              }}
              data-testid="choose-same"
            >
              {t('choose.same')}
            </Button>
          )}
          <Button variant="secondary" onClick={() => setTests(HANDS)} data-testid="choose-hands">
            {t('choose.hands')}
          </Button>
          <Button variant="secondary" onClick={() => setTests(TESTS)} data-testid="choose-all">
            {t('choose.all')}
          </Button>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          {TESTS.map((c) => (
            <label key={c} className="flex min-h-11 items-center gap-2 text-[14px]">
              <input
                type="checkbox"
                checked={tests.includes(c)}
                onChange={(e) => toggle(c, e.target.checked)}
                className="size-5 accent-brand"
                data-testid={`choose-test-${c}`}
              />
              {t(`tests.${c}`)}
            </label>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-[13px] font-semibold text-[#3D4552]">
            {t('doctor.medState')}
            <select
              value={med}
              onChange={(e) => setMed(e.target.value as typeof med)}
              className="h-11 rounded-xl border border-[#C9CFD8] bg-white px-2 font-normal"
              data-testid="choose-med"
            >
              {(['OFF', 'ON', 'ANY'] as const).map((m) => (
                <option key={m} value={m}>
                  {t(`choose.med.${m}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <fieldset className="flex flex-col gap-2" data-testid="choose-where">
          <legend className="mb-1.5 text-[14px] font-bold">{t('choose.whereTitle')}</legend>
          <div
            className={`flex gap-3 rounded-xl px-4 py-3.5 ${home ? 'border-2 border-brand bg-[#F4F8FC]' : 'border border-[#C9CFD8]'} ${joined === false ? 'opacity-60' : ''}`}
          >
            <input
              type="checkbox"
              checked={home}
              disabled={joined === false}
              onChange={(e) => setHome(e.target.checked)}
              className="mt-0.5 size-5 accent-brand"
              id="choose-home"
              data-testid="choose-home"
            />
            <span className="flex flex-1 flex-col gap-2 text-[14px]">
              <label htmlFor="choose-home">
                <b>{t('choose.home')}</b> · {t('choose.homeHint')}
              </label>
              {joined === false && (
                <span className="text-[13px] text-warn" data-testid="choose-not-joined">
                  {t('choose.notJoined')}
                </span>
              )}
              {home && (
                <span className="flex flex-col gap-2">
                  <label className="flex flex-col gap-1 text-[13px] font-semibold text-[#3D4552]">
                    {t('choose.recordBy')}
                    <input
                      type="date"
                      value={due}
                      onChange={(e) => setDue(e.target.value)}
                      className="h-11 rounded-xl border border-[#C9CFD8] px-3 font-normal"
                      data-testid="choose-due"
                    />
                  </label>
                  <label className="flex min-h-11 flex-wrap items-center gap-2 text-[14px]">
                    <input
                      type="checkbox"
                      checked={repeat}
                      onChange={(e) => setRepeat(e.target.checked)}
                      className="size-5 accent-brand"
                      data-testid="choose-repeat"
                    />
                    {t('choose.repeatA')}
                    <input
                      type="number"
                      min={1}
                      max={90}
                      value={days}
                      aria-label={t('choose.days')}
                      onChange={(e) => setDays(Number(e.target.value))}
                      className="h-9 w-16 rounded-lg border border-[#C9CFD8] px-2"
                      data-testid="choose-days"
                    />
                    {t('choose.repeatB')}
                  </label>
                  <span className="text-[13px] text-muted">{t('choose.reminder')}</span>
                </span>
              )}
            </span>
          </div>
          <div
            className={`flex gap-3 rounded-xl px-4 py-3.5 ${clinic ? 'border-2 border-brand bg-[#F4F8FC]' : 'border border-[#C9CFD8]'}`}
          >
            <input
              type="checkbox"
              checked={clinic}
              onChange={(e) => setClinic(e.target.checked)}
              className="mt-0.5 size-5 accent-brand"
              id="choose-clinic"
              data-testid="choose-clinic"
            />
            <span className="flex flex-col gap-1 text-[14px]">
              <label htmlFor="choose-clinic">
                <b>{t('choose.clinic')}</b> · {t('choose.clinicHint')}
              </label>
              <span className="text-[13px] text-muted">
                {t('choose.clinicWhen', { date: fmtDate(a.at) })}
              </span>
            </span>
          </div>
        </fieldset>
        <ErrorNote error={error} />
        <Button
          className="self-start"
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
      </Card>
    </div>
  );
}
