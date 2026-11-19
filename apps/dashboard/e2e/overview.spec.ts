import { expect, test } from '@playwright/test';
import { scanPlatform, signIn, stack } from './support.ts';

// v10 (decision 042): every role lands on an Overview with cards and one chart.
test('v10: overviews for platform, hospital admin, front desk and doctor', async ({ page }) => {
  const s = stack();
  await signIn(page, s.root_email, s.root_totp);
  await expect(page.getByTestId('nav-overview')).toBeVisible();
  await expect(page.getByTestId('counts-only')).toBeVisible();
  await expect(page.getByTestId('tile-hospitals-value')).toHaveText(/^\d+$/);
  await expect(page.getByTestId('overview-list')).toContainText('Sunrise Neuro Clinic');
  await page.getByTestId('overview-period-4w').click();
  await expect(page.getByTestId('overview-period-4w')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('chart-bar').last().hover();
  await expect(page.getByTestId('chart-tooltip')).toContainText('Week of');
  await page.getByTestId('overview-table-toggle').click();
  await expect(page.getByTestId('overview-table')).toContainText('Week of');
  await page.getByTestId('tile-hospitals').click();
  await expect(page.getByTestId('hospitals')).toBeVisible();
  // Decision 044: each hospital records only into its own storage (the test stack: development storage).
  await expect(page.getByTestId('can-record-Sunrise Neuro Clinic')).toHaveText('Can record');
  await page.getByTestId('nav-platformSettings').click();
  await expect(page.getByTestId('kind-s3')).toContainText('available');
  await expect(page.getByTestId('kind-azure')).toContainText('Azure app not registered');
  await expect(page.getByTestId('dev-storage-on')).toBeVisible();
  await expect(page.getByTestId('platform-storage')).not.toContainText('NeuroCapture storage');
  await page.getByTestId('sign-out').click();

  // Hospital admin: set-up and health, then the e-mail and SMS card at the connector.
  await signIn(page, s.admin_email, s.admin_totp);
  await expect(page.getByTestId('tile-staff')).toContainText('front desk');
  await expect(page.getByTestId('tile-recordings')).toContainText('Recordings (30 days)');
  const sms = page.getByTestId('overview-item-sms');
  await expect(sms).toContainText('not set up');
  await sms.getByRole('button', { name: 'Set up' }).click();
  await expect(page.getByTestId('storage-card')).toContainText('Phones can record');
  await expect(page.getByTestId('storage-card')).toContainText('NeuroCapture keeps no copy');
  await expect(page.getByTestId('recording-off')).toHaveCount(0);
  const card = page.getByTestId('messaging-card');
  await expect(card).toContainText('Saved at your connector');
  await page.getByTestId('msg-sms-provider-http').click();
  await page.getByTestId('msg-sms-http_url').fill('https://sms-gateway.invalid/send');
  await page.getByTestId('msg-sms-http_token').fill('gw-secret-123');
  await page.getByTestId('msg-save').click();
  await expect(page.getByTestId('messaging-note')).toContainText('Saved');
  await expect(page.getByTestId('msg-sms-http_token')).toHaveValue('');
  await expect(page.getByTestId('msg-sms-http_token')).toHaveAttribute('placeholder', /saved/);
  await page.getByTestId('msg-test-sms-to').fill('+919812345678');
  await page.getByTestId('msg-test-sms').click();
  await expect(card).toContainText('could not be sent');
  await expect(page.getByTestId('msg-sms-status')).toContainText('failing');
  await page.getByTestId('nav-overview').click();
  await expect(page.getByTestId('overview-item-sms')).toContainText('failing');
  // Switch SMS off again so later tests see the stack as it was.
  await page.getByTestId('nav-connections').click();
  await page.getByTestId('msg-sms-provider-off').click();
  await page.getByTestId('msg-save').click();
  await expect(page.getByTestId('messaging-note')).toContainText('Saved');
  await page.getByTestId('sign-out').click();

  // Front desk: the next 14 days, per day.
  await signIn(page, s.desk_email, s.desk_totp);
  await expect(page.getByTestId('tile-today')).toBeVisible();
  await expect(page.getByTestId('chart-bar')).toHaveCount(14);
  await expect(page.getByTestId('overview-period-4w')).toHaveCount(0);
  await page.getByTestId('sign-out').click();

  // Doctor.
  await signIn(page, s.doctor_email, s.doctor_totp);
  await expect(page.getByTestId('tile-myPatients')).toBeVisible();
  await expect(page.getByTestId('tile-onTime')).toBeVisible();

  // The SMS gateway token never reached NeuroCapture.
  expect(scanPlatform(['gw-secret-123', 'sms-gateway.invalid']).found).toEqual([]);
});
