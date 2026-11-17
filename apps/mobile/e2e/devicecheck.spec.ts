import { signUpPatient } from './helpers.ts';
import { expect, test, type Page } from '@playwright/test';

/**
 * Decision 035 (user, 16 Nov 2026): a camera check before a phone is added. 55 fps or more
 * passes (55–59 "borderline"); a failed check does not use the registration code or the invite.
 * A patient whose phone fails can tell the hospital, then join from another phone.
 */
interface Mock {
  benchmarkFps: number | undefined;
  fakeServer: { issueInvite(): string; phoneNotSuitable: Map<string, number> };
}
type W = { __ncMock: Mock };
const setFps = (page: Page, fps: number) =>
  page.evaluate((f) => {
    (globalThis as unknown as W).__ncMock.benchmarkFps = f;
  }, fps);

test('clinic phone: a failed check hides the code; after a pass the same code works', async ({
  page,
}) => {
  await page.goto('/?mockSpeed=20&benchFps=48');
  await page.getByTestId('role-clinic').click();
  const card = page.getByTestId('device-check');
  await expect(card).toHaveAttribute('data-outcome', 'fail');
  await expect(page.getByTestId('device-check-fps')).toContainText('48.0');
  await expect(card).toContainText('was not used');
  await expect(page.getByTestId('clinic-code')).toHaveCount(0);

  await setFps(page, 59.9);
  await page.getByTestId('device-check-again').click();
  await expect(card).toHaveAttribute('data-outcome', 'pass');
  await page.getByTestId('clinic-code').fill('DEMO-SITE-1');
  await page.getByTestId('clinic-register').click();
  await expect(page.getByTestId('op-id')).toBeVisible();
});

test('clinic phone: 55–59 fps is borderline and can still be added', async ({ page }) => {
  await page.goto('/?mockSpeed=20&benchFps=57.2');
  await page.getByTestId('role-clinic').click();
  await expect(page.getByTestId('device-check')).toHaveAttribute('data-outcome', 'borderline');
  await expect(page.getByTestId('device-check')).toContainText('may need to be repeated');
  await expect(page.getByTestId('clinic-code')).toBeVisible();
});

test('patient: phone too slow → tell my hospital; the invite still works', async ({ page }) => {
  await page.goto('/?mockSpeed=20&benchFps=41');
  await page.getByTestId('role-patient').click();
  await signUpPatient(page);
  const link = await page.evaluate(() =>
    (globalThis as unknown as W).__ncMock.fakeServer.issueInvite(),
  );
  await page.getByTestId('invite-text').fill(link);
  await page.getByTestId('invite-continue').click();
  await expect(page.getByTestId('device-check')).toHaveAttribute('data-outcome', 'fail');
  await expect(page.getByTestId('pin1')).toHaveCount(0);
  await expect(page.getByTestId('check-choices')).toContainText('next visit');

  await page.getByTestId('check-tell').click();
  await expect(page.getByTestId('check-told')).toContainText('Demo Hospital');
  const told = await page.evaluate(() => [
    ...(globalThis as unknown as W).__ncMock.fakeServer.phoneNotSuitable.values(),
  ]);
  expect(told).toEqual([41]);

  // A phone that passes (here: the same mock, now at 60 fps) joins with the same invite.
  await setFps(page, 60);
  await page.getByTestId('device-check-again').click();
  await page.getByTestId('invite-accept').click();
  await expect(page.getByTestId('hospital-card')).toHaveCount(1);
});
