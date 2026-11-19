/**
 * v13 (decision 045) and v14 (decision 046): hospital settings and clinic hours; the time helpers
 * the desk's panels share (desk.tsx).
 *
 * - MovePanel: the front desk picks a new date, then a doctor and a free time (doctors' clinic
 *   hours minus their booked appointments), and moves the appointment; or answers a patient's
 *   request with "please call us" / "keep the booked date".
 * - ChangeRequests: patients' open requests, oldest first.
 * - HospitalSettingsPage: phones' camera-check pass level, change cut-off, time zone.
 * - ClinicHours (hours.tsx): each doctor's weekly hours and leave, on Settings.
 * Times are the hospital's own time zone (the settings), whatever the browser's zone is.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { call } from './api.ts';
import { ClinicHours } from './hours.tsx';
import { Button, Card, ErrorNote, Notice, Page, SettingsLayout } from './ui.tsx';

// --- Time in the hospital's zone ---

function parts(utcMs: number, tz: string): Record<string, number> {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  return Object.fromEntries(
    p.filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]),
  );
}
function offsetMs(utcMs: number, tz: string): number {
  const x = parts(utcMs, tz);
  return Date.UTC(x.year!, x.month! - 1, x.day!, x.hour!, x.minute!, x.second!) - utcMs;
}
const pad = (n: number) => String(n).padStart(2, '0');
/** "2026-11-26" in the hospital's zone. */
export function zonedDay(iso: string | number, tz: string): string {
  const x = parts(typeof iso === 'number' ? iso : Date.parse(iso), tz);
  return `${x.year}-${pad(x.month!)}-${pad(x.day!)}`;
}
export function zonedTime(iso: string, tz: string): string {
  const x = parts(Date.parse(iso), tz);
  return `${pad(x.hour!)}:${pad(x.minute!)}`;
}
/** A local day and "HH:MM" in `tz` as an ISO time (UTC). */
export function zonedIso(day: string, hhmm: string, tz: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y!, m! - 1, d!, h!, mi!);
  let t = guess - offsetMs(guess, tz);
  const again = guess - offsetMs(t, tz);
  if (again !== t) t = again;
  return new Date(t).toISOString();
}
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
}
/** Monday = 0. */
export function weekday(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return (new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay() + 6) % 7;
}
export function fmtDay(day: string, withWeekday = true): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!, 12)).toLocaleDateString('en-IN', {
    timeZone: 'UTC',
    ...(withWeekday ? { weekday: 'short' } : {}),
    day: 'numeric',
    month: 'short',
  });
}
export function fmtTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2000, 0, 1, h, m)).toLocaleTimeString('en-IN', {
    timeZone: 'UTC',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// --- Types ---

export interface Settings {
  device_min_fps: number;
  change_cutoff_hours: number;
  patient_changes: boolean;
  time_zone: string;
  device_min_fps_options: number[];
  change_cutoff_hour_options: number[];
  warn_below_fps: number;
  // v14 (decision 046)
  patient_booking: boolean;
  booking_preferred: number;
  booking_alternatives: number;
  times_per_date: number;
  booking_days_ahead: number;
  booking_min_days: number;
  offer_max: number;
  offer_reply_hours: number;
  recording_valid_days: number;
  record_due_days_before: number;
  // v16 (decision 047)
  clinic_phone_consent: boolean;
  options: Record<string, number[]>;
}
type NumKey =
  | 'booking_preferred'
  | 'booking_alternatives'
  | 'times_per_date'
  | 'booking_days_ahead'
  | 'booking_min_days'
  | 'offer_max'
  | 'offer_reply_hours'
  | 'recording_valid_days'
  | 'record_due_days_before';
export function useSettings(): Settings | null {
  const [s, setS] = useState<Settings | null>(null);
  useEffect(() => {
    call<Settings>('GET', '/hospital/settings').then(setS, () => undefined);
  }, []);
  return s;
}

// --- Hospital settings (hospital admin) ---

function timeZones(current: string): string[] {
  const all = (
    Intl as unknown as { supportedValuesOf?: (k: string) => string[] }
  ).supportedValuesOf?.('timeZone') ?? ['UTC'];
  return all.includes(current) ? all : [current, ...all];
}

export function HospitalSettingsPage() {
  const { t } = useTranslation();
  const [s, setS] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Partial<Settings>>({});
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    call<Settings>('GET', '/hospital/settings').then(setS, setError);
  }, []);
  const v = { ...s, ...draft } as Settings;
  const save = async () => {
    setError(null);
    setSaved(false);
    try {
      setS(await call<Settings>('PUT', '/hospital/settings', draft));
      setDraft({});
      setSaved(true);
    } catch (e) {
      setError(e);
    }
  };
  const select = 'h-11 rounded-2xl border border-edge bg-card px-2 font-normal';
  /** v14: one setting chosen from its list (config/platform.json). */
  const num = (k: NumKey) => (
    <label key={k} className="contents text-[14px]">
      <span>{t(`settings.num.${k}.label`)}</span>
      <select
        value={v[k]}
        onChange={(e) => setDraft((d) => ({ ...d, [k]: Number(e.target.value) }))}
        className={select}
        data-testid={`settings-${k}`}
      >
        {(s?.options[k] ?? []).map((o) => (
          <option key={o} value={o}>
            {t(`settings.num.${k}.value`, { count: o })}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <Page title={t('settings.title')}>
      <ErrorNote error={error} />
      {saved && <Notice testId="settings-saved">{t('settings.saved')}</Notice>}
      {s && (
        <SettingsLayout
          sections={[
            { id: 'set-hours', label: t('hours.title') },
            { id: 'set-phones', label: t('settings.phonesTitle') },
            { id: 'set-changes', label: t('settings.changesTitle') },
            { id: 'set-booking', label: t('settings.bookingTitle') },
            { id: 'set-offers', label: t('settings.offersTitle') },
            { id: 'set-recordings', label: t('settings.recordingsTitle') },
            { id: 'set-consent', label: t('settings.consentTitle') },
          ]}
        >
          <div id="set-hours">
            <ClinicHours />
          </div>
          <Card title={t('settings.phonesTitle')} testId="settings-phones" id="set-phones">
            <span className="text-[14px] text-sub">{t('settings.phonesHint')}</span>
            <label className="flex max-w-md flex-col gap-1 text-[13px] font-semibold text-sub">
              {t('settings.minFps')}
              <select
                value={v.device_min_fps}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, device_min_fps: Number(e.target.value) }))
                }
                className={select}
                data-testid="settings-fps"
              >
                {s.device_min_fps_options.map((o) => (
                  <option key={o} value={o}>
                    {t('settings.fpsOption', { fps: o })}
                  </option>
                ))}
              </select>
            </label>
            <span className="text-[13px] text-muted">
              {t('settings.fpsNote', { warn: s.warn_below_fps })}
            </span>
          </Card>
          <Card title={t('settings.changesTitle')} testId="settings-changes" id="set-changes">
            <label className="flex min-h-11 items-center gap-2 text-[14px]">
              <input
                type="checkbox"
                checked={v.patient_changes}
                onChange={(e) => setDraft((d) => ({ ...d, patient_changes: e.target.checked }))}
                className="h-4 w-4"
                data-testid="settings-patient-changes"
              />
              {t('settings.patientChanges')}
            </label>
            <label className="flex max-w-md flex-col gap-1 text-[13px] font-semibold text-sub">
              {t('settings.cutoff')}
              <select
                value={v.change_cutoff_hours}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, change_cutoff_hours: Number(e.target.value) }))
                }
                className={select}
                data-testid="settings-cutoff"
              >
                {s.change_cutoff_hour_options.map((o) => (
                  <option key={o} value={o}>
                    {t('settings.hours', { count: o })}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex max-w-md flex-col gap-1 text-[13px] font-semibold text-sub">
              {t('settings.timeZone')}
              <select
                value={v.time_zone}
                onChange={(e) => setDraft((d) => ({ ...d, time_zone: e.target.value }))}
                className={select}
                data-testid="settings-tz"
              >
                {timeZones(v.time_zone).map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            </label>
            <span className="text-[13px] text-muted">{t('settings.timeZoneHint')}</span>
          </Card>
          <Card title={t('settings.bookingTitle')} testId="settings-booking" id="set-booking">
            <label className="flex min-h-11 items-center gap-2 text-[14px]">
              <input
                type="checkbox"
                checked={v.patient_booking}
                onChange={(e) => setDraft((d) => ({ ...d, patient_booking: e.target.checked }))}
                className="h-4 w-4"
                data-testid="settings-patient-booking"
              />
              {t('settings.patientBooking')}
            </label>
            <div className="grid max-w-2xl grid-cols-[1fr_220px] items-center gap-x-4 gap-y-2.5">
              {(
                [
                  'booking_preferred',
                  'booking_alternatives',
                  'times_per_date',
                  'booking_days_ahead',
                  'booking_min_days',
                ] as NumKey[]
              ).map((k) => num(k))}
            </div>
            <span className="text-[13px] text-muted">{t('settings.bookingHint')}</span>
          </Card>
          <Card title={t('settings.offersTitle')} testId="settings-offers" id="set-offers">
            <div className="grid max-w-2xl grid-cols-[1fr_220px] items-center gap-x-4 gap-y-2.5">
              {(['offer_max', 'offer_reply_hours'] as NumKey[]).map((k) => num(k))}
            </div>
            <span className="text-[13px] text-muted">{t('settings.offersHint')}</span>
          </Card>
          <Card
            title={t('settings.recordingsTitle')}
            testId="settings-recordings"
            id="set-recordings"
          >
            <div className="grid max-w-2xl grid-cols-[1fr_220px] items-center gap-x-4 gap-y-2.5">
              {(['recording_valid_days', 'record_due_days_before'] as NumKey[]).map((k) => num(k))}
            </div>
            <span className="text-[13px] text-muted">{t('settings.recordingsHint')}</span>
          </Card>
          <Card title={t('settings.consentTitle')} testId="settings-consent" id="set-consent">
            <label className="flex min-h-11 items-center gap-2 text-[14px]">
              <input
                type="checkbox"
                checked={v.clinic_phone_consent}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, clinic_phone_consent: e.target.checked }))
                }
                className="h-4 w-4"
                data-testid="settings-phone-consent"
              />
              {t('settings.phoneConsent')}
            </label>
            <span className="text-[13px] text-muted">{t('settings.consentHint')}</span>
          </Card>
          <Button
            className="self-start"
            disabled={!Object.keys(draft).length}
            onClick={() => void save()}
            data-testid="settings-save"
          >
            {t('settings.save')}
          </Button>
        </SettingsLayout>
      )}
    </Page>
  );
}
