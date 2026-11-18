import { signUpPatient } from './helpers.ts';
import { expect, test, type Page } from '@playwright/test';

/**
 * v3 acceptance (mock mode): a patient joins a hospital with an e-mail invite and a PIN (no
 * consent at joining). Nothing to record until the doctor sends a record link; then consent on its
 * own screen right before the camera, a full home session for that request, uploaded with the
 * hospital's key. History, the PIN lock, joining a second hospital, and withdrawing from one
 * (its history stays readable; the other hospital is not affected).
 */
const URL = '/?mockSpeed=20';

interface Fake {
  issueInvite(token?: string, opts?: { hospital?: string; siteId?: string }): string;
  sendRequest(ncid: string, opts?: { tests?: string[]; place?: 'home' | 'clinic' }): string;
  joinedNcids(): string[];
  homeSessions(): { requestId: string | null }[];
  takeKeyIds: string[];
}
type W = { __ncMock: { fakeServer: Fake } };
const fake = (page: Page) =>
  page.evaluate(() => ({ link: (globalThis as unknown as W).__ncMock.fakeServer.issueInvite() }));

async function recordAndAccept(page: Page) {
  await page.getByTestId('set-up-camera').click();
  await page.getByTestId('record').click();
  await expect(page.getByTestId('verdict-card')).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId('verdict-title')).toHaveText('Capture passed');
  await page.getByTestId('accept').click();
}

test('v3: join → record link → consent → home session; second hospital; withdraw one', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL);
  await page.getByTestId('role-patient').click();
  // v11: the app account first (e-mail, app PIN, recovery code).
  await signUpPatient(page);

  // The e-mail's link, pasted (a link opened from the e-mail goes straight to the PIN screen).
  await page.getByTestId('invite-text').fill('not-a-valid-code');
  await page.getByTestId('invite-continue').click();
  await expect(page.getByRole('alert')).toContainText('not accepted');
  const { link } = await fake(page);
  await page.getByTestId('invite-text').fill(link);
  await page.getByTestId('invite-continue').click();
  await expect(page.getByTestId('invite-hospital')).toContainText('Demo Hospital');
  // v11: no PIN for the hospital: the app PIN covers it.
  await expect(page.getByTestId('invite-no-pin')).toContainText('Demo Hospital');
  await expect(page.getByTestId('pin1')).toHaveCount(0);
  await page.getByTestId('invite-accept').click();

  // My hospitals: joined, nothing to record yet.
  await expect(page.getByTestId('hospital-card')).toHaveCount(1);
  await expect(page.getByTestId('hospital-badge')).toHaveText('Joined');
  await page.getByTestId('hospital-card').click();
  await expect(page.getByTestId('needs-now')).toHaveCount(0);
  await page.getByTestId('menu-recordings').click();
  await expect(page.getByTestId('no-requests')).toBeVisible();
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: 'Back' }).click();

  // The doctor chooses the tests and sends the record link.
  const rq = await page.evaluate(() => {
    const f = (globalThis as unknown as W).__ncMock.fakeServer;
    // Also in the clinic (both places): shown as information, not counted as a request.
    f.sendRequest(f.joinedNcids()[0]!, { place: 'clinic' });
    return f.sendRequest(f.joinedNcids()[0]!);
  });
  // (The fake server lives in the page: no reload here.) Opening the hospital fetches it live.
  await page.getByTestId('hospital-card').click();
  await expect(page.getByTestId('needs-record')).toContainText('Record 5 tests');
  await expect(page.getByTestId('menu-recordings-count')).toHaveText('1');
  await page.getByTestId('menu-recordings').click();
  await expect(page.getByTestId('request-card')).toContainText('Dr. Rao asks for 5 tests');
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByTestId('menu-appointments').click();
  await expect(page.getByTestId('request-clinic')).toContainText('at the clinic');
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByTestId('hospital-badge')).toHaveText('1 request');
  await page.getByTestId('hospital-card').click();
  await page.screenshot({ path: 'test-results/patient-hospital.png', fullPage: true });
  await page.getByTestId('needs-record').getByRole('button').click();

  // Consent right before the camera: no tick, no recording.
  await expect(page.getByTestId('consent-for')).toContainText('Demo Hospital');
  await expect(page.getByTestId('consent-start')).toBeDisabled();
  await page.getByTestId('consent-cancel').click();
  await page.getByTestId('menu-recordings').click();
  await expect(page.getByTestId('request-card')).toBeVisible();
  await page.getByTestId('request-start').click();
  await page.getByTestId('consent-check').check();
  await page.screenshot({ path: 'test-results/patient-consent.png', fullPage: true });
  await page.getByTestId('consent-start').click();

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
    const f = (globalThis as unknown as W).__ncMock.fakeServer;
    return { sessions: f.homeSessions(), keys: f.takeKeyIds };
  });
  expect(srv.sessions).toMatchObject([{ requestId: rq }]); // the session answers the request
  expect(srv.keys).toEqual(Array(5).fill('hk-fake-1')); // only the hospital's key, never the platform's

  // Back home: the request is now history.
  await page.getByTestId('end-session').click();
  await expect(page.getByTestId('hospital-badge')).toHaveText('Joined');
  await page.getByTestId('hospital-card').click();
  await page.getByTestId('menu-recordings').click();
  await expect(page.getByTestId('history-request')).toContainText('Recorded · uploaded');
  await expect(page.getByTestId('rec-session')).toContainText('5 tests uploaded');
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: 'Back' }).click();

  // Lock and unlock with the PIN.
  await page.getByTestId('lock-now').click();
  await page.getByTestId('unlock-secret').fill('1111');
  await page.getByTestId('unlock').click();
  await expect(page.getByRole('alert')).toContainText('not right');
  await page.getByTestId('unlock-secret').fill('2580');
  await page.getByTestId('unlock').click();

  // A second hospital: no PIN at all.
  const second = await page.evaluate(() =>
    (globalThis as unknown as W).__ncMock.fakeServer.issueInvite(undefined, {
      hospital: 'Lakeview Hospital',
      siteId: 'site2',
    }),
  );
  await page.getByTestId('join-hospital').click();
  await page.getByTestId('invite-text').fill(second);
  await page.getByTestId('invite-continue').click();
  await expect(page.getByTestId('invite-hospital')).toContainText('Lakeview Hospital');
  await page.getByTestId('invite-accept').click();
  await expect(page.getByTestId('hospital-card')).toHaveCount(2);
  await page.screenshot({ path: 'test-results/patient-hospitals.png', fullPage: true });

  // Withdraw from the first: history stays, read only; the other hospital is not affected.
  await page.getByTestId('hospital-card').filter({ hasText: 'Demo Hospital' }).click();
  await page.getByTestId('menu-details').click();
  await page.getByTestId('withdraw').click();
  await page.getByTestId('withdraw-yes').click();
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByTestId('hospital-withdrawn')).toBeVisible();
  await expect(page.getByTestId('menu-appointments')).toHaveCount(0);
  await page.getByTestId('menu-recordings').click();
  await expect(page.getByTestId('history-request')).toContainText('Recorded · uploaded');
  await expect(page.getByTestId('request-start')).toBeHidden();
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(
    page.getByTestId('hospital-card').filter({ hasText: 'Demo Hospital' }),
  ).toContainText('Withdrawn');
  await expect(
    page.getByTestId('hospital-card').filter({ hasText: 'Lakeview Hospital' }),
  ).toContainText('Joined');
  expect(errors).toEqual([]);
});

test('an invite link waits for the account, then joins; the app opens locked', async ({ page }) => {
  await page.goto(URL);
  // The app listens for links once it has loaded (a link sent earlier is missed on a slow machine).
  await expect(page.getByTestId('role-patient')).toBeVisible();
  const { link } = await fake(page);
  await page.evaluate(
    (l) => globalThis.dispatchEvent(new CustomEvent('nc:invite', { detail: l })),
    link,
  );
  await signUpPatient(page, '135790');
  await expect(page.getByTestId('invite-hospital')).toContainText('Demo Hospital');
  await page.getByTestId('invite-accept').click(); // v3: no consent box at joining
  await expect(page.getByTestId('hospital-card')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('unlock-secret')).toBeVisible();
  await expect(page.getByTestId('role-patient')).toBeHidden();
});
