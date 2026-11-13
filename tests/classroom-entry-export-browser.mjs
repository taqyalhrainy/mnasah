import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { startPlatformServer } from '../server/index.js';
import { memoryMongo } from './helpers/memory-mongo.mjs';

const start = Date.now() + 60000;
const users = [ { id: 'teacher', role: 'teachers', name: 'Teacher', status: 'active' }, { id: 'student', role: 'students', name: 'Student', status: 'active' } ];
const db = memoryMongo({ users, sessions: users.map(user => ({ user_id: user.id, token: crypto.createHash('sha256').update(user.id).digest('hex'), expires: Date.now() + 3600000 })), slots: [{ id: 'slot', teacher_id: 'teacher', start, minutes: 60, subject: 'رياضيات', price: 1000 }], bookings: [{ id: 'booking', slot_id: 'slot', teacher_id: 'teacher', student_id: 'student', status: 'confirmed', start, minutes: 60, subject: 'رياضيات', paid: 1, room: `entry-${Date.now()}` }] });
const { httpServer, io } = await startPlatformServer({ database: db, port: 0 });
const base = `http://127.0.0.1:${httpServer.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['camera', 'microphone'], serviceWorkers: 'block' });
  await context.addInitScript(() => { navigator.canShare = () => false; });
  await context.addCookies(users.map(user => ({ name: `mansah_session_${user.role}`, value: user.id, url: base })));
  for (const host of ['fonts.googleapis.com', 'fonts.gstatic.com', 'accounts.google.com']) await context.route(`https://${host}/**`, route => route.abort());
  const student = await context.newPage(), teacher = await context.newPage(), errors = [];
  for (const page of [student, teacher]) { page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message)); }
  await student.goto(base + '/students?view=rooms');
  await student.locator('.room-card').getByRole('button', { name: /دخول الغرفة|انضم الآن/, exact: true }).click();
  for (let index = 0; index < 60; index++) {
    const booking = await db.collection('bookings').findOne({ id: 'booking' });
    if (booking.student_peer_id && booking.student_present_until > Date.now()) break;
    if (index === 59) throw new Error('student never announced presence');
    await student.waitForTimeout(100);
  }
  let releasePolling; const heldPolling = new Promise(resolve => { releasePolling = resolve; });
  let roomRequests = 0;
  await teacher.route('**/api/teachers/bookings/booking/room', async route => {
    // First request opens the room; the authorization inside the room then fails once.
    if (++roomRequests === 2) await route.fulfill({ status: 503, json: { error: 'Temporary outage' } });
    else await route.continue();
  });
  await teacher.route('**/api/teachers/bookings/booking/presence', async route => { if (route.request().method() === 'GET') await heldPolling; await route.continue().catch(() => undefined); });
  await teacher.addInitScript(() => {
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.captureAttempts = 0;
    navigator.mediaDevices.getUserMedia = async constraints => {
      if (++window.captureAttempts <= 3) throw new DOMException('Microphone still releasing', 'NotReadableError');
      await new Promise(resolve => setTimeout(resolve, 450)); return capture(constraints);
    };
  });
  await teacher.goto(base + '/teachers?view=rooms');
  await teacher.locator('.room-card').getByRole('button', { name: /دخول الغرفة|انضم الآن/, exact: true }).click();
  await teacher.locator('.video-room').waitFor();
  await teacher.locator('[data-tile=remote] .camera-placeholder small').filter({ hasText: 'داخل الحصة' }).waitFor({ state: 'attached' });
  assert.doesNotMatch(await teacher.locator('[data-tile=remote]').innerText(), /لم يدخل بعد|بانتظار الدخول/);
  for (const page of [student, teacher]) await page.waitForFunction(() => [...document.querySelectorAll('.participant-tile video')].filter(video => video.srcObject).length === 2, null, { timeout: 25000 });
  assert.ok(roomRequests >= 4, 'temporary authorization and microphone failure must recover automatically');
  assert.equal(await teacher.evaluate(() => window.captureAttempts), 4);
  releasePolling();
  await teacher.getByTitle('اللوح المشترك', { exact: true }).tap();
  const board = teacher.locator('.whiteboard-canvas'); await board.waitFor();
  const picture = await teacher.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 180; canvas.height = 100; const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ed263a'; ctx.fillRect(0, 0, 180, 100); return canvas.toDataURL('image/png').split(',')[1]; });
  await teacher.locator('.whiteboard-tools input[type=file]').setInputFiles({ name: 'example.png', mimeType: 'image/png', buffer: Buffer.from(picture, 'base64') });
  await teacher.locator('.whiteboard-board-image').waitFor();
  await teacher.locator('[data-whiteboard-tool=text]').tap();
  const box = await board.boundingBox();
  await teacher.touchscreen.tap(box.x + 25, box.y + 25);
  await teacher.locator('.mobile-whiteboard-text-input').fill('صورة البورد · اختبار');
  await teacher.getByRole('button', { name: 'حفظ النص', exact: true }).tap();
  await teacher.locator('[data-whiteboard-tool=draw]').tap();
  const drawing = await board.boundingBox();
  await teacher.mouse.move(drawing.x + 20, drawing.y + drawing.height * .7); await teacher.mouse.down(); await teacher.mouse.move(drawing.x + 130, drawing.y + drawing.height * .7, { steps: 8 }); await teacher.mouse.up();
  const saving = teacher.waitForEvent('download');
  await teacher.getByRole('button', { name: 'تنزيل اللوح', exact: true }).tap();
  const download = await saving, bytes = await readFile(await download.path());
  assert.match(download.suggestedFilename(), /\.png$/);
  assert.deepEqual([...bytes.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
  assert.ok(bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0);
  await download.saveAs('.private/whiteboard-export.png');
  const pixels = await teacher.evaluate(async data => {
    const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
    const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data; let red = 0, white = 0, ink = 0;
    for (let i = 0; i < rgba.length; i += 4) { if (rgba[i] > 180 && rgba[i + 1] < 90 && rgba[i + 2] < 110) red++; if (rgba[i] > 245 && rgba[i+1] > 245 && rgba[i+2] > 245) white++; if (rgba[i] < 140 && rgba[i+1] < 140 && rgba[i+2] < 140) ink++; }
    return { red, white, ink };
  }, bytes.toString('base64'));
  assert.ok(pixels.red > 1000 && pixels.white > 1000 && pixels.ink > 20, JSON.stringify(pixels));
  // iPhone path shares an actual PNG File, without navigating away from the call.
  await teacher.evaluate(() => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' });
    navigator.canShare = data => data.files?.[0]?.type === 'image/png';
    navigator.share = async data => { const file = data.files[0]; window.sharedBoardFile = { type: file.type, name: file.name, magic: [...new Uint8Array(await file.arrayBuffer()).slice(0, 8)] }; };
  });
  await teacher.getByRole('button', { name: 'تنزيل اللوح', exact: true }).tap();
  await teacher.locator('.board-image-preview img').waitFor();
  await teacher.getByRole('button', { name: 'حفظ الصورة في الصور', exact: true }).tap();
  await teacher.waitForFunction(() => !!window.sharedBoardFile);
  const shared = await teacher.evaluate(() => window.sharedBoardFile);
  assert.equal(shared.type, 'image/png'); assert.match(shared.name, /\.png$/); assert.deepEqual(shared.magic, [137,80,78,71,13,10,26,10]);
  assert.equal(await teacher.locator('.participant-tile video').evaluateAll(nodes => nodes.filter(node => node.srcObject).length), 2);
  await teacher.locator('.board-image-preview').getByRole('button', { name: 'إغلاق', exact: true }).tap();
  // Android supports image sharing too; do not force its users into a file-only download.
  await teacher.evaluate(() => {
    window.sharedBoardFile = null;
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => 'Mozilla/5.0 (Linux; Android 15)' });
  });
  await teacher.getByRole('button', { name: 'تنزيل اللوح', exact: true }).tap();
  await teacher.locator('.board-image-preview img').waitFor();
  await teacher.getByRole('button', { name: 'حفظ الصورة في الصور', exact: true }).tap();
  await teacher.waitForFunction(() => !!window.sharedBoardFile);
  assert.equal((await teacher.evaluate(() => window.sharedBoardFile)).type, 'image/png');
  await teacher.locator('.board-image-preview').getByRole('button', { name: 'إغلاق', exact: true }).tap();
  await teacher.route('**/api/teachers/bookings/booking/files?**', route => route.fulfill({ status: 503, json: { error: 'تعذر تنفيذ الطلب الآن. حاول مجدداً.' } }));
  await teacher.locator('[data-whiteboard-file-input]').setInputFiles({ name: 'failure.png', mimeType: 'image/png', buffer: Buffer.from(picture, 'base64') });
  await teacher.locator('.call-media-error').waitFor();
  await teacher.locator('.call-media-error').waitFor({ state: 'detached', timeout: 7000 });
  assert.equal(await teacher.locator('.participant-tile video').evaluateAll(nodes => nodes.filter(node => node.srcObject).length), 2, 'dismissing the error must preserve the call');
  await teacher.close();
  const denied = await context.newPage();
  await denied.addInitScript(() => {
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.captureAttempts = 0; window.denyCapture = true;
    navigator.mediaDevices.getUserMedia = constraints => {
      window.captureAttempts++;
      if (window.denyCapture) return Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
      return capture(constraints);
    };
  });
  await denied.goto(base + '/teachers?view=rooms');
  await denied.locator('.room-card').getByRole('button', { name: /دخول الغرفة|انضم الآن/, exact: true }).click();
  await denied.getByRole('button', { name: 'إعادة المحاولة', exact: true }).waitFor();
  await denied.waitForTimeout(1800);
  assert.equal(await denied.evaluate(() => window.captureAttempts), 1, 'permission denial must not trigger automatic prompts');
  await denied.evaluate(() => { window.denyCapture = false; });
  await denied.getByRole('button', { name: 'إعادة المحاولة', exact: true }).click();
  await denied.waitForFunction(() => [...document.querySelectorAll('.participant-tile video')].filter(video => video.srcObject).length === 2, null, { timeout: 25000 });
  assert.equal(await denied.evaluate(() => window.captureAttempts), 2, 'explicit retry works without closing the app');
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('Automatic entry recovery after failed authorization and busy microphone; no permission prompt loop; manual retry reconnects; PNG includes images/text/drawing and shares on iOS/Android.');
} finally { await browser.close(); await new Promise(resolve => io.close(() => httpServer.close(resolve))); }
