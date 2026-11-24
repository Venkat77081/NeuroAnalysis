import { signUpPatient } from './helpers.ts';
import { expect, test, type Page } from '@playwright/test';

/**
 * v36 (decision 063): patients may start a recording with a sign. The phone check tries the sign
 * (optional); on the camera screen, an open palm held for a second starts the countdown, which
 * says "Lower your hand". Clinic phones never show it.
 */
const SHOTS = process.env.NC_SHOTS;
interface Fake {
  issueInvite(): string;
  sendRequest(ncid: string, opts?: { tests?: string[] }): string;
  joinedNcids(): string[];
}
type W = { __ncMock: { fakeServer: Fake; startSign: 'palm' | 'arm' | null } };
const showSign = (page: Page, s: 'palm' | 'arm' | null) =>
  page.evaluate((v) => {
    (globalThis as unknown as W).__ncMock.startSign = v;
  }, s);

test('patient: try the sign at the phone check, then start a recording with it', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/?mockSpeed=20');
  await page.getByTestId('role-patient').click();
  await signUpPatient(page);
  const link = await page.evaluate(() =>
    (globalThis as unknown as W).__ncMock.fakeServer.issueInvite(),
  );
  await page.getByTestId('invite-text').fill(link);
  await page.getByTestId('invite-continue').click();
  await expect(page.getByTestId('device-check')).toHaveAttribute('data-outcome', 'pass');

  // The try-out: the patient shows an open palm to the front camera.
  await expect(page.getByTestId('sign-offer')).toBeVisible();
  await page.getByTestId('sign-try').click();
  await expect(page.getByTestId('sign-tryout')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/sign-tryout.png` });
  await showSign(page, 'palm');
  await expect(page.getByTestId('sign-result')).toHaveAttribute('data-status', 'works');
  await expect(page.getByTestId('check-row-sign')).toContainText('Works');
  await showSign(page, null);
  if (SHOTS)
    await page.getByTestId('device-check').screenshot({ path: `${SHOTS}/sign-check-row.png` });
  await page.getByTestId('invite-accept').click();
  await expect(page.getByTestId('hospital-card')).toHaveCount(1);

  // A record link; consent; the camera screen offers the sign once the outline is green.
  await page.evaluate(() => {
    const f = (globalThis as unknown as W).__ncMock.fakeServer;
    f.sendRequest(f.joinedNcids()[0]!, { tests: ['FT'] });
  });
  await page.getByTestId('hospital-card').click(); // fetches the request
  await expect(page.getByTestId('menu-recordings-count')).toHaveText('1');
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByTestId('todo-record').first().click();
  await page.getByTestId('consent-check').check();
  await expect(page.getByTestId('consent-start')).toBeEnabled();
  await page.getByTestId('consent-start').click();
  await page.getByTestId('set-up-camera').click();
  const prompt = page.getByTestId('sign-prompt');
  await expect(prompt).toHaveAttribute('data-ready', 'true', { timeout: 20_000 });
  await expect(prompt).toContainText('Raise an open palm above your head to start');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/sign-framing.png` });
  // The tapping position itself (both hands up, open) is not the sign: nothing starts.
  await page.waitForTimeout(2500);
  await expect(page.getByTestId('countdown')).toHaveCount(0);
  await showSign(page, 'palm');
  await expect(page.getByTestId('countdown-lower')).toHaveText('Lower your hand');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/sign-countdown.png` });
  await showSign(page, null);
  await expect(page.getByTestId('verdict-card')).toBeVisible({ timeout: 45_000 });
});

test('patient: skipping the try-out keeps the Record button only', async ({ page }) => {
  await page.goto('/?mockSpeed=20');
  await page.getByTestId('role-patient').click();
  await signUpPatient(page);
  const link = await page.evaluate(() =>
    (globalThis as unknown as W).__ncMock.fakeServer.issueInvite(),
  );
  await page.getByTestId('invite-text').fill(link);
  await page.getByTestId('invite-continue').click();
  await page.getByTestId('sign-skip').click();
  await expect(page.getByTestId('sign-result')).toHaveAttribute('data-status', 'skipped');
  await expect(page.getByTestId('check-row-sign')).toContainText('Not tried');
});

test('clinic phones never show the sign', async ({ page }) => {
  await page.goto('/?mode=clinic-local&mockSpeed=20');
  await page.getByTestId('choose-patient').click();
  await page.getByTestId('patient-ref-input').fill('A0142');
  await page.getByTestId('save-patient').click();
  await page.getByTestId('med-ON').click();
  await page.getByTestId('consent').check();
  await page.getByTestId('start-session').click();
  await page.getByTestId('set-up-camera').click();
  await expect(page.getByTestId('record')).toHaveAttribute('data-gate', 'open', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('sign-prompt')).toHaveCount(0);
});
