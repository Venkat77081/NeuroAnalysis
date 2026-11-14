import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApp } from '../../app/AppContext.tsx';
import { capture } from '../../lib/capture.ts';
import { maskRef, newId } from '../../data/repo.ts';
import { useSession } from '../../session/useSession.ts';
import type { MedState, Patient } from '../../session/machine.ts';
import { Button, Card, Sheet } from '../../ui/kit.tsx';

const LONG_PRESS_MS = 1200;

export function Logo({ onLongPress }: { onLongPress: () => void }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = () => {
    timer.current = setTimeout(onLongPress, LONG_PRESS_MS);
  };
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
  };
  return (
    <div
      className="flex size-8 select-none items-center justify-center rounded-lg bg-brand text-white"
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onContextMenu={(e) => e.preventDefault()}
      data-testid="logo"
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="3" y="6" width="13" height="12" rx="2" />
        <path d="M16 10l5-3v10l-5-3" />
      </svg>
    </div>
  );
}

export function SessionHome({ onEngineering }: { onEngineering: () => void }) {
  const { t } = useTranslation();
  const { config, repo, settings } = useApp();
  const { ctx, send } = useSession();
  const [patients, setPatients] = useState<Patient[]>([]);
  const [picker, setPicker] = useState(false);
  const [draft, setDraft] = useState({ ref: '', yob: '', sex: '' as '' | 'M' | 'F' | 'O' });
  const native = capture.implementation === 'native';

  useEffect(() => {
    repo.listPatients().then(setPatients, () => undefined);
  }, [repo]);

  const totalS = ctx.plan.reduce((s, p) => s + (config.tests.get(p.code)?.task.durationS ?? 0), 0);
  const minutes = Math.round(totalS / 60 + ctx.plan.length * 1.5);
  const ready = !!ctx.patient && !!ctx.medState && !!ctx.consent;
  const yob = Number(draft.yob);
  const draftOk = draft.ref.trim().length >= 3 && (!draft.yob || (yob >= 1900 && yob <= 2030));

  async function savePatient() {
    const p: Patient = {
      localId: newId('p'),
      ref: draft.ref.trim(),
      yearOfBirth: draft.yob ? yob : null,
      sex: draft.sex || null,
    };
    await repo.savePatient(p);
    setPatients(await repo.listPatients());
    send({ type: 'SET_PATIENT', patient: p });
    setDraft({ ref: '', yob: '', sex: '' });
    setPicker(false);
  }

  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col bg-ground">
      <header className="flex items-center justify-between px-5 pt-4 pb-2">
        <div className="flex items-center gap-2.5">
          <Logo onLongPress={onEngineering} />
          <span className="text-[17px] font-bold">{t('app.name')}</span>
        </div>
        <span
          className={`rounded-full px-2.5 py-1.5 text-xs font-semibold ${native ? 'bg-ok-soft text-ok' : 'bg-warn-soft text-warn'}`}
          data-testid="mode-badge"
        >
          {t(`home.mode.${capture.implementation}`)}
        </span>
      </header>

      <main className="flex flex-1 flex-col gap-3.5 px-5 pt-1">
        <div className="flex items-baseline justify-between">
          <h1 className="m-0 text-[26px] font-bold">{t('session.home.title')}</h1>
          <span className="text-[13px] text-muted">
            {t('session.home.operator', { id: settings.operatorId })}
          </span>
        </div>

        <Card className="flex items-center justify-between">
          <div className="flex flex-col gap-0.5">
            <span className="text-xs font-semibold tracking-wide text-muted uppercase">
              {t('session.home.patient')}
            </span>
            {ctx.patient ? (
              <>
                <span className="text-[17px] font-semibold" data-testid="patient-ref">
                  {t('session.home.ref')} {maskRef(ctx.patient.ref)}
                </span>
                <span className="text-[13px] text-muted">
                  {[
                    ctx.patient.yearOfBirth
                      ? t('session.home.born', { year: ctx.patient.yearOfBirth })
                      : null,
                    ctx.patient.sex ? t(`session.home.sexes.${ctx.patient.sex}`) : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </>
            ) : (
              <span className="text-[15px] text-muted">{t('session.home.choosePatient')}</span>
            )}
          </div>
          <Button variant="ghost" onClick={() => setPicker(true)} data-testid="choose-patient">
            {ctx.patient ? t('session.home.change') : t('session.home.newPatient')}
          </Button>
        </Card>

        <section className="flex flex-col gap-2">
          <span id="medlabel" className="text-sm font-semibold">
            {t('session.home.medState')}
          </span>
          <div role="group" aria-labelledby="medlabel" className="grid grid-cols-3 gap-2">
            {(config.session.medStates as MedState[]).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={ctx.medState === m}
                onClick={() => send({ type: 'SET_MED_STATE', medState: m })}
                className={`h-12 rounded-xl border text-[15px] font-semibold ${ctx.medState === m ? 'border-brand bg-brand text-white' : 'border-[#C9CFD8] bg-white'}`}
                data-testid={`med-${m}`}
              >
                {t(`session.home.med.${m}`)}
              </button>
            ))}
          </div>
        </section>

        <label className="flex items-center gap-3 rounded-2xl border border-line bg-white px-4 py-3 text-sm">
          <input
            type="checkbox"
            checked={!!ctx.consent}
            onChange={(e) =>
              send({ type: 'SET_CONSENT', given: e.target.checked, at: new Date().toISOString() })
            }
            className="size-6 accent-brand"
            data-testid="consent"
          />
          <span className="flex flex-col">
            <span className="font-semibold">{t('session.home.consent')}</span>
            <span className="text-xs text-muted">
              {t('session.home.consentDetail', { version: config.session.consentVersion })}
            </span>
          </span>
        </label>

        <section className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-semibold">{t('session.home.plan')}</span>
            <span className="text-xs text-muted">
              {t('session.home.planMeta', { count: ctx.plan.length, min: minutes })}
            </span>
          </div>
          <ol
            className="m-0 list-none overflow-hidden rounded-2xl border border-line bg-white p-0"
            data-testid="test-plan"
          >
            {ctx.plan.map((p, i) => (
              <li
                key={`${p.code}-${p.side ?? 'na'}`}
                className="flex h-11 items-center gap-3 border-b border-[#EDF0F3] px-3.5 last:border-b-0"
              >
                <span className="w-5 text-xs text-muted tabular-nums">{i + 1}</span>
                <span className="min-w-10 rounded-md bg-brand-soft px-1.5 py-0.5 text-center text-xs font-bold text-brand">
                  {p.code}
                </span>
                <span className="flex-1 text-sm">{t(`tests.${p.code}`)}</span>
                <span className="text-[13px] text-muted">
                  {p.side ? t(`session.sides.${p.side}`) : '—'}
                </span>
                <span className="w-10 text-right text-[13px] text-muted tabular-nums">
                  {config.tests.get(p.code)?.task.durationS} s
                </span>
              </li>
            ))}
          </ol>
        </section>
      </main>

      <footer className="px-5 pt-3 pb-6">
        <Button
          className="h-14 w-full text-[17px]"
          disabled={!ready}
          onClick={() => send({ type: 'START', at: new Date().toISOString() })}
          data-testid="start-session"
        >
          {t('session.home.start')}
        </Button>
      </footer>

      {picker && (
        <Sheet
          title={t('session.home.patient')}
          onClose={() => setPicker(false)}
          testId="patient-sheet"
        >
          {patients.length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {patients.map((p) => (
                <li key={p.localId}>
                  <button
                    type="button"
                    onClick={() => {
                      send({ type: 'SET_PATIENT', patient: p });
                      setPicker(false);
                    }}
                    className={`flex min-h-12 w-full items-center justify-between rounded-xl border px-3.5 text-left text-[15px] ${ctx.patient?.localId === p.localId ? 'border-brand bg-brand-soft' : 'border-[#C9CFD8] bg-white'}`}
                  >
                    <span className="font-semibold">{maskRef(p.ref)}</span>
                    <span className="text-xs text-muted">{p.yearOfBirth ?? ''}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <span className="mt-1 text-sm font-semibold">{t('session.home.newPatient')}</span>
          <label className="flex flex-col gap-1 text-sm">
            {t('session.home.ref')}
            <input
              value={draft.ref}
              onChange={(e) => setDraft({ ...draft, ref: e.target.value })}
              autoComplete="off"
              className="h-12 rounded-xl border border-[#C9CFD8] px-3 text-[15px]"
              data-testid="patient-ref-input"
            />
            <span className="text-xs text-muted">{t('session.home.refHint')}</span>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-sm">
              {t('session.home.yob')}
              <input
                inputMode="numeric"
                value={draft.yob}
                onChange={(e) =>
                  setDraft({ ...draft, yob: e.target.value.replace(/\D/g, '').slice(0, 4) })
                }
                className="h-12 rounded-xl border border-[#C9CFD8] px-3 text-[15px]"
                data-testid="patient-yob-input"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {t('session.home.sex')}
              <select
                value={draft.sex}
                onChange={(e) => setDraft({ ...draft, sex: e.target.value as typeof draft.sex })}
                className="h-12 rounded-xl border border-[#C9CFD8] bg-white px-3 text-[15px]"
              >
                <option value="">—</option>
                {(['M', 'F', 'O'] as const).map((s) => (
                  <option key={s} value={s}>
                    {t(`session.home.sexes.${s}`)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <Button disabled={!draftOk} onClick={() => void savePatient()} data-testid="save-patient">
            {t('session.home.savePatient')}
          </Button>
        </Sheet>
      )}
    </div>
  );
}
