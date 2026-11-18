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
    /**
     * Staff sign-in reset link lifetime (decision 039).
     */
    resetTtlHours: number;
    /**
     * Reasons an admin picks when resetting someone's sign-in (kept in the log).
     *
     * @minItems 1
     */
    resetReasons: [string, ...string[]];
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
    /**
     * Pass levels a hospital admin may choose for its phones (v13); the lowest is minFps. A hospital can be stricter, never looser.
     *
     * @minItems 1
     */
    minFpsOptions: [number, ...number[]];
  };
  /**
   * v10 Overview pages (decision 042): time windows for the cards and the chart.
   */
  overview?: {
    /**
     * Chart periods offered (days back, counted per week).
     */
    periodsDays: {
      '4w': number;
      '12w': number;
      '1y': number;
    };
    /**
     * 'Recordings (30 days)', 'not used in 30 days', 'onboarded this month'.
     */
    recentDays: number;
    /**
     * Front desk: invites sent and patients not in the app with an appointment within this many days.
     */
    inviteDays: number;
    /**
     * Front desk chart: appointments per day for the next N days.
     */
    deskDays: number;
    doctorUpcomingDays: number;
    /**
     * Doctor: home links recorded by their due date over this many days.
     */
    onTimeDays: number;
  };
  /**
   * v11 patient app account (decision 043): e-mail codes, PIN pause, recovery code length. Wrong PINs use patientPin.maxFailures.
   */
  appAccount?: {
    codeTtlMinutes: number;
    codeMaxPerHour: number;
    codeMaxAttempts: number;
    pauseHours: number;
    recoveryCodeChars: 24;
  };
  /**
   * v13/v14: appointment changes and booking from the app. Patients ask for exact free times (preferred and alternative dates) to change or book; the desk books one, offers up to offerMax held times, or declines; both sides may cancel with a reason; recordings follow a moved appointment (recordingValidDays).
   */
  appointmentChanges: {
    /**
     * Default: patients may ask until this many hours before the appointment (a hospital admin can change it).
     */
    cutoffHours: number;
    /**
     * @minItems 1
     */
    cutoffHourOptions: [number, ...number[]];
    maxDays: number;
    maxDaysAhead: number;
    patientReasons: string[];
    declineAnswers: string[];
    deskReasons: string[];
    answerShownDays: number;
    movedShownDays: number;
    slotMinutes: number;
    /**
     * @minItems 1
     */
    slotMinuteOptions: [number, ...number[]];
    /**
     * Default time zone by hospital region; a hospital admin can change it.
     */
    timeZones: {
      [k: string]: string;
    };
    defaultTimeZone: string;
    bookingPreferred: number;
    /**
     * @minItems 1
     */
    bookingPreferredOptions: [number, ...number[]];
    bookingAlternatives: number;
    /**
     * @minItems 1
     */
    bookingAlternativeOptions: [number, ...number[]];
    timesPerDate: number;
    /**
     * @minItems 1
     */
    timesPerDateOptions: [number, ...number[]];
    bookingDaysAhead: number;
    /**
     * @minItems 1
     */
    bookingDaysAheadOptions: [number, ...number[]];
    bookingMinDays: number;
    /**
     * @minItems 1
     */
    bookingMinDayOptions: [number, ...number[]];
    offerMax: number;
    /**
     * @minItems 1
     */
    offerMaxOptions: [number, ...number[]];
    offerReplyHours: number;
    /**
     * @minItems 1
     */
    offerReplyHourOptions: [number, ...number[]];
    recordingValidDays: number;
    /**
     * @minItems 1
     */
    recordingValidDayOptions: [number, ...number[]];
    /**
     * @minItems 1
     */
    recordDueDaysBeforeOptions: [number, ...number[]];
    /**
     * @minItems 1
     */
    cancelReasons: [string, ...string[]];
    /**
     * @minItems 1
     */
    patientCancelReasons: [string, ...string[]];
    /**
     * @minItems 1
     */
    bookingPurposes: [string, ...string[]];
    /**
     * @minItems 1
     */
    bookingDeclineAnswers: [string, ...string[]];
    cancelledShownDays: number;
    /**
     * v17: past appointments shown in the patient app's Appointment history.
     */
    patientHistoryMax: number;
    /**
     * v17: most days one calendar request may ask free-time counts for.
     */
    freeDaysMaxSpan: number;
  };
  /**
   * v16 (decision 047): clinic recordings need the patient's consent, given in their app and shown as a one-time QR code (prefix + code) the clinic phone scans; or, when the hospital allows it, on the clinic phone with a reason.
   */
  clinicConsent: {
    qrPrefix: string;
    codeLength: number;
    /**
     * @minItems 1
     */
    fallbackReasons: [string, ...string[]];
  };
}
