import { expect, test } from '@playwright/test';

/** M9 training mode: practice takes need no patient, are never uploaded, and are deleted. */
type Mock = { listTakes(): Promise<{ takes: { takeId: string }[] }> };
const takeCount = (page: import('@playwright/test').Page) =>
  page.evaluate(async () => {
    const m = (globalThis as unknown as { __ncMock: Mock }).__ncMock;
    return (await m.listTakes()).takes.length;
  });

test('M9: a practice session records without a patient and leaves nothing behind', async ({
  page,
}) => {
  await page.goto('/?mockSpeed=20');
  await expect(page.getByTestId('start-session')).toBeDisabled();
  await page.getByTestId('practice-toggle').check();
  await expect(page.getByTestId('choose-patient')).toHaveCount(0);
  await expect(page.getByTestId('start-session')).toHaveText('Start practice');
  await page.getByTestId('start-session').click();
  await page.getByTestId('set-up-camera').click();
  await expect(page.getByTestId('practice-badge')).toBeVisible();
  await page.getByTestId('record').click();
  await expect(page.getByTestId('verdict-card')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('accept').click();
  await page.getByTestId('end-early').click();
  await page.getByLabel('Out of time').check();
  await page.getByTestId('confirm-abort').click();
  await expect(page.getByTestId('practice-summary')).toBeVisible();
  await expect(page.getByTestId('upload-panel')).toHaveCount(0);
  expect(await takeCount(page)).toBe(1);
  await page.getByTestId('end-session').click();
  await expect(page.getByRole('heading', { name: 'New session' })).toBeVisible();
  await expect.poll(() => takeCount(page)).toBe(0);
  await expect(page.getByTestId('practice-toggle')).not.toBeChecked();
});
