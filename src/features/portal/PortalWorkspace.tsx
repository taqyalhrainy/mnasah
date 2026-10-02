import { lazy, Suspense, useEffect, useState, type FormEvent } from 'react';
import { BookOpen, CalendarPlus, Check, ChevronLeft, CreditCard, Download, History as HistoryIcon, RefreshCw, Search, Send, UserRound, Video, X, Save, Bell, BellOff, Clock3, BadgeCheck, ArrowRight } from 'lucide-react';
import { request, date, money, statusNames, type Booking, type Slot, type Portal, type User, type Message } from '../../services/platformApi';
import { useLessonReminders, reminderPhase } from './useLessonReminders';
import { AccountsPanel } from './AccountsPanel';
import { CatalogPanel } from './CatalogPanel';
import { WorkspaceOverview, WorkspaceSkeleton } from './WorkspaceOverview';
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
const timeOnly = (value: number) => new Date(value).toLocaleTimeString('ar-JO', { hour: '2-digit', minute: '2-digit' });
const normalizedSearch = (value: string) => value.normalize('NFKD').toLocaleLowerCase().replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/[أإآ]/g, 'ا').replace(/ؤ/g, 'و').replace(/ئ|ى/g, 'ي').replace(/ة/g, 'ه').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const searchKeys = (value: string) => { const normalized = normalizedSearch(value).replaceAll(' ', ''); return [normalized, normalized.replace(/[اوي]/g, '')].filter(key => key.length > 1); };
const fuzzyMatch = (left: string, right: string) => searchKeys(left).some(a => searchKeys(right).some(b => a.includes(b) || b.includes(a)));
const teachesSubject = (list: string, subject: string) => list.split(' | ').some(item => fuzzyMatch(item, subject));
type TeachingChoice = { categoryId: string; categoryName: string; subject: string; levels: string[] };
const teachingChoiceKey = (categoryId: string, subject: string) => `${categoryId}\u0000${subject}`;
const uniqueTeachingChoices = (choices: TeachingChoice[]) => [...new Map(choices.map(choice => [teachingChoiceKey(choice.categoryId, choice.subject), choice])).values()];
const serializeTeachingChoices = (choices: TeachingChoice[]) => choices.map(choice => [choice.categoryName, choice.subject, choice.levels.join('، ')].filter(Boolean).join(' › ')).join(' | ');
const teachingChoiceLabel = (choice: TeachingChoice, category?: Category) => `${choice.categoryName} › ${choice.subject}${category?.levels.length ? ` › ${choice.levels.length === category.levels.length ? 'كل المستويات' : choice.levels.join('، ')}` : ''}`;
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

export function PortalWorkspace({ portal, user, view, onUser, onView, onRoomLiveChange }: { portal: Portal; user: User; view: string; onUser: (u: User | null) => void; onView: (view: string) => void; onRoomLiveChange?: (live: boolean) => void }) {
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);
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
  const [availabilityDay, setAvailabilityDay] = useState(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); });
  const [availabilityMode, setAvailabilityMode] = useState<'range' | 'custom'>('range');
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [callCompact, setCallCompact] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const reminders = useLessonReminders(portal, user.id, revision, room?.id);
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
      if (failure) setError(failure instanceof Error ? failure.message : 'تعذر تحميل بعض البيانات. حاول مجدداً.');
    }).finally(() => { if (alive) setLoading(false); });
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
  async function act(action: () => Promise<unknown>, message = 'تم حفظ التغييرات.') {
    setBusy(true); setError(''); setSuccess('');
    try { await action(); setSuccess(message); refresh(); return true; }
    catch (e) { setError((e as Error).message); return false; }
    finally { setBusy(false); }
  }
  const post = (path: string, body: unknown = {}) => request(`${portal}/${path}`, body);
  const current = bookings.find(b => b.id === selected);
  const currentSlot = slots.find(s => s.id === selectedSlot);
  const deleteSlot = (id: string) => { if (window.confirm('حذف هذا الموعد؟')) void act(async () => { await post(`slots/${id}`); setSlots(rows => rows.filter(slot => slot.id !== id)); setSelectedSlot(null); }, 'تم حذف الموعد.'); };
  const matches = (value: string) => normalizedSearch(value).includes(normalizedSearch(query));
  const shownBookings = bookings.filter(b => matches(`${b.subject} ${b.teacher_name} ${b.student_name}`) && (filter === 'all' || b.status === filter));
  const canJoinBooking = (booking: Booking) => booking.status === 'confirmed' && reminders.now >= booking.start - 15 * 60000;
  function exportBookings() {
    const safe = (value: unknown) => `"${String(value).replace(/^[=+@-]/, "'").replaceAll('"', '""')}"`;
    const rows = [['المادة', 'الأستاذ', 'الطالب', 'الموعد', 'الحالة', 'السعر بالدينار', 'مدفوع', 'مرجع الدفعة'], ...shownBookings.map(b => [b.subject, b.teacher_name, b.student_name, date(b.start), statusNames[b.status], b.price / 100, b.paid ? 'نعم' : 'لا', b.payment_ref])];
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
    }, 'الغرفة جاهزة.');
  }
  const cancel = (b: Booking) => { if (window.confirm(`إلغاء حصة ${b.subject} بتاريخ ${date(b.start)}؟`)) void act(() => post(`bookings/${b.id}/cancel`), 'تم إلغاء الحصة.'); };
  const openSlots = slots.filter(s => s.status === 'open' && (s.available_until || s.start + s.minutes * 60000) > Date.now() && matches(`${s.subject} ${s.teacher_name || ''} ${s.teacher_subjects || ''}`));
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const today = todayStart.getTime(), tomorrow = today + 86400000;
  const weekDays = Array.from({ length: 7 }, (_, index) => {
    const d = new Date(today); d.setDate(todayStart.getDate() + index);
    const name = d.toLocaleDateString('ar-JO', { weekday: 'long' });
    return { name, value: d.getTime(), label: d.toLocaleDateString('ar-JO', { month: 'short', day: 'numeric' }) };
  });
  const teacherBooked = bookings.filter(b => b.status === 'confirmed' && (filter === 'all' || (filter === 'today' && b.start >= today && b.start < tomorrow) || (filter === 'tomorrow' && b.start >= tomorrow && b.start < tomorrow + 86400000) || (filter === 'week' && b.start >= today && b.start < today + 604800000))).sort((a, b) => a.start - b.start);
  const completedThisWeek = bookings.filter(b => b.status === 'completed');
  const grossEarnings = completedThisWeek.reduce((sum, b) => sum + b.price, 0);
  const platformFee = Math.round(grossEarnings * 0.15);
  const netEarnings = grossEarnings - platformFee;
  const teacherMap = new Map<string, Booking>();
  bookings.forEach(b => { if (!teacherMap.has(b.teacher_id)) teacherMap.set(b.teacher_id, b); });
  const myTutors = [...teacherMap.values()];
  const categories = catalog.map(category => [category.id, category.name, category.description, category.icon] as const);
  const catalogSubjects = [...new Set(catalog.flatMap(category => category.subjects))];
  const teacherSubjects = [...new Set(teachingChoices.map(choice => choice.subject))];
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
  const studentSearch = <label className="student-search"><Search size={19} /><input aria-label="بحث" placeholder="ابحث عن مادة أو أستاذ" value={query} onChange={e => setQuery(e.target.value)} /></label>;
  const bookSlot = (s: Slot) => { if (window.confirm(`تأكيد حجز الحصة بقيمة ${money(s.price)}؟`)) void act(() => post(`slots/${s.id}`), 'تم تأكيد الحجز. ستجده في السجل.'); };
  const atTime = (day: number, time: unknown) => { const [h, m] = String(time).split(':').map(Number); const d = new Date(day); d.setHours(h || 0, m || 0, 0, 0); return d.getTime(); };
  const addSlotForm = <form className="work-form availability-composer" onSubmit={async e => {
    e.preventDefault(); const form = e.currentTarget; const data = formData(form);
    const start = atTime(availabilityDay, availabilityMode === 'range' ? data.from : data.time);
    const end = availabilityMode === 'range' ? atTime(availabilityDay, data.to) : 0;
    const rangeMinutes = availabilityMode === 'range' ? Math.round((end - start) / 60000) : 0;
    const minutes = Number(data.minutes);
    if (availabilityMode === 'range' && rangeMinutes < minutes) { setError('الفترة المتاحة يجب أن تكون أطول من مدة الحصة أو تساويها.'); return; }
    if (availabilityMode === 'range' && end <= Date.now()) { setError('انتهت الفترة التي اخترتها. اختر وقت نهاية بعد الوقت الحالي.'); return; }
    if (availabilityMode === 'custom' && start <= Date.now()) { setError('اختر وقتاً مخصصاً بعد الوقت الحالي.'); return; }
    if (await act(() => post('slots', { subject: data.subject, start, minutes, available_until: availabilityMode === 'range' ? end : start + minutes * 60000, price: Math.round(Number(data.price) * 100) }), 'تم نشر الموعد.')) form.reset();
  }}><div className="availability-form-head"><h3>إضافة توفر</h3><p>{weekDays.find(d => d.value === availabilityDay)?.name} · {weekDays.find(d => d.value === availabilityDay)?.label}</p></div><label>المادة<select name="subject" defaultValue={studentSubject || 'كل المواد المختارة'}>{teacherSubjects.length > 1 && <option>كل المواد المختارة</option>}{(teacherSubjects.length ? teacherSubjects : [user.subject || studentSubject || studentCategory]).map(subject => <option key={subject} value={subject}>{subject}</option>)}</select></label><label>السعر بالدينار<input name="price" type="number" min="0" max="1000" step="0.01" required /></label><div className="availability-mode" role="tablist"><button type="button" className={availabilityMode === 'range' ? 'selected' : ''} onClick={() => setAvailabilityMode('range')}>فترة زمنية</button><button type="button" className={availabilityMode === 'custom' ? 'selected' : ''} onClick={() => setAvailabilityMode('custom')}>وقت مخصص</button></div>{availabilityMode === 'range' ? <><div className="availability-time-row"><label>متاح من<input name="from" type="time" defaultValue="16:00" required /></label><label>متاح إلى<input name="to" type="time" defaultValue="22:00" required /></label></div><label>مدة الحصة<select name="minutes" defaultValue="60">{[30, 45, 60, 90, 120].map(n => <option key={n} value={n}>{n} دقيقة</option>)}</select></label></> : <div className="availability-time-row"><label>الوقت<input name="time" type="time" defaultValue="16:00" required /></label><label>مدة الحصة<select name="minutes" defaultValue="60">{[30, 45, 60, 90, 120].map(n => <option key={n} value={n}>{n} دقيقة</option>)}</select></label></div>}<button className="primary-button" disabled={busy}><CalendarPlus size={17} />نشر التوفر</button></form>;
  const lessonDetails = current && <dialog ref={node => { if (node && !node.open) node.showModal(); }} onCancel={() => setSelected(null)} className="detail-dialog" aria-labelledby="lesson-title"><div className="section-heading"><h2 id="lesson-title">{current.subject}</h2><button className="icon-button" title="إغلاق التفاصيل" onClick={() => setSelected(null)}><X size={20} /></button></div>{error && <p className="notice error" role="alert">{error}</p>}{success && <p className="notice success" role="status">{success}</p>}<p>{current.teacher_name} · {current.student_name}</p><p>{date(current.start)} · {money(current.price)}</p><span className={`badge ${current.status}`}>{statusNames[current.status]}</span>
    <div className="lesson-notes"><h3>ملخص الحصة والواجب</h3><p>{current.notes || 'لا يوجد ملخص بعد.'}</p>{current.resource && <a href={current.resource} target="_blank" rel="noopener noreferrer">فتح المادة التعليمية</a>}</div>
    {portal === 'admin' && <form className="work-form" key={`payment-${current.id}-${current.paid}`} onSubmit={e => { e.preventDefault(); const data = formData(e.currentTarget); void act(() => post(`bookings/${current.id}/payment`, { paid: current.paid ? 0 : 1, reference: data.reference || '' })); }}><h3>{current.paid ? 'الدفعة مسجلة' : 'تسجيل دفعة مستلمة'}</h3><label>مرجع الحوالة أو الإيصال<input name="reference" defaultValue={current.payment_ref} maxLength={200} required={!current.paid} /></label><button className="secondary-button" disabled={busy}>{current.paid ? 'عكس تسجيل الدفعة' : 'تأكيد الاستلام اليدوي'}</button></form>}
    <div className="row-actions">{current.status === 'confirmed' && <button className="secondary-button" disabled={busy} onClick={() => cancel(current)}>إلغاء الحصة</button>}</div>
    <section className="lesson-messages"><h3>مراسلات الحصة</h3>{messages.map(m => <article key={m.id}><strong>{m.name}</strong><small>{date(m.created)}</small><p>{m.body}</p></article>)}<form onSubmit={async (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const form = e.currentTarget; const data = formData(form); if (await act(async () => { const result = await request<{ messages: Message[] }>(`${portal}/bookings/${current.id}/messages`, data); setMessages(result.messages); }, 'تم إرسال الرسالة.')) form.reset(); }}><label>رسالة جديدة<textarea name="body" maxLength={2000} rows={2} required /></label><button className="primary-button" disabled={busy || current.status === 'cancelled'}><Send size={17} />إرسال</button></form></section>
  </dialog>;
  const callNavigation = portal === 'students'
    ? [{ id: 'home', label: 'الرئيسية' }, { id: 'rooms', label: 'الغرف' }, { id: 'tutors', label: 'أساتذتي' }, { id: 'wallet', label: 'المحفظة' }, { id: 'history', label: 'السجل' }, { id: 'profile', label: 'حسابي' }]
    : [{ id: 'home', label: 'الرئيسية' }, { id: 'rooms', label: 'الغرف' }, { id: 'booked', label: 'المحجوزة' }, { id: 'available', label: 'المتاحة' }, { id: 'earnings', label: 'المستحقات' }, { id: 'profile', label: 'حسابي' }];
  const callLayer = room && <div className={callCompact ? 'floating-call-shell' : 'immersive-call-shell'} dir="rtl"><Suspense fallback={<div className="call-loading" role="status"><div className="wake-spinner" /><p>جارٍ تجهيز الغرفة…</p></div>}><VideoRoom
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
  if (portal === 'students') return <>{callLayer}{lessonDetails}<div className="portal-content student-experience">
    <div className="reminder-settings"><button className="secondary-button" aria-pressed={reminders.enabled} onClick={reminders.toggle}>{reminders.enabled ? <Bell size={18} /> : <BellOff size={18} />}{reminders.enabled ? 'التنبيهات مفعّلة' : 'تفعيل تنبيهات الحصص'}</button>{reminders.hint && <small role="status">{reminders.hint}</small>}</div>
    {reminders.upcoming.map(b => <div className="lesson-reminder lesson-pulse" key={b.id}><Bell size={22} /><div><strong>{b.subject}</strong><p>{b.start > reminders.now ? `تبدأ خلال ${Math.ceil((b.start - reminders.now) / 60000)} دقيقة` : 'حان موعد الحصة'}</p></div><button className="primary-button" onClick={() => onView('rooms')}><Video size={17} />فتح الغرف</button></div>)}
    {error && <p className="notice error" role="alert">{error}</p>}{success && <p className="notice success" role="status">{success}</p>}
    {loading ? <WorkspaceSkeleton /> : <>
      {view === 'home' && <section className="student-home">
        <WorkspaceOverview user={user} portal={portal} bookings={bookings} availableCount={new Set(openSlots.map(slot => slot.teacher_id)).size} onView={onView} />
        <div className="student-hero" id="learning-path"><div><span className="section-kicker">مسارك القادم</span><h2>ماذا سنتعلّم اليوم؟</h2></div>{studentSearch}</div>
        {studentStep === 'categories' && <div className="category-grid">{categories.map(([id, title, desc, icon]) => <button key={id} className="category-card" onClick={() => chooseCategory(id, title)}><span><CategoryIcon value={icon} /></span><strong>{title}</strong><p>{desc}</p><ChevronLeft size={18} /></button>)}</div>}
        {studentStep !== 'categories' && <div className="student-flow"><div className="discovery-path"><button className="text-button back-to-categories" onClick={() => { setStudentStep('categories'); setStudentCategory(''); setStudentLevel(''); setStudentSubject(''); }}><ArrowRight size={16} />العودة للتصنيفات</button><ChevronLeft size={15} /><button className="text-button" onClick={() => { setStudentStep(levels.length ? 'levels' : subjects.length ? 'subjects' : 'tutors'); setStudentLevel(''); setStudentSubject(''); }}>{studentCategory}</button>{studentLevel && <><ChevronLeft size={15} /><button className="text-button" onClick={() => { setStudentStep('subjects'); setStudentSubject(''); }}>{studentLevel}</button></>}{studentSubject && <><ChevronLeft size={15} /><span>{studentSubject}</span></>}</div><h3>{studentStep === 'levels' ? 'اختر مستواك الدراسي' : studentStep === 'subjects' ? 'اختر المادة' : 'موعدك مع التعلّم'}</h3>{studentStep === 'levels' && <div className="choice-grid">{levels.map(level => <button onClick={() => { setStudentLevel(level); setStudentStep('subjects'); }} key={level}>{level}<ChevronLeft size={16} /></button>)}</div>}{studentStep === 'subjects' && <div className="choice-grid">{subjects.map(subject => <button onClick={() => { setStudentSubject(subject); setStudentStep('tutors'); }} key={subject}>{subject}<ChevronLeft size={16} /></button>)}</div>}{studentStep === 'tutors' && <TutorList slots={subjectSlots} busy={busy} bookSlot={bookSlot} />}</div>}
        <section className="available-tutors"><div className="section-heading"><div><span className="section-kicker">وقت مناسب، وأستاذ مناسب</span><h3>مواعيد متاحة للحجز</h3></div><button className="text-button" onClick={() => { setStudentStep('tutors'); setStudentSubject(''); setStudentCategory(''); setStudentLevel(''); setCategoryId(''); }}>عرض الكل<ChevronLeft size={16} /></button></div><TutorList slots={openSlots.slice(0, 6)} busy={busy} bookSlot={bookSlot} compact /></section>
      </section>}
      {view === 'rooms' && <RoomHub portal={portal} bookings={bookings} now={reminders.now} filter={roomFilter} onFilter={setRoomFilter} busy={busy} canJoin={canJoinBooking} onJoin={join} />}
      {view === 'tutors' && <section className="student-page"><h2>أساتذتي</h2>{!myTutors.length && <Empty text="لم تحجز مع أي أستاذ بعد." />}<div className="student-list">{myTutors.map(b => <article className="saved-tutor" key={b.teacher_id}><div className="avatar"><UserRound size={24} /></div><div><strong>{b.teacher_name}</strong><p>{b.subject} · آخر حصة {date(b.start)}</p></div><button className="primary-button" onClick={() => onView('home')}>احجز مجدداً</button></article>)}</div></section>}
      {view === 'wallet' && <section className="student-page wallet-page"><div className="wallet-hero"><CreditCard size={30} /><span>المحفظة</span><strong>قريباً في منصّة</strong><p>إضافة الرصيد والدفع الإلكتروني غير متاحين حالياً. يمكنك متابعة حجوزاتك كالمعتاد.</p></div><TransactionList bookings={bookings} /></section>}
      {view === 'history' && <section className="student-page"><h2>السجل</h2><div className="history-tabs">{[['all', 'الكل'], ['confirmed', 'القادمة'], ['completed', 'المكتملة'], ['cancelled', 'الملغاة']].map(([id, label]) => <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>)}</div>{!shownBookings.length && <Empty text="لا توجد حصص في هذا القسم." />}<div className="history-list">{shownBookings.map(b => <article key={b.id}><BookOpen size={20} /><div><strong>{b.subject}</strong><p>{b.teacher_name} · {date(b.start)}</p></div><span className={`badge ${b.status}`}>{statusNames[b.status]}</span><b>{money(b.price)}</b><button className="secondary-button" onClick={() => setSelected(b.id)}>التفاصيل</button></article>)}</div></section>}
      {view === 'profile' && <section className="student-page account-page"><h2>حسابي</h2><div className="profile-layout"><form className="work-form" onSubmit={async e => { e.preventDefault(); const data = formData(e.currentTarget); await act(async () => { const result = await request<{ user: User }>(`${portal}/profile`, data); onUser(result.user); }); }}><h3>المعلومات الشخصية</h3><label>الاسم الكامل<input name="name" defaultValue={user.name} required /></label><label>البريد الإلكتروني<input value={user.email} readOnly dir="ltr" /></label><label>المرحلة الدراسية<input placeholder="مثال: توجيهي" disabled /></label><input type="hidden" name="subject" value="" /><input type="hidden" name="bio" value="" /><button className="primary-button" disabled={busy}><Save size={17} />حفظ</button></form><div className="account-settings"><button disabled>الإشعارات غير متاحة</button><button disabled>طرق الدفع غير متاحة</button><button disabled>الخصوصية والأمان قريباً</button><button disabled>المساعدة والدعم قريباً</button></div></div></section>}
    </>}
    {currentSlot && <dialog ref={node => { if (node && !node.open) node.showModal(); }} onCancel={() => setSelectedSlot(null)} className="detail-dialog"><div className="section-heading"><h2>{currentSlot.subject}</h2><button className="icon-button" title="إغلاق التفاصيل" onClick={() => setSelectedSlot(null)}><X size={20} /></button></div><p>{date(currentSlot.start)}</p><p>{currentSlot.minutes} دقيقة · {money(currentSlot.price)}</p><span className={`badge ${currentSlot.status}`}>{statusNames[currentSlot.status]}</span><div className="row-actions">{currentSlot.status === 'open' && <button className="secondary-button" disabled={busy} onClick={() => { if (window.confirm('حذف هذا الموعد؟')) void act(() => post(`slots/${currentSlot.id}`), 'تم حذف الموعد.'); setSelectedSlot(null); }}><X size={17} />حذف الموعد</button>}</div></dialog>}
  </div></>;
  if (portal === 'teachers') return <>{callLayer}{lessonDetails}<div className="portal-content tutor-experience">
    <div className="reminder-settings"><button className="secondary-button" aria-pressed={reminders.enabled} onClick={reminders.toggle}>{reminders.enabled ? <Bell size={18} /> : <BellOff size={18} />}{reminders.enabled ? 'التنبيهات مفعّلة' : 'تفعيل تنبيهات الحصص'}</button>{reminders.hint && <small role="status">{reminders.hint}</small>}</div>
    {reminders.upcoming.map(b => <div className="lesson-reminder lesson-pulse" key={b.id}><Bell size={22} /><div><strong>{b.subject}</strong><p>{b.start > reminders.now ? `تبدأ خلال ${Math.ceil((b.start - reminders.now) / 60000)} دقيقة` : 'حان موعد الحصة'}</p></div><button className="primary-button" onClick={() => onView('rooms')}><Video size={17} />فتح الغرف</button></div>)}
    {error && <p className="notice error" role="alert">{error}</p>}{success && <p className="notice success" role="status">{success}</p>}
    {loading ? <WorkspaceSkeleton /> : <>
      {view === 'home' && <section className="tutor-home">
        <WorkspaceOverview user={user} portal={portal} bookings={bookings} availableCount={openSlots.length} onView={onView} />
        <form className="teaching-picker" onSubmit={async e => { e.preventDefault(); const subject = serializeTeachingChoices(teachingChoices); await act(async () => { const result = await request<{ user: User }>(`${portal}/profile`, { name: user.name, bio: user.bio, subject }); onUser(result.user); }, 'تم حفظ المواد والمستويات التي تدرسها.'); }}>
          <div className="section-heading"><div><span className="section-kicker">ملفك التعليمي</span><h3>مجالاتك وموادك</h3></div><button className="primary-button" disabled={busy}><Save size={17} />حفظ</button></div>
          <div className="category-grid teaching-category-grid">{catalog.map(category => <details className="category-card teaching-category-card" key={category.id}><summary><span><CategoryIcon value={category.icon} /></span><strong>{category.name}</strong><p>{category.description}</p><ChevronLeft size={18} /></summary><div className="teaching-subjects">{category.subjects.map(subject => {
            const choice = teachingChoices.find(item => item.categoryId === category.id && item.subject === subject);
            const allLevels = Boolean(choice && category.levels.length && category.levels.every(level => choice.levels.includes(level)));
            const subjectCheckbox = <label className="teaching-subject-main" onClick={event => event.stopPropagation()}><input type="checkbox" aria-label={`تدريس ${subject}`} checked={Boolean(choice)} onChange={event => updateTeachingSubject(category, subject, event.currentTarget.checked)} />{subject}</label>;
            if (!category.levels.length) return <div className="teaching-subject-row no-levels" key={subject}>{subjectCheckbox}</div>;
            const selectionSummary = !choice ? 'اختيار المستويات' : allLevels ? 'كل المستويات' : choice.levels.length === 1 ? 'مستوى واحد مختار' : `${choice.levels.length} مستويات مختارة`;
            return <details className="teaching-subject-row teaching-level-picker" key={subject}><summary>{subjectCheckbox}<span className="teaching-level-summary">{selectionSummary}</span><ChevronLeft size={17} /></summary><div className="teaching-levels" aria-label={`مستويات ${subject}`}><label className="teaching-level-option all-levels"><input type="checkbox" aria-label={`كل مستويات ${subject}`} checked={allLevels} onChange={event => updateTeachingSubject(category, subject, event.currentTarget.checked)} />كل المستويات</label>{category.levels.map(level => <label className="teaching-level-option" key={level}><input type="checkbox" aria-label={`${subject} - ${level}`} checked={Boolean(choice?.levels.includes(level))} onChange={event => updateTeachingLevel(category, subject, level, event.currentTarget.checked)} />{level}</label>)}</div></details>;
          })}</div></details>)}</div>
          <div className="selected-teaching"><strong>المواد والمستويات المختارة</strong>{teachingChoices.length ? <div>{teachingChoices.map(choice => <span key={teachingChoiceKey(choice.categoryId, choice.subject)}>{teachingChoiceLabel(choice, catalog.find(category => category.id === choice.categoryId))}</span>)}</div> : <p className="muted">لم تختر مواد بعد.</p>}</div>
        </form>
      </section>}
      {view === 'rooms' && <RoomHub portal={portal} bookings={bookings} now={reminders.now} filter={roomFilter} onFilter={setRoomFilter} busy={busy} canJoin={canJoinBooking} onJoin={join} />}
      {view === 'booked' && <section className="student-page"><div className="section-heading"><h2>المواعيد المحجوزة</h2><div className="history-tabs"><button onClick={() => setFilter('today')}>اليوم</button><button onClick={() => setFilter('tomorrow')}>غداً</button><button onClick={() => setFilter('week')}>الأسبوع</button></div></div>{!teacherBooked.length && <Empty text="لا توجد حصص محجوزة حالياً." />}<div className="history-list">{teacherBooked.map((b, i) => <article className={i === 0 ? 'next-booking' : ''} key={b.id}><BookOpen size={20} /><div><strong>{b.subject}</strong><p>{b.student_name} · {date(b.start)} · {b.minutes} دقيقة</p></div><span className={`badge ${b.status}`}>{statusNames[b.status]}</span><b>{money(b.price)}</b><button className="secondary-button" onClick={() => setSelected(b.id)}>التفاصيل</button></article>)}</div></section>}
      {view === 'available' && <section className="student-page availability-page"><div className="section-heading"><div><h2>المواعيد المتاحة</h2><p className="muted">اختر اليوم، ثم أضف فترة كاملة أو وقت واحد.</p></div></div><div className="availability-planner"><div className="availability-days">{weekDays.map(day => <button key={day.value} type="button" className={availabilityDay === day.value ? 'selected' : ''} onClick={() => setAvailabilityDay(day.value)}><strong>{day.name}</strong><span>{day.label}</span><small>{slots.filter(s => s.status !== 'cancelled' && new Date(s.start).toDateString() === new Date(day.value).toDateString()).length} موعد</small></button>)}</div>{addSlotForm}</div><div className="week-board">{weekDays.map(day => <div key={day.value}><strong>{day.name}</strong>{slots.filter(s => s.status !== 'cancelled' && new Date(s.start).toDateString() === new Date(day.value).toDateString()).slice(0, 4).map(s => <button type="button" className={s.status === 'booked' ? 'booked' : 'available'} key={s.id} onPointerDown={() => setSelectedSlot(s.id)} onClick={() => setSelectedSlot(s.id)}>{timeOnly(s.start)} - {timeOnly(s.available_until || s.start + s.minutes * 60000)} · {s.status === 'booked' ? 'محجوز' : 'متاح'}</button>)}{!slots.filter(s => s.status !== 'cancelled' && new Date(s.start).toDateString() === new Date(day.value).toDateString()).length && <small>غير محدد</small>}</div>)}</div>{currentSlot && <article className="slot-detail-card"><div className="section-heading"><div><span className={`badge ${currentSlot.status}`}>{statusNames[currentSlot.status]}</span><h3>{currentSlot.subject}</h3></div><button className="icon-button" type="button" onClick={() => setSelectedSlot(null)}><X size={18} /></button></div><p><strong>التاريخ:</strong> {new Date(currentSlot.start).toLocaleDateString('ar-JO')}</p><p><strong>الفترة المتاحة:</strong> {timeOnly(currentSlot.start)} - {timeOnly(currentSlot.available_until || currentSlot.start + currentSlot.minutes * 60000)}</p><p><strong>طول الحصة:</strong> {currentSlot.minutes} دقيقة</p><p><strong>المواد المتاحة:</strong> {currentSlot.subject}</p><p><strong>السعر:</strong> {money(currentSlot.price)}</p>{currentSlot.status === 'open' && <button className="secondary-button" disabled={busy} onClick={() => deleteSlot(currentSlot.id)}><X size={17} />حذف الموعد</button>}</article>}</section>}
      {view === 'earnings' && <section className="student-page earnings-page"><div className="wallet-hero"><span>مستحقات الحصص المكتملة</span><strong>{money(netEarnings)}</strong><p>الحصص المكتملة: {completedThisWeek.length} · إجمالي الحصص: {money(grossEarnings)} · عمولة المنصة: {money(platformFee)}</p><span className="badge pending">قيد الانتظار</span></div><div className="earnings-week">{['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'].map((day, i) => <article key={day}><span>{day}</span><strong>{money(completedThisWeek.filter(booking => new Date(booking.start).getDay() === i).reduce((sum, b) => sum + Math.round(b.price * .85), 0))}</strong></article>)}</div><p className="notice">التحويلات البنكية غير متاحة حالياً.</p><button className="text-button" onClick={() => onView('history')}>عرض السجل<ChevronLeft size={16} /></button></section>}
      {view === 'profile' && <section className="student-page account-page"><h2>حسابي</h2><div className="profile-layout"><form className="work-form" onSubmit={async e => { e.preventDefault(); const data = formData(e.currentTarget); await act(async () => { const result = await request<{ user: User }>(`${portal}/profile`, data); onUser(result.user); }); }}><h3>ملف الأستاذ</h3><label>الاسم الكامل<input name="name" defaultValue={user.name} required /></label><label>البريد الإلكتروني<input value={user.email} readOnly dir="ltr" /></label><label>المواد والمستويات<textarea value={teachingChoices.map(choice => teachingChoiceLabel(choice, catalog.find(category => category.id === choice.categoryId))).join('\n')} readOnly rows={5} /></label><input type="hidden" name="subject" value={user.subject} /><label>نبذة مهنية<textarea name="bio" defaultValue={user.bio} rows={5} /></label><button className="primary-button" disabled={busy}><Save size={17} />حفظ</button></form><div className="account-settings"><button onClick={() => setSuccess('حالة التوثيق مرتبطة بموافقة الإدارة وتظهر مباشرة بعد تفعيل الحساب.')}>حالة التوثيق: حسب موافقة الإدارة</button><button onClick={() => onView('available')}>إعدادات التوفر</button><button onClick={() => onView('earnings')}>تفاصيل المستحقات</button><button onClick={reminders.toggle}>إعدادات الإشعارات</button><button onClick={() => setSuccess('يمكنك طلب الدعم من الإدارة عبر رسائل الحصة أو حساب المنصة.')}>المساعدة والدعم</button></div></div></section>}
      {view === 'history' && <section className="student-page"><h2>السجل</h2><div className="history-tabs"><button onClick={() => setFilter('all')}>الكل</button><button onClick={() => setFilter('completed')}>الحصص</button><button onClick={() => onView('earnings')}>المستحقات</button></div><div className="history-list">{bookings.filter(b => filter === 'all' || b.status === filter).map(b => <article key={b.id}><HistoryIcon size={20} /><div><strong>{b.student_name}</strong><p>{b.subject} · {date(b.start)}</p></div><span className={`badge ${b.status}`}>{statusNames[b.status]}</span><b>{money(b.price)}</b></article>)}</div></section>}
    </>}
  </div></>;
  return <>{callLayer}<div className="portal-content">
    {portal !== 'admin' && <div className="reminder-settings"><button className="secondary-button" aria-pressed={reminders.enabled} onClick={reminders.toggle} title={reminders.enabled ? 'إيقاف الصوت وإشعارات الجهاز' : 'تفعيل الصوت وإشعارات الجهاز'}>{reminders.enabled ? <Bell size={18} /> : <BellOff size={18} />}{reminders.enabled ? 'التنبيهات مفعّلة' : 'تفعيل تنبيهات الحصص'}</button>{reminders.hint && <small role="status">{reminders.hint}</small>}</div>}
    {reminders.upcoming.map(b => <div className="lesson-reminder lesson-pulse" key={b.id}><Bell size={22} aria-hidden="true" /><div><strong>{b.subject}</strong><p role="status">{b.start > reminders.now ? `تبدأ خلال ${Math.ceil((b.start - reminders.now) / 60000)} دقيقة` : 'حان موعد الحصة'}</p></div><button className="primary-button" disabled={busy} onClick={() => { onView('bookings'); void join(b); }}><Video size={17} />دخول الحصة</button></div>)}
    {error && <p className="notice error" role="alert">{error}</p>}
    {success && <p className="notice success" role="status">{success}</p>}
    {view !== 'profile' && <div className="list-toolbar"><label className="search-field"><Search size={18} /><input aria-label="بحث" placeholder={view === 'slots' ? 'المادة أو اسم الأستاذ' : 'بحث'} value={query} onChange={e => setQuery(e.target.value)} /></label>
      {view === 'bookings' && <select aria-label="حالة الحصة" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">كل الحالات</option>{['confirmed', 'completed', 'cancelled'].map(s => <option value={s} key={s}>{statusNames[s]}</option>)}</select>}
      <button className="icon-button" onClick={refresh} title="تحديث" disabled={loading}><RefreshCw size={18} /></button>
      {view === 'bookings' && <button className="icon-button" onClick={exportBookings} title="تنزيل الحجوزات CSV" disabled={loading || !bookings.length}><Download size={18} /></button>}
    </div>}
    {view === 'users' && <AccountsPanel users={users} query={query} onChanged={refresh} />}
    {view === 'catalog' && !loading && <CatalogPanel categories={catalog} onChanged={setCatalog} />}
    {loading ? <WorkspaceSkeleton /> : <>
      {view === 'bookings' && <>
        <div className="metric-band"><div><span>الحصص المؤكدة</span><strong>{bookings.filter(b => b.status === 'confirmed').length}</strong></div><div><span>الحصص المكتملة</span><strong>{bookings.filter(b => b.status === 'completed').length}</strong></div><div><span>الدفعات المسجلة</span><strong>{money(bookings.filter(b => b.paid).reduce((sum, b) => sum + b.price, 0))}</strong></div></div>
        {!shownBookings.length && <Empty text={query || filter !== 'all' ? 'لا توجد نتائج مطابقة.' : 'لا توجد حجوزات حتى الآن.'} />}
        <div className="booking-list">{shownBookings.map(b => <article className="booking-row" key={b.id}><div><h2>{b.subject}</h2><p>{b.teacher_name} · {b.student_name}</p><time>{date(b.start)} · {b.minutes} دقيقة</time></div><div className="booking-state"><span className={`badge ${b.status}`}>{statusNames[b.status]}</span><strong>{money(b.price)}</strong><small>{b.paid ? 'دفعة مسجلة' : 'غير مدفوع'}</small>{b.status === 'cancelled' && b.paid === 1 && <small className="refund-note">يلزم مراجعة الاسترداد</small>}</div><div className="row-actions"><button className="secondary-button" onClick={() => setSelected(b.id)}>التفاصيل</button></div></article>)}</div>
      </>}
      {view === 'slots' && <>
        {false && <form className="work-form slot-form" onSubmit={async e => {
          e.preventDefault(); const form = e.currentTarget; const data = formData(form);
          if (await act(() => post('slots', { ...data, start: new Date(String(data.start)).getTime(), minutes: Number(data.minutes), price: Math.round(Number(data.price) * 100) }), 'تم نشر الموعد.')) form.reset();
        }}><h2>إضافة موعد</h2><label>المادة<input name="subject" maxLength={100} defaultValue={user.subject} required /></label><label>التاريخ والوقت<input name="start" type="datetime-local" required /></label><label>المدة<select name="minutes" defaultValue="60">{[30, 45, 60, 90, 120].map(n => <option key={n} value={n}>{n} دقيقة</option>)}</select></label><label>السعر بالدينار الأردني<input name="price" type="number" min="0" max="1000" step="0.01" required /></label><button className="primary-button" disabled={busy}><CalendarPlus size={17} />نشر الموعد</button></form>}
        <p className="muted">المواعيد حسب توقيت جهازك: {Intl.DateTimeFormat().resolvedOptions().timeZone}</p>
        {!slots.filter(s => matches(`${s.subject} ${s.teacher_name || ''}`)).length && <Empty text="لا توجد مواعيد متاحة مطابقة." />}
        <div className="slot-grid">{slots.filter(s => matches(`${s.subject} ${s.teacher_name || ''}`)).map(s => <article className="slot-item" key={s.id}><span className={`badge ${s.status}`}>{statusNames[s.status]}</span><h2>{s.subject}</h2>{s.teacher_name && <strong>{s.teacher_name}</strong>}{s.bio && <p>{s.bio}</p>}<p>{date(s.start)}</p><p>{s.minutes} دقيقة · {money(s.price)}</p>{s.status === 'open' && s.start > Date.now() && <button className="secondary-button" disabled={busy} onClick={() => { if (window.confirm('حذف هذا الموعد؟')) void act(() => post(`slots/${s.id}`), 'تم حذف الموعد.'); }}><X size={17} />حذف الموعد</button>}</article>)}</div>
      </>}
      {view === 'audit' && <div>{!events.length && <Empty text="لا توجد عمليات مسجلة بعد." />}{events.filter(e => matches(`${e.name} ${actionNames[e.action] || e.action}`)).map(e => <article className="audit-row" key={e.id}><strong>{actionNames[e.action] || e.action}</strong><span>{e.name}</span><time>{date(e.created)}</time><small dir="ltr">{e.target}</small></article>)}</div>}
      {view === 'profile' && <div className="profile-layout"><form className="work-form" onSubmit={async e => { e.preventDefault(); const data = formData(e.currentTarget); await act(async () => { const result = await request<{ user: User }>(`${portal}/profile`, data); onUser(result.user); }); }}><h2>معلومات الحساب</h2><label>الاسم الكامل<input name="name" defaultValue={user.name} maxLength={100} required /></label><label>البريد الإلكتروني<input value={user.email} readOnly dir="ltr" /></label><><input type="hidden" name="subject" value="" /><input type="hidden" name="bio" value="" /></><button className="primary-button" disabled={busy}><Save size={17} />حفظ</button></form><form className="work-form" onSubmit={async e => { e.preventDefault(); const data = formData(e.currentTarget); await act(async () => { await post('password', data); onUser(null); }); }}><h2>تغيير كلمة المرور</h2><label>كلمة المرور الحالية<input name="current" type="password" minLength={12} maxLength={128} autoComplete="current-password" required /></label><label>كلمة المرور الجديدة<input name="password" type="password" minLength={12} maxLength={128} autoComplete="new-password" required /></label><small>12 حرفًا على الأقل. يلزم الدخول مجددًا بعد التغيير.</small><button className="secondary-button" disabled={busy}><Save size={17} />تغيير كلمة المرور</button></form></div>}
    </>}
    {currentSlot && <dialog ref={node => { if (node && !node.open) node.showModal(); }} onCancel={() => setSelectedSlot(null)} className="detail-dialog"><div className="section-heading"><h2>{currentSlot.subject}</h2><button className="icon-button" title="إغلاق التفاصيل" onClick={() => setSelectedSlot(null)}><X size={20} /></button></div><p>{date(currentSlot.start)}</p><p>{currentSlot.minutes} دقيقة · {money(currentSlot.price)}</p><span className={`badge ${currentSlot.status}`}>{statusNames[currentSlot.status]}</span><div className="row-actions">{currentSlot.status === 'open' && <button className="secondary-button" disabled={busy} onClick={() => { if (window.confirm('حذف هذا الموعد؟')) void act(() => post(`slots/${currentSlot.id}`), 'تم حذف الموعد.'); setSelectedSlot(null); }}><X size={17} />حذف الموعد</button>}</div></dialog>}
    {lessonDetails}
  </div></>;
}
type RoomFilter = 'today' | 'tomorrow' | 'yesterday' | 'upcoming' | 'past' | 'all';
function RoomHub({ portal, bookings, now, filter, onFilter, busy, canJoin, onJoin }: { portal: 'students' | 'teachers'; bookings: Booking[]; now: number; filter: RoomFilter; onFilter: (filter: RoomFilter) => void; busy: boolean; canJoin: (booking: Booking) => boolean; onJoin: (booking: Booking) => Promise<void> }) {
  const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime();
  const day = 86400000;
  const filters: Array<[RoomFilter, string]> = [['today', 'اليوم'], ['tomorrow', 'غداً'], ['yesterday', 'أمس'], ['upcoming', 'القادمة'], ['past', 'السابقة'], ['all', 'الكل']];
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
    <div className="rooms-hero"><div><span className="rooms-kicker"><Video size={17} />مساحتك المنظمة للحصص</span><h2>غرف الحصص</h2><p>كل حصة في مكانها، مع حالة مباشرة وعدّ تنازلي واضح قبل البداية.</p></div><div className="rooms-live-summary"><strong>{bookings.filter(booking => booking.status === 'confirmed' && Number(portal === 'students' ? booking.teacher_present_until : booking.student_present_until) > now).length}</strong><span>{portal === 'students' ? 'أساتذة داخل الغرفة الآن' : 'طلاب بانتظارك الآن'}</span></div></div>
    <div className="room-filters" role="tablist" aria-label="فلترة غرف الحصص">{filters.map(([id, label]) => <button type="button" role="tab" aria-selected={filter === id} className={filter === id ? 'active' : ''} onClick={() => onFilter(id)} key={id}>{label}</button>)}</div>
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
        <div className="room-card-date"><span>{new Date(booking.start).toLocaleDateString('ar-JO', { weekday: 'long' })}</span><strong>{new Date(booking.start).toLocaleDateString('ar-JO', { day: 'numeric', month: 'short' })}</strong></div>
        <div className="room-card-main"><div className="room-card-title"><span className={`room-status ${counterpartLive ? 'live' : booking.status}`}>{counterpartLive ? <><Video size={14} />LIVE الآن</> : statusNames[booking.status]}</span><h3>{booking.subject}</h3></div><p>{person} · {timeOnly(booking.start)} - {timeOnly(end)} · {booking.minutes} دقيقة</p><div className="room-presence"><span className={teacherLive ? 'online' : ''}>الأستاذ {teacherLive ? 'داخل الغرفة' : 'لم يدخل بعد'}</span><span className={studentLive ? 'online' : ''}>الطالب {studentLive ? 'داخل الغرفة' : 'لم يدخل بعد'}</span></div></div>
        <div className="room-card-action">{booking.status === 'confirmed' && upcoming && <div className="room-countdown"><small>تبدأ بعد</small><strong dir="ltr" aria-live="polite">{countdown(booking.start)}</strong></div>}{booking.status === 'confirmed' && !upcoming && !counterpartLive && now <= end && <span className="room-started">بدأ موعد الحصة</span>}{booking.status === 'confirmed' ? <button className={counterpartLive ? 'primary-button live-button' : 'primary-button'} disabled={busy || !joinable} title={joinable ? 'دخول غرفة الحصة' : 'يفتح الدخول قبل الموعد بـ15 دقيقة'} onClick={() => void onJoin(booking)}><Video size={17} />{counterpartLive ? 'انضم الآن' : joinable ? 'دخول الغرفة' : 'تفتح قبل 15 دقيقة'}</button> : <span className="room-closed">{booking.status === 'completed' ? 'تمت الحصة' : 'أُلغيت الحصة'}</span>}</div>
      </article>;
    })}</div>
  </section>;
}
function TutorList({ slots, busy, bookSlot, compact = false }: { slots: Slot[]; busy: boolean; bookSlot: (slot: Slot) => void; compact?: boolean }) {
  if (!slots.length) return <Empty text="لا توجد مواعيد مناسبة حالياً." />;
  return <div className={compact ? 'tutor-strip' : 'tutor-market-list'}>{slots.map(slot => <article className="tutor-card" key={slot.id}>
    <div className="tutor-photo">{slot.teacher_name?.slice(0, 1) || 'أ'}</div>
    <div className="tutor-info"><div><strong>{slot.teacher_name || 'أستاذ منصّة'}</strong><BadgeCheck className="verified-icon" size={17} aria-label="أستاذ منصّة" /></div><p>{slot.subject}</p><small><Clock3 size={14} />{slot.minutes} دقيقة{slot.bio && <span> · {slot.bio}</span>}</small><time><CalendarPlus size={14} />{date(slot.start)}</time></div>
    <div className="tutor-actions"><b>{money(slot.price)}<small>للحصة</small></b><button className="primary-button" disabled={busy} onClick={() => bookSlot(slot)}><CalendarPlus size={16} />احجز الآن</button></div>
  </article>)}</div>;
}

function TransactionList({ bookings }: { bookings: Booking[] }) {
  const rows = bookings.slice(0, 6);
  return <div className="transaction-list"><h3>سجل العمليات</h3>{!rows.length && <Empty text="لا توجد عمليات بعد." />}{rows.map(b => <article key={b.id}><span className={b.paid ? 'positive' : 'negative'}>{b.paid ? 'دفع حصة' : 'حجز غير مدفوع'}</span><div><strong>{b.subject}</strong><small>{date(b.start)}</small></div><b className={b.paid ? 'negative' : ''}>{b.paid ? '-' : ''}{money(b.price)}</b></article>)}</div>;
}

function Empty({ text }: { text: string }) { return <div className="empty-state"><CalendarPlus size={30} /><p>{text}</p></div>; }




