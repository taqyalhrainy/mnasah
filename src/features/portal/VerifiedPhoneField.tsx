import { InternationalPhoneField } from '../auth/InternationalPhoneField';
import { t } from '../../i18n/preferences';

export function VerifiedPhoneField({ initialValue = '' }: { initialValue?: string }) {
  return <div className="profile-phone-field">
    <InternationalPhoneField initialValue={initialValue} />
    <small>{t('يمكنك تعديل رقم التواصل وحفظه مباشرة.')}</small>
  </div>;
}
