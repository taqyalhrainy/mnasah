import { t, locale, usePreferences } from '../../i18n/preferences';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, BellOff, Check, CheckCheck, ChevronDown, Download, File, ImagePlay, MessageCircle, Mic, MoreHorizontal, Paperclip, Reply, Search, Send, Settings2, ShieldOff, Smile, Square, Trash2, X } from 'lucide-react';
import { apiUrl, request, type Portal, type User } from '../../services/platformApi';
import type { ChatAttachment, ChatMessage, ChatThread, ThreadResult } from './chatTypes';
import type { DirectChatState } from './useDirectChat';
import './chat.css';

const reactions = ['❤️', '👍', '😂', '🔥', '👏', '🎉'];
const emojis = ['😊', '❤️', '👍', '😂', '🙏', '🌸', '🎉', '👏', '✨', '📚', '💜', '😅', '🤔', '👌', '🌟', '💡', '🔥', '🤝', '✅', '🙌', '😎', '🥳', '🌷', '💪'];
const gifs = [
  { label: 'شكراً', url: 'https://media.giphy.com/media/l0MYt5jPR6QX5pnqM/giphy.gif' },
  { label: 'رائع', url: 'https://media.giphy.com/media/111ebonMs90YLu/giphy.gif' },
  { label: 'تصفيق', url: 'https://media.giphy.com/media/Swx36wwSsU49HAnIhC/giphy.gif' },
];
const clock = (time: number) => new Date(time).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
const day = (time: number) => new Date(time).toLocaleDateString(locale(), { day: 'numeric', month: 'long' });
const sizeLabel = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} ${t('ك.ب')}` : `${(bytes / 1024 / 1024).toFixed(1)} ${t('م.ب')}`;
const recordingTime = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
const isAudio = (file: Pick<ChatAttachment, 'preview_type'>) => file.preview_type.startsWith('audio/');
type QueuedFile = { key: string; file: globalThis.File; url: string; progress: number; attachmentId?: string };
function presenceText(peer: ChatThread['peer']) {
  return peer.status === 'online' ? t("متاح الآن") : peer.status === 'away' ? t("كان هنا قبل قليل") : peer.status === 'hidden' ? t("الظهور مخفي") : peer.lastSeen ? t("آخر ظهور {v0}، {v1}", { v0: day(peer.lastSeen), v1: clock(peer.lastSeen) }) : t("غير متصل");
}
function PeerAvatar({ thread }: { thread: ChatThread }) {
  usePreferences();
  return <span className="dm-avatar">{thread.peer.name.trim().charAt(0)}{thread.peer.status !== 'hidden' && <i className={`presence-dot ${thread.peer.status}`} aria-label={presenceText(thread.peer)} />}</span>;
}
export function DirectMessages({ portal, user, chat, active }: { portal: Portal; user: User; chat: DirectChatState; active: boolean }) {
  usePreferences();
  const [detail, setDetail] = useState<ThreadResult | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [query, setQuery] = useState('');
  const [messageQuery, setMessageQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [picker, setPicker] = useState<'emoji' | 'gif' | null>(null);
  const [gifLink, setGifLink] = useState('');
  const [reply, setReply] = useState<ChatMessage | null>(null);
  const [busy, setBusy] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState('');
  const [reactionTarget, setReactionTarget] = useState<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [files, setFiles] = useState<QueuedFile[]>([]);
  const [recording, setRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const timeline = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const recorderStream = useRef<MediaStream | null>(null);
  const recorderChunks = useRef<Blob[]>([]);
  const recorderTimer = useRef<number | null>(null);
  const recorderStarted = useRef(0);
  const discardRecording = useRef(false);
  const selectedRef = useRef(chat.selected); selectedRef.current = chat.selected;
  const bottomRef = useRef(true);
  const requestVersion = useRef(0);
  const typing = useRef({ lastSent: 0, timer: 0 });
  const readMessage = useRef('');
  const pendingSend = useRef<{ signature: string; id: string } | null>(null);
  const loadRef = useRef(load); loadRef.current = load;
  const id = chat.selected;
  const draft = id ? drafts[id] || '' : '';
  const baseThread = detail?.thread.id === id ? detail.thread : chat.threads.find(row => row.id === id);
  const thread = baseThread ? { ...baseThread, typing: !baseThread.unavailable && (chat.typingUpdates[baseThread.id] ?? baseThread.typing) } : undefined;
  const messagePath = (threadId: string, action = '') => `${portal}/chat/threads/${threadId}${action ? `/${action}` : ''}`;
  const attachmentUrl = (threadId: string, attachment: ChatAttachment, preview = false) => apiUrl(`${messagePath(threadId, `attachments/${attachment.id}`)}${preview ? '?preview=1' : ''}`);
  async function load(threadId: string, older = false) {
    const version = ++requestVersion.current;
    const oldest = detail?.messages[0];
    const suffix = older && oldest ? `?before=${oldest.created}&beforeId=${encodeURIComponent(oldest.id)}` : '';
    const previousHeight = timeline.current?.scrollHeight || 0;
    try {
      const result = await request<ThreadResult>(messagePath(threadId) + suffix);
      if (selectedRef.current !== threadId || version !== requestVersion.current) return;
      setDetail(previous => {
        if (older && previous?.thread.id === threadId) return { ...result, messages: [...result.messages, ...previous.messages] };
        // Keep older pages when a live update refreshes the latest page.
        const rows = previous?.thread.id === threadId ? previous.messages : [];
        const first = result.messages[0];
        const keep = first ? rows.filter(row => row.created > result.thread.historyAfter && (row.created < first.created || (row.created === first.created && row.id < first.id))) : [];
        return { ...result, hasMore: keep.length ? previous?.hasMore || false : result.hasMore, messages: [...keep, ...result.messages] };
      });
      setError('');
      requestAnimationFrame(() => {
        const element = timeline.current; if (!element) return;
        if (older) element.scrollTop += element.scrollHeight - previousHeight;
        else if (bottomRef.current) element.scrollTop = element.scrollHeight;
      });
    } catch (e) { if (selectedRef.current === threadId) setError((e as Error).message); }
    finally { if (selectedRef.current === threadId) setFetching(false); }
  }
  useEffect(() => {
    cancelRecording();
    setDetail(null); setError(''); setReply(null); setPicker(null); setMessageQuery(''); setSearching(false); setReactionTarget(null); readMessage.current = '';
    setFiles(previous => { previous.forEach(row => URL.revokeObjectURL(row.url)); return []; }); pendingSend.current = null;
    bottomRef.current = true; setAtBottom(true);
    if (!id) return;
    setFetching(true); void load(id);
    return () => { ++requestVersion.current; };
    // Detail resets only when the selected conversation changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, portal]);
  useEffect(() => {
    if (!id || !active) return;
    const poll = () => { if (document.visibilityState === 'visible' && !document.documentElement.classList.contains('call-active')) void loadRef.current(id); };
    const timer = window.setInterval(poll, 3000);
    document.addEventListener('visibilitychange', poll);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', poll); };
  }, [id, active, portal]);
  useEffect(() => { if (id && active) void load(id); }, [chat.revision]);
  useEffect(() => {
    const last = detail?.messages.at(-1);
    if (!id || !active || !atBottom || document.visibilityState !== 'visible' || document.documentElement.classList.contains('call-active') || !last || last.id === readMessage.current) return;
    readMessage.current = last.id;
    void request(messagePath(id, 'read'), { messageId: last.id }).then(() => chat.refresh()).catch(() => { readMessage.current = ''; });
  }, [detail, id, active, atBottom]);
  useEffect(() => () => { clearTimeout(typing.current.timer); cancelRecording(); }, []);
  useEffect(() => { if (!active) stopTyping(); }, [active]);
  async function mutate(action: string, body: unknown, threadId = id) {
    if (!threadId) return;
    const result = await request<{ message?: ChatMessage }>(messagePath(threadId, action), body);
    if (result.message) setDetail(previous => previous?.thread.id === threadId ? { ...previous, messages: previous.messages.map(row => row.id === result.message?.id ? result.message : row) as ChatMessage[] } : previous);
    await chat.refresh(); await load(threadId);
  }
  function stopTyping(threadId = id) {
    clearTimeout(typing.current.timer); typing.current.lastSent = 0;
    if (threadId) void request(messagePath(threadId, 'typing'), { active: false }).catch(() => undefined);
  }
  function type(value: string) {
    if (!id) return;
    setDrafts(previous => ({ ...previous, [id]: value }));
    clearTimeout(typing.current.timer);
    if (!value.trim()) { stopTyping(); return; }
    if (Date.now() - typing.current.lastSent > 900) {
      typing.current.lastSent = Date.now();
      void request(messagePath(id, 'typing'), { active: true }).catch(() => undefined);
    }
    const target = id;
    typing.current.timer = window.setTimeout(() => stopTyping(target), 1600);
  }
  function queueFiles(selectedFiles: globalThis.File[]) {
    setError('');
    setFiles(previous => {
      const next = [...previous];
      for (const file of selectedFiles) {
        if (next.length >= 10) { setError(t('يمكنك إرفاق 10 ملفات كحد أقصى في الرسالة.')); break; }
        if (!file.size) { setError(t('لا يمكن إرسال ملف فارغ.')); continue; }
        if (file.size > 25 * 1024 * 1024) { setError(t('الملف {v0} أكبر من 25 ميغابايت.', { v0: file.name })); continue; }
        if (next.some(row => row.file.name === file.name && row.file.size === file.size && row.file.lastModified === file.lastModified)) continue;
        next.push({ key: crypto.randomUUID(), file, url: /^(image\/(png|jpeg|gif|webp)|audio\/(webm|ogg|wav|mp4|mpeg))$/.test(file.type) ? URL.createObjectURL(file) : '', progress: 0 });
      }
      if (next.reduce((sum, row) => sum + row.file.size, 0) > 100 * 1024 * 1024) { next.slice(previous.length).forEach(row => row.url && URL.revokeObjectURL(row.url)); setError(t('حجم مرفقات الرسالة يجب ألا يتجاوز 100 ميغابايت.')); return previous; }
      pendingSend.current = null;
      return next;
    });
  }
  function chooseFiles(selected: FileList | null) {
    if (!selected) return;
    queueFiles(Array.from(selected));
    if (fileInput.current) fileInput.current.value = '';
  }
  function releaseRecorder() {
    if (recorderTimer.current !== null) window.clearInterval(recorderTimer.current);
    recorderTimer.current = null;
    recorderStream.current?.getTracks().forEach(track => track.stop());
    recorderStream.current = null;
    recorder.current = null;
    setRecording(false);
  }
  function cancelRecording() {
    discardRecording.current = true;
    const activeRecorder = recorder.current;
    if (activeRecorder && activeRecorder.state !== 'inactive') activeRecorder.stop();
    else releaseRecorder();
  }
  function stopRecording() {
    discardRecording.current = false;
    if (recorder.current?.state !== 'inactive') recorder.current?.stop();
  }
  async function startRecording() {
    if (recording || busy || files.length >= 10) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { setError(t('التسجيل الصوتي غير مدعوم في هذا المتصفح.')); return; }
    try {
      setError(''); setPicker(null);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const preferred = typeof MediaRecorder.isTypeSupported === 'function' ? ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type)) : undefined;
      const activeRecorder = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined);
      recorder.current = activeRecorder; recorderStream.current = stream; recorderChunks.current = []; discardRecording.current = false;
      activeRecorder.ondataavailable = event => { if (event.data.size) recorderChunks.current.push(event.data); };
      activeRecorder.onerror = () => { setError(t('تعذر تسجيل الصوت. حاول مجدداً.')); cancelRecording(); };
      activeRecorder.onstop = () => {
        const discard = discardRecording.current;
        const chunks = recorderChunks.current; recorderChunks.current = [];
        const mime = activeRecorder.mimeType.split(';')[0] || chunks[0]?.type.split(';')[0] || 'audio/webm';
        releaseRecorder();
        if (discard || !chunks.length) return;
        const blob = new Blob(chunks, { type: mime });
        if (!blob.size) { setError(t('التسجيل الصوتي فارغ. حاول مجدداً.')); return; }
        const extension = mime === 'audio/mp4' ? 'm4a' : mime === 'audio/ogg' ? 'ogg' : mime === 'audio/wav' ? 'wav' : 'webm';
        queueFiles([new globalThis.File([blob], `voice-note-${Date.now()}.${extension}`, { type: mime })]);
      };
      activeRecorder.start(250);
      recorderStarted.current = Date.now(); setRecordingSeconds(0); setRecording(true);
      recorderTimer.current = window.setInterval(() => {
        const elapsed = Math.floor((Date.now() - recorderStarted.current) / 1000); setRecordingSeconds(elapsed);
        if (elapsed >= 120) stopRecording();
      }, 250);
    } catch { releaseRecorder(); setError(t('لم نتمكن من استخدام الميكروفون. اسمح بالوصول ثم حاول مجدداً.')); }
  }
  function removeFile(key: string) {
    if (busy) return;
    setFiles(previous => { const target = previous.find(row => row.key === key); if (target?.url) URL.revokeObjectURL(target.url); return previous.filter(row => row.key !== key); });
    pendingSend.current = null;
  }
  function uploadFile(threadId: string, messageId: string, queued: QueuedFile) {
    if (queued.attachmentId) return Promise.resolve(queued.attachmentId);
    return new Promise<string>((resolve, reject) => {
      const query = new URLSearchParams({ messageId, name: queued.file.name, size: String(queued.file.size) });
      const xhr = new XMLHttpRequest();
      xhr.open('POST', apiUrl(`${messagePath(threadId, 'attachments')}?${query}`)); xhr.withCredentials = true;
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = event => { queued.progress = event.lengthComputable ? Math.round(event.loaded / event.total * 100) : 0; setFiles(previous => [...previous]); };
      xhr.onerror = () => reject(new Error(t('تعذر رفع الملف. تحقق من الاتصال وحاول مجدداً.')));
      xhr.onabort = () => reject(new Error(t('تم إلغاء رفع الملف.')));
      xhr.onload = () => {
        let data: { attachment?: ChatAttachment; error?: string } = {}; try { data = JSON.parse(xhr.responseText); } catch { /* handled below */ }
        if (xhr.status < 200 || xhr.status >= 300 || !data.attachment) { reject(new Error(t(data.error || 'تعذر رفع الملف.'))); return; }
        queued.attachmentId = data.attachment.id; queued.progress = 100; setFiles(previous => [...previous]); resolve(data.attachment.id);
      };
      xhr.send(queued.file);
    });
  }
  async function download(threadId: string, attachment: ChatAttachment) {
    try {
      const response = await fetch(attachmentUrl(threadId, attachment), { credentials: 'include', cache: 'no-store' });
      if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(t(data.error || 'تعذر تنزيل الملف.')); }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a'); link.href = url; link.download = attachment.name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setError((e as Error).message); }
  }
  async function send(event?: FormEvent, media = '') {
    event?.preventDefault();
    if (!id || busy || (!draft.trim() && !media && !files.length) || thread?.unavailable || thread?.hidden) return;
    const threadId = id;
    setBusy(true); setError('');
    try {
      const signature = JSON.stringify([threadId, draft.trim(), media, reply?.id || '', files.map(row => [row.file.name, row.file.size, row.file.lastModified])]);
      if (pendingSend.current?.signature !== signature) pendingSend.current = { signature, id: crypto.randomUUID() };
      const attachmentIds = [];
      for (const file of files) attachmentIds.push(await uploadFile(threadId, pendingSend.current.id, file));
      await request(messagePath(threadId, 'messages'), { id: pendingSend.current.id, body: draft.trim(), media_url: media, attachments: attachmentIds, reply_to: reply?.id || '' });
      pendingSend.current = null;
      setDrafts(previous => ({ ...previous, [threadId]: '' })); stopTyping(threadId);
      if (selectedRef.current === threadId) { setFiles(previous => { previous.forEach(row => row.url && URL.revokeObjectURL(row.url)); return []; }); setReply(null); setPicker(null); setGifLink(''); bottomRef.current = true; setAtBottom(true); await load(threadId); }
      await chat.refresh(); input.current?.focus();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  const visibleThreads = chat.threads.filter(row => row.hidden === showHidden && row.peer.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const visibleMessages = (detail?.thread.id === id ? detail.messages : []).filter(row => !messageQuery || row.body.toLocaleLowerCase().includes(messageQuery.toLocaleLowerCase()) || row.attachments.some(file => file.name.toLocaleLowerCase().includes(messageQuery.toLocaleLowerCase())));
  async function action(task: () => Promise<unknown>) { try { setBusy(true); await task(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  return <section className="dm-workspace" aria-label={t("الرسائل الخاصة")}>
    <div className="dm-heading"><div><span className="section-kicker">{t("تعلّم يبدأ بمحادثة")}</span><h2>{t("رسائلك")}<span className="dm-heading-dot">.</span></h2><p>{t("مساحة تواصل مع ")}{portal === 'students' ? t("أساتذتك") : t("طلابك")}{t("، قبل الحصة وبعدها.")}</p></div><button className="secondary-button" onClick={() => setShowSettings(!showSettings)} aria-expanded={showSettings}><Settings2 size={17} />{t("إعدادات الرسائل")}</button></div>
    {showSettings && <section className="dm-settings" aria-label={t("إعدادات الرسائل")}><div><h3>{t("خصوصيتك، على راحتك")}</h3><p>{t("تُحفظ هذه الخيارات لحسابك في جميع المحادثات.")}</p></div>{[
      ['readReceipts', t("إظهار تمت القراءة"), t("اسمح للطرف الآخر بمعرفة أنك قرأت رسائله.")],
      ['showPresence', t("إظهار حالة الاتصال"), t("أظهر متاح الآن وآخر ظهور للطرف الآخر.")],
      ['notifications', t("إشعارات الرسائل"), t("تنبيهات الجهاز عند وصول رسالة جديدة.")],
      ['sounds', t("صوت الرسائل"), t("نغمة خفيفة عند وصول رسالة خارج المحادثة المفتوحة.")],
    ].map(([key, label, hint]) => <label key={key}><span><strong>{t(label)}</strong><small>{t(hint)}</small></span><input type="checkbox" checked={chat.settings[key as keyof typeof chat.settings]} disabled={busy} onChange={event => {
      const checked = event.currentTarget.checked;
      void action(async () => {
        if (key === 'notifications' && checked && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
        await chat.saveSettings({ [key]: checked });
      });
    }} /></label>)}{'Notification' in window && chat.settings.notifications && Notification.permission !== 'granted' && <p className="dm-permission">{t("تنبيهات الجهاز تحتاج إذن المتصفح.")}<button className="text-button" onClick={() => void Notification.requestPermission()}>{t("السماح بالتنبيهات")}</button></p>}</section>}
    {(chat.error || error) && <p className="notice error" role="alert">{error || chat.error}<button className="text-button" onClick={() => { void chat.refresh(); if (id) void load(id); }}>{t("إعادة المحاولة")}</button></p>}
    <div className={`dm-layout ${id ? 'has-selection' : ''}`}>
      <aside className="dm-inbox" aria-label={t("المحادثات")}><div className="dm-inbox-title"><h3>{t("المحادثات ")}<span>{visibleThreads.length}</span></h3><button className="icon-button" aria-label={showHidden ? t("عرض المحادثات") : t("المحادثات المحذوفة")} onClick={() => setShowHidden(!showHidden)} aria-pressed={showHidden}><Trash2 size={16} /></button></div><label className="dm-search"><Search size={17} /><input aria-label={t("بحث في المحادثات")} placeholder={t("ابحث عن اسم…")} value={query} onChange={e => setQuery(e.target.value)} /></label>{showHidden && <p className="dm-list-hint">{t("المحادثات المحذوفة من قائمتك. الاستعادة تفتح محادثة فارغة؛ لا تعيد السجل المحذوف.")}</p>}<div className="dm-thread-list">{chat.loading ? <p className="dm-empty-small" role="status">{t("جارٍ تحميل المحادثات…")}</p> : !visibleThreads.length ? <div className="dm-empty-small"><MessageCircle size={25} /><p>{query ? t("لا توجد نتائج مطابقة.") : showHidden ? t("لا توجد محادثات محذوفة.") : t("تظهر محادثاتك تلقائياً بعد أول حجز.")}</p></div> : visibleThreads.map(row => <button className={`dm-thread ${id === row.id ? 'selected' : ''}`} key={row.id} onClick={() => { stopTyping(); chat.select(row.id); }} aria-label={t("محادثة {v0}", { v0: row.peer.name })} aria-pressed={id === row.id}><PeerAvatar thread={row} /><span className="dm-thread-copy"><strong>{row.peer.name}{row.muted && <BellOff size={13} />}{row.blocked && <ShieldOff size={13} />}</strong><small>{row.typing ? <TypingDots /> : row.lastMessage?.media_url ? t("صورة GIF") : row.lastMessage?.body || (row.lastMessage?.attachments?.length ? isAudio(row.lastMessage.attachments[0]) ? t("رسالة صوتية") : `📎 ${row.lastMessage.attachments[0].name}` : t("ابدأ محادثة جديدة"))}</small></span><span className="dm-thread-meta">{row.lastMessage && <time>{clock(row.lastMessage.created)}</time>}{row.unread > 0 && !row.hidden && <b>{row.unread > 99 ? '99+' : row.unread}</b>}</span></button>)}</div><div className="dm-inbox-footer"><span className="dm-mini-dot" />{t("محادثات خاصة مرتبطة بحجوزاتك")}</div></aside>
      <div className="dm-conversation">{!thread ? <div className="dm-welcome"><span className="dm-welcome-icon"><MessageCircle size={34} strokeWidth={1.5} /></span><span className="section-kicker">{t("معك، خارج وقت الحصة أيضاً")}</span><h3>{t("كل سؤال، بداية جديدة.")}</h3><p>{t("اختر محادثة للتواصل، مشاركة فكرة، أو متابعة ما تعلّمته.")}</p><div className="dm-welcome-features"><span><CheckCheck size={16} />{t("قراءة")}</span><span><Smile size={16} />{t("تفاعلات")}</span><span><ShieldOff size={16} />{t("خصوصية")}</span></div></div> : <>
        <header className="dm-conversation-header"><button className="icon-button dm-back" aria-label={t("العودة للمحادثات")} onClick={() => { stopTyping(); chat.select(null); }}><ArrowRight size={19} /></button><PeerAvatar thread={thread} /><div className="dm-peer-title"><h3>{thread.peer.name}</h3><p><span className={`dm-status-text ${thread.peer.status}`}>{presenceText(thread.peer)}</span>{thread.muted && <BellOff size={13} />}</p></div><button className="icon-button" aria-label={t("بحث في الرسائل")} onClick={() => { setSearching(!searching); setMessageQuery(''); }} aria-pressed={searching}><Search size={18} /></button><details className="dm-menu"><summary aria-label={t("خيارات المحادثة")}><MoreHorizontal size={21} /></summary><div><button disabled={busy} onClick={() => void action(() => mutate('preferences', { muted: !thread.muted }))}><BellOff size={16} />{thread.muted ? t("إلغاء الصامت") : t("كتم المحادثة")}</button><button disabled={busy} onClick={() => void action(() => mutate('preferences', { blocked: !thread.blocked }))}><ShieldOff size={16} />{thread.blocked ? t("إلغاء الحظر") : t("حظر المراسلة")}</button><button disabled={busy} onClick={() => {
          if (window.confirm(t("حذف هذه المحادثة وسجلها من حسابك؟ تبقى نسخة الطرف الآخر لديه. لا يمكن استعادة سجلّك المحذوف."))) void action(async () => { await request(messagePath(thread.id, 'delete'), {}); chat.select(null); await chat.refresh(); });
        }}><Trash2 size={16} />{t("حذف المحادثة عندي")}</button></div></details></header>
        {searching && <label className="dm-search dm-message-search"><Search size={16} /><input aria-label={t("بحث داخل المحادثة")} placeholder={t("ابحث في نص الرسائل المحمّلة…")} value={messageQuery} onChange={e => setMessageQuery(e.target.value)} autoFocus /><button className="icon-button" aria-label={t("إغلاق البحث")} onClick={() => { setSearching(false); setMessageQuery(''); }}><X size={15} /></button></label>}
        {thread.hidden && <div className="dm-state-banner"><p>{t("حذفت هذه المحادثة من قائمتك.")}</p><button className="secondary-button" disabled={busy} onClick={() => void action(() => mutate('restore', {}))}>{t("استعادة المحادثة")}</button></div>}
        {thread.unavailable && <div className="dm-state-banner"><ShieldOff size={17} /><p>{thread.blocked ? t("حظرت المراسلة. يمكنك إلغاء الحظر من خيارات المحادثة.") : t("المراسلة غير متاحة حالياً.")}</p></div>}
        <div className="dm-timeline" ref={timeline} role="log" aria-label={t("سجل الرسائل")} aria-live="polite" onScroll={() => { const element = timeline.current; if (element) { const bottom = element.scrollHeight - element.scrollTop - element.clientHeight < 70; bottomRef.current = bottom; setAtBottom(bottom); } }}>
          {detail?.hasMore && !messageQuery && <button className="dm-load-more" disabled={fetching} onClick={() => { setFetching(true); void load(thread.id, true); }}>{t("عرض الرسائل الأقدم")}</button>}
          {fetching && !detail ? <p className="dm-empty-small" role="status">{t("جارٍ تحميل الرسائل…")}</p> : !visibleMessages.length ? <div className="dm-first-message"><span>✦</span><p>{messageQuery ? t("لا توجد رسالة مطابقة في الرسائل المحمّلة.") : t("قل مرحباً، وابدأ الحوار.")}</p></div> : visibleMessages.map((message, index) => {
            const mine = message.author_id === user.id;
            const previous = visibleMessages[index - 1];
            const showDay = !previous || new Date(previous.created).toDateString() !== new Date(message.created).toDateString();
            return <div key={message.id}>{showDay && <div className="dm-day"><span>{day(message.created)}</span></div>}<article className={`dm-message ${mine ? 'mine' : 'theirs'}`} data-message-id={message.id}><div className="dm-message-content">{message.reply && <blockquote className="dm-reply-quote"><Reply size={13} /><span>{message.reply.body || (message.reply.attachments?.length ? isAudio(message.reply.attachments[0]) ? t("رسالة صوتية") : `${t("ملف")}: ${message.reply.attachments[0].name}` : t("صورة GIF"))}</span></blockquote>}{message.body && <p dir="auto">{message.body}</p>}{message.media_url && <img className="dm-gif" src={message.media_url} alt={t("صورة GIF مرسلة")} loading="lazy" referrerPolicy="no-referrer" onError={event => { event.currentTarget.alt = t("تعذر تحميل GIF"); }} />}{message.attachments?.length > 0 && <div className="dm-attachments">{message.attachments.map(file => <div className={`dm-attachment ${isAudio(file) ? 'audio' : ''}`} key={file.id}>{file.preview_type.startsWith('image/') && <img src={attachmentUrl(thread.id, file, true)} alt={`${t("معاينة")} ${file.name}`} loading="lazy" />}{isAudio(file) && <div className="dm-audio"><Mic size={18} /><span>{t("رسالة صوتية")}</span><audio controls preload="metadata" src={attachmentUrl(thread.id, file, true)} aria-label={t("تشغيل الرسالة الصوتية")} /></div>}<div>{isAudio(file) ? <Mic size={18} /> : <File size={18} />}<span><b title={file.name}>{isAudio(file) ? t("تسجيل صوتي") : file.name}</b><small>{sizeLabel(file.size)}</small></span><button type="button" aria-label={`${t("تنزيل")} ${file.name}`} title={t("تنزيل الملف")} onClick={() => void download(thread.id, file)}><Download size={17} /></button></div></div>)}</div>}<div className="dm-message-meta"><time>{clock(message.created)}</time>{mine && <span title={thread.peerReadAt === null ? t("تم الإرسال") : thread.peerReadAt >= message.created ? t("تمت القراءة") : t("تم الإرسال")}>{thread.peerReadAt !== null && thread.peerReadAt >= message.created ? <><CheckCheck size={14} /><span>{t("تمت القراءة")}</span></> : <Check size={13} />}</span>}</div></div><div className="dm-message-tools"><button aria-label={t("تفاعل مع الرسالة")} disabled={thread.unavailable} onClick={() => setReactionTarget(reactionTarget === message.id ? null : message.id)}><Smile size={15} /></button><button aria-label={t("رد على الرسالة")} disabled={thread.unavailable} onClick={() => { setReply(message); input.current?.focus(); }}><Reply size={15} /></button></div>{reactionTarget === message.id && <div className="dm-reaction-picker" aria-label={t("تفاعلات سريعة")}>{reactions.map(emoji => <button key={emoji} aria-label={t("تفاعل {v0}", { v0: emoji })} disabled={busy} onClick={() => { setReactionTarget(null); void action(() => mutate('reaction', { messageId: message.id, emoji, active: !message.reactions.some(r => r.emoji === emoji && r.mine) })); }}>{emoji}</button>)}</div>}{message.reactions.length > 0 && <div className="dm-reactions">{message.reactions.map(reaction => <button key={reaction.emoji} disabled={busy || thread.unavailable} aria-label={`${reaction.emoji} ${reaction.count}`} aria-pressed={reaction.mine} onClick={() => void action(() => mutate('reaction', { messageId: message.id, emoji: reaction.emoji, active: !reaction.mine }))}>{reaction.emoji}<small>{reaction.count}</small></button>)}</div>}</article></div>;
          })}
        </div>
        {!atBottom && <button className="dm-jump" onClick={() => { if (timeline.current) timeline.current.scrollTop = timeline.current.scrollHeight; bottomRef.current = true; setAtBottom(true); }}><ChevronDown size={15} />{t("أحدث الرسائل")}</button>}
        <div className="dm-typing-line">{thread.typing && <><TypingDots /><span>{thread.peer.name}</span></>}</div>
        {reply && <div className="dm-reply-bar"><Reply size={16} /><span><small>{t("رد على ")}{reply.author_id === user.id ? t("رسالتك") : thread.peer.name}</small><b>{reply.body || (reply.attachments?.length ? isAudio(reply.attachments[0]) ? t("رسالة صوتية") : `${t("ملف")}: ${reply.attachments[0].name}` : t("صورة GIF"))}</b></span><button className="icon-button" aria-label={t("إلغاء الرد")} onClick={() => setReply(null)}><X size={16} /></button></div>}
        {picker && <div className="dm-picker"><div className="dm-picker-heading"><strong>{picker === 'emoji' ? t("إيموجي") : t("اختر GIF")}</strong><button className="icon-button" aria-label={t("إغلاق المنتقي")} onClick={() => setPicker(null)}><X size={16} /></button></div>{picker === 'emoji' ? <div className="dm-emoji-grid">{emojis.map(emoji => <button type="button" key={emoji} aria-label={t("إضافة {v0}", { v0: emoji })} onClick={() => { type(draft + emoji); input.current?.focus(); }}>{emoji}</button>)}</div> : <><div className="dm-gif-grid">{gifs.map(gif => <button key={gif.label} title={t(gif.label)} aria-label={t("إرسال GIF {v0}", { v0: t(gif.label) })} disabled={busy} onClick={() => void send(undefined, gif.url)}><img src={gif.url} alt={t(gif.label)} loading="lazy" referrerPolicy="no-referrer" /></button>)}</div><form className="dm-gif-link" onSubmit={event => { event.preventDefault(); void send(undefined, gifLink); }}><label><span>{t("أو رابط GIF مباشر من Giphy / Tenor")}</span><input aria-label={t("رابط GIF")} value={gifLink} onChange={event => setGifLink(event.target.value)} type="url" dir="ltr" placeholder="https://media.giphy.com/…/giphy.gif" required maxLength={1000} /></label><button className="secondary-button" disabled={busy || !gifLink}>{t("إرسال GIF")}</button></form><small>{t("مصدر الصور: Giphy. يمكن للطرف الآخر كتم المحادثة أو حظرك.")}</small></>}</div>}
        {recording && <div className="dm-recording" role="status"><span className="dm-recording-pulse" /><strong>{t("جارٍ التسجيل…")}</strong><time dir="ltr">{recordingTime(recordingSeconds)}</time><button type="button" onClick={stopRecording}><Square size={14} />{t("إنهاء التسجيل")}</button><button type="button" className="icon-button" aria-label={t("إلغاء التسجيل")} onClick={cancelRecording}><X size={16} /></button></div>}
        {files.length > 0 && <div className="dm-upload-list" aria-label={t("الملفات المختارة")}>{files.map(row => <div className={row.file.type.startsWith('audio/') ? 'audio' : ''} key={row.key}>{row.url && row.file.type.startsWith('image/') ? <img src={row.url} alt={t("معاينة الملف")} /> : row.file.type.startsWith('audio/') ? <><Mic size={20} /><audio controls preload="metadata" src={row.url} aria-label={t("معاينة التسجيل الصوتي")} /></> : <File size={22} />}<span><b title={row.file.name}>{row.file.type.startsWith('audio/') ? t("تسجيل صوتي") : row.file.name}</b><small>{sizeLabel(row.file.size)}{busy && ` · ${row.progress}%`}</small>{busy && <i style={{ width: `${row.progress}%` }} />}</span><button type="button" className="icon-button" aria-label={`${t("إزالة")} ${row.file.name}`} disabled={busy} onClick={() => removeFile(row.key)}><X size={15} /></button></div>)}</div>}
        <form className="dm-composer" onSubmit={event => void send(event)}><input ref={fileInput} className="dm-file-input" type="file" multiple aria-label={t("اختيار ملفات")} onChange={event => chooseFiles(event.currentTarget.files)} /><button type="button" className="icon-button" aria-label={t("إرفاق ملفات أو صور")} title={t("إرفاق ملفات أو صور")} disabled={thread.unavailable || thread.hidden || busy || recording || files.length >= 10} onClick={() => fileInput.current?.click()}><Paperclip size={20} /></button><button type="button" className="icon-button" aria-label={t("إيموجي")} disabled={thread.unavailable || thread.hidden || busy || recording} aria-expanded={picker === 'emoji'} onClick={() => setPicker(picker === 'emoji' ? null : 'emoji')}><Smile size={20} /></button><button type="button" className="icon-button" aria-label={t("صور GIF")} disabled={thread.unavailable || thread.hidden || busy || recording} aria-expanded={picker === 'gif'} onClick={() => setPicker(picker === 'gif' ? null : 'gif')}><ImagePlay size={20} /></button><button type="button" className={`icon-button dm-mic ${recording ? 'recording' : ''}`} aria-label={t("تسجيل رسالة صوتية")} title={t("تسجيل رسالة صوتية")} aria-pressed={recording} disabled={thread.unavailable || thread.hidden || busy || recording || files.length >= 10} onClick={() => void startRecording()}><Mic size={20} /></button><textarea ref={input} aria-label={t("رسالتك")} dir="auto" placeholder={thread.unavailable ? t("المراسلة غير متاحة") : t("اكتب رسالة…")} rows={1} value={draft} disabled={thread.unavailable || thread.hidden || busy || recording} maxLength={4000} onChange={event => type(event.target.value)} onBlur={() => stopTyping()} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} /><button className="dm-send" aria-label={t("إرسال الرسالة")} disabled={busy || recording || thread.unavailable || thread.hidden || (!draft.trim() && !files.length)}><Send size={19} /></button></form><p className="dm-composer-hint">{t("حتى 10 ملفات · 25 م.ب للملف · Enter للإرسال")}</p>
      </>}</div>
    </div>
  </section>;
}
function TypingDots() {
  usePreferences(); return <span className="dm-typing-dots" role="status" aria-label={t("يكتب الآن")}><i /><i /><i /></span>; }
