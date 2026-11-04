import html from '../dist/client/index.html';
import { auth } from './auth.js';
import { api } from './api.js';
import { fail } from './db.js';
import { workerPublicAvatar } from './verification-files.js';
import { GOOGLE_WEB_CLIENT_ID } from '../shared/google.js';
import { portalRequestAllowed, publicOwnerPage } from '../shared/portal-access.js';
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };
    try {
      if (publicOwnerPage(url.pathname, url.hostname)) return new Response('Not found', { status: 404, headers });
      const mode = env.PORTAL_MODE || 'all';
      if (!portalRequestAllowed(url.pathname, url.searchParams.get('portal'), mode)) return new Response('Not found', { status: 404, headers });
      if (mode === 'owner' && url.pathname === '/') return Response.redirect(`${url.origin}/owner`, 302);
      if (url.pathname.startsWith('/api/')) {
        const [, , portal, ...parts] = url.pathname.split('/');
        const path = parts.join('/');
        if (portal === 'public' && path === 'config' && request.method === 'GET') return Response.json({ portalMode: mode, googleClientId: env.GOOGLE_CLIENT_ID || GOOGLE_WEB_CLIENT_ID }, { headers });
        if (portal === 'media' && parts[0] === 'avatar' && parts[1] && request.method === 'GET') return workerPublicAvatar(env, parts[1]);
        const upload = /^chat\/threads\/[^/]+\/attachments$/.test(path) || path === 'verification/files' || path === 'wallet/topups';
        const write = request.method !== 'GET';
        if (!['GET', 'POST'].includes(request.method)) fail(405, 'طريقة غير مدعومة.');
        if (write && (request.headers.get('origin') !== url.origin || !request.headers.get('content-type')?.startsWith(upload ? 'application/octet-stream' : 'application/json'))) fail(403, 'مصدر الطلب غير صالح.');
        let body = {};
        if (write && !upload) { const raw = await request.text(); if (raw.length > 16000) fail(413, 'الطلب أكبر من المسموح.'); try { body = JSON.parse(raw); } catch { fail(400, 'طلب غير صالح.'); } if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'طلب غير صالح.'); }
        if (portal === 'auth' && ((path === 'me') !== !write)) fail(405, 'طريقة غير مدعومة.');
        if (!portalRequestAllowed(url.pathname, body.role || url.searchParams.get('portal'), mode)) return new Response('Not found', { status: 404, headers });
        const data = portal === 'auth' ? await auth(request, env, path, body) : await api(request, env, portal, path, body);
        if (data instanceof Response) return data;
        if (data.cookie) { headers['Set-Cookie'] = data.cookie; delete data.cookie; }
        return Response.json(data, { headers });
      }
      if (['/', '/owner', '/admin', '/teachers', '/students', '/video', '/video-test'].includes(url.pathname) || /^\/(owner|admin|teachers|students)\//.test(url.pathname)) {
        return new Response(html, { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      if (!error.status) console.error('Request failed', error);
      return Response.json({ error: error.status ? error.message : 'تعذر تنفيذ الطلب الآن. حاول مجددًا.' }, { status: error.status || 500, headers });
    }
  },
};
