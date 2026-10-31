import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Bell, BellOff, Download, LogOut, CalendarDays, Users, Settings, Search, ClipboardList, Home, Wallet, WalletCards, History, Clock3, Video, ChevronDown, MessageCircle, ShieldCheck, PackageCheck, ShieldAlert, Star } from 'lucide-react';
import { AuthForm } from '../features/auth/AuthForm';
import { ChangeTemporaryPassword } from '../features/auth/ChangeTemporaryPassword';
import { RegistrationFlow } from '../features/auth/RegistrationFlow';
import { PortalWorkspace } from '../features/portal/PortalWorkspace';
import { apiMediaUrl, request, portalNames, type Portal, type User } from '../services/platformApi';
import '../styles/portal.css';
import { useDirectChat, type BookingCreatedNotice } from '../features/chat/useDirectChat';
import { PreferenceControls, direction, usePreferences, t, locale } from '../i18n/preferences';
const DirectMessages = lazy(() => import('../features/chat/DirectMessages').then(module => ({ default: module.DirectMessages })));
const VideoTestPage = lazy(() => import('../features/video/VideoTestPage').then(module => ({ default: module.VideoTestPage })));
type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };
const defaultSupportWhatsapp = '0795764229';
const whatsappHrefNumber = (value: string) => {
  const digits = value.replace(/\D/g, '');
  return digits.startsWith('0') ? `962${digits.slice(1)}` : digits;
};
function WhatsAppIcon() {
  return <svg viewBox="0 0 32 32" width="23" height="23" aria-hidden="true"><path fill="currentColor" d="M16 3a12 12 0 0 0-10.3 18.2L4 29l8-1.7A12 12 0 1 0 16 3Zm0 21.8c-1.8 0-3.5-.5-5-1.4l-.4-.2-4.1.9.9-4-.3-.4A9.7 9.7 0 1 1 16 24.8Zm5.4-7.2c-.3-.2-1.8-.9-2.1-1-.3-.1-.5-.2-.7.2l-1 1.2c-.2.2-.4.2-.7.1-1.8-.9-3-1.7-4.2-3.8-.3-.5.3-.5.9-1.7.1-.2 0-.5 0-.7l-1-2.3c-.2-.6-.5-.5-.7-.5h-.6c-.2 0-.6.1-.9.4-.3.4-1.2 1.2-1.2 2.9 0 1.7 1.2 3.3 1.4 3.5.2.2 2.4 3.7 5.8 5.2 2.2 1 3.1 1.1 4.2.9 1-.1 1.8-.8 2.1-1.5.3-.7.3-1.3.2-1.5-.2-.2-.5-.3-.8-.4Z" /></svg>;
}

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
  usePreferences();
  if (routePath() === '/video-test') return <Suspense fallback={<WakeLoading slow={false} attempt={0} />}><VideoTestPage /></Suspense>;
  return <PortalApp />;
}

const wakeRetryDelays = [2500, 4000, 6000, 8000, 10000, 12000];

function WakeLoading({ slow, attempt }: { slow: boolean; attempt: number }) {
  usePreferences();
  return <main className="loading-page wake-page" role="status" dir={direction()} aria-live="polite">
    <PreferenceControls />
    <div className="wake-card">
      <img src={assetUrl('icon.svg')} width="56" height="56" alt="" />
      <div className="wake-spinner" aria-hidden="true" />
      <p className="wake-kicker">امتداد العلم</p>
      <h1>{slow ? t("لحظات ونكون معك") : t("جارٍ تحميل منصتك")}</h1>
      <p>{slow ? t('يرجى الانتظار لحظات…') : t("نجهز حسابك والبيانات الخاصة بك.")}</p>
      {attempt > 0 && <small>{t("قد يستغرق التحميل لحظات إضافية.")}</small>}
    </div>
  </main>;
}

function PortalApp() {
  usePreferences();
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
  const [lessonReminders, setLessonReminders] = useState({ enabled: false, hint: '' });
  const [supportWhatsapp, setSupportWhatsapp] = useState(defaultSupportWhatsapp);
  const [bookingAlert, setBookingAlert] = useState<BookingCreatedNotice | null>(null);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const toggleLessonReminders = useRef<() => void>(() => undefined);
  useEffect(() => {
    const capture = (event: Event) => { event.preventDefault(); setInstallPrompt(event as InstallPromptEvent); };
    window.addEventListener('beforeinstallprompt', capture);
    return () => window.removeEventListener('beforeinstallprompt', capture);
  }, []);
  useEffect(() => {
    const closeAccountMenus = (event: PointerEvent) => {
      document.querySelectorAll<HTMLDetailsElement>('details.account-menu[open]').forEach(menu => {
        if (!menu.contains(event.target as Node)) menu.removeAttribute('open');
      });
    };
    document.addEventListener('pointerdown', closeAccountMenus);
    return () => document.removeEventListener('pointerdown', closeAccountMenus);
  }, []);
  const captureLessonReminders = useCallback((enabled: boolean, hint: string, toggle: () => void) => {
    toggleLessonReminders.current = toggle;
    setLessonReminders(current => current.enabled === enabled && current.hint === hint ? current : { enabled, hint });
  }, []);
  const chat = useDirectChat(portal, user, view === 'messages', () => setView('messages'), setBookingAlert);
  useEffect(() => {
    if (!bookingAlert) return;
    const timer = window.setTimeout(() => setBookingAlert(null), 7000);
    return () => clearTimeout(timer);
  }, [bookingAlert]);
  useEffect(() => {
    let alive = true;
    if (!user || portal === 'admin' || user.status !== 'active') { setSupportWhatsapp(defaultSupportWhatsapp); return; }
    request<{ whatsapp: string }>(`${portal}/support`).then(result => { if (alive) setSupportWhatsapp(String(result.whatsapp || defaultSupportWhatsapp).replace(/\D/g, '')); }).catch(() => { if (alive) setSupportWhatsapp(defaultSupportWhatsapp); });
    return () => { alive = false; };
  }, [portal, user]);
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
  async function installAndroidApp() {
    if (!installPrompt) {
      setError(t('إذا كان التطبيق مثبتاً فلن يظهر الطلب. غير ذلك افتح قائمة المتصفح واختر «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية».'));
      return;
    }
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice.outcome === 'accepted') setInstallPrompt(null);
  }
  function openQuickAction() {
    if (portal === 'students') {
      setView('home');
      setSearchFocusKey(value => value + 1);
    } else setView(portal === 'teachers' ? 'available' : 'users');
  }
  if (loading) return <WakeLoading slow={slowWake || wakeAttempt > 0} attempt={wakeAttempt} />;
  if (error && !user) return <main className="loading-page wake-page" dir={direction()}><div className="wake-card"><p role="alert">{t(error)}</p><button className="primary-button" onClick={() => { setWakeAttempt(0); setRetry(retry + 1); }}>{t("إعادة المحاولة")}</button></div></main>;
  if (!user) return <AuthForm key={portal} portal={portal} onLogin={setUser} />;
  if (user.mustChangePassword && portal === user.role) return <ChangeTemporaryPassword user={user} onComplete={() => setUser(null)} />;
  if (portal !== user.role) return <main className="loading-page" dir={direction()}><h1>{t("هذا القسم غير متاح لحسابك")}</h1><a className="primary-button" href={appUrl(user.role)}>{t("العودة إلى قسمك")}</a><button className="text-button" onClick={logout}>{t("تسجيل الخروج")}</button></main>;
  const nav = portal === 'students'
    ? [{ id: 'home', label: t("الرئيسية"), icon: Home }, { id: 'rooms', label: t("الحصص المحجوزة"), icon: Video }, { id: 'messages', label: t("الرسائل"), icon: MessageCircle }, { id: 'packages', label: t("باقاتي"), icon: PackageCheck }, { id: 'tutors', label: t("أساتذتي"), icon: Users }, { id: 'wallet', label: t("المحفظة"), icon: Wallet }, { id: 'history', label: t("السجل"), icon: History }]
    : portal === 'teachers'
    ? [{ id: 'home', label: t("الرئيسية"), icon: Home }, { id: 'rooms', label: t("الحصص المحجوزة"), icon: Video }, { id: 'messages', label: t("الرسائل"), icon: MessageCircle }, { id: 'available', label: t("المتاحة"), icon: Clock3 }, { id: 'packages', label: t("الباقات"), icon: PackageCheck }, { id: 'earnings', label: t("المستحقات"), icon: Wallet }]
    : [{ id: 'bookings', label: t("الحصص والحجوزات"), icon: CalendarDays },
      { id: 'reports', label: t('شكاوى الحصص'), icon: ShieldAlert },
      ...(portal === 'admin' ? [{ id: 'users', label: t("الحسابات"), icon: Users }, { id: 'topups', label: t("شحن المحافظ"), icon: WalletCards }, { id: 'audit', label: t("سجل العمليات"), icon: ClipboardList }] : [{ id: 'slots', label: t("مواعيدي المتاحة"), icon: Search }]),
      { id: 'payments', label: t("مستحقات الأساتذة"), icon: Wallet },
      { id: 'catalog', label: t("التصنيفات والمواد"), icon: ClipboardList },
      { id: 'profile', label: t("حسابي"), icon: Settings }];
  const accountAvatar = user.avatar_url && user.status === 'active' ? <span className="account-avatar has-photo"><img src={apiMediaUrl(user.avatar_url)} alt="" /></span> : <span className="account-avatar">{user.name.trim().charAt(0)}</span>;
  const learningAccountMenu = (className: string) => <details className={`account-menu ${className}`}><summary title={t('خيارات الحساب')}>{accountAvatar}<span className="account-name">{user.name}</span><ChevronDown size={15} /></summary><div className="account-dropdown"><button onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); setView('profile'); }}><Settings size={16} />{t("حسابي")}</button><div className="account-preferences"><PreferenceControls /></div><button className="account-reminders" aria-pressed={lessonReminders.enabled} onClick={() => toggleLessonReminders.current()}>{lessonReminders.enabled ? <Bell size={16} /> : <BellOff size={16} />}<span><strong>{t("تنبيهات الحصص")}</strong><small>{lessonReminders.enabled ? t("مفعّلة") : t("غير مفعّلة")}</small></span></button>{lessonReminders.hint && <small className="account-reminder-hint" role="status">{t(lessonReminders.hint)}</small>}<button type="button" onClick={() => void installAndroidApp()}><Download size={16} />{t("تثبيت تطبيق أندرويد")}</button><button className="account-logout" onClick={logout}><LogOut size={16} />{t("تسجيل الخروج")}</button></div></details>;
  return <main className={`app-shell business-shell redesigned-shell portal-${portal} ${portal !== 'admin' ? 'learning-shell' : ''}`} dir={direction()}>
    <a className="skip-link" href="#main-content">{t("انتقل إلى المحتوى")}</a>
    <aside className="sidebar"><button className="brand" onClick={() => setView(portal === 'admin' ? 'bookings' : 'home')} title="امتداد العلم"><img className="brand-monogram" src={assetUrl('icon.svg')} width="38" height="38" alt="" /><div><strong>امتداد العلم<span className="brand-dot">.</span></strong><span>{t(portalNames[portal])}</span></div></button>
      <nav className="nav-list" aria-label={t("التنقل الرئيسي")}>{nav.map(({ id, label, icon: Icon }) => <button key={id} aria-label={`${label}${id === 'rooms' && roomLive ? ' LIVE' : ''}`} aria-current={view === id ? 'page' : undefined} className={`nav-button ${view === id ? 'active' : ''}`} onClick={() => setView(id)}><Icon size={20} strokeWidth={1.8} /><span className="nav-label-full">{t(label)}</span><span className="nav-label-short">{id === 'bookings' ? t("الحجوزات") : id === 'audit' ? t("العمليات") : id === 'catalog' ? t("المواد") : label}</span>{id === 'rooms' && roomLive && <span className="nav-live"><span aria-hidden="true" />LIVE</span>}{id === 'messages' && chat.unread > 0 && <span className="nav-unread" aria-label={t("{v0} رسائل غير مقروءة", { v0: chat.unread })}>{chat.unread > 99 ? '99+' : chat.unread}</span>}</button>)}</nav>
      {portal !== 'admin' ? learningAccountMenu('sidebar-account') : <div className="sidebar-footer"><button type="button" onClick={() => void installAndroidApp()} className="icon-button" title={t("تثبيت تطبيق أندرويد")}><Download size={19} /></button><button className="icon-button" onClick={logout} title={t("تسجيل الخروج")}><LogOut size={19} /></button></div>}
    </aside>
    {portal !== 'admin' && learningAccountMenu('mobile-account')}
    <section className="workspace">{portal === 'admin' && <header className="topbar">
      <div className="topbar-location"><img className="mobile-brand brand-monogram" src={assetUrl('icon.svg')} width="32" height="32" alt="امتداد العلم" /><div><span className="eyebrow">{t(portalNames[portal])}</span><h1>{nav.find(n => n.id === view)?.label}</h1></div></div>
      {portal === 'admin' && <div className="topbar-actions"><time className="topbar-date"><CalendarDays size={17} />{new Date().toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' })}</time>
        <PreferenceControls />
        <button className="icon-button quick-action" onClick={openQuickAction} title={t("إدارة الحسابات")}><Users size={19} /></button>
        <details className="account-menu"><summary>{accountAvatar}<span className="account-name">{user.name}</span><ChevronDown size={15} /></summary><div><button onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); setView('profile'); }}><Settings size={16} />{t("حسابي")}</button><button type="button" onClick={() => void installAndroidApp()}><Download size={16} />{t("تثبيت تطبيق أندرويد")}</button><button onClick={logout}><LogOut size={16} />{t("تسجيل الخروج")}</button></div></details>
      </div>}</header>}
      <div className={`workspace-content ${portal !== 'admin' && view === 'home' ? 'home-workspace-content' : ''}`} id="main-content" tabIndex={-1}>
      {portal === 'teachers' && view === 'profile' && <div className="teacher-profile-rating-summary"><Star fill="currentColor" /><span><small>{t('تقييمك على المنصة')}</small><strong>{user.teacher_rating_count && user.teacher_rating !== null && user.teacher_rating !== undefined ? `${user.teacher_rating.toFixed(1)} / 5` : t('لم تُقيّم بعد')}</strong>{Boolean(user.teacher_rating_count) && <em>{t('{v0} تقييم', { v0: user.teacher_rating_count || 0 })}</em>}</span></div>}
      {error && <p className="notice error" role="alert">{t(error)}</p>}
      {user.status === 'suspended' ? <p className="notice error">{t("حسابك موقوف. راجع الإدارة.")}</p> : user.status === 'pending' && portal === 'teachers' && user.verification?.verification_status !== 'submitted' && user.verification?.verification_status !== 'approved' ? <RegistrationFlow portal="teachers" existingUser={user} onLogin={setUser} onCancel={logout} /> : user.status === 'pending' && view !== 'profile' ? <section className="empty-state"><ShieldCheck size={34} /><h2>{t("طلبك قيد المراجعة")}</h2><p>{t("وصلت بياناتك وصورتك وفيديو التحقق والمستندات إلى الأونر. سنفعّل الحساب بعد المراجعة.")}</p><button className="secondary-button" onClick={() => setRetry(retry + 1)}>{t("تحديث حالة الطلب")}</button></section> : <PortalWorkspace key={user.id} portal={portal} user={user} view={view} onUser={setUser} onView={setView} onRoomLiveChange={setRoomLive} onReminderControls={captureLessonReminders} searchFocusKey={searchFocusKey} />}
      {portal !== 'admin' && user.status === 'active' && <div hidden={view !== 'messages'}><Suspense fallback={<p role="status">{t("جارٍ تجهيز الرسائل…")}</p>}><DirectMessages key={user.id} portal={portal} user={user} chat={chat} active={view === 'messages'} /></Suspense></div>}
      </div></section>
    {bookingAlert && <button className="booking-created-toast" type="button" onClick={() => { setView('rooms'); setBookingAlert(null); }}><Bell size={21} /><span><strong>{t(bookingAlert.audience === 'teacher' ? 'حجز جديد' : 'تم تأكيد حجزك')}</strong><small>{bookingAlert.audience === 'teacher' ? t('حجز طالب حصة جديدة معك. افتح الحصص المحجوزة للتفاصيل.') : t('تم حجز الحصة بنجاح وأضيفت إلى حصصك المحجوزة.')}</small>{(bookingAlert.audience === 'teacher' ? bookingAlert.student_phone : bookingAlert.teacher_phone) && <b dir="ltr">{bookingAlert.audience === 'teacher' ? bookingAlert.student_phone : bookingAlert.teacher_phone}</b>}</span></button>}
    {portal !== 'admin' && supportWhatsapp && <a className="support-whatsapp" href={`https://wa.me/${whatsappHrefNumber(supportWhatsapp)}?text=${encodeURIComponent(t('مرحباً، أحتاج مساعدة في منصة امتداد العلم'))}`} target="_blank" rel="noreferrer" aria-label={t('التواصل مع الدعم عبر واتساب')}><WhatsAppIcon /><span><small>{t('الدعم الفني')}</small><strong dir="ltr">{supportWhatsapp}</strong></span></a>}
  </main>;
}
