import { t, locale, direction, usePreferences, catalogText, searchText } from '../../i18n/preferences';
import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { BookOpen, CalendarDays, CalendarPlus, Check, ChevronLeft, CircleAlert, Download, History as HistoryIcon, RefreshCw, Search, Send, UserRound, Video, X, Save, Bell, BellOff, Clock3, BadgeCheck, ArrowRight, Plus, Trash2, PackageCheck, ShoppingBag, Star, Phone } from 'lucide-react';
import { ApiError, request, requestFile, apiMediaUrl, date, money, statusNames, type Booking, type Slot, type SlotOffering, type Portal, type User, type Message, type CustomPackage, type WalletData, type CancellationQuote, type LessonPackage, type PackagePurchase, type PackageAvailabilityDay, type WeeklySchedule } from '../../services/platformApi';
import { useLessonReminders, reminderPhase } from './useLessonReminders';
import { AccountsPanel } from './AccountsPanel';
import { CatalogPanel } from './CatalogPanel';
import { PaymentsPanel } from './PaymentsPanel';
import { WalletPanel } from './WalletPanel';
import { TopupReviewPanel } from './TopupReviewPanel';
import { WorkspaceOverview, WorkspaceSkeleton } from './WorkspaceOverview';
import { TeacherAvailabilityHub, type AvailabilityDraft } from './TeacherAvailabilityHub';
import { LessonPackagesPanel } from './LessonPackagesPanel';
import { ReportsPanel } from './ReportsPanel';
import type { Category } from '../../services/platformApi';
import { GraduationCap, Library, Languages, PenLine, Sparkles, Sprout } from 'lucide-react';
const VideoRoom = lazy(() => import('../video/VideoRoom').then(module => ({ default: module.VideoRoom })));

function CategoryIcon({ value }: { value: string }) {
  const icons: Record<string, typeof Library> = { '📚': Library, '☘': Sprout, '✍': PenLine, EN: Languages, '🎓': GraduationCap, '✨': Sparkles };
  const Icon = icons[value];
  return Icon ? <Icon size={22} strokeWidth={1.7} /> : <>{value}</>;
}

type EventRow = { id: string; name: string; action: string; target: string; created: number };
type Room = { id: string; room: string; role: 'teacher' | 'student'; scheduledEnd: number };
type TeacherProfileData = { teacher: User; reviews: Array<{ rating: number; review: string; created: number; student_name: string }> };
const actionNames: Record<string, string> = { 'user:password-reset': 'إصدار كلمة مرور مؤقتة', 'user:active': 'تفعيل حساب', 'user:suspended': 'إيقاف حساب', 'booking:cancel': 'إلغاء حصة', 'payment:received': 'تسجيل دفعة', 'payment:reversed': 'عكس دفعة' };
actionNames['user:deleted'] = 'حذف حساب';
const formData = (form: HTMLFormElement) => Object.fromEntries(new FormData(form));
const timeOnly = (value: number) => new Date(value).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
const packageWeekDays = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const PackageSchedule = ({ rows }: { rows: WeeklySchedule[] }) => rows.length ? <div className="package-schedule-summary"><CalendarDays size={17} /><div>{rows.map(row => <span key={row.weekday}>{t(packageWeekDays[row.weekday])} <b dir="ltr">{row.from}–{row.to}</b></span>)}</div></div> : null;
const normalizedSearch = (value: string) => value.normalize('NFKD').toLocaleLowerCase().replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/[أإآ]/g, 'ا').replace(/ؤ/g, 'و').replace(/ئ|ى/g, 'ي').replace(/ة/g, 'ه').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const searchKeys = (value: string) => { const normalized = normalizedSearch(value).replaceAll(' ', ''); return [normalized, normalized.replace(/[اوي]/g, '')].filter(key => key.length > 1); };
const fuzzyMatch = (left: string, right: string) => searchKeys(left).some(a => searchKeys(right).some(b => a.includes(b) || b.includes(a)));
const teachesSubject = (list: string, subject: string) => list.split(' | ').some(item => fuzzyMatch(item, subject));
const legacyTeacherSubjects = (value = '') => [...new Set(value.split(' | ').map(entry => { const parts = entry.split(' › ').map(item => item.trim()); return parts.length > 1 ? parts[1] : entry.trim(); }).filter(Boolean))];
const slotSubjects = (slot: Slot) => slot.subjects?.filter(Boolean).length
  ? [...new Set(slot.subjects.filter(Boolean))]
  : slot.subject === 'كل المواد المختارة' && slot.teacher_subjects ? legacyTeacherSubjects(slot.teacher_subjects) : [slot.subject].filter(Boolean);
const slotOfferings = (slot: Slot): SlotOffering[] => slot.offerings?.filter(item => [30, 45, 60, 90, 120].includes(item.minutes) && Number.isInteger(item.price)).length
  ? [...new Map(slot.offerings.filter(item => [30, 45, 60, 90, 120].includes(item.minutes) && Number.isInteger(item.price)).map(item => [item.minutes, item])).values()].sort((left, right) => left.minutes - right.minutes)
  : [{ minutes: slot.minutes, price: slot.price }];
const availableBookingStarts = (slot: Slot, minutes: number) => {
  if (!minutes) return [];
  const step = 5 * 60000;
  const windowEnd = Number(slot.available_until || slot.start + slot.minutes * 60000);
  const first = Math.max(Number(slot.start), Math.ceil((Date.now() + 1000) / step) * step);
  const occupied = slot.booked_ranges || [];
  const starts: number[] = [];
  for (let start = first; start + minutes * 60000 <= windowEnd; start += step) {
    const end = start + minutes * 60000;
    if (!occupied.some(range => start < range.end && end > range.start)) starts.push(start);
  }
  return starts;
};
type TeachingChoice = { categoryId: string; categoryName: string; subject: string; levels: string[] };
const teachingChoiceKey = (categoryId: string, subject: string) => `${categoryId}\u0000${subject}`;
const uniqueTeachingChoices = (choices: TeachingChoice[]) => [...new Map(choices.map(choice => [teachingChoiceKey(choice.categoryId, choice.subject), choice])).values()];
const serializeTeachingChoices = (choices: TeachingChoice[]) => choices.map(choice => [choice.categoryName, choice.subject, choice.levels.join('، ')].filter(Boolean).join(' › ')).join(' | ');
const teachingChoiceLabel = (choice: TeachingChoice, category?: Category) => [t(choice.categoryName), catalogText(choice.subject), ...(category?.levels.length ? [choice.levels.length === category.levels.length ? t('كل المستويات') : choice.levels.map(catalogText).join('، ')] : [])].join(' › ');
function parseTeachingChoices(value: string, catalog: Category[]) {
  if (!value || !catalog.length) return [];
  const choices: TeachingChoice[] = [];
  for (const entry of value.split(' | ').map(item => item.trim()).filter(Boolean)) {
    const parts = entry.split(' › ').map(item => item.trim());
    if (parts.length >= 2) {
      const category = catalog.find(item => item.name === parts[0]);
      if (!category || !category.subjects.includes(parts[1])) continue;
      const selected = parts[2] ? parts[2].split('،').map(item => item.trim()).filter(level => category.levels.includes(level)) : [];
      choices.push({ categoryId: category.id, categoryName: category.name, subject: parts[1], levels: category.levels.length ? selected : [] });
      continue;
    }
    for (const category of catalog) {
      for (const subject of category.subjects) {
        if (entry !== subject && !entry.startsWith(`${subject} - `)) continue;
        const legacyLevel = entry.slice(subject.length + 3).trim();
        choices.push({ categoryId: category.id, categoryName: category.name, subject, levels: category.levels.length ? (legacyLevel && category.levels.includes(legacyLevel) ? [legacyLevel] : [...category.levels]) : [] });
      }
    }
  }
  return uniqueTeachingChoices(choices);
}

export function PortalWorkspace({ portal, user, view, onUser, onView, onRoomLiveChange, onReminderControls, searchFocusKey = 0 }: { portal: Portal; user: User; view: string; onUser: (u: User | null) => void; onView: (view: string) => void; onRoomLiveChange?: (live: boolean) => void; onReminderControls?: (enabled: boolean, hint: string, toggle: () => void) => void; searchFocusKey?: number }) {
  usePreferences();
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadedView, setLoadedView] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [roomFilter, setRoomFilter] = useState<'today' | 'tomorrow' | 'yesterday' | 'upcoming' | 'past' | 'all'>('today');
  const [studentStep, setStudentStep] = useState<'categories' | 'levels' | 'subjects' | 'tutors'>('categories');
  const [studentCategory, setStudentCategory] = useState('');
  const [catalog, setCatalog] = useState<Category[]>([]);
  const [categoryId, setCategoryId] = useState('');
  const [studentLevel, setStudentLevel] = useState('');
  const [studentSubject, setStudentSubject] = useState('');
  const [selectedTutorId, setSelectedTutorId] = useState('');
  const [teachingChoices, setTeachingChoices] = useState<TeachingChoice[]>([]);
  const [customPackages, setCustomPackages] = useState<CustomPackage[]>(() => user.custom_packages || []);
  const [teacherCategoryId, setTeacherCategoryId] = useState('');
  const [teacherPackageKey, setTeacherPackageKey] = useState('');
  const [buildingCustomPackage, setBuildingCustomPackage] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [bookingSlot, setBookingSlot] = useState<Slot | null>(null);
  const [bookingSubject, setBookingSubject] = useState('');
  const [bookingMinutes, setBookingMinutes] = useState(0);
  const [bookingStart, setBookingStart] = useState(0);
  const [profileAvatarVersion, setProfileAvatarVersion] = useState(0);
  const [profileAvatarAvailable, setProfileAvatarAvailable] = useState(false);
  const [walletRequired, setWalletRequired] = useState(0);
  const [insufficientWallet, setInsufficientWallet] = useState<{ balance: number; price: number } | null>(null);
  const [lessonPackages, setLessonPackages] = useState<LessonPackage[]>([]);
  const [packageDetails, setPackageDetails] = useState<LessonPackage | null>(null);
  const [packagePurchases, setPackagePurchases] = useState<PackagePurchase[]>([]);
  const [bookingPackage, setBookingPackage] = useState<PackagePurchase | null>(null);
  const [selectedPackagePurchase, setSelectedPackagePurchase] = useState('');
  const [packageAvailabilityDays, setPackageAvailabilityDays] = useState<PackageAvailabilityDay[]>([]);
  const [packageAvailabilityLoading, setPackageAvailabilityLoading] = useState(false);
  const [packageBookingDay, setPackageBookingDay] = useState('');
  const [packageBookingStart, setPackageBookingStart] = useState(0);
  const [packageBookingSubject, setPackageBookingSubject] = useState('');
  const [room, setRoom] = useState<Room | null>(null);
  const [callCompact, setCallCompact] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [ratingDraft, setRatingDraft] = useState(0);
  const [feedbackBooking, setFeedbackBooking] = useState<Booking | null>(null);
  const [feedbackReport, setFeedbackReport] = useState(false);
  const [feedbackCategory, setFeedbackCategory] = useState('teacher_inactive');
  const [feedbackReview, setFeedbackReview] = useState('');
  const [teacherProfile, setTeacherProfile] = useState<TeacherProfileData | null>(null);
  const [teacherProfileLoading, setTeacherProfileLoading] = useState(false);
  const reminders = useLessonReminders(portal, user.id, revision, room?.id);
  const focusedSearch = useRef(0);
  useEffect(() => { onReminderControls?.(reminders.enabled, reminders.hint, reminders.toggle); }, [reminders.enabled, reminders.hint, onReminderControls]);
  useEffect(() => {
    if (portal !== 'students' || view !== 'home' || loadedView !== view || loading || searchFocusKey === focusedSearch.current) return;
    const frame = requestAnimationFrame(() => {
      const input = document.querySelector<HTMLInputElement>('.student-search input');
      if (!input || document.querySelector('.workspace-skeleton')) return;
      input.scrollIntoView({ block: 'center', behavior: 'instant' });
      input.focus({ preventScroll: true });
      focusedSearch.current = searchFocusKey;
    });
    return () => cancelAnimationFrame(frame);
  }, [portal, view, loadedView, loading, searchFocusKey]);
  const refresh = () => setRevision(v => v + 1);
  useEffect(() => { setQuery(''); setFilter('all'); setSelected(null); setSuccess(''); if (view !== 'tutors') setSelectedTutorId(''); }, [view]);
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('lesson');
    if (view === 'bookings' && id && bookings.some(b => b.id === id)) {
      setSelected(id); history.replaceState({}, '', location.pathname);
    }
  }, [view, bookings]);
  useEffect(() => {
    const open = (event: MessageEvent) => {
      if (event.data?.type !== 'lesson-reminder' || typeof event.data.id !== 'string') return;
      history.replaceState({}, '', `/${portal}?lesson=${encodeURIComponent(event.data.id)}`);
      onView(portal === 'admin' ? 'bookings' : 'rooms'); setRevision(value => value + 1);
    };
    navigator.serviceWorker?.addEventListener('message', open);
    return () => navigator.serviceWorker?.removeEventListener('message', open);
  }, [portal, onView]);
  useEffect(() => {
    if (view === 'messages' || view === 'payments' || view === 'earnings' || view === 'wallet' || view === 'topups' || view === 'reports' || (portal === 'teachers' && view === 'packages')) return;
    let alive = true;
    setLoading(true); setError('');
    const path = portal === 'students' ? (view === 'home' || view === 'packages' ? 'slots' : view === 'profile' ? 'profile' : 'overview') : view === 'bookings' ? 'overview' : view;
    Promise.allSettled([
      request<{ bookings?: Booking[]; slots?: Slot[]; users?: User[]; events?: EventRow[] }>(`${portal}/${path}`),
      request<{ categories: Category[] }>(`${portal}/catalog`),
      portal === 'students' && (view === 'home' || view === 'packages') ? request<{ offers: LessonPackage[]; purchases: PackagePurchase[] }>('students/lesson-packages') : Promise.resolve(null),
      portal === 'students' && view === 'tutors' ? request<{ slots: Slot[] }>('students/slots') : Promise.resolve(null),
    ]).then(([dataResult, catalogResult, packagesResult, tutorSlotsResult]) => {
      if (!alive) return;
      if (catalogResult.status === 'fulfilled') setCatalog(catalogResult.value.categories);
      if (packagesResult.status === 'fulfilled' && packagesResult.value) { setLessonPackages(Array.isArray(packagesResult.value.offers) ? packagesResult.value.offers : []); setPackagePurchases(Array.isArray(packagesResult.value.purchases) ? packagesResult.value.purchases : []); }
      if (tutorSlotsResult.status === 'fulfilled' && tutorSlotsResult.value) setSlots(Array.isArray(tutorSlotsResult.value.slots) ? tutorSlotsResult.value.slots : []);
      if (dataResult.status === 'fulfilled') {
        const data = dataResult.value;
        if (data.bookings) setBookings(data.bookings);
        if (data.slots) setSlots(data.slots);
        if (data.users) setUsers(data.users);
        if (data.events) setEvents(data.events);
      }
      const failure = dataResult.status === 'rejected' ? dataResult.reason : catalogResult.status === 'rejected' ? catalogResult.reason : packagesResult.status === 'rejected' ? packagesResult.reason : tutorSlotsResult.status === 'rejected' ? tutorSlotsResult.reason : null;
      if (failure) setError(failure instanceof Error ? failure.message : t("تعذر تحميل بعض البيانات. حاول مجدداً."));
    }).finally(() => { if (alive) { setLoadedView(view); setLoading(false); } });
    return () => { alive = false; };
  }, [portal, view, revision]);
  useEffect(() => {
    if (portal === 'admin') { onRoomLiveChange?.(false); return; }
    let alive = true;
    const loadRooms = () => request<{ bookings: Booking[] }>(`${portal}/rooms`).then(result => {
      if (!alive) return;
      const roomBookings = Array.isArray(result.bookings) ? result.bookings : [];
      setBookings(roomBookings);
      const now = Date.now();
      const counterpartLive = roomBookings.some(booking => booking.status === 'confirmed' && Number(portal === 'students' ? booking.teacher_present_until : booking.student_present_until) > now);
      onRoomLiveChange?.(counterpartLive);
    }).catch(() => undefined);
    void loadRooms();
    const timer = window.setInterval(loadRooms, 10000);
    const visible = () => { if (document.visibilityState === 'visible') void loadRooms(); };
    document.addEventListener('visibilitychange', visible);
    return () => { alive = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); onRoomLiveChange?.(false); };
  }, [portal, revision, onRoomLiveChange]);
  useEffect(() => {
    if (catalog.length) setTeachingChoices(parseTeachingChoices(user.subject, catalog));
  }, [catalog, user.subject]);
  useEffect(() => { setCustomPackages(user.custom_packages || []); }, [user.custom_packages]);
  useEffect(() => {
    const purchase = packagePurchases.find(item => item.id === selectedPackagePurchase);
    setPackageAvailabilityDays([]); setPackageBookingDay(''); setPackageBookingStart(0); setPackageBookingSubject(purchase?.subjects.length === 1 ? purchase.subjects[0] : '');
    if (!purchase?.weekly_schedule?.length) return;
    let alive = true; setPackageAvailabilityLoading(true);
    request<{ days: PackageAvailabilityDay[] }>(`students/package-purchases/${purchase.id}/availability`)
      .then(result => { if (alive) setPackageAvailabilityDays(result.days || []); })
      .catch(cause => { if (alive) setError((cause as Error).message); })
      .finally(() => { if (alive) setPackageAvailabilityLoading(false); });
    return () => { alive = false; };
  }, [selectedPackagePurchase, packagePurchases]);
  useEffect(() => {
    if (!selected) return;
    let alive = true; setMessages([]);
    const load = () => request<{ messages: Message[] }>(`${portal}/bookings/${selected}/messages`).then(r => { if (alive) setMessages(r.messages); }).catch(e => { if (alive) setError(e.message); });
    void load(); const timer = setInterval(load, 10000);
    return () => { alive = false; clearInterval(timer); };
  }, [selected, portal]);
  useEffect(() => {
    if (!room) return;
    let alive = true;
    const loadMessages = () => request<{ messages: Message[] }>(`${portal}/bookings/${room.id}/messages`).then(result => { if (alive) setMessages(result.messages); }).catch(e => { if (alive) setError(e.message); });
    void loadMessages();
    const timer = window.setInterval(loadMessages, 1500);
    return () => { alive = false; window.clearInterval(timer); };
  }, [room, portal]);
  useEffect(() => {
    document.documentElement.classList.toggle('call-active', Boolean(room && !callCompact));
    return () => document.documentElement.classList.remove('call-active');
  }, [room, callCompact]);
  async function act(action: () => Promise<unknown>, message = t("تم حفظ التغييرات.")) {
    setBusy(true); setError(''); setSuccess('');
    try { await action(); setSuccess(message); refresh(); return true; }
    catch (e) { setError((e as Error).message); return false; }
    finally { setBusy(false); }
  }
  const post = (path: string, body: unknown = {}) => request(`${portal}/${path}`, body);
  const teacherAvatarEditor = portal === 'teachers' && <div className="profile-photo-settings"><label className="profile-photo-editor"><span className="profile-photo-preview"><UserRound size={28} />{user.avatar_url && <img src={`${apiMediaUrl(user.avatar_url)}?v=${profileAvatarVersion}`} alt={t('الصورة الشخصية')} onLoad={() => setProfileAvatarAvailable(true)} onError={event => { event.currentTarget.hidden = true; setProfileAvatarAvailable(false); }} />}</span><span><strong>{t('الصورة الشخصية')}</strong><small>{t('اختيارية ويمكن تعديلها في أي وقت')}</small></span><input type="file" accept="image/jpeg,image/png,image/webp" onChange={event => { const file = event.target.files?.[0]; if (!file) return; if (file.size > 5 * 1024 * 1024) { setError(t('الصورة أكبر من 5 ميغابايت.')); return; } void act(async () => { await requestFile('teachers/verification/files', file, { kind: 'avatar' }); setProfileAvatarVersion(Date.now()); }, t('تم تحديث الصورة الشخصية.')); }} /></label>{profileAvatarAvailable && <button type="button" className="secondary-button remove-profile-photo" disabled={busy} onClick={() => { if (!window.confirm(t('إزالة الصورة الشخصية'))) return; void act(async () => { await request('teachers/verification/avatar/remove', {}); setProfileAvatarAvailable(false); setProfileAvatarVersion(Date.now()); }, t('تمت إزالة الصورة الشخصية.')); }}><Trash2 size={17} />{t('إزالة الصورة الشخصية')}</button>}</div>;
  const current = bookings.find(b => b.id === selected);
  const currentSlot = slots.find(s => s.id === selectedSlot);
  const deleteSlot = (id: string) => { if (window.confirm(t("حذف هذا الموعد؟"))) void act(async () => { await post(`slots/${id}`); setSlots(rows => rows.filter(slot => slot.id !== id)); setSelectedSlot(null); }, t("تم حذف الموعد.")); };
  const matches = (value: string) => normalizedSearch(value).includes(normalizedSearch(query));
  const shownBookings = bookings.filter(b => matches(searchText(b.subject, b.teacher_name, b.student_name)) && (filter === 'all' || b.status === filter));
  const canJoinBooking = (booking: Booking) => booking.status === 'confirmed' && reminders.now >= booking.start - 15 * 60000;
  function exportBookings() {
    const safe = (value: unknown) => `"${String(value).replace(/^[=+@-]/, "'").replaceAll('"', '""')}"`;
    const rows = [[t("المادة"), t("الأستاذ"), t("الطالب"), t("الموعد"), t("الحالة"), t("السعر بالدينار"), t("مدفوع"), t("مرجع الدفعة")], ...shownBookings.map(b => [b.subject, b.teacher_name, b.student_name, date(b.start), statusNames[b.status], b.price / 100, b.paid ? t("نعم") : t("لا"), b.payment_ref])];
    const url = URL.createObjectURL(new Blob(['\uFEFF' + rows.map(r => r.map(safe).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = 'imtidad-bookings.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function join(b: Booking) {
    await act(async () => {
      const data = await request<Pick<Room, 'room' | 'role'>>(`${portal}/bookings/${b.id}/room`);
      setSelected(null);
      setMessages([]);
      setCallCompact(false);
      setRoom({ id: b.id, ...data, scheduledEnd: b.start + b.minutes * 60000 });
    }, t("الغرفة جاهزة."));
  }
  const cancel = async (b: Booking) => {
    try {
      const { quote } = await request<{ quote: CancellationQuote }>(`${portal}/bookings/${b.id}/cancellation`);
      const policy = portal === 'students'
        ? quote.packageCredit ? t('ستعود الحصة إلى رصيد باقتك لتتمكن من حجز موعد بديل.')
        : quote.refundPercent === 100 ? t('سيعود كامل المبلغ {v0} إلى محفظتك.', { v0: money(quote.refund) })
        : quote.refundPercent === 50 ? t('سيعود {v0} إلى محفظتك حسب سياسة الإلغاء بين 6 و24 ساعة.', { v0: money(quote.refund) })
        : t('لن يُسترد المبلغ لأن موعد الحصة خلال أقل من 6 ساعات.')
        : t('سيعود كامل المبلغ {v0} إلى محفظة الطالب.', { v0: money(quote.refund) });
      if (!window.confirm(`${t("إلغاء حصة {v0} بتاريخ {v1}؟", { v0: catalogText(b.subject), v1: date(b.start) })}\n\n${policy}`)) return;
      await act(() => post(`bookings/${b.id}/cancel`), t(quote.packageCredit ? 'تم إلغاء الحصة وإعادتها إلى رصيد باقتك.' : "تم إلغاء الحصة. يمكنك حجز موعد بديل من صفحة الأساتذة."));
    } catch (cause) { setError((cause as Error).message); }
  };
  const reportTeacherNoShow = async (b: Booking) => {
    if (!window.confirm(t('تأكيد أن الأستاذ لم يدخل الغرفة بعد مرور 10 دقائق؟ سيُراجع سجل الحضور ويعود كامل المبلغ لمحفظتك إذا ثبت الغياب.'))) return;
    await act(() => post(`bookings/${b.id}/report-no-show`), t('تم قبول بلاغ الغياب وإعادة كامل المبلغ إلى محفظتك.'));
  };
  const openTeacherProfile = async (teacherId: string) => {
    setTeacherProfileLoading(true); setError('');
    try { setTeacherProfile(await request<TeacherProfileData>(`students/teachers/${teacherId}/profile`)); }
    catch (cause) { setError((cause as Error).message); }
    finally { setTeacherProfileLoading(false); }
  };
  const rateTeacher = async (booking: Booking) => {
    const rating = ratingDraft || booking.student_rating || 0;
    if (!rating) { setError(t('اختر تقييماً بين 1 و5.')); return; }
    if (await act(() => post(`bookings/${booking.id}/rating`, { rating, review: feedbackReview }), t('شكراً، تم حفظ تقييمك وملاحظتك.'))) {
      setRatingDraft(0);
      setFeedbackReview('');
      await refresh();
    }
  };
  const submitLessonFeedback = async () => {
    if (!feedbackBooking) return;
    if (!ratingDraft && !feedbackReport) { setError(t('اختر تقييماً أو فعّل خيار إرسال شكوى.')); return; }
    if (feedbackReport && !feedbackReview.trim()) { setError(t('اكتب ملاحظة توضح سبب الشكوى.')); return; }
    if (await act(() => post(`bookings/${feedbackBooking.id}/feedback`, { rating: ratingDraft, review: feedbackReview, report: feedbackReport, category: feedbackCategory }), t(feedbackReport ? 'تم إرسال التقييم والشكوى للدعم الفني.' : 'شكراً، تم حفظ تقييمك.'))) {
      setFeedbackBooking(null); setFeedbackReport(false); setFeedbackReview(''); setRatingDraft(0);
    }
  };
  const openSlots = slots.filter(s => s.status === 'open' && (s.available_until || s.start + s.minutes * 60000) > Date.now() && (portal !== 'students' || slotOfferings(s).some(offering => availableBookingStarts(s, offering.minutes).length)) && matches(searchText(slotSubjects(s).join(' '), s.teacher_name || '', s.teacher_subjects || '')));
  const teacherMap = new Map<string, Booking>();
  bookings.forEach(b => { if (!teacherMap.has(b.teacher_id)) teacherMap.set(b.teacher_id, b); });
  const myTutors = [...teacherMap.values()];
  const categories = catalog.map(category => [category.id, category.name, category.description, category.icon] as const);
  const catalogSubjects = [...new Set(catalog.flatMap(category => category.subjects))];
  const teacherSubjects = [...new Set([...teachingChoices.map(choice => choice.subject), ...legacyTeacherSubjects(user.subject)])].filter(subject => catalogSubjects.includes(subject));
  const activeCategory = catalog.find(category => category.id === categoryId);
  const levels = activeCategory?.levels || [];
  const subjects = activeCategory?.subjects || [];
  function chooseCategory(id: string, title: string) {
    const category = catalog.find(item => item.id === id);
    setCategoryId(id); setStudentCategory(title); setStudentLevel(''); setStudentSubject('');
    setStudentStep(category?.levels.length ? 'levels' : category?.subjects.length ? 'subjects' : 'tutors');
  }
  function updateTeachingSubject(category: Category, subject: string, checked: boolean) {
    const key = teachingChoiceKey(category.id, subject);
    setTeachingChoices(current => checked
      ? uniqueTeachingChoices([...current, { categoryId: category.id, categoryName: category.name, subject, levels: [...category.levels] }])
      : current.filter(choice => teachingChoiceKey(choice.categoryId, choice.subject) !== key));
  }
  function updateTeachingLevel(category: Category, subject: string, level: string, checked: boolean) {
    const key = teachingChoiceKey(category.id, subject);
    setTeachingChoices(current => {
      const existing = current.find(choice => teachingChoiceKey(choice.categoryId, choice.subject) === key);
      const levels = checked ? [...new Set([...(existing?.levels || []), level])] : (existing?.levels || []).filter(item => item !== level);
      const without = current.filter(choice => teachingChoiceKey(choice.categoryId, choice.subject) !== key);
      return levels.length ? uniqueTeachingChoices([...without, { categoryId: category.id, categoryName: category.name, subject, levels: category.levels.filter(item => levels.includes(item)) }]) : without;
    });
  }
  const builtInPackages = catalog.flatMap(category => category.subjects.map(subject => ({ key: teachingChoiceKey(category.id, subject), category, subject })));
  const selectedBuiltInPackage = builtInPackages.find(item => item.key === teacherPackageKey);
  const selectedTeacherCategory = catalog.find(category => category.id === teacherCategoryId);
  const selectedCustomPackage = teacherPackageKey.startsWith('custom:') ? customPackages.find(item => `custom:${item.id}` === teacherPackageKey) : undefined;
  const commonLevels = [...new Set(catalog.flatMap(category => category.levels))];
  async function saveTeacherProfile(nextChoices = teachingChoices, nextPackages = customPackages, message = t('تم حفظ اختياراتك. اذهب إلى صفحة المتاحة لإعداد وقت نشر مادتك.')) {
    return act(async () => {
      const result = await request<{ user: User }>(`${portal}/profile`, { name: user.name, bio: user.bio, phone: user.phone, subject: serializeTeachingChoices(nextChoices), custom_packages: nextPackages });
      setCustomPackages(result.user.custom_packages || nextPackages);
      onUser(result.user);
    }, message);
  }
  async function createCustomPackage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get('name') || '').trim();
    if (!name) { setError(t('اكتب اسم الباقة أولاً.')); return; }
    const typedLevels = String(data.get('custom_levels') || '').split(/[،,\n]/).map(value => value.trim()).filter(Boolean);
    const levels = [...new Set([...data.getAll('level').map(String), ...typedLevels])];
    const item: CustomPackage = { id: crypto.randomUUID?.() || `custom-${Date.now()}`, name, description: String(data.get('description') || '').trim(), levels };
    const nextPackages = [...customPackages, item];
    setCustomPackages(nextPackages);
    setBuildingCustomPackage(false);
    setTeacherPackageKey(`custom:${item.id}`);
    await saveTeacherProfile(teachingChoices, nextPackages, t('تم إنشاء باقتك الخاصة وحفظها.'));
  }
  async function deleteCustomPackage(item: CustomPackage) {
    if (!window.confirm(t('حذف الباقة الخاصة {v0}؟', { v0: item.name }))) return;
    const nextPackages = customPackages.filter(value => value.id !== item.id);
    setCustomPackages(nextPackages); setTeacherPackageKey('');
    await saveTeacherProfile(teachingChoices, nextPackages, t('تم حذف الباقة الخاصة.'));
  }
  const subjectSlots = openSlots.filter(s => {
    if (!studentSubject) return true;
    const availableSubjects = slotSubjects(s);
    const slotMatchesSubject = availableSubjects.some(subject => subject === 'كل المواد المختارة' || fuzzyMatch(subject, studentSubject));
    const choices = parseTeachingChoices(s.teacher_subjects || '', catalog);
    if (choices.length) {
      const matching = choices.filter(choice => (!activeCategory || choice.categoryId === activeCategory.id) && fuzzyMatch(choice.subject, studentSubject));
      return slotMatchesSubject && matching.some(choice => !studentLevel || !activeCategory?.levels.length || choice.levels.includes(studentLevel));
    }
    const specialties = `${s.subject} ${s.teacher_subjects || ''}`;
    return fuzzyMatch(specialties, studentSubject) || (s.subject === 'كل المواد المختارة' && teachesSubject(s.teacher_subjects || '', studentSubject));
  });
  const studentSearch = <label className="student-search"><Search size={19} /><input aria-label={t("بحث")} placeholder={t("ابحث عن مادة أو أستاذ")} value={query} onChange={e => setQuery(e.target.value)} /></label>;
  const activePackagePurchases = packagePurchases.filter(item => item.status === 'active' && item.remaining_lessons > 0 && item.expires_at > Date.now());
  const slotsForPackage = (purchase: PackagePurchase) => openSlots.filter(slot => slot.teacher_id === purchase.teacher_id && slotSubjects(slot).some(subject => purchase.subjects.includes(subject)) && slotOfferings(slot).some(offering => offering.minutes === purchase.minutes && availableBookingStarts(slot, offering.minutes).some(start => start + offering.minutes * 60000 <= purchase.expires_at)));
  async function purchaseLessonPackage(item: LessonPackage) {
    setBusy(true); setError(''); setSuccess('');
    try {
      const wallet = await request<WalletData>('students/wallet');
      if (wallet.balance < item.price) { setWalletRequired(item.price); setPackageDetails(null); setInsufficientWallet({ balance: wallet.balance, price: item.price }); return; }
      if (!window.confirm(t('تأكيد شراء باقة {v0} من {v1} مقابل {v2}؟', { v0: item.name, v1: item.teacher_name || '', v2: money(item.price) }))) return;
      await request(`students/lesson-packages/${item.id}/purchase`, {});
      setSuccess(t('تم شراء الباقة. ستجدها الآن في «باقاتي».'));
      setSelectedPackagePurchase(''); refresh(); onView('packages');
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 402) { const wallet = await request<WalletData>('students/wallet').catch(() => ({ balance: 0 } as WalletData)); setWalletRequired(item.price); setPackageDetails(null); setInsufficientWallet({ balance: wallet.balance, price: item.price }); }
      else setError((cause as Error).message);
    } finally { setBusy(false); }
  }
  async function completeBooking(slot: Slot, subject: string, offering: SlotOffering, start: number, purchase?: PackagePurchase | null) {
    setBusy(true); setError(''); setSuccess('');
    try {
      if (!purchase) {
        const wallet = await request<WalletData>('students/wallet');
        if (wallet.balance < offering.price) { setWalletRequired(offering.price); setBookingSlot(null); setInsufficientWallet({ balance: wallet.balance, price: offering.price }); return; }
      }
      const confirmation = purchase
        ? t('تأكيد استخدام حصة من باقة {v0} لحجز {v1} لمدة {v2} دقيقة؟', { v0: purchase.package_name, v1: catalogText(subject), v2: offering.minutes })
        : t("تأكيد حجز حصة {v0} لمدة {v1} دقيقة بقيمة {v2}؟", { v0: catalogText(subject), v1: offering.minutes, v2: money(offering.price) });
      if (!window.confirm(confirmation)) return;
      await post(`slots/${slot.id}`, { subject, minutes: offering.minutes, start, method: purchase ? 'package' : 'wallet', ...(purchase ? { package_purchase_id: purchase.id } : {}) });
      setWalletRequired(0); setBookingSlot(null); setBookingPackage(null); setSuccess(t(purchase ? 'تم تأكيد الحجز وخصم حصة واحدة من باقتك. ستجده في الحصص المحجوزة.' : 'تم تأكيد الحجز. ستجده الآن في الحصص المحجوزة.')); refresh(); onView('rooms');
    } catch (cause) {
      if (!purchase && cause instanceof ApiError && cause.status === 402) { const wallet = await request<WalletData>('students/wallet').catch(() => ({ balance: 0 } as WalletData)); setWalletRequired(offering.price); setBookingSlot(null); setInsufficientWallet({ balance: wallet.balance, price: offering.price }); }
      else setError((cause as Error).message);
    } finally { setBusy(false); }
  }
  async function bookPackageTime(purchase: PackagePurchase) {
    if (!packageBookingStart || !packageBookingSubject) { setError(t('اختر المادة واليوم والوقت المناسب.')); return; }
    setBusy(true); setError(''); setSuccess('');
    try {
      await request(`students/package-purchases/${purchase.id}/book`, { start: packageBookingStart, subject: packageBookingSubject, recurring: true });
      setSuccess(t('تم تثبيت جميع حصص الباقة أسبوعياً في نفس اليوم والوقت، وستجدها في الحصص المحجوزة.'));
      setSelectedPackagePurchase(''); refresh(); onView('rooms');
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  const bookSlot = (slot: Slot, purchase: PackagePurchase | null = null) => {
    const availableSubjects = purchase ? slotSubjects(slot).filter(subject => purchase.subjects.includes(subject)) : slotSubjects(slot);
    const offerings = purchase ? slotOfferings(slot).filter(offering => offering.minutes === purchase.minutes) : slotOfferings(slot);
    const filteredSubject = studentSubject && availableSubjects.find(subject => fuzzyMatch(subject, studentSubject));
    const subject = filteredSubject || (availableSubjects.length === 1 ? availableSubjects[0] : '');
    const minutes = offerings.length === 1 ? offerings[0].minutes : 0;
    const starts = minutes ? availableBookingStarts(slot, minutes).filter(start => !purchase || start + minutes * 60000 <= purchase.expires_at) : [];
    setBookingPackage(purchase); setBookingSlot(slot); setBookingSubject(subject); setBookingMinutes(minutes); setBookingStart(starts[0] || 0);
  };
  async function publishAvailability(drafts: AvailabilityDraft[]) {
    setBusy(true); setError(''); setSuccess('');
    try {
      for (const draft of drafts) await post('slots', { subject: draft.subject, subjects: draft.subjects, start: draft.start, minutes: draft.minutes, available_until: draft.availableUntil, price: draft.price, offerings: draft.offerings });
      setSlots(current => [...drafts.map(draft => ({ id: crypto.randomUUID?.() || `slot-${Date.now()}-${draft.start}`, teacher_id: user.id, subject: draft.subject, subjects: draft.subjects, start: draft.start, minutes: draft.minutes, offerings: draft.offerings, available_until: draft.availableUntil, price: draft.price, status: 'open' })), ...current]);
      setSuccess(t('تم نشر مواعيدك وإضافتها إلى التقويم.'));
      return true;
    } catch (cause) {
      setError((cause as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  const teacherPackageExplorer = <div className="package-explorer">
    {!teacherPackageKey && <>
      <div className="showcase-heading"><div><span>{t('ملفك التعليمي')}</span><h2>{t(selectedTeacherCategory?.name || 'شو حاب تدرّس؟')}</h2><p>{t(selectedTeacherCategory?.description || 'اختر من نفس المجالات والمواد التي أضافتها الإدارة للطلاب.')}</p></div><small>{t('{v0} مواد محفوظة', { v0: teachingChoices.length })}</small></div>
      {!selectedTeacherCategory ? <div className="package-grid student-package-grid">{categories.map(([id, title, desc, icon], index) => <button type="button" className="package-card" style={{ '--package-delay': `${Math.min(index, 12) * 55}ms` } as CSSProperties} key={id} onClick={() => setTeacherCategoryId(id)}><span className="package-icon"><CategoryIcon value={icon} /></span><strong>{t(title)}</strong><small>{t(desc)}</small><ChevronLeft size={18} /></button>)}</div> : <div className="student-flow showcase-flow"><button type="button" className="package-back" onClick={() => setTeacherCategoryId('')}><ArrowRight size={18} />{t('كل المجالات')}</button><h3>{t('اختر المادة')}</h3><div className="package-grid">{selectedTeacherCategory.subjects.map((subject, index) => {
        const key = teachingChoiceKey(selectedTeacherCategory.id, subject);
        const chosen = teachingChoices.some(choice => teachingChoiceKey(choice.categoryId, choice.subject) === key);
        return <button type="button" className={`package-card ${chosen ? 'chosen' : ''}`} style={{ '--package-delay': `${Math.min(index, 12) * 45}ms` } as CSSProperties} key={key} onClick={() => setTeacherPackageKey(key)}><span className="package-icon"><CategoryIcon value={selectedTeacherCategory.icon} /></span><strong>{catalogText(subject)}</strong><small>{t(selectedTeacherCategory.name)}</small>{chosen && <Check size={16} />}</button>;
      })}</div></div>}
    </>}
    {selectedBuiltInPackage && (() => {
      const { category, subject } = selectedBuiltInPackage;
      const choice = teachingChoices.find(item => item.categoryId === category.id && item.subject === subject);
      const allLevels = Boolean(choice && category.levels.length && category.levels.every(level => choice.levels.includes(level)));
      return <div className="package-detail"><button type="button" className="package-back" onClick={() => { setTeacherPackageKey(''); setTeacherCategoryId(category.id); }}><ArrowRight size={18} />{t('مواد المجال')}</button><div className="package-detail-copy"><span>{t(category.name)}</span><h2>{t('اختار المستويات لمادة {v0}', { v0: catalogText(subject) })}</h2><p>{t(category.description)}</p></div>{category.levels.length ? <div className="package-levels"><label className="all-levels"><input type="checkbox" checked={allLevels} onChange={event => updateTeachingSubject(category, subject, event.currentTarget.checked)} />{t('كل المستويات')}</label>{category.levels.map(level => <label key={level}><input type="checkbox" checked={Boolean(choice?.levels.includes(level))} onChange={event => updateTeachingLevel(category, subject, level, event.currentTarget.checked)} />{t(level)}</label>)}</div> : <label className="package-single-toggle"><input type="checkbox" checked={Boolean(choice)} onChange={event => updateTeachingSubject(category, subject, event.currentTarget.checked)} />{t('أدرّس هذه المادة')}</label>}<div className="package-actions"><button type="button" className="primary-button" disabled={busy} onClick={() => void (async () => { if (await saveTeacherProfile()) { setTeacherPackageKey(''); setTeacherCategoryId(category.id); } })()}><Save size={17} />{t('حفظ اختياراتي')}</button></div></div>;
    })()}
  </div>;
  const lessonDetails = current && <dialog ref={node => { if (node && !node.open) node.showModal(); }} onCancel={() => setSelected(null)} className="detail-dialog" aria-labelledby="lesson-title"><div className="section-heading"><h2 id="lesson-title">{catalogText(current.subject)}</h2><button className="icon-button" title={t("إغلاق التفاصيل")} onClick={() => setSelected(null)}><X size={20} /></button></div>{error && <p className="notice error" role="alert">{t(error)}</p>}{success && <p className="notice success" role="status">{t(success)}</p>}<p>{current.teacher_name} · {current.student_name}</p><p>{date(current.start)} · {money(current.price)}</p>{portal === 'students' && current.teacher_phone && <p className="lesson-contact"><strong>{t('رقم الأستاذ')}</strong><a href={`tel:${current.teacher_phone}`} dir="ltr"><Phone size={16} />{current.teacher_phone}</a></p>}{portal === 'teachers' && current.student_phone && <p className="lesson-contact"><strong>{t('رقم الطالب')}</strong><a href={`tel:${current.student_phone}`} dir="ltr"><Phone size={16} />{current.student_phone}</a></p>}{portal === 'admin' && <p className="lesson-contact"><span>{current.teacher_phone}</span><span>{current.student_phone}</span></p>}<span className={`badge ${current.status}`}>{t(statusNames[current.status])}</span>
    <div className="lesson-notes"><h3>{t("ملخص الحصة والواجب")}</h3><p>{current.notes || t("لا يوجد ملخص بعد.")}</p>{current.resource && <a href={current.resource} target="_blank" rel="noopener noreferrer">{t("فتح المادة التعليمية")}</a>}</div>
    {portal === 'admin' && (current.package_purchase_id ? <p className="notice success"><PackageCheck size={17} />{t('هذه الحصة مدفوعة من باقة الطالب.')}</p> : <form className="work-form" key={`payment-${current.id}-${current.paid}`} onSubmit={e => { e.preventDefault(); const data = formData(e.currentTarget); void act(() => post(`bookings/${current.id}/payment`, { paid: current.paid ? 0 : 1, reference: data.reference || '' })); }}><h3>{current.paid ? t("الدفعة مسجلة") : t("تسجيل دفعة مستلمة")}</h3><label>{t("مرجع الحوالة أو الإيصال")}<input name="reference" defaultValue={current.payment_ref} maxLength={200} required={!current.paid} /></label><button className="secondary-button" disabled={busy}>{current.paid ? t("عكس تسجيل الدفعة") : t("تأكيد الاستلام اليدوي")}</button></form>)}
    {current.status === 'cancelled' && <div className="cancellation-result"><strong>{t('تفاصيل الإلغاء')}</strong><span>{current.package_purchase_id ? t('تمت إعادة الحصة إلى رصيد الباقة.') : t('المعاد إلى المحفظة: {v0}', { v0: money(current.refund_amount || 0) })}</span>{Number(current.teacher_compensation || 0) > 0 && <span>{t('تعويض الأستاذ: {v0}', { v0: money(current.teacher_compensation || 0) })}</span>}{portal === 'students' && <button type="button" className="secondary-button" onClick={() => { setSelected(null); onView(current.package_purchase_id ? 'packages' : 'home'); }}>{t('اختيار موعد بديل')}</button>}</div>}
    {portal === 'students' && current.status === 'completed' && <section className="lesson-rating"><div><strong>{current.student_rating ? t('تقييمك للأستاذ') : t('قيّم تجربتك مع الأستاذ')}</strong><small>{current.student_rating ? t('يمكنك تعديل تقييمك في أي وقت.') : t('رأيك يساعد الطلاب الآخرين ويحسّن جودة المنصة.')}</small></div><div className="rating-stars" role="radiogroup" aria-label={t('تقييم الأستاذ')}>{[1, 2, 3, 4, 5].map(value => <button type="button" role="radio" aria-checked={(ratingDraft || current.student_rating || 0) === value} className={value <= (ratingDraft || current.student_rating || 0) ? 'active' : ''} onClick={() => setRatingDraft(value)} key={value}><Star size={23} fill="currentColor" /></button>)}</div><label className="feedback-note">{t('ملاحظة عن الأستاذ والحصة')}<textarea rows={3} maxLength={1000} value={feedbackReview} onChange={event => setFeedbackReview(event.target.value)} placeholder={t('اكتب تجربتك لتفيد الطلاب الآخرين…')} /></label><button type="button" className="secondary-button" disabled={busy || !(ratingDraft || current.student_rating)} onClick={() => void rateTeacher(current)}>{t(current.student_rating ? 'تحديث التقييم' : 'إرسال التقييم')}</button></section>}
    <div className="row-actions">{current.status === 'confirmed' && (portal !== 'students' || current.start > Date.now()) && <button className="secondary-button" disabled={busy} onClick={() => void cancel(current)}>{t("إلغاء الحصة")}</button>}{portal === 'students' && current.status === 'confirmed' && Date.now() >= current.start + 10 * 60000 && !Number(current.teacher_joined_at || 0) && <button className="secondary-button danger-action" disabled={busy} onClick={() => void reportTeacherNoShow(current)}>{t('إبلاغ عن عدم حضور الأستاذ')}</button>}</div>
    <section className="lesson-messages"><h3>{t("مراسلات الحصة")}</h3>{messages.map(m => <article key={m.id}><strong>{m.name}</strong><small>{date(m.created)}</small><p>{m.body}</p></article>)}<form onSubmit={async (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const form = e.currentTarget; const data = formData(form); if (await act(async () => { const result = await request<{ messages: Message[] }>(`${portal}/bookings/${current.id}/messages`, data); setMessages(result.messages); }, t("تم إرسال الرسالة."))) form.reset(); }}><label>{t("رسالة جديدة")}<textarea name="body" maxLength={2000} rows={2} required /></label><button className="primary-button" disabled={busy || current.status === 'cancelled'}><Send size={17} />{t("إرسال")}</button></form></section>
  </dialog>;
  const callNavigation = portal === 'students'
    ? [{ id: 'home', label: t("الرئيسية") }, { id: 'rooms', label: t("الحصص المحجوزة") }, { id: 'messages', label: t("الرسائل") }, { id: 'packages', label: t("باقاتي") }, { id: 'tutors', label: t("أساتذتي") }, { id: 'wallet', label: t("المحفظة") }, { id: 'history', label: t("السجل") }, { id: 'profile', label: t("حسابي") }]
    : [{ id: 'home', label: t("الرئيسية") }, { id: 'rooms', label: t("الحصص المحجوزة") }, { id: 'messages', label: t("الرسائل") }, { id: 'available', label: t("المتاحة") }, { id: 'packages', label: t("الباقات") }, { id: 'earnings', label: t("المستحقات") }, { id: 'profile', label: t("حسابي") }];
  const callLayer = room && <div className={callCompact ? 'floating-call-shell' : 'immersive-call-shell'} dir={direction()}><Suspense fallback={<div className="call-loading" role="status"><div className="wake-spinner" /><p>{t("جارٍ تجهيز الغرفة…")}</p></div>}><VideoRoom
      key={room.id}
      assignedRole={room.role}
      assignedRoom={room.room}
      currentUserId={user.id}
      scheduledEnd={room.scheduledEnd}
      onGraceExpired={() => request(`${portal}/bookings/${room.id}/complete`, {})}
      authorize={() => request(`${portal}/bookings/${room.id}/room`)}
      messages={messages}
      navigationItems={callNavigation}
      compact={callCompact}
      onNavigate={nextView => { setCallCompact(true); onView(nextView); }}
      onExpand={() => setCallCompact(false)}
      onSendMessage={async body => {
        const result = await request<{ messages: Message[] }>(`${portal}/bookings/${room.id}/messages`, { body });
        setMessages(result.messages);
      }}
      onPresenceChange={(active, peerId) => request(`${portal}/bookings/${room.id}/presence`, { active, peerId })}
      getRemotePeerId={async () => {
        const presence = await request<{ teacherPeerId?: string | null; studentPeerId?: string | null }>(`${portal}/bookings/${room.id}/presence`);
        return room.role === 'teacher' ? presence.studentPeerId : presence.teacherPeerId;
      }}
      onLeave={() => { const ended = bookings.find(booking => booking.id === room.id) || null; setRoom(null); setCallCompact(false); if (portal === 'students' && ended && Date.now() >= ended.start) { setFeedbackBooking(ended); setRatingDraft(ended.student_rating || 0); } refresh(); }}
    /></Suspense></div>;
  const feedbackDialog = feedbackBooking && <dialog ref={node => { if (node && !node.open) node.showModal(); }} className="detail-dialog lesson-feedback-dialog" onCancel={() => setFeedbackBooking(null)}>
    <div className="section-heading"><div><span className="section-kicker">{t('بعد انتهاء المكالمة')}</span><h2>{t('كيف كانت الحصة؟')}</h2><p>{t('تقييمك يساعدنا على تحسين الجودة وحماية حقوقك.')}</p></div><button className="icon-button" onClick={() => setFeedbackBooking(null)} title={t('إغلاق')}><X size={20} /></button></div>
    <div className="rating-stars feedback-stars" role="radiogroup" aria-label={t('تقييم الحصة')}>{[1, 2, 3, 4, 5].map(value => <button type="button" role="radio" aria-checked={ratingDraft === value} className={value <= ratingDraft ? 'active' : ''} onClick={() => setRatingDraft(value)} key={value}><Star size={30} fill="currentColor" /></button>)}</div>
    <label className="feedback-note">{t('ملاحظتك')}<textarea rows={4} maxLength={1500} value={feedbackReview} onChange={event => setFeedbackReview(event.target.value)} placeholder={t('اكتب ملاحظتك عن الحصة…')} /></label>
    <label className="feedback-report-toggle"><input type="checkbox" checked={feedbackReport} onChange={event => setFeedbackReport(event.target.checked)} /><span><strong>{t('إرسال شكوى للدعم الفني عن الحصة أو الأستاذ')}</strong></span></label>
    {feedbackReport && <label>{t('نوع المشكلة')}<select value={feedbackCategory} onChange={event => setFeedbackCategory(event.target.value)}><option value="teacher_absent">{t('الأستاذ لم يحضر')}</option><option value="teacher_inactive">{t('لم يتم تقديم الحصة')}</option><option value="technical">{t('مشكلة تقنية')}</option><option value="content">{t('مشكلة في المحتوى')}</option><option value="conduct">{t('سلوك غير مناسب')}</option><option value="other">{t('أخرى')}</option></select></label>}
    {error && <p className="notice error" role="alert">{t(error)}</p>}
    <div className="row-actions"><button className="secondary-button" onClick={() => setFeedbackBooking(null)}>{t('لاحقاً')}</button><button className="primary-button" disabled={busy} onClick={() => void submitLessonFeedback()}>{t(feedbackReport ? 'إرسال التقييم والشكوى' : 'إرسال التقييم')}</button></div>
  </dialog>;
  const packageMarketplace = <section className="lesson-package-marketplace">
    <div className="section-heading"><div><span className="section-kicker">{t('وفّر أكثر والتزم بخطتك')}</span><h3>{t('باقات الأساتذة')}</h3><p>{t('مجموعة حصص بسعر واحد، وتحجز مواعيدك لاحقاً حسب وقتك ووقت الأستاذ.')}</p></div></div>
    {!lessonPackages.length ? <div className="empty-state compact-empty"><PackageCheck size={30} /><p>{t('لا توجد باقات منشورة حالياً.')}</p></div> : <div className="lesson-package-offer-grid">{lessonPackages.slice(0, 8).map(item => <article className="lesson-package-offer" key={item.id}>
      <header><span className="package-symbol"><PackageCheck size={21} /></span><div><small>{item.teacher_name}</small><h4>{item.name}</h4></div></header>
      <TutorRating rating={item.teacher_rating} count={item.teacher_rating_count} />
      {item.description && <p>{item.description}</p>}
      <div className="lesson-package-tags">{item.subjects.map(subject => <span key={subject}>{catalogText(subject)}</span>)}</div>
      <dl><div><dt>{t('عدد الحصص')}</dt><dd>{item.lesson_count}</dd></div><div><dt>{t('مدة الحصة')}</dt><dd>{item.minutes} {t('دقيقة')}</dd></div><div><dt>{t('صلاحية')}</dt><dd>{item.validity_days} {t('يوماً')}</dd></div></dl>
      <footer><div><strong>{money(item.price)}</strong><small>{t('{v0} للحصة تقريباً', { v0: money(Math.round(item.price / item.lesson_count)) })}</small></div><div className="package-offer-actions"><button className="secondary-button" type="button" onClick={() => setPackageDetails(item)}><BookOpen size={17} />{t('تفاصيل الباقة')}</button></div></footer>
    </article>)}</div>}
  </section>;
  const packageDetailsDialog = packageDetails && <dialog ref={node => { if (node && !node.open) node.showModal(); }} onCancel={() => setPackageDetails(null)} className="detail-dialog package-details-dialog" aria-labelledby="package-details-title">
    <header><div><span className="section-kicker">{t('تفاصيل الباقة')}</span><h2 id="package-details-title">{packageDetails.name}</h2><p>{t('مع {v0}', { v0: packageDetails.teacher_name || t('أستاذ امتداد') })}</p></div><button className="icon-button" type="button" title={t('إغلاق التفاصيل')} onClick={() => setPackageDetails(null)}><X size={20} /></button></header>
    {packageDetails.description && <p className="package-details-description">{packageDetails.description}</p>}
    <div className="lesson-package-tags">{packageDetails.subjects.map(subject => <span key={subject}>{catalogText(subject)}</span>)}</div>
    <section className="package-details-facts"><div><small>{t('عدد الحصص')}</small><strong>{packageDetails.lesson_count}</strong></div><div><small>{t('مدة الحصة')}</small><strong>{packageDetails.minutes} {t('دقيقة')}</strong></div><div><small>{t('صلاحية الاستخدام')}</small><strong>{packageDetails.validity_days} {t('يوماً')}</strong></div><div><small>{t('سعر الباقة')}</small><strong>{money(packageDetails.price)}</strong></div></section>
    <section className="package-details-schedule"><h3><CalendarDays size={18} />{t('أيام وساعات الباقة')}</h3>{packageDetails.weekly_schedule?.length ? <PackageSchedule rows={packageDetails.weekly_schedule} /> : <p>{t('لم يحدد الأستاذ أياماً ثابتة لهذه الباقة بعد.')}</p>}</section>
    <section className="booking-cancellation-policy package-policy"><strong>{t('حجز مرن من رصيد الباقة')}</strong><p>{t('بعد الشراء تختار مواعيدك من الأيام التي نشرها الأستاذ، وتظهر لك فقط الساعات المتاحة فعلياً.')}</p></section>
    <footer><div><small>{t('الإجمالي')}</small><strong>{money(packageDetails.price)}</strong></div><button className="primary-button" type="button" disabled={busy} onClick={() => { const item = packageDetails; setPackageDetails(null); void purchaseLessonPackage(item); }}><ShoppingBag size={17} />{t('شراء الباقة')}</button></footer>
  </dialog>;
  const selectedPurchase = packagePurchases.find(item => item.id === selectedPackagePurchase) || null;
  const myPackagesView = <section className="student-page my-packages-page">
    <header className="my-packages-hero"><div><span><PackageCheck size={17} />{t('باقاتك المشتراة')}</span><h2>{t('كل حصص باقاتك بمكان واحد')}</h2><p>{t('اختر الباقة، وسنعرض لك فقط مواعيد الأستاذ المطابقة للمادة ومدة الحصة.')}</p></div><strong>{activePackagePurchases.reduce((sum, item) => sum + item.remaining_lessons, 0)}<small>{t('حصص متبقية')}</small></strong></header>
    {!packagePurchases.length ? <div className="empty-state"><PackageCheck size={36} /><h3>{t('ما عندك باقات بعد')}</h3><p>{t('استكشف باقات الأساتذة من الصفحة الرئيسية واختر ما يناسب خطتك.')}</p><button className="primary-button" onClick={() => onView('home')}><ShoppingBag size={17} />{t('استكشف الباقات')}</button></div> : <div className="owned-package-grid">{packagePurchases.map(item => {
      const remainingPercent = Math.max(0, Math.min(100, item.remaining_lessons / item.lesson_count * 100));
      const active = item.status === 'active' && item.remaining_lessons > 0 && item.expires_at > Date.now();
      return <article className={`owned-package-card ${item.status} ${selectedPackagePurchase === item.id ? 'selected' : ''}`} key={item.id}>
        <header><span className="package-symbol"><PackageCheck size={21} /></span><div><small>{item.teacher_name}</small><h3>{item.package_name}</h3></div><span className={`badge ${active ? 'active' : 'cancelled'}`}>{t(active ? 'فعّالة' : item.status === 'expired' ? 'منتهية' : 'مكتملة')}</span></header>
        <div className="package-credit"><div><span>{t('المتبقي')}</span><strong>{item.remaining_lessons}<small> / {item.lesson_count}</small></strong></div><div className="package-credit-track" aria-label={t('{v0} حصص متبقية', { v0: item.remaining_lessons })}><i style={{ width: `${remainingPercent}%` }} /></div></div>
        <div className="lesson-package-tags">{item.subjects.map(subject => <span key={subject}>{catalogText(subject)}</span>)}</div>
        <PackageSchedule rows={item.weekly_schedule || []} />
        <dl><div><dt>{t('مدة الحصة')}</dt><dd>{item.minutes} {t('دقيقة')}</dd></div><div><dt>{t('صالحة حتى')}</dt><dd>{new Date(item.expires_at).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' })}</dd></div></dl>
        <button className="primary-button" disabled={!active} onClick={() => setSelectedPackagePurchase(selectedPackagePurchase === item.id ? '' : item.id)}><CalendarPlus size={17} />{selectedPackagePurchase === item.id ? t('إخفاء المواعيد') : active ? t('احجز من الباقة') : t('لا توجد حصص متاحة')}</button>
      </article>;
    })}</div>}
    {selectedPurchase && <section className="package-matching-slots"><div className="section-heading"><div><span className="section-kicker">{t('جدول الباقة')}</span><h3>{t('اختر موعدك مع {v0}', { v0: selectedPurchase.teacher_name })}</h3><p>{t('اختر المادة ثم اليوم والساعة من الفترات التي خصصها الأستاذ لهذه الباقة.')}</p></div></div>{selectedPurchase.weekly_schedule?.length ? <div className="package-direct-booking"><PackageSchedule rows={selectedPurchase.weekly_schedule} />{selectedPurchase.subjects.length > 1 && <fieldset className="package-booking-subjects"><legend>{t('المادة')}</legend>{selectedPurchase.subjects.map(subject => <button type="button" className={packageBookingSubject === subject ? 'selected' : ''} onClick={() => setPackageBookingSubject(subject)} key={subject}>{catalogText(subject)}</button>)}</fieldset>}{packageAvailabilityLoading ? <div className="package-availability-loading"><RefreshCw className="spin" size={22} />{t('جارٍ تجهيز المواعيد المتاحة…')}</div> : !packageAvailabilityDays.length ? <div className="empty-state compact-empty"><CalendarDays size={30} /><p>{t('لا توجد مواعيد متاحة ضمن جدول الباقة حالياً.')}</p></div> : <><div className="package-day-picker">{packageAvailabilityDays.map(day => <button type="button" className={packageBookingDay === day.day ? 'selected' : ''} onClick={() => { setPackageBookingDay(day.day); setPackageBookingStart(0); }} key={day.day}><small>{t(packageWeekDays[day.weekday])}</small><strong>{new Date(`${day.day}T12:00:00`).toLocaleDateString(locale(), { day: 'numeric', month: 'short' })}</strong><span>{t('{v0} موعد', { v0: day.starts.length })}</span></button>)}</div>{packageBookingDay && <div className="package-time-picker">{packageAvailabilityDays.find(day => day.day === packageBookingDay)?.starts.map(start => <button type="button" className={packageBookingStart === start ? 'selected' : ''} onClick={() => setPackageBookingStart(start)} key={start}><Clock3 size={16} />{timeOnly(start)}</button>)}</div>}<footer className="package-booking-confirm"><div><small>{t('اختيارك')}</small><strong>{packageBookingStart ? `${catalogText(packageBookingSubject)} · ${date(packageBookingStart)}` : t('اختر الموعد المناسب')}</strong></div><button type="button" className="primary-button" disabled={busy || !packageBookingStart || !packageBookingSubject} onClick={() => void bookPackageTime(selectedPurchase)}><CalendarPlus size={18} />{t('تأكيد حجز الباقة')}</button></footer></>}</div> : <TutorList slots={slotsForPackage(selectedPurchase)} busy={busy} bookSlot={slot => bookSlot(slot, selectedPurchase)} />}</section>}
  </section>;
  const bookingDialog = bookingSlot && (() => {
    const availableSubjects = bookingPackage ? slotSubjects(bookingSlot).filter(subject => bookingPackage.subjects.includes(subject)) : slotSubjects(bookingSlot);
    const offerings = bookingPackage ? slotOfferings(bookingSlot).filter(offering => offering.minutes === bookingPackage.minutes) : slotOfferings(bookingSlot);
    const selectedOffering = offerings.find(item => item.minutes === bookingMinutes);
    const startOptions = selectedOffering ? availableBookingStarts(bookingSlot, selectedOffering.minutes).filter(start => !bookingPackage || start + selectedOffering.minutes * 60000 <= bookingPackage.expires_at) : [];
    const subjectAlreadyFiltered = Boolean(studentSubject && availableSubjects.some(subject => fuzzyMatch(subject, studentSubject)));
    return <dialog ref={node => { if (node && !node.open) node.showModal(); }} onCancel={() => { setBookingSlot(null); setBookingPackage(null); }} className="booking-choice-dialog" aria-labelledby="booking-choice-title">
      <header><div><span>{bookingPackage ? t('حجز من باقتك') : t('أكمل اختيار حصتك')}</span><h2 id="booking-choice-title">{bookingSlot.teacher_name}</h2><p>{date(bookingSlot.start)} – {timeOnly(bookingSlot.available_until || bookingSlot.start + bookingSlot.minutes * 60000)}</p>{bookingPackage && <small className="booking-package-badge"><PackageCheck size={14} />{bookingPackage.package_name} · {bookingPackage.remaining_lessons} {t('حصص متبقية')}</small>}</div><button className="icon-button" type="button" aria-label={t('إغلاق')} onClick={() => { setBookingSlot(null); setBookingPackage(null); }}><X size={20} /></button></header>
      {!subjectAlreadyFiltered && availableSubjects.length > 1 && <fieldset><legend>{t('أي مادة تريد أن تدرس؟')}</legend><div className="booking-choice-grid subjects">{availableSubjects.map(subject => <label className={bookingSubject === subject ? 'selected' : ''} key={subject}><input type="radio" name="booking-subject" checked={bookingSubject === subject} onChange={() => setBookingSubject(subject)} /><span><BookOpen size={18} />{catalogText(subject)}</span></label>)}</div></fieldset>}
      <fieldset><legend>{offerings.length > 1 ? t('اختر مدة الحصة التي تناسبك') : t('مدة الحصة')}</legend><div className="booking-choice-grid durations">{offerings.map(offering => <label className={bookingMinutes === offering.minutes ? 'selected' : ''} key={offering.minutes}><input type="radio" name="booking-duration" checked={bookingMinutes === offering.minutes} onChange={() => { const starts = availableBookingStarts(bookingSlot, offering.minutes).filter(start => !bookingPackage || start + offering.minutes * 60000 <= bookingPackage.expires_at); setBookingMinutes(offering.minutes); setBookingStart(starts[0] || 0); }} /><span><Clock3 size={18} /><strong>{offering.minutes} {t('دقيقة')}</strong><small>{bookingPackage ? t('مشمولة في الباقة') : money(offering.price)}</small></span></label>)}</div></fieldset>
      {selectedOffering && <fieldset className="booking-time-choice"><legend>{t('اختر وقت بداية الحصة')}</legend>{startOptions.length ? <select value={bookingStart || startOptions[0]} onChange={event => setBookingStart(Number(event.target.value))}>{startOptions.map(start => <option value={start} key={start}>{timeOnly(start)} – {timeOnly(start + selectedOffering.minutes * 60000)}</option>)}</select> : <p className="notice error">{t('لا يوجد وقت متبقٍ يناسب هذه المدة.')}</p>}</fieldset>}
      {bookingPackage ? <section className="booking-cancellation-policy package-policy" aria-label={t('سياسة الباقة')}><strong>{t('حجز مرن من رصيد الباقة')}</strong><p>{t('لن يُخصم مبلغ جديد. وإذا ألغيت الحصة تعود إلى رصيد باقتك لتختار موعداً بديلاً.')}</p></section> : <section className="booking-cancellation-policy" aria-label={t('سياسة الإلغاء')}><strong>{t('سياسة الإلغاء قبل الدفع')}</strong><ul><li>{t('قبل 24 ساعة أو أكثر: استرداد 100% إلى المحفظة.')}</li><li>{t('بين 6 و24 ساعة: استرداد 50% إلى المحفظة.')}</li><li>{t('أقل من 6 ساعات أو عدم الحضور: لا يوجد استرداد.')}</li><li>{t('إذا ألغى الأستاذ أو ثبت غيابه: استرداد كامل للطالب.')}</li></ul><small>{t('جميع الاستردادات تعود إلى محفظة منصّة. يمكنك اختيار موعد بديل بدل الإلغاء.')}</small></section>}
      <footer><div><small>{bookingPackage ? t('طريقة الدفع') : t('الإجمالي')}</small><strong>{bookingPackage ? t('من رصيد الباقة') : selectedOffering ? money(selectedOffering.price) : '—'}</strong></div><button className="primary-button" type="button" disabled={busy || !bookingSubject || !selectedOffering || !bookingStart} onClick={() => selectedOffering && bookingStart && void completeBooking(bookingSlot, bookingSubject, selectedOffering, bookingStart, bookingPackage)}><CalendarPlus size={18} />{t('تأكيد الحجز')}</button></footer>
    </dialog>;
  })();
  const insufficientWalletDialog = insufficientWallet && <dialog ref={node => { if (node && !node.open) node.showModal(); }} onCancel={() => setInsufficientWallet(null)} className="detail-dialog wallet-shortfall-dialog" aria-labelledby="wallet-shortfall-title"><header><span><CircleAlert size={24} /></span><div><h2 id="wallet-shortfall-title">{t('رصيد محفظتك غير كافي')}</h2><p>{t('اشحن محفظتك ثم ارجع لتأكيد الحجز.')}</p></div><button className="icon-button" type="button" aria-label={t('إغلاق')} onClick={() => setInsufficientWallet(null)}><X size={20} /></button></header><dl><div><dt>{t('رصيد المحفظة')}</dt><dd>{money(insufficientWallet.balance)}</dd></div><div><dt>{t('سعر الطلب')}</dt><dd>{money(insufficientWallet.price)}</dd></div><div className="shortfall"><dt>{t('المتبقي لإتمامه')}</dt><dd>{money(Math.max(0, insufficientWallet.price - insufficientWallet.balance))}</dd></div></dl><button className="primary-button" type="button" onClick={() => setInsufficientWallet(null)}>{t('حسناً')}</button></dialog>;
  const teacherNoShowWarnings = portal === 'teachers' && bookings.filter(b => b.status === 'confirmed' && reminders.now >= b.start && reminders.now < b.start + 10 * 60000 && !Number(b.teacher_joined_at || 0)).map(b => <div className="notice error teacher-no-show-warning" key={`warning-${b.id}`}><CircleAlert size={20} /><span>{t('بدأت حصة {v0}. ادخل الآن؛ بعد 10 دقائق سيُرفع بلاغ غياب تلقائي وتُقيّد مستحقات الحصة.', { v0: catalogText(b.subject) })}</span><button className="primary-button" onClick={() => void join(b)}><Video size={16} />{t('دخول الآن')}</button></div>);
  const teacherProfileDialog = teacherProfile && <dialog ref={node => { if (node && !node.open) node.showModal(); }} className="detail-dialog teacher-profile-dialog" onCancel={() => setTeacherProfile(null)}><header className="teacher-profile-head"><span className="profile-photo-preview"><UserRound size={30} />{teacherProfile.teacher.avatar_url && <img src={apiMediaUrl(teacherProfile.teacher.avatar_url)} alt="" />}</span><div><small>{t('ملف الأستاذ')}</small><h2>{teacherProfile.teacher.name}</h2><TutorRating rating={teacherProfile.teacher.teacher_rating} count={teacherProfile.teacher.teacher_rating_count} /></div><button type="button" className="icon-button" onClick={() => setTeacherProfile(null)} aria-label={t('إغلاق')}><X size={20} /></button></header>{teacherProfile.teacher.bio && <p className="teacher-profile-bio">{teacherProfile.teacher.bio}</p>}<section><h3>{t('المواد والخبرة')}</h3><p>{teacherProfile.teacher.subject || t('لم يضف الأستاذ وصف المواد بعد.')}</p></section>{teacherProfile.teacher.phone && <a className="teacher-profile-phone" href={`tel:${teacherProfile.teacher.phone}`} dir="ltr"><Phone size={17} />{teacherProfile.teacher.phone}</a>}<section className="teacher-profile-reviews"><h3>{t('آراء الطلاب')}</h3>{teacherProfile.reviews.length ? teacherProfile.reviews.map((review, index) => <article key={`${review.created}-${index}`}><header><strong>{review.student_name}</strong><span><Star size={14} fill="currentColor" />{review.rating}</span><time>{new Date(review.created).toLocaleDateString(locale())}</time></header><p>{review.review}</p></article>) : <p>{t('لا توجد ملاحظات مكتوبة بعد.')}</p>}</section></dialog>;
  if (view === 'messages') return <>{callLayer}</>;
  if (portal === 'students' && view === 'wallet') return <>{callLayer}<WalletPanel requiredAmount={walletRequired} /></>;
  if (portal === 'admin' && view === 'topups') return <>{callLayer}<TopupReviewPanel /></>;
  if ((portal === 'admin' && view === 'payments') || (portal === 'teachers' && view === 'earnings')) return <>{callLayer}<PaymentsPanel portal={portal === 'admin' ? 'admin' : 'teachers'} /></>;
  if (portal === 'admin' && view === 'reports') return <ReportsPanel />;
  if (portal === 'teachers' && view === 'packages') return <>{callLayer}<div className="portal-content tutor-experience"><LessonPackagesPanel subjects={teacherSubjects} /></div></>;
  if (portal === 'teachers' && view === 'profile' && !loading) return <>{callLayer}<div className="portal-content tutor-experience"><section className="student-page account-page"><h2>{t('حسابي')}</h2>{error && <p className="notice error" role="alert">{t(error)}</p>}{success && <p className="notice success" role="status">{t(success)}</p>}<div className="profile-layout"><form className="work-form" onSubmit={async event => { event.preventDefault(); const data = formData(event.currentTarget); await act(async () => { const result = await request<{ user: User }>('teachers/profile', data); onUser(result.user); }); }}><h3>{t('ملف الأستاذ')}</h3>{teacherAvatarEditor}<label>{t('الاسم الكامل')}<input name="name" defaultValue={user.name} required /></label><label>{t('البريد الإلكتروني')}<input value={user.email} readOnly dir="ltr" /></label><label>{t('المواد والمستويات')}<textarea value={teachingChoices.map(choice => teachingChoiceLabel(choice, catalog.find(category => category.id === choice.categoryId))).join('\n')} readOnly rows={5} /></label><input type="hidden" name="subject" value={user.subject} /><label>{t('نبذة مهنية')}<textarea name="bio" defaultValue={user.bio} rows={5} /></label><button className="primary-button" disabled={busy}><Save size={17} />{t('حفظ')}</button></form><div className="account-settings"><button onClick={() => setSuccess(t('حالة التوثيق مرتبطة بموافقة الإدارة وتظهر مباشرة بعد تفعيل الحساب.'))}>{t('حالة التوثيق: حسب موافقة الإدارة')}</button><button onClick={() => onView('available')}>{t('إعدادات التوفر')}</button><button onClick={() => onView('earnings')}>{t('تفاصيل المستحقات')}</button><button onClick={reminders.toggle}>{t('إعدادات الإشعارات')}</button></div></div></section></div></>;
  if (portal === 'students') return <>{callLayer}{feedbackDialog}{lessonDetails}{bookingDialog}{insufficientWalletDialog}{teacherProfileDialog}{teacherProfileLoading && <div className="profile-loading-toast">{t('جارٍ فتح ملف الأستاذ…')}</div>}<div className="portal-content student-experience">
    {reminders.upcoming.map(b => <div className="lesson-reminder lesson-pulse" key={b.id}><Bell size={22} /><div><strong>{catalogText(b.subject)}</strong><p>{b.start > reminders.now ? t("تبدأ خلال {v0} دقيقة", { v0: Math.ceil((b.start - reminders.now) / 60000) }) : t("حان موعد الحصة")}</p></div><button className="primary-button" disabled={busy} onClick={() => void join(b)}><Video size={17} />{t("دخول الغرفة")}</button></div>)}
    {error && <p className="notice error" role="alert">{t(error)}</p>}{success && <p className="notice success" role="status">{t(success)}</p>}
    {loading || loadedView !== view ? <WorkspaceSkeleton /> : <>
      {view === 'home' && <section className="student-home">
        <WorkspaceOverview user={user} portal={portal} bookings={bookings} availableCount={new Set(openSlots.map(slot => slot.teacher_id)).size} onView={onView}>
          <div className="student-package-explorer" id="learning-path">
            <div className="showcase-heading"><div><span>{t('مساحتك التعليمية')}</span><h2>{studentStep === 'categories' ? t('شو حاب تتعلّم؟') : t(studentCategory)}</h2><p>{studentStep === 'categories' ? t('اختار المجال، وإحنا بنوصلك للأستاذ والموعد المناسب.') : t(activeCategory?.description || 'كل سؤال، بداية جديدة.')}</p></div>{studentSearch}</div>
            {studentStep === 'categories' && <div className="package-grid student-package-grid">{categories.map(([id, title, desc, icon], index) => <button key={id} className="package-card" style={{ '--package-delay': `${Math.min(index, 12) * 55}ms` } as CSSProperties} onClick={() => chooseCategory(id, title)}><span className="package-icon"><CategoryIcon value={icon} /></span><strong>{t(title)}</strong><small>{t(desc)}</small><ChevronLeft size={18} /></button>)}</div>}
            {studentStep !== 'categories' && <div className="student-flow showcase-flow"><button className="package-back" onClick={() => { setStudentStep('categories'); setStudentCategory(''); setStudentLevel(''); setStudentSubject(''); }}><ArrowRight size={18} />{t('كل المجالات')}</button><h3>{studentStep === 'levels' ? t('اختر مستواك الدراسي') : studentStep === 'subjects' ? t('اختر المادة') : t('المواعيد المناسبة إلك')}</h3>{studentStep === 'levels' && <div className="choice-grid">{levels.map(level => <button onClick={() => { setStudentLevel(level); setStudentStep('subjects'); }} key={level}>{t(level)}<ChevronLeft size={16} /></button>)}</div>}{studentStep === 'subjects' && <div className="choice-grid">{subjects.map(subject => <button onClick={() => { setStudentSubject(subject); setStudentStep('tutors'); }} key={subject}>{catalogText(subject)}<ChevronLeft size={16} /></button>)}</div>}{studentStep === 'tutors' && <TutorList slots={subjectSlots} busy={busy} bookSlot={bookSlot} onProfile={openTeacherProfile} />}</div>}
          </div>
        </WorkspaceOverview>
        <div className="student-home-market-grid"><section className="available-tutors home-nearest-tutors"><div className="section-heading"><div><span className="section-kicker">{t('أقرب المواعيد')}</span><h3>{t('مواعيد الأساتذة')}</h3></div><button className="text-button" onClick={() => { setStudentStep('tutors'); setStudentSubject(''); setStudentCategory(''); setStudentLevel(''); setCategoryId(''); }}>{t('الكل')}<ChevronLeft size={16} /></button></div><TutorList slots={openSlots.slice(0, 4)} busy={busy} bookSlot={bookSlot} compact onProfile={openTeacherProfile} /></section>{packageMarketplace}</div>
      </section>}
      {view === 'rooms' && <RoomHub portal={portal} bookings={bookings} now={reminders.now} filter={roomFilter} onFilter={setRoomFilter} busy={busy} canJoin={canJoinBooking} onJoin={join} onDetails={booking => setSelected(booking.id)} onCancel={cancel} />}
      {view === 'packages' && myPackagesView}
      {view === 'tutors' && <section className="student-page"><div className="section-heading"><h2>{selectedTutorId ? t('مواعيد الأستاذ') : t("أساتذتي")}</h2>{selectedTutorId && <button className="secondary-button" onClick={() => setSelectedTutorId('')}><ArrowRight size={17} />{t('العودة إلى أساتذتي')}</button>}</div>{selectedTutorId ? (openSlots.some(slot => slot.teacher_id === selectedTutorId) ? <TutorList slots={openSlots.filter(slot => slot.teacher_id === selectedTutorId)} busy={busy} bookSlot={bookSlot} onProfile={openTeacherProfile} /> : <Empty text="الأستاذ مش ناشر مواعيد جديدة" />) : <>{!myTutors.length && <Empty text="لم تحجز مع أي أستاذ بعد." />}<div className="student-list">{myTutors.map(b => <article className="saved-tutor" key={b.teacher_id}><button type="button" className="avatar" onClick={() => void openTeacherProfile(b.teacher_id)} aria-label={t('فتح ملف الأستاذ')}><UserRound size={24} /></button><button type="button" className="saved-tutor-name" onClick={() => void openTeacherProfile(b.teacher_id)}><strong>{b.teacher_name}</strong><p>{catalogText(b.subject)}{t(" · آخر حصة ")}{date(b.start)}</p></button><button className="primary-button" onClick={() => setSelectedTutorId(b.teacher_id)}>{t("احجز مجدداً")}</button></article>)}</div></>}</section>}
      {view === 'history' && <section className="student-page"><h2>{t("السجل")}</h2><div className="history-tabs">{[['all', t("الكل")], ['confirmed', t("القادمة")], ['completed', t("المكتملة")], ['cancelled', t("الملغاة")]].map(([id, label]) => <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>{t(label)}</button>)}</div>{!shownBookings.length && <Empty text="لا توجد حصص في هذا القسم." />}<div className="history-list">{shownBookings.map(b => <article key={b.id}><BookOpen size={20} /><div><strong>{catalogText(b.subject)}</strong><p>{b.teacher_name} · {date(b.start)}</p></div><span className={`badge ${b.status}`}>{t(statusNames[b.status])}</span><b>{money(b.price)}</b><button className="secondary-button" onClick={() => setSelected(b.id)}>{t("التفاصيل")}</button></article>)}</div></section>}
      {view === 'profile' && <section className="student-page account-page"><h2>{t("حسابي")}</h2><div className="profile-layout"><form className="work-form" onSubmit={async e => { e.preventDefault(); const data = formData(e.currentTarget); await act(async () => { const result = await request<{ user: User }>(`${portal}/profile`, data); onUser(result.user); }); }}><h3>{t("المعلومات الشخصية")}</h3><label>{t("الاسم الكامل")}<input name="name" defaultValue={user.name} required /></label><label>{t("البريد الإلكتروني")}<input value={user.email} readOnly dir="ltr" /></label><input type="hidden" name="subject" value="" /><input type="hidden" name="bio" value="" /><button className="primary-button" disabled={busy}><Save size={17} />{t("حفظ")}</button></form><aside className="account-facts"><h3>{t("تفاصيل الحساب")}</h3><dl><div><dt>{t("نوع الحساب")}</dt><dd>{t("طالب")}</dd></div><div><dt>{t("حالة الحساب")}</dt><dd><span className={`badge ${user.status}`}>{t(statusNames[user.status])}</span></dd></div><div><dt>{t("تنبيهات الحصص")}</dt><dd><label className="preference-toggle"><input type="checkbox" aria-label={t("تنبيهات الحصص")} checked={reminders.enabled} onChange={reminders.toggle} />{reminders.enabled ? t("مفعّلة") : t("غير مفعّلة")}</label></dd></div></dl></aside></div></section>}
    </>}
    {packageDetailsDialog}
    {currentSlot && <dialog ref={node => { if (node && !node.open) node.showModal(); }} onCancel={() => setSelectedSlot(null)} className="detail-dialog"><div className="section-heading"><h2>{catalogText(currentSlot.subject)}</h2><button className="icon-button" title={t("إغلاق التفاصيل")} onClick={() => setSelectedSlot(null)}><X size={20} /></button></div><p>{date(currentSlot.start)}</p><p>{currentSlot.minutes}{t(" دقيقة · ")}{money(currentSlot.price)}</p><span className={`badge ${currentSlot.status}`}>{t(statusNames[currentSlot.status])}</span><div className="row-actions">{currentSlot.status === 'open' && <button className="secondary-button" disabled={busy} onClick={() => { if (window.confirm(t("حذف هذا الموعد؟"))) void act(() => post(`slots/${currentSlot.id}`), t("تم حذف الموعد.")); setSelectedSlot(null); }}><X size={17} />{t("حذف الموعد")}</button>}</div></dialog>}
  </div></>;
  if (portal === 'teachers') return <>{callLayer}{lessonDetails}<div className="portal-content tutor-experience">
    {teacherNoShowWarnings}
    {reminders.upcoming.map(b => <div className="lesson-reminder lesson-pulse" key={b.id}><Bell size={22} /><div><strong>{catalogText(b.subject)}</strong><p>{b.start > reminders.now ? t("تبدأ خلال {v0} دقيقة", { v0: Math.ceil((b.start - reminders.now) / 60000) }) : t("حان موعد الحصة")}</p></div><button className="primary-button" disabled={busy} onClick={() => void join(b)}><Video size={17} />{t("دخول الغرفة")}</button></div>)}
    {error && <p className="notice error" role="alert">{t(error)}</p>}{success && <p className="notice success" role="status">{t(success)}</p>}
    {loading || loadedView !== view ? <WorkspaceSkeleton /> : <>
      {view === 'home' && <section className="tutor-home">
        <WorkspaceOverview user={user} portal={portal} bookings={bookings} availableCount={openSlots.length} onView={onView}>{teacherPackageExplorer}</WorkspaceOverview>
      </section>}
      {view === 'rooms' && <RoomHub portal={portal} bookings={bookings} now={reminders.now} filter={roomFilter} onFilter={setRoomFilter} busy={busy} canJoin={canJoinBooking} onJoin={join} onDetails={booking => setSelected(booking.id)} onCancel={cancel} />}
      {view === 'available' && <TeacherAvailabilityHub subjects={teacherSubjects} slots={slots} bookings={bookings} busy={busy} onHome={() => onView('home')} onPublish={publishAvailability} onDelete={deleteSlot} onBookingDetails={setSelected} />}
      {view === 'profile' && <section className="student-page account-page"><h2>{t("حسابي")}</h2><div className="profile-layout"><form className="work-form" onSubmit={async e => { e.preventDefault(); const data = formData(e.currentTarget); await act(async () => { const result = await request<{ user: User }>(`${portal}/profile`, data); onUser(result.user); }); }}><h3>{t("ملف الأستاذ")}</h3><label>{t("الاسم الكامل")}<input name="name" defaultValue={user.name} required /></label><label>{t("البريد الإلكتروني")}<input value={user.email} readOnly dir="ltr" /></label><label>{t("المواد والمستويات")}<textarea value={teachingChoices.map(choice => teachingChoiceLabel(choice, catalog.find(category => category.id === choice.categoryId))).join('\n')} readOnly rows={5} /></label><input type="hidden" name="subject" value={user.subject} /><label>{t("نبذة مهنية")}<textarea name="bio" defaultValue={user.bio} rows={5} /></label><button className="primary-button" disabled={busy}><Save size={17} />{t("حفظ")}</button></form><div className="account-settings"><button onClick={() => setSuccess(t("حالة التوثيق مرتبطة بموافقة الإدارة وتظهر مباشرة بعد تفعيل الحساب."))}>{t("حالة التوثيق: حسب موافقة الإدارة")}</button><button onClick={() => onView('available')}>{t("إعدادات التوفر")}</button><button onClick={() => onView('earnings')}>{t("تفاصيل المستحقات")}</button><button onClick={reminders.toggle}>{t("إعدادات الإشعارات")}</button><button onClick={() => setSuccess(t("يمكنك طلب الدعم من الإدارة عبر رسائل الحصة أو حساب المنصة."))}>{t("المساعدة والدعم")}</button></div></div></section>}
      {view === 'history' && <section className="student-page"><h2>{t("السجل")}</h2><div className="history-tabs"><button onClick={() => setFilter('all')}>{t("الكل")}</button><button onClick={() => setFilter('completed')}>{t("الحصص")}</button><button onClick={() => onView('earnings')}>{t("المستحقات")}</button></div><div className="history-list">{bookings.filter(b => filter === 'all' || b.status === filter).map(b => <article key={b.id}><HistoryIcon size={20} /><div><strong>{b.student_name}</strong><p>{catalogText(b.subject)} · {date(b.start)}</p></div><span className={`badge ${b.status}`}>{t(statusNames[b.status])}</span><b>{money(b.price)}</b></article>)}</div></section>}
    </>}
  </div></>;
  return <>{callLayer}{feedbackDialog}<div className="portal-content">
    {portal !== 'admin' && <div className="reminder-settings"><button className="secondary-button" aria-pressed={reminders.enabled} onClick={reminders.toggle} title={reminders.enabled ? t("إيقاف الصوت وإشعارات الجهاز") : t("تفعيل الصوت وإشعارات الجهاز")}>{reminders.enabled ? <Bell size={18} /> : <BellOff size={18} />}{reminders.enabled ? t("التنبيهات مفعّلة") : t("تفعيل تنبيهات الحصص")}</button>{reminders.hint && <small role="status">{t(reminders.hint)}</small>}</div>}
    {reminders.upcoming.map(b => <div className="lesson-reminder lesson-pulse" key={b.id}><Bell size={22} aria-hidden="true" /><div><strong>{catalogText(b.subject)}</strong><p role="status">{b.start > reminders.now ? t("تبدأ خلال {v0} دقيقة", { v0: Math.ceil((b.start - reminders.now) / 60000) }) : t("حان موعد الحصة")}</p></div><button className="primary-button" disabled={busy} onClick={() => { onView('bookings'); void join(b); }}><Video size={17} />{t("دخول الحصة")}</button></div>)}
    {error && <p className="notice error" role="alert">{t(error)}</p>}
    {success && <p className="notice success" role="status">{t(success)}</p>}
    {view !== 'profile' && <div className="list-toolbar"><label className="search-field"><Search size={18} /><input aria-label={t("بحث")} placeholder={view === 'slots' ? t("المادة أو اسم الأستاذ") : t("بحث")} value={query} onChange={e => setQuery(e.target.value)} /></label>
      {view === 'bookings' && <select aria-label={t("حالة الحصة")} value={filter} onChange={e => setFilter(e.target.value)}><option value="all">{t("كل الحالات")}</option>{['confirmed', 'completed', 'cancelled'].map(s => <option value={s} key={s}>{t(statusNames[s])}</option>)}</select>}
      <button className="icon-button" onClick={refresh} title={t("تحديث")} disabled={loading}><RefreshCw size={18} /></button>
      {view === 'bookings' && <button className="icon-button" onClick={exportBookings} title={t("تنزيل الحجوزات CSV")} disabled={loading || !bookings.length}><Download size={18} /></button>}
    </div>}
    {view === 'users' && <AccountsPanel users={users} query={query} onChanged={refresh} />}
    {view === 'catalog' && !loading && loadedView === view && <CatalogPanel categories={catalog} onChanged={setCatalog} />}
    {loading || loadedView !== view ? <WorkspaceSkeleton /> : <>
      {view === 'bookings' && <>
        <div className="metric-band"><div><span>{t("الحصص المؤكدة")}</span><strong>{bookings.filter(b => b.status === 'confirmed').length}</strong></div><div><span>{t("الحصص المكتملة")}</span><strong>{bookings.filter(b => b.status === 'completed').length}</strong></div><div><span>{t("الدفعات المسجلة")}</span><strong>{money(bookings.filter(b => b.paid).reduce((sum, b) => sum + b.price, 0))}</strong></div></div>
        {!shownBookings.length && <Empty text={query || filter !== 'all' ? t("لا توجد نتائج مطابقة.") : t("لا توجد حجوزات حتى الآن.")} />}
        {!!shownBookings.length && <div className="booking-table-heading" aria-hidden="true"><span>{t("الحصة والمشاركون ")}<small>{shownBookings.length}</small></span><span>{t("الحالة والمبلغ")}</span><span>{t("الإجراءات")}</span></div>}
        <div className="booking-list">{shownBookings.map(b => <article className="booking-row" key={b.id}><div className="booking-title"><span className="booking-date-mark" aria-hidden="true"><strong>{new Date(b.start).toLocaleDateString(locale(), { day: 'numeric' })}</strong><small>{new Date(b.start).toLocaleDateString(locale(), { month: 'short' })}</small></span><div><h2>{catalogText(b.subject)}</h2><p>{b.teacher_name} · {b.student_name}</p><time>{date(b.start)} · {b.minutes}{t(" دقيقة")}</time></div></div><div className="booking-state"><span className={`badge ${b.status}`}>{t(statusNames[b.status])}</span><strong>{money(b.price)}</strong><small>{b.paid ? t("دفعة مسجلة") : t("غير مدفوع")}</small>{b.status === 'cancelled' && b.paid === 1 && <small className="refund-note">{t("يلزم مراجعة الاسترداد")}</small>}</div><div className="row-actions"><button className="secondary-button" onClick={() => setSelected(b.id)}>{t("التفاصيل")}<ChevronLeft size={16} /></button></div></article>)}</div>
      </>}
      {view === 'slots' && <>
        {false && <form className="work-form slot-form" onSubmit={async e => {
          e.preventDefault(); const form = e.currentTarget; const data = formData(form);
          if (await act(() => post('slots', { ...data, start: new Date(String(data.start)).getTime(), minutes: Number(data.minutes), price: Math.round(Number(data.price) * 100) }), t("تم نشر الموعد."))) form.reset();
        }}><h2>{t("إضافة موعد")}</h2><label>{t("المادة")}<input name="subject" maxLength={100} defaultValue={user.subject} required /></label><label>{t("التاريخ والوقت")}<input name="start" type="datetime-local" required /></label><label>{t("المدة")}<select name="minutes" defaultValue="60">{[30, 45, 60, 90, 120].map(n => <option key={n} value={n}>{n}{t(" دقيقة")}</option>)}</select></label><label>{t("السعر بالدينار الأردني")}<input name="price" type="number" min="0" max="1000" step="0.01" required /></label><button className="primary-button" disabled={busy}><CalendarPlus size={17} />{t("نشر الموعد")}</button></form>}
        <p className="muted">{t("المواعيد حسب توقيت جهازك: ")}{Intl.DateTimeFormat().resolvedOptions().timeZone}</p>
        {!slots.filter(s => matches(`${s.subject} ${s.teacher_name || ''}`)).length && <Empty text="لا توجد مواعيد متاحة مطابقة." />}
        <div className="slot-grid">{slots.filter(s => matches(`${s.subject} ${s.teacher_name || ''}`)).map(s => <article className="slot-item" key={s.id}><span className={`badge ${s.status}`}>{t(statusNames[s.status])}</span><h2>{catalogText(s.subject)}</h2>{s.teacher_name && <strong>{s.teacher_name}</strong>}{s.bio && <p>{s.bio}</p>}<p>{date(s.start)}</p><p>{s.minutes}{t(" دقيقة · ")}{money(s.price)}</p>{s.status === 'open' && s.start > Date.now() && <button className="secondary-button" disabled={busy} onClick={() => { if (window.confirm(t("حذف هذا الموعد؟"))) void act(() => post(`slots/${s.id}`), t("تم حذف الموعد.")); }}><X size={17} />{t("حذف الموعد")}</button>}</article>)}</div>
      </>}
      {view === 'audit' && <div>{!events.length && <Empty text="لا توجد عمليات مسجلة بعد." />}{events.filter(e => matches(`${e.name} ${actionNames[e.action] || e.action}`)).map(e => <article className="audit-row" key={e.id}><strong>{t(actionNames[e.action] || e.action)}</strong><span>{e.name}</span><time>{date(e.created)}</time><small dir="ltr">{e.target}</small></article>)}</div>}
      {view === 'profile' && <div className="profile-layout"><form className="work-form" onSubmit={async e => { e.preventDefault(); const data = formData(e.currentTarget); await act(async () => { const result = await request<{ user: User }>(`${portal}/profile`, data); onUser(result.user); }); }}><h2>{t("معلومات الحساب")}</h2><label>{t("الاسم الكامل")}<input name="name" defaultValue={user.name} maxLength={100} required /></label><label>{t("البريد الإلكتروني")}<input value={user.email} readOnly dir="ltr" /></label><><input type="hidden" name="subject" value="" /><input type="hidden" name="bio" value="" /></><button className="primary-button" disabled={busy}><Save size={17} />{t("حفظ")}</button></form><form className="work-form" onSubmit={async e => { e.preventDefault(); const data = formData(e.currentTarget); await act(async () => { await post('password', data); onUser(null); }); }}><h2>{t("تغيير كلمة المرور")}</h2><label>{t("كلمة المرور الحالية")}<input name="current" type="password" minLength={12} maxLength={128} autoComplete="current-password" required /></label><label>{t("كلمة المرور الجديدة")}<input name="password" type="password" minLength={12} maxLength={128} autoComplete="new-password" required /></label><small>{t("12 حرفًا على الأقل. يلزم الدخول مجددًا بعد التغيير.")}</small><button className="secondary-button" disabled={busy}><Save size={17} />{t("تغيير كلمة المرور")}</button></form></div>}
    </>}
    {currentSlot && <dialog ref={node => { if (node && !node.open) node.showModal(); }} onCancel={() => setSelectedSlot(null)} className="detail-dialog"><div className="section-heading"><h2>{catalogText(currentSlot.subject)}</h2><button className="icon-button" title={t("إغلاق التفاصيل")} onClick={() => setSelectedSlot(null)}><X size={20} /></button></div><p>{date(currentSlot.start)}</p><p>{currentSlot.minutes}{t(" دقيقة · ")}{money(currentSlot.price)}</p><span className={`badge ${currentSlot.status}`}>{t(statusNames[currentSlot.status])}</span><div className="row-actions">{currentSlot.status === 'open' && <button className="secondary-button" disabled={busy} onClick={() => { if (window.confirm(t("حذف هذا الموعد؟"))) void act(() => post(`slots/${currentSlot.id}`), t("تم حذف الموعد.")); setSelectedSlot(null); }}><X size={17} />{t("حذف الموعد")}</button>}</div></dialog>}
    {lessonDetails}
  </div></>;
}
type RoomFilter = 'today' | 'tomorrow' | 'yesterday' | 'upcoming' | 'past' | 'all';
function RoomHub({ portal, bookings, now, filter, onFilter, busy, canJoin, onJoin, onDetails, onCancel }: { portal: 'students' | 'teachers'; bookings: Booking[]; now: number; filter: RoomFilter; onFilter: (filter: RoomFilter) => void; busy: boolean; canJoin: (booking: Booking) => boolean; onJoin: (booking: Booking) => Promise<void>; onDetails: (booking: Booking) => void; onCancel: (booking: Booking) => Promise<void> }) {
  usePreferences();
  const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime();
  const day = 86400000;
  const filters: Array<[RoomFilter, string]> = [['today', t("اليوم")], ['tomorrow', t("غداً")], ['yesterday', t("أمس")], ['upcoming', t("القادمة")], ['past', t("السابقة")], ['all', t("الكل")]];
  const visible = bookings.filter(booking => {
    const end = booking.start + booking.minutes * 60000;
    if (filter === 'today') return booking.start >= today && booking.start < today + day;
    if (filter === 'tomorrow') return booking.start >= today + day && booking.start < today + day * 2;
    if (filter === 'yesterday') return booking.start >= today - day && booking.start < today;
    if (filter === 'upcoming') return end >= now;
    if (filter === 'past') return end < now;
    return true;
  }).sort((a, b) => filter === 'past' || filter === 'all' ? b.start - a.start : a.start - b.start);
  const countdown = (start: number) => {
    const seconds = Math.max(0, Math.floor((start - now) / 1000));
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;
    return `${days ? `${days} ${t('يوم')} ` : ''}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
  };
  const isArchived = (booking: Booking) => booking.start + booking.minutes * 60000 < now || booking.status === 'completed' || booking.status === 'cancelled';
  const upcomingBookings = visible.filter(booking => !isArchived(booking));
  const archivedBookings = visible.filter(isArchived);
  const renderBooking = (booking: Booking) => {
    const teacherLive = Number(booking.teacher_present_until || 0) > now;
    const studentLive = Number(booking.student_present_until || 0) > now;
    const end = booking.start + booking.minutes * 60000;
    const past = isArchived(booking);
    const counterpartLive = booking.status === 'confirmed' && !past && (portal === 'students' ? teacherLive : studentLive);
    const upcoming = booking.start > now;
    const joinable = canJoin(booking);
    const person = portal === 'students' ? booking.teacher_name : booking.student_name;
    return <article className={`room-card ${counterpartLive ? 'is-live' : ''} ${past ? 'is-past' : ''}`} key={booking.id}>
      <div className="room-card-date"><span>{new Date(booking.start).toLocaleDateString(locale(), { weekday: 'long' })}</span><strong>{new Date(booking.start).toLocaleDateString(locale(), { day: 'numeric', month: 'short' })}</strong></div>
      <div className="room-card-main"><div className="room-card-title"><span className={`room-status ${counterpartLive ? 'live' : booking.status}`}>{counterpartLive ? <><Video size={14} />{t("LIVE الآن")}</> : statusNames[booking.status]}</span><h3>{catalogText(booking.subject)}</h3></div><p>{person} · {timeOnly(booking.start)} - {timeOnly(end)} · {booking.minutes}{t(" دقيقة")}</p>{(portal === 'students' ? booking.teacher_phone : booking.student_phone) && <a className="room-contact" href={`tel:${portal === 'students' ? booking.teacher_phone : booking.student_phone}`} dir="ltr"><Phone size={14} />{portal === 'students' ? booking.teacher_phone : booking.student_phone}</a>}<div className="room-presence"><span className={teacherLive ? 'online' : ''}>{t("الأستاذ ")}{teacherLive ? t("داخل الغرفة") : t("لم يدخل بعد")}</span><span className={studentLive ? 'online' : ''}>{t("الطالب ")}{studentLive ? t("داخل الغرفة") : t("لم يدخل بعد")}</span></div></div>
      <div className="room-card-action">{booking.status === 'confirmed' && upcoming && <div className="room-countdown"><small>{t("تبدأ بعد")}</small><strong dir="ltr" aria-live="polite">{countdown(booking.start)}</strong></div>}{booking.status === 'confirmed' && !upcoming && !counterpartLive && now <= end && <span className="room-started">{t("بدأ موعد الحصة")}</span>}{booking.status === 'confirmed' ? <button className={counterpartLive ? 'primary-button live-button' : 'primary-button'} disabled={busy || !joinable} title={joinable ? t("دخول غرفة الحصة") : t("يفتح الدخول قبل الموعد بـ15 دقيقة")} onClick={() => void onJoin(booking)}><Video size={17} />{counterpartLive ? t("انضم الآن") : joinable ? t("دخول الغرفة") : t("تفتح قبل 15 دقيقة")}</button> : <span className="room-closed">{booking.status === 'completed' ? t("تمت الحصة") : t("أُلغيت الحصة")}</span>}<div className="room-card-secondary-actions"><button type="button" className="secondary-button" onClick={() => onDetails(booking)}>{t('التفاصيل')}</button>{booking.status === 'confirmed' && upcoming && <button type="button" className="secondary-button danger-action" disabled={busy} onClick={() => void onCancel(booking)}>{t('إلغاء الحصة')}</button>}</div></div>
    </article>;
  };
  return <section className="rooms-hub student-page">
    <div className="rooms-hero"><div><span className="rooms-kicker"><Video size={17} />{t("حصصك المباشرة")}</span><h2>{t("الحصص المحجوزة")}</h2><p>{bookings.filter(booking => booking.status === 'confirmed').length}{t(" حصص مؤكدة · ")}{new Date(now).toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' })}</p></div><div className="rooms-live-summary"><strong>{bookings.filter(booking => booking.status === 'confirmed' && Number(portal === 'students' ? booking.teacher_present_until : booking.student_present_until) > now).length}</strong><span>{portal === 'students' ? t("أساتذة داخل الغرفة الآن") : t("طلاب بانتظارك الآن")}</span></div></div>
    <div className="room-filters" role="tablist" aria-label={t("فلترة غرف الحصص")}>{filters.map(([id, label]) => <button type="button" role="tab" aria-selected={filter === id} className={filter === id ? 'active' : ''} onClick={() => onFilter(id)} key={id}>{t(label)}</button>)}</div>
    {!visible.length && <Empty text="لا توجد حصص ضمن هذه الفترة." />}
    {!!visible.length && <div className="room-groups"><section><header><span>{upcomingBookings.length}</span><h3>{t('الحصص القادمة')}</h3></header><div className="room-list">{upcomingBookings.length ? upcomingBookings.map(renderBooking) : <p className="room-group-empty">{t('لا توجد حصص قادمة ضمن هذه الفترة.')}</p>}</div></section><section className="archived"><header><span>{archivedBookings.length}</span><h3>{t('المنتهية أو الملغاة')}</h3></header><div className="room-list">{archivedBookings.length ? archivedBookings.map(renderBooking) : <p className="room-group-empty">{t('لا توجد حصص منتهية أو ملغاة ضمن هذه الفترة.')}</p>}</div></section></div>}
  </section>;
}
function TutorList({ slots, busy, bookSlot, compact = false, onProfile }: { slots: Slot[]; busy: boolean; bookSlot: (slot: Slot) => void; compact?: boolean; onProfile?: (teacherId: string) => void }) {
  usePreferences();
  if (!slots.length) return <Empty text="لا توجد مواعيد مناسبة حالياً." />;
  return <div className={compact ? 'tutor-strip' : 'tutor-market-list'}>{slots.map(slot => <article className="tutor-card" key={slot.id}>
    <button type="button" className="tutor-photo" onClick={() => onProfile?.(slot.teacher_id)} aria-label={t('فتح ملف الأستاذ')}>{slot.teacher_name?.slice(0, 1) || 'أ'}</button>
    <div className="tutor-info"><div><strong>{slot.teacher_name || t("أستاذ منصّة")}</strong><BadgeCheck className="verified-icon" size={17} aria-label={t("أستاذ منصّة")} /></div><TutorRating rating={slot.teacher_rating} count={slot.teacher_rating_count} /><p>{slotSubjects(slot).map(catalogText).join('، ')}</p><small><Clock3 size={14} />{slotOfferings(slot).map(item => item.minutes).join(' / ')}{t(" دقيقة")}{slot.bio && <span> · {slot.bio}</span>}</small><time><CalendarPlus size={14} />{date(slot.start)} – {timeOnly(slot.available_until || slot.start + slot.minutes * 60000)}</time></div>
    <div className="tutor-actions"><b>{slotOfferings(slot).length > 1 ? <span className="variable-lesson-price">{t("السعر حسب طول الحصة")}</span> : money(slotOfferings(slot)[0].price)}<small>{slotOfferings(slot).length > 1 ? t("اختر المدة لترى السعر") : t("سعر الحصة")}</small></b><button className="primary-button" disabled={busy} onClick={() => bookSlot(slot)}><CalendarPlus size={16} />{t("احجز الآن")}</button></div>
  </article>)}</div>;
}

function TutorRating({ rating, count = 0 }: { rating?: number | null; count?: number }) {
  return <span className={`tutor-rating ${rating !== null && rating !== undefined && count > 0 ? 'rated' : 'unrated'}`}>{rating !== null && rating !== undefined && count > 0 ? <><Star size={15} fill="currentColor" /><strong>{rating.toFixed(1)}</strong><small>({count})</small></> : <small>{t('لم يُقيّم بعد')}</small>}</span>;
}

function Empty({ text }: { text: string }) {
  usePreferences(); return <div className="empty-state"><CalendarPlus size={30} /><p>{t(text)}</p></div>; }




