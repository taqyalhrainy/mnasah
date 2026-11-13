const CACHE_NAME = 'imtidad-shell-v43';
const shellUrl = path => new URL(path, self.registration.scope).href;
const INDEX_URL = shellUrl('index.html');
const SHELL_FILES = ['', 'index.html', 'favicon.ico', 'images/emtidad-alelm-final-logo-48.png', 'images/emtidad-alelm-final-logo-192.png', 'manifest.webmanifest'].map(shellUrl);
function startingResponse() {
  return new Response(`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>منصة امتداد العلم</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;text-align:center;background:#21152f;color:#fff;font:17px Tahoma,Arial}main{padding:28px;max-width:400px}img{width:80px;height:80px;border-radius:50%;background:#fff}h1{font-size:25px}p{color:#d5cadf;line-height:1.8}button{padding:12px 24px;border:0;border-radius:12px;background:#ffda54;font:inherit;color:#21152f}</style><main><img src="${shellUrl('images/emtidad-alelm-final-logo-192.png')}" alt="شعار امتداد العلم"><p>منصة امتداد العلم</p><h1>ثواني وبنكون معك</h1><p role="status">نجهّز المنصة لاستقبالك…</p><button onclick="location.reload()">إعادة المحاولة</button></main><script>(function(){var started=Date.now();async function check(){var c=new AbortController(),t=setTimeout(function(){c.abort()},10000);try{var r=await fetch('/health',{cache:'no-store',signal:c.signal});if(r.ok&&(await r.json()).ok===true){location.reload();return}}catch(e){}finally{clearTimeout(t)}if(Date.now()-started<120000)setTimeout(check,2500)}check()})();</script></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(SHELL_FILES.map(url => new Request(url, { cache: 'reload' })));
    // Install the entry JS/CSS with its HTML, before retiring the previous build.
    const html = await (await cache.match(INDEX_URL)).text();
    if (!html.includes('id="boot-recovery"')) throw new Error('Application is starting');
    const entryAssets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map(match => new URL(match[1], INDEX_URL))
      .filter(url => url.origin === self.location.origin && url.pathname.includes('/assets/'));
    await cache.addAll([...new Set(entryAssets.map(url => url.href))]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('imtidad-shell-') && key !== CACHE_NAME).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (/^\/(?:owner|admin)(?:\/|$)/.test(url.pathname) && ['emtidad-alelm.onrender.com', 'mnasah.onrender.com'].includes(url.hostname)) {
    event.respondWith(fetch(request));
    return;
  }
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;
  // Public documents must never receive or overwrite the cached portal shell.
  if (/\/(?:about|launch)\/?$|\/(?:robots\.txt|sitemap\.xml|google[a-f0-9]+\.html)$/.test(url.pathname)) {
    event.respondWith(fetch(request)); return;
  }

  if (request.mode === 'navigate') {
    const network = fetch(new Request(request, { cache: 'no-store' })).then(async response => {
      if (!response.ok) throw new Error('Navigation unavailable');
      // A hosting-provider wake-up page is not our application, even with HTTP 200.
      const html = await response.clone().text();
      if (!html.includes('id="boot-recovery"')) throw new Error('Application is starting');
      // Storage/quota failures must not turn a successful load into an error.
      const copy = response.clone();
      event.waitUntil(Promise.resolve().then(() => caches.open(CACHE_NAME)).then(cache => cache.put(INDEX_URL, copy)).catch(() => undefined));
      return response;
    });
    event.waitUntil(network.catch(() => undefined));
    event.respondWith((async () => {
      // A recovery navigation must bypass stale HTML, even if a cache exists.
      if (url.searchParams.has('__app_reload')) return network.catch(startingResponse);
      let cached;
      try { cached = await (await caches.open(CACHE_NAME)).match(INDEX_URL); } catch { /* Restricted storage. */ }
      if (!cached) return network.catch(startingResponse);
      let timer;
      try {
        return await Promise.race([network.catch(() => cached), new Promise(resolve => { timer = setTimeout(() => resolve(cached), 150); })]);
      } finally { clearTimeout(timer); }
    })());
    return;
  }

  if (url.origin === self.location.origin && (url.pathname.includes('/assets/') || /\.(?:js|css|svg|png|jpg|webp|woff2|ico|webmanifest)$/.test(url.pathname))) {
    event.respondWith((async () => {
      let cache, cached;
      try { cache = await caches.open(CACHE_NAME); cached = await cache.match(request); } catch { /* Storage is optional. */ }
      if (cached && url.pathname.includes('/assets/')) return cached;
      const network = fetch(request).then(response => {
        if (response.ok && cache) event.waitUntil(cache.put(request, response.clone()).catch(() => undefined));
        return response;
      }).catch(() => cached || Response.error());
      event.waitUntil(network.catch(() => undefined));
      return cached || network;
    })());
  }
});

self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data?.json?.() || {}; } catch { /* Always display a visible notification, including malformed pushes. */ }
  event.waitUntil(self.registration.showNotification(payload.title || 'امتداد العلم أكاديمي', {
    body: payload.body || 'لديك تحديث جديد',
    icon: shellUrl('images/emtidad-alelm-final-logo-192.png'),
    badge: shellUrl('images/emtidad-alelm-final-logo-192.png'),
    tag: payload.tag || 'imtidad-update',
    renotify: true,
    data: { url: payload.url || (self.location.hostname === 'emtidad-alelm-owner.onrender.com' ? 'owner' : 'students') },
    dir: 'rtl',
    lang: 'ar',
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const rawUrl = event.notification.data?.url || 'students';
  const target = /^https?:\/\//.test(rawUrl)
    ? new URL(rawUrl)
    : new URL(String(rawUrl).replace(/^\/+/, ''), self.registration.scope);
  const scopePath = new URL(self.registration.scope).pathname.replace(/\/$/, '');
  const routePath = scopePath && target.pathname.startsWith(`${scopePath}/`) ? target.pathname.slice(scopePath.length) : target.pathname;
  if (target.origin !== self.location.origin || !/^\/(owner|teachers|students)$/.test(routePath)) return;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(client => new URL(client.url).pathname === target.pathname);
    if (existing) {
      if (target.searchParams.has('lesson')) existing.postMessage({ type: 'lesson-reminder', id: target.searchParams.get('lesson') });
      if (target.searchParams.has('view')) existing.postMessage({ type: 'platform-notification', view: target.searchParams.get('view') });
      return existing.focus();
    }
    return self.clients.openWindow(target.href);
  })());
});
