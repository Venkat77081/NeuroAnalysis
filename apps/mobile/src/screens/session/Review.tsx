import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { VerdictReason } from '@neurocapture/quality-core';
import { capture } from '../../lib/capture.ts';
import { landmarkOverlayEnabled, setLandmarkOverlay } from '../../lib/debug-flags.ts';
import { ReplayOverlay } from '../../overlays/ReplayOverlay.tsx';
import { LandmarksToggle } from '../../overlays/LandmarksToggle.tsx';
import { cleanNote, lastTake, retakesLeft } from '../../session/machine.ts';
import { useSession } from '../../session/useSession.ts';
import { Button, Card, Radio, Sheet } from '../../ui/kit.tsx';
import { SkipSheet } from './SkipSheet.tsx';
import { stepTitle } from './TestIntro.tsx';

export function ReasonList({ reasons }: { reasons: VerdictReason[] }) {
  const { t } = useTranslation();
  return (
    <ul className="m-0 pl-5 text-sm leading-relaxed text-[#2B323C]" data-testid="verdict-reasons">
      {reasons.map((r, i) => (
        <li key={i}>{t(r.messageKey.replace(/^verdict\./, 'session.verdict.'), r.params ?? {})}</li>
      ))}
    </ul>
  );
}

export function Review() {
  const { t } = useTranslation();
  const { ctx, send, snapshot } = useSession();
  const take = lastTake(ctx)!;
  const r = take.result!;
  const step = ctx.plan[ctx.index]!;
  const pass = take.verdict === 'PASS';
  const left = retakesLeft(ctx);
  const [player, setPlayer] = useState<string | null>(null);
  const [skipping, setSkipping] = useState(false);
  const [showLm, setShowLm] = useState(landmarkOverlayEnabled);
  const videoRef = useRef<HTMLVideoElement>(null);

  async function play() {
    try {
      setPlayer((await capture.kit.playTake({ takeId: take.takeId })).playerUrl);
    } catch {
      setPlayer(null);
    }
  }

  async function closePlayer() {
    await capture.kit.closePlayback({ takeId: take.takeId }).catch(() => undefined);
    setPlayer(null);
  }

  if (player) {
    return (
      <div
        className="fixed inset-0 flex flex-col bg-black pt-[var(--sat)] pb-[var(--sab)]"
        data-testid="player"
      >
        <div className="relative min-h-0 flex-1">
          <video
            ref={videoRef}
            src={player}
            controls
            autoPlay
            playsInline
            className="absolute inset-0 h-full w-full object-contain"
          />
          {showLm && (
            <ReplayOverlay
              takeId={take.takeId}
              firstSampleNs={r.mp4?.firstSampleNs ?? null}
              video={videoRef}
            />
          )}
        </div>
        <div className="m-4 flex gap-2">
          <LandmarksToggle
            on={showLm}
            onChange={(v) => {
              setShowLm(v);
              setLandmarkOverlay(v);
            }}
          />
          <Button className="flex-1" variant="secondary" onClick={() => void closePlayer()}>
            {t('common.close')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col bg-ground">
      <header className="flex flex-col gap-0.5 px-5 pt-4 pb-2">
        <span className="text-[13px] text-muted">
          {t('session.intro.testOf', { n: ctx.index + 1, of: ctx.plan.length })} ·{' '}
          {t('session.review.takeOf', { n: take.takeNo })}
        </span>
        <h1 className="m-0 text-[22px] font-bold">{stepTitle(t, step.code, step.side)}</h1>
      </header>

      <main className="flex flex-1 flex-col gap-3 px-5 pt-1">
        <button
          type="button"
          onClick={() => void play()}
          className="relative h-44 rounded-2xl bg-[#1C222B]"
          aria-label={t('session.review.play')}
          data-testid="play"
        >
          <span className="absolute top-1/2 left-1/2 flex size-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white text-ink">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M8 5v14l11-7z" />
            </svg>
          </span>
        </button>

        <section
          className={`flex flex-col gap-2 rounded-2xl border p-4 ${pass ? 'border-[#9ED4B5] bg-ok-soft' : 'border-[#F3B4AE] bg-[#FDECEA]'}`}
          data-testid="verdict-card"
        >
          <span
            className={`text-lg font-bold ${pass ? 'text-ok' : 'text-bad'}`}
            data-testid="verdict-title"
          >
            {pass
              ? t('session.review.passed')
              : left > 0
                ? t('session.review.retake')
                : t('session.review.retakeNone')}
          </span>
          {pass ? (
            <span className="text-sm">{t('session.review.allOk')}</span>
          ) : (
            <ReasonList reasons={take.reasons} />
          )}
        </section>

        <dl className="m-0 grid grid-cols-2 gap-2">
          <Card className="!p-3">
            <dt className="text-xs text-muted">{t('session.review.duration')}</dt>
            <dd className="m-0 text-base font-bold tabular-nums">{r.durationS.toFixed(2)} s</dd>
          </Card>
          <Card className="!p-3">
            <dt className="text-xs text-muted">{t('session.review.fps')}</dt>
            <dd className="m-0 text-base font-bold tabular-nums">
              {r.effectiveFps.toFixed(1)} @ {r.actualFps}
            </dd>
          </Card>
          <Card className="col-span-2 !p-3">
            <dt className="text-xs text-muted">{t('session.review.dropped')}</dt>
            <dd className="m-0 text-base font-bold tabular-nums">
              {(r.droppedFrac * 100).toFixed(2)} %{' '}
              <span className="text-xs font-normal text-muted">
                ({t('session.review.droppedLogged')})
              </span>
            </dd>
          </Card>
        </dl>
      </main>

      <footer className="flex flex-col gap-2 px-5 pt-3 pb-6">
        {pass && (
          <div className="flex gap-2.5">
            <Button
              variant="secondary"
              disabled={left === 0}
              onClick={() => send({ type: 'RETAKE' })}
              data-testid="retake"
            >
              {t('session.review.retakeBtn')}
            </Button>
            <Button
              className="h-14 flex-1 text-[17px]"
              onClick={() => send({ type: 'ACCEPT' })}
              data-testid="accept"
            >
              {t('session.review.accept')}
            </Button>
          </div>
        )}
        {!pass && left > 0 && (
          <div className="flex gap-2.5">
            <Button variant="secondary" onClick={() => send({ type: 'KEEP' })} data-testid="keep">
              {t('session.review.keep')}
            </Button>
            <Button
              className="h-14 flex-1 text-[17px]"
              onClick={() => send({ type: 'RETAKE' })}
              data-testid="retake"
            >
              {t('session.review.retakeLeft', { n: left })}
            </Button>
          </div>
        )}
        {!pass && left === 0 && (
          <>
            <div className="flex gap-2.5">
              <Button variant="secondary" onClick={() => setSkipping(true)} data-testid="skip-test">
                {t('session.review.skip')}
              </Button>
              <Button
                className="h-14 flex-1 text-[17px]"
                onClick={() => send({ type: 'KEEP' })}
                data-testid="keep"
              >
                {t('session.review.keep')}
              </Button>
            </div>
            <span className="text-center text-xs text-muted">
              {t('session.review.allUsed', { n: ctx.maxRetakes })}
            </span>
          </>
        )}
      </footer>

      {snapshot.matches({ test: 'keep' }) && (
        <KeepSheet reasons={take.reasons} options={ctx.overrideReasons} />
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

/** "Keep this take…": failure reasons repeated, reason required, then flagged for review (decision 003). */
function KeepSheet({ reasons, options }: { reasons: VerdictReason[]; options: string[] }) {
  const { t } = useTranslation();
  const { send } = useSession();
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const ok = !!reason && (reason !== 'other' || cleanNote(note) !== null);
  return (
    <Sheet
      title={t('session.keep.title')}
      onClose={() => send({ type: 'CANCEL' })}
      testId="keep-sheet"
    >
      <div className="rounded-xl border border-[#F3B4AE] bg-[#FDECEA] px-3.5 py-2.5">
        <span className="text-xs font-bold tracking-wide text-bad uppercase">
          {t('session.keep.failed')}
        </span>
        <ReasonList reasons={reasons} />
      </div>
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-1 text-sm font-semibold">{t('session.keep.reason')}</legend>
        {options.map((o) => (
          <Radio
            key={o}
            name="keep"
            checked={reason === o}
            onChange={() => setReason(o)}
            label={t(`session.reasons.override.${o}`)}
          />
        ))}
      </fieldset>
      {reason === 'other' && (
        <label className="flex flex-col gap-1 text-sm text-muted">
          {t('session.keep.note')}
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            className="resize-none rounded-xl border border-[#C9CFD8] p-3 text-[15px] text-ink"
          />
        </label>
      )}
      <p className="m-0 text-[13px] text-muted">{t('session.keep.flagNote')}</p>
      <div className="flex gap-2">
        <Button variant="secondary" onClick={() => send({ type: 'CANCEL' })}>
          {t('common.cancel')}
        </Button>
        <Button
          className="flex-1"
          disabled={!ok}
          onClick={() =>
            reason && send({ type: 'CONFIRM_KEEP', reason, note, at: new Date().toISOString() })
          }
          data-testid="confirm-keep"
        >
          {t('session.keep.confirm')}
        </Button>
      </div>
    </Sheet>
  );
}
