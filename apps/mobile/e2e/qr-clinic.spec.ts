import { expect, test } from '@playwright/test';

/**
 * v29 (decision 052): a new clinic phone scans the registration QR from the dashboard's Phones
 * page (Chromium fake camera) and is registered without typing the code.
 */
test('v29: scanning the registration QR registers the clinic phone', async ({ page }) => {
  await page.goto('/?mockSpeed=20');
  await page.getByTestId('role-clinic').click();
  await page.getByTestId('clinic-scan').click();
  await expect(page.getByTestId('qr-scanner')).toBeVisible();
  await expect(page.getByTestId('op-id')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('qr-scanner')).toBeHidden();
});
