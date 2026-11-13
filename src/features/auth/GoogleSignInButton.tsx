import { useEffect, useRef, useState } from 'react';
import { t } from '../../i18n/preferences';
import { request } from '../../services/platformApi';
import { GOOGLE_WEB_CLIENT_ID } from '../../../shared/google.js';

type GoogleProfile = { email?: string; given_name?: string; family_name?: string };

function decodeGoogleProfile(credential: string): GoogleProfile {
  try { return JSON.parse(atob(credential.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); }
  catch { return {}; }
}

export function GoogleSignInButton({ onCredential }: { onCredential: (credential: string, profile: GoogleProfile) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [clientId, setClientId] = useState(() => (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) || GOOGLE_WEB_CLIENT_ID);
  useEffect(() => {
    if (clientId) return;
    let active = true;
    void request<{ googleClientId?: string }>('public/config').then(config => { if (active && config.googleClientId) setClientId(config.googleClientId); }).catch(() => undefined);
    return () => { active = false; };
  }, [clientId]);
  useEffect(() => {
    if (!clientId || !host.current) return;
    let cancelled = false;
    const render = () => {
      const google = (window as unknown as { google?: { accounts: { id: { initialize: (value: object) => void; renderButton: (node: HTMLElement, value: object) => void } } } }).google;
      if (!google || cancelled || !host.current) return;
      google.accounts.id.initialize({ client_id: clientId, callback: ({ credential }: { credential: string }) => onCredential(credential, decodeGoogleProfile(credential)) });
      host.current.replaceChildren();
      google.accounts.id.renderButton(host.current, { theme: 'outline', size: 'large', shape: 'pill', text: 'continue_with', width: Math.min(360, host.current.clientWidth || 360) });
    };
    const existing = document.querySelector<HTMLScriptElement>('script[data-mansah-google]');
    if (existing) {
      if ((window as unknown as { google?: unknown }).google) render();
      else existing.addEventListener('load', render, { once: true });
    } else {
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.dataset.mansahGoogle = 'true';
      script.onload = render;
      document.head.append(script);
    }
    return () => { cancelled = true; };
  }, [clientId, onCredential]);
  return <div className="registration-google"><div ref={host} />{!clientId && <small>{t('يتطلب تسجيل Google إضافة مفتاح Google Client ID إلى إعدادات الخادم.')}</small>}</div>;
}
