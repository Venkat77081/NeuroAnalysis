/**
 * Doctor (M14): my patients (NCIDs from the platform + names live from the connector), a patient's
 * live history, recordings decrypted by the connector, review (note kept at the hospital),
 * re-record request and the home recording plan. Nothing about identity is stored by this page.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { call, hospital, hospitalFile } from './api.ts';
import { Badge, Button, Card, ErrorNote, Notice, Page, Table, fmt, fmtDate } from './ui.tsx';
import { StageBadge, type Appointment } from './appointments.tsx';
import { BiomarkerAction, BiomarkerReport, useBiomarkers } from './biomarkers.tsx';

interface PlatformPatient {
  ncid: string;
  status: string;
  sessions: number;
  last_session_at: string | null;
  /** Decision 061: their appointment moved to another doctor; this doctor may only view. */
  view_only?: boolean;
  moved_to?: string | null;
}
interface Ident {
  ncid: string;
  mrn: string;
  name: string | null;
  birth_date: string | null;
  sex: string | null;
  records_available: boolean;
}

export function MyPatients({ onOpen }: { onOpen: (ncid: string) => void }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<PlatformPatient[] | null>(null);
  const [ident, setIdent] = useState<Record<string, Ident>>({});
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    void (async () => {
      try {
        const list = await call<PlatformPatient[]>('GET', '/hospital/patients');
        setRows(list);
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
  return (
    <Page title={t('doctor.patientsTitle')}>
      <Notice>{t('app.notStored')}</Notice>
      <ErrorNote error={error} />
      {rows?.length === 0 && (
        <Notice tone="warn" testId="no-patients">
          {t('doctor.noPatients')}
        </Notice>
      )}
      <Table head={['', t('hospital.mrn'), '', '']} testId="my-patients">
        {(rows ?? []).map((p) => {
          const i = ident[p.ncid];
          return (
            <tr key={p.ncid} className="border-t border-[#EDF0F3]">
              <td className="px-4 py-3 font-semibold">
                {i?.name ?? <code className="text-[12px] text-muted">{p.ncid}</code>}
                {p.view_only && (
                  <span className="ml-2 align-middle" data-testid={`moved-${i?.mrn ?? p.ncid}`}>
                    <Badge tone="warn">
                      {t('moved.badge', { doctor: p.moved_to ?? t('moved.anotherDoctor') })}
                    </Badge>
                  </span>
                )}
              </td>
              <td className="px-4 py-3">{i?.mrn ?? ''}</td>
              <td className="px-4 py-3 text-[13px] text-muted">
                {t('doctor.sessions', { count: p.sessions })}
                {p.last_session_at
                  ? ` · ${t('doctor.lastSession', { date: fmtDate(p.last_session_at) })}`
                  : ''}
              </td>
              <td className="px-4 py-3">
                <Button
                  variant="secondary"
                  onClick={() => onOpen(p.ncid)}
                  data-testid={`open-${i?.mrn ?? p.ncid}`}
                >
                  {t('doctor.open')}
                </Button>
              </td>
            </tr>
          );
        })}
      </Table>
    </Page>
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
  /** Decision 061: who reviewed. */
  reviewer_name?: string | null;
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
  /** Decision 061: this doctor may only view (the appointment moved to another doctor). */
  view_only?: boolean;
  moved_to?: string | null;
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

export function PatientView({ ncid, onBack }: { ncid: string; onBack: () => void }) {
  const { t } = useTranslation();
  const [view, setView] = useState<View | null>(null);
  const [recs, setRecs] = useState<Recording[]>([]);
  const [reviews, setReviews] = useState<Record<string, Review>>({});
  const [error, setError] = useState<unknown>(null);
  const [playing, setPlaying] = useState<{ take: string; url: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // M15 (decision 059): biomarkers computed at the hospital; the report opens in a dialog.
  const bio = useBiomarkers(ncid);
  const [report, setReport] = useState<string | null>(null);
  // Decision 061: after a move to another doctor, this doctor may only view.
  const [access, setAccess] = useState<{ viewOnly: boolean; movedTo: string | null }>({
    viewOnly: false,
    movedTo: null,
  });

  useEffect(() => {
    call<PlatformHistory>('GET', `/hospital/patients/${ncid}/history`).then(
      (h) => setAccess({ viewOnly: !!h.view_only, movedTo: h.moved_to ?? null }),
      () => undefined,
    );
    hospital<View>('GET', `/v1/patients/${ncid}`).then(setView, setError);
    hospital<Recording[]>('GET', `/v1/patients/${ncid}/recordings`).then(setRecs, setError);
    hospital<Review[]>('GET', `/v1/patients/${ncid}/reviews`).then(
      (rs) => setReviews(Object.fromEntries([...rs].reverse().map((r) => [r.take_id, r]))),
      () => undefined,
    );
  }, [ncid]);
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

  return (
    <Page title={view?.name ?? ncid}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" onClick={onBack}>
          ← {t('app.back')}
        </Button>
        <span className="text-[13px] font-semibold text-ok">{t('app.live')}</span>
      </div>
      <Card testId="patient-header">
        <span className="text-[14px] text-muted" data-testid="patient-mrn">
          {view
            ? [`MRN ${view.mrn}`, view.birth_date && fmtDate(view.birth_date), view.sex]
                .filter(Boolean)
                .join(' · ')
            : ''}
        </span>
        <span className="text-[12px] text-muted">NCID {ncid}</span>
        <Notice>{t('app.notStored')}</Notice>
      </Card>
      <ErrorNote error={error} />
      {access.viewOnly && (
        <Notice tone="warn" testId="view-only">
          {t('moved.notice', { doctor: access.movedTo ?? t('moved.anotherDoctor') })}
        </Notice>
      )}
      {notice && <Notice testId="notice">{notice}</Notice>}
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
            <ul className="flex flex-col divide-y divide-[#EDF0F3]">
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
                        {reviews[r.take_id]!.reviewer_name
                          ? ` · ${reviews[r.take_id]!.reviewer_name}`
                          : ''}
                      </Badge>
                    )}
                    <span className="flex-1" />
                    <BiomarkerAction
                      take={r.take_id}
                      test={r.test_code}
                      complete={r.status === 'complete'}
                      bio={bio}
                      onOpen={setReport}
                    />
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
                  {playing?.take === r.take_id && (
                    <video
                      src={playing.url}
                      controls
                      className="w-full max-w-xl rounded-xl bg-black"
                      data-testid="player"
                    />
                  )}
                  {!access.viewOnly && (
                    <ReviewForm
                      take={r.take_id}
                      onSaved={(rv) => setReviews((m) => ({ ...m, [r.take_id]: rv }))}
                    />
                  )}
                </li>
              ))}
            </ul>
            {!access.viewOnly && (
              <Button
                variant="secondary"
                className="self-start"
                onClick={() => void rerecord()}
                data-testid="rerecord"
              >
                {t('doctor.rerecord')}
              </Button>
            )}
          </Card>
          <Timeline ncid={ncid} />
          {!access.viewOnly && <PlanEditor ncid={ncid} />}
          <Card title={t('doctor.biomarkerTitle')} testId="biomarkers">
            <ErrorNote error={bio.error} />
            <p className="text-[13px] text-muted">
              {bio.caps?.installed ? t('biomarkers.cardHint') : t('biomarkers.notInstalled')}
            </p>
            <p className="text-[13px] text-muted">{t('doctor.biomarkerHint')}</p>
          </Card>
        </div>
      </div>
      {report && (
        <BiomarkerReport
          take={report}
          title={`${t('doctor.biomarkerTitle')} · ${view?.name ?? ncid}`}
          onClose={() => setReport(null)}
        />
      )}
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
        className="h-11 min-w-48 flex-1 rounded-xl border border-[#C9CFD8] px-3"
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
        <label className="flex flex-col gap-1 text-[13px] font-semibold text-[#3D4552]">
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
            className="h-11 w-24 rounded-xl border border-[#C9CFD8] px-3"
            data-testid="plan-days"
          />
        </label>
        <label className="flex flex-col gap-1 text-[13px] font-semibold text-[#3D4552]">
          {t('doctor.medState')}
          <select
            value={plan.med_state}
            onChange={(e) => {
              setSaved(false);
              setPlan({ ...plan, med_state: e.target.value as Plan['med_state'] });
            }}
            className="h-11 rounded-xl border border-[#C9CFD8] bg-white px-2"
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
  id?: string;
  appointment_id: string;
  text: string;
  author_id: string;
  /** Decision 061: who wrote it; after a move, each doctor has their own remark. */
  author_name?: string | null;
  updated_at: string;
}

/** Decision 040, 061: remarks on one appointment, each with its author; the appointment's own
 * doctor writes or edits theirs (kept at the hospital, connector). */
function VisitRemark({
  appointmentId,
  remarks,
  mine,
  meId,
  onSaved,
}: {
  appointmentId: string;
  remarks: Remark[];
  /** This doctor may write on this appointment (their own, not view-only). */
  mine: boolean;
  meId: string | null;
  onSaved: (r: Remark | null) => void;
}) {
  const { t } = useTranslation();
  const own = remarks.find((r) => r.author_id === meId);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(own?.text ?? '');
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
          className="rounded-xl border border-[#C9CFD8] p-2 text-[14px]"
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
  if (remarks.length === 0 && !mine) return null;
  return (
    <div
      className="ml-3 flex flex-col gap-1.5 rounded-xl bg-ground px-3 py-2 text-[13px]"
      data-testid="remark"
    >
      <span className="font-semibold">{t('remarks.label')}</span>
      {remarks.length === 0 && <span className="text-muted">{t('remarks.none')}</span>}
      {remarks.map((r) => (
        <span key={r.id ?? r.author_id} className="flex flex-col" data-testid="remark-item">
          <span className="whitespace-pre-wrap">{r.text}</span>
          <span className="text-[12px] text-muted" data-testid="remark-author">
            {t('remarks.by', {
              name: r.author_name ?? t('remarks.aDoctor'),
              date: fmtDate(r.updated_at),
            })}
          </span>
        </span>
      ))}
      {mine && (
        <Button
          variant="ghost"
          className="self-start"
          onClick={() => {
            setText(own?.text ?? '');
            setEditing(true);
          }}
          data-testid="remark-edit"
        >
          {own ? t('remarks.edit') : t('remarks.add')}
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
  const [remarks, setRemarks] = useState<Remark[]>([]);
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
    void hospital<Remark[]>('GET', `/v1/patients/${ncid}/remarks`).then(setRemarks, () => {});
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
          className="flex overflow-hidden rounded-xl border border-[#C9CFD8] bg-white"
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
      <ol className="flex flex-col divide-y divide-[#EDF0F3]">
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
              remarks={remarks.filter((r) => r.appointment_id === a.id)}
              mine={!!meId && a.doctor_id === meId && !h?.view_only}
              meId={meId}
              onSaved={(r) =>
                setRemarks((cur) => [
                  ...cur.filter((x) => !(x.appointment_id === a.id && x.author_id === meId)),
                  ...(r ? [r] : []),
                ])
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
