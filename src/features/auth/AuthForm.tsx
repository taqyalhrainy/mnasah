import { useState, type FormEvent } from 'react';
import { ArrowLeft, Eye, EyeOff, GraduationCap, LockKeyhole, LogIn, Mail, ShieldCheck, UserPlus, Users } from 'lucide-react';
import { request, portalNames, type Portal, type User } from '../../services/platformApi';
import { PreferenceControls, direction, t, usePreferences } from '../../i18n/preferences';
import { RegistrationFlow } from './RegistrationFlow';

export function AuthForm({ portal, onLogin }: { portal: Portal; onLogin: (user: User) => void }) {
  usePreferences();
  const [setupToken] = useState(() => new URLSearchParams(location.hash.slice(1)).get('setup') || '');
  const [register, setRegister] = useState(Boolean(setupToken));
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const base = import.meta.env.BASE_URL;
  const PortalIcon = portal === 'students' ? GraduationCap : portal === 'teachers' ? Users : ShieldCheck;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const result = await request<{ user: User }>(`auth/${setupToken ? 'setup' : register ? 'register' : 'login'}`, { ...data, role: portal, token: setupToken });
      history.replaceState({}, '', location.pathname); onLogin(result.user);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  if (register && portal !== 'admin' && !setupToken) return <main className={`auth-page redesigned-auth registration-page portal-${portal}`} dir={direction()}>
    <header className="auth-masthead"><div className="auth-brand"><img className="brand-monogram" src={`${base}icon.svg`} width="41" height="41" alt="" /><strong>Mansah<span className="brand-dot">.</span></strong></div><div className="auth-masthead-actions"><span className="auth-masthead-portal"><PortalIcon size={18} />{t(portalNames[portal])}</span><PreferenceControls /></div></header>
    <div className="auth-main registration-main"><RegistrationFlow portal={portal} onLogin={onLogin} onCancel={() => { setRegister(false); setError(''); }} /></div>
    <aside className="auth-visual" aria-label={t("مساحة تعلم")}><img src={`${base}images/learning-desk-v3.jpg`} alt={t("دفتر دراسة وقلم وسماعات على مكتب أصفر")} fetchPriority="high" /></aside>
  </main>;
  return <main className={`auth-page redesigned-auth portal-${portal}`} dir={direction()}>
    <header className="auth-masthead"><div className="auth-brand"><img className="brand-monogram" src={`${base}icon.svg`} width="41" height="41" alt="" /><strong>Mansah<span className="brand-dot">.</span></strong></div><div className="auth-masthead-actions"><span className="auth-masthead-portal"><PortalIcon size={18} />{t(portalNames[portal])}</span><PreferenceControls /></div></header>
    <div className="auth-main">
      <section className="auth-form">
        <div className="auth-portal-label">{t("منصّة تعليم خصوصي")}</div>
        <h1>{setupToken ? t("إنشاء حساب الأونر") : register ? t("انضم إلى منصّة") : t("تسجيل الدخول")}</h1>
        <p className="auth-welcome">{register ? t("أهلاً في منصّة.") : t("أهلاً بعودتك.")}</p>
        {portal !== 'admin' && !setupToken && <nav className="auth-role-tabs" aria-label={t("بوابات المنصة")}><a href={`${base}students`} aria-current={portal === 'students' ? 'page' : undefined}><GraduationCap size={18} />{t("طالب")}</a><a href={`${base}teachers`} aria-current={portal === 'teachers' ? 'page' : undefined}><Users size={18} />{t("أستاذ")}</a></nav>}
        <form onSubmit={submit}>
          {register && <label>{t("الاسم الكامل")}<div className="auth-input-wrap"><UserPlus size={18} /><input name="name" autoComplete="name" placeholder={t("اسمك الكامل")} maxLength={100} required /></div></label>}
          <label>{t("البريد الإلكتروني")}<div className="auth-input-wrap"><Mail size={18} /><input name="email" type="email" dir="ltr" autoComplete="email" placeholder="you@example.com" maxLength={254} required /></div></label>
          <label>{t("كلمة المرور")}<div className="auth-input-wrap"><LockKeyhole size={18} /><input name="password" type={showPassword ? 'text' : 'password'} dir="ltr" autoComplete={register ? 'new-password' : 'current-password'} minLength={12} maxLength={128} required /><button type="button" className="password-toggle" aria-label={showPassword ? t("إخفاء كلمة المرور") : t("إظهار كلمة المرور")} title={showPassword ? t("إخفاء كلمة المرور") : t("إظهار كلمة المرور")} aria-pressed={showPassword} onClick={() => setShowPassword(value => !value)}>{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button></div></label>
          {register && <small>{t("كلمة المرور 12 حرفاً على الأقل.")}</small>}
          {error && <p className="notice error" role="alert">{t(error)}</p>}
          <button className="primary-button auth-submit" disabled={busy}><LogIn size={18} />{busy ? t("جارٍ المتابعة…") : register ? t("إنشاء الحساب") : t("دخول")}<ArrowLeft size={18} /></button>
        </form>
        {portal !== 'admin' && <div className="auth-register"><span>{register ? t("لديك حساب؟") : t("أول مرة في منصّة؟")}</span><button className="text-button" onClick={() => { setRegister(!register); setError(''); }}><UserPlus size={17} />{register ? t("لدي حساب بالفعل") : t("إنشاء حساب جديد")}</button></div>}
      </section>
      <footer className="auth-footer"><ShieldCheck size={15} /><span>{t(portalNames[portal])}</span><span dir="ltr">Mansah © {new Date().getFullYear()}</span></footer>
    </div>
    <aside className="auth-visual" aria-label={t("مساحة تعلم")}><img src={`${base}images/learning-desk-v3.jpg`} alt={t("دفتر دراسة وقلم وسماعات على مكتب أصفر")} fetchPriority="high" /></aside>
  </main>;
}
