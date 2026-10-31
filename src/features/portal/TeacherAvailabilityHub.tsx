import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, CalendarCheck, CalendarDays, CalendarPlus, Check, ChevronLeft, ChevronRight, Clock3, Trash2, X } from 'lucide-react';
import { catalogText, locale, t, usePreferences } from '../../i18n/preferences';
import { money, request, type Booking, type Slot, type SlotOffering } from '../../services/platformApi';

export type AvailabilityDraft = { subject: string; subjects: string[]; start: number; availableUntil: number; minutes: number; price: number; offerings: SlotOffering[] };
type Schedule = { from: string; to: string };
type Props = { subjects: string[]; slots: Slot[]; bookings: Booking[]; busy: boolean; onHome: () => void; onPublish: (drafts: AvailabilityDraft[]) => Promise<boolean>; onDelete: (id: string) => void; onBookingDetails: (id: string) => void };

const dayStart = (value = new Date()) => { const day = new Date(value); day.setHours(0, 0, 0, 0); return day.getTime(); };
const sameDay = (left: number, right: number) => new Date(left).toDateString() === new Date(right).toDateString();
const nextDayStart = (value: number) => { const next = new Date(value); next.setDate(next.getDate() + 1); next.setHours(0, 0, 0, 0); return next.getTime(); };
const rangeIntersectsDay = (start: number, end: number, day: number) => start < nextDayStart(day) && end > dayStart(new Date(day));
const timeValue = (value: Date) => `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
const clockMinutes = (value: string) => {
  const [hours, minutes] = value.split(':').map(Number);
  return Number.isInteger(hours) && Number.isInteger(minutes) && hours >= 0 && hours < 24 && minutes >= 0 && minutes < 60 ? hours * 60 + minutes : -1;
};
const initialSchedule = (): Schedule => {
  const from = new Date();
  const partialMinute = from.getSeconds() > 0 || from.getMilliseconds() > 0;
  from.setSeconds(0, 0);
  const remainder = from.getMinutes() % 15;
  if (remainder || partialMinute) from.setMinutes(from.getMinutes() + (remainder ? 15 - remainder : 15));
  return { from: timeValue(from), to: timeValue(new Date(from.getTime() + 60 * 60000)) };
};
const atTime = (day: number, value: string) => { const [hours, minutes] = value.split(':').map(Number); const result = new Date(day); result.setHours(hours || 0, minutes || 0, 0, 0); return result.getTime(); };
const availabilityEnd = (day: number, from: string, to: string) => {
  const end = atTime(day, to);
  return clockMinutes(to) <= clockMinutes(from) ? end + 24 * 60 * 60000 : end;
};
const monthStart = (value: number | Date) => { const result = new Date(value); result.setDate(1); result.setHours(0, 0, 0, 0); return result.getTime(); };
const dateLabel = (value: number) => new Date(value).toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' });
const availabilityRangeLabel = (start: number, end: number) => sameDay(start, end)
  ? `${new Date(start).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })} – ${new Date(end).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })}`
  : `${new Date(start).toLocaleDateString(locale(), { weekday: 'short', day: 'numeric', month: 'short' })} ${new Date(start).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })} → ${new Date(end).toLocaleDateString(locale(), { weekday: 'short', day: 'numeric', month: 'short' })} ${new Date(end).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })}`;
const durationOptions = [30, 45, 60, 90, 120] as const;
const timeOptions = Array.from({ length: 24 * 4 }, (_, index) => {
  const minutes = index * 15;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
});
const timeLabel = (value: string) => {
  const minutes = clockMinutes(value);
  const date = new Date(2026, 0, 1, Math.floor(minutes / 60), minutes % 60);
  return date.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
};
export function TeacherAvailabilityHub({ subjects, slots, bookings, busy, onHome, onPublish, onDelete, onBookingDetails }: Props) {
  usePreferences();
  const today = dayStart();
  const [tab, setTab] = useState<'publish' | 'calendar'>('publish');
  const [selectedDay, setSelectedDay] = useState<number | null>(today);
  const [schedule, setSchedule] = useState<Schedule>(initialSchedule);
  const [month, setMonth] = useState(monthStart(Date.now()));
  const [calendarDay, setCalendarDay] = useState(today);
  const [durationPrices, setDurationPrices] = useState<Record<number, string>>({ 60: '10' });
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [localError, setLocalError] = useState('');
  const [launching, setLaunching] = useState(false);
  const dayStripRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    request<{ offerings: SlotOffering[] }>('teachers/availability-preferences').then(result => {
      if (!alive) return;
      const saved = Object.fromEntries((result.offerings || []).map(item => [item.minutes, String(item.price / 100)]));
      setDurationPrices(Object.keys(saved).length ? saved : { 60: '10' });
    }).catch(() => undefined).finally(() => { if (alive) setPreferencesLoaded(true); });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (!preferencesLoaded) return;
    const timer = window.setTimeout(() => {
      const offerings = durationOptions.filter(minutes => durationPrices[minutes] !== undefined && durationPrices[minutes] !== '').map(minutes => ({ minutes, price: Math.round(Number(durationPrices[minutes]) * 100) })).filter(item => Number.isFinite(item.price) && item.price >= 0);
      if (offerings.length) void request('teachers/availability-preferences', { offerings }).catch(() => undefined);
    }, 450);
    return () => clearTimeout(timer);
  }, [durationPrices, preferencesLoaded]);

  const monthDays = useMemo(() => { const first = new Date(month); const count = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate(); const lead = (first.getDay() + 6) % 7; return [...Array.from({ length: lead }, () => null), ...Array.from({ length: count }, (_, index) => new Date(first.getFullYear(), first.getMonth(), index + 1).getTime())]; }, [month]);
  const publishDays = useMemo(() => Array.from({ length: 28 }, (_, index) => { const day = new Date(today); day.setDate(day.getDate() + index); return day.getTime(); }), [today]);
  const activeSlots = slots.filter(slot => slot.status !== 'cancelled');
  const activeBookings = bookings.filter(booking => booking.status === 'confirmed' || booking.status === 'completed');
  const daySlots = activeSlots.filter(slot => rangeIntersectsDay(slot.start, slot.available_until || slot.start + slot.minutes * 60000, calendarDay));
  const dayBookings = activeBookings.filter(booking => sameDay(booking.start, calendarDay));
  const freeWindows = useMemo(() => {
    const opening = atTime(calendarDay, '08:00'), closing = atTime(calendarDay, '22:00');
    const busyRanges = [...daySlots.map(slot => [slot.start, slot.available_until || slot.start + slot.minutes * 60000] as const), ...dayBookings.map(booking => [booking.start, booking.start + booking.minutes * 60000] as const)].sort((left, right) => left[0] - right[0]);
    const windows: Array<[number, number]> = []; let cursor = sameDay(calendarDay, Date.now()) ? Math.max(opening, Date.now()) : opening;
    busyRanges.forEach(([start, end]) => { if (end <= cursor || start >= closing) return; if (start - cursor >= 30 * 60000) windows.push([cursor, Math.min(start, closing)]); cursor = Math.max(cursor, end); });
    if (closing - cursor >= 30 * 60000) windows.push([cursor, closing]); return windows;
  }, [calendarDay, daySlots, dayBookings]);

  const toggleDuration = (minutes: number, checked: boolean) => {
    setDurationPrices(current => {
      if (!checked) { const next = { ...current }; delete next[minutes]; return next; }
      return { ...current, [minutes]: current[minutes] ?? '10' };
    });
    setLocalError('');
  };
  const updateDurationPrice = (minutes: number, value: string) => { setDurationPrices(current => ({ ...current, [minutes]: value })); setLocalError(''); };
  const updateSchedule = (key: keyof Schedule, value: string) => {
    if (clockMinutes(value) < 0) return;
    setSchedule(current => ({ ...current, [key]: value }));
    setLocalError('');
  };
  const chooseDay = (value: number) => { setSelectedDay(value); setLocalError(''); };
  const publish = async () => {
    if (selectedDay === null) { setLocalError(t('اختر يوماً واحداً على الأقل.')); return; }
    const offerings = durationOptions.filter(minutes => durationPrices[minutes] !== undefined).map(minutes => ({ minutes, price: Math.round(Number(durationPrices[minutes]) * 100) }));
    if (!offerings.length) { setLocalError(t('اختر مدة حصة واحدة على الأقل.')); return; }
    if (offerings.some(item => !Number.isFinite(item.price) || item.price < 0 || item.price > 100000)) { setLocalError(t('أدخل سعراً صحيحاً لكل مدة مختارة.')); return; }
    const start = atTime(selectedDay, schedule.from), availableUntil = availabilityEnd(selectedDay, schedule.from, schedule.to);
    if (start < Date.now() - 60000) { setLocalError(t('كل المواعيد يجب أن تبدأ بعد الوقت الحالي.')); return; }
    if (availableUntil - start < Math.max(...offerings.map(item => item.minutes)) * 60000) { setLocalError(t('الفترة المتاحة يجب أن تتسع لأطول مدة حصة اخترتها.')); return; }
    if (activeSlots.some(slot => start < (slot.available_until || slot.start + slot.minutes * 60000) && availableUntil > slot.start)) { setLocalError(t('الموعد يتعارض مع موعد آخر.')); return; }
    const subject = 'كل المواد المختارة'; setLocalError('');
    const defaultOffering = offerings[0];
    if (!await onPublish([{ subject, subjects: [...subjects], start, availableUntil, minutes: defaultOffering.minutes, price: defaultOffering.price, offerings }])) return;
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
        <div className="availability-date-picker"><div className="availability-date-head"><strong>{new Date(selectedDay ?? today).toLocaleDateString(locale(), { month: 'long', year: 'numeric' })}</strong><div><button type="button" title={t('تمرير الأيام للخلف')} onClick={() => dayStripRef.current?.scrollBy({ left: -260, behavior: 'smooth' })}><ChevronRight size={17} /></button><button type="button" title={t('تمرير الأيام للأمام')} onClick={() => dayStripRef.current?.scrollBy({ left: 260, behavior: 'smooth' })}><ChevronLeft size={17} /></button></div></div><div className="availability-day-strip" ref={dayStripRef}>{publishDays.map(value => <button type="button" key={value} aria-pressed={selectedDay === value} className={selectedDay === value ? 'selected' : ''} onClick={() => chooseDay(value)}><span>{new Date(value).toLocaleDateString(locale(), { weekday: 'short' })}</span><strong>{new Date(value).toLocaleDateString(locale(), { day: '2-digit' })}</strong><small>{new Date(value).toLocaleDateString(locale(), { month: 'short' })}</small></button>)}</div></div>
        {selectedDay !== null && <div className="availability-inline-settings"><div className="availability-selected-day"><CalendarDays size={18} /><strong>{dateLabel(selectedDay)}</strong></div><ScheduleRow label={t('الفترة المتاحة')} schedule={schedule} onChange={updateSchedule} /><div className={`availability-range-preview ${clockMinutes(schedule.to) <= clockMinutes(schedule.from) ? 'overnight' : ''}`}><Clock3 size={17} /><span><small>{clockMinutes(schedule.to) <= clockMinutes(schedule.from) ? t('الموعد ممتد لليوم التالي') : t('الفترة المختارة')}</small><strong dir="auto">{availabilityRangeLabel(atTime(selectedDay, schedule.from), availabilityEnd(selectedDay, schedule.from, schedule.to))}</strong></span></div><fieldset className="availability-duration-options"><legend>{t('مدد الحصة وأسعارها')}</legend><p>{t('اختر المدد التي تناسبك وحدد سعراً منفصلاً لكل واحدة. تحفظ اختياراتك تلقائياً للمرة القادمة.')}</p><div>{durationOptions.map(minutes => { const checked = durationPrices[minutes] !== undefined; const price = Number(durationPrices[minutes]); return <label className={checked ? 'selected' : ''} key={minutes}><span className="duration-check"><input type="checkbox" checked={checked} onChange={event => toggleDuration(minutes, event.currentTarget.checked)} /><i><Check size={13} /></i><strong>{minutes} {t('دقيقة')}</strong></span><span className="duration-price"><input type="number" aria-label={t('سعر {v0} دقيقة', { v0: minutes })} min="0" max="1000" step="0.01" disabled={!checked} value={durationPrices[minutes] ?? ''} onChange={event => updateDurationPrice(minutes, event.target.value)} /><small>{t('د.أ')}</small></span>{checked && Number.isFinite(price) && price >= 0 && <em className="platform-commission-note">{t('عمولة المنصة 10%: {v0} د.أ · يصلك {v1} د.أ', { v0: (price * .1).toFixed(2), v1: (price * .9).toFixed(2) })}</em>}</label>; })}</div></fieldset><button className="availability-publish" type="button" disabled={busy} onClick={() => void publish()}><span><CalendarPlus size={19} />{busy ? t('جارٍ الحفظ…') : t('نشر المواعيد')}</span><i aria-hidden="true" /></button></div>}
        {localError && <p className="availability-local-error" role="alert">{localError}</p>}
      </div>}
      {tab === 'calendar' && <div className="availability-calendar-view"><div className="availability-stage-toolbar"><div><span>{t('الصورة الكاملة')}</span><h3>{t('تقويم مواعيدك وحجوزاتك')}</h3></div><div className="calendar-legend"><span className="open">{t('متاح')}</span><span className="booked">{t('محجوز')}</span><span className="past">{t('منتهي')}</span></div></div><div className="availability-calendar-layout"><MonthCalendar month={month} days={monthDays} today={today} selected={[calendarDay]} slots={activeSlots} bookings={activeBookings} onMove={moveMonth} onDay={setCalendarDay} /><aside className="calendar-day-panel"><span>{t('تفاصيل اليوم')}</span><h3>{dateLabel(calendarDay)}</h3><div className="day-capacity"><div><strong>{dayBookings.length}</strong><small>{t('حصص محجوزة')}</small></div><div><strong>{daySlots.filter(slot => slot.status === 'open').length}</strong><small>{t('فترات متاحة')}</small></div></div><div className="day-free-windows"><strong>{t('الساعات الفارغة')}</strong><div>{freeWindows.length ? freeWindows.slice(0, 4).map(([from, to]) => <span key={`${from}-${to}`} dir="ltr">{timeValue(new Date(from))} – {timeValue(new Date(to))}</span>) : <small>{t('لا توجد فترة فارغة كافية بين 8 صباحاً و10 مساءً.')}</small>}</div></div>{!daySlots.length && !dayBookings.length && <div className="free-day"><Clock3 size={28} /><strong>{t('هذا اليوم فاضي')}</strong><p>{t('تقدر تضيف له وقت جديد بدون تعارض.')}</p></div>}<div className="calendar-day-events">{dayBookings.map(booking => { const past = booking.start + booking.minutes * 60000 < Date.now(); return <button type="button" className={`day-event booked ${past ? 'past' : ''}`} key={`booking-${booking.id}`} onClick={() => onBookingDetails(booking.id)}><span>{timeValue(new Date(booking.start))}</span><div><strong>{catalogText(booking.subject)}</strong><small>{booking.student_name} · {booking.minutes}{t(' دقيقة')}</small>{booking.student_phone && <small dir="ltr">{booking.student_phone}</small>}</div><ChevronLeft size={16} /></button>; })}{daySlots.filter(slot => slot.status === 'open').map(slot => { const end = slot.available_until || slot.start + slot.minutes * 60000; const past = end < Date.now(); return <article className={`day-event open ${past ? 'past' : ''}`} key={slot.id}><span>{timeValue(new Date(slot.start))}</span><div><strong>{catalogText(slot.subject)}</strong><small>{availabilityRangeLabel(slot.start, end)} · {money(slot.price)}</small><small>{dayBookings.filter(booking => booking.slot_id === slot.id && booking.status === 'confirmed').length} {t('حجوزات مؤكدة')}</small></div>{!past && <button type="button" title={t('حذف الموعد')} onClick={() => onDelete(slot.id)}><Trash2 size={15} /></button>}</article>; })}</div><button className="availability-light-button" type="button" disabled={calendarDay < today} onClick={() => addFromCalendar(calendarDay)}><CalendarPlus size={17} />{t('إضافة موعد لهذا اليوم')}</button></aside></div></div>}
    </div>
  </section>;
}

function ScheduleRow({ label, schedule, onChange }: { label: string; schedule: Schedule; onChange: (key: keyof Schedule, value: string) => void }) {
  const crossesMidnight = clockMinutes(schedule.to) <= clockMinutes(schedule.from);
  return <div className="schedule-row"><div><CalendarDays size={18} /><strong>{label}</strong></div><TimeWheel label={t('من')} value={schedule.from} onChange={value => onChange('from', value)} /><TimeWheel label={t('إلى')} value={schedule.to} onChange={value => onChange('to', value)} note={crossesMidnight ? t('اليوم التالي') : ''} /></div>;
}

function TimeWheel({ label, value, onChange, note = '' }: { label: string; value: string; onChange: (value: string) => void; note?: string }) {
  const [open, setOpen] = useState(false);
  const drag = useRef<{ y: number; index: number; moved: boolean } | null>(null);
  const currentIndex = Math.max(0, timeOptions.indexOf(value));
  const selectIndex = (index: number) => onChange(timeOptions[(index + timeOptions.length) % timeOptions.length]);
  const surrounding = Array.from({ length: 7 }, (_, index) => {
    const offset = index - 3;
    const optionIndex = (currentIndex + offset + timeOptions.length) % timeOptions.length;
    return { offset, value: timeOptions[optionIndex] };
  });
  return <div className={`time-wheel ${open ? 'open' : ''}`}>
    <span>{label}</span>
    <button className="time-wheel-trigger" type="button" role="spinbutton" data-value={value} aria-label={label} aria-valuetext={timeLabel(value)} aria-expanded={open} onClick={() => setOpen(true)}><Clock3 size={16} /><strong dir="ltr">{timeLabel(value)}</strong></button>
    {note && <small className="next-day-note">{note}</small>}
    {open && createPortal(<div className="time-wheel-backdrop" role="presentation" onPointerDown={event => { if (event.target === event.currentTarget) setOpen(false); }}>
      <section className="time-wheel-popover" role="dialog" aria-modal="true" aria-label={`${label} ${timeLabel(value)}`} onWheel={event => { event.preventDefault(); selectIndex(currentIndex + (event.deltaY > 0 ? 1 : -1)); }} onPointerDown={event => { drag.current = { y: event.clientY, index: currentIndex, moved: false }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => { if (!drag.current) return; const steps = Math.round((drag.current.y - event.clientY) / 42); if (steps) drag.current.moved = true; selectIndex(drag.current.index + steps); }} onPointerUp={event => { event.currentTarget.releasePointerCapture(event.pointerId); window.setTimeout(() => { drag.current = null; }, 0); }} onPointerCancel={() => { drag.current = null; }}>
        <header><div><small>{t('اختيار الوقت')}</small><strong>{label}</strong></div><span className="time-wheel-current" dir="ltr">{timeLabel(value)}</span><button type="button" aria-label={t('إغلاق')} onPointerDown={event => event.stopPropagation()} onClick={() => setOpen(false)}><X size={18} /></button></header>
        <div className="time-wheel-options" aria-live="polite">{surrounding.map(option => <button type="button" className={option.offset === 0 ? 'selected' : ''} data-distance={Math.abs(option.offset)} key={`${option.offset}-${option.value}`} onClick={() => { if (drag.current?.moved) return; onChange(option.value); if (option.offset === 0) setOpen(false); }}><span dir="ltr">{timeLabel(option.value)}</span></button>)}</div>
        <button className="time-wheel-done" type="button" onPointerDown={event => event.stopPropagation()} onClick={() => setOpen(false)}>{t('تم')}</button>
      </section>
    </div>, document.body)}
  </div>;
}

function MonthCalendar({ month, days, today, selected, slots, bookings, onMove, onDay }: { month: number; days: Array<number | null>; today: number; selected: number[]; slots: Slot[]; bookings: Booking[]; onMove: (direction: number) => void; onDay: (value: number) => void }) {
  const weekdays = Array.from({ length: 7 }, (_, index) => new Date(2026, 0, 5 + index).toLocaleDateString(locale(), { weekday: 'short' }));
  return <div className="month-calendar"><div className="month-calendar-head"><button type="button" onClick={() => onMove(-1)} title={t('الشهر السابق')}><ChevronRight size={18} /></button><strong>{new Date(month).toLocaleDateString(locale(), { month: 'long', year: 'numeric' })}</strong><button type="button" onClick={() => onMove(1)} title={t('الشهر التالي')}><ChevronLeft size={18} /></button></div><div className="month-weekdays">{weekdays.map(day => <span key={day}>{day}</span>)}</div><div className="month-grid">{days.map((value, index) => {
    if (value === null) return <i key={`blank-${index}`} />;
    const past = value < today;
    const open = slots.filter(slot => slot.status === 'open' && rangeIntersectsDay(slot.start, slot.available_until || slot.start + slot.minutes * 60000, value)).length;
    const booked = bookings.filter(booking => (booking.status === 'confirmed' || booking.status === 'completed') && sameDay(booking.start, value)).length;
    return <button type="button" key={value} aria-pressed={selected.includes(value)} aria-label={new Date(value).toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' })} className={`${selected.includes(value) ? 'selected' : ''} ${sameDay(value, today) ? 'today' : ''} ${past ? 'past' : ''} ${open ? 'has-open' : ''} ${booked ? 'has-booked' : ''}`} onClick={() => onDay(value)}><span>{new Date(value).getDate()}</span>{(open > 0 || booked > 0) && <small>{open > 0 && <b className="open-dot">{open}</b>}{booked > 0 && <b className="booked-dot">{booked}</b>}</small>}</button>;
  })}</div></div>;
}
