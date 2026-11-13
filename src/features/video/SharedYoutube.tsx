import { useEffect, useRef, useState } from 'react';
import { Play, X } from 'lucide-react';
import { t } from '../../i18n/preferences';

export type YoutubeSession = { videoId: string; time: number; playing: boolean; updatedAt: number };
type Player = { getCurrentTime(): number; getPlayerState(): number; seekTo(time: number, allowSeekAhead: boolean): void; playVideo(): void; pauseVideo(): void; destroy(): void };
type YoutubeApi = { Player: new (node: HTMLElement, options: { videoId: string; playerVars: Record<string, string | number>; events: { onReady(): void; onStateChange(event: { data: number }): void; onError(): void } }) => Player };
declare global { interface Window { YT?: YoutubeApi; onYouTubeIframeAPIReady?: () => void } }
let apiPromise: Promise<YoutubeApi> | null = null;
function loadApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise<YoutubeApi>((resolve, reject) => {
    const timer = window.setTimeout(() => { apiPromise = null; reject(new Error('YouTube unavailable')); }, 20000);
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { previous?.(); window.clearTimeout(timer); if (window.YT) resolve(window.YT); };
    let script = document.querySelector<HTMLScriptElement>('#youtube-player-api');
    if (!script) { script = document.createElement('script'); script.id = 'youtube-player-api'; script.src = 'https://www.youtube.com/iframe_api'; document.head.append(script); }
    script.onerror = () => { window.clearTimeout(timer); script.remove(); apiPromise = null; reject(new Error('YouTube unavailable')); };
  });
  return apiPromise;
}

export function youtubeVideoId(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const host = url.hostname.replace(/^www\.|^m\./, '');
    const id = host === 'youtu.be' ? url.pathname.split('/')[1] : ['youtube.com', 'youtube-nocookie.com'].includes(host) ? (url.searchParams.get('v') || /^\/(?:embed|shorts|live)\/([^/]+)/.exec(url.pathname)?.[1]) : null;
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  } catch { return null; }
}
export function validYoutubeSession(value: unknown): value is YoutubeSession {
  if (!value || typeof value !== 'object') return false;
  const state = value as YoutubeSession;
  return typeof state.videoId === 'string' && /^[\w-]{11}$/.test(state.videoId) && Number.isFinite(state.time) && state.time >= 0 && state.time <= 604800 && typeof state.playing === 'boolean' && Number.isFinite(state.updatedAt);
}

export function YoutubeLinkDialog({ onShare, onClose }: { onShare: (id: string) => void; onClose: () => void }) {
  const [link, setLink] = useState('');
  const id = youtubeVideoId(link);
  return <div className="youtube-link-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }}><dialog open className="youtube-link-dialog" aria-modal="true" aria-label={t('مشاركة فيديو يوتيوب')} onKeyDown={event => { if (event.key === 'Escape') onClose(); }}><button type="button" className="icon-button" onClick={onClose} aria-label={t('إغلاق')}><X size={20} /></button><form onSubmit={event => { event.preventDefault(); if (id) onShare(id); }}><h2>{t('مشاركة فيديو يوتيوب')}</h2><label>{t('رابط فيديو يوتيوب')}<input autoFocus type="url" dir="ltr" value={link} onChange={event => setLink(event.target.value)} placeholder="https://www.youtube.com/watch?v=…" required /></label>{link && !id && <p role="alert">{t('أدخل رابط فيديو يوتيوب صالحاً.')}</p>}<button type="submit" className="primary-button" disabled={!id}><Play size={18} />{t('عرض داخل المكالمة')}</button></form></dialog></div>;
}

export function SharedYoutube({ session, onChange, onClose }: { session: YoutubeSession; onChange: (session: YoutubeSession) => void; onClose: () => void }) {
  const container = useRef<HTMLDivElement>(null);
  const player = useRef<Player | null>(null);
  const latest = useRef(session); latest.current = session;
  const change = useRef(onChange); change.current = onChange;
  const applyingUntil = useRef(0);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const targetTime = (state: YoutubeSession) => state.time + (state.playing ? Math.max(0, Date.now() - state.updatedAt) / 1000 : 0);
  const apply = () => {
    const current = player.current; if (!current) return;
    const state = latest.current, time = targetTime(state);
    applyingUntil.current = Date.now() + 700;
    if (Math.abs(current.getCurrentTime() - time) > 1) current.seekTo(time, true);
    if (state.playing) current.playVideo(); else current.pauseVideo();
  };
  useEffect(() => {
    let alive = true, instance: Player | null = null, poll: ReturnType<typeof setInterval> | undefined;
    setReady(false); setFailed(false); setBlocked(false);
    const root = container.current!;
    const mount = document.createElement('div'); root.replaceChildren(mount);
    void loadApi().then(api => {
      if (!alive) return;
      instance = new api.Player(mount, {
        videoId: session.videoId,
        playerVars: { origin: location.origin, playsinline: 1, rel: 0, enablejsapi: 1 },
        events: {
          onReady() {
            if (!alive || !instance) return;
            player.current = instance; setReady(true); apply();
            let sampled = instance.getCurrentTime(), sampledAt = Date.now();
            poll = setInterval(() => {
              if (!instance || !alive) return;
              const now = Date.now(), time = instance.getCurrentTime(), playing = instance.getPlayerState() === 1;
              const expected = sampled + (playing ? (now - sampledAt) / 1000 : 0);
              if (now > applyingUntil.current && Math.abs(time - expected) > 2 && Math.abs(time - targetTime(latest.current)) > 2) change.current({ videoId: session.videoId, time, playing, updatedAt: now });
              sampled = time; sampledAt = now;
              setBlocked(latest.current.playing && instance.getPlayerState() !== 1 && instance.getPlayerState() !== 3 && now > applyingUntil.current);
            }, 1000);
          },
          onStateChange({ data }) {
            if (!alive || !instance || Date.now() < applyingUntil.current || ![0, 1, 2].includes(data)) return;
            const playing = data === 1;
            if (playing !== latest.current.playing) change.current({ videoId: session.videoId, time: instance.getCurrentTime(), playing, updatedAt: Date.now() });
          },
          onError() { if (alive) setFailed(true); },
        },
      });
    }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; clearInterval(poll); instance?.destroy(); player.current = null; };
  }, [session.videoId]);
  useEffect(() => { if (ready) apply(); }, [session, ready]);
  return <section className="shared-youtube" aria-label={t('فيديو يوتيوب مشترك')}>
    <header><strong>YouTube</strong><button type="button" onClick={onClose}><X size={17} />{t('إنهاء العرض')}</button></header>
    <div className="youtube-player" ref={container} />
    {failed && <p role="alert">{t('تعذر تشغيل الفيديو. قد يمنع صاحبه عرضه داخل المواقع أو قد يكون الاتصال متوقفاً.')}</p>}
    {blocked && !failed && <button type="button" className="youtube-resume" onClick={() => { apply(); setBlocked(false); }}><Play size={18} />{t('اضغط لتشغيل الفيديو بالصوت')}</button>}
  </section>;
}
