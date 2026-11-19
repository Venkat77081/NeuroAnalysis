/**
 * Front desk: join invites. Patients are found live in the hospital's records (through the
 * connector) and invited by e-mail (QR and link), SMS (paid by the hospital) or a printed QR handed
 * over at the visit. The contact details are read and used at the connector only; the platform
 * never receives them. Used on "Invite patients" and on the Appointments page.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { hospital } from './api.ts';
import { Badge, Button, Card, ErrorNote, Notice, Page, Table } from './ui.tsx';

interface RecordRow {
  mrn: string;
  name: string;
  has_email: boolean;
  has_phone: boolean;
  ncid: string | null;
  app_status: string | null;
}
interface InviteResult {
  mrn: string;
  result: string;
  ncid: string | null;
  qr_png_base64: string | null;
}

type Via = 'email' | 'sms' | 'print';

/** The three ways to send a join invite, the send button and the results (with QR for print). */
export function InviteBox({
  mrns,
  title,
  onSent,
}: {
  mrns: string[];
  title: string;
  onSent?: (results: InviteResult[]) => void;
}) {
  const { t } = useTranslation();
  const [via, setVia] = useState<Via>('email');
  const [results, setResults] = useState<InviteResult[]>([]);
  // Sent once for these patients: the results (and printed QR codes) stay on screen.
  const [sentFor, setSentFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await hospital<InviteResult[]>('POST', '/v1/invites', { mrns, channel: via });
      setResults(r);
      setSentFor(mrns.join());
      onSent?.(r);
    } catch (e) {
      setError(e);
    }
    setBusy(false);
  };
  return (
    <Card title={title} testId="p-invite">
      {(['email', 'sms', 'print'] as const).map((v) => (
        <label key={v} className="flex min-h-11 items-center gap-2 text-[14px]">
          <input
            type="radio"
            name="via"
            checked={via === v}
            onChange={() => setVia(v)}
            className="size-5 accent-brand"
            data-testid={`via-${v}`}
          />
          {t(`hospital.via${v[0]!.toUpperCase()}${v.slice(1)}`)}
        </label>
      ))}
      <ErrorNote error={error} />
      <Button
        className="self-start"
        disabled={busy || mrns.length === 0 || sentFor === mrns.join()}
        onClick={() => void send()}
        data-testid="p-send"
      >
        {t('hospital.send')}
      </Button>
      {results.length > 0 && (
        <ul className="flex flex-col gap-2" data-testid="p-invite-results">
          {results.map((r) => (
            <li key={r.mrn} className="flex flex-wrap items-center gap-3 text-[14px]">
              <span className="font-semibold">{r.mrn}</span>
              <Badge tone={r.result === 'sent' || r.result === 'printed' ? 'ok' : 'warn'}>
                {t(`hospital.result_${r.result}`)}
              </Badge>
              {r.qr_png_base64 && (
                <img
                  src={`data:image/png;base64,${r.qr_png_base64}`}
                  alt={t('invite.qrAlt', { mrn: r.mrn })}
                  width={160}
                  height={160}
                  data-testid="invite-qr"
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Front desk: find patients in the hospital's records and send them a join invite. */
export function InvitePatients({ initialQuery }: { initialQuery?: string } = {}) {
  const { t } = useTranslation();
  // v28: opened from the ⌘K search with a patient's MRN.
  const [q, setQ] = useState(initialQuery ?? '');
  const [rows, setRows] = useState<RecordRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<unknown>(null);
  const search = async () => {
    setError(null);
    try {
      setRows(await hospital<RecordRow[]>('GET', `/v1/patients?q=${encodeURIComponent(q.trim())}`));
    } catch (e) {
      setError(e);
    }
  };
  useEffect(() => {
    // Only when opened from the ⌘K search.
    if (!initialQuery || initialQuery.trim().length < 2) return;
    let off = false;
    hospital<RecordRow[]>('GET', `/v1/patients?q=${encodeURIComponent(initialQuery.trim())}`).then(
      (r) => !off && setRows(r),
      (e: unknown) => !off && setError(e),
    );
    return () => {
      off = true;
    };
  }, [initialQuery]);
  const toggle = (mrn: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(mrn)) n.delete(mrn);
      else n.add(mrn);
      return n;
    });
  return (
    <Page title={t('invite.title')}>
      <Notice>{t('app.notStored')}</Notice>
      <ErrorNote error={error} />
      <div className="flex gap-2">
        <input
          aria-label={t('hospital.search')}
          placeholder={t('hospital.search')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && q.trim().length >= 2 && void search()}
          className="h-11 w-full max-w-md rounded-2xl border border-edge bg-card px-3 text-[14px]"
          data-testid="p-search"
        />
        <Button
          disabled={q.trim().length < 2}
          onClick={() => void search()}
          data-testid="p-search-btn"
        >
          {t('hospital.searchBtn')}
        </Button>
      </div>
      <Table
        head={[
          '',
          t('hospital.patient'),
          t('hospital.mrn'),
          t('hospital.email'),
          t('hospital.mobile'),
          t('hospital.appStatus'),
        ]}
        testId="p-results"
      >
        {rows.map((r) => (
          <tr key={r.mrn} className="border-t border-line">
            <td className="px-4 py-3">
              <input
                type="checkbox"
                aria-label={`Select ${r.mrn}`}
                checked={selected.has(r.mrn)}
                onChange={() => toggle(r.mrn)}
                className="size-5 accent-brand"
                data-testid={`p-sel-${r.mrn}`}
              />
            </td>
            <td className="px-4 py-3 font-semibold">{r.name}</td>
            <td className="px-4 py-3">{r.mrn}</td>
            <td className="px-4 py-3">
              {r.has_email ? (
                t('invite.yes')
              ) : (
                <span className="font-semibold text-bad">{t('hospital.missing')}</span>
              )}
            </td>
            <td className="px-4 py-3">
              {r.has_phone ? (
                t('invite.yes')
              ) : (
                <span className="font-semibold text-bad">{t('hospital.missing')}</span>
              )}
            </td>
            <td className="px-4 py-3">
              {r.app_status ? (
                <Badge tone={r.app_status === 'active' ? 'ok' : 'neutral'}>{r.app_status}</Badge>
              ) : (
                t('hospital.notInvited')
              )}
            </td>
          </tr>
        ))}
      </Table>
      {selected.size > 0 && (
        <InviteBox
          mrns={[...selected]}
          title={t('hospital.via', { n: selected.size })}
          onSent={() => void search()}
        />
      )}
    </Page>
  );
}
