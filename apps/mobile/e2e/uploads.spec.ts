import { expect, test, type Page } from '@playwright/test';

/** M7: register with the built-in test server (mock mode), sign in, and upload a session. */
const URL = '/?mockSpeed=20';

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

test('M7: enroll, sign in, upload a session in the background', async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL);
  await page.getByTestId('open-upload-setup').click();
  await expect(page.getByTestId('server-input')).toHaveValue('fake://api');
  await page.getByTestId('enroll-input').fill('WRONG-CODE');
  await page.getByTestId('enroll').click();
  await expect(page.getByRole('alert')).toContainText('not accepted');
  await page.getByTestId('enroll-input').fill('DEMO-SITE-1');
  await page.getByTestId('enroll').click();
  await expect(page.getByTestId('enrolled')).toBeVisible();
  await page.getByTestId('login-operator').fill('OP-07');
  await page.getByTestId('login-pin').fill('1111');
  await page.getByTestId('sign-in').click();
  await expect(page.getByRole('alert')).toContainText('PIN is wrong');
  await page.getByTestId('login-pin').fill('2468');
  await page.getByTestId('sign-in').click();
  await expect(page.getByTestId('signed-in')).toContainText('OP-07');
  await page.getByTestId('upload-setup-close').click();

  await oneTakeThenEnd(page);
  await expect(page.getByTestId('upload-FT')).toHaveText('Uploaded', { timeout: 15_000 });
  await expect(page.getByTestId('upload-summary')).toContainText('All takes uploaded');
  await page.screenshot({ path: 'test-results/upload-summary.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('M7: without a server the summary says takes stay on the phone', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(URL);
  await oneTakeThenEnd(page);
  await expect(page.getByTestId('upload-not-linked')).toBeVisible();
  await expect(page.getByTestId('upload-sign-in')).toHaveText('Set up uploads');
});
