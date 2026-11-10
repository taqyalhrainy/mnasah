import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { startPlatformServer } from '../server/index.js';
import { memoryMongo } from './helpers/memory-mongo.mjs';

const { httpServer, io } = await startPlatformServer({ database: memoryMongo(), port: 0 });
const base = `http://127.0.0.1:${httpServer.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, permissions: ['camera', 'microphone'] });
  for (const host of ['fonts.googleapis.com', 'fonts.gstatic.com', 'accounts.google.com']) await context.route(`https://${host}/**`, route => route.abort());
  const teacher = await context.newPage(), student = await context.newPage(), errors = [];
  for (const page of [teacher, student]) { page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message)); }
  const room = `drawing-${Date.now()}`;
  await teacher.goto(`${base}/video-test?room=${room}&role=teacher`, { waitUntil: 'domcontentloaded' });
  await student.goto(`${base}/video-test?room=${room}&role=student`, { waitUntil: 'domcontentloaded' });
  for (const page of [teacher, student]) await page.waitForFunction(() => [...document.querySelectorAll('.participant-tile video')].filter(video => video.srcObject).length === 2, null, { timeout: 25000 });
  assert.ok(await teacher.locator('.participant-tile[data-tile="local"] video').evaluate(el => new DOMMatrix(getComputedStyle(el).transform).a < 0), 'front preview is visibly mirrored');
  await teacher.getByTitle('اللوح المشترك', { exact: true }).tap();
  await student.locator('.whiteboard-canvas').waitFor();
  for (const page of [teacher, student]) {
    await page.locator('[data-whiteboard-tool=draw]').tap();
    const box = await page.locator('.whiteboard-canvas').boundingBox();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width * .4, y: box.y + box.height * .4, id: 1 }] });
    for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + box.width * (.4 + i * .02), y: box.y + box.height * (.4 + i * .02), id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  }
  for (const page of [teacher, student]) await page.waitForFunction(() => document.querySelectorAll('.whiteboard-canvas > path').length === 2);
  const image = await teacher.evaluate(() => { const c = document.createElement('canvas'); c.width = 600; c.height = 900; const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 600, 900); x.fillStyle = '#4b2071'; x.fillRect(100, 100, 200, 200); return c.toDataURL('image/png').split(',')[1]; });
  await teacher.locator('[data-whiteboard-file-input]').setInputFiles({ name: 'lesson.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64') });
  for (const page of [teacher, student]) await page.locator('.document-zoom-percent').waitFor();
  await teacher.getByTitle('تكبير الملف', { exact: true }).tap();
  await teacher.waitForFunction(() => document.querySelector('.document-zoom-percent')?.textContent === '125%');
  await student.waitForTimeout(150);
  assert.equal(await student.locator('.document-zoom-percent').innerText(), '100%');
  await teacher.getByTitle('تكبير الملف', { exact: true }).tap();
  await teacher.waitForFunction(() => document.querySelector('.document-zoom-percent')?.textContent === '156%');
  await student.getByTitle('تكبير الملف', { exact: true }).tap();
  assert.equal(await teacher.locator('.document-zoom-percent').innerText(), '156%');
  assert.equal(await student.locator('.document-zoom-percent').innerText(), '125%');
  await teacher.getByTitle('المؤشر الأحمر', { exact: true }).tap();
  const surface = await teacher.locator('.document-page-canvas').boundingBox();
  const annotations = await teacher.locator('.document-page-canvas path').count();
  await teacher.touchscreen.tap(surface.x + surface.width / 2, surface.y + surface.height / 2);
  await student.locator('.document-page-canvas .shared-pointer.remote').waitFor();
  assert.equal(await teacher.locator('.document-page-canvas path').count(), annotations, 'pointer adds no drawing');
  await teacher.getByTitle('عرض الصفحة كاملة', { exact: true }).first().tap();
  assert.equal(await teacher.locator('.document-zoom-percent').innerText(), '100%');
  assert.equal(await student.locator('.document-zoom-percent').innerText(), '125%');
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('Both peers draw; front camera is mirrored; file zoom stays independent and pointer synchronizes without drawing.');
} finally { await browser.close(); await new Promise(resolve => io.close(() => httpServer.close(resolve))); }
