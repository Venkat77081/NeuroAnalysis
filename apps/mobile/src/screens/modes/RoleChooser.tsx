import { useTranslation } from 'react-i18next';
import { Screen } from './Common.tsx';

/** First run (M13): patient app or clinic phone. The choice is locked natively once set up. */
export function RoleChooser({ onPick }: { onPick: (mode: 'patient' | 'clinic') => void }) {
  const { t } = useTranslation();
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
      {option('patient')}
      {option('clinic')}
      <p className="text-[13px] leading-5 text-muted">{t('modes.role.note')}</p>
    </Screen>
  );
}
