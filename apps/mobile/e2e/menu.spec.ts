import { expect, test } from '@playwright/test';

// Decision 041: the long-press menu is on the first screen too, and offers only the language,
// the frame-rate limit, the camera frame-rate check and (debug APK) test mode.
test('long-press menu on the first screen: frame-rate check, no developer tools', async ({
  page,
}) => {
  await page.goto('/?mockSpeed=20');
  const logo = page.getByTestId('logo');
  await logo.dispatchEvent('pointerdown');
  await page.waitForTimeout(1400);
  await logo.dispatchEvent('pointerup');
  await expect(page.getByTestId('language-select')).toBeVisible();
  await expect(page.getByTestId('min-fps-select')).toBeVisible();
  await expect(page.getByTestId('open-device-check')).toHaveCount(0);
  await expect(page.getByTestId('advisory-toggle')).toHaveCount(0);
  await expect(page.getByText('The browser version always uses a pretend hospital')).toHaveCount(1);
  await page.getByTestId('open-fps-check').click();
  await expect(page.getByTestId('device-check-fps')).toBeVisible({ timeout: 20_000 });
});
