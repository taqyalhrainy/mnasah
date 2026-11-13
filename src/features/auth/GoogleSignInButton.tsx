import { useEffect, useRef, useState } from 'react';
import { locale, t } from '../../i18n/preferences';
import { BACKEND_ORIGIN, FRONTEND_ORIGIN, GOOGLE_SIGNIN_ORIGIN } from '../../../shared/deployment.js';
import { request } from '../../services/platformApi';
import { GOOGLE_WEB_CLIENT_ID } from '../../../shared/google.js';

type GoogleProfile = { email?: string; given_name?: string; family_name?: string };

function decodeGoogleProfile(credential: string): GoogleProfile {
  try { return JSON.parse(atob(credential.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); }
  catch { return {}; }
}

export function GoogleSignInButton({ onCredential }: { onCredential: (credential: string, profile: GoogleProfile) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const bridge = useRef<HTMLIFrameElement>(null);
  const useBridge = [FRONTEND_ORIGIN, BACKEND_ORIGIN].includes(location.origin);
  const [clientId, setClientId] = useState(() => (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) || GOOGLE_WEB_CLIENT_ID);
  useEffect(() => {
    if (clientId) return;
    let active = true;
    void request<{ googleClientId?: string }>('public/config').then(config => { if (active && config.googleClientId) setClientId(config.googleClientId); }).catch(() => undefined);
    return () => { active = false; };
  }, [clientId]);
  useEffect(() => {
    if (useBridge) {
      const receive = (event: MessageEvent) => {
        if (event.origin !== GOOGLE_SIGNIN_ORIGIN || event.source !== bridge.current?.contentWindow || event.data?.type !== 'emtidad-google-credential' || typeof event.data.credential !== 'string') return;
        onCredential(event.data.credential, decodeGoogleProfile(event.data.credential));
      };
      window.addEventListener('message', receive);
      return () => window.removeEventListener('message', receive);
    }
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
  }, [clientId, onCredential, useBridge]);
  if (useBridge) return <div className="registration-google"><iframe ref={bridge} title={t('المواصلة باستخدام Google')} src={`${GOOGLE_SIGNIN_ORIGIN}/api/public/google-bridge?parent=${encodeURIComponent(location.origin)}&lang=${locale().startsWith('en') ? 'en' : 'ar'}`} allow="identity-credentials-get" style={{ width: '100%', maxWidth: 360, height: 48, border: 0, colorScheme: 'light' }} /></div>;
  return <div className="registration-google"><div ref={host} />{!clientId && <small>{t('يتطلب تسجيل Google إضافة مفتاح Google Client ID إلى إعدادات الخادم.')}</small>}</div>;
}
