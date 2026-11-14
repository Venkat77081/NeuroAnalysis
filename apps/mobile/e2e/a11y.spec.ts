import { expect, test, type Page } from '@playwright/test';

/**
 * M9 accessibility: every control an operator taps is at least 48 × 48 CSS px (DEV_PLAN §4),
 * has an accessible name, and every test intro offers spoken instructions.
 */
async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(
      'button, [role="button"], input[type="checkbox"], input[type="radio"], select, a[href]',
    )) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue; // not shown
      // A checkbox/radio counts with its label (the whole row is the target).
      const target = (el.closest('label') as HTMLElement | null) ?? el;
      const t = target.getBoundingClientRect();
      if (t.height < 48 || t.width < 48)
        out.push(
          `${el.dataset.testid || el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 30) || el.tagName} ${Math.round(t.width)}×${Math.round(t.height)}`,
        );
      const name =
        el.getAttribute('aria-label') || el.textContent?.trim() || target.textContent?.trim();
      if (!name) out.push(`${el.dataset.testid ?? el.tagName} has no accessible name`);
    }
    return out;
  });
}

test('M9: touch targets and names on the main screens', async ({ page }) => {
  await page.goto('/?mockSpeed=20');
  const problems: Record<string, string[]> = {};
  problems.home = await smallTargets(page);
  await page.getByTestId('choose-patient').click();
  await page.getByTestId('patient-ref-input').fill('F1001');
  await page.getByTestId('save-patient').click();
  await page.getByTestId('med-ON').click();
  await page.getByTestId('consent').check();
  await page.getByTestId('start-session').click();
  problems.intro = await smallTargets(page);
  await expect(page.getByRole('button', { name: /listen/i })).toBeVisible();
  await page.getByTestId('set-up-camera').click();
  await expect(page.getByTestId('record')).toBeEnabled();
  problems.camera = await smallTargets(page);
  await page.getByTestId('record').click();
  await expect(page.getByTestId('verdict-card')).toBeVisible({ timeout: 15_000 });
  problems.review = await smallTargets(page);
  await page.getByTestId('accept').click();
  await page.getByTestId('end-early').click();
  problems.abort = await smallTargets(page);
  await page.getByLabel('Out of time').check();
  await page.getByTestId('confirm-abort').click();
  problems.summary = await smallTargets(page);
  expect(problems).toEqual({ home: [], intro: [], camera: [], review: [], abort: [], summary: [] });
});
