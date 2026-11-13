import { expect, test } from '@playwright/test';

test('placeholder home screen runs in mock mode', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Foundation build' })).toBeVisible();
  await expect(page.getByTestId('mode-badge')).toHaveText('Mock mode · not for clinical data');
  await expect(page.getByTestId('config-status')).toHaveText('All configs valid');
  await expect(page.getByTestId('test-plan').locator('li')).toHaveCount(7);
  await expect(page.getByTestId('test-plan')).toContainText('30 s');
  // MockCaptureKit replays the sample fixture: frames keep arriving.
  await expect(page.getByTestId('frame-count')).toContainText(/\d+ analysis frames received/);
  await page.screenshot({ path: 'test-results/home-mock.png', fullPage: true });
  expect(errors).toEqual([]);
});
