import type { Page } from '@playwright/test';

/** Long-press the logo to open the engineering menu, then open Device check. */
export async function openDeviceCheck(page: Page): Promise<void> {
  const logo = page.getByTestId('logo');
  await logo.dispatchEvent('pointerdown');
  await page.waitForTimeout(1400);
  await logo.dispatchEvent('pointerup');
  await page.getByTestId('open-device-check').click();
}
