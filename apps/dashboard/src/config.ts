/** Values the dashboards share with the app and server (config/platform.json). */
import platformJson from '../../../config/platform.json' with { type: 'json' };
import FT from '../../../config/tests/FT.json' with { type: 'json' };
import FTF from '../../../config/tests/FTF.json' with { type: 'json' };
import FR from '../../../config/tests/FR.json' with { type: 'json' };
import SAW from '../../../config/tests/SAW.json' with { type: 'json' };
import FA from '../../../config/tests/FA.json' with { type: 'json' };

/** Camera check (decision 035): phones pass at minFps; below warnBelowFps they are borderline. */
export const deviceCheck: { minFps: number; warnBelowFps: number; usageDays: number } =
  platformJson.deviceCheck;

/** Staff sign-in reset (decision 039): link lifetime and the reasons an admin picks. */
export const staffReset: { resetTtlHours: number; resetReasons: string[] } = platformJson.staff;

/** v13 (decision 045): appointment changes, the choices offered and how long badges show. */
export const appointmentChanges: {
  deskReasons: string[];
  declineAnswers: string[];
  patientReasons: string[];
  cancelReasons: string[];
  patientCancelReasons: string[];
  bookingPurposes: string[];
  bookingDeclineAnswers: string[];
  movedShownDays: number;
  slotMinuteOptions: number[];
  undoSeconds: number;
  /** v31: rows the clinic hours grid starts with, and where Afternoon starts in time lists. */
  clinicBlocks: string[][];
  afternoonFrom: string;
} = platformJson.appointmentChanges;

/** v29 (decision 052): the clinic-phone registration QR holds this prefix + the code. */
export const deviceQrPrefix: string = platformJson.invites.deviceQrPrefix;

/** v30: each test's fixed take length in seconds (config/tests), shown on recording tiles. */
export const takeSeconds: Record<string, number> = Object.fromEntries(
  [FT, FTF, FR, SAW, FA].map((c) => [c.code, c.task.durationS]),
);

/**
 * v31 (decision 054): the lengths each test may be set to (config/tests durationOptionsS): the
 * default and longer ones only, never shorter (user, 19 Nov 2026).
 */
export const takeOptions: Record<string, number[]> = Object.fromEntries(
  [FT, FTF, FR, SAW, FA].map((c) => {
    const opts = (c.task as { durationOptionsS?: number[] }).durationOptionsS ?? [];
    const ok = [...new Set([c.task.durationS, ...opts.filter((o) => o >= c.task.durationS)])];
    return [c.code, ok.sort((a, b) => a - b)];
  }),
);
/** The tests in protocol order (DNE). */
export const testOrder: string[] = [FT, FTF, FR, SAW, FA].map((c) => c.code);

/** v31: Automatic appearance is dark from darkFromHour until lightFromHour (local time). */
export const appearance: { darkFromHour: number; lightFromHour: number } = platformJson.appearance;

/** v30: platform rules shown (read only) on Platform settings. */
export const platformPolicy = {
  twoStepRequired: platformJson.staff.twoStepRequired as boolean,
  staffInviteDays: platformJson.invites.staffTtlDays as number,
  patientInviteDays: platformJson.invites.patientTtlDays as number,
  pinTries: platformJson.patientPin.maxFailures as number,
  consentVersion: platformJson.consentVersion as string,
  fpsOptions: platformJson.deviceCheck.minFpsOptions as number[],
  warnBelowFps: platformJson.deviceCheck.warnBelowFps as number,
  deviceCodeHours: platformJson.invites.deviceCodeTtlHours as number,
};
