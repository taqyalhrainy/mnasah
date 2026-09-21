import { useEffect, useState } from 'react';
import { Download, LogOut, CalendarDays, Users, Settings, Search, ClipboardList, Home, Wallet, History, Clock3 } from 'lucide-react';
import { AuthForm } from '../features/auth/AuthForm';
import { ChangeTemporaryPassword } from '../features/auth/ChangeTemporaryPassword';
import { PortalWorkspace } from '../features/portal/PortalWorkspace';
import { request, portalNames, type Portal, type User } from '../services/platformApi';
import '../styles/portal.css';

function currentPortal(): Portal {
  const part = location.pathname.split('/')[1];
  return part === 'admin' || part === 'teachers' ? part : 'students';
}
export function App() {
  const [portal, setPortal] = useState(currentPortal);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [view, setView] = useState(portal === 'students' || portal === 'teachers' ? 'home' : 'bookings');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const pop = () => { const next = currentPortal(); setPortal(next); setView(next === 'students' || next === 'teachers' ? 'home' : 'bookings'); };
    addEventListener('popstate', pop); return () => removeEventListener('popstate', pop);
  }, []);
  useEffect(() => {
    setLoading(true); setError('');
    request<{ user: User | null }>('auth/me').then(result => {
      setUser(result.user);
      if (location.pathname === '/video' && result.user) { history.replaceState({}, '', `/${result.user.role}`); setPortal(result.user.role); }
    }).catch(e => setError(e.message)).finally(() => setLoading(false));
  }, [retry]);
  async function logout() {
    try { await request('auth/logout', {}); setUser(null); setView(portal === 'students' || portal === 'teachers' ? 'home' : 'bookings'); } catch (e) { setError((e as Error).message); }
  }
  if (loading) return <main className="loading-page" role="status">جارٍ تحميل حسابك…</main>;
  if (error && !user) return <main className="loading-page"><p role="alert">{error}</p><button onClick={() => setRetry(retry + 1)}>إعادة المحاولة</button></main>;
  if (!user) return <AuthForm key={portal} portal={portal} onLogin={setUser} />;
  if (user.mustChangePassword && portal === user.role) return <ChangeTemporaryPassword user={user} onComplete={() => setUser(null)} />;
  if (portal !== user.role) return <main className="loading-page" dir="rtl"><h1>هذا القسم غير متاح لحسابك</h1><a className="primary-button" href={`/${user.role}`}>العودة إلى قسمك</a><button className="text-button" onClick={logout}>تسجيل الخروج</button></main>;
  const nav = portal === 'students'
    ? [{ id: 'home', label: 'الرئيسية', icon: Home }, { id: 'tutors', label: 'أساتذتي', icon: Users }, { id: 'wallet', label: 'المحفظة', icon: Wallet }, { id: 'history', label: 'السجل', icon: History }, { id: 'profile', label: 'حسابي', icon: Settings }]
    : portal === 'teachers'
    ? [{ id: 'home', label: 'الرئيسية', icon: Home }, { id: 'booked', label: 'المحجوزة', icon: CalendarDays }, { id: 'available', label: 'المتاحة', icon: Clock3 }, { id: 'earnings', label: 'المستحقات', icon: Wallet }, { id: 'profile', label: 'حسابي', icon: Settings }]
    : [{ id: 'bookings', label: 'الحصص والحجوزات', icon: CalendarDays },
      ...(portal === 'admin' ? [{ id: 'users', label: 'الحسابات', icon: Users }, { id: 'audit', label: 'سجل العمليات', icon: ClipboardList }] : [{ id: 'slots', label: 'مواعيدي المتاحة', icon: Search }]),
      { id: 'profile', label: 'حسابي', icon: Settings }];
  return <main className="app-shell business-shell" dir="rtl">
    <aside className="sidebar"><div className="brand"><img src="/icon.svg" width="40" height="40" alt="" /><div><strong>Mansah</strong><span>{portalNames[portal]}</span></div></div>
      <nav className="nav-list">{nav.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-button ${view === id ? 'active' : ''}`} onClick={() => setView(id)}><Icon size={18} />{label}</button>)}</nav>
      <div className="sidebar-footer"><a href="/downloads/mansah.apk" className="nav-button"><Download size={18} />تطبيق أندرويد</a><button className="nav-button" onClick={logout}><LogOut size={18} />تسجيل الخروج</button></div>
    </aside>
    <section className="workspace"><header className="topbar"><div><span className="eyebrow">{portalNames[portal]}</span><h1>{nav.find(n => n.id === view)?.label}</h1></div><span className="account-name">{user.name}</span></header>
      {error && <p className="notice error" role="alert">{error}</p>}
      {user.status === 'suspended' ? <p className="notice error">حسابك موقوف. راجع الإدارة.</p> : user.status === 'pending' && view !== 'profile' ? <section className="empty-state"><h2>طلبك قيد المراجعة</h2><p>ستظهر المواعيد والحصص بعد موافقة الإدارة على حسابك.</p><button className="secondary-button" onClick={() => setRetry(retry + 1)}>تحديث حالة الطلب</button></section> : <PortalWorkspace key={user.id} portal={portal} user={user} view={view} onUser={setUser} onView={setView} />}
    </section>
  </main>;
}
