import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const navigation = url => Object.defineProperty(new Request(url), 'mode', { value: 'navigate' });

test('public discovery documents bypass the cached portal shell', async () => {
  const handlers = {};
  const origin = 'https://emtidad-alelm.onrender.com';
  const self = { registration: { scope: origin + '/' }, location: { origin }, addEventListener: (name, handler) => { handlers[name] = handler; } };
  const fetched = [];
  vm.runInNewContext(readFileSync('public/service-worker.js', 'utf8'), {
    self, URL, Response,
    fetch: async request => { fetched.push(request.url); return new Response('public document'); },
    caches: { open() { throw new Error('public documents must not read or overwrite the app shell'); } },
  });
  for (const pathname of ['/about/', '/about', '/robots.txt', '/sitemap.xml', '/google2431f05154e788a3.html']) {
    let result;
    handlers.fetch({ request: { method: 'GET', mode: 'navigate', url: origin + pathname }, respondWith: promise => { result = promise; } });
    assert.equal(await (await result).text(), 'public document');
  }
  assert.equal(fetched.length, 5);
});

test('navigation falls back to the platform shell on a temporary server error', async () => {
  const handlers = {};
  const origin = 'https://emtidad-alelm.onrender.com';
  const self = { registration: { scope: origin + '/' }, location: { origin }, addEventListener: (name, handler) => { handlers[name] = handler; } };
  const cached = new Response('platform shell');
  vm.runInNewContext(readFileSync('public/service-worker.js', 'utf8'), { self, URL, Request, Response, setTimeout, clearTimeout, fetch: async () => new Response('server error', { status: 503 }), caches: { open: async () => ({ match: async () => cached }) } });
  let result;
  handlers.fetch({ request: navigation(origin + '/students'), waitUntil: promise => promise.catch(() => {}), respondWith: promise => { result = promise; } });
  assert.equal(await (await result).text(), 'platform shell');
});

test('a slow server falls back to cached HTML within a bounded delay', async () => {
  const handlers = {};
  const origin = 'https://emtidad-alelm.onrender.com';
  const self = { registration: { scope: origin + '/' }, location: { origin }, addEventListener: (name, handler) => { handlers[name] = handler; } };
  const cached = new Response('instant shell');
  vm.runInNewContext(readFileSync('public/service-worker.js', 'utf8'), {
    self, URL, Request, Response, setTimeout: callback => setTimeout(callback, 5), clearTimeout,
    fetch: () => new Promise(() => {}),
    caches: { open: async () => ({ match: async () => cached }) },
  });
  let result;
  handlers.fetch({ request: navigation(origin + '/students'), waitUntil: () => {}, respondWith: promise => { result = promise; } });
  const response = await Promise.race([result, new Promise((_, reject) => setTimeout(() => reject(new Error('cached navigation waited for the server')), 100))]);
  assert.equal(await response.text(), 'instant shell');
});

test('a hosting wake-up page with HTTP 200 never replaces the installed app', async () => {
  const handlers = {}, work = [];
  const origin = 'https://emtidad-alelm.onrender.com';
  const self = { registration: { scope: origin + '/' }, location: { origin }, addEventListener: (name, handler) => { handlers[name] = handler; } };
  vm.runInNewContext(readFileSync('public/service-worker.js', 'utf8'), {
    self, URL, Request, Response, setTimeout, clearTimeout,
    fetch: async () => new Response('<html>Render is starting your service</html>'),
    caches: { open: async () => ({ match: async () => new Response('saved application'), put: () => { throw new Error('must not save provider page'); } }) },
  });
  let result;
  handlers.fetch({ request: navigation(origin + '/teachers'), waitUntil: p => work.push(p), respondWith: p => { result = p; } });
  assert.equal(await (await result).text(), 'saved application');
  await Promise.all(work);
});

test('fresh HTML wins over stale cache and recovery bypasses it; cache failures do not break loads', async () => {
  for (const storageFails of [false, true]) {
    const handlers = {}, work = [];
    const origin = 'https://emtidad-alelm.onrender.com';
    const self = { registration: { scope: origin + '/' }, location: { origin }, addEventListener: (name, handler) => { handlers[name] = handler; } };
    vm.runInNewContext(readFileSync('public/service-worker.js', 'utf8'), {
      self, URL, Request, Response, setTimeout, clearTimeout,
      fetch: async request => { assert.equal(request.cache, 'no-store'); return new Response('fresh build<script id="boot-recovery"></script>'); },
      caches: { open: async () => { if (storageFails) throw new Error('storage unavailable'); return { match: async () => new Response('old build'), put: async () => { throw new Error('quota full'); } }; } },
    });
    for (const path of ['/students', '/students?__app_reload=123']) {
      let result;
      handlers.fetch({ request: navigation(origin + path), waitUntil: promise => work.push(promise), respondWith: promise => { result = promise; } });
      assert.equal(await (await result).text(), 'fresh build<script id="boot-recovery"></script>');
    }
    await Promise.all(work);
  }
});

test('an installed worker without a cached shell shows branded loading instead of the provider page', async () => {
  const handlers = {}, work = [];
  const origin = 'https://emtidad-alelm.onrender.com';
  const self = { registration: { scope: origin + '/' }, location: { origin }, addEventListener: (name, handler) => { handlers[name] = handler; } };
  vm.runInNewContext(readFileSync('public/service-worker.js', 'utf8'), {
    self, URL, Request, Response, setTimeout, clearTimeout,
    fetch: async () => new Response('<html>Render wake page</html>'),
    caches: { open: async () => ({ match: async () => undefined }) },
  });
  let result;
  handlers.fetch({ request: navigation(origin + '/students'), waitUntil: p => work.push(p), respondWith: p => { result = p; } });
  const response = await result, html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /ثواني وبنكون معك/);
  assert.doesNotMatch(html, /Render wake page/);
  await Promise.all(work);
});

test('background worker shows owner notifications without an open page and opens the target section', async () => {
  const handlers = {}, shown = [], messages = [], opened = [];
  let running = [];
  const origin = 'https://emtidad-alelm-owner.onrender.com';
  const self = { location: { origin, hostname: 'emtidad-alelm-owner.onrender.com' }, registration: { scope: origin + '/', showNotification: async (...args) => shown.push(args) }, addEventListener: (name, action) => { handlers[name] = action; }, clients: { matchAll: async () => running, openWindow: async url => opened.push(url) } };
  vm.runInNewContext(readFileSync('public/service-worker.js', 'utf8'), { self, URL });
  let completion;
  const waitUntil = promise => { completion = promise; };
  handlers.push({ data: { json: () => ({ title: 'طلب شحن محفظة', body: 'طلب جديد', url: '/owner?view=topups', tag: 'admin-1' }) }, waitUntil });
  await completion; assert.equal(shown.length, 1); assert.equal(shown[0][0], 'طلب شحن محفظة');
  handlers.notificationclick({ notification: { close() {}, data: shown[0][1].data }, waitUntil });
  await completion; assert.deepEqual(opened, [origin + '/owner?view=topups']);
  running = [{ url: origin + '/owner', postMessage: value => messages.push(value), focus: async () => {} }];
  handlers.notificationclick({ notification: { close() {}, data: shown[0][1].data }, waitUntil });
  await completion; assert.equal(messages[0].type, 'platform-notification'); assert.equal(messages[0].view, 'topups');
  handlers.push({ data: { json() { throw new Error('invalid'); } }, waitUntil });
  await completion; assert.equal(shown.length, 2, 'push must always display a notification');
});
