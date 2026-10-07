import { t, locale, direction, usePreferences, catalogText, searchText } from '../../i18n/preferences';
import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { BookOpen, CalendarPlus, Check, ChevronLeft, CreditCard, Download, History as HistoryIcon, RefreshCw, Search, Send, UserRound, Video, X, Save, Bell, BellOff, Clock3, BadgeCheck, ArrowRight, Plus, Trash2 } from 'lucide-react';
import { request, date, money, statusNames, type Booking, type Slot, type Portal, type User, type Message, type CustomPackage } from '../../services/platformApi';
import { useLessonReminders, reminderPhase } from './useLessonReminders';
import { AccountsPanel } from './AccountsPanel';
import { CatalogPanel } from './CatalogPanel';
import { PaymentsPanel } from './PaymentsPanel';
import { WorkspaceOverview, WorkspaceSkeleton } from './WorkspaceOverview';
import { TeacherAvailabilityHub, type AvailabilityDraft } from './TeacherAvailabilityHub';
import type { Category } from '../../services/platformApi';
import { GraduationCap, Library, Languages, PenLine, Sparkles, Sprout } from 'lucide-react';
const VideoRoom = lazy(() => import('../video/VideoRoom').then(module => ({ default: module.VideoRoom })));

function CategoryIcon({ value }: { value: string }) {
  const icons: Record<string, typeof Library> = { '📚': Library, '☘': Sprout, '✍': PenLine, EN: Languages, '🎓': GraduationCap, '✨': Sparkles };
  const Icon = icons[value];
  return Icon ? <Icon size={22} strokeWidth={1.7} /> : <>{value}</>;
}

type EventRow = { id: string; name: string; action: string; target: string; created: number };
type Room = { id: string; room: string; role: 'teacher' | 'student' };
const actionNames: Record<string, string> = { 'user:password-reset': 'إصدار كلمة مرور مؤقتة', 'user:active': 'تفعيل حساب', 'user:suspended': 'إيقاف حساب', 'booking:cancel': 'إلغاء حصة', 'payment:received': 'تسجيل دفعة', 'payment:reversed': 'عكس دفعة' };
const formData = (form: HTMLFormElement) => Object.fromEntries(new FormData(form));
const timeOnly = (value: number) => new Date(value).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
const normalizedSearch = (value: string) => value.normalize('NFKD').toLocaleLowerCase().replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/[أإآ]/g, 'ا').replace(/ؤ/g, 'و').replace(/ئ|ى/g, 'ي').replace(/ة/g, 'ه').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const searchKeys = (value: string) => { const normalized = normalizedSearch(value).replaceAll(' ', ''); return [normalized, normalized.replace(/[اوي]/g, '')].filter(key => key.length > 1); };
const fuzzyMatch = (left: string, right: string) => searchKeys(left).some(a => searchKeys(right).some(b => a.includes(b) || b.includes(a)));
const teachesSubject = (list: string, subject: string) => list.split(' | ').some(item => fuzzyMatch(item, subject));
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
  const [teachingChoices, setTeachingChoices] = useState<TeachingChoice[]>([]);
  const [customPackages, setCustomPackages] = useState<CustomPackage[]>(() => user.custom_packages || []);
  const [teacherPackageKey, setTeacherPackageKey] = useState('');
  const [buildingCustomPackage, setBuildingCustomPackage] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [callCompact, setCallCompact] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
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
  useEffect(() => { setQuery(''); setFilter('all'); setSelected(null); setSuccess(''); }, [view]);
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
    if (view === 'messages' || view === 'payments' || view === 'earnings') return;
    let alive = true;
    setLoading(true); setError('');
    const path = portal === 'students' ? (view === 'home' ? 'slots' : view === 'profile' ? 'profile' : 'overview') : view === 'bookings' ? 'overview' : view;
    Promise.allSettled([
      request<{ bookings?: Booking[]; slots?: Slot[]; users?: User[]; events?: EventRow[] }>(`${portal}/${path}`),
      request<{ categories: Category[] }>(`${portal}/catalog`),
    ]).then(([dataResult, catalogResult]) => {
      if (!alive) return;
      if (catalogResult.status === 'fulfilled') setCatalog(catalogResult.value.categories);
      if (dataResult.status === 'fulfilled') {
        const data = dataResult.value;
        if (data.bookings) setBookings(data.bookings);
        if (data.slots) setSlots(data.slots);
        if (data.users) setUsers(data.users);
        if (data.events) setEvents(data.events);
      }
      const failure = dataResult.status === 'rejected' ? dataResult.reason : catalogResult.status === 'rejected' ? catalogResult.reason : null;
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
    const a = document.createElement('a'); a.href = url; a.download = 'mansah-bookings.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function join(b: Booking) {
    await act(async () => {
      const data = await request<Omit<Room, 'id'>>(`${portal}/bookings/${b.id}/room`);
      setSelected(null);
      setMessages([]);
      setCallCompact(false);
      setRoom({ id: b.id, ...data });
    }, t("الغرفة جاهزة."));
  }
  const cancel = (b: Booking) => { if (window.confirm(t("إلغاء حصة {v0} بتاريخ {v1}؟", { v0: catalogText(b.subject), v1: date(b.start) }))) void act(() => post(`bookings/${b.id}/cancel`), t("تم إلغاء الحصة.")); };
  const openSlots = slots.filter(s => s.status === 'open' && (s.available_until || s.start + s.minutes * 60000) > Date.now() && matches(searchText(s.subject, s.teacher_name || '', s.teacher_subjects || '')));
  const teacherMap = new Map<string, Booking>();
  bookings.forEach(b => { if (!teacherMap.has(b.teacher_id)) teacherMap.set(b.teacher_id, b); });
  const myTutors = [...teacherMap.values()];
  const categories = catalog.map(category => [category.id, category.name, category.description, category.icon] as const);
  const catalogSubjects = [...new Set(catalog.flatMap(category => category.subjects))];
  const teacherSubjects = [...new Set([...teachingChoices.map(choice => choice.subject), ...customPackages.map(item => item.name)])];
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
  const selectedCustomPackage = teacherPackageKey.startsWith('custom:') ? customPackages.find(item => `custom:${item.id}` === teacherPackageKey) : undefined;
  const commonLevels = [...new Set(catalog.flatMap(category => category.levels))];
  async function saveTeacherProfile(nextChoices = teachingChoices, nextPackages = customPackages, message = t('تم حفظ اختياراتك. اذهب إلى صفحة المتاحة لإعداد وقت نشر مادتك.')) {
    await act(async () => {
      const result = await request<{ user: User }>(`${portal}/profile`, { name: user.name, bio: user.bio, subject: serializeTeachingChoices(nextChoices), custom_packages: nextPackages });
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
    const slotMatchesSubject = s.subject === 'كل المواد المختارة' || fuzzyMatch(s.subject, studentSubject);
    const choices = parseTeachingChoices(s.teacher_subjects || '', catalog);
    if (choices.length) {
      const matching = choices.filter(choice => (!activeCategory || choice.categoryId === activeCategory.id) && fuzzyMatch(choice.subject, studentSubject));
      return slotMatchesSubject && matching.some(choice => !studentLevel || !activeCategory?.levels.length || choice.levels.includes(studentLevel));
    }
    const specialties = `${s.subject} ${s.teacher_subjects || ''}`;
    return fuzzyMatch(specialties, studentSubject) || (s.subject === 'كل المواد المختارة' && teachesSubject(s.teacher_subjects || '', studentSubject));
  });
  const studentSearch = <label className="student-search"><Search size={19} /><input aria-label={t("بحث")} placeholder={t("ابحث عن مادة أو أستاذ")} value={query} onChange={e => setQuery(e.target.value)} /></label>;
  const bookSlot = (s: Slot) => { if (window.confirm(t("تأكيد حجز الحصة بقيمة {v0}؟", { v0: money(s.price) }))) void act(() => post(`slots/${s.id}`), t("تم تأكيد الحجز. ستجده في السجل.")); };
  async function publishAvailability(drafts: AvailabilityDraft[]) {
    setBusy(true); setError(''); setSuccess('');
    try {
      for (const draft of drafts) await post('slots', { subject: draft.subject, start: draft.start, minutes: draft.minutes, available_until: draft.availableUntil, price: draft.price });
      setSlots(current => [...drafts.map(draft => ({ id: crypto.randomUUID?.() || `slot-${Date.now()}-${draft.start}`, teacher_id: user.id, subject: draft.subject, start: draft.start, minutes: draft.minutes, available_until: draft.availableUntil, price: draft.price, status: 'open' })), ...current]);
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
    {!teacherPackageKey && !buildingCustomPackage && <>
      <div className="showcase-heading"><div><span>{t('ملفك التعليمي')}</span><h2>{t('شو حاب تدرّس؟')}</h2><p>{t('اختر مادة وعدّل المستويات، أو اصنع باقتك الخاصة من الصفر.')}</p></div><small>{t('{v0} باقات محفوظة', { v0: teachingChoices.length + customPackages.length })}</small></div>
      <div className="package-grid">{builtInPackages.map(({ key, category, subject }, index) => {
        const chosen = teachingChoices.some(choice => teachingChoiceKey(choice.categoryId, choice.subject) === key);
        return <button type="button" className={`package-card ${chosen ? 'chosen' : ''}`} style={{ '--package-delay': `${Math.min(index, 12) * 45}ms` } as CSSProperties} key={key} onClick={() => setTeacherPackageKey(key)}><span className="package-icon"><CategoryIcon value={category.icon} /></span><strong>{catalogText(subject)}</strong><small>{t(category.name)}</small>{chosen && <Check size={16} />}</button>;
      })}<button type="button" className="package-card custom-package-card" onClick={() => setBuildingCustomPackage(true)}><span className="package-icon"><Plus size={23} /></span><strong>{t('أخرى')}</strong><small>{t('اصنع باقتك')}</small></button>{customPackages.map((item, index) => <button type="button" className="package-card chosen custom-saved-package" style={{ '--package-delay': `${Math.min(index + builtInPackages.length, 12) * 45}ms` } as CSSProperties} key={item.id} onClick={() => setTeacherPackageKey(`custom:${item.id}`)}><span className="package-icon"><Sparkles size={22} /></span><strong>{item.name}</strong><small>{t('باقة خاصة')}</small><Check size={16} /></button>)}</div>
    </>}
    {selectedBuiltInPackage && (() => {
      const { category, subject } = selectedBuiltInPackage;
      const choice = teachingChoices.find(item => item.categoryId === category.id && item.subject === subject);
      const allLevels = Boolean(choice && category.levels.length && category.levels.every(level => choice.levels.includes(level)));
      return <div className="package-detail"><button type="button" className="package-back" onClick={() => setTeacherPackageKey('')}><ArrowRight size={18} />{t('كل المواد')}</button><div className="package-detail-copy"><span>{t(category.name)}</span><h2>{t('اختار المستوى الي حاب تعطيه المادة')}</h2><p>{t(category.description)}</p></div>{category.levels.length ? <div className="package-levels"><label className="all-levels"><input type="checkbox" checked={allLevels} onChange={event => updateTeachingSubject(category, subject, event.currentTarget.checked)} />{t('كل المستويات')}</label>{category.levels.map(level => <label key={level}><input type="checkbox" checked={Boolean(choice?.levels.includes(level))} onChange={event => updateTeachingLevel(category, subject, level, event.currentTarget.checked)} />{t(level)}</label>)}</div> : <label className="package-single-toggle"><input type="checkbox" checked={Boolean(choice)} onChange={event => updateTeachingSubject(category, subject, event.currentTarget.checked)} />{t('أدرّس هذه المادة')}</label>}<div className="package-actions"><button type="button" className="primary-button" disabled={busy} onClick={() => void saveTeacherProfile()}><Save size={17} />{t('حفظ اختياراتي')}</button></div></div>;
    })()}
    {selectedCustomPackage && <div className="package-detail custom-package-detail"><button type="button" className="package-back" onClick={() => setTeacherPackageKey('')}><ArrowRight size={18} />{t('كل المواد')}</button><div className="package-detail-copy"><span>{t('باقتك الخاصة')}</span><h2>{selectedCustomPackage.name}</h2><p>{selectedCustomPackage.description || t('باقة مرنة صنعتها بطريقتك.')}</p></div><div className="package-levels static-levels">{selectedCustomPackage.levels.length ? selectedCustomPackage.levels.map(level => <span key={level}>{level}</span>) : <span>{t('مناسبة لجميع المستويات')}</span>}</div><div className="package-actions"><button type="button" className="secondary-button danger-action" disabled={busy} onClick={() => void deleteCustomPackage(selectedCustomPackage)}><Trash2 size={17} />{t('حذف الباقة')}</button></div></div>}
    {buildingCustomPackage && <form className="custom-package-builder" onSubmit={createCustomPackage}><button type="button" className="package-back" onClick={() => setBuildingCustomPackage(false)}><ArrowRight size={18} />{t('كل المواد')}</button><div className="package-detail-copy"><span>{t('صمّمها على كيفك')}</span><h2>{t('باقة جديدة باسمك')}</h2><p>{t('اكتب المادة وحدد المستويات التي تناسبك؛ ستظهر لاحقاً ضمن موادك ومواعيدك.')}</p></div><div className="custom-package-fields"><label>{t('اسم المادة أو الباقة')}<input name="name" maxLength={80} required placeholder={t('مثلاً: روبوتكس للمبتدئين')} /></label><label>{t('وصف قصير')}<textarea name="description" maxLength={240} rows={2} placeholder={t('ما الذي يميز هذه الباقة؟')} /></label></div><fieldset className="custom-level-picker"><legend>{t('اختر المستويات')}</legend>{commonLevels.map(level => <label key={level}><input type="checkbox" name="level" value={level} />{t(level)}</label>)}</fieldset><label className="custom-levels-input">{t('مستويات أخرى (افصل بينها بفاصلة أو سطر)')}<textarea name="custom_levels" rows={2} placeholder={t('مبتدئ، متوسط، متقدم')} /></label><button className="primary-button" disabled={busy}><Plus size={17} />{t('إنشاء الباقة وحفظها')}</button></form>}
  </div>;
  const lessonDetails = current && <dialog ref={node => { if (node && !node.open) node.showModal(); }} onCancel={() => setSelected(null)} className="detail-dialog" aria-labelledby="lesson-title"><div className="section-heading"><h2 id="lesson-title">{catalogText(current.subject)}</h2><button className="icon-button" title={t("إغلاق التفاصيل")} onClick={() => setSelected(null)}><X size={20} /></button></div>{error && <p className="notice error" role="alert">{t(error)}</p>}{success && <p className="notice success" role="status">{t(success)}</p>}<p>{current.teacher_name} · {current.student_name}</p><p>{date(current.start)} · {money(current.price)}</p><span className={`badge ${current.status}`}>{t(statusNames[current.status])}</span>
    <div className="lesson-notes"><h3>{t("ملخص الحصة والواجب")}</h3><p>{current.notes || t("لا يوجد ملخص بعد.")}</p>{current.resource && <a href={current.resource} target="_blank" rel="noopener noreferrer">{t("فتح المادة التعليمية")}</a>}</div>
    {portal === 'admin' && <form className="work-form" key={`payment-${current.id}-${current.paid}`} onSubmit={e => { e.preventDefault(); const data = formData(e.currentTarget); void act(() => post(`bookings/${current.id}/payment`, { paid: current.paid ? 0 : 1, reference: data.reference || '' })); }}><h3>{current.paid ? t("الدفعة مسجلة") : t("تسجيل دفعة مستلمة")}</h3><label>{t("مرجع الحوالة أو الإيصال")}<input name="reference" defaultValue={current.payment_ref} maxLength={200} required={!current.paid} /></label><button className="secondary-button" disabled={busy}>{current.paid ? t("عكس تسجيل الدفعة") : t("تأكيد الاستلام اليدوي")}</button></form>}
    <div className="row-actions">{current.status === 'confirmed' && <button className="secondary-button" disabled={busy} onClick={() => cancel(current)}>{t("إلغاء الحصة")}</button>}</div>
    <section className="lesson-messages"><h3>{t("مراسلات الحصة")}</h3>{messages.map(m => <article key={m.id}><strong>{m.name}</strong><small>{date(m.created)}</small><p>{m.body}</p></article>)}<form onSubmit={async (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const form = e.currentTarget; const data = formData(form); if (await act(async () => { const result = await request<{ messages: Message[] }>(`${portal}/bookings/${current.id}/messages`, data); setMessages(result.messages); }, t("تم إرسال الرسالة."))) form.reset(); }}><label>{t("رسالة جديدة")}<textarea name="body" maxLength={2000} rows={2} required /></label><button className="primary-button" disabled={busy || current.status === 'cancelled'}><Send size={17} />{t("إرسال")}</button></form></section>
  </dialog>;
  const callNavigation = portal === 'students'
    ? [{ id: 'home', label: t("الرئيسية") }, { id: 'rooms', label: t("الغرف") }, { id: 'messages', label: t("الرسائل") }, { id: 'tutors', label: t("أساتذتي") }, { id: 'wallet', label: t("المحفظة") }, { id: 'history', label: t("السجل") }, { id: 'profile', label: t("حسابي") }]
    : [{ id: 'home', label: t("الرئيسية") }, { id: 'rooms', label: t("الغرف") }, { id: 'messages', label: t("الرسائل") }, { id: 'available', label: t("المتاحة") }, { id: 'earnings', label: t("المستحقات") }, { id: 'profile', label: t("حسابي") }];
  const callLayer = room && <div className={callCompact ? 'floating-call-shell' : 'immersive-call-shell'} dir={direction()}><Suspense fallback={<div className="call-loading" role="status"><div className="wake-spinner" /><p>{t("جارٍ تجهيز الغرفة…")}</p></div>}><VideoRoom
      key={room.id}
      assignedRole={room.role}
      assignedRoom={room.room}
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
      onLeave={() => { setRoom(null); setCallCompact(false); refresh(); }}
    /></Suspense></div>;
  if (view === 'messages') return <>{callLayer}</>;
  if ((portal === 'admin' && view === 'payments') || (portal === 'teachers' && view === 'earnings')) return <>{callLayer}<PaymentsPanel portal={portal === 'admin' ? 'admin' : 'teachers'} /></>;
  if (portal === 'students') return <>{callLayer}{lessonDetails}<div className="portal-content student-experience">
    {reminders.upcoming.map(b => <div className="lesson-reminder lesson-pulse" key={b.id}><Bell size={22} /><div><strong>{catalogText(b.subject)}</strong><p>{b.start > reminders.now ? t("تبدأ خلال {v0} دقيقة", { v0: Math.ceil((b.start - reminders.now) / 60000) }) : t("حان موعد الحصة")}</p></div><button className="primary-button" onClick={() => onView('rooms')}><Video size={17} />{t("فتح الغرف")}</button></div>)}
    {error && <p className="notice error" role="alert">{t(error)}</p>}{success && <p className="notice success" role="status">{t(success)}</p>}
    {loading || loadedView !== view ? <WorkspaceSkeleton /> : <>
      {view === 'home' && <section className="student-home">
        <WorkspaceOverview user={user} portal={portal} bookings={bookings} availableCount={new Set(openSlots.map(slot => slot.teacher_id)).size} onView={onView}>
          <div className="student-package-explorer" id="learning-path">
            <div className="showcase-heading"><div><span>{t('مساحتك التعليمية')}</span><h2>{studentStep === 'categories' ? t('شو حاب تتعلّم؟') : t(studentCategory)}</h2><p>{studentStep === 'categories' ? t('اختار المجال، وإحنا بنوصلك للأستاذ والموعد المناسب.') : t(activeCategory?.description || 'كل سؤال، بداية جديدة.')}</p></div>{studentSearch}</div>
            {studentStep === 'categories' && <div className="package-grid student-package-grid">{categories.map(([id, title, desc, icon], index) => <button key={id} className="package-card" style={{ '--package-delay': `${Math.min(index, 12) * 55}ms` } as CSSProperties} onClick={() => chooseCategory(id, title)}><span className="package-icon"><CategoryIcon value={icon} /></span><strong>{t(title)}</strong><small>{t(desc)}</small><ChevronLeft size={18} /></button>)}</div>}
            {studentStep !== 'categories' && <div className="student-flow showcase-flow"><button className="package-back" onClick={() => { setStudentStep('categories'); setStudentCategory(''); setStudentLevel(''); setStudentSubject(''); }}><ArrowRight size={18} />{t('كل المجالات')}</button><h3>{studentStep === 'levels' ? t('اختر مستواك الدراسي') : studentStep === 'subjects' ? t('اختر المادة') : t('المواعيد المناسبة إلك')}</h3>{studentStep === 'levels' && <div className="choice-grid">{levels.map(level => <button onClick={() => { setStudentLevel(level); setStudentStep('subjects'); }} key={level}>{t(level)}<ChevronLeft size={16} /></button>)}</div>}{studentStep === 'subjects' && <div className="choice-grid">{subjects.map(subject => <button onClick={() => { setStudentSubject(subject); setStudentStep('tutors'); }} key={subject}>{catalogText(subject)}<ChevronLeft size={16} /></button>)}</div>}{studentStep === 'tutors' && <TutorList slots={subjectSlots} busy={busy} bookSlot={bookSlot} />}</div>}
          </div>
        </WorkspaceOverview>
        <section className="available-tutors home-nearest-tutors"><div className="section-heading"><div><span className="section-kicker">{t('أقرب المواعيد')}</span><h3>{t('احجز حصتك القادمة')}</h3></div><button className="text-button" onClick={() => { setStudentStep('tutors'); setStudentSubject(''); setStudentCategory(''); setStudentLevel(''); setCategoryId(''); }}>{t('الكل')}<ChevronLeft size={16} /></button></div><TutorList slots={openSlots.slice(0, 6)} busy={busy} bookSlot={bookSlot} compact /></section>
      </section>}
      {view === 'rooms' && <RoomHub portal={portal} bookings={bookings} now={reminders.now} filter={roomFilter} onFilter={setRoomFilter} busy={busy} canJoin={canJoinBooking} onJoin={join} />}
      {view === 'tutors' && <section className="student-page"><h2>{t("أساتذتي")}</h2>{!myTutors.length && <Empty text="لم تحجز مع أي أستاذ بعد." />}<div className="student-list">{myTutors.map(b => <article className="saved-tutor" key={b.teacher_id}><div className="avatar"><UserRound size={24} /></div><div><strong>{b.teacher_name}</strong><p>{catalogText(b.subject)}{t(" · آخر حصة ")}{date(b.start)}</p></div><button className="primary-button" onClick={() => onView('home')}>{t("احجز مجدداً")}</button></article>)}</div></section>}
      {view === 'wallet' && <section className="student-page wallet-page"><div className="wallet-hero"><CreditCard size={30} /><span>{t("المحفظة")}</span><strong>{t("قريباً في منصّة")}</strong><p>{t("إضافة الرصيد والدفع الإلكتروني غير متاحين حالياً. يمكنك متابعة حجوزاتك كالمعتاد.")}</p></div><TransactionList bookings={bookings} /></section>}
      {view === 'history' && <section className="student-page"><h2>{t("السجل")}</h2><div className="history-tabs">{[['all', t("الكل")], ['confirmed', t("القادمة")], ['completed', t("المكتملة")], ['cancelled', t("الملغاة")]].map(([id, label]) => <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>{t(label)}</button>)}</div>{!shownBookings.length && <Empty text="لا توجد حصص في هذا القسم." />}<div className="history-list">{shownBookings.map(b => <article key={b.id}><BookOpen size={20} /><div><strong>{catalogText(b.subject)}</strong><p>{b.teacher_name} · {date(b.start)}</p></div><span className={`badge ${b.status}`}>{t(statusNames[b.status])}</span><b>{money(b.price)}</b><button className="secondary-button" onClick={() => setSelected(b.id)}>{t("التفاصيل")}</button></article>)}</div></section>}
      {view === 'profile' && <section className="student-page account-page"><h2>{t("حسابي")}</h2><div className="profile-layout"><form className="work-form" onSubmit={async e => { e.preventDefault(); const data = formData(e.currentTarget); await act(async () => { const result = await request<{ user: User }>(`${portal}/profile`, data); onUser(result.user); }); }}><h3>{t("المعلومات الشخصية")}</h3><label>{t("الاسم الكامل")}<input name="name" defaultValue={user.name} required /></label><label>{t("البريد الإلكتروني")}<input value={user.email} readOnly dir="ltr" /></label><input type="hidden" name="subject" value="" /><input type="hidden" name="bio" value="" /><button className="primary-button" disabled={busy}><Save size={17} />{t("حفظ")}</button></form><aside className="account-facts"><h3>{t("تفاصيل الحساب")}</h3><dl><div><dt>{t("نوع الحساب")}</dt><dd>{t("طالب")}</dd></div><div><dt>{t("حالة الحساب")}</dt><dd><span className={`badge ${user.status}`}>{t(statusNames[user.status])}</span></dd></div><div><dt>{t("تنبيهات الحصص")}</dt><dd><label className="preference-toggle"><input type="checkbox" aria-label={t("تنبيهات الحصص")} checked={reminders.enabled} onChange={reminders.toggle} />{reminders.enabled ? t("مفعّلة") : t("غير مفعّلة")}</label></dd></div></dl></aside></div></section>}
    </>}
    {currentSlot && <dialog ref={node => { if (node && !node.open) node.showModal(); }} onCancel={() => setSelectedSlot(null)} className="detail-dialog"><div className="section-heading"><h2>{catalogText(currentSlot.subject)}</h2><button className="icon-button" title={t("إغلاق التفاصيل")} onClick={() => setSelectedSlot(null)}><X size={20} /></button></div><p>{date(currentSlot.start)}</p><p>{currentSlot.minutes}{t(" دقيقة · ")}{money(currentSlot.price)}</p><span className={`badge ${currentSlot.status}`}>{t(statusNames[currentSlot.status])}</span><div className="row-actions">{currentSlot.status === 'open' && <button className="secondary-button" disabled={busy} onClick={() => { if (window.confirm(t("حذف هذا الموعد؟"))) void act(() => post(`slots/${currentSlot.id}`), t("تم حذف الموعد.")); setSelectedSlot(null); }}><X size={17} />{t("حذف الموعد")}</button>}</div></dialog>}
  </div></>;
  if (portal === 'teachers') return <>{callLayer}{lessonDetails}<div className="portal-content tutor-experience">
    {reminders.upcoming.map(b => <div className="lesson-reminder lesson-pulse" key={b.id}><Bell size={22} /><div><strong>{catalogText(b.subject)}</strong><p>{b.start > reminders.now ? t("تبدأ خلال {v0} دقيقة", { v0: Math.ceil((b.start - reminders.now) / 60000) }) : t("حان موعد الحصة")}</p></div><button className="primary-button" onClick={() => onView('rooms')}><Video size={17} />{t("فتح الغرف")}</button></div>)}
    {error && <p className="notice error" role="alert">{t(error)}</p>}{success && <p className="notice success" role="status">{t(success)}</p>}
    {loading || loadedView !== view ? <WorkspaceSkeleton /> : <>
      {view === 'home' && <section className="tutor-home">
        <WorkspaceOverview user={user} portal={portal} bookings={bookings} availableCount={openSlots.length} onView={onView}>{teacherPackageExplorer}</WorkspaceOverview>
      </section>}
      {view === 'rooms' && <RoomHub portal={portal} bookings={bookings} now={reminders.now} filter={roomFilter} onFilter={setRoomFilter} busy={busy} canJoin={canJoinBooking} onJoin={join} />}
      {view === 'available' && <TeacherAvailabilityHub subjects={teacherSubjects} slots={slots} bookings={bookings} busy={busy} onHome={() => onView('home')} onPublish={publishAvailability} onDelete={deleteSlot} onBookingDetails={setSelected} />}
      {view === 'profile' && <section className="student-page account-page"><h2>{t("حسابي")}</h2><div className="profile-layout"><form className="work-form" onSubmit={async e => { e.preventDefault(); const data = formData(e.currentTarget); await act(async () => { const result = await request<{ user: User }>(`${portal}/profile`, data); onUser(result.user); }); }}><h3>{t("ملف الأستاذ")}</h3><label>{t("الاسم الكامل")}<input name="name" defaultValue={user.name} required /></label><label>{t("البريد الإلكتروني")}<input value={user.email} readOnly dir="ltr" /></label><label>{t("المواد والمستويات")}<textarea value={teachingChoices.map(choice => teachingChoiceLabel(choice, catalog.find(category => category.id === choice.categoryId))).join('\n')} readOnly rows={5} /></label><input type="hidden" name="subject" value={user.subject} /><label>{t("نبذة مهنية")}<textarea name="bio" defaultValue={user.bio} rows={5} /></label><button className="primary-button" disabled={busy}><Save size={17} />{t("حفظ")}</button></form><div className="account-settings"><button onClick={() => setSuccess(t("حالة التوثيق مرتبطة بموافقة الإدارة وتظهر مباشرة بعد تفعيل الحساب."))}>{t("حالة التوثيق: حسب موافقة الإدارة")}</button><button onClick={() => onView('available')}>{t("إعدادات التوفر")}</button><button onClick={() => onView('earnings')}>{t("تفاصيل المستحقات")}</button><button onClick={reminders.toggle}>{t("إعدادات الإشعارات")}</button><button onClick={() => setSuccess(t("يمكنك طلب الدعم من الإدارة عبر رسائل الحصة أو حساب المنصة."))}>{t("المساعدة والدعم")}</button></div></div></section>}
      {view === 'history' && <section className="student-page"><h2>{t("السجل")}</h2><div className="history-tabs"><button onClick={() => setFilter('all')}>{t("الكل")}</button><button onClick={() => setFilter('completed')}>{t("الحصص")}</button><button onClick={() => onView('earnings')}>{t("المستحقات")}</button></div><div className="history-list">{bookings.filter(b => filter === 'all' || b.status === filter).map(b => <article key={b.id}><HistoryIcon size={20} /><div><strong>{b.student_name}</strong><p>{catalogText(b.subject)} · {date(b.start)}</p></div><span className={`badge ${b.status}`}>{t(statusNames[b.status])}</span><b>{money(b.price)}</b></article>)}</div></section>}
    </>}
  </div></>;
  return <>{callLayer}<div className="portal-content">
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
function RoomHub({ portal, bookings, now, filter, onFilter, busy, canJoin, onJoin }: { portal: 'students' | 'teachers'; bookings: Booking[]; now: number; filter: RoomFilter; onFilter: (filter: RoomFilter) => void; busy: boolean; canJoin: (booking: Booking) => boolean; onJoin: (booking: Booking) => Promise<void> }) {
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
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;
    return `${hours ? `${String(hours).padStart(2, '0')}:` : ''}${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
  };
  return <section className="rooms-hub student-page">
    <div className="rooms-hero"><div><span className="rooms-kicker"><Video size={17} />{t("حصصك المباشرة")}</span><h2>{t("غرف الحصص")}</h2><p>{bookings.filter(booking => booking.status === 'confirmed').length}{t(" حصص مؤكدة · ")}{new Date(now).toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' })}</p></div><div className="rooms-live-summary"><strong>{bookings.filter(booking => booking.status === 'confirmed' && Number(portal === 'students' ? booking.teacher_present_until : booking.student_present_until) > now).length}</strong><span>{portal === 'students' ? t("أساتذة داخل الغرفة الآن") : t("طلاب بانتظارك الآن")}</span></div></div>
    <div className="room-filters" role="tablist" aria-label={t("فلترة غرف الحصص")}>{filters.map(([id, label]) => <button type="button" role="tab" aria-selected={filter === id} className={filter === id ? 'active' : ''} onClick={() => onFilter(id)} key={id}>{t(label)}</button>)}</div>
    {!visible.length && <Empty text="لا توجد حصص ضمن هذه الفترة." />}
    <div className="room-list">{visible.map(booking => {
      const teacherLive = Number(booking.teacher_present_until || 0) > now;
      const studentLive = Number(booking.student_present_until || 0) > now;
      const counterpartLive = portal === 'students' ? teacherLive : studentLive;
      const end = booking.start + booking.minutes * 60000;
      const upcoming = booking.start > now;
      const joinable = canJoin(booking);
      const person = portal === 'students' ? booking.teacher_name : booking.student_name;
      return <article className={`room-card ${counterpartLive ? 'is-live' : ''}`} key={booking.id}>
        <div className="room-card-date"><span>{new Date(booking.start).toLocaleDateString(locale(), { weekday: 'long' })}</span><strong>{new Date(booking.start).toLocaleDateString(locale(), { day: 'numeric', month: 'short' })}</strong></div>
        <div className="room-card-main"><div className="room-card-title"><span className={`room-status ${counterpartLive ? 'live' : booking.status}`}>{counterpartLive ? <><Video size={14} />{t("LIVE الآن")}</> : statusNames[booking.status]}</span><h3>{catalogText(booking.subject)}</h3></div><p>{person} · {timeOnly(booking.start)} - {timeOnly(end)} · {booking.minutes}{t(" دقيقة")}</p><div className="room-presence"><span className={teacherLive ? 'online' : ''}>{t("الأستاذ ")}{teacherLive ? t("داخل الغرفة") : t("لم يدخل بعد")}</span><span className={studentLive ? 'online' : ''}>{t("الطالب ")}{studentLive ? t("داخل الغرفة") : t("لم يدخل بعد")}</span></div></div>
        <div className="room-card-action">{booking.status === 'confirmed' && upcoming && <div className="room-countdown"><small>{t("تبدأ بعد")}</small><strong dir="ltr" aria-live="polite">{countdown(booking.start)}</strong></div>}{booking.status === 'confirmed' && !upcoming && !counterpartLive && now <= end && <span className="room-started">{t("بدأ موعد الحصة")}</span>}{booking.status === 'confirmed' ? <button className={counterpartLive ? 'primary-button live-button' : 'primary-button'} disabled={busy || !joinable} title={joinable ? t("دخول غرفة الحصة") : t("يفتح الدخول قبل الموعد بـ15 دقيقة")} onClick={() => void onJoin(booking)}><Video size={17} />{counterpartLive ? t("انضم الآن") : joinable ? t("دخول الغرفة") : t("تفتح قبل 15 دقيقة")}</button> : <span className="room-closed">{booking.status === 'completed' ? t("تمت الحصة") : t("أُلغيت الحصة")}</span>}</div>
      </article>;
    })}</div>
  </section>;
}
function TutorList({ slots, busy, bookSlot, compact = false }: { slots: Slot[]; busy: boolean; bookSlot: (slot: Slot) => void; compact?: boolean }) {
  usePreferences();
  if (!slots.length) return <Empty text="لا توجد مواعيد مناسبة حالياً." />;
  return <div className={compact ? 'tutor-strip' : 'tutor-market-list'}>{slots.map(slot => <article className="tutor-card" key={slot.id}>
    <div className="tutor-photo">{slot.teacher_name?.slice(0, 1) || 'أ'}</div>
    <div className="tutor-info"><div><strong>{slot.teacher_name || t("أستاذ منصّة")}</strong><BadgeCheck className="verified-icon" size={17} aria-label={t("أستاذ منصّة")} /></div><p>{catalogText(slot.subject)}</p><small><Clock3 size={14} />{slot.minutes}{t(" دقيقة")}{slot.bio && <span> · {slot.bio}</span>}</small><time><CalendarPlus size={14} />{date(slot.start)}</time></div>
    <div className="tutor-actions"><b>{money(slot.price)}<small>{t("للحصة")}</small></b><button className="primary-button" disabled={busy} onClick={() => bookSlot(slot)}><CalendarPlus size={16} />{t("احجز الآن")}</button></div>
  </article>)}</div>;
}

function TransactionList({ bookings }: { bookings: Booking[] }) {
  usePreferences();
  const rows = bookings.slice(0, 6);
  return <div className="transaction-list"><h3>{t("سجل العمليات")}</h3>{!rows.length && <Empty text="لا توجد عمليات بعد." />}{rows.map(b => <article key={b.id}><span className={b.paid ? 'positive' : 'negative'}>{b.paid ? t("دفع حصة") : t("حجز غير مدفوع")}</span><div><strong>{catalogText(b.subject)}</strong><small>{date(b.start)}</small></div><b className={b.paid ? 'negative' : ''}>{b.paid ? '-' : ''}{money(b.price)}</b></article>)}</div>;
}

function Empty({ text }: { text: string }) {
  usePreferences(); return <div className="empty-state"><CalendarPlus size={30} /><p>{t(text)}</p></div>; }




