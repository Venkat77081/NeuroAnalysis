import { assignTier, formatTierReason, type TierAssessment } from '@neurocapture/quality-core';
import type { BenchmarkReport, DeviceTiersConfig } from '@neurocapture/contracts-ts';
import { logger } from './logger.ts';

const KEY = 'nc.deviceQualification';

export interface StoredQualification {
  assessment: TierAssessment;
  reports: BenchmarkReport[];
}

/** Attach the TS-assigned assessment to a raw native report (stored form, schema `assessment`). */
export function withAssessment(report: BenchmarkReport, a: TierAssessment): BenchmarkReport {
  return {
    ...report,
    assessment: {
      tier: a.tier,
      provisional: a.provisional,
      reasons: a.reasons.map(formatTierReason),
      tiersConfigVersion: a.tiersConfigVersion,
    },
  };
}

export function assess(reports: BenchmarkReport[], cfg: DeviceTiersConfig): TierAssessment {
  return assignTier(reports, cfg);
}

/** Per-device convenience cache (M1). The encrypted local DB replaces this in M3. */
export function loadQualification(): StoredQualification | null {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    return raw ? (JSON.parse(raw) as StoredQualification) : null;
  } catch (e) {
    logger.warn('could not read stored qualification', { error: String(e) });
    return null;
  }
}

export function saveQualification(q: StoredQualification): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(q));
  } catch (e) {
    logger.warn('could not store qualification', { error: String(e) });
  }
}

/** Safe report file name: <manufacturer>-<model>-<fps>fps-<date>.json */
export function reportFileName(r: BenchmarkReport): string {
  const slug = (s: string) =>
    s
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'unknown';
  const date = r.ranAt.replace(/[:.]/g, '-');
  return `${slug(r.device.manufacturer)}-${slug(r.device.model)}-${r.settings.targetFps}fps-${date}.json`;
}
