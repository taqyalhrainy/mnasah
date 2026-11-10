import { useRef } from 'react';
import { Share, X } from 'lucide-react';
import { t, usePreferences } from '../i18n/preferences';

export function IosInstallGuide({ onClose }: { onClose: () => void }) {
  usePreferences();
  const videoRef = useRef<HTMLVideoElement>(null);
  const steps = [t('افتح المنصة في Safari، ثم اضغط مشاركة.'), t('اختر إضافة إلى الشاشة الرئيسية من قائمة المشاركة.'), t('اضغط إضافة أعلى الشاشة لتأكيد التثبيت.'), t('افتح امتداد العلم من الأيقونة على شاشتك الرئيسية.')];
  return <dialog ref={node => { if (node && !node.open) node.showModal(); }} onCancel={onClose} className="ios-install-guide ios-guide-v2" aria-label={t('شرح تثبيت التطبيق على الآيفون')}>
    <header><div><small>iPhone · Safari</small><h2>{t('ثبّت المنصة في أربع خطوات')}</h2></div></header>
    <button type="button" className="ios-video-close" onClick={onClose} aria-label={t('إغلاق الشرح')}><X size={19} /></button>
    <div className="ios-guide-v2-layout"><div className="iphone-video-shell">
      <video
        ref={videoRef}
        controls
        autoPlay
        muted
        playsInline
        preload="metadata"
        aria-label={t('فيديو تثبيت التطبيق على الآيفون')}
      ><source src={`${import.meta.env.BASE_URL}videos/install-iphone-guide-v3.mp4`} type="video/mp4" /></video>
    </div><div className="ios-guide-instructions"><ol>{steps.map((step, index) => <li key={step}><button type="button" onClick={() => { const video = videoRef.current; if (video) { video.currentTime = index * 4; void video.play().catch(() => undefined); } }}><b>{index + 1}</b><span>{step}</span></button></li>)}</ol><p><Share size={18} />{t('إذا لم يظهر زر المشاركة، افتح قائمة المزيد (…) في Safari.')}</p><p>{t('إذا لم يظهر خيار الإضافة، مرّر القائمة أو افتح تعديل الإجراءات.')}</p><a href="https://support.apple.com/en-eg/guide/iphone/iphea86e5236/ios" target="_blank" rel="noreferrer">{t('شرح Apple الرسمي')}</a></div></div>
  </dialog>;
}
