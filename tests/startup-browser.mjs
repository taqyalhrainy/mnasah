import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { startPlatformServer } from '../server/index.js';
import { memoryMongo } from './helpers/memory-mongo.mjs';

const entry = readFileSync('dist/client/index.html', 'utf8').match(/<script type="module"[^>]*src="([^"]+)"/)[1];
const db = memoryMongo({ users: [{ id: 'teacher', name: 'Teacher', email: 'teacher@test.invalid', role: 'teachers', status: 'active', subject: '', bio: '' }], sessions: [{ token: crypto.createHash('sha256').update('saved-session').digest('hex'), user_id: 'teacher', expires: Date.now() + 3600000 }] });
const { httpServer, io } = await startPlatformServer({ database: db, port: 0, portalMode: 'public' });
const base = `http://127.0.0.1:${httpServer.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  // A failed entry script used to strand the original boot screen indefinitely.
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
  await context.addCookies([{ name: 'mansah_session_teachers', value: 'saved-session', url: base }]);
  const page = await context.newPage(), navigations = [];
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
  let fail = true;
  await page.route(`**${entry}`, route => { if (fail) { fail = false; return route.abort(); } return route.continue(); });
  await page.goto(base + '/teachers?view=rooms', { waitUntil: 'commit' });
  await page.locator('.app-shell').waitFor();
  assert.ok(navigations.some(url => url.includes('__app_reload=')), 'entry failure must fetch a fresh document');
  assert.equal(new URL(page.url()).searchParams.has('__app_reload'), false);
  assert.equal(new URL(page.url()).searchParams.get('view'), 'rooms');
  assert.ok((await context.cookies()).some(cookie => cookie.name === 'mansah_session_teachers' && cookie.value === 'saved-session'), 'recovery must preserve login');
  await context.close();

  // Repeated load failures offer a real retry rather than an automatic loop,
  // including Safari/private contexts where sessionStorage may throw.
  const blocked = await browser.newContext({ serviceWorkers: 'block' });
  await blocked.addInitScript(() => Object.defineProperty(window, 'sessionStorage', { get() { throw new Error('disabled storage'); } }));
  const broken = await blocked.newPage();
  let denied = true, loads = 0;
  broken.on('framenavigated', frame => { if (frame === broken.mainFrame()) loads++; });
  await broken.route(`**${entry}`, route => denied ? route.abort() : route.continue());
  await broken.goto(base + '/students', { waitUntil: 'commit' });
  await broken.locator('#boot-retry').waitFor();
  assert.equal(loads, 2);
  denied = false;
  await broken.locator('#boot-retry').click();
  await broken.locator('.auth-account-choice').waitFor();
  await blocked.close();

  // Exercise the actual installed worker with an intentionally stale shell.
  const cached = await browser.newContext();
  const cachedPage = await cached.newPage();
  await cachedPage.goto(base + '/students');
  await cachedPage.locator('.auth-account-choice').waitFor();
  await cachedPage.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    const cache = await caches.open('imtidad-shell-v37');
    await cache.put(new URL('/index.html', location.href), new Response('<html><body>stale build</body></html>', { headers: { 'content-type': 'text/html' } }));
  });
  await cachedPage.reload();
  await cachedPage.locator('.auth-account-choice').waitFor();
  assert.doesNotMatch(await cachedPage.locator('body').innerText(), /stale build/);
  await cached.close();

  // Slow/failed auth is bounded and can be retried in-place without logging out.
  const timed = await browser.newContext({ serviceWorkers: 'block' });
  const slow = await timed.newPage();
  await slow.clock.install();
  let hang = true;
  await slow.route('**/api/auth/me?**', route => hang ? undefined : route.fulfill({ json: { user: null } }));
  await slow.goto(base + '/students', { waitUntil: 'domcontentloaded' });
  await slow.locator('.wake-spinner').waitFor();
  for (const ms of [10001, 1001, 10001, 2001, 10001]) { await slow.clock.runFor(ms); await slow.waitForTimeout(30); }
  await slow.getByRole('alert').waitFor({ timeout: 3000 });
  assert.equal(await slow.locator('.wake-spinner').count(), 0, 'auth must leave loading after finite retries');
  hang = false;
  await slow.locator('.wake-card button').click();
  await slow.locator('.auth-account-choice').waitFor();
  await timed.close();
  console.log('Startup regression passed: failed chunks, blocked storage, preserved session, stale SW HTML, bounded auth and retry.');
} finally { await browser.close(); await new Promise(resolve => io.close(() => httpServer.close(resolve))); }
