/**
 * New UI (decision 050): a greeting by time of day on the phone. Morning: a sun rising on a peach
 * sky; afternoon: light blue; evening: navy with a moon and stars. The name is the patient's first
 * name kept on this phone (never sent anywhere) or, on a clinic phone, the operator's name.
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Logo } from './Logo.tsx';

export type DayPart = 'morning' | 'afternoon' | 'evening';
export const dayPart = (d = new Date()): DayPart =>
  d.getHours() < 12 ? 'morning' : d.getHours() < 17 ? 'afternoon' : 'evening';

const SKY: Record<DayPart, string> = {
  morning: 'linear-gradient(160deg, #fff1e0 0%, #ffe4cc 55%, #fde3cf 100%)',
  afternoon: 'linear-gradient(160deg, #e6f2ff 0%, #d7eaff 100%)',
  evening: 'linear-gradient(160deg, #1e2a4a 0%, #2d3a63 100%)',
};

export function Greeting({
  name,
  line,
  right,
  part = dayPart(),
  card = false,
  onLogo,
  chip,
}: {
  name?: string | null;
  line?: ReactNode;
  right?: ReactNode;
  part?: DayPart;
  /** Inside a padded page (clinic phone): a rounded card instead of a full-width header. */
  card?: boolean;
  /** New UI round 3: the logo sits top left in the card; long-press opens the settings menu. */
  onLogo?: () => void;
  /** A small status next to the logo (e.g. mock mode). */
  chip?: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const dark = part === 'evening';
  const date = new Date()
    .toLocaleDateString(i18n.language === 'hi' ? 'hi-IN' : 'en-IN', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    })
    .replace(',', '');
  const first = name?.trim().split(/\s+/)[0];
  return (
    <section
      className={`relative overflow-hidden ${card ? 'rounded-[22px] px-4 pt-5 pb-4' : '-mx-5 rounded-b-[26px] px-5 pb-6'} ${dark ? 'text-white' : 'text-[#3B2417]'}`}
      style={{
        background: SKY[part],
        // Full width, under the status bar too (the page has top padding for it).
        ...(card
          ? {}
          : { marginTop: 'calc(-1.5rem - var(--sat))', paddingTop: 'calc(1.75rem + var(--sat))' }),
      }}
      data-testid="greeting"
      data-part={part}
    >
      {part === 'evening' ? (
        <>
          <span
            aria-hidden
            className="nc-moon absolute right-8 size-11 rounded-full shadow-[-12px_6px_0_0_#fde68a]"
            style={{ top: card ? '1.25rem' : 'calc(1.25rem + var(--sat))' }}
          />
          {[
            [62, 18],
            [40, 52],
            [80, 64],
            [28, 90],
          ].map(([r, top], i) => (
            <span
              key={i}
              aria-hidden
              className="nc-twinkle absolute size-1 rounded-full bg-white"
              style={{
                right: `${r! + 30}px`,
                top: card ? `${top}px` : `calc(${top}px + var(--sat))`,
                animationDelay: `${i * 0.4}s`,
              }}
            />
          ))}
        </>
      ) : (
        <span
          aria-hidden
          className="nc-rise absolute right-5 size-14 rounded-full"
          style={{
            top: card ? '1rem' : 'calc(1rem + var(--sat))',
            background:
              part === 'morning'
                ? 'radial-gradient(circle at 40% 40%, #fde68a, #fb923c)'
                : 'radial-gradient(circle, #fff7c2, #fbbf24)',
          }}
        />
      )}
      {onLogo && (
        <div className="relative z-10 mb-3 flex items-center gap-2 pr-16">
          <Logo onLongPress={onLogo} />
          <b className="text-[14px]">{t('app.name')}</b>
          {chip}
        </div>
      )}
      <div className="relative z-10 flex items-center justify-between gap-2 pr-16">
        <span className="text-[13px] opacity-80">{date}</span>
        {right}
      </div>
      <h1
        className="m-0 mt-1 pr-16 text-[28px] leading-[34px] font-extrabold whitespace-pre-line"
        data-testid="greeting-text"
      >
        {first ? t(`greeting.${part}Name`, { name: first }) : t(`greeting.${part}`)}
      </h1>
      {line && (
        <p className="m-0 mt-1.5 text-[14px] opacity-85" data-testid="greeting-line">
          {line}
        </p>
      )}
    </section>
  );
}
