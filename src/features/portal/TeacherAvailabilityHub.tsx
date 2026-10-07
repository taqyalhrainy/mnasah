import { useMemo, useState, type CSSProperties } from 'react';
import { ArrowLeft, ArrowRight, CalendarCheck, CalendarDays, CalendarPlus, Check, ChevronLeft, ChevronRight, Clock3, Sparkles, Trash2 } from 'lucide-react';
import { catalogText, locale, t, usePreferences } from '../../i18n/preferences';
import { date, money, statusNames, type Booking, type Slot } from '../../services/platformApi';

export type AvailabilityDraft = {
  subject: string;
  start: number;
  availableUntil: number;
  minutes: number;
  price: number;
};

type Schedule = { from: string; to: string };
type Props = {
  subjects: string[];
  slots: Slot[];
  bookings: Booking[];
  busy: boolean;
  onHome: () => void;
  onPublish: (drafts: AvailabilityDraft[]) => Promise<boolean>;
  onDelete: (id: string) => void;
  onBookingDetails: (id: string) => void;
};

const dayStart = (value = new Date()) => {
  const day = new Date(value);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
};
const sameDay = (left: number, right: number) => new Date(left).toDateString() === new Date(right).toDateString();
const timeValue = (value: Date) => `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
const initialSchedule = (): Schedule => {
  const from = new Date();
  from.setSeconds(0, 0);
  from.setMinutes(from.getMinutes() + 2);
  const to = new Date(from.getTime() + 60 * 60000);
  return { from: timeValue(from), to: timeValue(to) };
};
const atTime = (day: number, value: string) => {
  const [hours, minutes] = value.split(':').map(Number);
  const result = new Date(day);
  result.setHours(hours || 0, minutes || 0, 0, 0);
  return result.getTime();
};
const monthStart = (value: number | Date) => {
  const result = new Date(value);
  result.setDate(1);
  result.setHours(0, 0, 0, 0);
  return result.getTime();
};
const dateLabel = (value: number) => new Date(value).toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' });

export function TeacherAvailabilityHub({ subjects, slots, bookings, busy, onHome, onPublish, onDelete, onBookingDetails }: Props) {
  usePreferences();
  const today = dayStart();
  const [tab, setTab] = useState<'publish' | 'calendar'>('publish');
  const [step, setStep] = useState<'subject' | 'dates' | 'schedule'>('subject');
  const [subject, setSubject] = useState('');
  const [selectedDates, setSelectedDates] = useState<number[]>([]);
  const [month, setMonth] = useState(monthStart(Date.now()));
  const [calendarDay, setCalendarDay] = useState(today);
  const [sameSchedule, setSameSchedule] = useState(true);
  const [sharedSchedule, setSharedSchedule] = useState<Schedule>(initialSchedule);
  const [dailySchedules, setDailySchedules] = useState<Record<number, Schedule>>({});
  const [duration, setDuration] = useState(60);
  const [price, setPrice] = useState('10');
  const [localError, setLocalError] = useState('');
  const [launching, setLaunching] = useState(false);

  const monthDays = useMemo(() => {
    const first = new Date(month);
    const count = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const lead = (first.getDay() + 6) % 7;
    return [...Array.from({ length: lead }, () => null), ...Array.from({ length: count }, (_, index) => new Date(first.getFullYear(), first.getMonth(), index + 1).getTime())];
  }, [month]);
  const activeSlots = slots.filter(slot => slot.status !== 'cancelled');
  const activeBookings = bookings.filter(booking => booking.status === 'confirmed' || booking.status === 'completed');
  const daySlots = activeSlots.filter(slot => sameDay(slot.start, calendarDay));
  const dayBookings = activeBookings.filter(booking => sameDay(booking.start, calendarDay));
  const freeWindows = useMemo(() => {
    const opening = atTime(calendarDay, '08:00');
    const closing = atTime(calendarDay, '22:00');
    const busyRanges = [
      ...daySlots.map(slot => [slot.start, slot.available_until || slot.start + slot.minutes * 60000] as const),
      ...dayBookings.map(booking => [booking.start, booking.start + booking.minutes * 60000] as const),
    ].sort((left, right) => left[0] - right[0]);
    const windows: Array<[number, number]> = [];
    let cursor = sameDay(calendarDay, Date.now()) ? Math.max(opening, Date.now()) : opening;
    busyRanges.forEach(([start, end]) => {
      if (end <= cursor || start >= closing) return;
      if (start - cursor >= 30 * 60000) windows.push([cursor, Math.min(start, closing)]);
      cursor = Math.max(cursor, end);
    });
    if (closing - cursor >= 30 * 60000) windows.push([cursor, closing]);
    return windows;
  }, [calendarDay, daySlots, dayBookings]);

  const resetPublish = () => {
    setStep('subject');
    setSubject('');
    setSelectedDates([]);
    setDailySchedules({});
    setLocalError('');
  };
  const chooseSubject = (value: string) => {
    setSubject(value);
    setStep('dates');
    setLocalError('');
  };
  const toggleDate = (value: number) => {
    if (value < today) return;
    setSelectedDates(current => current.includes(value) ? current.filter(item => item !== value) : [...current, value].sort((a, b) => a - b));
    setLocalError('');
  };
  const openSchedule = () => {
    if (!selectedDates.length) { setLocalError(t('اختر يوماً واحداً على الأقل.')); return; }
    const next: Record<number, Schedule> = {};
    selectedDates.forEach(value => { next[value] = dailySchedules[value] || { ...sharedSchedule }; });
    setDailySchedules(next);
    setStep('schedule');
    setLocalError('');
  };
  const updateDaily = (value: number, key: keyof Schedule, next: string) => setDailySchedules(current => ({ ...current, [value]: { ...(current[value] || sharedSchedule), [key]: next } }));
  const publish = async () => {
    const amount = Number(price);
    if (!Number.isFinite(amount) || amount < 0 || amount > 1000) { setLocalError(t('أدخل سعراً صحيحاً.')); return; }
    const drafts: AvailabilityDraft[] = [];
    for (const selectedDay of selectedDates) {
      const schedule = sameSchedule ? sharedSchedule : dailySchedules[selectedDay];
      const start = atTime(selectedDay, schedule.from);
      const availableUntil = atTime(selectedDay, schedule.to);
      if (start <= Date.now()) { setLocalError(t('كل المواعيد يجب أن تبدأ بعد الوقت الحالي.')); return; }
      if (availableUntil - start < duration * 60000) { setLocalError(t('الفترة المتاحة يجب أن تكون أطول من مدة الحصة أو تساويها.')); return; }
      if (activeSlots.some(slot => slot.status !== 'cancelled' && start < (slot.available_until || slot.start + slot.minutes * 60000) && availableUntil > slot.start)) { setLocalError(t('الموعد يتعارض مع موعد آخر.')); return; }
      drafts.push({ subject, start, availableUntil, minutes: duration, price: Math.round(amount * 100) });
    }
    setLocalError('');
    if (!await onPublish(drafts)) return;
    const firstDay = selectedDates[0];
    setLaunching(true);
    window.setTimeout(() => {
      setCalendarDay(firstDay);
      setMonth(monthStart(firstDay));
      setTab('calendar');
      resetPublish();
      setLaunching(false);
    }, 1050);
  };
  const moveMonth = (direction: number) => {
    const next = new Date(month);
    next.setMonth(next.getMonth() + direction);
    setMonth(monthStart(next));
  };
  const addFromCalendar = (value: number) => {
    setSelectedDates([Math.max(value, today)]);
    setTab('publish');
    setStep('subject');
    setLocalError('');
  };

  return <section className="availability-hub" aria-label={t('مركز المواعيد')}>
    <div className={`availability-showcase ${launching ? 'is-launching' : ''}`}>
      <div className="availability-orbit orbit-one" aria-hidden="true" />
      <div className="availability-orbit orbit-two" aria-hidden="true" />
      <header className="availability-showcase-head">
        <div><span className="availability-kicker"><Sparkles size={16} />{t('استوديو وقتك')}</span><h2>{t('رتّب وقتك. وخلّي الحصة تبدأ صح.')}</h2><p>{t('اختر المادة والأيام، ونحن نرتب لك الصورة كاملة بدون أي تعارض.')}</p></div>
        <div className="availability-tabs" role="tablist" aria-label={t('أقسام المواعيد')}>
          <button type="button" role="tab" aria-selected={tab === 'publish'} className={tab === 'publish' ? 'active' : ''} onClick={() => setTab('publish')}><CalendarPlus size={18} />{t('نشر مواعيد')}</button>
          <button type="button" role="tab" aria-selected={tab === 'calendar'} className={`${tab === 'calendar' ? 'active' : ''} ${launching ? 'electric-target' : ''}`} onClick={() => setTab('calendar')}><CalendarCheck size={18} />{t('جدولي والمحجوز')}</button>
        </div>
      </header>

      {launching && <div className="availability-electric-path" aria-hidden="true"><i /><i /><i /></div>}

      {tab === 'publish' && !subjects.length && <div className="availability-lock">
        <span><CalendarDays size={34} /></span><h3>{t('لتتمكن من إضافة مواعيدك، اختر مادتك أولاً من الصفحة الرئيسية.')}</h3><p>{t('بعد حفظ المادة ستظهر هنا تلقائياً وتقدر تبني جدولك خلال خطوات بسيطة.')}</p><button className="availability-light-button" type="button" onClick={onHome}>{t('الذهاب للرئيسية')}<ArrowLeft size={17} /></button>
      </div>}

      {tab === 'publish' && subjects.length > 0 && <div className={`availability-wizard step-${step}`}>
        <div className="availability-progress" aria-label={t('خطوات نشر الموعد')}>
          {[['subject', '1', t('المادة')], ['dates', '2', t('الأيام')], ['schedule', '3', t('الوقت والنشر')]].map(([id, number, label]) => <span className={step === id ? 'current' : (id === 'subject' || step === 'schedule' && id === 'dates') ? 'done' : ''} key={id}><b>{step !== id && (id === 'subject' || step === 'schedule' && id === 'dates') ? <Check size={14} /> : number}</b>{label}</span>)}
        </div>

        {step === 'subject' && <div className="availability-stage availability-subject-stage"><div className="availability-stage-copy"><span>{t('الخطوة الأولى')}</span><h3>{t('أي مادة بدك تفتح إلها وقت؟')}</h3><p>{subjects.length > 1 ? t('موادك جاهزة. اختر واحدة لنرتب أيامها.') : t('مادتك جاهزة. اضغط عليها وابدأ ترتيب الأيام.')}</p></div><div className="availability-subjects">{subjects.map((item, index) => <button type="button" key={item} style={{ '--availability-delay': `${index * 70}ms` } as CSSProperties} onClick={() => chooseSubject(item)}><span>{String(index + 1).padStart(2, '0')}</span><strong>{catalogText(item)}</strong><small>{t('جاهزة للجدولة')}</small><ChevronLeft size={19} /></button>)}</div></div>}

        {step === 'dates' && <div className="availability-stage"><div className="availability-stage-toolbar"><button className="availability-back" type="button" onClick={() => setStep('subject')}><ArrowRight size={17} />{t('تغيير المادة')}</button><div><span>{catalogText(subject)}</span><h3>{t('اختار الأيام المناسبة')}</h3></div><small>{t('{v0} أيام محددة', { v0: selectedDates.length })}</small></div><MonthCalendar month={month} days={monthDays} today={today} selected={selectedDates} slots={activeSlots} bookings={activeBookings} onMove={moveMonth} onDay={toggleDate} selectable />{selectedDates.length > 0 && <div className="selected-date-strip">{selectedDates.map(value => <button type="button" key={value} onClick={() => toggleDate(value)}>{new Date(value).toLocaleDateString(locale(), { weekday: 'short', day: 'numeric', month: 'short' })}<span>×</span></button>)}</div>}<button className="availability-next" type="button" onClick={openSchedule}>{t('التالي: تحديد الوقت')}<ArrowLeft size={18} /></button></div>}

        {step === 'schedule' && <div className="availability-stage schedule-stage"><div className="availability-stage-toolbar"><button className="availability-back" type="button" onClick={() => setStep('dates')}><ArrowRight size={17} />{t('تعديل الأيام')}</button><div><span>{catalogText(subject)}</span><h3>{t('اضبط وقت الحصص')}</h3></div><small>{t('{v0} أيام', { v0: selectedDates.length })}</small></div><div className="schedule-choice" role="tablist"><button type="button" className={sameSchedule ? 'active' : ''} onClick={() => setSameSchedule(true)}>{t('نفس الوقت لكل الأيام')}</button><button type="button" className={!sameSchedule ? 'active' : ''} onClick={() => setSameSchedule(false)}>{t('وقت مختلف لكل يوم')}</button></div>{sameSchedule ? <ScheduleRow label={t('كل الأيام المحددة')} schedule={sharedSchedule} onChange={(key, value) => setSharedSchedule(current => ({ ...current, [key]: value }))} /> : <div className="daily-schedules">{selectedDates.map(value => <ScheduleRow key={value} label={dateLabel(value)} schedule={dailySchedules[value] || sharedSchedule} onChange={(key, next) => updateDaily(value, key, next)} />)}</div>}<div className="availability-publish-settings"><label>{t('مدة الحصة')}<select value={duration} onChange={event => setDuration(Number(event.target.value))}>{[30, 45, 60, 90, 120].map(value => <option key={value} value={value}>{value}{t(' دقيقة')}</option>)}</select></label><label>{t('السعر بالدينار')}<input type="number" min="0" max="1000" step="0.01" value={price} onChange={event => setPrice(event.target.value)} /></label><div className="publish-summary"><span>{t('جاهز للنشر')}</span><strong>{catalogText(subject)}</strong><small>{t('{v0} مواعيد · {v1} دقيقة', { v0: selectedDates.length, v1: duration })}</small></div></div><button className="availability-publish" type="button" disabled={busy} onClick={() => void publish()}><span><CalendarPlus size={19} />{busy ? t('جارٍ الحفظ…') : t('نشر المواعيد')}</span><i aria-hidden="true" /></button></div>}
        {localError && <p className="availability-local-error" role="alert">{localError}</p>}
      </div>}

      {tab === 'calendar' && <div className="availability-calendar-view">
        <div className="availability-stage-toolbar"><div><span>{t('الصورة الكاملة')}</span><h3>{t('تقويم مواعيدك وحجوزاتك')}</h3></div><div className="calendar-legend"><span className="open">{t('متاح')}</span><span className="booked">{t('محجوز')}</span></div></div>
        <div className="availability-calendar-layout"><MonthCalendar month={month} days={monthDays} today={today} selected={[calendarDay]} slots={activeSlots} bookings={activeBookings} onMove={moveMonth} onDay={setCalendarDay} /><aside className="calendar-day-panel"><span>{t('تفاصيل اليوم')}</span><h3>{dateLabel(calendarDay)}</h3><div className="day-capacity"><div><strong>{dayBookings.length}</strong><small>{t('حصص محجوزة')}</small></div><div><strong>{daySlots.filter(slot => slot.status === 'open').length}</strong><small>{t('فترات متاحة')}</small></div></div><div className="day-free-windows"><strong>{t('الساعات الفارغة')}</strong><div>{freeWindows.length ? freeWindows.slice(0, 4).map(([from, to]) => <span key={`${from}-${to}`} dir="ltr">{timeValue(new Date(from))} – {timeValue(new Date(to))}</span>) : <small>{t('لا توجد فترة فارغة كافية بين 8 صباحاً و10 مساءً.')}</small>}</div></div>{!daySlots.length && !dayBookings.length && <div className="free-day"><Clock3 size={28} /><strong>{t('هذا اليوم فاضي')}</strong><p>{t('تقدر تضيف له وقت جديد بدون تعارض.')}</p></div>}<div className="calendar-day-events">{dayBookings.map(booking => <button type="button" className="day-event booked" key={`booking-${booking.id}`} onClick={() => onBookingDetails(booking.id)}><span>{timeValue(new Date(booking.start))}</span><div><strong>{catalogText(booking.subject)}</strong><small>{booking.student_name} · {booking.minutes}{t(' دقيقة')}</small></div><ChevronLeft size={16} /></button>)}{daySlots.filter(slot => slot.status === 'open').map(slot => <article className="day-event open" key={slot.id}><span>{timeValue(new Date(slot.start))}</span><div><strong>{catalogText(slot.subject)}</strong><small>{timeValue(new Date(slot.start))} – {timeValue(new Date(slot.available_until || slot.start + slot.minutes * 60000))} · {money(slot.price)}</small></div><button type="button" title={t('حذف الموعد')} onClick={() => onDelete(slot.id)}><Trash2 size={15} /></button></article>)}</div><button className="availability-light-button" type="button" disabled={calendarDay < today} onClick={() => addFromCalendar(calendarDay)}><CalendarPlus size={17} />{t('إضافة موعد لهذا اليوم')}</button></aside></div>
      </div>}
    </div>
    <div className="availability-quick-stats"><div><span>{t('المواعيد القادمة')}</span><strong>{activeSlots.filter(slot => slot.start >= Date.now()).length}</strong></div><div><span>{t('الحصص المحجوزة')}</span><strong>{activeBookings.filter(booking => booking.status === 'confirmed' && booking.start + booking.minutes * 60000 >= Date.now()).length}</strong></div><div><span>{t('أيام عندك فيها نشاط')}</span><strong>{new Set([...activeSlots, ...activeBookings].map(item => dayStart(new Date(item.start)))).size}</strong></div></div>
  </section>;
}

function ScheduleRow({ label, schedule, onChange }: { label: string; schedule: Schedule; onChange: (key: keyof Schedule, value: string) => void }) {
  return <div className="schedule-row"><div><CalendarDays size={18} /><strong>{label}</strong></div><label>{t('من')}<input type="time" value={schedule.from} onChange={event => onChange('from', event.target.value)} /></label><span aria-hidden="true">→</span><label>{t('إلى')}<input type="time" value={schedule.to} onChange={event => onChange('to', event.target.value)} /></label></div>;
}

function MonthCalendar({ month, days, today, selected, slots, bookings, onMove, onDay, selectable = false }: { month: number; days: Array<number | null>; today: number; selected: number[]; slots: Slot[]; bookings: Booking[]; onMove: (direction: number) => void; onDay: (value: number) => void; selectable?: boolean }) {
  const weekdays = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(2026, 0, 5 + index);
    return day.toLocaleDateString(locale(), { weekday: 'short' });
  });
  return <div className="month-calendar"><div className="month-calendar-head"><button type="button" onClick={() => onMove(-1)} title={t('الشهر السابق')}><ChevronRight size={18} /></button><strong>{new Date(month).toLocaleDateString(locale(), { month: 'long', year: 'numeric' })}</strong><button type="button" onClick={() => onMove(1)} title={t('الشهر التالي')}><ChevronLeft size={18} /></button></div><div className="month-weekdays">{weekdays.map(day => <span key={day}>{day}</span>)}</div><div className="month-grid">{days.map((value, index) => {
    if (value === null) return <i key={`blank-${index}`} />;
    const open = slots.filter(slot => slot.status === 'open' && sameDay(slot.start, value)).length;
    const booked = bookings.filter(booking => booking.status === 'confirmed' && sameDay(booking.start, value)).length;
    const disabled = selectable && value < today;
    return <button type="button" key={value} disabled={disabled} aria-pressed={selected.includes(value)} aria-label={new Date(value).toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' })} className={`${selected.includes(value) ? 'selected' : ''} ${sameDay(value, today) ? 'today' : ''} ${open ? 'has-open' : ''} ${booked ? 'has-booked' : ''}`} onClick={() => onDay(value)}><span>{new Date(value).getDate()}</span>{(open > 0 || booked > 0) && <small>{open > 0 && <b className="open-dot">{open}</b>}{booked > 0 && <b className="booked-dot">{booked}</b>}</small>}{selected.includes(value) && selectable && <Check size={14} />}</button>;
  })}</div></div>;
}
