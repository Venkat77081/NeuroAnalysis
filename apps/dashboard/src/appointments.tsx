/**
 * Reception (v3): the hospital's appointments, read live from its system through the connector
 * (FHIR or SQL) and kept on the platform as a time, a patient NCID and a doctor only; or entered by
 * hand when the hospital system does not send them. Reception assigns the doctor; the appointment
 * then waits for that doctor to choose the tests. The patient gets the record link only when the
 * doctor sends it. Names and MRNs come live from the connector and are never stored here.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, call, hospital } from './api.ts';
import { Badge, Button, Card, ErrorNote, Field, Notice, Page, Table, fmt, fmtDate } from './ui.tsx';

export type Stage = 'needs_doctor' | 'needs_tests' | 'sent' | 'recorded' | 'missed' | 'cancelled';

export interface RequestOut {
  id: string;
  kind: 'appointment' | 'rerecord';
  tests: string[];
  med_state: string;
  due_at: string;
  state: 'open' | 'recorded' | 'missed' | 'cancelled';
  created_at: string;
}
export interface Appointment {
  id: string;
  ncid: string;
  at: string;
  doctor_id: string | null;
  doctor_name: string | null;
  source: 'manual' | 'fhir';
  status: 'booked' | 'cancelled';
  stage: Stage;
  requests: RequestOut[];
}
interface LiveRow {
  external_id: string;
  at: string;
  mrn: string;
  name: string | null;
  ncid: string | null;
  practitioner: string | null;
}
interface PatientRow {
  ncid: string;
  status: string;
}
interface Doctor {
  id: string;
  display_name: string | null;
  email: string;
  active: boolean;
}
interface Ident {
  ncid: string;
  mrn: string;
  name: string | null;
}
interface Found {
  mrn: string;
  name: string;
  ncid: string | null;
}
interface InviteResult {
  mrn: string;
  result: string;
  invite_link: string | null;
}

const STAGE_TONE: Record<Stage, 'ok' | 'warn' | 'bad' | 'neutral'> = {
  needs_doctor: 'warn',
  needs_tests: 'neutral',
  sent: 'warn',
  recorded: 'ok',
  missed: 'bad',
  cancelled: 'neutral',
};

export function StageBadge({ a }: { a: Appointment }) {
  const { t } = useTranslation();
  const open = a.requests.filter((r) => r.state === 'open').pop();
  return (
    <span data-testid="appt-stage">
      <Badge tone={STAGE_TONE[a.stage]}>
        {a.stage === 'sent' && open
          ? t('appts.stage.sentDue', { date: fmtDate(open.due_at) })
          : t(`appts.stage.${a.stage}`)}
      </Badge>
    </span>
  );
}

export function Appointments() {
  const { t } = useTranslation();
  const [appts, setAppts] = useState<Appointment[] | null>(null);
  const [notJoined, setNotJoined] = useState<LiveRow[]>([]);
  const [live, setLive] = useState<'ok' | 'off' | 'down' | null>(null);
  const [app, setApp] = useState<Record<string, string>>({});
  const [docs, setDocs] = useState<Doctor[]>([]);
  const [ident, setIdent] = useState<Record<string, Ident>>({});
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let off = false;
    void (async () => {
      try {
        // Live list from the hospital system; appointments of patients with an NCID are kept
        // (idempotent: the platform matches them by a hash of the hospital's appointment ID).
        let rows: LiveRow[] = [];
        let state: 'ok' | 'off' | 'down' = 'ok';
        try {
          rows = await hospital<LiveRow[]>('GET', '/v1/appointments');
        } catch (e) {
          state = e instanceof ApiError && e.status === 501 ? 'off' : 'down';
        }
        for (const r of rows.filter((x) => x.ncid))
          await call('POST', '/hospital/appointments', {
            ncid: r.ncid,
            at: r.at,
            source: 'fhir',
            external_id: r.external_id,
          });
        const [list, doctors, patients] = await Promise.all([
          call<Appointment[]>('GET', '/hospital/appointments'),
          call<Doctor[]>('GET', '/hospital/doctors'),
          call<PatientRow[]>('GET', '/hospital/patients'),
        ]);
        const ncids = [...new Set(list.map((a) => a.ncid))];
        const ids = ncids.length
          ? await hospital<Ident[]>('POST', '/v1/patients/lookup', { ncids })
          : [];
        if (off) return;
        setLive(state);
        setNotJoined(rows.filter((x) => !x.ncid));
        setAppts(list);
        setDocs(doctors.filter((d) => d.active));
        setApp(Object.fromEntries(patients.map((p) => [p.ncid, p.status])));
        setIdent(Object.fromEntries(ids.map((i) => [i.ncid, i])));
      } catch (e) {
        if (!off) setError(e);
      }
    })();
    return () => {
      off = true;
    };
  }, [version]);

  const assign = async (a: Appointment) => {
    setError(null);
    try {
      await call('PUT', `/hospital/appointments/${a.id}`, { doctor_id: choice[a.id] });
      setNotice(t('appts.assigned'));
      reload();
    } catch (e) {
      setError(e);
    }
  };
  const invite = async (mrn: string) => {
    setError(null);
    try {
      let [r] = await hospital<InviteResult[]>('POST', '/v1/invites', {
        mrns: [mrn],
        channel: 'email',
      });
      if (r?.result === 'skipped_no_email')
        [r] = await hospital<InviteResult[]>('POST', '/v1/invites', {
          mrns: [mrn],
          channel: 'sms',
        });
      setNotice(t(`appts.invite.${r?.result ?? 'failed'}`, { defaultValue: r?.result ?? '' }));
      reload();
    } catch (e) {
      setError(e);
    }
  };
  const docName = (d: Doctor) => d.display_name ?? d.email;
  const joined = (ncid: string) => app[ncid] === 'active';

  return (
    <Page title={t('appts.title')}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-[13px] text-muted">{t('appts.window')}</span>
        {live && (
          <span
            className={`text-[13px] font-semibold ${live === 'ok' ? 'text-ok' : 'text-warn'}`}
            data-testid="appts-live"
          >
            {t(`appts.live.${live}`)}
          </span>
        )}
      </div>
      <Notice>{t('app.notStored')}</Notice>
      <ErrorNote error={error} />
      {notice && <Notice testId="notice">{notice}</Notice>}
      <Table
        head={[
          t('appts.when'),
          t('appts.patient'),
          t('appts.app'),
          t('appts.doctor'),
          t('appts.status'),
        ]}
        testId="appointments"
      >
        {(appts ?? []).map((a) => {
          const i = ident[a.ncid];
          return (
            <tr
              key={a.id}
              className="border-t border-[#EDF0F3]"
              data-testid={`appt-${i?.mrn ?? a.ncid}`}
            >
              <td className="px-4 py-3 font-semibold">
                {fmt(a.at)}
                <span className="block text-[12px] font-normal text-muted">
                  {t(`appts.source.${a.source}`)}
                </span>
              </td>
              <td className="px-4 py-3">
                {i?.name ?? <code className="text-[12px] text-muted">{a.ncid}</code>}
                {i && <span className="block text-[12px] text-muted">MRN {i.mrn}</span>}
              </td>
              <td className="px-4 py-3">
                <Badge tone={joined(a.ncid) ? 'ok' : 'neutral'}>
                  {t(joined(a.ncid) ? 'appts.joined' : 'appts.notJoined')}
                </Badge>
              </td>
              <td className="px-4 py-3">
                {a.stage === 'needs_doctor' || a.stage === 'needs_tests' ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      aria-label={t('appts.doctor')}
                      value={choice[a.id] ?? a.doctor_id ?? ''}
                      onChange={(e) => setChoice((c) => ({ ...c, [a.id]: e.target.value }))}
                      className="h-11 rounded-xl border border-[#C9CFD8] bg-white px-2"
                      data-testid="appt-doctor"
                    >
                      <option value="">{t('assign.choose')}</option>
                      {docs.map((d) => (
                        <option key={d.id} value={d.id}>
                          {docName(d)}
                        </option>
                      ))}
                    </select>
                    {choice[a.id] && choice[a.id] !== a.doctor_id && (
                      <Button onClick={() => void assign(a)} data-testid="appt-assign">
                        {t(a.doctor_id ? 'assign.reassign' : 'appts.assign')}
                      </Button>
                    )}
                  </div>
                ) : (
                  a.doctor_name
                )}
              </td>
              <td className="px-4 py-3">
                <div className="flex flex-col items-start gap-1.5">
                  <StageBadge a={a} />
                  {!joined(a.ncid) && i && a.stage !== 'cancelled' && (
                    <Button
                      variant="secondary"
                      onClick={() => void invite(i.mrn)}
                      data-testid="appt-invite"
                    >
                      {t('appts.sendInvite')}
                    </Button>
                  )}
                </div>
              </td>
            </tr>
          );
        })}
        {notJoined.map((r) => (
          <tr
            key={r.external_id}
            className="border-t border-[#EDF0F3] bg-[#F9FBFD]"
            data-testid={`live-${r.mrn}`}
          >
            <td className="px-4 py-3 font-semibold">
              {fmt(r.at)}
              <span className="block text-[12px] font-normal text-muted">
                {t('appts.source.fhir')}
              </span>
            </td>
            <td className="px-4 py-3">
              {r.name}
              <span className="block text-[12px] text-muted">MRN {r.mrn}</span>
            </td>
            <td className="px-4 py-3">
              <Badge>{t('appts.notJoined')}</Badge>
            </td>
            <td className="px-4 py-3 text-[13px] text-muted">{r.practitioner}</td>
            <td className="px-4 py-3">
              <Button
                variant="secondary"
                onClick={() => void invite(r.mrn)}
                data-testid="live-invite"
              >
                {t('appts.sendInvite')}
              </Button>
            </td>
          </tr>
        ))}
      </Table>
      {appts?.length === 0 && notJoined.length === 0 && (
        <Notice tone="warn" testId="no-appointments">
          {t('appts.none')}
        </Notice>
      )}
      <ManualAppointment
        docs={docs}
        onAdded={() => {
          setNotice(t('appts.added'));
          reload();
        }}
      />
    </Page>
  );
}

function ManualAppointment({ docs, onAdded }: { docs: Doctor[]; onAdded: () => void }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Found[]>([]);
  const [who, setWho] = useState<Found | null>(null);
  const [at, setAt] = useState('');
  const [doctor, setDoctor] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const search = async () => {
    setError(null);
    try {
      setFound(await hospital<Found[]>('GET', `/v1/patients?q=${encodeURIComponent(q.trim())}`));
    } catch (e) {
      setError(e);
    }
  };
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const { ncid } = await hospital<{ ncid: string }>('POST', '/v1/ncid', { mrn: who!.mrn });
      await call('POST', '/hospital/appointments', {
        ncid,
        at: new Date(at).toISOString(),
        doctor_id: doctor || null,
        source: 'manual',
      });
      setWho(null);
      setFound([]);
      setQ('');
      setAt('');
      onAdded();
    } catch (e) {
      setError(e);
    }
    setBusy(false);
  };
  return (
    <Card title={t('appts.manualTitle')} testId="manual" className="max-w-3xl">
      <span className="text-[14px] text-[#3D4552]">{t('appts.manualHint')}</span>
      <div className="flex flex-wrap items-end gap-3">
        <Field
          id="appt-q"
          label={t('appts.findPatient')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          data-testid="manual-q"
        />
        <Button
          variant="secondary"
          disabled={q.trim().length < 2}
          onClick={() => void search()}
          data-testid="manual-search"
        >
          {t('appts.search')}
        </Button>
      </div>
      {found.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {found.map((f) => (
            <li key={f.mrn}>
              <Button
                variant={who?.mrn === f.mrn ? 'primary' : 'secondary'}
                onClick={() => setWho(f)}
                data-testid={`manual-pick-${f.mrn}`}
              >
                {f.name} · MRN {f.mrn}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <Field
          id="appt-at"
          type="datetime-local"
          label={t('appts.dateTime')}
          value={at}
          onChange={(e) => setAt(e.target.value)}
          data-testid="manual-at"
        />
        <label className="flex flex-col gap-1 text-[13px] font-semibold text-[#3D4552]">
          {t('appts.doctor')}
          <select
            value={doctor}
            onChange={(e) => setDoctor(e.target.value)}
            className="h-11 rounded-xl border border-[#C9CFD8] bg-white px-2 font-normal"
            data-testid="manual-doctor"
          >
            <option value="">{t('assign.choose')}</option>
            {docs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.display_name ?? d.email}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="text-[13px] leading-[19px] text-muted">{t('appts.afterAssign')}</p>
      <ErrorNote error={error} />
      <Button
        className="self-start"
        disabled={busy || !who || !at}
        onClick={() => void add()}
        data-testid="manual-add"
      >
        {t('appts.addAndAssign')}
      </Button>
    </Card>
  );
}
