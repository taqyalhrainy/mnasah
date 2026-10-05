import { t, direction, usePreferences, PreferenceControls } from '../../i18n/preferences';
import { useState, type FormEvent } from 'react';
import { Save } from 'lucide-react';
import { request, type User } from '../../services/platformApi';

export function ChangeTemporaryPassword({ user, onComplete }: { user: User; onComplete: () => void }) {
  usePreferences();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    const values = Object.fromEntries(new FormData(event.currentTarget));
    if (values.password !== values.confirm) { setError(t("كلمتا المرور الجديدتان غير متطابقتين.")); return; }
    setBusy(true);
    try { await request(`${user.role}/password`, values); onComplete(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <main className="auth-page password-change-page" dir={direction()}><PreferenceControls /><section className="auth-form"><h1>{t("تغيير كلمة المرور المؤقتة")}</h1><p>{user.name}{t("، اختر كلمة مرور خاصة بك للمتابعة.")}</p><form onSubmit={submit}>
    <label>{t("كلمة المرور المؤقتة")}<input name="current" type="password" autoComplete="current-password" minLength={12} maxLength={128} required /></label>
    <label>{t("كلمة المرور الجديدة")}<input name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required /></label>
    <label>{t("تأكيد كلمة المرور الجديدة")}<input name="confirm" type="password" autoComplete="new-password" minLength={12} maxLength={128} required /></label>
    <small>{t("12 حرفًا على الأقل. بعد الحفظ سجّل الدخول بكلمتك الجديدة.")}</small>
    {error && <p className="notice error" role="alert">{t(error)}</p>}
    <button className="primary-button" disabled={busy}><Save size={18} />{busy ? t("جارٍ الحفظ…") : t("حفظ كلمة المرور")}</button>
  </form><button className="text-button" disabled={busy} onClick={async () => { try { await request('auth/logout', {}); onComplete(); } catch (e) { setError((e as Error).message); } }}>{t("تسجيل الخروج")}</button></section></main>;
}
