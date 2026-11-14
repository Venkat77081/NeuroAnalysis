/**
 * M9 thermal policy (DEV_PLAN M9): as the phone heats up, first lower the analysis (tracking)
 * rate, then hide the landmark overlay, and at the top level ask the operator to let the phone
 * cool before the next take. The recording frame rate is never touched. Levels come from
 * session.json `thermal`; a level applies at its status and above.
 */
import type { ThermalStatus } from '@neurocapture/capture-kit';
import type { SessionConfig } from '@neurocapture/contracts-ts';

export type ThermalLevel = NonNullable<SessionConfig['thermal']>['moderate'];

const ORDER: ThermalStatus[] = [
  'none',
  'light',
  'moderate',
  'severe',
  'critical',
  'emergency',
  'shutdown',
];

/** The policy for a thermal status, or null when nothing needs to change. */
export function thermalPolicy(
  status: ThermalStatus,
  cfg: SessionConfig['thermal'] | undefined,
): (ThermalLevel & { level: 'moderate' | 'severe' | 'critical' }) | null {
  if (!cfg) return null;
  const rank = ORDER.indexOf(status);
  if (rank < 0) return null; // unsupported
  const level =
    rank >= ORDER.indexOf('critical')
      ? 'critical'
      : rank >= ORDER.indexOf('severe')
        ? 'severe'
        : rank >= ORDER.indexOf('moderate')
          ? 'moderate'
          : null;
  return level ? { ...cfg[level], level } : null;
}
