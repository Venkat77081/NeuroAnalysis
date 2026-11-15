import { expect, test, type Page } from '@playwright/test';

/** M7: register with the built-in test server (mock mode), sign in, and upload a session. */
const URL = '/?mode=clinic-local&mockSpeed=20';

async function oneTakeThenEnd(page: Page) {
  await page.getByTestId('choose-patient').click();
  await page.getByTestId('patient-ref-input').fill('C3301');
  await page.getByTestId('save-patient').click();
  await page.getByTestId('med-ON').click();
  await page.getByTestId('consent').check();
  await page.getByTestId('start-session').click();
  await page.getByTestId('set-up-camera').click();
  await page.getByTestId('record').click();
  await expect(page.getByTestId('verdict-card')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('accept').click();
  await page.getByTestId('end-early').click();
  await page.getByLabel('Out of time').check();
  await page.getByTestId('confirm-abort').click();
  await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible();
}

test('M7: without a server the summary says takes stay on the phone', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(URL);
  await oneTakeThenEnd(page);
  await expect(page.getByTestId('upload-not-linked')).toBeVisible();
  await expect(page.getByTestId('upload-sign-in')).toHaveText('Set up uploads');
});
