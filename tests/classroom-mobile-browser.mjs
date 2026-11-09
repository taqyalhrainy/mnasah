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
const savedPreviews = new Set();
let slowPageSaved = false;
const attachmentStore = { async write(id, name, source) { if (name === 'many-pages.pdf') await new Promise(resolve => setTimeout(resolve, 8000)); if (name === 'page-40.webp') await new Promise(resolve => setTimeout(resolve, 1500)); const chunks = []; for await (const chunk of source) chunks.push(Buffer.from(chunk)); stored.set(id, Buffer.concat(chunks)); savedPreviews.add(name); if (name === 'many-pages.pdf') originalSaved = true; if (name === 'page-40.webp') slowPageSaved = true; }, read: id => Readable.from([stored.get(id)]), async remove(id) { stored.delete(id); } };
const { httpServer, io } = await startPlatformServer({ database: db, attachmentStore, port: 0 });
const base = `http://127.0.0.1:${httpServer.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const context = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 390, height: 844 }, isMobile: true });
await context.addInitScript(() => {
  const Native = window.RTCPeerConnection;
  window.testPeerConnections = [];
  window.testMediaErrors = [];
  const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async constraints => { try { return await getUserMedia(constraints); } catch (error) { window.testMediaErrors.push({ name: error.name, message: error.message, constraints, devices: (await navigator.mediaDevices.enumerateDevices()).map(device => ({kind:device.kind,label:device.label})) }); throw error; } };
  window.RTCPeerConnection = class extends Native { constructor(...args) { super(...args); window.testPeerConnections.push(this); } };
});
for (const host of ['fonts.googleapis.com', 'fonts.gstatic.com', 'accounts.google.com']) await context.route(`https://${host}/**`, route => route.abort());
await context.addCookies(users.map(user => ({ name: `mansah_session_${user.role}`, value: user.id, url: base })));
const teacher = await context.newPage(), student = await context.newPage();
const errors = [];
for (const [label, page] of [['teacher', teacher], ['student', student]]) {
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('net::ERR_FAILED')) console.log(label, message.text().slice(0, 300)); });
  page.on('requestfailed', request => { if (/peerjs/.test(request.url())) console.log(label, 'signaling failed', request.failure()?.errorText); });
}
try {
  await teacher.goto(`${base}/teachers?view=rooms`);
  await student.goto(`${base}/students?view=rooms`);
  await teacher.locator('.room-card').getByRole('button', { name: 'دخول الغرفة', exact: true }).click();
  await student.locator('.room-card').getByRole('button', { name: /دخول الغرفة|انضم الآن/, exact: true }).click();
  for (const page of [teacher, student]) await page.waitForFunction(() => [...document.querySelectorAll('.participant-tile video')].filter(video => video.srcObject).length === 2, undefined, { timeout: 30000 });
  for (const page of [teacher, student]) await page.waitForFunction(async () => {
    for (const peer of window.testPeerConnections) {
      if (peer.connectionState !== 'connected') continue;
      const stats = await peer.getStats();
      if ([...stats.values()].some(row => row.type === 'inbound-rtp' && row.kind === 'audio' && row.packetsReceived > 0)) return true;
    }
    return false;
  }, undefined, { timeout: 10000 });
  await teacher.getByTitle('تشغيل الكاميرا', { exact: true }).click();
  await student.getByTitle('تشغيل الكاميرا', { exact: true }).click();
  for (const page of [teacher, student]) {
    await page.waitForFunction(() => [...document.querySelectorAll('.participant-tile .camera-placeholder')].length === 0);
    const cards = await page.locator('.participant-tile').evaluateAll(elements => elements.map(element => { const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; }));
    assert.ok(cards[1].y >= cards[0].y + cards[0].height - 1 && Math.abs(cards[0].x - cards[1].x) < 2, `camera-only call must stack participants: ${JSON.stringify(cards)}`);
    assert.equal(await page.locator('.support-whatsapp').isVisible(), false, 'support must not cover an active call');
  }
  const nodes = await teacher.locator('.participant-tile video').count();
  assert.equal(nodes, 2);
  await teacher.getByTitle('اللوح المشترك', { exact: true }).click();
  await student.locator('.whiteboard-panel').waitFor();
  const canvas = await teacher.locator('.whiteboard-canvas').boundingBox();
  await teacher.mouse.move(canvas.x + 20, canvas.y + 40); await teacher.mouse.down(); await teacher.mouse.move(canvas.x + 140, canvas.y + 80, { steps: 12 }); await teacher.mouse.up();
  await student.locator('.whiteboard-canvas path').waitFor();
  await teacher.locator('.participant-tile').first().click();
  await teacher.locator('.shared-whiteboard-tile').waitFor();
  assert.equal(await teacher.locator('.shared-whiteboard-tile > svg path').count(), 1, 'board preview retains actual drawing when cameras are focused');
  const image = await teacher.locator('.call-stage').screenshot();
  await teacher.locator('[data-whiteboard-file-input]').setInputFiles({ name: 'lesson.png', mimeType: 'image/png', buffer: image });
  for (const page of [teacher, student]) {
    await page.waitForFunction(() => document.querySelector('.document-page img')?.naturalWidth > 0, undefined, { timeout: 30000 });
    const url = await page.locator('.document-page img').getAttribute('src');
    if (page === student) assert.ok(url.includes('/bookings/mobile-booking/files/'), 'the peer uses authenticated streamed files rather than large preview payloads');
    else assert.ok(url.startsWith('data:image/') || url.includes('/bookings/mobile-booking/files/'), 'the teacher can show its local preview before the upload finishes');
    await page.locator('.participant-tile').first().click();
    await page.locator('.shared-document-tile:not(.shared-whiteboard-tile)').click();
    await page.waitForFunction(() => document.querySelector('.document-page img')?.naturalWidth > 0);
    assert.ok((await page.locator('.stable-media-grid').boundingBox()).height >= 100);
    await page.screenshot({ path: `.private/mobile-call-${page === teacher ? 'teacher' : 'student'}.png` });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  assert.equal(await teacher.locator('.file-share-button').count(), 1);
  assert.equal(await teacher.locator('.file-share-button').getAttribute('title'), 'عرض الملف المشترك', 'viewing an open file must not close it');
  assert.equal(await teacher.getByTitle('إنهاء مشاركة الملف', { exact: true }).count(), 1);
  assert.equal(await teacher.getByTitle('إنهاء مشاركة البورد', { exact: true }).count(), 1, 'the two resources have separately named stop controls');
  assert.equal(await teacher.locator('.document-fit-width').count(), 0, 'the unwanted three-dot file button is removed');
  await student.reload({ waitUntil: 'domcontentloaded' });
  await student.locator('.room-card').getByRole('button', { name: /دخول الغرفة|انضم الآن/, exact: true }).click();
  for (const page of [teacher, student]) {
    await page.waitForFunction(() => [...document.querySelectorAll('.participant-tile video')].filter(video => video.srcObject).length === 2, undefined, { timeout: 30000 });
    const capture = await page.evaluate(async () => ({ errors: window.testMediaErrors, permission: (await navigator.permissions.query({ name: 'camera' })).state }));
    assert.equal(capture.permission, 'granted', 'the existing camera grant remains in force after reentry');
    if (await page.locator('.participant-tile .camera-placeholder').count()) assert.ok(capture.errors.some(error => error.name === 'NotFoundError'), 'camera fallback is only expected when the native capture device is actually unavailable');
    await page.waitForFunction(() => document.querySelector('.document-page img')?.naturalWidth > 0, undefined, { timeout: 30000 });
  }
  await teacher.getByTitle('إنهاء مشاركة الملف', { exact: true }).click();
  await student.locator('.document-page').waitFor({ state: 'detached' });
  for (const page of [teacher, student]) { await page.locator('.whiteboard-panel').waitFor(); assert.equal(await page.locator('.whiteboard-canvas path').count(), 1, 'closing the file keeps the open board intact'); }
  await teacher.getByTitle('إنهاء مشاركة البورد', { exact: true }).click();
  await student.locator('.shared-whiteboard-tile').waitFor({ state: 'detached' });
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
  await teacher.getByTitle('صفحات الملف', { exact: true }).click();
  const pageJumpAt = await teacher.getByRole('option', { name: 'صفحة 40', exact: true }).evaluate(button => { const at = Date.now(); button.click(); return at; });
  await teacher.waitForFunction(() => document.querySelector('.document-page img')?.alt.includes('40'));
  assert.equal(slowPageSaved, false, 'the teacher preview must not wait for its page upload');
  console.log('Teacher uncached page jump ms:', Date.now() - pageJumpAt);
  await student.waitForFunction(() => document.querySelector('.document-page img')?.alt.includes('40'));
  for (let i = 0; i < 160 && !savedPreviews.has('page-41.webp'); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(savedPreviews.has('page-41.webp'), 'wait for page 41 warm-up before measuring the cache hit');
  await new Promise(resolve => setTimeout(resolve, 100));
  const warmPageAt = await teacher.getByTitle('الصفحة التالية', { exact: true }).evaluate(button => { const at = Date.now(); button.click(); return at; });
  await student.waitForFunction(() => document.querySelector('.document-page img')?.alt.includes('41'));
  assert.ok(Date.now() - warmPageAt < 1000, 'a warmed slide should switch without a new upload round trip');
  console.log('Warm page jump at both endpoints ms:', Date.now() - warmPageAt);
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
  const observer = await context.newPage();
  await observer.goto(`${base}/students?view=rooms`);
  await observer.waitForFunction(() => document.querySelector('.room-presence span')?.classList.contains('online'));
  assert.equal(await teacher.locator('.call-toolbar .danger').isVisible(), true);
  const leaveAt = await teacher.locator('.call-toolbar .danger').evaluate(button => { const at = Date.now(); button.click(); return at; });
  await student.waitForFunction(() => document.querySelector('[data-tile="remote"] .camera-placeholder strong')?.textContent === 'بانتظار الدخول', undefined, { timeout: 2000 });
  await observer.waitForFunction(() => !document.querySelector('.room-presence span')?.classList.contains('online'), undefined, { timeout: 2000 });
  console.log('Explicit leave and booking-card presence ms:', Date.now() - leaveAt);
  assert.equal(await observer.locator('.support-whatsapp').innerText(), 'الدعم الفني');
  assert.equal(await observer.locator('.support-whatsapp svg').count(), 0);
  await observer.close();
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('Mobile classroom: stacked cameras, retained board/file, independent close controls, fast 624-page navigation, rejoin and immediate presence passed.');
} catch (error) {
  console.error('Browser page errors', errors);
  console.error('Stored booking presence', await db.collection('bookings').findOne({ id: 'mobile-booking' }));
  for (const [label, page] of [['teacher', teacher], ['student', student]]) console.error(label, JSON.stringify(await page.evaluate(() => ({ url: location.href, status: document.querySelector('.call-status,.call-media-error')?.textContent, mediaErrors: window.testMediaErrors.slice(-2), tracks: [...document.querySelectorAll('video')].map(video => ({ hasStream: !!video.srcObject, tracks: video.srcObject?.getTracks().map(track => ({ kind: track.kind, state: track.readyState })) })), peers: window.testPeerConnections.map(peer => ({ connection: peer.connectionState, ice: peer.iceConnectionState, signaling: peer.signalingState })), visible: document.visibilityState })), null, 2));
  await teacher.screenshot({ path: '.private/mobile-call-failure.png' }); throw error;
} finally {
  await browser.close(); await new Promise(resolve => io.close(() => httpServer.close(resolve)));
}
