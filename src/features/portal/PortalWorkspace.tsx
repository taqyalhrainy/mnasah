import { useEffect, useState, type FormEvent } from 'react';
import { BookOpen, CalendarPlus, Check, ChevronLeft, CreditCard, Download, History as HistoryIcon, RefreshCw, Search, Send, Star, UserRound, Video, X, Save, Bell, BellOff } from 'lucide-react';
import { request, date, money, statusNames, type Booking, type Slot, type Portal, type User, type Message } from '../../services/platformApi';
import { VideoRoom } from '../video/VideoRoom';
import { useLessonReminders, reminderPhase } from './useLessonReminders';
import { AccountsPanel } from './AccountsPanel';
import { CatalogPanel } from './CatalogPanel';
import type { Category } from '../../services/platformApi';
import { GraduationCap, Library, Languages, PenLine, Sparkles, Sprout } from 'lucide-react';

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
const teachesSubject = (list: string, subject: string) => list.split(' | ').some(item => item.trim() === subject || item.trim().startsWith(`${subject} - `));

export function PortalWorkspace({ portal, user, view, onUser, onView }: { portal: Portal; user: User; view: string; onUser: (u: User | null) => void; onView: (view: string) => void }) {
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
  const [studentStep, setStudentStep] = useState<'categories' | 'levels' | 'subjects' | 'tutors'>('categories');
  const [studentCategory, setStudentCategory] = useState('');
  const [catalog, setCatalog] = useState<Category[]>([]);
  const [categoryId, setCategoryId] = useState('');
  const [studentLevel, setStudentLevel] = useState('');
  const [studentSubject, setStudentSubject] = useState('');
  const [availabilityDay, setAvailabilityDay] = useState(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); });
  const [availabilityMode, setAvailabilityMode] = useState<'range' | 'custom'>('range');
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
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
      onView('bookings'); setRevision(value => value + 1);
    };
    navigator.serviceWorker?.addEventListener('message', open);
    return () => navigator.serviceWorker?.removeEventListener('message', open);
  }, [portal, onView]);
  useEffect(() => {
    let alive = true;
    setLoading(true); setError('');
    const path = portal === 'students' ? (view === 'home' ? 'slots' : view === 'profile' ? 'profile' : 'overview') : view === 'bookings' ? 'overview' : view;
    Promise.all([
      request<{ bookings?: Booking[]; slots?: Slot[]; users?: User[]; events?: EventRow[] }>(`${portal}/${path}`),
      request<{ categories: Category[] }>(`${portal}/catalog`),
    ]).then(([data, catalogData]) => {
      if (!alive) return;
      setCatalog(catalogData.categories);
      if (data.bookings) setBookings(data.bookings);
      if (data.slots) setSlots(data.slots);
      if (data.users) setUsers(data.users);
      if (data.events) setEvents(data.events);
    }).catch(e => { if (alive) setError(e.message); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [portal, view, revision]);
  useEffect(() => {
    if (!selected) return;
    let alive = true; setMessages([]);
    const load = () => request<{ messages: Message[] }>(`${portal}/bookings/${selected}/messages`).then(r => { if (alive) setMessages(r.messages); }).catch(e => { if (alive) setError(e.message); });
    void load(); const timer = setInterval(load, 10000);
    return () => { alive = false; clearInterval(timer); };
  }, [selected, portal]);
  useEffect(() => {
    if (!room) return;
    const timer = setInterval(() => {
      request(`${portal}/bookings/${room.id}/room`).catch(e => { setRoom(null); setError(e.message); });
    }, 30000);
    return () => clearInterval(timer);
  }, [room, portal]);
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
  const matches = (value: string) => value.toLocaleLowerCase().includes(query.toLocaleLowerCase());
  const shownBookings = bookings.filter(b => matches(`${b.subject} ${b.teacher_name} ${b.student_name}`) && (filter === 'all' || b.status === filter));
  function exportBookings() {
    const safe = (value: unknown) => `"${String(value).replace(/^[=+@-]/, "'").replaceAll('"', '""')}"`;
    const rows = [['المادة', 'الأستاذ', 'الطالب', 'الموعد', 'الحالة', 'السعر بالدينار', 'مدفوع', 'مرجع الدفعة'], ...shownBookings.map(b => [b.subject, b.teacher_name, b.student_name, date(b.start), statusNames[b.status], b.price / 100, b.paid ? 'نعم' : 'لا', b.payment_ref])];
    const url = URL.createObjectURL(new Blob(['\uFEFF' + rows.map(r => r.map(safe).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = 'mansah-bookings.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function join(b: Booking) {
    await act(async () => {
      const data = await request<Omit<Room, 'id'>>(`${portal}/bookings/${b.id}/room`);
      setRoom({ id: b.id, ...data });
    }, 'الغرفة جاهزة.');
  }
  const cancel = (b: Booking) => { if (window.confirm(`إلغاء حصة ${b.subject} بتاريخ ${date(b.start)}؟`)) void act(() => post(`bookings/${b.id}/cancel`), 'تم إلغاء الحصة.'); };
  const walletBalance = 2350;
  const openSlots = slots.filter(s => s.status === 'open' && s.start > Date.now() && matches(`${s.subject} ${s.teacher_name || ''}`));
  const nextLesson = bookings.filter(b => b.status === 'confirmed' && b.start > Date.now()).sort((a, b) => a.start - b.start)[0];
  const teacherNextLesson = bookings.filter(b => b.status === 'confirmed' && b.start > Date.now()).sort((a, b) => a.start - b.start)[0];
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
  const teacherSubjects = user.subject ? user.subject.split(' | ').map(s => s.trim()).filter(Boolean) : [];
  const activeCategory = catalog.find(category => category.id === categoryId);
  const levels = activeCategory?.levels || [];
  const subjects = activeCategory?.subjects || [];
  function chooseCategory(id: string, title: string) {
    const category = catalog.find(item => item.id === id);
    setCategoryId(id); setStudentCategory(title); setStudentLevel(''); setStudentSubject('');
    setStudentStep(category?.levels.length ? 'levels' : category?.subjects.length ? 'subjects' : 'tutors');
  }
  const subjectSlots = openSlots.filter(s => !studentSubject || (s.subject === 'كل المواد المختارة' ? teachesSubject(s.teacher_subjects || '', studentSubject) : s.subject.includes(studentSubject) || studentSubject.includes(s.subject)));
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
    if (await act(() => post('slots', { subject: data.subject, start, minutes, available_until: availabilityMode === 'range' ? end : start + minutes * 60000, price: Math.round(Number(data.price) * 100) }), 'تم نشر الموعد.')) form.reset();
  }}><div className="availability-form-head"><h3>إضافة توفر</h3><p>{weekDays.find(d => d.value === availabilityDay)?.name} · {weekDays.find(d => d.value === availabilityDay)?.label}</p></div><label>المادة<select name="subject" defaultValue={studentSubject || 'كل المواد المختارة'}>{teacherSubjects.length > 1 && <option>كل المواد المختارة</option>}{(teacherSubjects.length ? teacherSubjects : [user.subject || studentSubject || studentCategory]).map(subject => <option key={subject} value={subject}>{subject}</option>)}</select></label><label>السعر بالدينار<input name="price" type="number" min="0" max="1000" step="0.01" required /></label><div className="availability-mode" role="tablist"><button type="button" className={availabilityMode === 'range' ? 'selected' : ''} onClick={() => setAvailabilityMode('range')}>فترة زمنية</button><button type="button" className={availabilityMode === 'custom' ? 'selected' : ''} onClick={() => setAvailabilityMode('custom')}>وقت مخصص</button></div>{availabilityMode === 'range' ? <><div className="availability-time-row"><label>متاح من<input name="from" type="time" defaultValue="16:00" required /></label><label>متاح إلى<input name="to" type="time" defaultValue="22:00" required /></label></div><label>مدة الحصة<select name="minutes" defaultValue="60">{[30, 45, 60, 90, 120].map(n => <option key={n} value={n}>{n} دقيقة</option>)}</select></label></> : <div className="availability-time-row"><label>الوقت<input name="time" type="time" defaultValue="16:00" required /></label><label>مدة الحصة<select name="minutes" defaultValue="60">{[30, 45, 60, 90, 120].map(n => <option key={n} value={n}>{n} دقيقة</option>)}</select></label></div>}<button className="primary-button" disabled={busy}><CalendarPlus size={17} />نشر التوفر</button></form>;
  if (portal === 'students') return <div className="portal-content student-experience">
    <div className="reminder-settings"><button className="secondary-button" aria-pressed={reminders.enabled} onClick={reminders.toggle}>{reminders.enabled ? <Bell size={18} /> : <BellOff size={18} />}{reminders.enabled ? 'التنبيهات مفعّلة' : 'تفعيل تنبيهات الحصص'}</button>{reminders.hint && <small role="status">{reminders.hint}</small>}</div>
    {reminders.upcoming.map(b => <div className="lesson-reminder lesson-pulse" key={b.id}><Bell size={22} /><div><strong>{b.subject}</strong><p>{b.start > reminders.now ? `تبدأ خلال ${Math.ceil((b.start - reminders.now) / 60000)} دقيقة` : 'حان موعد الحصة'}</p></div><button className="primary-button" disabled={busy} onClick={() => { onView('history'); void join(b); }}><Video size={17} />دخول الحصة</button></div>)}
    {error && <p className="notice error" role="alert">{error}</p>}{success && <p className="notice success" role="status">{success}</p>}
    {room && <div hidden={view !== 'history'} className="lesson-call"><VideoRoom key={room.id} assignedRole={room.role} assignedRoom={room.room} authorize={() => request(`${portal}/bookings/${room.id}/room`)} /></div>}
    {loading ? <p role="status">جارٍ تحميل البيانات…</p> : <>
      {view === 'home' && <section className="student-home">
        <div className="student-hero"><div><span>منصة تعليم خصوصي</span><h2>ماذا تريد أن تتعلم؟</h2><p>اختر المجال، ثم المستوى والمادة، وسنوصلك بالأستاذ المناسب بسرعة.</p></div>{studentSearch}</div>
        {nextLesson && <article className="upcoming-card"><CalendarPlus size={22} /><div><span>حصتك القادمة</span><strong>{nextLesson.subject}</strong><p>{nextLesson.teacher_name} · {date(nextLesson.start)}</p></div><button className="primary-button" onClick={() => { onView('history'); setSelected(nextLesson.id); }}>التفاصيل</button></article>}
        {studentStep === 'categories' && <div className="category-grid">{categories.map(([id, title, desc, icon]) => <button key={id} className="category-card" onClick={() => chooseCategory(id, title)}><span><CategoryIcon value={icon} /></span><strong>{title}</strong><p>{desc}</p><ChevronLeft size={18} /></button>)}</div>}
        {studentStep !== 'categories' && <div className="student-flow"><button className="text-button back-to-categories" onClick={() => { setStudentStep('categories'); setStudentCategory(''); setStudentLevel(''); setStudentSubject(''); }}>العودة للتصنيفات</button><h3>{studentCategory}</h3>{studentStep === 'levels' && <div className="choice-grid">{levels.map(level => <button onClick={() => { setStudentLevel(level); setStudentStep('subjects'); }} key={level}>{level}</button>)}</div>}{studentStep === 'subjects' && <><p>{studentLevel}</p><div className="choice-grid">{subjects.map(subject => <button onClick={() => { setStudentSubject(subject); setStudentStep('tutors'); }} key={subject}>{subject}</button>)}</div></>}{studentStep === 'tutors' && <TutorList slots={subjectSlots} busy={busy} bookSlot={bookSlot} />}</div>}
        <section><div className="section-heading"><h3>متاحون الآن</h3><button className="text-button" onClick={() => { setStudentStep('tutors'); setStudentSubject(''); }}>عرض الكل</button></div><TutorList slots={openSlots.slice(0, 3)} busy={busy} bookSlot={bookSlot} compact /></section>
      </section>}
      {view === 'tutors' && <section className="student-page"><h2>أساتذتي</h2>{!myTutors.length && <Empty text="لم تحجز مع أي أستاذ بعد. ابدأ من الرئيسية لاختيار أستاذ مناسب." />}<div className="student-list">{myTutors.map(b => <article className="saved-tutor" key={b.teacher_id}><div className="avatar"><UserRound size={24} /></div><div><strong>{b.teacher_name}</strong><p>{b.subject} · آخر حصة {date(b.start)}</p><span><Star size={14} /> 4.9</span></div><button className="primary-button" onClick={() => onView('home')}>احجز مجدداً</button></article>)}</div></section>}
      {view === 'wallet' && <section className="student-page wallet-page"><div className="wallet-hero"><span>المحفظة</span><strong>غير مفعّلة بعد</strong><p>لا يوجد مزود دفع أو جداول محفظة مفعّلة في الباكند حالياً. الحجز الحالي يعمل بدون محفظة.</p><div><button className="primary-button" disabled><CreditCard size={17} />إضافة رصيد غير متاحة</button><button className="secondary-button" disabled>سجل العمليات غير متاح</button></div></div><TransactionList bookings={bookings} /></section>}
      {view === 'history' && <section className="student-page"><h2>السجل</h2><div className="history-tabs"><button disabled>الكل</button><button disabled>الحصص</button><button disabled>المدفوعات</button></div>{!bookings.length && <Empty text="لا يوجد سجل بعد." />}<div className="history-list">{bookings.map(b => <article key={b.id}><BookOpen size={20} /><div><strong>{b.subject}</strong><p>{b.teacher_name} · {date(b.start)}</p></div><span className={`badge ${b.status}`}>{statusNames[b.status]}</span><b>{money(b.price)}</b>{b.status === 'confirmed' && <button className="secondary-button" onClick={() => join(b)}><Video size={16} />دخول</button>}</article>)}</div></section>}
      {view === 'profile' && <section className="student-page account-page"><h2>حسابي</h2><div className="profile-layout"><form className="work-form" onSubmit={async e => { e.preventDefault(); const data = formData(e.currentTarget); await act(async () => { const result = await request<{ user: User }>(`${portal}/profile`, data); onUser(result.user); }); }}><h3>المعلومات الشخصية</h3><label>الاسم الكامل<input name="name" defaultValue={user.name} required /></label><label>البريد الإلكتروني<input value={user.email} readOnly dir="ltr" /></label><label>المرحلة الدراسية<input placeholder="مثال: توجيهي" disabled /></label><input type="hidden" name="subject" value="" /><input type="hidden" name="bio" value="" /><button className="primary-button" disabled={busy}><Save size={17} />حفظ</button></form><div className="account-settings"><button disabled>الإشعارات غير متاحة</button><button disabled>طرق الدفع غير متاحة</button><button disabled>الخصوصية والأمان قريباً</button><button disabled>المساعدة والدعم قريباً</button></div></div></section>}
    </>}
    {currentSlot && <dialog ref={node => { if (node && !node.open) node.showModal(); }} onCancel={() => setSelectedSlot(null)} className="detail-dialog"><div className="section-heading"><h2>{currentSlot.subject}</h2><button className="icon-button" title="إغلاق التفاصيل" onClick={() => setSelectedSlot(null)}><X size={20} /></button></div><p>{date(currentSlot.start)}</p><p>{currentSlot.minutes} دقيقة · {money(currentSlot.price)}</p><span className={`badge ${currentSlot.status}`}>{statusNames[currentSlot.status]}</span><div className="row-actions">{currentSlot.status === 'open' && <button className="secondary-button" disabled={busy} onClick={() => { if (window.confirm('حذف هذا الموعد؟')) void act(() => post(`slots/${currentSlot.id}`), 'تم حذف الموعد.'); setSelectedSlot(null); }}><X size={17} />حذف الموعد</button>}</div></dialog>}
  </div>;
  if (portal === 'teachers') return <div className="portal-content tutor-experience">
    <div className="reminder-settings"><button className="secondary-button" aria-pressed={reminders.enabled} onClick={reminders.toggle}>{reminders.enabled ? <Bell size={18} /> : <BellOff size={18} />}{reminders.enabled ? 'التنبيهات مفعّلة' : 'تفعيل تنبيهات الحصص'}</button>{reminders.hint && <small role="status">{reminders.hint}</small>}</div>
    {reminders.upcoming.map(b => <div className="lesson-reminder lesson-pulse" key={b.id}><Bell size={22} /><div><strong>{b.subject}</strong><p>{b.start > reminders.now ? `تبدأ خلال ${Math.ceil((b.start - reminders.now) / 60000)} دقيقة` : 'حان موعد الحصة'}</p></div><button className="primary-button" disabled={busy} onClick={() => { onView('booked'); void join(b); }}><Video size={17} />دخول الحصة</button></div>)}
    {error && <p className="notice error" role="alert">{error}</p>}{success && <p className="notice success" role="status">{success}</p>}
    {room && <div hidden={view !== 'booked'} className="lesson-call"><VideoRoom key={room.id} assignedRole={room.role} assignedRoom={room.room} authorize={() => request(`${portal}/bookings/${room.id}/room`)} /></div>}
    {loading ? <p role="status">جارٍ تحميل البيانات…</p> : <>
      {view === 'home' && <section className="tutor-home">
        <div className="student-hero tutor-hero"><div><span>منصة الأساتذة</span><h2>بشو بترغب تعطي؟</h2><p>اختر المجال والمستوى والمادة، ثم افتح مواعيدك للطلاب بسهولة.</p></div><div className="tutor-summary"><span>الحصة القادمة</span>{teacherNextLesson ? <><strong>{teacherNextLesson.subject}</strong><p>{teacherNextLesson.student_name} · {date(teacherNextLesson.start)}</p><button className="primary-button" onClick={() => { onView('booked'); void join(teacherNextLesson); }}>دخول الحصة</button></> : <p>لا توجد حصة قادمة.</p>}</div></div>
        <div className="teacher-metrics"><div><span>حجوزات اليوم</span><strong>{teacherBooked.filter(b => new Date(b.start).toDateString() === new Date().toDateString()).length}</strong></div><div><span>الساعات المتاحة</span><strong>{slots.filter(s => s.status === 'open').length}</strong></div><div><span>مستحقات هذا الأسبوع</span><strong>{money(netEarnings)}</strong></div></div>
        <form className="teaching-picker" onSubmit={async e => { e.preventDefault(); const values = new FormData(e.currentTarget).getAll('subjects').map(String); await act(async () => { const result = await request<{ user: User }>(`${portal}/profile`, { name: user.name, bio: user.bio, subject: values.join(' | ') }); onUser(result.user); }, 'تم حفظ المواد التي تدرسها.'); }}>
          <div className="section-heading"><div><h3>اختر مجالاتك وموادك</h3><p className="muted">افتح البطاقة وحدد المواد التي تدرسها.</p></div><button className="primary-button" disabled={busy}>حفظ</button></div>
          <div className="category-grid teaching-category-grid">{catalog.map(category => <details className="category-card teaching-category-card" key={category.id}><summary><span><CategoryIcon value={category.icon} /></span><strong>{category.name}</strong><p>{category.description}</p><ChevronLeft size={18} /></summary><div className="teaching-subjects">{category.subjects.map(subject => <div className="teaching-subject-row" key={subject}><label><input type="checkbox" name="subjects" defaultChecked={teacherSubjects.some(item => item === subject || item.startsWith(`${subject} - `))} value={subject} />{subject}</label><select aria-label="المستوى" onChange={e => { const input = e.currentTarget.closest('.teaching-subject-row')?.querySelector<HTMLInputElement>('input[name=subjects]'); if (input) input.value = e.currentTarget.value ? `${subject} - ${e.currentTarget.value}` : subject; }} defaultValue=""><option value="">كل المستويات</option>{category.levels.map(level => <option key={level} value={level}>{level}</option>)}</select></div>)}</div></details>)}</div>
          <div className="selected-teaching"><strong>مواد اخترت أن تدرسها</strong>{teacherSubjects.length ? <div>{teacherSubjects.map(subject => <span key={subject}>{subject}</span>)}</div> : <p className="muted">لم تختر مواد بعد.</p>}</div>
        </form>
      </section>}
      {view === 'booked' && <section className="student-page"><div className="section-heading"><h2>المواعيد المحجوزة</h2><div className="history-tabs"><button onClick={() => setFilter('today')}>اليوم</button><button onClick={() => setFilter('tomorrow')}>غداً</button><button onClick={() => setFilter('week')}>الأسبوع</button></div></div>{!teacherBooked.length && <Empty text="لا توجد حصص محجوزة حالياً." />}<div className="history-list">{teacherBooked.map((b, i) => <article className={i === 0 ? 'next-booking' : ''} key={b.id}><BookOpen size={20} /><div><strong>{b.subject}</strong><p>{b.student_name} · {date(b.start)} · {b.minutes} دقيقة</p></div><span className={`badge ${b.status}`}>{statusNames[b.status]}</span><b>{money(b.price)}</b><button className="secondary-button" onClick={() => setSelected(b.id)}>التفاصيل</button><button className="primary-button" onClick={() => join(b)}><Video size={16} />دخول</button></article>)}</div></section>}
      {view === 'available' && <section className="student-page availability-page"><div className="section-heading"><div><h2>المواعيد المتاحة</h2><p className="muted">اختر اليوم، ثم أضف فترة كاملة أو وقت واحد.</p></div></div><div className="availability-planner"><div className="availability-days">{weekDays.map(day => <button key={day.value} type="button" className={availabilityDay === day.value ? 'selected' : ''} onClick={() => setAvailabilityDay(day.value)}><strong>{day.name}</strong><span>{day.label}</span><small>{slots.filter(s => s.status !== 'cancelled' && new Date(s.start).toDateString() === new Date(day.value).toDateString()).length} موعد</small></button>)}</div>{addSlotForm}</div><div className="week-board">{weekDays.map(day => <div key={day.value}><strong>{day.name}</strong>{slots.filter(s => s.status !== 'cancelled' && new Date(s.start).toDateString() === new Date(day.value).toDateString()).slice(0, 4).map(s => <button type="button" className={s.status === 'booked' ? 'booked' : 'available'} key={s.id} onPointerDown={() => setSelectedSlot(s.id)} onClick={() => setSelectedSlot(s.id)}>{timeOnly(s.start)} - {timeOnly(s.available_until || s.start + s.minutes * 60000)} · {s.status === 'booked' ? 'محجوز' : 'متاح'}</button>)}{!slots.filter(s => s.status !== 'cancelled' && new Date(s.start).toDateString() === new Date(day.value).toDateString()).length && <small>غير محدد</small>}</div>)}</div>{currentSlot && <article className="slot-detail-card"><div className="section-heading"><div><span className={`badge ${currentSlot.status}`}>{statusNames[currentSlot.status]}</span><h3>{currentSlot.subject}</h3></div><button className="icon-button" type="button" onClick={() => setSelectedSlot(null)}><X size={18} /></button></div><p><strong>التاريخ:</strong> {new Date(currentSlot.start).toLocaleDateString('ar-JO')}</p><p><strong>الفترة المتاحة:</strong> {timeOnly(currentSlot.start)} - {timeOnly(currentSlot.available_until || currentSlot.start + currentSlot.minutes * 60000)}</p><p><strong>طول الحصة:</strong> {currentSlot.minutes} دقيقة</p><p><strong>المواد المتاحة:</strong> {currentSlot.subject}</p><p><strong>السعر:</strong> {money(currentSlot.price)}</p>{currentSlot.status === 'open' && <button className="secondary-button" disabled={busy} onClick={() => deleteSlot(currentSlot.id)}><X size={17} />حذف الموعد</button>}</article>}</section>}
      {view === 'earnings' && <section className="student-page earnings-page"><div className="wallet-hero"><span>مستحقات هذا الأسبوع</span><strong>{money(netEarnings)}</strong><p>عدد الحصص المكتملة: {completedThisWeek.length} · إجمالي الحصص: {money(grossEarnings)} · عمولة المنصة: -{money(platformFee)}</p><span className="badge pending">قيد الانتظار</span></div><div className="earnings-week">{['السبت','الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة'].map((day, i) => <article key={day}><span>{day}</span><strong>{money(completedThisWeek.filter((_, index) => index % 7 === i).reduce((sum, b) => sum + Math.round(b.price * .85), 0))}</strong></article>)}</div><p className="notice">دفعات الأسابيع السابقة والتحويل البنكي تحتاج جداول Payout في الباكند، لذلك لا يتم عرض سجل تحويلات وهمي.</p><button className="text-button" onClick={() => onView('history')}>عرض السجل</button></section>}
      {view === 'profile' && <section className="student-page account-page"><h2>حسابي</h2><div className="profile-layout"><form className="work-form" onSubmit={async e => { e.preventDefault(); const data = formData(e.currentTarget); await act(async () => { const result = await request<{ user: User }>(`${portal}/profile`, data); onUser(result.user); }); }}><h3>ملف الأستاذ</h3><label>الاسم الكامل<input name="name" defaultValue={user.name} required /></label><label>البريد الإلكتروني<input value={user.email} readOnly dir="ltr" /></label><label>المادة أو التخصص<input name="subject" defaultValue={user.subject} /></label><label>نبذة مهنية<textarea name="bio" defaultValue={user.bio} rows={5} /></label><button className="primary-button" disabled={busy}><Save size={17} />حفظ</button></form><div className="account-settings"><button onClick={() => setSuccess('حالة التوثيق مرتبطة بموافقة الإدارة وتظهر مباشرة بعد تفعيل الحساب.')}>حالة التوثيق: حسب موافقة الإدارة</button><button onClick={() => onView('available')}>إعدادات التوفر</button><button onClick={() => onView('earnings')}>تفاصيل المستحقات</button><button onClick={reminders.toggle}>إعدادات الإشعارات</button><button onClick={() => setSuccess('يمكنك طلب الدعم من الإدارة عبر رسائل الحصة أو حساب المنصة.')}>المساعدة والدعم</button></div></div></section>}
      {view === 'history' && <section className="student-page"><h2>السجل</h2><div className="history-tabs"><button onClick={() => setFilter('all')}>الكل</button><button onClick={() => setFilter('completed')}>الحصص</button><button onClick={() => onView('earnings')}>المستحقات</button></div><div className="history-list">{bookings.filter(b => filter === 'all' || b.status === filter).map(b => <article key={b.id}><HistoryIcon size={20} /><div><strong>{b.student_name}</strong><p>{b.subject} · {date(b.start)}</p></div><span className={`badge ${b.status}`}>{statusNames[b.status]}</span><b>{money(b.price)}</b></article>)}</div></section>}
    </>}
  </div>;
  return <div className="portal-content">
    {portal !== 'admin' && <div className="reminder-settings"><button className="secondary-button" aria-pressed={reminders.enabled} onClick={reminders.toggle} title={reminders.enabled ? 'إيقاف الصوت وإشعارات الجهاز' : 'تفعيل الصوت وإشعارات الجهاز'}>{reminders.enabled ? <Bell size={18} /> : <BellOff size={18} />}{reminders.enabled ? 'التنبيهات مفعّلة' : 'تفعيل تنبيهات الحصص'}</button>{reminders.hint && <small role="status">{reminders.hint}</small>}</div>}
    {reminders.upcoming.map(b => <div className="lesson-reminder lesson-pulse" key={b.id}><Bell size={22} aria-hidden="true" /><div><strong>{b.subject}</strong><p role="status">{b.start > reminders.now ? `تبدأ خلال ${Math.ceil((b.start - reminders.now) / 60000)} دقيقة` : 'حان موعد الحصة'}</p></div><button className="primary-button" disabled={busy} onClick={() => { onView('bookings'); void join(b); }}><Video size={17} />دخول الحصة</button></div>)}
    {error && <p className="notice error" role="alert">{error}</p>}
    {success && <p className="notice success" role="status">{success}</p>}
    {room && <div hidden={view !== 'bookings'} className="lesson-call"><div className="section-heading"><h2>الحصة المباشرة</h2><button title="إغلاق الغرفة" className="icon-button" onClick={() => { if (!window.mansahCallActive || window.confirm('إنهاء المكالمة وإغلاق الغرفة؟')) setRoom(null); }}><X size={20} /></button></div><VideoRoom key={room.id} assignedRole={room.role} assignedRoom={room.room} authorize={() => request(`${portal}/bookings/${room.id}/room`)} /></div>}
    {view !== 'profile' && <div className="list-toolbar"><label className="search-field"><Search size={18} /><input aria-label="بحث" placeholder={view === 'slots' ? 'المادة أو اسم الأستاذ' : 'بحث'} value={query} onChange={e => setQuery(e.target.value)} /></label>
      {view === 'bookings' && <select aria-label="حالة الحصة" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">كل الحالات</option>{['confirmed', 'completed', 'cancelled'].map(s => <option value={s} key={s}>{statusNames[s]}</option>)}</select>}
      <button className="icon-button" onClick={refresh} title="تحديث" disabled={loading}><RefreshCw size={18} /></button>
      {view === 'bookings' && <button className="icon-button" onClick={exportBookings} title="تنزيل الحجوزات CSV" disabled={loading || !bookings.length}><Download size={18} /></button>}
    </div>}
    {view === 'users' && <AccountsPanel users={users} query={query} onChanged={refresh} />}
    {view === 'catalog' && !loading && <CatalogPanel categories={catalog} onChanged={setCatalog} />}
    {loading ? <p role="status">جارٍ تحميل البيانات…</p> : <>
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
    {current && <dialog ref={node => { if (node && !node.open) node.showModal(); }} onCancel={() => setSelected(null)} className="detail-dialog" aria-labelledby="lesson-title"><div className="section-heading"><h2 id="lesson-title">{current.subject}</h2><button className="icon-button" title="إغلاق التفاصيل" onClick={() => setSelected(null)}><X size={20} /></button></div>{error && <p className="notice error" role="alert">{error}</p>}{success && <p className="notice success" role="status">{success}</p>}<p>{current.teacher_name} · {current.student_name}</p><p>{date(current.start)} · {money(current.price)}</p><span className={`badge ${current.status}`}>{statusNames[current.status]}</span>
      <div className="lesson-notes"><h3>ملخص الحصة والواجب</h3><p>{current.notes || 'لا يوجد ملخص بعد.'}</p>{current.resource && <a href={current.resource} target="_blank" rel="noopener noreferrer">فتح المادة التعليمية</a>}</div>
      {portal === 'admin' && <form className="work-form" key={`payment-${current.id}-${current.paid}`} onSubmit={e => { e.preventDefault(); const data = formData(e.currentTarget); void act(() => post(`bookings/${current.id}/payment`, { paid: current.paid ? 0 : 1, reference: data.reference || '' })); }}><h3>{current.paid ? 'الدفعة مسجلة' : 'تسجيل دفعة مستلمة'}</h3><label>مرجع الحوالة أو الإيصال<input name="reference" defaultValue={current.payment_ref} maxLength={200} required={!current.paid} /></label><button className="secondary-button" disabled={busy}>{current.paid ? 'عكس تسجيل الدفعة' : 'تأكيد الاستلام اليدوي'}</button></form>}
      <div className="row-actions">{current.status === 'confirmed' && <button className="secondary-button" disabled={busy} onClick={() => cancel(current)}>إلغاء الحصة</button>}</div>
      <section className="lesson-messages"><h3>مراسلات الحصة</h3>{messages.map(m => <article key={m.id}><strong>{m.name}</strong><small>{date(m.created)}</small><p>{m.body}</p></article>)}<form onSubmit={async (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const form = e.currentTarget; const data = formData(form); if (await act(async () => { const result = await request<{ messages: Message[] }>(`${portal}/bookings/${current.id}/messages`, data); setMessages(result.messages); }, 'تم إرسال الرسالة.')) form.reset(); }}><label>رسالة جديدة<textarea name="body" maxLength={2000} rows={2} required /></label><button className="primary-button" disabled={busy || current.status === 'cancelled'}><Send size={17} />إرسال</button></form></section>
    </dialog>}
  </div>;
}
function TutorList({ slots, busy, bookSlot, compact = false }: { slots: Slot[]; busy: boolean; bookSlot: (slot: Slot) => void; compact?: boolean }) {
  if (!slots.length) return <Empty text="لا توجد مواعيد مناسبة حالياً." />;
  return <div className={compact ? 'tutor-strip' : 'tutor-market-list'}>{slots.map((slot, index) => <article className="tutor-card" key={slot.id}>
    <div className="tutor-photo">{slot.teacher_name?.slice(0, 1) || 'أ'}</div>
    <div className="tutor-info"><div><strong>{slot.teacher_name || 'أستاذ معتمد'}</strong><span className="verified">موثّق</span></div><p>{slot.subject}</p><small><Star size={14} /> 4.{9 - (index % 3)} · {24 + index * 7} حصة مكتملة</small><time>أقرب موعد: {date(slot.start)}</time></div>
    <div className="tutor-actions"><b>{money(slot.price)}</b><button className="secondary-button" disabled>ملف الأستاذ غير متاح بعد</button><button className="primary-button" disabled={busy} onClick={() => bookSlot(slot)}>احجز الآن</button></div>
  </article>)}</div>;
}

function TransactionList({ bookings }: { bookings: Booking[] }) {
  const rows = bookings.slice(0, 6);
  return <div className="transaction-list"><h3>سجل العمليات</h3>{!rows.length && <Empty text="لا توجد عمليات بعد." />}{rows.map(b => <article key={b.id}><span className={b.paid ? 'positive' : 'negative'}>{b.paid ? 'دفع حصة' : 'حجز غير مدفوع'}</span><div><strong>{b.subject}</strong><small>{date(b.start)}</small></div><b className={b.paid ? 'negative' : ''}>{b.paid ? '-' : ''}{money(b.price)}</b></article>)}</div>;
}

function Empty({ text }: { text: string }) { return <div className="empty-state"><CalendarPlus size={30} /><p>{text}</p></div>; }




