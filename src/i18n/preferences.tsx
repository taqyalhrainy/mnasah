import { useSyncExternalStore } from 'react';
import { Languages, Moon, Sun } from 'lucide-react';
import { messages } from './messages';
import { additionalMessages } from './additionalMessages';
Object.assign(messages, additionalMessages);

export type Language = 'ar' | 'en';
export type Theme = 'light' | 'dark';
const sourceKeys = new Map(Object.entries(messages).map(([source, english]) => [english, source]));
// Admin-entered catalogue labels can omit hamzas/diacritics or use a different
// final ya/ta marbuta. Match the complete label before the phrase fallback, so
// "تأسيس عربي" never becomes a mixed Arabic/English title.
const normalizedKey = (value: string) => value.normalize('NFKC').replace(/[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed\u0640]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/\s+/g, ' ').trim();
const normalizedMessages = new Map(Object.entries(messages).map(([source, english]) => [normalizedKey(source), english]));
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const templates = Object.entries(messages).filter(([key]) => /\{\w+\}/.test(key)).map(([key, english]) => ({
  regex: new RegExp('^' + key.split(/(\{\w+\})/).map(part => /^\{\w+\}$/.test(part) ? '(.+?)' : escapeRegex(part)).join('') + '$'),
  names: [...key.matchAll(/\{(\w+)\}/g)].map(match => match[1]), english,
}));
const phrases = Object.keys(messages).filter(key => /[\u0600-\u06ff]/.test(key) && key.length > 1 && !key.includes('{')).sort((a, b) => b.length - a.length);
const phrasePattern = new RegExp(phrases.map(escapeRegex).join('|'), 'g');
function englishText(key: string): string {
  if (messages[key]) return messages[key];
  const normalized = normalizedMessages.get(normalizedKey(key));
  if (normalized) return normalized;
  for (const template of templates) {
    const match = key.match(template.regex);
    if (match) return template.english.replace(/\{(\w+)\}/g, (token, name: string) => match[template.names.indexOf(name) + 1] || token);
  }
  return key.replace(phrasePattern, match => messages[match]).replace(/[٠-٩]/g, digit => String(digit.charCodeAt(0) - 0x660)).replace(/،/g, ',');
}
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

export function t(source: string | null | undefined, values?: Record<string, string | number>): string;
export function t(source: string, index: number, list: string[]): string;
export function t(source: string | null | undefined, values: Record<string, string | number> | number = {}): string {
  if (!source) return '';
  const replacements = typeof values === 'number' ? {} : values;
  const key = sourceKeys.get(source.trim()) || source.trim();
  const translated = language === 'en' ? englishText(key) : key;
  const result = translated.replace(/\{(\w+)\}/g, (token, name: string) => String(replacements[name] ?? token));
  return source.startsWith(' ') || source.endsWith(' ') ? source.slice(0, source.length - source.trimStart().length) + result + source.slice(source.trimEnd().length) : result;
}
function apply() {
  document.documentElement.lang = language;
  document.documentElement.dir = direction();
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#20172c' : '#ffffff');
  document.title = t('امتداد العلم أكاديمي | منصة تعليم خصوصي عن بُعد');
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
