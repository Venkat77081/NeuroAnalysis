/** Remembers the operator's portrait/landscape choice per test on this device (UI preference only). */
export type Orientation = 'portrait' | 'landscape';

const key = (code: string) => `nc.orientation.${code}`;

export function preferredOrientation(
  code: string,
  allowed: readonly Orientation[],
  fallback: Orientation,
): Orientation {
  try {
    const v = globalThis.localStorage?.getItem(key(code));
    if (v === 'portrait' || v === 'landscape') return allowed.includes(v) ? v : fallback;
  } catch {
    /* storage unavailable */
  }
  return fallback;
}

export function rememberOrientation(code: string, o: Orientation): void {
  try {
    globalThis.localStorage?.setItem(key(code), o);
  } catch {
    /* storage unavailable: the choice just is not remembered */
  }
}
