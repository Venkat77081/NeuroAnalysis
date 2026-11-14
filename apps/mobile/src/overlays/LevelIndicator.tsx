import { useTranslation } from 'react-i18next';

/**
 * Spirit level for the phone on its stand: the bar shows roll (turns with the phone), the dot
 * shows pitch (camera aimed up/down). Green when both are within the tilt check's limits.
 */
export function LevelIndicator({
  tilt,
  maxRollDeg,
  maxPitchDeg,
}: {
  tilt: { rollDeg: number; pitchDeg: number } | null;
  maxRollDeg: number;
  maxPitchDeg: number;
}) {
  const { t } = useTranslation();
  if (!tilt) return null;
  const ok = Math.abs(tilt.rollDeg) <= maxRollDeg && Math.abs(tilt.pitchDeg) <= maxPitchDeg;
  const colour = ok ? '#5BE3A0' : '#F2A23A';
  const dotY = Math.max(-18, Math.min(18, tilt.pitchDeg * 1.2));
  return (
    <div
      className="flex items-center gap-2 rounded-full bg-[#0E1116]/85 py-1 pr-3 pl-1"
      data-testid="level"
      data-ok={ok}
      aria-label={t('session.guidance.levelAria', {
        roll: Math.round(tilt.rollDeg),
        pitch: Math.round(tilt.pitchDeg),
      })}
    >
      <svg width="44" height="44" viewBox="-22 -22 44 44" aria-hidden="true">
        <circle r="20" fill="none" stroke="#4A525E" strokeWidth="2" />
        <line x1="-20" x2="20" stroke="#4A525E" strokeWidth="1" strokeDasharray="2 3" />
        <g transform={`rotate(${tilt.rollDeg})`}>
          <line x1="-16" x2="16" stroke={colour} strokeWidth="3" strokeLinecap="round" />
        </g>
        <circle cy={dotY} r="3.5" fill={colour} />
      </svg>
      <span className="text-xs font-semibold tabular-nums" style={{ color: colour }}>
        {Math.round(tilt.rollDeg)}° · {Math.round(tilt.pitchDeg)}°
      </span>
    </div>
  );
}
