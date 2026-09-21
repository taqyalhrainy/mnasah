import { useEffect, useState, type FormEvent } from 'react';
import { BookOpen, CalendarPlus, Check, ChevronLeft, CreditCard, Download, RefreshCw, Search, Send, Star, UserRound, Video, X, Save, Bell, BellOff } from 'lucide-react';
import { request, date, money, statusNames, type Booking, type Slot, type Portal, type User, type Message } from '../../services/platformApi';
import { VideoRoom } from '../video/VideoRoom';
import { useLessonReminders, reminderPhase } from './useLessonReminders';
import { AccountsPanel } from './AccountsPanel';

type EventRow = { id: string; name: string; action: string; target: string; created: number };
type Room = { id: string; room: string; role: 'teacher' | 'student' };
const actionNames: Record<string, string> = { 'user:password-reset': 'إصدار كلمة مرور مؤقتة', 'user:active': 'تفعيل حساب', 'user:suspended': 'إيقاف حساب', 'booking:cancel': 'إلغاء حصة', 'payment:received': 'تسجيل دفعة', 'payment:reversed': 'عكس دفعة' };
const formData = (form: HTMLFormElement) => Object.fromEntries(new FormData(form));

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
  const [studentLevel, setStudentLevel] = useState('');
  const [studentSubject, setStudentSubject] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
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
    request<{ bookings?: Booking[]; slots?: Slot[]; users?: User[]; events?: EventRow[] }>(`${portal}/${path}`).then(data => {
      if (!alive) return;
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
  const teacherMap = new Map<string, Booking>();
  bookings.forEach(b => { if (!teacherMap.has(b.teacher_id)) teacherMap.set(b.teacher_id, b); });
  const myTutors = [...teacherMap.values()];
  const categories = [
    ['jordan', 'المنهاج الأردني', 'توجيهي وجميع الصفوف المدرسية', '📚'],
    ['quran', 'تحفيظ القرآن الكريم', 'تلاوة، حفظ، وتجويد', '☘'],
    ['reading', 'تعليم القراءة والكتابة', 'تأسيس عربي للأطفال والكبار', '✍'],
    ['english', 'اللغة الإنجليزية', 'محادثة، مدرسة، واختبارات', 'EN'],
    ['university', 'المواد الجامعية', 'مساندة جامعية متخصصة', '🎓'],
    ['skills', 'مهارات ودورات أخرى', 'مهارات عملية ودورات قصيرة', '✨'],
  ] as const;
  const levels = ['توجيهي', 'الصف العاشر', 'الصف التاسع', 'الصف الثامن', 'الصف السابع', 'المرحلة الأساسية'];
  const subjects = ['رياضيات', 'فيزياء', 'كيمياء', 'عربي', 'إنجليزي', 'أحياء'];
  const subjectSlots = openSlots.filter(s => !studentSubject || s.subject.includes(studentSubject) || studentSubject.includes(s.subject));
  const studentSearch = <label className="student-search"><Search size={19} /><input aria-label="بحث" placeholder="ابحث عن مادة أو أستاذ" value={query} onChange={e => setQuery(e.target.value)} /></label>;
  const bookSlot = (s: Slot) => { if (window.confirm(`تأكيد حجز الحصة بقيمة ${money(s.price)}؟`)) void act(() => post(`slots/${s.id}`), 'تم تأكيد الحجز. ستجده في السجل.'); };
  if (portal === 'students') return <div className="portal-content student-experience">
    <div className="reminder-settings"><button className="secondary-button" aria-pressed={reminders.enabled} onClick={reminders.toggle}>{reminders.enabled ? <Bell size={18} /> : <BellOff size={18} />}{reminders.enabled ? 'التنبيهات مفعّلة' : 'تفعيل تنبيهات الحصص'}</button>{reminders.hint && <small role="status">{reminders.hint}</small>}</div>
    {reminders.upcoming.map(b => <div className="lesson-reminder lesson-pulse" key={b.id}><Bell size={22} /><div><strong>{b.subject}</strong><p>{b.start > reminders.now ? `تبدأ خلال ${Math.ceil((b.start - reminders.now) / 60000)} دقيقة` : 'حان موعد الحصة'}</p></div><button className="primary-button" disabled={busy} onClick={() => { onView('history'); void join(b); }}><Video size={17} />دخول الحصة</button></div>)}
    {error && <p className="notice error" role="alert">{error}</p>}{success && <p className="notice success" role="status">{success}</p>}
    {room && <div hidden={view !== 'history'} className="lesson-call"><VideoRoom key={room.id} assignedRole={room.role} assignedRoom={room.room} authorize={() => request(`${portal}/bookings/${room.id}/room`)} /></div>}
    {loading ? <p role="status">جارٍ تحميل البيانات…</p> : <>
      {view === 'home' && <section className="student-home">
        <div className="student-hero"><div><span>منصة تعليم خصوصي</span><h2>ماذا تريد أن تتعلم؟</h2><p>اختر المجال، ثم المستوى والمادة، وسنوصلك بالأستاذ المناسب بسرعة.</p></div>{studentSearch}</div>
        {nextLesson && <article className="upcoming-card"><CalendarPlus size={22} /><div><span>حصتك القادمة</span><strong>{nextLesson.subject}</strong><p>{nextLesson.teacher_name} · {date(nextLesson.start)}</p></div><button className="primary-button" onClick={() => { onView('history'); setSelected(nextLesson.id); }}>التفاصيل</button></article>}
        {studentStep === 'categories' && <div className="category-grid">{categories.map(([id, title, desc, icon]) => <button key={id} className="category-card" onClick={() => { setStudentCategory(title); setStudentStep(id === 'jordan' ? 'levels' : 'tutors'); }}><span>{icon}</span><strong>{title}</strong><p>{desc}</p><ChevronLeft size={18} /></button>)}</div>}
        {studentStep !== 'categories' && <div className="student-flow"><button className="text-button" onClick={() => { setStudentStep('categories'); setStudentCategory(''); setStudentLevel(''); setStudentSubject(''); }}>العودة للتصنيفات</button><h3>{studentCategory}</h3>{studentStep === 'levels' && <div className="choice-grid">{levels.map(level => <button onClick={() => { setStudentLevel(level); setStudentStep('subjects'); }} key={level}>{level}</button>)}</div>}{studentStep === 'subjects' && <><p>{studentLevel}</p><div className="choice-grid">{subjects.map(subject => <button onClick={() => { setStudentSubject(subject); setStudentStep('tutors'); }} key={subject}>{subject}</button>)}</div></>}{studentStep === 'tutors' && <TutorList slots={subjectSlots} busy={busy} bookSlot={bookSlot} />}</div>}
        <section><div className="section-heading"><h3>متاحون الآن</h3><button className="text-button" onClick={() => { setStudentStep('tutors'); setStudentSubject(''); }}>عرض الكل</button></div><TutorList slots={openSlots.slice(0, 3)} busy={busy} bookSlot={bookSlot} compact /></section>
      </section>}
      {view === 'tutors' && <section className="student-page"><h2>أساتذتي</h2>{!myTutors.length && <Empty text="لم تحجز مع أي أستاذ بعد. ابدأ من الرئيسية لاختيار أستاذ مناسب." />}<div className="student-list">{myTutors.map(b => <article className="saved-tutor" key={b.teacher_id}><div className="avatar"><UserRound size={24} /></div><div><strong>{b.teacher_name}</strong><p>{b.subject} · آخر حصة {date(b.start)}</p><span><Star size={14} /> 4.9</span></div><button className="primary-button" onClick={() => onView('home')}>احجز مجدداً</button></article>)}</div></section>}
      {view === 'wallet' && <section className="student-page wallet-page"><div className="wallet-hero"><span>رصيدك الحالي</span><strong>{money(walletBalance)}</strong><div><button className="primary-button"><CreditCard size={17} />إضافة رصيد</button><button className="secondary-button">سجل العمليات</button></div></div><div className="topup-grid">{[500, 1000, 2000].map(v => <button key={v}>{money(v)}</button>)}<button>مبلغ مخصص</button></div><TransactionList bookings={bookings} /></section>}
      {view === 'history' && <section className="student-page"><h2>السجل</h2><div className="history-tabs"><button>الكل</button><button>الحصص</button><button>المدفوعات</button></div>{!bookings.length && <Empty text="لا يوجد سجل بعد." />}<div className="history-list">{bookings.map(b => <article key={b.id}><BookOpen size={20} /><div><strong>{b.subject}</strong><p>{b.teacher_name} · {date(b.start)}</p></div><span className={`badge ${b.status}`}>{statusNames[b.status]}</span><b>{money(b.price)}</b>{b.status === 'confirmed' && <button className="secondary-button" onClick={() => join(b)}><Video size={16} />دخول</button>}</article>)}</div></section>}
      {view === 'profile' && <section className="student-page account-page"><h2>حسابي</h2><div className="profile-layout"><form className="work-form" onSubmit={async e => { e.preventDefault(); const data = formData(e.currentTarget); await act(async () => { const result = await request<{ user: User }>(`${portal}/profile`, data); onUser(result.user); }); }}><h3>المعلومات الشخصية</h3><label>الاسم الكامل<input name="name" defaultValue={user.name} required /></label><label>البريد الإلكتروني<input value={user.email} readOnly dir="ltr" /></label><label>المرحلة الدراسية<input placeholder="مثال: توجيهي" /></label><input type="hidden" name="subject" value="" /><input type="hidden" name="bio" value="" /><button className="primary-button" disabled={busy}><Save size={17} />حفظ</button></form><div className="account-settings"><button>الإشعارات</button><button>طرق الدفع</button><button>الخصوصية والأمان</button><button>المساعدة والدعم</button></div></div></section>}
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
    {loading ? <p role="status">جارٍ تحميل البيانات…</p> : <>
      {view === 'bookings' && <>
        <div className="metric-band"><div><span>الحصص المؤكدة</span><strong>{bookings.filter(b => b.status === 'confirmed').length}</strong></div><div><span>الحصص المكتملة</span><strong>{bookings.filter(b => b.status === 'completed').length}</strong></div><div><span>الدفعات المسجلة</span><strong>{money(bookings.filter(b => b.paid).reduce((sum, b) => sum + b.price, 0))}</strong></div></div>
        {!shownBookings.length && <Empty text={query || filter !== 'all' ? 'لا توجد نتائج مطابقة.' : 'لا توجد حجوزات حتى الآن.'} />}
        <div className="booking-list">{shownBookings.map(b => <article className={portal !== 'admin' && b.id !== room?.id && reminders.upcoming.some(upcoming => upcoming.id === b.id) && reminderPhase(b, reminders.now) ? 'booking-row lesson-pulse' : 'booking-row'} key={b.id}><div><h2>{b.subject}</h2><p>{portal === 'teachers' ? b.student_name : b.teacher_name}{portal === 'admin' ? ` · ${b.student_name}` : ''}</p><time>{date(b.start)} · {b.minutes} دقيقة</time></div><div className="booking-state"><span className={`badge ${b.status}`}>{statusNames[b.status]}</span><strong>{money(b.price)}</strong><small>{b.paid ? 'دفعة مسجلة' : 'غير مدفوع'}</small>{b.status === 'cancelled' && b.paid === 1 && <small className="refund-note">يلزم مراجعة الاسترداد</small>}</div><div className="row-actions"><button className="secondary-button" onClick={() => setSelected(b.id)}>التفاصيل</button>{b.status === 'confirmed' && portal !== 'admin' && <button className="primary-button" disabled={busy} onClick={() => join(b)}><Video size={17} />دخول الحصة</button>}</div></article>)}</div>
      </>}
      {view === 'slots' && <>
        {portal === 'teachers' && <form className="work-form slot-form" onSubmit={async e => {
          e.preventDefault(); const form = e.currentTarget; const data = formData(form);
          if (await act(() => post('slots', { ...data, start: new Date(String(data.start)).getTime(), minutes: Number(data.minutes), price: Math.round(Number(data.price) * 100) }), 'تم نشر الموعد.')) form.reset();
        }}><h2>إضافة موعد</h2><label>المادة<input name="subject" maxLength={100} defaultValue={user.subject} required /></label><label>التاريخ والوقت<input name="start" type="datetime-local" required /></label><label>المدة<select name="minutes" defaultValue="60">{[30, 45, 60, 90, 120].map(n => <option key={n} value={n}>{n} دقيقة</option>)}</select></label><label>السعر بالدينار الأردني<input name="price" type="number" min="0" max="1000" step="0.01" required /></label><button className="primary-button" disabled={busy}><CalendarPlus size={17} />نشر الموعد</button></form>}
        <p className="muted">المواعيد حسب توقيت جهازك: {Intl.DateTimeFormat().resolvedOptions().timeZone}</p>
        {!slots.filter(s => matches(`${s.subject} ${s.teacher_name || ''}`)).length && <Empty text="لا توجد مواعيد متاحة مطابقة." />}
        <div className="slot-grid">{slots.filter(s => matches(`${s.subject} ${s.teacher_name || ''}`)).map(s => <article className="slot-item" key={s.id}><span className={`badge ${s.status}`}>{statusNames[s.status]}</span><h2>{s.subject}</h2>{s.teacher_name && <strong>{s.teacher_name}</strong>}{s.bio && <p>{s.bio}</p>}<p>{date(s.start)}</p><p>{s.minutes} دقيقة · {money(s.price)}</p>{s.status === 'open' && s.start > Date.now() && <button className="secondary-button" disabled={busy} onClick={() => { if (window.confirm('حذف هذا الموعد؟')) void act(() => post(`slots/${s.id}`), 'تم حذف الموعد.'); }}><X size={17} />حذف الموعد</button>}</article>)}</div>
      </>}
      {view === 'audit' && <div>{!events.length && <Empty text="لا توجد عمليات مسجلة بعد." />}{events.filter(e => matches(`${e.name} ${actionNames[e.action] || e.action}`)).map(e => <article className="audit-row" key={e.id}><strong>{actionNames[e.action] || e.action}</strong><span>{e.name}</span><time>{date(e.created)}</time><small dir="ltr">{e.target}</small></article>)}</div>}
      {view === 'profile' && <div className="profile-layout"><form className="work-form" onSubmit={async e => { e.preventDefault(); const data = formData(e.currentTarget); await act(async () => { const result = await request<{ user: User }>(`${portal}/profile`, data); onUser(result.user); }); }}><h2>معلومات الحساب</h2><label>الاسم الكامل<input name="name" defaultValue={user.name} maxLength={100} required /></label><label>البريد الإلكتروني<input value={user.email} readOnly dir="ltr" /></label>{portal === 'teachers' ? <><label>المادة أو التخصص<input name="subject" defaultValue={user.subject} maxLength={100} /></label><label>نبذة مهنية<textarea name="bio" defaultValue={user.bio} maxLength={2000} rows={5} /></label></> : <><input type="hidden" name="subject" value="" /><input type="hidden" name="bio" value="" /></>}<button className="primary-button" disabled={busy}><Save size={17} />حفظ</button></form><form className="work-form" onSubmit={async e => { e.preventDefault(); const data = formData(e.currentTarget); await act(async () => { await post('password', data); onUser(null); }); }}><h2>تغيير كلمة المرور</h2><label>كلمة المرور الحالية<input name="current" type="password" minLength={12} maxLength={128} autoComplete="current-password" required /></label><label>كلمة المرور الجديدة<input name="password" type="password" minLength={12} maxLength={128} autoComplete="new-password" required /></label><small>12 حرفًا على الأقل. يلزم الدخول مجددًا بعد التغيير.</small><button className="secondary-button" disabled={busy}><Save size={17} />تغيير كلمة المرور</button></form></div>}
    </>}
    {current && <dialog ref={node => { if (node && !node.open) node.showModal(); }} onCancel={() => setSelected(null)} className="detail-dialog" aria-labelledby="lesson-title"><div className="section-heading"><h2 id="lesson-title">{current.subject}</h2><button className="icon-button" title="إغلاق التفاصيل" onClick={() => setSelected(null)}><X size={20} /></button></div>{error && <p className="notice error" role="alert">{error}</p>}{success && <p className="notice success" role="status">{success}</p>}<p>{current.teacher_name} · {current.student_name}</p><p>{date(current.start)} · {money(current.price)}</p><span className={`badge ${current.status}`}>{statusNames[current.status]}</span>
      {portal === 'teachers' ? <form className="work-form" key={current.id} onSubmit={e => { e.preventDefault(); void act(() => post(`bookings/${current.id}/notes`, formData(e.currentTarget))); }}><label>ملخص الحصة والواجب<textarea name="notes" defaultValue={current.notes} maxLength={5000} rows={4} /></label><label>رابط المادة التعليمية<input name="resource" type="url" dir="ltr" defaultValue={current.resource} maxLength={1000} /></label><button className="secondary-button" disabled={busy || current.status === 'cancelled'}><Save size={17} />حفظ المادة والملخص</button></form> : <div className="lesson-notes"><h3>ملخص الحصة والواجب</h3><p>{current.notes || 'لم يضف الأستاذ ملخصًا بعد.'}</p>{current.resource && <a href={current.resource} target="_blank" rel="noopener noreferrer">فتح المادة التعليمية</a>}</div>}
      {portal === 'admin' && <form className="work-form" key={`payment-${current.id}-${current.paid}`} onSubmit={e => { e.preventDefault(); const data = formData(e.currentTarget); void act(() => post(`bookings/${current.id}/payment`, { paid: current.paid ? 0 : 1, reference: data.reference || '' })); }}><h3>{current.paid ? 'الدفعة مسجلة' : 'تسجيل دفعة مستلمة'}</h3><label>مرجع الحوالة أو الإيصال<input name="reference" defaultValue={current.payment_ref} maxLength={200} required={!current.paid} /></label><button className="secondary-button" disabled={busy}>{current.paid ? 'عكس تسجيل الدفعة' : 'تأكيد الاستلام اليدوي'}</button></form>}
      <div className="row-actions">{current.status === 'confirmed' && <button className="secondary-button" disabled={busy} onClick={() => cancel(current)}>إلغاء الحصة</button>}{portal === 'teachers' && current.status === 'confirmed' && current.start + current.minutes * 60000 <= Date.now() && <button className="primary-button" disabled={busy} onClick={() => { if (window.confirm('تأكيد اكتمال هذه الحصة؟')) void act(() => post(`bookings/${current.id}/complete`)); }}><Check size={17} />تأكيد اكتمال الحصة</button>}</div>
      <section className="lesson-messages"><h3>مراسلات الحصة</h3>{messages.map(m => <article key={m.id}><strong>{m.name}</strong><small>{date(m.created)}</small><p>{m.body}</p></article>)}<form onSubmit={async (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const form = e.currentTarget; const data = formData(form); if (await act(async () => { const result = await request<{ messages: Message[] }>(`${portal}/bookings/${current.id}/messages`, data); setMessages(result.messages); }, 'تم إرسال الرسالة.')) form.reset(); }}><label>رسالة جديدة<textarea name="body" maxLength={2000} rows={2} required /></label><button className="primary-button" disabled={busy || current.status === 'cancelled'}><Send size={17} />إرسال</button></form></section>
    </dialog>}
  </div>;
}
function TutorList({ slots, busy, bookSlot, compact = false }: { slots: Slot[]; busy: boolean; bookSlot: (slot: Slot) => void; compact?: boolean }) {
  if (!slots.length) return <Empty text="لا توجد مواعيد مناسبة حالياً." />;
  return <div className={compact ? 'tutor-strip' : 'tutor-market-list'}>{slots.map((slot, index) => <article className="tutor-card" key={slot.id}>
    <div className="tutor-photo">{slot.teacher_name?.slice(0, 1) || 'أ'}</div>
    <div className="tutor-info"><div><strong>{slot.teacher_name || 'أستاذ معتمد'}</strong><span className="verified">موثّق</span></div><p>{slot.subject}</p><small><Star size={14} /> 4.{9 - (index % 3)} · {24 + index * 7} حصة مكتملة</small><time>أقرب موعد: {date(slot.start)}</time></div>
    <div className="tutor-actions"><b>{money(slot.price)}</b><button className="secondary-button">عرض الأستاذ</button><button className="primary-button" disabled={busy} onClick={() => bookSlot(slot)}>احجز الآن</button></div>
  </article>)}</div>;
}

function TransactionList({ bookings }: { bookings: Booking[] }) {
  const rows = bookings.slice(0, 6);
  return <div className="transaction-list"><h3>سجل العمليات</h3>{!rows.length && <Empty text="لا توجد عمليات بعد." />}{rows.map(b => <article key={b.id}><span className={b.paid ? 'positive' : 'negative'}>{b.paid ? 'دفع حصة' : 'حجز غير مدفوع'}</span><div><strong>{b.subject}</strong><small>{date(b.start)}</small></div><b className={b.paid ? 'negative' : ''}>{b.paid ? '-' : ''}{money(b.price)}</b></article>)}</div>;
}

function Empty({ text }: { text: string }) { return <div className="empty-state"><CalendarPlus size={30} /><p>{text}</p></div>; }
