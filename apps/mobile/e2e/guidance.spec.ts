import { expect, test, type Page } from '@playwright/test';

/** Mock camera plays a synthetic positioning scenario (?scenario=…) for the current test. */
async function framing(page: Page, scenario: string) {
  await page.goto(`/?mockSpeed=4&scenario=${scenario}`);
  await page.getByTestId('choose-patient').click();
  await page.getByTestId('patient-ref-input').fill('A0142');
  await page.getByTestId('patient-yob-input').fill('1958');
  await page.getByTestId('save-patient').click();
  await page.getByTestId('med-ON').click();
  await page.getByTestId('consent').check();
  await page.getByTestId('start-session').click();
  await page.getByTestId('set-up-camera').click();
}

test('M5: a correct setup turns every chip green and enables Record', async ({ page }) => {
  await framing(page, 'good');
  await expect(page.getByTestId('record')).toHaveAttribute('data-gate', 'open');
  await expect(page.getByTestId('record')).toBeEnabled();
  await expect(page.getByTestId('gate-status')).toHaveText('Ready. Press Record');
  for (const chip of ['in_frame', 'distance', 'light', 'level', 'steady'])
    await expect(page.getByTestId(`chip-${chip}`)).toHaveAttribute('data-state', 'OK');
  await expect(page.getByTestId('guidance-prompt')).toHaveCount(0);
});

for (const [scenario, key, text, chip] of [
  ['too_far', 'move_closer', 'Too far: move the phone closer', 'distance'],
  ['one_hand', 'show_both_hands', 'Keep both hands in view', 'in_frame'],
  ['dark', 'too_dark', 'Too dark', 'light'],
  ['tilted', 'rotate_cw', 'Turn the phone a little clockwise', 'level'],
] as const) {
  test(`M5: ${scenario} → single prompt "${key}", Record disabled`, async ({ page }) => {
    await framing(page, scenario);
    await expect(page.getByTestId('guidance-prompt')).toHaveAttribute('data-key', key);
    await expect(page.getByTestId('guidance-prompt')).toContainText(text);
    await expect(page.getByTestId(`chip-${chip}`)).toHaveAttribute('data-state', 'WARN');
    await expect(page.getByTestId('record')).toBeDisabled();
    await page.waitForTimeout(800);
    await expect(page.getByTestId('record')).toBeDisabled();
    await expect(page.getByTestId('guidance-prompt')).toHaveCount(1);
  });
}

test('M5: a tracker error shows "Tracking…", not an error prompt', async ({ page }) => {
  await framing(page, 'tracker_error');
  await expect(page.getByTestId('guidance-tracking')).toContainText('Tracking…');
  await expect(page.getByTestId('guidance-prompt')).toHaveCount(0);
  await expect(page.getByTestId('record')).toBeDisabled();
});

test('M5: engineering "gate off" lets Record work while prompts still show', async ({ page }) => {
  await page.goto('/?mockSpeed=4&scenario=too_far');
  const logo = page.getByTestId('logo');
  await logo.dispatchEvent('pointerdown');
  await page.waitForTimeout(1400);
  await logo.dispatchEvent('pointerup');
  await page.getByTestId('advisory-toggle').check();
  await page.keyboard.press('Escape');
  await page.reload();
  await page.getByTestId('choose-patient').click();
  await page.getByTestId('patient-ref-input').fill('A0142');
  await page.getByTestId('patient-yob-input').fill('1958');
  await page.getByTestId('save-patient').click();
  await page.getByTestId('med-ON').click();
  await page.getByTestId('consent').check();
  await page.getByTestId('start-session').click();
  await page.getByTestId('set-up-camera').click();
  await expect(page.getByTestId('guidance-prompt')).toHaveAttribute('data-key', 'move_closer');
  await expect(page.getByTestId('record')).toBeEnabled();
  await expect(page.getByTestId('gate-status')).toHaveText('Gate off (engineering)');
});
