import { expect, test, type Page } from '@playwright/test';

/**
 * Decision 062: the phone check reads memory (RAM) and storage as well as the camera; a visit
 * starts only with the space it needs; low free memory only warns.
 */
const SHOTS = process.env.NC_SHOTS;

async function readyClinicVisit(page: Page, url: string) {
  await page.goto(url);
  await page.getByTestId('choose-patient').click();
  await page.getByTestId('patient-ref-input').fill('A0142');
  await page.getByTestId('save-patient').click();
  await page.getByTestId('med-ON').click();
  await page.getByTestId('consent').check();
}

test('clinic phone: camera, memory and storage rows; a 2 GB phone is not suitable', async ({
  page,
}) => {
  await page.goto('/?mockSpeed=20&benchFps=59.8&memGb=5.6&freeGb=18.4');
  await page.getByTestId('role-clinic').click();
  const card = page.getByTestId('device-check');
  await expect(card).toHaveAttribute('data-outcome', 'pass');
  for (const row of ['camera', 'memory', 'storage'])
    await expect(page.getByTestId(`check-row-${row}`)).toHaveAttribute('data-tone', 'ok');
  await expect(page.getByTestId('check-row-camera')).toContainText('1920 × 1080');
  await expect(page.getByTestId('check-row-memory')).toContainText('6 GB');
  await expect(page.getByTestId('check-row-storage')).toContainText('18.4 GB free');
  if (SHOTS) await card.screenshot({ path: `${SHOTS}/app-check-ready.png` });

  await page.goto('/?mockSpeed=20&benchFps=60&memGb=1.8&freeGb=1.6');
  await page.getByTestId('role-clinic').click();
  await expect(card).toHaveAttribute('data-outcome', 'fail');
  await expect(card).toContainText('does not have enough memory');
  await expect(page.getByTestId('check-row-memory')).toHaveAttribute('data-tone', 'bad');
  await expect(page.getByTestId('check-row-storage')).toHaveAttribute('data-tone', 'bad');
  await expect(page.getByTestId('device-check-storage-hint')).toContainText('Free up at least');
  await expect(page.getByTestId('clinic-code')).toHaveCount(0);
  if (SHOTS) await card.screenshot({ path: `${SHOTS}/app-check-fail.png` });
});

test('before a visit: too little storage stops it; low memory only warns', async ({ page }) => {
  await readyClinicVisit(page, '/?mode=clinic-local&mockSpeed=20&freeGb=1.6');
  const check = page.getByTestId('visit-check');
  await expect(check).toHaveAttribute('data-blocked', 'true');
  await expect(check).toContainText('Not enough space for this visit');
  await expect(page.getByTestId('start-session')).toBeDisabled();
  if (SHOTS) await check.screenshot({ path: `${SHOTS}/app-visit-blocked.png` });

  await readyClinicVisit(page, '/?mode=clinic-local&mockSpeed=20&freeGb=18&memLow=1');
  await expect(check).toHaveAttribute('data-blocked', 'false');
  await expect(page.getByTestId('check-row-visit-memory')).toHaveAttribute('data-tone', 'warn');
  await expect(check).toContainText('Close other apps');
  await expect(page.getByTestId('start-session')).toBeEnabled();
  if (SHOTS) await check.screenshot({ path: `${SHOTS}/app-visit-memory.png` });
});
