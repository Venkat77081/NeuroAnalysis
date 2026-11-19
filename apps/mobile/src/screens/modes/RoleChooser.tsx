import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EngineeringMenu } from '../EngineeringMenu.tsx';
import { Logo } from '../session/SessionHome.tsx';
import { dayPart } from '../../ui/Greeting.tsx';

/**
 * First run (M13): patient app or clinic phone. The choice is locked natively once set up.
 * Long-pressing the logo opens the settings menu (language, frame-rate limit, camera check and,
 * in debug builds, test mode; decision 041), so test mode can be switched on before set-up.
 */
export function RoleChooser({ onPick }: { onPick: (mode: 'patient' | 'clinic') => void }) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState(false);
  // v31: at night the welcome sky shows a moon and stars instead of the sun.
  const [night] = useState(() => dayPart() === 'evening');
  // New UI (decision 050): a welcome page with a sunrise, then the two choices.
  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col bg-ground px-5 pb-6">
      <div
        className="relative -mx-5 h-[260px] overflow-hidden"
        style={{
          marginTop: 'calc(-1 * var(--sat))',
          // v31: the theme's sky (sunrise by day, dusk in the evening look).
          background:
            'linear-gradient(170deg, var(--color-hero-a) 0%, var(--color-hero-b) 45%, var(--color-hero-c) 100%)',
        }}
        aria-hidden="true"
      >
        {night ? (
          <>
            <span
              className="nc-moon absolute top-[96px] left-1/2 size-24 -translate-x-1/2 rounded-full shadow-[0_0_60px_16px_rgb(165_180_252/0.35)]"
              style={{ background: 'radial-gradient(circle at 38% 38%, #eef2ff, #a5b4fc 70%)' }}
              data-testid="welcome-moon"
            />
            {[
              [18, 60],
              [30, 130],
              [72, 80],
              [84, 150],
              [60, 40],
            ].map(([left, top], i) => (
              <span
                key={i}
                className="nc-twinkle absolute size-1 rounded-full bg-brand-ink"
                style={{ left: `${left}%`, top: `${top}px`, animationDelay: `${i * 0.4}s` }}
              />
            ))}
          </>
        ) : (
          <span
            className="nc-rise absolute top-[96px] left-1/2 size-24 -translate-x-1/2 rounded-full shadow-[0_0_60px_16px_rgb(251_146_60/0.3)]"
            style={{ background: 'radial-gradient(circle at 40% 40%, #fde68a, #fb923c 72%)' }}
            data-testid="welcome-sun"
          />
        )}
        <span className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-b from-transparent to-ground" />
      </div>
      <div className="relative z-10 -mt-6 flex items-center gap-2 text-[14px] font-bold text-sub">
        <Logo onLongPress={() => setMenu(true)} />
        {t('app.name')}
      </div>
      <h1 className="nc-fade-up mt-3 mb-1 text-[28px] leading-[34px] font-extrabold">
        {t('modes.role.welcome')}
      </h1>
      <p
        className="nc-fade-up m-0 text-[15px] leading-[22px] text-sub"
        style={{ animationDelay: '0.1s' }}
      >
        {t('modes.role.welcomeHint')}
      </p>
      <div className="mt-auto flex flex-col gap-3 pt-8">
        <span className="text-[13px] font-semibold text-muted">{t('modes.role.title')}</span>
        <button
          type="button"
          onClick={() => onPick('patient')}
          className="nc-fade-up nc-gradient flex min-h-[72px] items-center gap-3 rounded-3xl px-4 py-3 text-left text-white shadow-[0_10px_26px_rgb(79_70_229/0.32)]"
          style={{ animationDelay: '0.2s' }}
          data-testid="role-patient"
        >
          <span
            aria-hidden
            className="flex size-11 flex-none items-center justify-center rounded-2xl bg-white/20 text-[22px]"
          >
            🙂
          </span>
          <span className="flex flex-1 flex-col">
            <span className="text-[17px] font-bold">{t('modes.role.patient')}</span>
            <span className="text-[13px] leading-[18px] opacity-90">
              {t('modes.role.patientHint')}
            </span>
          </span>
          <span aria-hidden className="text-[22px]">
            ›
          </span>
        </button>
        <button
          type="button"
          onClick={() => onPick('clinic')}
          className="nc-fade-up flex min-h-[72px] items-center gap-3 rounded-3xl bg-card px-4 py-3 text-left shadow-card"
          style={{ animationDelay: '0.3s' }}
          data-testid="role-clinic"
        >
          <span
            aria-hidden
            className="flex size-11 flex-none items-center justify-center rounded-2xl bg-[#ffe9e4] text-[22px]"
          >
            🏥
          </span>
          <span className="flex flex-1 flex-col">
            <span className="text-[17px] font-bold">{t('modes.role.clinic')}</span>
            <span className="text-[13px] leading-[18px] text-muted">
              {t('modes.role.clinicHint')}
            </span>
          </span>
          <span aria-hidden className="text-[22px] text-muted">
            ›
          </span>
        </button>
        <p className="m-0 text-[12px] leading-[18px] text-muted">{t('modes.role.note')}</p>
      </div>
      {menu && <EngineeringMenu onClose={() => setMenu(false)} />}
    </div>
  );
}
