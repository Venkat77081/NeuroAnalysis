import { expect, test, type APIRequestContext } from '@playwright/test';
import { signIn, stack } from './support.ts';

/**
 * v13 (decision 045), against the real platform + connector: the hospital admin sets the phones'
 * pass level, the change cut-off and a doctor's clinic hours; the patient asks (as the app does)
 * to move their appointment; the front desk sees the request, picks a free time and moves it; then
 * moves it again on its own with a reason. Runs last: it changes the seeded appointment.
 */
const TZ = 'Asia/Kolkata';
const dayIn = (days: number) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Date.now() + days * 86_400_000));

async function patientToken(request: APIRequestContext): Promise<string> {
  const s = stack();
  const r = await request.post(`${s.platform_url}/patient/login`, {
    data: {
      device_id: s.patient_device_id,
      device_secret: s.patient_device_secret,
      pin: s.patient_pin,
    },
  });
  expect(r.status()).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}

test('v13: settings, clinic hours, a patient asks to move, the desk moves', async ({
  page,
  request,
}) => {
  const s = stack();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // Hospital admin: phones' pass level and the change cut-off; Dr. Rao's clinic hours.
  await signIn(page, s.admin_email, s.admin_totp);
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-fps').selectOption('57');
  await page.getByTestId('settings-cutoff').selectOption('48');
  await page.getByTestId('settings-tz').selectOption(TZ);
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('settings-saved')).toBeVisible();
  await expect(page.getByTestId('settings-fps')).toHaveValue('57');
  await page.getByTestId('nav-team').click();
  const rao = page.getByTestId('hours-Dr. Rao');
  await expect(rao).toContainText('Not set');
  for (const d of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])
    await rao.getByTestId(`hours-${d}`).fill('09:00-13:00');
  await rao.getByTestId('hours-mon').fill('9:00-13:00, 14:00-1700');
  await expect(rao.getByTestId('hours-save')).toBeDisabled();
  await rao.getByTestId('hours-mon').fill('09:00-13:00, 14:00-17:00');
  await rao.getByTestId('hours-dept').fill('Neurology');
  await rao.getByTestId('hours-slot').selectOption('30');
  await rao.getByTestId('hours-save').click();
  await expect(rao.getByTestId('hours-saved')).toBeVisible();
  await expect(rao).not.toContainText('Not set');
  await page.getByTestId('sign-out').click();

  // The patient asks (as the app does) to move their appointment with Dr. Rao.
  const tok = await patientToken(request);
  const auth = { Authorization: `Bearer ${tok}` };
  const mine = (await (
    await request.get(`${s.platform_url}/patient/appointments`, { headers: auth })
  ).json()) as { cutoff_hours: number; appointments: { id: string; can_ask: boolean }[] };
  expect(mine.cutoff_hours).toBe(48);
  const appt = mine.appointments.find((a) => a.can_ask)!;
  const wanted = [dayIn(5), dayIn(6)];
  const asked = await request.post(
    `${s.platform_url}/patient/appointments/${appt.id}/change-request`,
    {
      headers: auth,
      data: { days: wanted, part_of_day: 'morning', reason: 'travel' },
    },
  );
  expect(asked.status()).toBe(201);

  // Front desk: a count in the menu, the request in its tab, then the move panel.
  await signIn(page, s.desk_email, s.desk_totp);
  await expect(page.getByTestId('change-count')).toHaveText('1');
  await page.getByTestId('nav-appointments').click();
  await expect(
    page.getByTestId(`appt-${s.patient_mrn}`).filter({ hasText: 'Change asked' }),
  ).toHaveCount(1);
  await page.getByTestId('tab-changes').click();
  const row = page.getByTestId(`change-${s.patient_mrn}`);
  await expect(row).toContainText('morning');
  await expect(row).toContainText('Reason: Travel');
  await row.getByTestId('change-choose').click();
  const panel = page.getByTestId('move-panel');
  await expect(panel.getByTestId('move-request')).toContainText('The patient would like');
  await expect(panel.getByTestId(`move-day-${wanted[0]}`)).toHaveAttribute('aria-pressed', 'true');
  const raoDay = panel.getByTestId('move-doctor-Dr. Rao');
  await expect(raoDay).toContainText('Neurology');
  await expect(raoDay).toContainText(/\d+ free/);
  await raoDay.getByTestId('move-slot-10:00').click();
  await expect(panel.getByTestId('move-save')).toContainText('10:00 am · Dr. Rao');
  await page.screenshot({ path: 'test-results/v13-move-panel.png', fullPage: true });
  await panel.getByTestId('move-save').click();
  await expect(page.getByTestId('notice')).toContainText('appointment is now');
  await expect(page.getByTestId('no-change-requests')).toBeVisible();
  await expect(page.getByTestId('change-count')).toHaveCount(0);

  // The patient sees it accepted, at the new day.
  const after = (await (
    await request.get(`${s.platform_url}/patient/appointments`, { headers: auth })
  ).json()) as { appointments: { id: string; at: string; change: { status: string } | null }[] };
  const moved = after.appointments.find((a) => a.id === appt.id)!;
  expect(moved.change?.status).toBe('accepted');
  expect(new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(moved.at))).toBe(
    wanted[0],
  );

  // The desk moves it again on its own: a typed time and a reason; the list shows "Moved · was".
  await page.getByTestId('tab-list').click();
  await page.getByTestId('range-30').click();
  const listed = page.getByTestId(`appt-${s.patient_mrn}`).filter({ hasText: 'Moved · was' });
  await expect(listed).toHaveCount(1);
  await listed.getByTestId('appt-move').click();
  const panel2 = page.getByTestId('move-panel');
  await expect(panel2.getByTestId('move-save')).toBeDisabled();
  await panel2.getByTestId(`move-day-${dayIn(8)}`).click();
  await panel2.getByTestId('move-time').fill('11:30');
  await panel2.getByTestId('move-reason').selectOption('doctor_unavailable');
  await panel2.getByTestId('move-notify').uncheck();
  await panel2.getByTestId('move-save').click();
  await expect(page.getByTestId('notice')).toContainText('11:30 am');
  const hist = page.getByTestId(`appt-${s.patient_mrn}`).filter({ hasText: 'Moved · was' });
  await hist.getByTestId('appt-history-btn').click();
  await expect(page.getByTestId('appt-history')).toContainText('Doctor not available');
  await expect(page.getByTestId('appt-history')).toContainText('Patient asked to change the date');
  expect(errors).toEqual([]);
});
