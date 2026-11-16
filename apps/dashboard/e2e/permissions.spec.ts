import { expect, test } from '@playwright/test';
import { signIn, stack } from './support.ts';

/**
 * Decision 033: the platform admin changes what a role may do at one hospital, with a reason;
 * the person's menu follows; the hospital admin sees it read only; reset restores the defaults.
 */
test('platform admin lets doctors book appointments at one hospital, then resets', async ({
  page,
}) => {
  const s = stack();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // Defaults: a doctor cannot add appointments (no form, no hospital-system list).
  await signIn(page, s.doctor_email, s.doctor_totp);
  await page.getByTestId('nav-appointments').click();
  await expect(page.getByTestId('manual')).toHaveCount(0);
  await page.getByTestId('sign-out').click();

  await signIn(page, s.root_email, s.root_totp);
  await page.getByTestId('perms-Sunrise Neuro Clinic').click();
  const table = page.getByTestId('perm-table');
  await expect(table).toContainText('Assign and reassign the doctor');
  await expect(page.getByTestId('perm-fixed')).toContainText('Assigned patients only');
  await expect(page.getByTestId('perm-requests.send-receptionist')).toHaveCount(0); // not eligible
  await page.getByTestId('perm-appointments.add-doctor').check();
  await page.getByTestId('perm-appointments.assign-doctor').check();
  await expect(page.getByTestId('perm-save')).toBeDisabled(); // a reason is required
  await page.getByTestId('perm-reason').fill('Small clinic: Dr. Rao books his own appointments');
  await page.getByTestId('perm-save').click();
  await expect(page.getByTestId('perm-saved')).toBeVisible();
  await expect(page.getByTestId('perm-changed-count')).toContainText('2 changes');
  await expect(page.getByTestId('perm-appointments.add')).toContainText('CHANGED');
  await expect(page.getByTestId('perm-last')).toContainText('Small clinic');
  await page.screenshot({ path: 'test-results/permissions.png', fullPage: true });
  await page.getByTestId('nav-platformLog').click();
  await expect(page.getByTestId('platform-log')).toContainText('Changed roles and permissions');
  await page.getByTestId('sign-out').click();

  // The doctor now has the booking form.
  await signIn(page, s.doctor_email, s.doctor_totp);
  await page.getByTestId('nav-appointments').click();
  await expect(page.getByTestId('manual')).toBeVisible();
  await expect(page.getByTestId('manual-doctor')).toBeVisible();
  await page.getByTestId('sign-out').click();

  // The hospital admin sees who can do what, read only.
  await signIn(page, s.admin_email, s.admin_totp);
  await page.getByTestId('nav-team').click();
  await expect(page.getByTestId('perm-readonly')).toContainText('Small clinic');
  await expect(page.getByTestId('perm-appointments.add-doctor')).toBeDisabled();
  await page.getByTestId('sign-out').click();

  // Reset to defaults.
  await signIn(page, s.root_email, s.root_totp);
  await page.getByTestId('perms-Sunrise Neuro Clinic').click();
  await page.getByTestId('perm-reason').fill('Back to the standard set');
  await page.getByTestId('perm-reset').click();
  await expect(page.getByTestId('perm-saved')).toBeVisible();
  await expect(page.getByTestId('perm-changed-count')).toHaveCount(0);
  expect(errors).toEqual([]);
});
