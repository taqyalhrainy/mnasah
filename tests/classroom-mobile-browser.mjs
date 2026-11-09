import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { zipSync, strToU8 } from 'fflate';
import { startPlatformServer } from '../server/index.js';
import { memoryMongo } from './helpers/memory-mongo.mjs';

const now = Date.now(), start = now + 5 * 60000;
const users = [{ id: 'teacher-mobile', name: 'أستاذ التجربة', email: 'teacher@test.local', role: 'teachers', status: 'active', subject: 'رياضيات' }, { id: 'student-mobile', name: 'طالب التجربة', email: 'student@test.local', role: 'students', status: 'active' }];
const db = memoryMongo({ users, sessions: users.map(user => ({ user_id: user.id, token: crypto.createHash('sha256').update(user.id).digest('hex'), expires: now + 3600000 })), catalog: [{ id: 'math', kind: 'category', name: 'رياضيات', levels: [], subjects: ['رياضيات'] }], slots: [{ id: 'mobile-slot', teacher_id: users[0].id, start, available_until: start + 3600000, minutes: 60, price: 1000, subject: 'رياضيات', status: 'open' }], bookings: [{ id: 'mobile-booking', slot_id: 'mobile-slot', student_id: users[1].id, start, minutes: 60, price: 1000, subject: 'رياضيات', status: 'confirmed', room: `mobile-${now}`, paid: 1 }] });
const stored = new Map();
let originalSaved = false;
const attachmentStore = { async write(id, name, source) { if (name === 'many-pages.pdf') await new Promise(resolve => setTimeout(resolve, 8000)); const chunks = []; for await (const chunk of source) chunks.push(Buffer.from(chunk)); stored.set(id, Buffer.concat(chunks)); if (name === 'many-pages.pdf') originalSaved = true; }, read: id => Readable.from([stored.get(id)]), async remove(id) { stored.delete(id); } };
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
  for (const page of [teacher, student]) {
    await page.waitForFunction(() => [...document.querySelectorAll('.participant-tile .camera-placeholder')].length === 0);
    const cards = await page.locator('.participant-tile').evaluateAll(elements => elements.map(element => { const rect = element.getBoundingClientRect(); return { width: rect.width, height: rect.height }; }));
    assert.ok(cards.every(card => Math.abs(card.width - card.height) < 3), `mobile gallery must be square: ${JSON.stringify(cards)}`);
  }
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
  assert.equal(await teacher.locator('.file-share-button').count(), 1);
  assert.equal(await teacher.locator('.file-share-button').getAttribute('title'), 'إنهاء مشاركة الملف', 'the upload button itself becomes the stop button');
  await student.reload({ waitUntil: 'domcontentloaded' });
  await student.locator('.room-card').getByRole('button', { name: /دخول الغرفة|انضم الآن/, exact: true }).click();
  for (const page of [teacher, student]) {
    await page.waitForFunction(() => [...document.querySelectorAll('.participant-tile .camera-placeholder')].length === 0, undefined, { timeout: 30000 });
    await page.waitForFunction(() => document.querySelector('.document-page img')?.naturalWidth > 0, undefined, { timeout: 30000 });
  }
  await teacher.getByTitle('إنهاء مشاركة الملف', { exact: true }).click();
  await student.locator('.document-page').waitFor({ state: 'detached' });
  const docx = zipSync({ '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'), 'word/document.xml': strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Word lesson preview</w:t></w:r></w:p></w:body></w:document>') });
  await teacher.locator('[data-whiteboard-file-input]').setInputFiles({ name: 'lesson.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from(docx) });
  await student.waitForFunction(() => document.querySelector('.document-page img')?.naturalWidth > 0, undefined, { timeout: 30000 });
  await teacher.getByTitle('إيقاف المايك', { exact: true }).click();
  assert.equal(await teacher.locator('.participant-tile').last().evaluate(element => element.classList.contains('speaking')), false);
  await teacher.getByTitle('إنهاء مشاركة الملف', { exact: true }).click();
  const count = 624;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Count ${count} /Kids [${Array.from({ length: count }, (_, i) => `${i + 3} 0 R`).join(' ')}] >>`, ...Array.from({ length: count }, () => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${count + 4} 0 R >> >> /Contents ${count + 3} 0 R >>`)];
  const content = 'BT /F1 24 Tf 50 720 Td (First page without waiting for original upload) Tj ET';
  objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let pdf = '%PDF-1.4\n', offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  await teacher.locator('[data-whiteboard-file-input]').setInputFiles({ name: 'many-pages.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdf) });
  await student.waitForFunction(() => document.querySelector('.document-page img')?.naturalWidth > 0, undefined, { timeout: 30000 });
  assert.equal(originalSaved, false, 'the first page must arrive while the original is still uploading');
  const counter = teacher.getByTitle('صفحات الملف', { exact: true });
  assert.match(await counter.textContent(), /1\s*\/\s*624/);
  assert.ok((await counter.boundingBox()).height <= 36, 'large page counts must stay on one line');
  assert.ok((await teacher.locator('.document-viewer > header').boundingBox()).height < 95, 'document tools must fit in two neat rows');
  await teacher.getByTitle('تنزيل الملف', { exact: true }).waitFor({ timeout: 20000 });
  await teacher.screenshot({ path: '.private/mobile-call-many-pages.png' });
  await teacher.getByTitle('إنهاء مشاركة الملف', { exact: true }).click();
  await teacher.locator('[data-whiteboard-file-input]').setInputFiles({ name: 'lesson.custom', mimeType: 'application/octet-stream', buffer: Buffer.from('arbitrary lesson file') });
  await student.waitForFunction(() => document.querySelector('.document-page img')?.naturalWidth > 0, undefined, { timeout: 30000 });
  await teacher.getByTitle('إنهاء مشاركة الملف', { exact: true }).click();
  for (const page of [teacher, student]) await page.evaluate(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const context = canvas.getContext('2d'); context.fillStyle = '#6745ac'; context.fillRect(0, 0, 640, 360); context.fillStyle = '#fff'; context.font = '32px Arial'; context.fillText('Shared screen', 80, 170);
      window.setInterval(() => { context.fillStyle = '#6745ac'; context.fillRect(0, 0, 640, 360); context.fillStyle = '#fff'; context.fillText('Shared screen', 80, 170); }, 100);
      window.testSharedCanvas = canvas; return canvas.captureStream(10);
    };
  });
  await teacher.getByTitle('مشاركة الشاشة', { exact: true }).click();
  await student.getByTitle('مشاركة الشاشة', { exact: true }).click();
  for (const page of [teacher, student]) {
    await page.waitForFunction(() => [...document.querySelectorAll('.share-tile video')].filter(video => video.srcObject && video.videoWidth).length === 2, undefined, { timeout: 20000 });
    const tiles = await page.locator('.participant-tile').evaluateAll(elements => elements.map(element => { const rect = element.getBoundingClientRect(); return { width: rect.width, height: rect.height }; }));
    assert.equal(tiles.length, 4, 'two cameras and two screen shares are four separate tiles');
    assert.ok(tiles.every(tile => Math.abs(tile.width - tile.height) < 3), 'screen shares and cameras must remain square in gallery mode');
    await page.locator('.share-tile').first().click();
    await page.locator('.share-tile.is-focused').click();
    assert.equal(await page.locator('.stable-media-grid.has-focus').count(), 0, 'clicking the focused screen returns to the gallery');
    await page.screenshot({ path: `.private/mobile-four-tiles-${page === teacher ? 'teacher' : 'student'}.png` });
  }
  await teacher.getByTitle('إيقاف مشاركة الشاشة', { exact: true }).click();
  await student.waitForFunction(() => document.querySelectorAll('.share-tile').length === 1);
  await student.getByTitle('إيقاف مشاركة الشاشة', { exact: true }).click();
  await teacher.waitForFunction(() => document.querySelectorAll('.share-tile').length === 0);
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('Mobile classroom: live-camera rejoin, restored shared document, fast 624-page preview and four square media tiles passed.');
} catch (error) {
  await teacher.screenshot({ path: '.private/mobile-call-failure.png' }); throw error;
} finally {
  await browser.close(); await new Promise(resolve => io.close(() => httpServer.close(resolve)));
}
