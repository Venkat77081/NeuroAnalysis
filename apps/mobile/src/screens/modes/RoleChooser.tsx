import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EngineeringMenu } from '../EngineeringMenu.tsx';
import { Logo } from '../session/SessionHome.tsx';
import { Screen } from './Common.tsx';

/**
 * First run (M13): patient app or clinic phone. The choice is locked natively once set up.
 * Long-pressing the logo opens the settings menu (language, frame-rate limit, camera check and,
 * in debug builds, test mode; decision 041), so test mode can be switched on before set-up.
 */
export function RoleChooser({ onPick }: { onPick: (mode: 'patient' | 'clinic') => void }) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState(false);
  const option = (mode: 'patient' | 'clinic') => (
    <button
      type="button"
      onClick={() => onPick(mode)}
      data-testid={`role-${mode}`}
      className="flex min-h-[88px] flex-col items-start gap-1 rounded-2xl border border-line bg-white px-4 py-4 text-left"
    >
      <span className="text-[18px] font-bold">{t(`modes.role.${mode}`)}</span>
      <span className="text-[14px] leading-5 text-muted">{t(`modes.role.${mode}Hint`)}</span>
    </button>
  );
  return (
    <Screen title={t('modes.role.title')}>
      <div className="-mb-2 flex items-center gap-2 text-[14px] font-semibold text-muted">
        <Logo onLongPress={() => setMenu(true)} />
        {t('app.name')}
      </div>
      {option('patient')}
      {option('clinic')}
      <p className="text-[13px] leading-5 text-muted">{t('modes.role.note')}</p>
      {menu && <EngineeringMenu onClose={() => setMenu(false)} />}
    </Screen>
  );
}
