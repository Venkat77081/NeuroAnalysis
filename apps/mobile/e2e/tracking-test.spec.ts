import { expect, test } from '@playwright/test';
import { openDeviceCheck } from './helpers.ts';

test('M4 tracking test (mock): measures analysis events while recording and draws the overlay', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?mockSpeed=10');
  await openDeviceCheck(page);
  await page.getByTestId('open-tracking-test').click();
  await expect(page.getByRole('heading', { name: 'Tracking test (M4)' })).toBeVisible();
  await page.getByTestId('tracking-test-select').selectOption('FT');
  await page.getByTestId('tracking-run').click();
  await expect(page.getByTestId('tracking-live')).toBeVisible();
  await expect(page.getByTestId('landmark-overlay')).toBeAttached();
  await expect(page.getByTestId('tracking-result')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByTestId('tracking-result')).toContainText('hand');
  await expect(page.getByTestId('tracking-result')).toContainText('landmark frames');
  expect(errors).toEqual([]);
});
