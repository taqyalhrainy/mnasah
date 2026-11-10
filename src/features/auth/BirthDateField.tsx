import { useState } from 'react';
import { t } from '../../i18n/preferences';

export function BirthDateField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [parts, setParts] = useState(() => { const [year = '', month = '', day = ''] = value.split('-'); return { year, month, day }; });
  const now = new Date().getFullYear();
  const days = parts.month ? new Date(Number(parts.year) || 2000, Number(parts.month), 0).getDate() : 31;
  function change(key: keyof typeof parts, value: string) {
    const next = { ...parts, [key]: value };
    const max = next.month ? new Date(Number(next.year) || 2000, Number(next.month), 0).getDate() : 31;
    if (Number(next.day) > max) next.day = String(max).padStart(2, '0');
    setParts(next); onChange(next.year && next.month && next.day ? `${next.year}-${next.month}-${next.day}` : '');
  }
  return <div className="birth-date-selects" role="group" aria-label={t('تاريخ الميلاد')}>
    <label><span>{t('السنة')}</span><select aria-label={t('سنة الميلاد')} value={parts.year} onChange={e => change('year', e.target.value)}><option value="">{t('السنة')}</option>{Array.from({ length: 101 }, (_, i) => now - i).map(year => <option key={year} value={year}>{year}</option>)}</select></label>
    <label><span>{t('الشهر')}</span><select aria-label={t('شهر الميلاد')} value={parts.month} onChange={e => change('month', e.target.value)}><option value="">{t('الشهر')}</option>{Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0')).map(month => <option key={month} value={month}>{month}</option>)}</select></label>
    <label><span>{t('اليوم')}</span><select aria-label={t('يوم الميلاد')} value={parts.day} onChange={e => change('day', e.target.value)}><option value="">{t('اليوم')}</option>{Array.from({ length: days }, (_, i) => String(i + 1).padStart(2, '0')).map(day => <option key={day} value={day}>{day}</option>)}</select></label>
  </div>;
}
