import { useEffect, useState } from 'react';
import { Check, Plus, RotateCcw, Share, Smartphone, X } from 'lucide-react';
import { t, usePreferences } from '../i18n/preferences';

const steps = [
  { title: 'افتح المنصة في Safari', text: 'افتح رابط بوابة الطالب أو الأستاذ باستخدام Safari على الآيفون.' },
  { title: 'اضغط زر المشاركة', text: 'من شريط Safari اضغط أيقونة المشاركة الموجودة أسفل الشاشة.' },
  { title: 'اختر إضافة إلى الشاشة الرئيسية', text: 'مرّر قائمة المشاركة قليلاً ثم اضغط «إضافة إلى الشاشة الرئيسية».' },
  { title: 'اضغط إضافة', text: 'سيظهر تطبيق امتداد العلم على شاشة هاتفك ويفتح مباشرة مثل أي تطبيق.' },
] as const;

export function IosInstallGuide({ onClose }: { onClose: () => void }) {
  usePreferences();
  const [step, setStep] = useState(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    const timer = window.setInterval(() => setStep(value => (value + 1) % steps.length), 2600);
    return () => window.clearInterval(timer);
  }, [paused]);
  const current = steps[step];
  return <aside className="ios-install-guide" aria-label={t('شرح تثبيت التطبيق على الآيفون')} onPointerEnter={() => setPaused(true)} onPointerLeave={() => setPaused(false)}>
    <header><div><span><Smartphone size={17} />{t('تثبيت على iPhone')}</span><h2>{t('حوّل المنصة إلى تطبيق')}</h2></div><button type="button" onClick={onClose} aria-label={t('إغلاق الشرح')}><X size={20} /></button></header>
    <div className="ios-guide-layout">
      <div className={`iphone-demo step-${step}`} aria-hidden="true">
        <div className="iphone-frame"><div className="iphone-island" /><div className="iphone-status"><b>9:41</b><span>5G&nbsp; ▰</span></div><div className="iphone-screen">
          {step < 3 ? <><div className="iphone-site"><div className="iphone-site-brand">M</div><strong>{t('امتداد العلم')}</strong><small>{t('منصة تعليم خصوصي')}</small><div className="iphone-site-card" /><div className="iphone-site-lines"><i /><i /><i /></div></div><div className="safari-bar"><span>امتداد العلم</span><button className={step === 1 ? 'is-focus' : ''}><Share size={18} /></button></div></> : <div className="iphone-home"><div className="home-wallpaper" /><div className="home-app"><span><img src={`${import.meta.env.BASE_URL}images/emtidad-alelm-final-logo-192.png`} alt="" /></span><small>{t('امتداد العلم')}</small></div><div className="home-dock"><i /><i /><i /><i /></div></div>}
          {step === 0 && <div className="safari-hint"><span>Safari</span><Check size={15} /></div>}
          {step === 2 && <div className="ios-share-sheet"><i /><strong>{t('إضافة إلى الشاشة الرئيسية')}</strong><Plus size={18} /></div>}
          {step === 3 && <div className="installed-pop"><Check size={18} />{t('تم تثبيت التطبيق')}</div>}
        </div><div className="iphone-home-indicator" /></div>
      </div>
      <div className="ios-guide-copy" aria-live="polite"><span>{t('الخطوة {v0} من 4', { v0: step + 1 })}</span><h3>{t(current.title)}</h3><p>{t(current.text)}</p><div className="ios-guide-progress">{steps.map((_, index) => <button type="button" key={index} className={index === step ? 'active' : ''} aria-label={t('عرض الخطوة {v0}', { v0: index + 1 })} onClick={() => { setStep(index); setPaused(true); }} />)}</div><button type="button" className="ios-guide-replay" onClick={() => { setStep(0); setPaused(false); }}><RotateCcw size={15} />{t('إعادة الشرح')}</button></div>
    </div>
  </aside>;
}
