/**
 * Test panel for the fake (browser) mode only (user, 16 Nov 2026: testing on a phone has no browser
 * console). Plays the hospital: a patient invite, a doctor's record link, a clinic queue patient,
 * and "start again". Never shown with the real camera or in release builds.
 *
 * The fake server lives in this page's memory: reloading the page forgets it (registered phones,
 * changed passwords, joined patients), so "Start again" clears the app's stored data too.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MockCaptureKit } from '@neurocapture/capture-kit';
import { capture } from '../lib/capture.ts';
import { testHospitalInvite, testModeOn, testServer } from '../lib/testmode.ts';
import { hospitalsOf } from '../lib/hospitals.ts';
import { useApp } from '../app/AppContext.tsx';
import { Button, Sheet } from '../ui/kit.tsx';

const NAMES = ['Asha Testpatient', 'Ravi Samplename', 'Meena Demo', 'Arjun Example'];

export const TEST_PANEL =
  import.meta.env.VITE_PRODUCTION !== '1' &&
  (capture.kit instanceof MockCaptureKit || testModeOn());

/** The pretend hospital: the browser's fake server, or the debug APK's test mode (decision 041). */
function pretendHospital() {
  return capture.kit instanceof MockCaptureKit ? capture.kit.fakeServer : testServer();
}

export function TestPanel() {
  const { t } = useTranslation();
  const { resetApp, settings } = useApp();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  if (!TEST_PANEL) return null;
  const fake = pretendHospital();

  const invite = () => {
    const l = testHospitalInvite(fake, hospitalsOf(settings).length);
    setLink(l);
    setNote(t('testPanel.inviteDone'));
    globalThis.dispatchEvent(new CustomEvent('nc:invite', { detail: l }));
  };
  const homeLink = () => {
    const ncids = fake.joinedNcids();
    if (ncids.length === 0) return setNote(t('testPanel.joinFirst'));
    fake.sendRequest(ncids[ncids.length - 1]!);
    setNote(t('testPanel.homeDone'));
  };
  const clinicRecording = () => {
    const ncids = fake.joinedNcids();
    if (ncids.length === 0) return setNote(t('testPanel.joinFirst'));
    fake.sendRequest(ncids[ncids.length - 1]!, {
      place: 'clinic',
      tests: ['FT', 'FTF', 'FR', 'SAW', 'FA'],
    });
    setNote(t('testMode.clinicRecordingDone'));
  };
  /** v13: a booked appointment the patient can ask to change; then the desk's answer. */
  const appointment = () => {
    const ncids = fake.joinedNcids();
    if (ncids.length === 0) return setNote(t('testPanel.joinFirst'));
    fake.addAppointment(ncids[ncids.length - 1]!, { days: 5 });
    setNote(t('testPanel.appointmentDone'));
  };
  /** v14: the desk books the patient's first time (open change or booking request). */
  const deskAnswers = () => {
    const r = [...fake.appts.requests].reverse().find((x) => x.status === 'open');
    if (!r) return setNote(t('testPanel.noChangeAsked'));
    fake.appts.deskBook(r.id, r.kind === 'change' ? 'Dr. Menon' : undefined);
    setNote(t('testPanel.deskMoved'));
  };
  /** v14: the desk offers 3 times for the latest booked appointment. */
  const deskOffers = () => {
    const a = [...fake.appts.appointments].reverse().find((x) => x.status === 'booked');
    if (!a) return setNote(t('testPanel.joinFirst'));
    fake.appts.deskOffer({ appointmentId: a.id }, 3, true);
    setNote(t('testPanel.deskOffered'));
  };
  const clinic = () => {
    const mrn = String(10_000_000 + Math.floor(Math.random() * 89_999_999));
    const name = NAMES[Math.floor(Math.random() * NAMES.length)]!;
    fake.addClinicRequest(mrn, name, { inHours: 1 });
    setNote(t('testPanel.clinicDone', { name, mrn }));
  };
  /** v11: wipe the app but keep the pretend hospital, as after reinstalling (sign in again). */
  const reinstall = () => {
    void resetApp().then(() => {
      setOpen(false);
      setNote(null);
    });
  };
  const startAgain = () => {
    if (testModeOn()) {
      void resetApp(); // test mode: wipe the app (stays in test mode)
      return;
    }
    try {
      globalThis.localStorage?.clear();
      globalThis.sessionStorage?.clear();
    } catch {
      /* nothing stored */
    }
    globalThis.location.reload();
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed top-1/3 right-0 z-50 min-h-12 min-w-12 rounded-l-xl bg-cam/75 px-3 text-[13px] font-semibold text-white"
        data-testid="test-panel-open"
      >
        {t('testPanel.open')}
      </button>
      {testModeOn() && (
        <div
          className="fixed top-0 right-0 left-0 z-40 bg-[#6B2FB3] px-4 py-1 text-center text-[11px] font-bold text-white"
          data-testid="test-mode-banner"
        >
          {t('testMode.banner')}
        </div>
      )}
      {open && (
        <Sheet title={t('testPanel.title')} onClose={() => setOpen(false)} testId="test-panel">
          <p className="m-0 text-[13px] leading-[19px] text-sub">{t('testPanel.signIns')}</p>
          <Button variant="secondary" onClick={invite} data-testid="tp-invite">
            {t('testPanel.invite')}
          </Button>
          <Button variant="secondary" onClick={homeLink} data-testid="tp-home-link">
            {t('testPanel.homeLink')}
          </Button>
          <Button variant="secondary" onClick={clinicRecording} data-testid="tp-clinic-recording">
            {t('testMode.clinicRecording')}
          </Button>
          <Button variant="secondary" onClick={appointment} data-testid="tp-appointment">
            {t('testPanel.appointment')}
          </Button>
          <Button variant="secondary" onClick={deskAnswers} data-testid="tp-desk-moves">
            {t('testPanel.deskMoves')}
          </Button>
          <Button variant="secondary" onClick={deskOffers} data-testid="tp-desk-offers">
            {t('testPanel.deskOffers')}
          </Button>
          <Button variant="secondary" onClick={clinic} data-testid="tp-clinic">
            {t('testPanel.clinic')}
          </Button>
          {note && (
            <p className="m-0 rounded-xl bg-ok-soft px-3 py-2 text-[13px]" data-testid="tp-note">
              {note}
            </p>
          )}
          {link && (
            <code className="overflow-x-auto rounded-lg bg-ground px-2 py-1 text-[12px]">
              {link}
            </code>
          )}
          <p className="m-0 text-[12px] leading-[18px] text-muted">{t('testPanel.memory')}</p>
          <Button variant="secondary" onClick={reinstall} data-testid="tp-reinstall">
            {t('testPanel.reinstall')}
          </Button>
          <Button variant="ghost" onClick={startAgain} data-testid="tp-start-again">
            {t('testPanel.startAgain')}
          </Button>
        </Sheet>
      )}
    </>
  );
}
