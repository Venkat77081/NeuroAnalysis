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
} = platformJson.appointmentChanges;

/** v29 (decision 052): the clinic-phone registration QR holds this prefix + the code. */
export const deviceQrPrefix: string = platformJson.invites.deviceQrPrefix;

/** v30: each test's fixed take length in seconds (config/tests), shown on recording tiles. */
export const takeSeconds: Record<string, number> = Object.fromEntries(
  [FT, FTF, FR, SAW, FA].map((c) => [c.code, c.task.durationS]),
);

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
