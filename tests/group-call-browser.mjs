import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { startPlatformServer } from '../server/index.js';
import { memoryMongo } from './helpers/memory-mongo.mjs';

const stored = new Map();
const bytes = { async write(id, _name, source) { const chunks = []; for await (const chunk of source) chunks.push(chunk); stored.set(id, Buffer.concat(chunks)); }, read: id => Readable.from([stored.get(id)]), async remove(id) { stored.delete(id); } };
const { httpServer, io } = await startPlatformServer({ database: memoryMongo(), attachmentStore: bytes, port: 0 });
const base = `http://127.0.0.1:${httpServer.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const pages = [], errors = [];
try {
  const response = await fetch(base + '/api/group-calls', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{}' });
  const room = await response.json(); assert.equal(response.status, 200);
  for (let index = 0; index < 3; index++) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['camera', 'microphone'] });
    await context.addInitScript(() => {
      window.__pcs = [];
      const Original = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends Original { constructor(...args) { super(...args); window.__pcs.push(this); } };
    });
    for (const host of ['fonts.googleapis.com', 'fonts.gstatic.com', 'accounts.google.com']) await context.route(`https://${host}/**`, route => route.abort());
    const page = await context.newPage(); pages.push(page);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/call/${room.id}${index === 0 ? '#host=' + room.hostKey : ''}`);
    await page.locator('#group-display-name').fill(['المضيف', 'أحمد', 'سارة'][index]);
    await page.getByRole('button', { name: 'دخول المكالمة', exact: true }).tap();
    await page.locator('.video-room.group-call-room').waitFor();
    await page.getByTitle('تشغيل الكاميرا', { exact: true }).waitFor();
  }
  for (const page of pages) {
    await page.waitForFunction(() => window.__pcs.filter(pc => pc.connectionState === 'connected').length === 2, null, { timeout: 30000 });
    await page.waitForFunction(async () => {
      const pcs = window.__pcs.filter(pc => pc.connectionState === 'connected');
      return pcs.length === 2 && (await Promise.all(pcs.map(async pc => [...(await pc.getStats()).values()].some(stat => stat.type === 'inbound-rtp' && stat.kind === 'audio' && stat.packetsReceived > 5)))).every(Boolean);
    }, null, { timeout: 15000 });
    assert.equal(await page.locator('.participant-tile').count(), 3);
    await page.getByTitle('تشغيل الكاميرا', { exact: true }).tap();
  }
  for (const page of pages) await page.waitForFunction(async () => (await Promise.all(window.__pcs.filter(pc => pc.connectionState === 'connected').map(async pc => [...(await pc.getStats()).values()].some(stat => stat.type === 'inbound-rtp' && stat.kind === 'video' && stat.framesDecoded > 2)))).every(Boolean), null, { timeout: 20000 });
  const [host, guest, third] = pages;
  await host.getByTitle('اللوح المشترك', { exact: true }).tap();
  for (const page of pages) await page.locator('.whiteboard-canvas').waitFor();
  await guest.locator('[data-whiteboard-tool=draw]').tap();
  const box = await guest.locator('.whiteboard-canvas').boundingBox();
  await guest.touchscreen.tap(box.x + box.width * .4, box.y + box.height * .4);
  for (const page of pages) await page.waitForFunction(() => document.querySelectorAll('.whiteboard-canvas > .whiteboard-dot').length === 1);
  await host.getByRole('switch').tap();
  await guest.waitForFunction(() => document.querySelector('[data-whiteboard-tool=draw]')?.disabled === true);
  const image = await host.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 600; const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 400, 600); ctx.fillStyle = '#512780'; ctx.font = '40px sans-serif'; ctx.fillText('Shared document', 30, 90); return canvas.toDataURL('image/png').split(',')[1]; });
  await host.locator('[data-whiteboard-file-input]').setInputFiles({ name: 'group-page.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64') });
  for (const page of pages) await page.locator('.document-stage').waitFor();
  await host.getByTitle('تكبير الملف', { exact: true }).tap();
  for (const page of [guest, third]) await page.waitForFunction(() => document.querySelector('.document-zoom-percent')?.textContent === '125%');
  assert.equal(await host.locator('.group-call-header').isVisible(), true);
  await host.getByTitle('المحادثة', { exact: true }).tap();
  await host.getByLabel('رسالة جديدة', { exact: true }).fill('اختبار صوت وصورة جماعي');
  await host.getByRole('button', { name: 'إرسال الرسالة', exact: true }).tap();
  for (const page of [guest, third]) {
    await page.getByTitle('المحادثة', { exact: true }).tap();
    await page.locator('.call-chat-messages').getByText('اختبار صوت وصورة جماعي', { exact: true }).waitFor();
  }
  await host.screenshot({ path: 'DO_NOT_UPLOAD/group-call-mobile.png' });
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('Three independent mobile callers exchange audio/video, board drawing/permissions and chat without platform accounts.');
} catch (error) {
  for (let i = 0; i < pages.length; i++) { console.log(i, await pages[i].locator('body').innerText()); await pages[i].screenshot({ path: `DO_NOT_UPLOAD/group-fail-${i}.png` }); }
  throw error;
} finally { await browser.close(); await new Promise(resolve => io.close(() => httpServer.close(resolve))); }
