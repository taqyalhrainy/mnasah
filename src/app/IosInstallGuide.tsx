import { X } from 'lucide-react';
import { t, usePreferences } from '../i18n/preferences';

export function IosInstallGuide({ onClose }: { onClose: () => void }) {
  usePreferences();
  return <aside className="ios-install-guide" aria-label={t('شرح تثبيت التطبيق على الآيفون')}>
    <button type="button" className="ios-video-close" onClick={onClose} aria-label={t('إغلاق الشرح')}><X size={19} /></button>
    <div className="iphone-video-shell">
      <video
        src={`${import.meta.env.BASE_URL}videos/install-iphone-guide.webm`}
        autoPlay
        loop
        muted
        playsInline
        preload="auto"
        aria-label={t('فيديو تثبيت التطبيق على الآيفون')}
      />
    </div>
  </aside>;
}
