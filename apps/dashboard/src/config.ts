/** Values the dashboards share with the app and server (config/platform.json). */
import platformJson from '../../../config/platform.json' with { type: 'json' };

/** Camera check (decision 035): phones pass at minFps; below warnBelowFps they are borderline. */
export const deviceCheck: { minFps: number; warnBelowFps: number; usageDays: number } =
  platformJson.deviceCheck;

/** Staff sign-in reset (decision 039): link lifetime and the reasons an admin picks. */
export const staffReset: { resetTtlHours: number; resetReasons: string[] } = platformJson.staff;
