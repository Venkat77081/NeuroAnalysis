import { expect, test } from '@playwright/test';
import { QR_INVITE_TOKEN } from './support/global-setup.ts';

/** M13: the in-app scanner reads the invite QR code from the camera (Chromium fake camera). */
test('M13: scanning the invite QR code opens the PIN screen', async ({ page }) => {
  await page.goto('/?mockSpeed=20');
  await page.evaluate((tok) => {
    (
      globalThis as unknown as { __ncMock: { fakeServer: { issueInvite(t: string): string } } }
    ).__ncMock.fakeServer.issueInvite(tok);
  }, QR_INVITE_TOKEN);
  await page.getByTestId('role-patient').click();
  await page.getByTestId('invite-scan').click();
  await expect(page.getByTestId('qr-scanner')).toBeVisible();
  await expect(page.getByTestId('invite-hospital')).toContainText('Demo Hospital', {
    timeout: 15_000,
  });
  await expect(page.getByTestId('qr-scanner')).toBeHidden();
  await expect(page.getByTestId('pin1')).toBeVisible();
});
