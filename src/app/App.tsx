import { lazy, Suspense, useEffect, useState } from 'react';
import { Download, LogOut, CalendarDays, Users, Settings, Search, ClipboardList, Home, Wallet, History, Clock3, Video, ChevronDown } from 'lucide-react';
import { AuthForm } from '../features/auth/AuthForm';
import { ChangeTemporaryPassword } from '../features/auth/ChangeTemporaryPassword';
import { PortalWorkspace } from '../features/portal/PortalWorkspace';
import { request, portalNames, type Portal, type User } from '../services/platformApi';
import '../styles/portal.css';
const VideoTestPage = lazy(() => import('../features/video/VideoTestPage').then(module => ({ default: module.VideoTestPage })));

function currentPortal(): Portal {
  const part = routePath().split('/')[1];
  return part === 'admin' || part === 'teachers' ? part : 'students';
}
const baseUrl = import.meta.env.BASE_URL;
const basePath = baseUrl.replace(/\/$/, '');
const assetUrl = (path: string) => `${baseUrl}${path.replace(/^\//, '')}`;
const appUrl = (path: string) => `${basePath}${path.startsWith('/') ? path : `/${path}`}` || '/';
function routePath() {
  const path = location.pathname;
  return basePath && path.startsWith(`${basePath}/`) ? path.slice(basePath.length) : path;
}
export function App() {
  if (routePath() === '/video-test') return <Suspense fallback={<WakeLoading slow={false} attempt={0} />}><VideoTestPage /></Suspense>;
  return <PortalApp />;
}

const wakeRetryDelays = [2500, 4000, 6000, 8000, 10000, 12000];

function WakeLoading({ slow, attempt }: { slow: boolean; attempt: number }) {
  return <main className="loading-page wake-page" role="status" dir="rtl" aria-live="polite">
    <div className="wake-card">
      <img src={assetUrl('icon.svg')} width="56" height="56" alt="" />
      <div className="wake-spinner" aria-hidden="true" />
      <p className="wake-kicker">Mansah</p>
      <h1>{slow ? 'لحظات ونكون معك' : 'جارٍ تحميل منصتك'}</h1>
      <p>{slow ? 'Please wait a few moments...' : 'نجهز حسابك والبيانات الخاصة بك.'}</p>
      {attempt > 0 && <small>قد يستغرق التحميل لحظات إضافية.</small>}
    </div>
  </main>;
}

function PortalApp() {
  const [portal, setPortal] = useState(currentPortal);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [slowWake, setSlowWake] = useState(false);
  const [wakeAttempt, setWakeAttempt] = useState(0);
  const [error, setError] = useState('');
  const [view, setView] = useState(portal === 'students' || portal === 'teachers' ? 'home' : 'bookings');
  const [roomLive, setRoomLive] = useState(false);
  const [retry, setRetry] = useState(0);
  const [searchFocusKey, setSearchFocusKey] = useState(0);
  useEffect(() => { window.scrollTo({ top: 0, behavior: 'instant' }); }, [view]);
  useEffect(() => {
    const pop = () => { const next = currentPortal(); setPortal(next); setView(next === 'students' || next === 'teachers' ? 'home' : 'bookings'); setRoomLive(false); };
    addEventListener('popstate', pop); return () => removeEventListener('popstate', pop);
  }, []);
  useEffect(() => {
    let alive = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const slowTimer = setTimeout(() => { if (alive) setSlowWake(true); }, 1800);
    setLoading(true); setError('');
    request<{ user: User | null }>(`auth/me?portal=${portal}`).then(result => {
      if (!alive) return;
      setUser(result.user);
      if (routePath() === '/video' && result.user) { history.replaceState({}, '', appUrl(result.user.role)); setPortal(result.user.role); }
      setWakeAttempt(0);
      setSlowWake(false);
    }).catch(e => {
      if (!alive) return;
      const delay = wakeRetryDelays[wakeAttempt];
      if (delay !== undefined) {
        setSlowWake(true);
        retryTimer = setTimeout(() => { if (alive) setWakeAttempt(attempt => attempt + 1); }, delay);
        return;
      }
      setError(e.message);
    }).finally(() => {
      clearTimeout(slowTimer);
      if (alive && !retryTimer) setLoading(false);
    });
    return () => {
      alive = false;
      clearTimeout(slowTimer);
      clearTimeout(retryTimer);
    };
  }, [retry, portal, wakeAttempt]);
  async function logout() {
    try { await request(`auth/logout?portal=${portal}`, { role: portal }); setUser(null); setRoomLive(false); setView(portal === 'students' || portal === 'teachers' ? 'home' : 'bookings'); } catch (e) { setError((e as Error).message); }
  }
  function openQuickAction() {
    if (portal === 'students') {
      setView('home');
      setSearchFocusKey(value => value + 1);
    } else setView(portal === 'teachers' ? 'available' : 'users');
  }
  if (loading) return <WakeLoading slow={slowWake || wakeAttempt > 0} attempt={wakeAttempt} />;
  if (error && !user) return <main className="loading-page wake-page" dir="rtl"><div className="wake-card"><p role="alert">{error}</p><button className="primary-button" onClick={() => { setWakeAttempt(0); setRetry(retry + 1); }}>إعادة المحاولة</button></div></main>;
  if (!user) return <AuthForm key={portal} portal={portal} onLogin={setUser} />;
  if (user.mustChangePassword && portal === user.role) return <ChangeTemporaryPassword user={user} onComplete={() => setUser(null)} />;
  if (portal !== user.role) return <main className="loading-page" dir="rtl"><h1>هذا القسم غير متاح لحسابك</h1><a className="primary-button" href={appUrl(user.role)}>العودة إلى قسمك</a><button className="text-button" onClick={logout}>تسجيل الخروج</button></main>;
  const nav = portal === 'students'
    ? [{ id: 'home', label: 'الرئيسية', icon: Home }, { id: 'rooms', label: 'الغرف', icon: Video }, { id: 'tutors', label: 'أساتذتي', icon: Users }, { id: 'wallet', label: 'المحفظة', icon: Wallet }, { id: 'history', label: 'السجل', icon: History }, { id: 'profile', label: 'حسابي', icon: Settings }]
    : portal === 'teachers'
    ? [{ id: 'home', label: 'الرئيسية', icon: Home }, { id: 'rooms', label: 'الغرف', icon: Video }, { id: 'booked', label: 'المحجوزة', icon: CalendarDays }, { id: 'available', label: 'المتاحة', icon: Clock3 }, { id: 'earnings', label: 'المستحقات', icon: Wallet }, { id: 'profile', label: 'حسابي', icon: Settings }]
    : [{ id: 'bookings', label: 'الحصص والحجوزات', icon: CalendarDays },
      ...(portal === 'admin' ? [{ id: 'users', label: 'الحسابات', icon: Users }, { id: 'audit', label: 'سجل العمليات', icon: ClipboardList }] : [{ id: 'slots', label: 'مواعيدي المتاحة', icon: Search }]),
      { id: 'catalog', label: 'التصنيفات والمواد', icon: ClipboardList },
      { id: 'profile', label: 'حسابي', icon: Settings }];
  return <main className={`app-shell business-shell redesigned-shell portal-${portal} ${portal !== 'admin' ? 'learning-shell' : ''}`} dir="rtl">
    <a className="skip-link" href="#main-content">انتقل إلى المحتوى</a>
    <aside className="sidebar"><button className="brand" onClick={() => setView(portal === 'admin' ? 'bookings' : 'home')} title="Mansah"><img className="brand-monogram" src={assetUrl('icon.svg')} width="38" height="38" alt="" /><div><strong>Mansah<span className="brand-dot">.</span></strong><span>{portalNames[portal]}</span></div></button>
      <nav className="nav-list" aria-label="التنقل الرئيسي">{nav.map(({ id, label, icon: Icon }) => <button key={id} title={label} aria-label={`${label}${id === 'rooms' && roomLive ? ' LIVE' : ''}`} aria-current={view === id ? 'page' : undefined} className={`nav-button ${view === id ? 'active' : ''}`} onClick={() => setView(id)}><Icon size={20} strokeWidth={1.8} /><span className="nav-label-full">{label}</span><span className="nav-label-short">{id === 'bookings' ? 'الحجوزات' : id === 'audit' ? 'العمليات' : id === 'catalog' ? 'المواد' : label}</span>{id === 'rooms' && roomLive && <span className="nav-live"><span aria-hidden="true" />LIVE</span>}</button>)}</nav>
      <div className="sidebar-footer"><a href={assetUrl('downloads/mansah.apk')} className="icon-button" title="تطبيق أندرويد"><Download size={19} /></a><button className="icon-button" onClick={logout} title="تسجيل الخروج"><LogOut size={19} /></button></div>
    </aside>
    <section className="workspace"><header className="topbar"><div className="topbar-location"><img className="mobile-brand brand-monogram" src={assetUrl('icon.svg')} width="32" height="32" alt="Mansah" /><div><span className="eyebrow">{portalNames[portal]}</span><h1>{nav.find(n => n.id === view)?.label}</h1></div></div><div className="topbar-actions"><time className="topbar-date"><CalendarDays size={17} />{new Date().toLocaleDateString('ar-JO', { weekday: 'long', day: 'numeric', month: 'long' })}</time><button className="icon-button quick-action" onClick={openQuickAction} title={portal === 'students' ? 'البحث عن مادة أو أستاذ' : portal === 'teachers' ? 'إضافة موعد متاح' : 'إدارة الحسابات'}>{portal === 'students' ? <Search size={19} /> : portal === 'teachers' ? <CalendarDays size={19} /> : <Users size={19} />}</button><details className="account-menu"><summary><span className="account-avatar">{user.name.trim().charAt(0)}</span><span className="account-name">{user.name}</span><ChevronDown size={15} /></summary><div><button onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); setView('profile'); }}><Settings size={16} />حسابي</button><a href={assetUrl('downloads/mansah.apk')}><Download size={16} />تطبيق أندرويد</a><button onClick={logout}><LogOut size={16} />تسجيل الخروج</button></div></details></div></header>
      <div className="workspace-content" id="main-content" tabIndex={-1}>
      {error && <p className="notice error" role="alert">{error}</p>}
      {user.status === 'suspended' ? <p className="notice error">حسابك موقوف. راجع الإدارة.</p> : user.status === 'pending' && view !== 'profile' ? <section className="empty-state"><h2>طلبك قيد المراجعة</h2><p>ستظهر المواعيد والحصص بعد موافقة الإدارة على حسابك.</p><button className="secondary-button" onClick={() => setRetry(retry + 1)}>تحديث حالة الطلب</button></section> : <PortalWorkspace key={user.id} portal={portal} user={user} view={view} onUser={setUser} onView={setView} onRoomLiveChange={setRoomLive} searchFocusKey={searchFocusKey} />}
      </div></section>
  </main>;
}
