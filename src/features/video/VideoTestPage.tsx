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
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const role: VideoRole = params.get('role') === 'student' ? 'student' : 'teacher';
  const [token] = useState(() => cleanToken(params.get('room')) || newToken());
  const [copied, setCopied] = useState(false);
  const otherRole: VideoRole = role === 'teacher' ? 'student' : 'teacher';
  const otherUrl = `${location.origin}/video-test?room=${encodeURIComponent(token)}&role=${otherRole}`;

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
    <main className="video-test-page" dir="rtl">
      <header className="video-test-bar">
        <div>
          <span><FlaskConical size={17} /> وضع اختبار الفيديو</span>
          <strong>أنت داخل بدور {role === 'teacher' ? 'المعلّم' : 'الطالب'}</strong>
          <small>لا تحتاج حصة أو حساب. افتح رابط الطرف الثاني على جهاز أو متصفح آخر.</small>
        </div>
        <div className="video-test-actions">
          <button className="secondary-button" type="button" onClick={copyOtherLink}>
            <Copy size={17} />{copied ? 'تم نسخ الرابط' : `نسخ رابط ${otherRole === 'teacher' ? 'المعلّم' : 'الطالب'}`}
          </button>
          <a className="secondary-button" href={otherUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={17} />فتح الطرف الثاني
          </a>
        </div>
      </header>
      <VideoRoom assignedRole={role} assignedRoom={`test-${token}`} authorize={() => Promise.resolve()} />
    </main>
  );
}
