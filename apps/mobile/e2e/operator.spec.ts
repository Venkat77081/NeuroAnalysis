import { expect, test, type Page } from '@playwright/test';

/**
 * M13 acceptance (mock mode): a clinic phone is registered, the operator signs in with ID +
 * password, must replace the temporary password, records with the NCID from the hospital
 * connector and uploads. The phone then never opens patient mode, and it auto-locks.
 */
const URL = '/?mockSpeed=20';

async function registerAndSignIn(page: Page, url = URL) {
  await page.goto(url);
  await page.getByTestId('role-clinic').click();
  await expect(page.getByTestId('clinic-server')).toHaveValue('fake://api');
  await page.getByTestId('clinic-code').fill('WRONG-CODE');
  await page.getByTestId('clinic-register').click();
  await expect(page.getByRole('alert')).toContainText('not accepted');
  await page.getByTestId('clinic-code').fill('DEMO-SITE-1');
  await page.getByTestId('clinic-register').click();
  await page.getByTestId('op-id').fill('op-new');
  await page.getByTestId('op-password').fill('wrong-password');
  await page.getByTestId('op-sign-in').click();
  await expect(page.getByRole('alert')).toContainText('wrong');
  await page.getByTestId('op-password').fill('temp-pass-1234');
  await page.getByTestId('op-sign-in').click();
  // Temporary password: a new one before recording.
  await page.getByTestId('pw-current').fill('temp-pass-1234');
  await page.getByTestId('pw-next').fill('clinic-phone-77');
  await page.getByTestId('pw-repeat').fill('clinic-phone-77');
  await page.getByTestId('pw-save').click();
  await expect(page.getByTestId('choose-patient')).toBeVisible();
}

test('M13: operator sign-in, NCID from the connector, one take uploaded', async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await registerAndSignIn(page);
  await page.getByTestId('choose-patient').click();
  await page.getByTestId('patient-ref-input').fill('00012388');
  await page.getByTestId('save-patient').click();
  await expect(page.getByTestId('patient-ref')).toContainText('••••2388');
  const ncid = await page.evaluate(
    () =>
      (
        globalThis as unknown as { __ncMock: { fakeServer: { connectorMap: Map<string, string> } } }
      ).__ncMock.fakeServer.connectorMap.get('00012388') ?? null,
  );
  expect(ncid).toMatch(/^nc_[0-9a-f]{32}$/);
  await page.getByTestId('med-ON').click();
  await page.getByTestId('consent').check();
  await page.getByTestId('start-session').click();
  await page.getByTestId('set-up-camera').click();
  await page.getByTestId('record').click();
  await expect(page.getByTestId('verdict-card')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('accept').click();
  await page.getByTestId('end-early').click();
  await page.getByLabel('Out of time').check();
  await page.getByTestId('confirm-abort').click();
  await expect(page.getByTestId('upload-FT')).toHaveText('Uploaded', { timeout: 15_000 });
  await expect(page.getByTestId('upload-summary')).toContainText('All takes uploaded');
  await page.getByTestId('end-session').click();

  // Lock now; only the operator's password unlocks.
  await page.getByTestId('lock-now').click();
  await page.getByTestId('unlock-secret').fill('nope');
  await page.getByTestId('unlock').click();
  await expect(page.getByRole('alert')).toContainText('not right');
  await page.getByTestId('unlock-secret').fill('clinic-phone-77');
  await page.getByTestId('unlock').click();
  await expect(page.getByTestId('choose-patient')).toBeVisible();
  expect(errors).toEqual([]);
});

test('M13: a clinic phone cannot open patient mode', async ({ page }) => {
  test.setTimeout(60_000);
  await registerAndSignIn(page);
  // An invite link opened on this phone is refused.
  await page.evaluate(() =>
    globalThis.dispatchEvent(
      new CustomEvent('nc:invite', { detail: 'neurocapture://invite?t=abcdefghijkl' }),
    ),
  );
  await expect(page.getByTestId('clinic-blocked')).toBeVisible();
  await page.getByTestId('clinic-blocked-ok').click();
  // The mode is locked in CaptureKit: no way to switch, not even from JS.
  const r = await page.evaluate(async () => {
    const kit = (
      globalThis as unknown as {
        __ncMock: {
          lockAppMode(o: { mode: string }): Promise<unknown>;
          securePut(o: { key: string; json: string }): Promise<void>;
        };
      }
    ).__ncMock;
    const a = await kit.lockAppMode({ mode: 'patient' }).then(
      () => 'ok',
      (e: Error) => e.message,
    );
    const b = await kit.securePut({ key: 'sys.app_mode', json: '{}' }).then(
      () => 'ok',
      (e: Error) => e.message,
    );
    return [a, b];
  });
  expect(r).toEqual(['mode_locked', 'reserved key']);
  // After a restart: still a clinic phone (locked, no role choice).
  await page.reload();
  await expect(page.getByTestId('unlock-secret')).toBeVisible();
  await expect(page.getByTestId('role-patient')).toBeHidden();
  await page.goto(`${URL}&invite=neurocapture%3A%2F%2Finvite%3Ft%3Dabcdefghijkl`);
  await expect(page.getByTestId('clinic-blocked')).toBeVisible();
});

test('M13: an idle clinic phone locks itself', async ({ page }) => {
  test.setTimeout(60_000);
  await registerAndSignIn(page, `${URL}&lockAfterMs=1500`);
  await expect(page.getByTestId('unlock-secret')).toBeVisible({ timeout: 5_000 });
});

test('clinic queue: names live, start fills the session, "not recorded" with a reason', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL);
  type Fake = {
    addClinicRequest(mrn: string, name: string, o?: { tests?: string[]; doctor?: string }): string;
    requestInfo(id: string): { state: string; notDone: { reason: string } | null } | null;
  };
  const ids = await page.evaluate(() => {
    const f = (globalThis as unknown as { __ncMock: { fakeServer: Fake } }).__ncMock.fakeServer;
    return {
      asha: f.addClinicRequest('00012388', 'Asha Testpatient', { tests: ['FT', 'FA'] }),
      ravi: f.addClinicRequest('00012401', 'Ravi Samplename', { doctor: 'Dr. Iyer' }),
    };
  });
  // (Registration and sign-in as in the test above.)
  await page.getByTestId('role-clinic').click();
  await page.getByTestId('clinic-code').fill('DEMO-SITE-1');
  await page.getByTestId('clinic-register').click();
  await page.getByTestId('op-id').fill('op-07');
  await page.getByTestId('op-password').fill('2468');
  await page.getByTestId('op-sign-in').click();

  const queue = page.getByTestId('clinic-queue');
  await expect(queue.getByTestId('queue-item')).toHaveCount(2);
  await expect(queue).toContainText('Asha Testpatient');
  await expect(queue).toContainText('MRN 00012388 · Dr. Rao');
  await expect(queue).toContainText('Finger Tapping');
  await page.screenshot({ path: 'test-results/clinic-queue.png', fullPage: true });

  // Ravi did not come: not recorded, with a reason.
  const ravi = queue.getByTestId('queue-item').filter({ hasText: 'Ravi Samplename' });
  await ravi.getByTestId('queue-skip').click();
  await ravi.getByTestId('reason-did_not_attend').click();
  await expect(ravi.getByTestId('queue-state')).toHaveText('Not recorded: Did not attend');

  // Asha: the session is filled in; the operator confirms consent and records the two tests.
  await queue
    .getByTestId('queue-item')
    .filter({ hasText: 'Asha Testpatient' })
    .getByTestId('queue-start')
    .click();
  await expect(page.getByTestId('patient-ref')).toContainText('••••2388');
  await expect(page.getByTestId('start-session')).toBeDisabled(); // consent first
  await page.getByTestId('consent').check();
  await page.getByTestId('start-session').click();
  for (let i = 0; i < 2; i++) {
    await expect(page.getByTestId('test-of')).toHaveText(`Test ${i + 1} of 2`);
    await page.getByTestId('set-up-camera').click();
    await page.getByTestId('record').click();
    await expect(page.getByTestId('verdict-card')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('accept').click();
  }
  await expect(page.getByTestId('upload-summary')).toContainText('All takes uploaded', {
    timeout: 20_000,
  });
  const info = await page.evaluate((x) => {
    const f = (globalThis as unknown as { __ncMock: { fakeServer: Fake } }).__ncMock.fakeServer;
    return { asha: f.requestInfo(x.asha), ravi: f.requestInfo(x.ravi) };
  }, ids);
  expect(info.asha?.state).toBe('recorded'); // the session answered the doctor's request
  expect(info.ravi?.notDone?.reason).toBe('did_not_attend');
  expect(errors).toEqual([]);
});
