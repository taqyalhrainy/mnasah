import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { startPlatformServer } from '../server/index.js';
import { memoryMongo } from './helpers/memory-mongo.mjs';

const { httpServer, io } = await startPlatformServer({ database: memoryMongo(), port: 0 });
const base = `http://127.0.0.1:${httpServer.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  for (const host of ['fonts.googleapis.com', 'fonts.gstatic.com', 'accounts.google.com']) await context.route(`https://${host}/**`, route => route.abort());
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  for (const portal of ['students', 'teachers']) {
    await page.goto(`${base}/${portal}`, { waitUntil: 'domcontentloaded' });
    await page.locator('.auth-account-choice button').nth(1).waitFor();
    assert.equal(await page.locator('.auth-account-choice button').nth(1).isVisible(), true);
    await page.locator('.auth-account-choice button').nth(1).tap();
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
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('Student/teacher signup: visible year picker, leap-day clamp, Sweden +46 normalization, mobile layout passed.');
} finally { await browser.close(); await new Promise(resolve => io.close(() => httpServer.close(resolve))); }
