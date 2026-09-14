import { useState, type FormEvent } from 'react';
import { Users, GraduationCap, KeyRound, Copy, X, Check, Ban } from 'lucide-react';
import { request, statusNames, date, type User } from '../../services/platformApi';

export function AccountsPanel({ users, query, onChanged }: { users: User[]; query: string; onChanged: () => void }) {
  const [role, setRole] = useState<'teachers' | 'students'>('teachers');
  const [target, setTarget] = useState<User | null>(null);
  const [result, setResult] = useState<{ temporaryPassword: string; expires: number } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const list = users.filter(u => u.role === role && `${u.name} ${u.email}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  function close() { if (busy) return; const changed = Boolean(result); setTarget(null); setResult(null); setCopied(false); setError(''); if (changed) onChanged(); }
  async function reset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!target) return;
    const form = event.currentTarget;
    const body = Object.fromEntries(new FormData(form));
    setBusy(true); setError('');
    try { setResult(await request(`admin/users/${target.id}/reset-password`, body)); form.reset(); }
    catch(e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function changeStatus(user: User) {
    const status = user.status === 'active' ? 'suspended' : 'active';
    if (!window.confirm(`${status === 'active' ? 'تفعيل' : 'إيقاف'} حساب ${user.name}؟`)) return;
    setBusy(true); setError('');
    try { await request(`admin/users/${user.id}`, { status }); onChanged(); }
    catch(e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <section className="accounts-panel">
    <div className="account-tabs" role="tablist" aria-label="نوع الحسابات">{(['teachers', 'students'] as const).map(value => <button key={value} id={`tab-${value}`} role="tab" aria-selected={role === value} aria-controls="account-results" className={role === value ? 'selected' : ''} onClick={() => { setRole(value); setError(''); }}>{value === 'teachers' ? <Users size={19} /> : <GraduationCap size={19} />}{value === 'teachers' ? 'حسابات الأساتذة' : 'حسابات الطلاب'}<span>{users.filter(u => u.role === value).length}</span></button>)}</div>
    {error && !target && <p className="notice error" role="alert">{error}</p>}
    <div role="tabpanel" id="account-results" aria-labelledby={`tab-${role}`}>
      {!list.length && <p className="empty-state">{query ? 'لا توجد حسابات مطابقة للبحث.' : 'لا توجد حسابات في هذا القسم بعد.'}</p>}
      {list.map(user => <article className="user-row account-row" key={user.id}><div><h2>{user.name}</h2><p className="account-email" dir="ltr">{user.email}</p>{user.role === 'teachers' && <small>{user.subject || 'لم يحدد المادة'}</small>}{user.bio && <p>{user.bio}</p>}<p className="muted">{user.mustChangePassword ? 'يلزم تغيير كلمة المرور المؤقتة' : 'كلمة المرور خاصة بصاحب الحساب'}</p></div><span className={`badge ${user.status}`}>{statusNames[user.status]}</span><div className="row-actions"><button className="secondary-button" disabled={busy} onClick={() => changeStatus(user)}>{user.status === 'active' ? <Ban size={17} /> : <Check size={17} />}{user.status === 'active' ? 'إيقاف الحساب' : 'قبول وتفعيل'}</button><button className="secondary-button" disabled={busy} onClick={() => { setTarget(user); setResult(null); setError(''); setCopied(false); }}><KeyRound size={17} />كلمة مرور مؤقتة</button></div></article>)}
    </div>
    {target && <dialog className="detail-dialog" aria-labelledby="reset-title" ref={node => { if (node && !node.open) node.showModal(); }} onCancel={event => { event.preventDefault(); close(); }}><div className="section-heading"><h2 id="reset-title">كلمة مرور مؤقتة</h2><button className="icon-button" disabled={busy} onClick={close} title="إغلاق"><X size={20} /></button></div><p>{target.name}</p><p className="account-email" dir="ltr">{target.email}</p>
      {error && <p className="notice error" role="alert">{error}</p>}
      {result ? <div className="temporary-credential"><p role="status">تم إصدار كلمة المرور. تظهر هنا مرة واحدة فقط؛ أرسلها لصاحب الحساب بشكل خاص.</p><label>كلمة المرور المؤقتة<input dir="ltr" readOnly value={result.temporaryPassword} autoComplete="off" /></label><p>صالحة حتى {date(result.expires)}. يجب تغييرها عند الدخول، والكلمة السابقة لم تعد تعمل.</p><button className="secondary-button" onClick={async () => { try { await navigator.clipboard.writeText(result.temporaryPassword); setCopied(true); } catch { setError('تعذر النسخ التلقائي. حدد كلمة المرور وانسخها يدويًا.'); } }}><Copy size={17} />{copied ? 'تم النسخ' : 'نسخ كلمة المرور'}</button><button className="primary-button" onClick={close}>تم</button></div> : <form className="work-form" onSubmit={reset}><p>سيتم إلغاء كلمة المرور السابقة وتسجيل خروج هذا الحساب من جميع الأجهزة.</p><label>كلمة مرور الأدمن للتأكيد<input name="adminPassword" type="password" autoComplete="current-password" required minLength={12} maxLength={128} /></label><button className="primary-button" disabled={busy}><KeyRound size={18} />{busy ? 'جارٍ الإصدار…' : 'إصدار كلمة مرور مؤقتة'}</button></form>}
    </dialog>}
  </section>;
}
