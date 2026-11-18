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
export async function signUpPatient(
  page: Page,
  pin = '2580',
  email = 'asha@example.com',
  firstName = 'Asha',
) {
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
  // New UI: the first name for the greeting (kept on the phone); empty skips it.
  if (firstName) {
    await page.getByTestId('acct-first-name').fill(firstName);
    await page.getByTestId('acct-name-next').click();
  } else await page.getByTestId('acct-name-skip').click();
  return recovery;
}

/** Types the e-mail code the pretend server shows in test builds. */
export async function enterCode(page: Page) {
  const hint = (await page.getByTestId('acct-code-hint').textContent()) ?? '';
  await page.getByTestId('acct-code').fill(/\d{6}/.exec(hint)![0]);
}

/** v17: open one section of a hospital from its menu. */
export async function section(
  page: Page,
  name: 'appointments' | 'book' | 'history' | 'recordings' | 'details',
) {
  await page.getByTestId(`menu-${name}`).click();
}

/** v17: the day `n` days from today in the hospital's zone (the fake uses India time). */
export function dayAhead(n: number, tz = 'Asia/Kolkata'): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Date.now() + n * 86_400_000));
}

/** v17: tap that day in the calendar, moving to later months as needed. */
export async function pickDay(page: Page, n: number) {
  const day = page.getByTestId(`change-day-${dayAhead(n)}`);
  for (let i = 0; i < 3 && !(await day.isVisible()); i++)
    await page.getByTestId('picker-next-month').click();
  await day.click();
}
