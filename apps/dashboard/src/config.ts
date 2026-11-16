/** Values the dashboards share with the app and server (config/platform.json). */
import platformJson from '../../../config/platform.json' with { type: 'json' };

/** Camera check (decision 035): phones pass at minFps; below warnBelowFps they are borderline. */
export const deviceCheck: { minFps: number; warnBelowFps: number; usageDays: number } =
  platformJson.deviceCheck;
