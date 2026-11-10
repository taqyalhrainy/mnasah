const CACHE_NAME = 'imtidad-shell-v28';
const shellUrl = path => new URL(path, self.registration.scope).href;
const INDEX_URL = shellUrl('index.html');
const SHELL_FILES = ['', 'index.html', 'favicon.ico', 'images/emtidad-alelm-final-logo-48.png', 'images/emtidad-alelm-final-logo-192.png', 'manifest.webmanifest'].map(shellUrl);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(SHELL_FILES);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)));
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

  if (request.mode === 'navigate') {
    const network = fetch(request).then(async response => {
      if (!response.ok) throw new Error('Navigation unavailable');
      const cache = await caches.open(CACHE_NAME);
      await cache.put(INDEX_URL, response.clone());
      return response;
    });
    event.waitUntil(network.catch(() => undefined));
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(INDEX_URL);
      if (cached) return cached;
      try { return await network; }
      catch { return Response.error(); }
    })());
    return;
  }

  if (url.origin === self.location.origin && (url.pathname.includes('/assets/') || /\.(?:js|css|svg|png|jpg|webp|woff2|ico|webmanifest)$/.test(url.pathname))) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);
      const network = fetch(request).then(response => {
        if (response.ok) cache.put(request, response.clone());
        return response;
      }).catch(() => cached);
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
