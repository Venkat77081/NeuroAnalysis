import { expect, test } from '@playwright/test';

test('landmark overlay can be switched on while framing and recording, and in replay', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?mockSpeed=10');
  await page.getByTestId('choose-patient').click();
  await page.getByTestId('patient-ref-input').fill('A0142');
  await page.getByTestId('patient-yob-input').fill('1958');
  await page.getByTestId('save-patient').click();
  await page.getByTestId('med-ON').click();
  await page.getByTestId('consent').check();
  await page.getByTestId('start-session').click();
  await page.getByTestId('set-up-camera').click();

  const sw = page.getByTestId('landmarks-switch');
  await expect(page.getByTestId('landmark-overlay')).toHaveCount(0);
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('landmark-overlay')).toBeAttached();

  await page.getByTestId('record').click();
  await expect(page.getByTestId('rec-badge')).toBeVisible();
  await expect(page.getByTestId('landmarks-switch')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('landmarks-switch').click();
  await expect(page.getByTestId('landmark-overlay')).toHaveCount(0);
  await page.getByTestId('landmarks-switch').click();

  await expect(page.getByTestId('verdict-card')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('play').click();
  await expect(page.getByTestId('player')).toBeVisible();
  // Remembered from the camera screen: replay overlay on, landmarks of this take loaded.
  const overlay = page.getByTestId('replay-overlay');
  await expect(overlay).toBeAttached();
  await expect
    .poll(async () => Number(await overlay.getAttribute('data-frames')))
    .toBeGreaterThan(20);
  await page.getByTestId('landmarks-switch').click();
  await expect(page.getByTestId('replay-overlay')).toHaveCount(0);
  expect(errors).toEqual([]);
});
