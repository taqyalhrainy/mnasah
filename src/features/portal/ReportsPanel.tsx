import { useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, BadgeCheck, Clock3, RefreshCw, ShieldAlert } from 'lucide-react';
import { date, request, type Booking } from '../../services/platformApi';
import { catalogText, t } from '../../i18n/preferences';

type LessonReport = {
  id: string;
  booking_id: string;
  category: string;
  note: string;
  status: 'pending' | 'upheld' | 'dismissed';
  automatic?: boolean;
  created: number;
  evidence?: Record<string, number>;
  booking?: Booking | null;
};

const categoryLabels: Record<string, string> = {
  teacher_absent: 'غياب الأستاذ', teacher_inactive: 'عدم تقديم الحصة', technical: 'مشكلة تقنية', conduct: 'سلوك غير مناسب', content: 'مشكلة بالمحتوى', other: 'أخرى',
};

export function ReportsPanel() {
  const [reports, setReports] = useState<LessonReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState('');
  useEffect(() => {
    let alive = true; setLoading(true); setError('');
    request<{ reports: LessonReport[] }>('admin/reports').then(result => { if (alive) setReports(result.reports || []); }).catch(cause => { if (alive) setError((cause as Error).message); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [revision]);
  async function resolve(event: FormEvent<HTMLFormElement>, report: LessonReport) {
    event.preventDefault(); setBusy(report.id); setError('');
    try { await request(`admin/reports/${report.id}/resolve`, Object.fromEntries(new FormData(event.currentTarget))); setRevision(value => value + 1); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(''); }
  }
  return <section className="reports-page">
    <header className="section-heading"><div><span className="section-kicker">{t('الجودة والحماية')}</span><h2>{t('شكاوى الحصص')}</h2><p>{t('سجل الحضور والأوقات والرسائل محفوظ مع كل شكوى لمراجعة عادلة.')}</p></div><button className="icon-button" title={t('تحديث')} onClick={() => setRevision(value => value + 1)}><RefreshCw size={19} /></button></header>
    {error && <p className="notice error" role="alert">{t(error)}</p>}
    {loading ? <div className="payment-loading"><span className="wake-spinner" />{t('جاري تحميل الشكاوى…')}</div> : !reports.length ? <div className="empty-state"><BadgeCheck size={34} /><h3>{t('لا توجد شكاوى')}</h3><p>{t('كل الحصص تسير بشكل طبيعي حالياً.')}</p></div> : <div className="report-list">{reports.map(report => <article className={`report-card ${report.status}`} key={report.id}>
      <header><span className="report-icon">{report.status === 'pending' ? <ShieldAlert size={21} /> : report.status === 'upheld' ? <AlertTriangle size={21} /> : <BadgeCheck size={21} />}</span><div><strong>{t(categoryLabels[report.category] || report.category)}</strong><small><Clock3 size={14} />{date(report.created)}{report.automatic ? ` · ${t('تلقائي')}` : ''}</small></div><span className={`badge ${report.status === 'pending' ? 'pending' : report.status === 'upheld' ? 'suspended' : 'active'}`}>{t(report.status === 'pending' ? 'قيد المراجعة' : report.status === 'upheld' ? 'مثبتة' : 'غير مثبتة')}</span></header>
      {report.booking && <div className="report-lesson"><strong>{catalogText(report.booking.subject)}</strong><span>{report.booking.teacher_name} · {report.booking.student_name}</span><time>{date(report.booking.start)}</time></div>}
      <p className="report-note">{report.note}</p>
      {report.evidence && <dl className="report-evidence"><div><dt>{t('دخول الأستاذ')}</dt><dd>{report.evidence.teacher_joined_at ? date(report.evidence.teacher_joined_at) : t('لم يدخل')}</dd></div><div><dt>{t('دخول الطالب')}</dt><dd>{report.evidence.student_joined_at ? date(report.evidence.student_joined_at) : t('لم يدخل')}</dd></div><div><dt>{t('رسائل الحصة')}</dt><dd>{report.evidence.message_count || 0}</dd></div></dl>}
      {report.status === 'pending' && <form className="report-resolution" onSubmit={event => void resolve(event, report)}><label>{t('القرار')}<select name="resolution" required><option value="">{t('اختر')}</option><option value="dismissed">{t('الشكوى غير مثبتة')}</option><option value="upheld">{t('الشكوى صحيحة')}</option></select></label><label>{t('الإجراء')}<select name="action" defaultValue="none"><option value="none">{t('بدون عقوبة')}</option><option value="warning">{t('تحذير')}</option><option value="suspend_7d">{t('إيقاف 7 أيام')}</option><option value="suspend_30d">{t('إيقاف 30 يوماً')}</option><option value="ban">{t('إيقاف دائم')}</option></select></label><label className="report-owner-note">{t('ملاحظة الأونر')}<textarea name="note" rows={2} maxLength={2000} /></label><button className="primary-button" disabled={busy === report.id}>{busy === report.id ? t('جاري الحفظ…') : t('اعتماد القرار')}</button></form>}
    </article>)}</div>}
  </section>;
}
