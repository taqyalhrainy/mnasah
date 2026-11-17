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
      const state = window.__push = { permission: 'default', calls: 0, subscribed: false, gesture: false };
      Object.defineProperty(window, 'Notification', { configurable: true, value: { get permission() { return state.permission; }, requestPermission() { state.calls++; state.gesture = navigator.userActivation.isActive; state.permission = result; return Promise.resolve(result); } } });
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
    } else {
      await dialog.getByRole('button', { name: 'تحقق مرة أخرى', exact: true }).waitFor();
      assert.equal(await page.locator('.notification-help').count(), 1, 'only the blocked-permission help remains');
      await page.keyboard.press('Escape'); assert.equal(await dialog.isVisible(), true);
      await dialog.getByRole('button', { name: 'تحقق مرة أخرى', exact: true }).tap();
      assert.equal(await page.evaluate(() => window.__push.calls), 1, 'do not pretend the browser can reprompt a denied permission');
      await page.evaluate(() => { window.__push.permission = 'granted'; });
      await dialog.getByRole('button', { name: 'تحقق مرة أخرى', exact: true }).tap();
      await dialog.waitFor({ state: 'detached' }); assert.equal(registered, true);
    }
    assert.deepEqual(errors, []); await context.close();
  }
  console.log('Mandatory notification consent persists; grant enables push; denied devices receive persistent settings help and recover after permission changes.');
} finally { await browser.close(); await new Promise(resolve => io.close(() => httpServer.close(resolve))); }
