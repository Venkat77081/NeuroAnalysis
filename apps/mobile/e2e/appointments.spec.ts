import { expect, test } from '@playwright/test';
import { signUpPatient } from './helpers.ts';

/**
 * v13 (decision 045): the patient asks to change an appointment's date (days + time of day,
 * reason from a list), can withdraw, and sees the hospital's answer. Too close to the appointment,
 * the app says to call instead.
 */
type Fake = {
  issueInvite(): string;
  joinedNcids(): string[];
  addAppointment(ncid: string, opts?: { days?: number; doctor?: string }): string;
  answerChange(id: string, a: { move?: { doctor?: string }; decline?: string }): void;
};
type W = { __ncMock: { fakeServer: Fake } };

test('patient asks to change an appointment; the hospital moves it', async ({ page }) => {
  await page.goto('/?mockSpeed=20');
  await page.getByTestId('role-patient').click();
  await signUpPatient(page);
  const link = await page.evaluate(() =>
    (globalThis as unknown as W).__ncMock.fakeServer.issueInvite(),
  );
  await page.getByTestId('invite-text').fill(link);
  await page.getByTestId('invite-continue').click();
  await page.getByTestId('invite-accept').click();
  const ids = await page.evaluate(() => {
    const f = (globalThis as unknown as W).__ncMock.fakeServer;
    const ncid = f.joinedNcids()[0]!;
    return {
      later: f.addAppointment(ncid, { days: 6, doctor: 'Dr. Rao' }),
      soon: f.addAppointment(ncid, { days: 0.5, doctor: 'Dr. Iyer' }),
    };
  });
  await page.getByTestId('hospital-card').click();
  const cards = page.getByTestId('appointment-card');
  await expect(cards).toHaveCount(2);
  // Within 24 hours: no button, call instead.
  await expect(cards.first()).toContainText('Dr. Iyer');
  await expect(cards.first().getByTestId('appointment-ask')).toHaveCount(0);
  await expect(cards.first().getByTestId('appointment-too-late')).toContainText('Please call');

  // Ask: two days, morning, a reason.
  const later = cards.nth(1);
  await expect(later.getByTestId('appointment-badge')).toHaveText('Booked');
  await later.getByTestId('appointment-ask').click();
  const form = page.getByTestId('change-form');
  await expect(form).toContainText('Dr. Rao');
  await expect(page.getByTestId('change-send')).toBeDisabled();
  const dayChips = form.locator('[data-testid^="change-day-"]');
  await expect(dayChips).toHaveCount(14);
  await dayChips.nth(3).click();
  await dayChips.nth(5).click();
  await page.getByTestId('change-part-morning').click();
  await page.getByTestId('change-reason-unwell').click();
  await expect(form).toContainText('your appointment stays on');
  await page.screenshot({ path: 'test-results/v13-ask-change.png', fullPage: true });
  await page.getByTestId('change-send').click();
  await expect(later.getByTestId('appointment-badge')).toHaveText('Change asked');
  await expect(later.getByTestId('appointment-asked')).toContainText('morning');

  // Withdraw, ask again, then the desk moves it to the first chosen day with another doctor.
  await later.getByTestId('appointment-withdraw').click();
  await expect(later.getByTestId('appointment-badge')).toHaveText('Booked');
  await later.getByTestId('appointment-ask').click();
  await form.locator('[data-testid^="change-day-"]').nth(2).click();
  await page.getByTestId('change-part-any').click();
  await page.getByTestId('change-send').click();
  await expect(later.getByTestId('appointment-badge')).toHaveText('Change asked');
  await page.evaluate(
    (id) =>
      (globalThis as unknown as W).__ncMock.fakeServer.answerChange(id, {
        move: { doctor: 'Dr. Menon' },
      }),
    ids.later,
  );
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByTestId('hospital-card').click();
  const moved = page.getByTestId('appointment-card').filter({ hasText: 'Dr. Menon' });
  await expect(moved.getByTestId('appointment-badge')).toHaveText('Changed');
  await expect(moved.getByTestId('appointment-moved')).toContainText('Moved as you asked');
  await expect(moved.getByTestId('appointment-moved')).toContainText('was Dr. Rao');
});
