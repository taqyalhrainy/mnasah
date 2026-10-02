import { useState, type FormEvent } from 'react';
import { ArrowLeft, Eye, EyeOff, GraduationCap, LockKeyhole, LogIn, Mail, ShieldCheck, UserPlus, Users } from 'lucide-react';
import { request, portalNames, type Portal, type User } from '../../services/platformApi';

export function AuthForm({ portal, onLogin }: { portal: Portal; onLogin: (user: User) => void }) {
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
  return <main className={`auth-page redesigned-auth portal-${portal}`} dir="rtl">
    <div className="auth-main">
      <div className="auth-brand"><img src={`${base}icon.svg`} width="44" height="44" alt="" /><strong>Mansah<span>منصّة</span></strong></div>
      <section className="auth-form">
        <div className="auth-portal-label"><PortalIcon size={19} />{portalNames[portal]}</div>
        <h1>{setupToken ? 'إنشاء حساب الأونر' : register ? 'انضم إلى منصّة' : 'تسجيل الدخول'}</h1>
        <p className="auth-welcome">{register ? 'بداية جديدة، وفرص أكبر.' : 'أهلاً بعودتك. مكانك بانتظارك.'}</p>
        {portal !== 'admin' && !setupToken && <nav className="auth-role-tabs" aria-label="بوابات المنصة"><a href={`${base}students`} aria-current={portal === 'students' ? 'page' : undefined}><GraduationCap size={18} />طالب</a><a href={`${base}teachers`} aria-current={portal === 'teachers' ? 'page' : undefined}><Users size={18} />أستاذ</a></nav>}
        <form onSubmit={submit}>
          {register && <label>الاسم الكامل<div className="auth-input-wrap"><UserPlus size={18} /><input name="name" autoComplete="name" placeholder="اسمك الكامل" maxLength={100} required /></div></label>}
          <label>البريد الإلكتروني<div className="auth-input-wrap"><Mail size={18} /><input name="email" type="email" dir="ltr" autoComplete="email" placeholder="you@example.com" maxLength={254} required /></div></label>
          <label>كلمة المرور<div className="auth-input-wrap"><LockKeyhole size={18} /><input name="password" type={showPassword ? 'text' : 'password'} dir="ltr" autoComplete={register ? 'new-password' : 'current-password'} minLength={12} maxLength={128} required /><button type="button" className="password-toggle" aria-label={showPassword ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'} title={showPassword ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'} aria-pressed={showPassword} onClick={() => setShowPassword(value => !value)}>{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button></div></label>
          {register && <small>كلمة المرور 12 حرفاً على الأقل.</small>}
          {error && <p className="notice error" role="alert">{error}</p>}
          <button className="primary-button auth-submit" disabled={busy}><LogIn size={18} />{busy ? 'جارٍ المتابعة…' : register ? 'إنشاء الحساب' : 'دخول'}<ArrowLeft size={18} /></button>
        </form>
        {portal !== 'admin' && <div className="auth-register"><span>{register ? 'لديك حساب؟' : 'أول مرة في منصّة؟'}</span><button className="text-button" onClick={() => { setRegister(!register); setError(''); }}><UserPlus size={17} />{register ? 'لدي حساب بالفعل' : 'إنشاء حساب جديد'}</button></div>}
      </section>
      <footer className="auth-footer"><ShieldCheck size={15} /><span>مساحتك الخاصة للتعلّم</span><span dir="ltr">Mansah © {new Date().getFullYear()}</span></footer>
    </div>
    <aside className="auth-visual" aria-label="مساحة تعلم"><img src={`${base}images/study-workspace.jpg`} alt="طالب يكتب ملاحظاته أثناء الدراسة" fetchPriority="low" /><div className="auth-visual-caption"><span>التعلّم يبدأ بخطوة.</span><strong>خطوتك القادمة<br />تبدأ هنا.</strong><div><span>Mansah</span><span>منصّة تعليم خصوصي</span></div></div></aside>
  </main>;
}
