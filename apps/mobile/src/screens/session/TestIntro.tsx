import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApp } from '../../app/AppContext.tsx';
import { speak, stopSpeaking } from '../../guidance/audio.ts';
import { useSession } from '../../session/useSession.ts';
import { SELF_REF } from '../../session/machine.ts';
import { BackButton, Button, Card, Check } from '../../ui/kit.tsx';
import { SkipSheet } from './SkipSheet.tsx';

export function stepTitle(t: (k: string) => string, code: string, side: 'R' | 'L' | null): string {
  return side ? `${t(`tests.${code}`)} · ${t(`session.sides.${side}`)}` : t(`tests.${code}`);
}

export function TestIntro() {
  const { t, i18n } = useTranslation();
  const { config } = useApp();
  const { ctx, send } = useSession();
  const step = ctx.plan[ctx.index]!;
  const cfg = config.tests.get(step.code)!;
  const [done, setDone] = useState<Record<string, boolean>>({});
  const [skipping, setSkipping] = useState(false);
  const [ending, setEnding] = useState(false);
  const outcome = ctx.outcomes[ctx.index]!;
  const steps = cfg.instructions.stepKeys.map((k) => t(`session.steps.${k}`));
  const [dMin, dMax] = cfg.setup.distanceM;
  // M13: at home the walking test needs a helper to hold the phone (config/platform.json).
  const [helper, setHelper] = useState(false);
  const needHelper =
    ctx.patient?.ref === SELF_REF &&
    step.code === 'SAW' &&
    config.platform.app.homeSawNeedsHelper &&
    !helper &&
    outcome.status === 'pending';

  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col bg-ground">
      <header className="flex flex-col gap-2.5 px-5 pt-3 pb-2">
        <div className="flex items-center justify-between">
          {ctx.index > 0 ? (
            <span data-testid="prev-test">
              <BackButton
                onClick={() => {
                  void stopSpeaking();
                  send({ type: 'PREV_STEP' });
                }}
                label={t('session.intro.prev')}
              />
            </span>
          ) : (
            <span className="w-11" />
          )}
          <span className="text-[13px] font-semibold text-muted" data-testid="test-of">
            {t('session.intro.testOf', { n: ctx.index + 1, of: ctx.plan.length })}
          </span>
          <button
            type="button"
            onClick={() => setEnding(true)}
            className="h-12 rounded-full px-3 text-[13px] font-semibold text-bad"
            data-testid="end-early"
          >
            {t('session.intro.end')}
          </button>
        </div>
        {/* New UI: one segment per test (done, this one, still to come). */}
        <div className="flex gap-1.5" aria-hidden data-testid="test-progress">
          {ctx.plan.map((_, i) => (
            <span
              key={i}
              className={`h-1.5 flex-1 rounded-full ${i < ctx.index ? 'bg-ok' : i === ctx.index ? 'bg-brand' : 'bg-line'}`}
            />
          ))}
        </div>
      </header>

      <main className="flex flex-1 flex-col gap-3.5 px-5 pt-1">
        {outcome.status !== 'pending' && (
          <div
            className="flex items-center justify-between gap-3 rounded-2xl bg-brand-soft px-4 py-3"
            data-testid="step-done"
          >
            <span className="text-sm">
              {t('session.intro.done', { status: t(`session.summary.status.${outcome.status}`) })}
            </span>
            <Button
              variant="secondary"
              onClick={() => {
                void stopSpeaking();
                send({ type: 'NEXT_STEP' });
              }}
              data-testid="next-test"
            >
              {t('session.intro.next')}
            </Button>
          </div>
        )}
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-col gap-1.5">
            <h1 className="m-0 text-[26px] font-bold" data-testid="test-title">
              {t(`tests.${step.code}`)}
            </h1>
            {step.side && (
              <span className="self-start rounded-full bg-brand-soft px-2.5 py-1 text-[13px] font-semibold text-brand">
                {t(
                  step.code === 'FT' || step.code === 'FR' || step.code === 'FTF'
                    ? `session.sideHand.${step.side}`
                    : `session.sides.${step.side}`,
                )}
              </span>
            )}
          </div>
          <Button
            variant="secondary"
            onClick={() => void speak(steps.join(' '), i18n.language)}
            className="gap-2"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M4 9v6h4l5 4V5L8 9H4z" />
              <path d="M16.5 8.5a5 5 0 010 7" />
              <path d="M19 6a8.5 8.5 0 010 12" />
            </svg>
            {t('session.intro.listen')}
          </Button>
        </div>

        <div
          className="nc-fade-up relative flex h-44 items-center justify-center rounded-2xl bg-gradient-to-br from-[#E6EFF8] to-[#FDE3CF] text-sm font-semibold text-[#3D4552]"
          aria-label={t('session.intro.demoMissing')}
        >
          {cfg.instructions.demoVideo === 'TBD'
            ? t('session.intro.demoMissing')
            : t('session.intro.demo')}
        </div>

        <ol className="m-0 flex list-none flex-col gap-2.5 p-0" data-testid="steps">
          {steps.map((s, i) => (
            <li
              key={i}
              className="nc-fade-up flex gap-3 text-[15px] leading-snug"
              style={{ animationDelay: `${0.1 + i * 0.08}s` }}
            >
              <span className="flex size-[26px] flex-none items-center justify-center rounded-full bg-brand text-[13px] font-bold text-white">
                {i + 1}
              </span>
              <span>{s}</span>
            </li>
          ))}
        </ol>

        <Card className="flex flex-col gap-2.5">
          <span className="text-xs font-semibold tracking-wide text-muted uppercase">
            {t('session.intro.setup')}
          </span>
          <div className="grid grid-cols-3 gap-2">
            <div className="flex flex-col">
              <span className="text-xs text-muted">{t('session.intro.distance')}</span>
              <span className="text-[15px] font-semibold">
                {dMin}–{dMax} m
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-xs text-muted">{t('session.intro.height')}</span>
              <span className="text-[15px] font-semibold">
                {t(`session.heightRef.${cfg.setup.heightRef}`)}
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-xs text-muted">{t('session.intro.view')}</span>
              <span className="text-[15px] font-semibold">
                {t(`session.views.${cfg.setup.view}`)}
              </span>
            </div>
          </div>
          <span className="text-xs text-muted">{t('session.intro.checklist')}</span>
          <div className="flex flex-wrap gap-2">
            {cfg.setup.checklist.map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={!!done[c]}
                onClick={() => setDone({ ...done, [c]: !done[c] })}
                className={`flex min-h-12 items-center gap-1.5 rounded-full border px-3.5 text-[14px] font-medium ${done[c] ? 'border-[#9ED4B5] bg-ok-soft text-[#145F38]' : 'border-[#C9CFD8] bg-white text-muted'}`}
              >
                <Check />
                {t(`session.checklist.${c}`)}
              </button>
            ))}
          </div>
        </Card>
      </main>

      {needHelper && (
        <section
          className="mx-5 flex flex-col gap-2.5 rounded-2xl border border-line bg-white p-4"
          data-testid="saw-helper"
        >
          <h2 className="text-[16px] font-bold">{t('modes.saw.title')}</h2>
          <p className="text-[14px] leading-5 text-[#3D4552]">{t('modes.saw.body')}</p>
          <Button onClick={() => setHelper(true)} data-testid="saw-helper-yes">
            {t('modes.saw.yes')}
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              send({ type: 'SKIP', reason: 'no_helper', at: new Date().toISOString() })
            }
            data-testid="saw-helper-no"
          >
            {t('modes.saw.no')}
          </Button>
        </section>
      )}

      <footer className={`flex gap-2.5 px-5 pt-3 pb-6 ${needHelper ? 'hidden' : ''}`}>
        <Button variant="secondary" onClick={() => setSkipping(true)} data-testid="skip-test">
          {t('session.intro.skip')}
        </Button>
        <Button
          className="h-14 flex-1 text-[17px]"
          onClick={() => {
            void stopSpeaking();
            send({ type: 'CONTINUE' });
          }}
          data-testid="set-up-camera"
        >
          {t('session.intro.setUpCamera')}
        </Button>
      </footer>

      {ending && (
        <SkipSheet
          kind="abort"
          reasons={ctx.abortReasons ?? []}
          onCancel={() => setEnding(false)}
          onSkip={(reason, note) => {
            setEnding(false);
            void stopSpeaking();
            send({ type: 'ABORT', reason, note, at: new Date().toISOString() });
          }}
        />
      )}
      {skipping && (
        <SkipSheet
          reasons={ctx.skipReasons}
          onCancel={() => setSkipping(false)}
          onSkip={(reason, note) => {
            setSkipping(false);
            send({ type: 'SKIP', reason, note, at: new Date().toISOString() });
          }}
        />
      )}
    </div>
  );
}
