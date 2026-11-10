import { useMemo, useState } from 'react';
import { getCountries, getCountryCallingCode, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';
import { normalizePhone } from '../../../shared/phone.js';
import { t, usePreferences } from '../../i18n/preferences';

export function InternationalPhoneField({ initialValue = '', onChange, name = 'phone' }: { initialValue?: string; onChange?: (value: string) => void; name?: string }) {
  usePreferences();
  const initial = parsePhoneNumberFromString(initialValue, 'JO');
  const [country, setCountry] = useState<CountryCode>(initial?.country || 'JO');
  const [national, setNational] = useState(initial?.formatNational() || initialValue);
  const language = document.documentElement.lang === 'en' ? 'en' : 'ar';
  const countries = useMemo(() => {
    const display = new Intl.DisplayNames([language], { type: 'region' });
    return getCountries().map(code => ({ code, title: display.of(code) || code })).sort((a, b) => a.title.localeCompare(b.title, language));
  }, [language]);
  function combined(value: string, code: CountryCode) {
    const phone = parsePhoneNumberFromString(value.replace(/^00/, '+'), code);
    return phone?.number || (value ? `+${getCountryCallingCode(code)}${value.replace(/\D/g, '').replace(code === 'IT' ? /^$/ : /^0/, '')}` : '');
  }
  const raw = combined(national, country), valid = normalizePhone(raw);
  function edit(value: string, code = country) {
    const phone = parsePhoneNumberFromString(value.replace(/^00/, '+'), code);
    if (/^(\+|00)/.test(value) && phone?.country) { setCountry(phone.country); setNational(phone.formatNational()); }
    else setNational(value);
    onChange?.(combined(value, code));
  }
  return <div className="international-phone" role="group" aria-label={t('رقم الهاتف')}>
    <label><span>{t('الدولة ورمز الاتصال')}</span><select aria-label={t('الدولة ورمز الاتصال')} value={country} onChange={event => { const code = event.target.value as CountryCode; setCountry(code); onChange?.(combined(national, code)); }}>{countries.map(item => <option key={item.code} value={item.code}>{item.title} (+{getCountryCallingCode(item.code)})</option>)}</select></label>
    <label><span>{t('رقم الهاتف')}</span><input aria-label={t('رقم الهاتف')} type="tel" dir="ltr" inputMode="tel" autoComplete="tel-national" value={national} maxLength={40} required onChange={event => edit(event.target.value)} placeholder={country === 'JO' ? '079 123 4567' : country === 'SE' ? '070 123 45 67' : t('رقم الهاتف')} /></label>
    <input type="hidden" name={name} value={valid || raw} />
    <small className="phone-international-preview" dir="ltr">+{getCountryCallingCode(country)}{valid ? ` · ${valid}` : ''}</small>
  </div>;
}
