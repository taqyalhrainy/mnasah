import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});

try {
  const context = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${process.env.BASE_URL || 'http://127.0.0.1:8787'}/video-test?room=whiteboard-layout&role=teacher`);
  await page.addStyleTag({ content: '.video-test-bar{display:none!important}.video-test-page{padding:0!important}.video-test-page>.video-room{height:100dvh!important;max-width:none!important}' });
  await page.waitForFunction(() => [...document.querySelectorAll('video')].some(video => video.srcObject), undefined, { timeout: 20000 });
  await page.getByTitle('اللوح المشترك').click();
  await page.locator('.whiteboard-canvas').waitFor();
  await page.locator('.whiteboard-color-picker input[type="color"]').fill('#13a67a');
  assert.equal(await page.locator('.call-toolbar').isVisible(), true, 'call controls should stay visible');
  assert.equal(await page.locator('.whiteboard-side-rail .whiteboard-tools').isVisible(), true, 'board tools should sit below participant previews');
  assert.equal(await page.locator('.whiteboard-color-picker input[type="color"]').inputValue(), '#13a67a');
  assert.match(await page.locator('.whiteboard-color-picker > span').evaluate(element => getComputedStyle(element).backgroundColor), /19, 166, 122/);
  const board = await page.locator('.whiteboard-canvas').boundingBox();
  const stage = await page.locator('.whiteboard-stage').boundingBox();
  assert.ok(board && stage && board.width / stage.width > 0.72, 'the board should keep most of the stage width');
  await page.screenshot({ path: '.private/whiteboard-layout.png' });
  console.log('Whiteboard rail, full color picker, visible call controls and expanded board layout passed.');
  await context.close();
} finally {
  await browser.close();
}
