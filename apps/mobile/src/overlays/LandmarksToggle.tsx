import { useTranslation } from 'react-i18next';

/** On/off switch for the landmark overlay (live camera, recording and replay). */
export function LandmarksToggle({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={`flex h-11 items-center gap-2 rounded-full px-3 text-[13px] font-semibold ${
        on ? 'bg-[#4FC3F7] text-[#0E1116]' : 'bg-[#0E1116] text-white'
      }`}
      data-testid="landmarks-switch"
    >
      <span
        className={`size-2.5 rounded-full ${on ? 'bg-[#0E1116]' : 'bg-[#8C96A5]'}`}
        aria-hidden="true"
      />
      {t('session.landmarks')}
    </button>
  );
}
