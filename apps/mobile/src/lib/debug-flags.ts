/** Engineering-only switches kept per device in localStorage (never patient data). */
const KEY = 'nc.debug.landmarks';

export function landmarkOverlayEnabled(): boolean {
  if (import.meta.env.VITE_PRODUCTION === '1') return false;
  try {
    return globalThis.localStorage?.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function setLandmarkOverlay(on: boolean): void {
  try {
    if (on) globalThis.localStorage?.setItem(KEY, '1');
    else globalThis.localStorage?.removeItem(KEY);
  } catch {
    /* storage unavailable: the overlay just stays off */
  }
}
