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
import { Button, Sheet } from '../ui/kit.tsx';

const NAMES = ['Asha Testpatient', 'Ravi Samplename', 'Meena Demo', 'Arjun Example'];

export const TEST_PANEL =
  import.meta.env.VITE_PRODUCTION !== '1' && capture.kit instanceof MockCaptureKit;

export function TestPanel() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  if (!TEST_PANEL) return null;
  const fake = (capture.kit as MockCaptureKit).fakeServer;

  const invite = () => {
    const l = fake.issueInvite();
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
  const clinic = () => {
    const mrn = String(10_000_000 + Math.floor(Math.random() * 89_999_999));
    const name = NAMES[Math.floor(Math.random() * NAMES.length)]!;
    fake.addClinicRequest(mrn, name, { inHours: 1 });
    setNote(t('testPanel.clinicDone', { name, mrn }));
  };
  const startAgain = () => {
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
        className="fixed top-1/3 right-0 z-50 min-h-12 min-w-12 rounded-l-xl bg-[#14181F]/75 px-3 text-[13px] font-semibold text-white"
        data-testid="test-panel-open"
      >
        {t('testPanel.open')}
      </button>
      {open && (
        <Sheet title={t('testPanel.title')} onClose={() => setOpen(false)} testId="test-panel">
          <p className="m-0 text-[13px] leading-[19px] text-[#3D4552]">{t('testPanel.signIns')}</p>
          <Button variant="secondary" onClick={invite} data-testid="tp-invite">
            {t('testPanel.invite')}
          </Button>
          <Button variant="secondary" onClick={homeLink} data-testid="tp-home-link">
            {t('testPanel.homeLink')}
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
          <Button variant="ghost" onClick={startAgain} data-testid="tp-start-again">
            {t('testPanel.startAgain')}
          </Button>
        </Sheet>
      )}
    </>
  );
}
