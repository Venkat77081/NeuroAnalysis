import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: { baseURL: 'http://localhost:4173', trace: 'off' },
  globalSetup: './e2e/support/global-setup.ts',
  projects: [
    { name: 'phone', use: { ...devices['Pixel 7'] }, testIgnore: /qr(-clinic)?\.spec\.ts/ },
    {
      // M13 QR scanner: a fake camera that shows an invite QR code.
      name: 'qr-camera',
      testMatch: /qr\.spec\.ts/,
      use: {
        ...devices['Pixel 7'],
        permissions: ['camera'],
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--use-file-for-fake-video-capture=test-results/qr-invite.y4m',
          ],
        },
      },
    },
    {
      // v29 (decision 052): a fake camera that shows a clinic-phone registration QR code.
      name: 'qr-clinic-camera',
      testMatch: /qr-clinic\.spec\.ts/,
      use: {
        ...devices['Pixel 7'],
        permissions: ['camera'],
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--use-file-for-fake-video-capture=test-results/qr-device.y4m',
          ],
        },
      },
    },
  ],
  webServer: {
    command: 'pnpm build && pnpm preview',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
