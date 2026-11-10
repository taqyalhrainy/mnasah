import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startPlatformServer } from '../server/index.js';
import { memoryMongo } from './helpers/memory-mongo.mjs';

const db = memoryMongo({ users: [{ id: 'saved-teacher', name: 'Teacher', role: 'teachers', status: 'active', email: 'teacher@example.com' }], sessions: [{ user_id: 'saved-teacher', token: crypto.createHash('sha256').update('saved-session').digest('hex'), expires: Date.now() + 3600000 }] });
const { httpServer, io } = await startPlatformServer({ database: db, port: 0 });
const base = `http://127.0.0.1:${httpServer.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  for (const host of ['fonts.googleapis.com', 'fonts.gstatic.com', 'accounts.google.com']) await context.route(`https://${host}/**`, route => route.abort());
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  for (const portal of ['students', 'teachers']) {
    await page.goto(`${base}/${portal}`, { waitUntil: 'domcontentloaded' });
    await page.locator('.auth-account-choice button').nth(1).waitFor();
    assert.equal(await page.locator('input[type=email]').count(), 0, 'no login form before choosing intent');
    assert.equal(await page.locator('.auth-role-choice').count(), 0, 'no role picker before choosing intent');
    await page.screenshot({ path: '.private/auth-two-options.png', fullPage: true });
    assert.equal(await page.locator('.auth-account-choice button').nth(1).isVisible(), true);
    await page.locator('.auth-account-choice button').nth(1).tap();
    assert.equal(await page.locator('input[type=email]').count(), 0);
    await page.locator('.auth-role-choice button').nth(portal === 'students' ? 0 : 1).tap();
    await page.getByLabel('سنة الميلاد', { exact: true }).selectOption('2000');
    await page.getByLabel('شهر الميلاد', { exact: true }).selectOption('02');
    await page.getByLabel('يوم الميلاد', { exact: true }).selectOption('29');
    assert.equal(await page.getByLabel('سنة الميلاد', { exact: true }).inputValue(), '2000');
    await page.getByLabel('سنة الميلاد', { exact: true }).selectOption('2001');
    assert.equal(await page.getByLabel('يوم الميلاد', { exact: true }).inputValue(), '28');
    await page.getByLabel('الدولة ورمز الاتصال', { exact: true }).selectOption('SE');
    await page.getByRole('textbox', { name: 'رقم الهاتف', exact: true }).fill('0701234567');
    assert.equal(await page.locator('input[name=phone]').inputValue(), '+46701234567');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `.private/${portal}-international-registration.png`, fullPage: true });
  }
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('.auth-account-choice button').first().tap();
  await page.locator('.auth-role-choice button').nth(1).tap();
  assert.equal(await page.locator('input[type=email]').isVisible(), true);
  assert.equal(await page.locator('.auth-role-tabs').count(), 0);
  await context.addCookies([{ name: 'mansah_session_teachers', value: 'saved-session', url: base, expires: Math.floor(Date.now() / 1000) + 3600 }]);
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('.learning-shell').waitFor();
  assert.ok(page.url().includes('/teachers'), 'root restores teacher session even without a local role hint');
  assert.equal(await page.locator('.auth-account-choice').count(), 0);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.learning-shell').waitFor();
  await page.locator('.account-menu summary:visible').first().click();
  await page.getByRole('button', { name: 'تثبيت على iPhone', exact: true }).click();
  await page.locator('dialog.ios-guide-v2').waitFor();
  await page.waitForFunction(() => document.querySelector('.ios-guide-v2 video')?.videoWidth === 780);
  assert.equal(await page.locator('.ios-guide-v2 video').evaluate(el => el.controls), true);
  assert.equal(await page.locator('.ios-guide-instructions li').count(), 4);
  await page.screenshot({ path: '.private/ios-guide-mobile-v2.png', fullPage: true });
  await page.getByRole('button', { name: 'إغلاق الشرح', exact: true }).click();
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('Intent -> role -> form flow, international phone, date controls, persistent teacher root session, reload and 780px playable iPhone guide passed.');
} finally { await browser.close(); await new Promise(resolve => io.close(() => httpServer.close(resolve))); }
