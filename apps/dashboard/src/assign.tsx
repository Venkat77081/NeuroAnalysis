/**
 * Receptionist (M14): find the hospital's patients and assign or reassign them to doctors. Names
 * come live from the hospital connector; the platform stores only NCID → doctor.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { call, hospital } from './api.ts';
import { Badge, Button, Card, ErrorNote, Notice, Page, Table, fmtDate } from './ui.tsx';

interface Row {
  ncid: string;
  status: string;
  sessions: number;
  last_session_at: string | null;
  doctor_id: string | null;
}
interface Doctor {
  id: string;
  display_name: string | null;
  email: string;
  active: boolean;
  patients: number;
}
interface Ident {
  ncid: string;
  mrn: string;
  name: string | null;
}
interface RecordRow {
  mrn: string;
  name: string;
  ncid: string | null;
}

export function Assign() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Row[]>([]);
  const [docs, setDocs] = useState<Doctor[]>([]);
  const [ident, setIdent] = useState<Record<string, Ident>>({});
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [q, setQ] = useState('');
  const [found, setFound] = useState<RecordRow[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const [version, setVersion] = useState(0);
  const load = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    let off = false;
    Promise.all([
      call<Row[]>('GET', '/hospital/patients'),
      call<Doctor[]>('GET', '/hospital/doctors'),
    ])
      .then(async ([list, doctors]) => {
        const ids = list.length
          ? await hospital<Ident[]>('POST', '/v1/patients/lookup', {
              ncids: list.map((r) => r.ncid),
            })
          : [];
        if (off) return;
        setRows(list);
        setDocs(doctors.filter((d) => d.active));
        setIdent(Object.fromEntries(ids.map((i) => [i.ncid, i])));
      })
      .catch((e: unknown) => !off && setError(e));
    return () => {
      off = true;
    };
  }, [version]);

  const docName = (id: string | null) => {
    const d = docs.find((x) => x.id === id);
    return d ? (d.display_name ?? d.email) : null;
  };
  const save = async (ncid: string, doctorId: string | null) => {
    setError(null);
    try {
      await call('PUT', `/hospital/patients/${ncid}/doctor`, { doctor_id: doctorId });
      setSaved(ncid);
      load();
    } catch (e) {
      setError(e);
    }
  };
  const search = async () => {
    setError(null);
    try {
      setFound(await hospital<RecordRow[]>('GET', `/v1/patients?q=${encodeURIComponent(q)}`));
    } catch (e) {
      setError(e);
    }
  };
  const add = async (mrn: string) => {
    setError(null);
    try {
      await hospital('POST', '/v1/ncid', { mrn });
      setFound([]);
      setQ('');
      load();
    } catch (e) {
      setError(e);
    }
  };

  return (
    <Page title={t('assign.title')}>
      <Notice>{t('app.notStored')}</Notice>
      <ErrorNote error={error} />
      <Card title={t('assign.addTitle')}>
        <div className="flex gap-2">
          <input
            aria-label={t('hospital.search')}
            placeholder={t('hospital.search')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void search()}
            className="h-11 w-full max-w-md rounded-xl border border-[#C9CFD8] bg-white px-3 text-[14px]"
            data-testid="a-search"
          />
          <Button
            disabled={q.trim().length < 2}
            onClick={() => void search()}
            data-testid="a-search-btn"
          >
            {t('hospital.searchBtn')}
          </Button>
        </div>
        <ul className="flex flex-col gap-1" data-testid="a-found">
          {found.map((r) => (
            <li key={r.mrn} className="flex items-center gap-3 text-[14px]">
              <span className="font-semibold">{r.name}</span>
              <span className="text-muted">{r.mrn}</span>
              {r.ncid ? (
                <Badge tone="ok">{t('assign.listed')}</Badge>
              ) : (
                <Button
                  variant="secondary"
                  onClick={() => void add(r.mrn)}
                  data-testid={`a-add-${r.mrn}`}
                >
                  {t('assign.add')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Card>
      <Table
        head={[t('hospital.patient'), t('hospital.mrn'), t('assign.doctor'), '']}
        testId="assign-table"
      >
        {rows.map((r) => {
          const i = ident[r.ncid];
          const current = r.doctor_id;
          const pick = choice[r.ncid] ?? current ?? '';
          return (
            <tr
              key={r.ncid}
              className="border-t border-[#EDF0F3]"
              data-testid={`row-${i?.mrn ?? r.ncid}`}
            >
              <td className="px-4 py-3">
                <span className="font-semibold">
                  {i?.name ?? <code className="text-[12px] text-muted">{r.ncid}</code>}
                </span>
                <span className="block text-[12px] text-muted">
                  {t('doctor.sessions', { count: r.sessions })}
                  {r.last_session_at ? ` · ${fmtDate(r.last_session_at)}` : ''}
                </span>
              </td>
              <td className="px-4 py-3">{i?.mrn ?? ''}</td>
              <td className="px-4 py-3">
                <span className="mb-1 block text-[13px]" data-testid="assigned-to">
                  {docName(current) ?? t('assign.none')}
                </span>
                <select
                  aria-label={t('assign.doctor')}
                  value={pick}
                  onChange={(e) => setChoice({ ...choice, [r.ncid]: e.target.value })}
                  className="h-11 rounded-xl border border-[#C9CFD8] bg-white px-2 text-[14px]"
                  data-testid="a-doctor"
                >
                  <option value="">{t('assign.choose')}</option>
                  {docs.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.display_name ?? d.email}
                    </option>
                  ))}
                </select>
              </td>
              <td className="flex flex-wrap gap-2 px-4 py-3">
                <Button
                  disabled={!pick || pick === current}
                  onClick={() => void save(r.ncid, pick)}
                  data-testid="a-save"
                >
                  {current ? t('assign.reassign') : t('assign.assign')}
                </Button>
                {current && (
                  <Button
                    variant="ghost"
                    onClick={() => void save(r.ncid, null)}
                    data-testid="a-unassign"
                  >
                    {t('assign.unassign')}
                  </Button>
                )}
                {saved === r.ncid && <Badge tone="ok">{t('assign.saved')}</Badge>}
              </td>
            </tr>
          );
        })}
      </Table>
    </Page>
  );
}
