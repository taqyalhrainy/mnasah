import html from '../dist/client/index.html';
import { auth } from './auth.js';
import { api } from './api.js';
import { fail } from './db.js';
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };
    try {
      if (url.pathname.startsWith('/api/')) {
        const write = request.method !== 'GET';
        if (!['GET', 'POST'].includes(request.method)) fail(405, 'طريقة غير مدعومة.');
        if (write && (request.headers.get('origin') !== url.origin || !request.headers.get('content-type')?.startsWith('application/json'))) fail(403, 'مصدر الطلب غير صالح.');
        let body = {};
        if (write) { const raw = await request.text(); if (raw.length > 16000) fail(413, 'الطلب أكبر من المسموح.'); try { body = JSON.parse(raw); } catch { fail(400, 'طلب غير صالح.'); } if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'طلب غير صالح.'); }
        const [, , portal, ...parts] = url.pathname.split('/');
        const path = parts.join('/');
        if (portal === 'auth' && ((path === 'me') !== !write)) fail(405, 'طريقة غير مدعومة.');
        const data = portal === 'auth' ? await auth(request, env, path, body) : await api(request, env, portal, path, body);
        if (data.cookie) { headers['Set-Cookie'] = data.cookie; delete data.cookie; }
        return Response.json(data, { headers });
      }
      if (['/', '/admin', '/teachers', '/students', '/video', '/video-test'].includes(url.pathname) || /^\/(admin|teachers|students)\//.test(url.pathname)) {
        return new Response(html, { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      if (!error.status) console.error('Request failed', error);
      return Response.json({ error: error.status ? error.message : 'تعذر تنفيذ الطلب الآن. حاول مجددًا.' }, { status: error.status || 500, headers });
    }
  },
};
