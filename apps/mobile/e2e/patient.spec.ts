import { expect, test, type Page } from '@playwright/test';

/**
 * M13 acceptance (mock mode): a patient accepts an e-mail invite, chooses a PIN, consents, and
 * uploads a full home session with the doctor's plan. The take keys are wrapped with the hospital
 * key of the session. Then: the PIN lock, recordings, and withdrawing consent.
 */
const URL = '/?mockSpeed=20';

interface Fake {
  issueInvite(): string;
  homeSessions(): unknown[];
  takeKeyIds: string[];
}
const fake = (page: Page) =>
  page.evaluate(() => {
    const f = (globalThis as unknown as { __ncMock: { fakeServer: Fake } }).__ncMock.fakeServer;
    return { link: f.issueInvite() };
  });

async function recordAndAccept(page: Page) {
  await page.getByTestId('set-up-camera').click();
  await page.getByTestId('record').click();
  await expect(page.getByTestId('verdict-card')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('verdict-title')).toHaveText('Capture passed');
  await page.getByTestId('accept').click();
}

test('M13: e-mail invite → PIN → consent → full home session uploaded', async ({ page }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL);
  await page.getByTestId('role-patient').click();

  // The e-mail's link, pasted (a link opened from the e-mail goes straight to the PIN screen).
  await page.getByTestId('invite-text').fill('not-a-valid-code');
  await page.getByTestId('invite-continue').click();
  await expect(page.getByRole('alert')).toContainText('not accepted');
  const { link } = await fake(page);
  await page.getByTestId('invite-text').fill(link);
  await page.getByTestId('invite-continue').click();
  await expect(page.getByTestId('invite-hospital')).toContainText('Demo Hospital');
  await page.getByTestId('pin1').fill('2580');
  await page.getByTestId('pin2').fill('9999');
  await expect(page.getByTestId('invite-accept')).toBeDisabled(); // consent not given yet
  await page.getByTestId('invite-consent').check();
  await page.getByTestId('invite-accept').click();
  await expect(page.getByRole('alert')).toContainText('do not match');
  await page.getByTestId('pin2').fill('2580');
  await page.getByTestId('invite-accept').click();

  // Home: the doctor's plan.
  await expect(page.getByTestId('home-plan')).toBeVisible();
  await expect(page.getByTestId('home-due')).toBeVisible();
  await expect(page.getByTestId('home-med')).toContainText('medicine OFF');
  await page.screenshot({ path: 'test-results/patient-home.png', fullPage: true });
  await expect(page.getByTestId('home-start')).toBeDisabled(); // consent for this session first
  await page.getByTestId('home-consent').check();
  await page.getByTestId('home-start').click();

  for (let i = 0; i < 5; i++) {
    await expect(page.getByTestId('test-of')).toHaveText(`Test ${i + 1} of 5`);
    if (i === 3) {
      // Walking test at home: a helper must hold the phone.
      await expect(page.getByTestId('saw-helper')).toBeVisible();
      await expect(page.getByTestId('set-up-camera')).toBeHidden();
      await page.getByTestId('saw-helper-yes').click();
    }
    await recordAndAccept(page);
  }
  await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible();
  await expect(page.getByTestId('summary-counts')).toContainText('5Passed');
  await expect(page.getByTestId('upload-summary')).toContainText('All takes uploaded', {
    timeout: 30_000,
  });
  const srv = await page.evaluate(() => {
    const f = (globalThis as unknown as { __ncMock: { fakeServer: Fake } }).__ncMock.fakeServer;
    return { sessions: f.homeSessions().length, keys: f.takeKeyIds };
  });
  expect(srv.sessions).toBe(1); // recorded as the patient's own (home) session
  expect(srv.keys).toEqual(Array(5).fill('hk-fake-1')); // only the hospital's key, never the platform's

  // Back home; recordings list; lock and unlock with the PIN.
  await page.getByTestId('end-session').click();
  await expect(page.getByTestId('home-plan')).toBeVisible();
  await page.getByTestId('home-recordings').click();
  await expect(page.getByTestId('rec-session')).toHaveCount(1);
  await expect(page.getByTestId('rec-session')).toContainText('5 tests uploaded');
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByTestId('lock-now').click();
  await page.getByTestId('unlock-secret').fill('1111');
  await page.getByTestId('unlock').click();
  await expect(page.getByRole('alert')).toContainText('not right');
  await page.getByTestId('unlock-secret').fill('2580');
  await page.getByTestId('unlock').click();
  await expect(page.getByTestId('home-plan')).toBeVisible();

  // Withdraw consent: the phone is signed out and wiped, back to the first screen.
  await page.getByTestId('home-settings').click();
  await page.getByTestId('withdraw-delete').check();
  await page.getByTestId('withdraw').click();
  await page.getByTestId('withdraw-yes').click();
  await expect(page.getByTestId('withdrawn')).toBeVisible();
  await page.getByRole('button', { name: 'OK' }).click();
  await expect(page.getByTestId('role-patient')).toBeVisible();
  expect(errors).toEqual([]);
});

test('M13: an invite link opens straight to the PIN screen; the app opens locked', async ({
  page,
}) => {
  await page.goto(URL);
  const { link } = await fake(page);
  await page.evaluate(
    (l) => globalThis.dispatchEvent(new CustomEvent('nc:invite', { detail: l })),
    link,
  );
  await expect(page.getByTestId('invite-hospital')).toContainText('Demo Hospital');
  await page.getByTestId('pin1').fill('135790');
  await page.getByTestId('pin2').fill('135790');
  await page.getByTestId('invite-consent').check();
  await page.getByTestId('invite-accept').click();
  await expect(page.getByTestId('home-plan')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('unlock-secret')).toBeVisible();
  await expect(page.getByTestId('role-patient')).toBeHidden();
});
