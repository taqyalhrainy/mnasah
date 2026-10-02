import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const context = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const now = Date.now();
const user = { id: 'student-room-test', name: 'طالب الاختبار', role: 'students', status: 'active', email: 'student@example.com', subject: '', bio: '' };
const booking = { id: 'room-booking', slot_id: 'slot-1', student_id: user.id, teacher_id: 'teacher-1', subject: 'الرياضيات', start: now + 5 * 60000, minutes: 60, status: 'confirmed', teacher_name: 'الأستاذ أحمد', student_name: user.name, price: 1500, paid: 1, payment_ref: 'test', notes: '', resource: '', teacher_present_until: now + 60000, student_present_until: 0 };
const messages = [];
const presenceWrites = [];
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));

try {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/api/', '');
    if (path.startsWith('auth/me')) return route.fulfill({ json: { user } });
    if (path === 'students/catalog') return route.fulfill({ json: { categories: [] } });
    if (path === 'students/slots') return route.fulfill({ json: { slots: [] } });
    if (path === 'students/rooms' || path === 'students/reminders' || path === 'students/overview') return route.fulfill({ json: { bookings: [booking] } });
    if (path === `students/bookings/${booking.id}/room`) return route.fulfill({ json: { room: 'browser-room-test', role: 'student' } });
    if (path === `students/bookings/${booking.id}/presence`) {
      if (route.request().method() === 'POST') presenceWrites.push(route.request().postDataJSON());
      return route.fulfill({ json: { teacherLive: true, studentLive: presenceWrites.at(-1)?.active === true } });
    }
    if (path === `students/bookings/${booking.id}/messages`) {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON().body;
        messages.push({ id: String(messages.length + 1), body, created: Date.now(), name: user.name });
      }
      return route.fulfill({ json: { messages } });
    }
    return route.fulfill({ status: 404, json: { error: 'missing test route' } });
  });

  await page.goto('http://127.0.0.1:8787/students');
  const roomsNav = page.getByRole('button', { name: 'الغرف LIVE', exact: true });
  await roomsNav.waitFor();
  await page.getByText('LIVE', { exact: true }).waitFor();
  await roomsNav.click();
  await page.getByRole('heading', { name: 'غرف الحصص' }).waitFor();
  await page.getByRole('tab', { name: 'القادمة', exact: true }).click();
  await page.locator('.room-card.is-live').waitFor();
  assert.equal(await page.locator('.room-card.is-live').count(), 1);
  assert.match(await page.locator('.room-countdown strong').innerText(), /^\d{2}:\d{2}$/);
  await page.screenshot({ path: '.private/rooms-hub.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '.private/rooms-hub-mobile.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole('button', { name: 'انضم الآن' }).click();
  await page.locator('.immersive-call-shell').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('call-active')), true);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.immersive-call-shell')).position), 'fixed');

  await page.waitForFunction(() => [...document.querySelectorAll('video')].some(video => video.srcObject));
  await page.evaluate(() => { window.callStreamBeforeBrowsing = [...document.querySelectorAll('video')].find(video => video.srcObject)?.srcObject; });
  await page.getByLabel('فتح صفحات المنصة').hover();
  const callNavigation = page.getByRole('navigation', { name: 'صفحات المنصة' });
  await callNavigation.waitFor();
  await page.screenshot({ path: '.private/call-navigation-open.png' });
  await callNavigation.getByRole('button', { name: 'المحفظة', exact: true }).click();
  await page.locator('.floating-call-shell').waitFor();
  await page.locator('.wallet-page').waitFor();
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('video')].some(video => video.srcObject === window.callStreamBeforeBrowsing)), true, 'browsing portal pages must preserve the active call stream');
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('call-active')), false);
  await page.screenshot({ path: '.private/call-browse-floating.png', fullPage: true });
  await page.getByTitle('العودة إلى المكالمة الكاملة').click();
  await page.locator('.immersive-call-shell').waitFor();

  await page.getByTitle('المحادثة').click();
  const chat = page.locator('.call-chat-drawer');
  await chat.waitFor();
  await page.getByLabel('رسالة جديدة').fill('رسالة مباشرة من الغرفة');
  await page.getByLabel('إرسال الرسالة').click();
  await page.getByText('رسالة مباشرة من الغرفة', { exact: true }).waitFor();
  const placement = await page.evaluate(() => {
    const chatElement = document.querySelector('.call-chat-drawer');
    const stage = document.querySelector('.call-stage');
    const messagesElement = document.querySelector('.call-chat-messages');
    const chatRect = chatElement.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    return { position: getComputedStyle(chatElement).position, separated: chatRect.top >= stageRect.bottom, messagesOverflow: getComputedStyle(messagesElement).overflowY };
  });
  assert.deepEqual(placement, { position: 'relative', separated: true, messagesOverflow: 'auto' });
  await page.screenshot({ path: '.private/immersive-call-chat.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => {
    const chatRect = document.querySelector('.call-chat-drawer').getBoundingClientRect();
    const stageRect = document.querySelector('.call-stage').getBoundingClientRect();
    return chatRect.top >= stageRect.bottom && document.documentElement.scrollWidth <= innerWidth;
  }), true, 'mobile chat must stay below the video without horizontal overflow');
  await page.screenshot({ path: '.private/immersive-call-chat-mobile.png' });

  await page.getByTitle('إنهاء المكالمة والخروج').click();
  await page.locator('.immersive-call-shell').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('call-active')), false);
  assert.equal(pageErrors.length, 0, pageErrors.join('\n'));
  console.log('Rooms hub, live badge, immersive call and bottom chat checks passed.');
} finally {
  await browser.close();
}
