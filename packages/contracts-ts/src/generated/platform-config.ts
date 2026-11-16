/* eslint-disable */
/** GENERATED from /contracts by scripts/gen.ts — do not edit. Run `pnpm contracts:gen`. */

/**
 * Account and invite policy for hospitals, staff, operators and patients (PLATFORM_PLAN M10). Schema version 1.0.0.
 */
export interface PlatformConfig {
  schemaVersion: '1.0.0';
  configVersion: string;
  invites: {
    patientTtlDays: number;
    staffTtlDays: number;
    deviceCodeTtlHours: number;
    deviceCodeLength: number;
  };
  passwords: {
    minLength: number;
    temporaryLength: number;
  };
  patientPin: {
    minDigits: number;
    maxDigits: number;
    maxFailures: number;
  };
  staff: {
    twoStepRequired: boolean;
    maxFailedLogins: number;
  };
  consentVersion: string;
  /**
   * Recording plan for a patient until their doctor sets one (M13).
   */
  defaultPlan: {
    /**
     * @minItems 1
     */
    tests: ['FT' | 'FTF' | 'FR' | 'SAW' | 'FA', ...('FT' | 'FTF' | 'FR' | 'SAW' | 'FA')[]];
    everyDays: number;
    medState: 'OFF' | 'ON' | 'ANY';
  };
  app: {
    operatorAutoLockMin: number;
    patientAutoLockMin: number;
    /**
     * Home walking test only with a helper holding the phone.
     */
    homeSawNeedsHelper: boolean;
  };
  /**
   * Clinic operators (M13): wrong passwords in a row before the account locks; a hospital admin unlocks it.
   */
  operators: {
    maxFailedLogins: number;
  };
  /**
   * Recording requests for appointments (v3): when they are due, re-record deadline, reminder lead time, how far ahead reception sees appointments.
   */
  requests: {
    defaultDueDaysBefore: number;
    rerecordDueDays: number;
    reminderHoursBefore: number;
    appointmentWindowDays: number;
    /**
     * Why an operator could not record a clinic request (codes; texts are in the app's i18n).
     *
     * @minItems 1
     */
    clinicNotDoneReasons: [string, ...string[]];
    /**
     * Longest time window a clinic phone may ask the queue for.
     */
    clinicQueueMaxHours: number;
  };
  /**
   * Per-hospital permissions (decision 033): what each role may do by default, and which roles a platform admin may grant it to. Clinical data, patient identity, consent and logging are fixed in code and are not listed here.
   */
  permissions: {
    /**
     * This interface was referenced by `undefined`'s JSON-Schema definition
     * via the `patternProperty` "^[a-z]+\.[a-z]+$".
     */
    [k: string]: {
      group: 'patients' | 'appointments' | 'requests' | 'clinic' | 'setup';
      default: ('hospital_admin' | 'receptionist' | 'doctor' | 'operator')[];
      /**
       * @minItems 1
       */
      eligible: [
        'hospital_admin' | 'receptionist' | 'doctor' | 'operator',
        ...('hospital_admin' | 'receptionist' | 'doctor' | 'operator')[]
      ];
    };
  };
  /**
   * Camera check before a phone is added (user, 16 Nov 2026): clinic phones before their registration code is used, patients before their invite is accepted.
   */
  deviceCheck: {
    minFps: number;
    /**
     * Passed but below this: 'borderline', some takes may need repeating (takes fail below the session minimum, 59 by default).
     */
    warnBelowFps: number;
    durationS: number;
    facing: 'back' | 'front';
    resolution: '1080p' | '720p';
    /**
     * Phones list: takes recorded on each phone over this many days, and how many were below warnBelowFps.
     */
    usageDays: number;
  };
}
