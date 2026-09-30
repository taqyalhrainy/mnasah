import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
const base = Date.now();
let status = 'confirmed';
const user = { id: 'reminder-test', name: 'طالب', role: 'students', status: 'active', email: 'test@example.com', subject: '', bio: '' };
const booking = () => ({ id: 'test-lesson', subject: 'الرياضيات', start: base + 16 * 60000, status, teacher_name: 'الأستاذ', student_name: 'طالب', price: 1500, minutes: 60, paid: 0, notes: '', resource: '' });
try {
  await page.clock.install({ time: new Date(base) });
  await page.addInitScript(() => {
    window.sentReminders = [];
    window.permissionCalls = 0;
    Object.defineProperty(window, 'Notification', { configurable: true, value: class {
      static permission = 'granted';
      static async requestPermission() { window.permissionCalls++; return 'granted'; }
    } });
    navigator.serviceWorker.getRegistration = async () => ({ showNotification: async (title, options) => window.sentReminders.push({ title, ...options }) });
  });
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/me') || path.endsWith('/profile')) return route.fulfill({ json: { user } });
    if (path.endsWith('/catalog')) return route.fulfill({ json: { categories: [] } });
    if (path.endsWith('/slots')) return route.fulfill({ json: { slots: [] } });
    return route.fulfill({ json: { bookings: [booking()] } });
  });
  await page.goto('http://127.0.0.1:8787/students');
  await page.getByRole('button', { name: 'تفعيل تنبيهات الحصص' }).waitFor();
  assert.equal(await page.locator('.lesson-reminder').count(), 0);
  assert.equal(await page.evaluate(() => window.permissionCalls), 0);
  await page.getByRole('button', { name: 'تفعيل تنبيهات الحصص' }).click();
  await page.clock.fastForward(60000);
  await page.getByText('تبدأ خلال 15 دقيقة', { exact: true }).waitFor();
  await page.waitForFunction(() => window.sentReminders.length === 1);
  assert.equal(await page.locator('.lesson-reminder').count(), 1);
  await page.getByRole('button', { name: 'فتح الغرف' }).waitFor();
  await page.screenshot({ path: '.private/reminder-mobile.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.getByRole('button', { name: 'حسابي', exact: true }).click();
  await page.getByText('تبدأ خلال 15 دقيقة', { exact: true }).waitFor();
  await page.clock.fastForward(60000);
  assert.equal(await page.evaluate(() => window.sentReminders.length), 1);
  await page.reload();
  await page.getByText('تبدأ خلال 14 دقيقة', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.sentReminders.length), 0);
  await page.clock.fastForward(14 * 60000);
  await page.getByText('حان موعد الحصة', { exact: true }).waitFor();
  await page.waitForFunction(() => window.sentReminders.length === 1);
  assert.equal((await page.evaluate(() => window.sentReminders[0])).title, 'حان موعد حصتك');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.lesson-reminder').evaluate(el => getComputedStyle(el).animationName), 'none');
  status = 'cancelled';
  await page.clock.fastForward(30000);
  await page.waitForFunction(() => !document.querySelector('.lesson-reminder'));
  console.log('Reminder checks passed: 15-minute threshold, start alert, no repeat on reload, all views, cancelled lessons, reduced motion, mobile layout.');
} finally { await browser.close(); }
