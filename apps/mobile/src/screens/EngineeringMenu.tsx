import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApp } from '../app/AppContext.tsx';
import { Button, Sheet } from '../ui/kit.tsx';
import { capture } from '../lib/capture.ts';
import { setTestMode, TEST_MODE_AVAILABLE, testModeOn } from '../lib/testmode.ts';
import { DeviceCheck } from './modes/DeviceCheck.tsx';
import {
  gateAdvisory,
  landmarkOverlayEnabled,
  setGateAdvisory,
  setLandmarkOverlay,
} from '../lib/debug-flags.ts';

/** Engineering tools are hidden from production builds (VITE_PRODUCTION=1). */
export const ENGINEERING_TOOLS = import.meta.env.VITE_PRODUCTION !== '1';
/**
 * Decision 041 (user, 17 Nov 2026: "for other debug tests only check the frame rate"): the menu
 * offers the camera frame-rate check and test mode. The older engineering tools (operator ID,
 * landmark overlay, record without the gate, capture/tracking tests, device tiers) stay for
 * developers only in the browser with `?tools=1`.
 */
export const DEV_TOOLS =
  ENGINEERING_TOOLS && new URLSearchParams(globalThis.location?.search ?? '').has('tools');

export function EngineeringMenu({
  onClose,
  onDeviceCheck,
}: {
  onClose: () => void;
  /** The developers' device tests (`?tools=1` in the browser only). */
  onDeviceCheck?: () => void;
}) {
  const { t } = useTranslation();
  const { settings, saveSettings, config, resetApp } = useApp();
  const [fpsCheck, setFpsCheck] = useState(false);
  const [operatorId, setOperatorId] = useState(settings.operatorId);
  const [language, setLanguage] = useState(settings.language);
  const [minFps, setMinFps] = useState<number | null>(settings.minFps);
  const fpsOptions = config.session.minFpsOptions ?? [];
  const [landmarks, setLandmarks] = useState(landmarkOverlayEnabled);
  const [advisory, setAdvisory] = useState(gateAdvisory);
  const ok = /^[A-Za-z0-9-]{2,20}$/.test(operatorId);
  return (
    <Sheet title={t('session.engineering.title')} onClose={onClose} testId="engineering-menu">
      {DEV_TOOLS && (
        <label className="flex flex-col gap-1 text-sm">
          {t('session.engineering.operatorId')}
          <input
            value={operatorId}
            onChange={(e) => setOperatorId(e.target.value.toUpperCase())}
            className="h-12 rounded-xl border border-[#C9CFD8] px-3 text-[15px]"
            data-testid="operator-input"
          />
        </label>
      )}
      <label className="flex flex-col gap-1 text-sm">
        {t('session.engineering.language')}
        <select
          value={language}
          onChange={(e) => setLanguage(e.target.value as 'en' | 'hi')}
          className="h-12 rounded-xl border border-[#C9CFD8] bg-white px-3 text-[15px]"
          data-testid="language-select"
        >
          <option value="en">English</option>
          <option value="hi">हिन्दी</option>
        </select>
      </label>
      {fpsOptions.length > 0 && (
        <label className="flex flex-col gap-1 text-sm">
          {t('session.engineering.minFps')}
          <select
            value={minFps ?? ''}
            onChange={(e) => setMinFps(e.target.value === '' ? null : Number(e.target.value))}
            className="h-12 rounded-xl border border-[#C9CFD8] bg-white px-3 text-[15px]"
            data-testid="min-fps-select"
          >
            <option value="">
              {t('session.engineering.minFpsDefault', {
                fps: Math.min(...[...config.tests.values()].map((c) => c.camera.minEffectiveFps)),
              })}
            </option>
            {fpsOptions.map((f) => (
              <option key={f} value={f}>
                {t('session.engineering.minFpsOption', { fps: f })}
              </option>
            ))}
          </select>
        </label>
      )}
      <Button
        disabled={!ok}
        onClick={() => {
          void saveSettings({ ...settings, operatorId, language, minFps });
          onClose();
        }}
        data-testid="save-settings"
      >
        {t('session.engineering.save')}
      </Button>
      {DEV_TOOLS && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={landmarks}
            onChange={(e) => {
              setLandmarks(e.target.checked);
              setLandmarkOverlay(e.target.checked);
            }}
            data-testid="landmarks-toggle"
          />
          {t('session.engineering.landmarks')}
        </label>
      )}
      {DEV_TOOLS && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={advisory}
            onChange={(e) => {
              setAdvisory(e.target.checked);
              setGateAdvisory(e.target.checked);
            }}
            data-testid="advisory-toggle"
          />
          {t('session.engineering.gateAdvisory')}
        </label>
      )}
      <span className="mt-2 text-xs font-bold tracking-wide text-muted uppercase">
        {t('session.engineering.tests')}
      </span>
      {fpsCheck ? (
        <DeviceCheck who="check" onResult={() => {}} />
      ) : (
        <Button variant="secondary" onClick={() => setFpsCheck(true)} data-testid="open-fps-check">
          {t('testMode.fpsCheck')}
          <span className="block text-[12px] font-normal">{t('testMode.fpsCheckHint')}</span>
        </Button>
      )}
      {TEST_MODE_AVAILABLE &&
        (capture.implementation === 'mock' ? (
          <p className="m-0 text-[13px] text-muted">{t('testMode.browser')}</p>
        ) : (
          <label className="flex items-start gap-3 rounded-2xl border-2 border-[#6B2FB3] bg-white px-4 py-3 text-sm">
            <input
              type="checkbox"
              checked={testModeOn()}
              onChange={(e) => {
                const on = e.target.checked;
                if (!globalThis.confirm(t(on ? 'testMode.confirmOn' : 'testMode.confirmOff')))
                  return;
                void resetApp().then(() => {
                  setTestMode(on);
                  globalThis.location.reload();
                });
              }}
              className="mt-0.5 size-6 accent-[#6B2FB3]"
              data-testid="test-mode-toggle"
            />
            <span className="flex flex-col">
              <span className="font-semibold">{t('testMode.toggle')}</span>
              <span className="text-xs text-muted">{t('testMode.toggleHint')}</span>
            </span>
          </label>
        ))}
      {DEV_TOOLS && onDeviceCheck && (
        <Button variant="secondary" onClick={onDeviceCheck} data-testid="open-device-check">
          {t('session.engineering.deviceCheck')}
        </Button>
      )}
    </Sheet>
  );
}
