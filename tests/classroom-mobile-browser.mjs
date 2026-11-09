import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { zipSync, strToU8 } from 'fflate';
import { startPlatformServer } from '../server/index.js';
import { memoryMongo } from './helpers/memory-mongo.mjs';

const now = Date.now(), start = now + 60000;
const users = [{ id: 'teacher-mobile', name: 'أستاذ التجربة', email: 'teacher@test.local', role: 'teachers', status: 'active', subject: 'رياضيات' }, { id: 'student-mobile', name: 'طالب التجربة', email: 'student@test.local', role: 'students', status: 'active' }];
const db = memoryMongo({ users, sessions: users.map(user => ({ user_id: user.id, token: crypto.createHash('sha256').update(user.id).digest('hex'), expires: now + 3600000 })), catalog: [{ id: 'math', kind: 'category', name: 'رياضيات', levels: [], subjects: ['رياضيات'] }], slots: [{ id: 'mobile-slot', teacher_id: users[0].id, start, available_until: start + 3600000, minutes: 60, price: 1000, subject: 'رياضيات', status: 'open' }], bookings: [{ id: 'mobile-booking', slot_id: 'mobile-slot', student_id: users[1].id, start, minutes: 60, price: 1000, subject: 'رياضيات', status: 'confirmed', room: `mobile-${now}`, paid: 1 }] });
const stored = new Map();
const attachmentStore = { async write(id, name, source) { const chunks = []; for await (const chunk of source) chunks.push(Buffer.from(chunk)); stored.set(id, Buffer.concat(chunks)); }, read: id => Readable.from([stored.get(id)]), async remove(id) { stored.delete(id); } };
const { httpServer, io } = await startPlatformServer({ database: db, attachmentStore, port: 0 });
const base = `http://127.0.0.1:${httpServer.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const context = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 390, height: 844 }, isMobile: true });
await context.addCookies(users.map(user => ({ name: `mansah_session_${user.role}`, value: user.id, url: base })));
const teacher = await context.newPage(), student = await context.newPage();
const errors = [];
for (const page of [teacher, student]) page.on('pageerror', error => errors.push(error.message));
try {
  await teacher.goto(`${base}/teachers?view=rooms`);
  await student.goto(`${base}/students?view=rooms`);
  await teacher.locator('.room-card').getByRole('button', { name: 'دخول الغرفة', exact: true }).click();
  await student.locator('.room-card').getByRole('button', { name: /دخول الغرفة|انضم الآن/, exact: true }).click();
  for (const page of [teacher, student]) await page.waitForFunction(() => [...document.querySelectorAll('.participant-tile video')].filter(video => video.srcObject).length === 2, undefined, { timeout: 30000 });
  await teacher.getByTitle('تشغيل الكاميرا', { exact: true }).click();
  await student.getByTitle('تشغيل الكاميرا', { exact: true }).click();
  const nodes = await teacher.locator('.participant-tile video').count();
  assert.equal(nodes, 2);
  const image = await teacher.locator('.call-stage').screenshot();
  await teacher.locator('[data-whiteboard-file-input]').setInputFiles({ name: 'lesson.png', mimeType: 'image/png', buffer: image });
  for (const page of [teacher, student]) {
    await page.waitForFunction(() => document.querySelector('.document-page img')?.naturalWidth > 0, undefined, { timeout: 30000 });
    const url = await page.locator('.document-page img').getAttribute('src');
    assert.ok(url.includes('/bookings/mobile-booking/files/'), 'page images must use authenticated streamed files rather than large peer payloads');
    await page.locator('.participant-tile').first().click();
    await page.locator('.shared-document-tile').click();
    await page.waitForFunction(() => document.querySelector('.document-page img')?.naturalWidth > 0);
    assert.ok((await page.locator('.stable-media-grid').boundingBox()).height >= 100);
    await page.screenshot({ path: `.private/mobile-call-${page === teacher ? 'teacher' : 'student'}.png` });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await teacher.getByTitle('إنهاء مشاركة الملف', { exact: true }).click();
  await student.locator('.document-page').waitFor({ state: 'detached' });
  const docx = zipSync({ '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'), 'word/document.xml': strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Word lesson preview</w:t></w:r></w:p></w:body></w:document>') });
  await teacher.locator('[data-whiteboard-file-input]').setInputFiles({ name: 'lesson.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from(docx) });
  await student.waitForFunction(() => document.querySelector('.document-page img')?.naturalWidth > 0, undefined, { timeout: 30000 });
  await teacher.getByTitle('إيقاف المايك', { exact: true }).click();
  assert.equal(await teacher.locator('.participant-tile').last().evaluate(element => element.classList.contains('speaking')), false);
  await teacher.getByTitle('إنهاء مشاركة الملف', { exact: true }).click();
  await teacher.locator('[data-whiteboard-file-input]').setInputFiles({ name: 'lesson.custom', mimeType: 'application/octet-stream', buffer: Buffer.from('arbitrary lesson file') });
  await student.waitForFunction(() => document.querySelector('.document-page img')?.naturalWidth > 0, undefined, { timeout: 30000 });
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('Authenticated mobile classroom: streaming image/Word/arbitrary files, camera focus and persistent video passed.');
} catch (error) {
  await teacher.screenshot({ path: '.private/mobile-call-failure.png' }); throw error;
} finally {
  await browser.close(); await new Promise(resolve => io.close(() => httpServer.close(resolve)));
}
