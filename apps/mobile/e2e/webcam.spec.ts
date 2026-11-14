import { expect, test } from '@playwright/test';
import { openDeviceCheck } from './helpers.ts';

// Webcam mode (Tier W) with Chromium's fake camera: real MediaPipe for Web, real MediaRecorder.
test.use({
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
  permissions: ['camera'],
});

test('MediaPipe for Web loads and emits analysis frames; a take is recorded', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'fake camera flags are Chromium-only');
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?impl=webcam');
  await openDeviceCheck(page);
  await page.getByTestId('open-tracking-test').click();
  await page.getByTestId('tracking-test-select').selectOption('FT');
  await page.getByTestId('tracking-run').click();
  await expect(page.locator('video[data-capturekit-preview]')).toBeAttached({ timeout: 30_000 });
  await expect(page.getByTestId('tracking-hud')).toContainText('fps', { timeout: 60_000 });
  await expect(page.getByTestId('tracking-result')).toHaveCount(1, { timeout: 60_000 });
  const text = await page.getByTestId('tracking-result').innerText();
  const events = Number(/(\d+) events/.exec(text)?.[1] ?? 0);
  // Smoke test only: CPU MediaPipe on CI runners is slow. Speed is measured on phones (M4 QA).
  expect(events).toBeGreaterThan(5);
  expect(text).toContain('0 tracker-error frames');
  expect(errors).toEqual([]);
});
