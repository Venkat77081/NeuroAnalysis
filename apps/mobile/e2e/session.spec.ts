import { expect, test, type Page } from '@playwright/test';

/** Mock recordings and countdowns run 20× faster (?mockSpeed=20). */
const URL = '/?mockSpeed=20';

async function startSession(page: Page) {
  await page.goto(URL);
  await page.getByTestId('choose-patient').click();
  await page.getByTestId('patient-ref-input').fill('A0142');
  await page.getByTestId('patient-yob-input').fill('1958');
  await page.getByTestId('save-patient').click();
  await expect(page.getByTestId('patient-ref')).toContainText('••••0142');
  await expect(page.getByTestId('start-session')).toBeDisabled();
  await page.getByTestId('med-ON').click();
  await page.getByTestId('consent').check();
  await page.getByTestId('start-session').click();
}

async function recordTake(page: Page, opts: { stopEarly?: boolean } = {}) {
  await page.getByTestId('record').click();
  await expect(page.getByTestId('rec-badge')).toBeVisible();
  if (opts.stopEarly) await page.getByTestId('stop-early').click();
  await expect(page.getByTestId('verdict-card')).toBeVisible({ timeout: 15_000 });
}

test('M3: a full 5-take session (DNE protocol) in mock mode, including one "Keep this take" override', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await startSession(page);

  const titles = [
    'Finger Tapping',
    'Finger-to-Finger',
    'Forearm Roll',
    'Stand and Walk',
    'Facial Activation',
  ];
  for (let i = 0; i < 5; i++) {
    await expect(page.getByTestId('test-of')).toHaveText(`Test ${i + 1} of 5`);
    await expect(page.getByTestId('test-title')).toHaveText(titles[i]!);
    await page.getByTestId('set-up-camera').click();
    await expect(page.getByTestId('outline')).toBeVisible();

    if (i === 1) {
      // Stopped early → RETAKE → keep with a reason (flagged for review).
      await recordTake(page, { stopEarly: true });
      await expect(page.getByTestId('verdict-title')).toHaveText('Retake needed');
      await expect(page.getByTestId('verdict-reasons')).toContainText('Stopped early');
      await page.getByTestId('keep').click();
      await expect(page.getByTestId('keep-sheet')).toBeVisible();
      await expect(page.getByTestId('confirm-keep')).toBeDisabled();
      await page.getByLabel('Patient fatigue').check();
      await page.getByTestId('confirm-keep').click();
      continue;
    }
    if (i === 4) {
      // One retake: the first take is accepted only after a second recording.
      await recordTake(page);
      await page.getByTestId('retake').click();
      await expect(page.getByTestId('stage-framing')).toBeVisible();
    }
    await recordTake(page);
    await expect(page.getByTestId('verdict-title')).toHaveText('Capture passed');
    await page.getByTestId('accept').click();
  }

  await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible();
  const counts = page.getByTestId('summary-counts');
  await expect(counts).toContainText('4Passed');
  await expect(counts).toContainText('1Kept · flagged');
  await expect(counts).toContainText('0Skipped');
  await expect(page.getByTestId('summary-rows')).toContainText('Reason: Patient fatigue');
  await expect(page.getByTestId('summary-rows')).toContainText('2 takes');
  await page.screenshot({ path: 'test-results/session-summary.png', fullPage: true });

  await page.getByTestId('end-session').click();
  await expect(page.getByRole('heading', { name: 'New session' })).toBeVisible();
  await expect(page.getByTestId('start-session')).toBeDisabled();
  expect(errors).toEqual([]);
});

test('M3: a take in progress when the app reloads resumes as interrupted at framing', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto('/'); // real time, so the take is still recording at reload
  await page.getByTestId('choose-patient').click();
  await page.getByTestId('patient-ref-input').fill('B7788');
  await page.getByTestId('save-patient').click();
  await page.getByTestId('med-OFF').click();
  await page.getByTestId('consent').check();
  await page.getByTestId('start-session').click();
  await page.getByTestId('set-up-camera').click();
  await page.getByTestId('record').click();
  await expect(page.getByTestId('rec-badge')).toBeVisible({ timeout: 10_000 });
  await page.reload();
  await expect(page.getByTestId('stage-framing')).toBeVisible();
  await expect(page.getByTestId('interrupted-notice')).toBeVisible();
  // Record again from where the session left off.
  await page.goto(URL);
  await recordTake(page);
  await expect(page.getByTestId('verdict-title')).toHaveText('Capture passed');
});

test('M3: skipping a test needs a reason; "Other" needs a note', async ({ page }) => {
  await startSession(page);
  await page.getByTestId('skip-test').click();
  await expect(page.getByTestId('confirm-skip')).toBeDisabled();
  await page.getByLabel('Other').check();
  await expect(page.getByTestId('confirm-skip')).toBeDisabled();
  await page.getByRole('textbox').fill('Patient left early');
  await page.getByTestId('confirm-skip').click();
  await expect(page.getByTestId('test-of')).toHaveText('Test 2 of 5');
});

test('M3: go back to a previous test, keep its result, then end the session early', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await startSession(page);
  await expect(page.getByTestId('prev-test')).toHaveCount(0);
  await page.getByTestId('set-up-camera').click();
  await expect(page.getByTestId('upper_body_hands_up')).toBeAttached();
  await recordTake(page);
  await page.getByTestId('accept').click();
  await expect(page.getByTestId('test-of')).toHaveText('Test 2 of 5');
  await page.getByTestId('set-up-camera').click();
  await expect(page.getByTestId('upper_body_hands_up')).toBeAttached();
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByTestId('prev-test').getByRole('button').click();
  await expect(page.getByTestId('test-of')).toHaveText('Test 1 of 5');
  await expect(page.getByTestId('step-done')).toContainText('Passed');
  await page.getByTestId('next-test').click();
  await expect(page.getByTestId('test-of')).toHaveText('Test 2 of 5');
  await expect(page.getByTestId('step-done')).toHaveCount(0);
  await page.getByTestId('end-early').click();
  await expect(page.getByTestId('confirm-abort')).toBeDisabled();
  await page.getByLabel('Patient unwell').check();
  await page.getByTestId('confirm-abort').click();
  await expect(page.getByTestId('aborted')).toContainText('Session ended early: Patient unwell');
  await expect(page.getByTestId('summary-rows')).toContainText('Not done');
});
