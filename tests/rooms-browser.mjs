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

  await page.getByTitle('المحادثة').click();
  const chat = page.locator('.call-chat-drawer');
  await chat.waitFor();
  await page.getByLabel('رسالة جديدة').fill('رسالة مباشرة من الغرفة');
  await page.getByLabel('إرسال الرسالة').click();
  await page.getByText('رسالة مباشرة من الغرفة', { exact: true }).waitFor();
  const placement = await chat.evaluate(element => ({ position: getComputedStyle(element).position, bottom: getComputedStyle(element).bottom }));
  assert.deepEqual(placement, { position: 'absolute', bottom: '8px' });
  await page.screenshot({ path: '.private/immersive-call-chat.png' });

  await page.getByTitle('إنهاء المكالمة والخروج').click();
  await page.locator('.immersive-call-shell').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('call-active')), false);
  assert.equal(pageErrors.length, 0, pageErrors.join('\n'));
  console.log('Rooms hub, live badge, immersive call and bottom chat checks passed.');
} finally {
  await browser.close();
}
