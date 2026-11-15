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
}
