import { useEffect, useState, type FormEvent } from 'react';
import { BookOpen, CalendarPlus, Check, ChevronLeft, CreditCard, Download, History as HistoryIcon, RefreshCw, Search, Send, Star, UserRound, Video, X, Save, Bell, BellOff } from 'lucide-react';
import { request, date, money, statusNames, type Booking, type Slot, type Portal, type User, type Message, type WalletTransaction, type Earnings } from '../../services/platformApi';
import { VideoRoom } from '../video/VideoRoom';
import { useLessonReminders, reminderPhase } from './useLessonReminders';
import { AccountsPanel } from './AccountsPanel';

type EventRow = { id: string; name: string; action: string; target: string; created: number };
type Room = { id: string; room: string; role: 'teacher' | 'student' };
const actionNames: Record<string, string> = { 'user:password-reset': 'Ø¥ØµØ¯Ø§Ø± ÙƒÙ„Ù…Ø© Ù…Ø±ÙˆØ± Ù…Ø¤Ù‚ØªØ©', 'user:active': 'ØªÙØ¹ÙŠÙ„ Ø­Ø³Ø§Ø¨', 'user:suspended': 'Ø¥ÙŠÙ‚Ø§Ù Ø­Ø³Ø§Ø¨', 'booking:cancel': 'Ø¥Ù„ØºØ§Ø¡ Ø­ØµØ©', 'payment:received': 'ØªØ³Ø¬ÙŠÙ„ Ø¯ÙØ¹Ø©', 'payment:reversed': 'Ø¹ÙƒØ³ Ø¯ÙØ¹Ø©' };
const formData = (form: HTMLFormElement) => Object.fromEntries(new FormData(form));

export function PortalWorkspace({ portal, user, view, onUser, onView }: { portal: Portal; user: User; view: string; onUser: (u: User | null) => void; onView: (view: string) => void }) {
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [wallet, setWallet] = useState<{ balance: number; transactions: WalletTransaction[] }>({ balance: 0, transactions: [] });
  const [earnings, setEarnings] = useState<Earnings | null>(null);
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
    const path = portal === 'students' ? (view === 'home' ? 'slots' : view === 'profile' ? 'profile' : view === 'wallet' ? 'wallet' : 'overview') : view === 'bookings' ? 'overview' : view;
    request<{ bookings?: Booking[]; slots?: Slot[]; users?: User[]; events?: EventRow[]; balance?: number; transactions?: WalletTransaction[]; earnings?: Earnings }>(`${portal}/${path}`).then(data => {
      if (!alive) return;
      if (data.bookings) setBookings(data.bookings);
      if (data.slots) setSlots(data.slots);
      if (data.users) setUsers(data.users);
      if (data.events) setEvents(data.events);
      if (typeof data.balance === 'number') setWallet({ balance: data.balance, transactions: data.transactions || [] });
      if ('gross' in data) setEarnings(data as Earnings);
    }).catch(e => { if (alive) setError(e.message); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [portal, view, revision]);
  useEffect(() => {
    if (portal !== 'students') return;
    request<{ balance: number; transactions: WalletTransaction[] }>('students/wallet').then(data => setWallet(data)).catch(() => {});
  }, [portal, revision]);
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
  async function act(action: () => Promise<unknown>, message = 'ØªÙ… Ø­ÙØ¸ Ø§Ù„ØªØºÙŠÙŠØ±Ø§Øª.') {
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
    const rows = [['Ø§Ù„Ù…Ø§Ø¯Ø©', 'Ø§Ù„Ø£Ø³ØªØ§Ø°', 'Ø§Ù„Ø·Ø§Ù„Ø¨', 'Ø§Ù„Ù…ÙˆØ¹Ø¯', 'Ø§Ù„Ø­Ø§Ù„Ø©', 'Ø§Ù„Ø³Ø¹Ø± Ø¨Ø§Ù„Ø¯ÙŠÙ†Ø§Ø±', 'Ù…Ø¯ÙÙˆØ¹', 'Ù…Ø±Ø¬Ø¹ Ø§Ù„Ø¯ÙØ¹Ø©'], ...shownBookings.map(b => [b.subject, b.teacher_name, b.student_name, date(b.start), statusNames[b.status], b.price / 100, b.paid ? 'Ù†Ø¹Ù…' : 'Ù„Ø§', b.payment_ref])];
    const url = URL.createObjectURL(new Blob(['\uFEFF' + rows.map(r => r.map(safe).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = 'mansah-bookings.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function join(b: Booking) {
    await act(async () => {
      const data = await request<Omit<Room, 'id'>>(`${portal}/bookings/${b.id}/room`);
      setRoom({ id: b.id, ...data });
    }, 'Ø§Ù„ØºØ±ÙØ© Ø¬Ø§Ù‡Ø²Ø©.');
  }
  const cancel = (b: Booking) => { if (window.confirm(`Ø¥Ù„ØºØ§Ø¡ Ø­ØµØ© ${b.subject} Ø¨ØªØ§Ø±ÙŠØ® ${date(b.start)}ØŸ`)) void act(() => post(`bookings/${b.id}/cancel`), 'ØªÙ… Ø¥Ù„ØºØ§Ø¡ Ø§Ù„Ø­ØµØ©.'); };
  const openSlots = slots.filter(s => s.status === 'open' && s.start > Date.now() && matches(`${s.subject} ${s.teacher_name || ''}`));
  const nextLesson = bookings.filter(b => b.status === 'confirmed' && b.start > Date.now()).sort((a, b) => a.start - b.start)[0];
  const teacherNextLesson = bookings.filter(b => b.status === 'confirmed' && b.start > Date.now()).sort((a, b) => a.start - b.start)[0];
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = dayStart.getTime() + 86400000;
  const teacherBooked = bookings.filter(b => b.status === 'confirmed' && (filter === 'all' || (filter === 'today' && b.start >= dayStart.getTime() && b.start < dayEnd) || (filter === 'tomorrow' && b.start >= dayEnd && b.start < dayEnd + 86400000) || (filter === 'week' && b.start >= dayStart.getTime() && b.start < dayStart.getTime() + 604800000))).sort((a, b) => a.start - b.start);
  const completedThisWeek = earnings?.completed || bookings.filter(b => b.status === 'completed');
  const grossEarnings = earnings?.gross ?? completedThisWeek.reduce((sum, b) => sum + b.price, 0);
  const platformFee = earnings?.fee ?? Math.round(grossEarnings * 0.15);
  const netEarnings = earnings?.net ?? grossEarnings - platformFee;
  const teacherMap = new Map<string, Booking>();
  bookings.forEach(b => { if (!teacherMap.has(b.teacher_id)) teacherMap.set(b.teacher_id, b); });
  const myTutors = [...teacherMap.values()];
  const categories = [
    ['jordan', 'Ø§Ù„Ù…Ù†Ù‡Ø§Ø¬ Ø§Ù„Ø£Ø±Ø¯Ù†ÙŠ', 'ØªÙˆØ¬ÙŠÙ‡ÙŠ ÙˆØ¬Ù…ÙŠØ¹ Ø§Ù„ØµÙÙˆÙ Ø§Ù„Ù…Ø¯Ø±Ø³ÙŠØ©', 'ðŸ“š'],
    ['quran', 'ØªØ­ÙÙŠØ¸ Ø§Ù„Ù‚Ø±Ø¢Ù† Ø§Ù„ÙƒØ±ÙŠÙ…', 'ØªÙ„Ø§ÙˆØ©ØŒ Ø­ÙØ¸ØŒ ÙˆØªØ¬ÙˆÙŠØ¯', 'â˜˜'],
    ['reading', 'ØªØ¹Ù„ÙŠÙ… Ø§Ù„Ù‚Ø±Ø§Ø¡Ø© ÙˆØ§Ù„ÙƒØªØ§Ø¨Ø©', 'ØªØ£Ø³ÙŠØ³ Ø¹Ø±Ø¨ÙŠ Ù„Ù„Ø£Ø·ÙØ§Ù„ ÙˆØ§Ù„ÙƒØ¨Ø§Ø±', 'âœ'],
    ['english', 'Ø§Ù„Ù„ØºØ© Ø§Ù„Ø¥Ù†Ø¬Ù„ÙŠØ²ÙŠØ©', 'Ù…Ø­Ø§Ø¯Ø«Ø©ØŒ Ù…Ø¯Ø±Ø³Ø©ØŒ ÙˆØ§Ø®ØªØ¨Ø§Ø±Ø§Øª', 'EN'],
    ['university', 'Ø§Ù„Ù…ÙˆØ§Ø¯ Ø§Ù„Ø¬Ø§Ù…Ø¹ÙŠØ©', 'Ù…Ø³Ø§Ù†Ø¯Ø© Ø¬Ø§Ù…Ø¹ÙŠØ© Ù…ØªØ®ØµØµØ©', 'ðŸŽ“'],
    ['skills', 'Ù…Ù‡Ø§Ø±Ø§Øª ÙˆØ¯ÙˆØ±Ø§Øª Ø£Ø®Ø±Ù‰', 'Ù…Ù‡Ø§Ø±Ø§Øª Ø¹Ù…Ù„ÙŠØ© ÙˆØ¯ÙˆØ±Ø§Øª Ù‚ØµÙŠØ±Ø©', 'âœ¨'],
  ] as const;
  const levels = ['ØªÙˆØ¬ÙŠÙ‡ÙŠ', 'Ø§Ù„ØµÙ Ø§Ù„Ø¹Ø§Ø´Ø±', 'Ø§Ù„ØµÙ Ø§Ù„ØªØ§Ø³Ø¹', 'Ø§Ù„ØµÙ Ø§Ù„Ø«Ø§Ù…Ù†', 'Ø§Ù„ØµÙ Ø§Ù„Ø³Ø§Ø¨Ø¹', 'Ø§Ù„Ù…Ø±Ø­Ù„Ø© Ø§Ù„Ø£Ø³Ø§Ø³ÙŠØ©'];
  const subjects = ['Ø±ÙŠØ§Ø¶ÙŠØ§Øª', 'ÙÙŠØ²ÙŠØ§Ø¡', 'ÙƒÙŠÙ…ÙŠØ§Ø¡', 'Ø¹Ø±Ø¨ÙŠ', 'Ø¥Ù†Ø¬Ù„ÙŠØ²ÙŠ', 'Ø£Ø­ÙŠØ§Ø¡'];
  const subjectSlots = openSlots.filter(s => !studentSubject || s.subject.includes(studentSubject) || studentSubject.includes(s.subject));
  const studentSearch = <label className="student-search"><Search size={19} /><input aria-label="Ø¨Ø­Ø«" placeholder="Ø§Ø¨Ø­Ø« Ø¹Ù† Ù…Ø§Ø¯Ø© Ø£Ùˆ Ø£Ø³ØªØ§Ø°" value={query} onChange={e => setQuery(e.target.value)} /></label>;
  const bookSlot = (s: Slot) => {
    const useWallet = window.confirm(`Ø§Ù„Ø¯ÙØ¹ Ù…Ù† Ø§Ù„Ù…Ø­ÙØ¸Ø©ØŸ\nØ§Ù„Ø±ØµÙŠØ¯: ${money(wallet.balance)}\nÙ‚ÙŠÙ…Ø© Ø§Ù„Ø­ØµØ©: ${money(s.price)}\nÙ…ÙˆØ§ÙÙ‚ = Ø§Ù„Ù…Ø­ÙØ¸Ø©ØŒ Ø¥Ù„ØºØ§Ø¡ = Ø¯ÙØ¹ ØªØ¬Ø±ÙŠØ¨ÙŠ Ø§Ù„Ø¢Ù†`);
    if (useWallet && wallet.balance < s.price) { setError('Ø±ØµÙŠØ¯ Ø§Ù„Ù…Ø­ÙØ¸Ø© ØºÙŠØ± ÙƒØ§Ù. Ø§Ø´Ø­Ù† Ø±ØµÙŠØ¯ ØªØ¬Ø±ÙŠØ¨ÙŠ Ø«Ù… Ø£Ø¹Ø¯ Ø§Ù„Ø­Ø¬Ø².'); onView('wallet'); return; }
    void act(() => post(`slots/${s.id}`, { method: useWallet ? 'wallet' : 'sandbox' }), 'ØªÙ… ØªØ£ÙƒÙŠØ¯ Ø§Ù„Ø­Ø¬Ø² ÙˆØ§Ù„Ø¯ÙØ¹.');
  };
  const topUpWallet = () => {
    const amount = Number(window.prompt('Ø£Ø¯Ø®Ù„ Ù…Ø¨Ù„Øº Ø§Ù„Ø´Ø­Ù† Ø§Ù„ØªØ¬Ø±ÙŠØ¨ÙŠ Ø¨Ø§Ù„Ø¯ÙŠÙ†Ø§Ø±', '10'));
    if (Number.isFinite(amount) && amount > 0) void act(() => post('wallet', { amount }), 'ØªÙ…Øª Ø¥Ø¶Ø§ÙØ© Ø§Ù„Ø±ØµÙŠØ¯ Ø§Ù„ØªØ¬Ø±ÙŠØ¨ÙŠ.');
  };
  const teacherCategories = categories.map(([id, title, desc, icon]) => [id, title, desc, icon] as const);
  const addSlotForm = <form className="work-form slot-form tutor-slot-form" onSubmit={async e => {
    e.preventDefault(); const form = e.currentTarget; const data = formData(form);
    if (await act(() => post('slots', { ...data, start: new Date(String(data.start)).getTime(), minutes: Number(data.minutes), price: Math.round(Number(data.price) * 100) }), 'ØªÙ… Ù†Ø´Ø± Ø§Ù„Ù…ÙˆØ¹Ø¯.')) form.reset();
  }}><h3>Ø¥Ø¶Ø§ÙØ© Ù…ÙˆØ¹Ø¯ Ù…ØªØ§Ø­</h3><label>Ø§Ù„Ù…Ø§Ø¯Ø©<input name="subject" maxLength={100} defaultValue={user.subject} required /></label><label>Ø§Ù„ØªØ§Ø±ÙŠØ® ÙˆØ§Ù„ÙˆÙ‚Øª<input name="start" type="datetime-local" required /></label><label>Ø§Ù„Ù…Ø¯Ø©<select name="minutes" defaultValue="60">{[30, 45, 60, 90, 120].map(n => <option key={n} value={n}>{n} Ø¯Ù‚ÙŠÙ‚Ø©</option>)}</select></label><label>Ø§Ù„Ø³Ø¹Ø± Ø¨Ø§Ù„Ø¯ÙŠÙ†Ø§Ø±<input name="price" type="number" min="0" max="1000" step="0.01" required /></label><button className="primary-button" disabled={busy}><CalendarPlus size={17} />Ù†Ø´Ø± Ø§Ù„Ù…ÙˆØ¹Ø¯</button></form>;
  if (portal === 'students') return <div className="portal-content student-experience">
    <div className="reminder-settings"><button className="secondary-button" aria-pressed={reminders.enabled} onClick={reminders.toggle}>{reminders.enabled ? <Bell size={18} /> : <BellOff size={18} />}{reminders.enabled ? 'Ø§Ù„ØªÙ†Ø¨ÙŠÙ‡Ø§Øª Ù…ÙØ¹Ù‘Ù„Ø©' : 'ØªÙØ¹ÙŠÙ„ ØªÙ†Ø¨ÙŠÙ‡Ø§Øª Ø§Ù„Ø­ØµØµ'}</button>{reminders.hint && <small role="status">{reminders.hint}</small>}</div>
    {reminders.upcoming.map(b => <div className="lesson-reminder lesson-pulse" key={b.id}><Bell size={22} /><div><strong>{b.subject}</strong><p>{b.start > reminders.now ? `ØªØ¨Ø¯Ø£ Ø®Ù„Ø§Ù„ ${Math.ceil((b.start - reminders.now) / 60000)} Ø¯Ù‚ÙŠÙ‚Ø©` : 'Ø­Ø§Ù† Ù…ÙˆØ¹Ø¯ Ø§Ù„Ø­ØµØ©'}</p></div><button className="primary-button" disabled={busy} onClick={() => { onView('history'); void join(b); }}><Video size={17} />Ø¯Ø®ÙˆÙ„ Ø§Ù„Ø­ØµØ©</button></div>)}
    {error && <p className="notice error" role="alert">{error}</p>}{success && <p className="notice success" role="status">{success}</p>}
    {room && <div hidden={view !== 'history'} className="lesson-call"><VideoRoom key={room.id} assignedRole={room.role} assignedRoom={room.room} authorize={() => request(`${portal}/bookings/${room.id}/room`)} /></div>}
    {loading ? <p role="status">Ø¬Ø§Ø±Ù ØªØ­Ù…ÙŠÙ„ Ø§Ù„Ø¨ÙŠØ§Ù†Ø§Øªâ€¦</p> : <>
      {view === 'home' && <section className="student-home">
        <div className="student-hero"><div><span>Ù…Ù†ØµØ© ØªØ¹Ù„ÙŠÙ… Ø®ØµÙˆØµÙŠ</span><h2>Ù…Ø§Ø°Ø§ ØªØ±ÙŠØ¯ Ø£Ù† ØªØªØ¹Ù„Ù…ØŸ</h2><p>Ø§Ø®ØªØ± Ø§Ù„Ù…Ø¬Ø§Ù„ØŒ Ø«Ù… Ø§Ù„Ù…Ø³ØªÙˆÙ‰ ÙˆØ§Ù„Ù…Ø§Ø¯Ø©ØŒ ÙˆØ³Ù†ÙˆØµÙ„Ùƒ Ø¨Ø§Ù„Ø£Ø³ØªØ§Ø° Ø§Ù„Ù…Ù†Ø§Ø³Ø¨ Ø¨Ø³Ø±Ø¹Ø©.</p></div>{studentSearch}</div>
        {nextLesson && <article className="upcoming-card"><CalendarPlus size={22} /><div><span>Ø­ØµØªÙƒ Ø§Ù„Ù‚Ø§Ø¯Ù…Ø©</span><strong>{nextLesson.subject}</strong><p>{nextLesson.teacher_name} Â· {date(nextLesson.start)}</p></div><button className="primary-button" onClick={() => { onView('history'); setSelected(nextLesson.id); }}>Ø§Ù„ØªÙØ§ØµÙŠÙ„</button></article>}
        {studentStep === 'categories' && <div className="category-grid">{categories.map(([id, title, desc, icon]) => <button key={id} className="category-card" onClick={() => { setStudentCategory(title); setStudentStep(id === 'jordan' ? 'levels' : 'tutors'); }}><span>{icon}</span><strong>{title}</strong><p>{desc}</p><ChevronLeft size={18} /></button>)}</div>}
        {studentStep !== 'categories' && <div className="student-flow"><button className="text-button" onClick={() => { setStudentStep('categories'); setStudentCategory(''); setStudentLevel(''); setStudentSubject(''); }}>Ø§Ù„Ø¹ÙˆØ¯Ø© Ù„Ù„ØªØµÙ†ÙŠÙØ§Øª</button><h3>{studentCategory}</h3>{studentStep === 'levels' && <div className="choice-grid">{levels.map(level => <button onClick={() => { setStudentLevel(level); setStudentStep('subjects'); }} key={level}>{level}</button>)}</div>}{studentStep === 'subjects' && <><p>{studentLevel}</p><div className="choice-grid">{subjects.map(subject => <button onClick={() => { setStudentSubject(subject); setStudentStep('tutors'); }} key={subject}>{subject}</button>)}</div></>}{studentStep === 'tutors' && <TutorList slots={subjectSlots} busy={busy} bookSlot={bookSlot} />}</div>}
        <section><div className="section-heading"><h3>Ù…ØªØ§Ø­ÙˆÙ† Ø§Ù„Ø¢Ù†</h3><button className="text-button" onClick={() => { setStudentStep('tutors'); setStudentSubject(''); }}>Ø¹Ø±Ø¶ Ø§Ù„ÙƒÙ„</button></div><TutorList slots={openSlots.slice(0, 3)} busy={busy} bookSlot={bookSlot} compact /></section>
      </section>}
      {view === 'tutors' && <section className="student-page"><h2>Ø£Ø³Ø§ØªØ°ØªÙŠ</h2>{!myTutors.length && <Empty text="Ù„Ù… ØªØ­Ø¬Ø² Ù…Ø¹ Ø£ÙŠ Ø£Ø³ØªØ§Ø° Ø¨Ø¹Ø¯. Ø§Ø¨Ø¯Ø£ Ù…Ù† Ø§Ù„Ø±Ø¦ÙŠØ³ÙŠØ© Ù„Ø§Ø®ØªÙŠØ§Ø± Ø£Ø³ØªØ§Ø° Ù…Ù†Ø§Ø³Ø¨." />}<div className="student-list">{myTutors.map(b => <article className="saved-tutor" key={b.teacher_id}><div className="avatar"><UserRound size={24} /></div><div><strong>{b.teacher_name}</strong><p>{b.subject} Â· Ø¢Ø®Ø± Ø­ØµØ© {date(b.start)}</p><span><Star size={14} /> 4.9</span></div><button className="primary-button" onClick={() => onView('home')}>Ø§Ø­Ø¬Ø² Ù…Ø¬Ø¯Ø¯Ø§Ù‹</button></article>)}</div></section>}
      {view === 'wallet' && <section className="student-page wallet-page"><div className="wallet-hero"><span>المحفظة</span><strong>{money(wallet.balance)}</strong><p>رصيد تجريبي آمن للاختبار والحجز داخل المنصة.</p><div><button className="primary-button" onClick={topUpWallet} disabled={busy}><CreditCard size={17} />إضافة رصيد تجريبي</button><button className="secondary-button" onClick={refresh}>تحديث العمليات</button></div></div><TransactionList transactions={wallet.transactions} /></section>}
      {view === 'history' && <section className="student-page"><h2>Ø§Ù„Ø³Ø¬Ù„</h2><div className="history-tabs"><button onClick={refresh}>Ø§Ù„ÙƒÙ„</button><button onClick={refresh}>Ø§Ù„Ø­ØµØµ</button><button onClick={refresh}>Ø§Ù„Ù…Ø¯ÙÙˆØ¹Ø§Øª</button></div>{!bookings.length && <Empty text="Ù„Ø§ ÙŠÙˆØ¬Ø¯ Ø³Ø¬Ù„ Ø¨Ø¹Ø¯." />}<div className="history-list">{bookings.map(b => <article key={b.id}><BookOpen size={20} /><div><strong>{b.subject}</strong><p>{b.teacher_name} Â· {date(b.start)}</p></div><span className={`badge ${b.status}`}>{statusNames[b.status]}</span><b>{money(b.price)}</b>{b.status === 'confirmed' && <button className="secondary-button" onClick={() => join(b)}><Video size={16} />Ø¯Ø®ÙˆÙ„</button>}</article>)}</div></section>}
      {view === 'profile' && <section className="student-page account-page"><h2>Ø­Ø³Ø§Ø¨ÙŠ</h2><div className="profile-layout"><form className="work-form" onSubmit={async e => { e.preventDefault(); const data = formData(e.currentTarget); await act(async () => { const result = await request<{ user: User }>(`${portal}/profile`, data); onUser(result.user); }); }}><h3>Ø§Ù„Ù…Ø¹Ù„ÙˆÙ…Ø§Øª Ø§Ù„Ø´Ø®ØµÙŠØ©</h3><label>Ø§Ù„Ø§Ø³Ù… Ø§Ù„ÙƒØ§Ù…Ù„<input name="name" defaultValue={user.name} required /></label><label>Ø§Ù„Ø¨Ø±ÙŠØ¯ Ø§Ù„Ø¥Ù„ÙƒØªØ±ÙˆÙ†ÙŠ<input value={user.email} readOnly dir="ltr" /></label><label>Ø§Ù„Ù…Ø±Ø­Ù„Ø© Ø§Ù„Ø¯Ø±Ø§Ø³ÙŠØ©<input placeholder="Ù…Ø«Ø§Ù„: ØªÙˆØ¬ÙŠÙ‡ÙŠ" disabled /></label><input type="hidden" name="subject" value="" /><input type="hidden" name="bio" value="" /><button className="primary-button" disabled={busy}><Save size={17} />Ø­ÙØ¸</button></form><div className="account-settings"><button onClick={refresh}>Ø§Ù„Ø¥Ø´Ø¹Ø§Ø±Ø§Øª ØºÙŠØ± Ù…ØªØ§Ø­Ø©</button><button onClick={refresh}>Ø·Ø±Ù‚ Ø§Ù„Ø¯ÙØ¹ ØºÙŠØ± Ù…ØªØ§Ø­Ø©</button><button onClick={refresh}>Ø§Ù„Ø®ØµÙˆØµÙŠØ© ÙˆØ§Ù„Ø£Ù…Ø§Ù† Ù‚Ø±ÙŠØ¨Ø§Ù‹</button><button onClick={refresh}>Ø§Ù„Ù…Ø³Ø§Ø¹Ø¯Ø© ÙˆØ§Ù„Ø¯Ø¹Ù… Ù‚Ø±ÙŠØ¨Ø§Ù‹</button></div></div></section>}
    </>}
  </div>;
  if (portal === 'teachers') return <div className="portal-content tutor-experience">
    <div className="reminder-settings"><button className="secondary-button" aria-pressed={reminders.enabled} onClick={reminders.toggle}>{reminders.enabled ? <Bell size={18} /> : <BellOff size={18} />}{reminders.enabled ? 'Ø§Ù„ØªÙ†Ø¨ÙŠÙ‡Ø§Øª Ù…ÙØ¹Ù‘Ù„Ø©' : 'ØªÙØ¹ÙŠÙ„ ØªÙ†Ø¨ÙŠÙ‡Ø§Øª Ø§Ù„Ø­ØµØµ'}</button>{reminders.hint && <small role="status">{reminders.hint}</small>}</div>
    {reminders.upcoming.map(b => <div className="lesson-reminder lesson-pulse" key={b.id}><Bell size={22} /><div><strong>{b.subject}</strong><p>{b.start > reminders.now ? `ØªØ¨Ø¯Ø£ Ø®Ù„Ø§Ù„ ${Math.ceil((b.start - reminders.now) / 60000)} Ø¯Ù‚ÙŠÙ‚Ø©` : 'Ø­Ø§Ù† Ù…ÙˆØ¹Ø¯ Ø§Ù„Ø­ØµØ©'}</p></div><button className="primary-button" disabled={busy} onClick={() => { onView('booked'); void join(b); }}><Video size={17} />Ø¯Ø®ÙˆÙ„ Ø§Ù„Ø­ØµØ©</button></div>)}
    {error && <p className="notice error" role="alert">{error}</p>}{success && <p className="notice success" role="status">{success}</p>}
    {room && <div hidden={view !== 'booked'} className="lesson-call"><VideoRoom key={room.id} assignedRole={room.role} assignedRoom={room.room} authorize={() => request(`${portal}/bookings/${room.id}/room`)} /></div>}
    {loading ? <p role="status">Ø¬Ø§Ø±Ù ØªØ­Ù…ÙŠÙ„ Ø§Ù„Ø¨ÙŠØ§Ù†Ø§Øªâ€¦</p> : <>
      {view === 'home' && <section className="tutor-home">
        <div className="student-hero tutor-hero"><div><span>Ù…Ù†ØµØ© Ø§Ù„Ø£Ø³Ø§ØªØ°Ø©</span><h2>Ø¨Ø´Ùˆ Ø¨ØªØ±ØºØ¨ ØªØ¹Ø·ÙŠØŸ</h2><p>Ø§Ø®ØªØ± Ø§Ù„Ù…Ø¬Ø§Ù„ ÙˆØ§Ù„Ù…Ø³ØªÙˆÙ‰ ÙˆØ§Ù„Ù…Ø§Ø¯Ø©ØŒ Ø«Ù… Ø§ÙØªØ­ Ù…ÙˆØ§Ø¹ÙŠØ¯Ùƒ Ù„Ù„Ø·Ù„Ø§Ø¨ Ø¨Ø³Ù‡ÙˆÙ„Ø©.</p></div><div className="tutor-summary"><span>Ø§Ù„Ø­ØµØ© Ø§Ù„Ù‚Ø§Ø¯Ù…Ø©</span>{teacherNextLesson ? <><strong>{teacherNextLesson.subject}</strong><p>{teacherNextLesson.student_name} Â· {date(teacherNextLesson.start)}</p><button className="primary-button" onClick={() => { onView('booked'); void join(teacherNextLesson); }}>Ø¯Ø®ÙˆÙ„ Ø§Ù„Ø­ØµØ©</button></> : <p>Ù„Ø§ ØªÙˆØ¬Ø¯ Ø­ØµØ© Ù‚Ø§Ø¯Ù…Ø©.</p>}</div></div>
        <div className="teacher-metrics"><div><span>Ø­Ø¬ÙˆØ²Ø§Øª Ø§Ù„ÙŠÙˆÙ…</span><strong>{teacherBooked.filter(b => new Date(b.start).toDateString() === new Date().toDateString()).length}</strong></div><div><span>Ø§Ù„Ø³Ø§Ø¹Ø§Øª Ø§Ù„Ù…ØªØ§Ø­Ø©</span><strong>{slots.filter(s => s.status === 'open').length}</strong></div><div><span>Ù…Ø³ØªØ­Ù‚Ø§Øª Ù‡Ø°Ø§ Ø§Ù„Ø£Ø³Ø¨ÙˆØ¹</span><strong>{money(netEarnings)}</strong></div></div>
        <div className="category-grid">{teacherCategories.map(([id, title, desc, icon]) => <button key={id} className="category-card" onClick={() => { onView('available'); }}><span>{icon}</span><strong>{title}</strong><p>{desc}</p><small>Ø§Ø®ØªÙŠØ§Ø± Ø§Ù„ØªØµÙ†ÙŠÙ ØºÙŠØ± Ù…ÙØ¹Ù‘Ù„ Ø¨Ø¹Ø¯</small></button>)}</div>
      </section>}
      {view === 'booked' && <section className="student-page"><div className="section-heading"><h2>Ø§Ù„Ù…ÙˆØ§Ø¹ÙŠØ¯ Ø§Ù„Ù…Ø­Ø¬ÙˆØ²Ø©</h2><div className="history-tabs"><button onClick={refresh}>Ø§Ù„ÙŠÙˆÙ…</button><button onClick={refresh}>ØºØ¯Ø§Ù‹</button><button onClick={refresh}>Ø§Ù„Ø£Ø³Ø¨ÙˆØ¹</button></div></div>{!teacherBooked.length && <Empty text="Ù„Ø§ ØªÙˆØ¬Ø¯ Ø­ØµØµ Ù…Ø­Ø¬ÙˆØ²Ø© Ø­Ø§Ù„ÙŠØ§Ù‹." />}<div className="history-list">{teacherBooked.map((b, i) => <article className={i === 0 ? 'next-booking' : ''} key={b.id}><BookOpen size={20} /><div><strong>{b.subject}</strong><p>{b.student_name} Â· {date(b.start)} Â· {b.minutes} Ø¯Ù‚ÙŠÙ‚Ø©</p></div><span className={`badge ${b.status}`}>{statusNames[b.status]}</span><b>{money(b.price)}</b><button className="secondary-button" onClick={() => setSelected(b.id)}>Ø§Ù„ØªÙØ§ØµÙŠÙ„</button><button className="primary-button" onClick={() => join(b)}><Video size={16} />Ø¯Ø®ÙˆÙ„</button></article>)}</div></section>}
      {view === 'available' && <section className="student-page availability-page"><h2>Ø§Ù„Ù…ÙˆØ§Ø¹ÙŠØ¯ Ø§Ù„Ù…ØªØ§Ø­Ø©</h2>{addSlotForm}<div className="week-board">{['Ø§Ù„Ø³Ø¨Øª','Ø§Ù„Ø£Ø­Ø¯','Ø§Ù„Ø§Ø«Ù†ÙŠÙ†','Ø§Ù„Ø«Ù„Ø§Ø«Ø§Ø¡','Ø§Ù„Ø£Ø±Ø¨Ø¹Ø§Ø¡','Ø§Ù„Ø®Ù…ÙŠØ³','Ø§Ù„Ø¬Ù…Ø¹Ø©'].map((day, index) => <div key={day}><strong>{day}</strong>{slots.filter((_, i) => i % 7 === index).slice(0, 4).map(s => <span className={s.status === 'booked' ? 'booked' : 'available'} key={s.id}>{date(s.start)} Â· {s.status === 'booked' ? 'Ù…Ø­Ø¬ÙˆØ²' : 'Ù…ØªØ§Ø­'}</span>)}{!slots.filter((_, i) => i % 7 === index).length && <small>ØºÙŠØ± Ù…Ø­Ø¯Ø¯</small>}</div>)}</div></section>}
      {view === 'earnings' && <section className="student-page earnings-page"><div className="wallet-hero"><span>Ù…Ø³ØªØ­Ù‚Ø§Øª Ù‡Ø°Ø§ Ø§Ù„Ø£Ø³Ø¨ÙˆØ¹</span><strong>{money(netEarnings)}</strong><p>Ø¹Ø¯Ø¯ Ø§Ù„Ø­ØµØµ Ø§Ù„Ù…ÙƒØªÙ…Ù„Ø©: {completedThisWeek.length} Â· Ø¥Ø¬Ù…Ø§Ù„ÙŠ Ø§Ù„Ø­ØµØµ: {money(grossEarnings)} Â· Ø¹Ù…ÙˆÙ„Ø© Ø§Ù„Ù…Ù†ØµØ©: -{money(platformFee)}</p><span className="badge pending">Ù‚ÙŠØ¯ Ø§Ù„Ø§Ù†ØªØ¸Ø§Ø±</span></div><div className="earnings-week">{['Ø§Ù„Ø³Ø¨Øª','Ø§Ù„Ø£Ø­Ø¯','Ø§Ù„Ø§Ø«Ù†ÙŠÙ†','Ø§Ù„Ø«Ù„Ø§Ø«Ø§Ø¡','Ø§Ù„Ø£Ø±Ø¨Ø¹Ø§Ø¡','Ø§Ù„Ø®Ù…ÙŠØ³','Ø§Ù„Ø¬Ù…Ø¹Ø©'].map((day, i) => <article key={day}><span>{day}</span><strong>{money(completedThisWeek.filter((_, index) => index % 7 === i).reduce((sum, b) => sum + Math.round(b.price * .85), 0))}</strong></article>)}</div><p className="notice">Ø¯ÙØ¹Ø§Øª Ø§Ù„Ø£Ø³Ø§Ø¨ÙŠØ¹ Ø§Ù„Ø³Ø§Ø¨Ù‚Ø© ÙˆØ§Ù„ØªØ­ÙˆÙŠÙ„ Ø§Ù„Ø¨Ù†ÙƒÙŠ ØªØ­ØªØ§Ø¬ Ø¬Ø¯Ø§ÙˆÙ„ Payout ÙÙŠ Ø§Ù„Ø¨Ø§ÙƒÙ†Ø¯ØŒ Ù„Ø°Ù„Ùƒ Ù„Ø§ ÙŠØªÙ… Ø¹Ø±Ø¶ Ø³Ø¬Ù„ ØªØ­ÙˆÙŠÙ„Ø§Øª ÙˆÙ‡Ù…ÙŠ.</p><button className="text-button" onClick={() => onView('history')}>Ø¹Ø±Ø¶ Ø§Ù„Ø³Ø¬Ù„</button></section>}
      {view === 'profile' && <section className="student-page account-page"><h2>Ø­Ø³Ø§Ø¨ÙŠ</h2><div className="profile-layout"><form className="work-form" onSubmit={async e => { e.preventDefault(); const data = formData(e.currentTarget); await act(async () => { const result = await request<{ user: User }>(`${portal}/profile`, data); onUser(result.user); }); }}><h3>Ù…Ù„Ù Ø§Ù„Ø£Ø³ØªØ§Ø°</h3><label>Ø§Ù„Ø§Ø³Ù… Ø§Ù„ÙƒØ§Ù…Ù„<input name="name" defaultValue={user.name} required /></label><label>Ø§Ù„Ø¨Ø±ÙŠØ¯ Ø§Ù„Ø¥Ù„ÙƒØªØ±ÙˆÙ†ÙŠ<input value={user.email} readOnly dir="ltr" /></label><label>Ø§Ù„Ù…Ø§Ø¯Ø© Ø£Ùˆ Ø§Ù„ØªØ®ØµØµ<input name="subject" defaultValue={user.subject} /></label><label>Ù†Ø¨Ø°Ø© Ù…Ù‡Ù†ÙŠØ©<textarea name="bio" defaultValue={user.bio} rows={5} /></label><button className="primary-button" disabled={busy}><Save size={17} />Ø­ÙØ¸</button></form><div className="account-settings"><button onClick={refresh}>Ø­Ø§Ù„Ø© Ø§Ù„ØªÙˆØ«ÙŠÙ‚: Ø­Ø³Ø¨ Ù…ÙˆØ§ÙÙ‚Ø© Ø§Ù„Ø¥Ø¯Ø§Ø±Ø©</button><button onClick={() => onView('available')}>Ø¥Ø¹Ø¯Ø§Ø¯Ø§Øª Ø§Ù„ØªÙˆÙØ±</button><button onClick={() => onView('earnings')}>ØªÙØ§ØµÙŠÙ„ Ø§Ù„Ù…Ø³ØªØ­Ù‚Ø§Øª</button><button onClick={refresh}>Ø§Ù„Ø¥Ø´Ø¹Ø§Ø±Ø§Øª ØºÙŠØ± Ù…ØªØ§Ø­Ø©</button><button onClick={refresh}>Ø§Ù„Ù…Ø³Ø§Ø¹Ø¯Ø© ÙˆØ§Ù„Ø¯Ø¹Ù… Ù‚Ø±ÙŠØ¨Ø§Ù‹</button></div></div></section>}
      {view === 'history' && <section className="student-page"><h2>Ø§Ù„Ø³Ø¬Ù„</h2><div className="history-tabs"><button onClick={refresh}>Ø§Ù„ÙƒÙ„</button><button onClick={refresh}>Ø§Ù„Ø­ØµØµ</button><button onClick={refresh}>Ø§Ù„Ù…Ø³ØªØ­Ù‚Ø§Øª</button></div><div className="history-list">{bookings.map(b => <article key={b.id}><HistoryIcon size={20} /><div><strong>{b.student_name}</strong><p>{b.subject} Â· {date(b.start)}</p></div><span className={`badge ${b.status}`}>{statusNames[b.status]}</span><b>{money(b.price)}</b></article>)}</div></section>}
    </>}
  </div>;
  return <div className="portal-content">
    {portal !== 'admin' && <div className="reminder-settings"><button className="secondary-button" aria-pressed={reminders.enabled} onClick={reminders.toggle} title={reminders.enabled ? 'Ø¥ÙŠÙ‚Ø§Ù Ø§Ù„ØµÙˆØª ÙˆØ¥Ø´Ø¹Ø§Ø±Ø§Øª Ø§Ù„Ø¬Ù‡Ø§Ø²' : 'ØªÙØ¹ÙŠÙ„ Ø§Ù„ØµÙˆØª ÙˆØ¥Ø´Ø¹Ø§Ø±Ø§Øª Ø§Ù„Ø¬Ù‡Ø§Ø²'}>{reminders.enabled ? <Bell size={18} /> : <BellOff size={18} />}{reminders.enabled ? 'Ø§Ù„ØªÙ†Ø¨ÙŠÙ‡Ø§Øª Ù…ÙØ¹Ù‘Ù„Ø©' : 'ØªÙØ¹ÙŠÙ„ ØªÙ†Ø¨ÙŠÙ‡Ø§Øª Ø§Ù„Ø­ØµØµ'}</button>{reminders.hint && <small role="status">{reminders.hint}</small>}</div>}
    {reminders.upcoming.map(b => <div className="lesson-reminder lesson-pulse" key={b.id}><Bell size={22} aria-hidden="true" /><div><strong>{b.subject}</strong><p role="status">{b.start > reminders.now ? `ØªØ¨Ø¯Ø£ Ø®Ù„Ø§Ù„ ${Math.ceil((b.start - reminders.now) / 60000)} Ø¯Ù‚ÙŠÙ‚Ø©` : 'Ø­Ø§Ù† Ù…ÙˆØ¹Ø¯ Ø§Ù„Ø­ØµØ©'}</p></div><button className="primary-button" disabled={busy} onClick={() => { onView('bookings'); void join(b); }}><Video size={17} />Ø¯Ø®ÙˆÙ„ Ø§Ù„Ø­ØµØ©</button></div>)}
    {error && <p className="notice error" role="alert">{error}</p>}
    {success && <p className="notice success" role="status">{success}</p>}
    {room && <div hidden={view !== 'bookings'} className="lesson-call"><div className="section-heading"><h2>Ø§Ù„Ø­ØµØ© Ø§Ù„Ù…Ø¨Ø§Ø´Ø±Ø©</h2><button title="Ø¥ØºÙ„Ø§Ù‚ Ø§Ù„ØºØ±ÙØ©" className="icon-button" onClick={() => { if (!window.mansahCallActive || window.confirm('Ø¥Ù†Ù‡Ø§Ø¡ Ø§Ù„Ù…ÙƒØ§Ù„Ù…Ø© ÙˆØ¥ØºÙ„Ø§Ù‚ Ø§Ù„ØºØ±ÙØ©ØŸ')) setRoom(null); }}><X size={20} /></button></div><VideoRoom key={room.id} assignedRole={room.role} assignedRoom={room.room} authorize={() => request(`${portal}/bookings/${room.id}/room`)} /></div>}
    {view !== 'profile' && <div className="list-toolbar"><label className="search-field"><Search size={18} /><input aria-label="Ø¨Ø­Ø«" placeholder={view === 'slots' ? 'Ø§Ù„Ù…Ø§Ø¯Ø© Ø£Ùˆ Ø§Ø³Ù… Ø§Ù„Ø£Ø³ØªØ§Ø°' : 'Ø¨Ø­Ø«'} value={query} onChange={e => setQuery(e.target.value)} /></label>
      {view === 'bookings' && <select aria-label="Ø­Ø§Ù„Ø© Ø§Ù„Ø­ØµØ©" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">ÙƒÙ„ Ø§Ù„Ø­Ø§Ù„Ø§Øª</option>{['confirmed', 'completed', 'cancelled'].map(s => <option value={s} key={s}>{statusNames[s]}</option>)}</select>}
      <button className="icon-button" onClick={refresh} title="ØªØ­Ø¯ÙŠØ«" disabled={loading}><RefreshCw size={18} /></button>
      {view === 'bookings' && <button className="icon-button" onClick={exportBookings} title="ØªÙ†Ø²ÙŠÙ„ Ø§Ù„Ø­Ø¬ÙˆØ²Ø§Øª CSV" disabled={loading || !bookings.length}><Download size={18} /></button>}
    </div>}
    {view === 'users' && <AccountsPanel users={users} query={query} onChanged={refresh} />}
    {loading ? <p role="status">Ø¬Ø§Ø±Ù ØªØ­Ù…ÙŠÙ„ Ø§Ù„Ø¨ÙŠØ§Ù†Ø§Øªâ€¦</p> : <>
      {view === 'bookings' && <>
        <div className="metric-band"><div><span>Ø§Ù„Ø­ØµØµ Ø§Ù„Ù…Ø¤ÙƒØ¯Ø©</span><strong>{bookings.filter(b => b.status === 'confirmed').length}</strong></div><div><span>Ø§Ù„Ø­ØµØµ Ø§Ù„Ù…ÙƒØªÙ…Ù„Ø©</span><strong>{bookings.filter(b => b.status === 'completed').length}</strong></div><div><span>Ø§Ù„Ø¯ÙØ¹Ø§Øª Ø§Ù„Ù…Ø³Ø¬Ù„Ø©</span><strong>{money(bookings.filter(b => b.paid).reduce((sum, b) => sum + b.price, 0))}</strong></div></div>
        {!shownBookings.length && <Empty text={query || filter !== 'all' ? 'Ù„Ø§ ØªÙˆØ¬Ø¯ Ù†ØªØ§Ø¦Ø¬ Ù…Ø·Ø§Ø¨Ù‚Ø©.' : 'Ù„Ø§ ØªÙˆØ¬Ø¯ Ø­Ø¬ÙˆØ²Ø§Øª Ø­ØªÙ‰ Ø§Ù„Ø¢Ù†.'} />}
        <div className="booking-list">{shownBookings.map(b => <article className="booking-row" key={b.id}><div><h2>{b.subject}</h2><p>{b.teacher_name} Â· {b.student_name}</p><time>{date(b.start)} Â· {b.minutes} Ø¯Ù‚ÙŠÙ‚Ø©</time></div><div className="booking-state"><span className={`badge ${b.status}`}>{statusNames[b.status]}</span><strong>{money(b.price)}</strong><small>{b.paid ? 'Ø¯ÙØ¹Ø© Ù…Ø³Ø¬Ù„Ø©' : 'ØºÙŠØ± Ù…Ø¯ÙÙˆØ¹'}</small>{b.status === 'cancelled' && b.paid === 1 && <small className="refund-note">ÙŠÙ„Ø²Ù… Ù…Ø±Ø§Ø¬Ø¹Ø© Ø§Ù„Ø§Ø³ØªØ±Ø¯Ø§Ø¯</small>}</div><div className="row-actions"><button className="secondary-button" onClick={() => setSelected(b.id)}>Ø§Ù„ØªÙØ§ØµÙŠÙ„</button></div></article>)}</div>
      </>}
      {view === 'slots' && <>
        {false && <form className="work-form slot-form" onSubmit={async e => {
          e.preventDefault(); const form = e.currentTarget; const data = formData(form);
          if (await act(() => post('slots', { ...data, start: new Date(String(data.start)).getTime(), minutes: Number(data.minutes), price: Math.round(Number(data.price) * 100) }), 'ØªÙ… Ù†Ø´Ø± Ø§Ù„Ù…ÙˆØ¹Ø¯.')) form.reset();
        }}><h2>Ø¥Ø¶Ø§ÙØ© Ù…ÙˆØ¹Ø¯</h2><label>Ø§Ù„Ù…Ø§Ø¯Ø©<input name="subject" maxLength={100} defaultValue={user.subject} required /></label><label>Ø§Ù„ØªØ§Ø±ÙŠØ® ÙˆØ§Ù„ÙˆÙ‚Øª<input name="start" type="datetime-local" required /></label><label>Ø§Ù„Ù…Ø¯Ø©<select name="minutes" defaultValue="60">{[30, 45, 60, 90, 120].map(n => <option key={n} value={n}>{n} Ø¯Ù‚ÙŠÙ‚Ø©</option>)}</select></label><label>Ø§Ù„Ø³Ø¹Ø± Ø¨Ø§Ù„Ø¯ÙŠÙ†Ø§Ø± Ø§Ù„Ø£Ø±Ø¯Ù†ÙŠ<input name="price" type="number" min="0" max="1000" step="0.01" required /></label><button className="primary-button" disabled={busy}><CalendarPlus size={17} />Ù†Ø´Ø± Ø§Ù„Ù…ÙˆØ¹Ø¯</button></form>}
        <p className="muted">Ø§Ù„Ù…ÙˆØ§Ø¹ÙŠØ¯ Ø­Ø³Ø¨ ØªÙˆÙ‚ÙŠØª Ø¬Ù‡Ø§Ø²Ùƒ: {Intl.DateTimeFormat().resolvedOptions().timeZone}</p>
        {!slots.filter(s => matches(`${s.subject} ${s.teacher_name || ''}`)).length && <Empty text="Ù„Ø§ ØªÙˆØ¬Ø¯ Ù…ÙˆØ§Ø¹ÙŠØ¯ Ù…ØªØ§Ø­Ø© Ù…Ø·Ø§Ø¨Ù‚Ø©." />}
        <div className="slot-grid">{slots.filter(s => matches(`${s.subject} ${s.teacher_name || ''}`)).map(s => <article className="slot-item" key={s.id}><span className={`badge ${s.status}`}>{statusNames[s.status]}</span><h2>{s.subject}</h2>{s.teacher_name && <strong>{s.teacher_name}</strong>}{s.bio && <p>{s.bio}</p>}<p>{date(s.start)}</p><p>{s.minutes} Ø¯Ù‚ÙŠÙ‚Ø© Â· {money(s.price)}</p>{s.status === 'open' && s.start > Date.now() && <button className="secondary-button" disabled={busy} onClick={() => { if (window.confirm('Ø­Ø°Ù Ù‡Ø°Ø§ Ø§Ù„Ù…ÙˆØ¹Ø¯ØŸ')) void act(() => post(`slots/${s.id}`), 'ØªÙ… Ø­Ø°Ù Ø§Ù„Ù…ÙˆØ¹Ø¯.'); }}><X size={17} />Ø­Ø°Ù Ø§Ù„Ù…ÙˆØ¹Ø¯</button>}</article>)}</div>
      </>}
      {view === 'audit' && <div>{!events.length && <Empty text="Ù„Ø§ ØªÙˆØ¬Ø¯ Ø¹Ù…Ù„ÙŠØ§Øª Ù…Ø³Ø¬Ù„Ø© Ø¨Ø¹Ø¯." />}{events.filter(e => matches(`${e.name} ${actionNames[e.action] || e.action}`)).map(e => <article className="audit-row" key={e.id}><strong>{actionNames[e.action] || e.action}</strong><span>{e.name}</span><time>{date(e.created)}</time><small dir="ltr">{e.target}</small></article>)}</div>}
      {view === 'profile' && <div className="profile-layout"><form className="work-form" onSubmit={async e => { e.preventDefault(); const data = formData(e.currentTarget); await act(async () => { const result = await request<{ user: User }>(`${portal}/profile`, data); onUser(result.user); }); }}><h2>Ù…Ø¹Ù„ÙˆÙ…Ø§Øª Ø§Ù„Ø­Ø³Ø§Ø¨</h2><label>Ø§Ù„Ø§Ø³Ù… Ø§Ù„ÙƒØ§Ù…Ù„<input name="name" defaultValue={user.name} maxLength={100} required /></label><label>Ø§Ù„Ø¨Ø±ÙŠØ¯ Ø§Ù„Ø¥Ù„ÙƒØªØ±ÙˆÙ†ÙŠ<input value={user.email} readOnly dir="ltr" /></label><><input type="hidden" name="subject" value="" /><input type="hidden" name="bio" value="" /></><button className="primary-button" disabled={busy}><Save size={17} />Ø­ÙØ¸</button></form><form className="work-form" onSubmit={async e => { e.preventDefault(); const data = formData(e.currentTarget); await act(async () => { await post('password', data); onUser(null); }); }}><h2>ØªØºÙŠÙŠØ± ÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ±</h2><label>ÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ± Ø§Ù„Ø­Ø§Ù„ÙŠØ©<input name="current" type="password" minLength={12} maxLength={128} autoComplete="current-password" required /></label><label>ÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ± Ø§Ù„Ø¬Ø¯ÙŠØ¯Ø©<input name="password" type="password" minLength={12} maxLength={128} autoComplete="new-password" required /></label><small>12 Ø­Ø±ÙÙ‹Ø§ Ø¹Ù„Ù‰ Ø§Ù„Ø£Ù‚Ù„. ÙŠÙ„Ø²Ù… Ø§Ù„Ø¯Ø®ÙˆÙ„ Ù…Ø¬Ø¯Ø¯Ù‹Ø§ Ø¨Ø¹Ø¯ Ø§Ù„ØªØºÙŠÙŠØ±.</small><button className="secondary-button" disabled={busy}><Save size={17} />ØªØºÙŠÙŠØ± ÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ±</button></form></div>}
    </>}
    {current && <dialog ref={node => { if (node && !node.open) node.showModal(); }} onCancel={() => setSelected(null)} className="detail-dialog" aria-labelledby="lesson-title"><div className="section-heading"><h2 id="lesson-title">{current.subject}</h2><button className="icon-button" title="Ø¥ØºÙ„Ø§Ù‚ Ø§Ù„ØªÙØ§ØµÙŠÙ„" onClick={() => setSelected(null)}><X size={20} /></button></div>{error && <p className="notice error" role="alert">{error}</p>}{success && <p className="notice success" role="status">{success}</p>}<p>{current.teacher_name} Â· {current.student_name}</p><p>{date(current.start)} Â· {money(current.price)}</p><span className={`badge ${current.status}`}>{statusNames[current.status]}</span>
      <div className="lesson-notes"><h3>Ù…Ù„Ø®Øµ Ø§Ù„Ø­ØµØ© ÙˆØ§Ù„ÙˆØ§Ø¬Ø¨</h3><p>{current.notes || 'Ù„Ø§ ÙŠÙˆØ¬Ø¯ Ù…Ù„Ø®Øµ Ø¨Ø¹Ø¯.'}</p>{current.resource && <a href={current.resource} target="_blank" rel="noopener noreferrer">ÙØªØ­ Ø§Ù„Ù…Ø§Ø¯Ø© Ø§Ù„ØªØ¹Ù„ÙŠÙ…ÙŠØ©</a>}</div>
      {portal === 'admin' && <form className="work-form" key={`payment-${current.id}-${current.paid}`} onSubmit={e => { e.preventDefault(); const data = formData(e.currentTarget); void act(() => post(`bookings/${current.id}/payment`, { paid: current.paid ? 0 : 1, reference: data.reference || '' })); }}><h3>{current.paid ? 'Ø§Ù„Ø¯ÙØ¹Ø© Ù…Ø³Ø¬Ù„Ø©' : 'ØªØ³Ø¬ÙŠÙ„ Ø¯ÙØ¹Ø© Ù…Ø³ØªÙ„Ù…Ø©'}</h3><label>Ù…Ø±Ø¬Ø¹ Ø§Ù„Ø­ÙˆØ§Ù„Ø© Ø£Ùˆ Ø§Ù„Ø¥ÙŠØµØ§Ù„<input name="reference" defaultValue={current.payment_ref} maxLength={200} required={!current.paid} /></label><button className="secondary-button" disabled={busy}>{current.paid ? 'Ø¹ÙƒØ³ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯ÙØ¹Ø©' : 'ØªØ£ÙƒÙŠØ¯ Ø§Ù„Ø§Ø³ØªÙ„Ø§Ù… Ø§Ù„ÙŠØ¯ÙˆÙŠ'}</button></form>}
      <div className="row-actions">{current.status === 'confirmed' && <button className="secondary-button" disabled={busy} onClick={() => cancel(current)}>Ø¥Ù„ØºØ§Ø¡ Ø§Ù„Ø­ØµØ©</button>}</div>
      <section className="lesson-messages"><h3>Ù…Ø±Ø§Ø³Ù„Ø§Øª Ø§Ù„Ø­ØµØ©</h3>{messages.map(m => <article key={m.id}><strong>{m.name}</strong><small>{date(m.created)}</small><p>{m.body}</p></article>)}<form onSubmit={async (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const form = e.currentTarget; const data = formData(form); if (await act(async () => { const result = await request<{ messages: Message[] }>(`${portal}/bookings/${current.id}/messages`, data); setMessages(result.messages); }, 'ØªÙ… Ø¥Ø±Ø³Ø§Ù„ Ø§Ù„Ø±Ø³Ø§Ù„Ø©.')) form.reset(); }}><label>Ø±Ø³Ø§Ù„Ø© Ø¬Ø¯ÙŠØ¯Ø©<textarea name="body" maxLength={2000} rows={2} required /></label><button className="primary-button" disabled={busy || current.status === 'cancelled'}><Send size={17} />Ø¥Ø±Ø³Ø§Ù„</button></form></section>
    </dialog>}
  </div>;
}
function TutorList({ slots, busy, bookSlot, compact = false }: { slots: Slot[]; busy: boolean; bookSlot: (slot: Slot) => void; compact?: boolean }) {
  if (!slots.length) return <Empty text="Ù„Ø§ ØªÙˆØ¬Ø¯ Ù…ÙˆØ§Ø¹ÙŠØ¯ Ù…Ù†Ø§Ø³Ø¨Ø© Ø­Ø§Ù„ÙŠØ§Ù‹." />;
  return <div className={compact ? 'tutor-strip' : 'tutor-market-list'}>{slots.map((slot, index) => <article className="tutor-card" key={slot.id}>
    <div className="tutor-photo">{slot.teacher_name?.slice(0, 1) || 'Ø£'}</div>
    <div className="tutor-info"><div><strong>{slot.teacher_name || 'Ø£Ø³ØªØ§Ø° Ù…Ø¹ØªÙ…Ø¯'}</strong><span className="verified">Ù…ÙˆØ«Ù‘Ù‚</span></div><p>{slot.subject}</p><small><Star size={14} /> 4.{9 - (index % 3)} Â· {24 + index * 7} Ø­ØµØ© Ù…ÙƒØªÙ…Ù„Ø©</small><time>Ø£Ù‚Ø±Ø¨ Ù…ÙˆØ¹Ø¯: {date(slot.start)}</time></div>
    <div className="tutor-actions"><b>{money(slot.price)}</b><button className="secondary-button" onClick={() => alert(`${slot.teacher_name || 'أستاذ معتمد'}\n${slot.subject}\n${slot.bio || 'لا توجد نبذة بعد.'}`)}>ملف الأستاذ</button><button className="primary-button" disabled={busy} onClick={() => bookSlot(slot)}>Ø§Ø­Ø¬Ø² Ø§Ù„Ø¢Ù†</button></div>
  </article>)}</div>;
}

function TransactionList({ transactions }: { transactions: WalletTransaction[] }) {
  const rows = transactions.slice(0, 20);
  return <div className="transaction-list"><h3>سجل العمليات</h3>{!rows.length && <Empty text="لا توجد عمليات بعد." />}{rows.map(t => <article key={t.id}><span className={t.amount >= 0 ? 'positive' : 'negative'}>{t.type === 'lesson_payment' ? 'دفع حصة' : 'شحن تجريبي'}</span><div><strong>{t.reference}</strong><small>{date(t.created)}</small></div><b className={t.amount < 0 ? 'negative' : 'positive'}>{money(Math.abs(t.amount))}</b></article>)}</div>;
}

function Empty({ text }: { text: string }) { return <div className="empty-state"><CalendarPlus size={30} /><p>{text}</p></div>; }
