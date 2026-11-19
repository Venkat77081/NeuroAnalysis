import { expect, test } from '@playwright/test';
import { signIn, stack } from './support.ts';

test('M14: hospital admin — connector health, team, phones, activity (set-up only)', async ({
  page,
}) => {
  const s = stack();
  await signIn(page, s.admin_email, s.admin_totp);
  await page.getByTestId('nav-connections').click();
  await expect(page.getByTestId('connector-card')).toContainText('registered');
  await expect(page.getByTestId('platform-key-sha')).toHaveText(/^[0-9a-f]{64}$/);
  await expect(page.getByTestId('keys')).toContainText('active');
  await page.getByTestId('c-sample').fill(s.patient_mrn);
  await page.getByTestId('c-check').click();
  const checks = page.getByTestId('check-results');
  for (const k of ['reachable', 'records', 'ncid_map', 'activity_log', 'decrypt_key'])
    await expect(checks).toContainText(`${k}: pass`);

  // Set-up only: patients, invites and appointments are the front desk's (user, 16 Nov 2026).
  for (const p of ['invite', 'appointments', 'assign'])
    await expect(page.getByTestId(`nav-${p}`)).toHaveCount(0);

  await page.getByTestId('nav-team').click();
  await page.getByTestId('team-add-operator').click(); // v30: adding happens in a pop-up
  await page.getByTestId('op-code').fill('OP-E2E');
  await expect(page.getByTestId('op-add')).toBeDisabled(); // a name is required
  await page.getByTestId('op-name').fill('Kavya R');
  await page.getByTestId('op-add').click();
  await expect(page.getByTestId('temp-password')).toContainText('OP-E2E');
  await expect(page.getByTestId('operators')).toContainText('must change password');
  // Decision 039: reset a staff member's sign-in (opened, then cancelled: later tests sign in as them).
  const iyer = page.getByTestId('staff').locator('li', { hasText: 'Dr. Iyer' });
  await iyer.getByTestId('st-reset').click();
  const panel = page.getByTestId('reset-panel');
  await expect(panel).toContainText('valid 24 hours');
  await expect(panel.getByTestId('reset-reason')).toContainText('Lost or new phone');
  await panel.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('reset-panel')).toHaveCount(0);

  await page.getByTestId('nav-phones').click();
  await page.getByTestId('d-new').click();
  await expect(page.getByTestId('d-code-text')).toHaveText(/^[A-Z2-9]{10}$/);
  // Camera check (decision 035): a failed check does not use the code; 57.2 fps is borderline.
  const code = await page.getByTestId('d-code-text').innerText();
  const register = (fps: number) =>
    page.request.post(`${s.platform_url}/auth/device-register`, {
      data: {
        enrollment_code: code,
        model: 'Redmi Note 12',
        os_version: '14',
        camera_check: { effective_fps: fps },
      },
    });
  expect((await register(48)).status()).toBe(422);
  expect((await register(57.2)).status()).toBe(201);
  await page.getByTestId('nav-team').click();
  await page.getByTestId('nav-phones').click();
  await expect(page.getByTestId('devices')).toContainText('Borderline · 57.2 fps');
  await expect(page.getByTestId('devices')).toContainText('In use (last 30 days)');
  await expect(page.getByTestId('device-usage').first()).toHaveText('No takes yet');

  await page.getByTestId('nav-activity').click();
  // One log, by person: name, e-mail and role on every row.
  const log = page.getByTestId('activity-log');
  await expect(log).toContainText('Added a clinic phone operator');
  await expect(log).toContainText(`${s.admin_email} · Hospital admin`);
  await expect(page.getByTestId('log-csv')).toBeVisible();
});

test('M14: platform admin — hospitals, set-up status, onboarding, platform log', async ({
  page,
}) => {
  const s = stack();
  await signIn(page, s.root_email, s.root_totp);
  await page.getByTestId('nav-hospitals').click(); // v10: every role starts on its Overview
  await expect(page.getByTestId('hospitals')).toContainText('Sunrise Neuro Clinic');
  await page.getByTestId('setup-Sunrise Neuro Clinic').click();
  const steps = page.getByTestId('setup-steps');
  // Decision 039: the platform admin can reset the hospital admin's sign-in from here.
  await expect(page.getByTestId('hospital-admins')).toContainText(s.admin_email);
  await expect(page.getByTestId('admin-reset')).toBeVisible();
  await expect(steps).toContainText('Connector registered');
  await expect(steps.locator('li', { hasText: 'Hospital take key registered' })).toContainText(
    'pass',
  );
  // v28: set-up opens in a side panel; close it to onboard the next hospital.
  await page.getByTestId('dialog-close').click();
  // v30: "Onboard a hospital" opens a pop-up.
  await page.getByTestId('onboard-open').click();
  await page.getByTestId('h-name').fill('Lakeview Hospital');
  await page.getByTestId('h-email').fill('admin@lakeview.example');
  await page.getByTestId('h-create').click();
  await expect(page.getByTestId('hospitals')).toContainText('Lakeview Hospital');
  if (await page.getByTestId('onboard-dialog').isVisible())
    await page.getByTestId('dialog-close').click(); // the invite e-mail could not be sent
  await page.getByTestId('nav-platformLog').click();
  await expect(page.getByTestId('platform-log')).toContainText('Onboarded the hospital');
  await expect(page.getByTestId('platform-log')).toContainText('Platform admin');
});
