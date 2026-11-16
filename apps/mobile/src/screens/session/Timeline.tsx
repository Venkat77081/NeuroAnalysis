import { useTranslation } from 'react-i18next';
import type { TakeTimeline } from '../../session/machine.ts';

/**
 * Review timeline (mockup screen 5): movement window (green band), alerts during recording
 * (amber = warning, red = critical) and detected movement events (ticks).
 */
export function Timeline({ timeline }: { timeline: TakeTimeline }) {
  const { t } = useTranslation();
  const d = Math.max(timeline.durationS, 0.001);
  const pct = (s: number) => `${Math.min(100, Math.max(0, (s / d) * 100))}%`;
  const width = (a: number, b: number) => `${Math.max(0.5, ((b - a) / d) * 100)}%`;
  const counts = Object.entries(timeline.counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => t('session.timeline.count', { what: t(`session.timeline.kind.${k}`, k), n }))
    .join(' · ');
  return (
    <section className="flex flex-col gap-1.5" data-testid="timeline">
      <div className="relative h-8 overflow-hidden rounded-lg bg-[#E3E7EC]" aria-hidden="true">
        {timeline.movementWindow && (
          <div
            className="absolute inset-y-0 bg-[#BFE8D0]"
            style={{
              left: pct(timeline.movementWindow.tStartS),
              width: width(timeline.movementWindow.tStartS, timeline.movementWindow.tEndS),
            }}
            data-testid="movement-window"
          />
        )}
        {timeline.marks.map((m, i) => (
          <div
            key={i}
            className="absolute top-2 bottom-2 w-px bg-[#1B7F4B]"
            style={{ left: pct(m) }}
          />
        ))}
        {timeline.alerts.map((a, i) => (
          <div
            key={i}
            className={`absolute bottom-0 h-2 ${a.severity === 'CRITICAL' ? 'bg-[#E5484D]' : 'bg-[#F2A23A]'}`}
            style={{ left: pct(a.tStartS), width: width(a.tStartS, a.tEndS) }}
            data-testid={`alert-${a.severity}`}
          />
        ))}
      </div>
      <div className="flex justify-between text-[11px] text-muted tabular-nums">
        <span>0 s</span>
        <span data-testid="timeline-counts">{counts || t('session.timeline.noEvents')}</span>
        <span>{timeline.durationS.toFixed(0)} s</span>
      </div>
    </section>
  );
}
