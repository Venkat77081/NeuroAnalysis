/** Canonical timestamps are nanoseconds as bigint; events cross the bridge as decimal strings (DEV_PLAN §5.3, §5.6). */

export function parseNs(ns: string): bigint {
  if (!/^-?\d+$/.test(ns)) throw new Error(`invalid nanosecond timestamp: ${ns}`);
  return BigInt(ns);
}

/** Seconds between two canonical timestamps, as a float (for display and windows, not storage). */
export function secondsBetween(fromNs: bigint, toNs: bigint): number {
  return Number(toNs - fromNs) / 1e9;
}

/** True when the recorded duration meets the fixed take length within tolerance (decision 002). */
export function meetsDuration(durationS: number, targetS: number, toleranceS: number): boolean {
  return durationS >= targetS - toleranceS;
}
