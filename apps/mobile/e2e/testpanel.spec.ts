import { signUpPatient } from './helpers.ts';
import { expect, test } from '@playwright/test';

/**
 * v8 (user, 16 Nov 2026): on a phone's browser there is no console, so the fake mode has a test
 * panel that plays the hospital: patient invite, doctor's record link, clinic queue, start again.
 */
test('test panel: join as a patient and get a record link without a console', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/?mockSpeed=20');
  await page.getByTestId('role-patient').click();
  await page.getByTestId('test-panel-open').click();
  await page.getByTestId('tp-invite').click();
  await expect(page.getByTestId('tp-note')).toContainText('Invite made');
  await page.getByRole('button', { name: 'Close' }).click();
  await signUpPatient(page); // the invite waits for the account
  await expect(page.getByTestId('invite-hospital')).toContainText('Demo Hospital');
  await page.getByTestId('invite-accept').click();
  await expect(page.getByTestId('hospital-card')).toHaveCount(1);

  await page.getByTestId('test-panel-open').click();
  await page.getByTestId('tp-home-link').click();
  await expect(page.getByTestId('tp-note')).toContainText('Record link sent');
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByTestId('hospital-card').click();
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByTestId('todo-record')).toBeVisible();

  // Start again clears everything (the fake server forgets on reload anyway).
  await page.getByTestId('test-panel-open').click();
  await page.getByTestId('tp-start-again').click();
  await expect(page.getByTestId('role-patient')).toBeVisible();
});

test('test panel: a clinic queue patient for today', async ({ page }) => {
  await page.goto('/?mockSpeed=20');
  await page.getByTestId('role-clinic').click();
  await page.getByTestId('clinic-code').fill('DEMO-SITE-1');
  await page.getByTestId('clinic-register').click();
  await page.getByTestId('op-id').fill('OP-07');
  await page.getByTestId('op-password').fill('2468');
  await page.getByTestId('op-sign-in').click();
  await expect(page.getByTestId('queue-empty')).toBeVisible();
  await page.getByTestId('test-panel-open').click();
  await page.getByTestId('tp-clinic').click();
  await expect(page.getByTestId('tp-note')).toContainText('added for today');
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByTestId('queue-item')).toHaveCount(1);
});
