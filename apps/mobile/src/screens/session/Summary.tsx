import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApp } from '../../app/AppContext.tsx';
import { maskRef } from '../../data/repo.ts';
import { stepTakes, summarizeOutcomes } from '../../session/machine.ts';
import { useSession } from '../../session/useSession.ts';
import { Button, Card } from '../../ui/kit.tsx';
import { stepTitle } from './TestIntro.tsx';

const chip: Record<string, string> = {
  accepted: 'bg-ok-soft text-[#145F38]',
  kept: 'bg-warn-soft text-warn',
  skipped: 'bg-[#EDF0F3] text-[#3D4552]',
  pending: 'bg-[#EDF0F3] text-muted',
};

export function Summary() {
  const { t } = useTranslation();
  const { newSession } = useApp();
  const { ctx, send } = useSession();
  const counts = summarizeOutcomes(ctx);
  const [now] = useState(() => Date.now());
  const minutes = ctx.startedAt
    ? Math.max(1, Math.round((now - Date.parse(ctx.startedAt)) / 60000))
    : 0;

  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col bg-ground">
      <header className="flex flex-col gap-1 px-5 pt-5 pb-2">
        <h1 className="m-0 text-[26px] font-bold">{t('session.summary.title')}</h1>
        <span className="text-sm text-muted">
          {t('session.summary.meta', {
            ref: ctx.patient ? maskRef(ctx.patient.ref) : '—',
            med: ctx.medState ?? '—',
            min: minutes,
          })}
        </span>
      </header>
      <main className="flex flex-1 flex-col gap-3 px-5 pt-1">
        <div className="grid grid-cols-3 gap-2" data-testid="summary-counts">
          <Card className="!p-3">
            <span className="block text-[22px] font-bold text-ok">{counts.passed}</span>
            <span className="text-xs text-muted">{t('session.summary.passed')}</span>
          </Card>
          <Card className="!p-3">
            <span className="block text-[22px] font-bold text-warn">{counts.kept}</span>
            <span className="text-xs text-muted">{t('session.summary.kept')}</span>
          </Card>
          <Card className="!p-3">
            <span className="block text-[22px] font-bold text-muted">{counts.skipped}</span>
            <span className="text-xs text-muted">{t('session.summary.skipped')}</span>
          </Card>
        </div>
        <ol
          className="m-0 list-none overflow-hidden rounded-2xl border border-line bg-white p-0"
          data-testid="summary-rows"
        >
          {ctx.plan.map((p, i) => {
            const o = ctx.outcomes[i]!;
            const n = stepTakes(ctx, i).filter((x) => x.verdict !== 'INTERRUPTED').length;
            const detail =
              o.status === 'kept'
                ? t('session.summary.reason', { reason: t(`session.reasons.override.${o.reason}`) })
                : o.status === 'skipped'
                  ? t('session.summary.reason', { reason: t(`session.reasons.skip.${o.reason}`) })
                  : t('session.summary.takes', { count: n });
            return (
              <li
                key={i}
                className="flex items-center gap-3 border-b border-[#EDF0F3] px-3.5 py-2.5 last:border-b-0"
              >
                <span className="min-w-10 rounded-md bg-brand-soft px-1.5 py-0.5 text-center text-xs font-bold text-brand">
                  {p.code}
                </span>
                <span className="flex flex-1 flex-col">
                  <span className="text-sm font-semibold">{stepTitle(t, p.code, p.side)}</span>
                  <span className="text-xs text-muted">{detail}</span>
                </span>
                <span className={`rounded-full px-2 py-1 text-xs font-bold ${chip[o.status]}`}>
                  {t(`session.summary.status.${o.status}`)}
                </span>
              </li>
            );
          })}
        </ol>
        <p className="m-0 text-[13px] text-muted">{t('session.summary.stored')}</p>
      </main>
      <footer className="px-5 pt-3 pb-6">
        <Button
          className="h-14 w-full text-[17px]"
          onClick={() => {
            send({ type: 'FINISH', at: new Date().toISOString() });
            void newSession();
          }}
          data-testid="end-session"
        >
          {t('session.summary.end')}
        </Button>
      </footer>
    </div>
  );
}
