import { useMemo, useRef, useState } from 'react';
import { ArrowLeft, CalendarCheck, CalendarDays, CalendarPlus, Check, ChevronDown, ChevronLeft, ChevronRight, Clock3, Trash2 } from 'lucide-react';
import { catalogText, locale, t, usePreferences } from '../../i18n/preferences';
import { money, type Booking, type Slot } from '../../services/platformApi';

export type AvailabilityDraft = { subject: string; start: number; availableUntil: number; minutes: number; price: number };
type Schedule = { from: string; to: string };
type Props = { subjects: string[]; slots: Slot[]; bookings: Booking[]; busy: boolean; onHome: () => void; onPublish: (drafts: AvailabilityDraft[]) => Promise<boolean>; onDelete: (id: string) => void; onBookingDetails: (id: string) => void };

const dayStart = (value = new Date()) => { const day = new Date(value); day.setHours(0, 0, 0, 0); return day.getTime(); };
const sameDay = (left: number, right: number) => new Date(left).toDateString() === new Date(right).toDateString();
const timeValue = (value: Date) => `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
const initialSchedule = (): Schedule => { const from = new Date(); from.setSeconds(0, 0); from.setMinutes(from.getMinutes() + 2); return { from: timeValue(from), to: timeValue(new Date(from.getTime() + 60 * 60000)) }; };
const atTime = (day: number, value: string) => { const [hours, minutes] = value.split(':').map(Number); const result = new Date(day); result.setHours(hours || 0, minutes || 0, 0, 0); return result.getTime(); };
const monthStart = (value: number | Date) => { const result = new Date(value); result.setDate(1); result.setHours(0, 0, 0, 0); return result.getTime(); };
const dateLabel = (value: number) => new Date(value).toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' });

export function TeacherAvailabilityHub({ subjects, slots, bookings, busy, onHome, onPublish, onDelete, onBookingDetails }: Props) {
  usePreferences();
  const today = dayStart();
  const [tab, setTab] = useState<'publish' | 'calendar'>('publish');
  const [selectedSubjects, setSelectedSubjects] = useState<string[]>([]);
  const [subjectMenuOpen, setSubjectMenuOpen] = useState(false);
  const [selectedDay, setSelectedDay] = useState<number | null>(today);
  const [schedule, setSchedule] = useState<Schedule>(initialSchedule);
  const [month, setMonth] = useState(monthStart(Date.now()));
  const [calendarDay, setCalendarDay] = useState(today);
  const [duration, setDuration] = useState(60);
  const [price, setPrice] = useState('10');
  const [localError, setLocalError] = useState('');
  const [launching, setLaunching] = useState(false);
  const dayStripRef = useRef<HTMLDivElement>(null);

  const monthDays = useMemo(() => { const first = new Date(month); const count = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate(); const lead = (first.getDay() + 6) % 7; return [...Array.from({ length: lead }, () => null), ...Array.from({ length: count }, (_, index) => new Date(first.getFullYear(), first.getMonth(), index + 1).getTime())]; }, [month]);
  const publishDays = useMemo(() => Array.from({ length: 28 }, (_, index) => { const day = new Date(today); day.setDate(day.getDate() + index); return day.getTime(); }), [today]);
  const activeSlots = slots.filter(slot => slot.status !== 'cancelled');
  const activeBookings = bookings.filter(booking => booking.status === 'confirmed' || booking.status === 'completed');
  const daySlots = activeSlots.filter(slot => sameDay(slot.start, calendarDay));
  const dayBookings = activeBookings.filter(booking => sameDay(booking.start, calendarDay));
  const freeWindows = useMemo(() => {
    const opening = atTime(calendarDay, '08:00'), closing = atTime(calendarDay, '22:00');
    const busyRanges = [...daySlots.map(slot => [slot.start, slot.available_until || slot.start + slot.minutes * 60000] as const), ...dayBookings.map(booking => [booking.start, booking.start + booking.minutes * 60000] as const)].sort((left, right) => left[0] - right[0]);
    const windows: Array<[number, number]> = []; let cursor = sameDay(calendarDay, Date.now()) ? Math.max(opening, Date.now()) : opening;
    busyRanges.forEach(([start, end]) => { if (end <= cursor || start >= closing) return; if (start - cursor >= 30 * 60000) windows.push([cursor, Math.min(start, closing)]); cursor = Math.max(cursor, end); });
    if (closing - cursor >= 30 * 60000) windows.push([cursor, closing]); return windows;
  }, [calendarDay, daySlots, dayBookings]);

  const allSubjectsSelected = subjects.length > 0 && selectedSubjects.length === subjects.length;
  const subjectSummary = !selectedSubjects.length ? t('اختر مادة أو أكثر') : allSubjectsSelected ? t('كل المواد') : selectedSubjects.length === 1 ? catalogText(selectedSubjects[0]) : t('{v0} مواد مختارة', { v0: selectedSubjects.length });
  const toggleSubject = (value: string) => { setSelectedSubjects(current => current.includes(value) ? current.filter(item => item !== value) : [...current, value]); setLocalError(''); };
  const chooseDay = (value: number) => { setSelectedDay(value); setLocalError(''); };
  const publish = async () => {
    if (!selectedSubjects.length) { setSubjectMenuOpen(true); setLocalError(t('اختر مادة واحدة على الأقل أولاً.')); return; }
    if (selectedDay === null) { setLocalError(t('اختر يوماً واحداً على الأقل.')); return; }
    const amount = Number(price); if (!Number.isFinite(amount) || amount < 0 || amount > 1000) { setLocalError(t('أدخل سعراً صحيحاً.')); return; }
    const start = atTime(selectedDay, schedule.from), availableUntil = atTime(selectedDay, schedule.to);
    if (start <= Date.now()) { setLocalError(t('كل المواعيد يجب أن تبدأ بعد الوقت الحالي.')); return; }
    if (availableUntil - start < duration * 60000) { setLocalError(t('الفترة المتاحة يجب أن تكون أطول من مدة الحصة أو تساويها.')); return; }
    if (activeSlots.some(slot => start < (slot.available_until || slot.start + slot.minutes * 60000) && availableUntil > slot.start)) { setLocalError(t('الموعد يتعارض مع موعد آخر.')); return; }
    const subject = allSubjectsSelected ? 'كل المواد المختارة' : selectedSubjects.join('، '); setLocalError('');
    if (!await onPublish([{ subject, start, availableUntil, minutes: duration, price: Math.round(amount * 100) }])) return;
    setLaunching(true); window.setTimeout(() => { setCalendarDay(selectedDay); setMonth(monthStart(selectedDay)); setSelectedDay(today); setTab('calendar'); setLaunching(false); }, 850);
  };
  const moveMonth = (direction: number) => { const next = new Date(month); next.setMonth(next.getMonth() + direction); setMonth(monthStart(next)); };
  const addFromCalendar = (value: number) => { setSelectedDay(Math.max(value, today)); setTab('publish'); setLocalError(''); };

  return <section className="availability-hub" aria-label={t('مركز المواعيد')}>
    <div className={`availability-showcase ${launching ? 'is-launching' : ''}`}>
      <div className="availability-orbit orbit-one" aria-hidden="true" /><div className="availability-orbit orbit-two" aria-hidden="true" />
      <header className="availability-showcase-head"><div className="availability-tabs" role="tablist" aria-label={t('أقسام المواعيد')}><button type="button" role="tab" aria-selected={tab === 'publish'} className={tab === 'publish' ? 'active' : ''} onClick={() => setTab('publish')}><CalendarPlus size={18} />{t('نشر مواعيد')}</button><button type="button" role="tab" aria-selected={tab === 'calendar'} className={`${tab === 'calendar' ? 'active' : ''} ${launching ? 'electric-target' : ''}`} onClick={() => setTab('calendar')}><CalendarCheck size={18} />{t('جدولي والمحجوز')}</button></div></header>
      {launching && <div className="availability-electric-path" aria-hidden="true"><i /><i /><i /></div>}
      {tab === 'publish' && !subjects.length && <div className="availability-lock"><span><CalendarDays size={34} /></span><h3>{t('لتتمكن من إضافة مواعيدك، اختر مادتك أولاً من الصفحة الرئيسية.')}</h3><p>{t('بعد حفظ المادة ستظهر هنا تلقائياً وتقدر تبني جدولك خلال خطوات بسيطة.')}</p><button className="availability-light-button" type="button" onClick={onHome}>{t('الذهاب للرئيسية')}<ArrowLeft size={17} /></button></div>}
      {tab === 'publish' && subjects.length > 0 && <div className="availability-simple-publisher">
        <div className={`availability-subject-picker ${subjectMenuOpen ? 'open' : ''}`}><button className="availability-subject-trigger" type="button" aria-expanded={subjectMenuOpen} onClick={() => setSubjectMenuOpen(value => !value)}><span><small>{t('المواد')}</small><strong>{subjectSummary}</strong></span><ChevronDown size={20} /></button>{subjectMenuOpen && <div className="availability-subject-menu"><label className="all-subjects"><input type="checkbox" checked={allSubjectsSelected} onChange={event => { setSelectedSubjects(event.currentTarget.checked ? [...subjects] : []); setLocalError(''); }} /><span><Check size={14} /></span><strong>{t('كل المواد')}</strong><small>{t('أي طالب، بأي مادة من موادك')}</small></label>{subjects.map(item => <label key={item}><input type="checkbox" checked={selectedSubjects.includes(item)} onChange={() => toggleSubject(item)} /><span><Check size={14} /></span><strong>{catalogText(item)}</strong></label>)}<button type="button" onClick={() => setSubjectMenuOpen(false)}>{t('تم')}</button></div>}</div>
        <div className="availability-date-picker"><div className="availability-date-head"><strong>{new Date(selectedDay ?? today).toLocaleDateString(locale(), { month: 'long', year: 'numeric' })}</strong><div><button type="button" title={t('تمرير الأيام للخلف')} onClick={() => dayStripRef.current?.scrollBy({ left: -260, behavior: 'smooth' })}><ChevronRight size={17} /></button><button type="button" title={t('تمرير الأيام للأمام')} onClick={() => dayStripRef.current?.scrollBy({ left: 260, behavior: 'smooth' })}><ChevronLeft size={17} /></button></div></div><div className="availability-day-strip" ref={dayStripRef}>{publishDays.map(value => <button type="button" key={value} aria-pressed={selectedDay === value} className={selectedDay === value ? 'selected' : ''} onClick={() => chooseDay(value)}><span>{new Date(value).toLocaleDateString(locale(), { weekday: 'short' })}</span><strong>{new Date(value).toLocaleDateString(locale(), { day: '2-digit' })}</strong><small>{new Date(value).toLocaleDateString(locale(), { month: 'short' })}</small></button>)}</div></div>
        {selectedDay !== null && <div className="availability-inline-settings"><div className="availability-selected-day"><CalendarDays size={18} /><strong>{dateLabel(selectedDay)}</strong></div><ScheduleRow label={t('الفترة المتاحة')} schedule={schedule} onChange={(key, value) => setSchedule(current => ({ ...current, [key]: value }))} /><div className="availability-publish-settings"><label>{t('مدة الحصة')}<select value={duration} onChange={event => setDuration(Number(event.target.value))}>{[30, 45, 60, 90, 120].map(value => <option key={value} value={value}>{value}{t(' دقيقة')}</option>)}</select></label><label>{t('السعر بالدينار')}<input type="number" min="0" max="1000" step="0.01" value={price} onChange={event => setPrice(event.target.value)} /></label></div><button className="availability-publish" type="button" disabled={busy} onClick={() => void publish()}><span><CalendarPlus size={19} />{busy ? t('جارٍ الحفظ…') : t('نشر المواعيد')}</span><i aria-hidden="true" /></button></div>}
        {localError && <p className="availability-local-error" role="alert">{localError}</p>}
      </div>}
      {tab === 'calendar' && <div className="availability-calendar-view"><div className="availability-stage-toolbar"><div><span>{t('الصورة الكاملة')}</span><h3>{t('تقويم مواعيدك وحجوزاتك')}</h3></div><div className="calendar-legend"><span className="open">{t('متاح')}</span><span className="booked">{t('محجوز')}</span></div></div><div className="availability-calendar-layout"><MonthCalendar month={month} days={monthDays} today={today} selected={[calendarDay]} slots={activeSlots} bookings={activeBookings} onMove={moveMonth} onDay={setCalendarDay} /><aside className="calendar-day-panel"><span>{t('تفاصيل اليوم')}</span><h3>{dateLabel(calendarDay)}</h3><div className="day-capacity"><div><strong>{dayBookings.length}</strong><small>{t('حصص محجوزة')}</small></div><div><strong>{daySlots.filter(slot => slot.status === 'open').length}</strong><small>{t('فترات متاحة')}</small></div></div><div className="day-free-windows"><strong>{t('الساعات الفارغة')}</strong><div>{freeWindows.length ? freeWindows.slice(0, 4).map(([from, to]) => <span key={`${from}-${to}`} dir="ltr">{timeValue(new Date(from))} – {timeValue(new Date(to))}</span>) : <small>{t('لا توجد فترة فارغة كافية بين 8 صباحاً و10 مساءً.')}</small>}</div></div>{!daySlots.length && !dayBookings.length && <div className="free-day"><Clock3 size={28} /><strong>{t('هذا اليوم فاضي')}</strong><p>{t('تقدر تضيف له وقت جديد بدون تعارض.')}</p></div>}<div className="calendar-day-events">{dayBookings.map(booking => <button type="button" className="day-event booked" key={`booking-${booking.id}`} onClick={() => onBookingDetails(booking.id)}><span>{timeValue(new Date(booking.start))}</span><div><strong>{catalogText(booking.subject)}</strong><small>{booking.student_name} · {booking.minutes}{t(' دقيقة')}</small></div><ChevronLeft size={16} /></button>)}{daySlots.filter(slot => slot.status === 'open').map(slot => <article className="day-event open" key={slot.id}><span>{timeValue(new Date(slot.start))}</span><div><strong>{catalogText(slot.subject)}</strong><small>{timeValue(new Date(slot.start))} – {timeValue(new Date(slot.available_until || slot.start + slot.minutes * 60000))} · {money(slot.price)}</small></div><button type="button" title={t('حذف الموعد')} onClick={() => onDelete(slot.id)}><Trash2 size={15} /></button></article>)}</div><button className="availability-light-button" type="button" disabled={calendarDay < today} onClick={() => addFromCalendar(calendarDay)}><CalendarPlus size={17} />{t('إضافة موعد لهذا اليوم')}</button></aside></div></div>}
    </div>
    <div className="availability-quick-stats"><div><span>{t('المواعيد القادمة')}</span><strong>{activeSlots.filter(slot => slot.start >= Date.now()).length}</strong></div><div><span>{t('الحصص المحجوزة')}</span><strong>{activeBookings.filter(booking => booking.status === 'confirmed' && booking.start + booking.minutes * 60000 >= Date.now()).length}</strong></div><div><span>{t('أيام عندك فيها نشاط')}</span><strong>{new Set([...activeSlots, ...activeBookings].map(item => dayStart(new Date(item.start)))).size}</strong></div></div>
  </section>;
}

function ScheduleRow({ label, schedule, onChange }: { label: string; schedule: Schedule; onChange: (key: keyof Schedule, value: string) => void }) {
  return <div className="schedule-row"><div><CalendarDays size={18} /><strong>{label}</strong></div><label>{t('من')}<input type="time" value={schedule.from} onChange={event => onChange('from', event.target.value)} /></label><span aria-hidden="true">→</span><label>{t('إلى')}<input type="time" value={schedule.to} onChange={event => onChange('to', event.target.value)} /></label></div>;
}

function MonthCalendar({ month, days, today, selected, slots, bookings, onMove, onDay }: { month: number; days: Array<number | null>; today: number; selected: number[]; slots: Slot[]; bookings: Booking[]; onMove: (direction: number) => void; onDay: (value: number) => void }) {
  const weekdays = Array.from({ length: 7 }, (_, index) => new Date(2026, 0, 5 + index).toLocaleDateString(locale(), { weekday: 'short' }));
  return <div className="month-calendar"><div className="month-calendar-head"><button type="button" onClick={() => onMove(-1)} title={t('الشهر السابق')}><ChevronRight size={18} /></button><strong>{new Date(month).toLocaleDateString(locale(), { month: 'long', year: 'numeric' })}</strong><button type="button" onClick={() => onMove(1)} title={t('الشهر التالي')}><ChevronLeft size={18} /></button></div><div className="month-weekdays">{weekdays.map(day => <span key={day}>{day}</span>)}</div><div className="month-grid">{days.map((value, index) => { if (value === null) return <i key={`blank-${index}`} />; const open = slots.filter(slot => slot.status === 'open' && sameDay(slot.start, value)).length; const booked = bookings.filter(booking => booking.status === 'confirmed' && sameDay(booking.start, value)).length; return <button type="button" key={value} aria-pressed={selected.includes(value)} aria-label={new Date(value).toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' })} className={`${selected.includes(value) ? 'selected' : ''} ${sameDay(value, today) ? 'today' : ''} ${open ? 'has-open' : ''} ${booked ? 'has-booked' : ''}`} onClick={() => onDay(value)}><span>{new Date(value).getDate()}</span>{(open > 0 || booked > 0) && <small>{open > 0 && <b className="open-dot">{open}</b>}{booked > 0 && <b className="booked-dot">{booked}</b>}</small>}</button>; })}</div></div>;
}
