import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { startPlatformServer } from '../server/index.js';
import { memoryMongo } from './helpers/memory-mongo.mjs';

const { httpServer, io } = await startPlatformServer({ database: memoryMongo(), port: 0 });
const base = `http://127.0.0.1:${httpServer.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const agents = {
  android: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/142.0.0.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
};
try {
  for (const [device, userAgent] of Object.entries(agents).filter(([name]) => !process.env.TOUCH_DEVICE || process.env.TOUCH_DEVICE === name)) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent, permissions: ['camera', 'microphone'] });
    for (const host of ['fonts.googleapis.com', 'fonts.gstatic.com', 'accounts.google.com']) await context.route(`https://${host}/**`, route => route.abort());
    const teacher = await context.newPage(), student = await context.newPage(), errors = [];
    for (const page of [teacher, student]) { page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message)); }
    const room = `touch-${device}-${Date.now()}`;
    await teacher.goto(`${base}/video-test?room=${room}&role=teacher`);
    await student.goto(`${base}/video-test?room=${room}&role=student`);
    for (const page of [teacher, student]) await page.waitForFunction(() => [...document.querySelectorAll('.participant-tile video')].filter(video => video.srcObject).length === 2, undefined, { timeout: 25000 });
    await teacher.getByTitle('اللوح المشترك', { exact: true }).tap();
    await student.locator('.whiteboard-canvas').waitFor();
    const board = teacher.locator('.whiteboard-canvas');
    await teacher.locator('[data-whiteboard-tool=text]').tap();
    const area = await board.boundingBox();
    await teacher.touchscreen.tap(area.x + 55, area.y + 90);
    const editor = teacher.locator('.mobile-whiteboard-text-input');
    await editor.waitFor();
    assert.equal(await editor.evaluate(el => document.activeElement === el), true);
    assert.ok(await editor.evaluate(el => parseFloat(getComputedStyle(el).fontSize) >= 20));
    await editor.fill('مرحبا من الهاتف');
    await editor.evaluate(el => el.blur());
    assert.equal(await editor.isVisible(), true, 'keyboard blur does not discard text');
    await editor.focus();
    await teacher.locator('.mobile-whiteboard-text-dialog button[type=submit]').tap();
    await student.locator('.whiteboard-text-content').filter({ hasText: 'مرحبا من الهاتف' }).waitFor();
    const textItem = teacher.locator('.whiteboard-item').first();
    const fontPixels = await textItem.locator('.whiteboard-text-content').evaluate(el => parseFloat(getComputedStyle(el).fontSize) * el.closest('svg').getScreenCTM().a);
    assert.ok(fontPixels >= 22, `new board text stays legible: ${fontPixels}px`);
    for (let n = 0; n < 5; n += 1) {
      await textItem.locator('.whiteboard-item-hitbox').tap();
      await editor.waitFor();
      await editor.fill(`تعديل الهاتف ${n}`);
      await teacher.locator('.mobile-whiteboard-text-dialog button[type=submit]').tap();
      await student.locator('.whiteboard-text-content').filter({ hasText: `تعديل الهاتف ${n}` }).waitFor();
      assert.equal(await teacher.locator('.whiteboard-item').count(), 1, 'tap edits rather than adding duplicates or leaving phantom pinch pointers');
    }
    const touch = await context.newCDPSession(teacher);
    const drag = async (from, to, hold = 0) => {
      await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y, id: 1 }] });
      if (hold) await new Promise(resolve => setTimeout(resolve, hold));
      for (let step = 1; step <= 6; step += 1) await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (to.x - from.x) * step / 6, y: from.y + (to.y - from.y) * step / 6, id: 1 }] });
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    let rect = await textItem.locator('.whiteboard-item-hitbox').boundingBox();
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, id: 1 }] });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    assert.equal(await editor.isVisible(), false, 'a cancelled touch cannot open or delete text');
    await drag({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, { x: rect.x + rect.width / 2 + 25, y: rect.y + rect.height / 2 + 25 }, 520);
    const moved = await textItem.locator('.whiteboard-item-hitbox').boundingBox();
    assert.ok(moved.x > rect.x + 15 && moved.y > rect.y + 15, 'long press moves existing text');
    assert.equal(await editor.isVisible(), false);
    await teacher.locator('[data-whiteboard-tool=text]').tap();
    const addArea = await board.boundingBox();
    await teacher.touchscreen.tap(addArea.x + 45, addArea.y + addArea.height * .7);
    await editor.waitFor();
    await teacher.locator('.mobile-whiteboard-text-dialog button[type=button]').tap();
    assert.equal(await teacher.locator('.whiteboard-item').count(), 1, 'cancel only removes the empty new text');
    const picture = await board.screenshot();
    await teacher.locator('.whiteboard-tools input[type=file]').setInputFiles({ name: 'board.png', mimeType: 'image/png', buffer: picture });
    await student.locator('.whiteboard-board-image').waitFor();
    const image = teacher.locator('.whiteboard-item').filter({ has: teacher.locator('.whiteboard-board-image') });
    const inspector = teacher.locator('.whiteboard-inspector');
    assert.ok((await inspector.boundingBox()).height <= 65, 'phone image controls start compact');
    rect = await image.locator('.whiteboard-item-hitbox').boundingBox();
    await drag({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, { x: rect.x + rect.width / 2 + 25, y: rect.y + rect.height / 2 - 35 });
    const imageMoved = await image.locator('.whiteboard-item-hitbox').boundingBox();
    assert.ok(imageMoved.x > rect.x + 15 && imageMoved.y < rect.y - 25, 'image hit target supports real touch dragging');
    const handle = await image.locator('.whiteboard-resize-handle').boundingBox();
    assert.ok(handle.width >= 34, 'resize handle is a usable finger target');
    await drag({ x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 }, { x: handle.x + handle.width / 2 + 35, y: handle.y + handle.height / 2 + 30 });
    assert.ok((await image.locator('.whiteboard-item-hitbox').boundingBox()).width > imageMoved.width + 25, 'image resizes by touch');
    await teacher.screenshot({ path: `.private/whiteboard-${device}-image.png` });
    await inspector.locator('.whiteboard-image-options-toggle').tap();
    const settings = await inspector.boundingBox();
    assert.ok(settings.width <= 390 && settings.height <= 231, 'expanded image settings remain within phone bounds');
    await inspector.locator('.whiteboard-image-options-close').tap();
    await teacher.locator('[data-whiteboard-tool=draw]').tap();
    const imageNow = await image.locator('.whiteboard-item-hitbox').boundingBox();
    await drag({ x: imageNow.x + 15, y: imageNow.y + 15 }, { x: imageNow.x + 45, y: imageNow.y + 45 });
    await student.locator('.whiteboard-canvas > path').waitFor();
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log(`${device}: repeated text edits, blur/cancel, readable font, long press, image drag/resize and compact settings passed.`);
    await context.close();
  }
} finally { await browser.close(); await new Promise(resolve => io.close(() => httpServer.close(resolve))); }
