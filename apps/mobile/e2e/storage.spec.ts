import { expect, test, type Page } from '@playwright/test';
import { signUpPatient } from './helpers.ts';

/**
 * Decision 044: NeuroCapture stores no videos. Until a hospital connects its own storage, its
 * clinic phones cannot start a recording and patients see "Getting ready".
 */
type W = { __ncMock: { fakeServer: { canRecord: boolean; issueInvite(): string } } };
const notReady = (page: Page) =>
  page.evaluate(() => {
    (globalThis as unknown as W).__ncMock.fakeServer.canRecord = false;
  });

test('clinic phone: queue shown, Start off until the hospital connects storage', async ({
  page,
}) => {
  await page.goto('/?mockSpeed=20');
  await notReady(page);
  await page.getByTestId('role-clinic').click();
  await page.getByTestId('clinic-code').fill('DEMO-SITE-1');
  await page.getByTestId('clinic-register').click();
  await page.getByTestId('op-id').fill('OP-07');
  await page.getByTestId('op-password').fill('2468');
  await page.getByTestId('op-sign-in').click();
  await page.getByTestId('test-panel-open').click();
  await page.getByTestId('tp-clinic').click();
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByTestId('queue-not-ready')).toContainText(
    'not ready to receive recordings',
  );
  await expect(page.getByTestId('queue-start')).toBeDisabled();
  // Storage connected: Start opens.
  await page.evaluate(() => {
    (globalThis as unknown as W).__ncMock.fakeServer.canRecord = true;
  });
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByTestId('queue-not-ready')).toHaveCount(0);
  await expect(page.getByTestId('queue-start')).toBeEnabled();
});

test('patient: a hospital without storage shows "Getting ready"', async ({ page }) => {
  await page.goto('/?mockSpeed=20');
  await notReady(page);
  await page.getByTestId('role-patient').click();
  await signUpPatient(page);
  const link = await page.evaluate(() =>
    (globalThis as unknown as W).__ncMock.fakeServer.issueInvite(),
  );
  await page.getByTestId('invite-text').fill(link);
  await page.getByTestId('invite-continue').click();
  await page.getByTestId('invite-accept').click();
  await expect(page.getByTestId('hospital-badge')).toHaveText('Getting ready');
  await page.getByTestId('hospital-card').click();
  await expect(page.getByTestId('hospital-not-ready')).toContainText('finishes setting up');
});
