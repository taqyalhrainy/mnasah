import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { startPlatformServer } from '../server/index.js';
import { memoryMongo } from './helpers/memory-mongo.mjs';

const now = Date.now();
const users = [
  { id: 'experience-teacher', name: 'Teacher', email: 'teacher@test.invalid', role: 'teachers', status: 'active', subject: 'المنهاج الأردني الأساسي › اللغة العربية › الصف الأول | المنهاج الأردني الإعدادي › اللغة العربية › الصف السابع' },
  { id: 'experience-student', name: 'Student', email: 'student@test.invalid', role: 'students', status: 'active' },
];
const db = memoryMongo({ users, sessions: users.map(user => ({ token: crypto.createHash('sha256').update(user.id).digest('hex'), user_id: user.id, expires: now + 3600000 })),
  catalog: [
    { id: 'basic', kind: 'category', name: 'المنهاج الأردني الأساسي', levels: ['الصف الأول'], subjects: ['اللغة العربية'] },
    { id: 'middle', kind: 'category', name: 'المنهاج الأردني الإعدادي', levels: ['الصف السابع'], subjects: ['اللغة العربية'] },
  ],
  slots: [{ id: 'old-slot', teacher_id: users[0].id, start: now - 60000, minutes: 60, available_until: now + 59 * 60000, price: 1000, subject: 'اللغة العربية', status: 'open' }],
  bookings: [{ id: 'old-booking', slot_id: 'old-slot', student_id: users[1].id, status: 'completed', start: now - 86400000, minutes: 60 }],
});
const stored = new Map();
const { httpServer, io } = await startPlatformServer({ database: db, port: 0, attachmentStore: {
  async write(id, _name, source) { const chunks = []; for await (const chunk of source) chunks.push(Buffer.from(chunk)); stored.set(id, Buffer.concat(chunks)); },
  read: (id, range) => { const bytes = stored.get(id); return Readable.from([range ? bytes.subarray(range.start, range.end + 1) : bytes]); }, async remove(id) { stored.delete(id); },
} });
const base = `http://127.0.0.1:${httpServer.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, permissions: ['microphone'], timezoneId: 'Asia/Amman', serviceWorkers: 'block' });
  await context.addCookies([{ name: 'mansah_session_teachers', value: users[0].id, url: base }]);
  await context.addInitScript(() => {
    let permission = 'denied';
    const changes = new EventTarget();
    window.notificationRequests = 0;
    window.setNotificationPermission = value => { permission = value; changes.dispatchEvent(new Event('change')); };
    Object.defineProperty(Notification, 'permission', { get: () => permission });
    Notification.requestPermission = async () => { window.notificationRequests++; return permission; };
    navigator.permissions.query = async () => changes;
    const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/test', options: {}, toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/test', keys: { auth: 'test', p256dh: 'test' } }) };
    const registration = { pushManager: { getSubscription: async () => subscription } };
    Object.defineProperty(navigator.serviceWorker, 'ready', { get: () => Promise.resolve(registration) });
  });
  for (const host of ['fonts.googleapis.com', 'fonts.gstatic.com', 'accounts.google.com']) await context.route(`https://${host}/**`, route => route.abort());
  await context.route('**/api/*/push/**', route => route.fulfill({ json: { enabled: true } }));
  await context.route('**/api/public/config', route => route.fulfill({ json: { vapidPublicKey: Buffer.alloc(65, 1).toString('base64url') } }));
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(12000);
  await page.goto(base + '/students');
  await page.locator('.portal-teachers').waitFor();
  assert.match(page.url(), /\/teachers$/, 'an installed default student link restores the saved teacher session');
  const renewed = (await context.cookies()).find(cookie => cookie.name === 'mansah_session_teachers');
  assert.ok(renewed.expires * 1000 > Date.now() + 364 * 86400000);
  await page.locator('.device-notification-prompt button.primary-button').click();
  await page.locator('.notification-help').waitFor();
  assert.equal(await page.evaluate(() => window.notificationRequests), 0);
  await page.locator('.notification-help .primary-button').click();
  assert.equal(await page.evaluate(() => window.notificationRequests), 0);
  await page.evaluate(() => {
    window.setNotificationPermission('default');
    Notification.requestPermission = async () => { window.notificationRequests++; window.setNotificationPermission('granted'); return 'granted'; };
  });
  await page.locator('.notification-help .primary-button').click();
  await page.locator('.notification-help').waitFor({ state: 'detached' });
  await page.locator('.device-notification-prompt').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.notificationRequests), 1, 'resetting a blocked permission permits a fresh OS request');
  await page.locator('.teacher-saved-subjects article').waitFor();
  assert.equal(await page.locator('.teacher-saved-subjects article').count(), 1);
  assert.match(await page.locator('.teacher-saved-subjects article').innerText(), /الأساسي.*الإعدادي/s);
  await page.locator('.nav-list').getByRole('button', { name: 'المتاحة', exact: true }).click();
  await page.locator('.availability-simple-publisher').waitFor();
  assert.equal(await page.locator('.unavailable-slot-list').count(), 0, 'expired slots must not precede the publishing form');
  await page.getByRole('button', { name: 'إلى', exact: true }).click();
  const wheel = page.getByRole('spinbutton', { name: 'الساعة', exact: true });
  // Scroll using actual wheel offsets; verify both noon and midnight boundaries.
  await page.locator('.clock-period button').filter({ hasText: 'مساءً' }).click();
  let hour = Number(await wheel.getAttribute('aria-valuenow'));
  const toEleven = (11 - hour + 12) % 12;
  if (toEleven) { await wheel.evaluate((el, steps) => { el.style.scrollBehavior = 'auto'; el.scrollTop += steps * 44; }, toEleven); await page.waitForTimeout(200); }
  await page.locator('.clock-period button').filter({ hasText: 'مساءً' }).click();
  await wheel.evaluate(el => { el.scrollTop += 44; });
  await page.waitForFunction(() => document.querySelector('.clock-period .selected')?.textContent === 'صباحًا');
  await page.getByRole('button', { name: 'تأكيد الوقت', exact: true }).click();
  assert.match(await page.getByRole('button', { name: 'إلى', exact: true }).getAttribute('data-value'), /^00:/);
  await page.getByRole('button', { name: 'إلى', exact: true }).click();
  await wheel.evaluate(el => { el.scrollTop -= 44; });
  await page.waitForFunction(() => document.querySelector('.clock-period .selected')?.textContent === 'مساءً');
  await page.getByRole('button', { name: 'تأكيد الوقت', exact: true }).click();
  await page.locator('.nav-list').getByRole('button', { name: 'الرسائل', exact: true }).click();
  await page.locator('.dm-thread').first().click();
  const beforeMessages = await page.locator('.dm-message').count();
  await page.getByRole('button', { name: 'تسجيل رسالة صوتية', exact: true }).click();
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'إنهاء التسجيل', exact: true }).click();
  await page.locator('.dm-composer .dm-upload-list audio').waitFor();
  assert.equal(await page.locator('.dm-message').count(), beforeMessages, 'stopping recording does not send a message');
  await page.getByText('لم يُرسل بعد · اضغط إرسال', { exact: true }).waitFor();
  const support = await page.locator('.support-whatsapp').boundingBox(), nav = await page.locator('.sidebar').boundingBox(), composer = await page.locator('.dm-composer').boundingBox();
  assert.ok(Math.abs(nav.y - (support.y + support.height)) < 14, `support sits beside navigation: ${JSON.stringify({support,nav})}`);
  assert.ok(support.y >= composer.y + composer.height || support.y + support.height <= composer.y, `support must not cover composer: ${JSON.stringify({support,composer})}`);
  await page.screenshot({ path: '.private/experience-voice-draft.png' });
  await page.getByRole('button', { name: 'إرسال الرسالة', exact: true }).click();
  await page.locator('.dm-message audio').waitFor();
  await page.waitForFunction(() => document.querySelector('.dm-message audio')?.preload === 'auto');
  assert.equal(await page.locator('.dm-composer .dm-upload-list').count(), 0);
  const next = await context.newPage(); await page.close();
  await next.goto(base + '/teachers'); await next.locator('.portal-teachers').waitFor();
  await next.locator('details.account-menu summary:visible').click();
  await next.locator('.account-logout:visible').click();
  await next.locator('.auth-account-choice').waitFor();
  await next.reload(); await next.locator('.auth-account-choice').waitFor();
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('Notification recovery, persistent sessions/logout, merged subjects, clean publishing, midnight rollover and unsent voice composer passed.');
} finally { await browser.close(); await new Promise(resolve => io.close(() => httpServer.close(resolve))); }
