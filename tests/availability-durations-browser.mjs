import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { startPlatformServer } from '../server/index.js';
import { memoryMongo } from './helpers/memory-mongo.mjs';

const now = Date.now(), start = now + 10 * 60000;
const users = [
  { id: 'duration-teacher', role: 'teachers', name: 'أستاذ الرياضيات', status: 'active', subject: 'رياضيات' },
  { id: 'duration-student', role: 'students', name: 'طالب', status: 'active' },
];
const token = 'duration-browser-session';
const slot = { id: 'short-window', teacher_id: users[0].id, status: 'open', start, available_until: start + 45 * 60000, minutes: 30, price: 500, subject: 'رياضيات', subjects: ['رياضيات'], offerings: [{ minutes: 30, price: 500 }, { minutes: 60, price: 1000 }, { minutes: 90, price: 1500 }], created: now };
const db = memoryMongo({ users, sessions: users.map(user => ({ user_id: user.id, token: crypto.createHash('sha256').update(token + user.id).digest('hex'), expires: now + 3600000 })), catalog: [{ id: 'math', kind: 'category', name: 'رياضيات', subjects: ['رياضيات'], levels: [] }], slots: [slot] });
const { httpServer, io } = await startPlatformServer({ database: db, port: Number(process.env.AVAILABILITY_TEST_PORT || 0), portalMode: 'public' });
const base = `http://127.0.0.1:${httpServer.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await context.addCookies([{ name: 'mansah_session_students', value: token + users[1].id, url: base }]);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/students', { waitUntil: 'domcontentloaded' });
  const card = page.locator('.tutor-card').first();
  await card.waitFor();
  assert.match(await card.locator('.tutor-info > small').innerText(), /30/);
  assert.doesNotMatch(await card.locator('.tutor-info > small').innerText(), /60|90/);
  await card.getByRole('button', { name: 'احجز الآن', exact: true }).click();
  const dialog = page.locator('.booking-choice-dialog');
  await dialog.waitFor();
  assert.equal(await dialog.locator('.durations label').count(), 1);
  assert.match(await dialog.locator('.durations').innerText(), /30/);
  assert.doesNotMatch(await dialog.locator('.durations').innerText(), /60|90/);
  assert.equal(await dialog.locator('.durations input').isChecked(), true);
  assert.equal(await dialog.locator('.booking-time-choice option').count(), 4);
  assert.equal(await dialog.getByRole('button', { name: 'تأكيد الحجز', exact: true }).isEnabled(), true);
  assert.deepEqual(errors, []);
  console.log('Mobile student sees only the fitting duration, automatically selected, with its price and available booking times.');
  await context.close();
  const teacherContext = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await teacherContext.addCookies([{ name: 'mansah_session_teachers', value: token + users[0].id, url: base }]);
  const teacher = await teacherContext.newPage();
  teacher.on('pageerror', error => errors.push(error.message));
  await teacher.goto(base + '/teachers?view=available', { waitUntil: 'domcontentloaded' });
  await teacher.getByRole('tab', { name: 'جدولي والمحجوز', exact: true }).click();
  const event = teacher.locator('.availability-event').first();
  await event.waitFor();
  assert.equal(await event.locator('.availability-event-prices > span').count(), 3);
  await mkdir('DO_NOT_UPLOAD/availability-qa', { recursive: true });
  for (const theme of ['light', 'dark']) {
    await teacher.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await event.screenshot({ path: `DO_NOT_UPLOAD/availability-qa/calendar-${theme}.png` });
    assert.ok(await teacher.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  }
  await event.getByRole('button', { name: 'تعديل الموعد', exact: true }).click();
  await teacher.locator('.availability-edit-banner').waitFor();
  await teacher.getByLabel('سعر 60 دقيقة', { exact: true }).fill('15');
  const updated = teacher.waitForResponse(response => response.url().endsWith('/slots/short-window/edit') && response.request().method() === 'POST');
  await teacher.getByRole('button', { name: 'حفظ التعديلات', exact: true }).click();
  assert.equal((await updated).status(), 200);
  await teacher.locator('.availability-edit-banner').waitFor({ state: 'hidden' });
  assert.equal((await db.collection('slots').findOne({ id: slot.id })).offerings.find(option => option.minutes === 60).price, 1500);
  assert.equal(await db.collection('slots').countDocuments({ teacher_id: users[0].id }), 1);
  await event.getByRole('button', { name: 'تعديل الموعد', exact: true }).click();
  await teacher.getByLabel('سعر 60 دقيقة', { exact: true }).fill('25');
  await teacher.getByRole('button', { name: 'إلغاء التعديل', exact: true }).click();
  assert.equal((await db.collection('slots').findOne({ id: slot.id })).offerings.find(option => option.minutes === 60).price, 1500);
  assert.deepEqual(errors, []);
  console.log('Teacher mobile light/dark calendar, editing in place, retaining slot identity and cancelling unsaved edits passed.');
} finally {
  await browser.close();
  await new Promise(resolve => io.close(() => httpServer.close(resolve)));
}
