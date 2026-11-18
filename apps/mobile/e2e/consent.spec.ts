import { expect, test, type Page } from '@playwright/test';
import { signUpPatient } from './helpers.ts';

/**
 * v16 (decision 047): consent for a clinic recording. The patient agrees in the app and shows a
 * one-time QR code; the clinic phone checks it (scanned, or the code typed) before recording.
 * Without the app: consent on the clinic phone with a reason.
 */
type Fake = {
  issueInvite(): string;
  joinedNcids(): string[];
  sendRequest(ncid: string, o?: { place?: 'home' | 'clinic'; appointmentDays?: number }): string;
  clinicCode(requestId: string): string | null;
  giveClinicConsent(requestId: string): string;
  addClinicRequest(mrn: string, name: string): string;
};
type W = { __ncMock: { fakeServer: Fake } };
const fake = <T>(page: Page, src: string, arg = '') =>
  page.evaluate(
    ([s, a]) =>
      new Function('f', 'a', `return (${s})(f, a)`)(
        (globalThis as unknown as W).__ncMock.fakeServer,
        a,
      ) as T,
    [src, arg] as const,
  );

test('patient agrees in the app, sees the QR and can withdraw', async ({ page }) => {
  await page.goto('/?mockSpeed=20');
  await page.getByTestId('role-patient').click();
  await signUpPatient(page);
  const link = await fake<string>(page, '(f) => f.issueInvite()');
  await page.getByTestId('invite-text').fill(link);
  await page.getByTestId('invite-continue').click();
  await page.getByTestId('invite-accept').click();
  const req = await fake<string>(
    page,
    "(f) => f.sendRequest(f.joinedNcids()[0], { place: 'clinic', appointmentDays: 0.02 })",
  );
  await page.getByTestId('hospital-card').click();
  const card = page.getByTestId('request-clinic');
  await card.getByTestId('clinic-consent-open').click();
  await expect(page.getByTestId('clinic-consent-give')).toBeDisabled();
  await page.getByTestId('clinic-consent-agree').check();
  await page.getByTestId('clinic-consent-give').click();
  const qr = page.getByTestId('clinic-consent-qr');
  await expect(qr.locator('img')).toBeVisible();
  const code = (await fake<string>(page, '(f, a) => f.clinicCode(a)', req))!;
  await expect(page.getByTestId('clinic-consent-code')).toHaveText(
    code.replace(/(.{4})(?=.)/g, '$1-'),
  );
  await page.screenshot({ path: 'test-results/v16-patient-qr.png', fullPage: true });

  // Withdraw: the code no longer works; the patient can agree again.
  await page.getByTestId('clinic-consent-withdraw').click();
  expect(await fake<string | null>(page, '(f, a) => f.clinicCode(a)', req)).toBeNull();
  await expect(page.getByTestId('clinic-consent-open')).toBeVisible();
});

test("the clinic phone checks the patient's code before recording; once only", async ({ page }) => {
  await page.goto('/?mockSpeed=20');
  await page.getByTestId('role-clinic').click();
  await page.getByTestId('clinic-code').fill('DEMO-SITE-1');
  await page.getByTestId('clinic-register').click();
  await page.getByTestId('op-id').fill('OP-07');
  await page.getByTestId('op-password').fill('2468');
  await page.getByTestId('op-sign-in').click();
  const req = await fake<string>(page, "(f) => f.addClinicRequest('00012402', 'Meena Samplename')");
  const code = await fake<string>(page, '(f, a) => f.giveClinicConsent(a)', req);
  await page.getByRole('button', { name: 'Refresh' }).click();
  const item = page.getByTestId('queue-item').first();
  await expect(item.getByTestId('queue-consent')).toHaveText('Consent in app');
  await expect(item.getByTestId('queue-start')).toHaveText('Scan consent QR');
  await item.getByTestId('queue-start').click();
  const scan = page.getByTestId('consent-scan');
  await scan.getByTestId('consent-code').fill('ZZZZ-ZZZZ-ZZZZ');
  await scan.getByTestId('consent-code-check').click();
  await expect(scan.getByTestId('consent-error')).toContainText('not recognised');
  await scan.getByTestId('consent-code').fill(code.toLowerCase().replace(/(.{4})(?=.)/g, '$1-'));
  await scan.getByTestId('consent-code-check').click();
  await expect(page.getByTestId('consent-confirmed')).toContainText('agreed in their app');
  await expect(page.getByTestId('consent')).toHaveCount(0); // nothing to tick
  // Used: the patient's app no longer shows it, and it cannot start another recording.
  expect(await fake<string | null>(page, '(f, a) => f.clinicCode(a)', req)).toBeNull();
});

test('no app: consent on the clinic phone with a reason', async ({ page }) => {
  await page.goto('/?mockSpeed=20');
  await page.getByTestId('role-clinic').click();
  await page.getByTestId('clinic-code').fill('DEMO-SITE-1');
  await page.getByTestId('clinic-register').click();
  await page.getByTestId('op-id').fill('OP-07');
  await page.getByTestId('op-password').fill('2468');
  await page.getByTestId('op-sign-in').click();
  await fake(page, "(f) => f.addClinicRequest('00012401', 'Ravi Samplename')");
  await page.getByRole('button', { name: 'Refresh' }).click();
  const item = page.getByTestId('queue-item').first();
  await expect(item.getByTestId('queue-consent')).toHaveText('No app');
  await item.getByTestId('queue-start').click();
  await expect(page.getByTestId('consent-phone-show')).toBeDisabled();
  await page.getByTestId('consent-reason-no_smartphone').click();
  await page.getByTestId('consent-phone-show').click();
  await expect(page.getByTestId('consent-phone-text')).toContainText('You can say no');
  await page.getByTestId('consent-phone-agree').check();
  await page.screenshot({ path: 'test-results/v16-phone-consent.png', fullPage: true });
  await page.getByTestId('consent-phone-confirm').click();
  await expect(page.getByTestId('consent-confirmed')).toContainText('on this phone');
});
