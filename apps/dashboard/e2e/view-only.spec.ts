import { expect, test } from '@playwright/test';
import { assignPatient, moveAppointments, signIn, stack } from './support.ts';

/**
 * Decision 061. Runs last (file order): it moves the doctor's upcoming appointments to another
 * doctor, which other specs rely on.
 */
test('decision 061: after a move to another doctor, the first doctor may only view', async ({
  page,
}) => {
  const s = stack();
  expect(await moveAppointments(s.doctor_email, s.new_doctor_email)).toBeGreaterThan(0);
  await signIn(page, s.doctor_email, s.doctor_totp);
  await page.getByTestId('nav-myPatients').click();
  await expect(page.getByTestId(`moved-${s.patient_mrn}`)).toContainText('view only');
  await page.getByTestId(`open-${s.patient_mrn}`).click();
  await expect(page.getByTestId('view-only')).toBeVisible();
  // Everything is still readable: history, recordings, earlier reviews and remarks.
  await expect(page.getByTestId('history')).toContainText("Parkinson's disease");
  await expect(page.getByTestId('recordings')).toContainText('Reviewed: Not usable');
  await expect(page.getByTestId('remark-author').first()).toBeVisible();
  // Nothing can be added or changed.
  await expect(page.getByTestId(`review-${s.take_id}`)).toHaveCount(0);
  await expect(page.getByTestId('remark-edit')).toHaveCount(0);
  await expect(page.getByTestId('rerecord')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/doctor-view-only.png', fullPage: true });
  await assignPatient(s.doctor_email); // a new visit with this doctor: full access again
});
