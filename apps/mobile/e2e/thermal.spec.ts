import { expect, test, type Page } from '@playwright/test';

/** M9 thermal policy in mock mode: warm → slower tracking + no overlay; hot → wait to cool. */
type Mock = { setThermal(s: string): void; currentAnalysisFps(): number | null };
const heat = (page: Page, s: string) =>
  page.evaluate((st) => (globalThis as unknown as { __ncMock: Mock }).__ncMock.setThermal(st), s);
const analysisFps = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { __ncMock: Mock }).__ncMock.currentAnalysisFps());

test('M9: a hot phone slows tracking, then blocks new takes until it cools', async ({ page }) => {
  await page.goto('/?mockSpeed=20');
  await page.getByTestId('choose-patient').click();
  await page.getByTestId('patient-ref-input').fill('E7001');
  await page.getByTestId('save-patient').click();
  await page.getByTestId('med-ON').click();
  await page.getByTestId('consent').check();
  await page.getByTestId('start-session').click();
  await page.getByTestId('set-up-camera').click();
  await expect(page.getByTestId('record')).toBeEnabled();
  const normal = await analysisFps(page);

  await heat(page, 'severe');
  await expect(page.getByTestId('thermal-warning')).toContainText('tracking is slowed');
  await expect.poll(() => analysisFps(page)).toBe(5);
  expect(normal).toBeGreaterThan(5);
  await expect(page.getByTestId('record')).toBeEnabled();

  await heat(page, 'critical');
  await expect(page.getByTestId('thermal-warning')).toContainText('too hot');
  await expect(page.getByTestId('record')).toBeDisabled();

  await heat(page, 'none');
  await expect(page.getByTestId('thermal-warning')).toHaveCount(0);
  await expect.poll(() => analysisFps(page)).toBe(normal);
  await expect(page.getByTestId('record')).toBeEnabled();
});
