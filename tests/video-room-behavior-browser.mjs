import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

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

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});

try {
  const context = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.__mediaRequests = [];
    navigator.mediaDevices.getUserMedia = async constraints => {
      window.__mediaRequests.push({ audio: Boolean(constraints?.audio), video: Boolean(constraints?.video) });
      return original(constraints);
    };
  });
  const teacher = await context.newPage();
  const student = await context.newPage();
  const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:8787';
  const room = `behavior-${Date.now()}`;
  await teacher.goto(`${baseUrl}/video-test?room=${room}&role=teacher`);
  await student.goto(`${baseUrl}/video-test?room=${room}&role=student`);
  await teacher.waitForFunction(() => [...document.querySelectorAll('video')].filter(video => video.srcObject).length === 2, undefined, { timeout: 25000 });
  await student.waitForFunction(() => [...document.querySelectorAll('video')].filter(video => video.srcObject).length === 2, undefined, { timeout: 25000 });

  assert.equal(await teacher.getByTitle('تشغيل الكاميرا').isVisible(), true, 'camera must start off');
  const initialRequests = await teacher.evaluate(() => window.__mediaRequests);
  assert.equal(initialRequests.some(request => request.video), false, 'joining must not request camera access');
  await teacher.getByTitle('تشغيل الكاميرا').click();
  await teacher.getByTitle('إيقاف الكاميرا').waitFor();
  await student.waitForFunction(() => document.querySelectorAll('.camera-placeholder').length === 1, undefined, { timeout: 10000 });
  await teacher.getByTitle('إيقاف الكاميرا').click();
  await teacher.getByTitle('تشغيل الكاميرا').click();
  await teacher.getByTitle('إيقاف الكاميرا').waitFor();
  const enabledRequests = await teacher.evaluate(() => window.__mediaRequests);
  assert.equal(enabledRequests.filter(request => request.video).length, 1, 'camera permission should be requested only once and the same track reused');

  await teacher.getByTitle('اللوح المشترك').click();
  await teacher.locator('.whiteboard-canvas').waitFor();
  await student.locator('.whiteboard-canvas').waitFor();
  const teacherBoard = await teacher.locator('.whiteboard-canvas').boundingBox();
  const studentBoard = await student.locator('.whiteboard-canvas').boundingBox();
  assert.ok(teacherBoard && studentBoard);

  await teacher.mouse.move(teacherBoard.x + 80, teacherBoard.y + 90);
  await teacher.mouse.down();
  await teacher.mouse.move(teacherBoard.x + 280, teacherBoard.y + 130, { steps: 8 });
  await teacher.mouse.up();
  await student.waitForFunction(() => document.querySelectorAll('.whiteboard-canvas path').length === 1, undefined, { timeout: 10000 });

  await student.mouse.move(studentBoard.x + 100, studentBoard.y + 180);
  await student.mouse.down();
  await student.mouse.move(studentBoard.x + 310, studentBoard.y + 230, { steps: 8 });
  await student.mouse.up();
  await teacher.waitForFunction(() => document.querySelectorAll('.whiteboard-canvas path').length === 2, undefined, { timeout: 10000 });
  await student.getByTitle('تراجع عن آخر إضافة لك').click();
  await teacher.waitForFunction(() => document.querySelectorAll('.whiteboard-canvas path').length === 1, undefined, { timeout: 10000 });

  const imageBuffer = await teacher.locator('.call-stage').screenshot();
  await teacher.locator('.whiteboard-image-input').first().setInputFiles({ name: 'lesson.png', mimeType: 'image/png', buffer: imageBuffer });
  const image = teacher.locator('.whiteboard-board-image').last();
  await image.waitFor();
  const imageObject = image.locator('xpath=..');
  const beforeImageBox = await imageObject.evaluate(element => ({ x: element.getAttribute('x'), y: element.getAttribute('y'), width: element.getAttribute('width'), height: element.getAttribute('height') }));
  await teacher.locator('[data-whiteboard-tool="draw"]').click();
  const imageBox = await image.boundingBox();
  assert.ok(imageBox);
  const pathsBefore = await teacher.locator('.whiteboard-canvas path').count();
  await teacher.mouse.move(imageBox.x + 20, imageBox.y + imageBox.height / 2);
  await teacher.mouse.down();
  await teacher.mouse.move(imageBox.x + imageBox.width - 20, imageBox.y + imageBox.height / 2, { steps: 10 });
  await teacher.mouse.up();
  assert.equal(await teacher.locator('.whiteboard-canvas path').count(), pathsBefore + 1, 'drawing over an image should create a stroke');
  assert.deepEqual(await imageObject.evaluate(element => ({ x: element.getAttribute('x'), y: element.getAttribute('y'), width: element.getAttribute('width'), height: element.getAttribute('height') })), beforeImageBox, 'drawing must not move the image');

  const viewWidthBefore = await teacher.locator('.whiteboard-canvas').evaluate(svg => svg.viewBox.baseVal.width);
  const pageScaleBefore = await teacher.evaluate(() => window.visualViewport?.scale || 1);
  await teacher.mouse.move(teacherBoard.x + teacherBoard.width / 2, teacherBoard.y + teacherBoard.height / 2);
  await teacher.keyboard.down('Control');
  await teacher.mouse.wheel(0, -300);
  await teacher.keyboard.up('Control');
  const viewWidthAfter = await teacher.locator('.whiteboard-canvas').evaluate(svg => svg.viewBox.baseVal.width);
  assert.ok(viewWidthAfter < viewWidthBefore, 'wheel zoom should affect the board');
  assert.equal(await teacher.evaluate(() => window.visualViewport?.scale || 1), pageScaleBefore, 'board zoom must not zoom the website');

  await teacher.locator('[data-whiteboard-file-input]').setInputFiles({ name: 'lesson.pdf', mimeType: 'application/pdf', buffer: createPdfBuffer() });
  await teacher.locator('.whiteboard-document-pages').waitFor({ timeout: 45000 });
  assert.match(await teacher.locator('.whiteboard-document-pages').innerText(), /lesson\.pdf/);
  assert.equal(await teacher.locator('.call-diagnostic').count(), 0, 'technical connection diagnostics must not be shown to users');
  await teacher.screenshot({ path: '.private/video-room-behavior.png' });
  console.log('Camera opt-in, private undo, image annotation, board-only zoom and PDF board upload passed.');
} finally {
  await browser.close();
}
