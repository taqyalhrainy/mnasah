import { useEffect, useRef, useState } from 'react';
import { ArrowRight, CalendarDays, Check, ChevronLeft, ChevronRight, Clock3, Download, Info, RefreshCw, Users, X } from 'lucide-react';
import { date, money, request, type Booking } from '../../services/platformApi';
import { direction, locale, t, catalogText, usePreferences } from '../../i18n/preferences';
import './payments.css';

type Range = { start: string; end: string };
type Totals = { gross: number; fee: number; net: number; collected: number; uncollected: number; minutes: number; lessons: number; averageHourly: number };
type EarningsBooking = Booking & { fee: number; net: number };
type Payments = Range & { commissionPercent: number; timezone: string; summary: Totals; bookings: EarningsBooking[]; teachers: Array<Totals & { id: string; name: string }>; days: Array<Totals & { day: string }> };
const key = (value: Date) => value.toISOString().slice(0, 10);
const civil = (value: string) => new Date(`${value}T12:00:00Z`);
const add = (value: string, days: number) => { const result = civil(value); result.setUTCDate(result.getUTCDate() + days); return key(result); };
const todayKey = () => { const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Amman', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(Date.now()); return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)?.value).join('-'); };
function week(value: string): Range { const start = add(value, -((civil(value).getUTCDay() + 6) % 7)); return { start, end: add(start, 6) > todayKey() ? todayKey() : add(start, 6) }; }
const dayLabel = (value: string) => new Intl.DateTimeFormat(locale(), { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(civil(value));
const rangeLabel = (range: Range) => range.start === range.end ? dayLabel(range.start) : `${dayLabel(range.start)} – ${dayLabel(range.end)}`;
const duration = (minutes: number) => t('{hours} س {minutes} د', { hours: new Intl.NumberFormat(locale()).format(Math.floor(minutes / 60)), minutes: new Intl.NumberFormat(locale()).format(minutes % 60) });
function totals(rows: EarningsBooking[]): Totals {
  const gross = rows.reduce((sum, row) => sum + row.price, 0), fee = rows.reduce((sum, row) => sum + row.fee, 0);
  const collected = rows.filter(row => row.paid === 1).reduce((sum, row) => sum + row.price, 0), minutes = rows.reduce((sum, row) => sum + row.minutes, 0);
  return { gross, fee, net: gross - fee, collected, uncollected: gross - collected, minutes, lessons: rows.length, averageHourly: minutes ? Math.round(gross * 60 / minutes) : 0 };
}
export function PaymentsPanel({ portal }: { portal: 'admin' | 'teachers' }) {
  usePreferences();
  const [range, setRange] = useState<Range>(() => week(todayKey()));
  const [data, setData] = useState<Payments | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [calendar, setCalendar] = useState(false);
  const [detail, setDetail] = useState(false);
  const [showLessons, setShowLessons] = useState(false);
  const [teacher, setTeacher] = useState('all');
  useEffect(() => {
    const controller = new AbortController(); let alive = true;
    setLoading(true); setError('');
    request<Payments>(`${portal}/payments?start=${range.start}&end=${range.end}`, undefined, controller.signal).then(result => { if (alive) setData(result); }).catch(reason => { if (alive) setError(reason.message); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; controller.abort(); };
  }, [portal, range.start, range.end, revision]);
  const rows = (data?.bookings || []).filter(row => teacher === 'all' || row.teacher_id === teacher);
  const summary = teacher === 'all' && data ? data.summary : totals(rows);
  const periodCurrent = range.start === week(todayKey()).start && range.end === todayKey();
  const complete = (next: Range) => { setRange(next); setCalendar(false); setShowLessons(false); setTeacher('all'); };
  const next = week(add(range.start, 7));
  function exportReport() {
    const safe = (value: string | number) => `"${String(value).replace(/^[=+@-]/, "'").replaceAll('"', '""')}"`;
    const report = [[t('الفترة'), rangeLabel(range)], [t('العمولة'), `${data?.commissionPercent || 0}%`], [], [t('المادة'), t('الأستاذ'), t('الطالب'), t('الموعد'), t('إيراد الحصة'), t('عمولة المنصة'), t('مستحقات الأستاذ'), t('الدفعة مسجلة')], ...rows.map(row => [row.subject, row.teacher_name, row.student_name, date(row.start), (row.price / 100).toFixed(3), (row.fee / 100).toFixed(3), (row.net / 100).toFixed(3), t(row.paid ? 'نعم' : 'لا')])];
    const url = URL.createObjectURL(new Blob(['\uFEFF' + report.map(row => row.map(safe).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `mansah-payments-${range.start}-${range.end}.csv`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section className="payments-page" aria-label={t('المستحقات')}>
    <div className="payments-heading"><div><span className="section-kicker">{t('التقارير المالية')}</span><h2>{detail ? t('تفاصيل المستحقات') : periodCurrent ? t('هذا الأسبوع') : t('الفترة المحددة')}</h2></div><div className="payments-tools">{detail && <button className="icon-button" title={t('العودة للملخص')} onClick={() => { setDetail(false); setTeacher('all'); }}><ArrowRight className="directional-icon" size={20} /></button>}<button className="icon-button" title={t('تحديد التاريخ')} onClick={() => setCalendar(true)}><CalendarDays size={21} /></button><button className="icon-button" title={t('تنزيل التقرير CSV')} disabled={loading || !rows.length} onClick={exportReport}><Download size={20} /></button><button className="icon-button" title={t('تحديث')} disabled={loading} onClick={() => setRevision(value => value + 1)}><RefreshCw size={18} /></button></div></div>
    {error ? <p role="alert" className="notice error">{t(error)}<button className="text-button" onClick={() => setRevision(value => value + 1)}>{t('إعادة المحاولة')}</button></p> : loading ? <div className="payment-loading" role="status"><span className="wake-spinner" /><span>{t('جارٍ تحميل المستحقات…')}</span></div> : data && <>
      {detail ? <div className="payment-period-navigation"><button className="icon-button" title={t('الأسبوع السابق')} onClick={() => complete(week(add(range.start, -7)))}><ChevronRight className="directional-icon" size={21} /></button><button className="payment-date-button" onClick={() => setCalendar(true)}><strong>{rangeLabel(range)}</strong><span>{new Intl.DateTimeFormat(locale(), { year: 'numeric', timeZone: 'UTC' }).format(civil(range.end))}</span></button><button className="icon-button" title={t('الأسبوع التالي')} disabled={next.start > todayKey()} onClick={() => complete(next)}><ChevronLeft className="directional-icon" size={21} /></button></div> : <button className="payment-summary-card" onClick={() => setDetail(true)} aria-label={t('فتح تفاصيل المستحقات')}><span className="payment-summary-period">{rangeLabel(range)}</span><strong className="payment-amount">{money(portal === 'admin' ? summary.gross : summary.net)}</strong><span className="payment-summary-caption">{t(portal === 'admin' ? 'إجمالي إيراد الحصص المكتملة' : 'صافي مستحقات الحصص المكتملة')}</span><ChevronLeft className="payment-summary-arrow directional-icon" size={28} /><span className="payment-summary-metrics"><span><span><Clock3 size={17} />{t('ساعات التدريس')}</span><b>{duration(summary.minutes)}</b></span><span><span><Info size={17} />{t('المتوسط في الساعة')}</span><b>{money(summary.averageHourly)}</b></span></span></button>}
      {portal === 'admin' && detail && <label className="payment-teacher-filter"><Users size={18} /><span>{t('الأستاذ')}</span><select aria-label={t('فلترة حسب الأستاذ')} value={teacher} onChange={event => setTeacher(event.target.value)}><option value="all">{t('كل الأساتذة')}</option>{data.teachers.map(row => <option value={row.id} key={row.id}>{row.name}</option>)}</select></label>}
      {detail && <><div className="payment-total"><span>{t(portal === 'admin' ? 'إجمالي إيراد الحصص المكتملة' : 'صافي مستحقات الحصص المكتملة')}</span><strong className="payment-amount">{money(portal === 'admin' ? summary.gross : summary.net)}</strong></div><dl className="payment-breakdown"><div><dt>{t('إيراد الحصص')}</dt><dd>{money(summary.gross)}</dd></div><div><dt>{t('عمولة المنصة')}<span>{data.commissionPercent}%</span></dt><dd>{money(summary.fee)}</dd></div><div className="payment-net"><dt>{t('مستحقات الأساتذة')}</dt><dd>{money(summary.net)}</dd></div><div><dt>{t('الدفعات المسجلة')}</dt><dd>{money(summary.collected)}</dd></div><div><dt>{t('بانتظار التحصيل')}</dt><dd>{money(summary.uncollected)}</dd></div></dl><div className="payment-detail-metrics"><div><span><Clock3 size={17} />{t('ساعات التدريس')}</span><strong>{duration(summary.minutes)}</strong></div><div><span><Info size={17} />{t('المتوسط في الساعة')}</span><strong>{money(summary.averageHourly)}</strong></div></div></>}
      <p className="payment-accounting-note"><Info size={16} /><span>{t('المبالغ محسوبة من الحصص المكتملة حسب توقيت عمّان. تسجيل دفعة للحصة لا يعني تحويل مستحقات الأستاذ.')}</span></p>
      {!summary.lessons && <div className="empty-state"><CalendarDays size={28} /><p>{t('لا توجد حصص مكتملة ضمن هذه الفترة.')}</p></div>}
      {portal === 'admin' && !detail && !!data.teachers.length && <section className="payment-teachers"><div className="section-heading"><h3>{t('مستحقات الأساتذة')}</h3><span>{new Intl.NumberFormat(locale()).format(data.teachers.length)}</span></div>{data.teachers.map(row => <button className="payment-teacher-row" key={row.id} onClick={() => { setTeacher(row.id); setDetail(true); }}><span className="account-avatar">{row.name?.slice(0, 1)}</span><span><strong>{row.name}</strong><small>{t('{count} حصص مكتملة', { count: row.lessons })}</small></span><b>{money(row.net)}</b><ChevronLeft className="directional-icon" size={19} /></button>)}</section>}
      {!!rows.length && <section className="payment-lessons"><button className="payment-lessons-toggle" aria-expanded={showLessons} aria-controls="payment-lessons-list" onClick={() => setShowLessons(value => !value)}><span><Check size={23} /><span><strong>{t('الحصص')}</strong><small>{t('{count} حصص مكتملة', { count: rows.length })}</small></span></span><ChevronLeft className={showLessons ? 'expanded' : 'directional-icon'} size={21} /></button>{showLessons && <div id="payment-lessons-list">{rows.map(row => <article className="payment-lesson-row" key={row.id}><div><strong>{catalogText(row.subject)}</strong><p>{row.teacher_name} · {row.student_name}</p><time>{date(row.start)}</time></div><div><strong>{money(row.price)}</strong><span className={`badge ${row.paid ? 'active' : 'pending'}`}>{t(row.paid ? 'دفعة مسجلة' : 'غير مدفوع')}</span></div></article>)}</div>}</section>}
    </>}
    {calendar && <PaymentCalendar value={range} onApply={complete} onClose={() => setCalendar(false)} />}
  </section>;
}
function PaymentCalendar({ value, onApply, onClose }: { value: Range; onApply: (range: Range) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(value);
  const [month, setMonth] = useState(() => value.end.slice(0, 7));
  const [selectingEnd, setSelectingEnd] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { dialog.current?.showModal(); }, []);
  const first = civil(`${month}-01`), offset = (first.getUTCDay() + 6) % 7;
  const dayCount = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const shift = (delta: number) => { const result = new Date(first); result.setUTCMonth(result.getUTCMonth() + delta); setMonth(key(result).slice(0, 7)); };
  function choose(day: string) {
    setError('');
    if (!selectingEnd || day < draft.start) { setDraft({ start: day, end: day }); setSelectingEnd(true); return; }
    if ((civil(day).getTime() - civil(draft.start).getTime()) / 86400000 >= 31) { setError(t('يمكنك تحديد يوم واحد أو فترة حتى 31 يوماً.')); return; }
    setDraft({ start: draft.start, end: day }); setSelectingEnd(false);
  }
  return <dialog ref={dialog} className="payment-calendar-dialog" dir={direction()} onCancel={onClose} onClick={event => { if (event.target === dialog.current) { const rect = dialog.current.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose(); } }}>
    <div className="section-heading"><h2>{t('تحديد التاريخ')}</h2><button className="icon-button" title={t('إغلاق')} onClick={onClose}><X size={20} /></button></div>
    <div className="calendar-month-toolbar"><button className="text-button" onClick={() => { setDraft({ start: todayKey(), end: todayKey() }); setMonth(todayKey().slice(0, 7)); setSelectingEnd(false); setError(''); }}>{t('اليوم')}</button><div><button className="icon-button" title={t('الشهر السابق')} onClick={() => shift(-1)}><ChevronRight className="directional-icon" size={20} /></button><strong>{new Intl.DateTimeFormat(locale(), { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(first)}</strong><button className="icon-button" title={t('الشهر التالي')} disabled={month >= todayKey().slice(0, 7)} onClick={() => shift(1)}><ChevronLeft className="directional-icon" size={20} /></button></div></div>
    <div className="payment-calendar-grid" role="group" aria-label={t('تقويم المستحقات')}>{Array.from({ length: 7 }, (_, index) => <span className="calendar-weekday" key={`weekday-${index}`}>{new Intl.DateTimeFormat(locale(), { weekday: 'short', timeZone: 'UTC' }).format(civil(add('2026-10-05', index)))}</span>)}{Array.from({ length: offset }, (_, index) => <span key={`gap-${index}`} />)}{Array.from({ length: dayCount }, (_, index) => { const day = `${month}-${String(index + 1).padStart(2, '0')}`; const selected = day >= draft.start && day <= draft.end; return <button type="button" key={day} aria-label={dayLabel(day)} aria-pressed={selected} disabled={day > todayKey()} className={`${selected ? 'selected' : ''} ${day === draft.start || day === draft.end ? 'endpoint' : ''} ${day === todayKey() ? 'today' : ''}`} onClick={() => choose(day)}>{new Intl.NumberFormat(locale()).format(index + 1)}</button>; })}</div>
    <p className="calendar-range-label" aria-live="polite">{rangeLabel(draft)}</p><p className="calendar-hint"><Info size={17} />{t('يمكنك تحديد يوم واحد أو فترة حتى 31 يوماً.')}</p>{error && <p className="notice error" role="alert">{error}</p>}
    <div className="calendar-footer"><button className="secondary-button" onClick={() => { setDraft(week(todayKey())); setMonth(todayKey().slice(0, 7)); setSelectingEnd(false); setError(''); }}>{t('هذا الأسبوع')}</button><button className="primary-button" onClick={() => onApply(draft)}><Check size={18} />{t('تطبيق التاريخ')}</button></div>
  </dialog>;
}
