import { expect, test } from '@playwright/test';
import { scanPlatform, signIn, stack } from './support.ts';

/**
 * v3 acceptance against the real platform + connector + FHIR stand-in: reception sees the
 * hospital's appointments live, assigns the doctor and adds one by hand; the doctor chooses the
 * tests (history next to them) and sends the record link; reception sees the link went out; the
 * doctor's patient page shows the timeline. The platform still holds no name or MRN.
 */
test('v3: reception assigns the doctor; the doctor chooses the tests and sends the link', async ({
  page,
}) => {
  const s = stack();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await signIn(page, s.desk_email, s.desk_totp);
  await expect(page.getByTestId('appts-live')).toContainText('From your hospital system');
  // Asha has joined: her FHIR appointment is kept and needs a doctor.
  const asha = page.getByTestId(`appt-${s.patient_mrn}`).first();
  await expect(asha).toContainText('Asha Testpatient');
  await expect(asha).toContainText('From the hospital system');
  await expect(asha.getByTestId('appt-stage')).toHaveText('Needs a doctor');
  // Ravi has not joined the app: reception can send him a join invite.
  await expect(
    page.getByTestId('live-00012401').or(page.getByTestId('appt-00012401')),
  ).toContainText('Not joined');

  await asha.getByTestId('appt-doctor').selectOption({ label: 'Dr. Rao' });
  await asha.getByTestId('appt-assign').click();
  await expect(page.getByTestId('notice')).toContainText('waits for the doctor');
  await expect(asha.getByTestId('appt-stage')).toHaveText("Waiting for doctor's tests");

  // An appointment the hospital system does not send, entered by hand.
  const inSix = new Date(Date.now() + 6 * 86_400_000);
  const local = `${inSix.toISOString().slice(0, 10)}T11:15`;
  await page.getByTestId('manual-q').fill('asha');
  await page.getByTestId('manual-search').click();
  await page.getByTestId(`manual-pick-${s.patient_mrn}`).click();
  await page.getByTestId('manual-at').fill(local);
  await page.getByTestId('manual-doctor').selectOption({ label: 'Dr. Rao' });
  await page.getByTestId('manual-add').click();
  await expect(page.getByTestId('notice')).toContainText('Appointment added');
  await expect(page.getByTestId(`appt-${s.patient_mrn}`)).toHaveCount(2);
  await expect(page.getByTestId('appointments')).toContainText('Added by hand');
  await page.screenshot({ path: 'test-results/reception-appointments.png', fullPage: true });
  await page.getByTestId('sign-out').click();

  // The doctor: both appointments wait for tests; history is shown next to the choice.
  await signIn(page, s.doctor_email, s.doctor_totp);
  await expect(page.getByTestId('choose-count')).toHaveText('2');
  await expect(page.getByTestId('choose-list')).toContainText('Asha Testpatient');
  await expect(page.getByTestId('choose-history')).toContainText("Parkinson's disease");
  await page.getByTestId('choose-hands').click();
  await expect(page.getByTestId('choose-test-SAW')).not.toBeChecked();
  await page.getByTestId('choose-test-FA').check();
  await page.getByTestId('choose-med').selectOption('OFF');
  await page.getByTestId('choose-repeat').check();
  await page.getByTestId('choose-days').fill('7');
  await page.screenshot({ path: 'test-results/doctor-choose-tests.png', fullPage: true });
  await page.getByTestId('choose-send').click();
  await expect(page.getByTestId('notice')).toContainText('Record link sent');
  await expect(page.getByTestId('choose-count')).toHaveText('1');
  // "Same as last time" now offers what was just chosen.
  await expect(page.getByTestId('choose-last')).toContainText('Finger Tapping');
  await page.getByTestId('choose-same').click();
  await expect(page.getByTestId('choose-test-FA')).toBeChecked();
  await expect(page.getByTestId('choose-test-SAW')).not.toBeChecked();

  // The patient page: the timeline and the "every N days" plan the doctor asked for.
  await page.getByTestId('nav-myPatients').click();
  await page.getByTestId(`open-${s.patient_mrn}`).click();
  await expect(page.getByTestId('timeline-request').first()).toContainText(
    'Finger Tapping, Finger-to-Finger, Forearm Roll, Facial Activation',
  );
  await expect(page.getByTestId('timeline')).toContainText('Doctor sent record link');
  await expect(page.getByTestId('plan-periodic')).toBeChecked();
  await expect(page.getByTestId('plan-days')).toHaveValue('7');
  await expect(page.getByTestId('plan-until')).toContainText(
    'Repeats stop at the next appointment',
  );
  await page.getByTestId('sign-out').click();

  // Reception sees the link went out.
  await signIn(page, s.desk_email, s.desk_totp);
  await expect(page.getByTestId('appointments')).toContainText('Doctor sent record link · due');

  const scan = scanPlatform(['Asha', 'Testpatient', 'Ravi', 'Samplename', s.patient_mrn]);
  expect(scan.found).toEqual([]);
  expect(errors).toEqual([]);
});
