import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import webpush from 'web-push';
import { startPlatformServer } from '../server/index.js';
import { memoryMongo } from './helpers/memory-mongo.mjs';

const { httpServer, io } = await startPlatformServer({ database: memoryMongo(), port: 0 });
const base = `http://127.0.0.1:${httpServer.address().port}`, publicKey = webpush.generateVAPIDKeys().publicKey;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const result of ['granted', 'denied']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await context.addInitScript(({ result, publicKey }) => {
      const state = window.__push = { permission: localStorage.getItem('test-notification-permission') || 'default', calls: 0, subscribed: false, gesture: false };
      Object.defineProperty(window, 'Notification', { configurable: true, value: { get permission() { return state.permission; }, requestPermission() { state.calls++; state.gesture = navigator.userActivation.isActive; state.permission = result; localStorage.setItem('test-notification-permission', result); return Promise.resolve(result); } } });
      Object.defineProperty(window, 'PushManager', { configurable: true, value: function() {} });
      const bytes = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
      const subscription = { endpoint: 'https://web.push.apple.com/test-owner-phone', options: { applicationServerKey: bytes.buffer }, toJSON: () => ({ endpoint: subscription.endpoint, keys: { p256dh: publicKey, auth: 'AAAAAAAAAAAAAAAAAAAAAA' } }) };
      const registration = { pushManager: { getSubscription: async () => state.subscribed ? subscription : null, subscribe: async () => { state.subscribed = true; return subscription; } } };
      const worker = new EventTarget(); worker.ready = Promise.resolve(registration); worker.getRegistration = async () => registration; worker.register = async () => registration;
      Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: worker });
    }, { result, publicKey });
    const page = await context.newPage(), errors = []; let registered = false;
    page.on('pageerror', error => errors.push(error.message));
    await page.route(/^https:\/\//, route => route.abort());
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/auth/me')) return route.fulfill({ json: { user: { id: 'owner', role: 'admin', status: 'active', name: 'Owner', email: 'owner@test.com', subject: '', bio: '' } } });
      if (path.endsWith('/public/config')) return route.fulfill({ json: { vapidPublicKey: publicKey } });
      if (path.endsWith('/push/subscribe')) { registered = true; return route.fulfill({ json: { ok: true } }); }
      if (path.endsWith('/push/status')) return route.fulfill({ json: { enabled: registered } });
      return route.fulfill({ json: { bookings: [], slots: [], users: [], events: [], topups: [], wallets: [], notifications: [], unreadByView: {}, groups: [], categories: [] } });
    });
    await page.goto(base + '/owner', { waitUntil: 'domcontentloaded' });
    const dialog = page.locator('.notification-help'); await dialog.waitFor();
    assert.equal(await dialog.getByRole('button').count(), 1, 'no later or close button');
    assert.equal(await page.evaluate(() => window.__push.calls), 0, 'only request the native permission after a user action');
    await page.keyboard.press('Escape'); await page.mouse.click(3, 3);
    assert.equal(await dialog.isVisible(), true, 'escape/backdrop cannot dismiss the consent');
    await dialog.getByRole('button', { name: 'السماح بالإشعارات', exact: true }).tap();
    await page.waitForFunction(() => window.__push.calls === 1);
    assert.equal(await page.evaluate(() => window.__push.gesture), true);
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
      await page.locator('.device-notification-toggle').click();
      await dialog.getByRole('button', { name: 'تحقق مرة أخرى', exact: true }).waitFor();
      await dialog.getByRole('button', { name: 'تحقق مرة أخرى', exact: true }).tap();
      assert.equal(await page.evaluate(() => window.__push.calls), 0, 'manual help does not repeat a blocked native prompt');
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
  console.log('First consent stays required; native denial/revocation never blocks the site, including after reload; manual permission help is dismissible and can recover.');
} finally { await browser.close(); await new Promise(resolve => io.close(() => httpServer.close(resolve))); }
