import { useTranslation } from 'react-i18next';

/** On/off switch for the landmark overlay (live camera, recording and replay). */
export function LandmarksToggle({
  on,
  onChange,
  compact = false,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  /** New UI: on the camera screen, a round icon button (the name stays for screen readers). */
  compact?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      aria-label={compact ? t('session.landmarks') : undefined}
      className={`flex h-12 items-center justify-center gap-2 rounded-full text-[13px] font-semibold ${compact ? 'w-12' : 'px-3'} ${
        on ? 'bg-[#4FC3F7] text-cam' : 'bg-cam text-white'
      }`}
      data-testid="landmarks-switch"
    >
      <span className={`size-2.5 rounded-full ${on ? 'bg-cam' : 'bg-muted'}`} aria-hidden="true" />
      {!compact && t('session.landmarks')}
    </button>
  );
}
