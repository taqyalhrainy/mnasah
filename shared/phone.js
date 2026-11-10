import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

export function normalizePhone(value, country = 'JO') {
  if (typeof value !== 'string' || value.length > 60) return '';
  const input = value.trim().replace(/[٠-٩]/g, n => String(n.charCodeAt(0) - 1632)).replace(/[۰-۹]/g, n => String(n.charCodeAt(0) - 1776)).replace(/^00/, '+');
  if (!/^[+\d\s().-]+$/.test(input)) return '';
  const compatible = /^9627[789]\d{7}$/.test(input) ? `+${input}` : input;
  try { const phone = parsePhoneNumberFromString(compatible, { defaultCountry: country, extract: false }); return phone?.isValid() && !phone.ext ? phone.number : ''; } catch { return ''; }
}
