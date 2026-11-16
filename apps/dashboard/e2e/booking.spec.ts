import { expect, test, type Page } from '@playwright/test';
import { signIn, stack } from './support.ts';

/**
 * Decision 038 (user, 16 Nov 2026): each appointment keeps its own doctor. A doctor sees a patient
 * through an appointment with them; changing one appointment's doctor leaves the patient's other
 * appointments alone. The date range picker shows appointments beyond 7 days.
 * (Runs after appointments.spec: Asha already has an appointment with Dr. Rao in 3 days.)
 */
const dayLabel = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
  });
const at = (days: number, hm: string) =>
  `${new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)}T${hm}`;

async function myPatients(page: Page) {
  await page.getByTestId('nav-myPatients').click();
}

test('v8: doctors see patients through their own appointments; one appointment, one doctor', async ({
  page,
}) => {
  const s = stack();
  // Dr. Iyer has no appointment with anyone yet.
  await signIn(page, s.doctor2_email, s.doctor2_totp);
  await myPatients(page);
  await expect(page.getByTestId('no-patients')).toBeVisible();
  await page.getByTestId('sign-out').click();

  // Front desk: no "Assign patients" page; book Asha with Dr. Iyer in 20 days.
  await signIn(page, s.desk_email, s.desk_totp);
  await expect(page.getByTestId('nav-assign')).toHaveCount(0);
  await page.getByTestId('nav-appointments').click();
  await page.getByTestId('range-7').click();
  await page.getByTestId('manual-q').fill('asha');
  await page.getByTestId('manual-search').click();
  await page.getByTestId(`manual-pick-${s.patient_mrn}`).click();
  await page.getByTestId('manual-at').fill(at(20, '09:30'));
  await page.getByTestId('manual-doctor').selectOption({ label: 'Dr. Iyer' });
  await page.getByTestId('manual-add').click();
  await expect(page.getByTestId('notice')).toContainText('Appointment added');
  const rows = page.getByTestId(`appt-${s.patient_mrn}`);
  await expect(rows).toHaveCount(1); // 7 days: only the one with Dr. Rao
  await page.getByTestId('range-30').click();
  await expect(page.getByTestId('appts-window')).toContainText('next 30 days');
  await expect(rows).toHaveCount(2);
  const raoRow = rows.filter({ hasText: dayLabel(3) });
  const iyerRow = rows.filter({ hasText: dayLabel(20) });
  await expect(iyerRow.getByTestId('appt-last')).toContainText('with Dr. Iyer');
  // Booking with Dr. Iyer did not move the appointment with Dr. Rao.
  await expect(raoRow).toContainText('Dr. Rao');
  await expect(raoRow).not.toContainText('Dr. Iyer');
  // The range is remembered.
  await page.reload();
  await page.getByTestId('nav-appointments').click();
  await expect(page.getByTestId('range-30')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('sign-out').click();

  // Dr. Iyer now sees Asha (history and every recording), and her appointment to choose tests for.
  await signIn(page, s.doctor2_email, s.doctor2_totp);
  await page.getByTestId('nav-chooseTests').click();
  await expect(page.getByTestId(`choose-${s.patient_mrn}`)).toBeVisible();
  await myPatients(page);
  await expect(page.getByTestId('my-patients')).toContainText('Asha Testpatient');
  await page.getByTestId('sign-out').click();

  // Front desk moves only that appointment to Dr. Rao.
  await signIn(page, s.desk_email, s.desk_totp);
  await page.getByTestId('nav-appointments').click();
  await iyerRow.getByTestId('appt-doctor').selectOption({ label: 'Dr. Rao' });
  await expect(iyerRow.getByTestId('appt-assign')).toHaveText('Change doctor');
  await iyerRow.getByTestId('appt-assign').click();
  await expect(page.getByTestId('notice')).toContainText('this appointment only');
  await expect(rows.filter({ hasText: dayLabel(20) }).getByTestId('appt-last')).toContainText(
    'Dr. Iyer → Dr. Rao',
  );
  await page.getByTestId('sign-out').click();

  // Dr. Iyer has no appointment with Asha any more: no access.
  await signIn(page, s.doctor2_email, s.doctor2_totp);
  await myPatients(page);
  await expect(page.getByTestId('no-patients')).toBeVisible();
});
