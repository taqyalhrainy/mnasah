import { useCallback, useEffect, useState } from 'react';
import { Copy, Phone, Users } from 'lucide-react';
import { VideoRoom } from './VideoRoom';
import { groupRequest, type GroupMessage, type GroupSession } from '../../services/groupCallApi';
import { direction, t, usePreferences } from '../../i18n/preferences';

export function GroupCallPage() {
  usePreferences();
  const [roomId, setRoomId] = useState(() => location.pathname.split('/')[2] || '');
  const [hostKey, setHostKey] = useState(() => {
    const id = location.pathname.split('/')[2] || '';
    const supplied = new URLSearchParams(location.hash.slice(1)).get('host');
    if (supplied) {
      try { localStorage.setItem(`emtidad-group-host:${id}`, supplied); } catch { /* The current tab still retains its host credential. */ }
      history.replaceState(null, '', location.pathname + location.search);
      return supplied;
    }
    try { return localStorage.getItem(`emtidad-group-host:${id}`) || ''; } catch { return ''; }
  });
  const [name, setName] = useState(() => { try { return localStorage.getItem('emtidad-group-name') || ''; } catch { return ''; } });
  const [session, setSession] = useState<GroupSession | null>(null);
  const [messages, setMessages] = useState<GroupMessage[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [copied, setCopied] = useState(false);
  const invite = `${location.origin}${import.meta.env.BASE_URL.replace(/\/$/, '')}/call/${roomId}`;
  useEffect(() => { document.title = t('مكالمة جماعية'); }, []);
  const receiveMessage = useCallback((message: GroupMessage) => setMessages(previous => previous.some(row => row.id === message.id) ? previous : [...previous, message].sort((a, b) => a.created - b.created).slice(-200)), []);
  async function join() {
    if (!name.trim() || busy) return;
    setBusy(true); setError('');
    try {
      let id = roomId, key = hostKey;
      if (!id) {
        const created = await groupRequest<{ id: string; hostKey: string }>('', {});
        id = created.id; key = created.hostKey; setRoomId(id); setHostKey(key);
        try { localStorage.setItem(`emtidad-group-host:${id}`, key); } catch {}
        history.replaceState(null, '', `${import.meta.env.BASE_URL}call/${id}`);
      }
      const joined = await groupRequest<GroupSession>(`/${id}/join`, { name: name.trim(), hostKey: key });
      try { localStorage.setItem('emtidad-group-name', name.trim()); } catch {}
      setMessages([]); setSession(joined);
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('تعذر دخول المكالمة الجماعية. حاول مجدداً.')); }
    finally { setBusy(false); }
  }
  async function copyInvite() {
    try { await navigator.clipboard.writeText(invite); setCopied(true); window.setTimeout(() => setCopied(false), 2000); }
    catch { setCopied(true); }
  }
  return <main className={`group-call-page ${session ? 'in-call' : ''}`} dir={direction()}>
    <header className="group-call-header"><strong><Users size={20} />{t('مكالمة جماعية')}</strong>{roomId && <button type="button" onClick={() => void copyInvite()}><Copy size={17} />{t(copied ? 'تم نسخ الرابط' : 'نسخ رابط الدعوة')}</button>}</header>
    {!session ? <form className="group-call-join" onSubmit={event => { event.preventDefault(); void join(); }}>
      <Users size={38} /><h1>{t('أهلاً بأصحابك')}</h1><p>{t('اكتب اسمك وادخل المكالمة.')}</p>
      <label htmlFor="group-display-name">{t('اسمك')}</label><input id="group-display-name" autoFocus autoComplete="nickname" value={name} maxLength={60} onChange={event => setName(event.target.value)} />
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={busy || !name.trim()}><Phone size={18} />{t(busy ? 'جارٍ الدخول…' : roomId ? 'دخول المكالمة' : 'إنشاء مكالمة')}</button>
      {copied && <input aria-label={t('رابط الدعوة')} value={invite} readOnly dir="ltr" onFocus={event => event.currentTarget.select()} />}
    </form> : <div className="group-call-stage"><VideoRoom key={session.id} assignedRole={session.host ? 'teacher' : 'student'} assignedRoom={`group-${session.roomId}`} groupSession={session} onGroupMessage={receiveMessage} authorize={() => Promise.resolve()} currentUserId={session.id} displayName={session.name} messages={messages} onLeave={() => setSession(null)} /></div>}
  </main>;
}
