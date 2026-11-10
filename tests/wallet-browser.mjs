import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { startPlatformServer } from '../server/index.js';
import { memoryMongo } from './helpers/memory-mongo.mjs';

const user = { id: 'wallet-ui', role: 'students', status: 'active', name: 'Wallet student', email: 'student@wallet.test' };
const db = memoryMongo({ users: [user], sessions: [{ user_id: user.id, token: crypto.createHash('sha256').update('wallet-ui-token').digest('hex'), expires: Date.now() + 3600000 }], platform_settings: [{ key: 'payments', value: { cliq_alias: 'TAQY123', cliq_name: 'Beneficiary' } }] });
const stored = new Map();
const { httpServer, io } = await startPlatformServer({ database: db, port: 0, topupProofStore: { async write(id, _name, source) { const chunks = []; for await (const chunk of source) chunks.push(Buffer.from(chunk)); stored.set(id, Buffer.concat(chunks)); }, read: id => Readable.from([stored.get(id)]), async remove(id) { stored.delete(id); } } });
const base = `http://127.0.0.1:${httpServer.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext();
  await context.addCookies([{ name: 'mansah_session_students', value: 'wallet-ui-token', url: base }]);
  for (const host of ['fonts.googleapis.com', 'fonts.gstatic.com', 'accounts.google.com']) await context.route(`https://${host}/**`, route => route.abort());
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/students?view=wallet`);
  await page.locator('.wallet-charge-card').waitFor();
  if (await page.locator('.notification-prompt-close').isVisible()) await page.locator('.notification-prompt-close').click();
  assert.equal(await page.locator('.wallet-ledger').count(), 0, 'history stays out of the top-up flow');
  assert.equal(await page.locator('.wallet-payment-methods > button').count(), 2);
  for (const width of [390, 820, 1366]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await page.locator('.wallet-payment-methods > button').first().click();
      assert.equal(await page.locator('.cliq-alias-card strong').innerText(), 'TAQY123');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.evaluate(() => window.scrollTo(0,0));
      await page.screenshot({ path: `.private/wallet-${width}-${theme}-cliq.png`, fullPage: true });
      await page.locator('.wallet-payment-methods > button').last().click();
      assert.doesNotMatch(await page.locator('.paypal-charge-summary').innerText(), /USD/);
      assert.equal(await page.locator('.paypal-currency-details > strong').isVisible(), false);
      await page.locator('.paypal-currency-details summary').click();
      assert.match(await page.locator('.paypal-currency-details').innerText(), /14\.11 USD/);
      await page.locator('.paypal-currency-details summary').click();
      assert.equal(await page.locator('.paypal-pay-button').isEnabled(), true);
      const inputStyle = await page.locator('#wallet-topup-amount').evaluate(el => ({ background: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color }));
      if (theme === 'dark') assert.notEqual(inputStyle.color, 'rgb(16, 24, 40)', 'dark input text stays readable');
      await page.evaluate(() => window.scrollTo(0,0));
      await page.screenshot({ path: `.private/wallet-${width}-${theme}-paypal.png`, fullPage: true });
    }
  }
  await page.locator('#wallet-topup-amount').fill('20');
  await page.locator('.paypal-currency-details summary').click();
  assert.match(await page.locator('.paypal-currency-details').innerText(), /28\.21 USD/);
  await page.locator('#wallet-topup-amount').fill('0');
  assert.equal(await page.locator('.paypal-pay-button').isDisabled(), true);
  await page.locator('#wallet-topup-amount').fill('10');
  let checkout;
  await page.route('https://www.paypal.com/**', route => { checkout = new URL(route.request().url()); return route.fulfill({ contentType: 'text/html', body: '<p>Hosted checkout intercepted without payment.</p>' }); });
  await page.locator('.paypal-pay-button').click();
  await page.waitForURL('https://www.paypal.com/**');
  assert.equal(checkout.searchParams.get('business'), 'takee12345678900@gmail.com');
  assert.equal(checkout.searchParams.get('currency_code'), 'USD');
  assert.equal(checkout.searchParams.get('amount'), '14.11');
  assert.equal((await db.collection('wallet_accounts').findOne({ user_id: user.id })).balance, 0, 'opening checkout does not credit the wallet');
  await page.goto(`${base}/students?view=wallet&paypal=return&order=${checkout.searchParams.get('invoice')}`);
  await page.locator('.wallet-payment-notice[role=status]').waitFor();
  assert.equal(await page.locator('.notice.success').count(), 0, 'return URL is not payment proof');
  assert.equal((await db.collection('wallet_accounts').findOne({ user_id: user.id })).balance, 0);
  await page.goto(`${base}/students?view=wallet`);
  await page.locator('.wallet-charge-card').waitFor();
  await page.locator('input[type=file]').setInputFiles({ name: 'receipt.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]) });
  await page.locator('.topup-submit').click();
  await page.locator('.topup-submitted-dialog').waitFor();
  await page.locator('.topup-submitted-dialog .primary-button').click();
  await page.locator('.wallet-request-history .topup-history article').first().waitFor();
  assert.equal((await db.collection('wallet_accounts').findOne({ user_id: user.id })).balance, 0, 'CliQ remains pending review');
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('Wallet: mobile/desktop, both themes, quote/redirect, no unverified credit and CliQ proof passed.');
} finally { await browser.close(); await new Promise(resolve => io.close(() => httpServer.close(resolve))); }
