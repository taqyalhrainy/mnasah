import { BellRing } from 'lucide-react';
import { t } from '../i18n/preferences';

export function NotificationPermissionHelp({ busy, hint, onCheck }: { busy: boolean; hint: string; onCheck: () => void }) {
  const android = /Android/i.test(navigator.userAgent);
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return <div className="notification-help-backdrop">
    <dialog open className="notification-help" aria-modal="true" aria-labelledby="notification-help-title" onKeyDown={event => { if (event.key === 'Escape') event.preventDefault(); }} onCancel={event => event.preventDefault()}>
      <BellRing size={30} /><h2 id="notification-help-title">{t('السماح بالإشعارات مجدداً')}</h2>
      <p>{t('تم حظر الإذن سابقاً. المتصفح يحتاج تغيير الإذن من إعداداته قبل أن يستطيع الموقع طلبه مجدداً.')}</p>
      <code dir="ltr">{location.hostname}</code>
      <ol>{ios ? <>
        <li>{t('افتح إعدادات iPhone، ثم الإشعارات، ثم امتداد العلم.')}</li>
        <li>{t('فعّل السماح بالإشعارات، ثم ارجع للتطبيق من الشاشة الرئيسية.')}</li>
      </> : <>
        <li>{t(android ? 'في Chrome: افتح ⋮ ثم الإعدادات ثم إعدادات المواقع ثم الإشعارات.' : 'اضغط رمز إعدادات الموقع بجانب الرابط، ثم أذونات الموقع ثم الإشعارات.')}</li>
        <li>{t('اختر هذا الموقع وغيّر الإشعارات إلى سماح، ثم ارجع إليه.')}</li>
      </>}</ol>
      <p>{t('نتحقق تلقائياً عند رجوعك. ويمكنك التحقق الآن بعد تغيير الإذن.')}</p>
      {hint && <p className="notification-permission-status" role="status">{t(hint)}</p>}
      <button type="button" autoFocus className="primary-button" disabled={busy} onClick={onCheck}>{t('تحقق مرة أخرى')}</button>
      <a href="https://support.google.com/chrome/answer/3220216" target="_blank" rel="noreferrer">{t('مساعدة إعدادات الإشعارات')}</a>
    </dialog>
  </div>;
}
