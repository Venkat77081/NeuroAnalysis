/**
 * v31 (decision 055): the app's light or evening (dark) look, like the dashboards. Automatic (the
 * default) is dark from `appearance.darkFromHour` until `appearance.lightFromHour` on the phone's
 * clock (config/platform.json); "Same as this phone" follows the phone's dark mode.
 */
export type Appearance = 'auto' | 'system' | 'light' | 'dark';
export const APPEARANCES: Appearance[] = ['auto', 'system', 'light', 'dark'];

export interface EveningHours {
  darkFromHour: number;
  lightFromHour: number;
}
/** Used only if the config has no hours (older config). */
export const FALLBACK_HOURS: EveningHours = { darkFromHour: 18, lightFromHour: 6 };

/** True from darkFromHour until lightFromHour; works across midnight. */
export function isEvening(d: Date, a: EveningHours): boolean {
  const h = d.getHours();
  return a.darkFromHour > a.lightFromHour
    ? h >= a.darkFromHour || h < a.lightFromHour
    : h >= a.darkFromHour && h < a.lightFromHour;
}

/** The data-theme for <html>: null = follow the phone (CSS media query). */
export function themeFor(
  mode: Appearance,
  hours: EveningHours,
  now: Date,
): 'light' | 'dark' | null {
  if (mode === 'system') return null;
  if (mode === 'auto') return isEvening(now, hours) ? 'dark' : 'light';
  return mode;
}

export function applyAppearance(mode: Appearance, hours: EveningHours, now = new Date()): void {
  const root = globalThis.document?.documentElement;
  if (!root) return;
  const theme = themeFor(mode, hours, now);
  if (theme) root.setAttribute('data-theme', theme);
  else root.removeAttribute('data-theme');
}
