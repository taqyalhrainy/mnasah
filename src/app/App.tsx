import { allowNavigation } from '../services/unsavedChanges';
import { lazyWithRetry } from './RecoveryBoundary';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Bell, BellOff, BellRing, Download, LogOut, CalendarDays, Users, Settings, Search, ClipboardList, Home, Wallet, WalletCards, History, Clock3, Video, ChevronDown, MessageCircle, ShieldCheck, ShieldAlert, Smartphone, Star, X } from 'lucide-react';
import { ChangeTemporaryPassword } from '../features/auth/ChangeTemporaryPassword';
import { apiMediaUrl, request, portalNames, type Portal, type User } from '../services/platformApi';
import '../styles/portal.css';
import { useDirectChat, type BookingCreatedNotice } from '../features/chat/useDirectChat';
import { useDeviceNotifications } from '../services/useDeviceNotifications';
import { removeDevicePush } from '../services/pushNotifications';
import { PreferenceControls, direction, usePreferences, t, locale } from '../i18n/preferences';
import { IosInstallGuide } from './IosInstallGuide';
import { NotificationPermissionHelp } from './NotificationPermissionHelp';
const DirectMessages = lazyWithRetry(() => import('../features/chat/DirectMessages').then(module => ({ default: module.DirectMessages })));
const AuthForm = lazyWithRetry(() => import('../features/auth/AuthForm').then(module => ({ default: module.AuthForm })));
const RegistrationFlow = lazyWithRetry(() => import('../features/auth/RegistrationFlow').then(module => ({ default: module.RegistrationFlow })));
const loadWorkspace = () => import('../features/portal/PortalWorkspace');
const PortalWorkspace = lazyWithRetry(() => loadWorkspace().then(module => ({ default: module.PortalWorkspace })));
const VideoTestPage = lazyWithRetry(() => import('../features/video/VideoTestPage').then(module => ({ default: module.VideoTestPage })));
type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };
type AdminNotificationCounts = Record<string, number>;
const portalNotificationViews: Record<Portal, string[]> = { admin: ['bookings', 'reports', 'users', 'topups', 'audit', 'payments', 'catalog', 'profile'], teachers: ['home', 'rooms', 'messages', 'available', 'earnings', 'profile'], students: ['home', 'rooms', 'messages', 'tutors', 'wallet', 'history', 'profile'] };
function notificationView(portal: Portal) {
  const query = new URLSearchParams(location.search);
  const view = query.get('view') || (query.has('lesson') ? (portal === 'admin' ? 'bookings' : 'rooms') : '');
  return portalNotificationViews[portal].includes(view) ? view : portal === 'admin' ? 'bookings' : 'home';
}
const defaultSupportWhatsapp = '0795764229';
const whatsappHrefNumber = (value: string) => {
  const digits = value.replace(/\D/g, '');
  return digits.startsWith('0') ? `962${digits.slice(1)}` : digits;
};

function currentPortal(): Portal {
  const part = routePath().split('/')[1];
  if (!part) { try { if (localStorage.getItem('emtidad-last-portal') === 'teachers') return 'teachers'; } catch {} }
  return part === 'owner' ? 'admin' : part === 'teachers' ? 'teachers' : 'students';
}
function rememberPortal(portal: Portal) { if (portal !== 'admin') try { localStorage.setItem('emtidad-last-portal', portal); } catch {} }
const baseUrl = import.meta.env.BASE_URL;
const basePath = baseUrl.replace(/\/$/, '');
const assetUrl = (path: string) => `${baseUrl}${path.replace(/^\//, '')}`;
const portalPath = (portal: Portal) => portal === 'admin' ? 'owner' : portal;
const appUrl = (portal: Portal) => `${basePath}/${portalPath(portal)}` || '/';
function routePath() {
  const path = location.pathname;
  return basePath && path.startsWith(`${basePath}/`) ? path.slice(basePath.length) : path;
}
export function App() {
  usePreferences();
  if (routePath() === '/video-test') return <Suspense fallback={<WakeLoading slow={false} attempt={0} />}><VideoTestPage /></Suspense>;
  if (routePath() === '/admin' || (['emtidad-alelm.onrender.com', 'mnasah.onrender.com'].includes(location.hostname) && routePath().startsWith('/owner'))) return <main className="loading-page" dir={direction()}><div className="wake-card"><ShieldAlert size={38} /><h1>{t('هذا الرابط غير متاح')}</h1><p>{t('بوابة الإدارة منفصلة ولا يمكن فتحها من رابط بوابات الطلاب والأساتذة.')}</p></div></main>;
  return <Suspense fallback={<WakeLoading slow={false} attempt={0} />}><PortalApp /></Suspense>;
}

const wakeRetryDelays = [1000, 2000];

function WakeLoading({ slow, attempt }: { slow: boolean; attempt: number }) {
  usePreferences();
  return <main className="loading-page wake-page" role="status" dir={direction()} aria-live="polite">
    <PreferenceControls />
    <div className="wake-card">
      <img src={assetUrl('images/emtidad-alelm-final-logo-192.png')} width="72" height="72" alt={t('شعار امتداد العلم أكاديمي')} />
      <div className="wake-spinner" aria-hidden="true" />
      <p className="wake-kicker">{t('امتداد العلم أكاديمي')}</p>
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
  const [view, setViewState] = useState(() => notificationView(portal));
  const setView = (next: string) => { if (next === view || allowNavigation()) setViewState(next); };
  const [roomLive, setRoomLive] = useState(false);
  const [retry, setRetry] = useState(0);
  const [searchFocusKey, setSearchFocusKey] = useState(0);
  const [lessonReminders, setLessonReminders] = useState({ enabled: false, hint: '' });
  const [supportWhatsapp, setSupportWhatsapp] = useState(defaultSupportWhatsapp);
  const [bookingAlert, setBookingAlert] = useState<BookingCreatedNotice | null>(null);
  const [adminNotificationsByView, setAdminNotificationsByView] = useState<AdminNotificationCounts>({});
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [iosGuideOpen, setIosGuideOpen] = useState(false);
  const [notificationPromptDismissed, setNotificationPromptDismissed] = useState(false);
  const deviceNotifications = useDeviceNotifications(portal, user?.id);
  useEffect(() => { setNotificationPromptDismissed(false); }, [user?.id]);
  useEffect(() => {
    const openNotification = (event: MessageEvent) => {
      if (event.data?.type !== 'platform-notification' || !portalNotificationViews[portal].includes(event.data.view)) return;
      void openView(event.data.view);
    };
    navigator.serviceWorker?.addEventListener('message', openNotification);
    return () => navigator.serviceWorker?.removeEventListener('message', openNotification);
  }, [portal, user?.id]);
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
  useEffect(() => {
    if (!user || portal !== 'admin') { setAdminNotificationsByView({}); return; }
    let alive = true;
    const load = () => request<{ unreadByView?: AdminNotificationCounts }>('admin/notifications').then(result => {
      if (!alive) return;
      setAdminNotificationsByView(result.unreadByView || {});
    }).catch(() => undefined);
    void load();
    const timer = window.setInterval(load, 12000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [portal, user?.id]);
  useEffect(() => { window.scrollTo({ top: 0, behavior: 'instant' }); }, [view]);
  useEffect(() => {
    const pop = () => { const next = currentPortal(); setPortal(next); setView(next === 'students' || next === 'teachers' ? 'home' : 'bookings'); setRoomLive(false); };
    addEventListener('popstate', pop); return () => removeEventListener('popstate', pop);
  }, []);
  useEffect(() => {
    let alive = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const slowTimer = setTimeout(() => { if (alive) setSlowWake(true); }, 1800);
    try { if (localStorage.getItem('emtidad-last-portal')) void loadWorkspace().catch(() => undefined); } catch { /* Storage is optional. */ }
    setLoading(true); setError('');
    request<{ user: User | null }>(`auth/me?portal=${portal}${portal !== 'admin' ? '&discover=1' : ''}`, undefined, controller.signal, 10000).then(result => {
      if (!alive) return;
      setUser(result.user);
      if (result.user) {
        rememberPortal(result.user.role);
        if (result.user.role !== portal || routePath() === '/') { history.replaceState({}, '', `${appUrl(result.user.role)}${location.search}`); setPortal(result.user.role); }
      }
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
      controller.abort();
    };
  }, [retry, portal, wakeAttempt]);
  async function logout() {
    if (!allowNavigation()) return;
    await removeDevicePush(portal).catch(() => undefined);
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
  async function openView(nextView: string) {
    setView(nextView);
    if (portal !== 'admin' || !adminNotificationsByView[nextView]) return;
    try {
      const result = await request<{ unreadByView?: AdminNotificationCounts }>('admin/notifications', { view: nextView });
      setAdminNotificationsByView(result.unreadByView || {});
    } catch { /* Opening the section must never be blocked by notification bookkeeping. */ }
  }
  if (loading) return <WakeLoading slow={slowWake || wakeAttempt > 0} attempt={wakeAttempt} />;
  if (error && !user) return <main className="loading-page wake-page" dir={direction()}><div className="wake-card"><p role="alert">{t(error)}</p><button className="primary-button" onClick={() => { setWakeAttempt(0); setRetry(retry + 1); }}>{t("إعادة المحاولة")}</button></div></main>;
  if (!user) return <AuthForm key={portal} portal={portal} onLogin={account => { rememberPortal(account.role); history.replaceState({}, '', appUrl(account.role)); setPortal(account.role); setViewState(account.role === 'admin' ? 'bookings' : 'home'); setUser(account); }} />;
  if (user.mustChangePassword && portal === user.role) return <ChangeTemporaryPassword user={user} onComplete={() => setUser(null)} />;
  if (portal !== user.role) return <main className="loading-page" dir={direction()}><h1>{t("هذا القسم غير متاح لحسابك")}</h1><a className="primary-button" href={appUrl(user.role)}>{t("العودة إلى قسمك")}</a><button className="text-button" onClick={logout}>{t("تسجيل الخروج")}</button></main>;
  const nav = portal === 'students'
    ? [{ id: 'home', label: t("الرئيسية"), icon: Home }, { id: 'rooms', label: t("الحصص المحجوزة"), icon: Video }, { id: 'messages', label: t("الرسائل"), icon: MessageCircle }, { id: 'tutors', label: t("أساتذتي"), icon: Users }, { id: 'wallet', label: t("المحفظة"), icon: Wallet }, { id: 'history', label: t("السجل"), icon: History }]
    : portal === 'teachers'
    ? [{ id: 'home', label: t("الرئيسية"), icon: Home }, { id: 'rooms', label: t("الحصص المحجوزة"), icon: Video }, { id: 'messages', label: t("الرسائل"), icon: MessageCircle }, { id: 'available', label: t("المتاحة"), icon: Clock3 }, { id: 'earnings', label: t("المستحقات"), icon: Wallet }]
    : [{ id: 'bookings', label: t("الحصص والحجوزات"), icon: CalendarDays },
      { id: 'reports', label: t('شكاوى الحصص'), icon: ShieldAlert },
      ...(portal === 'admin' ? [{ id: 'users', label: t("الحسابات"), icon: Users }, { id: 'topups', label: t("شحن المحافظ"), icon: WalletCards }, { id: 'audit', label: t("سجل العمليات"), icon: ClipboardList }] : [{ id: 'slots', label: t("مواعيدي المتاحة"), icon: Search }]),
      { id: 'payments', label: t("مستحقات الأساتذة"), icon: Wallet },
      { id: 'catalog', label: t("التصنيفات والمواد"), icon: ClipboardList },
      { id: 'profile', label: t("حسابي"), icon: Settings }];
  const accountAvatar = user.avatar_url && user.status === 'active' ? <span className="account-avatar has-photo"><img src={apiMediaUrl(user.avatar_url)} alt="" /></span> : <span className="account-avatar">{user.name.trim().charAt(0)}</span>;
  const learningAccountMenu = (className: string) => <details className={`account-menu ${className}`}><summary title={t('خيارات الحساب')}>{accountAvatar}<span className="account-name">{user.name}</span><ChevronDown size={15} /></summary><div className="account-dropdown"><button onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); setView('profile'); }}><Settings size={16} />{t("حسابي")}</button><div className="account-preferences"><PreferenceControls /></div><button className="account-reminders" aria-pressed={lessonReminders.enabled} onClick={() => toggleLessonReminders.current()}>{lessonReminders.enabled ? <Bell size={16} /> : <BellOff size={16} />}<span><strong>{t("تنبيهات الحصص")}</strong><small>{lessonReminders.enabled ? t("مفعّلة") : t("غير مفعّلة")}</small></span></button>{lessonReminders.hint && <small className="account-reminder-hint" role="status">{t(lessonReminders.hint)}</small>}<button className="account-reminders device-notification-toggle" type="button" disabled={deviceNotifications.busy} aria-pressed={deviceNotifications.enabled} onClick={() => void deviceNotifications.toggle()}>{deviceNotifications.enabled ? <BellRing size={17} /> : <BellOff size={17} />}<span><strong>{t(deviceNotifications.enabled ? 'إشعارات الهاتف مفعّلة' : 'تفعيل إشعارات الهاتف')}</strong><small>{t('تصل حتى عند إغلاق التطبيق')}</small></span></button>{deviceNotifications.hint && <small className="account-reminder-hint" role="status">{t(deviceNotifications.hint)}</small>}<button type="button" onClick={() => void installAndroidApp()}><Download size={16} />{t("تثبيت تطبيق أندرويد")}</button><button type="button" onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); setIosGuideOpen(true); }}><Smartphone size={16} />{t('تثبيت على iPhone')}</button><button className="account-logout" onClick={logout}><LogOut size={16} />{t("تسجيل الخروج")}</button></div></details>;
  return <main className={`app-shell business-shell redesigned-shell portal-${portal} ${portal !== 'admin' ? 'learning-shell' : ''} ${iosGuideOpen ? 'ios-guide-active' : ''}`} dir={direction()}>
    <a className="skip-link" href="#main-content">{t("انتقل إلى المحتوى")}</a>
    <aside className="sidebar"><button className="brand" onClick={() => setView(portal === 'admin' ? 'bookings' : 'home')} title={t('امتداد العلم أكاديمي')}><img className="brand-monogram" src={assetUrl('images/emtidad-alelm-final-logo-192.png')} width="44" height="44" alt={t('شعار امتداد العلم أكاديمي')} /><div><strong>{t('امتداد العلم')}<span className="brand-dot">.</span></strong><span>{t(portalNames[portal])}</span></div></button>
      <nav className="nav-list" aria-label={t("التنقل الرئيسي")}>{nav.map(({ id, label, icon: Icon }) => <button key={id} aria-label={`${label}${id === 'rooms' && roomLive ? ' LIVE' : ''}`} aria-current={view === id ? 'page' : undefined} className={`nav-button ${view === id ? 'active' : ''}`} onClick={() => void openView(id)}><Icon size={20} strokeWidth={1.8} /><span className="nav-label-full">{t(label)}</span><span className="nav-label-short">{id === 'bookings' ? t("الحجوزات") : id === 'audit' ? t("العمليات") : id === 'catalog' ? t("المواد") : label}</span>{id === 'rooms' && roomLive && <span className="nav-live"><span aria-hidden="true" />LIVE</span>}{id === 'messages' && chat.unread > 0 && <span className="nav-unread" aria-label={t("{v0} رسائل غير مقروءة", { v0: chat.unread })}>{chat.unread > 99 ? '99+' : chat.unread}</span>}{portal === 'admin' && Number(adminNotificationsByView[id] || 0) > 0 && <span className="nav-unread admin-section-unread" aria-label={t('{v0} إشعارات جديدة', { v0: adminNotificationsByView[id] })}>{adminNotificationsByView[id] > 99 ? '99+' : adminNotificationsByView[id]}</span>}</button>)}</nav>
      {portal !== 'admin' ? learningAccountMenu('sidebar-account') : <div className="sidebar-footer"><button type="button" onClick={() => void installAndroidApp()} className="icon-button" title={t("تثبيت تطبيق أندرويد")}><Download size={19} /></button><button className="icon-button" onClick={logout} title={t("تسجيل الخروج")}><LogOut size={19} /></button></div>}
    </aside>
    {portal !== 'admin' && learningAccountMenu('mobile-account')}
    <section className="workspace">{portal === 'admin' && <header className="topbar">
      <div className="topbar-location"><img className="mobile-brand brand-monogram" src={assetUrl('images/emtidad-alelm-final-logo-192.png')} width="36" height="36" alt={t('امتداد العلم أكاديمي')} /><div><span className="eyebrow">{t(portalNames[portal])}</span><h1>{nav.find(n => n.id === view)?.label}</h1></div></div>
      {portal === 'admin' && <div className="topbar-actions"><time className="topbar-date"><CalendarDays size={17} />{new Date().toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' })}</time>
        <PreferenceControls />
        <button className="icon-button quick-action" onClick={openQuickAction} title={t("إدارة الحسابات")}><Users size={19} /></button>
        <details className="account-menu"><summary>{accountAvatar}<span className="account-name">{user.name}</span><ChevronDown size={15} /></summary><div className="account-dropdown owner-account-dropdown"><button onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); setView('profile'); }}><Settings size={16} />{t("حسابي")}</button><button className="account-reminders device-notification-toggle" type="button" disabled={deviceNotifications.busy} aria-pressed={deviceNotifications.enabled} onClick={() => void deviceNotifications.toggle()}>{deviceNotifications.enabled ? <Bell size={17} /> : <BellOff size={17} />}<span><strong>{t(deviceNotifications.busy ? 'جارٍ تجهيز التنبيهات…' : deviceNotifications.enabled ? 'إيقاف التنبيهات' : 'تفعيل التنبيهات')}</strong><small>{t(deviceNotifications.enabled ? 'مفعّلة على هذا الجهاز' : 'تنبيهات الهاتف حتى عند إغلاق التطبيق')}</small></span></button>{deviceNotifications.enabled && <button type="button" disabled={deviceNotifications.busy} onClick={() => void deviceNotifications.test()}><Bell size={16} />{t('\u0625\u0631\u0633\u0627\u0644 \u0625\u0634\u0639\u0627\u0631 \u062a\u062c\u0631\u064a\u0628\u064a')}</button>}{deviceNotifications.hint && <small className="account-reminder-hint" role="status">{t(deviceNotifications.hint)}</small>}<button type="button" onClick={() => void installAndroidApp()}><Download size={16} />{t("تثبيت تطبيق أندرويد")}</button><button type="button" onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); setIosGuideOpen(true); }}><Smartphone size={16} />{t('تثبيت على iPhone')}</button><button onClick={logout}><LogOut size={16} />{t("تسجيل الخروج")}</button></div></details>
      </div>}</header>}
      <div className={`workspace-content ${portal !== 'admin' && view === 'home' ? 'home-workspace-content' : ''}`} id="main-content" tabIndex={-1}>
      {portal === 'teachers' && view === 'profile' && <div className="teacher-profile-rating-summary"><Star fill="currentColor" /><span><small>{t('تقييمك على المنصة')}</small><strong>{user.teacher_rating_count && user.teacher_rating !== null && user.teacher_rating !== undefined ? `${user.teacher_rating.toFixed(1)} / 5` : t('لم تُقيّم بعد')}</strong>{Boolean(user.teacher_rating_count) && <em>{t('{v0} تقييم', { v0: user.teacher_rating_count || 0 })}</em>}</span></div>}
      {error && <p className="notice error" role="alert">{t(error)}</p>}
      {user.status === 'suspended' ? <p className="notice error">{t("حسابك موقوف. راجع الإدارة.")}</p> : user.status === 'pending' && portal === 'teachers' && user.verification?.verification_status !== 'submitted' && user.verification?.verification_status !== 'approved' ? <RegistrationFlow portal="teachers" existingUser={user} onLogin={setUser} onCancel={logout} /> : user.status === 'pending' && view !== 'profile' ? <section className="empty-state"><ShieldCheck size={34} /><h2>{t("طلبك قيد المراجعة")}</h2><p>{t("وصلت بياناتك وصورتك وفيديو التحقق والمستندات إلى الأونر. سنفعّل الحساب بعد المراجعة.")}</p><button className="secondary-button" onClick={() => setRetry(retry + 1)}>{t("تحديث حالة الطلب")}</button></section> : <PortalWorkspace key={user.id} portal={portal} user={user} view={view} onUser={setUser} onView={setView} onRoomLiveChange={setRoomLive} onReminderControls={captureLessonReminders} searchFocusKey={searchFocusKey} />}
      {portal !== 'admin' && user.status === 'active' && <div hidden={view !== 'messages'}><Suspense fallback={<p role="status">{t("جارٍ تجهيز الرسائل…")}</p>}><DirectMessages key={user.id} portal={portal} user={user} chat={chat} active={view === 'messages'} /></Suspense></div>}
      </div></section>
    {iosGuideOpen && <IosInstallGuide onClose={() => setIosGuideOpen(false)} />}
    {deviceNotifications.permissionHelpOpen && <NotificationPermissionHelp busy={deviceNotifications.busy} onCheck={() => void deviceNotifications.toggle()} onClose={deviceNotifications.closePermissionHelp} />}
    {user.status === 'active' && (deviceNotifications.isAndroid || deviceNotifications.isDesktop) && deviceNotifications.supported && deviceNotifications.checked && deviceNotifications.needsPermission && !notificationPromptDismissed && <aside className="device-notification-prompt" role="dialog" aria-label={t('تفعيل إشعارات الجهاز')}><span><BellRing size={22} /></span><div><strong>{t(deviceNotifications.isDesktop ? 'فعّل إشعارات امتداد العلم على اللابتوب' : 'فعّل إشعارات امتداد العلم')}</strong><p>{t(deviceNotifications.permission === 'denied' ? (deviceNotifications.isDesktop ? 'الإشعارات محظورة من إعدادات المتصفح. اسمح بها لهذا الموقع من علامة القفل بجانب الرابط، ثم حاول مرة أخرى.' : 'الإشعارات مرفوضة من إعدادات الهاتف. فعّلها من إعدادات Chrome أو التطبيق ثم ارجع وحاول.') : (deviceNotifications.isDesktop ? 'اسمح بالإشعارات لتظهر على اللابتوب حتى لو كنت تتصفح موقعًا آخر أو كانت المنصة في الخلفية.' : 'اسمح بالإشعارات لتصلك الرسائل والحجوزات على الهاتف حتى عند إغلاق التطبيق.'))}</p>{deviceNotifications.hint && <small>{t(deviceNotifications.hint)}</small>}<button type="button" className="primary-button" disabled={deviceNotifications.busy} onClick={() => void deviceNotifications.toggle()}>{t(deviceNotifications.permission === 'denied' ? 'تحقق مرة أخرى' : 'السماح بالإشعارات')}</button></div><button type="button" className="notification-prompt-close" aria-label={t('ليس الآن')} onClick={() => setNotificationPromptDismissed(true)}><X size={18} /></button></aside>}
    {bookingAlert && <button className="booking-created-toast" type="button" onClick={() => { setView('rooms'); setBookingAlert(null); }}><Bell size={21} /><span><strong>{t(bookingAlert.audience === 'teacher' ? 'حجز جديد' : 'تم تأكيد حجزك')}</strong><small>{bookingAlert.audience === 'teacher' ? t('حجز طالب حصة جديدة معك. افتح الحصص المحجوزة للتفاصيل.') : t('تم حجز الحصة بنجاح وأضيفت إلى حصصك المحجوزة.')}</small>{(bookingAlert.audience === 'teacher' ? bookingAlert.student_phone : bookingAlert.teacher_phone) && <b dir="ltr">{bookingAlert.audience === 'teacher' ? bookingAlert.student_phone : bookingAlert.teacher_phone}</b>}</span></button>}
    {portal !== 'admin' && supportWhatsapp && <a className="support-whatsapp" href={`https://wa.me/${whatsappHrefNumber(supportWhatsapp)}?text=${encodeURIComponent(t('مرحباً، أحتاج مساعدة في منصة امتداد العلم'))}`} target="_blank" rel="noreferrer" aria-label={t('التواصل مع الدعم عبر واتساب')}><span><small>{t('الدعم الفني')}</small><strong dir="ltr">{supportWhatsapp}</strong></span></a>}
  </main>;
}
