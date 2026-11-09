import { useEffect, useRef, useState } from 'react';
import { devicePushEnabled, ensureDevicePush, removeDevicePush, testDevicePush } from './pushNotifications';
import type { Portal } from './platformApi';
const notificationError = (error: unknown) => {
  const message = (error as Error)?.message || '';
  return /[\u0600-\u06ff]/.test(message) ? message : 'تعذر تفعيل تنبيهات الجهاز. تحقق من الاتصال وإذن التنبيهات، ثم حاول مجددًا.';
};

export function useDeviceNotifications(portal: Portal, userId?: string) {
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState('');
  const [checked, setChecked] = useState(false);
  const syncVersion = useRef(0);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() => 'Notification' in window ? Notification.permission : 'unsupported');
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const isAndroid = /Android/i.test(navigator.userAgent);
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isDesktop = !isAndroid && !isIos;
  useEffect(() => {
    let alive = true;
    setEnabled(false); setHint(''); setChecked(false);
    if (!userId) return;
    const sync = async () => {
      const version = ++syncVersion.current;
      setPermission('Notification' in window ? Notification.permission : 'unsupported');
      try {
        let value = await devicePushEnabled(portal);
        if (!value && 'Notification' in window && Notification.permission === 'granted') value = await ensureDevicePush(portal);
        if (alive && version === syncVersion.current) { setEnabled(value); setChecked(true); }
      } catch { /* Keep the last known state; an offline device has not revoked permission. */ }
    };
    const visible = () => { if (document.visibilityState === 'visible') sync(); };
    sync(); document.addEventListener('visibilitychange', visible);
    return () => { alive = false; document.removeEventListener('visibilitychange', visible); };
  }, [portal, userId]);
  async function toggle() {
    if (!userId || busy) return;
    setBusy(true); setHint('');
    ++syncVersion.current;
    try {
      if (enabled) {
        await removeDevicePush(portal); setEnabled(false); setHint('تم إيقاف تنبيهات هذا الجهاز.'); return;
      }
      // Keep the OS permission request in the original button's user activation.
      const ready = await ensureDevicePush(portal, true);
      setPermission('Notification' in window ? Notification.permission : 'unsupported');
      setEnabled(ready);
      if (ready) setHint('تم تفعيل التنبيهات على هذا الجهاز، حتى عند إغلاق التطبيق.');
      else if ('Notification' in window && Notification.permission === 'denied') setHint('إذن التنبيهات مرفوض. فعّله من إعدادات التنبيهات في الهاتف، ثم حاول مجددًا.');
      else if (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) setHint('افتح التطبيق من أيقونته على الشاشة الرئيسية. تنبيهات الآيفون تحتاج iOS 16.4 أو أحدث.');
      else setHint('لم تُفعّل تنبيهات الجهاز. وافق على الإذن، أو افتح التطبيق المثبّت من Chrome وحاول مجددًا.');
    } catch (error) { setPermission('Notification' in window ? Notification.permission : 'unsupported'); setEnabled(false); setHint(notificationError(error)); }
    finally { setBusy(false); }
  }
  async function test() {
    if (!enabled || busy) return;
    setBusy(true); setHint('');
    try { await testDevicePush(portal); setHint('تم إرسال الإشعار التجريبي لهذا الجهاز.'); }
    catch (error) { setHint(notificationError(error)); }
    finally { setBusy(false); }
  }
  return { enabled, busy, hint, checked, permission, supported, isAndroid, isDesktop, needsPermission: checked && !enabled && permission !== 'granted', toggle, test };
}
