import { useState } from 'react';
import { Gift } from 'lucide-react';
import { t } from '../../i18n/preferences';
import { request, type User } from '../../services/platformApi';
import './free-trial.css';

export function FreeTrialBadge({ free, banner = false }: { free: boolean; banner?: boolean }) {
  return <span className={`trial-status ${free ? 'trial-free' : 'trial-paid'} ${banner ? 'trial-banner' : ''}`}>
    {free && <Gift size={banner ? 21 : 15} aria-hidden="true" />}
    <span>{t(banner ? 'لديك حصة مجانية' : free ? 'هذا الأستاذ لديه حصة مجانية' : 'غير مجانية')}{banner && <small>{t('30 دقيقة مع أستاذ مشارك، في الموعد الذي يناسبك')}</small>}</span>
  </span>;
}

export function TeacherFreeTrialSettings({ user, onUser, onError }: { user: User; onUser: (user: User) => void; onError: (message: string) => void }) {
  const [saving, setSaving] = useState(false);
  const enabled = user.free_trial_enabled === true;
  return <section className="teacher-trial-settings">
    <div className="teacher-trial-heading"><Gift size={25} /><div><h3>{t('الحصة التجريبية المجانية')}</h3><p>{t('خيار اختياري لتتيح للطلاب الجدد تجربة التدريس معك لمدة 30 دقيقة.')}</p></div></div>
    <button type="button" role="switch" aria-checked={enabled} className="teacher-trial-switch" disabled={saving} onClick={async () => {
      setSaving(true);
      try { const result = await request<{ user: User }>('teachers/free-trial', { enabled: !enabled }); onUser(result.user); }
      catch (error) { onError((error as Error).message); }
      finally { setSaving(false); }
    }}><span className="trial-switch-track"><i /></span><strong>{t('تقديم حصة مجانية للطلاب الجدد')}</strong><span>{t(saving ? 'جاري الحفظ…' : enabled ? 'مفعّل' : 'غير مفعّل')}</span></button>
    <small>{t('حصة واحدة لكل طالب جديد. إيقاف الخيار يمنع الحجوزات المجانية الجديدة ولا يغيّر الحجوزات المؤكدة.')}</small>
  </section>;
}
