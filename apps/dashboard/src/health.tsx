/**
 * v29 (decision 052): the hospital connector's last 24 hours, one bar per hour (did it check in?),
 * and whether it is online now. Counts only; nothing about patients.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { call } from './api.ts';
import { Badge, ErrorNote } from './ui.tsx';

export interface ConnectorHistory {
  registered: boolean;
  last_seen_at: string | null;
  online: boolean;
  offline_since: string | null;
  heartbeat_seconds: number;
  offline_after_minutes: number;
  hours: { start: string; pings: number }[];
}

export type Bar = 'ok' | 'missed' | 'before';

/**
 * What each hour shows: checked in; missed (after the connector was first seen in the window, or
 * any time when it was seen before the window); or "before" (not connected yet: grey).
 */
export function barStates(h: Pick<ConnectorHistory, 'hours' | 'online' | 'last_seen_at'>): Bar[] {
  const first = h.hours.findIndex((x) => x.pings > 0);
  const seenBefore =
    !!h.last_seen_at &&
    h.hours.length > 0 &&
    Date.parse(h.last_seen_at) < Date.parse(h.hours[0]!.start);
  return h.hours.map((x, i) => {
    if (x.pings > 0) return 'ok';
    if (i === h.hours.length - 1 && h.online) return 'ok'; // this hour has only just started
    if (seenBefore || (first >= 0 && i > first)) return 'missed';
    return 'before';
  });
}

const hourText = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });

function ago(iso: string, now = Date.now()): number {
  return Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
}

export function ConnectorStrip({ url, testId }: { url: string; testId?: string }) {
  const { t } = useTranslation();
  const [h, setH] = useState<ConnectorHistory | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let off = false;
    const load = () =>
      call<ConnectorHistory>('GET', url).then(
        (d) => !off && setH(d),
        (e: unknown) => !off && setError(e),
      );
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => {
      off = true;
      clearInterval(timer);
    };
  }, [url]);
  if (!h) return <ErrorNote error={error} />;
  const bars = barStates(h);
  const status = !h.registered
    ? { tone: 'neutral' as const, text: t('health.notRegistered') }
    : !h.last_seen_at
      ? { tone: 'warn' as const, text: t('health.notSeen') }
      : h.online
        ? { tone: 'ok' as const, text: t('health.online', { minutes: ago(h.last_seen_at) }) }
        : {
            tone: 'bad' as const,
            text: t('health.offline', { at: hourText(h.offline_since ?? h.last_seen_at) }),
          };
  const colour: Record<Bar, string> = {
    ok: 'var(--color-ok)',
    missed: 'var(--color-alert)',
    before: 'var(--color-line)',
  };
  return (
    <div className="flex flex-col gap-2" data-testid={testId ?? 'connector-history'}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <b className="text-[14px]">{t('health.title', { hours: h.hours.length })}</b>
        <span data-testid="connector-status">
          <Badge tone={status.tone}>{status.text}</Badge>
        </span>
      </div>
      <div className="flex h-7 items-stretch gap-[3px]" role="img" aria-label={t('health.aria')}>
        {h.hours.map((x, i) => (
          <span
            key={x.start}
            className="flex-1 rounded-[4px]"
            style={{ background: colour[bars[i]!] }}
            title={t(`health.bar.${bars[i]}`, { time: hourText(x.start), count: x.pings })}
            data-state={bars[i]}
          />
        ))}
      </div>
      <div className="flex justify-between text-[11px] text-muted">
        <span>{h.hours[0] ? hourText(h.hours[0].start) : ''}</span>
        <span>{t('health.now')}</span>
      </div>
      <span className="text-[12px] text-muted">
        {t('health.legend', { minutes: h.offline_after_minutes })}
      </span>
    </div>
  );
}
