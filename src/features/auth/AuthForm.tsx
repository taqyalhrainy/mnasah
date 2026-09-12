import { useState, type FormEvent } from 'react';
import { LogIn, UserPlus } from 'lucide-react';
import { request, portalNames, type Portal, type User } from '../../services/platformApi';

export function AuthForm({ portal, onLogin }: { portal: Portal; onLogin: (user: User) => void }) {
  const [setupToken] = useState(() => new URLSearchParams(location.hash.slice(1)).get('setup') || '');
  const [register, setRegister] = useState(Boolean(setupToken));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const result = await request<{ user: User }>(`auth/${setupToken ? 'setup' : register ? 'register' : 'login'}`, { ...data, role: portal, token: setupToken });
      history.replaceState({}, '', location.pathname); onLogin(result.user);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <main className="auth-page" dir="rtl">
    <div className="auth-brand"><img src="/icon.svg" width="48" height="48" alt="" /><strong>Mansah</strong></div>
    <section className="auth-form">
      <p className="eyebrow">{portalNames[portal]}</p><h1>{setupToken ? 'إنشاء حساب الأونر' : register ? 'إنشاء حساب' : 'تسجيل الدخول'}</h1>
      <form onSubmit={submit}>
        {register && <label>الاسم الكامل<input name="name" autoComplete="name" maxLength={100} required /></label>}
        <label>البريد الإلكتروني<input name="email" type="email" dir="ltr" autoComplete="email" maxLength={254} required /></label>
        <label>كلمة المرور<input name="password" type="password" dir="ltr" autoComplete={register ? 'new-password' : 'current-password'} minLength={12} maxLength={128} required /></label>
        {register && <small>كلمة المرور 12 حرفًا على الأقل.</small>}
        {error && <p className="notice error" role="alert">{error}</p>}
        <button className="primary-button" disabled={busy}><LogIn size={18} />{busy ? 'جارٍ المتابعة…' : register ? 'إنشاء الحساب' : 'دخول'}</button>
      </form>
      {portal !== 'admin' && <button className="text-button" onClick={() => { setRegister(!register); setError(''); }}><UserPlus size={17} />{register ? 'لدي حساب بالفعل' : 'إنشاء حساب جديد'}</button>}
    </section>
  </main>;
}
