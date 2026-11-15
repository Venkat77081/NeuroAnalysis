import { defineConfig, devices } from '@playwright/test';

/** M14: the dashboard against the real platform, connector and a FHIR stand-in (global-setup). */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  globalSetup: './e2e/global-setup.ts',
  use: { baseURL: 'http://localhost:5174', trace: 'off', ...devices['Desktop Chrome'] },
  webServer: {
    command: 'pnpm build && cp e2e/config.e2e.json dist/config.json && pnpm preview',
    url: 'http://localhost:5174',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
