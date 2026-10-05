import { useSyncExternalStore } from 'react';
import { Languages, Moon, Sun } from 'lucide-react';
import { messages } from './messages';

export type Language = 'ar' | 'en';
export type Theme = 'light' | 'dark';
const sourceKeys = new Map(Object.entries(messages).map(([source, english]) => [english, source]));
const listeners = new Set<() => void>();
function saved(key: string) { try { return localStorage.getItem(key); } catch { return null; } }
let language: Language = saved('mansah-language') === 'en' ? 'en' : 'ar';
let theme: Theme = saved('mansah-theme') === 'light' ? 'light' : saved('mansah-theme') === 'dark' ? 'dark' : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
const subscribe = (callback: () => void) => { listeners.add(callback); return () => { listeners.delete(callback); }; };
const snapshot = () => `${language}:${theme}`;
export const locale = () => language === 'ar' ? 'ar-JO' : 'en-JO';
export const direction = () => language === 'ar' ? 'rtl' : 'ltr';
export const catalogText = (source: string) => source === 'حفظ' && language === 'en' ? messages['حفظ القرآن'] : t(source);
export const searchText = (...values: string[]) => values.flatMap(value => [value, catalogText(value)]).join(' ');

export function t(source: string | null | undefined, values: Record<string, string | number> = {}): string {
  if (!source) return '';
  const key = sourceKeys.get(source.trim()) || source.trim();
  const translated = language === 'en' ? messages[key] || key : key;
  const result = translated.replace(/\{(\w+)\}/g, (token, name: string) => String(values[name] ?? token));
  return source.startsWith(' ') || source.endsWith(' ') ? source.slice(0, source.length - source.trimStart().length) + result + source.slice(source.trimEnd().length) : result;
}
function apply() {
  document.documentElement.lang = language;
  document.documentElement.dir = direction();
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#20172c' : '#ffffff');
  document.title = t('Mansah | منصة تعليم خصوصي');
}
apply();
function update(nextLanguage: Language, nextTheme: Theme, persist = true) {
  language = nextLanguage; theme = nextTheme;
  if (persist) { try { localStorage.setItem('mansah-language', language); localStorage.setItem('mansah-theme', theme); } catch { /* Private browsing can disable storage. */ } }
  apply(); listeners.forEach(callback => callback());
}
window.addEventListener('storage', event => {
  if (event.key === 'mansah-language' || event.key === 'mansah-theme') update(saved('mansah-language') === 'en' ? 'en' : 'ar', saved('mansah-theme') === 'dark' ? 'dark' : 'light', false);
});
export function usePreferences() {
  useSyncExternalStore(subscribe, snapshot);
  return { language, theme, setLanguage: (value: Language) => update(value, theme), setTheme: (value: Theme) => update(language, value) };
}
export function PreferenceControls() {
  const { language: currentLanguage, theme: currentTheme, setLanguage, setTheme } = usePreferences();
  return <div className="preference-controls" aria-label={t('إعدادات العرض')}>
    <label className="language-control"><Languages size={17} aria-hidden="true" /><select aria-label={t('اللغة')} value={currentLanguage} onChange={event => setLanguage(event.target.value as Language)}><option value="ar">العربية</option><option value="en">English</option></select></label>
    <button type="button" className="icon-button theme-control" aria-label={t(currentTheme === 'dark' ? 'الوضع الفاتح' : 'الوضع الداكن')} title={t(currentTheme === 'dark' ? 'الوضع الفاتح' : 'الوضع الداكن')} onClick={() => setTheme(currentTheme === 'dark' ? 'light' : 'dark')}>{currentTheme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</button>
  </div>;
}
