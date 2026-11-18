import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import webpush from 'web-push';
import { startPlatformServer } from '../server/index.js';
import { memoryMongo } from './helpers/memory-mongo.mjs';

const { httpServer, io } = await startPlatformServer({ database: memoryMongo(), port: 0 });
const base = `http://127.0.0.1:${httpServer.address().port}`, publicKey = webpush.generateVAPIDKeys().publicKey;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const result of ['granted', 'denied', 'setup-failure', 'granted-reopen']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await context.addInitScript(({ result, publicKey }) => {
      const state = window.__push = { permission: localStorage.getItem('test-notification-permission') || (result === 'granted-reopen' ? 'granted' : 'default'), calls: 0, subscribed: false, gesture: false };
      Object.defineProperty(window, 'Notification', { configurable: true, value: { get permission() { return state.permission; }, requestPermission() { state.calls++; state.gesture = navigator.userActivation.isActive; state.permission = result === 'denied' ? 'denied' : 'granted'; localStorage.setItem('test-notification-permission', state.permission); window.dispatchEvent(new Event('focus')); return Promise.resolve(state.permission); } } });
      Object.defineProperty(window, 'PushManager', { configurable: true, value: function() {} });
      const bytes = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
      const subscription = { endpoint: 'https://web.push.apple.com/test-owner-phone', options: { applicationServerKey: bytes.buffer }, toJSON: () => ({ endpoint: subscription.endpoint, keys: { p256dh: publicKey, auth: 'AAAAAAAAAAAAAAAAAAAAAA' } }) };
      const registration = { pushManager: { getSubscription: async () => state.subscribed ? subscription : null, subscribe: async () => { state.subscribed = true; return subscription; } } };
      const worker = new EventTarget(); worker.ready = Promise.resolve(registration); worker.getRegistration = async () => registration; worker.register = async () => registration;
      Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: worker });
    }, { result, publicKey });
    const page = await context.newPage(), errors = []; let registered = false;
    let registrationStarted, heldRegistration, releaseFailure = false, recovered = false;
    const registrationWaiting = new Promise(resolve => { registrationStarted = resolve; });
    page.on('pageerror', error => errors.push(error.message));
    await page.route(/^https:\/\//, route => route.abort());
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/auth/me')) return route.fulfill({ json: { user: { id: 'owner', role: 'admin', status: 'active', name: 'Owner', email: 'owner@test.com', subject: '', bio: '' } } });
      if (path.endsWith('/public/config')) return route.fulfill({ json: { vapidPublicKey: publicKey } });
      if (path.endsWith('/push/subscribe')) {
        if (['setup-failure', 'granted-reopen'].includes(result) && !recovered) {
          if (!releaseFailure) { heldRegistration = route; registrationStarted(); return; }
          return route.fulfill({ status: 503, json: { error: 'Registration temporarily unavailable' } });
        }
        registered = true; return route.fulfill({ json: { ok: true } });
      }
      if (path.endsWith('/push/status')) return route.fulfill({ json: { enabled: registered } });
      return route.fulfill({ json: { bookings: [], slots: [], users: [], events: [], topups: [], wallets: [], notifications: [], unreadByView: {}, groups: [], categories: [] } });
    });
    await page.goto(base + '/owner', { waitUntil: 'domcontentloaded' });
    const dialog = page.locator('.notification-help');
    if (result === 'granted-reopen') {
      await registrationWaiting;
      assert.equal(await dialog.count(), 0, 'an already granted device is usable while push setup is still pending');
    } else await dialog.waitFor();
    if (result !== 'granted-reopen') {
    assert.equal(await dialog.getByRole('button').count(), 1, 'no later or close button');
    assert.equal(await page.evaluate(() => window.__push.calls), 0, 'only request the native permission after a user action');
    await page.keyboard.press('Escape'); await page.mouse.click(3, 3);
    assert.equal(await dialog.isVisible(), true, 'escape/backdrop cannot dismiss the consent');
    await dialog.getByRole('button', { name: 'السماح بالإشعارات', exact: true }).tap();
    await page.waitForFunction(() => window.__push.calls === 1);
    assert.equal(await page.evaluate(() => window.__push.gesture), true);
    }
    if (['setup-failure', 'granted-reopen'].includes(result)) {
      await registrationWaiting;
      await dialog.waitFor({ state: 'detached' });
      await page.locator('details.account-menu > summary').click();
      assert.equal(await page.locator('.owner-account-dropdown').isVisible(), true, 'site remains interactive before registration completes');
      releaseFailure = true;
      await heldRegistration.fulfill({ status: 503, json: { error: 'Registration temporarily unavailable' } });
      await page.waitForFunction(() => !document.querySelector('.device-notification-toggle')?.disabled);
      assert.equal(await dialog.count(), 0, 'push setup failure must never reopen permission consent');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('details.account-menu > summary').click();
      await page.locator('.device-notification-toggle').waitFor();
      assert.equal(await dialog.count(), 0, 'reopening with permission granted and no registered subscription must not lock the site');
      assert.equal(await page.evaluate(() => window.__push.calls), 0, 'do not request native permission when it is already granted');
      recovered = true;
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await page.waitForFunction(() => document.querySelector('.device-notification-toggle')?.getAttribute('aria-pressed') === 'true');
      assert.equal(registered, true, 'recover push registration without requesting permission again');
      assert.deepEqual(errors, []); await context.close(); continue;
    }
    if (result === 'granted') {
      await dialog.waitFor({ state: 'detached' }); assert.equal(registered, true);
      await page.evaluate(() => { window.__push.permission = 'denied'; window.dispatchEvent(new Event('focus')); });
      await page.locator('details.account-menu > summary').click();
      await page.waitForFunction(() => document.querySelector('.device-notification-toggle')?.getAttribute('aria-pressed') === 'false');
      assert.equal(await dialog.count(), 0, 'revoking permission must not lock the user out');
    } else {
      await dialog.waitFor({ state: 'detached' });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('details.account-menu > summary').click();
      await page.locator('.device-notification-toggle').waitFor();
      assert.equal(await dialog.count(), 0, 'previously blocked devices can use the site after reopening');
      assert.equal(await page.evaluate(() => window.__push.calls), 0, 'do not automatically retry native permission after a block');
      // Simulate the browser resetting an old block to Ask: a new native request is valid again.
      await page.evaluate(() => { window.__push.permission = 'default'; window.dispatchEvent(new Event('focus')); });
      await dialog.getByRole('button', { name: 'السماح بالإشعارات', exact: true }).waitFor();
      await dialog.getByRole('button', { name: 'السماح بالإشعارات', exact: true }).tap();
      await dialog.waitFor({ state: 'detached' });
      assert.equal(await page.evaluate(() => window.__push.calls), 1, 'a real reset to Ask permits a new native prompt');
      if (!await page.locator('.device-notification-toggle').isVisible()) await page.locator('details.account-menu > summary').click();
      await page.locator('.device-notification-toggle').click();
      await dialog.getByRole('button', { name: 'تحقق مرة أخرى', exact: true }).waitFor();
      await dialog.getByRole('button', { name: 'تحقق مرة أخرى', exact: true }).tap();
      assert.equal(await page.evaluate(() => window.__push.calls), 1, 'manual help does not repeat a blocked native prompt');
      await dialog.getByRole('button', { name: 'إغلاق', exact: true }).tap();
      await dialog.waitFor({ state: 'detached' });
      if (!await page.locator('.device-notification-toggle').isVisible()) await page.locator('details.account-menu > summary').click();
      await page.locator('.device-notification-toggle').click();
      await page.evaluate(() => { window.__push.permission = 'granted'; });
      await dialog.getByRole('button', { name: 'تحقق مرة أخرى', exact: true }).tap();
      await dialog.waitFor({ state: 'detached' }); assert.equal(registered, true);
    }
    assert.deepEqual(errors, []); await context.close();
  }
  console.log('Native grant removes consent before push setup; registration failure/reopen never locks the site; online recovery, denial/revocation and a browser reset to Ask work correctly.');
} finally { await browser.close(); await new Promise(resolve => io.close(() => httpServer.close(resolve))); }
