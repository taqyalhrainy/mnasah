const CACHE_NAME = 'mansah-shell-v2';
const shellUrl = path => new URL(path, self.registration.scope).href;
const INDEX_URL = shellUrl('index.html');
const SHELL_FILES = ['', 'index.html', 'icon.svg', 'manifest.webmanifest'].map(shellUrl);

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
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const response = await fetch(request);
        cache.put(INDEX_URL, response.clone());
        return response;
      } catch {
        return (await cache.match(INDEX_URL)) || Response.error();
      }
    })());
    return;
  }

  if (url.origin === self.location.origin && (url.pathname.includes('/assets/') || /\.(?:js|css|svg|png|webp|ico|webmanifest)$/.test(url.pathname))) {
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

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/students', self.location.origin);
  if (target.origin !== self.location.origin || !/^\/(teachers|students)$/.test(target.pathname)) return;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(client => new URL(client.url).pathname === target.pathname);
    if (existing) {
      existing.postMessage({ type: 'lesson-reminder', id: target.searchParams.get('lesson') });
      return existing.focus();
    }
    return self.clients.openWindow(target.href);
  })());
});
