/**
 * M15 (decision 059): biomarkers on the doctor's patient page. The hospital connector analyses a
 * take (Finger Tapping so far) and keeps the result and the report; this page only asks for it and
 * shows the report. The report is decision support, not a diagnosis.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { hospital, hospitalText } from './api.ts';
import { testOrder } from './config.ts';
import { Button, Dialog, ErrorNote } from './ui.tsx';

export interface BiomarkerRun {
  take_id: string;
  test_code: string;
  status: 'running' | 'done' | 'failed';
  reason: string | null;
  requested_at: string;
  finished_at: string | null;
}
export interface BiomarkerCaps {
  installed: boolean;
  tests: string[];
}

/** How often a running analysis is checked (ms). */
const POLL_MS = 3000;

/** The connector's analysis for one patient: what it supports, each take's run, and "analyse". */
export function useBiomarkers(ncid: string) {
  const [caps, setCaps] = useState<BiomarkerCaps | null>(null);
  const [runs, setRuns] = useState<Record<string, BiomarkerRun>>({});
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(
    () =>
      hospital<BiomarkerRun[]>('GET', `/v1/patients/${ncid}/biomarkers`).then(
        (rs) => setRuns(Object.fromEntries(rs.map((r) => [r.take_id, r]))),
        () => undefined,
      ),
    [ncid],
  );
  useEffect(() => {
    // An older connector has no analysis at all: then nothing is offered.
    hospital<BiomarkerCaps>('GET', '/v1/biomarkers').then(setCaps, () =>
      setCaps({ installed: false, tests: [] }),
    );
    void load();
  }, [load]);
  const running = Object.values(runs).some((r) => r.status === 'running');
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [running, load]);
  const analyse = async (take: string, again = false) => {
    setError(null);
    try {
      const r = await hospital<BiomarkerRun>(
        'POST',
        `/v1/takes/${take}/biomarkers${again ? '?again=true' : ''}`,
      );
      setRuns((m) => ({ ...m, [take]: r }));
    } catch (e) {
      setError(e);
    }
  };
  return { caps, runs, analyse, error };
}

export type Biomarkers = ReturnType<typeof useBiomarkers>;

/** One recording's button: Analyse → Analysing… → Biomarker report (or Try again). */
export function BiomarkerAction({
  take,
  test,
  complete,
  bio,
  onOpen,
}: {
  take: string;
  test: string;
  complete: boolean;
  bio: Biomarkers;
  onOpen: (take: string) => void;
}) {
  const { t } = useTranslation();
  if (!complete || !bio.caps?.installed || !bio.caps.tests.includes(test)) return null;
  const run = bio.runs[take];
  if (run?.status === 'running')
    return (
      <Button variant="secondary" disabled data-testid={`bio-${take}`} data-state="running">
        {t('biomarkers.running')}
      </Button>
    );
  if (run?.status === 'done')
    return (
      <Button
        variant="secondary"
        onClick={() => onOpen(take)}
        data-testid={`bio-${take}`}
        data-state="done"
      >
        {t('biomarkers.open')}
      </Button>
    );
  return (
    <Button
      variant="secondary"
      onClick={() => void bio.analyse(take, run?.status === 'failed')}
      title={run?.status === 'failed' ? t('biomarkers.failedHint') : t('biomarkers.analyseHint')}
      data-testid={`bio-${take}`}
      data-state={run?.status ?? 'none'}
    >
      {run?.status === 'failed' ? t('biomarkers.retry') : t('biomarkers.analyse')}
    </Button>
  );
}

/** v34: the other finished reports from the same visit (session) as `take`, in protocol order. */
export function sessionReports(
  recs: { take_id: string; session_id: string; test_code: string }[],
  runs: Record<string, Pick<BiomarkerRun, 'status'>>,
  take: string,
): { take: string; test: string }[] {
  const sid = recs.find((r) => r.take_id === take)?.session_id;
  if (!sid) return [{ take, test: '' }];
  return recs
    .filter((r) => r.session_id === sid && runs[r.take_id]?.status === 'done')
    .sort((a, b) => testOrder.indexOf(a.test_code) - testOrder.indexOf(b.test_code))
    .map((r) => ({ take: r.take_id, test: r.test_code }));
}

/** v34: a chip on a recording tile: "Report" (opens it) or "Analysing". */
export function ReportChip({
  take,
  test,
  bio,
  onOpen,
}: {
  take: string;
  test: string;
  bio: Biomarkers;
  onOpen: (take: string) => void;
}) {
  const { t } = useTranslation();
  const run = bio.runs[take];
  if (run?.status === 'done')
    return (
      <button
        type="button"
        onClick={() => onOpen(take)}
        className="absolute top-1.5 left-1.5 rounded-lg bg-white/90 px-2 py-0.5 text-[11px] font-extrabold text-brand-ink shadow-sm hover:bg-white"
        data-testid={`rec-report-${test}`}
      >
        ◆ {t('biomarkers.reportChip')}
      </button>
    );
  if (run?.status === 'running')
    return (
      <span
        className="pointer-events-none absolute top-1.5 left-1.5 rounded-lg bg-white/90 px-2 py-0.5 text-[11px] font-extrabold text-warn"
        data-testid={`rec-report-${test}`}
        data-state="running"
      >
        ◷ {t('biomarkers.runningChip')}
      </span>
    );
  return null;
}

/** The report in a dialog: the connector's HTML in a sandboxed frame (no scripts, nothing loaded).
 * v34: with `others` (reports from the same visit), a switch moves between them. */
export function BiomarkerReport({
  take,
  title,
  others = [],
  onClose,
}: {
  take: string;
  title: string;
  others?: { take: string; test: string }[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState(take);
  // Loaded reports by take: switching shows "Loading" until that take's report arrives.
  const [loaded, setLoaded] = useState<Record<string, { html?: string; error?: unknown }>>({});
  useEffect(() => {
    let live = true;
    hospitalText(`/v1/takes/${current}/biomarkers/report`).then(
      (h) => live && setLoaded((m) => ({ ...m, [current]: { html: h } })),
      (e: unknown) => live && setLoaded((m) => ({ ...m, [current]: { error: e } })),
    );
    return () => {
      live = false;
    };
  }, [current]);
  const html = loaded[current]?.html ?? null;
  const error = loaded[current]?.error ?? null;
  return (
    <Dialog
      title={title}
      sub={t('biomarkers.reportSub')}
      size="lg"
      onClose={onClose}
      testId="bio-report"
    >
      {others.length > 1 && (
        <div
          className="inline-flex self-start rounded-full bg-soft p-1"
          role="group"
          aria-label={t('biomarkers.switchLabel')}
        >
          {others.map((o) => (
            <button
              key={o.take}
              type="button"
              aria-pressed={o.take === current}
              onClick={() => setCurrent(o.take)}
              className={`rounded-full px-3.5 py-1.5 text-[13px] font-semibold ${o.take === current ? 'bg-card text-ink shadow-sm' : 'text-sub'}`}
              data-testid={`bio-switch-${o.test}`}
            >
              {t(`tests.${o.test}`)}
            </button>
          ))}
        </div>
      )}
      <ErrorNote error={error} />
      {html === null && !error && (
        <span className="text-[14px] text-muted">{t('app.loading')}</span>
      )}
      {html !== null && (
        <iframe
          title={title}
          sandbox=""
          srcDoc={html}
          className="h-[70vh] w-full rounded-2xl border-0 bg-white"
          data-testid="bio-report-frame"
        />
      )}
    </Dialog>
  );
}
