import { t } from '../../i18n/preferences';
import { useCallback, useEffect, useRef, useState } from 'react';
import { request, type Portal, type User } from '../../services/platformApi';
import type { ChatSettings, ChatThread } from './chatTypes';

const defaults: ChatSettings = { readReceipts: true, showPresence: true, notifications: true, sounds: false };
export function useDirectChat(portal: Portal, user: User | null, active: boolean, onOpen: () => void) {
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [settings, setSettings] = useState<ChatSettings>(defaults);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [typingUpdates, setTypingUpdates] = useState<Record<string, boolean>>({});
  const notified = useRef<Map<string, string> | null>(null);
  const savingSettings = useRef(false);
  const refreshVersion = useRef(0);
  const current = useRef({ active, selected, onOpen, user });
  current.current = { active, selected, onOpen, user };
  const enabled = Boolean(user?.status === 'active' && portal !== 'admin' && user?.role === portal && !user?.mustChangePassword);
  const refresh = useCallback(async () => {
    if (!enabled) return;
    const requestedUserId = current.current.user?.id;
    const version = ++refreshVersion.current;
    try {
      const data = await request<{ threads: ChatThread[]; settings: ChatSettings }>(`${portal}/chat/threads`);
      if (current.current.user?.id !== requestedUserId || version !== refreshVersion.current) return;
      const rows = Array.isArray(data.threads) ? data.threads : [];
      const preferences = data.settings || defaults;
      if (notified.current) {
        for (const row of rows) {
          const last = row.lastMessage;
          if (!last || last.id === notified.current.get(row.id) || last.author_id === current.current.user?.id || !row.unread || row.hidden || row.unavailable || row.muted || !preferences.notifications) continue;
          if (current.current.active && current.current.selected === row.id && document.visibilityState === 'visible') continue;
          if (document.visibilityState !== 'visible' && 'Notification' in window && Notification.permission === 'granted') {
            const voice = last.attachments?.length === 1 && last.attachments[0].preview_type.startsWith('audio/');
            const notice = new Notification(row.peer.name, { body: last.body || (voice ? t('أرسل رسالة صوتية') : last.attachments?.length ? t(last.attachments.length === 1 ? 'أرسل ملفاً' : 'أرسل عدة ملفات') : t("أرسل صورة GIF")), tag: row.id, icon: `${import.meta.env.BASE_URL}icon.svg` });
            notice.onclick = () => { window.focus(); setSelected(row.id); current.current.onOpen(); notice.close(); };
          }
          if (preferences.sounds && navigator.userActivation?.hasBeenActive && !document.documentElement.classList.contains('call-active')) {
            const audio = new AudioContext();
            const oscillator = audio.createOscillator(); const gain = audio.createGain();
            oscillator.connect(gain); gain.connect(audio.destination); oscillator.frequency.value = 650; gain.gain.value = .035;
            oscillator.start(); gain.gain.exponentialRampToValueAtTime(.001, audio.currentTime + .16); oscillator.stop(audio.currentTime + .18);
            oscillator.onended = () => { void audio.close(); };
          }
        }
      }
      notified.current = new Map(rows.map(row => [row.id, row.lastMessage?.id || '']));
      setThreads(rows); if (!savingSettings.current) setSettings(preferences); setError('');
    } catch (e) { if (current.current.user?.id === requestedUserId) setError((e as Error).message); }
    finally { setLoading(false); }
  }, [enabled, portal]);
  useEffect(() => {
    setThreads([]); setSelected(null); setTypingUpdates({}); notified.current = null; setLoading(true); setError('');
    if (!enabled) { setLoading(false); return; }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10000);
    const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [enabled, user?.id, refresh]);
  useEffect(() => {
    if (!enabled) return;
    const heartbeat = () => { void request(`${portal}/chat/presence`, { active: document.visibilityState === 'visible' }).catch(() => undefined); };
    heartbeat(); const timer = window.setInterval(heartbeat, 20000);
    const leaving = () => { void fetch(`${(import.meta.env.VITE_API_URL || '').replace(/\/$/, '')}/api/${portal}/chat/presence`, { method: 'POST', credentials: 'include', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: false }) }).catch(() => undefined); };
    document.addEventListener('visibilitychange', heartbeat);
    window.addEventListener('pagehide', leaving);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', heartbeat); window.removeEventListener('pagehide', leaving); };
  }, [enabled, portal]);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let socket: import('socket.io-client').Socket | undefined;
    const typingTimers = new Map<string, number>();
    void import('socket.io-client').then(({ io }) => {
      if (!alive) return;
      socket = io(import.meta.env.VITE_API_URL || window.location.origin, { withCredentials: true, auth: { portal }, transports: ['websocket', 'polling'], reconnectionAttempts: 5 });
      socket.on('chat:changed', (data: { threadId?: string }) => {
        void refresh();
        if (!data?.threadId || data.threadId === current.current.selected) setRevision(value => value + 1);
      });
      socket.on('connect', () => { void refresh(); setRevision(value => value + 1); });
      socket.on('chat:typing', (data: { threadId: string; authorId: string; active: boolean }) => {
        if (data.authorId === current.current.user?.id) return;
        clearTimeout(typingTimers.get(data.threadId));
        setTypingUpdates(previous => ({ ...previous, [data.threadId]: data.active }));
        if (data.active) typingTimers.set(data.threadId, window.setTimeout(() => setTypingUpdates(previous => ({ ...previous, [data.threadId]: false })), 3500));
      });
    });
    return () => { alive = false; socket?.disconnect(); for (const timer of typingTimers.values()) clearTimeout(timer); };
  }, [enabled, portal, user?.id, refresh]);
  async function saveSettings(changes: Partial<ChatSettings>) {
    const previous = settings;
    savingSettings.current = true; setSettings(value => ({ ...value, ...changes }));
    try {
      const result = await request<{ settings: ChatSettings }>(`${portal}/chat/settings`, changes);
      setSettings(result.settings);
    } catch (error) { setSettings(previous); throw error; }
    finally { savingSettings.current = false; }
    await refresh();
  }
  return { threads, settings, loading, error, selected, select: setSelected, refresh, revision, saveSettings, typingUpdates, unread: threads.filter(t => !t.hidden && !t.muted && !t.unavailable).reduce((sum, t) => sum + t.unread, 0) };
}
export type DirectChatState = ReturnType<typeof useDirectChat>;
