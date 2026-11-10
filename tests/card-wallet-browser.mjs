import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startPlatformServer } from '../server/index.js';
import { memoryMongo } from './helpers/memory-mongo.mjs';

const user = { id: 'card-ui', role: 'students', status: 'active', name: 'Student', email: 'student@example.com' };
const db = memoryMongo({ users: [user], sessions: [{ user_id: user.id, token: crypto.createHash('sha256').update('card-ui').digest('hex'), expires: Date.now() + 3600000 }] });
const { httpServer, io } = await startPlatformServer({ database: db, port: 0 });
const base = `http://127.0.0.1:${httpServer.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext();
  await context.addCookies([{ name: 'mansah_session_students', value: 'card-ui', url: base }]);
  for (const host of ['fonts.googleapis.com', 'fonts.gstatic.com', 'accounts.google.com']) await context.route(`https://${host}/**`, route => route.abort());
  let enabled = false, requestBody;
  await context.route('**/api/students/wallet', async route => {
    const response = await route.fetch(); const data = await response.json();
    data.payment.card = { ready: enabled, provider: 'paytabs', currency: 'JOD' };
    await route.fulfill({ json: data });
  });
  await context.route('**/api/students/wallet/card', async route => {
    requestBody = route.request().postDataJSON();
    await route.fulfill({ json: { checkout_url: 'https://secure-jordan.paytabs.com/payment/page/ui-test' } });
  });
  await context.route('https://secure-jordan.paytabs.com/**', route => route.fulfill({ contentType: 'text/html', body: '<p>Intercepted; no actual payment.</p>' }));
  const page = await context.newPage();
  await page.goto(`${base}/students?view=wallet`, { waitUntil: 'domcontentloaded' });
  await page.locator('.wallet-charge-card').waitFor();
  assert.equal(await page.locator('.wallet-payment-methods > button').count(), 2, 'unconfigured cards are hidden');
  enabled = true; await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.wallet-payment-methods > button').nth(2).waitFor();
  if (await page.locator('.notification-prompt-close').isVisible()) await page.locator('.notification-prompt-close').click();
  for (const width of [390, 820, 1366]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(v => document.documentElement.dataset.theme = v, theme);
      await page.locator('.wallet-payment-methods > button').nth(1).click();
      assert.equal(await page.locator('.paypal-currency-details').count(), 0, 'direct cards do not convert to USD');
      assert.equal(await page.locator('.paypal-checkout-panel button').isEnabled(), true);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
  }
  await page.locator('#wallet-topup-amount').fill('0');
  assert.equal(await page.locator('.paypal-checkout-panel button').isDisabled(), true);
  await page.locator('#wallet-topup-amount').fill('10');
  await page.locator('.paypal-checkout-panel button').click();
  await page.waitForURL('https://secure-jordan.paytabs.com/**');
  assert.equal(requestBody.amount, '10.00');
  assert.equal((await db.collection('wallet_accounts').findOne({ user_id: user.id })).balance, 0);
  console.log('Direct card UI: activation gating, mobile/desktop, dark/light, exact JOD quote and safe redirect passed.');
} finally { await browser.close(); await new Promise(resolve => io.close(() => httpServer.close(resolve))); }
