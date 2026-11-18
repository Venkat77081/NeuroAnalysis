import { expect, test, type APIRequestContext } from '@playwright/test';
import { signIn, stack } from './support.ts';

/**
 * v13 + v14 (decisions 045, 046), against the real platform + connector: the hospital admin sets
 * the phones' pass level, the change cut-off and doctors' clinic hours; the patient (as the app
 * does) asks to change an appointment with exact times and the desk books one; the desk offers
 * choices and the patient picks one; the patient books from the app and the desk confirms; the
 * desk and the patient cancel with reasons. Runs last: it changes the seeded appointments.
 */
const TZ = 'Asia/Kolkata';
const dayIn = (days: number) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Date.now() + days * 86_400_000));
/** A time in the hospital's zone (India has no daylight saving). */
const at = (days: number, hhmm: string) => `${dayIn(days)}T${hhmm}:00+05:30`;
const localDay = (iso: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(iso));

interface Mine {
  cutoff_hours: number;
  appointments: {
    id: string;
    at: string;
    status: string;
    can_ask: boolean;
    change: { status: string } | null;
    offer: { id: string; options: { index: number; at: string }[] } | null;
  }[];
  bookings: { id: string; status: string }[];
}

async function patient(request: APIRequestContext) {
  const s = stack();
  const r = await request.post(`${s.platform_url}/patient/login`, {
    data: {
      device_id: s.patient_device_id,
      device_secret: s.patient_device_secret,
      pin: s.patient_pin,
    },
  });
  expect(r.status()).toBe(200);
  const headers = {
    Authorization: `Bearer ${((await r.json()) as { access_token: string }).access_token}`,
  };
  return {
    mine: async () =>
      (await (
        await request.get(`${s.platform_url}/patient/appointments`, { headers })
      ).json()) as Mine,
    post: async (path: string, data: unknown) =>
      request.post(`${s.platform_url}${path}`, { headers, data }),
  };
}

test('v13/v14: settings, hours, requests with times, offers, booking, cancelling', async ({
  page,
  request,
}) => {
  const s = stack();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // Hospital admin: settings and clinic hours.
  await signIn(page, s.admin_email, s.admin_totp);
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-fps').selectOption('57');
  await page.getByTestId('settings-cutoff').selectOption('48');
  await page.getByTestId('settings-tz').selectOption(TZ);
  await expect(page.getByTestId('settings-booking')).toContainText('Preferred dates');
  await page.getByTestId('settings-offer_reply_hours').selectOption('72');
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('settings-saved')).toBeVisible();
  await expect(page.getByTestId('settings-fps')).toHaveValue('57');
  await expect(page.getByTestId('settings-offer_reply_hours')).toHaveValue('72');
  // v16 (decision 047): consent on the clinic phone for patients without the app (on by default).
  const phoneConsent = page.getByTestId('settings-phone-consent');
  await expect(phoneConsent).toBeChecked();
  await phoneConsent.uncheck();
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('settings-saved')).toBeVisible();
  await page.getByTestId('nav-team').click();
  await page.getByTestId('nav-settings').click();
  await expect(page.getByTestId('settings-phone-consent')).not.toBeChecked();
  await page.getByTestId('settings-phone-consent').check();
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('settings-phone-consent')).toBeChecked();
  await page.getByTestId('nav-team').click();
  for (const [doc, hours] of [
    ['Dr. Rao', '09:00-13:00, 14:00-17:00'],
    ['Dr. Iyer', '09:00-13:00'],
  ] as const) {
    const row = page.getByTestId(`hours-${doc}`);
    await expect(row).toContainText('Not set');
    for (const d of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])
      await row.getByTestId(`hours-${d}`).fill(hours);
    await row.getByTestId('hours-dept').fill('Neurology');
    await row.getByTestId('hours-slot').selectOption('30');
    await row.getByTestId('hours-save').click();
    await expect(row.getByTestId('hours-saved')).toBeVisible();
  }
  const rao = page.getByTestId('hours-Dr. Rao');
  await rao.getByTestId('hours-mon').fill('9:00-13:00, 14:00-1700');
  await expect(rao.getByTestId('hours-save')).toBeDisabled();
  await page.getByTestId('sign-out').click();

  // The patient asks to change an appointment: exact times (preferred and alternative).
  const pt = await patient(request);
  const mine = await pt.mine();
  expect(mine.cutoff_hours).toBe(48);
  const appt = mine.appointments.find((a) => a.can_ask)!;
  const asked = await pt.post(`/patient/appointments/${appt.id}/change-request`, {
    choices: [
      { at: at(5, '10:00'), rank: 'preferred' },
      { at: at(5, '10:30'), rank: 'preferred' },
      { at: at(7, '11:00'), rank: 'alternative' },
    ],
    reason: 'travel',
  });
  expect(asked.status()).toBe(201);

  // Front desk: count, the Requests tab, each time checked, book the first.
  await signIn(page, s.desk_email, s.desk_totp);
  await expect(page.getByTestId('change-count')).toHaveText('1');
  await page.getByTestId('nav-appointments').click();
  await page.getByTestId('tab-requests').click();
  await expect(page.getByTestId('inbox-filter-change')).toContainText('1');
  const row = page.getByTestId(`inbox-${s.patient_mrn}`);
  await expect(row).toContainText('Change asked');
  await expect(row).toContainText('3 free now');
  await row.getByTestId('inbox-check').click();
  const panel = page.getByTestId('request-panel');
  await expect(panel.getByTestId('request-choice')).toHaveCount(3);
  await expect(panel.getByTestId('request-choice').first()).toContainText('Free');
  await page.screenshot({ path: 'test-results/v14-request-panel.png', fullPage: true });
  await panel.getByTestId('request-book').first().click();
  await expect(page.getByTestId('notice')).toContainText('appointment is now');
  await expect(page.getByTestId('inbox-empty')).toBeVisible();
  let after = (await pt.mine()).appointments.find((a) => a.id === appt.id)!;
  expect(after.change?.status).toBe('accepted');
  expect(localDay(after.at)).toBe(dayIn(5));

  // The desk offers choices instead of moving; the patient picks the second one.
  await page.getByTestId('tab-list').click();
  await page.getByTestId('range-30').click();
  const moved = page.getByTestId(`appt-${s.patient_mrn}`).filter({ hasText: 'Moved · was' });
  await expect(moved).toHaveCount(1);
  await moved.getByTestId('appt-move').click();
  const mp = page.getByTestId('move-panel');
  await mp.getByTestId('move-mode-offer').click();
  await mp.getByTestId(`move-day-${dayIn(8)}`).click();
  const raoDay = mp.getByTestId('move-doctor-Dr. Rao');
  await raoDay.getByTestId('move-slot-10:00').click();
  await raoDay.getByTestId('move-slot-10:30').click();
  await expect(mp.getByTestId('offer-pick')).toHaveCount(2);
  await mp.getByTestId('move-reason').selectOption('doctor_unavailable');
  await mp.getByTestId('move-notify').uncheck();
  await page.screenshot({ path: 'test-results/v14-offer-panel.png', fullPage: true });
  await mp.getByTestId('offer-send').click();
  await expect(page.getByTestId('notice')).toContainText('2 choices sent');
  await expect(
    page.getByTestId(`appt-${s.patient_mrn}`).filter({ hasText: 'Waiting for patient' }),
  ).toHaveCount(1);
  const offer = (await pt.mine()).appointments.find((a) => a.id === appt.id)!.offer!;
  expect(offer.options).toHaveLength(2);
  expect((await pt.post(`/patient/offers/${offer.id}/choose`, { index: 1 })).status()).toBe(200);
  after = (await pt.mine()).appointments.find((a) => a.id === appt.id)!;
  expect(after.offer).toBeNull();
  expect(after.at).toBe(new Date(at(8, '10:30')).toISOString().replace('.000Z', 'Z'));

  // The patient books from the app; the desk books their preferred time.
  const booked = await pt.post('/patient/bookings', {
    doctor_id: null,
    choices: [
      { at: at(10, '09:30'), rank: 'preferred' },
      { at: at(11, '14:00'), rank: 'alternative' },
    ],
    purpose: 'follow_up',
  });
  expect(booked.status()).toBe(201);
  await page.reload();
  await page.getByTestId('nav-appointments').click();
  await page.getByTestId('tab-requests').click();
  const b = page.getByTestId(`inbox-${s.patient_mrn}`);
  await expect(b).toContainText('New booking');
  await expect(b).toContainText('Any doctor');
  await b.getByTestId('inbox-check').click();
  await expect(page.getByTestId('request-panel')).toContainText('Follow-up');
  await page.getByTestId('request-book').first().click();
  await expect(page.getByTestId('notice')).toContainText('appointment is now');
  expect((await pt.mine()).bookings).toEqual([]);

  // The desk cancels the new appointment with a reason.
  await page.getByTestId('tab-list').click();
  await page.getByTestId('range-30').click();
  const fresh = page.getByTestId(`appt-${s.patient_mrn}`).filter({ hasText: 'Booked in the app' });
  await fresh.getByTestId('appt-cancel').click();
  const dialog = page.getByTestId('cancel-dialog');
  await expect(dialog.getByTestId('cancel-confirm')).toBeDisabled();
  await dialog.getByTestId('cancel-reason-doctor_unavailable').click();
  await dialog.getByTestId('cancel-confirm').click();
  await expect(page.getByTestId('notice')).toContainText('is cancelled');
  await expect(
    page
      .getByTestId(`appt-${s.patient_mrn}`)
      .filter({ hasText: 'Cancelled · Doctor not available' }),
  ).toHaveCount(1);

  // The patient cancels the moved one; the desk sees it until "Mark as seen".
  expect(
    (
      await pt.post(`/patient/appointments/${appt.id}/cancel`, { reason: 'feeling_better' })
    ).status(),
  ).toBe(204);
  await page.getByTestId('tab-requests').click();
  await page.getByTestId('inbox-filter-cancelled').click();
  const c = page.getByTestId(`inbox-${s.patient_mrn}`);
  await expect(c).toContainText('Cancelled by patient');
  await expect(c).toContainText('Feeling better');
  await c.getByTestId('inbox-seen').click();
  await expect(page.getByTestId('notice')).toContainText('Marked as seen');
  await expect(page.getByTestId('inbox-empty')).toBeVisible();

  // History names every step.
  await page.getByTestId('tab-list').click();
  await page.getByTestId('range-30').click();
  const hist = page
    .getByTestId(`appt-${s.patient_mrn}`)
    .filter({ hasText: 'Cancelled by patient' });
  await hist.getByTestId('appt-history-btn').click();
  const h = page.getByTestId('appt-history');
  await expect(h).toContainText('Patient asked to change the date (3 times');
  await expect(h).toContainText('Patient chose an offered time');
  await expect(h).toContainText('Patient cancelled the appointment (Feeling better)');
  // v15: the desk's panels are dialogs over the list; Esc closes; unsaved choices ask first.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('history-dialog')).toHaveCount(0);
  await expect(page.getByTestId('appointments')).toBeVisible();
  const live = page
    .getByTestId(`appt-${s.patient_mrn}`)
    .filter({ hasText: 'Waiting for doctor' })
    .first();
  await live.getByTestId('appt-history-btn').click();
  await expect(page.getByTestId('history-dialog')).toBeVisible();
  await page.getByTestId('history-move').click();
  const dlg = page.getByTestId('move-panel');
  await expect(dlg).toBeVisible();
  await expect(page.getByTestId('history-dialog')).toHaveCount(0);
  await dlg.getByTestId('move-time').fill('10:00');
  page.once('dialog', (d) => void d.dismiss());
  await page.keyboard.press('Escape');
  await expect(dlg).toBeVisible(); // "Discard what you chose?" → No
  page.once('dialog', (d) => void d.accept());
  await dlg.getByTestId('dialog-close').click();
  await expect(dlg).toHaveCount(0);
  expect(errors).toEqual([]);
});
