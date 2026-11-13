import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { startPlatformServer } from '../server/index.js';
import { memoryMongo } from './helpers/memory-mongo.mjs';

const now = Date.now();
const users = [
  { id: 'free-teacher', role: 'teachers', name: 'الأستاذ المشارك', status: 'active', subject: 'رياضيات' },
  { id: 'paid-teacher', role: 'teachers', name: 'الأستاذ الآخر', status: 'active', subject: 'رياضيات' },
  { id: 'new-student', role: 'students', name: 'طالب جديد', status: 'active' },
];
const token = id => `trial-browser-${id}`;
const db = memoryMongo({ users, sessions: users.map(user => ({ user_id: user.id, token: crypto.createHash('sha256').update(token(user.id)).digest('hex'), expires: now + 3600000 })), catalog: [{ id: 'math', kind: 'category', parentId: 'curriculum-other', name: 'رياضيات', subjects: ['رياضيات'], levels: [] }], slots: ['paid-teacher', 'free-teacher'].map((id, index) => ({ id: `slot-${id}`, teacher_id: id, status: 'open', start: now + 5 * 60000, available_until: now + 125 * 60000, minutes: 60, price: 2000, subject: 'رياضيات', subjects: ['رياضيات'], offerings: [{ minutes: 60, price: 2000 }], created: now + index })) });
const { httpServer, io } = await startPlatformServer({ database: db, port: Number(process.env.TRIAL_TEST_PORT || 55192), portalMode: 'public' });
const base = `http://127.0.0.1:${httpServer.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
await mkdir('DO_NOT_UPLOAD/free-trial-qa', { recursive: true });
try {
  const teacher = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await teacher.addCookies([{ name: 'mansah_session_teachers', value: token('free-teacher'), url: base }]);
  const teacherPage = await teacher.newPage();
  await teacherPage.goto(`${base}/teachers?view=profile`);
  const toggle = teacherPage.getByRole('switch', { name: /تقديم حصة مجانية/ });
  await toggle.waitFor(); assert.equal(await toggle.getAttribute('aria-checked'), 'false');
  await toggle.click(); await teacherPage.waitForFunction(() => document.querySelector('[role=switch]')?.getAttribute('aria-checked') === 'true');
  await teacherPage.reload(); await toggle.waitFor(); assert.equal(await toggle.getAttribute('aria-checked'), 'true');
  await teacherPage.screenshot({ path: 'DO_NOT_UPLOAD/free-trial-qa/teacher-mobile.png', fullPage: true });

  const student = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await student.addCookies([{ name: 'mansah_session_students', value: token('new-student'), url: base }]);
  const page = await student.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let walletRequests = 0; page.on('request', request => { if (new URL(request.url()).pathname === '/api/students/wallet') walletRequests++; });
  await page.goto(base + '/students'); await page.locator('.trial-banner').waitFor();
  await page.locator('.tutor-card').first().waitFor();
  assert.match(await page.locator('.tutor-card').first().innerText(), /الأستاذ المشارك/);
  assert.equal(await page.locator('.tutor-card .trial-free').count(), 1);
  assert.equal(await page.locator('.tutor-card .trial-paid').count(), 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: 'DO_NOT_UPLOAD/free-trial-qa/student-mobile.png', fullPage: true });
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await page.screenshot({ path: 'DO_NOT_UPLOAD/free-trial-qa/student-dark.png', fullPage: true });
  await page.locator('.tutor-card').first().getByRole('button', { name: 'احجز الآن' }).click();
  const dialog = page.locator('.booking-choice-dialog'); await dialog.waitFor();
  assert.equal(await dialog.locator('.booking-free-trial input').isChecked(), true);
  assert.equal(await dialog.locator('.booking-choice-grid.durations label').count(), 1);
  assert.match(await dialog.locator('.booking-choice-grid.durations').innerText(), /30/);
  assert.match(await dialog.locator('footer').innerText(), /مجانية/);
  await dialog.locator('.booking-free-trial input').uncheck();
  assert.match(await dialog.locator('.booking-choice-grid.durations').innerText(), /60/);
  await dialog.locator('.booking-free-trial input').check();
  page.once('dialog', modal => modal.accept());
  await dialog.getByRole('button', { name: 'تأكيد الحجز' }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(walletRequests, 0, 'the free booking must not require wallet balance');
  await page.getByRole('button', { name: 'الرئيسية', exact: true }).first().click();
  await page.locator('.tutor-card').first().waitFor();
  assert.equal(await page.locator('.trial-status').count(), 0, 'all trial badges must disappear after claiming');
  assert.match(await page.locator('.tutor-card').first().innerText(), /الأستاذ الآخر/);
  await page.reload(); await page.locator('.tutor-card').first().waitFor();
  assert.equal(await page.locator('.trial-status').count(), 0);
  assert.deepEqual(errors, []);
  console.log('Teacher opt-in persistence, mobile light/dark badges, priority order, free booking and consumed-credit hiding passed.');
  await teacher.close(); await student.close();
} finally { await browser.close(); await new Promise(resolve => io.close(() => httpServer.close(resolve))); }
