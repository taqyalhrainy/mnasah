import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUpRight, Copy } from 'lucide-react';

export function ExternalBrowserGate({ children }: { children: ReactNode }) {
  const ua = navigator.userAgent;
  const installed = matchMedia('(display-mode: standalone)').matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
  const embedded = !installed && /Android|iPhone|iPad|iPod/i.test(ua) && /Instagram|FBAN|FBAV|FB_IAB|TikTok|musical_ly|BytedanceWebview|Line\/|Snapchat|Twitter|LinkedInApp|; wv\)/i.test(ua);
  const [stay, setStay] = useState(false);
  const [copied, setCopied] = useState(false);
  const attempted = useRef(false);
  const english = document.documentElement.lang === 'en';
  function openBrowser() {
    const url = new URL(location.href);
    if (/Android/i.test(ua)) {
      location.href = `intent://${url.host}${url.pathname}${url.search}${url.hash}#Intent;scheme=https;package=com.android.chrome;action=android.intent.action.VIEW;S.browser_fallback_url=${encodeURIComponent(url.href)};end`;
    } else {
      location.href = `x-safari-https://${url.host}${url.pathname}${url.search}${url.hash}`;
    }
  }
  useEffect(() => {
    if (!embedded || attempted.current) return;
    attempted.current = true;
    // Apps may require a real tap for an external-app launch. Leave the button
    // visible if automatic handoff is blocked, and never refresh in a loop.
    try {
      const key = `emtidad-browser-handoff:${location.href}`;
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, '1');
      openBrowser();
    } catch { /* The visible button remains available. */ }
  }, [embedded]);
  if (!embedded || stay) return children;
  return <main className="loading-page wake-page" dir={english ? 'ltr' : 'rtl'}><section className="wake-card" style={{ maxWidth: 420, textAlign: 'center', padding: 28 }}>
    <img src={`${import.meta.env.BASE_URL}images/emtidad-alelm-final-logo-192.png`} width="76" height="76" alt="Emtidad Al Elm" style={{ borderRadius: '50%' }} />
    <h1>{english ? 'Open Emtidad in your browser' : 'افتح امتداد العلم بالمتصفح'}</h1>
    <p>{english ? 'For reliable calls, camera and microphone access, continue in Safari or Chrome.' : 'لأفضل تجربة للمكالمات والكاميرا والمايك، افتح المنصة في Safari أو Chrome.'}</p>
    <button className="primary-button" onClick={openBrowser} style={{ width: '100%', justifyContent: 'center' }}><ArrowUpRight size={20} />{english ? 'Open in browser' : 'فتح في المتصفح'}</button>
    <p style={{ fontSize: 14 }}>{english ? 'If the app blocks opening: tap ⋯ or Share, then Open in browser.' : 'إذا التطبيق منع الفتح، اضغط ⋯ أو مشاركة، ثم «فتح في المتصفح».'}</p>
    <button className="text-button" onClick={async () => { try { await navigator.clipboard.writeText(location.href); setCopied(true); } catch { /* Use the app share menu instead. */ } }}><Copy size={16} />{copied ? (english ? 'Link copied' : 'تم نسخ الرابط') : (english ? 'Copy link' : 'نسخ الرابط')}</button>
    <button className="text-button" onClick={() => setStay(true)}>{english ? 'Continue here' : 'المتابعة هنا'}</button>
  </section></main>;
}
