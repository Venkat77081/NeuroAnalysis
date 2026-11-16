/**
 * Reception: appointments that need a recording, added by hand (user, 16 Nov 2026: nothing is read
 * from the hospital's appointment system, which also holds ortho, cardio and other visits). The
 * platform keeps a time, a patient NCID and a doctor only. The doctor then chooses the tests and
 * where to record: at home (record link) and/or in the clinic (clinic phones' queue). Names and
 * MRNs come live from the connector and are never stored here.
 */
import { Fragment, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { call, hospital } from './api.ts';
import { Badge, Button, Card, ErrorNote, Field, Notice, Page, Table, fmt, fmtDate } from './ui.tsx';
import { InviteBox } from './invites.tsx';
import { describe, roleText } from './activity.tsx';
import { usePerms } from './perms.ts';

export type Stage =
  'needs_doctor' | 'needs_tests' | 'sent' | 'recorded' | 'missed' | 'not_recorded' | 'cancelled';

export interface RequestOut {
  id: string;
  kind: 'appointment' | 'rerecord';
  place: 'home' | 'clinic';
  not_done_reason: string | null;
  tests: string[];
  med_state: string;
  due_at: string;
  state: 'open' | 'recorded' | 'missed' | 'cancelled' | 'not_recorded';
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
  /** Who added it by hand (null: from the hospital system). */
  booked_by_name: string | null;
  last_event: HistoryEvent | null;
}
export interface HistoryEvent {
  at: string;
  action: string;
  actor_name: string;
  actor_email: string | null;
  actor_role: string;
  details: Record<string, unknown>;
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

const STAGE_TONE: Record<Stage, 'ok' | 'warn' | 'bad' | 'neutral'> = {
  needs_doctor: 'warn',
  needs_tests: 'neutral',
  sent: 'warn',
  recorded: 'ok',
  missed: 'bad',
  not_recorded: 'bad',
  cancelled: 'neutral',
};

export function StageBadge({ a }: { a: Appointment }) {
  const { t } = useTranslation();
  const live = a.requests.filter((r) => r.state !== 'cancelled');
  if (
    a.stage === 'needs_doctor' ||
    a.stage === 'needs_tests' ||
    a.stage === 'cancelled' ||
    !live.length
  )
    return (
      <span data-testid="appt-stage">
        <Badge tone={STAGE_TONE[a.stage]}>{t(`appts.stage.${a.stage}`)}</Badge>
      </span>
    );
  // One badge per place (home link, clinic queue): both may be asked for.
  return (
    <span className="flex flex-col items-start gap-1" data-testid="appt-stage">
      {live.map((r) => (
        <Badge
          key={r.id}
          tone={r.state === 'recorded' ? 'ok' : r.state === 'open' ? 'warn' : 'bad'}
        >
          {t(`appts.req.${r.place}.${r.state}`, {
            date: fmtDate(r.place === 'clinic' ? a.at : r.due_at),
            reason: r.not_done_reason
              ? t(`appts.notDone.${r.not_done_reason}`, { defaultValue: r.not_done_reason })
              : '',
          })}
        </Badge>
      ))}
    </span>
  );
}

/** Where the doctor asked to record: home link, clinic queue, or both. */
export function WhereBadges({ a }: { a: Appointment }) {
  const { t } = useTranslation();
  const places = [
    ...new Set(a.requests.filter((r) => r.state !== 'cancelled').map((r) => r.place)),
  ];
  if (!places.length) return <span className="text-muted">—</span>;
  return (
    <span className="flex flex-col items-start gap-1" data-testid="appt-where">
      {places.map((p) => (
        <Badge key={p} tone="neutral">
          {t(`appts.where.${p}`)}
        </Badge>
      ))}
    </span>
  );
}

export function Appointments() {
  const { t } = useTranslation();
  // Decision 033: what this person may do here (set per hospital).
  const perms = usePerms();
  const canAdd = perms.has('appointments.add');
  const canAssign = perms.has('appointments.assign');
  const canInvite = perms.has('invites.send');
  const [appts, setAppts] = useState<Appointment[] | null>(null);
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
  /** The patient reception is inviting (the three ways show below the table). */
  /** The appointment whose history is open. */
  const [open, setOpen] = useState<string | null>(null);
  const [inviting, setInviting] = useState<{ mrn: string; name: string } | null>(null);
  const invite = (mrn: string, name: string | null) => {
    setNotice(null);
    setInviting({ mrn, name: name ?? `MRN ${mrn}` });
  };
  const docName = (d: Doctor) => d.display_name ?? d.email;
  const joined = (ncid: string) => app[ncid] === 'active';

  return (
    <Page title={t('appts.title')}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-[13px] text-muted">{t('appts.window')}</span>
      </div>
      <Notice>{t('app.notStored')}</Notice>
      <ErrorNote error={error} />
      {notice && <Notice testId="notice">{notice}</Notice>}
      {canAdd && (
        <ManualAppointment
          docs={docs}
          canAssign={canAssign}
          onAdded={() => {
            setNotice(t('appts.added'));
            reload();
          }}
        />
      )}
      <Table
        head={[
          t('appts.when'),
          t('appts.patient'),
          t('appts.app'),
          t('appts.doctor'),
          t('appts.whereTitle'),
          t('appts.status'),
          t('appts.lastChange'),
          '',
        ]}
        testId="appointments"
      >
        {(appts ?? []).map((a) => {
          const i = ident[a.ncid];
          return (
            <Fragment key={a.id}>
              <tr className="border-t border-[#EDF0F3]" data-testid={`appt-${i?.mrn ?? a.ncid}`}>
                <td className="px-4 py-3 font-semibold">
                  {fmt(a.at)}
                  <span className="block text-[12px] font-normal text-muted">
                    {a.source === 'manual' && a.booked_by_name
                      ? t('appts.addedBy', { name: a.booked_by_name })
                      : t(`appts.source.${a.source}`)}
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
                  {canAssign && (a.stage === 'needs_doctor' || a.stage === 'needs_tests') ? (
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
                  <WhereBadges a={a} />
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-col items-start gap-1.5">
                    <StageBadge a={a} />
                    {canInvite && !joined(a.ncid) && i && a.stage !== 'cancelled' && (
                      <Button
                        variant="secondary"
                        onClick={() => invite(i.mrn, i.name)}
                        data-testid="appt-invite"
                      >
                        {t('appts.sendInvite')}
                      </Button>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3 text-[13px]" data-testid="appt-last">
                  {a.last_event && (
                    <>
                      {describe(t, a.last_event.action, a.last_event.details)}
                      <span className="block text-muted">
                        {a.last_event.actor_name} · {fmt(a.last_event.at)}
                      </span>
                    </>
                  )}
                </td>
                <td className="px-4 py-3">
                  <Button
                    variant="secondary"
                    aria-expanded={open === a.id}
                    onClick={() => setOpen(open === a.id ? null : a.id)}
                    data-testid="appt-history-btn"
                  >
                    {open === a.id ? t('appts.hideHistory') : t('appts.history')}
                  </Button>
                </td>
              </tr>
              {open === a.id && (
                <tr>
                  <td colSpan={8} className="bg-[#F9FBFD] px-4 pb-4">
                    <AppointmentHistory id={a.id} />
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </Table>
      {appts?.length === 0 && (
        <Notice tone="warn" testId="no-appointments">
          {t('appts.none')}
        </Notice>
      )}
      {inviting && (
        <InviteBox
          key={inviting.mrn}
          mrns={[inviting.mrn]}
          title={t('appts.inviteFor', { name: inviting.name })}
          onSent={() => reload()}
        />
      )}
    </Page>
  );
}

function ManualAppointment({
  docs,
  canAssign,
  onAdded,
}: {
  docs: Doctor[];
  canAssign: boolean;
  onAdded: () => void;
}) {
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
      setDoctor('');
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
        {canAssign && (
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
        )}
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

/** Who did what for one appointment, oldest first (user, 16 Nov 2026). */
export function AppointmentHistory({ id }: { id: string }) {
  const { t } = useTranslation();
  const [events, setEvents] = useState<HistoryEvent[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    call<HistoryEvent[]>('GET', `/hospital/appointments/${id}/history`).then(setEvents, setError);
  }, [id]);
  return (
    <div className="flex flex-col gap-2">
      <ErrorNote error={error} />
      <ol
        aria-label={t('appts.historyLabel')}
        className="flex flex-col gap-2.5 rounded-xl border border-line bg-white px-4 py-3.5 text-[13px]"
        data-testid="appt-history"
      >
        {(events ?? []).map((e, n) => (
          <li key={n} className="grid grid-cols-[120px_1fr] gap-3">
            <span className="text-muted">{fmt(e.at)}</span>
            <span>
              <b>{describe(t, e.action, e.details)}</b> · {t('appts.by')} {e.actor_name}{' '}
              <span className="text-muted">
                ({[e.actor_email, roleText(t, e.actor_role)].filter(Boolean).join(' · ')})
              </span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
