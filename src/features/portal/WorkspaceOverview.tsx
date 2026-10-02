import { useState } from 'react';
import { ArrowLeft, BookOpen, CalendarDays, CheckCheck, ChevronDown, Clock3, GraduationCap, Video } from 'lucide-react';
import { date, type Booking, type Portal, type User } from '../../services/platformApi';

export function WorkspaceOverview({ user, portal, bookings, availableCount, onView, compact = false }: {
  user: User; portal: Portal; bookings: Booking[]; availableCount: number; onView: (view: string) => void; compact?: boolean;
}) {
  const [weekExpanded, setWeekExpanded] = useState(false);
  const now = Date.now();
  const upcoming = bookings.filter(booking => booking.status === 'confirmed' && booking.start + booking.minutes * 60000 > now).sort((a, b) => a.start - b.start);
  const next = upcoming[0];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(today); day.setDate(today.getDate() + index);
    return { day, count: upcoming.filter(booking => new Date(booking.start).toDateString() === day.toDateString()).length };
  });
  const completed = bookings.filter(booking => booking.status === 'completed').length;
  const teacher = portal === 'teachers';
  function openNext() {
    if (!next && !teacher) {
      document.getElementById('learning-path')?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
      return;
    }
    onView(next ? 'rooms' : 'available');
  }
  const metrics = [
    { label: teacher ? 'حصص اليوم' : 'حصص قادمة', value: teacher ? upcoming.filter(booking => new Date(booking.start).toDateString() === today.toDateString()).length : upcoming.length, icon: CalendarDays },
    { label: 'حصص مكتملة', value: completed, icon: CheckCheck },
    { label: teacher ? 'مواعيد متاحة' : 'أساتذة متاحون', value: availableCount, icon: teacher ? Clock3 : GraduationCap },
  ];
  return <section className={`workspace-overview ${compact ? 'overview-rail' : ''}`} aria-label="ملخص حسابك">
    {!compact && <div className="welcome-heading"><div><span className="overview-kicker">{teacher ? 'جدولك اليوم' : 'رحلتك التعليمية'}</span><h2>أهلاً، {user.name.trim().split(/\s+/)[0]}<span className="greeting-dot">.</span></h2><p>{teacher ? 'حصصك ومواعيدك، في مكان واحد.' : 'جاهز لخطوتك القادمة؟'}</p></div><button className="primary-button" onClick={() => onView(teacher ? 'available' : 'rooms')}>{teacher ? <CalendarDays size={17} /> : <Video size={17} />}{teacher ? 'إضافة موعد' : 'غرف حصصي'}<ArrowLeft size={16} /></button></div>}
    <div className="overview-metrics">{metrics.map(({ label, value, icon: Icon }, index) => <div className={`overview-metric metric-${index}`} key={label}><span className="metric-icon"><Icon size={21} strokeWidth={1.7} /></span><div><span>{label}</span><strong>{value.toLocaleString('ar-JO')}</strong></div></div>)}</div>
    <div className="overview-schedule">
      <article className={`next-lesson ${!next ? 'no-next-lesson' : ''}`}>
        <div className="next-lesson-body"><span className="next-lesson-kicker"><span />{next ? 'حصتك القادمة' : teacher ? 'مساحتك للتدريس' : 'مساحتك للتعلّم'}</span><h3>{next?.subject || (teacher ? 'افتح موعدك القادم' : 'الحصة الأولى تبدأ باختيارك')}</h3><p>{next ? `${teacher ? next.student_name : next.teacher_name} · ${date(next.start)}` : teacher ? 'مواعيدك المتاحة هي بداية حصصك القادمة.' : 'اختر مجالك من الأقسام أدناه.'}</p><button className="primary-button" onClick={openNext}>{next ? <Video size={17} /> : <BookOpen size={17} />}{next ? 'عرض الغرفة' : teacher ? 'إضافة موعد' : 'استكشف المجالات'}<ArrowLeft size={16} /></button></div>
        <div className="next-lesson-mark" aria-hidden="true">{next ? <><strong>{new Date(next.start).toLocaleDateString('ar-JO', { day: 'numeric' })}</strong><span>{new Date(next.start).toLocaleDateString('ar-JO', { month: 'short' })}</span><small>{next.minutes} دقيقة</small></> : <GraduationCap size={72} strokeWidth={1} />}</div>
      </article>
      <section className={`week-agenda ${weekExpanded ? 'expanded' : ''}`} aria-label="حصص الأسبوع"><div className="section-heading"><h3>أسبوعك</h3><div className="agenda-actions"><button className="icon-button agenda-toggle" title={weekExpanded ? 'طي أيام الأسبوع' : 'عرض أيام الأسبوع'} aria-expanded={weekExpanded} onClick={() => setWeekExpanded(value => !value)}><ChevronDown size={18} /></button><button className="icon-button" title="عرض جدول الحصص" onClick={() => onView(teacher ? 'booked' : 'rooms')}><ArrowLeft size={18} /></button></div></div><div className="agenda-days">{days.map(({ day, count }, index) => <div className={index === 0 ? 'agenda-day today' : 'agenda-day'} key={day.getTime()}><span>{day.toLocaleDateString('ar-JO', { weekday: 'short' })}</span><strong>{day.toLocaleDateString('ar-JO', { day: 'numeric' })}</strong><i className={count ? 'has-lessons' : ''} title={`${count} حصة`} /></div>)}</div><div className="agenda-footer"><CalendarDays size={16} /><span>{upcoming.filter(booking => booking.start < days[6].day.getTime() + 86400000).length} حصص خلال الأيام السبعة القادمة</span></div></section>
    </div>
  </section>;
}

export function WorkspaceSkeleton() {
  return <div className="workspace-skeleton" role="status" aria-label="جارٍ تحميل البيانات"><span className="sr-only">جارٍ تحميل البيانات…</span><div /><div className="skeleton-row"><span /><span /><span /></div><div /><div className="skeleton-row"><span /><span /><span /></div></div>;
}
