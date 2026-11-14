/** Engineering-only switches kept per device in localStorage (never patient data). */
const LANDMARKS = 'nc.debug.landmarks';
const ADVISORY = 'nc.debug.gateAdvisory';
const BASELINE = 'nc.device.sharpnessBaseline';
const DELEGATE = 'nc.device.trackerDelegate';

const production = () => import.meta.env.VITE_PRODUCTION === '1';

function get(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function set(key: string, value: string | null): void {
  try {
    if (value === null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, value);
  } catch {
    /* storage unavailable: the switch just stays off */
  }
}

export function landmarkOverlayEnabled(): boolean {
  return !production() && get(LANDMARKS) === '1';
}

export function setLandmarkOverlay(on: boolean): void {
  set(LANDMARKS, on ? '1' : null);
}

/** Pilot tuning only: Record works while the positioning gate is closed (prompts still shown). */
export function gateAdvisory(): boolean {
  return !production() && get(ADVISORY) === '1';
}

export function setGateAdvisory(on: boolean): void {
  set(ADVISORY, on ? '1' : null);
}

/** Device sharpness baseline from the 3 s calibration (Capture test); null = not calibrated. */
export function sharpnessBaseline(): number | null {
  const v = Number(get(BASELINE));
  return Number.isFinite(v) && v > 0 ? v : null;
}

export function setSharpnessBaseline(v: number | null): void {
  set(BASELINE, v === null ? null : String(v));
}

export type TrackerDelegate = 'auto' | 'gpu' | 'cpu';

/** MediaPipe delegate chosen for this device in the Tracking test (decision 016). */
export function trackerDelegate(): TrackerDelegate {
  const v = get(DELEGATE);
  return v === 'gpu' || v === 'cpu' ? v : 'auto';
}

export function setTrackerDelegate(v: TrackerDelegate): void {
  set(DELEGATE, v === 'auto' ? null : v);
}
