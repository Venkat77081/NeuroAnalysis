import { expect, test, type Page } from '@playwright/test';
import { pickDay, section, signUpPatient } from './helpers.ts';

/**
 * v13/v14 (decisions 045, 046) in the patient app: ask to change an appointment with exact free
 * times; answer the hospital's offer (choose a time, or none work and cancel); cancel any time;
 * book a new appointment (doctor, preferred and alternative dates with times, purpose).
 */
type Appts = {
  requests: { id: string; kind: string; status: string; choices: { at: string; rank: string }[] }[];
  appointments: { id: string; status: string; at: string; doctor_name: string }[];
  deskBook(id: string, doctor?: string): void;
  deskOffer(t: { appointmentId?: string; requestId?: string }, n?: number, keep?: boolean): string;
};
type Fake = {
  issueInvite(): string;
  joinedNcids(): string[];
  addAppointment(ncid: string, opts?: { days?: number; doctor?: string }): string;
  appts: Appts;
};
type W = { __ncMock: { fakeServer: Fake } };
const fake = <T>(page: Page, fn: (f: Fake, arg: string) => T, arg = '') =>
  page.evaluate(
    ([src, a]) =>
      new Function('f', 'a', `return (${src})(f, a)`)(
        (globalThis as unknown as W).__ncMock.fakeServer,
        a,
      ) as T,
    [fn.toString(), arg] as const,
  );

async function joined(page: Page) {
  await page.goto('/?mockSpeed=20');
  await page.getByTestId('role-patient').click();
  await signUpPatient(page);
  const link = await fake(page, (f) => f.issueInvite());
  await page.getByTestId('invite-text').fill(link);
  await page.getByTestId('invite-continue').click();
  await page.getByTestId('invite-accept').click();
}
/** Back to the hospitals list, then this hospital's appointments again (fresh from the server). */
const reopen = async (page: Page) => {
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByTestId('hospital-card').click();
  await section(page, 'appointments');
};
const openAppointments = async (page: Page) => {
  await page.getByTestId('hospital-card').click();
  await section(page, 'appointments');
};

test('change with exact times; the desk books one; withdraw; too late', async ({ page }) => {
  await joined(page);
  await fake(page, (f) => {
    const n = f.joinedNcids()[0]!;
    f.addAppointment(n, { days: 6, doctor: 'Dr. Rao' });
    f.addAppointment(n, { days: 0.5, doctor: 'Dr. Iyer' });
  });
  await openAppointments(page);
  const cards = page.getByTestId('appointment-card');
  await expect(cards).toHaveCount(2);
  await expect(cards.first().getByTestId('appointment-ask')).toHaveCount(0);
  await expect(cards.first().getByTestId('appointment-too-late')).toContainText('Please call');

  const later = cards.nth(1);
  await later.getByTestId('appointment-ask').click();
  const form = page.getByTestId('change-form');
  await expect(page.getByTestId('change-send')).toBeDisabled();
  await expect(form.getByTestId('picker-calendar')).toBeVisible();
  await pickDay(page, 4); // preferred 1
  await page.getByTestId('picker-time-0-10:00').click();
  await page.getByTestId('picker-time-0-10:30').click();
  await page.getByTestId('picker-rank-alternative').click();
  await pickDay(page, 6); // alternative 1
  await page.getByTestId('picker-time-1-11:00').click();
  await page.getByTestId('change-reason-unwell').click();
  await expect(page.getByTestId('change-send')).toHaveText('Send request (3 times)');
  await page.screenshot({ path: 'test-results/v17-calendar.png', fullPage: true });
  await page.screenshot({ path: 'test-results/v14-ask-change.png', fullPage: true });
  await page.getByTestId('change-send').click();
  await expect(later.getByTestId('appointment-badge')).toHaveText('Change asked');
  const req = await fake(page, (f) => f.appts.requests[0]!);
  expect(req.choices.map((c) => c.rank)).toEqual(['preferred', 'preferred', 'alternative']);

  // Withdraw, ask again, then the desk books the first time with Dr. Menon.
  await later.getByTestId('appointment-withdraw').click();
  await expect(later.getByTestId('appointment-badge')).toHaveText('Booked');
  await later.getByTestId('appointment-ask').click();
  await pickDay(page, 3);
  await page.getByTestId('picker-time-0-09:30').click();
  await page.getByTestId('change-send').click();
  await fake(page, (f) => f.appts.deskBook(f.appts.requests[1]!.id, 'Dr. Menon'));
  await reopen(page);
  const moved = page.getByTestId('appointment-card').filter({ hasText: 'Dr. Menon' });
  await expect(moved.getByTestId('appointment-badge')).toHaveText('Changed');
  await expect(moved.getByTestId('appointment-moved')).toContainText('was Dr. Rao');
  await expect(moved.getByTestId('appointment-waiting-tests')).toBeVisible();
});

test('the hospital offers times: choose one; none work and cancel', async ({ page }) => {
  await joined(page);
  const id = await fake(page, (f) => f.addAppointment(f.joinedNcids()[0]!, { days: 6 }));
  await fake(page, (f, a) => f.appts.deskOffer({ appointmentId: a }, 3), id);
  await page.getByTestId('hospital-card').click();
  // The menu says what needs doing now and opens the appointments.
  await expect(page.getByTestId('menu-appointments-count')).toHaveText('1');
  await page.getByTestId('needs-offer').getByRole('button').click();
  const card = page.getByTestId('appointment-card');
  await expect(card.getByTestId('appointment-badge')).toHaveText('Choose a new time');
  await expect(card.getByTestId('appointment-ask')).toHaveCount(0);
  await card.getByTestId('appointment-offer-open').click();
  await expect(page.getByTestId('offer-view')).toContainText('needs to move your appointment');
  await expect(page.getByTestId('offer-option-0')).toContainText('another doctor');
  await expect(page.getByTestId('offer-choose')).toBeDisabled();
  await page.getByTestId('offer-option-1').click();
  await page.screenshot({ path: 'test-results/v14-offer.png', fullPage: true });
  await page.getByTestId('offer-choose').click();
  await expect(card.getByTestId('appointment-badge')).toHaveText('Changed');
  await expect(card.getByTestId('appointment-moved')).toContainText('Moved as you asked');

  // A second offer: none work → cancel with a reason.
  await fake(page, (f, a) => f.appts.deskOffer({ appointmentId: a }, 2), id);
  await reopen(page);
  await page.getByTestId('appointment-offer-open').click();
  await page.getByTestId('offer-none-open').click();
  await expect(page.getByTestId('offer-keep')).toHaveCount(0); // the current date is gone
  await page.getByTestId('offer-cancel-reason-cant_make_it').click();
  await page.getByTestId('offer-decline').click();
  const c = page.getByTestId('appointment-card');
  await expect(c.getByTestId('appointment-badge')).toHaveText('Cancelled');
  await expect(c.getByTestId('appointment-cancelled')).toHaveText(
    'You cancelled this appointment.',
  );
  await expect(c.getByTestId('appointment-cancel')).toHaveCount(0);

  // v17: Appointment history lists it as cancelled by the patient.
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByTestId('needs-offer')).toHaveCount(0); // the menu is fresh
  await page.screenshot({ path: 'test-results/v17-menu.png', fullPage: true });
  await section(page, 'history');
  await expect(page.getByTestId('history-appt').first()).toContainText('Cancelled by you');
  await page.getByTestId('history-filter-past').click();
  await expect(page.getByTestId('history-none')).toBeVisible();
});

test('cancel any time; book an appointment and choose an offered time', async ({ page }) => {
  await joined(page);
  await fake(page, (f) => f.addAppointment(f.joinedNcids()[0]!, { days: 0.3 }));
  await openAppointments(page);
  // Within the change cut-off: no change, but cancelling is always possible.
  await page.getByTestId('appointment-cancel').click();
  await page.getByTestId('cancel-reason-feeling_better').click();
  await page.getByTestId('cancel-confirm').click();
  await expect(page.getByTestId('appointment-badge').first()).toHaveText('Cancelled');

  // Book: doctor → dates and times → purpose → send.
  await page.getByRole('button', { name: 'Back' }).click();
  await section(page, 'book');
  await expect(page.getByTestId('book-next')).toBeDisabled();
  await page.getByTestId('book-doctor-drrao').click();
  await page.getByTestId('book-next').click();
  await pickDay(page, 3);
  await page.getByTestId('picker-time-0-09:30').click();
  await page.getByTestId('picker-time-0-10:00').click();
  await page.getByTestId('picker-time-0-10:30').click(); // only 2 per date
  await pickDay(page, 5);
  await page.getByTestId('picker-time-1-11:00').click();
  await page.getByTestId('picker-rank-alternative').click();
  await pickDay(page, 7);
  await page.getByTestId('picker-time-2-12:00').click();
  await pickDay(page, 8);
  await pickDay(page, 9); // 2 alternatives at most
  await expect(page.getByRole('status')).toContainText('2 alternative dates');
  await expect(page.getByTestId('picker-block')).toHaveCount(4);
  await page.screenshot({ path: 'test-results/v14-book.png', fullPage: true });
  await page.getByTestId('book-next').click();
  await expect(page.getByTestId('book-review')).toContainText('Dr. Rao');
  await page.getByTestId('book-purpose-follow_up').click();
  await page.getByTestId('book-send').click();
  const booking = page.getByTestId('booking-card');
  await expect(booking.getByTestId('appointment-badge')).toHaveText('Waiting');
  await expect(booking).toContainText('4 times');
  const r = await fake(page, (f) => f.appts.requests.find((x) => x.kind === 'booking')!);
  expect(r.choices).toHaveLength(4);

  // The desk offers other times; the patient takes one: a new appointment.
  await fake(page, (f, a) => f.appts.deskOffer({ requestId: a }, 2), r.id);
  await reopen(page);
  await page.getByTestId('booking-offer-open').click();
  await expect(page.getByTestId('offer-view')).toContainText('offers these times');
  await page.getByTestId('offer-option-0').click();
  await page.getByTestId('offer-choose').click();
  await expect(page.getByTestId('booking-card')).toHaveCount(0);
  await expect(
    page
      .getByTestId('appointment-card')
      .filter({ hasText: 'Dr. Menon' })
      .getByTestId('appointment-badge'),
  ).toHaveText('Booked');
});
