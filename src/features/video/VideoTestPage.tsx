import { t, direction, usePreferences } from '../../i18n/preferences';
import { useEffect, useMemo, useState } from 'react';
import { Copy, ExternalLink, FlaskConical } from 'lucide-react';
import { VideoRoom } from './VideoRoom';
import type { VideoRole } from '../../services/videoConnection';

function cleanToken(value: string | null) {
  return (value || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 80);
}

function newToken() {
  return crypto.randomUUID().replace(/-/g, '');
}

export function VideoTestPage() {
  usePreferences();
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const role: VideoRole = params.get('role') === 'student' ? 'student' : 'teacher';
  const [token] = useState(() => cleanToken(params.get('room')) || newToken());
  const [copied, setCopied] = useState(false);
  const otherRole: VideoRole = role === 'teacher' ? 'student' : 'teacher';
  const otherUrl = `${location.origin}/video-test?room=${encodeURIComponent(token)}&role=${otherRole}`;
  const presenceKey = (targetRole: VideoRole) => `mansah-video-test:${token}:${targetRole}`;

  useEffect(() => {
    const canonical = `/video-test?room=${encodeURIComponent(token)}&role=${role}`;
    if (`${location.pathname}${location.search}` !== canonical) history.replaceState({}, '', canonical);
  }, [role, token]);

  async function copyOtherLink() {
    await navigator.clipboard.writeText(otherUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <main className="video-test-page" dir={direction()}>
      <header className="video-test-bar">
        <div>
          <span><FlaskConical size={17} />{t(" وضع اختبار الفيديو")}</span>
          <strong>{t("أنت داخل بدور ")}{role === 'teacher' ? t("المعلّم") : t("الطالب")}</strong>
          <small>{t("لا تحتاج حصة أو حساب. افتح رابط الطرف الثاني على جهاز أو متصفح آخر.")}</small>
        </div>
        <div className="video-test-actions">
          <button className="secondary-button" type="button" onClick={copyOtherLink}>
            <Copy size={17} />{copied ? t("تم نسخ الرابط") : t("نسخ رابط {v0}", { v0: t(otherRole === 'teacher' ? 'المعلّم' : 'الطالب') })}
          </button>
          <a className="secondary-button" href={otherUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={17} />{t("فتح الطرف الثاني\r\n          ")}</a>
        </div>
      </header>
      <VideoRoom
        assignedRole={role}
        assignedRoom={`test-${token}`}
        authorize={() => Promise.resolve()}
        onSendMessage={async () => undefined}
        onPresenceChange={async (active, peerId) => {
          if (!active || !peerId) localStorage.removeItem(presenceKey(role));
          else localStorage.setItem(presenceKey(role), JSON.stringify({ peerId, expires: Date.now() + 45000 }));
        }}
        getRemotePeerId={async () => {
          try {
            const presence = JSON.parse(localStorage.getItem(presenceKey(otherRole)) || 'null') as { peerId?: string; expires?: number } | null;
            return presence?.peerId && Number(presence.expires) > Date.now() ? presence.peerId : null;
          } catch {
            return null;
          }
        }}
      />
    </main>
  );
}
