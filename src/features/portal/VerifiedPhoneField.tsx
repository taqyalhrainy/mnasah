import { Phone } from 'lucide-react';
import { t } from '../../i18n/preferences';

export function VerifiedPhoneField({ initialValue = '' }: { initialValue?: string }) {
  return <label>{t('رقم الهاتف')}
    <span className="field-with-icon"><Phone size={17} /><input name="phone" dir="ltr" inputMode="tel" autoComplete="tel" defaultValue={initialValue} placeholder="079 123 4567" required /></span>
    <small>{t('يمكنك تعديل رقم التواصل وحفظه مباشرة.')}</small>
  </label>;
}
