import { useEffect, useState, type FormEvent } from 'react';
import { Archive, ArchiveRestore, BookOpen, Clock3, PackageCheck, Pencil, Plus, Save, Users } from 'lucide-react';
import { catalogText, t, usePreferences } from '../../i18n/preferences';
import { money, request, type LessonPackage } from '../../services/platformApi';

const durations = [30, 45, 60, 90, 120];
const validityOptions = [30, 60, 90, 180, 365];

export function LessonPackagesPanel({ subjects }: { subjects: string[] }) {
  usePreferences();
  const [packages, setPackages] = useState<LessonPackage[]>([]);
  const [editing, setEditing] = useState<LessonPackage | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const load = () => {
    setLoading(true);
    return request<{ packages: LessonPackage[] }>('teachers/lesson-packages')
      .then(result => setPackages(result.packages))
      .catch(cause => setError((cause as Error).message))
      .finally(() => setLoading(false));
  };
  useEffect(() => { void load(); }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const selectedSubjects = data.getAll('subjects').map(String);
    if (!selectedSubjects.length) { setError(t('اختر مادة واحدة على الأقل للباقة.')); return; }
    setBusy(true); setError(''); setSuccess('');
    try {
      await request('teachers/lesson-packages', {
        ...(editing ? { id: editing.id } : {}),
        name: String(data.get('name') || ''),
        description: String(data.get('description') || ''),
        subjects: selectedSubjects,
        lesson_count: Number(data.get('lesson_count')),
        minutes: Number(data.get('minutes')),
        price: Math.round(Number(data.get('price')) * 100),
        validity_days: Number(data.get('validity_days')),
      });
      form.reset(); setEditing(null); setSuccess(t(editing ? 'تم تحديث الباقة.' : 'تم نشر الباقة وأصبحت متاحة للطلاب.'));
      await load();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function toggle(item: LessonPackage) {
    setBusy(true); setError(''); setSuccess('');
    try {
      const action = item.status === 'active' ? 'archive' : 'activate';
      await request(`teachers/lesson-packages/${item.id}/${action}`, {});
      setSuccess(t(action === 'archive' ? 'تم إيقاف عرض الباقة للطلاب.' : 'تم تفعيل الباقة من جديد.'));
      await load();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  return <section className="student-page lesson-package-manager">
    <header className="lesson-package-hero"><div><span><PackageCheck size={17} />{t('باقاتك التعليمية')}</span><h2>{t('حوّل خبرتك إلى باقة واضحة')}</h2><p>{t('حدد عدد الحصص ومدة كل حصة والسعر. الطالب يدفع مرة واحدة ويحجز لاحقاً من مواعيدك المتاحة.')}</p></div><strong>{packages.filter(item => item.status === 'active').length}<small>{t('باقات فعّالة')}</small></strong></header>
    {error && <p className="notice error" role="alert">{t(error)}</p>}{success && <p className="notice success" role="status">{t(success)}</p>}
    <div className="lesson-package-layout">
      <form className="work-form lesson-package-form" onSubmit={save} key={editing?.id || 'new'}>
        <div className="section-heading"><div><span className="section-kicker">{editing ? t('تعديل الباقة') : t('باقة جديدة')}</span><h3>{editing ? editing.name : t('صمّم عرضاً يناسب طلابك')}</h3></div>{editing && <button type="button" className="text-button" onClick={() => setEditing(null)}>{t('إلغاء التعديل')}</button>}</div>
        <label>{t('اسم الباقة')}<input name="name" maxLength={100} defaultValue={editing?.name || ''} placeholder={t('مثلاً: تأسيس الرياضيات خلال شهر')} required /></label>
        <label>{t('وصف مختصر')}<textarea name="description" maxLength={500} rows={3} defaultValue={editing?.description || ''} placeholder={t('اشرح للطالب ماذا سيحقق في نهاية الباقة.')} /></label>
        <fieldset className="lesson-package-subjects"><legend>{t('المواد التي تغطيها الباقة')}</legend>{subjects.length ? subjects.map(subject => <label key={subject}><input type="checkbox" name="subjects" value={subject} defaultChecked={editing?.subjects.includes(subject)} />{catalogText(subject)}</label>) : <p>{t('احفظ موادك من الصفحة الرئيسية أولاً.')}</p>}</fieldset>
        <div className="lesson-package-numbers"><label>{t('عدد الحصص')}<input name="lesson_count" type="number" min="2" max="60" defaultValue={editing?.lesson_count || 8} required /></label><label>{t('مدة الحصة')}<select name="minutes" defaultValue={editing?.minutes || 60}>{durations.map(value => <option value={value} key={value}>{value} {t('دقيقة')}</option>)}</select></label><label>{t('سعر الباقة بالدينار')}<input name="price" type="number" min="1" max="10000" step="0.01" defaultValue={editing ? editing.price / 100 : ''} required /></label><label>{t('صلاحية الاستخدام')}<select name="validity_days" defaultValue={editing?.validity_days || 90}>{validityOptions.map(value => <option value={value} key={value}>{value} {t('يوماً')}</option>)}</select></label></div>
        <button className="primary-button" disabled={busy || !subjects.length}>{editing ? <Save size={17} /> : <Plus size={17} />}{t(editing ? 'حفظ التعديلات' : 'نشر الباقة')}</button>
      </form>
      <div className="teacher-package-list">
        <div className="section-heading"><div><span className="section-kicker">{t('إدارة الباقات')}</span><h3>{t('باقاتك المنشورة')}</h3></div></div>
        {loading ? <p className="muted">{t('جارٍ تحميل الباقات…')}</p> : !packages.length ? <div className="empty-state"><PackageCheck size={34} /><p>{t('لم تنشئ أي باقة بعد. ابدأ بأول باقة من النموذج.')}</p></div> : packages.map(item => <article className={`teacher-package-card ${item.status}`} key={item.id}>
          <div className="teacher-package-card-head"><span className="package-symbol"><PackageCheck size={22} /></span><div><strong>{item.name}</strong><small>{item.subjects.map(catalogText).join('، ')}</small></div><span className={`badge ${item.status === 'active' ? 'active' : 'cancelled'}`}>{t(item.status === 'active' ? 'فعّالة' : 'موقوفة')}</span></div>
          {item.description && <p>{item.description}</p>}
          <dl><div><dt><BookOpen size={15} />{t('الحصص')}</dt><dd>{item.lesson_count}</dd></div><div><dt><Clock3 size={15} />{t('المدة')}</dt><dd>{item.minutes} {t('دقيقة')}</dd></div><div><dt>{t('السعر')}</dt><dd>{money(item.price)}</dd></div><div><dt><Users size={15} />{t('طلاب نشطون')}</dt><dd>{item.active_students || 0}</dd></div></dl>
          <footer><small>{t('تم شراؤها {v0} مرة', { v0: item.sold_count || 0 })}</small><div><button className="secondary-button" disabled={busy} onClick={() => setEditing(item)}><Pencil size={16} />{t('تعديل')}</button><button className="secondary-button" disabled={busy} onClick={() => void toggle(item)}>{item.status === 'active' ? <Archive size={16} /> : <ArchiveRestore size={16} />}{t(item.status === 'active' ? 'إيقاف الباقة' : 'إعادة التفعيل')}</button></div></footer>
        </article>)}
      </div>
    </div>
  </section>;
}
