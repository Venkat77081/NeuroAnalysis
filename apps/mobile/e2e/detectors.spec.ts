import { expect, test, type Page } from '@playwright/test';

async function firstTake(page: Page, query: string) {
  await page.goto(`/?mockSpeed=20${query}`);
  await page.getByTestId('choose-patient').click();
  await page.getByTestId('patient-ref-input').fill('A0142');
  await page.getByTestId('patient-yob-input').fill('1958');
  await page.getByTestId('save-patient').click();
  await page.getByTestId('med-ON').click();
  await page.getByTestId('consent').check();
  await page.getByTestId('start-session').click();
  await page.getByTestId('set-up-camera').click();
  await page.getByTestId('record').click();
  await expect(page.getByTestId('verdict-card')).toBeVisible({ timeout: 20_000 });
}

test('M6: a normal take passes and the timeline shows the movement and taps', async ({ page }) => {
  await firstTake(page, '');
  await expect(page.getByTestId('verdict-title')).toHaveText('Capture passed');
  await expect(page.getByTestId('movement-window')).toBeAttached();
  await expect(page.getByTestId('timeline-counts')).toContainText(/R \d+ · L \d+/);
});

test('M6: movement stopping halfway gives a plain RETAKE reason', async ({ page }) => {
  await firstTake(page, '&take=interrupted');
  await expect(page.getByTestId('verdict-title')).toHaveText('Retake needed');
  await expect(page.getByTestId('verdict-reasons')).toContainText('Movement stopped for');
});

test('M6: a task not carried out (only one hand taps) is a RETAKE', async ({ page }) => {
  await firstTake(page, '&take=wrong');
  await expect(page.getByTestId('verdict-reasons')).toContainText(
    'The task was not carried out as instructed.',
  );
});
