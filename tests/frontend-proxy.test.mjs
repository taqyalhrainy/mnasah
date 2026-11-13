import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proxyBackend } from '../worker/frontend-proxy.js';
import { FRONTEND_ORIGIN, BACKEND_ORIGIN, paymentReturnOrigin } from '../shared/deployment.js';
import { googleBridge } from '../server/google-bridge.js';
import crypto from 'node:crypto';
import { io as socketClient } from 'socket.io-client';
import { startPlatformServer } from '../server/index.js';
import { memoryMongo } from './helpers/memory-mongo.mjs';
const request = (path, options = {}) => new Request(`${FRONTEND_ORIGIN}${path}`, options);

test('frontend proxy preserves streaming uploads, auth cookies and original verified origin', async () => {
  const input = request('/api/teachers/verification/files?kind=credential', {
    method: 'POST', headers: { Origin: FRONTEND_ORIGIN, Cookie: 'mansah_session_teachers=secret', 'Content-Type': 'application/octet-stream', 'X-Forwarded-Host': 'attacker.invalid' }, body: 'uploaded bytes',
  });
  const result = await proxyBackend(input, async upstream => {
    assert.equal(upstream.url, `${BACKEND_ORIGIN}/api/teachers/verification/files?kind=credential`);
    assert.equal(upstream.headers.get('Origin'), FRONTEND_ORIGIN);
    assert.equal(upstream.headers.get('Cookie'), 'mansah_session_teachers=secret');
    assert.equal(upstream.headers.get('X-Forwarded-Host'), null);
    assert.equal(await upstream.text(), 'uploaded bytes');
    const headers = new Headers({ 'Content-Type': 'application/json' });
    headers.append('Set-Cookie', 'mansah_session_teachers=new; Path=/; HttpOnly; Secure; SameSite=None');
    headers.append('Set-Cookie', 'mansah_session=; Path=/; Max-Age=0');
    return new Response('{"ok":true}', { headers });
  });
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
  assert.equal(result.headers.getSetCookie().length, 2);
  assert.match(result.headers.getSetCookie()[0], /HttpOnly/);
});

test('frontend proxy rejects cross-site writes and WebSocket hijacks before sending cookies upstream', async () => {
  let calls = 0;
  for (const [path, options] of [
    ['/api/auth/login', { method: 'POST', headers: { Origin: 'https://evil.invalid' }, body: '{}' }],
    ['/api/auth/login', { method: 'POST', body: '{}' }],
    ['/socket.io/?EIO=4&transport=websocket', { headers: { Origin: 'https://evil.invalid', Upgrade: 'websocket' } }],
    ['/socket.io/?transport=polling', { headers: { 'Sec-Fetch-Site': 'cross-site' } }],
  ]) assert.equal((await proxyBackend(request(path, options), async () => { calls++; })).status, 403);
  assert.equal(calls, 0);
});

test('range media and Socket.IO polling pass through; WebSocket upgrade response is returned intact', async () => {
  const media = await proxyBackend(request('/api/students/chat/threads/id/attachments/id?preview=1', { headers: { Range: 'bytes=3-5' } }), async upstream => {
    assert.equal(upstream.headers.get('Range'), 'bytes=3-5');
    return new Response('abc', { status: 206, headers: { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 3-5/20', 'Accept-Ranges': 'bytes' } });
  });
  assert.equal(media.status, 206); assert.equal(media.headers.get('Content-Range'), 'bytes 3-5/20');
  const polling = await proxyBackend(request('/socket.io/?EIO=4&transport=polling'), async () => new Response('0{"sid":"test"}'));
  assert.equal(await polling.text(), '0{"sid":"test"}');
  const upgrade = { status: 101, webSocket: {} };
  assert.equal(await proxyBackend(request('/socket.io/?transport=websocket', { headers: { Origin: FRONTEND_ORIGIN, Upgrade: 'websocket' } }), async () => upgrade), upgrade);
});

test('cold Render HTML or upstream errors return retryable JSON, never provider HTML', async () => {
  for (const status of [200, 502, 503]) {
    const result = await proxyBackend(request('/api/auth/me'), async () => new Response('<html>Render starting</html>', { status, headers: { 'Content-Type': 'text/html' } }));
    assert.equal(result.status, 503); assert.equal((await result.json()).starting, true);
    assert.equal(result.headers.get('Retry-After'), '3');
  }
  assert.equal((await proxyBackend(request('/health'), async () => { throw new Error('offline'); })).status, 503);
});

test('card return redirects remain on the frontend while callback payment verification stays on Render', async () => {
  const result = await proxyBackend(request('/api/payments/card/return?order=123', { method: 'POST', headers: { Origin: 'https://secure-jordan.paytabs.com' }, body: '' }), async () => new Response('', { status: 303, headers: { 'Content-Type': 'text/html', Location: `${BACKEND_ORIGIN}/students?view=wallet&order=123` } }));
  assert.equal(result.status, 303); assert.equal(result.headers.get('Location'), `${FRONTEND_ORIGIN}/students?view=wallet&order=123`);
  assert.equal(paymentReturnOrigin({ headers: { origin: FRONTEND_ORIGIN } }, BACKEND_ORIGIN), FRONTEND_ORIGIN);
  assert.equal(paymentReturnOrigin({ headers: { origin: 'https://evil.invalid' } }, BACKEND_ORIGIN), BACKEND_ORIGIN);
});

test('Google bridge only posts credentials to the fixed frontend and safely escapes script configuration', () => {
  const html = googleBridge('</script><script>attack()', 'en');
  assert.ok(!html.includes('</script><script>attack()'));
  assert.ok(html.includes(FRONTEND_ORIGIN));
  assert.ok(!html.includes("postMessage(result,'*')"));
});

test('independent frontend keeps real Mongo sessions, Google bridge and authenticated Socket.IO working', { timeout: 15000 }, async () => {
  const db = memoryMongo({ users: [{ id: 'student', role: 'students', name: 'Student', status: 'active' }], sessions: [{ user_id: 'student', token: crypto.createHash('sha256').update('test-token').digest('hex'), expires: Date.now() + 3600000 }] });
  const { httpServer, io } = await startPlatformServer({ database: db, port: 0, portalMode: 'public' });
  const base = `http://127.0.0.1:${httpServer.address().port}`;
  const headers = { Origin: FRONTEND_ORIGIN, Cookie: 'mansah_session_students=test-token' };
  const socket = socketClient(base, { auth: { portal: 'students' }, transports: ['websocket'], reconnection: false, extraHeaders: headers });
  try {
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    const localFetch = upstream => fetch(base + new URL(upstream.url).pathname + new URL(upstream.url).search, { method: upstream.method, headers: upstream.headers, body: upstream.body, duplex: 'half', redirect: 'manual' });
    const me = await proxyBackend(request('/api/auth/me?portal=students', { headers }), localFetch);
    assert.equal((await me.json()).user.id, 'student');
    assert.match(me.headers.get('Set-Cookie'), /HttpOnly/);
    const google = await fetch(`${base}/api/public/google-bridge?parent=${encodeURIComponent(FRONTEND_ORIGIN)}&lang=en`, { headers: { 'X-Forwarded-Host': 'mnasah.onrender.com' }, redirect: 'manual' });
    assert.equal(google.status, 200);
    assert.equal(google.headers.get('Content-Security-Policy'), `frame-ancestors ${FRONTEND_ORIGIN}`);
    assert.equal((await fetch(`${base}/api/public/google-bridge?parent=https://evil.invalid`)).status, 403);
    assert.equal((await fetch(`${base}/api/auth/me?portal=admin`, { headers })).status, 404);
    const logout = await proxyBackend(request('/api/auth/logout?portal=students', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{"role":"students"}' }), localFetch);
    assert.equal(logout.status, 200);
    assert.equal((await (await proxyBackend(request('/api/auth/me?portal=students', { headers }), localFetch)).json()).user, null);
  } finally { socket.disconnect(); await new Promise(resolve => io.close(() => httpServer.close(resolve))); }
});
