import { expect, test } from '@playwright/test';
import { signIn, stack } from './support.ts';

/** M14: the receptionist assigns and reassigns patients; doctors see only their assigned patients. */
test('M14: receptionist assigns and reassigns; each doctor sees only their patients', async ({
  page,
}) => {
  const s = stack();
  // A doctor with no assignment sees nobody.
  await signIn(page, s.doctor2_email, s.doctor2_totp);
  await expect(page.getByTestId('no-patients')).toBeVisible();
  await page.getByTestId('sign-out').click();

  await signIn(page, s.desk_email, s.desk_totp);
  await expect(page.getByTestId('who')).toContainText('Receptionist');
  await expect(page.getByTestId('nav-team')).toHaveCount(0); // the desk does not manage the team
  // Add a hospital patient who has no NCID yet, from the live records.
  await page.getByTestId('a-search').fill('ravi');
  await page.getByTestId('a-search-btn').click();
  // (The hospital admin test may already have invited him, which lists him too.)
  await expect(page.getByTestId('a-found')).toContainText('Ravi Samplename');
  const add = page.getByTestId('a-add-00012401');
  if (await add.count()) await add.click();
  const ravi = page.getByTestId('row-00012401');
  await expect(ravi).toContainText('Ravi Samplename');
  await expect(ravi.getByTestId('assigned-to')).toHaveText('Not assigned');
  // Assign Asha to Dr. Iyer, then reassign her to Dr. Rao.
  const asha = page.getByTestId(`row-${s.patient_mrn}`);
  await expect(asha).toContainText('Asha Testpatient');
  await asha.getByTestId('a-doctor').selectOption({ label: 'Dr. Iyer' });
  await asha.getByTestId('a-save').click();
  await expect(asha.getByTestId('assigned-to')).toHaveText('Dr. Iyer');
  await page.getByTestId('sign-out').click();

  await signIn(page, s.doctor2_email, s.doctor2_totp);
  await expect(page.getByTestId('my-patients')).toContainText('Asha Testpatient');
  await expect(page.getByTestId('my-patients')).not.toContainText('Ravi');
  await page.getByTestId('sign-out').click();

  await signIn(page, s.desk_email, s.desk_totp);
  await asha.getByTestId('a-doctor').selectOption({ label: 'Dr. Rao' });
  await expect(asha.getByTestId('a-save')).toHaveText('Reassign');
  await asha.getByTestId('a-save').click();
  await expect(asha.getByTestId('assigned-to')).toHaveText('Dr. Rao');
  await page.getByTestId('sign-out').click();

  // Dr. Iyer lost access at once; Dr. Rao has it.
  await signIn(page, s.doctor2_email, s.doctor2_totp);
  await expect(page.getByTestId('no-patients')).toBeVisible();
  await page.getByTestId('sign-out').click();
  await signIn(page, s.doctor_email, s.doctor_totp);
  await expect(page.getByTestId('my-patients')).toContainText('Asha Testpatient');
});
