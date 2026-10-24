import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});

try {
  const context = await browser.newContext({ permissions: ['camera', 'microphone'] });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { configurable: true, get: () => 'MacIntel' });
    Object.defineProperty(navigator, 'userAgentData', { configurable: true, get: () => ({ platform: 'macOS' }) });
  });
  const page = await context.newPage();
  await page.goto(`${process.env.BASE_URL || 'http://127.0.0.1:8787'}/video-test?room=non-windows-share-check&role=teacher`);
  await page.waitForFunction(() => [...document.querySelectorAll('video')].some(video => video.srcObject), undefined, { timeout: 20000 });
  await page.locator('.call-toolbar .tool-button').nth(2).click();
  const notice = page.locator('.unsupported-share-panel');
  await notice.waitFor();
  assert.match(await notice.innerText(), /متاح للويندوز فقط حالياً/);
  assert.equal(await page.locator('.call-toolbar .active-share').count(), 0);
  console.log('Non-Windows screen share guard passed.');
  await context.close();
} finally {
  await browser.close();
}
