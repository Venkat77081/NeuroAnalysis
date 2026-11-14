import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApp } from '../app/AppContext.tsx';
import { Button, Sheet } from '../ui/kit.tsx';
import {
  gateAdvisory,
  landmarkOverlayEnabled,
  setGateAdvisory,
  setLandmarkOverlay,
} from '../lib/debug-flags.ts';

/** Engineering tools are hidden from production builds (VITE_PRODUCTION=1). */
export const ENGINEERING_TOOLS = import.meta.env.VITE_PRODUCTION !== '1';

export function EngineeringMenu({
  onClose,
  onDeviceCheck,
}: {
  onClose: () => void;
  onDeviceCheck: () => void;
}) {
  const { t } = useTranslation();
  const { settings, saveSettings, config } = useApp();
  const [operatorId, setOperatorId] = useState(settings.operatorId);
  const [language, setLanguage] = useState(settings.language);
  const [minFps, setMinFps] = useState<number | null>(settings.minFps);
  const fpsOptions = config.session.minFpsOptions ?? [];
  const [landmarks, setLandmarks] = useState(landmarkOverlayEnabled);
  const [advisory, setAdvisory] = useState(gateAdvisory);
  const ok = /^[A-Za-z0-9-]{2,20}$/.test(operatorId);
  return (
    <Sheet title={t('session.engineering.title')} onClose={onClose} testId="engineering-menu">
      <label className="flex flex-col gap-1 text-sm">
        {t('session.engineering.operatorId')}
        <input
          value={operatorId}
          onChange={(e) => setOperatorId(e.target.value.toUpperCase())}
          className="h-12 rounded-xl border border-[#C9CFD8] px-3 text-[15px]"
          data-testid="operator-input"
        />
      </label>
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
          void saveSettings({ operatorId, language, minFps });
          onClose();
        }}
        data-testid="save-settings"
      >
        {t('session.engineering.save')}
      </Button>
      {ENGINEERING_TOOLS && (
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
      {ENGINEERING_TOOLS && (
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
      {ENGINEERING_TOOLS && (
        <Button variant="secondary" onClick={onDeviceCheck} data-testid="open-device-check">
          {t('session.engineering.deviceCheck')}
        </Button>
      )}
    </Sheet>
  );
}
