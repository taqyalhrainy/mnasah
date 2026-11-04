import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import webpush from 'web-push';
import { mkdir } from 'node:fs/promises';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const base = process.env.UI_BASE_URL || 'http://127.0.0.1:5192';
const publicKey = webpush.generateVAPIDKeys().publicKey;
await mkdir('.private/owner-push', { recursive: true });
try {
  for (const scenario of [{ name: 'iphone', result: 'granted', theme: 'light' }, { name: 'android', result: 'granted', theme: 'dark' }, { name: 'denied', result: 'denied', theme: 'light' }]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, reducedMotion: 'reduce', userAgent: scenario.name === 'android' ? 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36' : 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' });
    const page = await context.newPage();
    await page.route(/^https:\/\//, route => route.abort());
    await page.addInitScript(({ result, theme, publicKey }) => {
      localStorage.setItem('mansah-theme', theme);
      const state = window.__push = { calls: Number(localStorage.getItem('test-permission-calls') || 0), gesture: false, subscribed: localStorage.getItem('test-subscription') === '1', permission: localStorage.getItem('test-permission') || 'default' };
      Object.defineProperty(window, 'Notification', { configurable: true, value: { get permission() { return state.permission; }, requestPermission() { state.calls++; state.gesture = navigator.userActivation.isActive; state.permission = result; localStorage.setItem('test-permission', result); localStorage.setItem('test-permission-calls', String(state.calls)); return Promise.resolve(result); } } });
      Object.defineProperty(window, 'PushManager', { configurable: true, value: function() {} });
      const bytes = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
      const subscription = { endpoint: 'https://web.push.apple.com/test-owner-phone', options: { applicationServerKey: bytes.buffer }, toJSON: () => ({ endpoint: subscription.endpoint, keys: { p256dh: publicKey, auth: 'AAAAAAAAAAAAAAAAAAAAAA' } }), unsubscribe: async () => { state.subscribed = false; localStorage.removeItem('test-subscription'); return true; } };
      const registration = { pushManager: { getSubscription: async () => state.subscribed ? subscription : null, subscribe: async () => { state.subscribed = true; localStorage.setItem('test-subscription', '1'); return subscription; } } };
      const worker = new EventTarget(); worker.ready = Promise.resolve(registration); worker.getRegistration = async () => registration; worker.register = async () => registration;
      Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: worker });
    }, { ...scenario, publicKey });
    let registered = false, writes = 0, testPushes = 0;
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/auth/me')) return route.fulfill({ json: { user: { id: 'owner', role: 'admin', status: 'active', name: 'الأونر', email: 'owner@test.com', subject: '', bio: '' } } });
      if (path.endsWith('/public/config')) return route.fulfill({ json: { vapidPublicKey: publicKey } });
      if (path.endsWith('/push/subscribe')) { registered = true; writes++; return route.fulfill({ json: { ok: true } }); }
      if (path.endsWith('/push/status')) return route.fulfill({ json: { enabled: registered } });
      if (path.endsWith('/push/unsubscribe')) { registered = false; return route.fulfill({ json: { ok: true } }); }
      if (path.endsWith('/push/test')) { assert.equal(registered, true); testPushes++; return route.fulfill({ json: { ok: true } }); }
      return route.fulfill({ json: { bookings: [], slots: [], users: [], events: [], topups: [], wallets: [], notifications: [], unreadByView: {}, groups: [], categories: [] } });
    });
    await page.goto(base + '/owner', { waitUntil: 'domcontentloaded' });
    await page.locator('details.account-menu > summary').click();
    const menuBounds = await page.locator('.owner-account-dropdown').boundingBox();
    assert.ok(menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= 390, 'notification menu must fit inside the phone screen');
    assert.equal(await page.evaluate(() => window.__push.calls), 0, 'must not prompt automatically on app launch');
    const toggle = page.locator('.device-notification-toggle');
    await toggle.click();
    await page.waitForFunction(() => !document.querySelector('.device-notification-toggle')?.disabled);
    assert.equal(await page.evaluate(() => window.__push.gesture), true, 'OS permission must be requested during the account button gesture');
    if (scenario.result === 'denied') {
      assert.equal(await toggle.getAttribute('aria-pressed'), 'false'); assert.equal(writes, 0);
      await page.getByRole('status').filter({ hasText: 'إذن التنبيهات مرفوض' }).waitFor();
    } else {
      assert.equal(await toggle.getAttribute('aria-pressed'), 'true'); assert.equal(writes, 1);
      await page.getByRole('button', { name: 'إرسال إشعار تجريبي', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'تم إرسال الإشعار التجريبي' }).waitFor();
      assert.equal(testPushes, 1);
      await page.screenshot({ path: `.private/owner-push/${scenario.name}.png` });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('details.account-menu > summary').click();
      await page.waitForFunction(() => document.querySelector('.device-notification-toggle')?.getAttribute('aria-pressed') === 'true');
      assert.equal(await page.evaluate(() => window.__push.calls), 1, 'existing permission must not be requested again');
      await toggle.click();
      await page.waitForFunction(() => document.querySelector('.device-notification-toggle')?.getAttribute('aria-pressed') === 'false');
      assert.equal(registered, false);
      await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'platform-notification', view: 'topups' } })));
      await page.locator('.nav-button[aria-current="page"]').filter({ hasText: 'شحن المحافظ' }).waitFor();
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await context.close(); console.log(scenario.name + ': owner permission, registration and notification controls passed');
  }
} finally { await browser.close(); }
