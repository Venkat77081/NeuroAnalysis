import { expect, test } from '@playwright/test';
import { openDeviceCheck } from './helpers.ts';

test('M2 capture test records a mock take and checks it against the acceptance criteria', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await openDeviceCheck(page);
  await page.getByTestId('open-capture-test').click();
  await expect(page.getByRole('heading', { name: 'Capture test (M2)' })).toBeVisible();
  await page.getByTestId('test-select').selectOption('FA'); // 15 s, 30 fps
  await page.getByTestId('run-capture-test').click();
  await expect(page.getByTestId('live-view')).toBeVisible();
  await expect(page.getByTestId('live-take')).toHaveText('Take 1 of 1');
  await expect(page.locator('html')).toHaveClass(/camera-active/);
  await expect(page.getByTestId('capture-status')).toHaveText('1 of 1 takes passed', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('capture-results')).toContainText(
    '1 of 1 takes pass the M2 checks',
  );
  await expect(page.getByTestId('capture-results')).toContainText('@ 30');
  await page.getByRole('button', { name: 'Play' }).click();
  await expect(page.getByTestId('player')).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Delete these test takes' }).click();
  await expect(page.getByTestId('capture-results')).toHaveCount(0);
  expect(errors).toEqual([]);
});
