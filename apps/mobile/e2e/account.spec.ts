import { expect, test, type Page } from '@playwright/test';
import { enterCode, signUpPatient } from './helpers.ts';

/**
 * v11 (decision 043): one app account for every hospital. Sign up, join without a hospital PIN,
 * reinstall the app (the pretend hospital and account stay), sign in and move the account to
 * "this phone", the hospitals come back; then forgot PIN with the recovery code.
 */
type W = { __ncMock: { fakeServer: { issueInvite(): string } } };
const invite = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as W).__ncMock.fakeServer.issueInvite());

test('v11: sign up, join, reinstall and move back, forgot PIN with the recovery code', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?mockSpeed=20');
  await page.getByTestId('role-patient').click();
  await expect(page.getByTestId('acct-email')).toBeVisible();
  const recovery = await signUpPatient(page, '2580');
  expect(recovery).toMatch(/^([A-Z2-9]{4}-){5}[A-Z2-9]{4}$/);

  await page.getByTestId('invite-text').fill(await invite(page));
  await page.getByTestId('invite-continue').click();
  await expect(page.getByTestId('invite-no-pin')).toBeVisible();
  await page.getByTestId('invite-accept').click();
  await expect(page.getByTestId('hospital-card')).toHaveCount(1);
  await page.getByTestId('home-settings').click();
  await expect(page.getByTestId('account-email')).toContainText('asha@example.com');
  await page.getByRole('button', { name: 'Back' }).click();

  // "Reinstall": the app's data is gone; the pretend hospital and the account remain.
  await page.getByTestId('test-panel-open').click();
  await page.getByTestId('tp-reinstall').click();
  await expect(page.getByTestId('acct-email')).toBeVisible();
  await page.getByTestId('acct-have-account').click();
  await page.getByTestId('acct-email').fill('asha@example.com');
  await page.getByTestId('acct-email-next').click();
  await enterCode(page);
  await page.getByTestId('acct-pin').fill('1111');
  await page.getByTestId('acct-code-next').click();
  await expect(page.getByRole('alert')).toContainText('Wrong PIN');
  await page.getByTestId('acct-pin').fill('2580');
  await page.getByTestId('acct-code-next').click();
  // The old install is still signed in: move the account to this one.
  await expect(page.getByTestId('acct-other-phone')).toBeVisible();
  await page.getByTestId('acct-move').click();
  await expect(page.getByTestId('acct-restored')).toContainText('Demo Hospital', {
    timeout: 30_000,
  });
  await page.getByTestId('acct-welcome-next').click();
  await expect(page.getByTestId('hospital-card')).toHaveCount(1);
  await expect(page.getByTestId('hospital-badge')).toHaveText('Joined');

  // Forgot PIN from the lock screen: e-mail code, recovery code, new PIN, new recovery code.
  await page.getByTestId('lock-now').click();
  await page.getByTestId('lock-forgot').click();
  await page.getByTestId('acct-email-next').click(); // the e-mail is remembered on this phone
  await enterCode(page);
  await page.getByTestId('acct-code-next').click();
  await page.getByTestId('acct-recovery').fill('WRONG-CODE');
  await expect(page.getByTestId('acct-recovery-ok')).toBeDisabled();
  await page.getByTestId('acct-recovery').fill(recovery.toLowerCase());
  await page.getByTestId('acct-recovery-ok').click();
  await page.getByTestId('acct-pin1').fill('135790');
  await page.getByTestId('acct-pin2').fill('135790');
  await page.getByTestId('acct-pin-save').click();
  const next = (await page.getByTestId('acct-recovery-code').textContent())!.trim();
  expect(next).not.toBe(recovery);
  await page.getByTestId('acct-recovery-saved').check();
  await page.getByTestId('acct-recovery-next').click();
  await expect(page.getByTestId('hospital-card')).toHaveCount(1);

  // The new PIN opens the app; the old one does not.
  await page.getByTestId('lock-now').click();
  await page.getByTestId('unlock-secret').fill('2580');
  await page.getByTestId('unlock').click();
  await expect(page.getByRole('alert')).toContainText('not right');
  await page.getByTestId('unlock-secret').fill('135790');
  await page.getByTestId('unlock').click();
  await expect(page.getByTestId('hospital-card')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('v11: Settings shows the account; joining a second hospital asks no PIN', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/?mockSpeed=20');
  await page.getByTestId('role-patient').click();
  await signUpPatient(page, '2580', 'other@example.com');
  await page.getByTestId('invite-text').fill(await invite(page));
  await page.getByTestId('invite-continue').click();
  await page.getByTestId('invite-accept').click();
  await page.getByTestId('join-hospital').click();
  await page.getByTestId('invite-text').fill(await invite(page));
  await page.getByTestId('invite-continue').click();
  await expect(page.getByTestId('pin1')).toHaveCount(0);
  await page.getByTestId('invite-accept').click();
  await page.getByTestId('home-settings').click();
  await expect(page.getByTestId('account-email')).toContainText('other@example.com');
  await expect(page.getByTestId('account-add')).toHaveCount(0);
});
