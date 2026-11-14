import { expect, test, type Page } from '@playwright/test';

/** M7 §15 in mock mode: low storage blocks takes; leaving the app mid-take interrupts it. */
async function toFraming(page: Page, url: string) {
  await page.goto(url);
  await page.getByTestId('choose-patient').click();
  await page.getByTestId('patient-ref-input').fill('D5512');
  await page.getByTestId('save-patient').click();
  await page.getByTestId('med-ON').click();
  await page.getByTestId('consent').check();
  await page.getByTestId('start-session').click();
  await page.getByTestId('set-up-camera').click();
}

test('§15: below 2 GB free, Record is blocked with a plain message', async ({ page }) => {
  await toFraming(page, '/?mockSpeed=20&freeGb=1.2');
  await expect(page.getByTestId('storage-low')).toContainText('1.2 GB free, 2 GB needed');
  await expect(page.getByTestId('record')).toBeDisabled();
});

test('§15: an app switch or call mid-recording stops the take; record it again', async ({
  page,
}) => {
  await toFraming(page, '/?mockSpeed=2');
  await page.getByTestId('record').click();
  await expect(page.getByTestId('rec-badge')).toBeVisible({ timeout: 10_000 });
  await page.evaluate(() =>
    (
      globalThis as unknown as { __ncMock: { simulateBackground(): void } }
    ).__ncMock.simulateBackground(),
  );
  await expect(page.getByTestId('interrupted-notice')).toContainText('another app or a call');
  await expect(page.getByTestId('record')).toBeEnabled();
});
