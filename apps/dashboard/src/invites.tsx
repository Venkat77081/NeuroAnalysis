/**
 * Front desk: join invites. Patients are found live in the hospital's records (through the
 * connector) and invited by e-mail (QR and link), SMS (paid by the hospital) or a printed QR handed
 * over at the visit. The contact details are read and used at the connector only; the platform
 * never receives them. Used on "Invite patients" and on the Appointments page.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { hospital } from './api.ts';
import { Avatar, Badge, Button, Card, ErrorNote, Page } from './ui.tsx';

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
      <span className="text-[13px] font-semibold text-sub">{t('invite.sendBy')}</span>
      <div className="flex flex-wrap gap-2">
        {(['email', 'sms', 'print'] as const).map((v) => (
          <label
            key={v}
            className={`flex min-h-10 cursor-pointer items-center gap-2 rounded-full px-3.5 text-[14px] font-semibold ${via === v ? 'bg-brand-soft text-brand-ink' : 'bg-card shadow-[inset_0_0_0_1px_var(--color-edge)]'}`}
          >
            <input
              type="radio"
              name="via"
              checked={via === v}
              onChange={() => setVia(v)}
              className="size-4 accent-brand"
              data-testid={`via-${v}`}
            />
            {t(`hospital.via${v[0]!.toUpperCase()}${v.slice(1)}`)}
          </label>
        ))}
      </div>
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
  const first = rows.find((r) => selected.has(r.mrn));
  return (
    <Page title={t('invite.title')} sub={t('invite.sub')}>
      <ErrorNote error={error} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card title={t('invite.who')}>
            <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-sub">
              {t('invite.find')}
              <span className="flex gap-2">
                <input
                  aria-label={t('hospital.search')}
                  placeholder={t('hospital.search')}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && q.trim().length >= 2 && void search()}
                  className="h-11 w-full rounded-2xl border border-transparent bg-soft px-3.5 text-[14px] font-normal text-ink outline-none focus:border-brand"
                  data-testid="p-search"
                />
                <Button
                  disabled={q.trim().length < 2}
                  onClick={() => void search()}
                  data-testid="p-search-btn"
                >
                  {t('hospital.searchBtn')}
                </Button>
              </span>
            </label>
            <div className="flex flex-col gap-2" data-testid="p-results">
              {rows.map((r) => {
                const on = selected.has(r.mrn);
                return (
                  <label
                    key={r.mrn}
                    className={`flex cursor-pointer flex-wrap items-center gap-3 rounded-[18px] p-3 ${on ? 'shadow-[inset_0_0_0_2px_var(--color-brand)]' : 'shadow-[inset_0_0_0_1px_var(--color-edge)]'}`}
                  >
                    <input
                      type="checkbox"
                      aria-label={`Select ${r.mrn}`}
                      checked={on}
                      onChange={() => toggle(r.mrn)}
                      className="size-5 accent-brand"
                      data-testid={`p-sel-${r.mrn}`}
                    />
                    <Avatar name={r.name} size={40} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <b className="text-[14px]">{r.name}</b>
                      <span className="text-[12px] text-muted">
                        MRN {r.mrn} · {t('invite.email')}{' '}
                        {r.has_email ? t('invite.yes') : t('hospital.missing')} ·{' '}
                        {t('invite.mobile')} {r.has_phone ? t('invite.yes') : t('hospital.missing')}
                      </span>
                    </span>
                    {r.app_status ? (
                      <Badge tone={r.app_status === 'active' ? 'ok' : 'neutral'}>
                        {r.app_status}
                      </Badge>
                    ) : (
                      <Badge tone="neutral">{t('hospital.notInvited')}</Badge>
                    )}
                  </label>
                );
              })}
              {rows.length === 0 && (
                <span className="text-[13px] text-muted">{t('invite.searchHint')}</span>
              )}
            </div>
            <span className="text-[12px] text-muted">{t('app.notStored')}</span>
          </Card>
          {selected.size > 0 && (
            <InviteBox
              mrns={[...selected]}
              title={t('hospital.via', { n: selected.size })}
              onSent={() => void search()}
            />
          )}
        </div>
        <Card title={t('invite.gets', { name: first?.name ?? t('invite.patient') })}>
          <div className="mx-auto flex h-[420px] w-[280px] flex-col gap-2.5 rounded-[36px] border-8 border-ink bg-soft px-3.5 py-4">
            <span className="text-center text-[12px] text-muted">{t('invite.phoneTop')}</span>
            <span className="max-w-[220px] self-start rounded-[18px_18px_18px_4px] bg-card px-3.5 py-3 text-[13px] leading-[19px]">
              {t('invite.preview')}
            </span>
          </div>
          <span className="text-center text-[12px] text-muted">{t('invite.previewNote')}</span>
        </Card>
      </div>
    </Page>
  );
}
