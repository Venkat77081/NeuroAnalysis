import type { Page } from '@playwright/test';

/** Long-press the logo to open the engineering menu, then open Device check. */
export async function openDeviceCheck(page: Page): Promise<void> {
  const logo = page.getByTestId('logo');
  await logo.dispatchEvent('pointerdown');
  await page.waitForTimeout(1400);
  await logo.dispatchEvent('pointerup');
  await page.getByTestId('open-device-check').click();
}

/**
 * v11 (decision 043): a new patient install signs up first (e-mail, code from the pretend
 * server's hint, app PIN, recovery code). Returns the recovery code.
 */
export async function signUpPatient(page: Page, pin = '2580', email = 'asha@example.com') {
  await page.getByTestId('acct-email').fill(email);
  await page.getByTestId('acct-email-next').click();
  await enterCode(page);
  await page.getByTestId('acct-code-next').click();
  await page.getByTestId('acct-pin1').fill(pin);
  await page.getByTestId('acct-pin2').fill(pin);
  await page.getByTestId('acct-pin-save').click();
  const recovery = (await page.getByTestId('acct-recovery-code').textContent())!.trim();
  await page.getByTestId('acct-recovery-saved').check();
  await page.getByTestId('acct-recovery-next').click();
  return recovery;
}

/** Types the e-mail code the pretend server shows in test builds. */
export async function enterCode(page: Page) {
  const hint = (await page.getByTestId('acct-code-hint').textContent()) ?? '';
  await page.getByTestId('acct-code').fill(/\d{6}/.exec(hint)![0]);
}
