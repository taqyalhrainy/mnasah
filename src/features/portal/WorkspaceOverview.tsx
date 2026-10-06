import { t, locale, usePreferences, catalogText } from '../../i18n/preferences';
import { useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft, BookOpen, CalendarDays, CheckCheck, ChevronDown, Clock3, GraduationCap, Sparkles, Video } from 'lucide-react';
import { date, type Booking, type Portal, type User } from '../../services/platformApi';

const greetedDuringThisVisit = new Set<string>();

export function WorkspaceOverview({ user, portal, bookings, availableCount, onView, compact = false, children }: {
  user: User; portal: Portal; bookings: Booking[]; availableCount: number; onView: (view: string) => void; compact?: boolean; children?: ReactNode;
}) {
  usePreferences();
  const [weekExpanded, setWeekExpanded] = useState(false);
  const greetingKey = `${portal}:${user.id}`;
  const [stage, setStage] = useState<'hello' | 'question' | 'ready'>(() => greetedDuringThisVisit.has(greetingKey) ? 'ready' : 'hello');
  useEffect(() => {
    if (stage === 'ready') return;
    greetedDuringThisVisit.add(greetingKey);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { setStage('ready'); return; }
    const questionTimer = window.setTimeout(() => setStage(current => current === 'ready' ? 'ready' : 'question'), 1350);
    const readyTimer = window.setTimeout(() => setStage('ready'), 2700);
    return () => { window.clearTimeout(questionTimer); window.clearTimeout(readyTimer); };
  }, [greetingKey]);
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
    { label: teacher ? t("حصص اليوم") : t("حصص قادمة"), value: teacher ? upcoming.filter(booking => new Date(booking.start).toDateString() === today.toDateString()).length : upcoming.length, icon: CalendarDays },
    { label: t("حصص مكتملة"), value: completed, icon: CheckCheck },
    { label: teacher ? t("مواعيد متاحة") : t("أساتذة متاحون"), value: availableCount, icon: teacher ? Clock3 : GraduationCap },
  ];
  return <section className={`workspace-overview ${compact ? 'overview-rail' : ''}`} aria-label={t("ملخص حسابك")}>
    <section className={`home-showcase stage-${stage}`} aria-live="polite">
      {stage !== 'ready' ? <div className="home-intro" key={stage}>
        <Sparkles className="home-intro-spark" size={27} aria-hidden="true" />
        {stage === 'hello' ? <h2><span>{teacher ? t('أهلاً يا أستاذ') : t('أهلاً يا')}</span><strong>{user.name.trim().split(/\s+/)[0]}</strong></h2> : <h2><span>{t('نورتنا')}</span><strong>{teacher ? t('شو حاب تدرّس؟') : t('شو حاب تتعلّم؟')}</strong></h2>}
        <button type="button" className="home-skip" onClick={() => setStage('ready')}>{t('تخطي')}</button>
      </div> : <div className="home-stage-content">{children}</div>}
    </section>
    <div className="overview-metrics" id={`week-metrics-${portal}`}>{metrics.map(({ label, value, icon: Icon }, index) => <div className={`overview-metric metric-${index}`} key={label}><span className="metric-icon"><Icon size={22} strokeWidth={1.8} /></span><div><span>{t(label)}</span><strong>{value.toLocaleString(locale())}</strong></div></div>)}</div>
    <div className="overview-schedule">
      <article className={`next-lesson ${!next ? 'no-next-lesson' : ''}`}>
        <div className="next-lesson-body"><span className="next-lesson-kicker"><span />{next ? next.start <= now ? t("حصة جارية") : t("على جدولك") : t("جدولك مفتوح")}</span><h3>{next ? catalogText(next.subject) : t("لا توجد حصص قادمة")}</h3><p>{next ? `${teacher ? next.student_name : next.teacher_name} · ${date(next.start)}` : teacher ? t("مواعيد متاحة: ") + availableCount : t("أساتذة متاحون: ") + availableCount}</p></div>
        <div className="next-lesson-mark" aria-hidden="true">{next ? <><strong>{new Date(next.start).toLocaleDateString(locale(), { day: 'numeric' })}</strong><span>{new Date(next.start).toLocaleDateString(locale(), { month: 'short' })}</span><small>{next.minutes}{t(" دقيقة")}</small></> : <GraduationCap size={72} strokeWidth={1} />}</div>
        <button className="primary-button" onClick={openNext}>{next ? <Video size={18} /> : <BookOpen size={18} />}{next ? t("عرض الغرفة") : teacher ? t("إضافة موعد") : t("استكشف المجالات")}<ArrowLeft size={17} /></button>
      </article>
      <section className={`week-agenda ${weekExpanded ? 'expanded' : ''}`} aria-label={t("حصص الأسبوع")}><div className="section-heading"><h3>{t("أسبوعك")}</h3><div className="agenda-actions"><button className="icon-button agenda-toggle" title={weekExpanded ? t("طي ملخّص الأسبوع") : t("عرض ملخّص الأسبوع")} aria-expanded={weekExpanded} aria-controls={`weekly-summary-${portal} week-metrics-${portal}`} onClick={() => setWeekExpanded(value => !value)}><ChevronDown size={18} /></button><button className="icon-button" title={t("عرض جدول الحصص")} onClick={() => onView(teacher ? 'booked' : 'rooms')}><ArrowLeft size={18} /></button></div></div><div className="agenda-days" id={`weekly-summary-${portal}`}>{days.map(({ day, count }, index) => <div className={index === 0 ? 'agenda-day today' : 'agenda-day'} key={day.getTime()}><span>{day.toLocaleDateString(locale(), { weekday: 'short' })}</span><strong>{day.toLocaleDateString(locale(), { day: 'numeric' })}</strong><i className={count ? 'has-lessons' : ''} title={t("{v0} حصة", { v0: count })} /></div>)}</div><div className="agenda-footer"><CalendarDays size={16} /><span>{upcoming.filter(booking => booking.start < days[6].day.getTime() + 86400000).length}{t(" حصص خلال الأيام السبعة القادمة")}</span></div></section>
    </div>
  </section>;
}

export function WorkspaceSkeleton() {
  usePreferences();
  return <div className="workspace-skeleton" role="status" aria-label={t("جارٍ تحميل البيانات")}><span className="sr-only">{t("جارٍ تحميل البيانات…")}</span><div /><div className="skeleton-row"><span /><span /><span /></div><div /><div className="skeleton-row"><span /><span /><span /></div></div>;
}
