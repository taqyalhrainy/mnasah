self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', () => {});

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
