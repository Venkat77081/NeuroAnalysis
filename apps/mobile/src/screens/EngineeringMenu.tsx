import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApp } from '../app/AppContext.tsx';
import { Button, Sheet } from '../ui/kit.tsx';

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
  const { settings, saveSettings } = useApp();
  const [operatorId, setOperatorId] = useState(settings.operatorId);
  const [language, setLanguage] = useState(settings.language);
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
      <Button
        disabled={!ok}
        onClick={() => {
          void saveSettings({ operatorId, language });
          onClose();
        }}
        data-testid="save-settings"
      >
        {t('session.engineering.save')}
      </Button>
      {ENGINEERING_TOOLS && (
        <Button variant="secondary" onClick={onDeviceCheck} data-testid="open-device-check">
          {t('session.engineering.deviceCheck')}
        </Button>
      )}
    </Sheet>
  );
}
