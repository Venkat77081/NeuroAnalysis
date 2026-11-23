import { expect, test } from '@playwright/test';
import { scanPlatform, signIn, stack } from './support.ts';

/**
 * Acceptance against the real platform + connector + FHIR stand-in: reception adds appointments by
 * hand (nothing is read from the hospital's appointment system) and assigns the doctor; the doctor
 * chooses the tests (history next to them) and where to record: at home, in the clinic, or both
 * (clinic only for a patient not in the app); reception sees where and who did each step. The
 * platform still holds no name or MRN.
 */
test('v3: reception assigns the doctor; the doctor chooses the tests and sends the link', async ({
  page,
}) => {
  const s = stack();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await signIn(page, s.desk_email, s.desk_totp);
  // Join invites are sent from the front desk: e-mail, SMS or a printed QR.
  await page.getByTestId('nav-invite').click();
  await page.getByTestId('p-search').fill('ravi');
  await page.getByTestId('p-search-btn').click();
  await expect(page.getByTestId('p-results')).toContainText('Ravi Samplename');
  await expect(page.getByTestId('p-results')).toContainText('Missing'); // no e-mail on file
  await page.getByTestId('p-sel-00012401').check();
  await expect(page.getByTestId('via-email')).toBeVisible();
  await expect(page.getByTestId('via-sms')).toBeVisible();
  await page.getByTestId('via-print').check();
  await page.getByTestId('p-send').click();
  await expect(page.getByTestId('p-invite-results')).toContainText('QR ready to print');
  await expect(page.getByTestId('invite-qr')).toBeVisible();
  await expect(page.getByTestId('p-send')).toBeDisabled(); // sent once; the QR stays on screen

  await page.getByTestId('nav-appointments').click();
  // By hand only: nothing is read from the hospital's appointment system (user, 16 Nov 2026).
  await expect(page.getByTestId('appts-live')).toHaveCount(0);
  const at = (days: number, hm: string) =>
    `${new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)}T${hm}`;
  const add = async (q: string, mrn: string, when: string, doctor?: string) => {
    await page.getByTestId('manual-q').fill(q);
    await page.getByTestId('manual-search').click();
    await page.getByTestId(`manual-pick-${mrn}`).click();
    await page.getByTestId('manual-at').fill(when);
    if (doctor) await page.getByTestId('manual-doctor').selectOption({ label: doctor });
    await page.getByTestId('manual-add').click();
    // The form clears once saved; the notice may still be up from the last add.
    await expect(page.getByTestId('manual-at')).toHaveValue('');
    await expect(page.getByTestId('notice')).toContainText('Appointment added');
  };
  await add('asha', s.patient_mrn, at(3, '10:30'), 'Dr. Rao');
  await add('ravi', '00012401', at(2, '11:15'));
  const asha = page.getByTestId(`appt-${s.patient_mrn}`).first();
  await expect(asha).toContainText('Added by hand · Front desk');
  await expect(asha.getByTestId('appt-stage')).toHaveText("Waiting for doctor's tests");
  const ravi = page.getByTestId('appt-00012401');
  await expect(ravi.getByTestId('appt-stage')).toHaveText('Needs a doctor');
  await ravi.getByTestId('appt-doctor').selectOption({ label: 'Dr. Rao' });
  await ravi.getByTestId('appt-assign').click();
  await expect(page.getByTestId('notice')).toContainText('waits for the doctor');
  // Ravi has not joined the app: the same three ways to invite him.
  await expect(ravi).toContainText('Not joined');
  // His phone failed the camera check and he told the hospital (decision 035).
  await expect(ravi.getByTestId('appt-phone-unsuitable')).toHaveText('Phone not suitable · 41 fps');
  await ravi.getByRole('button', { name: 'Send join invite' }).click();
  await expect(page.getByTestId('p-invite')).toContainText('Send a join invite to Ravi Samplename');
  await page.getByTestId('via-print').check();
  await page.getByTestId('p-send').click();
  await expect(page.getByTestId('invite-qr')).toBeVisible();
  await page.screenshot({ path: 'test-results/reception-appointments.png', fullPage: true });
  await page.getByTestId('sign-out').click();

  // The doctor: both appointments wait for tests; history is shown next to the choice.
  await signIn(page, s.doctor_email, s.doctor_totp);
  await expect(page.getByTestId('choose-count')).toHaveText('2');
  await page.getByTestId('nav-chooseTests').click();
  // Ravi is not in the app: only the clinic can record him.
  await page.getByTestId('choose-00012401').click();
  await expect(page.getByTestId('choose-not-joined')).toContainText(
    'failed the camera check (41 fps)',
  );
  await expect(page.getByTestId('choose-home')).toBeDisabled();
  await expect(page.getByTestId('choose-clinic')).toBeChecked();
  await expect(page.getByTestId('choose-send')).toHaveText('Add to the clinic queue');
  await page.getByTestId('choose-send').click();
  await expect(page.getByTestId('notice')).toContainText('Sent.');
  await expect(page.getByTestId('choose-count')).toHaveText('1');
  // Asha: at home and in the clinic.
  await page.getByTestId(`choose-${s.patient_mrn}`).click();
  await expect(page.getByTestId('choose-history')).toContainText("Parkinson's disease");
  await page.getByTestId('choose-hands').click();
  await expect(page.getByTestId('choose-test-SAW')).not.toBeChecked();
  await page.getByTestId('choose-test-FA').check();
  await page.getByTestId('choose-med').selectOption('OFF');
  await expect(page.getByTestId('choose-home')).toBeChecked();
  await page.getByTestId('choose-clinic').check();
  await page.getByTestId('choose-repeat').check();
  await page.getByTestId('choose-days').fill('7');
  await expect(page.getByTestId('choose-send')).toHaveText(
    'Send the link and add to the clinic queue',
  );
  await page.screenshot({ path: 'test-results/doctor-choose-tests.png', fullPage: true });
  await page.getByTestId('choose-send').click();
  await expect(page.getByTestId('choose-empty')).toBeVisible();

  // The patient page: the timeline and the "every N days" plan the doctor asked for.
  await page.getByTestId('nav-myPatients').click();
  await page.getByTestId(`open-${s.patient_mrn}`).click();
  await expect(page.getByTestId('timeline')).toContainText('At home');
  await expect(page.getByTestId('timeline')).toContainText('In the clinic');
  await expect(page.getByTestId('timeline-request').first()).toContainText(
    'Finger Tapping, Finger-to-Finger, Forearm Roll, Facial Activation',
  );
  await expect(page.getByTestId('plan-periodic')).toBeChecked();
  await expect(page.getByTestId('plan-days')).toHaveValue('7');
  await expect(page.getByTestId('plan-until')).toContainText(
    'Repeats stop at the next appointment',
  );
  await page.getByTestId('sign-out').click();

  // Reception sees where each will be recorded, and who did each step.
  await signIn(page, s.desk_email, s.desk_totp);
  await page.getByTestId('nav-appointments').click();
  const row = page.getByTestId(`appt-${s.patient_mrn}`).first();
  await expect(row.getByTestId('appt-where')).toContainText('Home link');
  await expect(row.getByTestId('appt-where')).toContainText('Clinic queue');
  await expect(row.getByTestId('appt-stage')).toContainText('Link sent · due');
  await expect(row.getByTestId('appt-stage')).toContainText('In clinic queue for');
  await expect(page.getByTestId('appt-00012401').getByTestId('appt-where')).toHaveText(
    'Clinic queue',
  );
  await expect(row.getByTestId('appt-last')).toContainText('Recording asked for');
  await expect(row.getByTestId('appt-last')).toContainText('Dr. Rao');
  await row.getByTestId('appt-history-btn').click();
  const hist = page.getByTestId('appt-history');
  await expect(hist).toContainText('Appointment added by hand');
  await expect(hist).toContainText(s.desk_email);
  await expect(hist).toContainText('Recording asked for (clinic queue)');
  await expect(hist).toContainText('Recording asked for (home link)');

  const scan = scanPlatform(['Asha', 'Testpatient', 'Ravi', 'Samplename', s.patient_mrn]);
  expect(scan.found).toEqual([]);
  expect(errors).toEqual([]);
});
