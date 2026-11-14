import { expect, test } from '@playwright/test';
import { openDeviceCheck } from './helpers.ts';

test('device check runs the mock benchmark and assigns Tier W', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await openDeviceCheck(page);
  await expect(page.getByRole('heading', { name: 'Device check' })).toBeVisible();
  await expect(page.getByTestId('capabilities')).toContainText('MockCaptureKit');
  await page.getByTestId('run-benchmark').click();
  await expect(page.getByTestId('benchmark-progress')).toBeVisible();
  await expect(page.getByTestId('tier-badge')).toHaveText('Tier W · demo only', {
    timeout: 15_000,
  });
  await expect(page.getByTestId('tier-result')).toContainText(
    'mock or webcam capture is never clinical',
  );
  await expect(page.getByTestId('tier-result')).toContainText('none (clinical capture blocked)');
  await expect(page.getByTestId('tier-result')).toContainText(
    /Saved: mock-MockCaptureKit-60fps-.*\.json/,
  );
  await page.screenshot({ path: 'test-results/device-check-mock.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('camera preview test draws the overlay and shows analysis stats', async ({ page }) => {
  await page.goto('/');
  await openDeviceCheck(page);
  await page.getByRole('button', { name: 'Camera preview test' }).click();
  await expect(page.getByTestId('camera-test')).toBeVisible();
  await expect(page.getByTestId('camera-test-stats')).toContainText(/Analysis [1-9]\d* fps/, {
    timeout: 5_000,
  });
  await expect(page.locator('html')).toHaveClass(/camera-active/);
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('html')).not.toHaveClass(/camera-active/);
});
