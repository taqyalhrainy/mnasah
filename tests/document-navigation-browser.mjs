import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const base = process.env.UI_BASE_URL || 'http://127.0.0.1:5192';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
try {
  const context = await browser.newContext({ hasTouch: true, permissions: ['microphone'], viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const teacher = await context.newPage(), student = await context.newPage();
  const room = `document-navigation-${Date.now()}`;
  for (const [page, role] of [[teacher, 'teacher'], [student, 'student']]) {
    await page.route('**/api/**', route => route.fulfill({ json: {} }));
    await page.goto(`${base}/video-test?room=${room}&role=${role}`, { waitUntil: 'domcontentloaded' });
    await page.locator('.video-room').waitFor();
    await page.evaluate(() => { const room = document.querySelector('.video-room'); const shell = document.createElement('div'); shell.className = 'immersive-call-shell'; room.before(shell); shell.append(room); });
  }
  await teacher.waitForFunction(() => [...document.querySelectorAll('video')].filter(video => video.srcObject).length === 2, undefined, { timeout: 25000 });
  await teacher.locator('[data-whiteboard-file-input]').setInputFiles({ name: 'navigation.pdf', mimeType: 'application/pdf', buffer: createPdfBuffer() });
  for (const page of [teacher, student]) {
    await page.locator('.document-page img').waitFor({ timeout: 20000 });
    await page.waitForFunction(() => document.querySelector('.document-page img')?.naturalHeight > 0);
  }
  const fitted = await teacher.locator('.document-page-canvas').boundingBox();
  await teacher.getByTitle('تكبير الملف', { exact: true }).click();
  await teacher.getByTitle('تكبير الملف', { exact: true }).click();
  assert.ok((await teacher.locator('.document-page-canvas').boundingBox()).width > fitted.width * 1.4);
  await teacher.getByTitle('تحريك الصفحة', { exact: true }).click();
  const area = await teacher.locator('.document-page').boundingBox();
  const x = area.x + area.width / 2, y = area.y + area.height / 2;
  await teacher.mouse.move(x, y); await teacher.mouse.down(); await teacher.mouse.move(x, y - 75, { steps: 5 }); await teacher.mouse.up();
  assert.match(await teacher.locator('.document-page-canvas').getAttribute('style'), /translate\(0px, -75px\)/);
  assert.equal(await teacher.locator('.document-page svg path').count(), 0, 'panning must not draw');
  await teacher.getByTitle('قلم', { exact: true }).click();
  await teacher.mouse.move(x, y); await teacher.mouse.down(); await teacher.mouse.move(x + 35, y + 20, { steps: 5 }); await teacher.mouse.up();
  await student.locator('.document-page svg path').last().waitFor();
  assert.equal(await teacher.locator('.document-page svg path').last().getAttribute('d'), await student.locator('.document-page svg path').last().getAttribute('d'));
  await teacher.mouse.move(x + 50, y + 30);
  await student.locator('.document-page .shared-pointer.remote').waitFor();
  await teacher.locator('.document-zoom-percent').click();
  await teacher.getByRole('button', { name: 'ملاءمة العرض', exact: true }).click();
  assert.ok((await teacher.locator('.document-page-canvas').boundingBox()).width > fitted.width * 1.4);
  const scale = await teacher.evaluate(() => visualViewport.scale);
  await teacher.mouse.move(x, y); await teacher.keyboard.down('Control'); await teacher.mouse.wheel(0, -80); await teacher.keyboard.up('Control');
  assert.equal(await teacher.evaluate(() => visualViewport.scale), scale);
  await teacher.locator('.document-zoom-percent').click();
  await teacher.setViewportSize({ width: 390, height: 844 });
  await teacher.waitForFunction(() => { const a = document.querySelector('.document-page').getBoundingClientRect(), b = document.querySelector('.document-page img').getBoundingClientRect(); return b.height > 180 && b.bottom <= a.bottom + 1 && b.top >= a.top && b.width <= a.width; });
  const mobile = await teacher.locator('.document-page').boundingBox();
  const cx = mobile.x + mobile.width / 2, cy = mobile.y + mobile.height / 2;
  const session = await context.newCDPSession(teacher);
  const beforePinch = await teacher.locator('.document-page svg path').count();
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx - 35, y: cy }, { x: cx + 35, y: cy }] });
  await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx - 85, y: cy }, { x: cx + 85, y: cy }] });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.ok(parseInt(await teacher.locator('.document-zoom-percent').innerText(), 10) > 150);
  assert.equal(await teacher.locator('.document-page svg path').count(), beforePinch, 'pinching must not leave a pen mark');
  assert.equal(await teacher.evaluate(() => visualViewport.scale), 1);
  await teacher.getByTitle('تحريك الصفحة', { exact: true }).click();
  await teacher.locator('.document-viewer').screenshot({ path: '.private/document-navigation-mobile.png', animations: 'disabled', timeout: 10000 });
  console.log('Two-peer document zoom, fit-width, hand panning, shared annotation coordinates, pointer and mobile pinch passed.');
} finally { await browser.close(); }

function createPdfBuffer() {
  const content = 'BT /F1 24 Tf 72 720 Td (Board PDF page) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let source = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(source, 'latin1'));
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(source, 'latin1');
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(source, 'latin1');
}

