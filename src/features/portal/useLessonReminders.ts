import { t } from '../../i18n/preferences';
import { useEffect, useRef, useState } from 'react';
import { request, type Booking, type Portal } from '../../services/platformApi';

export function reminderPhase(booking: Pick<Booking, 'start' | 'status'>, now: number) {
  if (booking.status !== 'confirmed') return null;
  const remaining = booking.start - now;
  return remaining > 0 && remaining <= 15 * 60000 ? 'soon' : remaining <= 0 && remaining >= -5 * 60000 ? 'started' : null;
}
function readPreference(key: string) { try { return localStorage.getItem(key) === '1'; } catch { return false; } }

export function useLessonReminders(portal: Portal, userId: string, revision: number, roomId?: string) {
  const [now, setNow] = useState(Date.now);
  const [lessons, setLessons] = useState<Booking[]>([]);
  const key = `mansah:reminders:${userId}`;
  const [enabled, setEnabled] = useState(() => readPreference(key));
  const [hint, setHint] = useState('');
  const audio = useRef<AudioContext | null>(null);
  const seen = useRef(new Set<string>());
  const active = useRef(true);
  const lastSync = useRef(0);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; void audio.current?.close(); audio.current = null; };
  }, []);
  useEffect(() => {
    if (portal === 'admin') return;
    let alive = true, pending = false;
    const sync = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await request<{ bookings: Booking[] }>(`${portal}/reminders`);
        if (alive) { lastSync.current = Date.now(); setLessons(result.bookings); setNow(Date.now()); }
      } catch { if (alive) { setLessons([]); lastSync.current = 0; } }
      finally { pending = false; }
    };
    const visible = () => { if (document.visibilityState === 'visible') void sync(); };
    void sync();
    const poll = setInterval(sync, 30000);
    const clock = setInterval(() => setNow(Date.now()), 10000);
    document.addEventListener('visibilitychange', visible);
    return () => { alive = false; clearInterval(poll); clearInterval(clock); document.removeEventListener('visibilitychange', visible); };
  }, [portal, revision]);
  useEffect(() => {
    const unlock = () => {
      if (!enabled) return;
      try { audio.current ??= new AudioContext(); void audio.current.resume().catch(() => {}); } catch { /* Audio is optional on unsupported browsers. */ }
    };
    document.addEventListener('pointerdown', unlock);
    return () => document.removeEventListener('pointerdown', unlock);
  }, [enabled]);
  const upcoming = lessons.filter(b => b.id !== roomId && reminderPhase(b, now) && now - lastSync.current < 45000);
  useEffect(() => {
    if (!enabled || window.mansahCallActive) return;
    for (const lesson of upcoming) {
      const phase = reminderPhase(lesson, now)!;
      const noticeKey = `${lesson.id}:${lesson.start}:${phase}`;
      if (seen.current.has(noticeKey)) continue;
      seen.current.add(noticeKey);
      const send = async () => {
        if (!active.current) return;
        // Share delivery history between tabs and reloads; it is only a notification preference.
        const historyKey = `${key}:sent`;
        let history: Record<string, number> = {};
        try { history = JSON.parse(localStorage.getItem(historyKey) || '{}'); if (!history || typeof history !== 'object' || Array.isArray(history)) history = {}; } catch { /* Use this tab's deduplication when storage is unavailable. */ }
        if (history[noticeKey]) return;
        history = Object.fromEntries(Object.entries(history).filter(([, time]) => typeof time === 'number' && time > Date.now() - 86400000));
        history[noticeKey] = Date.now();
        try { localStorage.setItem(historyKey, JSON.stringify(history)); } catch { /* Private mode may block writes. */ }
        const title = phase === 'soon' ? t("اقترب موعد حصتك") : t("حان موعد حصتك");
        const body = phase === 'soon' ? t("{v0} تبدأ خلال {v1} دقيقة.", { v0: lesson.subject, v1: Math.ceil((lesson.start - now) / 60000) }) : t("{v0} بدأت الآن.", { v0: lesson.subject });
        const context = audio.current;
        if (context?.state === 'running') {
          const oscillator = context.createOscillator(), gain = context.createGain();
          oscillator.connect(gain); gain.connect(context.destination);
          oscillator.frequency.setValueAtTime(660, context.currentTime);
          oscillator.frequency.setValueAtTime(880, context.currentTime + .18);
          gain.gain.setValueAtTime(.0001, context.currentTime);
          gain.gain.exponentialRampToValueAtTime(.12, context.currentTime + .03);
          gain.gain.exponentialRampToValueAtTime(.0001, context.currentTime + .65);
          oscillator.start(); oscillator.stop(context.currentTime + .7);
          oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
        }
        if ('Notification' in window && Notification.permission === 'granted' && 'serviceWorker' in navigator) {
          try {
            const registration = await navigator.serviceWorker.getRegistration();
            if (registration && active.current) await registration.showNotification(title, { body, icon: '/icon.svg', tag: `mansah-${noticeKey}`, data: { url: `/${portal}?lesson=${encodeURIComponent(lesson.id)}` } });
          } catch { if (active.current) setHint(t("تعذر عرض إشعار الجهاز؛ تنبيه الحصة ظاهر داخل الموقع.")); }
        }
      };
      if (navigator.locks) void navigator.locks.request(`${key}:delivery`, send).catch(() => {});
      else void send();
    }
  }, [upcoming, now, enabled, key, portal]);
  async function toggle() {
    if (enabled) { setEnabled(false); setHint(''); try { localStorage.setItem(key, '0'); } catch {} return; }
    try { audio.current ??= new AudioContext(); void audio.current.resume().catch(() => {}); } catch {}
    let permission: NotificationPermission | 'unsupported' = 'unsupported';
    try { if ('Notification' in window) permission = await Notification.requestPermission(); } catch {}
    if (!active.current) return;
    setEnabled(true);
    setHint(permission === 'granted' ? t("تم تفعيل إشعارات الحصص.") : t("تنبيهات الموقع مفعلة؛ إشعارات الجهاز غير مسموحة أو غير مدعومة."));
    try { localStorage.setItem(key, '1'); } catch {}
  }
  return { now, upcoming, enabled, hint, toggle };
}
