/**
 * M15 (decision 059): biomarkers on the doctor's patient page. The hospital connector analyses a
 * take (Finger Tapping so far) and keeps the result and the report; this page only asks for it and
 * shows the report. The report is decision support, not a diagnosis.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { hospital, hospitalText } from './api.ts';
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

/** The report in a dialog: the connector's HTML in a sandboxed frame (no scripts, nothing loaded). */
export function BiomarkerReport({
  take,
  title,
  onClose,
}: {
  take: string;
  title: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    hospitalText(`/v1/takes/${take}/biomarkers/report`).then(setHtml, setError);
  }, [take]);
  return (
    <Dialog
      title={title}
      sub={t('biomarkers.reportSub')}
      size="lg"
      onClose={onClose}
      testId="bio-report"
    >
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
