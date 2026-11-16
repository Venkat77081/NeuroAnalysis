/**
 * M4 acceptance (DEV_PLAN §16 M4): while recording on Tier A at 60 fps, analysis ≥ 20 fps,
 * event latency p95 ≤ 80 ms, event size ≤ 20 KB, and the recording still meets M2.
 * Engineering limits like M2_LIMITS; not protocol values.
 */
export const M4_LIMITS = {
  analysisFps: 20,
  latencyP95Ms: 80,
  eventBytes: 20 * 1024,
} as const;

/**
 * Maps JS time to the native canonical clock: offset = native − JS, sampled at the midpoint of a
 * clockNow() round trip (the one with the shortest round trip wins).
 */
export function clockOffsetNs(samples: { beforeMs: number; afterMs: number; nativeNs: bigint }[]): {
  offsetNs: bigint;
  rttMs: number;
} {
  if (!samples.length) throw new Error('no clock samples');
  const best = samples.reduce((a, b) => (b.afterMs - b.beforeMs < a.afterMs - a.beforeMs ? b : a));
  const midNs = BigInt(Math.round(((best.beforeMs + best.afterMs) / 2) * 1e6));
  return { offsetNs: best.nativeNs - midNs, rttMs: best.afterMs - best.beforeMs };
}

/** Nearest-rank percentile; NaN for an empty list. */
export function percentile(values: number[], p: number): number {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

export interface TrackingSummary {
  events: number;
  analysisFps: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  maxEventBytes: number;
  procP95Ms: number;
  /** Frames where every enabled tracker returned (ok or no_result, not error). */
  errorFrames: number;
}

export interface TrackingSample {
  tsNs: bigint;
  latencyMs: number;
  bytes: number;
  procMs: number;
  error: boolean;
}

/** Summary of the analysis events received during one run. fps is from the canonical timestamps. */
export function summarizeTracking(samples: TrackingSample[]): TrackingSummary {
  const n = samples.length;
  const spanS = n > 1 ? Number(samples[n - 1]!.tsNs - samples[0]!.tsNs) / 1e9 : 0;
  return {
    events: n,
    analysisFps: spanS > 0 ? (n - 1) / spanS : 0,
    latencyP50Ms: percentile(
      samples.map((s) => s.latencyMs),
      50,
    ),
    latencyP95Ms: percentile(
      samples.map((s) => s.latencyMs),
      95,
    ),
    maxEventBytes: samples.reduce((m, s) => Math.max(m, s.bytes), 0),
    procP95Ms: percentile(
      samples.map((s) => s.procMs),
      95,
    ),
    errorFrames: samples.filter((s) => s.error).length,
  };
}

export interface TrackingChecks {
  fps: boolean;
  latency: boolean;
  size: boolean;
}

export function checkTracking(s: TrackingSummary): TrackingChecks {
  return {
    fps: s.analysisFps >= M4_LIMITS.analysisFps,
    latency: s.latencyP95Ms <= M4_LIMITS.latencyP95Ms,
    size: s.events > 0 && s.maxEventBytes <= M4_LIMITS.eventBytes,
  };
}
