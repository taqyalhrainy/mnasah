import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { educationCatalog, educationGroups } from '../shared/jordan-catalog.js';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const base = process.env.UI_BASE_URL || 'http://127.0.0.1:5192';
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const user = { id: 'teacher', role: 'teachers', status: 'active', name: 'Teacher', email: 'teacher@test.invalid', subject: '', bio: '' };
  let saves = 0;
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auth/me')) return route.fulfill({ json: { user } });
    if (path.endsWith('/catalog')) return route.fulfill({ json: { categories: educationCatalog, groups: educationGroups } });
    if (path.endsWith('/profile') && route.request().method() === 'POST') { saves++; user.subject = route.request().postDataJSON().subject; return route.fulfill({ json: { user } }); }
    return route.fulfill({ json: { bookings: [], slots: [], events: [], users: [], offers: [], purchases: [], categories: [] } });
  });
  await page.goto(base + '/teachers');
  await page.locator('.home-showcase').waitFor();
  // Skip the decorative welcome rather than relying on its timing.
  const skip = page.getByRole('button', { name: 'تخطي', exact: true });
  if (await skip.isVisible()) await skip.click();
  await page.getByRole('button').filter({ hasText: 'المنهاج الأردني' }).last().click();
  await page.getByRole('button').filter({ hasText: 'الأساسي' }).last().click();
  await page.getByRole('button').filter({ hasText: 'الرياضيات' }).last().click();
  await page.locator('.package-levels input').first().check();
  let prompted = 0;
  page.once('dialog', dialog => { prompted++; void dialog.dismiss(); });
  await page.locator('.nav-button').filter({ hasText: 'المتاحة' }).first().click();
  assert.equal(prompted, 1);
  assert.equal(await page.locator('.package-levels').isVisible(), true, 'declining navigation must keep the draft open');
  assert.equal(saves, 0, 'draft edits must not save themselves');
  await page.getByRole('button', { name: 'حفظ اختياراتي', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.package-levels'));
  assert.equal(saves, 1);
  await page.locator('.account-menu summary').first().click();
  await page.locator('.account-menu select[aria-label="اللغة"]').first().selectOption('en');
  await page.getByRole('button').filter({ hasText: 'Jordanian curriculum' }).last().waitFor();
  const catalogue = await page.evaluate(async () => {
    const { t } = await import('/src/i18n/preferences.tsx');
    return [t('الفترة المتاحة'), t('مستحقات الباقات'), t('الصف الثاني عشر – الحقل الصحي'), t('صفحة 2 من 569'), t('الرياضيات › الصف الأول')];
  });
  assert.deepEqual(catalogue, ['Available hours', 'Package earnings', 'Grade 12 – Health field', 'Page 2 of 569', 'Mathematics › Grade 1']);
  await page.route('**/api/slow-request', () => {});
  const timedOut = await page.evaluate(async () => {
    const { request } = await import('/src/services/platformApi.ts');
    try { await request('slow-request', undefined, new AbortController().signal, 50); return false; }
    catch (error) { return error.message.includes('try again') || error.message.includes('Try again'); }
  });
  assert.equal(timedOut, true, 'an external cancellation signal must not disable the request timeout');
  await page.evaluate(() => localStorage.setItem('mansah-language', 'ar'));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  user.verification = { gender: 'female' };
  await page.reload();
  await page.getByText('أهلًا معلمة', { exact: true }).waitFor();
  user.verification.gender = 'male';
  await page.reload();
  await page.getByText('أهلًا أستاذ', { exact: true }).waitFor();
  await context.close();

  const touchContext = await browser.newContext({ hasTouch: true, viewport: { width: 1100, height: 820 }, permissions: ['microphone'], reducedMotion: 'reduce' });
  const touch = await touchContext.newPage();
  await touch.route('**/api/**', route => route.fulfill({ json: {} }));
  await touch.goto(base + '/video-test?room=long-press-regression&role=teacher');
  await touch.locator('.call-toolbar').waitFor();
  await touch.getByTitle('اللوح المشترك', { exact: true }).click();
  const board = touch.locator('.whiteboard-canvas');
  await board.waitFor();
  await touch.locator('[data-whiteboard-tool="text"]').click();
  await board.click({ position: { x: 120, y: 120 } });
  await touch.locator('.whiteboard-text-editor').fill('Move this text');
  await touch.locator('[data-whiteboard-tool="draw"]').click();
  const item = touch.locator('.whiteboard-item foreignObject').last();
  const before = Number(await item.getAttribute('x'));
  const box = await item.boundingBox();
  const session = await touchContext.newCDPSession(touch);
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + 30, y: box.y + 30 }] });
  await touch.waitForTimeout(550);
  await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + 110, y: box.y + 60 }] });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.ok(Number(await item.getAttribute('x')) > before + 20, 'a teacher can move board text by holding and dragging on touch');
  await touchContext.close();
  const failedContext = await browser.newContext();
  const failedPage = await failedContext.newPage();
  await failedPage.route('**/src/features/video/VideoRoom.tsx*', route => route.abort());
  await failedPage.goto(base + '/video-test?room=failed-module&role=teacher');
  await failedPage.locator('.recovery-panel button').waitFor();
  assert.equal(await failedPage.locator('.recovery-panel').count(), 1, 'a failed room import must offer recovery rather than a blank screen');
  await failedContext.close();
  console.log('Unsaved-subject guard, explicit save, English UI/catalogue and touch long-press text movement passed.');
} finally { await browser.close(); }
