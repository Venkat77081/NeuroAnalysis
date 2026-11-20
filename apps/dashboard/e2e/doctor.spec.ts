import { expect, test } from '@playwright/test';
import { assignPatient, scanPlatform, signIn, stack } from './support.ts';

/**
 * M14 acceptance: a doctor views a patient's live history and a recording, while NeuroCapture's
 * database, logs and stored files contain no name or MRN (checked by scanning them).
 */
test('M14: doctor sees live history and a decrypted recording; the platform holds no identity', async ({
  page,
}) => {
  const s = stack();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await assignPatient(s.doctor_email); // decision 040: an upcoming appointment with this doctor
  await signIn(page, s.doctor_email, s.doctor_totp);
  await page.getByTestId('nav-myPatients').click(); // v3: doctors land on "Choose tests"
  await expect(page.getByTestId('my-patients')).toContainText('Asha Testpatient');
  // v33: a card opens the side panel; "Open full page" goes to the patient page.
  await page.getByTestId(`patient-card-${s.patient_mrn}`).click();
  await expect(page.getByTestId('patient-panel')).toBeVisible();
  await page.getByTestId(`open-${s.patient_mrn}`).click();

  // Live history from the hospital's FHIR server, through the connector.
  await expect(page.getByTestId('patient-mrn')).toContainText(`MRN ${s.patient_mrn}`);
  await expect(page.getByTestId('history')).toContainText("Parkinson's disease");
  await expect(page.getByTestId('history')).toContainText('Levodopa/carbidopa 100/25 mg');

  // Decision 040: visit remarks on the doctor's own appointment (kept at the hospital), and the
  // period of past appointments shown.
  await expect(page.getByTestId('period-90')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('period-30').click();
  await page.getByTestId('remark-edit').first().click();
  await page.getByTestId('remark-text').fill('Tremor at rest improved since the dose change.');
  await page.getByTestId('remark-save').click();
  await expect(page.getByTestId('timeline')).toContainText('Tremor at rest improved');

  // The recording, decrypted by the connector, plays in the browser.
  await page.getByTestId('play-FT').click();
  const player = page.getByTestId('player');
  await expect(player).toBeVisible();
  await expect
    .poll(() => player.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(2);
  expect(await player.evaluate((v: HTMLVideoElement) => v.videoWidth)).toBe(320);
  await page.screenshot({ path: 'test-results/doctor-patient.png', fullPage: true });

  // M15 (decision 059): the connector analyses the take and keeps the report at the hospital. The
  // sample video is 30 fps, so every value says why it was not computed.
  const bio = page.getByTestId(`bio-${s.take_id}`);
  await expect(bio).toHaveAttribute('data-state', 'none');
  await bio.click();
  await expect(bio).toHaveAttribute('data-state', 'done', { timeout: 90_000 });
  await bio.click();
  const frame = page.frameLocator('[data-testid="bio-report-frame"]');
  await expect(frame.getByRole('heading', { name: 'Finger Tapping' })).toBeVisible();
  await expect(frame.locator('table').first()).toContainText('video is 30.0 fps, needs 58');
  await page.screenshot({ path: 'test-results/doctor-biomarker-report.png' });
  await page.getByTestId('bio-report').getByTestId('dialog-close').click();

  // Review (note kept at the hospital), plan, re-record request.
  const review = page.getByTestId(`review-${s.take_id}`);
  await review.getByTestId('review-not-usable').click();
  await review
    .getByTestId('review-note')
    .fill('Asha Testpatient: hands out of frame, retake on Friday');
  await review.getByTestId('review-save').click();
  await expect(page.getByTestId('recordings')).toContainText('Reviewed: Not usable');
  await page.getByTestId('plan-SAW').uncheck();
  await page.getByTestId('plan-periodic').check(); // v3: every N days only when the doctor asks
  await page.getByTestId('plan-days').fill('3');
  await page.getByTestId('plan-save').click();
  await expect(page.getByTestId('plan-saved')).toBeVisible();
  await page.getByTestId('rerecord').click();
  await expect(page.getByTestId('notice')).toContainText('due');

  // The scan: no name, MRN, contact or review note anywhere at NeuroCapture.
  const scan = scanPlatform([
    'Asha',
    'Testpatient',
    'asha.t@example.org',
    '+919800000001',
    'retake on Friday',
    '1958-03-02',
  ]);
  expect(scan.found).toEqual([]);
  expect(scan.audit_rows).toBeGreaterThan(5); // the scan did see a populated database
  expect(errors).toEqual([]);
});

test('M14: first sign-in sets up two-step with an authenticator app', async ({ page }) => {
  const s = stack();
  const { totp } = await import('./support.ts');
  await page.goto('/');
  await page.getByTestId('email').fill(s.new_doctor_email);
  await page.getByTestId('password').fill(s.password);
  await page.getByTestId('sign-in').click();
  const secret = (await page.getByTestId('two-step-secret').textContent())!.trim();
  await page.getByTestId('setup-code').fill('000000');
  await page.getByTestId('setup-confirm').click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByTestId('setup-code').fill(totp(secret));
  await page.getByTestId('setup-confirm').click();
  await expect(page.getByTestId('nav-chooseTests')).toBeVisible();
  await page.getByTestId('nav-myPatients').click();
  // v33: a new doctor's card grid is empty, so the page shows the "no patients" note instead.
  await expect(
    page.getByTestId('no-patients').or(page.locator('[data-testid^="patient-card-"]').first()),
  ).toBeVisible();
});
