import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const context = await browser.newContext({ permissions: ['camera', 'microphone'] });
const teacher = await context.newPage();
const student = await context.newPage();
teacher.setDefaultTimeout(15000);
student.setDefaultTimeout(15000);
const errors = [];
const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:8787';
const stressSteps = Number(process.env.WHITEBOARD_STRESS_STEPS || 600);
const reconnectAttempts = Number(process.env.VIDEO_RECONNECT_ATTEMPTS || 3);
teacher.on('pageerror', error => errors.push(error.message));
student.on('pageerror', error => errors.push(error.message));

try {
  const room = `browser-check-${Date.now()}`;
  await teacher.goto(`${baseUrl}/video-test?room=${room}&role=teacher`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await student.goto(`${baseUrl}/video-test?room=${room}&role=student`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await teacher.locator('.video-test-page').waitFor();
  await student.locator('.video-test-page').waitFor();
  await teacher.waitForFunction(() => [...document.querySelectorAll('video')].filter(video => video.srcObject).length === 2, undefined, { timeout: 20000 });
  await student.waitForFunction(() => [...document.querySelectorAll('video')].filter(video => video.srcObject).length === 2, undefined, { timeout: 20000 });
  await teacher.getByTitle('إيقاف المايك', { exact: true }).click();
  await teacher.waitForFunction(() => !document.querySelector('.participant-tile:last-of-type')?.classList.contains('speaking'));
  assert.equal(await teacher.locator('.participant-tile').last().evaluate(element => element.classList.contains('speaking')), false, 'muted speakers must not have a green outline');
  await teacher.getByTitle('تشغيل المايك', { exact: true }).click();

  await teacher.getByTitle('المحادثة').click();
  await student.getByTitle('المحادثة').click();
  await teacher.getByLabel('رسالة جديدة').fill('أ');
  await student.locator('.call-typing-indicator').waitFor({ timeout: 10000 });
  assert.equal(await student.locator('.call-typing-indicator span').count(), 3);
  await student.locator('.call-typing-indicator').waitFor({ state: 'detached', timeout: 5000 });
  await teacher.getByTitle('المحادثة').click();
  await student.getByTitle('المحادثة').click();

  await teacher.getByTitle('اللوح المشترك', { exact: true }).click();
  await teacher.locator('.whiteboard-canvas').waitFor();
  await student.locator('.whiteboard-canvas').waitFor();
  for (const page of [teacher, student]) {
    await page.evaluate(() => {
      window.videoStreamsBeforeDrawing = [...document.querySelectorAll('video')].map(video => video.srcObject);
    });
  }

  const board = await teacher.locator('.whiteboard-canvas').boundingBox();
  assert.ok(board);
  await teacher.mouse.move(board.x + 30, board.y + board.height / 2);
  await teacher.mouse.down();
  const teacherDrawing = teacher.mouse.move(board.x + board.width - 30, board.y + board.height / 2 + 40, { steps: stressSteps });
  await student.waitForFunction(() => (document.querySelector('.whiteboard-canvas path')?.getAttribute('d')?.includes('L') ?? false), undefined, { timeout: 10000 });
  await teacherDrawing;
  await teacher.mouse.up();
  await student.locator('.whiteboard-canvas path').waitFor();

  const studentBoard = await student.locator('.whiteboard-canvas').boundingBox();
  assert.ok(studentBoard);
  await student.mouse.move(studentBoard.x + 40, studentBoard.y + 80);
  await student.mouse.down();
  const studentDrawing = student.mouse.move(studentBoard.x + studentBoard.width - 40, studentBoard.y + 130, { steps: stressSteps });
  await teacher.waitForFunction(() => document.querySelectorAll('.whiteboard-canvas path').length >= 2
    && (document.querySelectorAll('.whiteboard-canvas path')[1]?.getAttribute('d')?.includes('L') ?? false), undefined, { timeout: 10000 });
  await studentDrawing;
  await student.mouse.up();

  for (const page of [teacher, student]) {
    const streamState = await page.evaluate(() => {
      const videos = [...document.querySelectorAll('video')];
      return videos.map((video, index) => ({ same: video.srcObject === window.videoStreamsBeforeDrawing[index], hasStream: Boolean(video.srcObject), tracks: video.srcObject ? [...video.srcObject.getTracks()].map(track => `${track.kind}:${track.readyState}`) : [] }));
    });
    assert.equal(streamState.every(item => item.same && item.hasStream && item.tracks.every(track => track.endsWith(':live'))), true, `drawing must not detach or stop the camera and microphone streams: ${JSON.stringify(streamState)}`);
  }

  await teacher.locator('[data-whiteboard-tool="text"]').click();
  const textBoard = teacher.locator('.whiteboard-canvas');
  const textBoardBox = await textBoard.boundingBox();
  assert.ok(textBoardBox);
  await textBoard.click({ position: { x: textBoardBox.width * 0.35, y: textBoardBox.height * 0.28 } });
  const textEditor = teacher.locator('.whiteboard-text-editor');
  await textEditor.fill('Shared board text');
  await teacher.locator('[data-whiteboard-tool="select"]').click();
  assert.equal(await teacher.locator('.whiteboard-inspector').count(), 0, 'text selection must not open a formatting bar');
  await student.waitForFunction(() => [...document.querySelectorAll('.whiteboard-text-content')].some(element => element.textContent === 'Shared board text'), undefined, { timeout: 10000 });
  const textSizeBefore = Number.parseFloat(await teacher.locator('.whiteboard-text-content').first().evaluate(element => getComputedStyle(element).fontSize));
  const textHandle = await teacher.locator('.whiteboard-resize-handle').boundingBox();
  assert.ok(textHandle);
  await teacher.mouse.move(textHandle.x + textHandle.width / 2, textHandle.y + textHandle.height / 2);
  await teacher.mouse.down();
  await teacher.mouse.move(textHandle.x + 100, textHandle.y + 70, { steps: 8 });
  await teacher.mouse.up();
  const textSizeAfter = Number.parseFloat(await teacher.locator('.whiteboard-text-content').first().evaluate(element => getComputedStyle(element).fontSize));
  assert.ok(textSizeAfter > textSizeBefore, `resizing a text box must scale its text (${textSizeBefore} -> ${textSizeAfter})`);

  const imageBuffer = await teacher.locator('.call-stage').screenshot();
  await teacher.locator('.whiteboard-image-input[accept^="image/"]').setInputFiles({ name: 'board-image.png', mimeType: 'image/png', buffer: imageBuffer });
  await student.locator('.whiteboard-board-image').waitFor({ timeout: 10000 });
  assert.ok((await student.locator('.whiteboard-board-image').getAttribute('src'))?.startsWith('data:image/webp'));
  await teacher.evaluate(async () => {
    const existing = document.querySelector('.whiteboard-board-image');
    const blob = await (await fetch(existing.src)).blob();
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], 'pasted-screenshot.webp', { type: blob.type || 'image/webp' }));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  });
  await student.waitForFunction(() => document.querySelectorAll('.whiteboard-board-image').length === 2, undefined, { timeout: 10000 });
  await teacher.getByTitle('تراجع خطوة').click();
  await student.waitForFunction(() => document.querySelectorAll('.whiteboard-board-image').length === 1, undefined, { timeout: 10000 });
  const pastedSize = await teacher.locator('.whiteboard-canvas foreignObject').last().evaluate(element => {
    const svg = element.closest('svg');
    return { width: Number(element.getAttribute('width')), height: Number(element.getAttribute('height')), viewWidth: svg.viewBox.baseVal.width, viewHeight: svg.viewBox.baseVal.height };
  });
  assert.equal(pastedSize.width / pastedSize.viewWidth <= 0.43 && pastedSize.height / pastedSize.viewHeight <= 0.47, true, `pasted image should start at a balanced board size: ${JSON.stringify(pastedSize)}`);
  await teacher.screenshot({ path: '.private/whiteboard-text-image.png' });

  await teacher.evaluate(() => { window.stableVideoNodes = [...document.querySelectorAll('video')]; });
  await student.evaluate(() => { window.stableVideoNodes = [...document.querySelectorAll('video')]; });
  const slides = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
    'ppt/presentation.xml': '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/></p:presentation>',
    'ppt/_rels/presentation.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>',
    ...Object.fromEntries([1, 2].map(number => [`ppt/slides/slide${number}.xml`, `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="500000" y="500000"/><a:ext cx="7000000" cy="2000000"/></a:xfrm><a:prstGeom prst="rect"/></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="3600"/><a:t>Slide ${number}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`])),
  };
  await teacher.locator('[data-whiteboard-file-input]').setInputFiles({ name: 'class-slides.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', buffer: Buffer.from(zipSync(Object.fromEntries(Object.entries(slides).map(([name, content]) => [name, strToU8(content)])))) });
  await teacher.locator('.document-page img').waitFor({ timeout: 30000 });
  await student.locator('.document-page img').waitFor({ timeout: 20000 });
  await teacher.getByTitle('صفحات الملف', { exact: true }).click();
  await teacher.getByRole('option', { name: 'صفحة 2', exact: true }).click();
  await student.waitForFunction(() => document.querySelector('.document-page img')?.getAttribute('alt')?.includes('2'));
  for (const page of [teacher, student]) {
    await page.locator('.participant-tile').first().click();
    await page.locator('.shared-document-tile').waitFor();
    await page.locator('.shared-document-tile').click();
    await page.locator('.document-page img').waitFor();
    assert.equal(await page.evaluate(() => window.stableVideoNodes.every((video, index) => video === document.querySelectorAll('video')[index])), true, 'camera elements must remain mounted across focus/document changes');
    await page.setViewportSize({ width: 390, height: 844 });
    const bounds = await page.locator('.stable-media-grid').boundingBox();
    assert.ok(bounds.height >= 100, `camera rail should stay visible on mobile: ${bounds.height}`);
    await page.waitForFunction(() => document.querySelector('.document-page img')?.naturalWidth > 0);
    await page.screenshot({ path: `.private/video-document-${page === teacher ? 'teacher' : 'student'}.png` });
  }
  await teacher.getByTitle('إنهاء مشاركة الملف', { exact: true }).click();
  await student.locator('.document-page').waitFor({ state: 'detached' });
  for (const page of [teacher, student]) await page.setViewportSize({ width: 1280, height: 720 });

  async function leaveAndReturn(leaver, waitingParticipant) {
    await waitingParticipant.evaluate(() => { window.remoteStreamBeforeReturn = document.querySelectorAll('video')[0]?.srcObject; });
    await leaver.locator('.call-toolbar .danger').click();
    await leaver.locator('.session-controls .primary-button').click();
    await leaver.waitForFunction(() => [...document.querySelectorAll('video')].filter(video => video.srcObject).length === 2, undefined, { timeout: 30000 });
    await waitingParticipant.waitForFunction(() => {
      const remote = document.querySelectorAll('video')[0]?.srcObject;
      return remote && remote !== window.remoteStreamBeforeReturn && [...remote.getTracks()].every(track => track.readyState === 'live');
    }, undefined, { timeout: 30000 });
  }

  for (let attempt = 0; attempt < reconnectAttempts; attempt += 1) await leaveAndReturn(teacher, student);
  for (let attempt = 0; attempt < reconnectAttempts; attempt += 1) await leaveAndReturn(student, teacher);

  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('Direct video route, whiteboard stability, and repeated teacher/student leave-and-return checks passed.');
} catch (error) {
  console.error(await teacher.evaluate(() => [...document.querySelectorAll('.call-experience,.call-stage,.stable-media-grid,.shared-document-tile')].map(element => ({ className: element.className, rect: element.getBoundingClientRect().toJSON() }))));
  await teacher.screenshot({ path: '.private/video-failure.png' });
  throw error;
} finally {
  await browser.close();
}
